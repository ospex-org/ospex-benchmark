import { join, resolve } from 'node:path';
import { canonicalize, sha256Hex } from './canonical.js';
import { deepFreeze } from './freeze.js';
import { installBytesNoClobber, nodeArtifactFs } from './fireArtifactSink.js';
import { assertPreparedMarketOpenRun, createMarketOpenCohort, MARKET_OPEN_POLICY, prepareMarketOpenRun } from './marketOpen.js';
import { authorizeMarketOpenProducerRecords } from './marketOpenRecordBoundary.js';
import { MarketOpenStore } from './marketOpenStore.js';
import { buildRecords } from './records.js';
import { runSlate } from './runner.js';
import { computeFireSpendGuard } from './spendGuard.js';
import { ConservativeSpendUnknownError, deriveConservativeActualUsdMicros } from './conservativeSpend.js';
import { assertDailyBudgetCap, computeDailyBudgetStatus, estimateMarketOpenDailyAttempts,
  MARKET_OPEN_DAILY_BUDGET_POLICY, MARKET_OPEN_DAILY_BUDGET_POLICY_SHA256 } from './marketOpenDailyBudget.js';
import type { DailyBudgetStatus } from './marketOpenDailyBudget.js';
import { spendReservationPolicyForVersion } from './spendReservationPolicy.js';
import { instantMs } from './time.js';
import { easternCalendarDay } from './slateDate.js';
import type { MarketOpenCohort, PreparedMarketOpenRun } from './marketOpen.js';
import type { MarketOpenClaimInput, MarketOpenFire, MarketOpenAttemptSlot, MarketOpenDailyObservation } from './marketOpenStore.js';
import type { RunContext } from './records.js';
import type { AttemptBoundary } from './runner.js';
import type { ArmSpec, AttemptRecord, GamesEndpointRow, MarketKey, ProviderAdapter, ProviderName } from './types.js';

/** Timestamps, not trip wires: elapsed lag is advisory, never send authority.
 * Monitoring configuration is recorded, never part of durable send authority. */
export const MARKET_OPEN_ADMISSION_POLICY = deepFreeze({
  version: 'market-open-admission-v2',
  workers: 2, transportDeadline: 'first-pitch', maxOutputTokens: 6_000,
  unknownSpend: 'halt-cohort', recovery: 'never-replay-started-attempt',
} as const);
export const MARKET_OPEN_ADMISSION_POLICY_SHA256 = sha256Hex(canonicalize(MARKET_OPEN_ADMISSION_POLICY));

export const MARKET_OPEN_MONITORING_DEFAULTS = deepFreeze({ observationToSendWarningMs: 120_000 });

export interface MarketOpenObservation {
  game: GamesEndpointRow; market: MarketKey; historyRows: unknown; observedAt: string;
}
export interface MarketOpenProducerOptions {
  root: string; name: string; slateDate: string; capUsdMicros: number | null;
  /** New explicit policy. ledgerRoot MUST be shared across names/slate dates.
   * Its existing exclusive writer lock also bounds workers across cohorts.
   * All daily artifacts live there. Legacy capUsdMicros is ignored in this mode. */
  dailyBudget?: { capUsdMicros: number; ledgerRoot: string };
  /** Trusted transport boundary. No provider factory, environment or credential IO here. */
  adapters: ReadonlyMap<string, ProviderAdapter>;
  nowMs?: () => number;
  /** Monitoring threshold only. No expiry, refusal, retry or reservation effect. */
  observationToSendWarningMs?: number;
}
export interface MarketOpenTiming {
  openerPresentAt: string; firstObservedAt: string; claimedAt: string;
  artifactInstalledAt: string | null; observationToSendWarningMs: number; lagWarning: boolean;
  attempts: Array<{ armId: string; role: 'initial' | 'repair'; intentAt: string;
    sendAt: string | null; responseAt: string | null; observationToSendLagMs: number | null; lagWarning: boolean }>;
}
type HeldResult = { state: 'held'; reason: string; eventId: string; artifactPath?: string | null };
type AdmissionResult = { state: 'admitted'; eventId: string } | { state: 'refused'; reason: string; eventId?: string } | HeldResult;
export type MarketOpenProductionResult =
  | HeldResult
  | { state: 'refused'; reason: string; eventId?: string; artifactPath?: string | null }
  | { state: 'completed' | 'failed' | 'unknown' | 'claimed' | 'running'; eventId: string; artifactPath: string | null };

