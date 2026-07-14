import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LADDER_VERSION,
  LadderError,
  ladderLineInDomain,
  loadLadderParams,
  MAX_LADDER_LINE,
  MU_MAX,
  MU_MIN,
  scoreTotalsLadder,
  solveCloseImpliedMean,
  tailProbabilities,
} from './ladder.js';
import type { CloseQuote } from './clv.js';

/**
 * Golden values computed INDEPENDENTLY (lgamma-form NB pmf + bisection to
 * 1e-13 in a separate implementation) at the committed dispersion parameter.
 */
const K = 8.101061957791782;
// G1: half-line close 8.5 with de-vigged over 0.52.
const MU_G1 = 9.263520765718;
// G2: integer close 9 with de-vigged (conditional) over 0.5.
const MU_G2 = 9.551675689313;
// G3: half-line close 10.5 with de-vigged over 0.45.
const MU_G3 = 10.486281324642;

function close(overrides: Partial<CloseQuote> = {}): CloseQuote {
  return {
    line: 8.5,
    awayDecimal: null,
    homeDecimal: null,
    awayPNovig: 0.52,
    homePNovig: 0.48,
    confidence: 'fresh',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// tailProbabilities
// ---------------------------------------------------------------------------

test('tail probabilities match the independent goldens at the solved means', () => {
  const tol = 1e-8;
  const g1AtClose = tailProbabilities(MU_G1, K, 8.5);
  assert.ok(Math.abs(g1AtClose.above - 0.52) < tol, `above(8.5) = ${g1AtClose.above}`);
  assert.equal(g1AtClose.at, 0, 'half-lines cannot push');
  const g1At8 = tailProbabilities(MU_G1, K, 8);
  assert.ok(Math.abs(g1At8.above - 0.52) < tol, 'P(T>8) = P(T>8.5) for integer T');
  assert.ok(Math.abs(g1At8.at - 0.094337664563) < tol, `at(8) = ${g1At8.at}`);
  assert.ok(Math.abs(g1At8.below - 0.385662335437) < tol, `below(8) = ${g1At8.below}`);
  const g1At9 = tailProbabilities(MU_G1, K, 9);
  assert.ok(Math.abs(g1At9.above - 0.429965520086) < tol, `above(9) = ${g1At9.above}`);
  assert.ok(Math.abs(g1At9.at - 0.090034479914) < tol, `at(9) = ${g1At9.at}`);
  const g3At95 = tailProbabilities(MU_G3, K, 9.5);
  assert.ok(Math.abs(g3At95.above - 0.532805238386) < tol, `above(9.5) = ${g3At95.above}`);
});

test('win/push/loss always sums to 1', () => {
  for (const line of [6.5, 7, 8.5, 9, 12]) {
    const { above, at, below } = tailProbabilities(9.1, K, line);
    assert.ok(Math.abs(above + at + below - 1) < 1e-12, `sums at line ${line}`);
  }
});

test('tailProbabilities refuses non-half-step lines', () => {
  assert.throws(() => tailProbabilities(9, K, 8.3), LadderError);
  assert.throws(() => tailProbabilities(9, K, -0.5), LadderError);
});

// ---------------------------------------------------------------------------
// solveCloseImpliedMean
// ---------------------------------------------------------------------------

test('solves the close-implied mean to the independent goldens', () => {
  assert.ok(Math.abs(solveCloseImpliedMean(8.5, 0.52, K) - MU_G1) < 1e-7, 'G1');
  assert.ok(Math.abs(solveCloseImpliedMean(9, 0.5, K) - MU_G2) < 1e-7, 'G2');
  assert.ok(Math.abs(solveCloseImpliedMean(10.5, 0.45, K) - MU_G3) < 1e-7, 'G3');
});

test('integer-line solve is push-conditioned: the conditional round-trips exactly', () => {
  const mu = solveCloseImpliedMean(9, 0.5, K);
  const { above, at } = tailProbabilities(mu, K, 9);
  assert.ok(Math.abs(above / (1 - at) - 0.5) < 1e-9, 'P(T>9)/(1-P(T=9)) = q_over');
  // The UNCONDITIONAL above is strictly below the conditional target — the
  // conditioning is load-bearing, not cosmetic.
  assert.ok(Math.abs(above - 0.455241374337) < 1e-8, `unconditional above = ${above}`);
});

test('half-line solve round-trips the outright probability', () => {
  const mu = solveCloseImpliedMean(8.5, 0.52, K);
  assert.ok(Math.abs(tailProbabilities(mu, K, 8.5).above - 0.52) < 1e-9, 'round trip');
});

test('solver refuses out-of-domain targets instead of clamping', () => {
  assert.throws(() => solveCloseImpliedMean(8.5, 0, K), LadderError);
  assert.throws(() => solveCloseImpliedMean(8.5, 1, K), LadderError);
  assert.throws(() => solveCloseImpliedMean(8.5, Number.NaN, K), LadderError);
  assert.throws(() => solveCloseImpliedMean(8.3, 0.5, K), LadderError);
  assert.throws(() => solveCloseImpliedMean(8.5, 0.5, 0), LadderError);
  // A target below f(MU_MIN): the implied mean would sit under the bound —
  // refused (f(0.5) at line 6.5 is ~5.7e-6, so 1e-7 is unreachable).
  assert.throws(() => solveCloseImpliedMean(6.5, 1e-7, K), /refusing to extrapolate/);
  assert.ok(MU_MIN === 0.5 && MU_MAX === 40, 'bounds pinned with the goldens');
});

// ---------------------------------------------------------------------------
// scoreTotalsLadder
// ---------------------------------------------------------------------------

const PARAMS = { k: K, parameterVersion: 'TOTALS_V1_PROVISIONAL' };

test('same-line half-line ladder reduces exactly to the exact-line metrics', () => {
  const result = scoreTotalsLadder({
    league: 'mlb',
    selection: 'over',
    entryDecimal: 1.95,
    entryOppositeDecimal: 1.95,
    entryLine: 8.5,
    close: close(),
    gateReason: null,
    params: PARAMS,
  });
  assert.equal(result.unscoredReason, null);
  assert.equal(result.ladderVersion, LADDER_VERSION);
  assert.equal(result.parameterVersion, 'TOTALS_V1_PROVISIONAL');
  assert.equal(result.qPushEntry, 0);
  // Economic: 100 * (0.52 * 1.95 - 1) = 1.4; margin-adjusted with the
  // even entry quote (q_entry = 0.5): 100 * (0.52/0.5 - 1) = 4.
  assert.equal(result.economicClvPct, 1.4);
  assert.equal(result.marginAdjustedClvPct, 4);
  assert.equal(result.qWinEntry, 0.52);
  assert.ok(Math.abs((result.closeImpliedMean ?? 0) - MU_G1) < 1e-3, 'mean recorded');
});

test('moved line: the ladder prices the ENTRY line from the close (over golden)', () => {
  // Entry over 8 at 1.95, close 8.5 @ 0.52 (golden G5): q_W = P(T>8) = 0.52,
  // q_P = P(T=8) = 0.0943376..., econ = 100*(0.52*1.95 + 0.0943377 - 1).
  const result = scoreTotalsLadder({
    league: 'mlb',
    selection: 'over',
    entryDecimal: 1.95,
    entryOppositeDecimal: 1.95,
    entryLine: 8,
    close: close(),
    gateReason: 'line_moved',
    params: PARAMS,
  });
  assert.equal(result.unscoredReason, null);
  assert.equal(result.economicClvPct, 10.8338);
  assert.equal(result.qWinEntry, 0.52);
  assert.equal(result.qPushEntry, 0.0943);
  // Margin-adjusted: 100 * (0.52/0.5 + 0.0943377 - 1) = 13.4338.
  assert.equal(result.marginAdjustedClvPct, 13.4338);
});

test('moved line: under direction uses the below-mass at the entry line', () => {
  // Entry under 9 vs close 8.5 @ 0.52: q_W = P(T<9) = 0.48, q_P = P(T=9).
  const result = scoreTotalsLadder({
    league: 'mlb',
    selection: 'under',
    entryDecimal: 2.0,
    entryOppositeDecimal: 2.0,
    entryLine: 9,
    close: close(),
    gateReason: 'line_moved',
    params: PARAMS,
  });
  assert.equal(result.unscoredReason, null);
  assert.equal(result.qWinEntry, 0.48);
  assert.equal(result.qPushEntry, 0.09);
  // econ = 100 * (0.48*2 + 0.090034479914 - 1) = 5.0034.
  assert.equal(result.economicClvPct, 5.0034);
});

test('integer same-line ladder equals the conditional CLV shrunk by the push mass', () => {
  // Close 9 @ conditional 0.5 (G2), entry under 9 at 1.9: conditional CLV is
  // 100*(1.9*0.5 - 1) = -5; the generalized value is -5 * (1 - q_P).
  const result = scoreTotalsLadder({
    league: 'mlb',
    selection: 'under',
    entryDecimal: 1.9,
    entryOppositeDecimal: 1.9,
    entryLine: 9,
    close: close({ line: 9, awayPNovig: 0.5, homePNovig: 0.5 }),
    gateReason: 'push_capable_line',
    params: PARAMS,
  });
  assert.equal(result.unscoredReason, null);
  const expected =
    Math.round(100 * (0.455241374337 * 1.9 + 0.089517251326 - 1) * 1e4) / 1e4;
  assert.equal(result.economicClvPct, expected);
  assert.ok(
    Math.abs((result.economicClvPct ?? 0) - -5 * (1 - 0.089517251326)) < 1e-3,
    'shrinkage identity',
  );
});

test('shared availability gates are honored verbatim, with version stamps riding along', () => {
  for (const reason of [
    'close_missing',
    'close_not_captured',
    'close_stale',
    'close_inconsistent',
  ] as const) {
    const result = scoreTotalsLadder({
      league: 'mlb',
      selection: 'over',
      entryDecimal: 1.95,
      entryOppositeDecimal: 1.95,
      entryLine: 8.5,
      close: reason === 'close_missing' ? null : close(),
      gateReason: reason,
      params: PARAMS,
    });
    assert.equal(result.unscoredReason, reason, reason);
    assert.equal(result.economicClvPct, null, reason);
    assert.equal(result.ladderVersion, LADDER_VERSION, reason);
    assert.equal(result.parameterVersion, 'TOTALS_V1_PROVISIONAL', reason);
  }
});

test('an unsolvable close is a typed refusal, never a number', () => {
  const result = scoreTotalsLadder({
    league: 'mlb',
    selection: 'over',
    entryDecimal: 1.95,
    entryOppositeDecimal: 1.95,
    entryLine: 8.5,
    close: close({ line: 6.5, awayPNovig: 1e-7, homePNovig: 1 - 1e-7 }),
    gateReason: null,
    params: PARAMS,
  });
  assert.equal(result.unscoredReason, 'ladder_unsolvable');
  assert.equal(result.economicClvPct, null);
});

test('a missing entry de-vig disables only the margin-adjusted ladder value', () => {
  const result = scoreTotalsLadder({
    league: 'mlb',
    selection: 'over',
    entryDecimal: 1.95,
    entryOppositeDecimal: null,
    entryLine: 8.5,
    close: close(),
    gateReason: null,
    params: PARAMS,
  });
  assert.equal(result.economicClvPct, 1.4);
  assert.equal(result.marginAdjustedClvPct, null);
});

// ---------------------------------------------------------------------------
// method domain — runtime-bound, fast typed refusals
// ---------------------------------------------------------------------------

test('integer same-line picks stay conditional-only: the ladder value is sensitivity output', () => {
  // The candidate method's generalized value at an unchanged integer line
  // exists in the ladder block (see the shrinkage identity above) but is
  // NEVER promoted into the primary columns while validation is pending —
  // that wiring lives in scoreRun, which leaves the exact-line result
  // untouched (asserted end-to-end in scoring.test.ts).
  const result = scoreTotalsLadder({
    league: 'mlb',
    selection: 'under',
    entryDecimal: 1.9,
    entryOppositeDecimal: 1.9,
    entryLine: 9,
    close: close({ line: 9, awayPNovig: 0.5, homePNovig: 0.5 }),
    gateReason: 'push_capable_line',
    params: PARAMS,
  });
  assert.equal(result.unscoredReason, null, 'the sensitivity value itself is computed');
  assert.ok(result.economicClvPct !== null, 'ladder block carries the generalized value');
});

test('a non-MLB league refuses fast with outside_method_domain', () => {
  const result = scoreTotalsLadder({
    league: 'nhl',
    selection: 'over',
    entryDecimal: 1.95,
    entryOppositeDecimal: 1.95,
    entryLine: 5.5,
    close: close({ line: 5.5, awayPNovig: 0.52, homePNovig: 0.48 }),
    gateReason: null,
    params: PARAMS,
  });
  assert.equal(result.unscoredReason, 'outside_method_domain');
  assert.equal(result.economicClvPct, null);
  assert.equal(result.ladderVersion, LADDER_VERSION, 'stamps ride along');
});

test('quarter lines are outside the half-step lattice (entry and close alike)', () => {
  const quarterEntry = scoreTotalsLadder({
    league: 'mlb',
    selection: 'over',
    entryDecimal: 1.95,
    entryOppositeDecimal: 1.95,
    entryLine: 8.25,
    close: close(),
    gateReason: 'line_moved',
    params: PARAMS,
  });
  assert.equal(quarterEntry.unscoredReason, 'outside_method_domain');
  const quarterClose = scoreTotalsLadder({
    league: 'mlb',
    selection: 'over',
    entryDecimal: 1.95,
    entryOppositeDecimal: 1.95,
    entryLine: 8.5,
    close: close({ line: 8.25 }),
    gateReason: 'line_moved',
    params: PARAMS,
  });
  assert.equal(quarterClose.unscoredReason, 'outside_method_domain');
});

test('the finite line rail refuses absurd lines FAST instead of grinding', () => {
  const startedAt = Date.now();
  const result = scoreTotalsLadder({
    league: 'mlb',
    selection: 'over',
    entryDecimal: 1.95,
    entryOppositeDecimal: 1.95,
    entryLine: 1_000_000,
    close: close(),
    gateReason: 'line_moved',
    params: PARAMS,
  });
  assert.equal(result.unscoredReason, 'outside_method_domain');
  assert.ok(Date.now() - startedAt < 250, 'refusal is immediate, not a CDF grind');
  // The pure walker enforces the same rail.
  assert.throws(() => tailProbabilities(9, K, MAX_LADDER_LINE + 0.5), /line rail/);
  assert.ok(ladderLineInDomain(MAX_LADDER_LINE), 'rail boundary is inside the domain');
  assert.ok(!ladderLineInDomain(MAX_LADDER_LINE + 0.5), 'past the rail is outside');
  assert.ok(!ladderLineInDomain(0), 'zero is outside');
  assert.ok(!ladderLineInDomain(8.25), 'quarter lines are outside');
});

// ---------------------------------------------------------------------------
// loadLadderParams
// ---------------------------------------------------------------------------

test('the loader reads the committed artifact and pins the parameter identity', () => {
  const params = loadLadderParams();
  assert.equal(params.parameterVersion, 'TOTALS_V1_PROVISIONAL');
  assert.equal(params.k, K, 'the goldens above are computed at the committed k');
});
