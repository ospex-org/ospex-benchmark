import { canonicalize, sha256Hex } from './canonical.js';
import { MARKET_ORDINAL } from './fireArtifact.js';
import { buildFireArtifact } from './fireArtifactProducer.js';
import { assertDispatchPermit } from './lineOpenClaim.js';
import { runSlate } from './runner.js';
import type { BootedCohort } from './cohortBoot.js';
import type { GameRequest } from './bundle.js';
import type { CandidateInput, CandidateVerdict } from './detection.js';
import type { FireArtifactV1, FireContext } from './fireArtifactProducer.js';
import type { ArtifactSink } from './lineOpenArtifactSink.js';
import type { ClaimOutcome, ClaimPort, DispatchPermit } from './lineOpenClaim.js';
import type { PublicationVerified } from './manifestPublication.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { RunEnvelope, SlateRunOptions } from './runner.js';
import type { AdmitDispatchRequest, ScopeKey, ScopeReservation } from './store/contract.js';
import type { ArmSpec, CurrentOddsRow, GamesEndpointRow, MarketKey, ProviderAdapter } from './types.js';

/**
 * The canonical line-open runner (SPEC-line-open-evidence-model.md §3/§4/§5) — the
 * discovery → detect → claim → fire → produce → persist loop that fires per (gameId,
 * market) off each market's own opener, replacing the retired game-level watcher.
 *
 * This slice defines the full dependency-injection seam set up front and proves the
 * claim → fire → produce → persist SPINE end-to-end for ONE prepared, already-eligible
 * fire, so later slices only FILL a seam without reshaping the core: discovery + the
 * per-market evidence read, per-market detection + deterministic ordering + co-arrival
 * grouping, the store-backed claim + the exhaustive reaction matrix + the per-arm lease
 * lifecycle, the pre-admit/HTTP dispatch gates, the manifest-file boot + real publication
 * resolver, and rehearsal + observability. `--live` is hard-disabled throughout; the only
 * mode that reaches this canonical path is a permit-bearing admission (see `lineOpenClaim`).
 */

// ---------------------------------------------------------------------------
// Seams (filled by later slices)
// ---------------------------------------------------------------------------

/** Epoch-ms clock. The dry runner injects a real wall clock; tests inject a fixture. */
export interface Clock {
  now(): number;
}

/**
 * An immutable discovery snapshot: the in-window games + the EXACT `current_odds` rows a
 * tick reads, with identity/duplicate checks already applied (filled by the discovery
 * slice). Candidate (game, market) pairs are enumerated from THIS snapshot — never an
 * `odds_history` tail — so "detected and claimed ⇒ bundle-buildable" holds by construction.
 */
export interface PreparedDiscoverySnapshot {
  readonly games: readonly GamesEndpointRow[];
  readonly currentOdds: readonly CurrentOddsRow[];
  readonly fetchCompletedAt: string;
}

/** Discover the cohort's in-window games + current-odds snapshot, per sport-allow-list
 *  (filled by the discovery slice). */
export type DiscoverFn = () => Promise<PreparedDiscoverySnapshot>;

/**
 * One scoped market's fully-validated history evidence (filled by the evidence-read slice):
 * the complete `source=jsonodds` rows plus the read mode, from which `firstTwoSided` (the
 * opener) and `asOfQuote` are derived in pure code — NOT merely an opener.
 */
export interface MarketEvidence {
  readonly historyRows: readonly TwoSidedHistoryRow[];
  readonly historyWatermark: number | null;
  readonly readCompletedAt: string;
}

/** Read one `(gameId, market)`'s full history evidence (filled by the evidence-read slice). */
export type ReadMarketEvidenceFn = (gameId: string, market: MarketKey) => Promise<MarketEvidence>;

/** A per-tick status/observability sink (filled by the observability slice): state
 *  transitions, per-speculation dispositions, and read-path canaries. */
export interface StatusSink {
  transition(line: string): void;
}

/**
 * One roster arm's per-attempt lease lifecycle (SPEC §4). The real store-backed
 * implementation releases each arm's initial slot the moment its HTTP attempt settles or
 * is skipped, and acquires/releases one fresh repair lease around a repair request; it is
 * wired INTO the dispatch loop by the store-choreographer/loop slices. Designed here so
 * the canonical `FireFn` requires a permit-bearing lifecycle from the start.
 */
