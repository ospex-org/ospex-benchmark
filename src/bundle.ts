import { canonicalize, sha256Hex } from './canonical.js';
import { deepFreeze } from './freeze.js';
import { americanToDecimal } from './odds.js';
import { buildGameRequest } from './scopedRequest.js';
import { easternCalendarDay } from './slateDate.js';
import { SMOKE_LABEL } from './types.js';
import type {
  CurrentOddsRow,
  ExcludedGame,
  GameBundle,
  GamesEndpointRow,
  MarketKey,
  ProbablePitchers,
  SlateBundle,
  SlateInputs,
} from './types.js';

/**
 * The full board: all three known markets in upstream vocabulary. The batch
 * slate builder (`buildBundle`) always requests this board, so its per-game
 * output stays byte-identical to the pre-scoped builder; the per-market runtime
 * requests a SUBSET (the ready markets for one dispatch) instead.
 *
 * A `deepFreeze`d `readonly MarketKey[]` — NOT a shared `Set` — because this is a
 * load-bearing shared constant and TypeScript `readonly` alone is not a runtime
 * lock (see `freeze.ts`); a `Set`'s `add`/`delete` mutate internal slots that
 * `Object.freeze`/`deepFreeze` cannot reach, so a frozen array is the only shape
 * that can't be corrupted process-wide. `buildGameBundle` copies its request into
 * a fresh `Set`, so the board this constant names can never be mutated.
 */
export const FULL_BOARD_MARKETS: readonly MarketKey[] = deepFreeze<MarketKey[]>([
  'moneyline',
  'spread',
  'total',
]);

/** A single game's bundle, or a stable exclusion reason code. */
export type GameBundleResult = { bundle: GameBundle } | { reason: string };

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
 * Probable-pitcher read from the games read path, tolerant of shape (object
 * or flat, camel or snake). The games endpoint serves the nested
 * `probablePitchers: { home, away }` form (advisory MLB starters as last
 * reported by the upstream odds feed; both sides null until announced), so
 * bundles populate whenever starters are known. This repo never sources
 * pitchers from anywhere else.
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

/**
 * Build ONE game's frozen bundle for a caller-supplied set of ready markets, or
 * return a stable exclusion reason.
 *
 * `requestedMarkets` names the markets to include in UPSTREAM vocabulary
 * (`moneyline` | `spread` | `total`, matching `current_odds` and the market
 * policy); it is any `Iterable` (a `Set` or an array — e.g. a ready-set from
 * `effectiveEnabled`), copied into a fresh `Set` here so the caller's collection
 * is never aliased or mutated. The emitted bundle uses BUNDLE vocabulary, so the
 * `spread` row becomes `markets.runLine`. Only the requested markets are read,
 * validated, and emitted:
 *   - an absent NON-requested market never rejects the game (it is simply not in
 *     this dispatch);
 *   - an absent REQUESTED market rejects with `missing_market:<market>`;
 *   - an absent market is an OMITTED key on `markets`, never an `undefined`-valued
 *     one (the prepared-request boundary rejects an explicit-`undefined` market).
 *
 * Requesting the full board (`FULL_BOARD_MARKETS`) yields output byte-identical to
 * the pre-scoped builder: the reason precedence and the `evidenceRefs`/`markets`
 * ordering below are preserved for that case. `requestedMarkets` must be
 * non-empty (a caller-contract invariant, so it throws — never a data condition).
 */
