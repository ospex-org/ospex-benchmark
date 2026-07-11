import { canonicalize, sha256Hex } from './canonical.js';
import { easternCalendarDay } from './dates.js';
import { americanToDecimal } from './odds.js';
import { SMOKE_LABEL } from './types.js';
import type {
  CurrentOddsRow,
  ExcludedGame,
  GameBundle,
  GamesEndpointRow,
  SlateBundle,
  SlateInputs,
} from './types.js';

export interface BuildResult {
  bundle: SlateBundle;
  bundleSha256: string;
  /** Per-game content hashes, keyed by gameId. */
  gameHashes: Record<string, string>;
  excluded: ExcludedGame[];
  /** Non-bundle provenance retained for the run record, keyed by gameId. */
  provenance: Record<string, { slug: string; oddsRows: CurrentOddsRow[] }>;
}

function evidenceRef(gameId: string, field: string): string {
  return `ev:${gameId}:${field}`;
}

function buildGameBundle(
  game: GamesEndpointRow,
  odds: Map<string, CurrentOddsRow>,
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

  const gameId = game.gameId;
  const spreadLine = spread.line;
  const totalLine = total.line;
  try {
    return {
      bundle: {
        gameId,
        league: 'mlb',
        scheduledStartUtc: game.matchTime,
        awayTeam: game.awayTeam.name,
        homeTeam: game.homeTeam.name,
        probableStartingPitchers: null,
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
        evidenceRefs: [
          evidenceRef(gameId, 'identity'),
          evidenceRef(gameId, 'schedule'),
          evidenceRef(gameId, 'moneyline'),
          evidenceRef(gameId, 'runline'),
          evidenceRef(gameId, 'total'),
        ],
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

  const slateRows = inputs.gamesRows
    .filter((g) => easternCalendarDay(g.matchTime) === slateDate)
    .sort((a, b) => (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0));

  for (const game of slateRows) {
    if (game.status !== 'upcoming') {
      excluded.push({ gameId: game.gameId, slug: game.slug, reason: `status:${game.status}` });
      continue;
    }
    if (options.requireFuture && Date.parse(game.matchTime) <= Date.parse(inputs.fetchedAt)) {
      excluded.push({ gameId: game.gameId, slug: game.slug, reason: 'already_started' });
      continue;
    }
    if (!game.hasOdds) {
      excluded.push({ gameId: game.gameId, slug: game.slug, reason: 'has_odds_false' });
      continue;
    }
    const result = buildGameBundle(game, oddsByGame.get(game.gameId) ?? new Map());
    if ('reason' in result) {
      excluded.push({ gameId: game.gameId, slug: game.slug, reason: result.reason });
      continue;
    }
    eligible.push(result.bundle);
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

  const cutoffAt = eligible
    .map((g) => g.scheduledStartUtc)
    .reduce((min, t) => (Date.parse(t) < Date.parse(min) ? t : min));

  const bundle: SlateBundle = {
    schemaVersion: 1,
    label: SMOKE_LABEL,
    league: 'mlb',
    slateDate,
    bundleTimestamp: inputs.fetchedAt,
    cutoffAt,
    games: eligible,
  };

  return {
    bundle,
    bundleSha256: sha256Hex(canonicalize(bundle)),
    gameHashes,
    excluded,
    provenance,
  };
}
