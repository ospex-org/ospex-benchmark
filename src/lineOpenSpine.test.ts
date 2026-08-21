import assert from 'node:assert/strict';
import { toolInferenceConfigSha256 } from './toolInferenceConfig.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cohortBoot } from './cohortBoot.js';
import { evaluateCandidate } from './detection.js';
import { assertDispatchPermit, StoreClaimPort } from './lineOpenClaim.js';
import type { DispatchPermit } from './lineOpenClaim.js';
import { DispatchAuthorizationError, PreDispatchCleanupError, scopeKeyOf } from './lineOpenDispatch.js';
import { AuthorizedDispatchFaultError } from './runner.js';
import { LifecycleFaultError } from './lineOpenLifecycle.js';
import {
  BillablePriceIdentityError,
  buildFullScopeAdmitRequest,
  deriveSpendReservationUsdMicros,
  FireReconciliationError,
  installReconciledArtifact,
  PreClaimClockError,
  reconcileArtifactToPermit,
  runOneFire,
  SpendGuardInternalError,
} from './lineOpenSpine.js';
import type { ArtifactInstaller, ArtifactInstallResult, CoverageMissReason, LineOpenAdmissionParameters, LineOpenRunOptions, RunOneFireInput } from './lineOpenSpine.js';
import type { DeferReason, RejectReason } from './lineOpenProject.js';
import { assertFireArtifact, buildFireArtifact } from './fireArtifactProducer.js';
import type { FireArtifactV1 } from './fireArtifactProducer.js';
import { FireArtifactSink, nodeArtifactFs } from './fireArtifactSink.js';
import type { ArtifactFs } from './fireArtifactSink.js';
import { parseFireArtifactV1, serializeFireArtifactV1, verifyFireArtifactReplay } from './fireArtifactWriter.js';
import { MARKET_ORDINAL } from './fireArtifact.js';
import { checkPublication } from './manifestPublication.js';
import type { CohortManifestV1 } from './manifest.js';
import { deriveFireSpendReservationUsdMicros } from './spendReservationPolicy.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { MODEL_PRICE_TABLE_DIGEST, MODEL_PRICE_TABLE_VERSION } from './modelPriceTable.js';
import { sealPreparedFire } from './preparedFire.js';
import type { PreparedFireSnapshot } from './preparedFire.js';
import { promptScaffoldSha256 } from './prompt.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import {
  createCohortMockAdapterCapability,
  createCohortRealShapedFakeCapability,
  mintInjectedAdapterCapability,
} from './cohortAdapterCapability.js';
import type { CohortAdapterCapability } from './cohortAdapterCapability.js';
import { checkProviderCollision } from './providers/family.js';
import { EMPTY_CONFIGURATION_SHA256 } from './participantConfiguration.js';
import { ProviderUnfinishedTurnError } from './providers/errors.js';
import { SPEND_GUARD_PRICE_TABLE_VERSION, modelPriceTableDigest } from './modelPriceTable.js';
import { serializeSpendEscalationSidecar, spendEscalationSidecarSha256 } from './spendEscalationSidecar.js';
import { verifySpendEvidence } from './verifySpendSidecar.js';
import type { SpendEscalationSidecarV1 } from './spendEscalationSidecar.js';
import type { BillingClass } from './spendGuard.js';
import type { CandidateInput } from './detection.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import { fixtureEnvelope } from './testFactories.js';
import type {
  AcquireRepairLeaseRequest,
  AdmitDispatchRequest,
  AdmitResult,
  AtomicStore,
  ClaimKey,
  CompleteClaimRequest,
  CompleteResult,
  InitCohortBudgetRequest,
  InitResult,
  Lease,
  ReleaseLeaseRequest,
  ReleaseResult,
  RepairLeaseResult,
} from './store/contract.js';
import type {
  ArmOutcome,
  BenchmarkResponse,
  ChatTurn,
  GameBundle,
  MarketKey,
  ProviderAdapter,
  ProviderName,
  ProviderResponse,
} from './types.js';

/**
 * The composition spine end to end. Every authorized-path fixture drives a genuine sealed
 * snapshot, the genuine artifact producer, and a genuine permit minted by a real `StoreClaimPort`
 * over a scripted `AtomicStore`. Provider adapters are synthetic; filesystem effects use an
 * injected `ArtifactFs` or `mkdtempSync` only. No provider, database, watcher, or live path.
 */

// --- shared instants / identity --------------------------------------------

const GAME_ID = '00000000-0000-4000-8000-0000000000f1';
const GAME_ID2 = '00000000-0000-4000-8000-0000000000f2';
const CUTOFF = '2026-07-18T20:00:00+00:00';
const WINDOW_START = '2026-07-18T00:00:00.000Z';
const WINDOW_END = '2026-07-19T00:00:00.000Z';
const BUNDLE_TS = '2026-07-18T12:00:00.000Z';
const DETECTED_AT = '2026-07-18T12:00:30.000Z';
const OPENER_AT = '2026-07-18T11:59:30.000Z';
const OBSERVED_AT = '2026-07-18T11:58:00+00:00';
const BUNDLE_BUILT_AT = '2026-07-18T12:00:31.000Z';
const COMMITTER_TS = '2026-07-17T23:00:00+00:00';
const NOW_MS = Date.parse('2026-07-18T12:00:40.000Z');
const W = 120_000;
const SKEW = 5_000;
const OWNER = 'owner-host-1234-abc';
import { STORE_SCHEMA_VERSION as SCHEMA } from './store/constants.js';
const BOTH: readonly MarketKey[] = ['moneyline', 'total'];
const CODE_ARMS = defaultExpectedArms();

// --- fixtures ---------------------------------------------------------------

function manifestJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    artifactSchemaVersion: 1,
    network: 'polygon',
    sportAllowList: ['mlb'],
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
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
      configuration: a.configuration,
    })),
    toolInferenceConfigSha256: toolInferenceConfigSha256(),
    baselinePolicyVersion: 'baselines-v0.3.0',
    repairPolicyVersion: 'repair-v1',
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: MODEL_PRICE_TABLE_VERSION,
    modelPriceTableDigest: MODEL_PRICE_TABLE_DIGEST,
    spendReservationPolicyVersion: 'fixed-attempt-v1',
    runnerCommitSha: 'e'.repeat(40),
    constants: {
      pollIntervalMs: 30_000,
      cleanEntryWindowMs: W,
      gameDiscoveryWindowHours: 168,
      maxClockSkewMs: SKEW,
      freshFireMs: 30_000,
      maxDispatchLagMs: 10_000,
      historyReadTimeoutMs: 30_000,
      providerCallTimeoutMs: 300_000,
      maxOutputTokens: 16_000,
      maxRepairAttemptsPerArm: 1,
      providerAttemptReservationUsdMicros: 100_000_000,
      ingestionGraceMs: 900_000,
      scheduleChangeToleranceMs: 60_000,
      maxConcurrentProviderRequests: Math.max(8, CODE_ARMS.length),
      maxDispatchesPerTick: 8,
    },
    cohortCallCap: 1_000,
    cohortSpendCapUsdMicros: 1_000_000,
    ...extra,
  });
}

function scopedGame(gameId: string, markets: readonly MarketKey[]): GameBundle {
  const evidenceRefs = [`ev:${gameId}:identity`, `ev:${gameId}:schedule`];
  const gameMarkets: GameBundle['markets'] = {};
  if (markets.includes('moneyline')) {
    gameMarkets.moneyline = { awayDecimal: 1.74627, homeDecimal: 2.17, observedAt: OBSERVED_AT, evidenceRef: `ev:${gameId}:moneyline` };
    evidenceRefs.push(`ev:${gameId}:moneyline`);
  }
  if (markets.includes('total')) {
    gameMarkets.total = { line: 8.5, overDecimal: 1.90909, underDecimal: 1.90909, observedAt: OBSERVED_AT, evidenceRef: `ev:${gameId}:total` };
    evidenceRefs.push(`ev:${gameId}:total`);
  }
  return {
    gameId,
    league: 'mlb',
    scheduledStartUtc: CUTOFF,
    awayTeam: 'Milwaukee Brewers',
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: gameMarkets,
    evidenceRefs,
  };
}

function historyRow(gameId: string, market: MarketKey): TwoSidedHistoryRow {
  const quote =
    market === 'moneyline'
      ? { line: null, away_odds_american: -134, away_odds_decimal: 1.74627, home_odds_american: 117, home_odds_decimal: 2.17 }
      : { line: 8.5, away_odds_american: -110, away_odds_decimal: 1.90909, home_odds_american: -110, home_odds_decimal: 1.90909 };
  return { id: 1, jsonodds_id: gameId, market, source: 'jsonodds', ...quote, captured_at: OPENER_AT, captured_at_ms: Date.parse(OPENER_AT) };
}

function candidateInput(gameId: string, market: MarketKey, windowEnd: string = WINDOW_END): CandidateInput {
  return {
    gameId,
    sport: 'mlb',
    market,
    sportAllowList: ['mlb'],
    marketPolicyVersion: MARKET_POLICY_VERSION,
    opener: historyRow(gameId, market),
    detectedAt: DETECTED_AT,
    windowStart: WINDOW_START,
    windowEnd,
    cleanEntryWindowMs: W,
    maxClockSkewMs: SKEW,
  };
}

interface SealOpts {
  gameId?: string;
  markets?: readonly MarketKey[];
  manifestExtra?: Record<string, unknown>;
}

function sealed(opts: SealOpts = {}): PreparedFireSnapshot {
  const gameId = opts.gameId ?? GAME_ID;
  const markets = opts.markets ?? BOTH;
  const json = manifestJson(opts.manifestExtra);
  const bytes = new TextEncoder().encode(json);
  // The candidate must carry the SAME windowEnd as the (possibly-overridden) manifest, or
  // reconcileCandidate rejects a built artifact on the admit path; derive it from the override.
  const candWindowEnd = (opts.manifestExtra?.['windowEnd'] as string | undefined) ?? WINDOW_END;
  return sealPreparedFire({
    game: scopedGame(gameId, markets),
    slug: `mil-pit-${gameId.slice(-4)}`,
    slateDate: '2026-07-18',
    bundleTimestamp: BUNDLE_TS,
    booted: cohortBoot({ manifestBytes: json }),
    publication: checkPublication({
      localManifestBytes: bytes,
      publication: { repositoryOwner: 'ospex-org', repositoryName: 'ospex-benchmark', path: 'manifests/cohort.json', commitSha: 'a'.repeat(40) },
      resolved: { blobBytes: bytes, committerTimestamp: COMMITTER_TS },
    }),
    detectedAt: DETECTED_AT,
    bundleBuiltAt: BUNDLE_BUILT_AT,
    proposedMarkets: markets,
    perMarket: markets.map((m) => ({
      candidateInput: candidateInput(gameId, m, candWindowEnd),
      verdict: evaluateCandidate(candidateInput(gameId, m, candWindowEnd)),
      historyRows: [historyRow(gameId, m)],
      historyWatermark: null,
    })),
  });
}

function leasesFor(indexes: readonly number[], prefix = ''): Lease[] {
  return indexes.map((armIndex) => ({
    leaseId: `${prefix}lease-${armIndex}`,
    armIndex,
    expiresAt: '2026-07-18T12:10:00.000Z',
    state: 'live' as const,
  }));
}

function leaseSet(count: number, prefix = ''): Lease[] {
  return leasesFor(Array.from({ length: count }, (_, i) => i), prefix);
}

type StoreCall = { op: 'release'; leaseId: string; ownerId: string } | { op: 'repair'; req: AcquireRepairLeaseRequest };

/** A scripted store that auto-admits the full proposed scope. `admitMarkets`/`leaseCount`
 *  overrides let a test drive a narrowed retained scope or a bad roster. */
class ScriptedStore implements AtomicStore {
  readonly calls: StoreCall[] = [];
  readonly admitCalls: AdmitDispatchRequest[] = [];
  onRelease: (req: ReleaseLeaseRequest) => Promise<ReleaseResult> = () => Promise.resolve({ outcome: 'released' });
  onRepair: (req: AcquireRepairLeaseRequest) => Promise<RepairLeaseResult> = (req) =>
    Promise.resolve({
      outcome: 'acquired',
      lease: { leaseId: `repair-${req.armIndex}-${req.repairOrdinal}`, armIndex: req.armIndex, expiresAt: '2026-07-18T12:20:00.000Z', state: 'live' },
      requestAuthorized: true,
    });
  /** When set, the admitted claimedKeys use THESE markets (to drive a narrowed retained scope). */
  admitMarkets?: readonly MarketKey[];
  /** When set, reverse the claimedKeys order the store returns (canonical-zipper test). */
  reverseKeys = false;
  /** When set, the admitted initial leases carry THESE arm indexes (to mint a genuine but
   *  non-bijective roster — `authorizePreparedDispatch` would refuse it, but a direct
   *  `StoreClaimPort.admit` mints a brand-genuine permit the reconcile roster dimension defends
   *  against). */
  badRoster?: readonly number[];

  constructor(private readonly rosterSize: number, private readonly leasePrefix = '') {}

  initCohortBudget(_r: InitCohortBudgetRequest): Promise<InitResult> {
    throw new Error('not used');
  }
  admitDispatch(req: AdmitDispatchRequest): Promise<AdmitResult> {
    this.admitCalls.push(req);
    const reservation = Object.values(req.scopeReservations)[0]!;
    const markets = this.admitMarkets ?? req.proposedMarkets;
    const ordered = this.reverseKeys ? [...markets].reverse() : markets;
    return Promise.resolve({
      outcome: 'admitted',
      claimedKeys: ordered.map((market) => ({ gameId: req.gameId, market })),
      preparedBytesDigest: reservation.preparedBytesDigest,
      initialLeases: this.badRoster ? leasesFor(this.badRoster, this.leasePrefix) : leaseSet(this.rosterSize, this.leasePrefix),
      dispatchAuthorized: true,
    });
  }
  acquireRepairLease(req: AcquireRepairLeaseRequest): Promise<RepairLeaseResult> {
    this.calls.push({ op: 'repair', req });
    return this.onRepair(req);
  }
  releaseLease(req: ReleaseLeaseRequest): Promise<ReleaseResult> {
    this.calls.push({ op: 'release', leaseId: req.leaseId, ownerId: req.ownerId });
    return this.onRelease(req);
  }
  /** Recorded + scriptable: the spine now settles exactly once, strictly after a durable install, so
   *  the throwing "never call" stub is replaced. Every pre-install path still asserts zero calls. */
  readonly completeCalls: CompleteClaimRequest[] = [];
  onComplete: (req: CompleteClaimRequest) => Promise<CompleteResult> = () => Promise.resolve({ outcome: 'completed' });
  completeClaim(req: CompleteClaimRequest): Promise<CompleteResult> {
    this.completeCalls.push(req);
    return this.onComplete(req);
  }
}

interface Scripted {
  adapter: ProviderAdapter;
  calls: number;
}

function validBody(participantId: string, requestedModelId: string, cohortId: string, bundleSha: string, game: GameBundle): string {
  const forecasts: BenchmarkResponse['games'][number]['forecasts'] = [];
  if (game.markets.moneyline) {
    forecasts.push({ market: 'moneyline', selection: game.awayTeam, line: null, observedDecimal: game.markets.moneyline.awayDecimal, probabilities: { win: 0.55, push: 0, loss: 0.45 }, confidence: 0.6, wouldAbstain: false, selectedForExecution: true, rationale: 'r', evidenceRefs: [game.markets.moneyline.evidenceRef], reasonCode: null, axes: { valuation: 4, trend: 2, consensus: 3, news: 1, softness: 5 }, primaryAxis: 'valuation', primaryExpectation: 'The away price reads rich against the implied probabilities.' });
  }
  if (game.markets.total) {
    forecasts.push({ market: 'total', selection: 'over', line: game.markets.total.line, observedDecimal: game.markets.total.overDecimal, probabilities: { win: 0.5, push: 0, loss: 0.5 }, confidence: 0.5, wouldAbstain: false, selectedForExecution: true, rationale: 'r', evidenceRefs: [game.markets.total.evidenceRef], reasonCode: null, axes: { valuation: 1, trend: 1, consensus: 1, news: 1, softness: 1 }, primaryAxis: null, primaryExpectation: 'No material movement is expected in this total before close.' });
  }
  const body: BenchmarkResponse = {
    schemaVersion: 2,
    cohortId,
    participantId,
    requestedModelId,
    bundleSha256: bundleSha,
    executionPolicy: 'fixed-moneyline-total',
    games: [{ gameId: game.gameId, forecasts }],
  };
  return JSON.stringify(body);
}

function scriptedAdapter(
  identity: { participantId: string; provider: string; requestedModelId: string },
  bodies: (call: number) => string | Promise<string>,
  opts: { hasCredential?: boolean; usageRawFor?: (call: number) => unknown } = {},
): Scripted {
  const state = { calls: 0 };
  const adapter: ProviderAdapter = {
    provider: identity.provider as ProviderName,
    requestedModelId: identity.requestedModelId,
    credentialEnvVar: `${identity.participantId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_KEY`,
    hasCredential: () => opts.hasCredential ?? true,
    async chat(_t: ChatTurn[], _ms: number): Promise<ProviderResponse> {
      state.calls += 1;
      const body = await bodies(state.calls);
      return { rawText: body, responseEnvelope: fixtureEnvelope(body), reportedModelId: identity.requestedModelId, providerResponseId: 'x', httpStatus: 200, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, usageRaw: opts.usageRawFor ? opts.usageRawFor(state.calls) : {}, requestParams: {}, searchAudit: null };
    },
  };
  return { adapter, get calls() { return state.calls; } } as Scripted;
}

function validAdapters(
  snapshot: PreparedFireSnapshot,
  cohortId: string,
  game: GameBundle,
  usageRawFor?: (identity: { participantId: string; provider: string }, call: number) => unknown,
): { map: Map<string, ProviderAdapter>; scripts: Scripted[] } {
  const scripts: Scripted[] = [];
  const map = new Map<string, ProviderAdapter>();
  for (const id of snapshot.expectedArmIdentities) {
    const s = scriptedAdapter(
      id,
      () => validBody(id.participantId, id.requestedModelId, cohortId, snapshot.prepared.requestSha256, game),
      usageRawFor ? { usageRawFor: (call) => usageRawFor(id, call) } : {},
    );
    scripts.push(s);
    map.set(id.participantId, s.adapter);
  }
  return { map, scripts };
}

function runOpts(over: Partial<LineOpenRunOptions> = {}): LineOpenRunOptions {
  return {
    timeoutMs: 600_000,
    maxOutputTokens: 16_000,
    executionPolicy: 'fixed-moneyline-total',
    baselinePolicyVersion: 'baselines-v0.3.0',
    ...over,
  };
}

const ADMISSION = { ownerId: OWNER, expectedSchemaVersion: SCHEMA } as const;

