import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import {
  forecastDigest,
  forecastFingerprint,
  projectionFingerprint,
  validateResponseText,
} from './schema.js';
import { PROJECTION_SCALES, quantizeForProjection } from './projectionNumeric.js';
import { makeOverScaleAccepted } from './testFactories.js';
import type { ForecastOutput } from './types.js';

/**
 * `forecast_digest`, the pregame commitment the serving projection stores.
 *
 * This is a CONTRACT, not an implementation detail. The digest is written at
 * seal time and a later reveal is checked against it, so a digest computed any
 * other way still produces 64 hex characters, still satisfies the column's
 * CHECK, still stores without complaint — and is silently unverifiable against
 * every reveal that follows. There is no runtime signal for getting it wrong.
 *
 * The commitment is taken over `projectionFingerprint()` — the twelve fields
 * rounded to the scale of the columns the reveal lands in — and NOT over the
 * raw `forecastFingerprint()`. Hashing unrounded floats while the database
 * stores rounded ones makes the seal unreproducible from the reveal; that was
 * measured against a real PostgreSQL, and `projectionNumeric.ts` carries the
 * numbers.
 *
 * Hence the golden values below. They are not a restatement of the
 * implementation: asserting `forecastDigest(f) === sha256Hex(canonicalize(
 * projectionFingerprint(f)))` would pass no matter what any of those three
 * functions did. A frozen literal is the only assertion that notices when
 * `canonicalize` changes its serialisation, or when a thirteenth field joins
 * the fingerprint.
 *
 * IF ONE OF THESE GOES RED, the definition of the commitment has changed and
 * every digest already stored is now unverifiable. That is a decision to make
 * deliberately — with a plan for the rows already written — not a number to
 * update until the test passes.
 */

/**
 * A v2 body: the analysis fields present. Synthetic; from no model.
 *
 * Every float carries four decimals ON PURPOSE. With round values like 0.61 and
 * 2.05, a mutation that rounds a probability before hashing is a no-op on the
 * fixture and survives the golden — measured, it did. Precision here makes the
 * golden itself discriminate.
 */
const V2: ForecastOutput = {
  market: 'spread',
  selection: 'St. Louis Cardinals',
  line: -1.5,
  observedDecimal: 2.0537,
  probabilities: { win: 0.5231, push: 0.0104, loss: 0.4665 },
  confidence: 0.6137,
  wouldAbstain: false,
  selectedForExecution: true,
  rationale: 'synthetic rationale, not from any model',
  evidenceRefs: ['ref-1', 'ref-2'],
  reasonCode: null,
  axes: { valuation: 4, trend: 3, consensus: 2, news: 1, softness: 5 },
  primaryAxis: 'valuation',
  primaryExpectation: 'synthetic expectation.',
};

/** The same decision on a v1 body: the three analysis keys absent, not null. */
const V1: ForecastOutput = {
  market: 'spread',
  selection: 'St. Louis Cardinals',
  line: -1.5,
  observedDecimal: 2.0537,
  probabilities: { win: 0.5231, push: 0.0104, loss: 0.4665 },
  confidence: 0.6137,
  wouldAbstain: false,
  selectedForExecution: true,
  rationale: 'synthetic rationale, not from any model',
  evidenceRefs: ['ref-1', 'ref-2'],
  reasonCode: null,
};

/**
 * An over-scale forecast THE REAL VALIDATOR ACCEPTS, built through the same
 * factories the rest of the suite uses and checked below before it is trusted.
 *
 * The first version of this fixture was hand-written and would have been
 * rejected outright — its probabilities summed to 1.33 — so it was regression
 * evidence for a case that could never occur. The cross-field rules that make
 * this one real: probabilities must sum to 1 within 1e-6, `observedDecimal`
 * must EQUAL the bundle price for the selected side, `line` must echo the
 * bundle, and `push` must be 0 whenever the line is not an integer, which an
 * over-scale line always is. So the bundle carries the over-scale price too.
 *
 * V2 above cannot stand in for this: every one of its values is already within
 * scale, so quantising it changes nothing and a build that skipped quantisation
 * entirely would pass every golden. This fixture is the one that discriminates.
 */
function overScaleFixture(): ForecastOutput {
  const { forecast, errors } = makeOverScaleAccepted();
  // The fixture is only worth something if a producer could actually have
  // received it. Asserted here rather than assumed — the first version of this
  // fixture summed its probabilities to 1.33 and would have been rejected.
  assert.deepEqual(errors, [], 'the over-scale fixture must be a response the validator accepts');
  return forecast;
}