/** Single in-process scheduler under the store's exclusive on-disk writer lock.
 * Admission is synchronous and atomic; HTTP work is independent and bounded.
 * Call observe without awaiting sibling observations; drain at the batch boundary.
 * No service, CLI, polling loop or automatic provider construction is installed. */
export class MarketOpenProducer {
  readonly cohort: MarketOpenCohort;
  private readonly store: MarketOpenStore;
  private readonly adapters: Map<string, ProviderAdapter>;
  private readonly artifactRoot: string;
  private readonly nowMs: () => number;
  private readonly admissionPolicy: typeof MARKET_OPEN_ADMISSION_POLICY | typeof MARKET_OPEN_DAILY_BUDGET_POLICY;
  private readonly admissionPolicySha256: string;
  private dailyCapUsdMicros: number | null;
  private readonly observationToSendWarningMs: number;
  // The actual send reading is immediately visible to status while HTTP is pending.
  // It becomes durable in the existing settled evidence, never a new send transition.
  private readonly activeAttempts = new Map<string, string>();
  private readonly jobs = new Map<string, Promise<MarketOpenProductionResult>>();
  private readonly queue: Array<() => Promise<void>> = [];
  private active = 0;
  private closed = false;
  private fault: unknown = null;

  constructor(options: MarketOpenProducerOptions) {
    this.cohort = createMarketOpenCohort(options);
    this.dailyCapUsdMicros = options.dailyBudget?.capUsdMicros ?? null;
    if (options.dailyBudget !== undefined) {
      assertDailyBudgetCap(options.dailyBudget.capUsdMicros);
      if (!options.dailyBudget.ledgerRoot) throw new Error('shared daily ledgerRoot required');
    }
    this.admissionPolicy = options.dailyBudget ? MARKET_OPEN_DAILY_BUDGET_POLICY : MARKET_OPEN_ADMISSION_POLICY;
    this.admissionPolicySha256 = options.dailyBudget ? MARKET_OPEN_DAILY_BUDGET_POLICY_SHA256 : MARKET_OPEN_ADMISSION_POLICY_SHA256;
    this.nowMs = options.nowMs ?? Date.now;
    const warningMs = options.observationToSendWarningMs ?? MARKET_OPEN_MONITORING_DEFAULTS.observationToSendWarningMs;
    if (!Number.isSafeInteger(warningMs) || warningMs < 0) throw new Error('invalid observation-to-send warning threshold');
    this.observationToSendWarningMs = warningMs;
    this.artifactRoot = resolve(options.dailyBudget?.ledgerRoot ?? options.root);
    this.adapters = new Map(options.adapters);
    for (const arm of MARKET_OPEN_POLICY.roster) {
      const adapter = this.adapters.get(arm.participantId);
      if (adapter === undefined || adapter.provider !== arm.provider || adapter.requestedModelId !== arm.requestedModelId) {
        throw new Error(`missing or mismatched market-open adapter: ${arm.participantId}`);
      }
      this.adapters.set(arm.participantId, Object.freeze({ provider: adapter.provider,
        requestedModelId: adapter.requestedModelId, credentialEnvVar: adapter.credentialEnvVar,
        hasCredential: adapter.hasCredential.bind(adapter), chat: adapter.chat.bind(adapter) }));
    }
    this.store = new MarketOpenStore({
      root: this.artifactRoot, ...this.cohort, capUsdMicros: this.dailyCapUsdMicros ?? options.capUsdMicros!,
      admissionPolicySha256: this.admissionPolicySha256,
      ...(options.dailyBudget ? { dailyBudgetVersion: MARKET_OPEN_DAILY_BUDGET_POLICY.version } : {}),
    });
  }

  snapshot() { return this.store.snapshot(); }

  /** Pure/read-only: no rollover write, claim, or send. */
  dailyBudgetStatus(): DailyBudgetStatus | null {
    return this.dailyCapUsdMicros === null ? null : computeDailyBudgetStatus(this.store.snapshot(),
      new Date(this.nowMs()).toISOString(), this.dailyCapUsdMicros);
  }

  /** Hot reload and <=60s tick entry point. Queues work but never waits for HTTP. */
  async refreshDailyBudget(capUsdMicros: number): Promise<DailyBudgetStatus> {
    this.assertOpen();
    if (this.dailyCapUsdMicros === null) throw new Error('not a daily budget producer');
    assertDailyBudgetCap(capUsdMicros); this.dailyCapUsdMicros = capUsdMicros;
    this.scheduleDaily();
    return this.dailyBudgetStatus()!;
  }