const releaseIds = (store: ScriptedStore): string[] =>
  store.calls.filter((c): c is Extract<StoreCall, { op: 'release' }> => c.op === 'release').map((c) => c.leaseId);

/** Mint a known-zero capability around scripted test adapters (the injected-fixture producer). */
function knownZeroCap(adapters: ReadonlyMap<string, ProviderAdapter>): CohortAdapterCapability {
  return mintInjectedAdapterCapability({ adapters, billingClass: 'known-zero' });
}

/** The v2 price pin a BILLABLE fire's manifest must carry (the billable price-identity gate). */
const V2_PIN = {
  modelPriceTableVersion: SPEND_GUARD_PRICE_TABLE_VERSION,
  modelPriceTableDigest: modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION),
} as const;

/** An installer spy that delegates to a real sink and records each call + result. */
function countingSink(real: ArtifactInstaller): ArtifactInstaller & {
  calls: Array<{ arg: FireArtifactV1; result: ReturnType<ArtifactInstaller['install']> }>;
  sidecarCalls: Array<{ arg: SpendEscalationSidecarV1; result: ReturnType<ArtifactInstaller['install']> }>;
} {
  const calls: Array<{ arg: FireArtifactV1; result: ReturnType<ArtifactInstaller['install']> }> = [];
  const sidecarCalls: Array<{ arg: SpendEscalationSidecarV1; result: ReturnType<ArtifactInstaller['install']> }> = [];
  return {
    calls,
    sidecarCalls,
    install(artifact) {
      const result = real.install(artifact);
      calls.push({ arg: artifact, result });
      return result;
    },
    installSpendEscalationSidecar(sidecar) {
      const result = real.installSpendEscalationSidecar(sidecar);
      sidecarCalls.push({ arg: sidecar, result });
      return result;
    },
  };
}

/** An installer whose `install` returns a caller-controlled pending promise and signals when reached —
 *  so a test can observe that settlement does not run while the install is still in flight. */
function deferredInstaller(): {
  installer: ArtifactInstaller;
  reached: Promise<void>;
  resolve: (r: ArtifactInstallResult) => void;
  reject: (e: unknown) => void;
  installCalls: () => number;
} {
  let signalReached!: () => void;
  const reached = new Promise<void>((res) => { signalReached = res; });
  let resolveFn!: (r: ArtifactInstallResult) => void;
  let rejectFn!: (e: unknown) => void;
  let installCalls = 0;
  const installer: ArtifactInstaller = {
    install() {
      installCalls += 1;
      const pending = new Promise<ArtifactInstallResult>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
      signalReached();
      return pending;
    },
    installSpendEscalationSidecar() {
      throw new Error('deferred installer fixture: no escalation is expected on this path');
    },
  };
  return { installer, reached, resolve: (r) => resolveFn(r), reject: (e) => rejectFn(e), installCalls: () => installCalls };
}

/** The full happy-path harness for one fire, over an injected in-memory filesystem. The tick clock
 *  is injected via `now` (default `() => NOW_MS`, the boundary-safe reading whose V-lag against the
 *  fixture `detectedAt` equals `maxDispatchLagMs`, so the gate admits); a late clock drives the
 *  gate-refusal rows. */
async function fireOf(
  opts: SealOpts & {
    store?: ScriptedStore;
    runOptions?: LineOpenRunOptions;
    fs?: ArtifactFs;
    now?: () => number;
    billingClass?: BillingClass;
    usageRawFor?: (identity: { participantId: string; provider: string }, call: number) => unknown;
  } = {},
): Promise<{
  outcome: Awaited<ReturnType<typeof runOneFire>>;
  store: ScriptedStore;
  snapshot: PreparedFireSnapshot;
  scripts: Scripted[];
  sink: ReturnType<typeof countingSink>;
}> {
  const snapshot = sealed(opts);
  const cohortId = snapshot.booted.cohortId;
  const game = scopedGame(opts.gameId ?? GAME_ID, opts.markets ?? BOTH);
  const store = opts.store ?? new ScriptedStore(snapshot.expectedArmIdentities.length);
  const { map, scripts } = validAdapters(snapshot, cohortId, game, opts.usageRawFor);
  const sink = countingSink(new FireArtifactSink('/base', opts.fs ?? new MemoryFs()));
  const outcome = await runOneFire({
    snapshot,
    capability: mintInjectedAdapterCapability({ adapters: map, billingClass: opts.billingClass ?? 'known-zero' }),
    claimPort: new StoreClaimPort(store),
    sink,
    runOptions: opts.runOptions ?? runOpts(),
    admission: ADMISSION,
    now: opts.now ?? (() => NOW_MS),
  });
  return { outcome, store, snapshot, scripts, sink };
}

/** Run a fire and require it installed; return the genuine artifact + permit. */
async function installedFire(opts: SealOpts = {}): Promise<{ artifact: FireArtifactV1; permit: DispatchPermit }> {
  const { outcome } = await fireOf(opts);
  if (outcome.kind !== 'Installed') throw new Error(`fixture: expected Installed, got ${outcome.kind}`);
  return { artifact: outcome.artifact, permit: outcome.permit };
}

// --- a minimal in-memory ArtifactFs (atomic no-clobber, enough for the sink) --

class MemoryFs implements ArtifactFs {
  readonly files = new Map<string, Buffer>();
  private readonly temps = new Map<number, { path: string; chunks: Buffer[] }>();
  private nextFd = 100;
  mkdirp(_dir: string): void {}
  openExclusive(path: string): number {
    if (this.files.has(path)) {
      const e = new Error('EEXIST') as NodeJS.ErrnoException;
      e.code = 'EEXIST';
      throw e;
    }
    const fd = this.nextFd;
    this.nextFd += 1;
    this.temps.set(fd, { path, chunks: [] });
    return fd;
  }
  write(fd: number, data: Buffer, offset: number, length: number): number {
    this.temps.get(fd)?.chunks.push(Buffer.from(data.subarray(offset, offset + length)));
    return length;
  }
  fsync(_fd: number): void {}
  close(fd: number): void {
    const t = this.temps.get(fd);
    if (t) this.files.set(t.path, Buffer.concat(t.chunks));
  }
  link(existingPath: string, newPath: string): void {
    if (this.files.has(newPath)) {
      const e = new Error('EEXIST') as NodeJS.ErrnoException;
      e.code = 'EEXIST';
      throw e;
    }
    const bytes = this.files.get(existingPath);
    if (bytes === undefined) throw new Error(`memory link: missing source ${existingPath}`);
    this.files.set(newPath, bytes);
  }
  syncDir(_dir: string): void {}
  readFile(path: string): Buffer {
    const b = this.files.get(path);
    if (b === undefined) throw new Error(`memory readFile: missing ${path}`);
    return b;
  }
  unlink(path: string): void {
    this.files.delete(path);
  }
}

/** The S3 path derivation, re-computed independently for assertion. */
function expectedPath(baseDir: string, artifact: FireArtifactV1): string {
  const scope = [...artifact.scopedMarkets].sort((a, b) => MARKET_ORDINAL[a] - MARKET_ORDINAL[b]).join('+');
  const seg = Buffer.from(artifact.gameId, 'utf8').toString('base64url');
  return join(baseDir, artifact.cohortId, `fire-${seg}-${scope}-${artifact.fireId}.json`);
}

// ===========================================================================
// end-to-end happy path
// ===========================================================================

test('one fire runs admit->authorize->dispatch->produce->reconcile->install exactly once', async () => {
  const { outcome, store, scripts, sink } = await fireOf();
  assert.equal(outcome.kind, 'Installed');
  if (outcome.kind !== 'Installed') return;

  assert.equal(store.admitCalls.length, 1, 'exactly one admission');
  assert.equal(sink.calls.length, 1, 'exactly one install');
  assert.ok(scripts.every((s) => s.calls === 1), 'each arm called once, no repair');

  // Every initial lease released once (no repair path here).
  assert.deepEqual([...releaseIds(store)].sort(), outcome.permit.initialLeases.map((l) => l.leaseId).sort());
  assert.equal(store.calls.filter((c) => c.op === 'repair').length, 0);

  // Installed path == S3 derivation; created true; bytes parse + replay clean.
  assert.equal(outcome.install.created, true);
  assert.equal(outcome.install.path, expectedPath('/base', outcome.artifact));
  assert.deepEqual(verifyFireArtifactReplay(outcome.artifact), []);

  // Returned references are the exact stage values.
  assert.strictEqual(outcome.artifact, sink.calls[0]!.arg, 'installed artifact is the produced object');
  assert.strictEqual(outcome.install, sink.calls[0]!.result, 'returned install is the sink result');
  assert.doesNotThrow(() => assertFireArtifact(outcome.artifact));

  // The claim is settled exactly once, AFTER the install, and reports settled.
  assert.equal(store.completeCalls.length, 1, 'exactly one settle on the installed path');
  assert.deepEqual(outcome.completion, { status: 'settled' }, 'a completed store settle reports settled');
});

// ===========================================================================
// the runtime spend guard at the spine seam (post-install escalation)
// ===========================================================================

/** Minimal VALID per-provider `usageRaw` the conservative arithmetic prices without ambiguity —
 *  each shape carries every required field plus the corroboration its provider demands. */
