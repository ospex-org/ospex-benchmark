import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROVIDER_ATTEMPT_RESERVATION_USD_MICROS,
  SPEND_RESERVATION_POLICY_VERSION,
  SPEND_RESERVATION_POLICY_VERSIONS,
  deriveFireSpendReservationUsdMicros,
  isSpendReservationPolicyVersion,
  spendReservationPolicyForVersion,
} from './spendReservationPolicy.js';

/**
 * Fixed-attempt spend-reservation policy. The registry + per-attempt amount are pinned to
 * their literal values (so a mutated constant cannot drag the tests with it); the
 * known-version guard is exact; the registry + policy graph are runtime-frozen; and
 * `deriveFireSpendReservationUsdMicros` is checked bigint arithmetic that fails closed on
 * any out-of-domain operand and at the safe-integer boundary.
 */

// A1 — exact registry ---------------------------------------------------------
test('registry, guard, and current version', () => {
  assert.deepEqual([...SPEND_RESERVATION_POLICY_VERSIONS], ['fixed-attempt-v1']);
  assert.equal(SPEND_RESERVATION_POLICY_VERSION, 'fixed-attempt-v1');
  assert.equal(isSpendReservationPolicyVersion('fixed-attempt-v1'), true);
  for (const v of ['', 'fixed-attempt-v2', 'toString', '__proto__']) {
    assert.equal(isSpendReservationPolicyVersion(v), false, `must reject "${v}"`);
  }
});

// A2 — runtime immutability ---------------------------------------------------
test('the version registry and policy graph are frozen', () => {
  assert.throws(() => (SPEND_RESERVATION_POLICY_VERSIONS as unknown as string[]).push('fixed-attempt-v2'));
  assert.equal(isSpendReservationPolicyVersion('fixed-attempt-v2'), false);
  assert.deepEqual([...SPEND_RESERVATION_POLICY_VERSIONS], ['fixed-attempt-v1']); // unchanged

  // The returned policy object cannot be mutated after access; the derived reservation
  // is therefore stable across calls.
  const policy = spendReservationPolicyForVersion('fixed-attempt-v1');
  assert.throws(() => {
    (policy as { providerAttemptReservationUsdMicros: number }).providerAttemptReservationUsdMicros = 1;
  });
  assert.equal(
    spendReservationPolicyForVersion('fixed-attempt-v1').providerAttemptReservationUsdMicros,
    100_000_000,
  );
});

// A3 — literal monetary golden ------------------------------------------------
test('the per-attempt reservation is exactly $100 in USD-micros', () => {
  // Pinned to the literal — NOT read back from the policy object — so a changed constant reds here.
  assert.equal(PROVIDER_ATTEMPT_RESERVATION_USD_MICROS, 100_000_000);
  assert.equal(
    spendReservationPolicyForVersion('fixed-attempt-v1').providerAttemptReservationUsdMicros,
    100_000_000,
  );
});

// A4 — checked formula --------------------------------------------------------
test('derive multiplies roster × (1 + repairs) × per-attempt exactly', () => {
  assert.equal(
    deriveFireSpendReservationUsdMicros({ rosterSize: 4, maxRepairsPerArm: 1, version: 'fixed-attempt-v1' }),
    800_000_000,
  );
  assert.equal(
    deriveFireSpendReservationUsdMicros({ rosterSize: 1, maxRepairsPerArm: 0, version: 'fixed-attempt-v1' }),
    100_000_000,
  );
  // Drops the repair multiplier if `(1 + repairs)` degrades to `1`; drops the roster
  // multiplier if `roster` is ignored — each is a distinct red.
  assert.equal(
    deriveFireSpendReservationUsdMicros({ rosterSize: 4, maxRepairsPerArm: 0, version: 'fixed-attempt-v1' }),
    400_000_000,
  );
});

test('derive is checked bigint arithmetic at the safe-integer boundary', () => {
  // Maximum safe success: 90_071_992 × 1 × 100_000_000 = 9_007_199_200_000_000 ≤ MAX_SAFE_INTEGER.
  assert.equal(
    deriveFireSpendReservationUsdMicros({ rosterSize: 90_071_992, maxRepairsPerArm: 0, version: 'fixed-attempt-v1' }),
    9_007_199_200_000_000,
  );
  assert.ok(Number.isSafeInteger(9_007_199_200_000_000), 'the max-safe result must be exactly representable');
  // One unit more overflows the safe range and MUST throw (unchecked `number` multiply would
  // silently round instead).
  assert.throws(
    () =>
      deriveFireSpendReservationUsdMicros({
        rosterSize: 90_071_993,
        maxRepairsPerArm: 0,
        version: 'fixed-attempt-v1',
      }),
    /exceeds Number\.MAX_SAFE_INTEGER/,
  );
});

test('derive rejects every out-of-domain operand', () => {
  const ok = { rosterSize: 4, maxRepairsPerArm: 1, version: 'fixed-attempt-v1' };
  // rosterSize domain: positive safe integer only.
  for (const bad of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => deriveFireSpendReservationUsdMicros({ ...ok, rosterSize: bad }),
      /rosterSize/,
      `rosterSize=${bad} must throw`,
    );
  }
  // maxRepairsPerArm domain: nonnegative safe integer (0 is valid).
  for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => deriveFireSpendReservationUsdMicros({ ...ok, maxRepairsPerArm: bad }),
      /maxRepairsPerArm/,
      `maxRepairsPerArm=${bad} must throw`,
    );
  }
  // Non-number runtime shapes smuggled through the type: booleans, strings, null, coercible
  // objects — rejected WITHOUT coercion (a { valueOf } must not become 4).
  const hostile: unknown[] = [true, '4', null, undefined, { valueOf: () => 4 }, [4]];
  for (const bad of hostile) {
    assert.throws(
      () => deriveFireSpendReservationUsdMicros({ ...ok, rosterSize: bad as unknown as number }),
      /rosterSize/,
      `rosterSize=${String(bad)} must throw`,
    );
  }
  // Unknown policy version fails closed (no default reservation).
  assert.throws(
    () => deriveFireSpendReservationUsdMicros({ ...ok, version: 'fixed-attempt-v2' }),
    /unknown spend reservation policy version/,
  );
});

test('spendReservationPolicyForVersion throws on an unknown version', () => {
  assert.throws(() => spendReservationPolicyForVersion('nope'), /unknown spend reservation policy version/);
  assert.throws(() => spendReservationPolicyForVersion(''), /unknown spend reservation policy version/);
});
