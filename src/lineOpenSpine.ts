import { assertPreparedFireSnapshot, deriveRunId } from './preparedFire.js';
import type { PreparedFireSnapshot } from './preparedFire.js';
import { assertDispatchPermit } from './lineOpenClaim.js';
import type { ClaimPort, DispatchPermit } from './lineOpenClaim.js';
import { settleCompletedFire } from './fireSettlement.js';
import type { CompletionStatus } from './fireSettlement.js';
import { authorizePreparedDispatch, scopeKeyOf } from './lineOpenDispatch.js';
import type { AuthorizePreparedDispatchResult } from './lineOpenDispatch.js';
import { runAuthorizedDispatch } from './runner.js';
import type { InitialDispatchGate, SlateRunOptions } from './runner.js';
import { assertFireArtifact, buildFireArtifact } from './fireArtifactProducer.js';
import type { FireArtifactV1, FireContext, MarketFireContextV1 } from './fireArtifactProducer.js';
import { MARKET_ORDINAL } from './fireArtifact.js';
import { FireArtifactSink } from './fireArtifactSink.js';
import { deriveFireSpendReservationUsdMicros, spendReservationPolicyForVersion } from './spendReservationPolicy.js';
import type { CohortManifestV1 } from './manifest.js';
import type { MarketKey, ProviderAdapter } from './types.js';
import type { AdmitDispatchRequest, ClaimKey } from './store/contract.js';

/**
 * The composition spine: the single thin entry that runs ONE sealed fire end to end — admit,
 * authorize, dispatch, produce, reconcile, install, settle — and returns a typed outcome.
 *
 * Every stage it calls is already merged and already fail-closed by its own brand: this module
 * mints no permit, plan, dispatch, artifact, or lease authority, and holds no store, provider, or
 * filesystem of its own. Its only genuinely new logic is (a) DERIVING the full-scope admission
 * request from the sealed snapshot, (b) the permit↔artifact RECONCILIATION the durable sink
 * reserves for "a later slice's thin authorized wrapper" — the check that the fire we admitted is
 * the fire we are about to persist — and (c) settling the claim exactly once, strictly AFTER the
 * artifact is durably installed. The sink deliberately never sees a permit, and the producer never
 * sees one either, so nothing else in the pipeline compares the admission's identity to the
 * artifact's; this module is where those two independently-derived paths meet.
 *
 * This stays non-activating: nothing schedules `runOneFire`, no CLI/watcher/smoke calls it, and it
 * touches no `--live` path. It settles the claim only through the permit-resolved completion
 * capability, and it folds any settle failure to a typed `unsettled` completion that never discards
 * the persisted artifact — an activation consumer must branch on `completion.status` and escalate
 * `unsettled` (a later recovery slice re-settles an aged `unsettled` fire against durable
 * exact-artifact proof). Canonical persistence must survive the production host lifecycle: the local
 * filesystem sink is crash-consistent only on a persistent POSIX filesystem, so a durable
 * external/mounted sink — not dyno-local files — is the canonical evidence root at activation.
 */

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** The config inputs the caller supplies; the spend reservation and everything else are derived
 *  from authenticated boot state, never accepted from the caller. */
export interface LineOpenAdmissionParameters {
  readonly ownerId: string;
  readonly expectedSchemaVersion: number;
}

/** Run options WITHOUT `cohortId` or `nowMs`: the spine derives the cohort from the admitted permit,
 *  and threads the ONE tick clock (`RunOneFireInput.now`) into the dispatch itself — so a caller can
 *  neither point the runner at a cohort other than the one the store authorized, nor supply a dispatch
 *  clock that diverges from the detection clock. */
export type LineOpenRunOptions = Omit<SlateRunOptions, 'cohortId' | 'nowMs'>;

/** The resolved outcome of one durable install: the canonical path and whether THIS call created it. */
export type ArtifactInstallResult = ReturnType<FireArtifactSink['install']>;

