import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareFingerprints,
  extractDecisionFingerprint,
  fingerprintFromParsed,
  RESPONSE_SCHEMA_VERSIONS,
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
  swappedForecast.observedDecimal = request.game.markets.moneyline!.homeDecimal;
  const swapDiffs = compareFingerprints(before, fingerprintFromParsed(swapped));
  assert.ok(swapDiffs.some((d) => d.includes('selection changed')));

  const smaller = makeValidResponse(request);
  const smallerGame = smaller.games[0];
  assert.ok(smallerGame);
  smallerGame.forecasts = smallerGame.forecasts.slice(0, 2);
  const missingDiffs = compareFingerprints(before, fingerprintFromParsed(smaller));
  assert.ok(missingDiffs.some((d) => d.includes('missing after repair')));
});

// --- S3b: dynamic (1-3 market) validator (SPEC-prepared-request.md §5-S3, §6) ---

type MarketKey = 'moneyline' | 'spread' | 'total';

/** Response market key -> the bundle's market-block key (the run line is `runLine`). */
const MARKET_TO_BLOCK: Record<MarketKey, 'moneyline' | 'runLine' | 'total'> = {
  moneyline: 'moneyline',
  spread: 'runLine',
  total: 'total',
};

/**
 * A scoped fixture: a request whose single game supplies only `present` market
 * blocks (absent ones omitted, as a real scoped request would carry them), and a
 * valid response carrying exactly those markets' forecasts. Built from a
 * full-board request/response so the kept forecasts still echo the present
 * blocks' prices/lines. The bundle content is scoped AFTER `requestSha256` is
 * computed — the validator compares the echoed hash to the supplied value and
 * never recomputes it (that is the prepared boundary's job, S1/S3e).
 */
function scopedFixture(present: ReadonlyArray<MarketKey>): {
  request: ReturnType<typeof makeRequest>;
  response: BenchmarkResponse;
} {
  const request = makeRequest();
  const response = makeValidResponse(request);
  const presentSet = new Set(present);
  const game0 = response.games[0];
  assert.ok(game0);
  game0.forecasts = game0.forecasts.filter((f) => presentSet.has(f.market));
  const bundleGame = request.game;
  const full = bundleGame.markets;
  const scoped: Record<string, unknown> = {};
  for (const m of present) scoped[MARKET_TO_BLOCK[m]] = full[MARKET_TO_BLOCK[m]];
  (bundleGame as { markets: unknown }).markets = scoped;
  return { request, response };
}

// Every non-empty market combination: the validator accepts each scoped board
// with exactly its supplied-market forecasts, and only those.
const V3_COMBINATIONS: ReadonlyArray<ReadonlyArray<MarketKey>> = [
  ['moneyline'],
  ['spread'],
  ['total'],
  ['moneyline', 'spread'],
  ['moneyline', 'total'],
  ['spread', 'total'],
  ['moneyline', 'spread', 'total'],
];

for (const present of V3_COMBINATIONS) {
  const label = present.join('+');
  test(`validator accepts the scoped board [${label}] with exactly its supplied-market forecasts`, () => {
    const { request, response } = scopedFixture(present);
    const result = validate(response, request);
    assert.deepEqual(result.errors, []);
    assert.ok(result.parsed);
    assert.equal(result.parsed.games[0]?.forecasts.length, present.length);
  });
}

test('scoped board: the total forecast is executed under fixed-moneyline-total', () => {
  const { request, response } = scopedFixture(['total']);
  assert.deepEqual(validate(response, request).errors, []);
  const totalForecast = response.games[0]?.forecasts.find((f) => f.market === 'total');
  assert.ok(totalForecast);
  totalForecast.selectedForExecution = false; // total must be executed when supplied
  assert.ok(validate(response, request).errors.some((e) => e.includes('selectedForExecution')));
});

test('scoped board: a spread-only board executes nothing (spread never selected)', () => {
  const { request, response } = scopedFixture(['spread']);
  const spreadForecast = response.games[0]?.forecasts.find((f) => f.market === 'spread');
  assert.ok(spreadForecast);
  assert.equal(spreadForecast.selectedForExecution, false);
  assert.deepEqual(validate(response, request).errors, []);
  spreadForecast.selectedForExecution = true; // marking the spread violates the policy
  assert.ok(validate(response, request).errors.some((e) => e.includes('selectedForExecution')));
});