  private scheduleDaily(): void {
    if (this.dailyCapUsdMicros === null || this.closed || this.fault !== null) return;
    this.store.updateDailyBudget(new Date(this.nowMs()).toISOString(), this.dailyCapUsdMicros);
    // Includes previously admitted unsent claims from EVERY cohort in this ledger.
    for (const fire of this.store.snapshot().fires) if (fire.status === 'claimed') void this.resume(fire);
    const pending = this.store.snapshot().dailyBudget!.observations.filter((o) => o.state === 'held')
      .sort((a, b) => instantMs(a.input.preparation.game.matchTime) - instantMs(b.input.preparation.game.matchTime) ||
        instantMs(a.input.preparation.observedAt) - instantMs(b.input.preparation.observedAt) || a.input.eventId.localeCompare(b.input.eventId));
    for (const observation of pending) {
      const evaluated = this.store.evaluateDaily(observation.input.eventId, new Date(this.nowMs()).toISOString(), this.dailyCapUsdMicros);
      if (evaluated.state === 'admitted') void this.resume(this.store.getFire(evaluated.input.eventId)!);
    }
  }

  /** Read-only heartbeat payload for B3/B4 wiring; this library installs no monitor. */
  status() {
    const snapshot = this.store.snapshot();
    return { ...snapshot, fires: snapshot.fires.map((fire) => ({ ...fire, timing: this.timing(fire) })) };
  }

  private timing(fire: MarketOpenFire, preparedRun?: PreparedMarketOpenRun): MarketOpenTiming {
    const prepared = preparedRun === undefined ? prepareMarketOpenRun({ ...fire.claim.preparation, historyRows: fire.claim.preparation.historyRows, cohort: createMarketOpenCohort(fire.claim.preparation) }) : null;
    const run = preparedRun ?? (prepared?.state === 'prepared' ? prepared.run : undefined);
    if (run === undefined) throw new Error('persisted timing source does not prepare');
    const attempts = fire.attempts.map((a) => {
      const evidence = a.evidence as { attempt?: AttemptRecord } | null;
      const sendAt = evidence?.attempt?.requestAt ?? this.activeAttempts.get(canonicalize({ eventId: fire.claim.eventId, ...a.slot })) ?? null;
      const observationToSendLagMs = sendAt === null ? null : instantMs(sendAt) - instantMs(run.provenance.observedAt);
      return { armId: a.slot.armId, role: a.slot.role, intentAt: a.startedAt, sendAt,
        responseAt: evidence?.attempt?.responseAt ?? null, observationToSendLagMs,
        lagWarning: observationToSendLagMs !== null && observationToSendLagMs > this.observationToSendWarningMs };
    });
    return { openerPresentAt: run.provenance.source.row.captured_at, firstObservedAt: run.provenance.observedAt,
      claimedAt: fire.claimedAt, artifactInstalledAt: fire.artifactInstalledAt,
      observationToSendWarningMs: this.observationToSendWarningMs,
      lagWarning: attempts.some((a) => a.lagWarning), attempts };
  }

  /** The first eligible preparation, including exact observedAt, is persisted
   * before queuing. Duplicate observations never replace its source or clock. */
  observe(observation: MarketOpenObservation): Promise<MarketOpenProductionResult> {
    const admitted = this.admit(observation);
    if (admitted.state !== 'admitted') return Promise.resolve(admitted);
    return this.resume(this.store.getFire(admitted.eventId)!);
  }

