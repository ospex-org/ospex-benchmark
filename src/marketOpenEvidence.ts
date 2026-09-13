import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalize } from './canonical.js';
import { deepFreeze } from './freeze.js';
import { runBaselines } from './baselines.js';
import { createMarketOpenCohort, MARKET_OPEN_POLICY, prepareMarketOpenRun } from './marketOpen.js';
import type { PreparedMarketOpenRun } from './marketOpen.js';
import { MARKET_OPEN_ADMISSION_POLICY, MARKET_OPEN_ADMISSION_POLICY_SHA256 } from './marketOpenProducer.js';
import { estimateMarketOpenDailyAttempts, MARKET_OPEN_DAILY_BUDGET_POLICY,
  MARKET_OPEN_DAILY_BUDGET_POLICY_SHA256 } from './marketOpenDailyBudget.js';
import { marketOpenHistoryReference } from './marketOpenRecordBoundary.js';
import { assertMarketOpenJson, readMarketOpenArtifact, readMarketOpenStore } from './marketOpenStore.js';
import type { MarketOpenAttemptSlot, MarketOpenFire, MarketOpenStoreConfig } from './marketOpenStore.js';
import { configurationSha256, CONFIGURATION_DIGEST_VERSION } from './participantConfiguration.js';
import { validateResponseText, extractDecisionFingerprint, fingerprintFromParsed, compareFingerprints } from './schema.js';
import { computeFireSpendGuard } from './spendGuard.js';
import { ConservativeSpendUnknownError, deriveConservativeActualUsdMicros } from './conservativeSpend.js';
import { spendReservationPolicyForVersion } from './spendReservationPolicy.js';
import { instantMs } from './time.js';
import type { AttemptRecord } from './types.js';

export type MarketOpenRunEvidence = {
  readonly root: string; readonly artifactPath: string; readonly artifactSha256: string;
  readonly records: readonly Record<string, unknown>[];
  readonly fire: MarketOpenFire; readonly prepared: PreparedMarketOpenRun;
  readonly dailyBudget?: {
    readonly admissionPolicy: typeof MARKET_OPEN_DAILY_BUDGET_POLICY;
    readonly admissionPolicySha256: string;
    readonly spend: { readonly policyVersion: typeof MARKET_OPEN_DAILY_BUDGET_POLICY.version;
      readonly attempts: readonly { readonly slot: MarketOpenAttemptSlot; readonly costUsdMicros: number | null;
        readonly spend: DailyAttemptSpend }[] };
  };
};
type DailyAttemptSpend = {
  readonly policyVersion: typeof MARKET_OPEN_DAILY_BUDGET_POLICY.version;
  readonly estimateUsdMicros: number; readonly actualUsdMicros: number | null;
  readonly unknownCost: boolean; readonly aboveEstimate: boolean;
};
const genuine = new WeakSet<MarketOpenRunEvidence>();
type Row = Record<string, unknown>;
function object(value: unknown): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid market-open evidence object');
  return value as Row;
}
function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual === undefined || expected === undefined || canonicalize(actual) !== canonicalize(expected)) {
    throw new Error(`market-open ${label} mismatch`);
  }
}
function requireThat(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`market-open ${label}`);
}
function fields(row: Row, expected: Row, label: string): void {
  for (const [key, value] of Object.entries(expected)) equal(row[key], value, `${label}.${key}`);
}

/** B2 calls a fully settled model-arm failure `failed`, not `completed`.
 * Preserve those denominators, but never admit operational failed/unknown/refused
 * fires or promote their status. Every accepted fire must have a complete install. */
function installedOutcome(fire: MarketOpenFire): boolean {
  return fire.terminalArtifact !== null && (fire.status === 'completed' ||
    (fire.status === 'failed' && fire.reason === 'arm_outcome_failure'));
}

/** Enumerate the journal, not artifact filenames/mtimes. An empty real directory
 * is an empty source; a partial initialization or corrupt root fails closed.
 * The root is an operator-owned trust boundary, not cryptographic attestation. */
export function discoverMarketOpenRuns(rootInput: string): MarketOpenRunEvidence[] {
  const root = resolve(rootInput);
  requireThat(lstatSync(root).isDirectory() && realpathSync(root) === root, 'invalid evidence root');
  if (readdirSync(root).length === 0) return [];
  const { config, snapshot } = readMarketOpenStore(root);
  return snapshot.fires.filter(installedOutcome)
    .sort((a, b) => a.claim.eventId < b.claim.eventId ? -1 : a.claim.eventId > b.claim.eventId ? 1 : 0)
    .map((fire) => admit(config, fire));
}

