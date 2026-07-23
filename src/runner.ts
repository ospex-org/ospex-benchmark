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
import { initialDispatchGate } from './attemptProvenance.js';
import type { GameRequest } from './bundle.js';
import { assertAuthorizedDispatch, PreDispatchCleanupError } from './lineOpenDispatch.js';
import type { AuthorizedDispatch } from './lineOpenDispatch.js';
import { AttemptCleanupFaultError, createAttemptLifecycle, LifecycleFaultError } from './lineOpenLifecycle.js';
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
   * and enforcement can never disagree temporally. REQUIRED at dispatch:
   * `dispatchArmCore` throws a typed `ClockRequiredError` when it is absent —
   * there is no ambient wall-clock fallback, because a default clock would
   * silently decouple the send-time V-lag gate from the recorded evidence.
   * The field stays optional on the TYPE because the authorized spine threads
   * the one tick clock in for its callers; every real caller injects a clock
   * (the dry run a synthetic clock anchored to the fixture).
   */
  nowMs?: (() => number) | undefined;
  /** Called after each game's four arms have all settled (sealed per game). */
  onGameComplete?: ((line: string) => void) | undefined;
}

/**
 * The send-time dispatch-gate operands for the INITIAL request, captured from the authenticated
 * sealed snapshot at the composition spine (`detectedAt`, the observation `windowEnd`, and the
 * `maxDispatchLagMs` bound) and threaded to the arm dispatch as positive capability. It is a
 * REQUIRED argument of `runAuthorizedDispatch` (there is no ungated authorized path); the legacy
 * `runSlate` / `runOneArmGame` pass `null` — structurally ungated for this new V-lag/windowEnd
 * capability, while their existing first-pitch checks remain in force. `scheduledAtAtFire` is not
 * carried here: it is the arm request's own `cutoffAt` (first pitch).
 */
export interface InitialDispatchGate {
  readonly detectedAt: string;
  readonly windowEnd: string;
  readonly maxDispatchLagMs: number;
}

/**
 * The injected dispatch clock (`SlateRunOptions.nowMs`) is a REQUIRED capability at dispatch time:
 * the send-time V-lag gate operand and every persisted timestamp both derive from it, so there is no
 * safe ambient fallback — a wall-clock default would silently decouple enforcement from the recorded
 * evidence. `dispatchArmCore` throws this typed fault when the clock is absent, fail-closed and BEFORE
 * any credential check or provider call. On the authorized path the per-arm throw is aggregated into
 * an `AuthorizedDispatchFaultError` (releasing every initial lease exactly once via the dispatch
 * cleanup backstop); the legacy path surfaces it directly. Every real caller injects a clock.
 */
export class ClockRequiredError extends Error {
  constructor() {
    super('a dispatch clock (options.nowMs) is required — there is no ambient wall-clock fallback');
    this.name = 'ClockRequiredError';
  }
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
  startMs: number,
): Promise<
  AttemptRecord & {
    response: ProviderResponse | null;
    failure: 'timeout' | 'rate_limited' | 'provider_error' | null;
  }
