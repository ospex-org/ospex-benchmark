import { canonicalize, sha256Hex } from './canonical.js';
import { enabledMarkets } from './marketPolicy.js';
import { MARKET_KEYS } from './markets.js';
import { americanToDecimal } from './odds.js';
import { easternCalendarDay } from './slateDate.js';
import { SMOKE_LABEL } from './types.js';
import type {
  CurrentOddsRow,
  ExcludedGame,
  GameBundle,
  GamesEndpointRow,
  MarketKey,
  MoneylineBlock,
  ProbablePitchers,
  RunLineBlock,
  SlateBundle,
  SlateInputs,
  TotalBlock,
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
 * bundle assembly time. Violations exclude the market with a stable reason.
 */
export const MAX_QUOTE_AGE_MS = 30 * 60 * 1000;
export const FUTURE_QUOTE_SKEW_MS = 2 * 60 * 1000;

/**
 * Why one market on one game did not make it into a bundle. `buildable` is the
 * success value; every other value is a per-market not-entered reason at the
 * snapshot/freshness layer. `policy_disabled` and `market_never_opened` are
 * the two an operator most needs to tell apart — the first is by design, the
 * second is the book simply not having hung the line yet. Game-level reasons
 * (`status:*`, `already_started`) are carried separately.
 */
export type MarketBuildReason =
  | 'buildable'
  | 'policy_disabled'
  | 'market_never_opened'
  | 'one_sided'
  | 'missing_line'
  | 'stale_quote'
  | 'future_quote'
  | 'invalid_quote_timestamp'
  | 'invalid_price';

function quoteTimestampProblem(
  row: CurrentOddsRow,
  assembledAtMs: number,
): MarketBuildReason | null {
  const observedMs = Date.parse(row.upstream_last_updated);
  if (Number.isNaN(observedMs)) return 'invalid_quote_timestamp';
  if (observedMs > assembledAtMs + FUTURE_QUOTE_SKEW_MS) return 'future_quote';
  if (assembledAtMs - observedMs > MAX_QUOTE_AGE_MS) return 'stale_quote';
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

type MarketBlock = MoneylineBlock | RunLineBlock | TotalBlock;

/**
 * Evaluate ONE market on one game against a snapshot: shape (two-sidedness,
 * line presence) and freshness. Returns the frozen block or a stable reason.
 * Pure — no policy, no late gate, no ledger. Those layers compose on top.
 */
function evaluateMarket(
  gameId: string,
  market: MarketKey,
  row: CurrentOddsRow | undefined,
  assembledAtMs: number,
): { block: MarketBlock } | { reason: MarketBuildReason } {
  if (row === undefined) return { reason: 'market_never_opened' };
  if (row.away_odds_american === null || row.home_odds_american === null) {
    return { reason: 'one_sided' };
  }
  if ((market === 'spread' || market === 'total') && row.line === null) {
    return { reason: 'missing_line' };
  }
  const stale = quoteTimestampProblem(row, assembledAtMs);
  if (stale !== null) return { reason: stale };
  try {
    if (market === 'moneyline') {
      const block: MoneylineBlock = {
        awayDecimal: americanToDecimal(row.away_odds_american),
        homeDecimal: americanToDecimal(row.home_odds_american),
        observedAt: row.upstream_last_updated,
        evidenceRef: evidenceRef(gameId, 'moneyline'),
      };
      return { block };
    }
    if (market === 'spread') {
      const line = row.line as number;
      const block: RunLineBlock = {
        line,
        awayHandicap: -line,
        homeHandicap: line,
        awayDecimal: americanToDecimal(row.away_odds_american),
        homeDecimal: americanToDecimal(row.home_odds_american),
        observedAt: row.upstream_last_updated,
        evidenceRef: evidenceRef(gameId, 'runline'),
      };
      return { block };
    }
    const block: TotalBlock = {
      line: row.line as number,
      // Upstream storage convention: away column = Over, home column = Under.
      overDecimal: americanToDecimal(row.away_odds_american),
      underDecimal: americanToDecimal(row.home_odds_american),
      observedAt: row.upstream_last_updated,
      evidenceRef: evidenceRef(gameId, 'total'),
    };
    return { block };
  } catch {
    // A corrupt upstream price (non-integer, |value| < 100) excludes this one
    // market rather than aborting the game or the slate.
    return { reason: 'invalid_price' };
  }
}

export interface GameMarketsEval {
  /** Blocks for the markets that are enabled AND buildable, keyed by bundle key. */
  blocks: { moneyline?: MoneylineBlock; runLine?: RunLineBlock; total?: TotalBlock };
  /** Enabled + buildable markets, canonical order — the fireable-at-snapshot set. */
  built: MarketKey[];
  /**
   * Reason for every one of the three markets that is NOT in `built`. Universal
   * detection: a market disabled by policy is `policy_disabled` here, not
   * silently omitted, so the denominator sees it.
   */
  reasons: Partial<Record<MarketKey, MarketBuildReason>>;
  /** Game-level exclusion (`status:*` / `already_started`), else null. */
  gameExcludedReason: string | null;
}

/**
 * Evaluate all three markets of one game: apply the market policy (disabled
 * markets are recorded, never dispatched), then per-market shape + freshness.
 * The game-level gate (`upcoming`, future first pitch) short-circuits every
 * market with the same reason. This is the shared primitive the slate builder
 * and the line-open watcher both compose. The enabled market set defaults to
 * the committed policy for the game's league; callers may pass an explicit set
 * (the watcher threads its policy seam through here so detection can never
 * drift from what participants are given).
 */
export function evaluateGameMarkets(
  gameRow: GamesEndpointRow,
  oddsMap: Map<string, CurrentOddsRow>,
  assembledAtMs: number,
  options: { requireFuture: boolean; enabled?: MarketKey[] },
): GameMarketsEval {
  const reasons: Partial<Record<MarketKey, MarketBuildReason>> = {};
  const blocks: GameMarketsEval['blocks'] = {};
  const built: MarketKey[] = [];

  let gameExcludedReason: string | null = null;
  if (gameRow.status !== 'upcoming') {
    gameExcludedReason = `status:${gameRow.status}`;
  } else if (options.requireFuture && Date.parse(gameRow.matchTime) <= assembledAtMs) {
    gameExcludedReason = 'already_started';
  }

  const enabled = new Set(options.enabled ?? enabledMarkets(gameRow.sport));
  for (const market of MARKET_KEYS) {
    if (!enabled.has(market)) {
      reasons[market] = 'policy_disabled';
      continue;
    }
    if (gameExcludedReason !== null) {
      // The game itself cannot fire; every enabled market inherits that, but
      // the market is still counted (universal detection). market_never_opened
      // is the closest snapshot-level reason for "not fireable now".
      reasons[market] = 'market_never_opened';
      continue;
    }
    const result = evaluateMarket(gameRow.gameId, market, oddsMap.get(market), assembledAtMs);
    if ('reason' in result) {
      reasons[market] = result.reason;
      continue;
    }
    built.push(market);
    if (market === 'moneyline') blocks.moneyline = result.block as MoneylineBlock;
    else if (market === 'spread') blocks.runLine = result.block as RunLineBlock;
    else blocks.total = result.block as TotalBlock;
  }

  return { blocks, built, reasons, gameExcludedReason };
}

/**
 * Assemble a frozen GameBundle from a chosen market subset (⊆ the evaluated
 * `built` set). The evidenceRefs and the markets object carry exactly the
 * chosen markets — a scoped fire and a full board differ only in which blocks
 * are present, and the content hash reflects that.
 */
export function assembleGameBundle(
  gameRow: GamesEndpointRow,
  blocks: GameMarketsEval['blocks'],
  markets: MarketKey[],
): GameBundle {
  const gameId = gameRow.gameId;
  const pitchers = extractProbablePitchers(gameRow);
  const chosen = new Set(markets);

  // Canonical market order; only chosen + present blocks are carried.
  const marketBlocks: GameBundle['markets'] = {};
  const marketRefs: string[] = [];
  if (chosen.has('moneyline') && blocks.moneyline !== undefined) {
    marketBlocks.moneyline = blocks.moneyline;
    marketRefs.push(blocks.moneyline.evidenceRef);
  }
  if (chosen.has('spread') && blocks.runLine !== undefined) {
    marketBlocks.runLine = blocks.runLine;
    marketRefs.push(blocks.runLine.evidenceRef);
  }
  if (chosen.has('total') && blocks.total !== undefined) {
    marketBlocks.total = blocks.total;
    marketRefs.push(blocks.total.evidenceRef);
  }

  const evidenceRefs = [
    evidenceRef(gameId, 'identity'),
    evidenceRef(gameId, 'schedule'),
    ...(pitchers !== null ? [evidenceRef(gameId, 'pitchers')] : []),
    ...marketRefs,
  ];

  return {
    gameId,
    league: 'mlb',
    scheduledStartUtc: gameRow.matchTime,
    awayTeam: gameRow.awayTeam.name,
    homeTeam: gameRow.homeTeam.name,
    probableStartingPitchers: pitchers,
    markets: marketBlocks,
    evidenceRefs,
  };
}

/**
 * A single-game, market-scoped BuildResult — the line-open watcher's fire
 * primitive. Given a game's evaluated blocks and the chosen (gated, ready)
 * market subset, it produces the same BuildResult shape the record writer
 * consumes, so a scoped fire and a full smoke slate write identical record
 * types. The slate here is just this one game.
 */
export function buildScopedResult(options: {
  gameRow: GamesEndpointRow;
  blocks: GameMarketsEval['blocks'];
  markets: MarketKey[];
  slug: string;
  slateDate: string;
  bundleTimestamp: string;
  oddsRows: CurrentOddsRow[];
}): BuildResult {
  const game = assembleGameBundle(options.gameRow, options.blocks, options.markets);
  const gameSha = sha256Hex(canonicalize(game));
  const request = buildRequest(game, options.slug, options.slateDate, options.bundleTimestamp);
  const slateBundle: SlateBundle = {
    schemaVersion: 1,
    label: SMOKE_LABEL,
    league: 'mlb',
    slateDate: options.slateDate,
    bundleTimestamp: options.bundleTimestamp,
    cutoffAt: game.scheduledStartUtc,
    games: [game],
  };
  return {
    slateBundle,
    slateSha256: sha256Hex(canonicalize(slateBundle)),
    requests: [request],
    gameHashes: { [game.gameId]: gameSha },
    excluded: [],
    provenance: { [game.gameId]: { slug: options.slug, oddsRows: options.oddsRows } },
  };
}

/** Wrap one frozen GameBundle into a hashed single-game request. */
export function buildRequest(
  game: GameBundle,
  slug: string,
  slateDate: string,
  bundleTimestamp: string,
): GameRequest {
  const requestBundle: SlateBundle = {
    schemaVersion: 1,
    label: SMOKE_LABEL,
    league: 'mlb',
    slateDate,
    bundleTimestamp,
    cutoffAt: game.scheduledStartUtc,
    games: [game],
  };
  return {
    gameId: game.gameId,
    slug,
    game,
    requestBundle,
    requestSha256: sha256Hex(canonicalize(requestBundle)),
  };
}

/**
 * Build a whole slate at once (the `smoke` entry point). Each game carries the
 * subset of its policy-enabled markets that are buildable at the snapshot; a
 * game is excluded only when NO enabled market is buildable. The line-open
 * watcher does not use this — it composes evaluateGameMarkets / assembleGameBundle
 * per speculation with its own late gate — so partial-market semantics are
 * identical across both paths.
 */
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
    const oddsMap = oddsByGame.get(game.gameId) ?? new Map<string, CurrentOddsRow>();
    const evaluation = evaluateGameMarkets(game, oddsMap, assembledAtMs, options);
    if (evaluation.built.length === 0) {
      const reason =
        evaluation.gameExcludedReason ??
        // The most specific per-market reason, else a generic no-market note.
        evaluation.reasons.moneyline ??
        evaluation.reasons.total ??
        evaluation.reasons.spread ??
        'no_market_buildable';
      excluded.push({ gameId: game.gameId, slug: game.slug, reason });
      continue;
    }
    const bundle = assembleGameBundle(game, evaluation.blocks, evaluation.built);
    eligible.push(bundle);
    slugs.set(game.gameId, game.slug);
    gameHashes[game.gameId] = sha256Hex(canonicalize(bundle));
    provenance[game.gameId] = {
      slug: game.slug,
      oddsRows: MARKET_KEYS.map((m) => oddsMap.get(m)).filter(
        (r): r is CurrentOddsRow => r !== undefined,
      ),
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
  // each with its own cutoff (that game's first pitch), sorted earliest-first
  // with the stable game-ID tie-breaker (game IDs are opaque, no time order).
  const requests: GameRequest[] = eligible
    .map((game) => buildRequest(game, slugs.get(game.gameId) ?? game.gameId, slateDate, inputs.fetchCompletedAt))
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
