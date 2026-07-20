import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cohortBoot } from './cohortBoot.js';
import { evaluateCandidate } from './detection.js';
import { StoreClaimPort } from './lineOpenClaim.js';
import { authorizePreparedDispatch } from './lineOpenDispatch.js';
import type { AuthorizedDispatch } from './lineOpenDispatch.js';
import { createAttemptLifecycle, LifecycleFaultError } from './lineOpenLifecycle.js';
import { checkPublication } from './manifestPublication.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { sealPreparedFire } from './preparedFire.js';
import type { PreparedFireSnapshot } from './preparedFire.js';
import { promptScaffoldSha256 } from './prompt.js';
import { runAuthorizedDispatch } from './runner.js';
import type { SlateRunOptions } from './runner.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import { SMOKE_LABEL } from './types.js';
import type { CandidateInput } from './detection.js';
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
  GameBundle,
  MarketKey,
  ProviderAdapter,
  ProviderName,
  ProviderResponse,
} from './types.js';

/**
 * The permit-bound attempt lifecycle and the canonical authorized dispatch path. Every test
 * drives a genuine sealed snapshot, a genuine permit minted through `StoreClaimPort` from a
 * scripted `AtomicStore`, and synthetic adapters — no provider, database, or live path.
 */

const GAME_ID = '00000000-0000-4000-8000-0000000000f1';
const CUTOFF = '2026-07-18T20:00:00+00:00';
const CUTOFF_MS = Date.parse(CUTOFF);
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
const SCHEMA = 1;
const MARKETS: readonly MarketKey[] = ['moneyline', 'total'];
const CODE_ARMS = defaultExpectedArms();

// --- fixtures ---------------------------------------------------------------

function manifestJson(): string {
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
    modelPriceTableVersion: 'prices-v1',
    modelPriceTableDigest: 'd'.repeat(64),
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
      ingestionGraceMs: 900_000,
      scheduleChangeToleranceMs: 60_000,
      maxConcurrentProviderRequests: Math.max(8, CODE_ARMS.length),
      maxDispatchesPerTick: 8,
    },
    cohortCallCap: 1_000,
    cohortSpendCapUsdMicros: 1_000_000,
  });
}

function scopedGame(): GameBundle {
  return {
    gameId: GAME_ID,
    league: 'mlb',
    scheduledStartUtc: CUTOFF,
    awayTeam: 'Milwaukee Brewers',
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: {
      moneyline: { awayDecimal: 1.74627, homeDecimal: 2.17, observedAt: OBSERVED_AT, evidenceRef: `ev:${GAME_ID}:moneyline` },
      total: { line: 8.5, overDecimal: 1.90909, underDecimal: 1.90909, observedAt: OBSERVED_AT, evidenceRef: `ev:${GAME_ID}:total` },
    },
    evidenceRefs: [`ev:${GAME_ID}:identity`, `ev:${GAME_ID}:schedule`, `ev:${GAME_ID}:moneyline`, `ev:${GAME_ID}:total`],
  };
}

function historyRow(market: MarketKey): TwoSidedHistoryRow {
  const quote =
    market === 'moneyline'
      ? { line: null, away_odds_american: -134, away_odds_decimal: 1.74627, home_odds_american: 117, home_odds_decimal: 2.17 }
      : { line: 8.5, away_odds_american: -110, away_odds_decimal: 1.90909, home_odds_american: -110, home_odds_decimal: 1.90909 };
  return { id: 1, jsonodds_id: GAME_ID, market, source: 'jsonodds', ...quote, captured_at: OPENER_AT, captured_at_ms: Date.parse(OPENER_AT) };
}

function candidateInput(market: MarketKey): CandidateInput {
  return {
    gameId: GAME_ID,
    sport: 'mlb',
    market,
    sportAllowList: ['mlb'],
    marketPolicyVersion: MARKET_POLICY_VERSION,
    opener: historyRow(market),
    detectedAt: DETECTED_AT,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    cleanEntryWindowMs: W,
    maxClockSkewMs: SKEW,
  };
}

