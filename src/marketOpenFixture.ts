import { assertPreparedMarketOpenRun, MARKET_OPEN_POLICY } from './marketOpen.js';
import { createMockAdapters } from './mock.js';
import { buildRecords } from './records.js';
import { runSlate } from './runner.js';
import { computeFireSpendGuard } from './spendGuard.js';
import { spendReservationPolicyForVersion } from './spendReservationPolicy.js';
import { instantMs } from './time.js';
import type { PreparedMarketOpenRun } from './marketOpen.js';
import type { RunContext } from './records.js';

/**
 * B1's only runnable composition: closed, canned adapters and synthetic clocks.
 * No caller-supplied adapters, credentials, IO, publisher or live-mode switch.
 * These records are explicitly dry-run evidence, NOT scored production picks.
 * B2 must supply a separate durable claim/admission capability before paid work.
 */
export async function runMarketOpenFixture(run: PreparedMarketOpenRun) {
  assertPreparedMarketOpenRun(run);
  let clock = instantMs(run.provenance.observedAt);
  const nowMs = () => clock++;
  const options = {
    cohortId: run.cohort.cohortId, executionPolicy: MARKET_OPEN_POLICY.executionPolicy,
    baselinePolicyVersion: MARKET_OPEN_POLICY.baselinePolicyVersion,
    timeoutMs: 1_000, maxOutputTokens: 6_000, nowMs,
  };
  const envelope = await runSlate(
    [...MARKET_OPEN_POLICY.roster], createMockAdapters({ simulateCollision: false }),
    run.build.requests, options,
  );
  const context: RunContext = {
    ...options, runId: run.provenance.runId, slateDate: run.cohort.slateDate,
    mode: 'dry-run', clockMode: 'synthetic-fixture', createdAt: new Date(nowMs()).toISOString(),
    fetchStartedAt: run.provenance.observedAt, fetchCompletedAt: run.provenance.observedAt,
    marketOpen: run.provenance,
  };
  const spend = computeFireSpendGuard({
    arms: envelope.results.map((r) => ({
      participantId: r.arm.participantId, provider: r.arm.provider,
      requestedModelId: r.arm.requestedModelId,
      // Proven by this closed composition, not a caller-supplied billing flag.
      // A known-zero verdict checks wiring, not billable usage/cap enforcement.
      billingClass: 'known-zero' as const, attempt: r.attempt, repair: r.repair,
    })),
    priceVersion: MARKET_OPEN_POLICY.priceVersion,
    perAttemptReservationUsdMicros: spendReservationPolicyForVersion(
      MARKET_OPEN_POLICY.spendReservationPolicyVersion,
    ).providerAttemptReservationUsdMicros,
  });
  const records = buildRecords(envelope, context, run.build, { failures: [], warnings: [] });
  return { envelope, context, records, spend };
}
