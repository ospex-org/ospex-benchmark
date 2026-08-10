import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import {
  forecastDigest,
  forecastFingerprint,
  projectionFingerprint,
} from './schema.js';
import { PROJECTION_SCALES, quantizeForProjection } from './projectionNumeric.js';
import {
  ACCEPTANCE_GAME_ID,
  forecastAcceptance,
  makeOverScaleAccepted,
  makeOverScalePushAccepted,
} from './testFactories.js';
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
 *
 * ── THE FIXTURES ─────────────────────────────────────────────────────────────
 *
 * Every fixture here is a forecast the real validator ACCEPTS, and the first
 * test below proves it rather than asserting it in prose. A fixture that could
 * not occur is regression evidence for a case that never happens — and the
 * value that made the previous one impossible, a non-zero push on a half-run
 * line, was at the same time the only thing in this file keeping a `push`
 * hardcoded to 0 from passing. Impossible and load-bearing at once: that is the
 * trap, and it is why correcting a fixture is not a cosmetic edit.
 *
 * The validator's own rules then force the fixture set into the shape it has. A
 * non-zero push is refused on any fractional line, and a line is over-scale
 * only when it is fractional, so ONE forecast cannot carry both an over-scale
 * line and a push worth hashing. Four fixtures, four jobs:
 *
 *   V2 / V1        a half-run-line spread, within scale, push 0. The primary
 *                  golden; quantising it is a no-op, which is the ordinary case.
 *   OVERSCALE      a spread whose line, price, win, loss and confidence all
 *                  carry more decimals than their columns hold. Push is 0 there,
 *                  because its line is fractional.
 *   OVERSCALE_PUSH a whole-number total carrying an over-scale push — a
 *                  whole-number LINE is what admits a non-zero push, on a spread
 *                  as much as a total, and in this league only totals are quoted
 *                  that way.
 *   MONEYLINE      the only market whose line is null, which is a separate
 *                  branch of the fingerprint and produces a distinct digest for
 *                  every moneyline decision ever sealed. It also carries the
 *                  all-axes-1 shape, where the validator requires primaryAxis to
 *                  be null on a body that still HAS the analysis fields.
 *
 * The perturbations further down are deliberately NOT held to that standard:
 * they probe the hash function, not the pipeline, and requiring each to
 * validate would rule out the ones worth probing (a spread with a null line, a
 * market swap). It is the fixtures they are derived from that must be real.
 */

/**
 * A v2 body: the analysis fields present. Synthetic; from no model.
 *
 * `observedDecimal`, `win`, `loss` and `confidence` carry four decimals ON
 * PURPOSE. With round values like 0.61 and 1.9, a mutation that rounds one of
 * them before hashing is a no-op on the fixture and survives the golden —
 * measured, it did. `observedDecimal` is `americanToDecimal(-111)`, so it is a
 * price the bundle builder can emit rather than a number with the right digit
 * count.
 *
 * The two fields that are not free: `push` is 0 because the designated line is
 * a half run, and `selectedForExecution` is false because a spread is never
 * executed under fixed-moneyline-total. An earlier version of this fixture set
 * both the other way and would have been refused. A push of 0 cannot
 * discriminate a rounding mutation at all, which is precisely why
 * OVERSCALE_PUSH below exists.
 */
const V2: ForecastOutput = {
  market: 'spread',
  selection: 'St. Louis Cardinals',
  line: -1.5,
  observedDecimal: 1.9009,
  probabilities: { win: 0.5231, push: 0, loss: 0.4769 },
  confidence: 0.6137,
  wouldAbstain: false,
  selectedForExecution: false,
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
  observedDecimal: 1.9009,
  probabilities: { win: 0.5231, push: 0, loss: 0.4769 },
  confidence: 0.6137,
  wouldAbstain: false,
  selectedForExecution: false,
  rationale: 'synthetic rationale, not from any model',
  evidenceRefs: ['ref-1', 'ref-2'],
  reasonCode: null,
};

/**
 * An over-scale forecast, built through the same factories the rest of the
 * suite uses and shared with the database conformance suite so both argue about
 * one input.
 *
 * V2 above cannot stand in for it: every one of V2's values is already within
 * scale, so quantising it changes nothing and a build that skipped quantisation
 * entirely would pass every golden.
 */
const OVERSCALE_ACCEPTANCE = makeOverScaleAccepted();
const OVERSCALE: ForecastOutput = OVERSCALE_ACCEPTANCE.forecast;

