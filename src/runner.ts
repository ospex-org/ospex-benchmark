import { describeError, redactSecrets } from './config.js';
import { buildRepairInstruction, buildUserMessage, SYSTEM_PROMPT } from './prompt.js';
import { detectChangedDecisions, validateResponseText } from './schema.js';
import { ProviderHttpError, ProviderTimeoutError } from './providers/errors.js';
import type { GameRequest } from './bundle.js';
import type {
  ArmGameResult,
  ArmOutcome,
  ArmSpec,
  AttemptRecord,
  ChatTurn,
  ProviderAdapter,
  ProviderResponse,
} from './types.js';

export interface SlateRunOptions {
  cohortId: string;
  timeoutMs: number;
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

function classifyFailure(error: unknown): Exclude<ArmOutcome, 'valid' | 'invalid_schema' | 'credential_missing'> {
  if (error instanceof ProviderTimeoutError) return 'timeout';
  // A throttle must never be readable as a model failure.
  if (error instanceof ProviderHttpError && error.status === 429) return 'rate_limited';
  return 'provider_error';
}

async function timedChat(
  adapter: ProviderAdapter,
  turns: ChatTurn[],
  timeoutMs: number,
): Promise<
  AttemptRecord & {
    response: ProviderResponse | null;
    failure: 'timeout' | 'rate_limited' | 'provider_error' | null;
  }
> {
  const requestAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const response = await adapter.chat(turns, timeoutMs);
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

async function runOneArmGame(
  arm: ArmSpec,
  adapter: ProviderAdapter,
  request: GameRequest,
  options: SlateRunOptions,
): Promise<ArmGameResult> {
  const base = {
    arm,
    gameId: request.gameId,
    requestSha256: request.requestSha256,
    cutoffAt: request.requestBundle.cutoffAt,
  };
  if (!adapter.hasCredential()) {
    return {
      ...base,
      outcome: 'credential_missing',
      attempt: { ...emptyAttempt(), errorDetail: `${arm.credentialEnvVar} is not set` },
      repair: null,
      repairUsed: false,
      parsed: null,
      validationErrors: [],
    };
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

  const attempt = await timedChat(adapter, baseTurns, options.timeoutMs);
  const { response: firstResponse, failure: firstFailure, ...attemptRecord } = attempt;
  if (firstFailure !== null || firstResponse === null) {
    return {
      ...base,
      outcome: firstFailure ?? 'provider_error',
      attempt: attemptRecord,
      repair: null,
      repairUsed: false,
      parsed: null,
      validationErrors: [],
    };
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
      parsed: firstValidation.parsed,
      validationErrors: [],
    };
  }

  // One deterministic format-repair attempt: same frozen inputs, the prior
  // raw output, and a fixed instruction that may not invite a new decision.
  const repairTurns: ChatTurn[] = [
    ...baseTurns,
    { role: 'assistant', content: firstResponse.rawText },
    { role: 'user', content: buildRepairInstruction(firstValidation.errors) },
  ];
  const repair = await timedChat(adapter, repairTurns, options.timeoutMs);
  const { response: repairResponse, failure: repairFailure, ...repairRecord } = repair;
  if (repairFailure !== null || repairResponse === null) {
    return {
      ...base,
      outcome: 'invalid_schema',
      attempt: attemptRecord,
      repair: repairRecord,
      repairUsed: true,
      parsed: null,
      validationErrors: [
        ...firstValidation.errors,
        `repair attempt failed (${repairFailure ?? 'provider_error'}): ${repairRecord.errorDetail ?? 'unknown error'}`,
      ],
    };
  }

  const repairValidation = validateResponseText(
    repairResponse.rawText,
    request.requestBundle,
    request.requestSha256,
    arm,
    options.cohortId,
  );
  if (repairValidation.errors.length === 0 && repairValidation.parsed !== null) {
    const changed =
      firstValidation.parsed !== null
        ? detectChangedDecisions(firstValidation.parsed, repairValidation.parsed)
        : [];
    if (changed.length > 0) {
      return {
        ...base,
        outcome: 'invalid_schema',
        attempt: attemptRecord,
        repair: repairRecord,
        repairUsed: true,
        parsed: null,
        validationErrors: changed,
      };
    }
    return {
      ...base,
      outcome: 'valid',
      attempt: attemptRecord,
      repair: repairRecord,
      repairUsed: true,
      parsed: repairValidation.parsed,
      validationErrors: [],
    };
  }

  return {
    ...base,
    outcome: 'invalid_schema',
    attempt: attemptRecord,
    repair: repairRecord,
    repairUsed: true,
    parsed: null,
    validationErrors: repairValidation.errors,
  };
}

/**
 * Per-game dispatch: games run SEQUENTIALLY; within each game the four arms
 * run CONCURRENTLY against that game's identical frozen request. One game's
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
      options.onGameComplete(`game ${index}/${requests.length} ${request.slug}: ${cells}`);
    }
  }
  return all;
}
