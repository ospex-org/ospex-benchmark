import { z } from 'zod';
import type {
  ClosingLineRow,
  ClosingLineRowWithId,
  CurrentOddsRow,
  GamesEndpointRow,
  GamesTableRow,
} from './types.js';

/**
 * Zod validation of the two upstream wire shapes at the decode boundary.
 * Unknown extra fields are tolerated (passthrough) — the harness must not
 * break when the upstream adds columns.
 */

const teamSchema = z
  .object({
    name: z.string().min(1),
    abbreviation: z.string().min(1),
  })
  .passthrough();

export const gamesEndpointRowSchema = z
  .object({
    gameId: z.string().min(1),
    slug: z.string().min(1),
    sport: z.string().min(1),
    matchTime: z.string().min(1),
    status: z.string().min(1),
    homeTeam: teamSchema,
    awayTeam: teamSchema,
    hasOdds: z.boolean(),
    contestCreated: z.boolean(),
    contestId: z.string().nullable(),
    canCreateContest: z.boolean(),
    externalIds: z
      .object({
        jsonodds: z.string().min(1),
        sportspage: z.string().nullable(),
        rundown: z.string().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

export const gamesEndpointBodySchema = z
  .object({
    games: z.array(gamesEndpointRowSchema),
    pagination: z
      .object({
        limit: z.number(),
        offset: z.number(),
        total: z.number(),
        hasMore: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

export const currentOddsRowSchema = z
  .object({
    network: z.string().min(1),
    jsonodds_id: z.string().min(1),
    market: z.enum(['moneyline', 'spread', 'total']),
    line: z.number().nullable(),
    away_odds_american: z.number().nullable(),
    home_odds_american: z.number().nullable(),
    upstream_last_updated: z.string().min(1),
    poll_captured_at: z.string().min(1),
    changed_at: z.string().min(1),
  })
  .passthrough();

export function parseGamesBody(body: unknown): {
  games: GamesEndpointRow[];
  hasMore: boolean;
} {
  const parsed = gamesEndpointBodySchema.parse(body);
  return { games: parsed.games as GamesEndpointRow[], hasMore: parsed.pagination.hasMore };
}

/**
 * The `/v1/games` body WITH its query echo. The endpoint reflects the requested
 * `sport` (lowercased, or `null` when omitted), `windowHours`, and `availableOnly`
 * back at the top level, plus the pagination `limit`/`offset`, so a caller can
 * assert the server answered the query it actually asked — a returned page that
 * quietly widened the window or dropped the sport filter is caught rather than
 * trusted. Extra fields are tolerated (passthrough).
 */
export const gamesEndpointEchoBodySchema = z
  .object({
    sport: z.string().nullable(),
    windowHours: z.number(),
    availableOnly: z.boolean(),
    games: z.array(gamesEndpointRowSchema),
    pagination: z
      .object({
        limit: z.number(),
        offset: z.number(),
        total: z.number(),
        hasMore: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

export interface GamesEndpointEchoBody {
  sport: string | null;
  windowHours: number;
  availableOnly: boolean;
  games: GamesEndpointRow[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function parseGamesEndpointEchoBody(body: unknown): GamesEndpointEchoBody {
  const parsed = gamesEndpointEchoBodySchema.parse(body);
  return {
    sport: parsed.sport,
    windowHours: parsed.windowHours,
    availableOnly: parsed.availableOnly,
    games: parsed.games as GamesEndpointRow[],
    limit: parsed.pagination.limit,
    offset: parsed.pagination.offset,
    hasMore: parsed.pagination.hasMore,
  };
}

export function parseCurrentOddsRows(body: unknown): CurrentOddsRow[] {
  return z.array(currentOddsRowSchema).parse(body) as CurrentOddsRow[];
}

export const closingLineRowSchema = z
  .object({
    network: z.string().min(1),
    jsonodds_id: z.string().min(1),
    market: z.enum(['moneyline', 'spread', 'total']),
    line: z.number().nullable(),
    away_odds_decimal: z.number().nullable(),
    home_odds_decimal: z.number().nullable(),
    away_p_novig: z.number().nullable(),
    home_p_novig: z.number().nullable(),
    value_captured_at: z.string().nullable(),
    last_polled_at: z.string().nullable(),
    lock_time: z.string().min(1),
    poll_gap_seconds: z.number().nullable(),
    confidence: z.enum(['fresh', 'stale', 'missing']),
    source: z.string().min(1),
  })
  .passthrough();

export function parseClosingLineRows(body: unknown): ClosingLineRow[] {
  return z.array(closingLineRowSchema).parse(body) as ClosingLineRow[];
}

/** A closing-line row carrying its identity PK — the keyset-pagination key. */
export const closingLineRowWithIdSchema = closingLineRowSchema.extend({
  id: z.number().int().positive(),
});

export function parseClosingLineRowsWithId(body: unknown): ClosingLineRowWithId[] {
  return z.array(closingLineRowWithIdSchema).parse(body) as ClosingLineRowWithId[];
}

export const gamesTableRowSchema = z
  .object({
    network: z.string().min(1),
    jsonodds_id: z.string().min(1),
    sport: z.string().min(1),
    match_time: z.string().min(1),
    status: z.string().min(1),
    home_score: z.number().int().nullable(),
    away_score: z.number().int().nullable(),
    final_type: z.string().nullable(),
    score_captured: z.boolean(),
  })
  .passthrough();

export function parseGamesTableRows(body: unknown): GamesTableRow[] {
  return z.array(gamesTableRowSchema).parse(body) as GamesTableRow[];
}

export const historyFirstRowSchema = z
  .object({
    captured_at: z.string().min(1),
  })
  .passthrough();

/**
 * First price-history row for one (game, market) — the moment the market
 * first appeared on the board. Used by watch mode's late-detection gate;
 * an empty array means the history row has not landed yet (transient).
 */
export function parseHistoryFirstRow(body: unknown): string | null {
  const rows = z.array(historyFirstRowSchema).max(1).parse(body);
  return rows.length === 1 && rows[0] !== undefined ? rows[0].captured_at : null;
}