function pricedUsageFor(provider: string): unknown {
  switch (provider) {
    case 'openai':
      return { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    case 'anthropic':
      return { input_tokens: 1, output_tokens: 1 };
    case 'google':
      return { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 0, totalTokenCount: 2 };
    case 'xai':
      return { prompt_tokens: 1, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
    default:
      throw new Error(`no priced usage fixture for provider ${provider}`);
  }
}

const ANTHROPIC_ARM_ID = CODE_ARMS.find((a) => a.provider === 'anthropic')!.participantId;
/** claude-fable-5 prices at $10/Mtok input on the guard's conservative table, i.e. 10 USD-micros per
 *  input token — so 10,000,000 input tokens derive EXACTLY the $100 (100,000,000 µUSD) per-attempt
 *  reservation, and one more token is the smallest expressible step above it (+10 µUSD). The exact
 *  value must PASS (the threshold is strictly `>`); the next reachable value must escalate. */
const AT_CAP_USAGE = { input_tokens: 10_000_000, output_tokens: 0 };
const OVER_CAP_USAGE = { input_tokens: 10_000_001, output_tokens: 0 };
const OVER_CAP_DERIVED_USD_MICROS = 100_000_010;

test('a billable attempt priced over the reservation escalates AFTER install and never settles', async () => {
  const { outcome, store, sink } = await fireOf({
    billingClass: 'billable',
    manifestExtra: V2_PIN,
    usageRawFor: (id) => (id.participantId === ANTHROPIC_ARM_ID ? OVER_CAP_USAGE : pricedUsageFor(id.provider)),
  });
  assert.equal(outcome.kind, 'InstalledEscalated');
  if (outcome.kind !== 'InstalledEscalated') return;
  assert.equal(outcome.reason, 'spend_attempt_over_reservation');
  // Identity, not membership: the exact offender — arm, role, and derived-actual — from the
  // exact authenticated envelope, nothing else flagged.
  assert.deepEqual(
    outcome.offenders.map((o) => ({ ...o })),
    [{ participantId: ANTHROPIC_ARM_ID, role: 'initial', status: 'breach', derivedActualUsdMicros: OVER_CAP_DERIVED_USD_MICROS }],
  );
  // The evidence durably installed FIRST: escalation is strictly post-install, and the outcome
  // carries the exact produced artifact + the exact sink result by identity.
  assert.equal(sink.calls.length, 1, 'the artifact durably installed before the refusal');
  assert.strictEqual(outcome.artifact, sink.calls[0]!.arg, 'the escalated outcome carries the installed artifact');
  assert.strictEqual(outcome.install, sink.calls[0]!.result, 'the escalated outcome carries the sink result');
  assert.equal(outcome.install.created, true);
  assert.doesNotThrow(() => assertFireArtifact(outcome.artifact));
  // ...and settlement NEVER ran — the claim and its full reservation stay pending (retained).
  assert.equal(store.completeCalls.length, 0, 'a breached fire never settles');
});

test('the guard prices at the CONSERVATIVE table the billable manifest pinned', async () => {
  // Only a provider whose rates DIFFER between the default replay table and the conservative
  // guard table can observe the version wiring (the anthropic row is identical in both). Google
  // input prices at $2/Mtok on the default table but $4/Mtok on the guard table, so 30M prompt
  // tokens derive 60,000,000 µUSD (PASS) at the default and 120,000,000 µUSD (BREACH) at the
  // guard table — a guard priced at the cheaper table would silently settle this fire. The
  // manifest here pins the guard table (the billable price-identity gate requires it), so the
  // authenticated identity and the judged identity agree.
  const googleArmId = CODE_ARMS.find((a) => a.provider === 'google')!.participantId;
  const googleOverCap = { promptTokenCount: 30_000_000, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 30_000_000 };
  const { outcome, store } = await fireOf({
    billingClass: 'billable',
    manifestExtra: V2_PIN,
    usageRawFor: (id) => (id.participantId === googleArmId ? googleOverCap : pricedUsageFor(id.provider)),
  });
  assert.equal(outcome.kind, 'InstalledEscalated');
  if (outcome.kind !== 'InstalledEscalated') return;
  assert.equal(outcome.reason, 'spend_attempt_over_reservation');
  assert.deepEqual(
    outcome.offenders.map((o) => ({ ...o })),
    [{ participantId: googleArmId, role: 'initial', status: 'breach', derivedActualUsdMicros: 120_000_000 }],
  );
  assert.equal(store.completeCalls.length, 0, 'never settled');
});

test('a billable sent attempt with NO usage is UNKNOWN — escalates, never read as zero, never settles', async () => {
  const { outcome, store, sink } = await fireOf({
    billingClass: 'billable',
    manifestExtra: V2_PIN,
    usageRawFor: (id) => (id.participantId === ANTHROPIC_ARM_ID ? null : pricedUsageFor(id.provider)),
  });
  assert.equal(outcome.kind, 'InstalledEscalated');
  if (outcome.kind !== 'InstalledEscalated') return;
  assert.equal(outcome.reason, 'spend_evidence_unknown');
  assert.deepEqual(
    outcome.offenders.map((o) => ({ ...o })),
    [{ participantId: ANTHROPIC_ARM_ID, role: 'initial', status: 'unknown', derivedActualUsdMicros: null }],
  );
  assert.equal(sink.calls.length, 1, 'an UNKNOWN spend still installs its evidence first');
  assert.equal(store.completeCalls.length, 0, 'an UNKNOWN spend never settles');
});

test('a billable fire priced EXACTLY at the reservation passes — the threshold is strictly greater — and settles', async () => {
  const { outcome, store } = await fireOf({
    billingClass: 'billable',
    manifestExtra: V2_PIN,
    usageRawFor: (id) => (id.participantId === ANTHROPIC_ARM_ID ? AT_CAP_USAGE : pricedUsageFor(id.provider)),
  });
  // The bidirectional pair of the breach test above: PASS ⇒ settles (and the exact `==` boundary
  // is accepted), BREACH ⇒ does not — both directions asserted, not just the failing one.
  assert.equal(outcome.kind, 'Installed');
  if (outcome.kind !== 'Installed') return;
  assert.deepEqual(outcome.completion, { status: 'settled' });
  assert.equal(store.completeCalls.length, 1, 'a passing billable fire settles exactly once');
});

test('the SAME over-cap-shaped usage on a known-zero fire settles clean — billing provenance decides, not shape', async () => {
  const { outcome, store } = await fireOf({
    billingClass: 'known-zero',
    usageRawFor: (id) => (id.participantId === ANTHROPIC_ARM_ID ? OVER_CAP_USAGE : pricedUsageFor(id.provider)),
  });
  assert.equal(outcome.kind, 'Installed');
  if (outcome.kind !== 'Installed') return;
  assert.deepEqual(outcome.completion, { status: 'settled' });
  assert.equal(store.completeCalls.length, 1, 'the known-zero mock path is unchanged by the guard');
});

test('a CLEAN billable pass durably installs the spend sidecar and carries it on the outcome — and the offline pair verifier passes it', async () => {
  // Google reports nonzero thoughts so the produced record also satisfies the verifier's
  // reasoning-observed check (the crossing-acceptance round trip below).
  const googleThoughts = { promptTokenCount: 1465, candidatesTokenCount: 471, thoughtsTokenCount: 305, totalTokenCount: 2241 };
  const fs = new MemoryFs();
  const { outcome, store, sink } = await fireOf({
    billingClass: 'billable',
    manifestExtra: V2_PIN,
    fs,
    usageRawFor: (id) => (id.provider === 'google' ? googleThoughts : pricedUsageFor(id.provider)),
  });
  assert.equal(outcome.kind, 'Installed');
  if (outcome.kind !== 'Installed') return;
  assert.deepEqual(outcome.completion, { status: 'settled' });
  assert.equal(store.completeCalls.length, 1, 'the clean pass still settles exactly once');

  // Exactly one durable sidecar, beside (not replacing) the artifact.
  assert.equal(sink.sidecarCalls.length, 1, 'a billable fire ALWAYS installs its spend evidence');
  const record = sink.sidecarCalls[0]!.arg;

  // The record binds the exact installed artifact and pins the guard's price identity.
  assert.equal(record.cohortId, outcome.artifact.cohortId);
  assert.equal(record.fireId, outcome.artifact.fireId);
  assert.equal(record.runId, outcome.artifact.runId);
  assert.equal(record.gameId, outcome.artifact.gameId);
  assert.equal(record.requestSha256, outcome.artifact.requestSha256);
  assert.equal(record.reason, null, 'a clean pass is evidence, not an escalation');
  assert.equal(record.priceVersion, SPEND_GUARD_PRICE_TABLE_VERSION);
  assert.equal(record.priceTableDigest, modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION));
  assert.equal(record.perAttemptReservationUsdMicros, 100_000_000);

  // COMPLETE per-attempt content (minus the two dynamic instants, asserted as present):
  // every arm's initial, all passing, with the whitelisted token buckets verbatim.
  for (const attempt of record.attempts) {
    assert.equal(typeof attempt.requestAt, 'string');
    assert.equal(typeof attempt.responseAt, 'string');
  }
  assert.deepEqual(
    record.attempts.map((a) => ({
      participantId: a.participantId,
      provider: a.provider,
      requestedModelId: a.requestedModelId,
      role: a.role,
      usageTokens: { ...a.usageTokens },
      spendClass: a.spendClass,
      status: a.status,
      derivedActualUsdMicros: a.derivedActualUsdMicros,
    })),
    CODE_ARMS.map((arm) => ({
      participantId: arm.participantId,
      provider: arm.provider,
      requestedModelId: arm.requestedModelId,
      role: 'initial',
      usageTokens:
        arm.provider === 'openai'
          ? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          : arm.provider === 'anthropic'
            ? { input_tokens: 1, output_tokens: 1 }
            : arm.provider === 'google'
              ? { promptTokenCount: 1465, candidatesTokenCount: 471, thoughtsTokenCount: 305, totalTokenCount: 2241 }
              : { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, 'completion_tokens_details.reasoning_tokens': 0 },
      spendClass: 'price',
      status: 'pass',
      derivedActualUsdMicros: null,
    })),
  );

  // The outcome carries the durable evidence identity: path, created, and the exact hash.
  assert.ok(outcome.sidecar, 'the clean billable outcome carries its sidecar');
  assert.deepEqual(
    { ...outcome.sidecar },
    {
      path: (sink.sidecarCalls[0]!.result as { path: string }).path,
      created: true,
      sha256: spendEscalationSidecarSha256(record),
    },
  );
  assert.match(outcome.sidecar.path, /-spend\.json$/);
  assert.notEqual(outcome.sidecar.path, outcome.install.path);

  // Round trip: the REAL durable PAIR — the installed artifact's exact bytes plus the
  // produced record re-parsed from its canonical bytes — PASSES the offline pair verifier
  // the crossing acceptance uses, every named check green.
  const verification = verifySpendEvidence({
    artifactBytes: fs.readFile(outcome.install.path).toString('utf8'),
    sidecar: JSON.parse(serializeSpendEscalationSidecar(record)),
  });
  assert.deepEqual(
    verification.checks.filter((c) => !c.ok),
    [],
    `every verifier check passes: ${JSON.stringify(verification.checks)}`,
  );
  assert.equal(verification.ok, true);
});

test('END-TO-END: an anthropic pause_turn carrying usage yields a coherent artifact + sidecar pair the offline verifier PASSES', async () => {
  // The reviewer-probed shape: a paused server-tool turn is a PAID, RECEIVED
  // response (HTTP 200 with usage and a search audit, no answer text). The
  // persisted attempt must therefore show a receipt — httpStatus, ids, an
  // empty body, requestReceivedAt — alongside its usage, or the durable pair
  // contradicts itself (the verifier refuses usage buckets on a no-receipt
  // attempt).
  const fs = new MemoryFs();
  const snapshot = sealed({ manifestExtra: V2_PIN });
  const cohortId = snapshot.booted.cohortId;
  const game = scopedGame(GAME_ID, BOTH);
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
  const googleThoughts = { promptTokenCount: 1465, candidatesTokenCount: 471, thoughtsTokenCount: 305, totalTokenCount: 2241 };
  const { map } = validAdapters(snapshot, cohortId, game, (id) =>
    id.provider === 'google' ? googleThoughts : pricedUsageFor(id.provider),
  );
  const anthropicId = snapshot.expectedArmIdentities.find((a) => a.provider === 'anthropic');
  assert.ok(anthropicId);
  const pausedUsage = {
    inputTokens: 4_200,
    outputTokens: 180,
    totalTokens: 4_380,
    reasoningTokens: null,
    billableOutputTokens: 180,
  };
  const pausedUsageRaw = { input_tokens: 4_200, output_tokens: 180, server_tool_use: { web_search_requests: 5 } };
  const pausedAudit = { queries: [{ query: 'late lineup news' }], results: [], searchCount: 5, incomplete: [] };
  map.set(anthropicId.participantId, {
    provider: 'anthropic',
    requestedModelId: anthropicId.requestedModelId,
    credentialEnvVar: 'ANTHROPIC_API_KEY',
    hasCredential: () => true,
    async chat(): Promise<ProviderResponse> {
      throw new ProviderUnfinishedTurnError({
        provider: 'anthropic',
        stopReason: 'pause_turn',
        detail: 'the server-side tool loop hit its iteration limit; continuation is not enabled (maxServerToolContinuations)',
        httpStatus: 200,
        providerResponseId: 'msg_paused_e2e_1',
        reportedModelId: anthropicId.requestedModelId,
        rawText: '',
        responseEnvelope: fixtureEnvelope(''),
        usage: pausedUsage,
        usageRaw: pausedUsageRaw,
        searchAudit: pausedAudit,
        requestParams: { endpoint: 'https://stub.example/v1/messages', model: anthropicId.requestedModelId },
      });
    },
  });
  const sink = countingSink(new FireArtifactSink('/base', fs));
  const outcome = await runOneFire({
    snapshot,
    capability: mintInjectedAdapterCapability({ adapters: map, billingClass: 'billable' }),
    claimPort: new StoreClaimPort(store),
    sink,
    runOptions: runOpts(),
    admission: ADMISSION,
    now: () => NOW_MS,
  });
  assert.equal(outcome.kind, 'Installed');
  if (outcome.kind !== 'Installed') return;

  // Artifact side: a provider outcome whose one sent attempt is a RECEIVED response.
  const arm = outcome.artifact.arms.find((a) => a.expectedArmIdentity.provider === 'anthropic');
  assert.ok(arm);
  assert.equal(arm.terminalOutcome, 'provider_error');
  assert.equal(arm.orderedAttempts.length, 1);
  const attempt = arm.orderedAttempts[0]!;
  assert.equal(attempt.httpStatus, 200);
  assert.notEqual(attempt.requestReceivedAt, null, 'a paused turn IS a received response');
  assert.equal(attempt.reportedModelId, anthropicId.requestedModelId);
  assert.equal(attempt.persistedResponseBody, '');
  assert.deepEqual(attempt.usage, pausedUsage);
  assert.deepEqual(attempt.searchAudit, pausedAudit);
  // The structured provider completion state is digest-bound artifact evidence.
  assert.equal(attempt.providerStopReason, 'pause_turn');
  assert.equal(attempt.turnCompleted, false);

  // Sidecar side: the paused call is priced from its carried buckets + count.
  assert.equal(sink.sidecarCalls.length, 1, 'a billable fire always installs its spend evidence');
  const record = sink.sidecarCalls[0]!.arg;
  const row = record.attempts.find((a) => a.provider === 'anthropic');
  assert.ok(row);
  assert.deepEqual(
    { ...row.usageTokens },
    { input_tokens: 4_200, output_tokens: 180, 'server_tool_use.web_search_requests': 5 },
  );
  assert.equal(row.searchCount, 5);
  assert.equal(row.spendClass, 'price');
  assert.equal(row.status, 'pass');
  assert.equal(record.reason, null, 'a priced pause_turn is evidence, not an escalation');

  // The REAL durable pair round-trips the offline verifier: every named check
  // green — in particular attempt-completeness (usage buckets WITH a receipt)
  // and attempts-priceable (the paused call recomputes to a conservative cost).
  const verification = verifySpendEvidence({
    artifactBytes: fs.readFile(outcome.install.path).toString('utf8'),
    sidecar: JSON.parse(serializeSpendEscalationSidecar(record)),
  });
  assert.deepEqual(
    verification.checks.filter((c) => !c.ok),
    [],
    `every verifier check passes: ${JSON.stringify(verification.checks)}`,
  );
  assert.equal(verification.ok, true);
});

test('a known-zero pass installs NO sidecar and carries null — the default paths are unchanged', async () => {
  const { outcome, sink } = await fireOf();
  assert.equal(outcome.kind, 'Installed');
  if (outcome.kind !== 'Installed') return;
  assert.equal(outcome.sidecar, null, 'nothing was billed, nothing to evidence');
  assert.equal(sink.sidecarCalls.length, 0, 'the sidecar seam is never touched on a known-zero fire');
});

test('a clean-pass sidecar-install failure propagates BEFORE settlement — a paid fire never settles without its evidence', async () => {
  const snapshot = sealed({ manifestExtra: V2_PIN });
  const cohortId = snapshot.booted.cohortId;
  const game = scopedGame(GAME_ID, BOTH);
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
  const { map } = validAdapters(snapshot, cohortId, game, (id) => pricedUsageFor(id.provider));
  const real = new FireArtifactSink('/base', new MemoryFs());
  let artifactInstalls = 0;
  const sink: ArtifactInstaller = {
    install(artifact) {
      artifactInstalls += 1;
      return real.install(artifact);
    },
    installSpendEscalationSidecar() {
      throw new Error('sidecar install failed (fixture)');
    },
  };
  await assert.rejects(
    () =>
      runOneFire({
        snapshot,
        capability: mintInjectedAdapterCapability({ adapters: map, billingClass: 'billable' }),
        claimPort: new StoreClaimPort(store),
        sink,
        runOptions: runOpts(),
        admission: ADMISSION,
        now: () => NOW_MS,
      }),
    /sidecar install failed/,
  );
  assert.equal(artifactInstalls, 1, 'the canonical artifact was durably installed first');
  assert.equal(store.completeCalls.length, 0, 'settlement never ran — the evidence-first ordering holds');
});

// ===========================================================================
// The offline PAIR verifier, driven adversarially against REAL produced pairs.
// The artifact is the relational witness (strict-parsed + replay-verified), so a
// truncated, duplicated, fabricated, contradictory, or foreign sidecar must fail
// a named check — and a prototype-pollution key must fail shape without touching
// any global prototype.
// ===========================================================================

interface EvidencePair {
  readonly artifactBytes: string;
  readonly sidecar: Record<string, unknown>;
}

/** One REAL clean billable pair (google reports nonzero thoughts), memoized per run. */
let cleanPairPromise: Promise<EvidencePair> | null = null;
function cleanPair(): Promise<EvidencePair> {
  cleanPairPromise ??= (async () => {
    const fs = new MemoryFs();
    const googleThoughts = { promptTokenCount: 1465, candidatesTokenCount: 471, thoughtsTokenCount: 305, totalTokenCount: 2241 };
    const { outcome, sink } = await fireOf({
      billingClass: 'billable',
      manifestExtra: V2_PIN,
      fs,
      usageRawFor: (id) => (id.provider === 'google' ? googleThoughts : pricedUsageFor(id.provider)),
    });
    if (outcome.kind !== 'Installed') throw new Error(`fixture: expected Installed, got ${outcome.kind}`);
    return {
      artifactBytes: fs.readFile(outcome.install.path).toString('utf8'),
      sidecar: JSON.parse(serializeSpendEscalationSidecar(sink.sidecarCalls[0]!.arg)) as Record<string, unknown>,
    };
  })();
  return cleanPairPromise;
}

/** A REAL pair in which EVERY arm's initial is semantically invalid (a bogus evidenceRef)
 *  and repaired — 8 sent attempts, each priced EXACTLY at the $100 reservation, so the
 *  fire aggregate is exactly the $800 crossing cap (the == boundary). Memoized per run. */
let repairPairPromise: Promise<EvidencePair> | null = null;
function repairPair(): Promise<EvidencePair> {
  repairPairPromise ??= (async () => {
    const snapshot = sealed({ manifestExtra: V2_PIN });
    const cohortId = snapshot.booted.cohortId;
    const game = scopedGame(GAME_ID, BOTH);
    const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
    // Per-provider usage priced EXACTLY at the $100 reservation (integer-divisible, with a
    // small nonzero google thoughts bucket folded into the exact total).
    const atCapFor = (provider: string): unknown => {
      switch (provider) {
        case 'openai':
          return { prompt_tokens: 4_000_000, completion_tokens: 0, total_tokens: 4_000_000 };
        case 'anthropic':
          return { input_tokens: 10_000_000, output_tokens: 0 };
        case 'google':
          return { promptTokenCount: 24_999_991, candidatesTokenCount: 0, thoughtsTokenCount: 2, totalTokenCount: 24_999_993 };
        case 'xai':
          return { prompt_tokens: 25_000_000, completion_tokens: 0, total_tokens: 25_000_000, completion_tokens_details: { reasoning_tokens: 0 } };
        default:
          throw new Error(`no at-cap usage for ${provider}`);
      }
    };
    const map = new Map<string, ProviderAdapter>();
    for (const id of snapshot.expectedArmIdentities) {
      const clean = validBody(id.participantId, id.requestedModelId, cohortId, snapshot.prepared.requestSha256, game);
      const bogusRef = (): string => {
        const parsed = JSON.parse(clean) as { games: Array<{ forecasts: Array<{ evidenceRefs: string[] }> }> };
        parsed.games[0]!.forecasts[0]!.evidenceRefs = ['ev:not-a-real-ref'];
        return JSON.stringify(parsed);
      };
      const s = scriptedAdapter(id, (call) => (call === 1 ? bogusRef() : clean), {
        usageRawFor: () => atCapFor(id.provider),
      });
      map.set(id.participantId, s.adapter);
    }
    const fs = new MemoryFs();
    const sink = countingSink(new FireArtifactSink('/base', fs));
    const outcome = await runOneFire({
      snapshot,
      capability: mintInjectedAdapterCapability({ adapters: map, billingClass: 'billable' }),
      claimPort: new StoreClaimPort(store),
      sink,
      runOptions: runOpts(),
      admission: ADMISSION,
      now: () => NOW_MS,
    });
    if (outcome.kind !== 'Installed') throw new Error(`fixture: expected Installed, got ${outcome.kind}`);
    return {
      artifactBytes: fs.readFile(outcome.install.path).toString('utf8'),
      sidecar: JSON.parse(serializeSpendEscalationSidecar(sink.sidecarCalls[0]!.arg)) as Record<string, unknown>,
    };
  })();
  return repairPairPromise;
}

/** Deep-copy the sidecar and apply a mutation (the original pair stays pristine). */
function mutatedSidecar(pair: EvidencePair, mutate: (sidecar: Record<string, unknown>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(pair.sidecar)) as Record<string, unknown>;
  mutate(copy);
  return copy;
}

type SidecarRow = Record<string, unknown>;
const rowsOf = (sidecar: Record<string, unknown>): SidecarRow[] => sidecar['attempts'] as SidecarRow[];

function failedNames(verification: ReturnType<typeof verifySpendEvidence>): string[] {
  return verification.checks.filter((c) => !c.ok).map((c) => c.name);
}

test('pair verifier: a TRUNCATED sidecar (one arm only) fails attempt-completeness', async () => {
  const pair = await cleanPair();
  const verification = verifySpendEvidence({
    artifactBytes: pair.artifactBytes,
    sidecar: mutatedSidecar(pair, (s) => {
      s['attempts'] = rowsOf(s).filter((r) => (r['participantId'] as string).startsWith('google'));
    }),
  });
  assert.ok(failedNames(verification).includes('attempt-completeness'), JSON.stringify(verification.checks));
  assert.equal(verification.ok, false);
});

test('pair verifier: a DUPLICATED initial row fails attempt-completeness', async () => {
  const pair = await cleanPair();
  const verification = verifySpendEvidence({
    artifactBytes: pair.artifactBytes,
    sidecar: mutatedSidecar(pair, (s) => {
      rowsOf(s).push(JSON.parse(JSON.stringify(rowsOf(s)[0])) as SidecarRow);
    }),
  });
  assert.ok(failedNames(verification).includes('attempt-completeness'));
  assert.equal(verification.ok, false);
});

test('pair verifier: a FABRICATED participant fails attempt-completeness', async () => {
  const pair = await cleanPair();
  const verification = verifySpendEvidence({
    artifactBytes: pair.artifactBytes,
    sidecar: mutatedSidecar(pair, (s) => {
      const fake = JSON.parse(JSON.stringify(rowsOf(s)[0])) as SidecarRow;
      fake['participantId'] = 'fabricated-arm';
      rowsOf(s).push(fake);
    }),
  });
  assert.ok(failedNames(verification).includes('attempt-completeness'));
  assert.equal(verification.ok, false);
});

test('pair verifier: an escalation reason over all-pass rows fails reason-recomputed', async () => {
  const pair = await cleanPair();
  const verification = verifySpendEvidence({
    artifactBytes: pair.artifactBytes,
    sidecar: mutatedSidecar(pair, (s) => {
      s['reason'] = 'spend_evidence_unknown';
    }),
  });
  assert.ok(failedNames(verification).includes('reason-recomputed'));
  assert.equal(verification.ok, false);
});

test('pair verifier: a PASS row with a false non-null derived cost fails record-consistency', async () => {
  const pair = await cleanPair();
  const verification = verifySpendEvidence({
    artifactBytes: pair.artifactBytes,
    sidecar: mutatedSidecar(pair, (s) => {
      rowsOf(s)[0]!['derivedActualUsdMicros'] = 12_345;
    }),
  });
  assert.ok(failedNames(verification).includes('record-consistency'));
  assert.equal(verification.ok, false);
});

test('pair verifier: a sent/priced row mislabeled spendClass unknown fails record-consistency', async () => {
  const pair = await cleanPair();
  const verification = verifySpendEvidence({
    artifactBytes: pair.artifactBytes,
    sidecar: mutatedSidecar(pair, (s) => {
      rowsOf(s)[0]!['spendClass'] = 'unknown';
    }),
  });
  assert.ok(failedNames(verification).includes('record-consistency'));
  assert.equal(verification.ok, false);
});

test('pair verifier: a non-whitelisted token key fails shape (provider-strict buckets)', async () => {
  const pair = await cleanPair();
  const verification = verifySpendEvidence({
    artifactBytes: pair.artifactBytes,
    sidecar: mutatedSidecar(pair, (s) => {
      (rowsOf(s)[0]!['usageTokens'] as Record<string, number>)['bogus_field'] = 5;
    }),
  });
  assert.ok(failedNames(verification).includes('shape'));
  assert.equal(verification.ok, false);
});

test('pair verifier: identity/market divergence from the artifact fails artifact-binding', async () => {
  const pair = await cleanPair();
  for (const mutate of [
    (s: Record<string, unknown>) => {
      s['gameId'] = 'not-the-artifact-game';
    },
    (s: Record<string, unknown>) => {
      s['requestSha256'] = 'f'.repeat(64);
    },
    (s: Record<string, unknown>) => {
      s['scopedMarkets'] = ['total', 'moneyline']; // reordered — canonical order is binding
    },
  ]) {
    const verification = verifySpendEvidence({ artifactBytes: pair.artifactBytes, sidecar: mutatedSidecar(pair, mutate) });
    assert.ok(failedNames(verification).includes('artifact-binding'), JSON.stringify(verification.checks));
    assert.equal(verification.ok, false);
  }
});

test('pair verifier: an incoherent never-sent row (erasing a sent attempt) fails attempt-completeness', async () => {
  const pair = await cleanPair();
  const verification = verifySpendEvidence({
    artifactBytes: pair.artifactBytes,
    sidecar: mutatedSidecar(pair, (s) => {
      const row = rowsOf(s)[0]!;
      row['requestAt'] = null; // "never sent" — but responseAt/buckets remain, and the artifact SENT it
    }),
  });
  const failed = failedNames(verification);
  assert.ok(failed.includes('attempt-completeness'), JSON.stringify(verification.checks));
  assert.equal(verification.ok, false);
});

test('pair verifier: responseAt must be a canonical instant and bind to the artifact receipt', async () => {
  const pair = await cleanPair();

  const malformed = verifySpendEvidence({
    artifactBytes: pair.artifactBytes,
    sidecar: mutatedSidecar(pair, (s) => {
      rowsOf(s)[0]!['responseAt'] = 'not-an-instant';
    }),
  });
  assert.ok(failedNames(malformed).includes('shape'), JSON.stringify(malformed.checks));
  assert.equal(malformed.ok, false);

  const substituted = verifySpendEvidence({
    artifactBytes: pair.artifactBytes,
    sidecar: mutatedSidecar(pair, (s) => {
      const row = rowsOf(s)[0]!;
      const requestAt = row['requestAt'] as string;
      row['responseAt'] = new Date(Date.parse(requestAt) + 86_400_000).toISOString();
    }),
  });
  assert.ok(failedNames(substituted).includes('attempt-completeness'), JSON.stringify(substituted.checks));
  assert.equal(substituted.ok, false);
});

test('pair verifier: a fabricated coherent never-sent repair row fails attempt-completeness', async () => {
  const pair = await cleanPair();
  const verification = verifySpendEvidence({
    artifactBytes: pair.artifactBytes,
    sidecar: mutatedSidecar(pair, (s) => {
      const initial = rowsOf(s)[0]!;
      rowsOf(s).push({
        participantId: initial['participantId'],
        provider: initial['provider'],
        requestedModelId: initial['requestedModelId'],
        role: 'repair',
        requestAt: null,
        responseAt: null,
        usageTokens: null,
        spendClass: 'zero',
        status: 'pass',
        derivedActualUsdMicros: null,
      });
    }),
  });
  assert.ok(failedNames(verification).includes('attempt-completeness'), JSON.stringify(verification.checks));
  assert.equal(verification.ok, false);
});

test('pair verifier: coordinated noncanonical market order fails artifact-binding', async () => {
  const pair = await cleanPair();
  const artifact = JSON.parse(pair.artifactBytes) as Record<string, unknown>;
  artifact['scopedMarkets'] = [...(artifact['scopedMarkets'] as string[])].reverse();
  const verification = verifySpendEvidence({
    artifactBytes: JSON.stringify(artifact),
    sidecar: mutatedSidecar(pair, (s) => {
      s['scopedMarkets'] = [...(s['scopedMarkets'] as string[])].reverse();
    }),
  });
  assert.ok(failedNames(verification).includes('artifact-binding'), JSON.stringify(verification.checks));
  assert.equal(verification.ok, false);
});

test('pair verifier: a __proto__ token key fails shape and does NOT pollute Object.prototype', async () => {
  const pair = await cleanPair();
  const before = ({} as Record<string, unknown>)['ospexPolluted'];
  const verification = verifySpendEvidence({
    artifactBytes: pair.artifactBytes,
    sidecar: mutatedSidecar(pair, (s) => {
      (rowsOf(s)[0]!['usageTokens'] as Record<string, number>)['__proto__.ospexPolluted'] = 1337;
    }),
  });
  assert.ok(failedNames(verification).includes('shape'), JSON.stringify(verification.checks));
  assert.equal(verification.ok, false);
  assert.equal(({} as Record<string, unknown>)['ospexPolluted'], before, 'Object.prototype is untouched');
  assert.equal(before, undefined);
});

test('pair verifier: a tampered or unparseable artifact fails artifact-integrity before anything else', async () => {
  const pair = await cleanPair();
  // Unparseable bytes.
  const broken = verifySpendEvidence({ artifactBytes: '{ not json', sidecar: pair.sidecar });
  assert.deepEqual(failedNames(broken), ['artifact-integrity']);
  // Parse-clean but digest-tampered: flip the artifact's requestSha256 value in the bytes —
  // the strict parse may accept the shape, but the digest replay must refuse the witness.
  const parsed = JSON.parse(pair.artifactBytes) as Record<string, unknown>;
  parsed['requestSha256'] = 'f'.repeat(64);
  const tampered = verifySpendEvidence({ artifactBytes: JSON.stringify(parsed), sidecar: pair.sidecar });
  assert.ok(failedNames(tampered).includes('artifact-integrity'), JSON.stringify(tampered.checks));
});

test('pair verifier: exact per-attempt values on the clean pair (ceiling arithmetic, shared with the guard)', async () => {
  const pair = await cleanPair();
  const verification = verifySpendEvidence({ artifactBytes: pair.artifactBytes, sidecar: pair.sidecar });
  assert.equal(verification.ok, true, JSON.stringify(verification.checks));
  // Hand-computed at the pinned v4 rates (µUSD): openai 1×25 + 1×90 = 115;
  // anthropic 1×10 + 1×50 = 60; google 1465×4 + (471+305)×18 = 19_828; xai 1×4 + 1×12 = 16.
  assert.deepEqual(
    verification.attempts.map((a) => [a.participantId, a.derivedActualUsdMicros]),
    [
      ['openai-gpt-5.6-sol', 115],
      ['anthropic-claude-fable-5', 60],
      ['google-gemini-3.1-pro-preview', 19_828],
      ['xai-grok-4.5', 16],
    ],
  );
  assert.equal(verification.aggregateUsdMicros, 115 + 60 + 19_828 + 16);
});

test('pair verifier: the full-repair pair passes with 8 at-cap attempts summing EXACTLY to the $800 cap', async () => {
  const pair = await repairPair();
  const verification = verifySpendEvidence({ artifactBytes: pair.artifactBytes, sidecar: pair.sidecar });
  assert.deepEqual(failedNames(verification), [], JSON.stringify(verification.checks));
  assert.equal(verification.attempts.length, 8, 'four initials + four repairs');
  assert.ok(
    verification.attempts.every((a) => a.derivedActualUsdMicros === 100_000_000),
    'every attempt EXACTLY at the reservation — the == boundary passes',
  );
  assert.equal(verification.aggregateUsdMicros, 800_000_000, 'the aggregate == the crossing cap boundary passes');
});

test('pair verifier: a MISSING repair row (artifact sent it) fails attempt-completeness', async () => {
  const pair = await repairPair();
  const verification = verifySpendEvidence({
    artifactBytes: pair.artifactBytes,
    sidecar: mutatedSidecar(pair, (s) => {
      const rows = rowsOf(s);
      const index = rows.findIndex((r) => r['role'] === 'repair');
      rows.splice(index, 1);
    }),
  });
  assert.ok(failedNames(verification).includes('attempt-completeness'), JSON.stringify(verification.checks));
  assert.equal(verification.ok, false);
});

test('pair verifier: an over-reservation row (one micro-step over, honestly recorded) fails within-reservation only', async () => {
  const pair = await cleanPair();
  const verification = verifySpendEvidence({
    artifactBytes: pair.artifactBytes,
    sidecar: mutatedSidecar(pair, (s) => {
      const row = rowsOf(s).find((r) => (r['participantId'] as string).startsWith('anthropic'))!;
      row['usageTokens'] = { input_tokens: 10_000_001, output_tokens: 0 }; // 100,000,010 µUSD
      row['status'] = 'breach';
      row['derivedActualUsdMicros'] = 100_000_010;
      s['reason'] = 'spend_attempt_over_reservation';
    }),
  });
  // The record is internally coherent (status/derived/reason all recomputed-consistent), so
  // the money bound is the sole failure. The aggregate stays under the cap with four
  // attempts — an aggregate-over-cap failure is reachable only jointly with a reservation
  // failure, since 8 attempts × $100 equals the cap exactly.
  assert.deepEqual(failedNames(verification), ['attempts-within-reservation'], JSON.stringify(verification.checks));
  assert.equal(verification.ok, false);
});

test('pair verifier CLI: valid pair passes; truncated and final-round relational mutations fail; wrong arity exits 2', async () => {
  const pair = await cleanPair();
  const dir = mkdtempSync(join(tmpdir(), 'verify-pair-'));
  const artifactPath = join(dir, 'fire.json');
  const sidecarPath = join(dir, 'fire-spend.json');
  const truncatedPath = join(dir, 'truncated-spend.json');
  const malformedResponsePath = join(dir, 'malformed-response-spend.json');
  const fabricatedRepairPath = join(dir, 'fabricated-repair-spend.json');
  const noncanonicalArtifactPath = join(dir, 'noncanonical-fire.json');
  const noncanonicalSidecarPath = join(dir, 'noncanonical-spend.json');
  writeFileSync(artifactPath, pair.artifactBytes);
  writeFileSync(sidecarPath, JSON.stringify(pair.sidecar, null, 2));
  writeFileSync(
    truncatedPath,
    JSON.stringify(
      mutatedSidecar(pair, (s) => {
        s['attempts'] = rowsOf(s).slice(0, 1);
      }),
      null,
      2,
    ),
  );
  writeFileSync(
    malformedResponsePath,
    JSON.stringify(
      mutatedSidecar(pair, (s) => {
        rowsOf(s)[0]!['responseAt'] = 'not-an-instant';
      }),
      null,
      2,
    ),
  );
  writeFileSync(
    fabricatedRepairPath,
    JSON.stringify(
      mutatedSidecar(pair, (s) => {
        const initial = rowsOf(s)[0]!;
        rowsOf(s).push({
          participantId: initial['participantId'],
          provider: initial['provider'],
          requestedModelId: initial['requestedModelId'],
          role: 'repair',
          requestAt: null,
          responseAt: null,
          usageTokens: null,
          spendClass: 'zero',
          status: 'pass',
          derivedActualUsdMicros: null,
        });
      }),
      null,
      2,
    ),
  );
  const noncanonicalArtifact = JSON.parse(pair.artifactBytes) as Record<string, unknown>;
  noncanonicalArtifact['scopedMarkets'] = [...(noncanonicalArtifact['scopedMarkets'] as string[])].reverse();
  writeFileSync(noncanonicalArtifactPath, JSON.stringify(noncanonicalArtifact, null, 2));
  writeFileSync(
    noncanonicalSidecarPath,
    JSON.stringify(
      mutatedSidecar(pair, (s) => {
        s['scopedMarkets'] = [...(s['scopedMarkets'] as string[])].reverse();
      }),
      null,
      2,
    ),
  );

  const scriptPath = fileURLToPath(new URL('./verifySpendSidecar.ts', import.meta.url));
  const repoRoot = dirname(dirname(scriptPath));
  const run = (args: string[]): { status: number | null; out: string } => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
      input: '',
    });
    return { status: result.status, out: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
  };

  const pass = run([artifactPath, sidecarPath]);
  assert.equal(pass.status, 0, pass.out);
  assert.match(pass.out, /VERDICT: PASS/);
  assert.match(pass.out, /\[ok\] attempt-completeness/);

  const fail = run([artifactPath, truncatedPath]);
  assert.equal(fail.status, 1, fail.out);
  assert.match(fail.out, /VERDICT: FAIL/);
  assert.match(fail.out, /\[FAIL\] attempt-completeness/);

  const malformedResponse = run([artifactPath, malformedResponsePath]);
  assert.equal(malformedResponse.status, 1, malformedResponse.out);
  assert.match(malformedResponse.out, /VERDICT: FAIL/);
  assert.match(malformedResponse.out, /\[FAIL\] shape/);

  const fabricatedRepair = run([artifactPath, fabricatedRepairPath]);
  assert.equal(fabricatedRepair.status, 1, fabricatedRepair.out);
  assert.match(fabricatedRepair.out, /VERDICT: FAIL/);
  assert.match(fabricatedRepair.out, /\[FAIL\] attempt-completeness/);

  const noncanonicalScope = run([noncanonicalArtifactPath, noncanonicalSidecarPath]);
  assert.equal(noncanonicalScope.status, 1, noncanonicalScope.out);
  assert.match(noncanonicalScope.out, /VERDICT: FAIL/);
  assert.match(noncanonicalScope.out, /\[FAIL\] artifact-binding/);

  const arity = run([sidecarPath]);
  assert.equal(arity.status, 2, arity.out);
});

