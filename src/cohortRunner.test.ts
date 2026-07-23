import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cohortBoot } from './cohortBoot.js';
import { runCohortTick } from './cohortRunner.js';
import { discover } from './lineOpenRead.js';
import { assertReplayPendingRecovery, RehearsalClaimPort, replayReleaseCapabilityForRecovery, StoreClaimPort } from './lineOpenClaim.js';
import { FireArtifactSink } from './fireArtifactSink.js';
import { checkPublication } from './manifestPublication.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { MODEL_PRICE_TABLE_DIGEST, MODEL_PRICE_TABLE_VERSION } from './modelPriceTable.js';
import { promptScaffoldSha256 } from './prompt.js';
import { REPAIR_POLICY_VERSION } from './repairPolicy.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import { STORE_SCHEMA_VERSION } from './store/constants.js';
import type { BootedCohort } from './cohortBoot.js';
import type { CohortTickInput, CohortTickResult, FireOutcomeSummary } from './cohortRunner.js';
import type { DiscoverFn, DiscoveryReads, MarketEvidenceRead, ReadMarketEvidenceFn } from './lineOpenRead.js';
import type { ClaimOutcome, ClaimPort } from './lineOpenClaim.js';
import type { ArtifactInstaller, LineOpenRunOptions } from './lineOpenSpine.js';
import type { FireArtifactV1 } from './fireArtifactProducer.js';
import type { ArtifactFs } from './fireArtifactSink.js';
import type { PublicationVerified } from './manifestPublication.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type {
  AcquireRepairLeaseRequest,
  AdmitDispatchRequest,
  AdmitResult,
  AtomicStore,
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
  BenchmarkResponse,
  ChatTurn,
  CurrentOddsRow,
  GameBundle,
  GamesEndpointRow,
  MarketKey,
  ProviderAdapter,
  ProviderName,
  ProviderResponse,
} from './types.js';

/**
 * The per-tick cohort runner loop, driven end to end over injected seams: a genuine
 * `cohortBoot` cohort + `checkPublication` record, a genuine branded `discover` snapshot
 * (via the real `discover` seam with injected fake reads), the real projector, the real
 * composition spine, and a genuine permit minted by a real `StoreClaimPort` over a scripted
 * `AtomicStore`. Provider adapters are synthetic (they derive a valid body from the prompt);
 * artifact installs use an in-memory filesystem. No real fetcher, database, watcher, or live path.
 */

// --- aligned time constants (mirrors the projector fixtures) ----------------

const WINDOW_START = '2026-07-18T00:00:00.000Z';
const WINDOW_END = '2026-07-19T00:00:00.000Z';
const COMMITTER_TS = '2026-07-17T23:00:00+00:00';
const DISCO_MS = Date.parse('2026-07-18T12:00:00.000Z');
const DETECT_MS = DISCO_MS + 5_000;
const OPENER_AT = '2026-07-18T11:59:05.000Z';
const QUOTE_AT = '2026-07-18T11:59:00+00:00';
const MATCH_TIME = '2026-07-18T20:00:00+00:00';
// ONE coherent benchmark-host clock now drives BOTH detection and dispatch (B2): the tick's injected
// `now` (see `tickClock`) stamps `detectedAt` in the projector AND the send-time V-lag start in the
// spine, so the two clocks can never silently diverge. The fixture clock advances only a few ms
// across a tick — well inside the 10s dispatch-lag bound — so every fire admits and exercises the
// send path rather than gating every fire out.
const OWNER = 'owner-host-1234-abc';

const CODE_ARMS = defaultExpectedArms();

// --- manifest / boot / publication ------------------------------------------

function manifestObject(overConstants: Record<string, number> = {}): Record<string, unknown> {
  return {
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
    repairPolicyVersion: REPAIR_POLICY_VERSION,
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: MODEL_PRICE_TABLE_VERSION,
    modelPriceTableDigest: MODEL_PRICE_TABLE_DIGEST,
    spendReservationPolicyVersion: 'fixed-attempt-v1',
    runnerCommitSha: 'e'.repeat(40),
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
      maxConcurrentProviderRequests: Math.max(8, CODE_ARMS.length),
      maxDispatchesPerTick: 8,
      ...overConstants,
    },
    cohortCallCap: 1_000,
    cohortSpendCapUsdMicros: 1_000_000,
  };
}

function manifestJson(overConstants: Record<string, number> = {}): string {
  return JSON.stringify(manifestObject(overConstants));
}

