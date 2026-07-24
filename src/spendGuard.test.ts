import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyAttemptSpend, computeFireSpendGuard } from './spendGuard.js';
import type { BillingClass, GuardArmInput } from './spendGuard.js';
import { SPEND_GUARD_PRICE_TABLE_VERSION } from './modelPriceTable.js';
import { PROVIDER_ATTEMPT_RESERVATION_USD_MICROS } from './spendReservationPolicy.js';

/**
 * Spend-guard policy tests. The classifier's cell for each (billingClass, sent?, usage?) must be
 * exact (an undercount is silent money loss), and the fire verdict must escalate on BREACH or
 * UNKNOWN while a pure mock (known-zero) fire always passes at zero cost.
 */

const V2 = SPEND_GUARD_PRICE_TABLE_VERSION;
const CAP = PROVIDER_ATTEMPT_RESERVATION_USD_MICROS; // $100 = 100_000_000 USD-micros
const SENT = '2026-07-24T00:00:00.000000+00:00';

// gpt-5.6-sol at prices-v2 is $12.50/M input, $60/M output.
const UNDER_CAP_USAGE = { prompt_tokens: 100, completion_tokens: 20 }; // 100·12.5 + 20·60 = 2,450 micros
const AT_CAP_USAGE = { prompt_tokens: 8_000_000, completion_tokens: 0 }; // 8M·12.5 = exactly 100,000,000 == CAP
const OVER_CAP_USAGE = { prompt_tokens: 8_000_000, completion_tokens: 1 }; // 100,000,000 + 60 = 100,000,060 > CAP

function billableArm(usageRaw: unknown, requestAt: string | null = SENT, participantId = 'p1'): GuardArmInput {
  return { participantId, billingClass: 'billable', provider: 'openai', requestedModelId: 'gpt-5.6-sol', attempt: { requestAt, usageRaw }, repair: null };
}

// ── Classifier truth table (identity-bound: the exact class per cell) ───────────

test('classifier: known-zero is known_zero in every (sent, usage) combination', () => {
  const knownZero: BillingClass = 'known-zero';
  assert.equal(classifyAttemptSpend({ billingClass: knownZero, requestAt: SENT, usageRaw: { prompt_tokens: 1 } }), 'known_zero');
  assert.equal(classifyAttemptSpend({ billingClass: knownZero, requestAt: SENT, usageRaw: null }), 'known_zero');
  assert.equal(classifyAttemptSpend({ billingClass: knownZero, requestAt: null, usageRaw: { prompt_tokens: 1 } }), 'known_zero');
  assert.equal(classifyAttemptSpend({ billingClass: knownZero, requestAt: null, usageRaw: null }), 'known_zero');
});

test('classifier: billable cells map exactly — price / unknown / unknown / zero', () => {
  const b: BillingClass = 'billable';
  // sent + usage present → price
  assert.equal(classifyAttemptSpend({ billingClass: b, requestAt: SENT, usageRaw: { prompt_tokens: 1 } }), 'price');
  // sent + no usage → unknown (a sent attempt with no usage may still have billed)
  assert.equal(classifyAttemptSpend({ billingClass: b, requestAt: SENT, usageRaw: null }), 'unknown');
  // not sent + usage present → unknown (incoherent: usage without a sent request)
  assert.equal(classifyAttemptSpend({ billingClass: b, requestAt: null, usageRaw: { prompt_tokens: 1 } }), 'unknown');
  // not sent + no usage → zero (never dispatched)
  assert.equal(classifyAttemptSpend({ billingClass: b, requestAt: null, usageRaw: null }), 'zero');
});

test('classifier: an array or a non-object usage is NOT "present" — treated as no usage', () => {
  const b: BillingClass = 'billable';
  assert.equal(classifyAttemptSpend({ billingClass: b, requestAt: SENT, usageRaw: [1, 2, 3] }), 'unknown'); // sent, array → not present → unknown
  assert.equal(classifyAttemptSpend({ billingClass: b, requestAt: null, usageRaw: 42 }), 'zero'); // unsent, number → not present → zero
});