test('an over-reservation REPAIR attempt escalates with role repair — the repair leg reaches the guard', async () => {
  const snapshot = sealed({ manifestExtra: V2_PIN });
  const cohortId = snapshot.booted.cohortId;
  const game = scopedGame(GAME_ID, BOTH);
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
  const map = new Map<string, ProviderAdapter>();
  for (const id of snapshot.expectedArmIdentities) {
    const target = id.participantId === ANTHROPIC_ARM_ID;
    const clean = validBody(id.participantId, id.requestedModelId, cohortId, snapshot.prepared.requestSha256, game);
    // The target arm's INITIAL is shape-valid with a complete decision fingerprint but fails the
    // semantic evidence check (an unknown evidenceRef) — the one class of defect a repair may fix —
    // with clean priced usage; its REPAIR returns the clean body (fingerprint preserved) but
    // reports over-reservation usage. Every other arm is clean throughout.
    const bogusRef = (): string => {
      const parsed = JSON.parse(clean) as { games: Array<{ forecasts: Array<{ evidenceRefs: string[] }> }> };
      parsed.games[0]!.forecasts[0]!.evidenceRefs = ['ev:not-a-real-ref'];
      return JSON.stringify(parsed);
    };
    const s = scriptedAdapter(id, (call) => (target && call === 1 ? bogusRef() : clean), {
      usageRawFor: (call) => (target && call === 2 ? OVER_CAP_USAGE : pricedUsageFor(id.provider)),
    });
    map.set(id.participantId, s.adapter);
  }
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  const outcome = await runOneFire({
    snapshot,
    capability: mintInjectedAdapterCapability({ adapters: map, billingClass: 'billable' }),
    claimPort: new StoreClaimPort(store),
    sink,
    runOptions: runOpts(),
    admission: ADMISSION,
    now: () => NOW_MS,
  });
  assert.equal(outcome.kind, 'InstalledEscalated');
  if (outcome.kind !== 'InstalledEscalated') return;
  assert.equal(outcome.reason, 'spend_attempt_over_reservation');
  assert.deepEqual(
    outcome.offenders.map((o) => ({ ...o })),
    [{ participantId: ANTHROPIC_ARM_ID, role: 'repair', status: 'breach', derivedActualUsdMicros: OVER_CAP_DERIVED_USD_MICROS }],
  );
  assert.equal(sink.calls.length, 1, 'the escalated fire still installed its evidence');
  assert.equal(store.completeCalls.length, 0, 'never settled');
  // The durable sidecar records the REPAIR leg with its over-cap token buckets.
  const repairEntry = sink.sidecarCalls[0]!.arg.attempts.find(
    (a) => a.participantId === ANTHROPIC_ARM_ID && a.role === 'repair',
  );
  assert.deepEqual({ ...repairEntry?.usageTokens }, { input_tokens: 10_000_001, output_tokens: 0 });
  assert.equal(repairEntry?.status, 'breach');
});

test('a BILLABLE fire under a manifest that does not pin the guard price table refuses PRE-CLAIM', async () => {
  // The billable price-identity gate: money may only be judged under the price identity the
  // authenticated cohort precommitted to. The default fixture manifest pins the replay table,
  // so a billable fire under it must refuse BEFORE any claim — zero admissions, zero installs,
  // zero adapter calls, zero spend.
  const snapshot = sealed(); // default manifest: the replay table, NOT the guard table
  const cohortId = snapshot.booted.cohortId;
  const game = scopedGame(GAME_ID, BOTH);
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
  const { map, scripts } = validAdapters(snapshot, cohortId, game);
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  await assert.rejects(
    () =>
      runOneFire({
        snapshot,
        capability: mintInjectedAdapterCapability({ adapters: map, billingClass: 'billable' }),
        claimPort: new StoreClaimPort(store),
        sink,
        runOptions: runOpts(),
        admission: ADMISSION,
        now: () => NOW_MS,
      }),
    (e) => e instanceof BillablePriceIdentityError,
  );
  assert.equal(store.admitCalls.length, 0, 'refused before any claim');
  assert.equal(sink.calls.length, 0, 'nothing installed');
  assert.equal(scripts.reduce((n, s) => n + s.calls, 0), 0, 'zero adapter calls');
  // Negative control: the SAME manifest is fine for a known-zero fire (existing suites run it
  // throughout); the gate is billable-only.
});

test('an escalated outcome carries NO live settlement authority — no permit, nothing that settles', async () => {
  const { outcome } = await fireOf({
    billingClass: 'billable',
    manifestExtra: V2_PIN,
    usageRawFor: (id) => (id.participantId === ANTHROPIC_ARM_ID ? OVER_CAP_USAGE : pricedUsageFor(id.provider)),
  });
  assert.equal(outcome.kind, 'InstalledEscalated');
  if (outcome.kind !== 'InstalledEscalated') return;
  // Type-level: the member has no `permit`. Runtime: no own property of the outcome — at any
  // top-level position — authenticates as a DispatchPermit, so a caller holding this record
  // cannot resolve a completion capability from it.
  assert.ok(!('permit' in outcome), 'the escalated outcome exposes no permit key');
  for (const [key, value] of Object.entries(outcome)) {
    assert.throws(
      () => assertDispatchPermit(value as unknown as DispatchPermit),
      `outcome.${key} must not authenticate as a permit`,
    );
  }
  // The record is frozen — a consumer cannot graft settlement authority onto it either.
  assert.ok(Object.isFrozen(outcome));
});

test('a NON-money guard fault installs the artifact FIRST, then surfaces loudly with the cause and path', async () => {
  // A hostile/buggy usage object whose token field THROWS a plain error when read: the guard's
  // contract is to rethrow non-money faults, and before this seam existed that throw escaped
  // BETWEEN dispatch and install — losing the paid attempt's canonical evidence. Now the
  // artifact must durably install before the fault surfaces, settlement must never run, and
  // the typed error must carry the original cause plus the installed path.
  const sentinel = new Error('unexpected adapter/guard bug after a response');
  // NON-enumerable: an enumerating walker (spread / JSON / entries) elsewhere in the pipeline
  // never touches it, but the guard's arithmetic reads the token field by DIRECT keyed access
  // (after an Object.hasOwn check, which sees non-enumerable own keys) — so the fault fires
  // exactly at guard evaluation, the case this seam exists for.
  const faultingUsage = Object.defineProperty({ output_tokens: 0 }, 'input_tokens', {
    enumerable: false,
    get() {
      throw sentinel;
    },
  });
  const snapshot = sealed({ manifestExtra: V2_PIN });
  const cohortId = snapshot.booted.cohortId;
  const game = scopedGame(GAME_ID, BOTH);
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
  const { map } = validAdapters(snapshot, cohortId, game, (id) =>
    id.participantId === ANTHROPIC_ARM_ID ? faultingUsage : pricedUsageFor(id.provider),
  );
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  await assert.rejects(
    () =>
      runOneFire({
        snapshot,
        capability: mintInjectedAdapterCapability({ adapters: map, billingClass: 'billable' }),
        claimPort: new StoreClaimPort(store),
        sink,
        runOptions: runOpts(),
        admission: ADMISSION,
        now: () => NOW_MS,
      }),
    (e) => {
      if (!(e instanceof SpendGuardInternalError)) return false;
      assert.strictEqual(e.cause, sentinel, 'the original fault is preserved as the cause');
      assert.equal(e.installedArtifactPath, (sink.calls[0]!.result as { path: string }).path);
      return true;
    },
  );
  assert.equal(sink.calls.length, 1, 'the paid-attempt artifact durably installed BEFORE the fault surfaced');
  assert.equal(store.completeCalls.length, 0, 'a guard fault never settles');
  assert.equal(sink.sidecarCalls.length, 0, 'no verdict was reached, so no sidecar');
});

