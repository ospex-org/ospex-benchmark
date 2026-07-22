import { canonicalize } from './canonical.js';
import { assertBootedCohort } from './cohortBoot.js';
import { buildGameBundle } from './bundle.js';
import { fetchCurrentOdds, fetchFullHistoryRows, fetchGamesForSport } from './fetchers.js';
import { deepFreeze } from './freeze.js';
import type { BootedCohort } from './cohortBoot.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { CurrentOddsRow, GamesEndpointRow, MarketKey } from './types.js';

/**
 * Line-open discovery + per-market opener-read seams (SPEC-line-open-evidence-model.md
 * §1–§3; SPEC-line-open-speculation-runner.md §3). Two read-only, non-activating
 * boundaries the per-market runner later composes:
 *
 *   1. `DiscoverFn` — enumerate the fire candidates for a booted cohort directly
 *      from the `current_odds` snapshot (never the `odds_history` tail), and seal an
 *      immutable, deep-frozen, runtime-DETACHED, brand-authenticated discovery
 *      snapshot carrying the canonical-deduplicated games, ONLY the buildable
 *      current-odds rows (each candidate one-to-one to its exact retained row), and
 *      the exact discovery `fetchCompletedAt`. It carries the source-owned inputs the
 *      prepared-fire boundary later consumes; it does NOT seal a `PreparedFireSnapshot`.
 *
 *   2. `ReadMarketEvidenceFn` — read the full two-sided `odds_history` for one
 *      `(gameId, market)` pair, returning the full validated rows, the scoring
 *      watermark (`null` in live mode), and the read's completion instant — the
 *      inputs the opener / as-of derivations later run over.
 *
 * Both seams AUTHENTICATE the `BootedCohort` (`assertBootedCohort`) before reading
 * any manifest field. This module holds no store, admission, permit, adapter,
 * runner loop, CLI, or watcher wiring; it discovers and reads, and nothing else.
 * Buildability is decided by the SAME owner the batch builder uses (`buildGameBundle`),
 * evaluated at the snapshot's `fetchCompletedAt`, so discovery and assembly can never
 * disagree on which `(gameId, market)` is buildable.
 */

/**
 * A source-integrity fault raised by the SEMANTIC checks in discovery / the opener read:
 * a duplicate row, a game/network/requested-pair identity-binding violation, or a dropped
 * (evidence-erasing) history row. It does NOT encompass the lower-level faults, which
 * propagate RAW from the fetcher layer: a malformed body (a `ZodError`), a non-increasing /
 * unsafe raw id or a blown aggregate read deadline, and a games echo / offset-ceiling
 * violation. Error TYPE is therefore not yet a load-bearing classification contract — a later
 * stage mapping faults to retry-vs-stop must not switch on `instanceof` alone. Distinct from a
 * benign empty read (which completes with no rows).
 */
export class LineOpenReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineOpenReadError';
  }
}

// ---------------------------------------------------------------------------
// Snapshot + read shapes
// ---------------------------------------------------------------------------

/** One discovered fire candidate: a buildable `(gameId, market)` key. Exactly one
 *  per retained buildable current-odds row. */
export interface DiscoveredCandidate {
  readonly gameId: string;
  readonly market: MarketKey;
}

/**
 * The sealed discovery snapshot: canonical-deduplicated games, ONLY the buildable
 * current-odds rows (each the exact retained row for its candidate; non-buildable
 * rows excluded), the candidate key set, and the exact discovery completion instant.
 * Deep-frozen, runtime-detached, and brand-authenticated (see `assertDiscoverySnapshot`).
 * NOT a `PreparedFireSnapshot` — it carries the source-owned inputs a later stage seals.
 */
export interface DiscoverySnapshot {
  readonly games: readonly GamesEndpointRow[];
  readonly oddsRows: readonly CurrentOddsRow[];
  readonly candidates: readonly DiscoveredCandidate[];
  readonly fetchCompletedAt: string;
}

/**
 * The result of reading one `(gameId, market)` pair's opener evidence: the FULL
 * validated two-sided history, the scoring watermark (`null` in live-runtime mode,
 * a nonnegative safe integer when frozen), and the instant the whole read completed.
 */