  /** Durable admission is separately callable so a reader can commit before
   * handing off to workers. It never sends; recover() drains admitted events. */
  admit(observation: MarketOpenObservation): AdmissionResult {
    this.assertOpen();
    const cohort = this.dailyCapUsdMicros === null ? this.cohort : createMarketOpenCohort({
      name: this.cohort.name, slateDate: easternCalendarDay(observation.game.matchTime) });
    const eventId = sha256Hex(canonicalize({ cohortId: cohort.cohortId,
      gameId: observation.game.gameId, market: observation.market }));
    const existing = this.store.getFire(eventId);
    if (existing !== undefined) return admissionOf(existing);
    if (this.dailyCapUsdMicros !== null) {
      const held = this.store.getDailyObservation(eventId);
      if (held !== undefined) return dailyAdmissionOf(this.store.evaluateDaily(eventId, new Date(this.nowMs()).toISOString(), this.dailyCapUsdMicros));
    }
    const prepared = prepareMarketOpenRun({ cohort, ...observation });
    if (prepared.state === 'refused') return prepared;
    const run = prepared.run;
    const p = run.provenance;
    const claim: MarketOpenClaimInput = {
      eventId, runId: p.runId, sourceSha256: p.source.sha256, requestSha256: p.requestSha256,
      policySha256: p.policySha256, gameSha256: p.gameSha256, reservationUsdMicros: p.reservationUsdMicros,
      slots: MARKET_OPEN_POLICY.roster.flatMap((arm) => [slot(arm, 'initial'), slot(arm, 'repair')]),
      preparation: structuredClone({ name: cohort.name, slateDate: cohort.slateDate, ...observation }),
    };
    const at = new Date(this.nowMs()).toISOString();
    if (this.dailyCapUsdMicros !== null) {
      this.store.observeDaily(claim, estimateMarketOpenDailyAttempts(run), at);
      return dailyAdmissionOf(this.store.evaluateDaily(eventId, at, this.dailyCapUsdMicros));
    }
    return admissionOf(this.store.claim(claim, at).fire);
  }

  /** Explicit recovery only: unsent claims use the persisted FIRST observation.
   * Constructor already marks interrupted running work unknown; it is not resent. */
  recover(): Promise<MarketOpenProductionResult[]> {
    this.assertOpen();
    this.scheduleDaily();
    const fires = this.store.snapshot().fires;
    return Promise.all(fires.map((fire) => this.resume(fire)));
  }

  async drain(): Promise<void> {
    let size: number;
    do {
      size = this.jobs.size;
      const settled = await Promise.allSettled([...this.jobs.values()]);
      const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failure !== undefined) throw failure.reason;
      // Worker finally callbacks may enqueue freshly affordable held work.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    } while (this.jobs.size !== size);
    if (this.fault !== null) throw this.fault;
  }

  async close(): Promise<void> {
    this.closed = true;
    try { await this.drain(); } finally { this.store.close(); }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('market-open producer is closed');
    if (this.fault !== null) throw this.fault;
  }

  private resume(fire: MarketOpenFire): Promise<MarketOpenProductionResult> {
    const id = fire.claim.eventId;
    const inFlight = this.jobs.get(id);
    if (inFlight !== undefined) return inFlight;
    if (fire.status !== 'claimed') return Promise.resolve(resultOf(fire));
    const prepared = prepareMarketOpenRun({ ...fire.claim.preparation,
      historyRows: fire.claim.preparation.historyRows, cohort: createMarketOpenCohort(fire.claim.preparation) });
    if (prepared.state !== 'prepared') throw new Error(`persisted market-open preparation refused: ${prepared.reason}`);
    const run = prepared.run;
    if (run.provenance.requestSha256 !== fire.claim.requestSha256 ||
        run.provenance.source.sha256 !== fire.claim.sourceSha256 || run.provenance.runId !== fire.claim.runId) {
      throw new Error('persisted market-open preparation identity drift');
    }
    let resolve!: (result: MarketOpenProductionResult) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<MarketOpenProductionResult>((ok, no) => { resolve = ok; reject = no; });
    // The producer owns the rejection until a caller awaits it; no unhandled-rejection
    // race if a later observation causes one job to fail before drain is called.
    void promise.catch(() => {});
    this.jobs.set(id, promise);
    this.queue.push(async () => {
      try { resolve(await this.produce(run)); }
      catch (error) {
        this.fault = error;
        try { this.store.markUnknown(id, 'producer_or_durability_failure'); } catch { /* original error wins; store retains poisoned lock */ }
        reject(error);
      }
    });
    queueMicrotask(() => this.pump());
    return promise;
  }

  private pump(): void {
    while (this.active < MARKET_OPEN_ADMISSION_POLICY.workers && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active++;
      void job().finally(() => {
        this.active--;
        try { this.scheduleDaily(); this.pump(); } catch (error) { this.fault = error; }
      });
    }
  }

  private refusal(run: PreparedMarketOpenRun, at: string): string | null {
    if (this.fault !== null || this.store.snapshot().halted) return 'cohort_halted';
    const atMs = instantMs(at);
    if (atMs >= instantMs(run.request.game.scheduledStartUtc)) return 'at_or_after_first_pitch';
    return null;
  }