test('the escalation sidecar is durable, identity-bound, recomputable, and hashed into the outcome', async () => {
  const { outcome, sink } = await fireOf({
    billingClass: 'billable',
    manifestExtra: V2_PIN,
    usageRawFor: (id) => (id.participantId === ANTHROPIC_ARM_ID ? OVER_CAP_USAGE : pricedUsageFor(id.provider)),
  });
  assert.equal(outcome.kind, 'InstalledEscalated');
  if (outcome.kind !== 'InstalledEscalated') return;

  assert.equal(sink.sidecarCalls.length, 1, 'exactly one durable sidecar install');
  const record = sink.sidecarCalls[0]!.arg;
  // Identity binds to the EXACT installed artifact.
  assert.equal(record.cohortId, outcome.artifact.cohortId);
  assert.equal(record.fireId, outcome.artifact.fireId);
  assert.equal(record.runId, outcome.artifact.runId);
  assert.equal(record.gameId, outcome.artifact.gameId);
  assert.equal(record.requestSha256, outcome.artifact.requestSha256);
  assert.deepEqual([...record.scopedMarkets], [...outcome.artifact.scopedMarkets]);
  // The judged price identity + cap are pinned durably.
  assert.equal(record.reason, 'spend_attempt_over_reservation');
  assert.equal(record.priceVersion, SPEND_GUARD_PRICE_TABLE_VERSION);
  assert.equal(record.priceTableDigest, modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION));
  assert.equal(record.perAttemptReservationUsdMicros, 100_000_000);
  // The offending attempt's raw token buckets survive, redacted to counts.
  const offender = record.attempts.find((a) => a.participantId === ANTHROPIC_ARM_ID && a.role === 'initial');
  assert.deepEqual({ ...offender?.usageTokens }, { input_tokens: 10_000_001, output_tokens: 0 });
  assert.equal(offender?.status, 'breach');
  assert.equal(offender?.spendClass, 'price');
  assert.equal(offender?.derivedActualUsdMicros, 100_000_010);
  assert.equal(typeof offender?.requestAt, 'string', 'the sent fact is recorded');
  // A PASSING attempt is recorded too — the whole-fire verdict is recomputable from the record.
  const passing = record.attempts.find((a) => a.provider === 'openai' && a.role === 'initial');
  assert.equal(passing?.status, 'pass');
  assert.equal(passing?.spendClass, 'price');
  assert.deepEqual({ ...passing?.usageTokens }, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  // The outcome's hash is the hash of the EXACT record the sink installed, and the path is the
  // sink's durable result beside the artifact.
  assert.equal(outcome.sidecar.sha256, spendEscalationSidecarSha256(record));
  assert.equal(outcome.sidecar.path, (sink.sidecarCalls[0]!.result as { path: string }).path);
  assert.equal(outcome.sidecar.created, true);
  assert.match(outcome.sidecar.path, /-spend\.json$/);
  assert.notEqual(outcome.sidecar.path, outcome.install.path, 'a separately named durable record');
});

test('the sidecar is token-count-only: content-bearing fields in usageRaw never reach the durable bytes', async () => {
  const poisoned = {
    input_tokens: 10_000_001,
    output_tokens: 0,
    secret_note: 'THE-RAW-CONTENT-MARKER',
    nested: { prompt_excerpt: 'ANOTHER-CONTENT-MARKER' },
  };
  const { outcome, sink } = await fireOf({
    billingClass: 'billable',
    manifestExtra: V2_PIN,
    usageRawFor: (id) => (id.participantId === ANTHROPIC_ARM_ID ? poisoned : pricedUsageFor(id.provider)),
  });
  assert.equal(outcome.kind, 'InstalledEscalated');
  const bytes = serializeSpendEscalationSidecar(sink.sidecarCalls[0]!.arg);
  assert.ok(!bytes.includes('THE-RAW-CONTENT-MARKER'), 'unlisted string fields are never persisted');
  assert.ok(!bytes.includes('ANOTHER-CONTENT-MARKER'), 'nested content is never persisted');
  const offender = sink.sidecarCalls[0]!.arg.attempts.find((a) => a.participantId === ANTHROPIC_ARM_ID);
  assert.deepEqual({ ...offender?.usageTokens }, { input_tokens: 10_000_001, output_tokens: 0 });
});

test('the sidecar install is atomic no-clobber: identical bytes are idempotent, different bytes fail loud', async () => {
  const fs = new MemoryFs();
  const sink = new FireArtifactSink('/base', fs);
  const record: SpendEscalationSidecarV1 = {
    sidecarSchemaVersion: 1,
    cohortId: 'a'.repeat(64),
    fireId: 'b'.repeat(64),
    runId: 'c'.repeat(64),
    gameId: GAME_ID,
    scopedMarkets: ['moneyline', 'total'],
    requestSha256: 'd'.repeat(64),
    reason: 'spend_attempt_over_reservation',
    priceVersion: SPEND_GUARD_PRICE_TABLE_VERSION,
    priceTableDigest: modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION),
    perAttemptReservationUsdMicros: 100_000_000,
    attempts: [],
  };
  const first = sink.installSpendEscalationSidecar(record);
  assert.equal(first.created, true);
  assert.equal(fs.readFile(first.path).toString('utf8'), serializeSpendEscalationSidecar(record));
  // An exact-byte retry is idempotent...
  const retry = sink.installSpendEscalationSidecar(record);
  assert.deepEqual(retry, { path: first.path, created: false });
  // ...and a byte-different record at the same identity fails loud, never overwriting.
  const different = { ...record, perAttemptReservationUsdMicros: 200_000_000 };
  assert.throws(
    () => sink.installSpendEscalationSidecar(different),
    /refusing to overwrite a byte-different spend escalation sidecar/,
  );
  assert.equal(fs.readFile(first.path).toString('utf8'), serializeSpendEscalationSidecar(record), 'original bytes intact');
});

test('the fire seam rejects a raw adapter map, a structural lookalike, and a copied capability', async () => {
  const snapshot = sealed();
  const cohortId = snapshot.booted.cohortId;
  const game = scopedGame(GAME_ID, BOTH);
  const { map } = validAdapters(snapshot, cohortId, game);
  const genuine = knownZeroCap(map);
  const impostors: Array<[string, unknown]> = [
    ['raw adapter map', map],
    ['structural lookalike', { billingClass: 'known-zero', adapters: () => new Map(map) }],
    ['spread copy of a genuine capability', { ...genuine }],
  ];
  for (const [label, impostor] of impostors) {
    const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
    const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
    await assert.rejects(
      () =>
        runOneFire({
          snapshot,
          capability: impostor as CohortAdapterCapability,
          claimPort: new StoreClaimPort(store),
          sink,
          runOptions: runOpts(),
          admission: ADMISSION,
          now: () => NOW_MS,
        }),
      /not a minted cohort adapter capability/,
      `${label} must fail the brand`,
    );
    assert.equal(store.admitCalls.length, 0, `${label}: rejected before any admission`);
    assert.equal(sink.calls.length, 0, `${label}: nothing installed`);
  }
});

// ===========================================================================
// the real-shaped fake capability: no-network sentinel, dry-vs-real-shaped
// artifact parity, and the mock-blind classification paths
// ===========================================================================

/** Run one fire with the given capability over a fresh store/sink and require Installed.
 *  `timeoutMs` stays SMALL: the mock xai arm sleeps past the timeout before its typed
 *  timeout throw, so the dispatch timeout bounds this test's wall clock. */
async function capabilityFire(
  capability: CohortAdapterCapability,
  snapshot: PreparedFireSnapshot,
): Promise<{ artifact: FireArtifactV1; store: ScriptedStore }> {
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  const outcome = await runOneFire({
    snapshot,
    capability,
    claimPort: new StoreClaimPort(store),
    sink,
    runOptions: runOpts({ timeoutMs: 200 }),
    admission: ADMISSION,
    now: () => NOW_MS,
  });
  if (outcome.kind !== 'Installed') throw new Error(`capability fire: expected Installed, got ${outcome.kind}`);
  return { artifact: outcome.artifact, store };
}

/** Collect every differing leaf path between two plain-JSON trees (dotted/indexed paths). */
function collectDiffPaths(a: unknown, b: unknown, path: string, out: string[]): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(path);
      return;
    }
    for (let i = 0; i < a.length; i += 1) collectDiffPaths(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      collectDiffPaths(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        path === '' ? key : `${path}.${key}`,
        out,
      );
    }
    return;
  }
  if (!Object.is(a, b)) out.push(path);
}

/**
 * The POSITIVE, EXHAUSTIVE allow-list of leaf paths where a dry (mock) artifact and a
 * real-shaped-fake artifact may legitimately differ — response TEXT, its exact transitive
 * digest dependencies, and per-attempt TIMING. (A provider response id is a legitimate
 * difference too, but it is deliberately not persisted into the artifact, so it cannot
 * appear as a diff path.) Whole digest subtrees are NOT ignored: `verifyFireArtifactReplay`
 * RECOMPUTES every derived digest (responseSha256, acceptedResponseDigest, armDigest) from
 * each candidate artifact, so an allowed-to-differ digest is still proven internally correct.
 */
const PARITY_ALLOWED_LEAF_PATTERNS: readonly RegExp[] = [
  // The response text itself...
  /^arms\[\d+\]\.orderedAttempts\[\d+\]\.persistedResponseBody$/,
  // ...and its exact transitive digest dependencies:
  /^arms\[\d+\]\.orderedAttempts\[\d+\]\.responseSha256$/,
  /^arms\[\d+\]\.acceptedResponseDigest$/,
  /^arms\[\d+\]\.armDigest$/,
  // Per-attempt timing (deterministic here under the one injected tick clock, allowed
  // because timing is a legitimate leaf difference by contract):
  /^arms\[\d+\]\.initialRequestStartedAt$/,
  /^arms\[\d+\]\.orderedAttempts\[\d+\]\.(requestStartedAt|requestReceivedAt|acceptedAt)$/,
];

function assertParity(mockArtifact: FireArtifactV1, fakeArtifact: FireArtifactV1): string[] {
  // Compare the CANONICAL persisted bytes' JSON (the serializer authenticates + redacts),
  // so the comparison is over exactly what a scorer would re-parse.
  const mockJson = JSON.parse(serializeFireArtifactV1(mockArtifact)) as unknown;
  const fakeJson = JSON.parse(serializeFireArtifactV1(fakeArtifact)) as unknown;
  const diffs: string[] = [];
  collectDiffPaths(mockJson, fakeJson, '', diffs);
  const disallowed = diffs.filter((d) => !PARITY_ALLOWED_LEAF_PATTERNS.some((p) => p.test(d)));
  assert.deepEqual(disallowed, [], `unrelated divergence between dry and real-shaped artifacts: ${disallowed.join(', ')}`);
  // Each allowed derived digest is RECOMPUTED from its candidate artifact and checked.
  assert.deepEqual(verifyFireArtifactReplay(mockArtifact), []);
  assert.deepEqual(verifyFireArtifactReplay(fakeArtifact), []);
  return diffs;
}

