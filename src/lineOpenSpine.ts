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
import { assertCohortAdapterCapability } from './cohortAdapterCapability.js';
import type { CohortAdapterCapability } from './cohortAdapterCapability.js';
import { SPEND_GUARD_PRICE_TABLE_VERSION, modelPriceTableDigest } from './modelPriceTable.js';
import { computeFireSpendGuard } from './spendGuard.js';
import type { FireSpendVerdict, GuardArmInput, SpendGuardOffender } from './spendGuard.js';
import { buildSpendEscalationSidecar, spendEscalationSidecarSha256 } from './spendEscalationSidecar.js';
import type { SpendEscalationSidecarV1 } from './spendEscalationSidecar.js';
import { deriveFireSpendReservationUsdMicros, spendReservationPolicyForVersion } from './spendReservationPolicy.js';
import type { CohortManifestV1 } from './manifest.js';
import type { MarketKey, ProviderAdapter } from './types.js';
import type { AdmitDispatchRequest, ClaimKey } from './store/contract.js';

/**
 * The composition spine: the single thin entry that runs ONE sealed fire end to end — admit,
 * authorize, dispatch, produce, reconcile, install, settle — and returns a typed outcome.
 *
 * Each stage has its own fail-closed boundary: this module mints no permit, plan, dispatch,
 * artifact, or lease authority, and holds no store, provider, or filesystem of its own. It derives
 * the full-scope admission request, reconciles the permit to the produced artifact, applies the
 * post-dispatch spend guard, installs the canonical artifact (plus an escalation sidecar when
 * required), and settles a clean claim exactly once strictly AFTER durable installation. The sink
 * deliberately never sees a permit, and the producer never sees one either, so this module is where
 * those independently-derived identity paths meet.
 *
 * This build remains non-activating for REAL provider spend: the production cohort runner and its
 * fixture CLI reach `runOneFire` only through the mock, `known-zero` capability producer; no `--live`
 * path or gated real-adapter producer exists here. It settles a clean claim only through the
 * permit-resolved completion capability, and it folds any settle failure to a typed `unsettled`
 * completion that never discards the persisted artifact — an activation consumer must branch on
 * `completion.status` and escalate
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
  /** Durably install a spend-escalation sidecar beside the fire's artifact (same atomic
   *  no-clobber contract). REQUIRED on the seam so every sink decides its disposition —
   *  a sink that can never see an escalation (the rehearsal no-op) throws. */
  installSpendEscalationSidecar(sidecar: SpendEscalationSidecarV1): ArtifactInstallResult | Promise<ArtifactInstallResult>;
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

/**
 * Why a PRE-CLAIM canonical-window gate refused a fire before any claim (B1 / D7). The gate reads the
 * ONE authenticated pre-claim clock and compares it to the two canonical boundaries the sealed snapshot
 * carries: `first_pitch_before_claim` when the reading is already at/after first pitch
 * (`snapshot.prepared.cutoffAt`); `window_end_before_claim` when it is at/after the observation window
 * end (`snapshot.booted.manifest.windowEnd`). First pitch takes precedence when both have passed. These
 * are ADVISORY runner reasons on a DEDICATED type — deliberately disjoint from the arm-outcome enum
 * (`ArmOutcome`) and the projector `DeferReason` / `RejectReason`: a pre-claim coverage miss is a NEW
 * classification, never an already-claimed arm-level `cutoff_missed`.
 */
export type CoverageMissReason = 'first_pitch_before_claim' | 'window_end_before_claim';

/** The EXACT operand set the pre-claim gate compared, kept structurally SEPARATE from the advisory
 *  `reason` (B1-R5): the single pre-claim clock reading (the sole source of both the comparison and
 *  this persisted value), and — from the authenticated snapshot — first pitch, the observation window
 *  end, and the detection instant. All four are ISO-8601 strings (the artifact timestamp convention). */
export interface CoverageMissOperands {
  readonly preClaimReadingAt: string;
  readonly scheduledAtAtFire: string;
  readonly windowEnd: string;
  readonly detectedAt: string;
}

