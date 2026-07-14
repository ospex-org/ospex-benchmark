import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CLOSE_SPREAD_SOURCE,
  fitTotalsDispersionMoments,
  KNOWN_APPROXIMATIONS,
  marginalPmfCheck,
  PMF_CHECK_T_MAX,
  PMF_CHECK_T_MIN,
  PRIMARY_FIT_BASIS,
  PRIMARY_FIT_METHOD,
  PUSH_ANCHOR_BAND,
  REFIT_PLAN,
  RETROSHEET_FIT_WINDOW,
  TOTALS_DISPERSION_PARAMETERIZATION,
  totalsDispersionArtifactSchema,
} from './dispersion.js';
import {
  parseInhouseTotalsDataset,
  rederivedConfidence,
  rederivedLockTimeRange,
} from './inhouseTotals.js';
import { classifyOuts, parseRetrosheetDataset } from './retrosheet.js';

/**
 * Committed-artifact integrity: the published TOTALS_V1_PROVISIONAL parameter
 * must be EXACTLY what the committed datasets produce through the production
 * fit path, and every method/provenance field must equal its published
 * constant. Recomputes every numeric from data/ and compares bit-for-bit,
 * re-derives the provenance fields from the records (not the copied meta),
 * and pins the pmf-check table to the full published range — a hand-edited
 * parameter, a reworded method, a trimmed evidence table, a swapped dataset,
 * or a silent formula change all fail here. Only generatedAt and the dataset
 * paths float (the paths are pinned implicitly: the datasets are loaded FROM
 * them). The datasets' own meta cross-checks run as part of loading.
 */

const ARTIFACT_PATH = 'data/totals-dispersion-TOTALS_V1_PROVISIONAL.json';

