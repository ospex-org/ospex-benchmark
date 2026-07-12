import { canonicalize, sha256Hex } from './canonical.js';
import { americanToDecimal } from './odds.js';
import { easternCalendarDay } from './slateDate.js';
import { SMOKE_LABEL } from './types.js';
import type {
  CurrentOddsRow,
  ExcludedGame,
  GameBundle,
  GamesEndpointRow,
  ProbablePitchers,
  SlateBundle,
  SlateInputs,
} from './types.js';

export interface GameRequest {
  gameId: string;
  /** Display-only; mutable upstream, never a key. */
  slug: string;
  game: GameBundle;
  /**
   * The frozen single-game bundle an arm receives: same shape as the slate
   * bundle with exactly one game, cutoffAt = this game's first pitch.
   */
  requestBundle: SlateBundle;
  /** SHA-256 of the canonical request bundle — the hash the model echoes. */
  requestSha256: string;
}

export interface BuildResult {
  /** The whole slate in one frozen record, for audit and grouping. */
  slateBundle: SlateBundle;
  slateSha256: string;
  /** One frozen request per eligible game — the unit of dispatch. */
  requests: GameRequest[];
  /** Per-game content hashes (the GameBundle alone), keyed by gameId. */
  gameHashes: Record<string, string>;
  excluded: ExcludedGame[];
  /** Non-bundle provenance retained for the run record, keyed by gameId. */
  provenance: Record<string, { slug: string; oddsRows: CurrentOddsRow[] }>;
}

function evidenceRef(gameId: string, field: string): string {
  return `ev:${gameId}:${field}`;
}

/**
 * Preregistered reference-quote freshness policy. A market row is usable only
 * if its feed-side observation timestamp parses, is not in the future beyond
 * a small clock-skew allowance, and is no older than the maximum quote age at
 * bundle assembly time. Violations exclude the game with a stable reason code.
 */
export const MAX_QUOTE_AGE_MS = 30 * 60 * 1000;
export const FUTURE_QUOTE_SKEW_MS = 2 * 60 * 1000;

function quoteTimestampProblem(
  row: CurrentOddsRow,
  market: string,
  assembledAtMs: number,
): string | null {
  const observedMs = Date.parse(row.upstream_last_updated);
  if (Number.isNaN(observedMs)) return `invalid_quote_timestamp:${market}`;
  if (observedMs > assembledAtMs + FUTURE_QUOTE_SKEW_MS) return `future_quote:${market}`;
  if (assembledAtMs - observedMs > MAX_QUOTE_AGE_MS) return `stale_quote:${market}`;
  return null;
}

function pitcherName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Forward-compatible probable-pitcher read: the upstream ingest does not
 * store pitchers today, so this returns null — but if the games read path
 * gains the fields (object or flat, camel or snake), they populate
 * automatically. This repo never sources pitchers from anywhere else.
 */
export function extractProbablePitchers(row: GamesEndpointRow): ProbablePitchers | null {
  const raw = row as unknown as Record<string, unknown>;
  const nested = raw['probablePitchers'];
  if (typeof nested === 'object' && nested !== null) {
    const obj = nested as Record<string, unknown>;
    const away = pitcherName(obj['away']);
    const home = pitcherName(obj['home']);
    if (away !== null || home !== null) return { away, home };
  }
  const away = pitcherName(raw['awayPitcher']) ?? pitcherName(raw['away_pitcher']);
  const home = pitcherName(raw['homePitcher']) ?? pitcherName(raw['home_pitcher']);
  if (away !== null || home !== null) return { away, home };
  return null;
}

