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
import { deriveConservativeActualUsdMicros } from './conservativeSpend.js';
import { spendReservationPolicyForVersion } from './spendReservationPolicy.js';
import { instantMs } from './time.js';
import type { MarketOpenCohort, PreparedMarketOpenRun } from './marketOpen.js';
import type { MarketOpenClaimInput, MarketOpenFire, MarketOpenAttemptSlot } from './marketOpenStore.js';
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
  root: string; name: string; slateDate: string; capUsdMicros: number;
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
type AdmissionResult = { state: 'admitted'; eventId: string } | { state: 'refused'; reason: string; eventId?: string };
export type MarketOpenProductionResult =
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
  private readonly admissionPolicy = MARKET_OPEN_ADMISSION_POLICY;
  private readonly admissionPolicySha256 = MARKET_OPEN_ADMISSION_POLICY_SHA256;
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
    this.nowMs = options.nowMs ?? Date.now;
    const warningMs = options.observationToSendWarningMs ?? MARKET_OPEN_MONITORING_DEFAULTS.observationToSendWarningMs;
    if (!Number.isSafeInteger(warningMs) || warningMs < 0) throw new Error('invalid observation-to-send warning threshold');
    this.observationToSendWarningMs = warningMs;
    this.artifactRoot = resolve(options.root);
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
      root: options.root, ...this.cohort, capUsdMicros: options.capUsdMicros,
      admissionPolicySha256: this.admissionPolicySha256,
    });
  }

  snapshot() { return this.store.snapshot(); }

  /** Read-only heartbeat payload for B3/B4 wiring; this library installs no monitor. */
  status() {
    const snapshot = this.store.snapshot();
    return { ...snapshot, fires: snapshot.fires.map((fire) => ({ ...fire, timing: this.timing(fire) })) };
  }

  private timing(fire: MarketOpenFire, preparedRun?: PreparedMarketOpenRun): MarketOpenTiming {
    const prepared = preparedRun === undefined ? prepareMarketOpenRun({ ...fire.claim.preparation, historyRows: fire.claim.preparation.historyRows, cohort: this.cohort }) : null;
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
    if (admitted.state === 'refused') return Promise.resolve(admitted);
    return this.resume(this.store.getFire(admitted.eventId)!);
  }

  /** Durable admission is separately callable so a reader can commit before
   * handing off to workers. It never sends; recover() drains admitted events. */
  admit(observation: MarketOpenObservation): AdmissionResult {
    this.assertOpen();
    const eventId = sha256Hex(canonicalize({ cohortId: this.cohort.cohortId,
      gameId: observation.game.gameId, market: observation.market }));
    const existing = this.store.getFire(eventId);
    if (existing !== undefined) return admissionOf(existing);
    const prepared = prepareMarketOpenRun({ cohort: this.cohort, ...observation });
    if (prepared.state === 'refused') return prepared;
    const run = prepared.run;
    const p = run.provenance;
    const claim: MarketOpenClaimInput = {
      eventId, runId: p.runId, sourceSha256: p.source.sha256, requestSha256: p.requestSha256,
      policySha256: p.policySha256, gameSha256: p.gameSha256, reservationUsdMicros: p.reservationUsdMicros,
      slots: MARKET_OPEN_POLICY.roster.flatMap((arm) => [slot(arm, 'initial'), slot(arm, 'repair')]),
      preparation: structuredClone({ name: this.cohort.name, slateDate: this.cohort.slateDate, ...observation }),
    };
    return admissionOf(this.store.claim(claim, new Date(this.nowMs()).toISOString()).fire);
  }

  /** Explicit recovery only: unsent claims use the persisted FIRST observation.
   * Constructor already marks interrupted running work unknown; it is not resent. */
  recover(): Promise<MarketOpenProductionResult[]> {
    this.assertOpen();
    const fires = this.store.snapshot().fires;
    return Promise.all(fires.map((fire) => this.resume(fire)));
  }

  async drain(): Promise<void> {
    const settled = await Promise.allSettled([...this.jobs.values()]);
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure !== undefined) throw failure.reason;
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
      historyRows: fire.claim.preparation.historyRows, cohort: this.cohort });
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
      void job().finally(() => { this.active--; this.pump(); });
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
      cohortId: this.cohort.cohortId, executionPolicy: MARKET_OPEN_POLICY.executionPolicy,
      baselinePolicyVersion: MARKET_OPEN_POLICY.baselinePolicyVersion,
      // Each send/response remains bounded by the real game deadline, not a made-up duration.
      timeoutMs: Math.max(1, instantMs(run.request.game.scheduledStartUtc) - this.nowMs()),
      maxOutputTokens: MARKET_OPEN_ADMISSION_POLICY.maxOutputTokens,
      nowMs: this.nowMs, attemptBoundary: boundary,
    };
    const envelope = await runSlate([...MARKET_OPEN_POLICY.roster], this.adapters, run.build.requests, options);
    const context: RunContext = {
      ...options, runId: run.provenance.runId, slateDate: this.cohort.slateDate,
      mode: 'live', clockMode: 'wall', createdAt: new Date(this.nowMs()).toISOString(),
      fetchStartedAt: run.provenance.observedAt, fetchCompletedAt: run.provenance.observedAt,
      marketOpen: run.provenance, marketOpenTiming: this.timing(this.store.getFire(id)!, run),
    };
    const receipt = this.store.recordReceipt(id, run, envelope);
    authorizeMarketOpenProducerRecords(run, envelope, context, receipt);
    const records = buildRecords(envelope, context, run.build, { failures: [], warnings: [] });
    const spend = computeFireSpendGuard({
      arms: envelope.results.map((r) => ({ participantId: r.arm.participantId, provider: r.arm.provider,
        requestedModelId: r.arm.requestedModelId, billingClass: 'billable' as const,
        attempt: guardAttempt(r.attempt), repair: r.repair === null ? null : guardAttempt(r.repair) })),
      priceVersion: MARKET_OPEN_POLICY.priceVersion, perAttemptReservationUsdMicros: perAttempt,
    });
    const bytes = Buffer.from(canonicalize({ version: 'market-open-produced-v1',
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