test('the committed artifact is exactly reproducible from the committed datasets', () => {
  const artifact = totalsDispersionArtifactSchema.parse(
    JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')),
  );
  // The artifact names its own inputs; load them from those declared paths.
  const retrosheet = parseRetrosheetDataset(
    readFileSync(artifact.primaryFit.retrosheet.dataset, 'utf8'),
  );
  const inhouse = parseInhouseTotalsDataset(
    readFileSync(artifact.primaryFit.closeSpread.dataset, 'utf8'),
  );

  // Same selection the fit CLI applies (settlement basis).
  const nonForfeit = retrosheet.games.filter((game) => game.forfeit === null);
  const classified = nonForfeit.map(
    (game) => [classifyOuts(game.outs), game.awayScore + game.homeScore] as const,
  );
  const fullTotals = classified
    .filter(([classification]) => classification !== 'shortened')
    .map(([, total]) => total);
  const regulationTotals = classified
    .filter(([classification]) => classification === 'regulation')
    .map(([, total]) => total);
  const closeLines = inhouse.records.map((record) => record.line);

  const primary = fitTotalsDispersionMoments({ totals: fullTotals, closeLines });
  const regulation = fitTotalsDispersionMoments({ totals: regulationTotals, closeLines });

  // Method/provenance prose: pinned to the published constants.
  assert.equal(artifact.parameterization, TOTALS_DISPERSION_PARAMETERIZATION, 'parameterization');
  assert.equal(artifact.primaryFit.basis, PRIMARY_FIT_BASIS, 'basis');
  assert.equal(artifact.primaryFit.method, PRIMARY_FIT_METHOD, 'method');
  assert.equal(artifact.primaryFit.retrosheet.window, RETROSHEET_FIT_WINDOW, 'window');
  assert.equal(artifact.primaryFit.closeSpread.source, CLOSE_SPREAD_SOURCE, 'source');
  assert.deepEqual(artifact.knownApproximations, [...KNOWN_APPROXIMATIONS], 'knownApproximations');
  assert.equal(artifact.refitPlan, REFIT_PLAN, 'refitPlan');

  // Provenance re-derived from the RECORDS (not the copied meta fields).
  assert.deepEqual(
    artifact.primaryFit.retrosheet.seasons,
    [...new Set(retrosheet.games.map((game) => game.season))].sort((a, b) => a - b),
    'seasons',
  );
  assert.deepEqual(
    artifact.primaryFit.closeSpread.confidence,
    rederivedConfidence(inhouse.records),
    'confidence histogram',
  );
  assert.deepEqual(
    artifact.primaryFit.closeSpread.lockTimeRange,
    rederivedLockTimeRange(inhouse.records),
    'lockTimeRange',
  );

  // Headline parameter and every published moment: exact equality.
  assert.equal(artifact.k, primary.k, 'k');
  assert.equal(artifact.primaryFit.retrosheet.nGames, primary.n, 'nGames');
  assert.equal(artifact.primaryFit.retrosheet.marginalMean, primary.marginalMean, 'marginalMean');
  assert.equal(
    artifact.primaryFit.retrosheet.marginalVariance,
    primary.marginalVariance,
    'marginalVariance',
  );
  assert.equal(
    artifact.primaryFit.retrosheet.nForfeitsExcluded,
    retrosheet.games.length - nonForfeit.length,
    'nForfeitsExcluded',
  );
  assert.equal(
    artifact.primaryFit.retrosheet.nShortenedExcluded,
    classified.length - fullTotals.length,
    'nShortenedExcluded',
  );
  assert.equal(
    artifact.primaryFit.retrosheet.nExtraInnings,
    fullTotals.length - regulationTotals.length,
    'nExtraInnings',
  );
  assert.equal(
    artifact.primaryFit.retrosheet.nCompletedLater,
    nonForfeit.filter((game) => game.completedLater).length,
    'nCompletedLater',
  );
  assert.equal(artifact.primaryFit.closeSpread.n, primary.closeN, 'close n');
  assert.equal(artifact.primaryFit.closeSpread.lineMean, primary.closeLineMean, 'lineMean');
  assert.equal(
    artifact.primaryFit.closeSpread.lineVariance,
    primary.closeLineVariance,
    'lineVariance',
  );
  assert.equal(
    artifact.primaryFit.conditionalVariance,
    primary.conditionalVariance,
    'conditionalVariance',
  );

  // Sensitivity variant.
  assert.equal(artifact.sensitivity.regulationOnly.k, regulation.k, 'regulation k');
  assert.equal(artifact.sensitivity.regulationOnly.nGames, regulation.n, 'regulation n');
  assert.equal(
    artifact.sensitivity.regulationOnly.marginalMean,
    regulation.marginalMean,
    'regulation mean',
  );
  assert.equal(
    artifact.sensitivity.regulationOnly.marginalVariance,
    regulation.marginalVariance,
    'regulation variance',
  );
  assert.equal(
    artifact.sensitivity.regulationOnly.conditionalVariance,
    regulation.conditionalVariance,
    'regulation conditional variance',
  );

  // Anchors and the published goodness-of-fit table.
  assert.deepEqual(
    artifact.anchors.pushProbabilityAtLineEqualMean,
    primary.pushAnchors,
    'push anchors',
  );
  assert.deepEqual(
    artifact.anchors.acceptanceBand,
    [PUSH_ANCHOR_BAND[0], PUSH_ANCHOR_BAND[1]],
    'acceptance band',
  );
  // The misfit-evidence table is recomputed over the PUBLISHED range
  // constants, never a range read back from the artifact under test —
  // trimming awkward rows out of the committed table fails here.
  assert.deepEqual(
    artifact.anchors.marginalPmfCheck,
    marginalPmfCheck(fullTotals, closeLines, primary.k, PMF_CHECK_T_MIN, PMF_CHECK_T_MAX),
    'marginal pmf check',
  );

  // Observational pair counts.
  const pairs = inhouse.records.filter((record) => record.final !== null);
  const integerLinePairs = pairs.filter((record) => Number.isInteger(record.line));
  assert.equal(artifact.anchors.inHousePairsObserved.n, pairs.length, 'pairs n');
  assert.equal(
    artifact.anchors.inHousePairsObserved.integerLinePairs,
    integerLinePairs.length,
    'integer-line pairs',
  );
  assert.equal(
    artifact.anchors.inHousePairsObserved.pushes,
    integerLinePairs.filter((record) => record.final !== null && record.final.total === record.line)
      .length,
    'pushes',
  );
});
