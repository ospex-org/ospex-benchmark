import { describeError, redactSecrets } from './config.js';
import { buildRepairInstruction, buildUserMessage, SYSTEM_PROMPT } from './prompt.js';
import {
  compareFingerprints,
  extractDecisionFingerprint,
  fingerprintFromParsed,
  validateResponseText,
} from './schema.js';
import { ProviderHttpError, ProviderTimeoutError } from './providers/errors.js';
import { assertPrepared, prepareGameRequest } from './preparedRequest.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { deepFreeze } from './freeze.js';
import { instantMs } from './time.js';
import type { GameRequest } from './bundle.js';
import type { PreparedGameRequest } from './preparedRequest.js';
import type {
  ArmGameResult,
  ArmSpec,
  AttemptRecord,
  ChatTurn,
  ProviderAdapter,
  ProviderResponse,
  RepairTransport,
  SlateBundle,
} from './types.js';

/**
 * The single frozen snapshot of what was dispatched. EVERY artifact surface —
 * records, deterministic baselines, run metadata, and the summary — reads its
 * game content from here, so a post-preparation mutation of the mutable build
 * slate cannot split the evidence (SPEC-prepared-request.md §2.4). Its
 * `slate.games` are the SAME frozen objects as the per-game `prepared[i].game`.
 */
export interface DispatchSnapshot {
  /** The frozen, hash-verified requests dispatched — one per game, cutoff order. */
  prepared: readonly PreparedGameRequest[];
  /** The frozen slate view re-derived from the dispatched games, in gameId order. */
  slate: SlateBundle;
  /** sha256Hex(canonicalize(slate)) — the slate hash, derived from the snapshot. */
  slateSha256: string;
}

export interface SlateRunResult {
  results: ArmGameResult[];
  snapshot: DispatchSnapshot;
}

// Module-private registry of snapshots produced by sealDispatch. Nothing
// outside this module can add to it, so membership is unforgeable proof that a
// DispatchSnapshot WRAPPER (its slate + hash, not just its nested prepared
// objects) actually came through sealDispatch — a consumer cannot be handed a
// hand-built snapshot with genuine prepared requests but a substituted slate.
const sealedSnapshots = new WeakSet<DispatchSnapshot>();

/**
 * Throw unless `snapshot` was produced by `sealDispatch`. The record and summary
 * builders call this before emitting anything, so a forged or substituted
 * snapshot never reaches the artifact.
 */
export function assertSealed(snapshot: DispatchSnapshot): void {
  if (!sealedSnapshots.has(snapshot)) {
    throw new Error('dispatch snapshot was not produced by sealDispatch (forged or substituted)');
  }
}

/**
 * Validate and seal the dispatched games into one frozen, branded snapshot,
 * BEFORE any provider call. Every request must be genuinely prepared, game IDs
 * must be unique, and the shared slate metadata (schema/label/league/date/
 * bundle-timestamp) must be identical across the batch — otherwise the batch is
 * rejected without a single provider call. The slate view is re-derived from the
 * frozen prepared games THEMSELVES (canonical gameId order), so nothing
 * downstream needs the mutable build slate; the whole snapshot — the prepared
 * array included — is deep-frozen and registered in the seal brand.
 */
export function sealDispatch(prepared: readonly PreparedGameRequest[]): DispatchSnapshot {
  const first = prepared[0];
  if (first === undefined) {
    throw new Error('cannot seal a dispatch snapshot from zero prepared requests');
  }
  const base = first.requestBundle;
  const seenIds = new Set<string>();
  for (const p of prepared) {
    // Only genuinely-prepared requests may enter a sealed snapshot, so a sealed
    // snapshot transitively guarantees its prepared are branded.
    assertPrepared(p);
    if (seenIds.has(p.gameId)) {
      throw new Error(`duplicate game ID in the dispatch batch: ${p.gameId}`);
    }
    seenIds.add(p.gameId);
    const b = p.requestBundle;
    if (
      b.schemaVersion !== base.schemaVersion ||
      b.label !== base.label ||
      b.league !== base.league ||
      b.slateDate !== base.slateDate ||
      b.bundleTimestamp !== base.bundleTimestamp
    ) {
      throw new Error(`dispatch batch mixes slate metadata (game ${p.gameId})`);
    }
  }
  const byGameId = [...prepared].sort((a, b) =>
    a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0,
  );
  const cutoffAt = prepared
    .map((p) => p.cutoffAt)
    .reduce((min, c) => (instantMs(c) < instantMs(min) ? c : min));
  const slate: SlateBundle = {
    schemaVersion: base.schemaVersion,
    label: base.label,
    league: base.league,
    slateDate: base.slateDate,
    bundleTimestamp: base.bundleTimestamp,
    cutoffAt,
    games: byGameId.map((p) => p.game),
  };
  const snapshot = deepFreeze({ prepared, slate, slateSha256: sha256Hex(canonicalize(slate)) });
  sealedSnapshots.add(snapshot);
  return snapshot;
}