test('scoped board: a forecast for an unsupplied market is rejected', () => {
  // Scope the bundle to total-only but leave the full three-forecast response:
  // moneyline and spread are now unsupplied extras.
  const request = makeRequest();
  const response = makeValidResponse(request);
  (request.game as { markets: unknown }).markets = { total: request.game.markets.total };
  const result = validate(response, request);
  assert.ok(result.errors.some((e) => /must contain exactly one total forecast/.test(e)));
});

test('scoped board: a supplied market missing from the response is rejected', () => {
  const { request, response } = scopedFixture(['moneyline', 'total']);
  const game0 = response.games[0];
  assert.ok(game0);
  game0.forecasts = game0.forecasts.filter((f) => f.market !== 'total');
  const result = validate(response, request);
  assert.ok(
    result.errors.some((e) => /must contain exactly one moneyline, one total forecast/.test(e)),
  );
});

test('fingerprint extraction: a scoped board yields one entry per supplied market', () => {
  const { request, response } = scopedFixture(['moneyline', 'total']);
  const fp = extractDecisionFingerprint(JSON.stringify(response), request.requestBundle);
  assert.ok(fp);
  assert.equal(fp.size, 2);
});

test('fingerprint extraction: an unsupplied-market forecast or a missing supplied market yields null', () => {
  // total-only bundle, but the full three-forecast response carries unsupplied
  // moneyline/spread → ambiguous → null.
  const request = makeRequest();
  const response = makeValidResponse(request);
  (request.game as { markets: unknown }).markets = { total: request.game.markets.total };
  assert.equal(extractDecisionFingerprint(JSON.stringify(response), request.requestBundle), null);

  // moneyline+total bundle, but the response supplies only moneyline → the
  // supplied total is missing → incomplete → null.
  const req2 = makeRequest();
  const resp2 = makeValidResponse(req2);
  const g2 = resp2.games[0];
  assert.ok(g2);
  g2.forecasts = g2.forecasts.filter((f) => f.market === 'moneyline');
  (req2.game as { markets: unknown }).markets = {
    moneyline: req2.game.markets.moneyline,
    total: req2.game.markets.total,
  };
  assert.equal(extractDecisionFingerprint(JSON.stringify(resp2), req2.requestBundle), null);
});

// ---------------------------------------------------------------------------
// Response schema v2: axes / primaryAxis / primaryExpectation + versioning
// ---------------------------------------------------------------------------

/** The same decisions as a pre-axes (v1) body: version literal 1, analysis fields stripped. */
function asV1(response: BenchmarkResponse): BenchmarkResponse {
  const stripped = structuredClone(response);
  stripped.schemaVersion = 1;
  for (const game of stripped.games) {
    for (const forecast of game.forecasts) {
      delete forecast.axes;
      delete forecast.primaryAxis;
      delete forecast.primaryExpectation;
    }
  }
  return stripped;
}

test('fail-new: a v1-shaped (pre-axes) response is rejected under the new-run default', () => {
  const request = makeRequest();
  const result = validate(asV1(makeValidResponse(request)), request);
  assert.ok(result.errors.length > 0, 'a pre-axes body must fail new-run validation');
  assert.ok(
    result.errors.some((e) => e.includes('schemaVersion') || e.includes('axes')),
    `errors must name the version or the missing fields, got: ${result.errors.join(' | ')}`,
  );
});

test('accept-old: the SAME v1 body validates cleanly when the caller accepts the known versions (replay contexts)', () => {
  const request = makeRequest();
  const v1 = asV1(makeValidResponse(request));
  const result = validateResponseText(
    JSON.stringify(v1),
    request.requestBundle,
    request.requestSha256,
    TEST_ARM,
    TEST_COHORT,
    RESPONSE_SCHEMA_VERSIONS,
  );
  assert.deepEqual(result.errors, []);
  assert.ok(result.parsed);
  // Negative control: accept-old does not accept an UNKNOWN version.
  const v3 = { ...v1, schemaVersion: 3 } as unknown as BenchmarkResponse;
  const rejected = validateResponseText(
    JSON.stringify(v3),
    request.requestBundle,
    request.requestSha256,
    TEST_ARM,
    TEST_COHORT,
    RESPONSE_SCHEMA_VERSIONS,
  );
  assert.ok(rejected.errors.some((e) => e.includes('schemaVersion')));
});

