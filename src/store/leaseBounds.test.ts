import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INT4_MAX, STORE_SCHEMA_VERSION, isInt4NonNeg } from './constants.js';
import { LeaseBoundOutOfRangeError, deriveLeaseBounds } from './leaseBounds.js';

/**
 * Store constants + lease-bound derivation. The version + int4 ceiling are pinned to their
 * literal values (so a mutated constant cannot drag the tests with it), and the derivation
 * implements repair = timeout + skew, initial = lag + repair, validating repair before
 * initial and failing closed on any bound outside the nonnegative int4 domain.
 */

// --- constants / helper ---

test('constants: STORE_SCHEMA_VERSION is the literal 1', () => {
  assert.equal(STORE_SCHEMA_VERSION, 1);
});

test('constants: INT4_MAX is the literal PostgreSQL int4 ceiling', () => {
  assert.equal(INT4_MAX, 2_147_483_647);
});

test('isInt4NonNeg: accepts exactly the nonnegative int4 domain, rejects everything else', () => {
  // Accepts the domain endpoints.
  assert.equal(isInt4NonNeg(0), true);
  assert.equal(isInt4NonNeg(2_147_483_647), true);
  // Rejects negative, fractional, above-int4, unsafe, and non-finite.
  assert.equal(isInt4NonNeg(-1), false);
  assert.equal(isInt4NonNeg(1.5), false);
  assert.equal(isInt4NonNeg(2_147_483_648), false); // int4 max + 1
  assert.equal(isInt4NonNeg(Number.MAX_SAFE_INTEGER), false);
  assert.equal(isInt4NonNeg(Number.NaN), false);
  assert.equal(isInt4NonNeg(Number.POSITIVE_INFINITY), false);
  assert.equal(isInt4NonNeg(Number.NEGATIVE_INFINITY), false);
});

// --- derivation ---

test('deriveLeaseBounds: exact formula (Tier-0 and a custom fixture)', () => {
  assert.deepEqual(
    deriveLeaseBounds({ providerCallTimeoutMs: 300_000, maxClockSkewMs: 5_000, maxDispatchLagMs: 10_000 }),
    { repairLeaseBoundMs: 305_000, initialLeaseBoundMs: 315_000 },
  );
  assert.deepEqual(
    deriveLeaseBounds({ providerCallTimeoutMs: 120_000, maxClockSkewMs: 0, maxDispatchLagMs: 7_500 }),
    { repairLeaseBoundMs: 120_000, initialLeaseBoundMs: 127_500 },
  );
});

test('deriveLeaseBounds: maximum successful pair returns initial exactly INT4_MAX', () => {
  // Because dispatch lag is positive, a repair bound of INT4_MAX would overflow the initial
  // bound; the exact ceiling is repair = INT4_MAX-1, initial = INT4_MAX.
  assert.deepEqual(
    deriveLeaseBounds({ providerCallTimeoutMs: 2_147_483_646, maxClockSkewMs: 0, maxDispatchLagMs: 1 }),
    { repairLeaseBoundMs: 2_147_483_646, initialLeaseBoundMs: 2_147_483_647 },
  );
});

test('deriveLeaseBounds: a valid repair but out-of-int4 initial throws for initialLeaseBoundMs', () => {
  assert.throws(
    () => deriveLeaseBounds({ providerCallTimeoutMs: 2_147_483_646, maxClockSkewMs: 0, maxDispatchLagMs: 2 }),
    (e: unknown) =>
      e instanceof LeaseBoundOutOfRangeError && e.bound === 'initialLeaseBoundMs' && e.value === 2_147_483_648,
  );
});

test('deriveLeaseBounds: a repair bound above int4 throws for repairLeaseBoundMs first', () => {
  assert.throws(
    () => deriveLeaseBounds({ providerCallTimeoutMs: 2_147_483_648, maxClockSkewMs: 0, maxDispatchLagMs: 1 }),
    (e: unknown) =>
      e instanceof LeaseBoundOutOfRangeError && e.bound === 'repairLeaseBoundMs' && e.value === 2_147_483_648,
  );
});

test('deriveLeaseBounds: an unsafe repair sum throws for repairLeaseBoundMs', () => {
  assert.throws(
    () => deriveLeaseBounds({ providerCallTimeoutMs: Number.MAX_SAFE_INTEGER, maxClockSkewMs: 1, maxDispatchLagMs: 1 }),
    (e: unknown) =>
      e instanceof LeaseBoundOutOfRangeError &&
      e.bound === 'repairLeaseBoundMs' &&
      e.value === Number.MAX_SAFE_INTEGER + 1,
  );
});