test('the real-shaped fake fires with ZERO network: a throwing fetch sentinel is never touched', async () => {
  const snapshot = sealed();
  const originalFetch = globalThis.fetch;
  let fetchTouches = 0;
  globalThis.fetch = (async () => {
    fetchTouches += 1;
    throw new Error('network sentinel: the real-shaped fake must never fetch');
  }) as typeof fetch;
  try {
    // Positive control first: the sentinel genuinely throws when touched.
    await assert.rejects(() => globalThis.fetch('https://example.invalid'), /network sentinel/);
    fetchTouches = 0;
    const { artifact } = await capabilityFire(createCohortRealShapedFakeCapability({ simulateCollision: false }), snapshot);
    assert.equal(fetchTouches, 0, 'a whole real-shaped-fake fire reaches the fetch seam zero times');
    assert.ok(artifact.arms.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('dry vs real-shaped parity: same fire, byte-identical artifacts outside the allow-listed leaves', async () => {
  const snapshot = sealed();
  const { artifact: mockArtifact } = await capabilityFire(createCohortMockAdapterCapability({ simulateCollision: false }), snapshot);
  const { artifact: fakeArtifact } = await capabilityFire(
    createCohortRealShapedFakeCapability({ simulateCollision: false }),
    snapshot,
  );

  const diffs = assertParity(mockArtifact, fakeArtifact);

  // Diagnosticity: the fake's realistic text envelope MUST have produced text-leaf
  // differences (else this test could pass with a comparator that compares nothing).
  assert.ok(
    diffs.some((d) => /persistedResponseBody$/.test(d)),
    'the real-shaped envelope differs in at least one persisted response body',
  );
  assert.ok(
    diffs.some((d) => /armDigest$/.test(d)),
    'a text difference transitively moves the arm digest',
  );
  // Load-bearing EQUALITIES: decisions, outcomes, identity, and usage are byte-identical.
  const mockJson = JSON.parse(serializeFireArtifactV1(mockArtifact)) as FireArtifactV1;
  const fakeJson = JSON.parse(serializeFireArtifactV1(fakeArtifact)) as FireArtifactV1;
  assert.deepEqual(
    fakeJson.arms.map((a) => a.terminalOutcome),
    mockJson.arms.map((a) => a.terminalOutcome),
  );
  assert.deepEqual(
    fakeJson.arms.map((a) => a.acceptedDecisionFingerprint),
    mockJson.arms.map((a) => a.acceptedDecisionFingerprint),
  );
  assert.deepEqual(
    fakeJson.arms.map((a) => a.orderedAttempts.map((at) => at.usage)),
    mockJson.arms.map((a) => a.orderedAttempts.map((at) => at.usage)),
  );

  // Negative control: a NON-allow-listed leaf difference must FAIL the comparator — a
  // token count is nudged on a plain reparse and the diff must surface as disallowed.
  const tampered = JSON.parse(serializeFireArtifactV1(fakeArtifact)) as {
    arms: Array<{ orderedAttempts: Array<{ usage: { inputTokens: number | null } | null }> }>;
  };
  const usage = tampered.arms
    .flatMap((a) => a.orderedAttempts)
    .map((at) => at.usage)
    .find((u) => u !== null && u.inputTokens !== null);
  assert.ok(usage, 'fixture: a priced attempt exists to tamper');
  usage.inputTokens = (usage.inputTokens as number) + 1;
  const tamperedDiffs: string[] = [];
  collectDiffPaths(JSON.parse(serializeFireArtifactV1(mockArtifact)), tampered, '', tamperedDiffs);
  const tamperedDisallowed = tamperedDiffs.filter((d) => !PARITY_ALLOWED_LEAF_PATTERNS.some((p) => p.test(d)));
  assert.ok(
    tamperedDisallowed.some((d) => /usage\.inputTokens$/.test(d)),
    'the tampered token count is reported as an unrelated (disallowed) divergence',
  );
});

test('the fake exercises the mock-blind paths: unapproved model echo FAILS the identity check', async () => {
  const snapshot = sealed();
  const { artifact } = await capabilityFire(createCohortRealShapedFakeCapability({ simulateCollision: true }), snapshot);

  const inputs = artifact.expectedArmIdentities.map((identity, i) => {
    const attempts = artifact.arms[i]!.orderedAttempts;
    const reported = [...new Set(attempts.map((a) => a.reportedModelId).filter((id): id is string => id !== null))];
    const unidentified = attempts.filter((a) => a.persistedResponseBody !== null && a.reportedModelId === null).length;
    return {
      participantId: identity.participantId,
      provider: identity.provider as ProviderName,
      requestedModelId: identity.requestedModelId,
      approvedReportedModelIds: [...identity.approvedReportedModelIds],
      configuration: {},
      // The line-open path runs the all-defaults roster: `expectedArmIdentity`
      // refuses a roster entry that declares a configuration, so every arm
      // reaching here carries the empty one.
      configurationSha256: EMPTY_CONFIGURATION_SHA256,
      reportedModelIds: reported,
      unidentifiedResponses: unidentified,
    };
  });
  const collided = checkProviderCollision(inputs);
  assert.ok(
    collided.failures.some((f) => /MODEL_IDENTITY/.test(f) && /unapproved model ID "gpt-5\.6-sol"/.test(f)),
    'the collided echo is refused fail-closed against the approved list',
  );
  assert.ok(
    collided.failures.some((f) => /PROVIDER_COLLISION/.test(f) && /identical configuration/.test(f)),
    'the substituted arm is now indistinguishable from the real one as an entrant',
  );
  assert.ok(
    collided.failures.some((f) => /PROVIDER_COLLISION/.test(f) && /but responses report the/.test(f)),
    'and its reported family contradicts the provider it was requested from',
  );

  // Negative control: the CLEAN fake passes the same fail-closed check outright.
  const clean = await capabilityFire(createCohortRealShapedFakeCapability({ simulateCollision: false }), sealed());
  const cleanInputs = clean.artifact.expectedArmIdentities.map((identity, i) => {
    const attempts = clean.artifact.arms[i]!.orderedAttempts;
    const reported = [...new Set(attempts.map((a) => a.reportedModelId).filter((id): id is string => id !== null))];
    return {
      participantId: identity.participantId,
      provider: identity.provider as ProviderName,
      requestedModelId: identity.requestedModelId,
      approvedReportedModelIds: [...identity.approvedReportedModelIds],
      configuration: {},
      configurationSha256: EMPTY_CONFIGURATION_SHA256,
      reportedModelIds: reported,
      unidentifiedResponses: 0,
    };
  });
  assert.deepEqual(checkProviderCollision(cleanInputs).failures, []);
});

test('the fake exercises 429, timeout, and prose+fence repair classification through a whole fire', async () => {
  const snapshot = sealed();
  const { artifact } = await capabilityFire(
    createCohortRealShapedFakeCapability({ simulateCollision: false, rateLimitedGameId: GAME_ID }),
    snapshot,
  );
  const byParticipant = new Map(artifact.arms.map((a) => [a.expectedArmIdentity.participantId, a]));
  // HTTP 429 → rate_limited, never a model failure.
  assert.equal(byParticipant.get('openai-gpt-5.6-sol')!.terminalOutcome, 'rate_limited');
  // The xai fake directly emits the same typed timeout classification as the mock's
  // never-answering scenario; no wall-clock wait is simulated here.
  assert.equal(byParticipant.get('xai-grok-4.5')!.terminalOutcome, 'timeout');
  // Prose+fenced JSON with a wrong echo → parse succeeds, the single repair fixes the echo
  // with identical decisions: two persisted attempts, terminal valid, fingerprint accepted.
  const google = byParticipant.get('google-gemini-3.1-pro-preview')!;
  assert.equal(google.terminalOutcome, 'valid');
  assert.equal(google.orderedAttempts.length, 2, 'initial + fingerprint-preserving repair');
  assert.notEqual(google.acceptedDecisionFingerprint, null);
  // The clean-JSON arm stays valid on one attempt.
  assert.equal(byParticipant.get('anthropic-claude-fable-5')!.terminalOutcome, 'valid');
});

// ===========================================================================
// derivation, brand, and option capture
// ===========================================================================

test('the admission request is derived from the snapshot, plus only the two admission fields', () => {
  const snapshot = sealed();
  const request = buildFullScopeAdmitRequest(snapshot, ADMISSION);
  assert.equal(request.cohortId, snapshot.booted.cohortId);
  assert.equal(request.fireId, snapshot.fireId);
  assert.equal(request.gameId, snapshot.prepared.gameId);
  assert.deepEqual(request.proposedMarkets, [...snapshot.proposedMarkets]);
  assert.equal(request.ownerId, OWNER);
  assert.equal(request.expectedSchemaVersion, SCHEMA);
  const key = scopeKeyOf(snapshot.proposedMarkets);
  assert.deepEqual(Object.keys(request.scopeReservations), [key]);
  assert.equal(request.scopeReservations[key]!.preparedBytesDigest, snapshot.prepared.requestSha256);
  // The spend reservation is DERIVED from the booted manifest, never the caller. For the 4-arm,
  // one-repair, $100/attempt cohort that is exactly $800 = 4 × (1 + 1) × 100_000_000 — and it is not
  // a hardcoded literal: it equals the policy derivation over the manifest's own roster/repair/version.
  const derived = deriveFireSpendReservationUsdMicros({
    rosterSize: CODE_ARMS.length,
    maxRepairsPerArm: 1,
    version: 'fixed-attempt-v1',
  });
  assert.equal(request.scopeReservations[key]!.spendReservationUsdMicros, 800_000_000);
  assert.equal(request.scopeReservations[key]!.spendReservationUsdMicros, derived);
});

test('the caller cannot supply or override the spend reservation (runtime-extra is ignored)', () => {
  const snapshot = sealed();
  const key = scopeKeyOf(snapshot.proposedMarkets);
  // A runtime-extra spend field — the pre-derivation caller authority — is ignored; the derived value wins.
  const withExtra = { ...ADMISSION, spendReservationUsdMicros: 1 } as LineOpenAdmissionParameters;
  assert.equal(
    buildFullScopeAdmitRequest(snapshot, withExtra).scopeReservations[key]!.spendReservationUsdMicros,
    800_000_000,
  );
  // A hostile getter that WOULD leak a caller value if the builder ever read a caller spend field:
  // it must never be read, and cannot alter the derived value even after capture.
  let touched = false;
  const hostile = new Proxy({ ownerId: OWNER, expectedSchemaVersion: SCHEMA } as LineOpenAdmissionParameters, {
    get(target, prop, recv) {
      if (prop === 'spendReservationUsdMicros') {
        touched = true;
        return 1;
      }
      return Reflect.get(target, prop, recv);
    },
  });
  assert.equal(
    buildFullScopeAdmitRequest(snapshot, hostile).scopeReservations[key]!.spendReservationUsdMicros,
    800_000_000,
  );
  assert.equal(touched, false, 'the builder never reads a caller-supplied spend field');
});

test('the derived reservation varies exactly with roster and repair cap (per-attempt is the versioned policy constant)', () => {
  const manifest = (
    roster: number,
    maxRepairs: number,
    perAttempt = 100_000_000,
    version = 'fixed-attempt-v1',
  ): CohortManifestV1 =>
    ({
      spendReservationPolicyVersion: version,
      expectedArmRoster: new Array(roster).fill({
        participantId: 'x',
        provider: 'x',
        requestedModelId: 'x',
        approvedReportedModelIds: ['x'],
        configuration: {},
      }),
      constants: { providerAttemptReservationUsdMicros: perAttempt, maxRepairAttemptsPerArm: maxRepairs },
    }) as unknown as CohortManifestV1;
  assert.equal(deriveSpendReservationUsdMicros(manifest(4, 1)), 800_000_000); // current cohort
  assert.equal(deriveSpendReservationUsdMicros(manifest(3, 1)), 600_000_000); // fewer arms
  assert.equal(deriveSpendReservationUsdMicros(manifest(4, 0)), 400_000_000); // no repair
  assert.equal(deriveSpendReservationUsdMicros(manifest(4, 2)), 1_200_000_000); // two repairs
  assert.equal(deriveSpendReservationUsdMicros(manifest(1, 0)), 100_000_000); // single attempt
});

test('an unknown or amount-mismatched spend policy fails closed before any request is built', () => {
  // The derivation is the FIRST thing buildFullScopeAdmitRequest does after the brand check, and
  // runOneFire calls that builder before it admits or dispatches — so either throw yields zero
  // admission and zero adapter calls (the reservation is unbuildable).
  const roster = new Array(4).fill({
    participantId: 'x',
    provider: 'x',
    requestedModelId: 'x',
    approvedReportedModelIds: ['x'],
    configuration: {},
  });
  assert.throws(
    () =>
      deriveSpendReservationUsdMicros({
        spendReservationPolicyVersion: 'fixed-attempt-v2',
        expectedArmRoster: roster,
        constants: { providerAttemptReservationUsdMicros: 100_000_000, maxRepairAttemptsPerArm: 1 },
      } as unknown as CohortManifestV1),
    /unknown spend reservation policy version/,
  );
  assert.throws(
    () =>
      deriveSpendReservationUsdMicros({
        spendReservationPolicyVersion: 'fixed-attempt-v1',
        expectedArmRoster: roster,
        constants: { providerAttemptReservationUsdMicros: 99_999_999, maxRepairAttemptsPerArm: 1 },
      } as unknown as CohortManifestV1),
    /does not match spend-reservation policy/,
  );
});

test('a hand-built snapshot is rejected by the brand before any field is read', () => {
  const genuine = sealed();
  // A structural copy is not in the brand WeakSet.
  assert.throws(() => buildFullScopeAdmitRequest({ ...genuine }, ADMISSION), /was not produced/);
  // A hostile snapshot whose fields throw if touched: the brand assertion fires first.
  let touched = false;
  const hostile = new Proxy({} as PreparedFireSnapshot, {
    get(_t, prop) {
      touched = true;
      throw new Error(`hostile getter ${String(prop)} was read`);
    },
  });
  assert.throws(() => buildFullScopeAdmitRequest(hostile, ADMISSION), /was not produced/);
  assert.equal(touched, false, 'no snapshot field was read before the brand rejected it');
});

test('a runtime-extra hostile cohortId on the run options is ignored; the permit cohort is used', async () => {
  const hostileOptions = { ...runOpts(), cohortId: 'HOSTILE-COHORT' } as unknown as LineOpenRunOptions;
  // If the hostile cohort reached the runner, runAuthorizedDispatch would reject on the cohort
  // mismatch; a successful install proves the permit cohort was injected instead.
  const { outcome } = await fireOf({ runOptions: hostileOptions });
  assert.equal(outcome.kind, 'Installed');
});

test('each run-option field is read once, before admission, and a later mutation cannot change it', async () => {
  const reads: Record<string, number> = {};
  const backing = runOpts();
  const counting = {} as LineOpenRunOptions;
  // `nowMs` is no longer a run-option field (B2 — the dispatch clock is the tick clock threaded via
  // RunOneFireInput.now); the remaining five run-option fields must each be read exactly once.
  for (const field of ['timeoutMs', 'maxOutputTokens', 'executionPolicy', 'baselinePolicyVersion', 'onGameComplete'] as const) {
    Object.defineProperty(counting, field, {
      enumerable: true,
      get() {
        reads[field] = (reads[field] ?? 0) + 1;
        return (backing as Record<string, unknown>)[field];
      },
    });
  }
  const { outcome } = await fireOf({ runOptions: counting });
  assert.equal(outcome.kind, 'Installed');
  // All FIVE run-option fields — onGameComplete included — are read exactly once, before admission;
  // a post-admission re-read of any of them (e.g. `onGameComplete: input.runOptions.onGameComplete`)
  // reads its getter twice and turns this red.
  for (const field of ['timeoutMs', 'maxOutputTokens', 'executionPolicy', 'baselinePolicyVersion', 'onGameComplete'] as const) {
    assert.equal(reads[field], 1, `${field} read exactly once`);
  }
});

test('mutating the caller inputs while the claim is pending does not redirect the fire', async () => {
  const snapshot = sealed();
  const cohortId = snapshot.booted.cohortId;
  const game = scopedGame(GAME_ID, BOTH);
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
  const { map } = validAdapters(snapshot, cohortId, game);
  const realSink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  const port = new StoreClaimPort(store);
  // The EXACT input object the spine reads. Its claim-port wrapper, fired mid-admission (while the
  // claim is pending), swaps the sink's install AND the tick clock ON THIS OBJECT — the spine must
  // use the references it captured BEFORE the first await, not these later swaps.
  const fireInput: RunOneFireInput = {
    snapshot,
    capability: knownZeroCap(map),
    claimPort: {
      admit(req: AdmitDispatchRequest) {
        (realSink as { install: unknown }).install = () => {
          throw new Error('swapped install must never run');
        };
        // Swap the tick clock to one 10,000,000ms late: a re-read of input.now after the await would
        // put every initial's V-lag far past maxDispatchLagMs and gate out the whole fire.
        (fireInput as { now: () => number }).now = () => NOW_MS + 10_000_000;
        return port.admit(req);
      },
    },
    sink: realSink,
    runOptions: runOpts(),
    admission: { ...ADMISSION },
    now: () => NOW_MS,
  };
  const outcome = await runOneFire(fireInput);
  assert.equal(outcome.kind, 'Installed', 'the fire used the captured install + clock, not the swapped ones');
});

// ===========================================================================
// ordinary non-admitted values are quiet
// ===========================================================================

test('every ordinary NotAdmitted outcome is returned by identity with zero side effects', async () => {
  const outcomes = [
    { kind: 'WouldAdmit' as const },
    { kind: 'Defer' as const, reason: 'concurrency' as const },
    { kind: 'Skip' as const, reason: 'all_claimed' as const },
    { kind: 'Fault' as const, reason: 'store_admit_failed' as const },
  ];
  for (const claimOutcome of outcomes) {
    const snapshot = sealed();
    const cohortId = snapshot.booted.cohortId;
    const game = scopedGame(GAME_ID, BOTH);
    const { map, scripts } = validAdapters(snapshot, cohortId, game);
    const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
    const outcome = await runOneFire({
      snapshot,
      capability: knownZeroCap(map),
      claimPort: { admit: () => Promise.resolve(claimOutcome) },
      sink,
      runOptions: runOpts(),
      admission: ADMISSION,
      now: () => NOW_MS,
    });
    assert.equal(outcome.kind, 'NotAdmitted');
    if (outcome.kind === 'NotAdmitted') assert.strictEqual(outcome.outcome, claimOutcome, `${claimOutcome.kind} returned by identity`);
    assert.equal(scripts.reduce((n, s) => n + s.calls, 0), 0, `${claimOutcome.kind}: zero adapter calls`);
    assert.equal(sink.calls.length, 0, `${claimOutcome.kind}: zero installs`);
  }
});

// ===========================================================================
// unknown commit and admitted-refusal cleanup
// ===========================================================================

test('a claim-port throw propagates unchanged with zero side effects', async () => {
  const snapshot = sealed();
  const cohortId = snapshot.booted.cohortId;
  const game = scopedGame(GAME_ID, BOTH);
  const { map, scripts } = validAdapters(snapshot, cohortId, game);
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  const sentinel = new Error('claim store unreachable');
  await assert.rejects(
    () =>
      runOneFire({
        snapshot,
        capability: knownZeroCap(map),
        claimPort: { admit: () => Promise.reject(sentinel) },
        sink,
        runOptions: runOpts(),
        admission: ADMISSION,
        now: () => NOW_MS,
      }),
    (e) => e === sentinel,
  );
  assert.equal(scripts.reduce((n, s) => n + s.calls, 0), 0);
  assert.equal(sink.calls.length, 0);
});

test('an admitted narrowed scope propagates the refusal and releases every lease', async () => {
  const snapshot = sealed({ markets: BOTH });
  const cohortId = snapshot.booted.cohortId;
  const game = scopedGame(GAME_ID, BOTH);
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
  store.admitMarkets = ['moneyline'];
  const { map, scripts } = validAdapters(snapshot, cohortId, game);
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  await assert.rejects(
    () => runOneFire({ snapshot, capability: knownZeroCap(map), claimPort: new StoreClaimPort(store), sink, runOptions: runOpts(), admission: ADMISSION, now: () => NOW_MS }),
    /retained_scope_not_supported|does not|narrower/,
  );
  // Exactly the distinct initial-lease IDs are released once each — compared to the expected set,
  // not to a second projection of the same store log.
  const expectedLeaseIds = snapshot.expectedArmIdentities.map((_, i) => `lease-${i}`).sort();
  assert.deepEqual([...releaseIds(store)].sort(), expectedLeaseIds, 'every initial lease released once');
  assert.equal(new Set(releaseIds(store)).size, expectedLeaseIds.length, 'distinct lease IDs');
  assert.equal(scripts.reduce((n, s) => n + s.calls, 0), 0, 'no adapter called');
  assert.equal(sink.calls.length, 0, 'nothing installed');
  assert.equal(store.completeCalls.length, 0, 'a fire that never installed is never settled');
});

test('a narrowed scope whose cleanup also fails surfaces the cleanup error, installs nothing', async () => {
  const snapshot = sealed({ markets: BOTH });
  const cohortId = snapshot.booted.cohortId;
  const game = scopedGame(GAME_ID, BOTH);
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
  store.admitMarkets = ['moneyline'];
  store.onRelease = () => Promise.resolve({ outcome: 'refused', reason: 'not_owner' });
  const { map } = validAdapters(snapshot, cohortId, game);
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  // Permit initial-lease order, UNSORTED — the retained evidence must preserve it, so a reversal
  // of the failures (or attempts) is caught here rather than normalized away by a sort.
  const expectedLeaseIds = snapshot.expectedArmIdentities.map((_, i) => `lease-${i}`);
  await assert.rejects(
    () => runOneFire({ snapshot, capability: knownZeroCap(map), claimPort: new StoreClaimPort(store), sink, runOptions: runOpts(), admission: ADMISSION, now: () => NOW_MS }),
    (error: unknown) => {
      // The typed cleanup error is propagated UNCHANGED — its structured, ORDERED evidence must
      // survive, so a re-wrap that reverses the retained failures is a regression this catches.
      assert.ok(error instanceof PreDispatchCleanupError, 'a PreDispatchCleanupError, not a plain Error');
      assert.ok(
        error.primary instanceof DispatchAuthorizationError && error.primary.reason === 'retained_scope_not_supported',
        'the primary is the retained-scope refusal',
      );
      // Every lease was attempted in permit order; every attempt failed not_owner.
      assert.deepEqual(error.attempts.map((a) => a.leaseId), expectedLeaseIds, 'complete ordered attempts');
      assert.ok(error.attempts.every((a) => a.result === 'not_owner'), 'each attempt records not_owner');
      // The still-held failures preserve permit order and their result vocabulary — no sort.
      assert.deepEqual(error.failures.map((f) => f.leaseId), expectedLeaseIds, 'failures remain in permit initial-lease order');
      assert.deepEqual(error.failures.map((f) => f.result), expectedLeaseIds.map(() => 'not_owner'), 'every ordered failure retains its result');
      return true;
    },
  );
  assert.equal(sink.calls.length, 0);
  assert.equal(store.completeCalls.length, 0, 'a fire that never installed is never settled');
});

// ===========================================================================
// dispatch and producer failure containment
// ===========================================================================

test('a dispatch fault propagates and installs nothing', async () => {
  const snapshot = sealed();
  const cohortId = snapshot.booted.cohortId;
  const game = scopedGame(GAME_ID, BOTH);
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
  store.onRelease = () => Promise.resolve({ outcome: 'refused', reason: 'not_owner' }); // initial release fails
  const { map } = validAdapters(snapshot, cohortId, game);
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  await assert.rejects(
    () => runOneFire({ snapshot, capability: knownZeroCap(map), claimPort: new StoreClaimPort(store), sink, runOptions: runOpts(), admission: ADMISSION, now: () => NOW_MS }),
    (error: unknown) => {
      // The typed dispatch fault is propagated UNCHANGED — every retained arm cause must survive in
      // roster order, so a re-wrap that reverses the causes is caught here.
      assert.ok(error instanceof AuthorizedDispatchFaultError, 'a typed dispatch fault, not a plain Error');
      assert.equal(error.failures.length, snapshot.expectedArmIdentities.length, 'exactly one cause per arm');
      for (let i = 0; i < error.failures.length; i += 1) {
        const failure = error.failures[i];
        assert.ok(failure instanceof LifecycleFaultError, `arm ${i}: lifecycle fault retained`);
        assert.match(
          (failure as LifecycleFaultError).message,
          new RegExp(`^arm ${i} initial lease release `),
          `arm ${i}: cause remains in roster position`,
        );
      }
      return true;
    },
  );
  assert.equal(sink.calls.length, 0, 'a fire that could not dispatch leaves no record');
  assert.equal(store.completeCalls.length, 0, 'a dispatch fault never settles');
  // Every launched arm settled and every expected initial-lease release was attempted exactly once.
  const dispatchLeaseIds = snapshot.expectedArmIdentities.map((_, i) => `lease-${i}`).sort();
  assert.deepEqual([...releaseIds(store)].sort(), dispatchLeaseIds, 'every arm attempted its release');
  assert.equal(new Set(releaseIds(store)).size, dispatchLeaseIds.length, 'each release attempted once');
});

test('a producer failure after dispatch leaves leases settled and installs nothing', async () => {
  // Omitting baselinePolicyVersion makes the runner stamp the default (v0.2.0) while the manifest
  // declares v0.3.0 — dispatch succeeds and settles every lease, then the producer fails closed.
  const options = runOpts();
  delete (options as { baselinePolicyVersion?: unknown }).baselinePolicyVersion;
  const snapshot = sealed();
  const cohortId = snapshot.booted.cohortId;
  const game = scopedGame(GAME_ID, BOTH);
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
  const { map } = validAdapters(snapshot, cohortId, game);
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  await assert.rejects(
    () => runOneFire({ snapshot, capability: knownZeroCap(map), claimPort: new StoreClaimPort(store), sink, runOptions: options, admission: ADMISSION, now: () => NOW_MS }),
    /baseline/i,
  );
  assert.deepEqual([...releaseIds(store)].sort(), snapshot.expectedArmIdentities.map((_, i) => `lease-${i}`).sort(), 'all leases already released');
  assert.equal(sink.calls.length, 0, 'no install after a producer failure');
  assert.equal(store.completeCalls.length, 0, 'a producer failure before install never settles');
});

// ===========================================================================
// canonical permit zipper and source ownership
// ===========================================================================

test('a store returning reversed claimed keys still yields canonical artifact evidence bound to the permit', async () => {
  const snapshot = sealed({ markets: BOTH });
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
  store.reverseKeys = true; // claimedKeys come back as [total, moneyline]
  const { outcome, store: usedStore } = await fireOf({ markets: BOTH, store });
  assert.equal(outcome.kind, 'Installed');
  if (outcome.kind !== 'Installed') return;
  // The artifact evidence is canonical regardless of the store's key order.
  assert.deepEqual(outcome.artifact.scopedMarkets, ['moneyline', 'total']);
  // Every claim equals the corresponding permit key, field by field.
  const keyByMarket = new Map<MarketKey, ClaimKey>(outcome.permit.claimedKeys.map((k) => [k.market, k]));
  for (const evidence of outcome.artifact.marketEvidence) {
    const key = keyByMarket.get(evidence.claim.market)!;
    assert.equal(evidence.claim.cohortId, outcome.permit.cohortId);
    assert.equal(evidence.claim.fireId, outcome.permit.fireId);
    assert.equal(evidence.claim.gameId, key.gameId);
    assert.equal(evidence.claim.market, key.market);
  }
  void usedStore;
});

test('the spine builds each claim from the permit, not from snapshot identities', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lineOpenSpine.ts'), 'utf8');
  assert.ok(/claim:\s*\{\s*cohortId:\s*permit\.cohortId,\s*fireId:\s*permit\.fireId,\s*gameId:\s*key\.gameId,\s*market:\s*key\.market/.test(src), 'claim is built from permit + captured key');
  assert.ok(!/claim:\s*\{[^}]*snapshot\./.test(src), 'no claim field is sourced from the snapshot');
});

// ===========================================================================
// reconciliation matrix
// ===========================================================================

test('genuine pairs that disagree on a dimension raise a FireReconciliationError naming it', async () => {
  const base = await installedFire();
  const diffGame = await installedFire({ gameId: GAME_ID2 });
  const diffScope = await installedFire({ markets: ['moneyline'] });
  const diffCohort = await installedFire({ manifestExtra: { cohortSpendCapUsdMicros: 2_000_000 } });

  const check = (artifact: FireArtifactV1, permit: DispatchPermit, dimension: string): void => {
    let raised: FireReconciliationError | null = null;
    try {
      reconcileArtifactToPermit(artifact, permit);
    } catch (error) {
      raised = error as FireReconciliationError;
    }
    assert.ok(raised instanceof FireReconciliationError, `${dimension}: reconciliation must reject`);
    assert.ok(raised.dimensions.includes(dimension as never), `${dimension}: dimension named (${raised.dimensions.join(',')})`);
    // No compared value leaks into the message.
    assert.ok(!raised.message.includes(artifact.fireId) && !raised.message.includes(artifact.gameId), 'no value in message');
  };

  check(base.artifact, diffCohort.permit, 'cohortId');
  check(base.artifact, diffGame.permit, 'fireId');
  check(base.artifact, diffGame.permit, 'runId');
  check(base.artifact, diffGame.permit, 'gameId');
  check(base.artifact, diffScope.permit, 'scopedMarkets');
  check(base.artifact, diffGame.permit, 'marketClaims');
  check(base.artifact, diffGame.permit, 'requestSha256');

  // initialLeaseRoster, the eighth dimension. A permit minted DIRECTLY through the real
  // StoreClaimPort with a non-bijective roster is brand-genuine (StoreClaimPort gates only on
  // admitted+dispatchAuthorized and clones the leases verbatim; the [0,N) bijection check lives
  // downstream in authorizePreparedDispatch). Crossing it with a good artifact from the SAME fire
  // isolates the roster dimension — every other identity matches — which is precisely the case
  // the roster dimension defends against (a store slipping a bad roster past its own count/index
  // gate). authorizePreparedDispatch would refuse such a roster; reconcile, a direct unit call
  // over genuine branded values, must still catch it.
  const badRosterStore = new ScriptedStore(4);
  badRosterStore.badRoster = [0, 1, 2, 4];
  const rosterSnapshot = sealed();
  const rosterMint = await new StoreClaimPort(badRosterStore).admit(buildFullScopeAdmitRequest(rosterSnapshot, ADMISSION));
  assert.equal(rosterMint.kind, 'Authorized', 'the bad-roster permit is brand-genuine');
  if (rosterMint.kind === 'Authorized') check(base.artifact, rosterMint.permit, 'initialLeaseRoster');

  // marketClaims is one-to-one: a genuine permit with DUPLICATE claimed keys [moneyline, moneyline]
  // crossed with the good [moneyline, total] artifact leaves the artifact's total claim with no
  // permit key. Equal array length alone would miss it; the relation must reject the duplicate.
  const dupStore = new ScriptedStore(4);
  dupStore.admitMarkets = ['moneyline', 'moneyline'];
  const dupMint = await new StoreClaimPort(dupStore).admit(buildFullScopeAdmitRequest(sealed(), ADMISSION));
  assert.equal(dupMint.kind, 'Authorized', 'the duplicate-key permit is brand-genuine');
  if (dupMint.kind === 'Authorized') {
    let raised: FireReconciliationError | null = null;
    try {
      reconcileArtifactToPermit(base.artifact, dupMint.permit);
    } catch (error) {
      raised = error as FireReconciliationError;
    }
    assert.ok(raised instanceof FireReconciliationError, 'the duplicate-key permit must not reconcile');
    // Both scopedMarkets (artifact [ml,total] vs permit [ml,ml]) and marketClaims fail — reported
    // in the fixed canonical order.
    assert.deepEqual(
      raised.dimensions.filter((d) => d === 'scopedMarkets' || d === 'marketClaims'),
      ['scopedMarkets', 'marketClaims'],
      'both scope and one-to-one claims fail, in fixed order',
    );
  }

  // Positive control: two genuine same-roster values never spuriously flag the dimension.
  for (const permit of [diffGame.permit, diffCohort.permit, diffScope.permit]) {
    try {
      reconcileArtifactToPermit(base.artifact, permit);
    } catch (error) {
      assert.ok(
        !(error as FireReconciliationError).dimensions.includes('initialLeaseRoster'),
        'roster is never spuriously flagged for a canonical-roster cross',
      );
    }
  }
});

test('reconciliation reports every disagreeing dimension, not just the first', async () => {
  const base = await installedFire();
  const diffGame = await installedFire({ gameId: GAME_ID2 });
  let raised: FireReconciliationError | null = null;
  try {
    reconcileArtifactToPermit(base.artifact, diffGame.permit);
  } catch (error) {
    raised = error as FireReconciliationError;
  }
  assert.ok(raised instanceof FireReconciliationError);
  // fireId, runId, gameId, marketClaims, requestSha256 all differ for a different game.
  for (const d of ['fireId', 'runId', 'gameId', 'marketClaims', 'requestSha256']) {
    assert.ok(raised.dimensions.includes(d as never), `${d} present`);
  }
  // Reported in the fixed canonical order.
  const order = ['cohortId', 'fireId', 'runId', 'gameId', 'scopedMarkets', 'marketClaims', 'requestSha256', 'initialLeaseRoster'];
  const idx = raised.dimensions.map((d) => order.indexOf(d));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), 'dimensions in fixed order');
});

test('a matching genuine pair reconciles without error', async () => {
  const { artifact, permit } = await installedFire();
  assert.doesNotThrow(() => reconcileArtifactToPermit(artifact, permit));
});

test('a forged artifact or permit fails its own brand, not a wrapped reconciliation error', async () => {
  const { artifact, permit } = await installedFire();
  assert.throws(() => reconcileArtifactToPermit({ ...artifact }, permit), /was not produced/);
  assert.throws(() => reconcileArtifactToPermit(artifact, { ...permit }), /was not produced|forged|substituted/);
});

// ===========================================================================
// authorized wrapper ordering and identity
// ===========================================================================

test('installReconciledArtifact installs nothing on a mismatch and the exact artifact on a match', async () => {
  const base = await installedFire();
  const diffGame = await installedFire({ gameId: GAME_ID2 });
  const spy = { calls: [] as FireArtifactV1[], install(a: FireArtifactV1) { this.calls.push(a); return { path: '/sentinel', created: true } as const; } };

  // Reconciliation throws synchronously; the async wrapper surfaces it as a rejection.
  await assert.rejects(() => installReconciledArtifact(base.artifact, diffGame.permit, spy), FireReconciliationError);
  assert.equal(spy.calls.length, 0, 'no install on a mismatch');

  const result = await installReconciledArtifact(base.artifact, base.permit, spy);
  assert.equal(spy.calls.length, 1, 'exactly one install on a match');
  assert.strictEqual(spy.calls[0], base.artifact, 'the exact artifact object is installed');
  assert.deepEqual(result, { path: '/sentinel', created: true }, 'the exact sink result is returned');
});

test('installReconciledArtifact returns the exact sink result, awaits an async sink, and propagates a sink throw', async () => {
  const { artifact, permit } = await installedFire();
  const sentinelResult = { path: '/x', created: false } as const;
  const okSink = { install: () => sentinelResult };
  assert.strictEqual(await installReconciledArtifact(artifact, permit, okSink), sentinelResult);

  // An asynchronous installer is awaited; its resolved value is returned by identity.
  const asyncResult = { path: '/async', created: true } as const;
  const asyncSink = { install: () => Promise.resolve(asyncResult) };
  assert.strictEqual(await installReconciledArtifact(artifact, permit, asyncSink), asyncResult);

  const boom = new Error('sink exploded');
  const throwing = { install: () => { throw boom; } };
  await assert.rejects(() => installReconciledArtifact(artifact, permit, throwing), (e) => e === boom);

  // An asynchronous installer REJECTION propagates unchanged (never swallowed).
  const asyncBoom = new Error('async sink exploded');
  const asyncThrowing = { install: () => Promise.reject(asyncBoom) };
  await assert.rejects(() => installReconciledArtifact(artifact, permit, asyncThrowing), (e) => e === asyncBoom);
});

// ===========================================================================
// idempotent install passthrough
// ===========================================================================

test('a second install of the same genuine artifact returns created:false, byte-identical', async () => {
  const { artifact, permit } = await installedFire();
  const fs = new MemoryFs();
  const sink = new FireArtifactSink('/base', fs);
  const first = await installReconciledArtifact(artifact, permit, sink);
  assert.equal(first.created, true);
  const second = await installReconciledArtifact(artifact, permit, sink);
  assert.equal(second.created, false);
  assert.equal(second.path, first.path);
  assert.ok(fs.readFile(first.path).equals(Buffer.from(serializeFireArtifactV1(artifact), 'utf8')));
  assert.deepEqual(verifyFireArtifactReplay(parseFireArtifactV1(fs.readFile(first.path).toString('utf8'))), []);
});

// ===========================================================================
// settle-once completion
// ===========================================================================

test('a store completion refusal folds to unsettled and NEVER discards the installed artifact', async () => {
  for (const reason of ['version_mismatch', 'invariant_breach', 'invalid_input'] as const) {
    const store = new ScriptedStore(CODE_ARMS.length);
    store.onComplete = () => Promise.resolve({ outcome: 'refused', reason });
    const { outcome, sink } = await fireOf({ store });
    assert.equal(outcome.kind, 'Installed', `${reason}: the durably-installed fire is preserved`);
    if (outcome.kind !== 'Installed') return;
    assert.deepEqual(outcome.completion, { status: 'unsettled', reason }, `${reason}: exact typed unsettled reason`);
    assert.equal(outcome.install.created, true, `${reason}: the artifact was durably installed`);
    assert.equal(sink.calls.length, 1, `${reason}: installed exactly once`);
    assert.equal(store.completeCalls.length, 1, `${reason}: settle attempted once`);
  }
});

test('a store completion throw folds to unsettled/store_complete_failed, keeps the artifact, and never reads the value', async () => {
  const store = new ScriptedStore(CODE_ARMS.length);
  let touched = false;
  const hostile = new Proxy(
    {},
    {
      get() {
        touched = true;
        throw new Error('the thrown completion value must never be read');
      },
    },
  );
  store.onComplete = () => Promise.reject(hostile);
  const { outcome, sink } = await fireOf({ store });
  assert.equal(outcome.kind, 'Installed');
  if (outcome.kind !== 'Installed') return;
  assert.deepEqual(outcome.completion, { status: 'unsettled', reason: 'store_complete_failed' });
  assert.equal(outcome.install.created, true, 'the artifact was durably installed');
  assert.equal(sink.calls.length, 1);
  assert.equal(touched, false, 'the thrown completion value was never read or formatted');
});

test('settlement runs exactly once, strictly after the install resolves; a pending or rejected install never settles', async () => {
  // Resolve path: while the install promise is pending there is no settle; after it resolves, exactly one.
  {
    const snapshot = sealed();
    const cohortId = snapshot.booted.cohortId;
    const game = scopedGame(GAME_ID, BOTH);
    const { map } = validAdapters(snapshot, cohortId, game);
    const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
    const d = deferredInstaller();
    const p = runOneFire({ snapshot, capability: knownZeroCap(map), claimPort: new StoreClaimPort(store), sink: d.installer, runOptions: runOpts(), admission: ADMISSION, now: () => NOW_MS });
    await d.reached;
    assert.equal(d.installCalls(), 1, 'install reached exactly once');
    assert.equal(store.completeCalls.length, 0, 'no settle while the install promise is pending');
    d.resolve({ path: '/base/installed', created: true });
    const outcome = await p;
    assert.equal(outcome.kind, 'Installed');
    assert.equal(store.completeCalls.length, 1, 'exactly one settle after the install resolves');
  }
  // Reject path: a rejected install propagates unchanged and never settles.
  {
    const snapshot = sealed();
    const cohortId = snapshot.booted.cohortId;
    const game = scopedGame(GAME_ID, BOTH);
    const { map } = validAdapters(snapshot, cohortId, game);
    const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
    const d = deferredInstaller();
    const p = runOneFire({ snapshot, capability: knownZeroCap(map), claimPort: new StoreClaimPort(store), sink: d.installer, runOptions: runOpts(), admission: ADMISSION, now: () => NOW_MS });
    await d.reached;
    assert.equal(store.completeCalls.length, 0, 'no settle before the install resolves');
    const boom = new Error('durable sink unreachable');
    d.reject(boom);
    await assert.rejects(p, (e) => e === boom);
    assert.equal(store.completeCalls.length, 0, 'a rejected install never settles');
  }
});

test('a second full-spine fire over the same filesystem installs created:false and is still settled', async () => {
  const fs = new MemoryFs();
  const first = await fireOf({ fs });
  assert.equal(first.outcome.kind, 'Installed');
  const second = await fireOf({ fs });
  assert.equal(second.outcome.kind, 'Installed');
  if (second.outcome.kind !== 'Installed') return;
  assert.equal(second.outcome.install.created, false, 'the byte-identical artifact already existed');
  assert.equal(second.store.completeCalls.length, 1, 'a created:false install is still eligible for settlement');
  assert.deepEqual(second.outcome.completion, { status: 'settled' });
});

// ===========================================================================
// source / ownership gate
// ===========================================================================

test('the spine imports no runtime store, settles only via the permit-resolved capability, and orders its stages', () => {
  const spine = join(dirname(fileURLToPath(import.meta.url)), 'lineOpenSpine.ts');
  const src = readFileSync(spine, 'utf8');
  for (const forbidden of [
    // A DIRECT store completion in-spine is forbidden — the spine settles ONLY through the
    // permit-resolved `settleCompletedFire` indirection (a stale gate that merely forbade the
    // `completeClaim` literal would stay green while the spine settled through the helper).
    '.completeClaim(',
    'runSlate',
    'atomicStore',
    "from './providers",
    "from './watch",
    "from './store/atomicStore",
    '.releaseLease(',
    '.acquireRepairLease(',
    'sealDispatch',
    'mintAdmission',
  ]) {
    assert.ok(!src.includes(forbidden), `spine must not reference ${forbidden}`);
  }
  // Only a type-only import from the store contract is allowed.
  assert.ok(/import type \{[^}]*\} from '\.\/store\/contract\.js'/.test(src), 'store/contract is type-only');
  assert.ok(!/^import \{[^}]*\} from '\.\/store\//m.test(src), 'no runtime store import');
  // Settlement is the permit-resolved capability, invoked through the settlement helper.
  assert.ok(src.includes("from './fireSettlement.js'"), 'settlement goes through fireSettlement');

  // Stage order inside runOneFire: dispatch is the first fallible op after authorization — no
  // work (context mapping, production, install) may run between Authorized and dispatch (§4/R5).
  const body = src.slice(src.indexOf('export async function runOneFire'));
  assert.ok(body.indexOf('runAuthorizedDispatch(') < body.indexOf('const keyByMarket'), 'context mapping follows dispatch');
  assert.ok(body.indexOf('runAuthorizedDispatch(') < body.indexOf('buildFireArtifact('), 'dispatch precedes production');
  assert.ok(body.indexOf('buildFireArtifact(') < body.indexOf('installReconciledArtifact('), 'production precedes install');
  // The install is AWAITED and settlement runs strictly AFTER it — never before a pending install
  // promise resolves, and never for a fire whose install threw/rejected.
  assert.ok(body.includes('await installReconciledArtifact('), 'the install is awaited');
  assert.ok(body.includes('await settleCompletedFire('), 'the settle is awaited');
  assert.ok(
    body.indexOf('installReconciledArtifact(') < body.indexOf('settleCompletedFire('),
    'settlement follows the durable install',
  );
  // Inside the wrapper, reconcile precedes install.
  const wrapper = src.slice(src.indexOf('export async function installReconciledArtifact'), src.indexOf('export async function runOneFire'));
  assert.ok(wrapper.indexOf('reconcileArtifactToPermit(') < wrapper.indexOf('sink.install('), 'reconcile precedes install');

  // Each reconciliation dimension is present and reported — defense in depth alongside the
  // reconciliation-matrix test, which exercises every dimension (roster included) over genuine
  // branded values.
  for (const dimension of ['cohortId', 'fireId', 'runId', 'gameId', 'scopedMarkets', 'marketClaims', 'requestSha256', 'initialLeaseRoster']) {
    assert.ok(src.includes(`failed.push('${dimension}')`), `reconcile computes and reports ${dimension}`);
  }
  assert.ok(/sortedLeaseIndexes\[i\] !== i/.test(src), 'the roster bijection is derived, not assumed');

  // The pre-dispatch scope-key owner remains additively exported for the composition spine.
  const dispatchSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lineOpenDispatch.ts'), 'utf8');
  assert.ok(dispatchSrc.includes('export function scopeKeyOf'), 'scopeKeyOf is additively exported');
});

// ===========================================================================
// The send-time initial-dispatch gate at the spine (SPEC §5)
// ===========================================================================

// 15s after the fixture detectedAt (12:00:30) — beyond maxDispatchLagMs (10s), so the
// snapshot-derived V-lag gate rejects every initial send.
const LATE_NOW = Date.parse('2026-07-18T12:00:45.000Z');

test('a gate-violating fire installs a writer-clean artifact — every arm carries the refused start, zero attempts (B3)', async () => {
  const { outcome, store, scripts } = await fireOf({ now: () => LATE_NOW });
  assert.equal(outcome.kind, 'Installed', 'the fire produces a durable artifact even when every arm is gated out');
  if (outcome.kind !== 'Installed') return;
  assert.equal(scripts.reduce((n, s) => n + s.calls, 0), 0, 'no arm was sent — the snapshot-derived gate rejected each initial');
  for (const arm of outcome.artifact.arms) {
    assert.equal(arm.terminalOutcome, 'dispatch_lag_exceeded', 'per violating arm: dispatch_lag_exceeded');
    // B3: the never-sent gate refusal carries the EXACT reading it compared (the ONE dispatch clock,
    // LATE_NOW) on initialRequestStartedAt — NON-null, without fabricating an attempt.
    assert.equal(arm.initialRequestStartedAt, new Date(LATE_NOW).toISOString(), 'per violating arm: the refused start is the gate reading');
    assert.equal(arm.orderedAttempts.length, 0, 'per violating arm: zero orderedAttempts (no phantom attempt)');
  }
  // The bidirectional writer relation now REQUIRES this non-null start for a zero-attempt
  // dispatch_lag_exceeded arm, so the produced artifact replays writer-clean (B3-R3).
  assert.deepEqual(verifyFireArtifactReplay(outcome.artifact), [], 'the produced artifact replays writer-clean');
  assert.deepEqual(
    [...releaseIds(store)].sort(),
    outcome.permit.initialLeases.map((l) => l.leaseId).sort(),
    'each skipped initial lease released once',
  );
});

test('the snapshot-derived gate wins over hostile permissive runOptions mutated during admission', async () => {
  const snapshot = sealed();
  const cohortId = snapshot.booted.cohortId;
  const game = scopedGame(GAME_ID, BOTH);
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
  const { map, scripts } = validAdapters(snapshot, cohortId, game);
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  // runOptions carries hostile runtime-extra gate operands (detectedAt / windowEnd / maxDispatchLagMs)
  // that WOULD admit every initial if the gate read them — but the gate sources those operands from
  // the authenticated snapshot, never from runOptions. The clock is the injected LATE tick clock.
  const runOptions = {
    ...runOpts(),
    detectedAt: new Date(LATE_NOW).toISOString(),
    windowEnd: '2999-01-01T00:00:00.000Z',
    maxDispatchLagMs: 1_000_000_000,
  } as unknown as LineOpenRunOptions;
  const port = new StoreClaimPort(store);
  const wrapped = {
    admit(req: AdmitDispatchRequest) {
      // Mutate the hostile permissive operands WHILE admission is pending.
      (runOptions as Record<string, unknown>).detectedAt = new Date(LATE_NOW).toISOString();
      (runOptions as Record<string, unknown>).maxDispatchLagMs = 5_000_000_000;
      return port.admit(req);
    },
  };
  const outcome = await runOneFire({ snapshot, capability: knownZeroCap(map), claimPort: wrapped, sink, runOptions, admission: ADMISSION, now: () => LATE_NOW });
  assert.equal(outcome.kind, 'Installed', 'the fire runs — every initial gated out by the snapshot operands');
  assert.equal(
    scripts.reduce((n, s) => n + s.calls, 0),
    0,
    'ZERO adapter calls — the snapshot-derived gate rejected each initial, never the permissive runOptions',
  );
  if (outcome.kind !== 'Installed') return;
  assert.ok(outcome.artifact.arms.every((a) => a.terminalOutcome === 'dispatch_lag_exceeded'), 'every arm gated out by the snapshot V-lag');
  assert.deepEqual(
    [...releaseIds(store)].sort(),
    outcome.permit.initialLeases.map((l) => l.leaseId).sort(),
    'each skipped initial lease released once',
  );
});

test('the dispatch gate is captured from the sealed snapshot, after admission-request derivation and before authorization', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lineOpenSpine.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function runOneFire'));
  // Every gate operand is sourced from the AUTHENTICATED snapshot, never from runOptions.
  assert.ok(
    /const gate: InitialDispatchGate = \{[\s\S]*?detectedAt: snapshot\.detectedAt,[\s\S]*?windowEnd: snapshot\.booted\.manifest\.windowEnd,[\s\S]*?maxDispatchLagMs: snapshot\.booted\.manifest\.constants\.maxDispatchLagMs,/.test(body),
    'the gate operands come from the snapshot',
  );
  assert.ok(!/runOptions\.(detectedAt|windowEnd|maxDispatchLagMs)/.test(body), 'no gate operand is read from runOptions');
  // Ordering: buildFullScopeAdmitRequest -> gate capture -> authorizePreparedDispatch.
  assert.ok(
    body.indexOf('buildFullScopeAdmitRequest(') < body.indexOf('const gate: InitialDispatchGate'),
    'gate captured after the admission request is derived (snapshot authenticated)',
  );
  assert.ok(
    body.indexOf('const gate: InitialDispatchGate') < body.indexOf('authorizePreparedDispatch('),
    'gate captured before authorization',
  );
});

// ===========================================================================
// B1 — the PRE-CLAIM canonical-window gate (SPEC-line-open-evidence-model.md §3/§5)
// ===========================================================================

// Fixture geometry (from the shared constants above): first pitch (cutoffAt) CUTOFF = 20:00,
// windowEnd WINDOW_END = 2026-07-19T00:00 (a day AFTER first pitch), detectedAt 12:00:30. A pre-claim
// reading is compared to first pitch (snapshot.prepared.cutoffAt) and windowEnd
// (snapshot.booted.manifest.windowEnd), first-pitch precedence when both have passed.
const AT_FIRST_PITCH = Date.parse(CUTOFF); // == snapshot.prepared.cutoffAt
const AFTER_FIRST_PITCH = Date.parse('2026-07-18T21:00:00.000Z'); // > first pitch, < windowEnd
const AT_OR_AFTER_WINDOW_END = Date.parse(WINDOW_END); // >= windowEnd AND >= first pitch (both passed)

/** The complete arm-outcome enum (compile-exhaustive: a new `ArmOutcome` forces an entry here). */
const ARM_OUTCOME_SET: Record<ArmOutcome, true> = {
  valid: true,
  invalid_schema: true,
  timeout: true,
  credential_missing: true,
  rate_limited: true,
  provider_error: true,
  cutoff_missed: true,
  dispatch_lag_exceeded: true,
};

/** The complete projector reason unions (compile-exhaustive: a new reason forces an entry here). */
const PROJECTOR_REASON_SET: Record<DeferReason | RejectReason, true> = {
  opener_not_visible: true,
  detected_before_window: true,
  clock_skew_defer: true,
  quote_moved: true,
  snapshot_stale: true,
  not_enabled: true,
  detected_after_window: true,
  opener_before_window: true,
  opener_after_window: true,
  clock_skew_fault: true,
  stale_entry: true,
};

// --- B1-R1 — a pre-claim first-pitch OR windowEnd impossibility takes no claim, no artifact ------

test('B1-R1(a): a pre-claim reading at/after first pitch is a CoverageMiss — admit/install/provider never invoked', async () => {
  const { outcome, store, sink, scripts } = await fireOf({ now: () => AT_FIRST_PITCH });
  assert.equal(outcome.kind, 'CoverageMiss', 'a first-pitch-passed reading takes no claim');
  if (outcome.kind === 'CoverageMiss') assert.equal(outcome.reason, 'first_pitch_before_claim');
  // The claim port, the sink, and every provider adapter are NEVER reached (spies stay at zero).
  assert.equal(store.admitCalls.length, 0, 'claimPort.admit never called — no claim was taken');
  assert.equal(sink.calls.length, 0, 'sink.install never called — no artifact produced');
  assert.equal(scripts.reduce((n, s) => n + s.calls, 0), 0, 'no provider was called');
});

test('B1-R1(b): a pre-claim reading in [windowEnd, firstPitch) is a CoverageMiss with reason window_end_before_claim', async () => {
  // windowEnd BEFORE first pitch (via the manifest), then a reading between them: windowEnd passed,
  // first pitch not yet. The gate reads windowEnd from snapshot.booted.manifest.windowEnd.
  const WINDOW_END_EARLY = '2026-07-18T14:00:00.000Z'; // < first pitch (20:00)
  const READING = Date.parse('2026-07-18T15:00:00.000Z'); // >= windowEnd (14:00), < first pitch (20:00)
  const { outcome, store, sink, scripts } = await fireOf({
    manifestExtra: { windowEnd: WINDOW_END_EARLY },
    now: () => READING,
  });
  assert.equal(outcome.kind, 'CoverageMiss');
  if (outcome.kind !== 'CoverageMiss') return;
  assert.equal(outcome.reason, 'window_end_before_claim', 'windowEnd passed but first pitch has not');
  assert.equal(store.admitCalls.length, 0);
  assert.equal(sink.calls.length, 0);
  assert.equal(scripts.reduce((n, s) => n + s.calls, 0), 0);
});

test('B1-R1(b-boundary): a pre-claim reading EXACTLY at windowEnd is a CoverageMiss (end-exclusive); one ms earlier admits', async () => {
  // The canonical window is END-EXCLUSIVE (`initialRequestStartedAt < windowEnd`), so a reading EXACTLY
  // at windowEnd is already too late → window_end_before_claim. windowEnd is set BEFORE first pitch so this
  // is unambiguously the windowEnd branch. Weakening the gate `>=` to `>` admits at the boundary → reds this.
  const WINDOW_END_EARLY = '2026-07-18T14:00:00.000Z'; // < first pitch (20:00)
  const AT_WINDOW_END = Date.parse(WINDOW_END_EARLY);
  const missed = await fireOf({ manifestExtra: { windowEnd: WINDOW_END_EARLY }, now: () => AT_WINDOW_END });
  assert.equal(missed.outcome.kind, 'CoverageMiss', 'a reading exactly at windowEnd takes no claim');
  if (missed.outcome.kind === 'CoverageMiss') assert.equal(missed.outcome.reason, 'window_end_before_claim');
  assert.equal(missed.store.admitCalls.length, 0, 'no claim at exactly windowEnd (end-exclusive)');
  assert.equal(missed.sink.calls.length, 0);
  assert.equal(missed.scripts.reduce((n, s) => n + s.calls, 0), 0);
  // The passing side: one millisecond earlier is INSIDE the window — the gate does not coverage-miss.
  const admitted = await fireOf({ manifestExtra: { windowEnd: WINDOW_END_EARLY }, now: () => AT_WINDOW_END - 1 });
  assert.notEqual(admitted.outcome.kind, 'CoverageMiss', 'windowEnd - 1ms is inside the window — not a coverage miss');
  assert.equal(admitted.store.admitCalls.length, 1, 'windowEnd - 1ms takes a claim');
});

test('B1-R1(c): when BOTH boundaries have passed, first pitch takes precedence', async () => {
  const { outcome } = await fireOf({ now: () => AT_OR_AFTER_WINDOW_END });
  assert.equal(outcome.kind, 'CoverageMiss');
  if (outcome.kind !== 'CoverageMiss') return;
  assert.equal(outcome.reason, 'first_pitch_before_claim', 'first-pitch precedence when both passed');
});

test('B1-R1(d): a forged/unsealed snapshot fails the brand BEFORE the gate — throws, never a CoverageMiss, never admits', async () => {
  const genuine = sealed();
  const store = new ScriptedStore(genuine.expectedArmIdentities.length);
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  // A structural copy is not in the seal WeakSet; the clock is late (would be a CoverageMiss if the
  // gate were reached) — proving the brand rejection fires first, at buildFullScopeAdmitRequest.
  await assert.rejects(
    () =>
      runOneFire({
        snapshot: { ...genuine } as PreparedFireSnapshot,
        capability: knownZeroCap(new Map()),
        claimPort: new StoreClaimPort(store),
        sink,
        runOptions: runOpts(),
        admission: ADMISSION,
        now: () => AT_FIRST_PITCH,
      }),
    /was not produced/,
  );
  assert.equal(store.admitCalls.length, 0, 'the brand rejected before any admission');
  assert.equal(sink.calls.length, 0);
});

test('B1-R1(e): EVERY non-finite reading (NaN, +Infinity, -Infinity) fails CLOSED — throws PreClaimClockError, never admits', async () => {
  // A broken clock cannot be evaluated; the gate must reject ALL non-finite readings, not just NaN. In
  // particular -Infinity would pass BOTH `>=` comparisons (−∞ ≥ x is false) and reach admission if the
  // guard were weakened from `!Number.isFinite` to `Number.isNaN`, and +Infinity would mis-route to a
  // CoverageMiss instead of failing closed — so both must throw here.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const snapshot = sealed();
    const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
    const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
    await assert.rejects(
      () =>
        runOneFire({
          snapshot,
          capability: knownZeroCap(new Map()),
          claimPort: new StoreClaimPort(store),
          sink,
          runOptions: runOpts(),
          admission: ADMISSION,
          now: () => bad,
        }),
      (e) => e instanceof PreClaimClockError,
      `${bad} must fail closed with PreClaimClockError`,
    );
    assert.equal(store.admitCalls.length, 0, `${bad}: a broken clock never admits`);
    assert.equal(sink.calls.length, 0, `${bad}: never installs`);
  }
});