/**
 * Exactly the sink capability the spine needs — the single `install` method, nothing else. Its return
 * may be synchronous or a promise: the local filesystem sink resolves synchronously, but a durable
 * external/object sink is normally asynchronous. The spine awaits the install, so completion ordering
 * holds for either — a pending install promise must resolve before settlement begins, and it must
 * never run before an install that could still reject. A dyno-local filesystem is not canonical durable
 * evidence (see the module header); the awaitable seam lets a reviewed durable sink drop in later
 * without reopening the ordering.
 */
export interface ArtifactInstaller {
  install(artifact: FireArtifactV1): ArtifactInstallResult | Promise<ArtifactInstallResult>;
}

/** The eight independently-derived dimensions on which a produced artifact must agree with the
 *  admission permit, in the fixed order the error reports them. */
export type FireReconciliationDimension =
  | 'cohortId'
  | 'fireId'
  | 'runId'
  | 'gameId'
  | 'scopedMarkets'
  | 'marketClaims'
  | 'requestSha256'
  | 'initialLeaseRoster';

/** The fixed report order; also the order `reconcileArtifactToPermit` evaluates and lists. */
const RECONCILIATION_ORDER: readonly FireReconciliationDimension[] = [
  'cohortId',
  'fireId',
  'runId',
  'gameId',
  'scopedMarkets',
  'marketClaims',
  'requestSha256',
  'initialLeaseRoster',
];

/**
 * A produced artifact whose identity disagrees with the admission permit. Genuine branded values
 * that fail to reconcile raise this; a forged/substituted artifact or permit instead fails its own
 * brand assertion, which propagates unwrapped. The message is built ONLY from S4's own dimension
 * labels — never a compared value — so a hostile field cannot destroy this typed error.
 */
export class FireReconciliationError extends Error {
  readonly dimensions: readonly FireReconciliationDimension[];
  constructor(dimensions: readonly FireReconciliationDimension[]) {
    super(`fire artifact does not reconcile with the admission permit on: ${dimensions.join(', ')}`);
    this.name = 'FireReconciliationError';
    this.dimensions = Object.freeze([...dimensions]);
  }
}

/** A non-authorizing admission is returned by identity; a successful fire returns its narrow Installed
 *  result — the durable artifact plus the completion status. `kind: 'Installed'` describes durable
 *  artifact presence; `completion.status` independently reports completion CONFIRMATION (`settled`, or
 *  `unsettled` with a reason whose store-state confidence a consumer reads), not omniscient canonical
 *  state. No envelope, pricing actual, or raw model response. */
export type LineOpenFireOutcome =
  | Extract<AuthorizePreparedDispatchResult, { kind: 'NotAdmitted' }>
  | {
      readonly kind: 'Installed';
      readonly permit: DispatchPermit;
      readonly artifact: FireArtifactV1;
      readonly install: ArtifactInstallResult;
      readonly completion: CompletionStatus;
    };

export interface RunOneFireInput {
  readonly snapshot: PreparedFireSnapshot;
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly claimPort: ClaimPort;
  readonly sink: ArtifactInstaller;
  readonly runOptions: LineOpenRunOptions;
  readonly admission: LineOpenAdmissionParameters;
  /** The ONE tick clock (from `CohortTickInput.now`): the SOLE source of BOTH the projection
   *  `detectedAt` (stamped upstream by `projectPreparedFires`) and the dispatch `runnerOptions.nowMs`,
   *  so detection and the send-time V-lag gate compare against a single coherent benchmark-host clock.
   *  Captured before the first await, like every other caller input. */
  readonly now: () => number;
}

// ---------------------------------------------------------------------------
// The full-scope admission request (derived, never accepted)
// ---------------------------------------------------------------------------

/**
 * The per-fire spend reservation, DERIVED from authenticated boot state — never accepted from the
 * caller. It is `roster × (1 + maxRepairs) × providerAttemptReservationUsdMicros` for the manifest's
 * pinned spend-reservation policy, so it varies automatically with the roster, the repair cap, and
 * the (versioned) per-attempt amount — no magic constant lives here. The manifest's pinned
 * per-attempt amount is re-verified against the code-owned policy value even though canonical boot
 * already did, so the directly-exported builder is fail-closed on its own: an unknown policy version
 * or a mismatched amount throws BEFORE any request is built, so no claim or dispatch can begin.
 */
