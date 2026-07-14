import { redactAndTruncate } from './config.js';
import {
  parseClosingLineRows,
  parseClosingLineRowsWithId,
  parseCurrentOddsRows,
  parseGamesBody,
  parseGamesTableRows,
  parseHistoryFirstRow,
} from './wire.js';
import type {
  ClosingLineRow,
  ClosingLineRowWithId,
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
 * Keyset pagination over a monotone-identity key: each page asks for rows
 * with id strictly greater than the last id seen, so — unlike offset
 * pagination — a concurrent insert can never shift page boundaries and
 * duplicate one row while dropping another. The identity walk asserts
 * strictly increasing ids across the whole result (uniqueness + order), and
 * refuses anything else. Correctness assumes the key is append-only
 * monotone (a GENERATED IDENTITY column), which closing_lines.id is.
 *
 * Termination is an EMPTY page only. A short page must not be trusted as
 * end-of-data: a server-side row cap below the requested limit would make
 * every page "short" and silently truncate the walk — the walker
 * deliberately does not know or assume any page size. Every appended page
 * passes the maxRows bound before the walk can return, so no result ever
 * exceeds it. Termination is guaranteed: each page must strictly advance
 * the id cursor (else the non-increasing refusal fires), and unbounded
 * growth hits maxRows.
 */
export async function keysetWalk<T>(options: {
  fetchPage: (afterId: number) => Promise<T[]>;
  idOf: (row: T) => number;
  maxRows?: number;
}): Promise<T[]> {
  const { fetchPage, idOf } = options;
  const maxRows = options.maxRows ?? 1_000_000;
  const rows: T[] = [];
  let afterId = 0;
  for (;;) {
    const page = await fetchPage(afterId);
    if (page.length === 0) return rows;
    let previous = afterId;
    for (const row of page) {
      const id = idOf(row);
      if (!Number.isSafeInteger(id) || id <= previous) {
        throw new Error(
          `keyset pagination returned a non-increasing id (${id} after ${previous}) — ` +
            'refusing an inconsistent snapshot',
        );
      }
      previous = id;
      rows.push(row);
    }
    if (rows.length > maxRows) {
      throw new Error(
        `keyset pagination exceeded ${maxRows} rows — refusing an unbounded walk`,
      );
    }
    afterId = previous;
  }
}

/**
 * EVERY totals closing line on a network, enumerated directly from the
 * source table the snapshot claims to cover (not via a pre-enumerated game
 * list, which would silently hide closes whose games row is missing or
 * unexpected). Keyset-paginated on the identity PK.
 */
export async function fetchTotalsClosingLines(
  supabaseUrl: string,
  anonKey: string,
  network: string,
): Promise<ClosingLineRowWithId[]> {
  const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const select =
    'id,network,jsonodds_id,market,line,away_odds_decimal,home_odds_decimal,' +
    'away_p_novig,home_p_novig,value_captured_at,last_polled_at,lock_time,' +
    'poll_gap_seconds,confidence,source';
  // The requested page size is a hint to the server, not a contract the
  // walker relies on — termination is the empty final page.
  const pageSize = 1000;
  return keysetWalk({
    fetchPage: async (afterId) => {
      const url =
        `${supabaseUrl}/rest/v1/closing_lines?select=${select}` +
        `&network=eq.${network}&market=eq.total&id=gt.${afterId}` +
        `&order=id.asc&limit=${pageSize}`;
      return parseClosingLineRowsWithId(await getJson(url, headers));
    },
    idOf: (row) => row.id,
  });
}

/**
 * `games` TABLE rows for a pinned set of game ids — batched `in.()` lookups
 * keyed by identity, so there is no pagination and nothing for a concurrent
 * write to shift. Duplicate rows for one key are refused.
 */
export async function fetchGamesRowsByIds(
  supabaseUrl: string,
  anonKey: string,
  network: string,
  gameIds: string[],
): Promise<GamesTableRow[]> {
  const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const select =
    'network,jsonodds_id,sport,match_time,status,home_score,away_score,final_type,score_captured';
  const rows: GamesTableRow[] = [];
  const batchSize = 40;
  for (let i = 0; i < gameIds.length; i += batchSize) {
    const batch = gameIds.slice(i, i + batchSize);
    const url =
      `${supabaseUrl}/rest/v1/games?select=${select}` +
      `&network=eq.${network}&jsonodds_id=in.(${batch.join(',')})`;
    rows.push(...parseGamesTableRows(await getJson(url, headers)));
  }
  if (new Set(rows.map((row) => row.jsonodds_id)).size !== rows.length) {
    throw new Error('games lookup returned duplicate rows for one game id — refusing');
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