// --- B1-R2 — distinct reason type; a post-claim crossing stays cutoff_missed, never CoverageMiss ---

test('B1-R2: each CoverageMissReason is disjoint from the arm-outcome enum and the projector reason unions', async () => {
  const reasons: readonly CoverageMissReason[] = ['first_pitch_before_claim', 'window_end_before_claim'];
  // Static: neither literal appears among the arm outcomes or projector reasons.
  for (const r of reasons) {
    assert.ok(!(r in ARM_OUTCOME_SET), `${r} must not be an arm outcome`);
    assert.ok(!(r in PROJECTOR_REASON_SET), `${r} must not be a projector defer/reject reason`);
  }
  // Runtime binding: the reason a PRODUCED CoverageMiss carries is likewise not an arm outcome — so
  // relabelling the pre-claim miss to `cutoff_missed` (an arm outcome) turns this red.
  const { outcome } = await fireOf({ now: () => AT_FIRST_PITCH });
  assert.equal(outcome.kind, 'CoverageMiss');
  if (outcome.kind !== 'CoverageMiss') return;
  assert.ok(!(outcome.reason in ARM_OUTCOME_SET), 'the produced CoverageMiss reason is not an arm outcome');
  assert.ok(!(outcome.reason in PROJECTOR_REASON_SET), 'the produced CoverageMiss reason is not a projector reason');
});

