import { z } from 'zod';
import type {
  ArmSpec,
  BenchmarkResponse,
  ForecastOutput,
  GameBundle,
  MarketKey,
  SlateBundle,
} from './types.js';

/**
 * Real-validator enforcement of the output contract in
 * docs/BENCHMARK_PROMPT_V0.md: a strict zod shape pass, then semantic checks
 * against the frozen bundle (exact labels, echoed lines/prices, probability
 * coherence, execution-policy marking). Prose checking is not validation.
 */

const probabilitiesSchema = z
  .object({
    win: z.number().min(0).max(1),
    push: z.number().min(0).max(1),
    loss: z.number().min(0).max(1),
  })
  .strict();

const forecastSchema = z
  .object({
    market: z.enum(['moneyline', 'spread', 'total']),
    selection: z.string().min(1),
    line: z.number().nullable(),
    observedDecimal: z.number().gt(1),
    probabilities: probabilitiesSchema,
    confidence: z.number().min(0).max(1),
    wouldAbstain: z.boolean(),
    selectedForExecution: z.boolean(),
    rationale: z
      .string()
      .min(1)
      .refine((s) => s.trim().length > 0, 'rationale must not be whitespace-only'),
    // Every rationale must be grounded: at least one bundle evidenceRef.
    evidenceRefs: z.array(z.string().min(1)).min(1),
    // The supplied reason codes the system prompt refers to. Absent or null
    // unless required information is missing or contradictory.
    reasonCode: z.enum(['missing_information', 'contradictory_information']).nullable().optional(),
  })
  .strict();

const gameForecastsSchema = z
  .object({
    gameId: z.string().min(1),
    forecasts: z.array(forecastSchema).length(3),
  })
  .strict();

export const benchmarkResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    cohortId: z.string().min(1),
    participantId: z.string().min(1),
    requestedModelId: z.string().min(1),
    bundleSha256: z.string().regex(/^[0-9a-f]{64}$/),
    executionPolicy: z.enum(['fixed-moneyline-total', 'model-choice-side-total']),
    games: z.array(gameForecastsSchema).min(1),
  })
  .strict();

const PROBABILITY_SUM_TOLERANCE = 1e-6;

function isHalfLine(line: number): boolean {
  return !Number.isInteger(line);
}

function checkGame(
  game: BenchmarkResponse['games'][number],
  bundleGame: GameBundle,
  errors: string[],
): void {
  const id = game.gameId;
  const byMarket = new Map(game.forecasts.map((f) => [f.market, f]));
  if (byMarket.size !== 3) {
    errors.push(`game ${id}: must contain exactly one moneyline, one spread, one total forecast`);
    return;
  }

  const moneyline = byMarket.get('moneyline');
  const spread = byMarket.get('spread');
  const total = byMarket.get('total');
  if (!moneyline || !spread || !total) {
    errors.push(`game ${id}: must contain exactly one moneyline, one spread, one total forecast`);
    return;
  }

  const teams = [bundleGame.awayTeam, bundleGame.homeTeam];

  // moneyline
  if (moneyline.line !== null) errors.push(`game ${id} moneyline: "line" must be null`);
  if (!teams.includes(moneyline.selection)) {
    errors.push(`game ${id} moneyline: selection must be exactly "${bundleGame.awayTeam}" or "${bundleGame.homeTeam}"`);
  } else {
    const expected =
      moneyline.selection === bundleGame.awayTeam
        ? bundleGame.markets.moneyline.awayDecimal
        : bundleGame.markets.moneyline.homeDecimal;
    if (moneyline.observedDecimal !== expected) {
      errors.push(`game ${id} moneyline: observedDecimal must equal the bundle price ${expected} for the selected side`);
    }
  }
  if (moneyline.probabilities.push !== 0) {
    errors.push(`game ${id} moneyline: push probability must be 0`);
  }

  // spread (designated run line)
  if (spread.line !== bundleGame.markets.runLine.line) {
    errors.push(`game ${id} spread: line must echo the designated run line ${bundleGame.markets.runLine.line}`);
  }
  if (!teams.includes(spread.selection)) {
    errors.push(`game ${id} spread: selection must be exactly "${bundleGame.awayTeam}" or "${bundleGame.homeTeam}"`);
  } else {
    const expected =
      spread.selection === bundleGame.awayTeam
        ? bundleGame.markets.runLine.awayDecimal
        : bundleGame.markets.runLine.homeDecimal;
    if (spread.observedDecimal !== expected) {
      errors.push(`game ${id} spread: observedDecimal must equal the bundle price ${expected} for the selected side`);
    }
  }
  if (isHalfLine(bundleGame.markets.runLine.line) && spread.probabilities.push !== 0) {
    errors.push(`game ${id} spread: push probability must be 0 on a half-run line`);
  }

  // total
  if (total.line !== bundleGame.markets.total.line) {
    errors.push(`game ${id} total: line must echo the designated total ${bundleGame.markets.total.line}`);
  }
  if (total.selection !== 'over' && total.selection !== 'under') {
    errors.push(`game ${id} total: selection must be exactly "over" or "under"`);
  } else {
    const expected =
      total.selection === 'over'
        ? bundleGame.markets.total.overDecimal
        : bundleGame.markets.total.underDecimal;
    if (total.observedDecimal !== expected) {
      errors.push(`game ${id} total: observedDecimal must equal the bundle price ${expected} for the selected side`);
    }
  }
  if (isHalfLine(bundleGame.markets.total.line) && total.probabilities.push !== 0) {
    errors.push(`game ${id} total: push probability must be 0 on a half-point total`);
  }

  // shared per-forecast checks
  const validRefs = new Set(bundleGame.evidenceRefs);
  for (const forecast of game.forecasts) {
    const { win, push, loss } = forecast.probabilities;
    if (Math.abs(win + push + loss - 1) > PROBABILITY_SUM_TOLERANCE) {
      errors.push(`game ${id} ${forecast.market}: probabilities must sum to 1`);
    }
    for (const ref of forecast.evidenceRefs) {
      if (!validRefs.has(ref)) {
        errors.push(`game ${id} ${forecast.market}: unknown evidenceRef "${ref}"`);
      }
    }
  }

  // execution policy: fixed moneyline+total
  if (!moneyline.selectedForExecution || !total.selectedForExecution || spread.selectedForExecution) {
    errors.push(
      `game ${id}: under fixed-moneyline-total, selectedForExecution must be true on moneyline and total and false on spread`,
    );
  }
}