export function readMarketOpenRun(root: string, artifactPath: string): MarketOpenRunEvidence {
  const target = resolve(artifactPath);
  const { config, snapshot } = readMarketOpenStore(root);
  const matches = snapshot.fires.filter((f) => installedOutcome(f) && f.terminalArtifact?.path === target);
  requireThat(matches.length === 1, 'target is not a completed journal-installed artifact');
  return admit(config, matches[0]!);
}

/** Authentication precedes every property read. A structural copy, caller-minted
 * wrapper, or extracted subset cannot become evidence. Re-read the exact target
 * before use so a deleted/tampered root cannot retain admission through a cache. */
export function assertMarketOpenRecords(records: readonly Row[], evidence: MarketOpenRunEvidence | undefined): void {
  requireThat(evidence !== undefined && genuine.has(evidence), 'requires genuine locally read completed evidence');
  assertMarketOpenJson(records);
  equal(records, evidence.records, 'exact canonical records');
  const current = readMarketOpenRun(evidence.root, evidence.artifactPath);
  equal(current.artifactSha256, evidence.artifactSha256, 'immutable artifact');
  equal(current.fire, evidence.fire, 'immutable fire');
}

function admit(config: MarketOpenStoreConfig, fire: MarketOpenFire): MarketOpenRunEvidence {
  // The persisted policy selects the verifier, never a caller or artifact label.
  // Daily ledger genesis retains the first cohort only; each claim owns its cohort.
  const daily = config.dailyBudgetVersion !== undefined;
  const admissionPolicy = daily ? MARKET_OPEN_DAILY_BUDGET_POLICY : MARKET_OPEN_ADMISSION_POLICY;
  const admissionPolicySha256 = daily ? MARKET_OPEN_DAILY_BUDGET_POLICY_SHA256 : MARKET_OPEN_ADMISSION_POLICY_SHA256;
  const genesisCohort = createMarketOpenCohort(config);
  fields(config, { ...genesisCohort, admissionPolicySha256 }, 'config');
  if (daily) equal(config.dailyBudgetVersion, MARKET_OPEN_DAILY_BUDGET_POLICY.version, 'daily budget version');
  const cohort = daily ? createMarketOpenCohort(fire.claim.preparation) : genesisCohort;
  const prepared = prepareMarketOpenRun({ ...fire.claim.preparation, historyRows: fire.claim.preparation.historyRows, cohort });
  requireThat(prepared.state === 'prepared', 'claim history no longer prepares');
  const run = prepared.run; const p = run.provenance; const request = run.request;
  fields(fire.claim, { eventId: p.event.eventId, runId: p.runId, sourceSha256: p.source.sha256,
    requestSha256: p.requestSha256, gameSha256: p.gameSha256, policySha256: p.policySha256,
    reservationUsdMicros: p.reservationUsdMicros,
    slots: MARKET_OPEN_POLICY.roster.flatMap((arm) => (['initial', 'repair'] as const).map((role) => ({
      armId: arm.participantId, role, ordinal: role === 'initial' ? 0 : 1 }))) }, 'claim preparation');
  requireThat(fire.admitted && installedOutcome(fire) && fire.artifactInstalledAt !== null, 'incomplete admission');
  requireThat(instantMs(fire.claimedAt) >= instantMs(p.observedAt), 'claim predates observation');
  const ref = fire.terminalArtifact!;
  equal(ref.path, join(config.root, 'artifacts', `${p.event.eventId}.json`), 'artifact event path');
  const bytes = readMarketOpenArtifact(config.root, ref);
  const doc = object(JSON.parse(bytes.toString('utf8')));
  assertMarketOpenJson(doc);
  requireThat(bytes.equals(Buffer.from(canonicalize(doc) + '\n')), 'noncanonical artifact bytes');
  equal(Object.keys(doc).sort(), ['version', 'admissionPolicy', 'admissionPolicySha256', 'eventId', 'runId', 'records', 'spend', 'admission'].sort(), 'artifact shape');
  fields(doc, { version: daily ? 'market-open-daily-produced-v1' : 'market-open-produced-v1', admissionPolicy,
    admissionPolicySha256: config.admissionPolicySha256, eventId: p.event.eventId, runId: p.runId }, 'artifact identity');
  equal(doc.admission, { ...fire, status: 'running', reason: null, terminalArtifact: null, artifactInstalledAt: null }, 'pre-install admission');
  requireThat(Array.isArray(doc.records), 'missing records');
  const records = doc.records.map(object);
  const byType = (type: string) => records.filter((r) => r.recordType === type);
  requireThat(byType('run_meta').length === 1 && byType('bundle_game').length === 1, 'metadata/game cardinality');
  const meta = byType('run_meta')[0]!;
  fields(meta, { runId: p.runId, cohortId: cohort.cohortId, mode: 'live', clockMode: 'wall',
    slateDate: cohort.slateDate, fetchStartedAt: p.observedAt, fetchCompletedAt: p.observedAt,
    marketOpen: p, slateSha256: run.build.slateSha256, bundleTimestamp: request.requestBundle.bundleTimestamp,
    slateCutoffAt: request.requestBundle.cutoffAt, executionPolicy: MARKET_OPEN_POLICY.executionPolicy,
    promptScaffoldVersion: MARKET_OPEN_POLICY.promptScaffoldVersion, promptScaffoldSha256: MARKET_OPEN_POLICY.promptScaffoldSha256,
    maxOutputTokens: admissionPolicy.maxOutputTokens,
    eligibleGames: 1, excludedGames: 0, armGameResults: MARKET_OPEN_POLICY.roster.length,
    baselinePolicyVersion: MARKET_OPEN_POLICY.baselinePolicyVersion,
    armRoster: MARKET_OPEN_POLICY.roster.map((arm) => ({ participantId: arm.participantId,
      provider: arm.provider, requestedModelId: arm.requestedModelId, configuration: arm.configuration,
      configurationSha256: configurationSha256(arm.configuration), configurationDigestVersion: CONFIGURATION_DIGEST_VERSION })) }, 'run metadata');
  requireThat(!('watch' in meta), 'watch provenance is not market-open evidence');
  requireThat(typeof meta.createdAt === 'string' && instantMs(meta.createdAt) <= instantMs(fire.artifactInstalledAt!), 'creation/install clock');
  fields(byType('bundle_game')[0]!, { gameId: request.gameId, bundle: request.game, gameSha256: p.gameSha256,
    requestSha256: p.requestSha256, cutoffAt: request.cutoffAt, slug: request.slug,
    sourceOddsRows: [], sourceOddsReference: marketOpenHistoryReference(p) }, 'immutable opener reference');
  for (const record of records) {
    equal(record.runId, p.runId, 'record run');
    requireThat(['run_meta', 'bundle_game', 'arm_game_response', 'decision', 'baseline_decision'].includes(String(record.recordType)), 'unexpected record type');
  }
  const common = { cohortId: cohort.cohortId, gameId: request.gameId, cutoffAt: request.cutoffAt };
  const baselines = runBaselines(run.build.slateBundle, MARKET_OPEN_POLICY.baselinePolicyVersion);
  equal(byType('baseline_decision').map((r) => {
    fields(r, { ...common, slateSha256: run.build.slateSha256, gameSha256: p.gameSha256, requestSha256: p.requestSha256 }, 'baseline identity');
    return Object.fromEntries(Object.keys(baselines[0]!).map((k) => [k, r[k]]));
  }), baselines, 'complete deterministic baselines');
  equal(meta.baselineDecisionCount, baselines.length, 'baseline count');
  const responses = byType('arm_game_response'); const decisions = byType('decision');
  equal(responses.map((r) => r.participantId), MARKET_OPEN_POLICY.roster.map((a) => a.participantId), 'complete response roster');
  const matched = new Set<string>();
  let expectedDecisions = 0;
  const perAttempt = spendReservationPolicyForVersion(MARKET_OPEN_POLICY.spendReservationPolicyVersion).providerAttemptReservationUsdMicros;
  const dailyEstimates = daily ? estimateMarketOpenDailyAttempts(run) : [];
  const dailySpendBySlot = new Map<string, DailyAttemptSpend>();
  MARKET_OPEN_POLICY.roster.forEach((arm, i) => {
    const response = responses[i]!;
    const identity = { ...common, participantId: arm.participantId, provider: arm.provider,
      requestedModelId: arm.requestedModelId, configurationSha256: configurationSha256(arm.configuration) };
    fields(response, { ...identity, requestSha256: p.requestSha256 }, 'response identity');
    const attempts = (['initial', 'repair'] as const).map((role) => {
      const raw = role === 'initial' ? response.attempt : response.repair;
      const durable = fire.attempts.find((a) => a.slot.armId === arm.participantId && a.slot.role === role);
      if (raw === null) { requireThat(role === 'repair' && durable === undefined, 'omitted initial/durable attempt'); return null; }
      const recorded = object(raw);
      requireThat(durable !== undefined && durable.finishedAt !== null && (daily || durable.costUsdMicros !== null), 'missing settled attempt');
      const e = object(durable.evidence);
      fields(e, { version: daily ? 'market-open-daily-attempt-v1' : 'market-open-attempt-v1', role, arm }, 'attempt identity');
      const a = object(e.attempt) as unknown as AttemptRecord;
      const { rawText, usage, ...rest } = a;
      equal({ ...recorded, acceptedAt: null }, { ...rest, answerText: rawText, tokens: usage }, 'durable response attempt');
      requireThat(a.acceptedAt === null, 'durable attempt accepted before validation');
      requireThat(instantMs(durable.startedAt) >= instantMs(fire.claimedAt), 'intent predates claim');
      requireThat(instantMs(durable.finishedAt) <= instantMs(meta.createdAt as string), 'settlement follows records');
      if (a.requestAt !== null) requireThat(instantMs(a.requestAt) >= instantMs(durable.startedAt) &&
        instantMs(a.requestAt) < instantMs(request.cutoffAt), 'send clock');
      if (a.responseAt !== null) requireThat(a.requestAt !== null && instantMs(a.responseAt) >= instantMs(a.requestAt) &&
        a.responseAt === durable.finishedAt, 'response clock');
      if (recorded.acceptedAt !== null) requireThat(typeof recorded.acceptedAt === 'string' && a.responseAt !== null &&
        instantMs(recorded.acceptedAt) >= instantMs(a.responseAt) && instantMs(recorded.acceptedAt) < instantMs(request.cutoffAt) &&
        instantMs(recorded.acceptedAt) <= instantMs(meta.createdAt as string), 'accepted clock');
      let cost: number | null = null;
      try {
        cost = a.requestAt === null ? 0 : deriveConservativeActualUsdMicros({ provider: arm.provider,
          requestedModelId: arm.requestedModelId, priceVersion: MARKET_OPEN_POLICY.priceVersion,
          usageRaw: a.usageRaw, searchCount: a.searchAudit?.searchCount ?? null });
      } catch (error) {
        if (!daily || !(error instanceof ConservativeSpendUnknownError)) throw error;
      }
      equal(durable.costUsdMicros, cost, 'billable attempt cost');
      if (daily) {
        const estimate = dailyEstimates.find((estimate) => canonicalize(estimate.slot) === canonicalize(durable.slot));
        requireThat(estimate !== undefined, 'missing daily attempt estimate');
        const spend = { policyVersion: MARKET_OPEN_DAILY_BUDGET_POLICY.version, estimateUsdMicros: estimate.usdMicros,
          actualUsdMicros: cost, unknownCost: cost === null, aboveEstimate: cost !== null && cost > estimate.usdMicros };
        equal(e.spend, spend, 'daily attempt spend');
        dailySpendBySlot.set(canonicalize(durable.slot), spend);
      } else {
        const guard = computeFireSpendGuard({ arms: [{ ...arm, billingClass: 'billable', attempt: guardAttempt(a), repair: null }],
          priceVersion: MARKET_OPEN_POLICY.priceVersion, perAttemptReservationUsdMicros: perAttempt });
        equal(e.spend, guard, 'attempt spend'); requireThat(guard.kind === 'pass', 'non-pass completed attempt spend');
      }
      matched.add(canonicalize(durable.slot));
      return recorded;
    });
    const armDecisions = decisions.filter((d) => d.participantId === arm.participantId);
    if (response.outcome === 'valid') {
      requireThat(typeof response.repairUsed === 'boolean', 'invalid repair selector');
      const accepted = attempts[response.repairUsed ? 1 : 0];
      requireThat(accepted !== null && accepted !== undefined && typeof accepted.answerText === 'string' &&
        accepted.acceptedAt !== null && accepted.turnCompleted === true, 'missing accepted attempt');
      const parsed = validateResponseText(accepted.answerText, request.requestBundle, p.requestSha256, arm, cohort.cohortId);
      requireThat(parsed.parsed !== null && parsed.errors.length === 0, 'accepted response validation');
      if (response.repairUsed) {
        const fingerprint = extractDecisionFingerprint(attempts[0]!.answerText as string, request.requestBundle);
        requireThat(fingerprint !== null && compareFingerprints(fingerprint, fingerprintFromParsed(parsed.parsed)).length === 0, 'repair changed decision');
      }
      const forecasts = parsed.parsed.games[0]!.forecasts;
      equal(armDecisions.length, forecasts.length, 'decision cardinality');
      expectedDecisions += forecasts.length;
      forecasts.forEach((forecast, index) => {
        const decision = armDecisions[index]!;
        fields(decision, { ...identity, slateSha256: run.build.slateSha256, gameSha256: p.gameSha256,
          bundleSha256: p.requestSha256, ...forecast, reasonCode: forecast.reasonCode ?? null,
          axes: forecast.axes ?? null, primaryAxis: forecast.primaryAxis ?? null, primaryExpectation: forecast.primaryExpectation ?? null,
          attemptUsed: response.repairUsed ? 'repair' : 'initial', outcome: 'valid' }, 'accepted decision');
        for (const key of ['requestAt', 'responseAt', 'acceptedAt', 'latencyMs', 'reportedModelId', 'providerResponseId', 'tokens', 'usageRaw', 'searchAudit']) {
          equal(decision[key], accepted[key], `decision attempt ${key}`);
        }
      });
    } else {
      requireThat(fire.status === 'failed' && armDecisions.length === 0, 'failed arm decision or clean failure relabel');
      requireThat(attempts.every((a) => a === null || a.acceptedAt === null), 'failed arm accepted clock');
    }
  });
  // Aggregate from the same durable initial/repair set, never from decision-only rows.
  const guardArms = MARKET_OPEN_POLICY.roster.map((arm) => {
    const get = (role: string) => fire.attempts.find((a) => a.slot.armId === arm.participantId && a.slot.role === role);
    const initial = object(get('initial')!.evidence).attempt as unknown as AttemptRecord;
    const repair = get('repair');
    return { ...arm, billingClass: 'billable' as const, attempt: guardAttempt(initial),
      repair: repair === undefined ? null : guardAttempt(object(repair.evidence).attempt as unknown as AttemptRecord) };
  });
  equal(matched.size, fire.attempts.length, 'complete attempt correspondence');
  equal(decisions.length, expectedDecisions, 'complete decision correspondence');
  equal(fire.status === 'failed', responses.some((r) => r.outcome !== 'valid'), 'terminal outcome');
  const dailyBudget = daily ? { admissionPolicy: MARKET_OPEN_DAILY_BUDGET_POLICY, admissionPolicySha256,
    spend: { policyVersion: MARKET_OPEN_DAILY_BUDGET_POLICY.version,
      attempts: fire.attempts.map((attempt) => ({ slot: attempt.slot, costUsdMicros: attempt.costUsdMicros,
        spend: dailySpendBySlot.get(canonicalize(attempt.slot))! })) } } : undefined;
  equal(doc.spend, dailyBudget?.spend ?? computeFireSpendGuard({ arms: guardArms, priceVersion: MARKET_OPEN_POLICY.priceVersion,
    perAttemptReservationUsdMicros: perAttempt }), 'aggregate spend');
  const timing = object(meta.marketOpenTiming);
  requireThat(Number.isSafeInteger(timing.observationToSendWarningMs) && (timing.observationToSendWarningMs as number) >= 0, 'invalid advisory threshold');
  const warning = timing.observationToSendWarningMs as number;
  const timings = fire.attempts.map((a) => {
    const attempt = object(object(a.evidence).attempt);
    const sendAt = attempt.requestAt as string | null;
    const lag = sendAt === null ? null : instantMs(sendAt) - instantMs(p.observedAt);
    return { armId: a.slot.armId, role: a.slot.role, intentAt: a.startedAt, sendAt, responseAt: attempt.responseAt,
      observationToSendLagMs: lag, lagWarning: lag !== null && lag > warning };
  });
  equal(timing, { openerPresentAt: p.source.row.captured_at, firstObservedAt: p.observedAt, claimedAt: fire.claimedAt,
    artifactInstalledAt: null, observationToSendWarningMs: warning, lagWarning: timings.some((a) => a.lagWarning), attempts: timings }, 'recomputed timing');
  const evidence = deepFreeze({ root: config.root, artifactPath: ref.path, artifactSha256: ref.sha256, records, fire, prepared: run,
    ...(dailyBudget === undefined ? {} : { dailyBudget }) });
  genuine.add(evidence); return evidence;
}
function guardAttempt(a: AttemptRecord) {
  return { requestAt: a.requestAt, usageRaw: a.usageRaw, searchCount: a.searchAudit?.searchCount ?? null };
}
