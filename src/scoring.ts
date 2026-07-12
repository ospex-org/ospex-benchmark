import { z } from 'zod';
import { scoreDecision } from './clv.js';
import { SMOKE_LABEL } from './types.js';
import type { ClvResult, CloseQuote, SelectedSide } from './clv.js';
import type { ClosingLineRow, MarketKey } from './types.js';

/**
 * Pure scoring assembly, no I/O: parse a run's records, join picks to the
 * captured closes, score each through the CLV module, and aggregate per
 * participant. The CLI wraps this with file reading and the close fetch.
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
  })
  .passthrough();

const bundleGameSchema = z
  .object({
    recordType: z.literal('bundle_game'),
    gameId: z.string().min(1),
    slug: z.string().min(1),
    bundle: z
      .object({
        awayTeam: z.string().min(1),
        homeTeam: z.string().min(1),
        scheduledStartUtc: z.string().min(1),
      })
      .passthrough(),
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
  })
  .passthrough();

export interface SourcePick {
  kind: 'model' | 'baseline';
  participantId: string;
  gameId: string;
  market: MarketKey;
  selection: string;
  line: number | null;
  entryDecimal: number;
  /** Model-submitted win probability (models only). */
  modelWinProbability: number | null;
  wouldAbstain: boolean | null;
  selectedForExecution: boolean | null;
}

export interface SourceRun {
  runId: string;
  cohortId: string;
  label: string;
  mode: string;
  slateDate: string;
  slateSha256: string;
  games: Map<string, { awayTeam: string; homeTeam: string; slug: string; startUtc: string }>;
  picks: SourcePick[];
}

export function parseRunRecords(lines: string[]): SourceRun {
  let meta: z.infer<typeof runMetaSchema> | null = null;
  const games = new Map<
    string,
    { awayTeam: string; homeTeam: string; slug: string; startUtc: string }
  >();
  const picks: SourcePick[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const record = JSON.parse(trimmed) as { recordType?: unknown };
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
        });
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
    games,
    picks,
  };
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
 * team names (validated at decision time against the frozen bundle); totals
 * map over → away column, under → home column (the upstream storage
 * convention).
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
// Aggregation
// ---------------------------------------------------------------------------

export interface ParticipantStats {
  participantId: string;
  kind: 'model' | 'baseline';
  picks: number;
  primaryScoreable: number;
  meanClvPct: number | null;
  medianClvPct: number | null;
  beatClosePct: number | null;
  conditionalOnly: number;
  unscoredByReason: Record<string, number>;
  byMarket: Record<string, { picks: number; scoreable: number; meanClvPct: number | null }>;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1e4) / 1e4;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return Math.round(value * 1e4) / 1e4;
}

export function aggregateByParticipant(scored: ScoredPick[]): ParticipantStats[] {
  const byParticipant = new Map<string, ScoredPick[]>();
  for (const pick of scored) {
    const list = byParticipant.get(pick.participantId) ?? [];
    list.push(pick);
    byParticipant.set(pick.participantId, list);
  }

  const stats: ParticipantStats[] = [];
  for (const [participantId, picks] of byParticipant) {
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
    const first = picks[0];
    stats.push({
      participantId,
      kind: first === undefined ? 'model' : first.kind,
      picks: picks.length,
      primaryScoreable: primary.length,
      meanClvPct: mean(primary),
      medianClvPct: median(primary),
      beatClosePct:
        primary.length === 0
          ? null
          : Math.round(((primary.filter((v) => v > 0).length / primary.length) * 100) * 100) / 100,
      conditionalOnly: picks.filter((p) => p.result.conditionalClvPct !== null).length,
      unscoredByReason,
      byMarket,
    });
  }

  // Models first (by mean CLV desc), then baselines (same order rule).
  const rank = (s: ParticipantStats): number => (s.meanClvPct === null ? -1e9 : s.meanClvPct);
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
    metric: 'reference-closing CLV (single reference source, decision CLV only)',
    closePolicy: {
      confidenceRequired: 'fresh',
      lineMatchRequired: true,
      integerLinePrimary: 'unavailable (conditional CLV separately labeled)',
    },
    picks: scored.length,
    primaryScoreable: scored.filter((p) => p.result.primaryClvPct !== null).length,
  });
  for (const pick of scored) {
    records.push({
      recordType: 'scored_decision',
      label: SMOKE_LABEL,
      runId: run.runId,
      scoredAt,
      kind: pick.kind,
      participantId: pick.participantId,
      gameId: pick.gameId,
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
