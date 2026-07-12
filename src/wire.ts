import { z } from 'zod';
import type { CurrentOddsRow, GamesEndpointRow } from './types.js';

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

export function parseCurrentOddsRows(body: unknown): CurrentOddsRow[] {
  return z.array(currentOddsRowSchema).parse(body) as CurrentOddsRow[];
}
