import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cohortBoot } from './cohortBoot.js';
import { evaluateCandidate } from './detection.js';
import { StoreClaimPort } from './lineOpenClaim.js';
import type { DispatchPermit } from './lineOpenClaim.js';
import { DispatchAuthorizationError, PreDispatchCleanupError, scopeKeyOf } from './lineOpenDispatch.js';
import { AuthorizedDispatchFaultError } from './runner.js';
import { LifecycleFaultError } from './lineOpenLifecycle.js';
import {
  buildFullScopeAdmitRequest,
  deriveSpendReservationUsdMicros,
  FireReconciliationError,
  installReconciledArtifact,
  PreClaimClockError,
  reconcileArtifactToPermit,
  runOneFire,
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
import type { CandidateInput } from './detection.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
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
    })),
    toolInferenceConfigSha256: 'c'.repeat(64),
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

function candidateInput(gameId: string, market: MarketKey): CandidateInput {
  return {
    gameId,
    sport: 'mlb',
    market,
    sportAllowList: ['mlb'],
    marketPolicyVersion: MARKET_POLICY_VERSION,
    opener: historyRow(gameId, market),
    detectedAt: DETECTED_AT,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
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
  return sealPreparedFire({
    game: scopedGame(gameId, markets),
    slug: `mil-pit-${gameId.slice(-4)}`,
    slateDate: '2026-07-18',
    bundleTimestamp: BUNDLE_TS,
    booted: cohortBoot({ live: false, manifestBytes: json }),
    publication: checkPublication({
      localManifestBytes: bytes,
      publication: { repositoryOwner: 'ospex-org', repositoryName: 'ospex-benchmark', path: 'manifests/cohort.json', commitSha: 'a'.repeat(40) },
      resolved: { blobBytes: bytes, committerTimestamp: COMMITTER_TS },
    }),
    detectedAt: DETECTED_AT,
    bundleBuiltAt: BUNDLE_BUILT_AT,
    proposedMarkets: markets,
    perMarket: markets.map((m) => ({
      candidateInput: candidateInput(gameId, m),
      verdict: evaluateCandidate(candidateInput(gameId, m)),
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
    forecasts.push({ market: 'moneyline', selection: game.awayTeam, line: null, observedDecimal: game.markets.moneyline.awayDecimal, probabilities: { win: 0.55, push: 0, loss: 0.45 }, confidence: 0.6, wouldAbstain: false, selectedForExecution: true, rationale: 'r', evidenceRefs: [game.markets.moneyline.evidenceRef], reasonCode: null });
  }
  if (game.markets.total) {
    forecasts.push({ market: 'total', selection: 'over', line: game.markets.total.line, observedDecimal: game.markets.total.overDecimal, probabilities: { win: 0.5, push: 0, loss: 0.5 }, confidence: 0.5, wouldAbstain: false, selectedForExecution: true, rationale: 'r', evidenceRefs: [game.markets.total.evidenceRef], reasonCode: null });
  }
  const body: BenchmarkResponse = {
    schemaVersion: 1,
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
  opts: { hasCredential?: boolean } = {},
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
      return { rawText: body, reportedModelId: identity.requestedModelId, providerResponseId: 'x', httpStatus: 200, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, usageRaw: {}, requestParams: {} };
    },
  };
  return { adapter, get calls() { return state.calls; } } as Scripted;
}

function validAdapters(snapshot: PreparedFireSnapshot, cohortId: string, game: GameBundle): { map: Map<string, ProviderAdapter>; scripts: Scripted[] } {
  const scripts: Scripted[] = [];
  const map = new Map<string, ProviderAdapter>();
  for (const id of snapshot.expectedArmIdentities) {
    const s = scriptedAdapter(id, () => validBody(id.participantId, id.requestedModelId, cohortId, snapshot.prepared.requestSha256, game));
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

/** An installer spy that delegates to a real sink and records each call + result. */
function countingSink(real: ArtifactInstaller): ArtifactInstaller & { calls: Array<{ arg: FireArtifactV1; result: ReturnType<ArtifactInstaller['install']> }> } {
  const calls: Array<{ arg: FireArtifactV1; result: ReturnType<ArtifactInstaller['install']> }> = [];
  return {
    calls,
    install(artifact) {
      const result = real.install(artifact);
      calls.push({ arg: artifact, result });
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
  };
  return { installer, reached, resolve: (r) => resolveFn(r), reject: (e) => rejectFn(e), installCalls: () => installCalls };
}

/** The full happy-path harness for one fire, over an injected in-memory filesystem. The tick clock
 *  is injected via `now` (default `() => NOW_MS`, the boundary-safe reading whose V-lag against the
 *  fixture `detectedAt` equals `maxDispatchLagMs`, so the gate admits); a late clock drives the
 *  gate-refusal rows. */
async function fireOf(opts: SealOpts & { store?: ScriptedStore; runOptions?: LineOpenRunOptions; fs?: ArtifactFs; now?: () => number } = {}): Promise<{
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
  const { map, scripts } = validAdapters(snapshot, cohortId, game);
  const sink = countingSink(new FireArtifactSink('/base', opts.fs ?? new MemoryFs()));
  const outcome = await runOneFire({
    snapshot,
    adapters: map,
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
    adapters: map,
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
      adapters: map,
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
        adapters: map,
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
    () => runOneFire({ snapshot, adapters: map, claimPort: new StoreClaimPort(store), sink, runOptions: runOpts(), admission: ADMISSION, now: () => NOW_MS }),
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
    () => runOneFire({ snapshot, adapters: map, claimPort: new StoreClaimPort(store), sink, runOptions: runOpts(), admission: ADMISSION, now: () => NOW_MS }),
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
    () => runOneFire({ snapshot, adapters: map, claimPort: new StoreClaimPort(store), sink, runOptions: runOpts(), admission: ADMISSION, now: () => NOW_MS }),
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
    () => runOneFire({ snapshot, adapters: map, claimPort: new StoreClaimPort(store), sink, runOptions: options, admission: ADMISSION, now: () => NOW_MS }),
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
    const p = runOneFire({ snapshot, adapters: map, claimPort: new StoreClaimPort(store), sink: d.installer, runOptions: runOpts(), admission: ADMISSION, now: () => NOW_MS });
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
    const p = runOneFire({ snapshot, adapters: map, claimPort: new StoreClaimPort(store), sink: d.installer, runOptions: runOpts(), admission: ADMISSION, now: () => NOW_MS });
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

  // The only product change outside S4 is the additive scopeKeyOf export.
  const dispatchSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lineOpenDispatch.ts'), 'utf8');
  assert.ok(dispatchSrc.includes('export function scopeKeyOf'), 'scopeKeyOf is additively exported');
});

// ===========================================================================
// The send-time initial-dispatch gate at the spine (SPEC §5)
// ===========================================================================

// 15s after the fixture detectedAt (12:00:30) — beyond maxDispatchLagMs (10s), so the
// snapshot-derived V-lag gate rejects every initial send.
const LATE_NOW = Date.parse('2026-07-18T12:00:45.000Z');

test('a gate-violating fire installs a writer-clean artifact — every arm null-start, zero attempts', async () => {
  const { outcome, store, scripts } = await fireOf({ now: () => LATE_NOW });
  assert.equal(outcome.kind, 'Installed', 'the fire produces a durable artifact even when every arm is gated out');
  if (outcome.kind !== 'Installed') return;
  assert.equal(scripts.reduce((n, s) => n + s.calls, 0), 0, 'no arm was sent — the snapshot-derived gate rejected each initial');
  for (const arm of outcome.artifact.arms) {
    assert.equal(arm.terminalOutcome, 'dispatch_lag_exceeded', 'per violating arm: dispatch_lag_exceeded');
    assert.equal(arm.initialRequestStartedAt, null, 'per violating arm: initialRequestStartedAt null');
    assert.equal(arm.orderedAttempts.length, 0, 'per violating arm: zero orderedAttempts');
  }
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
  const outcome = await runOneFire({ snapshot, adapters: map, claimPort: wrapped, sink, runOptions, admission: ADMISSION, now: () => LATE_NOW });
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
        adapters: new Map(),
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

test('B1-R1(e): a non-finite (NaN) clock reading fails CLOSED (throws PreClaimClockError), never admits through NaN >= x', async () => {
  const snapshot = sealed();
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  await assert.rejects(
    () =>
      runOneFire({
        snapshot,
        adapters: new Map(),
        claimPort: new StoreClaimPort(store),
        sink,
        runOptions: runOpts(),
        admission: ADMISSION,
        now: () => Number.NaN,
      }),
    (e) => e instanceof PreClaimClockError,
  );
  assert.equal(store.admitCalls.length, 0, 'a broken clock never admits — NaN >= x must not be read as false');
  assert.equal(sink.calls.length, 0);
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
  const { outcome, snapshot } = await fireOf({ now: () => AFTER_FIRST_PITCH });
  assert.equal(outcome.kind, 'CoverageMiss');
  if (outcome.kind !== 'CoverageMiss') return;
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
