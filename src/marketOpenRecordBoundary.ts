import { canonicalize } from './canonical.js';
import { assertMarketOpenPreparedRecordIdentity, assertPreparedMarketOpenRun } from './marketOpen.js';
import { assertMarketOpenRecordReceipt } from './marketOpenStore.js';
import type { BuildResult } from './bundle.js';
import type { MarketOpenProvenance, PreparedMarketOpenRun } from './marketOpen.js';
import type { MarketOpenRecordReceipt } from './marketOpenStore.js';
import type { RunContext } from './records.js';
import type { RunEnvelope } from './runner.js';

// Code-owned and mandatory: callers cannot install a validator, skip an absent
// validator, or mint permission with a flag. This registry is NOT a replay API.
const producerPermissions = new WeakMap<RunEnvelope, {
  run: PreparedMarketOpenRun; context: string; receipt: MarketOpenRecordReceipt;
}>();

// Bind the fields buildRecords actually emits, not extra runner options a
// caller may carry on a structurally assignable context (such as nowMs).
function recordContextIdentity(ctx: RunContext): string {
  return canonicalize({
    runId: ctx.runId, cohortId: ctx.cohortId, mode: ctx.mode, slateDate: ctx.slateDate,
    createdAt: ctx.createdAt, executionPolicy: ctx.executionPolicy, timeoutMs: ctx.timeoutMs,
    maxOutputTokens: ctx.maxOutputTokens, fetchStartedAt: ctx.fetchStartedAt,
    fetchCompletedAt: ctx.fetchCompletedAt, clockMode: ctx.clockMode,
    watch: ctx.watch, marketOpen: ctx.marketOpen,
  });
}

/**
 * Record authorization only, not send admission. The producer calls this after
 * the shared runner returns and the store has durably recorded attempt evidence,
 * before immutable artifact installation. Receipt provenance is owned by the
 * store; permanent preparation identity is owned by marketOpen, not the runtime.
 */
export function authorizeMarketOpenProducerRecords(
  run: PreparedMarketOpenRun, envelope: RunEnvelope, context: RunContext,
  receipt: MarketOpenRecordReceipt,
): void {
  assertPreparedMarketOpenRun(run);
  assertMarketOpenRecordReceipt(receipt, run, envelope);
  if (assertMarketOpenPreparedRecordIdentity(envelope, context, run.build) !== run ||
      context.mode !== 'live' || context.clockMode !== 'wall') {
    throw new Error('market-open producer record context is not the authorized prepared event');
  }
  const binding = { run, context: recordContextIdentity(context), receipt };
  const previous = producerPermissions.get(envelope);
  if (previous !== undefined && (previous.run !== run || previous.context !== binding.context)) {
    throw new Error('market-open producer envelope already has a different record context');
  }
  producerPermissions.set(envelope, binding);
}

/** Always called by buildRecords; missing provenance never opts out. */
export function assertMarketOpenRecordContext(env: RunEnvelope, ctx: RunContext, build: BuildResult): void {
  const run = assertMarketOpenPreparedRecordIdentity(env, ctx, build);
  if (run === undefined) return; // The legacy record shape and behavior are unchanged.
  if (ctx.mode === 'dry-run' && ctx.clockMode === 'synthetic-fixture') return;
  const permission = producerPermissions.get(env);
  if (ctx.mode !== 'live' || ctx.clockMode !== 'wall' || permission?.run !== run ||
      permission.context !== recordContextIdentity(ctx)) {
    throw new Error('market-open record context needs bound producer permission (B1 is fixture-only)');
  }
  assertMarketOpenRecordReceipt(permission.receipt, run, env);
}

/**
 * Additive D1 reference, never a fabricated CurrentOddsRow. buildRecords calls
 * this only after the mandatory identity/permission assertion above. Consumers
 * must resolve it against this same run's run_meta.marketOpen.source (B4).
 */
export function marketOpenHistoryReference(p: MarketOpenProvenance) {
  return {
    kind: 'market-open-history-v1' as const,
    relation: 'odds_history' as const,
    recordType: 'run_meta' as const,
    path: 'marketOpen.source' as const,
    runId: p.runId,
    cohortId: p.event.cohortId,
    eventId: p.event.eventId,
    gameId: p.event.gameId,
    market: p.event.market,
    requestSha256: p.requestSha256,
    gameSha256: p.gameSha256,
    sourceSha256: p.source.sha256,
    openerId: p.source.openerId,
    openedAt: p.source.openedAt,
  };
}
