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

/** Proposed for R3: two minutes inclusive from FIRST eligible observation to
 * EACH HTTP start, including repairs. This does not change B1 policy bytes. */
export const MARKET_OPEN_ADMISSION_POLICY = deepFreeze({
  version: 'market-open-admission-v1', maxObservationToSendLagMs: 120_000,
  workers: 2, timeoutMs: 60_000, maxOutputTokens: 6_000,
  unknownSpend: 'halt-cohort', recovery: 'never-replay-started-attempt',
} as const);
export const MARKET_OPEN_ADMISSION_POLICY_SHA256 = sha256Hex(canonicalize(MARKET_OPEN_ADMISSION_POLICY));

export interface MarketOpenObservation {
  game: GamesEndpointRow; market: MarketKey; historyRows: unknown; observedAt: string;
}
export interface MarketOpenProducerOptions {
  root: string; name: string; slateDate: string; capUsdMicros: number;
  /** Trusted transport boundary. No provider factory, environment or credential IO here. */
  adapters: ReadonlyMap<string, ProviderAdapter>;
  nowMs?: () => number;
}
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
  private readonly jobs = new Map<string, Promise<MarketOpenProductionResult>>();
  private readonly queue: Array<() => Promise<void>> = [];
  private active = 0;
  private closed = false;
  private fault: unknown = null;

  constructor(options: MarketOpenProducerOptions) {
    this.cohort = createMarketOpenCohort(options);
    this.nowMs = options.nowMs ?? Date.now;
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
      admissionPolicySha256: MARKET_OPEN_ADMISSION_POLICY_SHA256,
    });
  }

  snapshot() { return this.store.snapshot(); }

  /** The first eligible preparation, including exact observedAt, is persisted
   * before queuing. Duplicate observations never replace its source or clock. */
  observe(observation: MarketOpenObservation): Promise<MarketOpenProductionResult> {
    const admitted = this.admit(observation);
    if (admitted.state === 'refused') return Promise.resolve(admitted);
    return this.resume(this.store.getFire(admitted.eventId)!);
  }

  /** Durable admission is separately callable so a reader can commit before
   * handing off to workers. It never sends; recover() drains admitted events. */
  admit(observation: MarketOpenObservation): { state: 'admitted'; eventId: string } | { state: 'refused'; reason: string } {
    this.assertOpen();
    const eventId = sha256Hex(canonicalize({ cohortId: this.cohort.cohortId,
      gameId: observation.game.gameId, market: observation.market }));
    const existing = this.store.getFire(eventId);
    if (existing !== undefined) return { state: 'admitted', eventId };
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
    this.store.claim(claim);
    return { state: 'admitted', eventId };
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
    const observedMs = instantMs(run.provenance.observedAt);
    if (atMs < observedMs || atMs - observedMs > MARKET_OPEN_ADMISSION_POLICY.maxObservationToSendLagMs) {
      return 'observation_to_send_lag';
    }
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
      confirm: (_arm, _role, at) => this.refusal(run, at),
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
        if (guard.kind === 'breach' && this.store.snapshot().halted === null) {
          this.store.markUnknown(id, 'per_attempt_reservation_breach');
        }
      },
    };
    const options = {
      cohortId: this.cohort.cohortId, executionPolicy: MARKET_OPEN_POLICY.executionPolicy,
      baselinePolicyVersion: MARKET_OPEN_POLICY.baselinePolicyVersion,
      timeoutMs: MARKET_OPEN_ADMISSION_POLICY.timeoutMs,
      maxOutputTokens: MARKET_OPEN_ADMISSION_POLICY.maxOutputTokens,
      nowMs: this.nowMs, attemptBoundary: boundary,
    };
    const envelope = await runSlate([...MARKET_OPEN_POLICY.roster], this.adapters, run.build.requests, options);
    const context: RunContext = {
      ...options, runId: run.provenance.runId, slateDate: this.cohort.slateDate,
      mode: 'live', clockMode: 'wall', createdAt: new Date(this.nowMs()).toISOString(),
      fetchStartedAt: run.provenance.observedAt, fetchCompletedAt: run.provenance.observedAt,
      marketOpen: run.provenance,
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
      admissionPolicy: MARKET_OPEN_ADMISSION_POLICY, admissionPolicySha256: MARKET_OPEN_ADMISSION_POLICY_SHA256,
      eventId: id, runId: run.provenance.runId, records, spend,
      admission: this.store.getFire(id),
    }) + '\n', 'utf8');
    const dir = join(this.artifactRoot, 'artifacts');
    const installed = installBytesNoClobber(nodeArtifactFs, { dir, finalPath: join(dir, `${id}.json`),
      tmpStem: id, buffer: bytes, label: 'market-open produced artifact' });
    // The immutable artifact is present AND durable before terminal state advances.
    const reference = { path: installed.path, sha256: sha256Hex(bytes.toString('utf8')) };
    const latest = this.store.getFire(id)!;
    if (latest.status === 'running' || latest.status === 'claimed') {
      if (envelope.results.some((r) => r.outcome !== 'valid')) this.store.fail(id, 'arm_outcome_failure');
    }
    // Dirty terminals also bind their evidence, without promoting to completed.
    this.store.complete(id, reference);
    return { ...resultOf(this.store.getFire(id)!), artifactPath: installed.path };
  }
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