export function deriveSpendReservationUsdMicros(manifest: CohortManifestV1): number {
  const version = manifest.spendReservationPolicyVersion;
  const policy = spendReservationPolicyForVersion(version); // unknown version throws
  if (
    manifest.constants.providerAttemptReservationUsdMicros !== policy.providerAttemptReservationUsdMicros
  ) {
    throw new Error(
      `manifest providerAttemptReservationUsdMicros (${manifest.constants.providerAttemptReservationUsdMicros}) ` +
        `does not match spend-reservation policy "${version}" (${policy.providerAttemptReservationUsdMicros})`,
    );
  }
  return deriveFireSpendReservationUsdMicros({
    rosterSize: manifest.expectedArmRoster.length,
    maxRepairsPerArm: manifest.constants.maxRepairAttemptsPerArm,
    version,
  });
}

/**
 * Derive the admission request for the WHOLE proposed scope from the sealed snapshot. The
 * snapshot is authenticated before any field is read, and every identity/scope/digest field comes
 * from it — only the owner and schema version are caller-supplied; the spend reservation is derived
 * from authenticated boot state (never accepted). The one reservation is keyed by the full-scope
 * key: this is the full-scope fixture path, and the store refuses (post-admission, releasing every
 * lease) any narrower retained scope.
 */