// ── Fire verdict ───────────────────────────────────────────────────────────────

test('verdict: an all known-zero fire passes at zero cost (the mock cohort path never trips)', () => {
  const arms: GuardArmInput[] = [
    { participantId: 'a', billingClass: 'known-zero', provider: 'openai', requestedModelId: 'gpt-5.6-sol', attempt: { requestAt: SENT, usageRaw: OVER_CAP_USAGE }, repair: null },
    { participantId: 'b', billingClass: 'known-zero', provider: 'anthropic', requestedModelId: 'claude-fable-5', attempt: { requestAt: SENT, usageRaw: { input_tokens: 9_999_999, output_tokens: 9_999_999 } }, repair: null },
  ];
  // Even wildly-over-cap usage on a known-zero arm never trips — the adapter cannot spend.
  assert.deepEqual(computeFireSpendGuard({ arms, priceVersion: V2, perAttemptReservationUsdMicros: CAP }), { kind: 'pass' });
});

test('verdict: a billable attempt under the reservation passes', () => {
  const v = computeFireSpendGuard({ arms: [billableArm(UNDER_CAP_USAGE)], priceVersion: V2, perAttemptReservationUsdMicros: CAP });
  assert.deepEqual(v, { kind: 'pass' });
});

test('verdict: the boundary is strictly > — exactly $100 passes, over the cap breaches', () => {
  assert.deepEqual(
    computeFireSpendGuard({ arms: [billableArm(AT_CAP_USAGE)], priceVersion: V2, perAttemptReservationUsdMicros: CAP }),
    { kind: 'pass' },
  );
  const over = computeFireSpendGuard({ arms: [billableArm(OVER_CAP_USAGE)], priceVersion: V2, perAttemptReservationUsdMicros: CAP });
  assert.equal(over.kind, 'breach');
  assert.equal(over.kind === 'breach' ? over.offenders.length : -1, 1);
  const o = over.kind === 'breach' ? over.offenders[0]! : undefined;
  assert.equal(o?.participantId, 'p1');
  assert.equal(o?.role, 'initial');
  assert.equal(o?.status, 'breach');
  assert.equal(o?.derivedActualUsdMicros, 100_000_060);
});

test('verdict: a billable SENT attempt with no usage is UNKNOWN (never read as zero)', () => {
  const v = computeFireSpendGuard({ arms: [billableArm(null)], priceVersion: V2, perAttemptReservationUsdMicros: CAP });
  assert.equal(v.kind, 'unknown');
  assert.equal(v.kind === 'unknown' ? v.offenders[0]?.status : undefined, 'unknown');
});

test('verdict: a billable attempt with present-but-malformed usage folds the arithmetic UNKNOWN into the verdict', () => {
  // usage present (shallow) but missing prompt_tokens → arithmetic throws → guard converts to unknown.
  const v = computeFireSpendGuard({ arms: [billableArm({ completion_tokens: 5 })], priceVersion: V2, perAttemptReservationUsdMicros: CAP });
  assert.equal(v.kind, 'unknown');
});

test('verdict: a billable UNSENT arm with no usage passes (provisional zero — never dispatched)', () => {
  const v = computeFireSpendGuard({ arms: [billableArm(null, null)], priceVersion: V2, perAttemptReservationUsdMicros: CAP });
  assert.deepEqual(v, { kind: 'pass' });
});

test('verdict: BREACH takes precedence over UNKNOWN, but offenders lists both', () => {
  const arms: GuardArmInput[] = [billableArm(OVER_CAP_USAGE, SENT, 'breacher'), billableArm(null, SENT, 'unknowner')];
  const v = computeFireSpendGuard({ arms, priceVersion: V2, perAttemptReservationUsdMicros: CAP });
  assert.equal(v.kind, 'breach');
  const offenders = v.kind === 'breach' ? v.offenders : [];
  assert.equal(offenders.length, 2);
  assert.ok(offenders.some((o) => o.participantId === 'breacher' && o.status === 'breach'));
  assert.ok(offenders.some((o) => o.participantId === 'unknowner' && o.status === 'unknown'));
});

