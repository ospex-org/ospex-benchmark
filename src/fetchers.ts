import { redactSecrets } from './config.js';
import { parseCurrentOddsRows, parseGamesBody } from './wire.js';
import type { CurrentOddsRow, GamesEndpointRow, SlateInputs } from './types.js';

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
        `GET ${url} failed with HTTP ${response.status}: ${redactSecrets(body.slice(0, 500))}`,
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
