import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DispersionFitError,
  fitTotalsDispersionMoments,
  marginalPmfCheck,
  MIN_CLOSE_SAMPLE,
  MIN_TOTALS_SAMPLE,
  nbPmf,
  PUSH_ANCHOR_BAND,
  PUSH_ANCHOR_LINES,
  sampleMoments,
  totalsDispersionArtifactSchema,
} from './dispersion.js';
import { RETROSHEET_ATTRIBUTION } from './retrosheet.js';
import type { TotalsDispersionArtifact } from './dispersion.js';

function repeat(pattern: readonly number[], times: number): number[] {
  const values: number[] = [];
  for (let i = 0; i < times; i += 1) values.push(...pattern);
  return values;
}

/**
 * Analytic fixture: totals [3,6,9,12,15] x 1200 (n=6000, mean 9, sample
 * variance 108000/5999) against closing lines [8,9,10] x 400 (n=1200, mean 9,
 * sample variance 800/1199). Exact-fraction arithmetic (computed
 * independently) gives k = 587416081/59957591 = 9.797192835849593.
 */
const FIXTURE_TOTALS = repeat([3, 6, 9, 12, 15], 1200);
const FIXTURE_LINES = repeat([8, 9, 10], 400);
const FIXTURE_K = 9.797192835849593;

// ---------------------------------------------------------------------------
// nbPmf
// ---------------------------------------------------------------------------

test('nbPmf matches lgamma-formula goldens (independent formula path)', () => {
  // Reference values computed with the gamma-function form
  // exp(lgamma(t+k) - lgamma(k) - lgamma(t+1) + k*ln(k/(k+mu)) + t*ln(mu/(k+mu)))
  // — a different evaluation path than the multiplicative recursion under test.
  const goldens: Array<[number, number, number, number]> = [
    [0, 8.5, 8.0, 0.00305385450593422],
    [9, 8.5, 8.0, 0.0892666424594241],
    [7, 7.0, 8.101, 0.108615511915678],
    [20, 8.5, 8.0, 0.00469867719932707],
    [3, 2.5, 15.0, 0.196341881400368],
  ];
  for (const [t, mu, k, expected] of goldens) {
    assert.ok(
      Math.abs(nbPmf(t, mu, k) - expected) < 1e-12,
      `nbPmf(${t}, ${mu}, ${k}) = ${nbPmf(t, mu, k)}, expected ${expected}`,
    );
  }
});

test('nbPmf sums to 1 and reproduces the NB mean and variance', () => {
  const mu = 8.5;
  const k = 8.0;
  let sum = 0;
  let mean = 0;
  let secondMoment = 0;
  for (let t = 0; t <= 500; t += 1) {
    const p = nbPmf(t, mu, k);
    sum += p;
    mean += t * p;
    secondMoment += t * t * p;
  }
  assert.ok(Math.abs(sum - 1) < 1e-9, `pmf sums to ${sum}`);
  assert.ok(Math.abs(mean - mu) < 1e-9, `pmf mean ${mean} vs mu ${mu}`);
  const variance = secondMoment - mean * mean;
  const expectedVariance = mu + (mu * mu) / k;
  assert.ok(
    Math.abs(variance - expectedVariance) < 1e-6,
    `pmf variance ${variance} vs mu + mu^2/k = ${expectedVariance}`,
  );
});

test('nbPmf refuses out-of-domain arguments', () => {
  assert.throws(() => nbPmf(-1, 8.5, 8), DispersionFitError);
  assert.throws(() => nbPmf(1.5, 8.5, 8), DispersionFitError);
  assert.throws(() => nbPmf(3, 0, 8), DispersionFitError);
  assert.throws(() => nbPmf(3, 8.5, 0), DispersionFitError);
  assert.throws(() => nbPmf(3, Number.NaN, 8), DispersionFitError);
  assert.throws(() => nbPmf(3, 8.5, Number.POSITIVE_INFINITY), DispersionFitError);
});

// ---------------------------------------------------------------------------
// sampleMoments
// ---------------------------------------------------------------------------

test('sampleMoments: unbiased (n-1) variance on a tiny exact case', () => {
  const moments = sampleMoments([1, 2, 3, 4]);
  assert.equal(moments.n, 4);
  assert.equal(moments.mean, 2.5);
  assert.ok(Math.abs(moments.variance - 5 / 3) < 1e-15, `variance ${moments.variance}`);
});

