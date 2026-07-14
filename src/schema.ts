import { z } from 'zod';
import { bundleMarketKeys } from './markets.js';
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
    // Cardinality is bounded at the shape layer (1..3) and pinned exactly at
    // the semantic layer, where the required market set is derived from the
    // request bundle — a scoped fire asks for a subset. checkGame /
    // extractDecisionFingerprint enforce "exactly the bundle's markets".
    forecasts: z.array(forecastSchema).min(1).max(3),
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

/**
 * Structural walk of the response schema, used to build the prompt's
 * response template FROM the validator itself. The first live run proved
 * that four different labs, given prose alone, each invent their own field
 * names — so prompt/schema alignment must hold by construction, at every
 * nesting depth, not by a hand-maintained name list.
 */
function unwrapSchema(node: z.ZodTypeAny): z.ZodTypeAny {
  let current = node;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
    } else if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
    } else if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodTypeAny;
    } else {
      return current;
    }
  }
}

/**
 * Every LEAF path of a zod schema, recursively — objects descend by key
 * (`a.b`), arrays by element (`a[]`). Shape changes are visible in the path
 * set itself: turning the probabilities object into an array replaces
 * `…probabilities.win/push/loss` with `…probabilities[]`.
 */
export function schemaLeafPaths(schema: z.ZodTypeAny, prefix = ''): string[] {
  const node = unwrapSchema(schema);
  if (node instanceof z.ZodObject) {
    const paths: string[] = [];
    for (const [key, child] of Object.entries(node.shape as Record<string, z.ZodTypeAny>)) {
      paths.push(...schemaLeafPaths(child, prefix === '' ? key : `${prefix}.${key}`));
    }
    return paths;
  }
  if (node instanceof z.ZodArray) {
    return schemaLeafPaths(node.element as z.ZodTypeAny, `${prefix}[]`);
  }
  return [prefix];
}

/**
 * Render the response template text by walking the schema and substituting a
 * placeholder per leaf path. Fails loudly — a schema leaf with no
 * placeholder, or a placeholder naming a nonexistent leaf, throws. Because
 * the scaffold is built through this function at module load, a schema
 * change without a template update breaks every entry point and test.
 */
export function renderResponseTemplate(
  schema: z.ZodTypeAny,
  placeholders: Record<string, string>,
): string {
  const used = new Set<string>();
  const render = (node: z.ZodTypeAny, path: string, indent: string): string => {
    const unwrapped = unwrapSchema(node);
    if (unwrapped instanceof z.ZodObject) {
      const inner = Object.entries(unwrapped.shape as Record<string, z.ZodTypeAny>)
        .map(
          ([key, child]) =>
            `${indent}  "${key}": ${render(child, path === '' ? key : `${path}.${key}`, `${indent}  `)}`,
        )
        .join(',\n');
      return `{\n${inner}\n${indent}}`;
    }
    if (unwrapped instanceof z.ZodArray) {
      return `[\n${indent}  ${render(unwrapped.element as z.ZodTypeAny, `${path}[]`, `${indent}  `)}\n${indent}]`;
    }
    const placeholder = placeholders[path];
    if (placeholder === undefined) {
      throw new Error(
        `response template has no placeholder for schema field "${path}" — the output schema changed without updating the prompt scaffold`,
      );
    }
    used.add(path);
    return placeholder;
  };
  const rendered = render(schema, '', '');
  const extra = Object.keys(placeholders).filter((key) => !used.has(key));
  if (extra.length > 0) {
    throw new Error(
      `response-template placeholders name schema fields that do not exist: ${extra.join(', ')}`,
    );
  }
  return rendered;
}

const PROBABILITY_SUM_TOLERANCE = 1e-6;

function isHalfLine(line: number): boolean {
  return !Number.isInteger(line);
}

/** A market is executed under fixed-moneyline-total iff it is not the spread. */
function isExecutedMarket(market: MarketKey): boolean {
  return market !== 'spread';
}