test('B1-R2: a boundary crossing AFTER the claim stays an arm-level cutoff_missed (Installed), never a CoverageMiss', async () => {
  // A clock whose FIRST read (the pre-claim gate) is before both boundaries — so the fire is admitted —
  // but whose later reads (the send-time dispatch) are at/after first pitch, so each initial is refused
  // with the arm-level `cutoff_missed`. This is the already-claimed case, NOT a pre-claim CoverageMiss.
  let calls = 0;
  const now = (): number => {
    calls += 1;
    return calls === 1 ? NOW_MS : AT_FIRST_PITCH; // pre-claim before; every dispatch read at first pitch
  };
  const { outcome, store, scripts } = await fireOf({ now });
  assert.equal(outcome.kind, 'Installed', 'the fire WAS claimed — a post-claim crossing does not un-claim it');
  if (outcome.kind !== 'Installed') return;
  assert.ok(store.admitCalls.length === 1, 'the fire was admitted (a claim was taken)');
  assert.equal(scripts.reduce((n, s) => n + s.calls, 0), 0, 'no arm was sent — each initial hit the send-time cutoff');
  assert.ok(
    outcome.artifact.arms.every((a) => a.terminalOutcome === 'cutoff_missed'),
    'every arm is the already-claimed cutoff_missed, not a CoverageMiss',
  );
});

// --- B1-R5 — B1 owns the complete CoverageMiss record (reason + four operands, frozen) ------------

test('B1-R5: the CoverageMiss record binds each operand to the EXACT snapshot value the gate used; reason is a separate field; frozen', async () => {
  // A sparse SEQUENCED clock: the FIRST read triggers the miss (AFTER_FIRST_PITCH); any SECOND read returns
  // a DISTINCT valid value. The gate must read the clock EXACTLY once and persist THAT reading — so replacing
  // the persisted `readingMs` with a second `now()` (a distinct value) reds the call-count AND the identity.
  const seq = [AFTER_FIRST_PITCH, AFTER_FIRST_PITCH + 3_600_000];
  let clockReads = 0;
  const now = (): number => {
    const v = seq[Math.min(clockReads, seq.length - 1)]!;
    clockReads += 1;
    return v;
  };
  const { outcome, snapshot } = await fireOf({ now });
  assert.equal(outcome.kind, 'CoverageMiss');
  if (outcome.kind !== 'CoverageMiss') return;
  assert.equal(clockReads, 1, 'the pre-claim gate read the clock EXACTLY once (single-read evidence identity)');
  // Structural separation: `reason` is a distinct scalar field; the four operands live on `operands`,
  // NOT spread onto the outcome (collapsing reason+operands into one field turns this red).
  assert.equal(typeof outcome.reason, 'string');
  assert.equal(typeof outcome.operands, 'object');
  assert.ok(!('preClaimReadingAt' in outcome), 'operands are NOT spread onto the outcome alongside reason');
  assert.deepEqual(
    Object.keys(outcome.operands).sort(),
    ['detectedAt', 'preClaimReadingAt', 'scheduledAtAtFire', 'windowEnd'],
    'exactly the four operands are present',
  );
  // Identity binding: each operand equals the EXACT value the gate compared — the single injected
  // reading, and first pitch / windowEnd / detectedAt straight from the authenticated snapshot.
  assert.equal(outcome.operands.preClaimReadingAt, new Date(AFTER_FIRST_PITCH).toISOString());
  assert.equal(outcome.operands.scheduledAtAtFire, snapshot.prepared.cutoffAt);
  assert.equal(outcome.operands.windowEnd, snapshot.booted.manifest.windowEnd);
  assert.equal(outcome.operands.detectedAt, snapshot.detectedAt);
  // All four are typed ISO-8601 strings.
  for (const v of Object.values(outcome.operands)) {
    assert.equal(typeof v, 'string');
    assert.ok(!Number.isNaN(Date.parse(v)), `${v} is a parseable instant`);
  }
  // The record is frozen (operands + outcome) BEFORE it can reach the tick's shallow-frozen summary.
  assert.ok(Object.isFrozen(outcome), 'the CoverageMiss outcome is frozen');
  assert.ok(Object.isFrozen(outcome.operands), 'the operands object is frozen');
});