export interface SlateRunOptions {
  cohortId: string;
  timeoutMs: number;
  /** Explicit output-token bound applied to every live call and recorded. */
  maxOutputTokens: number;
  /**
   * Injected clock (epoch ms) used BOTH for cutoff enforcement (checked
   * before initial dispatch, before repair, and on response acceptance) AND
   * for every recorded timestamp (requestAt/responseAt/latency), so records
   * and enforcement can never disagree temporally. Defaults to the wall
   * clock; the dry run injects a synthetic clock anchored to the fixture.
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
  nowMs: () => number,
): Promise<
  AttemptRecord & {
    response: ProviderResponse | null;
    failure: 'timeout' | 'rate_limited' | 'provider_error' | null;
  }
> {
  const startedAt = nowMs();
  const requestAt = new Date(startedAt).toISOString();
  try {
    const response = await adapter.chat(turns, timeoutMs, { maxOutputTokens });
    const respondedAt = nowMs();
    return {
      rawText: redactSecrets(response.rawText),
      reportedModelId: response.reportedModelId,
      providerResponseId: response.providerResponseId,
      httpStatus: response.httpStatus,
      usage: response.usage,
      usageRaw: response.usageRaw,
      requestParams: response.requestParams,
      requestAt,
      responseAt: new Date(respondedAt).toISOString(),
      latencyMs: respondedAt - startedAt,
      errorDetail: null,
      response,
      failure: null,
    };
  } catch (error) {
    const detail =
      error instanceof ProviderHttpError || error instanceof ProviderTimeoutError
        ? error.message
        : describeError(error);
    const respondedAt = nowMs();
    return {
      ...emptyAttempt(),
      httpStatus: error instanceof ProviderHttpError ? error.status : null,
      requestAt,
      responseAt: new Date(respondedAt).toISOString(),
      latencyMs: respondedAt - startedAt,
      errorDetail: redactSecrets(detail),
      response: null,
      failure: classifyFailure(error),
    };
  }
}

export async function runOneArmGame(
  arm: ArmSpec,
  adapter: ProviderAdapter,
  request: PreparedGameRequest,
  options: SlateRunOptions,
): Promise<ArmGameResult> {
  // Runtime guard: never dispatch a request that did not come through the
  // prepared boundary — before reading any field or touching an adapter method.
  assertPrepared(request);
  const nowMs = options.nowMs ?? Date.now;
  const cutoffMs = Date.parse(request.cutoffAt);
  const base = {
    arm,
    gameId: request.gameId,
    requestSha256: request.requestSha256,
    cutoffAt: request.cutoffAt,
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
    request,
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
    nowMs,
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

  // Clock check BEFORE repair: if the decision window closed before the
  // repair could be dispatched, no acceptable response can exist any more —
  // that is a missed cutoff, not a schema verdict.
  const remainingAtRepair = cutoffMs - nowMs();
  if (remainingAtRepair <= 0) {
    return failed('cutoff_missed', attemptRecord, null, false, null, [
      ...firstValidation.errors,
      'repair not dispatched: decision cutoff passed before the repair window opened',
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
    nowMs,
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
 *
 * Every request is put through the prepared-request boundary BEFORE any arm is
 * dispatched (SPEC-prepared-request.md §2.3): `prepareGameRequest` normalizes,
 * hash-verifies, and freezes each one, and only that frozen value reaches an
 * arm. This closes the whole batch first, so a request that fails preparation
 * throws BEFORE a single provider call — never after a partial dispatch. A
 * preparation failure is a harness/preparation failure (the builder emitted a
 * request that does not satisfy the contract), surfaced by the throw; it is
 * never a per-model outcome and never `invalid_schema`. In the smoke CLI the
 * throw aborts the run (nonzero exit, no artifact); in the watcher it is caught
 * per game and recorded as that game's fire failure.
 */
export async function runSlate(
  arms: ArmSpec[],
  adapters: Map<string, ProviderAdapter>,
  requests: GameRequest[],
  options: SlateRunOptions,
): Promise<SlateRunResult> {
  // Seal + validate the whole batch BEFORE any provider call (unique game IDs,
  // identical shared slate metadata, genuine prepared origin). Dispatch then
  // runs on the sealed snapshot, and the artifact is built from it.
  const snapshot = sealDispatch(requests.map(prepareGameRequest));
  const all: ArmGameResult[] = [];
  let index = 0;
  for (const request of snapshot.prepared) {
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
      // The caller prints through the redacted console chokepoint.
      options.onGameComplete(`game ${index}/${snapshot.prepared.length} ${request.slug}: ${cells}`);
    }
  }
  // Freeze the results collection and the result envelope — nothing downstream
  // may mutate what the artifact is built from (the snapshot is already sealed).
  Object.freeze(all);
  return Object.freeze({ results: all, snapshot });
}
