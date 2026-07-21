import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CohortBudgetInitError,
  assertCohortBudgetInitialized,
  buildCohortBudgetInitRequest,
} from './cohortBudgetInit.js';
import { cohortBoot } from './cohortBoot.js';
import type { BootedCohort } from './cohortBoot.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { MODEL_PRICE_TABLE_DIGEST, MODEL_PRICE_TABLE_VERSION } from './modelPriceTable.js';
import { REPAIR_POLICY_VERSION } from './repairPolicy.js';
import { promptScaffoldSha256 } from './prompt.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import { STORE_SCHEMA_VERSION } from './store/constants.js';
import type { InitResult } from './store/contract.js';

/**
 * The cohort-budget init preparation: the pure mapper from an AUTHENTICATED booted cohort to
 * the store's init request, and the loud result classifier. No store, boot side effect, or
 * live path is contacted — a later slice owns the store call.
 */

const CODE_ARMS = defaultExpectedArms();

/** A code-consistent manifest (roster/digests/scaffold from the running code) so it boots. */
function manifestJson(): string {
  return JSON.stringify({
    artifactSchemaVersion: 1,
    network: 'polygon',
    sportAllowList: ['mlb'],
    windowStart: '2026-07-16T00:00:00.000Z',
    windowEnd: '2026-07-16T02:00:00.000Z',
    source: 'jsonodds',
    sourceQueryVersion: 'source-query-v1',
    marketPolicyVersion: MARKET_POLICY_VERSION,
    marketPolicyDigest: MARKET_POLICY_DIGEST,
    promptScaffoldSha256: promptScaffoldSha256(),
    expectedArmRoster: CODE_ARMS.map((a) => ({
      participantId: a.participantId,
      provider: a.provider,
      requestedModelId: a.requestedModelId,
      approvedReportedModelIds: [...a.approvedReportedModelIds],
    })),
    toolInferenceConfigSha256: 'b'.repeat(64),
    baselinePolicyVersion: 'baselines-v0.3.0',
    repairPolicyVersion: REPAIR_POLICY_VERSION,
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: MODEL_PRICE_TABLE_VERSION,
    modelPriceTableDigest: MODEL_PRICE_TABLE_DIGEST,
    spendReservationPolicyVersion: 'fixed-attempt-v1',
    runnerCommitSha: 'd'.repeat(40),
    constants: {
      pollIntervalMs: 30_000,
      cleanEntryWindowMs: 120_000,
      gameDiscoveryWindowHours: 168,
      maxClockSkewMs: 5_000,
      freshFireMs: 30_000,
      maxDispatchLagMs: 10_000,
      historyReadTimeoutMs: 30_000,
      providerCallTimeoutMs: 300_000,
      maxOutputTokens: 16_000,
      maxRepairAttemptsPerArm: 1,
      providerAttemptReservationUsdMicros: 100_000_000,
      ingestionGraceMs: 900_000,
      scheduleChangeToleranceMs: 60_000,
      // Deliberately > roster so concurrencyLimit and rosterSize are DISTINCT — a field swap
      // in the mapper is then observable.
      maxConcurrentProviderRequests: 8,
      maxDispatchesPerTick: 10,
    },
    cohortCallCap: 1_000,
    cohortSpendCapUsdMicros: 5_000_000,
  });
}

function bootGenuine(): BootedCohort {
  return cohortBoot({ live: false, manifestBytes: manifestJson() });
}

// E — the init mapper --------------------------------------------------------

test('buildCohortBudgetInitRequest maps all nine request fields from authenticated boot state', () => {
  const booted = bootGenuine();
  const request = buildCohortBudgetInitRequest(booted);
  assert.deepEqual(request, {
    cohortId: booted.cohortId, // from boot identity, never a re-hash or a separate id
    schemaVersion: STORE_SCHEMA_VERSION,
    callCap: 1_000,
    spendCapUsdMicros: 5_000_000,
    concurrencyLimit: 8, // maxConcurrentProviderRequests, DISTINCT from rosterSize
    rosterSize: CODE_ARMS.length,
    maxRepairsPerArm: 1,
    // deriveLeaseBounds: repair = 300_000 + 5_000; initial = 10_000 + repair.
    initialLeaseBoundMs: 315_000,
    repairLeaseBoundMs: 305_000,
  });
});

test('a forged / structural booted cohort is rejected BEFORE any manifest field is read', () => {
  // A hostile manifest whose every property access throws — if the mapper read a field before
  // authenticating the boot brand, we would see THAT error instead of the brand rejection.
  const forged = {
    cohortId: 'forged',
    manifest: new Proxy(
      {},
      {
        get() {
          throw new Error('a manifest field was read before authentication');
        },
      },
    ),
  } as unknown as BootedCohort;
  assert.throws(
    () => buildCohortBudgetInitRequest(forged),
    (e: unknown) => e instanceof Error && !/field was read before authentication/.test(e.message),
  );
  // A structural copy of a genuine booted cohort is likewise unbranded and rejected.
  const booted = bootGenuine();
  assert.throws(() => buildCohortBudgetInitRequest({ ...booted }));
});

// E — the result classifier --------------------------------------------------

test('assertCohortBudgetInitialized returns for initialized and throws loudly for every refusal', () => {
  assert.doesNotThrow(() => assertCohortBudgetInitialized({ outcome: 'initialized' }));
  for (const reason of ['config_mismatch', 'version_mismatch', 'invalid_input'] as const) {
    assert.throws(
      () => assertCohortBudgetInitialized({ outcome: 'refused', reason }),
      (e: unknown) => e instanceof CohortBudgetInitError && e.reason === reason,
      `refusal ${reason} must throw the typed init error`,
    );
  }
  // A runtime shape that slips past the types fails with the fixed reason, never formatted.
  assert.throws(
    () => assertCohortBudgetInitialized({ outcome: 'exploded' } as unknown as InitResult),
    (e: unknown) => e instanceof CohortBudgetInitError && e.reason === 'store_result_mismatch',
  );
});