const OVERSCALE: ForecastOutput = overScaleFixture();

const OVERSCALE_DIGEST = '57cc317eacd24a9c8fb9bf55936b255e73f69790b88675a99c608d750f50e21b';

const V2_DIGEST = '4945761adc3f2829b1b51fb6b6515a77d7f88d887d08df2e7c4779755e6b5348';
const V1_DIGEST = 'ff97a0f00a489a328d7637ee144df8ef3904c2a00bed2587ee51714187263878';

/** The column's CHECK, copied from the projection schema. */
const DIGEST_CHECK = /^[0-9a-f]{64}$/;

function withForecast(patch: Partial<ForecastOutput>): ForecastOutput {
  return { ...V2, ...patch };
}

// ─── the commitment itself ───────────────────────────────────────────────────

test('GOLDEN: the digest of a fixed forecast is a frozen value', () => {
  assert.equal(forecastDigest(V2), V2_DIGEST);
  assert.equal(forecastDigest(V1), V1_DIGEST);
});

test('GOLDEN: the bytes that are hashed are the twelve fingerprint fields, sorted', () => {
  // Pinned one level below the digest, so a red golden above says WHICH part
  // moved: the serialisation, or the field set.
  assert.equal(
    canonicalize(forecastFingerprint(V2)),
    '{"axes":{"consensus":2,"news":1,"softness":5,"trend":3,"valuation":4},' +
      '"confidence":0.6137,"line":-1.5,"loss":0.4665,"observedDecimal":2.0537,' +
      '"primaryAxis":"valuation","primaryExpectation":"synthetic expectation.",' +
      '"push":0.0104,"selectedForExecution":true,"selection":"St. Louis Cardinals",' +
      '"win":0.5231,"wouldAbstain":false}'
  );
  // Exactly twelve, so a thirteenth cannot arrive unnoticed.
  assert.equal(Object.keys(forecastFingerprint(V2)).length, 12);
  // …and a v1 body carries the analysis keys as null rather than dropping them.
  // `canonicalize` omits `undefined` members, so the difference between "absent"
  // and "null" is a different digest — `forecastFingerprint` normalises it.
  const v1Keys = Object.keys(forecastFingerprint(V1)).sort();
  assert.deepEqual(v1Keys, Object.keys(forecastFingerprint(V2)).sort());
  assert.equal(canonicalize(forecastFingerprint(V1)).includes('"axes":null'), true);
});

test('the digest satisfies the column CHECK', () => {
  for (const forecast of [V1, V2]) {
    const digest = forecastDigest(forecast);
    assert.match(digest, DIGEST_CHECK);
    assert.equal(digest, digest.toLowerCase());
    assert.equal(digest.length, 64);
  }
});

// ─── it must MOVE when the decision moves ────────────────────────────────────

test('every decision-bearing field changes the digest', () => {
  // The property that makes the commitment worth anything. A digest that does
  // not move when the decision moves would let a different forecast be revealed
  // against a stored seal.
  const perturbations: Array<[string, ForecastOutput]> = [
    ['selection', withForecast({ selection: 'Chicago Cubs' })],
    ['line', withForecast({ line: -2.5 })],
    ['line -> null', withForecast({ line: null })],
    ['observedDecimal', withForecast({ observedDecimal: 2.0538 })],
    ['win', withForecast({ probabilities: { win: 0.5232, push: 0.0104, loss: 0.4665 } })],
    ['push', withForecast({ probabilities: { win: 0.5231, push: 0.0105, loss: 0.4665 } })],
    ['loss', withForecast({ probabilities: { win: 0.5231, push: 0.0104, loss: 0.4666 } })],
    ['confidence', withForecast({ confidence: 0.6138 })],
    ['wouldAbstain', withForecast({ wouldAbstain: true })],
    ['selectedForExecution', withForecast({ selectedForExecution: false })],
    ['primaryAxis', withForecast({ primaryAxis: 'trend' })],
    ['primaryExpectation', withForecast({ primaryExpectation: 'a different expectation.' })],
  ];
  // Each of the five axis scores is decision-bearing on its own.
  for (const axis of ['valuation', 'trend', 'consensus', 'news', 'softness'] as const) {
    const axes = { ...V2.axes! , [axis]: V2.axes![axis] === 5 ? 1 : 5 };
    perturbations.push([`axes.${axis}`, withForecast({ axes })]);
  }

  const seen = new Map<string, string>([[V2_DIGEST, 'the unperturbed forecast']]);
  for (const [label, forecast] of perturbations) {
    const digest = forecastDigest(forecast);
    assert.notEqual(digest, V2_DIGEST, `${label}: changed the decision but not the digest`);
    const clash = seen.get(digest);
    assert.equal(clash, undefined, `${label}: collides with ${clash}`);
    seen.set(digest, label);
  }
  // 12 named + 5 axis scores, and the axes object as a whole via v1 vs v2.
  assert.equal(perturbations.length, 17);
  assert.notEqual(forecastDigest(V1), forecastDigest(V2), 'a v1 and a v2 body must not share a digest');
});

