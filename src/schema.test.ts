import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareFingerprints,
  extractDecisionFingerprint,
  fingerprintFromParsed,
  validateResponseText,
} from './schema.js';
import { makeRequest, makeValidResponse, TEST_ARM, TEST_COHORT } from './testFactories.js';
import type { BenchmarkResponse } from './types.js';

function validate(response: BenchmarkResponse, request = makeRequest()) {
  return validateResponseText(
    JSON.stringify(response),
    request.requestBundle,
    request.requestSha256,
    TEST_ARM,
    TEST_COHORT,
  );
}

test('a fully conformant response validates cleanly', () => {
  const request = makeRequest();
  const result = validate(makeValidResponse(request), request);
  assert.deepEqual(result.errors, []);
  assert.ok(result.parsed);
});

test('empty evidenceRefs are rejected — every rationale must be grounded', () => {
  const request = makeRequest();
  const response = makeValidResponse(request);
  const forecast = response.games[0]?.forecasts[0];
  assert.ok(forecast);
  forecast.evidenceRefs = [];
  const result = validate(response, request);
  assert.ok(result.errors.some((e) => e.includes('evidenceRefs')));
});

test('whitespace-only rationale is rejected', () => {
  const request = makeRequest();
  const response = makeValidResponse(request);
  const forecast = response.games[0]?.forecasts[0];
  assert.ok(forecast);
  forecast.rationale = '   ';
  const result = validate(response, request);
  assert.ok(result.errors.length > 0);
});

test('reasonCode: absent, null, and supplied codes are accepted; anything else is rejected', () => {
  const request = makeRequest();

  const absent = makeValidResponse(request);
  const absentForecast = absent.games[0]?.forecasts[0];
  assert.ok(absentForecast);
  delete absentForecast.reasonCode;
  assert.deepEqual(validate(absent, request).errors, []);

  const supplied = makeValidResponse(request);
  const suppliedForecast = supplied.games[0]?.forecasts[0];
  assert.ok(suppliedForecast);
  suppliedForecast.reasonCode = 'missing_information';
  assert.deepEqual(validate(supplied, request).errors, []);

  const bogus = makeValidResponse(request) as unknown as {
    games: Array<{ forecasts: Array<Record<string, unknown>> }>;
  };
  const bogusForecast = bogus.games[0]?.forecasts[0];
  assert.ok(bogusForecast);
  bogusForecast['reasonCode'] = 'because';
  const result = validateResponseText(
    JSON.stringify(bogus),
    request.requestBundle,
    request.requestSha256,
    TEST_ARM,
    TEST_COHORT,
  );
  assert.ok(result.errors.length > 0);
});

test('fingerprint extraction: complete response yields one entry per market', () => {
  const request = makeRequest();
  const fingerprint = extractDecisionFingerprint(
    JSON.stringify(makeValidResponse(request)),
    request.requestBundle,
  );
  assert.ok(fingerprint);
  assert.equal(fingerprint.size, 3);
});

test('fingerprint extraction: unparseable, incomplete, and duplicated responses yield null', () => {
  const request = makeRequest();
  assert.equal(extractDecisionFingerprint('not json {{{', request.requestBundle), null);

  const missingMarket = makeValidResponse(request);
  const missingGame = missingMarket.games[0];
  assert.ok(missingGame);
  missingGame.forecasts = missingGame.forecasts.filter((f) => f.market !== 'spread');
  assert.equal(
    extractDecisionFingerprint(JSON.stringify(missingMarket), request.requestBundle),
    null,
  );

  const duplicated = makeValidResponse(request);
  const duplicatedGame = duplicated.games[0];
  assert.ok(duplicatedGame);
  const spread = duplicatedGame.forecasts.find((f) => f.market === 'spread');
  assert.ok(spread);
  duplicatedGame.forecasts = [
    ...duplicatedGame.forecasts.filter((f) => f.market !== 'total'),
    { ...spread },
  ];
  assert.equal(
    extractDecisionFingerprint(JSON.stringify(duplicated), request.requestBundle),
    null,
  );

  const unknownGame = makeValidResponse(request);
  const firstGame = unknownGame.games[0];
  assert.ok(firstGame);
  firstGame.gameId = 'not-in-the-bundle';
  assert.equal(
    extractDecisionFingerprint(JSON.stringify(unknownGame), request.requestBundle),
    null,
  );
});

test('compareFingerprints: identical fingerprints produce no diffs', () => {
  const request = makeRequest();
  const a = fingerprintFromParsed(makeValidResponse(request));
  const b = fingerprintFromParsed(makeValidResponse(request));
  assert.deepEqual(compareFingerprints(a, b), []);
});

test('compareFingerprints: changed probability, selection, and missing forecast are all diffs', () => {
  const request = makeRequest();
  const before = fingerprintFromParsed(makeValidResponse(request));

  const changed = makeValidResponse(request);
  const changedForecast = changed.games[0]?.forecasts[0];
  assert.ok(changedForecast);
  changedForecast.probabilities = { win: 0.75, push: 0, loss: 0.25 };
  const changedDiffs = compareFingerprints(before, fingerprintFromParsed(changed));
  assert.ok(changedDiffs.some((d) => d.includes('win changed')));

  const swapped = makeValidResponse(request);
  const swappedForecast = swapped.games[0]?.forecasts[0];
  assert.ok(swappedForecast);
  swappedForecast.selection = request.game.homeTeam;
  swappedForecast.observedDecimal = request.game.markets.moneyline.homeDecimal;
  const swapDiffs = compareFingerprints(before, fingerprintFromParsed(swapped));
  assert.ok(swapDiffs.some((d) => d.includes('selection changed')));

  const smaller = makeValidResponse(request);
  const smallerGame = smaller.games[0];
  assert.ok(smallerGame);
  smallerGame.forecasts = smallerGame.forecasts.slice(0, 2);
  const missingDiffs = compareFingerprints(before, fingerprintFromParsed(smaller));
  assert.ok(missingDiffs.some((d) => d.includes('missing after repair')));
});
