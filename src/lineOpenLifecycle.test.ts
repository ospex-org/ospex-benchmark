import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cohortBoot } from './cohortBoot.js';
import { evaluateCandidate } from './detection.js';
import { StoreClaimPort } from './lineOpenClaim.js';
import { authorizePreparedDispatch, PreDispatchCleanupError } from './lineOpenDispatch.js';
import type { AuthorizedDispatch } from './lineOpenDispatch.js';
import { AttemptCleanupFaultError, createAttemptLifecycle, LifecycleFaultError } from './lineOpenLifecycle.js';
import { ProviderHttpError, ProviderTimeoutError } from './providers/errors.js';
import { checkPublication } from './manifestPublication.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { MODEL_PRICE_TABLE_DIGEST, MODEL_PRICE_TABLE_VERSION } from './modelPriceTable.js';
import { sealPreparedFire } from './preparedFire.js';
import type { PreparedFireSnapshot } from './preparedFire.js';
import { promptScaffoldSha256 } from './prompt.js';
import { AuthorizedDispatchFaultError, runAuthorizedDispatch } from './runner.js';
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
import { STORE_SCHEMA_VERSION as SCHEMA } from './store/constants.js';
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
    modelPriceTableVersion: MODEL_PRICE_TABLE_VERSION,
    modelPriceTableDigest: MODEL_PRICE_TABLE_DIGEST,
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