  private async produce(run: PreparedMarketOpenRun): Promise<MarketOpenProductionResult> {
    assertPreparedMarketOpenRun(run);
    const id = run.provenance.event.eventId;
    const refusal = this.refusal(run, new Date(this.nowMs()).toISOString());
    if (refusal !== null) {
      this.store.refuse(id, refusal);
      return resultOf(this.store.getFire(id)!);
    }
    const perAttempt = spendReservationPolicyForVersion(MARKET_OPEN_POLICY.spendReservationPolicyVersion)
      .providerAttemptReservationUsdMicros;
    const boundary: AttemptBoundary = {
      begin: (arm, role, at) => {
        const reason = this.refusal(run, at);
        if (reason !== null) return reason;
        this.store.beginAttempt({ eventId: id, slot: slot(arm, role), startedAt: at });
        return null;
      },
      confirm: (arm, role, at) => {
        const reason = this.refusal(run, at);
        if (reason === null) this.activeAttempts.set(attemptKey(id, arm, role), at);
        return reason;
      },
      settled: (arm, role, attempt) => {
        if (this.dailyCapUsdMicros !== null) {
          let cost: number | null = null;
          try {
            cost = attempt.requestAt === null ? 0 : deriveConservativeActualUsdMicros({ provider: arm.provider,
              requestedModelId: arm.requestedModelId, priceVersion: MARKET_OPEN_POLICY.priceVersion,
              usageRaw: attempt.usageRaw, searchCount: attempt.searchAudit?.searchCount ?? null });
          } catch (error) { if (!(error instanceof ConservativeSpendUnknownError)) throw error; }
          const estimate = this.store.getDailyObservation(id)!.estimates.find((e) => canonicalize(e.slot) === canonicalize(slot(arm, role)))!;
          this.store.finishAttempt({ eventId: id, slot: slot(arm, role),
            finishedAt: attempt.responseAt ?? new Date(this.nowMs()).toISOString(), costUsdMicros: cost,
            evidence: { version: 'market-open-daily-attempt-v1', role, arm, attempt, spend: {
              policyVersion: MARKET_OPEN_DAILY_BUDGET_POLICY.version, estimateUsdMicros: estimate.usdMicros,
              actualUsdMicros: cost, unknownCost: cost === null, aboveEstimate: cost !== null && cost > estimate.usdMicros } } });
          this.activeAttempts.delete(attemptKey(id, arm, role));
          return;
        }
        // Real admission always uses billable accounting, even in synthetic tests.
        // Never copy B1's closed mock-only known-zero classification here.
        const guard = computeFireSpendGuard({ arms: [{ participantId: arm.participantId,
          provider: arm.provider, requestedModelId: arm.requestedModelId,
          billingClass: 'billable', attempt: guardAttempt(attempt), repair: null }],
          priceVersion: MARKET_OPEN_POLICY.priceVersion, perAttemptReservationUsdMicros: perAttempt });
        const cost = guard.kind === 'unknown' ? null : attempt.requestAt === null ? 0
          : deriveConservativeActualUsdMicros({ provider: arm.provider, requestedModelId: arm.requestedModelId,
              priceVersion: MARKET_OPEN_POLICY.priceVersion, usageRaw: attempt.usageRaw,
              searchCount: attempt.searchAudit?.searchCount ?? null });
        this.store.finishAttempt({ eventId: id, slot: slot(arm, role),
          finishedAt: attempt.responseAt ?? new Date(this.nowMs()).toISOString(),
          costUsdMicros: cost,
          evidence: { version: 'market-open-attempt-v1', role, arm, attempt, spend: guard } });
        this.activeAttempts.delete(attemptKey(id, arm, role));
        if (guard.kind === 'breach' && this.store.snapshot().halted === null) {
          this.store.markUnknown(id, 'per_attempt_reservation_breach');
        }
      },
    };
    const options = {
      cohortId: run.cohort.cohortId, executionPolicy: MARKET_OPEN_POLICY.executionPolicy,
      baselinePolicyVersion: MARKET_OPEN_POLICY.baselinePolicyVersion,
      // Each send/response remains bounded by the real game deadline, not a made-up duration.
      timeoutMs: Math.max(1, instantMs(run.request.game.scheduledStartUtc) - this.nowMs()),
      maxOutputTokens: MARKET_OPEN_ADMISSION_POLICY.maxOutputTokens,
      nowMs: this.nowMs, attemptBoundary: boundary,
    };
    const envelope = await runSlate([...MARKET_OPEN_POLICY.roster], this.adapters, run.build.requests, options);
    const context: RunContext = {
      ...options, runId: run.provenance.runId, slateDate: run.cohort.slateDate,
      mode: 'live', clockMode: 'wall', createdAt: new Date(this.nowMs()).toISOString(),
      fetchStartedAt: run.provenance.observedAt, fetchCompletedAt: run.provenance.observedAt,
      marketOpen: run.provenance, marketOpenTiming: this.timing(this.store.getFire(id)!, run),
    };
    const receipt = this.store.recordReceipt(id, run, envelope);
    authorizeMarketOpenProducerRecords(run, envelope, context, receipt);
    const records = buildRecords(envelope, context, run.build, { failures: [], warnings: [] });
    const spend = this.dailyCapUsdMicros !== null ? { policyVersion: MARKET_OPEN_DAILY_BUDGET_POLICY.version,
      attempts: this.store.getFire(id)!.attempts.map((a) => ({ slot: a.slot, costUsdMicros: a.costUsdMicros,
        spend: (a.evidence as { spend: unknown }).spend })) } : computeFireSpendGuard({
      arms: envelope.results.map((r) => ({ participantId: r.arm.participantId, provider: r.arm.provider,
        requestedModelId: r.arm.requestedModelId, billingClass: 'billable' as const,
        attempt: guardAttempt(r.attempt), repair: r.repair === null ? null : guardAttempt(r.repair) })),
      priceVersion: MARKET_OPEN_POLICY.priceVersion, perAttemptReservationUsdMicros: perAttempt,
    });
    const bytes = Buffer.from(canonicalize({ version: this.dailyCapUsdMicros === null ? 'market-open-produced-v1' : 'market-open-daily-produced-v1',
      admissionPolicy: this.admissionPolicy, admissionPolicySha256: this.admissionPolicySha256,
      eventId: id, runId: run.provenance.runId, records, spend,
      admission: this.store.getFire(id),
    }) + '\n', 'utf8');
    const dir = join(this.artifactRoot, 'artifacts');
    const installed = installBytesNoClobber(nodeArtifactFs, { dir, finalPath: join(dir, `${id}.json`),
      tmpStem: id, buffer: bytes, label: 'market-open produced artifact' });
    // The immutable artifact is present AND durable before terminal state advances.
    const artifactInstalledAt = new Date(this.nowMs()).toISOString();
    const reference = { path: installed.path, sha256: sha256Hex(bytes.toString('utf8')) };
    const latest = this.store.getFire(id)!;
    if (latest.status === 'running' || latest.status === 'claimed') {
      if (envelope.results.some((r) => r.outcome !== 'valid')) this.store.fail(id, 'arm_outcome_failure');
    }
    // Dirty terminals also bind their evidence, without promoting to completed.
    this.store.complete(id, reference, artifactInstalledAt);
    return { ...resultOf(this.store.getFire(id)!), artifactPath: installed.path };
  }
}

