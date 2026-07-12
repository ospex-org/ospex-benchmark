import { describeError, redactSecrets } from './config.js';
import { buildRepairInstruction, buildUserMessage, SYSTEM_PROMPT } from './prompt.js';
import {
  compareFingerprints,
  extractDecisionFingerprint,
  fingerprintFromParsed,
  validateResponseText,
} from './schema.js';
import { ProviderHttpError, ProviderTimeoutError } from './providers/errors.js';
import type { GameRequest } from './bundle.js';
import type {
  ArmGameResult,
  ArmSpec,
  AttemptRecord,
  ChatTurn,
  ProviderAdapter,
  ProviderResponse,
  RepairTransport,
} from './types.js';

export interface SlateRunOptions {
  cohortId: string;
  timeoutMs: number;
  /** Explicit output-token bound applied to every live call and recorded. */
  maxOutputTokens: number;
  /**
   * Injected clock (epoch ms) used for ALL cutoff enforcement — checked
   * before initial dispatch, before repair, and on response acceptance.
   * Defaults to the wall clock; tests and the dry run inject a fixed one.
   */
  nowMs?: (() => number) | undefined;
  /** Called after each game's four arms have all settled (sealed per game). */
  onGameComplete?: ((line: string) => void) | undefined;
}

function emptyAttempt(): AttemptRecord {
  return {
    rawText: null,
    reportedModelId: null,
    providerResponseId: null,
    httpStatus: null,
    usage: null,
    usageRaw: null,
    requestParams: null,
    requestAt: null,
    responseAt: null,
    latencyMs: null,
    errorDetail: null,
  };
}

function classifyFailure(error: unknown): 'timeout' | 'rate_limited' | 'provider_error' {
  if (error instanceof ProviderTimeoutError) return 'timeout';
  // A throttle must never be readable as a model failure.
  if (error instanceof ProviderHttpError && error.status === 429) return 'rate_limited';
  return 'provider_error';
}

async function timedChat(
  adapter: ProviderAdapter,
  turns: ChatTurn[],
  timeoutMs: number,
  maxOutputTokens: number,
): Promise<
  AttemptRecord & {
    response: ProviderResponse | null;
    failure: 'timeout' | 'rate_limited' | 'provider_error' | null;
  }
> {
  const requestAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const response = await adapter.chat(turns, timeoutMs, { maxOutputTokens });
    return {
      rawText: redactSecrets(response.rawText),
      reportedModelId: response.reportedModelId,
      providerResponseId: response.providerResponseId,
      httpStatus: response.httpStatus,
      usage: response.usage,
      usageRaw: response.usageRaw,
      requestParams: response.requestParams,
      requestAt,
      responseAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      errorDetail: null,
      response,
      failure: null,
    };
  } catch (error) {
    const detail =
      error instanceof ProviderHttpError || error instanceof ProviderTimeoutError
        ? error.message
        : describeError(error);
    return {
      ...emptyAttempt(),
      httpStatus: error instanceof ProviderHttpError ? error.status : null,
      requestAt,
      responseAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      errorDetail: redactSecrets(detail),
      response: null,
      failure: classifyFailure(error),
    };
  }
}