export interface ValidationResult {
  parsed: BenchmarkResponse | null;
  errors: string[];
}

export function validateResponseText(
  rawText: string,
  bundle: SlateBundle,
  bundleSha256: string,
  arm: ArmSpec,
  cohortId: string,
): ValidationResult {
  const extracted = extractJson(rawText);
  if (extracted === null) {
    return { parsed: null, errors: ['response is not parseable JSON'] };
  }

  const shape = benchmarkResponseSchema.safeParse(extracted);
  if (!shape.success) {
    const errors = shape.error.issues
      .slice(0, 20)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return { parsed: null, errors };
  }

  const parsed = shape.data;
  const errors: string[] = [];

  if (parsed.cohortId !== cohortId) errors.push(`cohortId must echo "${cohortId}"`);
  if (parsed.participantId !== arm.participantId) {
    errors.push(`participantId must echo "${arm.participantId}"`);
  }
  if (parsed.requestedModelId !== arm.requestedModelId) {
    errors.push(`requestedModelId must echo "${arm.requestedModelId}"`);
  }
  if (parsed.bundleSha256 !== bundleSha256) {
    errors.push('bundleSha256 must echo the supplied bundle hash');
  }
  if (parsed.executionPolicy !== 'fixed-moneyline-total') {
    errors.push('executionPolicy must echo "fixed-moneyline-total"');
  }

  const bundleGames = new Map(bundle.games.map((g) => [g.gameId, g]));
  const seen = new Set<string>();
  for (const game of parsed.games) {
    if (seen.has(game.gameId)) {
      errors.push(`duplicate game ${game.gameId}`);
      continue;
    }
    seen.add(game.gameId);
    const bundleGame = bundleGames.get(game.gameId);
    if (!bundleGame) {
      errors.push(`unknown game ${game.gameId} (not in the bundle)`);
      continue;
    }
    checkGame(game, bundleGame, errors);
  }
  for (const gameId of bundleGames.keys()) {
    if (!seen.has(gameId)) errors.push(`missing game ${gameId}`);
  }

  return errors.length === 0 ? { parsed, errors: [] } : { parsed, errors };
}

/**
 * Deterministic JSON extraction: direct parse, then a fenced ```json block,
 * then the outermost brace slice. Anything beyond this is the model's schema
 * failure, not the harness's job to guess at.
 */