test('a v2 response missing any one of the three analysis fields fails with a field-named error', () => {
  for (const field of ['axes', 'primaryAxis', 'primaryExpectation'] as const) {
    const request = makeRequest();
    const response = makeValidResponse(request);
    const forecast = response.games[0]?.forecasts[0];
    assert.ok(forecast);
    delete forecast[field];
    const result = validate(response, request);
    assert.ok(
      result.errors.some((e) => e.includes(field)),
      `dropping ${field} must produce an error naming it, got: ${result.errors.join(' | ')}`,
    );
  }
});

test('axes scores are INTEGERS 1..5 on exactly the five named axes — range, fraction, extra-key, and missing-key mutants all fail', () => {
  const mutate = (fn: (axes: Record<string, number>) => void): string[] => {
    const request = makeRequest();
    const response = makeValidResponse(request);
    const forecast = response.games[0]?.forecasts[0];
    assert.ok(forecast?.axes);
    fn(forecast.axes as unknown as Record<string, number>);
    return validate(response, request).errors;
  };
  assert.ok(mutate((a) => { a['valuation'] = 0; }).some((e) => e.includes('axes')), 'below range');
  assert.ok(mutate((a) => { a['softness'] = 6; }).some((e) => e.includes('axes')), 'above range');
  assert.ok(mutate((a) => { a['trend'] = 2.5; }).some((e) => e.includes('axes')), 'non-integer');
  assert.ok(mutate((a) => { a['momentum'] = 3; }).some((e) => e.includes('axes')), 'unknown axis key');
  assert.ok(mutate((a) => { delete a['news']; }).some((e) => e.includes('axes')), 'missing axis key');
});

test('primaryExpectation pairs to primaryAxis: mixed null states fail, both-null and both-set validate', () => {
  const withPair = (
    primaryAxis: BenchmarkResponse['games'][number]['forecasts'][number]['primaryAxis'],
    primaryExpectation: string | null,
  ): string[] => {
    const request = makeRequest();
    const response = makeValidResponse(request);
    const forecast = response.games[0]?.forecasts[0];
    assert.ok(forecast);
    forecast.primaryAxis = primaryAxis;
    forecast.primaryExpectation = primaryExpectation;
    return validate(response, request).errors;
  };
  assert.deepEqual(withPair('news', 'A starter scratch is expected to move this line.'), []);
  assert.deepEqual(withPair(null, null), []);
  assert.ok(withPair(null, 'sentence without an axis').some((e) => e.includes('primaryExpectation')));
  assert.ok(withPair('trend', null).some((e) => e.includes('primaryExpectation')));
});

test('primaryExpectation must be one single-line sentence — newline and whitespace-only both fail', () => {
  const withExpectation = (value: string): string[] => {
    const request = makeRequest();
    const response = makeValidResponse(request);
    const forecast = response.games[0]?.forecasts[0];
    assert.ok(forecast);
    forecast.primaryAxis = 'valuation';
    forecast.primaryExpectation = value;
    return validate(response, request).errors;
  };
  assert.ok(withExpectation('two\nlines').some((e) => e.includes('primaryExpectation')));
  assert.ok(withExpectation('   ').some((e) => e.includes('primaryExpectation')));
  assert.deepEqual(withExpectation('One sentence about the expected move.'), []);
});

test('fingerprints span versions: a v1-shaped initial is still repairable and its fingerprint equals the v2 fingerprint (axes are not decision-bearing)', () => {
  const request = makeRequest();
  const v2 = makeValidResponse(request);
  const v1 = asV1(v2);
  const v1Fingerprint = extractDecisionFingerprint(JSON.stringify(v1), request.requestBundle);
  assert.ok(v1Fingerprint, 'a pre-axes body must still yield a complete fingerprint (repairable)');
  const v2Validated = validate(v2, request);
  assert.ok(v2Validated.parsed);
  assert.deepEqual(compareFingerprints(v1Fingerprint, fingerprintFromParsed(v2Validated.parsed)), []);
});