/**
 * The PRE-CLAIM canonical-window gate reads the ONE tick clock BEFORE deciding whether a timely initial
 * is still possible; a non-finite reading (`NaN` / `±Infinity`) is a broken clock the gate cannot
 * evaluate. It fails CLOSED — throwing this typed fault rather than letting `NaN >= x` evaluate false and
 * fall through to admission — so a bad clock can never silently admit a fire the gate should have refused.
 */
export class PreClaimClockError extends Error {
  constructor() {
    super('the pre-claim canonical-window gate requires a finite clock reading — a non-finite reading fails closed');
    this.name = 'PreClaimClockError';
  }
}

/**
 * A BILLABLE fire's guard price identity must be the identity its authenticated cohort
 * precommitted to: the booted manifest must pin the conservative guard table version AND
 * its recomputed digest. This is checked BEFORE any claim is taken (zero spend), so a
 * billable tick under a manifest that pins a different (cheaper) table refuses loudly
 * instead of judging money under an identity the cohort never committed to. Known-zero
 * cohorts are exempt — they may keep pinning the historical replay table.
 */
export class BillablePriceIdentityError extends Error {
  constructor(manifestVersion: string, manifestDigest: string) {
    super(
      `a billable fire requires the booted manifest to pin the conservative guard price table ` +
        `("${SPEND_GUARD_PRICE_TABLE_VERSION}" + its digest); this manifest pins "${manifestVersion}" ` +
        `(digest ${manifestDigest}) — refusing before any claim or dispatch`,
    );
    this.name = 'BillablePriceIdentityError';
  }
}

/**
 * A NON-money fault escaped the spend guard AFTER a dispatch had already run. The paid
 * attempt's artifact was durably installed FIRST (its path is carried here), the claim
 * and reservation remain retained, and the original fault is preserved as `cause` — an
 * internal bug is surfaced loudly, never converted to a PASS or masked as a money
 * UNKNOWN, and it can no longer discard the evidence of what was spent.
 */
export class SpendGuardInternalError extends Error {
  readonly installedArtifactPath: string;
  override readonly cause: unknown;
  constructor(installedArtifactPath: string, cause: unknown) {
    super(
      `the spend guard raised a non-money fault after dispatch; the fire artifact was installed ` +
        `first at ${installedArtifactPath} and the claim remains retained — investigate the cause`,
    );
    this.name = 'SpendGuardInternalError';
    this.installedArtifactPath = installedArtifactPath;
    this.cause = cause;
  }
}

/** A non-authorizing admission is returned by identity; a successful fire returns its narrow Installed
 *  result — the durable artifact plus the completion status. `kind: 'Installed'` describes durable
 *  artifact presence; `completion.status` independently reports completion CONFIRMATION (`settled`, or
 *  `unsettled` with a reason whose store-state confidence a consumer reads), not omniscient canonical
 *  state. No envelope, pricing actual, or raw model response. A `CoverageMiss` is the PRE-CLAIM gate's
 *  distinct outcome (B1): a timely initial was already impossible at the authenticated pre-claim clock
 *  reading, so NO claim was taken, NO artifact produced, and NO budget consumed — the candidate becomes
 *  a coverage miss through a later independent finalizer (never routed here). An `InstalledEscalated`
 *  fire ALSO durably installed its artifact — install is unconditional once evidence exists — but the
 *  spend guard refused settlement, so its claim/reservation is deliberately left pending. */