// ─── and must NOT move for anything else ─────────────────────────────────────

test('fields outside the fingerprint do not change the digest', () => {
  // The paired negative control. These are excluded on purpose: a format-only
  // repair may rewrite them, and they stay bound through the retained body and
  // responseSha256. If they entered the digest, a legal repair would break the
  // seal.
  for (const [label, forecast] of [
    ['rationale', withForecast({ rationale: 'an entirely different rationale' })],
    ['evidenceRefs', withForecast({ evidenceRefs: ['ref-9'] })],
    ['reasonCode', withForecast({ reasonCode: 'missing_information' })],
    // `market` is part of the decision KEY (run, game, market), not the digest.
    ['market', withForecast({ market: 'total' })],
  ] as Array<[string, ForecastOutput]>) {
    assert.equal(forecastDigest(forecast), V2_DIGEST, `${label}: must not affect the digest`);
  }
});

test('a change AT the published scale changes the digest', () => {
  // The contract binds the projection's precision, so this is the half of it
  // that must still move: rounding away digits the reveal columns DO hold
  // changes the committed decision and must change the digest. Its counterpart
  // — a change below the published scale, which must NOT change it — is the test
  // further down. Between them they say where the boundary is.
  //
  // Kept because a mutant that rounded confidence before hashing survived the
  // golden until the fixture stopped using values that were already round.
  for (const [label, rounded] of [
    ['confidence', withForecast({ confidence: 0.61 })],
    ['observedDecimal', withForecast({ observedDecimal: 2.05 })],
    ['probabilities', withForecast({ probabilities: { win: 0.52, push: 0.01, loss: 0.47 } })],
  ] as Array<[string, ForecastOutput]>) {
    assert.notEqual(forecastDigest(rounded), V2_DIGEST, `${label}: rounding did not change the digest`);
  }
});

test('the digest is stable across key order and object identity', () => {
  // Same logical forecast, built in a different order and from fresh objects.
  const reordered: ForecastOutput = {
    primaryExpectation: 'synthetic expectation.',
    primaryAxis: 'valuation',
    axes: { softness: 5, news: 1, consensus: 2, trend: 3, valuation: 4 },
    reasonCode: null,
    evidenceRefs: ['ref-1', 'ref-2'],
    rationale: 'synthetic rationale, not from any model',
    selectedForExecution: true,
    wouldAbstain: false,
    confidence: 0.6137,
    probabilities: { loss: 0.4665, push: 0.0104, win: 0.5231 },
    observedDecimal: 2.0537,
    line: -1.5,
    selection: 'St. Louis Cardinals',
    market: 'spread',
  };
  assert.equal(forecastDigest(reordered), V2_DIGEST);
  assert.equal(forecastDigest(structuredClone(V2)), V2_DIGEST);
  // Repeated calls do not drift.
  assert.equal(forecastDigest(V2), forecastDigest(V2));
});

// ─── the lookalike that would be wrong ───────────────────────────────────────

test('it is NOT the fire artifact fingerprint shape, which hashes differently', () => {
  // fireArtifact.ts `decisionFingerprint()` carries the same facts in a
  // different shape: probabilities nested, gameId/market added, and the three
  // analysis keys DROPPED on a v1 body rather than carried as null. Hashing
  // that instead would store fine and pass the CHECK, and every reveal checked
  // against it would fail for a reason nobody would look for here.
  const fp = forecastFingerprint(V2);
  const artifactShape = {
    gameId: 'g1',
    market: 'spread',
    selection: fp.selection,
    line: fp.line,
    observedDecimal: fp.observedDecimal,
    probabilities: { win: fp.win, push: fp.push, loss: fp.loss },
    confidence: fp.confidence,
    wouldAbstain: fp.wouldAbstain,
    selectedForExecution: fp.selectedForExecution,
    axes: fp.axes,
    primaryAxis: fp.primaryAxis,
    primaryExpectation: fp.primaryExpectation,
  };
  assert.notEqual(sha256Hex(canonicalize(artifactShape)), forecastDigest(V2));
  // Nesting the probabilities is enough on its own to diverge.
  const nestedOnly = {
    ...fp,
    win: undefined,
    push: undefined,
    loss: undefined,
    probabilities: { win: fp.win, push: fp.push, loss: fp.loss },
  };
  assert.notEqual(sha256Hex(canonicalize(nestedOnly)), forecastDigest(V2));
});

