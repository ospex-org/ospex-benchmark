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
import { BASELINE_POLICY_VERSION, type BaselinePolicyVersion } from './baselines.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { deepFreeze } from './freeze.js';
import { instantMs } from './time.js';
import type { GameRequest } from './bundle.js';
import { assertAuthorizedDispatch, PreDispatchCleanupError } from './lineOpenDispatch.js';
import type { AuthorizedDispatch } from './lineOpenDispatch.js';
import { createAttemptLifecycle, LifecycleFaultError } from './lineOpenLifecycle.js';
import type { AttemptLifecyclePort } from './lineOpenLifecycle.js';
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

/**
 * The single branded, deeply-immutable run envelope every artifact producer
 * authenticates and reads from (SPEC-artifact-producer.md). It carries all
 * dispatched evidence — the sealed snapshot, the complete result graph, the
 * expected-arm manifest, and the four load-bearing dispatch fields — so the
 * producers consume ONE authenticated value rather than three independently
 * substitutable arguments. `slateDate` is NOT a `dispatch` field; it derives
 * from `snapshot.slate.slateDate` (§4).
 */
export interface RunEnvelope {
  snapshot: DispatchSnapshot;
  results: readonly ArmGameResult[];
  /** The dispatched roster's participantIds (unique — runSlate rejects a duplicate). */
  expectedArms: readonly string[];
  dispatch: {
    cohortId: string;
    executionPolicy: 'fixed-moneyline-total';
    timeoutMs: number;
    maxOutputTokens: number;
  };
  /**
   * The baseline policy version every artifact producer derives its deterministic
   * baselines under (S3). Carried on the branded envelope as an authenticated
   * DERIVATION PARAMETER — read directly like `snapshot`/`results`, NOT one of the
   * five ctx-reconciled dispatch fields (§4 of the artifact-producer spec): it is
   * not model-echoed, and `run_meta.baselinePolicyVersion` derives from the emitted
   * decisions themselves, so there is no `RunContext` copy to reconcile. Defaults
   * to the full-board `baselines-v0.2.0` (byte-identical to pre-S3e-2b); a dynamic
   * cohort passes `baselines-v0.3.0` so a scoped slate derives its present-market
   * baselines instead of failing closed.
   */
  baselinePolicyVersion: BaselinePolicyVersion;
}