function checkGame(
  game: BenchmarkResponse['games'][number],
  bundleGame: GameBundle,
  errors: string[],
): void {
  const id = game.gameId;
  // The required market set IS the bundle's own market set — a scoped fire
  // carries a subset, an archived full board carries all three, and both are
  // validated the same way. No hard-coded count.
  const required = bundleMarketKeys(bundleGame);
  const requiredSet = new Set(required);
  const byMarket = new Map(game.forecasts.map((f) => [f.market, f]));
  if (byMarket.size !== game.forecasts.length) {
    errors.push(`game ${id}: duplicate market forecast`);
    return;
  }
  for (const forecast of game.forecasts) {
    if (!requiredSet.has(forecast.market)) {
      errors.push(`game ${id}: forecast for "${forecast.market}" is not a market in the bundle`);
    }
  }
  for (const market of required) {
    if (!byMarket.has(market)) {
      errors.push(`game ${id}: missing "${market}" forecast for a market in the bundle`);
    }
  }

  const teams = [bundleGame.awayTeam, bundleGame.homeTeam];

  const moneyline = byMarket.get('moneyline');
  const mlBlock = bundleGame.markets.moneyline;
  if (moneyline && mlBlock) {
    if (moneyline.line !== null) errors.push(`game ${id} moneyline: "line" must be null`);
    if (!teams.includes(moneyline.selection)) {
      errors.push(`game ${id} moneyline: selection must be exactly "${bundleGame.awayTeam}" or "${bundleGame.homeTeam}"`);
    } else {
      const expected =
        moneyline.selection === bundleGame.awayTeam ? mlBlock.awayDecimal : mlBlock.homeDecimal;
      if (moneyline.observedDecimal !== expected) {
        errors.push(`game ${id} moneyline: observedDecimal must equal the bundle price ${expected} for the selected side`);
      }
    }
    if (moneyline.probabilities.push !== 0) {
      errors.push(`game ${id} moneyline: push probability must be 0`);
    }
  }

  const spread = byMarket.get('spread');
  const rlBlock = bundleGame.markets.runLine;
  if (spread && rlBlock) {
    if (spread.line !== rlBlock.line) {
      errors.push(`game ${id} spread: line must echo the designated run line ${rlBlock.line}`);
    }
    if (!teams.includes(spread.selection)) {
      errors.push(`game ${id} spread: selection must be exactly "${bundleGame.awayTeam}" or "${bundleGame.homeTeam}"`);
    } else {
      const expected =
        spread.selection === bundleGame.awayTeam ? rlBlock.awayDecimal : rlBlock.homeDecimal;
      if (spread.observedDecimal !== expected) {
        errors.push(`game ${id} spread: observedDecimal must equal the bundle price ${expected} for the selected side`);
      }
    }
    if (isHalfLine(rlBlock.line) && spread.probabilities.push !== 0) {
      errors.push(`game ${id} spread: push probability must be 0 on a half-run line`);
    }
  }

  const total = byMarket.get('total');
  const totalBlock = bundleGame.markets.total;
  if (total && totalBlock) {
    if (total.line !== totalBlock.line) {
      errors.push(`game ${id} total: line must echo the designated total ${totalBlock.line}`);
    }
    if (total.selection !== 'over' && total.selection !== 'under') {
      errors.push(`game ${id} total: selection must be exactly "over" or "under"`);
    } else {
      const expected =
        total.selection === 'over' ? totalBlock.overDecimal : totalBlock.underDecimal;
      if (total.observedDecimal !== expected) {
        errors.push(`game ${id} total: observedDecimal must equal the bundle price ${expected} for the selected side`);
      }
    }
    if (isHalfLine(totalBlock.line) && total.probabilities.push !== 0) {
      errors.push(`game ${id} total: push probability must be 0 on a half-point total`);
    }
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
    // Execution policy: every supplied market executes except the spread.
    if (requiredSet.has(forecast.market)) {
      const shouldExecute = isExecutedMarket(forecast.market);
      if (forecast.selectedForExecution !== shouldExecute) {
        errors.push(
          shouldExecute
            ? `game ${id} ${forecast.market}: selectedForExecution must be true under fixed-moneyline-total`
            : `game ${id} ${forecast.market}: selectedForExecution must be false (the run line is not executed)`,
        );
      }
    }
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

/**
 * A complete, unambiguous decision fingerprint of a raw response against the
 * request bundle: the response must be parseable, shape-valid, and contain
 * EXACTLY the bundle's games with exactly one forecast per market the bundle
 * carries — a scoped fire's fingerprint covers its subset. Returns null
 * otherwise — in which case no repair can prove decision preservation.
 */
export function extractDecisionFingerprint(
  rawText: string,
  bundle: SlateBundle,
): DecisionFingerprint | null {
  const extracted = extractJson(rawText);
  if (extracted === null) return null;
  const shape = benchmarkResponseSchema.safeParse(extracted);
  if (!shape.success) return null;

  const requiredByGame = new Map(bundle.games.map((g) => [g.gameId, bundleMarketKeys(g)]));
  const fingerprint: DecisionFingerprint = new Map();
  const seenGames = new Set<string>();
  for (const game of shape.data.games) {
    const required = requiredByGame.get(game.gameId);
    if (required === undefined || seenGames.has(game.gameId)) return null;
    seenGames.add(game.gameId);
    const markets = new Set<MarketKey>();
    for (const forecast of game.forecasts) {
      if (markets.has(forecast.market)) return null;
      markets.add(forecast.market);
      fingerprint.set(`${game.gameId}:${forecast.market}`, forecastFingerprint(forecast));
    }
    // Exactly the bundle's markets: no missing, no extra.
    if (markets.size !== required.length || required.some((m) => !markets.has(m))) return null;
  }
  if (seenGames.size !== requiredByGame.size) return null;
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