function sealedSnapshot(): PreparedFireSnapshot {
  const json = manifestJson();
  const bytes = new TextEncoder().encode(json);
  return sealPreparedFire({
    game: scopedGame(),
    slug: 'mil-pit-2026-07-18',
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
    proposedMarkets: MARKETS,
    perMarket: MARKETS.map((m) => ({
      candidateInput: candidateInput(m),
      verdict: evaluateCandidate(candidateInput(m)),
      historyRows: [historyRow(m)],
      historyWatermark: null,
    })),
  });
}

function leases(count: number): Lease[] {
  return Array.from({ length: count }, (_, i) => ({
    leaseId: `lease-${i}`,
    armIndex: i,
    expiresAt: '2026-07-18T12:10:00.000Z',
    state: 'live' as const,
  }));
}

type StoreCall = { op: 'release'; leaseId: string; ownerId: string } | { op: 'repair'; req: AcquireRepairLeaseRequest };

class ScriptedStore implements AtomicStore {
  readonly calls: StoreCall[] = [];
  onRelease: (req: ReleaseLeaseRequest) => Promise<ReleaseResult> = () => Promise.resolve({ outcome: 'released' });
  onRepair: (req: AcquireRepairLeaseRequest) => Promise<RepairLeaseResult> = (req) =>
    Promise.resolve({
      outcome: 'acquired',
      lease: { leaseId: `repair-${req.armIndex}-${req.repairOrdinal}`, armIndex: req.armIndex, expiresAt: '2026-07-18T12:20:00.000Z', state: 'live' },
      requestAuthorized: true,
    });
  constructor(private readonly rosterSize: number) {}