test('sampleMoments refuses fewer than 2 values', () => {
  assert.throws(() => sampleMoments([7]), DispersionFitError);
});

// ---------------------------------------------------------------------------
// fitTotalsDispersionMoments
// ---------------------------------------------------------------------------

test('golden: the analytic fixture fits k = 9.7971928358…', () => {
  const fit = fitTotalsDispersionMoments({ totals: FIXTURE_TOTALS, closeLines: FIXTURE_LINES });
  assert.ok(Math.abs(fit.k - FIXTURE_K) < 1e-9, `k = ${fit.k}, expected ${FIXTURE_K}`);
  assert.equal(fit.n, 6000);
  assert.equal(fit.closeN, 1200);
  assert.equal(fit.marginalMean, 9);
  assert.ok(Math.abs(fit.marginalVariance - 108000 / 5999) < 1e-12, 'marginal variance');
  assert.ok(Math.abs(fit.closeLineVariance - 800 / 1199) < 1e-12, 'close-line variance');
  assert.ok(
    Math.abs(fit.conditionalVariance - (108000 / 5999 - 800 / 1199)) < 1e-12,
    'conditional variance',
  );
  // The Jensen term is load-bearing: dropping Var(lines) from the numerator
  // would give a k about 0.8% smaller — pin the distinction.
  const withoutJensen = (81) / (108000 / 5999 - 800 / 1199 - 9);
  assert.ok(Math.abs(fit.k - withoutJensen) > 1e-3, 'Jensen term must move k');
  assert.deepEqual(
    fit.pushAnchors.map((anchor) => anchor.line),
    [...PUSH_ANCHOR_LINES],
  );
  for (const anchor of fit.pushAnchors) {
    assert.ok(
      anchor.pushProbability >= PUSH_ANCHOR_BAND[0] &&
        anchor.pushProbability <= PUSH_ANCHOR_BAND[1],
      `anchor at ${anchor.line} in band`,
    );
  }
});

test('sample-size gates refuse to fit', () => {
  assert.throws(
    () =>
      fitTotalsDispersionMoments({
        totals: FIXTURE_TOTALS.slice(0, MIN_TOTALS_SAMPLE - 1),
        closeLines: FIXTURE_LINES,
      }),
    /minimum 5000/,
  );
  assert.throws(
    () =>
      fitTotalsDispersionMoments({
        totals: FIXTURE_TOTALS,
        closeLines: FIXTURE_LINES.slice(0, MIN_CLOSE_SAMPLE - 1),
      }),
    /minimum 500/,
  );
});

test('malformed inputs refuse to fit', () => {
  assert.throws(
    () =>
      fitTotalsDispersionMoments({
        totals: [...FIXTURE_TOTALS.slice(0, -1), 8.5],
        closeLines: FIXTURE_LINES,
      }),
    /non-negative integers/,
  );
  assert.throws(
    () =>
      fitTotalsDispersionMoments({
        totals: FIXTURE_TOTALS,
        closeLines: [...FIXTURE_LINES.slice(0, -1), -8.5],
      }),
    /finite positives/,
  );
});

test('a decomposition without overdispersion refuses to fit', () => {
  // Totals variance (~0.667) below the mean (9): NB cannot represent it.
  assert.throws(
    () =>
      fitTotalsDispersionMoments({
        totals: repeat([8, 9, 10], 2000),
        closeLines: FIXTURE_LINES,
      }),
    /no overdispersion/,
  );
});

test('push anchors outside the gross-error band refuse to publish', () => {
  // Totals [0,0,27]: mean 9 but enormous variance -> k ~ 0.54, anchors ~2-3%.
  assert.throws(
    () =>
      fitTotalsDispersionMoments({
        totals: repeat([0, 0, 27], 2000),
        closeLines: FIXTURE_LINES,
      }),
    /push anchor outside/,
  );
});

// ---------------------------------------------------------------------------
// marginalPmfCheck
// ---------------------------------------------------------------------------

test('marginalPmfCheck: empirical fractions and a mean-matched model mixture', () => {
  const check = marginalPmfCheck(FIXTURE_TOTALS, FIXTURE_LINES, FIXTURE_K, 4, 14);
  assert.equal(check.recenteredBy, 0);
  const t9 = check.rows.find((row) => row.t === 9);
  assert.ok(t9 !== undefined, 'row for t=9 exists');
  assert.ok(Math.abs(t9.empirical - 0.2) < 1e-15, `empirical(9) = ${t9.empirical}`);
  assert.ok(t9.model > 0 && t9.model < 1, 'model probability sane');
});