test('verdict: a REPAIR attempt is priced too — a breach on the repair is attributed to role "repair"', () => {
  const arm: GuardArmInput = {
    participantId: 'p1',
    billingClass: 'billable',
    provider: 'openai',
    requestedModelId: 'gpt-5.6-sol',
    attempt: { requestAt: SENT, usageRaw: UNDER_CAP_USAGE }, // initial fine
    repair: { requestAt: SENT, usageRaw: OVER_CAP_USAGE }, // repair breaches
  };
  const v = computeFireSpendGuard({ arms: [arm], priceVersion: V2, perAttemptReservationUsdMicros: CAP });
  assert.equal(v.kind, 'breach');
  assert.equal(v.kind === 'breach' ? v.offenders[0]?.role : undefined, 'repair');
});

test('verdict: an empty fire passes', () => {
  assert.deepEqual(computeFireSpendGuard({ arms: [], priceVersion: V2, perAttemptReservationUsdMicros: CAP }), { kind: 'pass' });
});

test('verdict: a non-positive / non-integer reservation cap throws (fail-closed config)', () => {
  for (const badCap of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => computeFireSpendGuard({ arms: [billableArm(UNDER_CAP_USAGE)], priceVersion: V2, perAttemptReservationUsdMicros: badCap }),
      /positive safe integer/,
      `cap=${String(badCap)} should throw`,
    );
  }
});

test('verdict: the returned verdict and offenders are frozen', () => {
  const v = computeFireSpendGuard({ arms: [billableArm(OVER_CAP_USAGE)], priceVersion: V2, perAttemptReservationUsdMicros: CAP });
  assert.throws(() => {
    (v as { kind: string }).kind = 'pass';
  });
  if (v.kind === 'breach') {
    assert.throws(() => (v.offenders as SpendGuardOffenderMutable[]).push({} as SpendGuardOffenderMutable));
  }
});

test('verdict: the breach boundary is tight — a derived-actual just $0.000002 over the cap breaches', () => {
  // gemini's even rates ($4/$18) reach the SMALLEST over-cap slack: 24,999,996·4 + 1·18 = 100,000,002 = CAP+2.
  // (CAP+1 is structurally unreachable — every provider's derived-actual is a multiple of ≥2.)
  const arm: GuardArmInput = {
    participantId: 'p1',
    billingClass: 'billable',
    provider: 'google',
    requestedModelId: 'gemini-3.1-pro-preview',
    attempt: { requestAt: SENT, usageRaw: { promptTokenCount: 24_999_996, candidatesTokenCount: 1, thoughtsTokenCount: 0, totalTokenCount: 24_999_997 } },
    repair: null,
  };
  const v = computeFireSpendGuard({ arms: [arm], priceVersion: V2, perAttemptReservationUsdMicros: CAP });
  assert.equal(v.kind, 'breach');
  assert.equal(v.kind === 'breach' ? v.offenders[0]?.derivedActualUsdMicros : undefined, 100_000_002);
});

test('verdict: an UNKNOWN on the REPAIR attempt is attributed to role "repair" (not hardcoded initial)', () => {
  const arm: GuardArmInput = {
    participantId: 'p1',
    billingClass: 'billable',
    provider: 'openai',
    requestedModelId: 'gpt-5.6-sol',
    attempt: { requestAt: SENT, usageRaw: UNDER_CAP_USAGE }, // initial fine
    repair: { requestAt: SENT, usageRaw: null }, // billable sent, no usage → unknown
  };
  const v = computeFireSpendGuard({ arms: [arm], priceVersion: V2, perAttemptReservationUsdMicros: CAP });
  assert.equal(v.kind, 'unknown');
  assert.equal(v.kind === 'unknown' ? v.offenders[0]?.role : undefined, 'repair');
});

// Local alias only to express the frozen-array mutation attempt above.
type SpendGuardOffenderMutable = { participantId: string; role: 'initial' | 'repair'; status: 'breach' | 'unknown'; derivedActualUsdMicros: number | null };