function dailyAdmissionOf(observation: MarketOpenDailyObservation): AdmissionResult {
  const eventId = observation.input.eventId;
  if (observation.state === 'admitted') return { state: 'admitted', eventId };
  if (observation.state === 'expired') return { state: 'refused', eventId, reason: 'daily_budget_held_expired' };
  return { state: 'held', eventId, reason: observation.reason ?? 'daily_budget_reached' };
}
function admissionOf(fire: MarketOpenFire): AdmissionResult {
  return fire.status === 'refused'
    ? { state: 'refused', eventId: fire.claim.eventId, reason: fire.reason ?? 'refused' }
    : { state: 'admitted', eventId: fire.claim.eventId };
}
function attemptKey(eventId: string, arm: ArmSpec, role: 'initial' | 'repair'): string {
  return canonicalize({ eventId, ...slot(arm, role) });
}
function slot(arm: ArmSpec, role: 'initial' | 'repair'): MarketOpenAttemptSlot {
  return { armId: arm.participantId, role, ordinal: role === 'initial' ? 0 : 1 };
}
function guardAttempt(attempt: AttemptRecord) {
  return { requestAt: attempt.requestAt, usageRaw: attempt.usageRaw,
    searchCount: attempt.searchAudit?.searchCount ?? null };
}
function resultOf(fire: MarketOpenFire): MarketOpenProductionResult {
  if (fire.status === 'refused') return { state: 'refused', eventId: fire.claim.eventId, reason: fire.reason ?? 'refused',
    artifactPath: fire.terminalArtifact?.path ?? null };
  return { state: fire.status, eventId: fire.claim.eventId, artifactPath: fire.terminalArtifact?.path ?? null };
}