export function buildFullScopeAdmitRequest(
  snapshot: PreparedFireSnapshot,
  admission: LineOpenAdmissionParameters,
): AdmitDispatchRequest {
  assertPreparedFireSnapshot(snapshot);
  // Capture the caller's admission fields exactly once.
  const ownerId = admission.ownerId;
  const expectedSchemaVersion = admission.expectedSchemaVersion;
  // The spend reservation is DERIVED from authenticated boot state — never accepted from the
  // caller — so a caller can neither under-reserve past the cap nor pin a different amount. Any
  // runtime-extra spend field on `admission` is therefore ignored.
  const spendReservationUsdMicros = deriveSpendReservationUsdMicros(snapshot.booted.manifest);
  // Every remaining field is DERIVED from the authenticated snapshot.
  const proposedMarkets = [...snapshot.proposedMarkets];
  const scopeKey = scopeKeyOf(snapshot.proposedMarkets);
  return {
    cohortId: snapshot.booted.cohortId,
    fireId: snapshot.fireId,
    ownerId,
    expectedSchemaVersion,
    gameId: snapshot.prepared.gameId,
    proposedMarkets,
    scopeReservations: {
      [scopeKey]: {
        spendReservationUsdMicros,
        preparedBytesDigest: snapshot.prepared.requestSha256,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Fail closed unless the produced artifact reconciles with the admission permit on all eight
 * dimensions. Both inputs are authenticated by their own brand BEFORE any field is read, so a
 * forged artifact or permit fails its brand assertion (which propagates unwrapped) rather than
 * reaching this comparison. Every compared property is captured once; the permit's claimed keys
 * and lease indexes are canonicalized locally, never positionally zipped in raw store order; all
 * eight dimensions are computed with no early exit; and a single `FireReconciliationError` lists
 * every disagreeing dimension in the fixed order.
 */
export function reconcileArtifactToPermit(artifact: FireArtifactV1, permit: DispatchPermit): void {
  assertFireArtifact(artifact);
  assertDispatchPermit(permit);

  // Capture every compared property/array exactly once.
  const aCohortId = artifact.cohortId;
  const aFireId = artifact.fireId;
  const aRunId = artifact.runId;
  const aGameId = artifact.gameId;
  const aScopedMarkets = [...artifact.scopedMarkets];
  const aClaims = artifact.marketEvidence.map((e) => e.claim);
  const aRequestSha256 = artifact.requestSha256;
  const aExpectedArmCount = artifact.expectedArmIdentities.length;

  const pCohortId = permit.cohortId;
  const pFireId = permit.fireId;
  const pGameId = permit.gameId;
  const pPreparedBytesDigest = permit.preparedBytesDigest;
  const pClaimedKeys = [...permit.claimedKeys];
  const pLeaseIndexes = permit.initialLeases.map((l) => l.armIndex);

  // Canonicalize the permit's keys and lease indexes locally.
  const canonicalKeys = [...pClaimedKeys].sort((a, b) => MARKET_ORDINAL[a.market] - MARKET_ORDINAL[b.market]);
  const permitMarkets = canonicalKeys.map((k) => k.market);
  const sortedLeaseIndexes = [...pLeaseIndexes].sort((a, b) => a - b);

  // scopedMarkets: the artifact's scope equals the permit's canonical claimed-market sequence.
  const scopedMarketsOk =
    aScopedMarkets.length === permitMarkets.length && aScopedMarkets.every((m, i) => m === permitMarkets[i]);

  // marketClaims: every artifact claim equals its canonical permit key (cohort/fire from the
  // permit, game/market from the key), field by field, mapped by market — never positionally.
  // marketClaims is a ONE-TO-ONE relation: both sides must be a set of DISTINCT markets, the two
  // market sets must be equal, and each artifact claim must match its permit key field by field.
  // Equal array length alone is insufficient — duplicate permit keys [ml, ml] against an artifact
  // [ml, total] have equal length yet leave the total claim with no permit key.
  const permitKeyByMarket = new Map<MarketKey, ClaimKey>();
  let permitMarketsDistinct = true;
  for (const key of canonicalKeys) {
    if (permitKeyByMarket.has(key.market)) permitMarketsDistinct = false;
    permitKeyByMarket.set(key.market, key);
  }
  const claimByMarket = new Map<MarketKey, (typeof aClaims)[number]>();
  let claimMarketsDistinct = true;
  for (const claim of aClaims) {
    if (claimByMarket.has(claim.market)) claimMarketsDistinct = false;
    claimByMarket.set(claim.market, claim);
  }
  let marketClaimsOk =
    permitMarketsDistinct && claimMarketsDistinct && permitKeyByMarket.size === claimByMarket.size;
  for (const [market, key] of permitKeyByMarket) {
    const claim = claimByMarket.get(market);
    if (
      claim === undefined ||
      claim.cohortId !== pCohortId ||
      claim.fireId !== pFireId ||
      claim.gameId !== key.gameId ||
      claim.market !== key.market
    ) {
      marketClaimsOk = false;
    }
  }

  // initialLeaseRoster: sorted permit arm indexes are exactly 0..N-1 for N expected arms — this
  // detects a missing, duplicated, or foreign index, and any cardinality mismatch.
  let rosterOk = sortedLeaseIndexes.length === aExpectedArmCount;
  for (let i = 0; i < sortedLeaseIndexes.length; i += 1) {
    if (sortedLeaseIndexes[i] !== i) rosterOk = false;
  }

  const failed: FireReconciliationDimension[] = [];
  if (aCohortId !== pCohortId) failed.push('cohortId');
  if (aFireId !== pFireId) failed.push('fireId');
  if (aRunId !== deriveRunId(pFireId)) failed.push('runId');
  if (aGameId !== pGameId) failed.push('gameId');
  if (!scopedMarketsOk) failed.push('scopedMarkets');
  if (!marketClaimsOk) failed.push('marketClaims');
  if (aRequestSha256 !== pPreparedBytesDigest) failed.push('requestSha256');
  if (!rosterOk) failed.push('initialLeaseRoster');

  if (failed.length > 0) {
    // Report in the fixed order (the pushes above already follow it; this pin makes it explicit).
    throw new FireReconciliationError(RECONCILIATION_ORDER.filter((d) => failed.includes(d)));
  }
}

/**
 * The thin authorized wrapper the durable sink reserved: reconcile, then install the EXACT artifact
 * object. On reconciliation failure the sink is never called; on success the sink receives the same
 * object by identity (no copy, spread, re-wrap, or reconstruction — the producer brand and the
 * sink's parse both depend on it), a sink throw propagates unchanged, and a `{created:false}`
 * idempotent result is returned as-is.
 */
export async function installReconciledArtifact(
  artifact: FireArtifactV1,
  permit: DispatchPermit,
  sink: ArtifactInstaller,
): Promise<ArtifactInstallResult> {
  reconcileArtifactToPermit(artifact, permit);
  return await sink.install(artifact);
}

// ---------------------------------------------------------------------------
// The spine
// ---------------------------------------------------------------------------

/**
 * Run one sealed fire end to end. The stage order is fixed: capture every caller input before the
 * first await; authenticate the snapshot and derive the admission request; authorize; and — the
 * instant a genuine `AuthorizedDispatch` exists — run the permit-bound dispatch as the first
 * fallible post-admission operation, so no S4 work can throw or leak while leases are held.
 * Context assembly, production, reconciliation, and install happen only after the lifecycle runner
 * has settled every lease.
 */
export async function runOneFire(input: RunOneFireInput): Promise<LineOpenFireOutcome> {
  // (1-2) Capture top-level references and admission fields once.
  const snapshot = input.snapshot;
  const adapters = input.adapters;
  const claimPort = input.claimPort;
  const sink = input.sink;
  const runOptions = input.runOptions;
  const ownerId = input.admission.ownerId;
  const expectedSchemaVersion = input.admission.expectedSchemaVersion;
  // The ONE tick clock, captured (like every other caller input) BEFORE the first await so a later
  // swap of `input.now` cannot redirect the dispatch. It is the sole source of the dispatch's
  // `runnerOptions.nowMs` — the SAME clock that stamped the snapshot's `detectedAt` upstream — so the
  // send-time V-lag gate and detection share one coherent benchmark-host clock.
  const now = input.now;

  // (3) Capture each run-option field into a fresh plain object, explicitly OMITTING any
  //     runtime-extra `cohortId` a hostile caller may have stuck on the options object. The clock
  //     is NOT among these fields — it is the threaded tick clock captured above, not a caller field.
  const capturedOptions = {
    timeoutMs: runOptions.timeoutMs,
    maxOutputTokens: runOptions.maxOutputTokens,
    executionPolicy: runOptions.executionPolicy,
    baselinePolicyVersion: runOptions.baselinePolicyVersion,
    onGameComplete: runOptions.onGameComplete,
  };

  // (4) Bind the claim and install method references now, so a later swap of the caller's
  //     `claimPort.admit` / `sink.install` across an await cannot redirect the operation.
  const admit = claimPort.admit.bind(claimPort);
  const install = sink.install.bind(sink);
  const capturedClaimPort: ClaimPort = { admit };
  const capturedInstaller: ArtifactInstaller = { install };

  // (5) Authenticate the snapshot and derive the full-scope admission request.
  const request = buildFullScopeAdmitRequest(snapshot, {
    ownerId,
    expectedSchemaVersion,
  });

  // (5b) Capture the send-time initial-dispatch gate operands from the AUTHENTICATED sealed
  //      snapshot — the detection instant, the observation window end, and the max dispatch lag —
  //      now that (5) authenticated the snapshot, and BEFORE admission. These three are ALWAYS
  //      sourced from the snapshot, never from caller-owned `runOptions`; sourcing them from the
  //      authenticated evidence is what makes the gate authoritative. This is a pure field capture
  //      (no fallible operation), so it does not displace `runAuthorizedDispatch` as the first
  //      fallible post-admission op while leases are held.
  const gate: InitialDispatchGate = {
    detectedAt: snapshot.detectedAt,
    windowEnd: snapshot.booted.manifest.windowEnd,
    maxDispatchLagMs: snapshot.booted.manifest.constants.maxDispatchLagMs,
  };

  // (6) S2 captures the adapter plan (from the caller's map) before it takes the claim.
  const result = await authorizePreparedDispatch({
    snapshot,
    adapters,
    request,
    claimPort: capturedClaimPort,
  });

  // A non-authorizing admission does not dispatch here: return the exact classified result by
  // identity (a capacity `Defer` is retryable next tick; a `Skip` is terminal for this dispatch;
  // a `Fault` is loud). A claim-port throw has already propagated out of the await unchanged.
  if (result.kind === 'NotAdmitted') return result;

  const dispatch = result.dispatch;
  const permit = dispatch.permit;

  // Dispatch is the FIRST fallible post-admission operation: no S4 check runs between a successful
  // authorization and this call. The cohort is derived from the permit and written last onto a
  // fresh options object; no caller `runOptions` object is spread or re-read after admission. The
  // clock is the tick clock captured before the first await (B2): the SAME source that stamped the
  // snapshot's `detectedAt`, so the send-time V-lag operands cannot silently come from two clocks.
  const runnerOptions: SlateRunOptions = {
    timeoutMs: capturedOptions.timeoutMs,
    maxOutputTokens: capturedOptions.maxOutputTokens,
    executionPolicy: capturedOptions.executionPolicy,
    baselinePolicyVersion: capturedOptions.baselinePolicyVersion,
    nowMs: now,
    onGameComplete: capturedOptions.onGameComplete,
    cohortId: permit.cohortId,
  };
  // A dispatch rejection propagates unchanged with its retained causes; no producer/reconcile/
  // install stage runs, so a fire that could not complete leaves no durable record. The gate
  // captured in (5b) from the sealed snapshot is passed as required positive capability — the
  // snapshot-derived operands, never `runOptions`, decide whether each initial may send.
  const envelope = await runAuthorizedDispatch(dispatch, runnerOptions, gate);

  // Only now — every lease settled — assemble the fire context. Its evidence comes from the sealed
  // snapshot; each claim is built from the PERMIT (cohort/fire from the permit, game/market from
  // the captured, canonicalized permit claimed key), mapped by market, never positionally zipped.
  const canonicalKeys = [...permit.claimedKeys].sort(
    (a, b) => MARKET_ORDINAL[a.market] - MARKET_ORDINAL[b.market],
  );
  const keyByMarket = new Map<MarketKey, ClaimKey>(canonicalKeys.map((k) => [k.market, k]));
  const perMarket: MarketFireContextV1[] = snapshot.perMarket.map((evidence) => {
    const key = keyByMarket.get(evidence.market);
    if (key === undefined) {
      // Unreachable on the authorized path: S2 admission guarantees the claimed markets equal the
      // snapshot's proposed scope. This is a total-function guard for an exhaustive map, not a
      // snapshot-vs-permit scope re-check (that relation is S2's, and reconciliation's below).
      throw new Error(`no admitted claim key for market ${evidence.market}`);
    }
    return {
      candidateInput: evidence.candidateInput,
      verdict: evidence.verdict,
      historyRows: evidence.historyRows,
      historyWatermark: evidence.historyWatermark,
      claim: { cohortId: permit.cohortId, fireId: permit.fireId, gameId: key.gameId, market: key.market },
    };
  });

  const ctx: FireContext = {
    booted: snapshot.booted,
    fireId: snapshot.fireId,
    runId: snapshot.runId,
    publication: snapshot.publication,
    bundleBuiltAt: snapshot.bundleBuiltAt,
    perMarket,
  };

  const artifact = buildFireArtifact(envelope, ctx);
  const installed = await installReconciledArtifact(artifact, permit, capturedInstaller);
  // Only after the artifact is durably installed does this run settle the claim exactly once. A settle
  // refusal or throw NEVER discards the persisted artifact: it folds to a typed `unsettled` completion
  // for an activation consumer to escalate. A known refusal leaves the claim confirmed `pending`; a
  // failed/mismatched completion is UNCONFIRMED (the store may be `pending` or already `completed`), but
  // the artifact is preserved and the reservation is only ever conservatively held — never over-admitting
  // and never a blind re-settle. Install throwing/rejecting propagates BEFORE this line, so settlement
  // never runs for a fire whose evidence did not persist.
  const completion = await settleCompletedFire(permit);
  return { kind: 'Installed', permit, artifact, install: installed, completion };
}