function buildGameBundle(
  game: GamesEndpointRow,
  odds: Map<string, CurrentOddsRow>,
  assembledAtMs: number,
): { bundle: GameBundle } | { reason: string } {
  const moneyline = odds.get('moneyline');
  const spread = odds.get('spread');
  const total = odds.get('total');
  if (!moneyline && !spread && !total) return { reason: 'no_odds_rows' };
  if (!moneyline) return { reason: 'missing_market:moneyline' };
  if (!spread) return { reason: 'missing_market:spread' };
  if (!total) return { reason: 'missing_market:total' };
  if (moneyline.away_odds_american === null || moneyline.home_odds_american === null) {
    return { reason: 'one_sided_price:moneyline' };
  }
  if (spread.away_odds_american === null || spread.home_odds_american === null) {
    return { reason: 'one_sided_price:spread' };
  }
  if (spread.line === null) return { reason: 'missing_line:spread' };
  if (total.away_odds_american === null || total.home_odds_american === null) {
    return { reason: 'one_sided_price:total' };
  }
  if (total.line === null) return { reason: 'missing_line:total' };
  for (const [market, row] of [
    ['moneyline', moneyline],
    ['spread', spread],
    ['total', total],
  ] as const) {
    const problem = quoteTimestampProblem(row, market, assembledAtMs);
    if (problem !== null) return { reason: problem };
  }

  const gameId = game.gameId;
  const spreadLine = spread.line;
  const totalLine = total.line;
  const pitchers = extractProbablePitchers(game);
  const evidenceRefs = [
    evidenceRef(gameId, 'identity'),
    evidenceRef(gameId, 'schedule'),
    ...(pitchers !== null ? [evidenceRef(gameId, 'pitchers')] : []),
    evidenceRef(gameId, 'moneyline'),
    evidenceRef(gameId, 'runline'),
    evidenceRef(gameId, 'total'),
  ];
  try {
    return {
      bundle: {
        gameId,
        league: 'mlb',
        scheduledStartUtc: game.matchTime,
        awayTeam: game.awayTeam.name,
        homeTeam: game.homeTeam.name,
        probableStartingPitchers: pitchers,
        markets: {
          moneyline: {
            awayDecimal: americanToDecimal(moneyline.away_odds_american),
            homeDecimal: americanToDecimal(moneyline.home_odds_american),
            observedAt: moneyline.upstream_last_updated,
            evidenceRef: evidenceRef(gameId, 'moneyline'),
          },
          runLine: {
            line: spreadLine,
            awayHandicap: -spreadLine,
            homeHandicap: spreadLine,
            awayDecimal: americanToDecimal(spread.away_odds_american),
            homeDecimal: americanToDecimal(spread.home_odds_american),
            observedAt: spread.upstream_last_updated,
            evidenceRef: evidenceRef(gameId, 'runline'),
          },
          total: {
            line: totalLine,
            // Upstream storage convention: away column = Over, home column = Under.
            overDecimal: americanToDecimal(total.away_odds_american),
            underDecimal: americanToDecimal(total.home_odds_american),
            observedAt: total.upstream_last_updated,
            evidenceRef: evidenceRef(gameId, 'total'),
          },
        },
        evidenceRefs,
      },
    };
  } catch (error) {
    // A corrupt upstream price (non-integer, |value| < 100) excludes this one
    // game rather than aborting the whole slate.
    return {
      reason: `invalid_price (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

export function buildBundle(
  inputs: SlateInputs,
  slateDate: string,
  options: { requireFuture: boolean },
): BuildResult {
  const oddsByGame = new Map<string, Map<string, CurrentOddsRow>>();
  for (const row of inputs.oddsRows) {
    const forGame = oddsByGame.get(row.jsonodds_id) ?? new Map<string, CurrentOddsRow>();
    forGame.set(row.market, row);
    oddsByGame.set(row.jsonodds_id, forGame);
  }

  const eligible: GameBundle[] = [];
  const excluded: ExcludedGame[] = [];
  const gameHashes: Record<string, string> = {};
  const provenance: BuildResult['provenance'] = {};
  const slugs = new Map<string, string>();
  const assembledAtMs = Date.parse(inputs.fetchCompletedAt);
  if (Number.isNaN(assembledAtMs)) {
    throw new Error(`unparseable fetchCompletedAt: ${inputs.fetchCompletedAt}`);
  }

  const slateRows = inputs.gamesRows
    .filter((g) => easternCalendarDay(g.matchTime) === slateDate)
    .sort((a, b) => (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0));

  for (const game of slateRows) {
    if (game.status !== 'upcoming') {
      excluded.push({ gameId: game.gameId, slug: game.slug, reason: `status:${game.status}` });
      continue;
    }
    if (options.requireFuture && Date.parse(game.matchTime) <= assembledAtMs) {
      excluded.push({ gameId: game.gameId, slug: game.slug, reason: 'already_started' });
      continue;
    }
    if (!game.hasOdds) {
      excluded.push({ gameId: game.gameId, slug: game.slug, reason: 'has_odds_false' });
      continue;
    }
    const result = buildGameBundle(game, oddsByGame.get(game.gameId) ?? new Map(), assembledAtMs);
    if ('reason' in result) {
      excluded.push({ gameId: game.gameId, slug: game.slug, reason: result.reason });
      continue;
    }
    eligible.push(result.bundle);
    slugs.set(game.gameId, game.slug);
    gameHashes[game.gameId] = sha256Hex(canonicalize(result.bundle));
    provenance[game.gameId] = {
      slug: game.slug,
      oddsRows: ['moneyline', 'spread', 'total']
        .map((m) => oddsByGame.get(game.gameId)?.get(m))
        .filter((r): r is CurrentOddsRow => r !== undefined),
    };
  }

  if (eligible.length === 0) {
    throw new Error(
      `no eligible games for slate ${slateDate} ` +
        `(${slateRows.length} candidate rows, ${excluded.length} excluded)`,
    );
  }

  const slateCutoff = eligible
    .map((g) => g.scheduledStartUtc)
    .reduce((min, t) => (Date.parse(t) < Date.parse(min) ? t : min));

  const slateBundle: SlateBundle = {
    schemaVersion: 1,
    label: SMOKE_LABEL,
    league: 'mlb',
    slateDate,
    bundleTimestamp: inputs.fetchCompletedAt,
    cutoffAt: slateCutoff,
    games: eligible,
  };

  // The unit of dispatch: one frozen single-game bundle per eligible game,
  // each with its own cutoff (that game's first pitch). A slate cannot be
  // batched when each game's decision deadline is independent.
  //
  // Canonical hash ordering (slateBundle.games, by gameId) is deliberately
  // separate from dispatch ordering: requests are sorted by cutoff so the
  // earliest-starting game is always dispatched first, with the stable
  // game-ID tie-breaker. Game IDs are opaque UUIDs and carry no time order.
  const requests: GameRequest[] = eligible
    .map((game) => {
      const requestBundle: SlateBundle = {
        schemaVersion: 1,
        label: SMOKE_LABEL,
        league: 'mlb',
        slateDate,
        bundleTimestamp: inputs.fetchCompletedAt,
        cutoffAt: game.scheduledStartUtc,
        games: [game],
      };
      return {
        gameId: game.gameId,
        slug: slugs.get(game.gameId) ?? game.gameId,
        game,
        requestBundle,
        requestSha256: sha256Hex(canonicalize(requestBundle)),
      };
    })
    .sort((a, b) => {
      const timeDiff =
        Date.parse(a.game.scheduledStartUtc) - Date.parse(b.game.scheduledStartUtc);
      if (timeDiff !== 0) return timeDiff;
      return a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0;
    });

  return {
    slateBundle,
    slateSha256: sha256Hex(canonicalize(slateBundle)),
    requests,
    gameHashes,
    excluded,
    provenance,
  };
}