export interface AttemptLifecyclePort {
  releaseInitial(armIndex: number): Promise<void>;
  acquireRepair(armIndex: number, repairOrdinal: number): Promise<{ authorized: boolean }>;
  releaseRepair(armIndex: number, repairOrdinal: number): Promise<void>;
}

/** A no-I/O lifecycle for the skeleton + pure tests; replaced by the store-backed one. */
export class NoopAttemptLifecycle implements AttemptLifecyclePort {
  releaseInitial(): Promise<void> {
    return Promise.resolve();
  }
  acquireRepair(): Promise<{ authorized: boolean }> {
    return Promise.resolve({ authorized: false });
  }
  releaseRepair(): Promise<void> {
    return Promise.resolve();
  }
}

/** One scoped market's prepared detection + history context (from detect/read seams). */
export interface PreparedScopedMarket {
  candidateInput: CandidateInput;
  verdict: CandidateVerdict;
  historyRows: readonly TwoSidedHistoryRow[];
  historyWatermark: number | null;
}

/**
 * One eligible fire, prepared upstream (discover → read → detect → order → group): a
 * single game's scoped markets sharing one `detectedAt` and one immutable prepared
 * snapshot, ready to claim. The discovery/detection seams produce this; this slice
 * consumes it.
 */
export interface PreparedFire {
  booted: BootedCohort;
  publication: PublicationVerified;
  gameId: string;
  /** Proposed markets in upstream vocabulary, canonical order (moneyline, spread, total). */
  proposedMarkets: readonly MarketKey[];
  detectedAt: string;
  /** The digest of the immutable prepared discovery snapshot (a discovery-slice concern). */
  preparedSnapshotDigest: string;
  bundleBuiltAt: string;
  /** The scoped dispatch request (`buildGameRequest` over the scoped `GameBundle`). */
  request: GameRequest;
  perMarket: readonly PreparedScopedMarket[];
  /** The dispatched roster + adapters + run options (mock adapters in dry-run). */
  arms: ArmSpec[];
  adapters: Map<string, ProviderAdapter>;
  runOptions: SlateRunOptions;
}

/** The fire seam: launch the roster under a permit and produce the fire artifact. */
export interface FireFn {
  fire(
    permit: DispatchPermit,
    fire: PreparedFire,
    ids: { fireId: string; runId: string },
  ): Promise<{ env: RunEnvelope; artifact: FireArtifactV1 }>;
}

/** The runner's injected dependencies. */
export interface FireDeps {
  claimPort: ClaimPort;
  fireFn: FireFn;
  artifactSink: ArtifactSink;
  lifecycle: AttemptLifecyclePort;
  /** Owner identity for at-most-once claiming + lease-release scoping. */
  ownerId: string;
  storeSchemaVersion: number;
  /** Conservative per-attempt spend reservation (the pricing slice replaces the value). */
  spendReservationUsdMicros: number;
}

// ---------------------------------------------------------------------------
// Fire identity
// ---------------------------------------------------------------------------

const FIRE_ID_DOMAIN = 'line-open-fire-id-v1';
const RUN_ID_DOMAIN = 'line-open-run-id-v1';

/** Canonical-order proposed markets (moneyline, spread, total). */
function canonicalMarkets(markets: readonly MarketKey[]): MarketKey[] {
  return [...markets].sort((a, b) => MARKET_ORDINAL[a] - MARKET_ORDINAL[b]);
}

/**
 * The idempotency anchor for one dispatch ATTEMPT — derived from inputs known BEFORE the
 * store reveals the retained scope (`proposedMarkets`, not `claimedKeys`), so the caller
 * can supply it to `admitDispatch`. Same-process retry of a lost response re-mints the
 * identical id; a cross-process restart cannot recover the original `detectedAt`/snapshot,
 * so it mints a new id whose claim keys already exist → `all_claimed` → no re-fire (safe).
 */
export function deriveFireId(input: {
  cohortId: string;
  gameId: string;
  proposedMarkets: readonly MarketKey[];
  detectedAt: string;
  preparedSnapshotDigest: string;
}): string {
  return sha256Hex(
    canonicalize({
      domain: FIRE_ID_DOMAIN,
      cohortId: input.cohortId,
      gameId: input.gameId,
      proposedMarkets: canonicalMarkets(input.proposedMarkets),
      detectedAt: input.detectedAt,
      preparedSnapshotDigest: input.preparedSnapshotDigest,
    }),
  );
}