/** The five load-bearing fields, derived from the envelope and equality-gated (A4). */
export interface BoundRunContext {
  slateDate: string;
  cohortId: string;
  executionPolicy: 'fixed-moneyline-total';
  timeoutMs: number;
  maxOutputTokens: number;
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

// Module-private registry of run envelopes produced by runSlate. Nothing outside
// this module can add to it, so membership is unforgeable proof that a
// RunEnvelope actually came through runSlate — a producer cannot be handed a
// hand-built envelope-shaped object (genuine or filtered nested pieces) with a
// substituted wrapper.
const runEnvelopes = new WeakSet<RunEnvelope>();

/**
 * Throw unless `env` was produced by `runSlate` (A5). The record and summary
 * builders call this before emitting anything. The envelope brand transitively
 * guarantees the nested snapshot (runSlate builds it via sealDispatch), so this
 * subsumes `assertSealed` — the producers no longer call `assertSealed`
 * separately.
 */
export function assertRunEnvelope(env: RunEnvelope): void {
  if (!runEnvelopes.has(env)) {
    throw new Error('run envelope was not produced by runSlate (forged or substituted)');
  }
}

/**
 * Authenticate the run envelope and reconcile the five load-bearing RunContext
 * fields against it (A4/A5). Returns the AUTHORITATIVE values derived from the
 * envelope (`slateDate` from the sealed slate, the other four from `dispatch`);
 * a separately-supplied context that disagrees on any of the five fails closed
 * before the producer writes anything. The producer records these five from the
 * returned bound values and its other seven fields from the context verbatim.
 */
export function authenticateRun(env: RunEnvelope, ctx: BoundRunContext): BoundRunContext {
  assertRunEnvelope(env);
  const bound: BoundRunContext = {
    slateDate: env.snapshot.slate.slateDate,
    cohortId: env.dispatch.cohortId,
    executionPolicy: env.dispatch.executionPolicy,
    timeoutMs: env.dispatch.timeoutMs,
    maxOutputTokens: env.dispatch.maxOutputTokens,
  };
  const disagreements: string[] = [];
  if (ctx.slateDate !== bound.slateDate) {
    disagreements.push(`slateDate (context ${ctx.slateDate} != envelope ${bound.slateDate})`);
  }
  if (ctx.cohortId !== bound.cohortId) {
    disagreements.push(`cohortId (context ${ctx.cohortId} != envelope ${bound.cohortId})`);
  }
  if (ctx.executionPolicy !== bound.executionPolicy) {
    disagreements.push(
      `executionPolicy (context ${ctx.executionPolicy} != envelope ${bound.executionPolicy})`,
    );
  }
  if (ctx.timeoutMs !== bound.timeoutMs) {
    disagreements.push(`timeoutMs (context ${ctx.timeoutMs} != envelope ${bound.timeoutMs})`);
  }
  if (ctx.maxOutputTokens !== bound.maxOutputTokens) {
    disagreements.push(
      `maxOutputTokens (context ${ctx.maxOutputTokens} != envelope ${bound.maxOutputTokens})`,
    );
  }
  if (disagreements.length > 0) {
    throw new Error(
      `run context disagrees with the sealed run envelope on: ${disagreements.join('; ')}`,
    );
  }
  return bound;
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
  // A1: capture the batch EXACTLY ONCE into a new plain array. An accessor- or
  // proxy-backed container can hand back a different element per read; from here
  // on every read is from this stable copy, never the caller's container, and
  // the copy (not the caller's array) is what the snapshot retains.
  const captured: readonly PreparedGameRequest[] = Array.from(prepared);
  const first = captured[0];
  if (first === undefined) {
    throw new Error('cannot seal a dispatch snapshot from zero prepared requests');
  }
  // Assert every captured element's runtime origin BEFORE reading any of its
  // fields, so a forged element is rejected before its `requestBundle` is read.
  for (const p of captured) assertPrepared(p);
  const base = first.requestBundle;
  const seenIds = new Set<string>();
  for (const p of captured) {
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
  const byGameId = [...captured].sort((a, b) =>
    a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0,
  );
  const cutoffAt = captured
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
  const snapshot = deepFreeze({ prepared: captured, slate, slateSha256: sha256Hex(canonicalize(slate)) });
  sealedSnapshots.add(snapshot);
  return snapshot;
}

export interface SlateRunOptions {
  cohortId: string;
  timeoutMs: number;
  /** Explicit output-token bound applied to every live call and recorded. */
  maxOutputTokens: number;
  /**
   * The run's declared execution policy — bound into the run envelope's
   * `dispatch` (A4) AND echoed into every prompt, so the recorded policy is
   * single-sourced with what the model is asked to echo back.
   */
  executionPolicy: 'fixed-moneyline-total';
  /**
   * The baseline policy version the artifact producers derive baselines under,
   * carried on the envelope (`RunEnvelope.baselinePolicyVersion`). Optional;
   * defaults to `BASELINE_POLICY_VERSION` (the full-board `baselines-v0.2.0`), so
   * the fixed-board smoke/watch path is unchanged. A dynamic cohort supplies
   * `baselines-v0.3.0` so a scoped slate derives its present-market baselines.
   */
  baselinePolicyVersion?: BaselinePolicyVersion | undefined;
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
    acceptedAt: null,
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

/**
 * What one arm's dispatch actually needs: the identity recorded in its result, plus the two
 * provider methods. The legacy path builds this from an `(ArmSpec, ProviderAdapter)` pair in a
 * complete preflight; the authorized path takes it from the already-captured plan facade, so
 * no caller-owned adapter map is read after a claim is taken.
 */
interface DispatchTarget {
  readonly arm: ArmSpec;
  hasCredential(): boolean;
  chat(turns: ChatTurn[], timeoutMs: number, options?: { maxOutputTokens?: number | undefined }): Promise<ProviderResponse>;
}

async function timedChat(
  adapter: Pick<DispatchTarget, 'chat'>,
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
      // A received response is not yet ACCEPTED — acceptance is stamped in
      // runOneArmGame only after validation (and repair fingerprint) passes.
      acceptedAt: null,
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
  return dispatchArm(
    {
      arm,
      hasCredential: () => adapter.hasCredential(),
      chat: (turns, timeoutMs, callOptions) => adapter.chat(turns, timeoutMs, callOptions),
    },
    request,
    options,
    null,
    0,
  );
}

/**
 * Dispatch ONE arm, optionally under a permit-bound lease lifecycle.
 *
 * With a lifecycle, the arm's initial slot is freed exactly once the moment its initial
 * attempt settles — or is skipped without a call — and BEFORE any validation, fingerprint, or
 * repair work, so a slow validation never holds capacity. A repair reserves a fresh slot
 * immediately before its request, RE-CHECKS the cutoff after that await (the acquisition
 * itself takes time, and a repair that would land after first pitch must not be sent), and
 * frees the slot on every exit. Without a lifecycle (`null`) the behaviour is exactly the
 * legacy path — no gate is added and nothing is released, because there is no durable lease.
 */
async function dispatchArm(
  target: DispatchTarget,
  request: PreparedGameRequest,
  options: SlateRunOptions,
  lifecycle: AttemptLifecyclePort | null,
  armIndex: number,
): Promise<ArmGameResult> {
  assertPrepared(request);
  let initialReleased = false;
  const releaseInitial = async (): Promise<void> => {
    if (lifecycle === null || initialReleased) return;
    initialReleased = true;
    await lifecycle.releaseInitial(armIndex);
  };
  try {
    return await dispatchArmCore(target, request, options, lifecycle, armIndex, releaseInitial);
  } catch (error) {
    // Backstop for a throw before the settle-time release (e.g. a synchronous pre-call
    // failure): free the slot without masking the primary error.
    if (lifecycle !== null && !initialReleased) {
      initialReleased = true;
      try {
        await lifecycle.releaseInitial(armIndex);
      } catch {
        /* the primary error wins */
      }
    }
    throw error;
  }
}

async function dispatchArmCore(
  target: DispatchTarget,
  request: PreparedGameRequest,
  options: SlateRunOptions,
  lifecycle: AttemptLifecyclePort | null,
  armIndex: number,
  releaseInitial: () => Promise<void>,
): Promise<ArmGameResult> {
  const arm = target.arm;
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

  if (!target.hasCredential()) {
    // No initial call will be made: free the slot now.
    await releaseInitial();
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
    await releaseInitial(); // skipped without a call
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
    executionPolicy: options.executionPolicy,
    request,
  });
  const baseTurns: ChatTurn[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  // Each request is bounded by the remaining time to cutoff.
  const attempt = await timedChat(
    target,
    baseTurns,
    Math.min(options.timeoutMs, remainingAtDispatch),
    options.maxOutputTokens,
    nowMs,
  );
  // The initial request has SETTLED (by response, timeout, or transport failure): free its
  // slot now — before any validation, fingerprint, or repair work — so capacity is never held
  // by this process's own bookkeeping. A release failure is a lifecycle fault: it propagates
  // and no repair begins.
  await releaseInitial();
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
    // Acceptance instant, rechecked against the cutoff at that instant: a
    // response accepted at/after first pitch is never a decision (§5), so it
    // stays cutoff_missed with acceptedAt unset. Otherwise stamp the truthful
    // accept time (distinct from the received-response stamp).
    const acceptedMs = nowMs();
    if (acceptedMs >= cutoffMs) {
      return failed('cutoff_missed', attemptRecord, null, false, null, [
        'response accepted after the decision cutoff',
      ]);
    }
    return {
      ...base,
      outcome: 'valid',
      attempt: { ...attemptRecord, acceptedAt: new Date(acceptedMs).toISOString() },
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

  // Capture the narrowed fingerprint: the repair sender below is a nested (hoisted)
  // function, so the null-narrowing above does not flow into it.
  const initialDecisions = initialFingerprint;

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

  // The repair turns are built deterministically BEFORE any capacity is reserved, so a slot is
  // never held across work that could have been done without it.
  const repairTurns: ChatTurn[] = [
    ...baseTurns,
    { role: 'assistant', content: firstResponse.rawText },
    { role: 'user', content: buildRepairInstruction(firstValidation.errors) },
  ];

  // Reserve one fresh repair slot immediately before the request. A denied or replayed
  // acquisition authorizes nothing: no request is sent, and nothing is released (nothing was
  // taken). With no lifecycle the legacy path is ungated — there is no durable lease to hold.
  const repairOrdinal = 1;
  let repairLeaseHeld = false;
  // The window to send the repair in. Without a lifecycle nothing is awaited between the
  // check above and the call, so the legacy path reads the clock no more times than before.
  let remainingForRepair = remainingAtRepair;
  if (lifecycle !== null) {
    const acquired = await lifecycle.acquireRepair(armIndex, repairOrdinal);
    if (!acquired.authorized) {
      return failed('invalid_schema', attemptRecord, null, false, null, [
        ...firstValidation.errors,
        'repair not dispatched: no repair concurrency slot was authorized',
      ]);
    }
    repairLeaseHeld = true;
    // The acquisition itself awaited the store, so RE-CHECK first pitch immediately before the
    // HTTP call: a repair that would land after the cutoff must not be sent at all.
    remainingForRepair = cutoffMs - nowMs();
  }

  try {
    if (remainingForRepair <= 0) {
      return failed('cutoff_missed', attemptRecord, null, false, null, [
        ...firstValidation.errors,
        'repair not dispatched: decision cutoff passed while the repair slot was acquired',
      ]);
    }
    return await sendRepair(remainingForRepair);
  } finally {
    // Free the repair slot on every exit — response, timeout, transport failure, validation
    // throw, or acceptance.
    if (repairLeaseHeld && lifecycle !== null) await lifecycle.releaseRepair(armIndex, repairOrdinal);
  }

  async function sendRepair(remainingMs: number): Promise<ArmGameResult> {
  const repair = await timedChat(
    target,
    repairTurns,
    Math.min(options.timeoutMs, remainingMs),
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
      initialDecisions,
      fingerprintFromParsed(repairValidation.parsed),
    );
    if (diffs.length > 0) {
      return failed('invalid_schema', attemptRecord, repairRecord, true, 'ok', diffs);
    }
    // Acceptance instant for the repair (the accepted attempt), rechecked
    // against the cutoff at that instant: a repair accepted at/after first pitch
    // is never a decision (§5). The initial attempt was NOT accepted, so its
    // acceptedAt stays null; only the repair carries the truthful accept time.
    const acceptedMs = nowMs();
    if (acceptedMs >= cutoffMs) {
      return failed('cutoff_missed', attemptRecord, repairRecord, true, 'ok', [
        'repair response accepted after the decision cutoff',
      ]);
    }
    return {
      ...base,
      outcome: 'valid',
      attempt: attemptRecord,
      repair: { ...repairRecord, acceptedAt: new Date(acceptedMs).toISOString() },
      repairUsed: true,
      repairTransport: 'ok',
      parsed: repairValidation.parsed,
      validationErrors: [],
    };
  }

  return failed('invalid_schema', attemptRecord, repairRecord, true, 'ok', repairValidation.errors);
  }
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
/**
 * A3 construction invariant: the completed results must be exactly the
 * `expectedArms × dispatched-games` grid — every cell present exactly once, no
 * foreign arm, no duplicate. runSlate builds this by construction; asserting it
 * before sealing turns any future regression into a loud failure rather than a
 * silently incomplete artifact.
 */
function assertCompleteGrid(
  results: readonly ArmGameResult[],
  expectedArms: readonly string[],
  prepared: readonly PreparedGameRequest[],
): void {
  const expected = new Set(expectedArms);
  const seen = new Set<string>();
  for (const r of results) {
    if (!expected.has(r.arm.participantId)) {
      throw new Error(`run produced a result for an unexpected arm: ${r.arm.participantId}`);
    }
    const cell = `${r.arm.participantId}:${r.gameId}`;
    if (seen.has(cell)) throw new Error(`run produced a duplicate result for ${cell}`);
    seen.add(cell);
  }
  for (const request of prepared) {
    for (const armId of expectedArms) {
      if (!seen.has(`${armId}:${request.gameId}`)) {
        throw new Error(`run is missing a result for ${armId} on game ${request.gameId}`);
      }
    }
  }
}

/**
 * Await EVERY launched arm before resolving or rejecting. `Promise.all` rejects on the first
 * failure while its siblings are still in flight — which, once a lease lifecycle is involved,
 * would let the caller proceed while a sibling's HTTP request and its durable slot are still
 * live. Collecting all settlements first means a fast arm never waits for a slow one, and a
 * failure is reported only after every sibling has finished and freed what it held.
 */
async function settleAll(tasks: readonly Promise<ArmGameResult>[]): Promise<ArmGameResult[]> {
  // Capture the CHRONOLOGICALLY first rejection — the exact error `Promise.all` would have
  // rejected with — while still awaiting every sibling. The change here is WHEN the caller is
  // told (after every arm has settled and freed what it held), never WHAT it is told: neither
  // a new aggregate nor the first-by-position failure would be the error a legacy caller saw.
  const firstRejection: Array<{ reason: unknown }> = [];
  const outcomes = await Promise.all(
    tasks.map((task) =>
      task.then(
        (value) => ({ ok: true as const, value }),
        (reason: unknown) => {
          if (firstRejection.length === 0) firstRejection.push({ reason });
          return { ok: false as const };
        },
      ),
    ),
  );
  if (firstRejection.length > 0) throw firstRejection[0]!.reason;
  return outcomes.map((o) => (o as { ok: true; value: ArmGameResult }).value);
}

export async function runSlate(
  arms: ArmSpec[],
  adapters: Map<string, ProviderAdapter>,
  requests: GameRequest[],
  options: SlateRunOptions,
): Promise<RunEnvelope> {
  // A3: reject a duplicate configured participantId BEFORE any provider call, so
  // the dispatched roster is inherently unique (no silent dedup). `expectedArms`
  // is the manifest of that roster, carried in the envelope.
  const expectedArms: string[] = [];
  const seenArms = new Set<string>();
  for (const arm of arms) {
    if (seenArms.has(arm.participantId)) {
      throw new Error(`duplicate participantId in the dispatch roster: ${arm.participantId}`);
    }
    seenArms.add(arm.participantId);
    expectedArms.push(arm.participantId);
  }

  // Seal + validate the whole batch BEFORE any provider call (unique game IDs,
  // identical shared slate metadata, genuine prepared origin). Dispatch then
  // runs on the sealed snapshot, and the artifact is built from it.
  const snapshot = sealDispatch(requests.map(prepareGameRequest));

  // Resolve the COMPLETE arm→adapter grid before any arm launches. Looking an adapter up
  // inside the launching map would let arm 0's request start and only then discover that a
  // later arm has no adapter — a partial dispatch. Resolving first makes that impossible.
  const targets: DispatchTarget[] = arms.map((arm) => {
    const adapter = adapters.get(arm.participantId);
    if (!adapter) throw new Error(`no adapter registered for ${arm.participantId}`);
    return {
      arm,
      hasCredential: () => adapter.hasCredential(),
      chat: (turns, timeoutMs, callOptions) => adapter.chat(turns, timeoutMs, callOptions),
    };
  });

  const all: ArmGameResult[] = [];
  let index = 0;
  for (const request of snapshot.prepared) {
    index += 1;
    const results = await settleAll(
      targets.map((target) => dispatchArm(target, request, options, null, 0)),
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

  assertCompleteGrid(all, expectedArms, snapshot.prepared);

  // A2/A5: deep-freeze the whole envelope graph and brand it, so the producers
  // authenticate ONE immutable value as the source of all dispatched evidence.
  const envelope: RunEnvelope = deepFreeze({
    snapshot,
    results: all,
    expectedArms,
    dispatch: {
      cohortId: options.cohortId,
      executionPolicy: options.executionPolicy,
      timeoutMs: options.timeoutMs,
      maxOutputTokens: options.maxOutputTokens,
    },
    // Authenticated derivation parameter (default: the full-board v0.2). The
    // producers derive baselines under this, so a scoped run stamps v0.3.
    baselinePolicyVersion: options.baselinePolicyVersion ?? BASELINE_POLICY_VERSION,
  });
  runEnvelopes.add(envelope);
  return envelope;
}

/**
 * The canonical authorized dispatch path: run ONE admitted fire's roster under its
 * permit-bound lease lifecycle.
 *
 * It accepts only a branded `AuthorizedDispatch` — never a raw `{permit, snapshot, plan}`
 * tuple and never a caller-owned adapter map — so the admission gate cannot be skipped by a
 * caller that assembles the pieces itself, and the arms dispatched are exactly the facades
 * captured before the claim was taken. The complete grid is resolved BEFORE any arm launches;
 * a preflight failure after authorization frees every unstarted initial lease and then
 * propagates, so a claim is never left holding capacity for a fire that never ran. Every
 * launched arm is awaited before this resolves or rejects.
 *
 * It produces the same branded `RunEnvelope` the legacy path produces; artifact production,
 * installation, and claim completion remain their own owners'.
 */
export async function runAuthorizedDispatch(
  dispatch: AuthorizedDispatch,
  options: SlateRunOptions,
): Promise<RunEnvelope> {
  assertAuthorizedDispatch(dispatch);
  const lifecycle = createAttemptLifecycle(dispatch);
  const permit = dispatch.permit;
  const prepared = dispatch.snapshot.prepared;

  // Complete preflight BEFORE any launch. Anything that can fail synchronously fails here,
  // while every initial lease is still unstarted and can be freed.
  let targets: DispatchTarget[];
  let expectedArms: string[];
  try {
    assertPrepared(prepared);
    if (options.cohortId !== permit.cohortId) {
      throw new Error(
        `run options cohortId ${options.cohortId} does not equal the authorized cohort ${permit.cohortId}`,
      );
    }
    if (prepared.gameId !== permit.gameId) {
      throw new Error('the authorized snapshot request is not the permitted game');
    }
    const facades = dispatch.plan.arms;
    if (facades.length === 0) throw new Error('the authorized plan carries no arms');
    const seen = new Set<string>();
    expectedArms = [];
    targets = facades.map((facade) => {
      if (seen.has(facade.participantId)) {
        throw new Error(`duplicate participantId in the authorized plan: ${facade.participantId}`);
      }
      seen.add(facade.participantId);
      expectedArms.push(facade.participantId);
      return {
        arm: {
          participantId: facade.participantId,
          provider: facade.provider as ArmSpec['provider'],
          requestedModelId: facade.requestedModelId,
          credentialEnvVar: facade.credentialEnvVar,
        },
        // The facades' bound methods — captured before the claim, never re-read from a map.
        hasCredential: () => facade.hasCredential(),
        chat: (turns, timeoutMs, callOptions) => facade.chat(turns, timeoutMs, callOptions),
      };
    });
  } catch (error) {
    // Nothing launched: free every unstarted initial lease, then surface the failure. If a
    // release itself failed, the preflight cause alone would hide the fact that this fire is
    // still holding durable capacity — so the cleanup fault is REPORTED, retaining the
    // preflight cause as its primary and naming every lease that is still held.
    let cleanupFault: unknown = null;
    try {
      await lifecycle.releaseAllUnstarted();
    } catch (failure) {
      cleanupFault = failure;
    }
    if (cleanupFault instanceof LifecycleFaultError && error instanceof Error) {
      throw new PreDispatchCleanupError(
        error,
        cleanupFault.failures.map((f) => ({ leaseId: f.leaseId, result: f.outcome === 'not_owner' ? 'not_owner' : 'threw' })),
        cleanupFault.failures.map((f) => ({ leaseId: f.leaseId, result: f.outcome === 'not_owner' ? 'not_owner' : 'threw' })),
      );
    }
    throw error;
  }

  // Launch the roster concurrently; a fast arm releases its slot without waiting for a slow
  // sibling, and every launched arm is awaited before this settles.
  const results = await settleAll(
    targets.map((target, armIndex) => dispatchArm(target, prepared, options, lifecycle, armIndex)),
  );
  assertCompleteGrid(results, expectedArms, [prepared]);

  const envelope: RunEnvelope = deepFreeze({
    snapshot: sealDispatch([prepared]),
    results,
    expectedArms,
    dispatch: {
      cohortId: options.cohortId,
      executionPolicy: options.executionPolicy,
      timeoutMs: options.timeoutMs,
      maxOutputTokens: options.maxOutputTokens,
    },
    baselinePolicyVersion: options.baselinePolicyVersion ?? BASELINE_POLICY_VERSION,
  });
  runEnvelopes.add(envelope);
  return envelope;
}
