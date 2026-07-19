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
import type { AttemptLifecyclePort, RunEnvelope, SlateRunOptions } from './runner.js';
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
 * The per-arm attempt-lease lifecycle now lives with the dispatch executor that drives it at
 * the HTTP boundaries (`runner.ts`); it is re-exported here so the runner's seam set stays
 * discoverable in one place. The canonical `FireFn` threads it into `runSlate`, which
 * releases each initial lease as its arm settles and sends a repair only under a
 * freshly-acquired lease.
 */
export type { AttemptLifecyclePort } from './runner.js';
export { NoopAttemptLifecycle } from './runner.js';

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

/**
 * The fire seam: launch the roster under a permit and produce the fire artifact. The permit
 * IS the authority — the fire id, run id (a domain-separated digest of it), and every
 * authorizing dimension are taken from / bound to the permit, never a separately-passed id,
 * so a fire artifact can never describe a fire the durable admission did not authorize. The
 * lifecycle is threaded into the dispatch executor so leases are released / acquired at the
 * actual HTTP boundaries.
 */
export interface FireFn {
  fire(
    permit: DispatchPermit,
    fire: PreparedFire,
    lifecycle: AttemptLifecyclePort,
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
 * `permit.claimedKeys` is a later durable-store-integration concern.
 */
export class LineOpenFireFn implements FireFn {
  async fire(
    permit: DispatchPermit,
    fire: PreparedFire,
    lifecycle: AttemptLifecyclePort,
  ): Promise<{ env: RunEnvelope; artifact: FireArtifactV1 }> {
    // PRE-DISPATCH AUTHORITY: authenticate the permit and bind EVERY authorizing dimension to
    // the exact snapshot about to be fired, BEFORE any model adapter is touched. No call is
    // made unless the permit authorizes this exact cohort, game, scope, request bytes, and a
    // full-roster unique-live initial-lease bijection.
    assertDispatchPermit(permit);
    bindPermitToFire(permit, fire);
    const fireId = permit.fireId; // the permit is the authority; there is no separate fire id
    const runId = deriveRunId(fireId);
    const dispatchOptions: SlateRunOptions = { ...fire.runOptions, lifecycle };
    const env = await runSlate(fire.arms, fire.adapters, [fire.request], dispatchOptions);
    const ctx: FireContext = {
      booted: fire.booted,
      fireId,
      runId,
      publication: fire.publication,
      bundleBuiltAt: fire.bundleBuiltAt,
      perMarket: fire.perMarket.map((m) => ({
        candidateInput: m.candidateInput,
        verdict: m.verdict,
        historyRows: m.historyRows,
        historyWatermark: m.historyWatermark,
        claim: { cohortId: permit.cohortId, fireId, gameId: fire.gameId, market: m.candidateInput.market },
      })),
    };
    const artifact = buildFireArtifact(env, ctx);
    return { env, artifact };
  }
}

/** The scoped markets present on the request bundle's one game, canonical order (bundle
 *  `runLine` is the `spread` MarketKey). */
function presentRequestMarkets(fire: PreparedFire): MarketKey[] {
  const m = fire.request.game.markets;
  const scope: MarketKey[] = [];
  if (m.moneyline != null) scope.push('moneyline');
  if (m.runLine != null) scope.push('spread');
  if (m.total != null) scope.push('total');
  return scope.sort((a, b) => MARKET_ORDINAL[a] - MARKET_ORDINAL[b]);
}

function sameMarkets(a: readonly MarketKey[], b: readonly MarketKey[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

/** Every authorizing dimension must agree with the exact snapshot to be dispatched, and the
 *  initial leases must be a unique live bijection over the roster arm indexes — else no call
 *  is made. This slice fires a FULL claim: a partial/mismatched claimed scope is refused
 *  here (a retained-subset projection is a later slice). */
function bindPermitToFire(permit: DispatchPermit, fire: PreparedFire): void {
  if (permit.cohortId !== fire.booted.cohortId) {
    throw new Error('dispatch permit does not authorize this cohort');
  }
  if (permit.gameId !== fire.gameId || fire.request.game.gameId !== fire.gameId) {
    throw new Error('dispatch permit does not authorize this game');
  }
  const claimed = [...permit.claimedKeys.map((k) => k.market)].sort((x, y) => MARKET_ORDINAL[x] - MARKET_ORDINAL[y]);
  const present = presentRequestMarkets(fire);
  const proposed = canonicalMarkets(fire.proposedMarkets);
  if (!sameMarkets(claimed, present) || !sameMarkets(claimed, proposed)) {
    throw new Error('dispatch permit claimed scope does not equal the dispatched request scope');
  }
  // Recompute the digest of the EXACT bundle to dispatch — never the stored, possibly-stale
  // requestSha256 field — and require it equals what the permit authorized. A request mutated
  // during the awaited admission no longer matches, so no adapter is called.
  const dispatchedDigest = sha256Hex(canonicalize(fire.request.requestBundle));
  if (dispatchedDigest !== permit.preparedBytesDigest) {
    throw new Error('the request to dispatch does not match the digest the permit authorized');
  }
  const rosterSize = fire.arms.length;
  if (permit.initialLeases.length !== rosterSize) {
    throw new Error(`dispatch permit must carry one initial lease per roster arm (${rosterSize}), got ${permit.initialLeases.length}`);
  }
  const seen = new Set<number>();
  for (const lease of permit.initialLeases) {
    if (lease.state !== 'live') throw new Error(`initial lease for arm ${lease.armIndex} is not live`);
    if (!Number.isInteger(lease.armIndex) || lease.armIndex < 0 || lease.armIndex >= rosterSize) {
      throw new Error(`initial lease arm index ${lease.armIndex} is outside [0, ${rosterSize})`);
    }
    if (seen.has(lease.armIndex)) throw new Error(`duplicate initial lease for arm index ${lease.armIndex}`);
    seen.add(lease.armIndex);
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
  // Bind the fire-id's detectedAt operand to the evidence the artifact certifies: every
  // scoped market shares the one prepared-group detection instant (buildFireArtifact
  // requires the candidate detectedAts equal EACH OTHER, but not this fire-level one), so
  // the fire id can never hash an instant that contradicts the certified detectedAt.
  for (const m of fire.perMarket) {
    if (m.candidateInput.detectedAt !== fire.detectedAt) {
      throw new Error(
        `prepared fire detectedAt (${fire.detectedAt}) does not equal candidate detectedAt for ${m.candidateInput.market} (${m.candidateInput.detectedAt})`,
      );
    }
  }
  // CAPTURE the authorized digest from the exact request bundle BEFORE the store await (never
  // the stored, possibly-stale requestSha256 field): this is the byte-authority the durable
  // admission pins. The fire executor RE-COMPUTES it at dispatch and refuses if it no longer
  // matches, so a request mutated during the awaited admission fires nothing.
  const authorizedDigest = sha256Hex(canonicalize(fire.request.requestBundle));
  const fireId = deriveFireId({
    cohortId,
    gameId: fire.gameId,
    proposedMarkets: markets,
    detectedAt: fire.detectedAt,
    preparedSnapshotDigest: fire.preparedSnapshotDigest,
  });

  const scopeKey = markets.join('+') as ScopeKey;
  const reservation: ScopeReservation = {
    spendReservationUsdMicros: deps.spendReservationUsdMicros,
    preparedBytesDigest: authorizedDigest,
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
  // The durable admission must have authorized exactly the fire we requested; a permit for a
  // different fire id never dispatches.
  if (permit.fireId !== fireId) {
    return { fired: false, outcome: { kind: 'Fault', reason: 'admission returned a permit for a different fire id' } };
  }
  // The fire executor binds every authorizing dimension (incl. the request digest) before any
  // model call, and threads the lifecycle into dispatch, which releases each arm's initial
  // lease at the HTTP boundary (no post-roster release loop).
  const { artifact } = await deps.fireFn.fire(permit, fire, deps.lifecycle);
  const { path } = deps.artifactSink.write(permit, artifact);
  return { fired: true, outcome, path, artifact };
}
