import { discover } from './lineOpenRead.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';
import type { DiscoverFn, ReadMarketEvidenceFn } from './lineOpenRead.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { CurrentOddsRow, GamesEndpointRow, MarketKey } from './types.js';

/**
 * The deterministic "see it fire" demo fixture — a NON-ACTIVATING, network-free synthetic
 * candidate that is aligned to admit a real fire against the wall clock.
 *
 * This is a PRODUCTION module (no test imports): it manufactures one now-relative synthetic
 * MLB moneyline candidate whose opener, current-odds snapshot, and first pitch are all
 * positioned so the real projector's detection-time gates (detection-in-window, opener-in-
 * window, clean-entry age, no clock skew, as-of/current reconcile) AND the dispatch-time gates
 * (V-lag on the initial request, windowEnd, first-pitch cutoff) all pass against a fresh wall
 * clock. It is the opt-in `--fixture` seam the store-backed demo uses because REAL MLB
 * discovery at line-open is always stale-rejected (the whole point of the runner: it refuses
 * stale openers).
 *
 * It reuses the REAL discovery seam (`discover`) over injected in-memory reads and the REAL
 * per-market opener-read shape, so the candidate flows through the exact production projector
 * and composition spine — nothing about detection/projection/dispatch is stubbed. Only the two
 * source READS (games/current-odds and odds_history) are the synthetic fixture; the claim
 * port, adapters, and sink the caller supplies decide whether a fire actually admits, dispatches,
 * and installs.
 *
 * Timing model (anchored at `anchorMs`, epoch ms):
 *   - `discover`'s `fetchCompletedAt` clock is pinned to `anchorMs`;
 *   - the caller's tick `now` (the projector's detection instant) runs on the wall clock, a few
 *     ms after `anchorMs`, so the freshness delta (`detectedAt − fetchCompletedAt`) is tiny;
 *   - the opener was captured ~10s before the anchor (within the clean-entry window, before
 *     detection, no skew), the current-odds quote ~5s before (fresh), and first pitch 3h out.
 * Build the fixture at `anchorMs = Date.now()` immediately before running the tick with the
 * wall clock, and every gate is satisfied.
 */

/** A small per-attempt provider timeout so the always-timing-out mock arm settles in ~1s rather
 *  than the ~5-minute production default — pinned only into this demo's generated manifest. */
export const DEMO_PROVIDER_CALL_TIMEOUT_MS = 1_000;

/** The synthetic game's stable, obviously-reserved id (mirrors the dry-run fixture's 0000… ids).
 *  Its `externalIds.jsonodds` equals it, as the discovery identity binding requires. */
export const DEMO_GAME_ID = '00000000-0000-4000-8000-000000000f1e';

const SECOND_MS = 1_000;
const HOUR_MS = 3_600_000;

/** The V1 moneyline quote shared by the opener history row and the current-odds row, so the
 *  as-of/current reconcile matches exactly. */
const AWAY_AMERICAN = -120;
const HOME_AMERICAN = 110;

export interface DemoRows {
  readonly game: GamesEndpointRow;
  readonly odds: CurrentOddsRow;
  /** The per-`${gameId}::${market}` opener history rows the evidence read returns. */
  readonly historyByPair: ReadonlyMap<string, readonly TwoSidedHistoryRow[]>;
}

/** Build the synthetic games/current-odds/odds-history rows anchored at `anchorMs`. */
export function buildDemoRows(anchorMs: number): DemoRows {
  const matchTime = new Date(anchorMs + 3 * HOUR_MS).toISOString(); // first pitch 3h out
  const quoteObservedAt = new Date(anchorMs - 5 * SECOND_MS).toISOString(); // fresh reference quote
  const openerMs = anchorMs - 10 * SECOND_MS; // opener within the clean-entry window, before detection
  const openerCapturedAt = new Date(openerMs).toISOString();

  const game: GamesEndpointRow = {
    gameId: DEMO_GAME_ID,
    slug: 'demo-mlb-line-open-fire',
    sport: 'mlb',
    matchTime,
    status: 'upcoming',
    homeTeam: { name: 'Demo Home Nine', abbreviation: 'DMH' },
    awayTeam: { name: 'Demo Away Nine', abbreviation: 'DMA' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: true,
    externalIds: { jsonodds: DEMO_GAME_ID, sportspage: null, rundown: null },
  };

  const odds: CurrentOddsRow = {
    network: 'polygon',
    jsonodds_id: DEMO_GAME_ID,
    market: 'moneyline',
    line: null,
    away_odds_american: AWAY_AMERICAN,
    home_odds_american: HOME_AMERICAN,
    upstream_last_updated: quoteObservedAt,
    poll_captured_at: quoteObservedAt,
    changed_at: quoteObservedAt,
  };

  const opener: TwoSidedHistoryRow = {
    id: 1,
    jsonodds_id: DEMO_GAME_ID,
    market: 'moneyline',
    source: 'jsonodds',
    line: null,
    away_odds_american: AWAY_AMERICAN,
    away_odds_decimal: 1.833333,
    home_odds_american: HOME_AMERICAN,
    home_odds_decimal: 2.1,
    captured_at: openerCapturedAt,
    captured_at_ms: openerMs, // must equal instantMs(captured_at); ISO round-trips ms exactly
  };

  const historyByPair = new Map<string, readonly TwoSidedHistoryRow[]>([
    [`${DEMO_GAME_ID}::moneyline`, [opener]],
  ]);

  return { game, odds, historyByPair };
}

export interface DemoFixture {
  /** The RAW canonical manifest bytes — fed (fatal-decoded) to `cohortBoot` and (as bytes) to
   *  publication verification, exactly like the rehearsal path. */
  readonly manifestBytes: Uint8Array;
  /** The real discovery seam over the synthetic in-memory reads (`fetchCompletedAt = anchorMs`). */
  readonly discover: DiscoverFn;
  /** The real per-market opener read over the synthetic history rows. */
  readonly readMarketEvidence: ReadMarketEvidenceFn;
}

/**
 * Assemble the whole demo fixture anchored at `anchorMs`: a code-consistent manifest (with a
 * small provider timeout), the real discovery seam over the synthetic games/current-odds reads,
 * and the real per-market opener read over the synthetic history. The manifest window is
 * now-relative (`windowStart = anchorMs − 168h`, `windowEnd = anchorMs + 6h`), so the anchor's
 * detection instant and the opener both fall inside it.
 */
export function buildDemoFixture(anchorMs: number): DemoFixture {
  const { bytes } = buildRehearsalManifest(anchorMs, {
    providerCallTimeoutMs: DEMO_PROVIDER_CALL_TIMEOUT_MS,
  });
  const rows = buildDemoRows(anchorMs);
  const discoverNow = (): number => anchorMs;

  const discoverFn: DiscoverFn = (booted) =>
    discover(booted, {
      readGames: async (sport) => (sport === rows.game.sport ? [rows.game] : []),
      readCurrentOdds: async () => [rows.odds],
      now: discoverNow,
    });

  const readMarketEvidenceFn: ReadMarketEvidenceFn = async (
    _booted,
    gameId: string,
    market: MarketKey,
  ) => ({
    gameId,
    market,
    historyRows: rows.historyByPair.get(`${gameId}::${market}`) ?? [],
    historyWatermark: null,
    readCompletedAt: new Date(anchorMs).toISOString(),
  });

  return {
    manifestBytes: new TextEncoder().encode(bytes),
    discover: discoverFn,
    readMarketEvidence: readMarketEvidenceFn,
  };
}