> {
  // The start reading is passed in (captured by the caller before the send), NOT re-read here:
  // the persisted `requestAt` AND `latencyMs` both derive from this one value, on success and
  // failure, so the initial's persisted start is byte-identical to the reading its send-time gate
  // evaluated.
  const startedAt = startMs;
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
 * immediately before its request, RE-CHECKS the cutoff after that await and INSIDE the release
 * scope (the acquisition itself takes time, a repair that would land after first pitch must not
 * be sent, and a clock that throws must not leak the slot), and frees the slot on every exit.
 * A cleanup that fails while another failure is propagating is composed with it, never
 * discarded. Without a lifecycle (`null`) the behaviour is exactly the legacy path — no gate is
 * added and nothing is released, because there is no durable lease.
 */
async function dispatchArm(
  target: DispatchTarget,
  request: PreparedGameRequest,
  options: SlateRunOptions,
  lifecycle: AttemptLifecyclePort | null,
  gate: InitialDispatchGate | null,
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
    return await dispatchArmCore(target, request, options, lifecycle, gate, armIndex, releaseInitial);
  } catch (error) {
    // Backstop for a throw before the settle-time release (e.g. a synchronous pre-call
    // failure): free the slot exactly once, never retried. If that release ALSO fails, BOTH
    // truths matter — the primary is what broke the attempt, and the cleanup fault means this
    // arm's durable slot is still held, which a lone primary would hide entirely.
    if (lifecycle !== null && !initialReleased) {
      initialReleased = true;
      try {
        await lifecycle.releaseInitial(armIndex);
      } catch (fault) {
        throw new AttemptCleanupFaultError(error, fault);
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
  gate: InitialDispatchGate | null,
  armIndex: number,
  releaseInitial: () => Promise<void>,
): Promise<ArmGameResult> {
  const arm = target.arm;
  // The dispatch clock is a REQUIRED capability — fail closed if it is absent, BEFORE any credential
  // check or provider call. There is no `?? Date.now` fallback: a wall-clock default would decouple
  // the V-lag gate from the persisted `requestAt`. Every real caller injects `options.nowMs`.
  if (options.nowMs === undefined) throw new ClockRequiredError();
  const nowMs = options.nowMs;
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

  // ONE clock reading, taken immediately before the send and after message-building, is the
  // single source of both the send-time gate operand AND the persisted `requestAt`: V-lag
  // "measured at the provider HTTP boundary" is approximated by this reading, which must precede
  // the send and equal the persisted start. When a gate is present (the authorized path), refuse
  // to send a doomed initial — first pitch / windowEnd reached, or the V-lag bound exceeded — and
  // emit the correct valid-negative with the never-sent shape, without spending a provider call.
  const initialStartMs = nowMs();
  if (gate !== null) {
    const verdict = initialDispatchGate({
      detectedAt: gate.detectedAt,
      windowEnd: gate.windowEnd,
      scheduledAtAtFire: request.cutoffAt,
      initialRequestStartedAt: new Date(initialStartMs).toISOString(),
      maxDispatchLagMs: gate.maxDispatchLagMs,
    });
    if (!verdict.ok) {
      await releaseInitial(); // skipped without a call
      const errorDetail =
        verdict.outcome === 'cutoff_missed'
          ? 'initial request start reached windowEnd/first pitch before send'
          : 'initial request would start too late after detection (V-lag)';
      return failed(verdict.outcome, { ...emptyAttempt(), errorDetail }, null, false, null, []);
    }
  }

  // Each request is bounded by the remaining time to cutoff. The persisted `requestAt` IS the
  // gated reading (`initialStartMs`), so the gate decision and the recorded start never disagree.
  const attempt = await timedChat(
    target,
    baseTurns,
    Math.min(options.timeoutMs, remainingAtDispatch),
    options.maxOutputTokens,
    nowMs,
    initialStartMs,
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
  if (lifecycle !== null) {
    const acquired = await lifecycle.acquireRepair(armIndex, repairOrdinal);
    if (!acquired.authorized) {
      return failed('invalid_schema', attemptRecord, null, false, null, [
        ...firstValidation.errors,
        'repair not dispatched: no repair concurrency slot was authorized',
      ]);
    }
    repairLeaseHeld = true;
  }

  try {
    // The acquisition itself awaited the store, so RE-CHECK first pitch immediately before the
    // HTTP call: a repair that would land after the cutoff must not be sent at all. This runs
    // INSIDE the release scope — the clock is an injected dependency, and a throw here must
    // still give the acquired slot back rather than leak it. Without a lifecycle nothing was
    // awaited since the check above, so the legacy path reads the clock no more times than
    // before and reuses that reading.
    const remainingForRepair = lifecycle === null ? remainingAtRepair : cutoffMs - nowMs();
    if (remainingForRepair <= 0) {
      return failed('cutoff_missed', attemptRecord, null, false, null, [
        ...firstValidation.errors,
        'repair not dispatched: decision cutoff passed while the repair slot was acquired',
      ]);
    }
    return await sendRepair(remainingForRepair);
  } catch (error) {
    // Free the slot while a failure is already propagating — and COMPOSE, never replace. A bare
    // `finally` whose release throws would annihilate the cause that actually broke the attempt
    // (the clock read above sits inside this scope precisely so its throw cannot leak the slot),
    // which is the same defect the initial-lease backstop composes away.
    if (repairLeaseHeld && lifecycle !== null) {
      repairLeaseHeld = false;
      try {
        await lifecycle.releaseRepair(armIndex, repairOrdinal);
      } catch (fault) {
        throw new AttemptCleanupFaultError(error, fault);
      }
    }
    throw error;
  } finally {
    // Free the repair slot on every NON-throwing exit — response, cutoff return, transport
    // outcome, or acceptance. (A throwing exit released above and cleared the flag.)
    if (repairLeaseHeld && lifecycle !== null) await lifecycle.releaseRepair(armIndex, repairOrdinal);
  }

  async function sendRepair(remainingMs: number): Promise<ArmGameResult> {
  // The repair takes its OWN fresh start reading — it is never gated by the initial dispatch gate
  // and never inherits `initialStartMs`. Every request, including a repair, must START before first
  // pitch: this fresh reading is the persisted start, the no-send authority, AND the timeout bound.
  // The post-acquire check ran on an earlier reading; if the clock crossed the cutoff since then,
  // the repair must NOT be sent — the provider call boundary is never reached at/after first pitch.
  const repairStartMs = nowMs();
  const remainingAtRepairStart = cutoffMs - repairStartMs;
  if (remainingAtRepairStart <= 0) {
    return failed('cutoff_missed', attemptRecord, null, false, null, [
      ...firstValidation.errors,
      'repair not dispatched: decision cutoff passed at repair start',
    ]);
  }
  const repair = await timedChat(
    target,
    repairTurns,
    Math.min(options.timeoutMs, remainingMs, remainingAtRepairStart),
    options.maxOutputTokens,
    nowMs,
    repairStartMs,
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
 * Every arm failure of ONE authorized dispatch. Reporting a single primary would hide the fact
 * that a sibling arm ALSO failed — and each lifecycle fault names a durable slot this fire may
 * still be holding, so no failure may be discarded.
 */
export class AuthorizedDispatchFaultError extends Error {
  /** One entry per rejected arm, in roster (arm index) order — never completion order. */
  readonly failures: readonly unknown[];
  constructor(failures: readonly unknown[], total: number) {
    // Our own counts only: coercing an arm's thrown value could throw and destroy this error
    // exactly when every retained cause is needed.
    super(`authorized dispatch failed: ${failures.length} of ${total} arm(s) raised`);
    this.name = 'AuthorizedDispatchFaultError';
    this.failures = Object.freeze([...failures]);
  }
}

/**
 * The CANONICAL settlement policy: await EVERY launched arm, then report every failure.
 *
 * `Promise.all` rejects on the first failure while its siblings are still in flight — which,
 * once a lease lifecycle is involved, would let the caller proceed while a sibling's HTTP
 * request and its durable slot are still live. Collecting all settlements first means a fast
 * arm never waits for a slow one, and a failure is reported only after every sibling has
 * finished and freed what it held. Keeping EVERY failure matters for the same reason: a
 * discarded second fault is a lease this fire may still hold that nobody is ever told about.
 *
 * This policy belongs to the authorized path alone — the legacy path has no durable leases and
 * keeps its pre-existing `Promise.all` behaviour.
 */
async function settleAllArms(tasks: readonly Promise<ArmGameResult>[]): Promise<ArmGameResult[]> {
  const outcomes = await Promise.all(
    tasks.map((task) =>
      task.then(
        (value) => ({ ok: true as const, value }),
        (reason: unknown) => ({ ok: false as const, reason }),
      ),
    ),
  );
  const values: ArmGameResult[] = [];
  const failures: unknown[] = [];
  for (const outcome of outcomes) {
    if (outcome.ok) values.push(outcome.value);
    else failures.push(outcome.reason);
  }
  if (failures.length > 0) throw new AuthorizedDispatchFaultError(failures, tasks.length);
  return values;
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
    // LEGACY settlement, deliberately NOT the canonical all-settled policy: with no lifecycle
    // there is no durable slot a sibling could still be holding, so this path keeps the exact
    // pre-existing `Promise.all` rejection identity AND timing. Routing it through the
    // canonical helper to share code would silently make a legacy caller wait for a slow
    // sibling and change the error it sees.
    const results = await Promise.all(
      targets.map((target) => dispatchArm(target, request, options, null, null, 0)),
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
 * propagates (with the complete cleanup log), so a claim is never left holding capacity for a
 * fire that never ran. Every launched arm is awaited before this resolves or rejects, and
 * EVERY arm failure is reported in one `AuthorizedDispatchFaultError`.
 *
 * It produces the same branded `RunEnvelope` the legacy path produces; artifact production,
 * installation, and claim completion remain their own owners'.
 *
 * The send-time initial-dispatch `gate` is a REQUIRED argument (positive capability): the
 * authorized path is never structurally ungated for the V-lag / windowEnd bounds. Its operands
 * are captured by the spine from the authenticated sealed snapshot; here they are threaded to
 * each arm and evaluated inside `dispatchArm`'s initial-lease cleanup backstop, so a malformed
 * operand that throws still releases every initial lease exactly once.
 */
export async function runAuthorizedDispatch(
  dispatch: AuthorizedDispatch,
  options: SlateRunOptions,
  gate: InitialDispatchGate,
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
      // The lifecycle's attempt log IS the cleanup log — the complete ordered set of leases it
      // tried, with the still-held ones as its non-released subset. Passing the failures as
      // both would report "2 of 2 failed" for a cleanup that actually attempted four.
      throw new PreDispatchCleanupError(error, cleanupFault.failures, cleanupFault.attempts);
    }
    throw error;
  }

  // Launch the roster concurrently; a fast arm releases its slot without waiting for a slow
  // sibling, every launched arm is awaited before this settles, and every arm failure is
  // reported rather than only the first.
  const results = await settleAllArms(
    targets.map((target, armIndex) => dispatchArm(target, prepared, options, lifecycle, gate, armIndex)),
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
