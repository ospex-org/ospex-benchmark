import { z } from 'zod';
import { canonicalize, sha256Hex } from './canonical.js';
import { scoreDecision } from './clv.js';
import { SMOKE_LABEL } from './types.js';
import type { ClvResult, CloseQuote, SelectedSide } from './clv.js';
import type { ClosingLineRow, MarketKey } from './types.js';

/**
 * Pure scoring assembly, no I/O: parse a run's records, VERIFY THE RUN'S
 * INTEGRITY (recomputed hashes, decision echoes, decision-to-response
 * linkage, absence of recorded run failures), join picks to the captured
 * closes, score each through the CLV module, and aggregate with full
 * coverage accounting — the equal-weight game-level aggregate is the primary
 * summary per the methodology, and arms that produced no valid decision
 * still appear in the denominators. The CLI wraps this with file reading and
 * the close fetch.
 */

// ---------------------------------------------------------------------------
// Source-run parsing (the harness's own NDJSON records)
// ---------------------------------------------------------------------------

const runMetaSchema = z
  .object({
    recordType: z.literal('run_meta'),
    runId: z.string().min(1),
    cohortId: z.string().min(1),
    label: z.string().min(1),
    mode: z.string().min(1),
    slateDate: z.string().min(1),
    slateSha256: z.string().min(1),
    bundleTimestamp: z.string().min(1),
    slateCutoffAt: z.string().min(1),
  })
  .passthrough();