export type LineOpenFireOutcome =
  | Extract<AuthorizePreparedDispatchResult, { kind: 'NotAdmitted' }>
  | {
      readonly kind: 'CoverageMiss';
      readonly reason: CoverageMissReason;
      readonly operands: CoverageMissOperands;
    }
  | {
      readonly kind: 'Installed';
      readonly permit: DispatchPermit;
      readonly artifact: FireArtifactV1;
      readonly install: ArtifactInstallResult;
      readonly completion: CompletionStatus;
    }
  | {
      /** The fire's evidence IS durably installed, but the runtime spend guard refused settlement:
       *  at least one billable attempt priced over the per-attempt reservation
       *  (`spend_attempt_over_reservation`), or at least one billable attempt could not be priced
       *  with confidence (`spend_evidence_unknown` — an UNKNOWN spend escalates, never reads as
       *  zero). The claim and its full reservation are deliberately RETAINED (never settled, never
       *  released here), and the serial tick stops admitting further fires. The escalation is NOT
       *  written to the store — the store cannot infer a per-attempt breach from an aggregate under
       *  the fire reservation — so the durable evidence is the installed artifact plus the redacted
       *  token-only sidecar installed beside it; a consumer surfaces this outcome loudly instead.
       *
       *  Deliberately NO `DispatchPermit` here: the escalated result is artifact/install identity
       *  only. A permit is live settlement authority (it resolves a completion capability), and
       *  handing it to the caller of an outcome whose whole point is "do NOT settle" would let that
       *  caller settle the refused claim. Any later completion must go through a reviewed recovery
       *  path against the durable evidence — never a blind re-settle off this record. */
      readonly kind: 'InstalledEscalated';
      readonly artifact: FireArtifactV1;
      readonly install: ArtifactInstallResult;
      /** The durable redacted token-only escalation evidence: path, whether THIS call created it,
       *  and the sha256 of its canonical bytes (the operator-report hash). */
      readonly sidecar: { readonly path: string; readonly created: boolean; readonly sha256: string };
      readonly reason: 'spend_attempt_over_reservation' | 'spend_evidence_unknown';
      /** Every non-passing attempt, in arm order — identity, role, and (for a breach) the
       *  conservative derived-actual that crossed the reservation. */
      readonly offenders: readonly SpendGuardOffender[];
    };

export interface RunOneFireInput {
  readonly snapshot: PreparedFireSnapshot;
  /** The MINTED adapter capability — the single value carrying both the adapter facades and
   *  their billing provenance, produced by a capability producer. A raw adapter map, a
   *  structural lookalike, or a spread/copy fails the runtime brand before anything runs, so
   *  a caller can never pair adapters with a billing label of its own choosing at this seam. */
  readonly capability: CohortAdapterCapability;
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
  sink: Pick<ArtifactInstaller, 'install'>,
): Promise<ArtifactInstallResult> {
  reconcileArtifactToPermit(artifact, permit);
  return await sink.install(artifact);
}

// ---------------------------------------------------------------------------
// The pre-claim canonical-window gate (B1)
// ---------------------------------------------------------------------------

/**
 * Build the FROZEN `CoverageMiss` outcome for a pre-claim canonical-window refusal (B1). The four
 * operands are the EXACT values the gate compared: the single pre-claim reading (`preClaimReadingAt`,
 * derived from the SAME `readingMs` the gate branched on — single-source, never a second clock read),
 * and, from the AUTHENTICATED snapshot, first pitch (`scheduledAtAtFire`), the observation window end
 * (`windowEnd`), and the detection instant (`detectedAt`). Both the operand object AND the outcome are
 * frozen HERE, before the value can reach the tick's shallow-frozen summary — the tick retains outcomes
 * BY REFERENCE and must never re-traverse them, so the record must arrive already immutable.
 */
