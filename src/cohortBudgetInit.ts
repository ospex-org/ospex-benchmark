import { assertBootedCohort } from './cohortBoot.js';
import type { BootedCohort } from './cohortBoot.js';
import { STORE_SCHEMA_VERSION } from './store/constants.js';
import { deriveLeaseBounds } from './store/leaseBounds.js';
import type { InitCohortBudgetRequest, InitRefusalReason, InitResult } from './store/contract.js';

/**
 * Cohort-budget initialization preparation. The store's caps + pinned constants are written
 * once at cohort boot from the strictly-parsed manifest, keyed by `cohortId`. This module owns
 * ONLY the pure mapping (manifest → request) and the result classification; it performs NO
 * store call — a later boot slice constructs the store and invokes `initCohortBudget`, then
 * classifies with `assertCohortBudgetInitialized` before any other store or provider effect.
 *
 * The request's identity is AUTHENTICATED boot identity: `buildCohortBudgetInitRequest` takes a
 * genuine `BootedCohort`, asserts its brand before reading any field, and uses `booted.cohortId`
 * directly — never a re-hashed manifest or a separately-supplied id — so the caps can only be
 * pinned under the identity the boot gate actually verified.
 */

/**
 * A cohort budget the store refused to (or could not) initialize. `config_mismatch` /
 * `version_mismatch` / `invalid_input` carry the store's exact refusal reason; a runtime shape
 * that is neither `initialized` nor a known refusal fails with the fixed `store_result_mismatch`
 * WITHOUT reading or formatting the value.
 */
export class CohortBudgetInitError extends Error {
  readonly reason: InitRefusalReason | 'store_result_mismatch';
  constructor(reason: InitRefusalReason | 'store_result_mismatch') {
    super(`cohort budget initialization did not succeed: ${reason}`);
    this.name = 'CohortBudgetInitError';
    this.reason = reason;
  }
}

/**
 * Build the store's init request from an AUTHENTICATED booted cohort. Asserts the boot brand
 * FIRST (before any field read), takes `cohortId` from boot identity, maps the authenticated
 * frozen manifest caps + constants, pins `STORE_SCHEMA_VERSION`, and derives the two lease
 * bounds via the checked-integer `deriveLeaseBounds` (which throws if a bound leaves the store's
 * integer domain). Pure — no store, boot, clock, network, provider, or filesystem access — and
 * returns fresh, frozen plain data.
 */
export function buildCohortBudgetInitRequest(booted: BootedCohort): InitCohortBudgetRequest {
  assertBootedCohort(booted);
  const manifest = booted.manifest;
  const constants = manifest.constants;
  const { initialLeaseBoundMs, repairLeaseBoundMs } = deriveLeaseBounds({
    providerCallTimeoutMs: constants.providerCallTimeoutMs,
    maxClockSkewMs: constants.maxClockSkewMs,
    maxDispatchLagMs: constants.maxDispatchLagMs,
  });
  return Object.freeze({
    cohortId: booted.cohortId,
    schemaVersion: STORE_SCHEMA_VERSION,
    callCap: manifest.cohortCallCap,
    spendCapUsdMicros: manifest.cohortSpendCapUsdMicros,
    concurrencyLimit: constants.maxConcurrentProviderRequests,
    rosterSize: manifest.expectedArmRoster.length,
    maxRepairsPerArm: constants.maxRepairAttemptsPerArm,
    initialLeaseBoundMs,
    repairLeaseBoundMs,
  });
}

/**
 * Classify a store `InitResult`: return normally ONLY for `initialized`; every refusal throws a
 * typed `CohortBudgetInitError` carrying the exact `InitRefusalReason`. A runtime shape that
 * slips past the types throws the fixed `store_result_mismatch`, never formatting the value.
 * A silent "proceed anyway" on a refusal would run a cohort against an un-/mis-initialized
 * budget, so a refusal is always loud.
 */
export function assertCohortBudgetInitialized(result: InitResult): void {
  switch (result.outcome) {
    case 'initialized':
      return;
    case 'refused':
      switch (result.reason) {
        case 'config_mismatch':
        case 'version_mismatch':
        case 'invalid_input':
          throw new CohortBudgetInitError(result.reason);
        default: {
          const _exhaustiveReason: never = result.reason;
          void _exhaustiveReason;
          throw new CohortBudgetInitError('store_result_mismatch');
        }
      }
    default: {
      const _exhaustiveOutcome: never = result;
      void _exhaustiveOutcome;
      throw new CohortBudgetInitError('store_result_mismatch');
    }
  }
}