/**
 * The case OVERSCALE structurally cannot reach: an over-scale PUSH.
 *
 * `isHalfLine()` is `!Number.isInteger`, so the validator REFUSES a non-zero
 * push on any fractional line — it does not rewrite the value, which is the
 * whole reason the old fixture was impossible rather than silently normalised.
 * A line with decimals to lose is fractional by definition, so a non-zero push
 * only occurs on a whole-number line: an ordinary baseball total (8 runs, push
 * if the game lands exactly there) rather than an exotic one.
 *
 * It matters because `push` is model-emitted and the response schema bounds the
 * probabilities by RANGE and never by precision, so a push the model DERIVED
 * arrives with as many decimals as its arithmetic produced. Without this
 * fixture, a build that hashed push raw while storing it rounded passed every
 * test in this file.
 *
 * It lives in testFactories.ts because the database conformance suite reveals
 * the same forecast through a real PostgreSQL; one builder, so the two cannot
 * drift.
 */
const OVERSCALE_PUSH_ACCEPTANCE = makeOverScalePushAccepted();
const OVERSCALE_PUSH: ForecastOutput = OVERSCALE_PUSH_ACCEPTANCE.forecast;

/**
 * The only market whose `line` is null, and therefore the only fixture that
 * reaches the fingerprint's null branch.
 *
 * Without it, three different treatments of that branch all pass — returning 0,
 * or omitting the key, or leaving it undefined — and each would produce a
 * different digest for every moneyline decision the projection ever seals.
 * Moneyline is one of the three markets and one of the two that
 * fixed-moneyline-total actually executes, so this is not a corner.
 *
 * It carries the all-axes-1 shape as well, where the validator requires
 * `primaryAxis` to be null on a body that still HAS the analysis fields. That
 * is a different thing from V1's null, where all three keys are absent
 * together, and the fingerprint has to keep them apart.
 */
const MONEYLINE: ForecastOutput = {
  market: 'moneyline',
  selection: 'Los Angeles Dodgers',
  line: null,
  observedDecimal: 1.71429, // americanToDecimal(-140)
  probabilities: { win: 0.5836, push: 0, loss: 0.4164 },
  confidence: 0.5219,
  wouldAbstain: false,
  selectedForExecution: true,
  rationale: 'synthetic rationale, not from any model',
  evidenceRefs: ['ref-1'],
  reasonCode: null,
  axes: { valuation: 1, trend: 1, consensus: 1, news: 1, softness: 1 },
  primaryAxis: null,
  primaryExpectation: 'No material movement is expected in this price before close.',
};

const V2_DIGEST = 'cd280a6bc15e7894cc036aef94ad70903545ea643468990e06b8a34c1c13ba5d';
const V1_DIGEST = 'fd0c68896bcb5d4d991c63d286839ea26ab954f1719a9109bb76328ba8a098b2';
const OVERSCALE_DIGEST = '57cc317eacd24a9c8fb9bf55936b255e73f69790b88675a99c608d750f50e21b';
const OVERSCALE_PUSH_DIGEST = '009fc2cb19ccbde2e0f19431cf816bd1dabc3e51d25b00b11b4595a05856be43';
const MONEYLINE_DIGEST = 'a068d2ee767addf8be567440872a47c394766b1d3d39593884d8b8ffcf4fc05a';

/** The column's CHECK, copied from the projection schema. */
const DIGEST_CHECK = /^[0-9a-f]{64}$/;

function withForecast(patch: Partial<ForecastOutput>): ForecastOutput {
  return { ...V2, ...patch };
}

// ─── the fixtures are real ───────────────────────────────────────────────────

test('every fixture in this file is a response the validator accepts', () => {
  assert.deepEqual(forecastAcceptance(V2), [], 'V2');
  assert.deepEqual(forecastAcceptance(V1, 1), [], 'V1 against the frozen v1 schema');
  assert.deepEqual(forecastAcceptance(MONEYLINE), [], 'MONEYLINE');
  assert.deepEqual(OVERSCALE_ACCEPTANCE.errors, [], 'OVERSCALE');
  assert.deepEqual(OVERSCALE_PUSH_ACCEPTANCE.errors, [], 'OVERSCALE_PUSH');
  // Two DIFFERENT decisions replayed as v1 bodies. V1 above is already
  // v1-shaped, so it never exercises the helper's field stripping — measured: a
  // build that skipped the stripping left every assertion above green. And one
  // replay is not enough either, because V1 and V2 are the same decision, so
  // each field the stripped body forwards could be a constant and still agree.
  assert.deepEqual(forecastAcceptance(V2, 1), [], 'V2 replayed as a v1 body');
  assert.deepEqual(forecastAcceptance(OVERSCALE_PUSH, 1), [], 'OVERSCALE_PUSH as a v1 body');
});