export function extractJson(rawText: string): unknown | null {
  const attempts: string[] = [rawText.trim()];
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1] !== undefined) attempts.push(fenced[1].trim());
  const first = rawText.indexOf('{');
  const last = rawText.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(rawText.slice(first, last + 1));
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as unknown;
    } catch {
      // try the next extraction strategy
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Decision fingerprints — repair-preservation proof
// ---------------------------------------------------------------------------

/**
 * Every decision-bearing field of one forecast. A format repair is acceptable
 * ONLY when the initial response yields a complete fingerprint and the
 * accepted repair's fingerprint is identical — otherwise decision
 * preservation cannot be proved and the result stays invalid.
 */
export interface ForecastFingerprint {
  selection: string;
  line: number | null;
  observedDecimal: number;
  win: number;
  push: number;
  loss: number;
  confidence: number;
  wouldAbstain: boolean;
  selectedForExecution: boolean;
}

export type DecisionFingerprint = Map<string, ForecastFingerprint>;

function forecastFingerprint(forecast: ForecastOutput): ForecastFingerprint {
  return {
    selection: forecast.selection,
    line: forecast.line,
    observedDecimal: forecast.observedDecimal,
    win: forecast.probabilities.win,
    push: forecast.probabilities.push,
    loss: forecast.probabilities.loss,
    confidence: forecast.confidence,
    wouldAbstain: forecast.wouldAbstain,
    selectedForExecution: forecast.selectedForExecution,
  };
}

const REQUIRED_MARKETS: MarketKey[] = ['moneyline', 'spread', 'total'];

/**
 * A complete, unambiguous decision fingerprint of a raw response against the
 * request bundle: the response must be parseable, shape-valid, and contain
 * EXACTLY the bundle's games with exactly one forecast per market. Returns
 * null otherwise — in which case no repair can prove decision preservation.
 */
export function extractDecisionFingerprint(
  rawText: string,
  bundle: SlateBundle,
): DecisionFingerprint | null {
  const extracted = extractJson(rawText);
  if (extracted === null) return null;
  const shape = benchmarkResponseSchema.safeParse(extracted);
  if (!shape.success) return null;

  const bundleIds = new Set(bundle.games.map((g) => g.gameId));
  const fingerprint: DecisionFingerprint = new Map();
  const seenGames = new Set<string>();
  for (const game of shape.data.games) {
    if (!bundleIds.has(game.gameId) || seenGames.has(game.gameId)) return null;
    seenGames.add(game.gameId);
    const markets = new Set<MarketKey>();
    for (const forecast of game.forecasts) {
      if (markets.has(forecast.market)) return null;
      markets.add(forecast.market);
      fingerprint.set(`${game.gameId}:${forecast.market}`, forecastFingerprint(forecast));
    }
    if (REQUIRED_MARKETS.some((m) => !markets.has(m))) return null;
  }
  if (seenGames.size !== bundleIds.size) return null;
  return fingerprint;
}

export function fingerprintFromParsed(parsed: BenchmarkResponse): DecisionFingerprint {
  const fingerprint: DecisionFingerprint = new Map();
  for (const game of parsed.games) {
    for (const forecast of game.forecasts) {
      fingerprint.set(`${game.gameId}:${forecast.market}`, forecastFingerprint(forecast));
    }
  }
  return fingerprint;
}

/**
 * Exact comparison of two fingerprints: identical key sets, identical values
 * for every decision-bearing field. Added or missing games/forecasts count
 * as changed decisions.
 */
export function compareFingerprints(
  before: DecisionFingerprint,
  after: DecisionFingerprint,
): string[] {
  const diffs: string[] = [];
  for (const key of before.keys()) {
    if (!after.has(key)) diffs.push(`changed_decision_after_repair: ${key} missing after repair`);
  }
  for (const key of after.keys()) {
    if (!before.has(key)) diffs.push(`changed_decision_after_repair: ${key} added by repair`);
  }
  for (const [key, a] of before) {
    const b = after.get(key);
    if (!b) continue;
    const fields: Array<keyof ForecastFingerprint> = [
      'selection',
      'line',
      'observedDecimal',
      'win',
      'push',
      'loss',
      'confidence',
      'wouldAbstain',
      'selectedForExecution',
    ];
    for (const field of fields) {
      if (a[field] !== b[field]) {
        diffs.push(`changed_decision_after_repair: ${key} ${field} changed`);
      }
    }
  }
  return diffs;
}
