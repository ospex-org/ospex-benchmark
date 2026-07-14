import { z } from 'zod';
import { RETROSHEET_ATTRIBUTION } from './retrosheet.js';

/**
 * Totals dispersion fit — pure math, no I/O.
 *
 * The totals ladder (TOTALS_V1) models the final combined run total T of an
 * MLB game as negative binomial with mean mu and dispersion k:
 *
 *   Var(T | mu) = mu + mu^2 / k        (k -> infinity recovers Poisson)
 *
 * The ladder solves mu per game from the closing quote; k is the single
 * fitted scalar this module produces. TOTALS_V1_PROVISIONAL fits k by moment
 * decomposition on historical finals plus our own captured closing totals:
 *
 *   Var(T) = Var(mu) + E[Var(T | mu)]              (law of total variance)
 *   E[Var(T | mu)] = mean(mu) + E[mu^2] / k
 *                  = mean(mu) + (mean(mu)^2 + Var(mu)) / k
 *
 * With the marginal moments of T estimated from Retrosheet finals and Var(mu)
 * estimated by the sample variance of our captured closing total lines
 * (the market's per-game mean estimate), solving for k gives
 *
 *   k = (mean^2 + Var(lines)) / (Var(T) - Var(lines) - mean)
 *
 * evaluated at mean = the Retrosheet marginal mean. The E[mu^2] term keeps
 * the Jensen correction (E[mu^2] > mean^2) rather than dropping it.
 *
 * Fail-closed: inputs below the minimum sample sizes, a decomposition that
 * comes out at or under the Poisson floor, or fitted push anchors outside
 * the gross-error band all throw DispersionFitError — the fit refuses to
 * publish a parameter rather than publish a wrong one.
 */

export const TOTALS_DISPERSION_PARAMETER_VERSION = 'TOTALS_V1_PROVISIONAL';

export class DispersionFitError extends Error {}

/**
 * Push-rate anchor: the integer lines MLB closing totals concentrate on.
 * For each, the fitted model's P(T = line) with the mean AT the line is
 * checked against the band below — the market lore figure is "roughly
 * 8–10%", and the band is deliberately wider: it exists to catch a grossly
 * wrong dispersion (which moves these probabilities far), not to localize
 * inside the lore band.
 */
export const PUSH_ANCHOR_LINES: readonly number[] = [7, 8, 9, 10];
export const PUSH_ANCHOR_BAND: readonly [number, number] = [0.06, 0.12];

/** Minimum finals for a marginal-moment fit (three seasons is ~7.3k). */
export const MIN_TOTALS_SAMPLE = 5000;
/** Minimum captured closing lines for the spread estimate. */
export const MIN_CLOSE_SAMPLE = 500;

/**
 * Negative binomial pmf via the exact multiplicative recursion
 *   P(0) = (k/(k+mu))^k,  P(t+1) = P(t) * ((t+k)/(t+1)) * (mu/(k+mu))
 * — no gamma-function evaluation, numerically stable for the t <= ~30 range
 * MLB totals live in.
 */
export function nbPmf(t: number, mu: number, k: number): number {
  if (!Number.isInteger(t) || t < 0) {
    throw new DispersionFitError(`nbPmf: t must be a non-negative integer, got ${t}`);
  }
  if (!Number.isFinite(mu) || !(mu > 0) || !Number.isFinite(k) || !(k > 0)) {
    throw new DispersionFitError(`nbPmf: mu and k must be finite and positive, got mu=${mu} k=${k}`);
  }
  let p = Math.pow(k / (k + mu), k);
  const ratio = mu / (k + mu);
  for (let i = 0; i < t; i += 1) {
    p *= ((i + k) / (i + 1)) * ratio;
  }
  return p;
}

export interface SampleMoments {
  n: number;
  mean: number;
  /** Unbiased sample variance (n - 1 denominator). */
  variance: number;
}

export function sampleMoments(values: readonly number[]): SampleMoments {
  const n = values.length;
  if (n < 2) throw new DispersionFitError(`need at least 2 values for moments, got ${n}`);
  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / n;
  let squares = 0;
  for (const value of values) squares += (value - mean) * (value - mean);
  return { n, mean, variance: squares / (n - 1) };
}