/** The one-game run id: a domain-separated digest of the fire id (never ad-hoc random). */
export function deriveRunId(fireId: string): string {
  return sha256Hex(canonicalize({ domain: RUN_ID_DOMAIN, fireId }));
}

// ---------------------------------------------------------------------------
// The canonical fire executor
// ---------------------------------------------------------------------------

/**
 * The canonical fire: requires a `DispatchPermit`, launches the scoped roster through the
 * shared `runSlate`, assembles the `FireContext` (binding each scoped market's claim to
 * this fire), and produces the branded `FireArtifactV1`. For this slice the retained scope
 * equals the proposed scope (full claim); the partial-claim projection from
 * `permit.claimedKeys` is a store-choreographer concern.
 */
export class LineOpenFireFn implements FireFn {
  async fire(
    permit: DispatchPermit,
    fire: PreparedFire,
    ids: { fireId: string; runId: string },
  ): Promise<{ env: RunEnvelope; artifact: FireArtifactV1 }> {
    assertDispatchPermit(permit);
    const env = await runSlate(fire.arms, fire.adapters, [fire.request], fire.runOptions);
    const ctx: FireContext = {
      booted: fire.booted,
      fireId: ids.fireId,
      runId: ids.runId,
      publication: fire.publication,
      bundleBuiltAt: fire.bundleBuiltAt,
      perMarket: fire.perMarket.map((m) => ({
        candidateInput: m.candidateInput,
        verdict: m.verdict,
        historyRows: m.historyRows,
        historyWatermark: m.historyWatermark,
        claim: { cohortId: permit.cohortId, fireId: ids.fireId, gameId: fire.gameId, market: m.candidateInput.market },
      })),
    };
    const artifact = buildFireArtifact(env, ctx);
    return { env, artifact };
  }
}

// ---------------------------------------------------------------------------
// The single-fire orchestrator
// ---------------------------------------------------------------------------

export interface FireResult {
  fired: boolean;
  outcome: ClaimOutcome;
  path?: string;
  artifact?: FireArtifactV1;
}

/**
 * Drive one prepared, already-eligible fire through the spine: derive the fire/run ids,
 * claim the dispatch (only an `Authorized` outcome carries a `DispatchPermit`), fire the
 * roster under that permit, release each arm's initial lease as the fire settles, and
 * install the produced artifact through the permit-gated sink. A non-`Authorized` claim
 * outcome fires nothing and writes no artifact.
 */
export async function runOneFire(fire: PreparedFire, deps: FireDeps): Promise<FireResult> {
  const cohortId = fire.booted.cohortId;
  const markets = canonicalMarkets(fire.proposedMarkets);
  const fireId = deriveFireId({
    cohortId,
    gameId: fire.gameId,
    proposedMarkets: markets,
    detectedAt: fire.detectedAt,
    preparedSnapshotDigest: fire.preparedSnapshotDigest,
  });
  const runId = deriveRunId(fireId);

  const scopeKey = markets.join('+') as ScopeKey;
  const reservation: ScopeReservation = {
    spendReservationUsdMicros: deps.spendReservationUsdMicros,
    preparedBytesDigest: fire.request.requestSha256,
  };
  const req: AdmitDispatchRequest = {
    cohortId,
    fireId,
    ownerId: deps.ownerId,
    expectedSchemaVersion: deps.storeSchemaVersion,
    gameId: fire.gameId,
    proposedMarkets: markets,
    scopeReservations: { [scopeKey]: reservation } as Readonly<Partial<Record<ScopeKey, ScopeReservation>>>,
  };

  const outcome = await deps.claimPort.admit(req);
  if (outcome.kind !== 'Authorized') return { fired: false, outcome };

  const { permit } = outcome;
  const { artifact } = await deps.fireFn.fire(permit, fire, { fireId, runId });
  // Release each arm's initial lease as the fire settles. The real store-backed lifecycle
  // releases per-arm inside dispatch; here the seam is threaded end-to-end.
  for (const lease of permit.initialLeases) await deps.lifecycle.releaseInitial(lease.armIndex);
  const { path } = deps.artifactSink.write(permit, artifact);
  return { fired: true, outcome, path, artifact };
}