test('…and that check has teeth: the three shapes that must be refused, are', () => {
  // The negative control, and a regression test for the defect itself. An
  // earlier version of V2 was a half-run-line spread carrying push = 0.0104 —
  // an internally contradictory forecast that would have been rejected long
  // before any digest was taken of it. Without this, an acceptance helper that
  // returned [] unconditionally would leave the test above green.
  //
  // Asserted as the WHOLE list rather than its length: `errors.length === 1` is
  // also satisfied by a helper that reports only the validator's first error,
  // and that mutant survived the earlier form of this test.
  assert.deepEqual(
    forecastAcceptance(withForecast({ probabilities: { win: 0.5231, push: 0.0104, loss: 0.4665 } })),
    [`game ${ACCEPTANCE_GAME_ID} spread: push probability must be 0 on a half-run line`]
  );
  // The total's push rule is a separate branch of the validator, and it is the
  // one OVERSCALE_PUSH depends on. Without this the fixture is accepted for a
  // reason no test can distinguish from that rule having been deleted.
  assert.deepEqual(
    forecastAcceptance({ ...OVERSCALE_PUSH, line: 8.5 }),
    [`game ${ACCEPTANCE_GAME_ID} total: push probability must be 0 on a half-point total`]
  );
  // A forecast wrong in TWO ways, because a single-error case cannot tell a
  // faithful helper from one that reports only the validator's first complaint
  // — measured: with only the two cases above, truncating the verdict to
  // `.slice(0, 1)` left this test green.
  //
  // ⚠ Do not delete this as redundant with the first case. It is, at the time of
  //   writing, the ONLY assertion in the whole suite that pins the validator's
  //   probability-sum rule: replacing that rule's condition with `false` leaves
  //   every other test in the repo green and reddens this one alone.
  assert.deepEqual(
    forecastAcceptance(withForecast({ probabilities: { win: 0.9, push: 0.0104, loss: 0.4665 } })),
    [
      `game ${ACCEPTANCE_GAME_ID} spread: push probability must be 0 on a half-run line`,
      `game ${ACCEPTANCE_GAME_ID} spread: probabilities must sum to 1`,
    ]
  );
});

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
      '"confidence":0.6137,"line":-1.5,"loss":0.4769,"observedDecimal":1.9009,' +
      '"primaryAxis":"valuation","primaryExpectation":"synthetic expectation.",' +
      '"push":0,"selectedForExecution":false,"selection":"St. Louis Cardinals",' +
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
  for (const forecast of [V1, V2, OVERSCALE, OVERSCALE_PUSH, MONEYLINE]) {
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
  // against a stored seal. One field at a time, and none of them may collide.
  const perturbations: Array<[string, ForecastOutput]> = [
    ['selection', withForecast({ selection: 'Chicago Cubs' })],
    ['line', withForecast({ line: -2.5 })],
    ['line -> null', withForecast({ line: null })],
    ['observedDecimal', withForecast({ observedDecimal: 1.901 })],
    ['win', withForecast({ probabilities: { win: 0.5232, push: 0, loss: 0.4769 } })],
    ['push', withForecast({ probabilities: { win: 0.5231, push: 0.0001, loss: 0.4769 } })],
    ['loss', withForecast({ probabilities: { win: 0.5231, push: 0, loss: 0.477 } })],
    ['confidence', withForecast({ confidence: 0.6138 })],
    ['wouldAbstain', withForecast({ wouldAbstain: true })],
    ['selectedForExecution', withForecast({ selectedForExecution: true })],
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
    ['observedDecimal', withForecast({ observedDecimal: 1.9 })],
    ['probabilities', withForecast({ probabilities: { win: 0.52, push: 0, loss: 0.48 } })],
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
    selectedForExecution: false,
    wouldAbstain: false,
    confidence: 0.6137,
    probabilities: { loss: 0.4769, push: 0, win: 0.5231 },
    observedDecimal: 1.9009,
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

test('GOLDEN: an over-scale PUSH is committed at the published scale too', () => {
  // The field the fixture above cannot reach, and the one most likely to arrive
  // over-scale in life: `push` is model-emitted and bounded only by range.
  // 0.061728395 lands in the reveal column as 0.06172839, so a digest over the
  // raw value is unverifiable against the reveal in exactly the way the
  // over-scale spread demonstrated for win, loss and confidence.
  assert.equal(forecastDigest(OVERSCALE_PUSH), OVERSCALE_PUSH_DIGEST);
  assert.equal(
    canonicalize(projectionFingerprint(OVERSCALE_PUSH)),
    '{"axes":{"consensus":3,"news":1,"softness":4,"trend":5,"valuation":2},' +
      '"confidence":0.5543211,"line":8,"loss":0.45061728,"observedDecimal":1.90909,' +
      '"primaryAxis":"trend","primaryExpectation":' +
      '"synthetic expectation on a whole-number total.",' +
      '"push":0.06172839,"selectedForExecution":true,"selection":"over",' +
      '"win":0.48765432,"wouldAbstain":false}'
  );
  // The quantisation is what the golden is pinning: raw and quantised differ,
  // and the difference is push itself.
  assert.notEqual(
    sha256Hex(canonicalize(forecastFingerprint(OVERSCALE_PUSH))),
    forecastDigest(OVERSCALE_PUSH)
  );
  assert.notEqual(
    projectionFingerprint(OVERSCALE_PUSH).push,
    OVERSCALE_PUSH.probabilities.push
  );
  assert.equal(
    projectionFingerprint(OVERSCALE_PUSH).push,
    quantizeForProjection(OVERSCALE_PUSH.probabilities.push, PROJECTION_SCALES.probability)
  );
  // …and the RULE is pinned, not just the scale. `win` sits on the scale-8
  // rounding boundary, where `Number(v.toFixed(8))` and the usual
  // `Math.round(v * 1e8) / 1e8` idiom disagree — so rewriting the quantiser as
  // that idiom, a plausible cleanup, moves the golden above instead of silently
  // redefining the commitment for every boundary value.
  const win = OVERSCALE_PUSH.probabilities.win;
  assert.notEqual(
    quantizeForProjection(win, PROJECTION_SCALES.probability),
    Math.round(win * 10 ** PROJECTION_SCALES.probability) / 10 ** PROJECTION_SCALES.probability,
    'the fixture value no longer straddles the rounding boundary, so the golden cannot see the rule change'
  );
});

test('GOLDEN: a null line is committed as null', () => {
  // The fingerprint branches on `line === null`, and moneyline is the only
  // market that reaches it — the validator MANDATES a null line there. Returning
  // 0 instead, or omitting the key, or leaving it undefined, each produces a
  // different digest for every moneyline decision ever sealed, and each passed
  // every other test in this file. `canonicalize` drops undefined members, so
  // "absent" and "null" are genuinely different bytes; the golden is what says
  // which one the commitment means.
  assert.equal(forecastDigest(MONEYLINE), MONEYLINE_DIGEST);
  assert.equal(
    canonicalize(projectionFingerprint(MONEYLINE)),
    '{"axes":{"consensus":1,"news":1,"softness":1,"trend":1,"valuation":1},' +
      '"confidence":0.5219,"line":null,"loss":0.4164,"observedDecimal":1.71429,' +
      '"primaryAxis":null,"primaryExpectation":' +
      '"No material movement is expected in this price before close.",' +
      '"push":0,"selectedForExecution":true,"selection":"Los Angeles Dodgers",' +
      '"win":0.5836,"wouldAbstain":false}'
  );
  // A v2 body with a null primaryAxis is NOT a v1 body. Both serialise
  // `"primaryAxis":null`, and the fingerprint has to keep them apart on the
  // strength of `axes` alone — which it does, because a v1 body carries
  // `"axes":null` and this one carries five ratings.
  const { axes, primaryAxis, primaryExpectation, ...sameDecisionOnAV1Body } = MONEYLINE;
  assert.deepEqual([axes !== undefined, primaryAxis, primaryExpectation !== undefined],
    [true, null, true], 'the fixture must actually carry the three analysis fields');
  assert.notEqual(forecastDigest(MONEYLINE), forecastDigest(sameDecisionOnAV1Body));
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
  // seal. Both fixtures below have the equivalent check against a REAL
  // PostgreSQL, using the projection's column types, in
  // servingStore.conformance.ts — this is the part that can run in CI.
  for (const fixture of [OVERSCALE, OVERSCALE_PUSH]) {
    const sealed = forecastDigest(fixture);
    const fingerprint = projectionFingerprint(fixture);
    const revealed: ForecastOutput = {
      ...fixture,
      line: fingerprint.line,
      observedDecimal: fingerprint.observedDecimal,
      probabilities: { win: fingerprint.win, push: fingerprint.push, loss: fingerprint.loss },
      confidence: fingerprint.confidence,
    };
    assert.equal(forecastDigest(revealed), sealed);
  }
  // Quantising is idempotent, which is the property that makes the above hold.
  for (const [value, scale] of [
    [1.50004, PROJECTION_SCALES.line],
    [2.0537127, PROJECTION_SCALES.observedDecimal],
    [1 / 3, PROJECTION_SCALES.probability],
    [0.061728395, PROJECTION_SCALES.probability],
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
  // Same boundary on the push fixture, where the field under test is push.
  assert.equal(
    forecastDigest({
      ...OVERSCALE_PUSH,
      probabilities: { ...OVERSCALE_PUSH.probabilities, push: 0.0617283899 },
    }),
    OVERSCALE_PUSH_DIGEST
  );
  assert.notEqual(
    forecastDigest({
      ...OVERSCALE_PUSH,
      probabilities: { ...OVERSCALE_PUSH.probabilities, push: 0.0617284 },
    }),
    OVERSCALE_PUSH_DIGEST
  );
});
