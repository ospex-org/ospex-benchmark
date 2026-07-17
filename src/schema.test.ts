import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareFingerprints,
  extractDecisionFingerprint,
  fingerprintFromParsed,
  validateResponseText,
} from './schema.js';
import { makeRequest, makeValidResponse, TEST_ARM, TEST_COHORT } from './testFactories.js';
import type { BenchmarkResponse, MarketKey } from './types.js';

const CUTOFF = '2026-07-12T16:15:00+00:00';

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

// ---------------------------------------------------------------------------
// Dynamic decision cardinality — one-, two-, and three-market scoped bundles
// (§3.4). The required forecast set derives from the bundle, never a fixed 3.
// ---------------------------------------------------------------------------

test('a scoped one-market bundle validates a single matching forecast', () => {
  for (const present of [['moneyline'], ['spread'], ['total']] as MarketKey[][]) {
    const request = makeRequest(CUTOFF, {}, present);
    const result = validate(makeValidResponse(request), request);
    assert.deepEqual(result.errors, [], `present=${present.join(',')}`);
    assert.ok(result.parsed);
  }
});

test('a scoped two-market (moneyline+total) bundle validates exactly two forecasts', () => {
  const request = makeRequest(CUTOFF, {}, ['moneyline', 'total']);
  const result = validate(makeValidResponse(request), request);
  assert.deepEqual(result.errors, []);
  assert.equal(result.parsed?.games[0]?.forecasts.length, 2);
});

test('a forecast for a market not in the scoped bundle is rejected', () => {
  const request = makeRequest(CUTOFF, {}, ['total']); // total-only scope
  const response = makeValidResponse(request);
  const game = response.games[0];
  const total = game?.forecasts[0];
  assert.ok(game && total);
  // Add a moneyline forecast the scoped bundle does not carry.
  game.forecasts = [
    ...game.forecasts,
    { ...total, market: 'moneyline', selection: request.game.awayTeam, line: null },
  ];
  const result = validate(response, request);
  assert.ok(result.errors.some((e) => e.includes('not in the scoped bundle')));
});

test('a missing required market is rejected with the present set named', () => {
  const request = makeRequest(); // full three-market
  const response = makeValidResponse(request);
  const game = response.games[0];
  assert.ok(game);
  game.forecasts = game.forecasts.filter((f) => f.market !== 'total');
  const result = validate(response, request);
  assert.ok(result.errors.some((e) => e.includes('missing total forecast')));
});

test('execution policy intersects the scoped set: run-line-only executes nothing, total-only executes the total', () => {
  // Run-line-only: the single spread forecast must NOT be marked for execution.
  const rlRequest = makeRequest(CUTOFF, {}, ['spread']);
  assert.deepEqual(validate(makeValidResponse(rlRequest), rlRequest).errors, []);
  const rlBad = makeValidResponse(rlRequest);
  rlBad.games[0]!.forecasts[0]!.selectedForExecution = true;
  assert.ok(validate(rlBad, rlRequest).errors.some((e) => e.includes('spread must be false')));

  // Total-only: the single total forecast MUST be marked for execution.
  const totRequest = makeRequest(CUTOFF, {}, ['total']);
  const totBad = makeValidResponse(totRequest);
  totBad.games[0]!.forecasts[0]!.selectedForExecution = false;
  assert.ok(validate(totBad, totRequest).errors.some((e) => e.includes('total must be true')));
});

test('fingerprint extraction on a scoped bundle: size matches the present set; an out-of-scope market yields null', () => {
  const request = makeRequest(CUTOFF, {}, ['moneyline', 'total']);
  const fp = extractDecisionFingerprint(
    JSON.stringify(makeValidResponse(request)),
    request.requestBundle,
  );
  assert.ok(fp);
  assert.equal(fp.size, 2);

  // A full three-market response against a two-market scope carries a forecast
  // outside the present set — not a clean, preservation-provable fingerprint.
  const full = makeValidResponse(makeRequest(CUTOFF));
  assert.equal(extractDecisionFingerprint(JSON.stringify(full), request.requestBundle), null);
});

test('a malformed (falsy) market block cannot smuggle an arbitrary forecast past the validator', () => {
  // The fail-open surface: a present-but-falsy moneyline block would otherwise
  // count as present (cardinality) yet skip every per-market check (truthiness),
  // accepting a forecast for a non-bundle team at a fabricated line/price.
  for (const badBlock of [null, false, 0, ''] as unknown[]) {
    const request = makeRequest(); // three-market
    const bundle = request.requestBundle;
    (bundle.games[0]!.markets as Record<string, unknown>).moneyline = badBlock;
    const response: BenchmarkResponse = {
      schemaVersion: 1,
      cohortId: TEST_COHORT,
      participantId: TEST_ARM.participantId,
      requestedModelId: TEST_ARM.requestedModelId,
      bundleSha256: request.requestSha256,
      executionPolicy: 'fixed-moneyline-total',
      games: [
        {
          gameId: bundle.games[0]!.gameId,
          forecasts: [
            {
              market: 'moneyline',
              selection: 'NOT A BUNDLE TEAM',
              line: 123,
              observedDecimal: 99,
              probabilities: { win: 0.4, push: 0.3, loss: 0.3 },
              confidence: 0.5,
              wouldAbstain: false,
              selectedForExecution: false,
              rationale: 'arbitrary',
              evidenceRefs: [bundle.games[0]!.evidenceRefs[0]!],
              reasonCode: null,
            },
          ],
        },
      ],
    };
    const result = validateResponseText(
      JSON.stringify(response),
      bundle,
      request.requestSha256,
      TEST_ARM,
      TEST_COHORT,
    );
    assert.ok(result.errors.length > 0, `badBlock ${String(badBlock)} must reject`);
    assert.ok(result.errors.some((e) => /invalid scoped bundle|malformed/.test(e)));
  }
});

test('a malformed bundle yields no repair fingerprint', () => {
  const request = makeRequest();
  const bundle = request.requestBundle;
  (bundle.games[0]!.markets as Record<string, unknown>).moneyline = null;
  assert.equal(
    extractDecisionFingerprint(JSON.stringify(makeValidResponse(makeRequest())), bundle),
    null,
  );
});

test('an empty scope is rejected by the validator and cannot produce a response', () => {
  const request = makeRequest(CUTOFF, {}, []); // empty scope
  assert.throws(() => makeValidResponse(request)); // fail-closed, not a zero-forecast response
  const response: BenchmarkResponse = {
    schemaVersion: 1,
    cohortId: TEST_COHORT,
    participantId: TEST_ARM.participantId,
    requestedModelId: TEST_ARM.requestedModelId,
    bundleSha256: request.requestSha256,
    executionPolicy: 'fixed-moneyline-total',
    games: [
      {
        gameId: request.game.gameId,
        forecasts: [
          {
            market: 'moneyline',
            selection: request.game.awayTeam,
            line: null,
            observedDecimal: 2,
            probabilities: { win: 0.5, push: 0, loss: 0.5 },
            confidence: 0.5,
            wouldAbstain: false,
            selectedForExecution: true,
            rationale: 'x',
            evidenceRefs: [request.game.evidenceRefs[0]!],
            reasonCode: null,
          },
        ],
      },
    ],
  };
  const result = validateResponseText(
    JSON.stringify(response),
    request.requestBundle,
    request.requestSha256,
    TEST_ARM,
    TEST_COHORT,
  );
  assert.ok(result.errors.some((e) => /empty scope|invalid scoped bundle/.test(e)));
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