const bundleGameSchema = z
  .object({
    recordType: z.literal('bundle_game'),
    gameId: z.string().min(1),
    slug: z.string().min(1),
    cutoffAt: z.string().min(1),
    gameSha256: z.string().min(1),
    requestSha256: z.string().min(1),
    bundle: z
      .object({
        gameId: z.string().min(1),
        league: z.string().min(1),
        awayTeam: z.string().min(1),
        homeTeam: z.string().min(1),
        scheduledStartUtc: z.string().min(1),
        markets: z
          .object({
            moneyline: z
              .object({ awayDecimal: z.number(), homeDecimal: z.number() })
              .passthrough(),
            runLine: z
              .object({ line: z.number(), awayDecimal: z.number(), homeDecimal: z.number() })
              .passthrough(),
            total: z
              .object({ line: z.number(), overDecimal: z.number(), underDecimal: z.number() })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const armResponseSchema = z
  .object({
    recordType: z.literal('arm_game_response'),
    participantId: z.string().min(1),
    provider: z.string().min(1),
    requestedModelId: z.string().min(1),
    reportedModelId: z.string().nullable(),
    gameId: z.string().min(1),
    requestSha256: z.string().min(1),
    outcome: z.string().min(1),
  })
  .passthrough();

const runFailureSchema = z
  .object({
    recordType: z.literal('run_failure'),
    code: z.string().min(1),
    failures: z.array(z.string()),
  })
  .passthrough();

const decisionSchema = z
  .object({
    recordType: z.literal('decision'),
    participantId: z.string().min(1),
    gameId: z.string().min(1),
    market: z.enum(['moneyline', 'spread', 'total']),
    selection: z.string().min(1),
    line: z.number().nullable(),
    observedDecimal: z.number().gt(1),
    probabilities: z
      .object({ win: z.number(), push: z.number(), loss: z.number() })
      .passthrough(),
    confidence: z.number(),
    selectedForExecution: z.boolean(),
    wouldAbstain: z.boolean(),
    provider: z.string().min(1),
    requestedModelId: z.string().min(1),
    reportedModelId: z.string().nullable(),
    providerResponseId: z.string().nullable(),
    attemptUsed: z.enum(['initial', 'repair']),
    bundleSha256: z.string().min(1),
    gameSha256: z.string().nullable(),
    slateSha256: z.string().min(1),
  })
  .passthrough();

const baselineDecisionSchema = z
  .object({
    recordType: z.literal('baseline_decision'),
    participantId: z.string().min(1),
    gameId: z.string().min(1),
    market: z.enum(['moneyline', 'spread', 'total']),
    selection: z.string().min(1),
    line: z.number().nullable(),
    observedDecimal: z.number().gt(1),
    policyVersion: z.string().min(1),
    slateSha256: z.string().min(1),
    gameSha256: z.string().nullable(),
    requestSha256: z.string().nullable(),
  })
  .passthrough();

export interface SourceGame {
  awayTeam: string;
  homeTeam: string;
  slug: string;
  startUtc: string;
  cutoffAt: string;
  gameSha256: string;
  requestSha256: string;
  /** The bundle exactly as recorded, for hash recomputation. */
  rawBundle: unknown;
  prices: {
    moneyline: { away: number; home: number };
    runLine: { line: number; away: number; home: number };
    total: { line: number; over: number; under: number };
  };
}

export interface SourcePick {
  kind: 'model' | 'baseline';
  participantId: string;
  gameId: string;
  market: MarketKey;
  selection: string;
  line: number | null;
  entryDecimal: number;
  modelWinProbability: number | null;
  wouldAbstain: boolean | null;
  selectedForExecution: boolean | null;
  provider: string | null;
  requestedModelId: string | null;
  reportedModelId: string | null;
  providerResponseId: string | null;
  attemptUsed: 'initial' | 'repair' | null;
  echoedRequestSha256: string | null;
  echoedGameSha256: string | null;
  echoedSlateSha256: string | null;
}

export interface ArmResponseRef {
  participantId: string;
  provider: string;
  requestedModelId: string;
  reportedModelId: string | null;
  gameId: string;
  requestSha256: string;
  outcome: string;
}

export interface SourceRun {
  runId: string;
  cohortId: string;
  label: string;
  mode: string;
  slateDate: string;
  slateSha256: string;
  bundleTimestamp: string;
  slateCutoffAt: string;
  games: Map<string, SourceGame>;
  picks: SourcePick[];
  armResponses: ArmResponseRef[];
  runFailures: Array<{ code: string; failures: string[] }>;
}

function parseRecordLine(trimmed: string, lineNumber: number): { recordType?: unknown } {
  try {
    return JSON.parse(trimmed) as { recordType?: unknown };
  } catch {
    throw new Error(`run file line ${lineNumber} is not valid JSON`);
  }
}

export function parseRunRecords(lines: string[]): SourceRun {
  let meta: z.infer<typeof runMetaSchema> | null = null;
  const games = new Map<string, SourceGame>();
  const picks: SourcePick[] = [];
  const armResponses: ArmResponseRef[] = [];
  const runFailures: Array<{ code: string; failures: string[] }> = [];

  let lineNumber = 0;
  for (const line of lines) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const record = parseRecordLine(trimmed, lineNumber);
    switch (record.recordType) {
      case 'run_meta':
        meta = runMetaSchema.parse(record);
        break;
      case 'bundle_game': {
        const game = bundleGameSchema.parse(record);
        games.set(game.gameId, {
          awayTeam: game.bundle.awayTeam,
          homeTeam: game.bundle.homeTeam,
          slug: game.slug,
          startUtc: game.bundle.scheduledStartUtc,
          cutoffAt: game.cutoffAt,
          gameSha256: game.gameSha256,
          requestSha256: game.requestSha256,
          rawBundle: game.bundle,
          prices: {
            moneyline: {
              away: game.bundle.markets.moneyline.awayDecimal,
              home: game.bundle.markets.moneyline.homeDecimal,
            },
            runLine: {
              line: game.bundle.markets.runLine.line,
              away: game.bundle.markets.runLine.awayDecimal,
              home: game.bundle.markets.runLine.homeDecimal,
            },
            total: {
              line: game.bundle.markets.total.line,
              over: game.bundle.markets.total.overDecimal,
              under: game.bundle.markets.total.underDecimal,
            },
          },
        });
        break;
      }
      case 'arm_game_response': {
        const response = armResponseSchema.parse(record);
        armResponses.push({
          participantId: response.participantId,
          provider: response.provider,
          requestedModelId: response.requestedModelId,
          reportedModelId: response.reportedModelId,
          gameId: response.gameId,
          requestSha256: response.requestSha256,
          outcome: response.outcome,
        });
        break;
      }
      case 'run_failure': {
        const failure = runFailureSchema.parse(record);
        runFailures.push({ code: failure.code, failures: failure.failures });
        break;
      }
      case 'decision': {
        const decision = decisionSchema.parse(record);
        picks.push({
          kind: 'model',
          participantId: decision.participantId,
          gameId: decision.gameId,
          market: decision.market,
          selection: decision.selection,
          line: decision.line,
          entryDecimal: decision.observedDecimal,
          modelWinProbability: decision.probabilities.win,
          wouldAbstain: decision.wouldAbstain,
          selectedForExecution: decision.selectedForExecution,
          provider: decision.provider,
          requestedModelId: decision.requestedModelId,
          reportedModelId: decision.reportedModelId,
          providerResponseId: decision.providerResponseId,
          attemptUsed: decision.attemptUsed,
          echoedRequestSha256: decision.bundleSha256,
          echoedGameSha256: decision.gameSha256,
          echoedSlateSha256: decision.slateSha256,
        });
        break;
      }
      case 'baseline_decision': {
        const baseline = baselineDecisionSchema.parse(record);
        picks.push({
          kind: 'baseline',
          participantId: baseline.participantId,
          gameId: baseline.gameId,
          market: baseline.market,
          selection: baseline.selection,
          line: baseline.line,
          entryDecimal: baseline.observedDecimal,
          modelWinProbability: null,
          wouldAbstain: null,
          selectedForExecution: null,
          provider: null,
          requestedModelId: null,
          reportedModelId: null,
          providerResponseId: null,
          attemptUsed: null,
          echoedRequestSha256: baseline.requestSha256,
          echoedGameSha256: baseline.gameSha256,
          echoedSlateSha256: baseline.slateSha256,
        });
        break;
      }
      default:
        break;
    }
  }

  if (meta === null) {
    throw new Error('run file has no run_meta record — is this a harness NDJSON file?');
  }
  if (games.size === 0) {
    throw new Error('run file has no bundle_game records — nothing to score against');
  }
  return {
    runId: meta.runId,
    cohortId: meta.cohortId,
    label: meta.label,
    mode: meta.mode,
    slateDate: meta.slateDate,
    slateSha256: meta.slateSha256,
    bundleTimestamp: meta.bundleTimestamp,
    slateCutoffAt: meta.slateCutoffAt,
    games,
    picks,
    armResponses,
    runFailures,
  };
}

// ---------------------------------------------------------------------------
// Run integrity — a scorecard is only as trustworthy as its input
// ---------------------------------------------------------------------------

function expectedEntry(
  game: SourceGame,
  market: MarketKey,
  side: SelectedSide,
): { price: number; line: number | null } {
  if (market === 'moneyline') {
    return { price: side === 'away' ? game.prices.moneyline.away : game.prices.moneyline.home, line: null };
  }
  if (market === 'spread') {
    return {
      price: side === 'away' ? game.prices.runLine.away : game.prices.runLine.home,
      line: game.prices.runLine.line,
    };
  }
  return {
    price: side === 'away' ? game.prices.total.over : game.prices.total.under,
    line: game.prices.total.line,
  };
}

/**
 * Verify the run file is internally consistent before trusting a single
 * number in it. Returns violations (empty = verified):
 *
 * - a recorded run_failure (identity/collision) makes the run unscoreable;
 * - every recorded game/request/slate hash must match a recomputation from
 *   the embedded bundles (a tampered price or bundle cannot hide);
 * - every model decision must be backed by a VALID arm response for the same
 *   participant/game/request hash, exactly three decisions per valid
 *   response and none for non-valid ones (no fabricated decisions);
 * - every decision's echoed selection/line/price must re-verify against the
 *   hash-verified bundle, and its echoed hashes must match.
 */
export function verifyRunIntegrity(run: SourceRun): string[] {
  const violations: string[] = [];

  for (const failure of run.runFailures) {
    violations.push(
      `run recorded a hard failure (${failure.code}: ${failure.failures.length} finding(s)) — this run is not scoreable`,
    );
  }

  // Hash recomputation, bottom-up: game -> request -> slate.
  const sortedBundles: unknown[] = [...run.games.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, game]) => game.rawBundle);
  for (const [gameId, game] of run.games) {
    const recomputedGame = sha256Hex(canonicalize(game.rawBundle));
    if (recomputedGame !== game.gameSha256) {
      violations.push(`game ${gameId}: recorded gameSha256 does not match the recomputed bundle hash`);
    }
    const league = (game.rawBundle as { league?: unknown }).league;
    const requestBundle = {
      schemaVersion: 1,
      label: run.label,
      league,
      slateDate: run.slateDate,
      bundleTimestamp: run.bundleTimestamp,
      cutoffAt: game.cutoffAt,
      games: [game.rawBundle],
    };
    if (sha256Hex(canonicalize(requestBundle)) !== game.requestSha256) {
      violations.push(`game ${gameId}: recorded requestSha256 does not match the recomputed request bundle hash`);
    }
  }
  const firstGame = [...run.games.values()][0];
  const slateBundle = {
    schemaVersion: 1,
    label: run.label,
    league: (firstGame?.rawBundle as { league?: unknown } | undefined)?.league,
    slateDate: run.slateDate,
    bundleTimestamp: run.bundleTimestamp,
    cutoffAt: run.slateCutoffAt,
    games: sortedBundles,
  };
  if (sha256Hex(canonicalize(slateBundle)) !== run.slateSha256) {
    violations.push('run_meta slateSha256 does not match the recomputed slate hash');
  }

  // Decision-to-response linkage.
  const responseByKey = new Map(run.armResponses.map((r) => [`${r.participantId}:${r.gameId}`, r]));
  const modelPicksByKey = new Map<string, SourcePick[]>();
  for (const pick of run.picks.filter((p) => p.kind === 'model')) {
    const key = `${pick.participantId}:${pick.gameId}`;
    const list = modelPicksByKey.get(key) ?? [];
    list.push(pick);
    modelPicksByKey.set(key, list);
  }
  for (const [key, list] of modelPicksByKey) {
    const response = responseByKey.get(key);
    if (!response) {
      violations.push(`decisions for ${key} have no arm_game_response record backing them`);
      continue;
    }
    if (response.outcome !== 'valid') {
      violations.push(`decisions for ${key} are backed by a non-valid arm response (${response.outcome})`);
    }
    const markets = new Set(list.map((p) => p.market));
    if (list.length !== 3 || markets.size !== 3) {
      violations.push(`${key}: expected exactly one decision per market, found ${list.length}`);
    }
  }
  for (const response of run.armResponses) {
    if (response.outcome === 'valid' && !modelPicksByKey.has(`${response.participantId}:${response.gameId}`)) {
      violations.push(
        `valid arm response ${response.participantId}:${response.gameId} has no decision records`,
      );
    }
  }

  // Echo re-verification against the hash-verified bundles.
  for (const pick of run.picks) {
    const game = run.games.get(pick.gameId);
    if (!game) {
      violations.push(`pick ${pick.participantId}:${pick.gameId}:${pick.market} references an unknown game`);
      continue;
    }
    let side: SelectedSide;
    try {
      side = sideForSelection(pick.market, pick.selection, game);
    } catch (error) {
      violations.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const expected = expectedEntry(game, pick.market, side);
    if (pick.entryDecimal !== expected.price) {
      violations.push(
        `${pick.participantId}:${pick.gameId}:${pick.market}: entry price ${pick.entryDecimal} does not match the frozen bundle price ${expected.price}`,
      );
    }
    if (pick.line !== expected.line) {
      violations.push(
        `${pick.participantId}:${pick.gameId}:${pick.market}: line ${pick.line ?? 'null'} does not match the designated line ${expected.line ?? 'null'}`,
      );
    }
    if (pick.echoedRequestSha256 !== null && pick.echoedRequestSha256 !== game.requestSha256) {
      violations.push(`${pick.participantId}:${pick.gameId}:${pick.market}: echoed request hash mismatch`);
    }
    if (pick.echoedGameSha256 !== null && pick.echoedGameSha256 !== game.gameSha256) {
      violations.push(`${pick.participantId}:${pick.gameId}:${pick.market}: echoed game hash mismatch`);
    }
    if (pick.echoedSlateSha256 !== null && pick.echoedSlateSha256 !== run.slateSha256) {
      violations.push(`${pick.participantId}:${pick.gameId}:${pick.market}: echoed slate hash mismatch`);
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Join + score
// ---------------------------------------------------------------------------

export function closeQuoteFromRow(row: ClosingLineRow): CloseQuote {
  return {
    line: row.line,
    awayDecimal: row.away_odds_decimal,
    homeDecimal: row.home_odds_decimal,
    awayPNovig: row.away_p_novig,
    homePNovig: row.home_p_novig,
    confidence: row.confidence,
  };
}

export function closesByKey(rows: ClosingLineRow[]): Map<string, ClosingLineRow> {
  return new Map(rows.map((row) => [`${row.jsonodds_id}:${row.market}`, row]));
}

export interface ScoredPick extends SourcePick {
  side: SelectedSide;
  result: ClvResult;
  close: ClosingLineRow | null;
}

/**
 * Selection label → close-column side. Moneyline/spread selections are exact
 * team names; totals map over → away column, under → home column (the
 * upstream storage convention).
 */
export function sideForSelection(
  market: MarketKey,
  selection: string,
  game: { awayTeam: string; homeTeam: string },
): SelectedSide {
  if (market === 'total') {
    if (selection === 'over') return 'away';
    if (selection === 'under') return 'home';
    throw new Error(`total selection must be over/under, got "${selection}"`);
  }
  if (selection === game.awayTeam) return 'away';
  if (selection === game.homeTeam) return 'home';
  throw new Error(
    `selection "${selection}" matches neither "${game.awayTeam}" (away) nor "${game.homeTeam}" (home)`,
  );
}

export function scoreRun(run: SourceRun, closeRows: ClosingLineRow[]): ScoredPick[] {
  const closes = closesByKey(closeRows);
  return run.picks.map((pick) => {
    const game = run.games.get(pick.gameId);
    if (!game) {
      throw new Error(`pick references game ${pick.gameId} with no bundle_game record`);
    }
    const side = sideForSelection(pick.market, pick.selection, game);
    const movementSelection =
      pick.market === 'total' ? (pick.selection as 'over' | 'under') : side;
    const close = closes.get(`${pick.gameId}:${pick.market}`) ?? null;
    const result = scoreDecision(
      pick.market,
      side,
      movementSelection,
      pick.entryDecimal,
      pick.line,
      close === null ? null : closeQuoteFromRow(close),
    );
    return { ...pick, side, result, close };
  });
}

// ---------------------------------------------------------------------------
// Aggregation — equal-weight game-level primary, full coverage accounting
// ---------------------------------------------------------------------------

export interface ClvSummary {
  meanClvPct: number | null;
  medianClvPct: number | null;
  beatClosePct: number | null;
}

export interface ParticipantStats {
  participantId: string;
  kind: 'model' | 'baseline';
  /** Games this arm was dispatched (models) or picked in (baselines). */
  games: number;
  /** Market-decision opportunities: models 3 per dispatched game; baselines 1 per pick. */
  eligibleMarkets: number;
  /** Valid decisions present in the run file. */
  validDecisions: number;
  /** Arm-level outcome counts (models) — failures stay in the denominator. */
  armOutcomes: Record<string, number>;
  primaryScoreable: number;
  /** PRIMARY: equal-weight game-level aggregate (mean of per-game mean CLV). */
  gamesScoreable: number;
  gameLevel: ClvSummary;
  /** Secondary: per-pick aggregate. */
  perPick: ClvSummary;
  conditionalOnly: number;
  unscoredByReason: Record<string, number>;
  byMarket: Record<string, { picks: number; scoreable: number; meanClvPct: number | null }>;
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round4(values.reduce((a, b) => a + b, 0) / values.length);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return round4(value);
}

function summary(values: number[]): ClvSummary {
  return {
    meanClvPct: mean(values),
    medianClvPct: median(values),
    beatClosePct:
      values.length === 0
        ? null
        : round4((values.filter((v) => v > 0).length / values.length) * 100),
  };
}

export function aggregateByParticipant(
  scored: ScoredPick[],
  run: SourceRun,
): ParticipantStats[] {
  const picksByParticipant = new Map<string, ScoredPick[]>();
  for (const pick of scored) {
    const list = picksByParticipant.get(pick.participantId) ?? [];
    list.push(pick);
    picksByParticipant.set(pick.participantId, list);
  }
  const responsesByParticipant = new Map<string, ArmResponseRef[]>();
  for (const response of run.armResponses) {
    const list = responsesByParticipant.get(response.participantId) ?? [];
    list.push(response);
    responsesByParticipant.set(response.participantId, list);
  }

  // Every arm that was dispatched appears, even with zero valid decisions —
  // failures must never vanish from the denominators.
  const participantIds = [
    ...new Set([...responsesByParticipant.keys(), ...picksByParticipant.keys()]),
  ];

  const stats: ParticipantStats[] = [];
  for (const participantId of participantIds) {
    const picks = picksByParticipant.get(participantId) ?? [];
    const responses = responsesByParticipant.get(participantId) ?? [];
    const kind: 'model' | 'baseline' =
      responses.length > 0 || picks[0]?.kind === 'model' ? 'model' : 'baseline';

    const armOutcomes: Record<string, number> = {};
    for (const response of responses) {
      armOutcomes[response.outcome] = (armOutcomes[response.outcome] ?? 0) + 1;
    }

    const primary = picks
      .map((p) => p.result.primaryClvPct)
      .filter((v): v is number => v !== null);
    const unscoredByReason: Record<string, number> = {};
    for (const pick of picks) {
      if (pick.result.unscoredReason !== null) {
        unscoredByReason[pick.result.unscoredReason] =
          (unscoredByReason[pick.result.unscoredReason] ?? 0) + 1;
      }
    }

    // Equal-weight game level: average scoreable CLV within each game first.
    const byGame = new Map<string, number[]>();
    for (const pick of picks) {
      if (pick.result.primaryClvPct === null) continue;
      const list = byGame.get(pick.gameId) ?? [];
      list.push(pick.result.primaryClvPct);
      byGame.set(pick.gameId, list);
    }
    const gameMeans = [...byGame.values()]
      .map((values) => mean(values))
      .filter((v): v is number => v !== null);

    const byMarket: ParticipantStats['byMarket'] = {};
    for (const market of ['moneyline', 'spread', 'total']) {
      const marketPicks = picks.filter((p) => p.market === market);
      if (marketPicks.length === 0) continue;
      const scoreable = marketPicks
        .map((p) => p.result.primaryClvPct)
        .filter((v): v is number => v !== null);
      byMarket[market] = {
        picks: marketPicks.length,
        scoreable: scoreable.length,
        meanClvPct: mean(scoreable),
      };
    }

    stats.push({
      participantId,
      kind,
      games: kind === 'model' ? responses.length : new Set(picks.map((p) => p.gameId)).size,
      eligibleMarkets: kind === 'model' ? responses.length * 3 : picks.length,
      validDecisions: picks.length,
      armOutcomes,
      primaryScoreable: primary.length,
      gamesScoreable: gameMeans.length,
      gameLevel: summary(gameMeans),
      perPick: summary(primary),
      conditionalOnly: picks.filter((p) => p.result.conditionalClvPct !== null).length,
      unscoredByReason,
      byMarket,
    });
  }

  // Models first (by game-level mean CLV desc), then baselines.
  const rank = (s: ParticipantStats): number =>
    s.gameLevel.meanClvPct === null ? -1e9 : s.gameLevel.meanClvPct;
  return stats.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'model' ? -1 : 1;
    return rank(b) - rank(a);
  });
}

// ---------------------------------------------------------------------------
// Scored records (NDJSON shape)
// ---------------------------------------------------------------------------

export function scoredRecords(
  run: SourceRun,
  scored: ScoredPick[],
  stats: ParticipantStats[],
  scoredAt: string,
): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  records.push({
    recordType: 'scored_run_meta',
    label: SMOKE_LABEL,
    runId: run.runId,
    cohortId: run.cohortId,
    slateDate: run.slateDate,
    slateSha256: run.slateSha256,
    sourceMode: run.mode,
    scoredAt,
    integrityVerified: true,
    metric: 'reference-closing CLV (single reference source, decision CLV only)',
    primaryAggregate: 'equal-weight game-level mean (per-pick reported as secondary)',
    closePolicy: {
      confidenceRequired: 'fresh',
      lineMatchRequired: true,
      integerLinePrimary: 'unavailable (conditional CLV separately labeled)',
    },
    picks: scored.length,
    primaryScoreable: scored.filter((p) => p.result.primaryClvPct !== null).length,
    armGameResponses: run.armResponses.length,
  });
  for (const pick of scored) {
    const game = run.games.get(pick.gameId);
    records.push({
      recordType: 'scored_decision',
      label: SMOKE_LABEL,
      runId: run.runId,
      scoredAt,
      kind: pick.kind,
      participantId: pick.participantId,
      provider: pick.provider,
      requestedModelId: pick.requestedModelId,
      reportedModelId: pick.reportedModelId,
      providerResponseId: pick.providerResponseId,
      attemptUsed: pick.attemptUsed,
      gameId: pick.gameId,
      slateSha256: run.slateSha256,
      gameSha256: game?.gameSha256 ?? null,
      requestSha256: game?.requestSha256 ?? null,
      market: pick.market,
      selection: pick.selection,
      side: pick.side,
      entryDecimal: pick.entryDecimal,
      entryLine: pick.line,
      modelWinProbability: pick.modelWinProbability,
      wouldAbstain: pick.wouldAbstain,
      selectedForExecution: pick.selectedForExecution,
      closing:
        pick.close === null
          ? null
          : {
              line: pick.close.line,
              awayDecimal: pick.close.away_odds_decimal,
              homeDecimal: pick.close.home_odds_decimal,
              awayPNovig: pick.close.away_p_novig,
              homePNovig: pick.close.home_p_novig,
              confidence: pick.close.confidence,
              valueCapturedAt: pick.close.value_captured_at,
              lockTime: pick.close.lock_time,
            },
      primaryClvPct: pick.result.primaryClvPct,
      unscoredReason: pick.result.unscoredReason,
      conditionalClvPct: pick.result.conditionalClvPct,
      lineMovementFavorable: pick.result.lineMovementFavorable,
      closingPNovigSelected: pick.result.closingPNovigSelected,
      aux: pick.result.aux,
    });
  }
  for (const stat of stats) {
    records.push({
      recordType: 'participant_scorecard',
      label: SMOKE_LABEL,
      runId: run.runId,
      scoredAt,
      ...stat,
    });
  }
  return records;
}