// ─── the commitment must bind what the reveal can actually carry ─────────────

test('GOLDEN: an over-scale forecast commits to the values the projection stores', () => {
  // Measured against PostgreSQL 16 with the projection's exact column types:
  // storing the RAW values rounds them, and a digest recomputed from the stored
  // row did not match the digest sealed before the game. The preimage is
  // therefore quantised to each column's scale, so the database never rounds
  // and the round trip is exact by construction.
  assert.equal(forecastDigest(OVERSCALE), OVERSCALE_DIGEST);
  assert.equal(
    canonicalize(projectionFingerprint(OVERSCALE)),
    '{"axes":{"consensus":1,"news":3,"softness":5,"trend":4,"valuation":2},' +
      '"confidence":0.61371235,"line":1.5,"loss":0.47687654,"observedDecimal":2.053713,' +
      '"primaryAxis":"trend","primaryExpectation":' +
      '"Recent form favors the home side on the designated run line.",' +
      '"push":0,"selectedForExecution":false,"selection":"Pittsburgh Pirates",' +
      '"win":0.52312346,"wouldAbstain":false}'
  );
});

test('the digest is taken over the QUANTISED fingerprint, not the raw one', () => {
  // The two differ for this fixture, which is what makes the golden above a
  // real assertion rather than a restatement.
  const raw = sha256Hex(canonicalize(forecastFingerprint(OVERSCALE)));
  assert.notEqual(raw, forecastDigest(OVERSCALE));
  // …and for a forecast already within scale they agree, so nothing changed for
  // the ordinary case.
  assert.equal(sha256Hex(canonicalize(forecastFingerprint(V2))), forecastDigest(V2));
  assert.deepEqual(projectionFingerprint(V2), forecastFingerprint(V2));
});

test('ROUND TRIP: re-quantising a revealed value reproduces the sealed digest', () => {
  // What the database does to a value already at scale is nothing, so replaying
  // the fingerprint's own numerics back through the forecast must reproduce the
  // seal. The equivalent check against a REAL PostgreSQL, using the projection's
  // column types, lives in servingStore.conformance.ts — this is the part that
  // can run in CI.
  const sealed = forecastDigest(OVERSCALE);
  const fingerprint = projectionFingerprint(OVERSCALE);
  const revealed: ForecastOutput = {
    ...OVERSCALE,
    line: fingerprint.line,
    observedDecimal: fingerprint.observedDecimal,
    probabilities: { win: fingerprint.win, push: fingerprint.push, loss: fingerprint.loss },
    confidence: fingerprint.confidence,
  };
  assert.equal(forecastDigest(revealed), sealed);
  // Quantising is idempotent, which is the property that makes the above hold.
  for (const [value, scale] of [
    [1.50004, PROJECTION_SCALES.line],
    [2.0537127, PROJECTION_SCALES.observedDecimal],
    [1 / 3, PROJECTION_SCALES.probability],
    [0.613712345, PROJECTION_SCALES.confidence],
  ] as Array<[number, number]>) {
    const once = quantizeForProjection(value, scale);
    assert.equal(quantizeForProjection(once, scale), once);
    // and the decimal it prints as is the one the column will hold
    assert.ok(String(once).split('.')[1] === undefined || String(once).split('.')[1]!.length <= scale);
  }
});

test('a difference below the projection scale does NOT change the digest', () => {
  // The honest consequence of the rule, stated so nobody is surprised by it: the
  // commitment binds the published precision, not the model's full output. Full
  // precision stays bound by responseSha256 over the retained body.
  const nudged: ForecastOutput = {
    ...OVERSCALE,
    confidence: 0.6137123451, // differs from the fixture in the 10th decimal
  };
  assert.equal(forecastDigest(nudged), OVERSCALE_DIGEST);
  // …but a difference AT the scale still does.
  assert.notEqual(forecastDigest({ ...OVERSCALE, confidence: 0.61371236 }), OVERSCALE_DIGEST);
});
