/**
 * Runtime constants for the atomic store. `contract.ts` is types-only, so the store's
 * current schema version and its shared nonnegative-int4 domain live here — one owner
 * each, imported by the adapter, the lease-bound derivation, and the conformance harnesses.
 */

/** Current schema version for the atomic store's cohort_budget contract only. */
export const STORE_SCHEMA_VERSION = 1;

/** Largest nonnegative PostgreSQL int/int4 value. */
export const INT4_MAX = 2_147_483_647;

/** True only for a nonnegative JavaScript safe integer representable as PostgreSQL int4. */
export const isInt4NonNeg = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= INT4_MAX;