test('marginalPmfCheck: recentering matches the mixture mean to the finals mean', () => {
  // Lines mean 8 vs totals mean 9 -> recenteredBy 1; the model mixture must
  // then have mean 9 (each NB component has mean line + 1).
  const lines = repeat([7, 8, 9], 400);
  const check = marginalPmfCheck(FIXTURE_TOTALS, lines, FIXTURE_K, 0, 300);
  assert.ok(Math.abs(check.recenteredBy - 1) < 1e-12, `recenteredBy = ${check.recenteredBy}`);
  let mixtureMean = 0;
  for (const row of check.rows) mixtureMean += row.t * row.model;
  assert.ok(Math.abs(mixtureMean - 9) < 1e-6, `mixture mean = ${mixtureMean}`);
});

test('marginalPmfCheck refuses bad ranges and non-positive recentered lines', () => {
  assert.throws(() => marginalPmfCheck(FIXTURE_TOTALS, FIXTURE_LINES, FIXTURE_K, 10, 4), /range/);
  // Totals mean far below the lines: recentering drives lines non-positive.
  assert.throws(
    () => marginalPmfCheck(repeat([0, 1], 3000), FIXTURE_LINES, FIXTURE_K, 0, 5),
    /non-positive/,
  );
});

// ---------------------------------------------------------------------------
// artifact schema
// ---------------------------------------------------------------------------

function artifact(): TotalsDispersionArtifact {
  return {
    parameterVersion: 'TOTALS_V1_PROVISIONAL',
    sport: 'mlb',
    market: 'total',
    distribution: 'negative-binomial',
    parameterization: 'negative binomial with mean mu and dispersion k',
    k: 8.1,
    primaryFit: {
      basis: 'settlement',
      method: 'moment decomposition',
      retrosheet: {
        dataset: 'data/retrosheet-mlb-totals-2023-2025.ndjson',
        seasons: [2023, 2024, 2025],
        window: 'MLB regular seasons 2023-2025',
        nGames: 7277,
        nForfeitsExcluded: 0,
        nShortenedExcluded: 12,
        nExtraInnings: 626,
        nCompletedLater: 13,
        marginalMean: 8.97,
        marginalVariance: 20.27,
      },
      closeSpread: {
        dataset: 'data/inhouse-totals-2026-07-14.ndjson',
        source: 'closing_lines capture',
        n: 927,
        confidence: { fresh: 917, stale: 10 },
        lockTimeRange: ['2026-05-05T23:40:00+00:00', '2026-07-12T20:10:00+00:00'],
        lineMean: 8.55,
        lineVariance: 1.2,
      },
      conditionalVariance: 19.07,
    },
    sensitivity: {
      regulationOnly: {
        nGames: 6651,
        marginalMean: 8.93,
        marginalVariance: 20.27,
        conditionalVariance: 19.07,
        k: 8.1,
      },
    },
    anchors: {
      pushProbabilityAtLineEqualMean: [{ line: 7, pushProbability: 0.11 }],
      acceptanceBand: [0.06, 0.12],
      marginalPmfCheck: { recenteredBy: 0.42, rows: [{ t: 9, empirical: 0.1, model: 0.09 }] },
      inHousePairsObserved: { n: 45, integerLinePairs: 20, pushes: 1 },
    },
    knownApproximations: ['closing line used as the market mean'],
    refitPlan: 'TOTALS_V1 MLE refit',
    attribution: RETROSHEET_ATTRIBUTION,
    generatedAt: '2026-07-14T00:00:00.000Z',
  };
}

test('artifact schema: a well-formed artifact validates', () => {
  const value = artifact();
  assert.deepEqual(totalsDispersionArtifactSchema.parse(value), value);
});

test('artifact schema: the exact attribution notice is literal-pinned', () => {
  const value = { ...artifact(), attribution: 'obtained from Retrosheet' };
  assert.throws(() => totalsDispersionArtifactSchema.parse(value), /invalid/i);
});

test('artifact schema: unknown fields are rejected (strict contract)', () => {
  const value = { ...artifact(), extra: true };
  assert.throws(() => totalsDispersionArtifactSchema.parse(value), /unrecognized/i);
});