  initCohortBudget(_r: InitCohortBudgetRequest): Promise<InitResult> {
    throw new Error('not used');
  }
  admitDispatch(req: AdmitDispatchRequest): Promise<AdmitResult> {
    return Promise.resolve({
      outcome: 'admitted',
      claimedKeys: MARKETS.map((market) => ({ gameId: req.gameId, market })),
      preparedBytesDigest: req.scopeReservations['moneyline+total']!.preparedBytesDigest,
      initialLeases: leases(this.rosterSize),
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
  completeClaim(_r: CompleteClaimRequest): Promise<CompleteResult> {
    throw new Error('not used');
  }
}

/** A synthetic adapter whose responses are scripted per attempt. */
interface Scripted {
  adapter: ProviderAdapter;
  calls: number;
}

function validBody(participantId: string, requestedModelId: string, cohortId: string, bundleSha: string): string {
  const game = scopedGame();
  const body: BenchmarkResponse = {
    schemaVersion: 1,
    cohortId,
    participantId,
    requestedModelId,
    bundleSha256: bundleSha,
    executionPolicy: 'fixed-moneyline-total',
    games: [
      {
        gameId: GAME_ID,
        forecasts: [
          { market: 'moneyline', selection: game.awayTeam, line: null, observedDecimal: game.markets.moneyline!.awayDecimal, probabilities: { win: 0.55, push: 0, loss: 0.45 }, confidence: 0.6, wouldAbstain: false, selectedForExecution: true, rationale: 'r', evidenceRefs: [game.markets.moneyline!.evidenceRef], reasonCode: null },
          { market: 'total', selection: 'over', line: game.markets.total!.line, observedDecimal: game.markets.total!.overDecimal, probabilities: { win: 0.5, push: 0, loss: 0.5 }, confidence: 0.5, wouldAbstain: false, selectedForExecution: true, rationale: 'r', evidenceRefs: [game.markets.total!.evidenceRef], reasonCode: null },
        ],
      },
    ],
  };
  return JSON.stringify(body);
}

/** An otherwise-valid body whose echoed cohort is wrong: it fails validation but still
 *  yields a complete decision fingerprint, so a repair is attempted. */
function wrongEcho(body: string): string {
  return JSON.stringify({ ...JSON.parse(body), cohortId: 'wrong-cohort-echo' });
}

function scriptedAdapter(
  identity: { participantId: string; provider: string; requestedModelId: string },
  bodies: (call: number) => string | Promise<never>,
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

function options(nowMs: () => number = () => NOW_MS, cohortId?: string): SlateRunOptions {
  return {
    cohortId: cohortId ?? '',
    timeoutMs: 600_000,
    maxOutputTokens: 16_000,
    executionPolicy: 'fixed-moneyline-total',
    baselinePolicyVersion: 'baselines-v0.3.0',
    nowMs,
  };
}

/** Authorize one fire; returns the branded dispatch plus its store and adapters. */
async function authorize(
  build: (snapshot: PreparedFireSnapshot) => Map<string, ProviderAdapter>,
): Promise<{ dispatch: AuthorizedDispatch; store: ScriptedStore; snapshot: PreparedFireSnapshot }> {
  const snapshot = sealedSnapshot();
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length);
  const result = await authorizePreparedDispatch({
    snapshot,
    adapters: build(snapshot),
    request: {
      cohortId: snapshot.booted.cohortId,
      fireId: snapshot.fireId,
      ownerId: OWNER,
      expectedSchemaVersion: SCHEMA,
      gameId: snapshot.prepared.gameId,
      proposedMarkets: [...snapshot.proposedMarkets],
      scopeReservations: { 'moneyline+total': { spendReservationUsdMicros: 1000, preparedBytesDigest: snapshot.prepared.requestSha256 } },
    },
    claimPort: new StoreClaimPort(store),
  });
  if (result.kind !== 'Authorized') throw new Error('fixture: expected an authorized dispatch');
  store.calls.length = 0; // only count lifecycle calls
  return { dispatch: result.dispatch, store, snapshot };
}

/** All arms answer validly on their first attempt. */
function validAdapters(snapshot: PreparedFireSnapshot, cohortId: string): { map: Map<string, ProviderAdapter>; scripts: Scripted[] } {
  const scripts: Scripted[] = [];
  const map = new Map<string, ProviderAdapter>();
  for (const id of snapshot.expectedArmIdentities) {
    const s = scriptedAdapter(id, () => validBody(id.participantId, id.requestedModelId, cohortId, snapshot.prepared.requestSha256));
    scripts.push(s);
    map.set(id.participantId, s.adapter);
  }
  return { map, scripts };
}

const releaseIds = (store: ScriptedStore): string[] =>
  store.calls.filter((c): c is Extract<StoreCall, { op: 'release' }> => c.op === 'release').map((c) => c.leaseId);

// ===========================================================================
// Captured authority reaches the exact store calls
// ===========================================================================

test('every lease call carries the admitted owner, cohort, fire and schema version', async () => {
  const snapshot = sealedSnapshot();
  const { dispatch, store } = await authorize((s) => validAdapters(s, s.booted.cohortId).map);
  const lifecycle = createAttemptLifecycle(dispatch);

  await lifecycle.releaseInitial(0);
  await lifecycle.acquireRepair(1, 1);
  await lifecycle.releaseRepair(1, 1);

  const release = store.calls.find((c) => c.op === 'release')!;
  assert.equal(release.op === 'release' && release.ownerId, dispatch.permit.ownerId);
  const repair = store.calls.find((c) => c.op === 'repair')!;
  assert.ok(repair.op === 'repair');
  assert.equal(repair.req.cohortId, dispatch.permit.cohortId);
  assert.equal(repair.req.fireId, dispatch.permit.fireId);
  assert.equal(repair.req.ownerId, dispatch.permit.ownerId);
  assert.equal(repair.req.expectedSchemaVersion, dispatch.permit.expectedSchemaVersion);
  assert.equal(repair.req.armIndex, 1);
  assert.equal(repair.req.repairOrdinal, 1);
  void snapshot;
});

// ===========================================================================
// Repair authorization / acquired-lease relation matrix
// ===========================================================================

test('a repair is authorized only by a fresh acquisition carrying a coherent live lease', async () => {
  const cases: Array<[string, ScriptedStore['onRepair'], { authorized: boolean; faults: boolean; cleaned: boolean }]> = [
    ['replayed', (req) => Promise.resolve({ outcome: 'replayed', lease: { leaseId: 'r', armIndex: req.armIndex, expiresAt: 'x', state: 'live' }, requestAuthorized: false }), { authorized: false, faults: false, cleaned: false }],
    ['refused', () => Promise.resolve({ outcome: 'refused', reason: 'concurrency', requestAuthorized: false }), { authorized: false, faults: false, cleaned: false }],
    // A wire skew: the ACQUIRED outcome without the authorization literal. The outcome name
    // alone must never authorize a paid request.
    ['acquired without the authorization literal', (req) => Promise.resolve({ outcome: 'acquired', lease: { leaseId: `r-skew-${req.armIndex}`, armIndex: req.armIndex, expiresAt: 'x', state: 'live' }, requestAuthorized: false } as unknown as RepairLeaseResult), { authorized: false, faults: false, cleaned: false }],
    ['wrong arm', (req) => Promise.resolve({ outcome: 'acquired', lease: { leaseId: 'r-x', armIndex: req.armIndex + 5, expiresAt: 'x', state: 'live' }, requestAuthorized: true }), { authorized: false, faults: true, cleaned: true }],
    ['not live', (req) => Promise.resolve({ outcome: 'acquired', lease: { leaseId: 'r-y', armIndex: req.armIndex, expiresAt: 'x', state: 'expired' }, requestAuthorized: true }), { authorized: false, faults: true, cleaned: true }],
    ['aliases an initial lease', (req) => Promise.resolve({ outcome: 'acquired', lease: { leaseId: 'lease-0', armIndex: req.armIndex, expiresAt: 'x', state: 'live' }, requestAuthorized: true }), { authorized: false, faults: true, cleaned: true }],
  ];
  for (const [label, onRepair, expected] of cases) {
    const { dispatch, store } = await authorize((s) => validAdapters(s, s.booted.cohortId).map);
    store.onRepair = onRepair;
    const lifecycle = createAttemptLifecycle(dispatch);
    if (expected.faults) {
      await assert.rejects(() => lifecycle.acquireRepair(0, 1), LifecycleFaultError, label);
      // The malformed lease is handed straight back.
      assert.equal(releaseIds(store).length, expected.cleaned ? 1 : 0, `${label}: cleanup`);
    } else {
      const r = await lifecycle.acquireRepair(0, 1);
      assert.equal(r.authorized, expected.authorized, label);
      assert.deepEqual(releaseIds(store), [], `${label}: nothing was taken, so nothing is released`);
      await assert.rejects(() => lifecycle.releaseRepair(0, 1), LifecycleFaultError, `${label}: nothing to release`);
    }
  }
});

test('a store throw during acquire is a lifecycle fault and authorizes nothing', async () => {
  const { dispatch, store } = await authorize((s) => validAdapters(s, s.booted.cohortId).map);
  store.onRepair = () => Promise.reject(new Error('store down'));
  const lifecycle = createAttemptLifecycle(dispatch);
  await assert.rejects(() => lifecycle.acquireRepair(0, 1), LifecycleFaultError);
  assert.deepEqual(releaseIds(store), []);
});

// ===========================================================================
// Misuse faults + concurrent-fire isolation
// ===========================================================================

test('unknown arms, repeated releases and unacquired repairs are lifecycle faults', async () => {
  const { dispatch } = await authorize((s) => validAdapters(s, s.booted.cohortId).map);
  const lifecycle = createAttemptLifecycle(dispatch);
  const rosterSize = dispatch.permit.initialLeases.length;

  await assert.rejects(() => lifecycle.releaseInitial(rosterSize + 3), LifecycleFaultError);
  await assert.rejects(() => lifecycle.acquireRepair(rosterSize + 3, 1), LifecycleFaultError);
  await assert.rejects(() => lifecycle.acquireRepair(0, 0), LifecycleFaultError);
  await assert.rejects(() => lifecycle.releaseRepair(0, 1), LifecycleFaultError); // never acquired

  await lifecycle.releaseInitial(0);
  await assert.rejects(() => lifecycle.releaseInitial(0), LifecycleFaultError); // double release

  await lifecycle.acquireRepair(1, 1);
  await assert.rejects(() => lifecycle.acquireRepair(1, 1), LifecycleFaultError); // duplicate acquire
  await lifecycle.releaseRepair(1, 1);
  await assert.rejects(() => lifecycle.releaseRepair(1, 1), LifecycleFaultError); // double release
});

test('two concurrent fires never touch each other lease identities', async () => {
  const a = await authorize((s) => validAdapters(s, s.booted.cohortId).map);
  const b = await authorize((s) => validAdapters(s, s.booted.cohortId).map);
  const lifeA = createAttemptLifecycle(a.dispatch);
  const lifeB = createAttemptLifecycle(b.dispatch);
  await lifeA.releaseInitial(0);
  await lifeB.releaseInitial(1);
  assert.deepEqual(releaseIds(a.store), [a.dispatch.permit.initialLeases.find((l) => l.armIndex === 0)!.leaseId]);
  assert.deepEqual(releaseIds(b.store), [b.dispatch.permit.initialLeases.find((l) => l.armIndex === 1)!.leaseId]);
  // A's release did not appear in B's store and vice versa.
  assert.equal(a.store.calls.length, 1);
  assert.equal(b.store.calls.length, 1);
});

test('a refused or throwing release is a lifecycle fault', async () => {
  for (const onRelease of [
    () => Promise.resolve<ReleaseResult>({ outcome: 'refused', reason: 'not_owner' }),
    () => Promise.reject(new Error('boom')),
  ]) {
    const { dispatch, store } = await authorize((s) => validAdapters(s, s.booted.cohortId).map);
    store.onRelease = onRelease;
    const lifecycle = createAttemptLifecycle(dispatch);
    await assert.rejects(() => lifecycle.releaseInitial(0), LifecycleFaultError);
  }
});

// ===========================================================================
// The canonical authorized dispatch path
// ===========================================================================

test('the authorized path releases every arm initial lease exactly once and produces an envelope', async () => {
  const snapshot0 = sealedSnapshot();
  const cohortId = snapshot0.booted.cohortId;
  const { dispatch, store } = await authorize((s) => validAdapters(s, cohortId).map);
  const env = await runAuthorizedDispatch(dispatch, options(() => NOW_MS, cohortId));

  assert.equal(env.results.length, dispatch.permit.initialLeases.length);
  assert.ok(env.results.every((r) => r.outcome === 'valid'));
  // exactly one release per arm lease, no repair needed
  assert.deepEqual(
    [...releaseIds(store)].sort(),
    dispatch.permit.initialLeases.map((l) => l.leaseId).sort(),
  );
  assert.equal(store.calls.filter((c) => c.op === 'repair').length, 0);
});

test('a skipped arm (missing credential) still releases its initial lease exactly once', async () => {
  const snapshot0 = sealedSnapshot();
  const cohortId = snapshot0.booted.cohortId;
  const { dispatch, store } = await authorize((s) => {
    const map = new Map<string, ProviderAdapter>();
    s.expectedArmIdentities.forEach((id, i) => {
      const script = scriptedAdapter(id, () => validBody(id.participantId, id.requestedModelId, cohortId, s.prepared.requestSha256), { hasCredential: i !== 0 });
      map.set(id.participantId, script.adapter);
    });
    return map;
  });
  const env = await runAuthorizedDispatch(dispatch, options(() => NOW_MS, cohortId));
  assert.equal(env.results.find((r) => r.outcome === 'credential_missing') !== undefined, true);
  assert.deepEqual(
    [...releaseIds(store)].sort(),
    dispatch.permit.initialLeases.map((l) => l.leaseId).sort(),
  );
});

test('a preflight failure after authorization frees every unstarted lease and dispatches nothing', async () => {
  const snapshot0 = sealedSnapshot();
  const cohortId = snapshot0.booted.cohortId;
  const built: Scripted[] = [];
  const { dispatch, store } = await authorize((s) => {
    const r = validAdapters(s, cohortId);
    built.push(...r.scripts);
    return r.map;
  });
  // A cohortId that disagrees with the permit is a synchronous preflight failure.
  await assert.rejects(() => runAuthorizedDispatch(dispatch, options(() => NOW_MS, 'a-different-cohort')));
  assert.deepEqual(
    [...releaseIds(store)].sort(),
    dispatch.permit.initialLeases.map((l) => l.leaseId).sort(),
  );
  assert.equal(built.reduce((n, s) => n + s.calls, 0), 0, 'no adapter was called');
});

test('a raw structural copy of an authorized dispatch is refused by the canonical entry', async () => {
  const snapshot0 = sealedSnapshot();
  const cohortId = snapshot0.booted.cohortId;
  const { dispatch } = await authorize((s) => validAdapters(s, cohortId).map);
  await assert.rejects(() => runAuthorizedDispatch({ ...dispatch }, options(() => NOW_MS, cohortId)));
});

test('a repair acquires, rechecks the cutoff after the acquire, and releases the slot', async () => {
  const snapshot0 = sealedSnapshot();
  const cohortId = snapshot0.booted.cohortId;
  // Arm 0 answers invalidly first, then validly — so it repairs.
  const { dispatch, store } = await authorize((s) => {
    const map = new Map<string, ProviderAdapter>();
    s.expectedArmIdentities.forEach((id, i) => {
      const script = scriptedAdapter(id, (call) =>
        i === 0 && call === 1
          ? wrongEcho(validBody(id.participantId, id.requestedModelId, cohortId, s.prepared.requestSha256))
          : validBody(id.participantId, id.requestedModelId, cohortId, s.prepared.requestSha256),
      );
      map.set(id.participantId, script.adapter);
    });
    return map;
  });
  const env = await runAuthorizedDispatch(dispatch, options(() => NOW_MS, cohortId));
  const repairs = store.calls.filter((c) => c.op === 'repair');
  assert.equal(repairs.length, 1, 'exactly one repair slot was acquired');
  // Its slot was released too: initial leases + the repair lease.
  assert.equal(releaseIds(store).length, dispatch.permit.initialLeases.length + 1);
  assert.ok(releaseIds(store).includes('repair-0-1'));
  assert.ok(env.results.some((r) => r.repairUsed));
});

test('a cutoff that passes while the repair slot is acquired sends no repair and frees the slot', async () => {
  const snapshot0 = sealedSnapshot();
  const cohortId = snapshot0.booted.cohortId;
  let now = NOW_MS;
  const scripts: Scripted[] = [];
  const { dispatch, store } = await authorize((s) => {
    const map = new Map<string, ProviderAdapter>();
    s.expectedArmIdentities.forEach((id, i) => {
      const script = scriptedAdapter(id, (call) =>
        i === 0 && call === 1
          ? wrongEcho(validBody(id.participantId, id.requestedModelId, cohortId, s.prepared.requestSha256))
          : validBody(id.participantId, id.requestedModelId, cohortId, s.prepared.requestSha256),
      );
      scripts.push(script);
      map.set(id.participantId, script.adapter);
    });
    return map;
  });
  // The acquisition itself advances the clock past first pitch.
  store.onRepair = (req) => {
    now = CUTOFF_MS + 1;
    return Promise.resolve({ outcome: 'acquired', lease: { leaseId: `repair-${req.armIndex}-${req.repairOrdinal}`, armIndex: req.armIndex, expiresAt: 'x', state: 'live' }, requestAuthorized: true });
  };
  const env = await runAuthorizedDispatch(dispatch, options(() => now, cohortId));
  const arm0 = env.results.find((r) => r.arm.participantId === dispatch.plan.arms[0]!.participantId)!;
  assert.equal(arm0.outcome, 'cutoff_missed');
  assert.equal(scripts[0]!.calls, 1, 'the repair request was never sent');
  assert.ok(releaseIds(store).includes('repair-0-1'), 'the acquired slot was released');
});
