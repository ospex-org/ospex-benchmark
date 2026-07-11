import { z } from 'zod';
import type { ArmSpec, BenchmarkResponse, GameBundle, SlateBundle } from './types.js';

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
    rationale: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
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

/**
 * A format repair may not change decisions. Where both attempts parsed,
 * compare the decision-bearing fields and reject changes.
 */
export function detectChangedDecisions(
  before: BenchmarkResponse,
  after: BenchmarkResponse,
): string[] {
  const changes: string[] = [];
  const beforeMap = new Map(
    before.games.flatMap((g) => g.forecasts.map((f) => [`${g.gameId}:${f.market}`, f] as const)),
  );
  for (const game of after.games) {
    for (const forecast of game.forecasts) {
      const prior = beforeMap.get(`${game.gameId}:${forecast.market}`);
      if (!prior) continue;
      if (
        prior.selection !== forecast.selection ||
        prior.selectedForExecution !== forecast.selectedForExecution ||
        prior.wouldAbstain !== forecast.wouldAbstain
      ) {
        changes.push(`changed_decision_after_repair: ${game.gameId} ${forecast.market}`);
      }
    }
  }
  return changes;
}