export function buildGameBundle(
  game: GamesEndpointRow,
  odds: Map<string, CurrentOddsRow>,
  assembledAtMs: number,
  requestedMarkets: Iterable<MarketKey>,
): GameBundleResult {
  const requested = new Set<MarketKey>(requestedMarkets);
  if (requested.size === 0) {
    throw new Error('buildGameBundle: requestedMarkets must be non-empty');
  }
  const moneyline = requested.has('moneyline') ? odds.get('moneyline') : undefined;
  const spread = requested.has('spread') ? odds.get('spread') : undefined;
  const total = requested.has('total') ? odds.get('total') : undefined;
  if (!moneyline && !spread && !total) return { reason: 'no_odds_rows' };
  if (requested.has('moneyline') && !moneyline) return { reason: 'missing_market:moneyline' };
  if (requested.has('spread') && !spread) return { reason: 'missing_market:spread' };
  if (requested.has('total') && !total) return { reason: 'missing_market:total' };
  // Per-market price/line validation, guarded by presence so only requested
  // markets are checked. The nested form gives each present row a direct
  // non-null narrowing that survives the timestamp loop below (each is a const),
  // and preserves the pre-scoped reason precedence for the full board.
  if (moneyline) {
    if (moneyline.away_odds_american === null || moneyline.home_odds_american === null) {
      return { reason: 'one_sided_price:moneyline' };
    }
  }
  if (spread) {
    if (spread.away_odds_american === null || spread.home_odds_american === null) {
      return { reason: 'one_sided_price:spread' };
    }
    if (spread.line === null) return { reason: 'missing_line:spread' };
  }
  if (total) {
    if (total.away_odds_american === null || total.home_odds_american === null) {
      return { reason: 'one_sided_price:total' };
    }
    if (total.line === null) return { reason: 'missing_line:total' };
  }
  const presentRows: Array<readonly [MarketKey, CurrentOddsRow]> = [];
  if (moneyline) presentRows.push(['moneyline', moneyline]);
  if (spread) presentRows.push(['spread', spread]);
  if (total) presentRows.push(['total', total]);
  for (const [market, row] of presentRows) {
    const problem = quoteTimestampProblem(row, market, assembledAtMs);
    if (problem !== null) return { reason: problem };
  }

  const gameId = game.gameId;
  const pitchers = extractProbablePitchers(game);
  // Only the requested markets contribute an evidenceRef, in the fixed
  // moneyline → runline → total order (full board ⇒ pre-scoped array).
  const evidenceRefs = [
    evidenceRef(gameId, 'identity'),
    evidenceRef(gameId, 'schedule'),
    ...(pitchers !== null ? [evidenceRef(gameId, 'pitchers')] : []),
    ...(moneyline ? [evidenceRef(gameId, 'moneyline')] : []),
    ...(spread ? [evidenceRef(gameId, 'runline')] : []),
    ...(total ? [evidenceRef(gameId, 'total')] : []),
  ];
  try {
    // Absent markets are OMITTED keys — assigned conditionally, never set to
    // `undefined`. canonicalize() key-sorts, so this matches the pre-scoped
    // object literal byte-for-byte when all three are present. The `!` on each
    // price/line is sound: the one_sided_price / missing_line gates above already
    // returned for any present-market null (TS just cannot carry that narrowing
    // across the intervening timestamp loop's call).
    const markets: GameBundle['markets'] = {};
    if (moneyline) {
      markets.moneyline = {
        awayDecimal: americanToDecimal(moneyline.away_odds_american!),
        homeDecimal: americanToDecimal(moneyline.home_odds_american!),
        observedAt: moneyline.upstream_last_updated,
        evidenceRef: evidenceRef(gameId, 'moneyline'),
      };
    }
    if (spread) {
      const spreadLine = spread.line!;
      markets.runLine = {
        line: spreadLine,
        awayHandicap: -spreadLine,
        homeHandicap: spreadLine,
        awayDecimal: americanToDecimal(spread.away_odds_american!),
        homeDecimal: americanToDecimal(spread.home_odds_american!),
        observedAt: spread.upstream_last_updated,
        evidenceRef: evidenceRef(gameId, 'runline'),
      };
    }
    if (total) {
      const totalLine = total.line!;
      markets.total = {
        line: totalLine,
        // Upstream storage convention: away column = Over, home column = Under.
        overDecimal: americanToDecimal(total.away_odds_american!),
        underDecimal: americanToDecimal(total.home_odds_american!),
        observedAt: total.upstream_last_updated,
        evidenceRef: evidenceRef(gameId, 'total'),
      };
    }
    return {
      bundle: {
        gameId,
        league: 'mlb',
        scheduledStartUtc: game.matchTime,
        awayTeam: game.awayTeam.name,
        homeTeam: game.homeTeam.name,
        probableStartingPitchers: pitchers,
        markets,
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
    const result = buildGameBundle(
      game,
      oddsByGame.get(game.gameId) ?? new Map(),
      assembledAtMs,
      FULL_BOARD_MARKETS,
    );
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
    .map((game) =>
      buildGameRequest(game, slugs.get(game.gameId) ?? game.gameId, slateDate, inputs.fetchCompletedAt),
    )
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