export async function runOneArmGame(
  arm: ArmSpec,
  adapter: ProviderAdapter,
  request: GameRequest,
  options: SlateRunOptions,
): Promise<ArmGameResult> {
  const nowMs = options.nowMs ?? Date.now;
  const cutoffMs = Date.parse(request.requestBundle.cutoffAt);
  const base = {
    arm,
    gameId: request.gameId,
    requestSha256: request.requestSha256,
    cutoffAt: request.requestBundle.cutoffAt,
  };
  const failed = (
    outcome: ArmGameResult['outcome'],
    attempt: AttemptRecord,
    repair: AttemptRecord | null,
    repairUsed: boolean,
    repairTransport: RepairTransport,
    validationErrors: string[],
  ): ArmGameResult => ({
    ...base,
    outcome,
    attempt,
    repair,
    repairUsed,
    repairTransport,
    parsed: null,
    validationErrors,
  });

  if (!adapter.hasCredential()) {
    return failed(
      'credential_missing',
      { ...emptyAttempt(), errorDetail: `${arm.credentialEnvVar} is not set` },
      null,
      false,
      null,
      [],
    );
  }

  // Clock check BEFORE initial dispatch: a request whose decision window has
  // already closed is never sent.
  const remainingAtDispatch = cutoffMs - nowMs();
  if (remainingAtDispatch <= 0) {
    return failed(
      'cutoff_missed',
      { ...emptyAttempt(), errorDetail: 'decision cutoff had already passed at dispatch' },
      null,
      false,
      null,
      [],
    );
  }

  const userMessage = buildUserMessage({
    cohortId: options.cohortId,
    participantId: arm.participantId,
    requestedModelId: arm.requestedModelId,
    executionPolicy: 'fixed-moneyline-total',
    bundleSha256: request.requestSha256,
    bundle: request.requestBundle,
  });
  const baseTurns: ChatTurn[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  // Each request is bounded by the remaining time to cutoff.
  const attempt = await timedChat(
    adapter,
    baseTurns,
    Math.min(options.timeoutMs, remainingAtDispatch),
    options.maxOutputTokens,
  );
  const { response: firstResponse, failure: firstFailure, ...attemptRecord } = attempt;
  if (firstFailure !== null || firstResponse === null) {
    return failed(firstFailure ?? 'provider_error', attemptRecord, null, false, null, []);
  }

  // Clock check ON response acceptance: a response that arrived after the
  // cutoff is never a decision, however valid its content.
  if (nowMs() >= cutoffMs) {
    return failed('cutoff_missed', attemptRecord, null, false, null, [
      'response received after the decision cutoff',
    ]);
  }

  const firstValidation = validateResponseText(
    firstResponse.rawText,
    request.requestBundle,
    request.requestSha256,
    arm,
    options.cohortId,
  );
  if (firstValidation.errors.length === 0 && firstValidation.parsed !== null) {
    return {
      ...base,
      outcome: 'valid',
      attempt: attemptRecord,
      repair: null,
      repairUsed: false,
      repairTransport: null,
      parsed: firstValidation.parsed,
      validationErrors: [],
    };
  }

  // A repair is acceptable only when the initial response yields a complete,
  // unambiguous decision fingerprint that the repair preserves exactly. If
  // preservation cannot be proved, the result stays invalid — so an
  // unfingerprintable initial response is unrepairable and no repair is sent.
  const initialFingerprint = extractDecisionFingerprint(
    firstResponse.rawText,
    request.requestBundle,
  );
  if (initialFingerprint === null) {
    return failed('invalid_schema', attemptRecord, null, false, null, [
      ...firstValidation.errors,
      'repair skipped: initial response yields no complete decision fingerprint, so decision preservation cannot be proved',
    ]);
  }

  // Clock check BEFORE repair.
  const remainingAtRepair = cutoffMs - nowMs();
  if (remainingAtRepair <= 0) {
    return failed('invalid_schema', attemptRecord, null, false, null, [
      ...firstValidation.errors,
      'repair skipped: decision cutoff passed before the repair could be dispatched',
    ]);
  }

  const repairTurns: ChatTurn[] = [
    ...baseTurns,
    { role: 'assistant', content: firstResponse.rawText },
    { role: 'user', content: buildRepairInstruction(firstValidation.errors) },
  ];
  const repair = await timedChat(
    adapter,
    repairTurns,
    Math.min(options.timeoutMs, remainingAtRepair),
    options.maxOutputTokens,
  );
  const { response: repairResponse, failure: repairFailure, ...repairRecord } = repair;
  if (repairFailure !== null || repairResponse === null) {
    // Transport outcome recorded separately: a throttled/failed repair is
    // never readable as a schema failure alone.
    return failed('invalid_schema', attemptRecord, repairRecord, true, repairFailure ?? 'provider_error', [
      ...firstValidation.errors,
      `repair not received (${repairFailure ?? 'provider_error'}): ${repairRecord.errorDetail ?? 'unknown error'}`,
    ]);
  }

  // Clock check on repair acceptance.
  if (nowMs() >= cutoffMs) {
    return failed('cutoff_missed', attemptRecord, repairRecord, true, 'ok', [
      'repair response received after the decision cutoff',
    ]);
  }

  const repairValidation = validateResponseText(
    repairResponse.rawText,
    request.requestBundle,
    request.requestSha256,
    arm,
    options.cohortId,
  );
  if (repairValidation.errors.length === 0 && repairValidation.parsed !== null) {
    const diffs = compareFingerprints(
      initialFingerprint,
      fingerprintFromParsed(repairValidation.parsed),
    );
    if (diffs.length > 0) {
      return failed('invalid_schema', attemptRecord, repairRecord, true, 'ok', diffs);
    }
    return {
      ...base,
      outcome: 'valid',
      attempt: attemptRecord,
      repair: repairRecord,
      repairUsed: true,
      repairTransport: 'ok',
      parsed: repairValidation.parsed,
      validationErrors: [],
    };
  }

  return failed('invalid_schema', attemptRecord, repairRecord, true, 'ok', repairValidation.errors);
}

/**
 * Per-game dispatch: games run SEQUENTIALLY in cutoff order (the earliest
 * first pitch is always served first); within each game the four arms run
 * CONCURRENTLY against that game's identical frozen request. One game's
 * failure affects only that game. Outputs stay sealed per game — nothing is
 * reported until all four arms for that game have settled, so no arm can be
 * conditioned on another's answer.
 */
export async function runSlate(
  arms: ArmSpec[],
  adapters: Map<string, ProviderAdapter>,
  requests: GameRequest[],
  options: SlateRunOptions,
): Promise<ArmGameResult[]> {
  const all: ArmGameResult[] = [];
  let index = 0;
  for (const request of requests) {
    index += 1;
    const results = await Promise.all(
      arms.map((arm) => {
        const adapter = adapters.get(arm.participantId);
        if (!adapter) throw new Error(`no adapter registered for ${arm.participantId}`);
        return runOneArmGame(arm, adapter, request, options);
      }),
    );
    all.push(...results);
    if (options.onGameComplete) {
      const cells = results
        .map((r) => `${r.arm.provider} ${r.outcome}${r.repairUsed ? ' (repair)' : ''}`)
        .join(' · ');
      options.onGameComplete(
        redactSecrets(`game ${index}/${requests.length} ${request.slug}: ${cells}`),
      );
    }
  }
  return all;
}