export interface MomentFitInputs {
  /** Final combined totals (settlement basis) — non-negative integers. */
  totals: readonly number[];
  /** Captured closing total lines — finite positives (halves and integers). */
  closeLines: readonly number[];
}

export interface PushAnchor {
  line: number;
  /** P(T = line) under the fitted model with mu = line. */
  pushProbability: number;
}

export interface MomentFitResult {
  n: number;
  marginalMean: number;
  marginalVariance: number;
  closeN: number;
  closeLineMean: number;
  closeLineVariance: number;
  /** E[Var(T | mu)] = marginalVariance - closeLineVariance. */
  conditionalVariance: number;
  k: number;
  pushAnchors: PushAnchor[];
}

export function fitTotalsDispersionMoments(inputs: MomentFitInputs): MomentFitResult {
  const { totals, closeLines } = inputs;
  if (totals.length < MIN_TOTALS_SAMPLE) {
    throw new DispersionFitError(
      `refusing to fit on ${totals.length} finals (minimum ${MIN_TOTALS_SAMPLE})`,
    );
  }
  if (closeLines.length < MIN_CLOSE_SAMPLE) {
    throw new DispersionFitError(
      `refusing to fit on ${closeLines.length} closing lines (minimum ${MIN_CLOSE_SAMPLE})`,
    );
  }
  for (const total of totals) {
    if (!Number.isInteger(total) || total < 0) {
      throw new DispersionFitError(`totals must be non-negative integers, got ${total}`);
    }
  }
  for (const line of closeLines) {
    if (!Number.isFinite(line) || !(line > 0)) {
      throw new DispersionFitError(`closing lines must be finite positives, got ${line}`);
    }
  }

  const marginal = sampleMoments(totals);
  const close = sampleMoments(closeLines);
  const conditionalVariance = marginal.variance - close.variance;
  const excessVariance = conditionalVariance - marginal.mean;
  if (!(excessVariance > 0)) {
    throw new DispersionFitError(
      `decomposition leaves no overdispersion (conditional variance ${conditionalVariance.toFixed(4)} ` +
        `vs mean ${marginal.mean.toFixed(4)}) — a negative binomial cannot represent this; refusing to fit`,
    );
  }
  const k = (marginal.mean * marginal.mean + close.variance) / excessVariance;

  const pushAnchors = PUSH_ANCHOR_LINES.map((line) => ({
    line,
    pushProbability: nbPmf(line, line, k),
  }));
  const [bandLow, bandHigh] = PUSH_ANCHOR_BAND;
  const outOfBand = pushAnchors.filter(
    (anchor) => anchor.pushProbability < bandLow || anchor.pushProbability > bandHigh,
  );
  if (outOfBand.length > 0) {
    throw new DispersionFitError(
      `push anchor outside [${bandLow}, ${bandHigh}]: ` +
        outOfBand.map((a) => `P(T=${a.line} | mu=${a.line}) = ${a.pushProbability.toFixed(4)}`).join(', ') +
        ' — dispersion looks grossly wrong; refusing to publish',
    );
  }

  return {
    n: marginal.n,
    marginalMean: marginal.mean,
    marginalVariance: marginal.variance,
    closeN: close.n,
    closeLineMean: close.mean,
    closeLineVariance: close.variance,
    conditionalVariance,
    k,
    pushAnchors,
  };
}

export interface PmfCheckRow {
  t: number;
  /** Fraction of finals landing exactly on t. */
  empirical: number;
  /** Model marginal: NB(line + recenteredBy, k) averaged over closing lines. */
  model: number;
}

export interface MarginalPmfCheck {
  /** Shift applied to every closing line so the mixture mean matches the finals mean. */
  recenteredBy: number;
  rows: PmfCheckRow[];
}

/**
 * Published goodness-of-fit evidence (not a gate): the model's implied
 * marginal pmf — the fitted NB mixed over the captured closing-line
 * distribution, recentered so the mixture mean matches the finals sample's
 * mean (isolating SHAPE from the era/window mean gap) — against the
 * empirical pmf of the finals. This is where the model's known smoothness
 * limitation is visible: real MLB totals oscillate by parity (games cannot
 * end tied, depleting even totals into mostly-odd resolutions), which a
 * smooth NB cannot reproduce. Published so nobody has to take that on faith.
 */