function coverageMiss(
  reason: CoverageMissReason,
  readingMs: number,
  snapshot: PreparedFireSnapshot,
): Extract<LineOpenFireOutcome, { kind: 'CoverageMiss' }> {
  const operands: CoverageMissOperands = Object.freeze({
    preClaimReadingAt: new Date(readingMs).toISOString(),
    scheduledAtAtFire: snapshot.prepared.cutoffAt,
    windowEnd: snapshot.booted.manifest.windowEnd,
    detectedAt: snapshot.detectedAt,
  });
  return Object.freeze({ kind: 'CoverageMiss' as const, reason, operands });
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
  // (1-2) Capture top-level references and admission fields once. The adapter capability is
  //       brand-asserted FIRST — a raw map or structural lookalike fails here, before any
  //       other field is read — and both the adapter facades and the billing provenance are
  //       derived from that ONE minted value, never accepted as separate caller fields.
  const snapshot = input.snapshot;
  const capability = input.capability;
  assertCohortAdapterCapability(capability);
  const adapters = capability.adapters();
  const billingClass = capability.billingClass;
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
  const installSidecar = sink.installSpendEscalationSidecar.bind(sink);
  const capturedClaimPort: ClaimPort = { admit };
  const capturedInstaller: ArtifactInstaller = { install, installSpendEscalationSidecar: installSidecar };

  // (5) Authenticate the snapshot and derive the full-scope admission request.
  const request = buildFullScopeAdmitRequest(snapshot, {
    ownerId,
    expectedSchemaVersion,
  });

  // (5a) BILLABLE price-identity gate: a billable fire may only be judged under the price
  //      identity its AUTHENTICATED cohort precommitted to, so the booted manifest must pin
  //      the conservative guard table version + its recomputed digest. Checked pre-claim
  //      (zero spend, refuses loudly). Known-zero fires are exempt — their manifests may pin
  //      the historical replay table, and the guard never prices them.
  if (billingClass === 'billable') {
    const manifest = snapshot.booted.manifest;
    const guardDigest = modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION);
    if (
      manifest.modelPriceTableVersion !== SPEND_GUARD_PRICE_TABLE_VERSION ||
      manifest.modelPriceTableDigest !== guardDigest
    ) {
      throw new BillablePriceIdentityError(manifest.modelPriceTableVersion, manifest.modelPriceTableDigest);
    }
  }

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

  // (5c) The PRE-CLAIM canonical-window gate (B1; SPEC-line-open-evidence-model.md §3/§5). Read the ONE
  //      coherent tick clock (the SAME `now` that drives the send-time V-lag) EXACTLY ONCE, and — from
  //      the AUTHENTICATED snapshot only — compare it to the two canonical boundaries. If the reading is
  //      already at/after first pitch (`snapshot.prepared.cutoffAt`) OR at/after the observation window
  //      end (`snapshot.booted.manifest.windowEnd`), a timely INITIAL request is already impossible; per
  //      §3 the runner must then NOT claim or dispatch. So the gate runs AFTER (5) authenticated the
  //      snapshot and BEFORE (6) admission: on a miss it never calls `claimPort.admit`, never calls a
  //      provider or the sink, produces no artifact, and consumes no budget — it returns a `CoverageMiss`
  //      (the candidate becomes a §6 coverage miss only through a later independent finalizer, never
  //      here). This is DISTINCT from the send-time `cutoff_missed`: that classifies an already-CLAIMED
  //      arm whose boundary crossed AFTER admission (the unchanged `initialDispatchGate`, below). The one
  //      reading is the sole source of BOTH the comparison and the persisted `preClaimReadingAt` operand.
  //      A non-finite reading fails CLOSED (throws) rather than letting `NaN >= x` be false and admitting.
  const readingMs = now();
  if (!Number.isFinite(readingMs)) throw new PreClaimClockError();
  const firstPitchMs = Date.parse(snapshot.prepared.cutoffAt);
  const windowEndMs = Date.parse(snapshot.booted.manifest.windowEnd);
  // First-pitch precedence when BOTH boundaries have passed (§5 / D7): first pitch is checked first.
  if (readingMs >= firstPitchMs) return coverageMiss('first_pitch_before_claim', readingMs, snapshot);
  if (readingMs >= windowEndMs) return coverageMiss('window_end_before_claim', readingMs, snapshot);

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

  // The runtime spend guard's verdict is computed HERE — from the STILL-LIVE envelope, because the
  // installed artifact is redacted (no `usageRaw` survives into it) — and the escalation branch is
  // taken only AFTER the install below: a paid dispatch has already spent the money, so the artifact
  // is the evidence of what was spent and MUST persist before this run refuses to settle. Each arm's
  // guard identity comes from the authenticated envelope (the dispatched `ArmSpec`), never a free
  // caller tuple; the fire's ONE `billingClass` (captured above) covers every arm. The price version
  // is the code-owned CONSERVATIVE guard table, deliberately NOT the manifest's stamped
  // `modelPriceTableVersion` — a hard-stop must price at the conservative rates, and a stamped
  // manifest must not be able to weaken it — while the per-attempt cap IS the manifest's
  // authenticated reservation constant (boot re-verifies it equals the code-owned policy value).
  // `computeFireSpendGuard` never throws for a money ambiguity (a typed UNKNOWN from the arithmetic
  // folds to an `unknown` verdict inside it), so no spend question can escape around the install.
  const guardArms: GuardArmInput[] = envelope.results.map((r) => ({
    participantId: r.arm.participantId,
    billingClass,
    provider: r.arm.provider,
    requestedModelId: r.arm.requestedModelId,
    attempt: { requestAt: r.attempt.requestAt, usageRaw: r.attempt.usageRaw },
    repair: r.repair === null ? null : { requestAt: r.repair.requestAt, usageRaw: r.repair.usageRaw },
  }));
  const perAttemptReservationUsdMicros = snapshot.booted.manifest.constants.providerAttemptReservationUsdMicros;
  let verdict: FireSpendVerdict;
  try {
    verdict = computeFireSpendGuard({
      arms: guardArms,
      priceVersion: SPEND_GUARD_PRICE_TABLE_VERSION,
      perAttemptReservationUsdMicros,
    });
  } catch (guardFault) {
    // A NON-money fault escaped the guard (money ambiguity folds to `unknown` inside it) —
    // an internal bug, after a dispatch that may already have spent money. EVIDENCE FIRST:
    // durably install the artifact, then surface the fault loudly with the installed path
    // and the original cause. Never converted to a PASS, never masked as a money UNKNOWN,
    // never allowed to discard the paid attempt's canonical record.
    const installedOnFault = await installReconciledArtifact(artifact, permit, capturedInstaller);
    throw new SpendGuardInternalError(installedOnFault.path, guardFault);
  }

  const installed = await installReconciledArtifact(artifact, permit, capturedInstaller);
  // Only after the artifact is durably installed does this run settle the claim exactly once. A settle
  // refusal or throw NEVER discards the persisted artifact: it folds to a typed `unsettled` completion
  // for an activation consumer to escalate. A known refusal leaves the claim confirmed `pending`; a
  // failed/mismatched completion is UNCONFIRMED (the store may be `pending` or already `completed`), but
  // the artifact is preserved and the reservation is only ever conservatively held — never over-admitting
  // and never a blind re-settle. Install throwing/rejecting propagates BEFORE this line, so settlement
  // never runs for a fire whose evidence did not persist.
  if (verdict.kind === 'pass') {
    const completion = await settleCompletedFire(permit);
    return { kind: 'Installed', permit, artifact, install: installed, completion };
  }
  // BREACH or UNKNOWN: do NOT settle — the claim and its full reservation stay pending (retained),
  // which is the conservative direction; nothing is written to the store about the escalation.
  // The raw token buckets that produced this verdict exist ONLY in the still-live envelope (the
  // artifact is redacted), so the redacted token-only sidecar is built and durably installed HERE,
  // beside the artifact, before the outcome is returned — after process loss the durable pair can
  // explain and recompute the verdict that left this claim pending. The permit is deliberately NOT
  // returned (see the outcome doc): the escalated record carries evidence identity, not settlement
  // authority. The outcome is frozen because, like a `CoverageMiss`, it is an escalation RECORD
  // retained by reference downstream (`offenders` is already frozen by the guard).
  const reason =
    verdict.kind === 'breach' ? ('spend_attempt_over_reservation' as const) : ('spend_evidence_unknown' as const);
  const sidecarRecord: SpendEscalationSidecarV1 = buildSpendEscalationSidecar({
    artifact,
    results: envelope.results,
    billingClass,
    verdict,
    reason,
    priceVersion: SPEND_GUARD_PRICE_TABLE_VERSION,
    priceTableDigest: modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION),
    perAttemptReservationUsdMicros,
  });
  const sidecarInstalled = await capturedInstaller.installSpendEscalationSidecar(sidecarRecord);
  return Object.freeze({
    kind: 'InstalledEscalated' as const,
    artifact,
    install: installed,
    sidecar: Object.freeze({
      path: sidecarInstalled.path,
      created: sidecarInstalled.created,
      sha256: spendEscalationSidecarSha256(sidecarRecord),
    }),
    reason,
    offenders: verdict.offenders,
  });
}
