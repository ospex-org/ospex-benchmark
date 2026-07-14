import { redactAndTruncate } from './config.js';
import {
  parseClosingLineRows,
  parseCurrentOddsRows,
  parseGamesBody,
  parseGamesTableRows,
  parseHistoryFirstRow,
} from './wire.js';
import type {
  ClosingLineRow,
  CurrentOddsRow,
  GamesEndpointRow,
  GamesTableRow,
  SlateInputs,
} from './types.js';

/**
 * Live read path. Two existing public surfaces, nothing new:
 *
 * 1. The core API's games endpoint (`GET /v1/games`) — the canonical public
 *    slate listing. Its `gameId` is the upstream odds-feed event ID, the same
 *    identifier the reference-odds snapshot and the closing-line capture key
 *    on, which is what makes every pick joinable to its close later.
 * 2. The `current_odds` snapshot table over PostgREST with the public
 *    read-only anon key — the pre-contest reference-odds read path.
 */

const FETCH_TIMEOUT_MS = 30_000;

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `GET ${url} failed with HTTP ${response.status}: ${redactAndTruncate(body, 500)}`,
      );
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGamesForWindow(
  apiUrl: string,
  windowHours: number,
): Promise<GamesEndpointRow[]> {
  const rows: GamesEndpointRow[] = [];
  const limit = 200;
  let offset = 0;
  for (;;) {
    const url =
      `${apiUrl}/v1/games?sport=mlb&windowHours=${windowHours}` +
      `&availableOnly=false&limit=${limit}&offset=${offset}`;
    const { games, hasMore } = parseGamesBody(await getJson(url, {}));
    rows.push(...games);
    if (!hasMore) break;
    offset += limit;
    if (offset > 5_000) {
      throw new Error('games pagination did not terminate — aborting rather than looping');
    }
  }
  return rows;
}

export async function fetchCurrentOdds(
  supabaseUrl: string,
  anonKey: string,
  network: string,
  gameIds: string[],
): Promise<CurrentOddsRow[]> {
  const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const rows: CurrentOddsRow[] = [];
  const batchSize = 40;
  for (let i = 0; i < gameIds.length; i += batchSize) {
    const batch = gameIds.slice(i, i + batchSize);
    const select =
      'network,jsonodds_id,market,line,away_odds_american,home_odds_american,' +
      'upstream_last_updated,poll_captured_at,changed_at';
    const url =
      `${supabaseUrl}/rest/v1/current_odds?select=${select}` +
      `&network=eq.${network}&jsonodds_id=in.(${batch.join(',')})`;
    rows.push(...parseCurrentOddsRows(await getJson(url, headers)));
  }
  return rows;
}

/**
 * Captured reference closes for a set of games — the read side of the
 * scoring join. Same public anon read path as the reference-odds snapshot.
 */
export async function fetchClosingLines(
  supabaseUrl: string,
  anonKey: string,
  network: string,
  gameIds: string[],
): Promise<ClosingLineRow[]> {
  const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const rows: ClosingLineRow[] = [];
  const batchSize = 40;
  for (let i = 0; i < gameIds.length; i += batchSize) {
    const batch = gameIds.slice(i, i + batchSize);
    const select =
      'network,jsonodds_id,market,line,away_odds_decimal,home_odds_decimal,' +
      'away_p_novig,home_p_novig,value_captured_at,last_polled_at,lock_time,' +
      'poll_gap_seconds,confidence,source';
    const url =
      `${supabaseUrl}/rest/v1/closing_lines?select=${select}` +
      `&network=eq.${network}&jsonodds_id=in.(${batch.join(',')})`;
    rows.push(...parseClosingLineRows(await getJson(url, headers)));
  }
  return rows;
}

/**
 * Every `games` TABLE row for one (network, sport) over the same public
 * anon read path — the completion/score side of the totals-pair extraction.
 * Paginated, ordered by the stable key, with a runaway guard.
 */
export async function fetchGamesTableRows(
  supabaseUrl: string,
  anonKey: string,
  network: string,
  sport: string,
): Promise<GamesTableRow[]> {
  const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const rows: GamesTableRow[] = [];
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const select =
      'network,jsonodds_id,sport,match_time,status,home_score,away_score,final_type,score_captured';
    const url =
      `${supabaseUrl}/rest/v1/games?select=${select}` +
      `&network=eq.${network}&sport=eq.${sport}` +
      `&order=jsonodds_id.asc&limit=${limit}&offset=${offset}`;
    const batch = parseGamesTableRows(await getJson(url, headers));
    rows.push(...batch);
    if (batch.length < limit) break;
    if (offset > 100_000) {
      throw new Error('games table pagination did not terminate — aborting rather than looping');
    }
  }
  return rows;
}

/**
 * First board appearance of one (game, market): the earliest price-history
 * row from the board feed. Immutable once it exists — callers should cache.
 * Returns the captured_at instant, or null when the history row has not
 * landed yet (the ingest writes history before the snapshot, so null is
 * transient and the caller should simply retry next cycle).
 */
export async function fetchFirstBoardAppearance(
  supabaseUrl: string,
  anonKey: string,
  gameId: string,
  market: 'moneyline' | 'spread' | 'total',
): Promise<string | null> {
  const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const url =
    `${supabaseUrl}/rest/v1/odds_history?select=captured_at` +
    `&jsonodds_id=eq.${gameId}&market=eq.${market}&source=eq.jsonodds` +
    `&order=captured_at.asc&limit=1`;
  return parseHistoryFirstRow(await getJson(url, headers));
}

export async function fetchLiveInputs(options: {
  apiUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  windowHours: number;
}): Promise<SlateInputs> {
  const fetchStartedAt = new Date().toISOString();
  const gamesRows = await fetchGamesForWindow(options.apiUrl, options.windowHours);
  const oddsRows =
    gamesRows.length === 0
      ? []
      : await fetchCurrentOdds(
          options.supabaseUrl,
          options.supabaseAnonKey,
          'polygon',
          gamesRows.map((g) => g.gameId),
        );
  // Completion time is the bundle assembly time: every observation in the
  // inputs happened at or before this instant, never after it.
  const fetchCompletedAt = new Date().toISOString();
  return { gamesRows, oddsRows, fetchStartedAt, fetchCompletedAt };
}