function publicationFor(json: string): PublicationVerified {
  const bytes = new TextEncoder().encode(json);
  return checkPublication({
    localManifestBytes: bytes,
    publication: {
      repositoryOwner: 'ospex-org',
      repositoryName: 'ospex-benchmark',
      path: 'manifests/cohort.json',
      commitSha: 'a'.repeat(40),
    },
    resolved: { blobBytes: bytes, committerTimestamp: COMMITTER_TS },
  });
}

// --- read-path row fixtures -------------------------------------------------

function makeGame(over: Partial<GamesEndpointRow> = {}): GamesEndpointRow {
  const gameId = over.gameId ?? 'g1';
  return {
    gameId,
    slug: `slug-${gameId}`,
    sport: 'mlb',
    matchTime: MATCH_TIME,
    status: 'upcoming',
    homeTeam: { name: 'Home Nine', abbreviation: 'HOM' },
    awayTeam: { name: 'Away Nine', abbreviation: 'AWY' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: true,
    externalIds: { jsonodds: gameId, sportspage: null, rundown: null },
    ...over,
  };
}

function makeOdds(over: Partial<CurrentOddsRow> = {}): CurrentOddsRow {
  return {
    network: 'polygon',
    jsonodds_id: 'g1',
    market: 'moneyline',
    line: null,
    away_odds_american: -120,
    home_odds_american: 110,
    upstream_last_updated: QUOTE_AT,
    poll_captured_at: QUOTE_AT,
    changed_at: QUOTE_AT,
    ...over,
  };
}

function makeHistory(gameId: string, market: MarketKey, over: Partial<TwoSidedHistoryRow> = {}): TwoSidedHistoryRow {
  const quote =
    market === 'moneyline'
      ? { line: null, away_odds_american: -120, away_odds_decimal: 1.83333, home_odds_american: 110, home_odds_decimal: 2.1 }
      : market === 'total'
        ? { line: 8.5, away_odds_american: -115, away_odds_decimal: 1.86957, home_odds_american: -105, home_odds_decimal: 1.95238 }
        : { line: -1.5, away_odds_american: -110, away_odds_decimal: 1.90909, home_odds_american: -110, home_odds_decimal: 1.90909 };
  const captured_at = over.captured_at ?? OPENER_AT;
  return {
    id: 1,
    jsonodds_id: gameId,
    market,
    source: 'jsonodds',
    ...quote,
    ...over,
    captured_at,
    captured_at_ms: over.captured_at_ms ?? Date.parse(captured_at),
  };
}

// --- discovery + evidence seams ---------------------------------------------

function discoveryReads(games: GamesEndpointRow[], odds: CurrentOddsRow[]): DiscoveryReads {
  return {
    readGames: async (sport) => games.filter((g) => g.sport === sport),
    readCurrentOdds: async () => odds,
    now: () => DISCO_MS,
  };
}

function discoverFn(games: GamesEndpointRow[], odds: CurrentOddsRow[]): DiscoverFn {
  return (booted) => discover(booted, discoveryReads(games, odds));
}

/** A per-pair evidence reader; each pair defaults to a single valid opener row. A pair mapped
 *  to `[]` is a completed empty read (opener_not_visible). */
function evidenceReader(rowsByPair: Map<string, readonly TwoSidedHistoryRow[]> = new Map()): ReadMarketEvidenceFn {
  return async (_booted, gameId, market): Promise<MarketEvidenceRead> => {
    const rows = rowsByPair.get(`${gameId}::${market}`) ?? [makeHistory(gameId, market)];
    return { gameId, market, historyRows: rows, historyWatermark: null, readCompletedAt: '2026-07-18T12:00:01.000Z' };
  };
}

/** A stateful injected clock returning a fixed sequence (repeating the last value once
 *  exhausted). Feeds the projector's one detection read + one read per sealed fire. */
function tickClock(values: readonly number[] = [DETECT_MS, DETECT_MS + 1_000, DETECT_MS + 2_000, DETECT_MS + 3_000, DETECT_MS + 4_000]): () => number {
  let i = 0;
  return () => {
    const v = values[Math.min(i, values.length - 1)];
    i += 1;
    if (v === undefined) throw new Error('tickClock has no values');
    return v;
  };
}

// --- a scripted store that auto-admits the full proposed scope ---------------

class ScriptedStore implements AtomicStore {
  readonly admitCalls: AdmitDispatchRequest[] = [];
  readonly releaseCalls: ReleaseLeaseRequest[] = [];
  readonly completeCalls: CompleteClaimRequest[] = [];
  private admits = 0;
  /** When set, the store returns THIS admit result (built from the captured request + freshly-minted
   *  roster leases) instead of the default full-scope admit — used to drive a genuine replayed/pending. */
  admitOutcome?: (req: AdmitDispatchRequest, leases: Lease[]) => AdmitResult;
  /** The completion result the store returns; default a clean `completed`, overridable to a refusal. */
  completeOutcome: CompleteResult = { outcome: 'completed' };

  constructor(private readonly rosterSize: number) {}

  initCohortBudget(_r: InitCohortBudgetRequest): Promise<InitResult> {
    throw new Error('not used');
  }
  admitDispatch(req: AdmitDispatchRequest): Promise<AdmitResult> {
    this.admitCalls.push(req);
    // Per-admit lease-id prefix so two admissions in one tick never collide on lease ids.
    const prefix = `a${(this.admits += 1)}-`;
    const initialLeases: Lease[] = Array.from({ length: this.rosterSize }, (_, armIndex) => ({
      leaseId: `${prefix}lease-${armIndex}`,
      armIndex,
      expiresAt: '2026-07-18T12:10:00.000Z',
      state: 'live' as const,
    }));
    if (this.admitOutcome) return Promise.resolve(this.admitOutcome(req, initialLeases));
    const reservation = Object.values(req.scopeReservations)[0]!;
    return Promise.resolve({
      outcome: 'admitted',
      claimedKeys: req.proposedMarkets.map((market) => ({ gameId: req.gameId, market })),
      preparedBytesDigest: reservation.preparedBytesDigest,
      initialLeases,
      dispatchAuthorized: true,
    });
  }
  acquireRepairLease(req: AcquireRepairLeaseRequest): Promise<RepairLeaseResult> {
    return Promise.resolve({
      outcome: 'acquired',
      lease: { leaseId: `repair-${req.armIndex}-${req.repairOrdinal}`, armIndex: req.armIndex, expiresAt: '2026-07-18T12:20:00.000Z', state: 'live' },
      requestAuthorized: true,
    });
  }
  releaseLease(req: ReleaseLeaseRequest): Promise<ReleaseResult> {
    this.releaseCalls.push(req);
    return Promise.resolve({ outcome: 'released' });
  }
  completeClaim(req: CompleteClaimRequest): Promise<CompleteResult> {
    this.completeCalls.push(req);
    return Promise.resolve(this.completeOutcome);
  }
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

/** An installer spy that delegates to a real sink and records each call. */
function countingSink(real: ArtifactInstaller): ArtifactInstaller & { calls: FireArtifactV1[] } {
  const calls: FireArtifactV1[] = [];
  return {
    calls,
    install(artifact) {
      calls.push(artifact);
      return real.install(artifact);
    },
  };
}

// --- synthetic provider adapters that answer from the prompt ----------------

interface PromptPayload {
  cohortId: string;
  participantId: string;
  requestedModelId: string;
  executionPolicy: BenchmarkResponse['executionPolicy'];
  bundleSha256: string;
  bundle: { games: GameBundle[] };
}

/** Derive a valid benchmark response body for WHATEVER single-game bundle the prompt carries,
 *  so ONE adapter map serves every fire in a tick regardless of its game/market/digest. */
function bodyFromPrompt(turns: ChatTurn[]): string {
  const userMessage = turns.find((t) => t.role === 'user')?.content ?? '';
  const marker = '\n\nRequest:\n';
  const at = userMessage.indexOf(marker);
  if (at < 0) throw new Error('smart adapter: no Request payload in prompt');
  const payload = JSON.parse(userMessage.slice(at + marker.length)) as PromptPayload;
  const game = payload.bundle.games[0]!;
  const forecasts: BenchmarkResponse['games'][number]['forecasts'] = [];
  if (game.markets.moneyline) {
    forecasts.push({ market: 'moneyline', selection: game.awayTeam, line: null, observedDecimal: game.markets.moneyline.awayDecimal, probabilities: { win: 0.55, push: 0, loss: 0.45 }, confidence: 0.6, wouldAbstain: false, selectedForExecution: true, rationale: 'r', evidenceRefs: [game.markets.moneyline.evidenceRef], reasonCode: null });
  }
  if (game.markets.total) {
    forecasts.push({ market: 'total', selection: 'over', line: game.markets.total.line, observedDecimal: game.markets.total.overDecimal, probabilities: { win: 0.5, push: 0, loss: 0.5 }, confidence: 0.5, wouldAbstain: false, selectedForExecution: true, rationale: 'r', evidenceRefs: [game.markets.total.evidenceRef], reasonCode: null });
  }
  const body: BenchmarkResponse = {
    schemaVersion: 1,
    cohortId: payload.cohortId,
    participantId: payload.participantId,
    requestedModelId: payload.requestedModelId,
    bundleSha256: payload.bundleSha256,
    executionPolicy: payload.executionPolicy,
    games: [{ gameId: game.gameId, forecasts }],
  };
  return JSON.stringify(body);
}

function smartAdapters(): Map<string, ProviderAdapter> {
  const map = new Map<string, ProviderAdapter>();
  for (const arm of CODE_ARMS) {
    const adapter: ProviderAdapter = {
      provider: arm.provider as ProviderName,
      requestedModelId: arm.requestedModelId,
      credentialEnvVar: `${arm.participantId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_KEY`,
      hasCredential: () => true,
      async chat(turns: ChatTurn[], _ms: number): Promise<ProviderResponse> {
        return { rawText: bodyFromPrompt(turns), reportedModelId: arm.requestedModelId, providerResponseId: 'x', httpStatus: 200, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, usageRaw: {}, requestParams: {} };
      },
    };
    map.set(arm.participantId, adapter);
  }
  return map;
}

function runOpts(): LineOpenRunOptions {
  return {
    timeoutMs: 600_000,
    maxOutputTokens: 16_000,
    executionPolicy: 'fixed-moneyline-total',
    baselinePolicyVersion: 'baselines-v0.3.0',
  };
}

const ADMISSION = { ownerId: OWNER, expectedSchemaVersion: STORE_SCHEMA_VERSION } as const;

/** Assemble a tick input from a booted cohort + injected seams, filling the shared defaults. */
function tickInput(
  json: string,
  games: GamesEndpointRow[],
  odds: CurrentOddsRow[],
  over: {
    claimPort: ClaimPort;
    sink?: ArtifactInstaller;
    adapters?: ReadonlyMap<string, ProviderAdapter>;
    readMarketEvidence?: ReadMarketEvidenceFn;
    now?: () => number;
    onStatus?: (line: string) => void;
  },
): { booted: BootedCohort; input: CohortTickInput } {
  const booted = cohortBoot({ live: false, manifestBytes: json });
  const input: CohortTickInput = {
    booted,
    publication: publicationFor(json),
    discover: discoverFn(games, odds),
    readMarketEvidence: over.readMarketEvidence ?? evidenceReader(),
    claimPort: over.claimPort,
    adapters: over.adapters ?? smartAdapters(),
    sink: over.sink ?? new FireArtifactSink('/base', new MemoryFs()),
    runOptions: runOpts(),
    admission: ADMISSION,
    now: over.now ?? tickClock(),
    ...(over.onStatus ? { onStatus: over.onStatus } : {}),
  };
  return { booted, input };
}

// ===========================================================================
// (a) happy path — discover -> project -> one accepted fire -> Installed
// ===========================================================================

test('one accepted candidate discovers, projects, dispatches, and installs exactly once', async () => {
  const json = manifestJson();
  const store = new ScriptedStore(CODE_ARMS.length);
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  const status: string[] = [];
  const { input } = tickInput(json, [makeGame({ gameId: 'g1' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })], {
    claimPort: new StoreClaimPort(store),
    sink,
    onStatus: (line) => status.push(line),
  });

  const result = await runCohortTick(input);

  assert.equal(result.discoveredCount, 1);
  assert.deepEqual(result.dispositions.map((d) => ({ ...d })), [{ gameId: 'g1', market: 'moneyline', outcome: 'prepared' }]);
  assert.equal(result.admittedCount, 1);
  assert.equal(result.fireOutcomes.length, 1);
  const installed = result.fireOutcomes[0]!.outcome;
  assert.equal(installed.kind, 'Installed');
  // The full typed outcome survives — a completed store settle is confirmed `settled`.
  if (installed.kind === 'Installed') assert.deepEqual(installed.completion, { status: 'settled' });
  assert.equal(result.fireOutcomes[0]!.gameId, 'g1');
  assert.equal(result.fireOutcomes[0]!.market, 'moneyline');
  // The fire's artifact install seam was invoked exactly once, and the claim settled once.
  assert.equal(sink.calls.length, 1, 'exactly one artifact installed');
  assert.equal(store.admitCalls.length, 1, 'exactly one admission');
  assert.equal(store.completeCalls.length, 1, 'the installed claim settled once');
  assert.equal(status.length, 1, 'one status line per attempted fire');
  // The result graph is frozen.
  assert.ok(Object.isFrozen(result));
  assert.throws(() => (result.fireOutcomes as FireOutcomeSummary[]).push(result.fireOutcomes[0]!));
});

// ===========================================================================
// (b) rehearsal — every fire NotAdmitted, nothing installed, all fires reported
// ===========================================================================

test('a rehearsal claim port admits nothing, installs nothing, and reports every fire', async () => {
  const json = manifestJson();
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  const games = [makeGame({ gameId: 'g1' }), makeGame({ gameId: 'g2' })];
  const odds = [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' }), makeOdds({ jsonodds_id: 'g2', market: 'moneyline' })];
  const { input } = tickInput(json, games, odds, { claimPort: new RehearsalClaimPort(), sink });

  const result = await runCohortTick(input);

  // Both candidates are PREPARED by the projector (it does not know the claim port), then the
  // rehearsal declines each at dispatch.
  assert.equal(result.discoveredCount, 2);
  assert.equal(result.dispositions.length, 2);
  assert.ok(result.dispositions.every((d) => d.outcome === 'prepared'), 'both candidates prepared');
  assert.equal(result.fireOutcomes.length, 2, 'every prepared fire is reported');
  assert.ok(result.fireOutcomes.every((f) => f.outcome.kind === 'NotAdmitted'), 'every fire is NotAdmitted');
  assert.equal(result.admittedCount, 0);
  assert.equal(sink.calls.length, 0, 'a rehearsal installs nothing');
});

// ===========================================================================
// (c) the per-tick dispatch budget
// ===========================================================================

test('maxDispatchesPerTick stops the loop after the budget of admitted fires is reached', async () => {
  // Cap at 1 with two admittable fires: only the first (by projection order) installs.
  const json = manifestJson({ maxDispatchesPerTick: 1 });
  const store = new ScriptedStore(CODE_ARMS.length);
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  const games = [makeGame({ gameId: 'g1' }), makeGame({ gameId: 'g2' })];
  const odds = [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' }), makeOdds({ jsonodds_id: 'g2', market: 'moneyline' })];
  const { input } = tickInput(json, games, odds, { claimPort: new StoreClaimPort(store), sink });

  const result = await runCohortTick(input);

  // Both were discovered + prepared, but only the first is dispatched; the loop stops.
  assert.equal(result.discoveredCount, 2);
  assert.equal(result.dispositions.length, 2);
  assert.equal(result.admittedCount, 1);
  assert.equal(result.fireOutcomes.length, 1, 'only the first fire was attempted');
  assert.equal(result.fireOutcomes[0]!.outcome.kind, 'Installed');
  assert.equal(result.fireOutcomes[0]!.gameId, 'g1', 'g1 sorts first and is the one dispatched');
  assert.equal(store.admitCalls.length, 1, 'the store was asked to admit exactly once — the loop stopped');
  assert.equal(sink.calls.length, 1);
});

test('a leading all_claimed fire does not burn the dispatch budget; a later admittable fire is still attempted', async () => {
  const json = manifestJson({ maxDispatchesPerTick: 1 });
  const store = new ScriptedStore(CODE_ARMS.length);
  const real = new StoreClaimPort(store);
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  const games = [makeGame({ gameId: 'g1' }), makeGame({ gameId: 'g2' })];
  const odds = [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' }), makeOdds({ jsonodds_id: 'g2', market: 'moneyline' })];
  // g1 (which sorts first) is terminally all_claimed; g2 admits normally.
  const claimPort: ClaimPort = {
    admit: (req) => (req.gameId === 'g1' ? Promise.resolve({ kind: 'Skip', reason: 'all_claimed' }) : real.admit(req)),
  };
  const { input } = tickInput(json, games, odds, { claimPort, sink });

  const result = await runCohortTick(input);

  assert.equal(result.fireOutcomes.length, 2, 'both fires attempted — all_claimed did not consume the budget');
  assert.equal(result.fireOutcomes[0]!.gameId, 'g1');
  const g1Outcome = result.fireOutcomes[0]!.outcome;
  assert.equal(g1Outcome.kind, 'NotAdmitted', 'g1 is all_claimed');
  // The all_claimed Skip reason is reachable through the tick result.
  if (g1Outcome.kind === 'NotAdmitted') assert.equal(g1Outcome.outcome.kind === 'Skip' ? g1Outcome.outcome.reason : null, 'all_claimed');
  assert.equal(result.fireOutcomes[1]!.gameId, 'g2');
  assert.equal(result.fireOutcomes[1]!.outcome.kind, 'Installed', 'g2 still admits under cap 1');
  assert.equal(result.admittedCount, 1);
  assert.equal(sink.calls.length, 1, 'only g2 installed');
});

// ===========================================================================
// (d) every discovered candidate appears once in the dispositions
// ===========================================================================

test('every discovered candidate appears exactly once in the tick dispositions', async () => {
  const json = manifestJson();
  const games = [makeGame({ gameId: 'g1' }), makeGame({ gameId: 'g2' }), makeGame({ gameId: 'g3' })];
  const odds = [
    makeOdds({ jsonodds_id: 'g1', market: 'moneyline' }), // reconciles -> prepared
    makeOdds({ jsonodds_id: 'g2', market: 'moneyline', away_odds_american: -140 }), // drifted -> quote_moved
    makeOdds({ jsonodds_id: 'g3', market: 'moneyline' }), // empty opener -> opener_not_visible
  ];
  const rowsByPair = new Map<string, readonly TwoSidedHistoryRow[]>([['g3::moneyline', []]]);
  const { input } = tickInput(json, games, odds, {
    claimPort: new RehearsalClaimPort(),
    readMarketEvidence: evidenceReader(rowsByPair),
  });

  const result = await runCohortTick(input);

  assert.equal(result.discoveredCount, 3);
  assert.equal(result.dispositions.length, 3);
  const keys = result.dispositions.map((d) => `${d.gameId}::${d.market}`);
  assert.equal(new Set(keys).size, keys.length, 'exactly one disposition per discovered candidate');
  const by = new Map(result.dispositions.map((d) => [`${d.gameId}::${d.market}`, d]));
  assert.equal(by.get('g1::moneyline')!.outcome, 'prepared');
  const g2 = by.get('g2::moneyline')!;
  assert.equal(g2.outcome === 'defer' ? g2.reason : null, 'quote_moved');
  const g3 = by.get('g3::moneyline')!;
  assert.equal(g3.outcome === 'defer' ? g3.reason : null, 'opener_not_visible');
});

// ===========================================================================
// (e) a rejecting evidence read fails the tick loudly
// ===========================================================================

test('a rejecting readMarketEvidence propagates and fails the whole tick', async () => {
  const json = manifestJson();
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  const store = new ScriptedStore(CODE_ARMS.length);
  const sentinel = new Error('odds_history read faulted');
  const { input } = tickInput(json, [makeGame({ gameId: 'g1' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })], {
    claimPort: new StoreClaimPort(store),
    sink,
    readMarketEvidence: () => Promise.reject(sentinel),
  });

  await assert.rejects(() => runCohortTick(input), (e) => e === sentinel);
  // A read fault happens before any dispatch — nothing was admitted or installed.
  assert.equal(store.admitCalls.length, 0);
  assert.equal(sink.calls.length, 0);
});

// ===========================================================================
// (f) non-activation — the module composes only injected seams
// ===========================================================================

test('the runner module imports no real fetcher/store/filesystem/ambient clock', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'cohortRunner.ts'), 'utf8');
  assert.ok(!/from '\.\/fetchers/.test(src), 'no real fetcher import');
  assert.ok(!/from '\.\/store\//.test(src), 'no real store import');
  assert.ok(!/atomicStore/.test(src), 'no atomic store import');
  assert.ok(!/from 'node:fs'|from 'node:net'|from 'node:http/.test(src), 'no filesystem/network import');
  assert.ok(!/Date\.now/.test(src), 'no ambient clock — the tick clock is injected');
});

// ===========================================================================
// B2-R2 — one coherent detection→dispatch clock threaded through the tick
// ===========================================================================

test('B2-R2: one injected tick clock sources BOTH detectedAt and the persisted V-lag start — the operand is the real elapsed ticks', async () => {
  const json = manifestJson();
  const store = new ScriptedStore(CODE_ARMS.length);
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  // ONE clock, threaded through the tick: it advances by exactly 1ms per read and RECORDS every
  // value it returns. `detectedAt` (stamped by the projector) and each arm's `initialRequestStartedAt`
  // (stamped at the send) must BOTH be values THIS clock produced — so the persisted V-lag operand
  // `initialRequestStartedAt − detectedAt` equals the number of clock advances between them (the real
  // elapsed ticks), and can never be an artifact of two divergent clocks. Under the B2-R2 mutation
  // (dispatch clock re-sourced from a separate `runOptions.nowMs`), the persisted start would NOT be
  // a reading of this recorded tick clock → `seen.includes(startMs)` fails → red.
  const seen: number[] = [];
  let n = 0;
  const now = (): number => {
    const v = DETECT_MS + n;
    n += 1;
    seen.push(v);
    return v;
  };
  const { input } = tickInput(json, [makeGame({ gameId: 'g1' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })], {
    claimPort: new StoreClaimPort(store),
    sink,
    now,
  });

  const result = await runCohortTick(input);
  assert.equal(result.admittedCount, 1, 'the fire admits under the single coherent clock');
  const artifact = sink.calls[0]!;
  const detectedMs = Date.parse(artifact.detectedAt);
  assert.ok(seen.includes(detectedMs), 'detectedAt is a reading of the injected tick clock');
  const sentArms = artifact.arms.filter((a) => a.initialRequestStartedAt !== null);
  assert.ok(sentArms.length > 0, 'at least one arm sent its initial');
  for (const arm of sentArms) {
    const startMs = Date.parse(arm.initialRequestStartedAt!);
    assert.ok(seen.includes(startMs), 'the persisted initial start is a reading of the SAME injected clock, not a divergent one');
    assert.ok(startMs >= detectedMs, 'dispatch never precedes detection under one clock');
    // step = 1ms with no gaps, so the count of clock advances in (detectedMs, startMs] IS the numeric
    // gap: the V-lag operand equals the real elapsed ticks on the single coherent clock.
    const elapsedTicks = seen.filter((v) => v > detectedMs && v <= startMs).length;
    assert.equal(startMs - detectedMs, elapsedTicks, 'the V-lag operand equals the real elapsed ticks on the one clock');
  }
});

test('B2-R2 structural: LineOpenRunOptions omits nowMs; the clock is threaded via RunOneFireInput.now', () => {
  const spineSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lineOpenSpine.ts'), 'utf8');
  assert.ok(
    /export type LineOpenRunOptions = Omit<\s*SlateRunOptions,\s*'cohortId'\s*\|\s*'nowMs'\s*>/.test(spineSrc),
    "LineOpenRunOptions = Omit<SlateRunOptions, 'cohortId' | 'nowMs'> (the dispatch clock is no longer a run-option field)",
  );
  assert.ok(/readonly now:\s*\(\)\s*=>\s*number/.test(spineSrc), 'RunOneFireInput carries the required tick clock `now`');
  // The spine sources the dispatch clock from the threaded tick clock, never a caller run-option field.
  const body = spineSrc.slice(spineSrc.indexOf('export async function runOneFire'));
  assert.ok(/const now = input\.now;/.test(body), 'the tick clock is captured from input.now before the first await');
  assert.ok(/nowMs: now,/.test(body), 'runnerOptions.nowMs is the captured tick clock');
  assert.ok(!/nowMs: (?:runOptions|capturedOptions)\.nowMs/.test(body), 'the dispatch clock is never re-read from runOptions');
});

// ===========================================================================
// typed terminal outcomes survive the tick boundary (not collapsed to a kind)
// ===========================================================================

test('a retryable Defer stays distinguishable from a terminal Skip and a loud Fault through the tick result', async () => {
  const json = manifestJson();
  const games = [makeGame({ gameId: 'g1' })];
  const odds = [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })];

  // Each fake claim port yields a distinct non-authorizing ClaimOutcome; runOneFire forwards it as
  // NotAdmitted, and the tick must preserve the FULL outcome (kind + reason), not just `kind`.
  const runWith = (claimPort: ClaimPort): Promise<CohortTickResult> =>
    runCohortTick(tickInput(json, games, odds, { claimPort, sink: countingSink(new FireArtifactSink('/base', new MemoryFs())) }).input);

  const deferResult = await runWith({ admit: () => Promise.resolve({ kind: 'Defer', reason: 'concurrency' }) });
  const skipResult = await runWith({ admit: () => Promise.resolve({ kind: 'Skip', reason: 'all_claimed' }) });
  const faultResult = await runWith({ admit: () => Promise.resolve({ kind: 'Fault', reason: 'store_admit_failed' }) });

  const claimOf = (r: CohortTickResult): Exclude<ClaimOutcome, { kind: 'Authorized' }> => {
    const outcome = r.fireOutcomes[0]!.outcome;
    assert.equal(outcome.kind, 'NotAdmitted');
    if (outcome.kind !== 'NotAdmitted') throw new Error('unreachable');
    return outcome.outcome;
  };
  const deferClaim = claimOf(deferResult);
  const skipClaim = claimOf(skipResult);
  const faultClaim = claimOf(faultResult);

  // The retryable Defer's reason is reachable...
  assert.equal(deferClaim.kind, 'Defer');
  assert.equal(deferClaim.kind === 'Defer' ? deferClaim.reason : null, 'concurrency');
  // ...and a terminal Skip / loud Fault CANNOT collapse into that Defer — distinct kinds + reasons.
  assert.equal(skipClaim.kind, 'Skip');
  assert.equal(faultClaim.kind, 'Fault');
  assert.notEqual(skipClaim.kind, deferClaim.kind);
  assert.notEqual(faultClaim.kind, deferClaim.kind);
  // None consumed the dispatch budget (only an Installed fire does).
  for (const r of [deferResult, skipResult, faultResult]) assert.equal(r.admittedCount, 0);
});

test('a replayed_pending Skip carries its branded recovery capability through to the tick result', async () => {
  const json = manifestJson();
  const store = new ScriptedStore(CODE_ARMS.length);
  // The store idempotently replays an already-committed, still-pending admission: StoreClaimPort
  // mints a genuine branded ReplayPendingRecovery with its release-only cleanup capability.
  store.admitOutcome = (req, leases) => ({
    outcome: 'replayed',
    fireStatus: 'pending',
    claimedKeys: req.proposedMarkets.map((market) => ({ gameId: req.gameId, market })),
    initialLeases: leases,
    dispatchAuthorized: false,
  });
  const sink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  const { input } = tickInput(json, [makeGame({ gameId: 'g1' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })], {
    claimPort: new StoreClaimPort(store),
    sink,
  });

  const result = await runCohortTick(input);

  assert.equal(result.admittedCount, 0, 'a replay authorizes no dispatch');
  assert.equal(sink.calls.length, 0, 'a replay installs nothing');
  const outcome = result.fireOutcomes[0]!.outcome;
  assert.equal(outcome.kind, 'NotAdmitted');
  if (outcome.kind !== 'NotAdmitted') return;
  const claim = outcome.outcome;
  assert.ok(claim.kind === 'Skip' && claim.reason === 'replayed_pending', 'a replayed_pending Skip');
  if (claim.kind !== 'Skip' || claim.reason !== 'replayed_pending') return;
  // The detached recovery — and its branded release-only cleanup capability — was NOT discarded or
  // copied away: it is reachable by reference and still authenticates against its own brand (a
  // deep-freeze / structural copy at the tick boundary would break the brand or the closure).
  assert.doesNotThrow(() => assertReplayPendingRecovery(claim.recovery));
  assert.doesNotThrow(() => replayReleaseCapabilityForRecovery(claim.recovery));
  assert.equal(claim.recovery.fireId, result.fireOutcomes[0]!.fireId, 'the recovery identifies this fire');
});

test('an installed fire whose settle is refused stays Installed with an unsettled reason, distinct from settled', async () => {
  const json = manifestJson();
  const games = [makeGame({ gameId: 'g1' })];
  const odds = [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })];

  // Baseline: a clean store completion → settled.
  const settledStore = new ScriptedStore(CODE_ARMS.length);
  const settled = await runCohortTick(
    tickInput(json, games, odds, { claimPort: new StoreClaimPort(settledStore), sink: countingSink(new FireArtifactSink('/base', new MemoryFs())) }).input,
  );

  // The store REFUSES the post-install settle with version_mismatch; fireSettlement classifies it
  // as unsettled/version_mismatch. The artifact is still durably installed (kind Installed).
  const unsettledStore = new ScriptedStore(CODE_ARMS.length);
  unsettledStore.completeOutcome = { outcome: 'refused', reason: 'version_mismatch' };
  const unsettledSink = countingSink(new FireArtifactSink('/base', new MemoryFs()));
  const unsettledResult = await runCohortTick(
    tickInput(json, games, odds, { claimPort: new StoreClaimPort(unsettledStore), sink: unsettledSink }).input,
  );

  const settledOutcome = settled.fireOutcomes[0]!.outcome;
  const unsettledOutcome = unsettledResult.fireOutcomes[0]!.outcome;
  assert.equal(settledOutcome.kind, 'Installed');
  assert.equal(unsettledOutcome.kind, 'Installed');
  if (settledOutcome.kind !== 'Installed' || unsettledOutcome.kind !== 'Installed') return;
  // Both installed and both consumed the budget — but the completion confirmation is preserved and
  // distinct, so an activation consumer can escalate the unsettled one.
  assert.equal(unsettledResult.admittedCount, 1, 'an unsettled install still counts as admitted');
  assert.equal(unsettledSink.calls.length, 1, 'the artifact is durably installed despite the settle refusal');
  assert.deepEqual(settledOutcome.completion, { status: 'settled' });
  assert.deepEqual(unsettledOutcome.completion, { status: 'unsettled', reason: 'version_mismatch' });
  assert.notDeepEqual(unsettledOutcome.completion, settledOutcome.completion);
});