export interface MarketEvidenceRead {
  /** The requested game id — carried so an empty (`historyRows: []`) read is still
   *  self-describing about which pair it answered. */
  readonly gameId: string;
  /** The requested market — carried alongside `gameId` for the same reason. */
  readonly market: MarketKey;
  readonly historyRows: readonly TwoSidedHistoryRow[];
  readonly historyWatermark: number | null;
  readonly readCompletedAt: string;
}

// ---------------------------------------------------------------------------
// Seam types
// ---------------------------------------------------------------------------

export type DiscoverFn = (booted: BootedCohort) => Promise<DiscoverySnapshot>;

export type ReadMarketEvidenceFn = (
  booted: BootedCohort,
  gameId: string,
  market: MarketKey,
) => Promise<MarketEvidenceRead>;

/** The per-sport games read and the single current-odds read discovery composes. */
export type ReadGamesFn = (sport: string, windowHours: number) => Promise<GamesEndpointRow[]>;
export type ReadCurrentOddsFn = (network: string, gameIds: string[]) => Promise<CurrentOddsRow[]>;

export interface DiscoveryReads {
  readGames: ReadGamesFn;
  readCurrentOdds: ReadCurrentOddsFn;
  now: () => number;
}

/** The bounded full-history fetch the opener read composes: it owns the raw-id
 *  keyset walk, the aggregate deadline, and parse-after; it returns the parsed
 *  rows plus the count dropped by full validation. */
export type FetchHistoryFn = (
  gameId: string,
  market: MarketKey,
  deadlineMs: number,
  now: () => number,
) => Promise<{ rows: TwoSidedHistoryRow[]; dropped: number }>;

export interface HistoryReadDeps {
  fetchHistory: FetchHistoryFn;
  now: () => number;
}

// ---------------------------------------------------------------------------
// Runtime origin brand. A DiscoverySnapshot's TypeScript type is erased at
// runtime, so a direct caller could forge the shape (or cast a raw object) and
// hand an unauthenticated discovery result to a later stage. This module-private
// WeakSet is populated ONLY by `discover` below, so membership is unforgeable
// runtime PROOF that a value actually came through discovery.
// ---------------------------------------------------------------------------

const discoverySnapshots = new WeakSet<DiscoverySnapshot>();

// The producing cohort id of each snapshot `discover` seals. A brand proves a
// snapshot came through discovery, but NOT which cohort produced it; recording the
// cohort id here lets `assertDiscoverySnapshotFor` reject a genuine snapshot from a
// DIFFERENT cohort being paired with the wrong booted cohort at a later stage.
const discoverySnapshotCohort = new WeakMap<DiscoverySnapshot, string>();

/** Throw unless `snapshot` was produced by `discover`. A stage that trusts the
 *  discovery result calls this; a forged or structurally-copied value is rejected
 *  even though the TypeScript type would let one through. */
export function assertDiscoverySnapshot(snapshot: DiscoverySnapshot): void {
  if (!discoverySnapshots.has(snapshot)) {
    throw new LineOpenReadError(
      'discovery snapshot was not produced by discover (forged or substituted)',
    );
  }
}

/**
 * Throw unless `snapshot` was produced by `discover` FOR this exact booted cohort.
 * Brands prove origin, not cross-root coherence — a genuine snapshot and a genuine
 * cohort can still belong to different cohorts. This binds them: it authenticates
 * `booted` itself (so the exported helper has a closed direct-call domain), then
 * requires the snapshot to be a genuine discovery result whose producing cohort id
 * equals `booted.cohortId`. A consumer that composes discovery with a cohort's
 * manifest calls this to reject a crossed pairing.
 */
export function assertDiscoverySnapshotFor(snapshot: DiscoverySnapshot, booted: BootedCohort): void {
  assertBootedCohort(booted);
  assertDiscoverySnapshot(snapshot);
  if (discoverySnapshotCohort.get(snapshot) !== booted.cohortId) {
    throw new LineOpenReadError(
      'discovery snapshot was produced for a different cohort than the one supplied',
    );
  }
}

// ---------------------------------------------------------------------------
// Games collection: per-sport reads + identity binding + canonical dedup
// ---------------------------------------------------------------------------

/**
 * One read per allow-list member, keyed on the requested sport + window, merged
 * into the canonical game set: each game's `gameId` must equal its jsonodds external
 * id (or fault), an exact canonical repeat of a game row deduplicates, and a
 * CONFLICTING repeat (same `gameId`, different content) faults rather than
 * last-row-wins. Returned in stable `gameId` order.
 *
 * The offset-pagination boundary-skip is a documented accepted limitation: a game
 * that straddles a page boundary during a concurrent insert may be missed; the
 * `hasMore` walk (in the games fetcher) bounds it, and duplicates are handled here.
 */