function leases(count: number, prefix = ''): Lease[] {
  return Array.from({ length: count }, (_, i) => ({
    leaseId: `${prefix}lease-${i}`,
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
  constructor(private readonly rosterSize: number, private readonly leasePrefix = '') {}

  initCohortBudget(_r: InitCohortBudgetRequest): Promise<InitResult> {
    throw new Error('not used');
  }
  admitDispatch(req: AdmitDispatchRequest): Promise<AdmitResult> {
    return Promise.resolve({
      outcome: 'admitted',
      claimedKeys: MARKETS.map((market) => ({ gameId: req.gameId, market })),
      preparedBytesDigest: req.scopeReservations['moneyline+total']!.preparedBytesDigest,
      initialLeases: leases(this.rosterSize, this.leasePrefix),
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
  leasePrefix = '',
): Promise<{ dispatch: AuthorizedDispatch; store: ScriptedStore; snapshot: PreparedFireSnapshot }> {
  const snapshot = sealedSnapshot();
  const store = new ScriptedStore(snapshot.expectedArmIdentities.length, leasePrefix);
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
    ['acquired without the authorization literal', (req) => Promise.resolve({ outcome: 'acquired', lease: { leaseId: `r-skew-${req.armIndex}`, armIndex: req.armIndex, expiresAt: 'x', state: 'live' }, requestAuthorized: false } as unknown as RepairLeaseResult), { authorized: false, faults: true, cleaned: true }],
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
  // DISTINCT lease ids per fire: with identical ids, a shared (module-global) arm map would
  // resolve one fire's arm to the other's lease object and still look correct.
  const a = await authorize((s) => validAdapters(s, s.booted.cohortId).map, 'A-');
  const b = await authorize((s) => validAdapters(s, s.booted.cohortId).map, 'B-');
  const lifeA = createAttemptLifecycle(a.dispatch);
  const lifeB = createAttemptLifecycle(b.dispatch);
  await lifeA.releaseInitial(0);
  await lifeB.releaseInitial(1);
  assert.deepEqual(releaseIds(a.store), [a.dispatch.permit.initialLeases.find((l) => l.armIndex === 0)!.leaseId]);
  assert.deepEqual(releaseIds(b.store), [b.dispatch.permit.initialLeases.find((l) => l.armIndex === 1)!.leaseId]);
  // A's release did not appear in B's store and vice versa …
  assert.equal(a.store.calls.length, 1);
  assert.equal(b.store.calls.length, 1);
  // … and neither fire released an id belonging to the other's lease set.
  const aIds = new Set(a.dispatch.permit.initialLeases.map((l) => l.leaseId));
  const bIds = new Set(b.dispatch.permit.initialLeases.map((l) => l.leaseId));
  assert.ok(releaseIds(b.store).every((id) => !aIds.has(id)), "B released one of A's leases");
  assert.ok(releaseIds(a.store).every((id) => !bIds.has(id)), "A released one of B's leases");
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

// ===========================================================================
// The complete ORDERED lifecycle log — a count alone cannot see a double-held slot
// ===========================================================================

/** This fire's ordered lifecycle operations for ONE arm (siblings are filtered out, so
 *  concurrent arms cannot make the sequence nondeterministic). */
function armLog(store: ScriptedStore, initialLeaseId: string, armIndex: number): string[] {
  return store.calls
    .filter((c) =>
      c.op === 'release'
        ? c.leaseId === initialLeaseId || c.leaseId === `repair-${armIndex}-1`
        : c.req.armIndex === armIndex,
    )
    .map((c) =>
      c.op === 'repair' ? 'acquireRepair' : c.leaseId === initialLeaseId ? 'releaseInitial' : 'releaseRepair',
    );
}

/** A roster whose arm 0 answers invalidly first (so it repairs) and validly on retry. */
function repairingAdapters(s: PreparedFireSnapshot, cohortId: string): Map<string, ProviderAdapter> {
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
}

test('an authorized repair drives releaseInitial then acquireRepair then releaseRepair, never holding both', async () => {
  const cohortId = sealedSnapshot().booted.cohortId;
  const { dispatch, store } = await authorize((s) => repairingAdapters(s, cohortId));
  await runAuthorizedDispatch(dispatch, options(() => NOW_MS, cohortId));
  const arm0Lease = dispatch.permit.initialLeases.find((l) => l.armIndex === 0)!.leaseId;
  // The initial slot is freed BEFORE the repair slot is taken: the two are never held at once.
  assert.deepEqual(armLog(store, arm0Lease, 0), ['releaseInitial', 'acquireRepair', 'releaseRepair']);
});

test('a denied repair ends the arm log at the acquire — nothing is released for a slot never taken', async () => {
  const cohortId = sealedSnapshot().booted.cohortId;
  const { dispatch, store } = await authorize((s) => repairingAdapters(s, cohortId));
  store.onRepair = () => Promise.resolve({ outcome: 'refused', reason: 'concurrency', requestAuthorized: false });
  await runAuthorizedDispatch(dispatch, options(() => NOW_MS, cohortId));
  const arm0Lease = dispatch.permit.initialLeases.find((l) => l.armIndex === 0)!.leaseId;
  assert.deepEqual(armLog(store, arm0Lease, 0), ['releaseInitial', 'acquireRepair']);
});

// ===========================================================================
// All-settled containment: one arm's fault must not let the run return early
// ===========================================================================

test('a lifecycle fault in one arm waits for every sibling to settle and release', async () => {
  const cohortId = sealedSnapshot().booted.cohortId;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let slowFinished = false;
  const { dispatch, store } = await authorize((s) => {
    const map = new Map<string, ProviderAdapter>();
    s.expectedArmIdentities.forEach((id, i) => {
      const script = scriptedAdapter(id, async () => {
        if (i === 1) {
          await gate; // arm 1 is held in flight
          slowFinished = true;
        }
        return validBody(id.participantId, id.requestedModelId, cohortId, s.prepared.requestSha256);
      });
      map.set(id.participantId, script.adapter);
    });
    return map;
  });
  // Arm 0's initial release fails — a lifecycle fault raised while arm 1 is still in flight.
  const arm0Lease = dispatch.permit.initialLeases.find((l) => l.armIndex === 0)!.leaseId;
  const arm1Lease = dispatch.permit.initialLeases.find((l) => l.armIndex === 1)!.leaseId;
  store.onRelease = (req): Promise<ReleaseResult> =>
    req.leaseId === arm0Lease
      ? Promise.resolve({ outcome: 'refused', reason: 'not_owner' })
      : Promise.resolve({ outcome: 'released' });

  let settled = false;
  const run = runAuthorizedDispatch(dispatch, options(() => NOW_MS, cohortId)).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  // Give the fault every chance to propagate early.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false, 'the run must not settle while a sibling request is still in flight');
  assert.equal(slowFinished, false);

  openGate();
  await run;
  assert.equal(settled, true);
  assert.equal(slowFinished, true, 'the slow sibling ran to completion');
  assert.ok(releaseIds(store).includes(arm1Lease), 'the sibling released its own slot');
});

// ===========================================================================
// The initial-release exit matrix
// ===========================================================================

test('every no-repair exit releases the arm initial lease exactly once', async () => {
  const cohortId = sealedSnapshot().booted.cohortId;
  const exits: Array<[string, (id: { participantId: string; provider: string; requestedModelId: string }) => ProviderAdapter]> = [
    [
      'hasCredential throws',
      (id) => ({
        ...scriptedAdapter(id, () => '').adapter,
        hasCredential: (): boolean => {
          throw new Error('credential probe blew up');
        },
      }),
    ],
    ['provider timeout', (id) => scriptedAdapter(id, () => Promise.reject(new ProviderTimeoutError(id.provider as ProviderName, 1))).adapter],
    ['rate limited', (id) => scriptedAdapter(id, () => Promise.reject(new ProviderHttpError(id.provider as ProviderName, 429, 'rate limited'))).adapter],
    ['generic provider throw', (id) => scriptedAdapter(id, () => Promise.reject(new Error('provider exploded'))).adapter],
    ['unparseable body', (id) => scriptedAdapter(id, () => 'not json at all').adapter],
  ];
  for (const [label, build] of exits) {
    const { dispatch, store } = await authorize((s) => {
      const map = new Map<string, ProviderAdapter>();
      s.expectedArmIdentities.forEach((id, i) => {
        map.set(
          id.participantId,
          i === 0
            ? build(id)
            : scriptedAdapter(id, () => validBody(id.participantId, id.requestedModelId, cohortId, s.prepared.requestSha256)).adapter,
        );
      });
      return map;
    });
    const arm0Lease = dispatch.permit.initialLeases.find((l) => l.armIndex === 0)!.leaseId;
    // A throwing hasCredential propagates as an arm failure; the rest resolve to outcomes.
    await runAuthorizedDispatch(dispatch, options(() => NOW_MS, cohortId)).catch(() => undefined);
    assert.deepEqual(
      releaseIds(store).filter((id) => id === arm0Lease),
      [arm0Lease],
      `${label}: exactly one release of the arm's initial lease`,
    );
  }
});

// ===========================================================================
// Failure convergence: once a lease exists, no failure may erase cleanup truth
// ===========================================================================

/** Run one authorized dispatch and return what it threw (or `null` when it resolved). */
async function faultOf(dispatch: AuthorizedDispatch, opts: SlateRunOptions): Promise<unknown> {
  return runAuthorizedDispatch(dispatch, opts).then(
    () => null,
    (error: unknown) => error,
  );
}

test('a clock that throws at the post-acquire recheck still frees the acquired repair slot', async () => {
  const cohortId = sealedSnapshot().booted.cohortId;
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
  // The clock starts throwing the instant the repair slot is taken — so it throws at the
  // post-acquire cutoff recheck, the very next clock read on that arm. The slot is already
  // held, so it must come back regardless.
  let acquired = false;
  const acquire = store.onRepair;
  store.onRepair = (req): Promise<RepairLeaseResult> => {
    acquired = true;
    return acquire(req);
  };
  const nowMs = (): number => {
    if (acquired) throw new Error('post-acquire clock exploded');
    return NOW_MS;
  };

  const fault = await faultOf(dispatch, options(nowMs, cohortId));
  assert.ok(fault instanceof AuthorizedDispatchFaultError, 'the clock failure is reported');
  assert.ok(
    fault.failures.some((f) => f instanceof Error && /post-acquire clock exploded/.test(f.message)),
    'the clock error itself stays observable',
  );
  assert.equal(store.calls.filter((c) => c.op === 'repair').length, 1, 'one repair slot was acquired');
  assert.deepEqual(
    releaseIds(store).filter((id) => id === 'repair-0-1'),
    ['repair-0-1'],
    'the acquired repair slot was released exactly once',
  );
  assert.equal(scripts[0]!.calls, 1, 'no repair request was sent');
});

/** A roster where ONLY arm 0 holds a credential, so it is the sole reader of the injected
 *  clock — the siblings return before the first clock read. Arm 0 answers invalidly first, so
 *  it repairs. */
function soloClockReaderAdapters(s: PreparedFireSnapshot, cohortId: string): Map<string, ProviderAdapter> {
  const map = new Map<string, ProviderAdapter>();
  s.expectedArmIdentities.forEach((id, i) => {
    const script = scriptedAdapter(
      id,
      (call) =>
        call === 1
          ? wrongEcho(validBody(id.participantId, id.requestedModelId, cohortId, s.prepared.requestSha256))
          : validBody(id.participantId, id.requestedModelId, cohortId, s.prepared.requestSha256),
      { hasCredential: i === 0 },
    );
    map.set(id.participantId, script.adapter);
  });
  return map;
}

test('a clock throw whose repair-slot cleanup ALSO fails reports both causes', async () => {
  const cohortId = sealedSnapshot().booted.cohortId;
  const { dispatch, store } = await authorize((s) => soloClockReaderAdapters(s, cohortId));
  let acquired = false;
  const acquire = store.onRepair;
  store.onRepair = (req): Promise<RepairLeaseResult> => {
    acquired = true;
    return acquire(req);
  };
  // The clock throws at the post-acquire recheck AND the slot refuses to come back. Freeing the
  // slot must not annihilate the cause that actually broke the attempt: a `finally` whose own
  // release throws would replace it, leaving an operator chasing the store while the real fault
  // is a broken clock that will keep killing every later fire.
  store.onRelease = (req): Promise<ReleaseResult> =>
    req.leaseId === 'repair-0-1'
      ? Promise.resolve({ outcome: 'refused', reason: 'not_owner' })
      : Promise.resolve({ outcome: 'released' });
  const nowMs = (): number => {
    if (acquired) throw new Error('post-acquire clock exploded');
    return NOW_MS;
  };

  const fault = await faultOf(dispatch, options(nowMs, cohortId));
  assert.ok(fault instanceof AuthorizedDispatchFaultError, 'the arm failure is reported');
  const composite = fault.failures.find((f): f is AttemptCleanupFaultError => f instanceof AttemptCleanupFaultError);
  assert.ok(composite, 'a failing repair release must not replace the failure already propagating');
  assert.ok(
    composite.primary instanceof Error && /post-acquire clock exploded/.test(composite.primary.message),
    'the clock cause is retained',
  );
  assert.ok(composite.cleanup instanceof LifecycleFaultError, 'the repair cleanup fault is retained');
  assert.deepEqual(
    releaseIds(store).filter((id) => id === 'repair-0-1'),
    ['repair-0-1'],
    'the slot was handed back exactly once, never retried',
  );
});

test('a pre-call failure whose lease cleanup ALSO fails reports both causes', async () => {
  const cohortId = sealedSnapshot().booted.cohortId;
  const { dispatch, store } = await authorize((s) => {
    const map = new Map<string, ProviderAdapter>();
    s.expectedArmIdentities.forEach((id, i) => {
      map.set(
        id.participantId,
        i === 0
          ? {
              ...scriptedAdapter(id, () => '').adapter,
              hasCredential: (): boolean => {
                throw new Error('credential probe exploded');
              },
            }
          : scriptedAdapter(id, () => validBody(id.participantId, id.requestedModelId, cohortId, s.prepared.requestSha256)).adapter,
      );
    });
    return map;
  });
  const arm0Lease = dispatch.permit.initialLeases.find((l) => l.armIndex === 0)!.leaseId;
  // Only arm 0's slot refuses to come back: its primary failure would otherwise hide the fact
  // that this fire is still holding durable capacity.
  store.onRelease = (req): Promise<ReleaseResult> =>
    req.leaseId === arm0Lease
      ? Promise.resolve({ outcome: 'refused', reason: 'not_owner' })
      : Promise.resolve({ outcome: 'released' });

  const fault = await faultOf(dispatch, options(() => NOW_MS, cohortId));
  assert.ok(fault instanceof AuthorizedDispatchFaultError, 'the arm failure is reported');
  const composite = fault.failures.find((f): f is AttemptCleanupFaultError => f instanceof AttemptCleanupFaultError);
  assert.ok(composite, 'the cleanup fault must not be discarded in favour of the primary');
  assert.ok(
    composite.primary instanceof Error && /credential probe exploded/.test(composite.primary.message),
    'the primary pre-call failure is retained',
  );
  assert.ok(composite.cleanup instanceof LifecycleFaultError, 'the lifecycle cleanup fault is retained');
  assert.deepEqual(
    releaseIds(store).filter((id) => id === arm0Lease),
    [arm0Lease],
    'exactly one release attempt — a local release is never retried',
  );
});

test('a partly-failing pre-launch cleanup exposes the COMPLETE attempt log, failures being its subset', async () => {
  const cohortId = sealedSnapshot().booted.cohortId;
  const built: Scripted[] = [];
  const { dispatch, store } = await authorize((s) => {
    const r = validAdapters(s, cohortId);
    built.push(...r.scripts);
    return r.map;
  });
  const ids = dispatch.permit.initialLeases.map((l) => l.leaseId);
  assert.ok(ids.length >= 4, 'fixture: the roster must be large enough for a MIXED cleanup');
  // Two leases come back, one refuses, one throws — the case a uniformly-failing store hides,
  // because there `failures` and the complete attempt log are the same array.
  store.onRelease = (req): Promise<ReleaseResult> =>
    req.leaseId === ids[1]
      ? Promise.resolve({ outcome: 'refused', reason: 'not_owner' })
      : req.leaseId === ids[2]
        ? Promise.reject(new Error('store down'))
        : Promise.resolve({ outcome: 'released' });

  await assert.rejects(
    () => runAuthorizedDispatch(dispatch, options(() => NOW_MS, 'a-different-cohort')),
    (error) => {
      assert.ok(error instanceof PreDispatchCleanupError, 'the cleanup failure is reported');
      assert.deepEqual(error.attempts.map((a) => a.leaseId), ids, 'every lease was attempted, in permit order');
      assert.deepEqual(
        error.attempts.map((a) => a.result),
        ids.map((_, i) => (i === 1 ? 'not_owner' : i === 2 ? 'threw' : 'released')),
        'each attempt records its own outcome',
      );
      assert.deepEqual(
        error.failures.map((a) => a.leaseId),
        [ids[1], ids[2]],
        'the still-held leases are exactly the non-released attempts',
      );
      return true;
    },
  );
  assert.equal(built.reduce((n, s) => n + s.calls, 0), 0, 'no adapter was called');
});

test('every arm failure is reported, not only the first', async () => {
  const cohortId = sealedSnapshot().booted.cohortId;
  const { dispatch, store } = await authorize((s) => validAdapters(s, cohortId).map);
  const initial = dispatch.permit.initialLeases;
  const refusing = new Set(
    [0, 1].map((armIndex) => initial.find((l) => l.armIndex === armIndex)!.leaseId),
  );
  assert.equal(refusing.size, 2, 'fixture: two DISTINCT arms must fail');
  store.onRelease = (req): Promise<ReleaseResult> =>
    refusing.has(req.leaseId)
      ? Promise.resolve({ outcome: 'refused', reason: 'not_owner' })
      : Promise.resolve({ outcome: 'released' });

  const fault = await faultOf(dispatch, options(() => NOW_MS, cohortId));
  assert.ok(fault instanceof AuthorizedDispatchFaultError, 'the failures are aggregated, not collapsed');
  assert.equal(fault.failures.length, 2, 'a second held-lease fault must not be discarded');
  assert.ok(
    fault.failures.every((f) => f instanceof LifecycleFaultError),
    'each retained cause is the arm lifecycle fault itself',
  );
  // Every arm still settled and attempted its own release before the run reported.
  assert.deepEqual([...releaseIds(store)].sort(), initial.map((l) => l.leaseId).sort());
});

test('a pre-launch cleanup failure is reported with the preflight cause and the held leases', async () => {
  const cohortId = sealedSnapshot().booted.cohortId;
  const { dispatch, store } = await authorize((s) => validAdapters(s, cohortId).map);
  store.onRelease = () => Promise.resolve({ outcome: 'refused', reason: 'not_owner' });
  // A cohort that disagrees with the permit fails preflight; every release then refuses.
  await assert.rejects(
    () => runAuthorizedDispatch(dispatch, options(() => NOW_MS, 'a-different-cohort')),
    (error) => {
      assert.ok(error instanceof PreDispatchCleanupError, 'the cleanup failure must not be swallowed');
      assert.ok(/does not equal the authorized cohort/.test(error.primary.message), 'the preflight cause is retained');
      assert.deepEqual(
        error.failures.map((f) => f.leaseId).sort(),
        dispatch.permit.initialLeases.map((l) => l.leaseId).sort(),
        'every still-held lease is named',
      );
      return true;
    },
  );
});