export function marginalPmfCheck(
  totals: readonly number[],
  closeLines: readonly number[],
  k: number,
  tMin: number,
  tMax: number,
): MarginalPmfCheck {
  if (!Number.isInteger(tMin) || !Number.isInteger(tMax) || tMin < 0 || tMax < tMin) {
    throw new DispersionFitError(`bad pmf-check range [${tMin}, ${tMax}]`);
  }
  const marginal = sampleMoments(totals);
  const close = sampleMoments(closeLines);
  const recenteredBy = marginal.mean - close.mean;
  const mus = closeLines.map((line) => line + recenteredBy);
  for (const mu of mus) {
    if (!(mu > 0)) {
      throw new DispersionFitError(`recentered closing line is non-positive (${mu})`);
    }
  }
  const counts = new Map<number, number>();
  for (const total of totals) counts.set(total, (counts.get(total) ?? 0) + 1);
  const rows: PmfCheckRow[] = [];
  for (let t = tMin; t <= tMax; t += 1) {
    let modelSum = 0;
    for (const mu of mus) modelSum += nbPmf(t, mu, k);
    rows.push({
      t,
      empirical: (counts.get(t) ?? 0) / marginal.n,
      model: modelSum / mus.length,
    });
  }
  return { recenteredBy, rows };
}

/**
 * The published parameter artifact (data/totals-dispersion-*.json). The
 * schema is the read contract for the TOTALS_V1 ladder; the fit CLI also
 * validates its own output against it before writing, so writer and reader
 * can never drift. The attribution field is literal-pinned: an artifact
 * without the exact Retrosheet notice is invalid.
 */
export const totalsDispersionArtifactSchema = z
  .object({
    parameterVersion: z.literal(TOTALS_DISPERSION_PARAMETER_VERSION),
    sport: z.literal('mlb'),
    market: z.literal('total'),
    distribution: z.literal('negative-binomial'),
    parameterization: z.string().min(1),
    k: z.number().positive(),
    primaryFit: z
      .object({
        basis: z.string().min(1),
        method: z.string().min(1),
        retrosheet: z
          .object({
            dataset: z.string().min(1),
            seasons: z.array(z.number().int()),
            window: z.string().min(1),
            nGames: z.number().int().positive(),
            nForfeitsExcluded: z.number().int().nonnegative(),
            nShortenedExcluded: z.number().int().nonnegative(),
            nExtraInnings: z.number().int().nonnegative(),
            nCompletedLater: z.number().int().nonnegative(),
            marginalMean: z.number(),
            marginalVariance: z.number(),
          })
          .strict(),
        closeSpread: z
          .object({
            dataset: z.string().min(1),
            source: z.string().min(1),
            n: z.number().int().positive(),
            confidence: z.record(z.string(), z.number().int().nonnegative()),
            lockTimeRange: z.tuple([z.string(), z.string()]),
            lineMean: z.number(),
            lineVariance: z.number(),
          })
          .strict(),
        conditionalVariance: z.number(),
      })
      .strict(),
    sensitivity: z
      .object({
        regulationOnly: z
          .object({
            nGames: z.number().int().positive(),
            marginalMean: z.number(),
            marginalVariance: z.number(),
            conditionalVariance: z.number(),
            k: z.number().positive(),
          })
          .strict(),
      })
      .strict(),
    anchors: z
      .object({
        pushProbabilityAtLineEqualMean: z.array(
          z.object({ line: z.number(), pushProbability: z.number() }).strict(),
        ),
        acceptanceBand: z.tuple([z.number(), z.number()]),
        marginalPmfCheck: z
          .object({
            recenteredBy: z.number(),
            rows: z.array(
              z.object({ t: z.number().int(), empirical: z.number(), model: z.number() }).strict(),
            ),
          })
          .strict(),
        inHousePairsObserved: z
          .object({
            n: z.number().int().nonnegative(),
            integerLinePairs: z.number().int().nonnegative(),
            pushes: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    knownApproximations: z.array(z.string().min(1)),
    refitPlan: z.string().min(1),
    attribution: z.literal(RETROSHEET_ATTRIBUTION),
    generatedAt: z.string().min(1),
  })
  .strict();

export type TotalsDispersionArtifact = z.infer<typeof totalsDispersionArtifactSchema>;