export async function collectGames(
  sportAllowList: readonly string[],
  windowHours: number,
  readGames: ReadGamesFn,
): Promise<GamesEndpointRow[]> {
  const byId = new Map<string, GamesEndpointRow>();
  for (const sport of sportAllowList) {
    const games = await readGames(sport, windowHours);
    for (const game of games) {
      if (game.gameId !== game.externalIds.jsonodds) {
        throw new LineOpenReadError(
          `game ${game.gameId} gameId does not equal externalIds.jsonodds ${game.externalIds.jsonodds}`,
        );
      }
      const existing = byId.get(game.gameId);
      if (existing === undefined) {
        byId.set(game.gameId, game);
      } else if (canonicalize(existing) !== canonicalize(game)) {
        throw new LineOpenReadError(`conflicting duplicate games row for game ${game.gameId}`);
      }
      // else: an exact canonical repeat — deduplicate silently.
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0,
  );
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover the fire candidates for a booted cohort and seal the discovery snapshot.
 * Authenticates the cohort first, reads games per sport, reads the current-odds
 * snapshot exactly ONCE for the discovered game set, binds + deduplicates BEFORE
 * filtering, then keeps only the `(gameId, market)` rows a singleton build accepts
 * at the discovery completion instant.
 */
export async function discover(
  booted: BootedCohort,
  deps: DiscoveryReads,
): Promise<DiscoverySnapshot> {
  // Authenticate BEFORE reading any manifest field (sportAllowList / network).
  assertBootedCohort(booted);
  const { sportAllowList, network } = booted.manifest;
  const windowHours = booted.manifest.constants.gameDiscoveryWindowHours;

  // (1) Per-sport games reads → identity binding + canonical dedup.
  const games = await collectGames(sportAllowList, windowHours, deps.readGames);
  const gameIds = games.map((g) => g.gameId);
  const gameIdSet = new Set(gameIds);

  // (2) The current-odds snapshot, read ONCE for the discovered game set. The exact
  //     retained rows cross the boundary; discovery never re-reads current_odds.
  const oddsRows = gameIds.length === 0 ? [] : await deps.readCurrentOdds(network, gameIds);

  // (3) Source binding — BEFORE the buildability filter, so a malformed duplicate
  //     cannot be hidden by filtering one copy out: every row on the cohort network
  //     and for a discovered game.
  for (const row of oddsRows) {
    if (row.network !== network) {
      throw new LineOpenReadError(
        `current_odds row for ${row.jsonodds_id} carries network ${row.network}, expected ${network}`,
      );
    }
    if (!gameIdSet.has(row.jsonodds_id)) {
      throw new LineOpenReadError(
        `current_odds row for ${row.jsonodds_id} is not one of the discovered games`,
      );
    }
  }

  // (4) Duplicate `(gameId, market)` detection — fail closed, never last-row-wins.
  const seenMarketKeys = new Set<string>();
  for (const row of oddsRows) {
    const key = `${row.jsonodds_id} ${row.market}`;
    if (seenMarketKeys.has(key)) {
      throw new LineOpenReadError(
        `duplicate current_odds row for (${row.jsonodds_id}, ${row.market})`,
      );
    }
    seenMarketKeys.add(key);
  }

  // (5) Buildability filter via the SAME owner the batch builder uses, evaluated at
  //     the discovery completion instant: a retained `(gameId, market)` is a candidate
  //     iff a singleton build with its exact game row + exact odds row + exact market
  //     + exact `fetchCompletedAt` succeeds.
  const fetchCompletedAt = new Date(deps.now()).toISOString();
  const assembledAtMs = Date.parse(fetchCompletedAt);
  const gamesById = new Map(games.map((g) => [g.gameId, g]));
  const buildableOdds: CurrentOddsRow[] = [];
  const candidates: DiscoveredCandidate[] = [];
  for (const row of oddsRows) {
    const game = gamesById.get(row.jsonodds_id);
    if (game === undefined) continue; // bound above; defensive
    const result = buildGameBundle(
      game,
      new Map<string, CurrentOddsRow>([[row.market, row]]),
      assembledAtMs,
      [row.market],
    );
    if ('bundle' in result) {
      buildableOdds.push(row);
      candidates.push({ gameId: row.jsonodds_id, market: row.market });
    }
  }

  // (6) The detached, deep-frozen, brand-authenticated snapshot. `structuredClone`
  //     detaches from the caller/network objects; `deepFreeze` locks the graph.
  const snapshot: DiscoverySnapshot = deepFreeze({
    games: structuredClone(games),
    oddsRows: structuredClone(buildableOdds),
    candidates: structuredClone(candidates),
    fetchCompletedAt,
  });
  discoverySnapshots.add(snapshot);
  discoverySnapshotCohort.set(snapshot, booted.cohortId);
  return snapshot;
}

// ---------------------------------------------------------------------------
// Per-market opener read
// ---------------------------------------------------------------------------

/**
 * Read one `(gameId, market)` pair's opener evidence. Authenticates the cohort,
 * runs the bounded full-history fetch, then FAULTS on any dropped (malformed) row
 * or any row that does not bind to the requested pair — an empty `200 []` is a
 * COMPLETED read with no rows, never a fault and never a fabricated opener. The
 * scoring watermark is `null` in this live-runtime read; completion is stamped only
 * after the whole read finished.
 */
export async function readMarketEvidence(
  booted: BootedCohort,
  gameId: string,
  market: MarketKey,
  deps: HistoryReadDeps,
): Promise<MarketEvidenceRead> {
  // Authenticate BEFORE reading any manifest field (historyReadTimeoutMs).
  assertBootedCohort(booted);
  const deadlineMs = booted.manifest.constants.historyReadTimeoutMs;

  const { rows, dropped } = await deps.fetchHistory(gameId, market, deadlineMs, deps.now);

  // A dropped row is evidence erasure — fault rather than complete a truncated read.
  if (dropped > 0) {
    throw new LineOpenReadError(
      `odds_history read for (${gameId}, ${market}) dropped ${dropped} malformed row(s)`,
    );
  }
  // Defensive requested-pair binding: the query filters by pair, but a VALID row for
  // the wrong pair would pass full validation, so bind every row or fault.
  for (const row of rows) {
    if (row.jsonodds_id !== gameId || row.market !== market) {
      throw new LineOpenReadError(
        `odds_history row (${row.jsonodds_id}, ${row.market}) does not bind to requested (${gameId}, ${market})`,
      );
    }
  }

  const readCompletedAt = new Date(deps.now()).toISOString();
  return { gameId, market, historyRows: rows, historyWatermark: null, readCompletedAt };
}

// ---------------------------------------------------------------------------
// Real network seam factories
// ---------------------------------------------------------------------------

export interface LineOpenReadConfig {
  /** Core API base URL (the public `/v1/games` slate listing). */
  apiUrl: string;
  /** PostgREST base URL (the `current_odds` / `odds_history` read path). */
  supabaseUrl: string;
  /** Public read-only anon key. */
  anonKey: string;
  /** Injectable clock; wall clock by default. */
  now?: () => number;
}

/** The real discovery seam: per-sport `/v1/games` reads + the single `current_odds`
 *  read, wired to `discover`. */
export function createDiscoverFn(config: LineOpenReadConfig): DiscoverFn {
  const now = config.now ?? ((): number => Date.now());
  return (booted) =>
    discover(booted, {
      readGames: (sport, windowHours) => fetchGamesForSport(config.apiUrl, sport, windowHours),
      readCurrentOdds: (network, gameIds) =>
        fetchCurrentOdds(config.supabaseUrl, config.anonKey, network, gameIds),
      now,
    });
}

/** The real per-market opener read seam, wired to `readMarketEvidence` over the
 *  bounded full-history fetch. */
export function createReadMarketEvidenceFn(config: LineOpenReadConfig): ReadMarketEvidenceFn {
  const now = config.now ?? ((): number => Date.now());
  return (booted, gameId, market) =>
    readMarketEvidence(booted, gameId, market, {
      fetchHistory: (gid, mkt, deadlineMs, clock) =>
        fetchFullHistoryRows({
          supabaseUrl: config.supabaseUrl,
          anonKey: config.anonKey,
          gameId: gid,
          market: mkt,
          deadlineMs,
          now: clock,
        }),
      now,
    });
}
