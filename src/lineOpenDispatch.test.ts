import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cohortBoot } from './cohortBoot.js';
import { evaluateCandidate } from './detection.js';
import { StoreClaimPort } from './lineOpenClaim.js';
import type { ClaimOutcome, ClaimPort, DispatchPermit } from './lineOpenClaim.js';
import {
  assertAuthorizedDispatch,
  assertDispatchPlan,
  authorizePreparedDispatch,
  buildDispatchPlan,
  DispatchAuthorizationError,
  PreDispatchCleanupError,
} from './lineOpenDispatch.js';
import type { AuthorizedDispatch, DispatchPlan, DispatchRefusalReason } from './lineOpenDispatch.js';
import { checkPublication } from './manifestPublication.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { MODEL_PRICE_TABLE_DIGEST, MODEL_PRICE_TABLE_VERSION } from './modelPriceTable.js';
import { sealPreparedFire } from './preparedFire.js';
import type { PreparedFireSnapshot } from './preparedFire.js';
import { promptScaffoldSha256 } from './prompt.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import type {
  AcquireRepairLeaseRequest,
  AdmitAdmittedResult,
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
import type { CandidateInput } from './detection.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { ChatTurn, GameBundle, MarketKey, ProviderAdapter, ProviderName, ProviderResponse } from './types.js';

/**
 * The pre-dispatch authorization boundary: plan capture before the claim, request/snapshot
 * coherence, the post-admission authority bind, and complete pre-dispatch lease cleanup.
 * Every test drives a genuine `sealPreparedFire` snapshot, genuine permits minted through
 * `StoreClaimPort` from a scripted `AtomicStore`, and synthetic adapters — no provider,
 * database, or live path is contacted, and no adapter method is ever invoked by the code
 * under test.
 */

const GAME_ID = '00000000-0000-4000-8000-0000000000f1';
const CUTOFF = '2026-07-18T20:00:00+00:00';
const WINDOW_START = '2026-07-18T00:00:00.000Z';
const WINDOW_END = '2026-07-19T00:00:00.000Z';
const BUNDLE_TS = '2026-07-18T12:00:00.000Z';
const DETECTED_AT = '2026-07-18T12:00:30.000Z';
const OPENER_AT = '2026-07-18T11:59:30.000Z';
const OBSERVED_AT = '2026-07-18T11:58:00+00:00';
const BUNDLE_BUILT_AT = '2026-07-18T12:00:31.000Z';
const COMMITTER_TS = '2026-07-17T23:00:00+00:00';
const SLATE_DATE = '2026-07-18';
const W = 120_000;
const SKEW = 5_000;
const OWNER = 'owner-host-1234-abc';
import { STORE_SCHEMA_VERSION as SCHEMA } from './store/constants.js';
const MARKETS: readonly MarketKey[] = ['moneyline', 'total'];

const CODE_ARMS = defaultExpectedArms();

// --- snapshot fixture -------------------------------------------------------

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
  });
}

function scopedGame(markets: readonly MarketKey[]): GameBundle {
  const m: GameBundle['markets'] = {};
  if (markets.includes('moneyline')) {
    m.moneyline = { awayDecimal: 1.74627, homeDecimal: 2.17, observedAt: OBSERVED_AT, evidenceRef: `ev:${GAME_ID}:moneyline` };
  }
  if (markets.includes('total')) {
    m.total = { line: 8.5, overDecimal: 1.90909, underDecimal: 1.90909, observedAt: OBSERVED_AT, evidenceRef: `ev:${GAME_ID}:total` };
  }
  return {
    gameId: GAME_ID,
    league: 'mlb',
    scheduledStartUtc: CUTOFF,
    awayTeam: 'Milwaukee Brewers',
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: m,
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

function sealedSnapshot(markets: readonly MarketKey[] = MARKETS): PreparedFireSnapshot {
  const json = manifestJson();
  const bytes = new TextEncoder().encode(json);
  return sealPreparedFire({
    game: scopedGame(markets),
    slug: 'mil-pit-2026-07-18',
    slateDate: SLATE_DATE,
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
      candidateInput: candidateInput(m),
      verdict: evaluateCandidate(candidateInput(m)),
      historyRows: [historyRow(m)],
      historyWatermark: null,
    })),
  });
}

// --- synthetic adapters -----------------------------------------------------

interface SyntheticAdapter extends ProviderAdapter {
  counts: { hasCredential: number; chat: number };
}

function syntheticAdapter(identity: { participantId: string; provider: string; requestedModelId: string }): SyntheticAdapter {
  const counts = { hasCredential: 0, chat: 0 };
  return {
    provider: identity.provider as ProviderName,
    requestedModelId: identity.requestedModelId,
    credentialEnvVar: `${identity.participantId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_KEY`,
    counts,
    hasCredential(): boolean {
      counts.hasCredential += 1;
      return true;
    },
    chat(_turns: ChatTurn[], _timeoutMs: number): Promise<ProviderResponse> {
      counts.chat += 1;
      throw new Error('synthetic adapter: no provider call is expected in this slice');
    },
  };
}

function adapterMap(snapshot: PreparedFireSnapshot): Map<string, SyntheticAdapter> {
  const map = new Map<string, SyntheticAdapter>();
  for (const identity of snapshot.expectedArmIdentities) map.set(identity.participantId, syntheticAdapter(identity));
  return map;
}

function totalFacadeCalls(map: Map<string, SyntheticAdapter>): number {
  let total = 0;
  for (const a of map.values()) total += a.counts.hasCredential + a.counts.chat;
  return total;
}

// --- scripted store + ports -------------------------------------------------

function leases(count: number): Lease[] {
  return Array.from({ length: count }, (_, i) => ({
    leaseId: `lease-${i}`,
    armIndex: i,
    expiresAt: '2026-07-18T12:10:00.000Z',
    state: 'live' as const,
  }));
}

class ScriptedStore implements AtomicStore {
  readonly admitCalls: AdmitDispatchRequest[] = [];
  readonly releaseCalls: ReleaseLeaseRequest[] = [];
  onAdmit: (req: AdmitDispatchRequest) => Promise<AdmitResult> = () => {
    throw new Error('onAdmit not scripted');
  };
  onRelease: (req: ReleaseLeaseRequest) => Promise<ReleaseResult> = () => Promise.resolve({ outcome: 'released' });

  initCohortBudget(_r: InitCohortBudgetRequest): Promise<InitResult> {
    throw new Error('not used');
  }
  admitDispatch(req: AdmitDispatchRequest): Promise<AdmitResult> {
    this.admitCalls.push(req);
    return this.onAdmit(req);
  }
  acquireRepairLease(_r: AcquireRepairLeaseRequest): Promise<RepairLeaseResult> {
    throw new Error('not used in this slice');
  }
  releaseLease(req: ReleaseLeaseRequest): Promise<ReleaseResult> {
    this.releaseCalls.push(req);
    return this.onRelease(req);
  }
  completeClaim(_r: CompleteClaimRequest): Promise<CompleteResult> {
    throw new Error('not used');
  }
}

/** A claim port that records admissions and returns a pre-minted genuine outcome. */
class PreMintedClaimPort implements ClaimPort {
  readonly calls: AdmitDispatchRequest[] = [];
  constructor(private readonly outcome: ClaimOutcome) {}
  admit(req: AdmitDispatchRequest): Promise<ClaimOutcome> {
    this.calls.push(req);
    return Promise.resolve(this.outcome);
  }
}

function admitted(over: Partial<AdmitAdmittedResult> = {}, snapshot?: PreparedFireSnapshot): AdmitAdmittedResult {
  const snap = snapshot ?? sealedSnapshot();
  return {
    outcome: 'admitted',
    claimedKeys: MARKETS.map((market) => ({ gameId: GAME_ID, market })),
    preparedBytesDigest: snap.prepared.requestSha256,
    initialLeases: leases(snap.expectedArmIdentities.length),
    dispatchAuthorized: true,
    ...over,
  };
}

function request(snapshot: PreparedFireSnapshot, over: Partial<AdmitDispatchRequest> = {}): AdmitDispatchRequest {
  return {
    cohortId: snapshot.booted.cohortId,
    fireId: snapshot.fireId,
    ownerId: OWNER,
    expectedSchemaVersion: SCHEMA,
    gameId: snapshot.prepared.gameId,
    proposedMarkets: [...snapshot.proposedMarkets],
    scopeReservations: {
      'moneyline+total': { spendReservationUsdMicros: 1000, preparedBytesDigest: snapshot.prepared.requestSha256 },
    },
    ...over,
  };
}

/** Mint a GENUINE permit through the real claim port from a scripted admitted result. */
async function mintPermit(
  store: ScriptedStore,
  req: AdmitDispatchRequest,
  result: AdmitAdmittedResult,
): Promise<{ permit: DispatchPermit; outcome: ClaimOutcome }> {
  store.onAdmit = () => Promise.resolve(result);
  const outcome = await new StoreClaimPort(store).admit(req);
  if (outcome.kind !== 'Authorized') throw new Error('fixture: expected an authorized mint');
  return { permit: outcome.permit, outcome };
}

/** Authorize with a genuine snapshot/adapters and a pre-minted outcome. */
async function authorizeWith(opts: {
  snapshot: PreparedFireSnapshot;
  adapters: Map<string, SyntheticAdapter>;
  request: AdmitDispatchRequest;
  outcome: ClaimOutcome;
}) {
  return authorizePreparedDispatch({
    snapshot: opts.snapshot,
    adapters: opts.adapters,
    request: opts.request,
    claimPort: new PreMintedClaimPort(opts.outcome),
  });
}

// ===========================================================================
// Plan completeness BEFORE the claim
// ===========================================================================

test('an incomplete or mismatched roster refuses before any claim is taken', async () => {
  const cases: Array<[string, (m: Map<string, SyntheticAdapter>, s: PreparedFireSnapshot) => void, DispatchRefusalReason]> = [
    ['missing participant', (m, s) => m.delete(s.expectedArmIdentities[0]!.participantId), 'plan_missing_participant'],
    ['unexpected participant', (m) => m.set('stranger', syntheticAdapter({ participantId: 'stranger', provider: 'openai', requestedModelId: 'x' })), 'plan_unexpected_participant'],
    [
      'provider mismatch',
      (m, s) => {
        const id = s.expectedArmIdentities[0]!;
        m.set(id.participantId, syntheticAdapter({ ...id, provider: 'google' }));
      },
      'plan_identity_mismatch',
    ],
    [
      'requested-model mismatch',
      (m, s) => {
        const id = s.expectedArmIdentities[0]!;
        m.set(id.participantId, syntheticAdapter({ ...id, requestedModelId: 'other-model' }));
      },
      'plan_identity_mismatch',
    ],
    [
      'non-callable hasCredential',
      (m, s) => {
        const id = s.expectedArmIdentities[0]!;
        const bad = syntheticAdapter(id) as unknown as { hasCredential: unknown };
        bad.hasCredential = 'nope';
        m.set(id.participantId, bad as unknown as SyntheticAdapter);
      },
      'plan_method_not_callable',
    ],
    [
      'non-callable chat',
      (m, s) => {
        const id = s.expectedArmIdentities[0]!;
        const bad = syntheticAdapter(id) as unknown as { chat: unknown };
        bad.chat = null;
        m.set(id.participantId, bad as unknown as SyntheticAdapter);
      },
      'plan_method_not_callable',
    ],
  ];
  for (const [label, mutate, reason] of cases) {
    const snapshot = sealedSnapshot();
    const adapters = adapterMap(snapshot);
    mutate(adapters, snapshot);
    const port = new PreMintedClaimPort({ kind: 'WouldAdmit' });
    await assert.rejects(
      () => authorizePreparedDispatch({ snapshot, adapters, request: request(snapshot), claimPort: port }),
      (e) => e instanceof DispatchAuthorizationError && e.reason === reason,
      label,
    );
    assert.deepEqual(port.calls, [], `${label}: no claim may be taken`);
    assert.equal(totalFacadeCalls(adapters), 0, `${label}: no adapter may be called`);
  }
});

test('a forged snapshot is rejected before any claim is taken', async () => {
  const snapshot = sealedSnapshot();
  const forged = { ...snapshot } as PreparedFireSnapshot;
  const adapters = adapterMap(snapshot);
  const port = new PreMintedClaimPort({ kind: 'WouldAdmit' });
  await assert.rejects(() => authorizePreparedDispatch({ snapshot: forged, adapters, request: request(snapshot), claimPort: port }));
  assert.deepEqual(port.calls, []);
  assert.equal(totalFacadeCalls(adapters), 0);
});

// ===========================================================================
// Facade capture
// ===========================================================================

test('the captured facades survive every later mutation of the caller map and adapters', async () => {
  const snapshot = sealedSnapshot();
  const adapters = adapterMap(snapshot);
  const first = snapshot.expectedArmIdentities[0]!;
  const original = adapters.get(first.participantId)!;

  const plan = buildDispatchPlan(snapshot, adapters);

  // Mutate the caller's map and adapter objects after capture.
  const replacement = syntheticAdapter(first);
  adapters.set(first.participantId, replacement);
  adapters.delete(snapshot.expectedArmIdentities[1]!.participantId);
  const rewritten = { hasCredential: 0, chat: 0 };
  (original as unknown as { hasCredential: () => boolean }).hasCredential = () => {
    rewritten.hasCredential += 1;
    return false;
  };
  (original as unknown as { chat: () => Promise<ProviderResponse> }).chat = () => {
    rewritten.chat += 1;
    return Promise.reject(new Error('rewritten'));
  };
  (original as unknown as { requestedModelId: string }).requestedModelId = 'tampered-model';
  adapters.clear();

  // The plan still names the authenticated identity captured at build time.
  assert.equal(plan.arms[0]!.participantId, first.participantId);
  assert.equal(plan.arms[0]!.requestedModelId, first.requestedModelId);
  assert.equal(plan.arms.length, snapshot.expectedArmIdentities.length);

  // Invoking the captured facade runs the ORIGINAL bound methods, not the rewrites.
  assert.equal(plan.arms[0]!.hasCredential(), true);
  assert.equal(original.counts.hasCredential, 1);
  assert.equal(rewritten.hasCredential, 0);
  assert.equal(replacement.counts.hasCredential, 0);
  assert.throws(() => plan.arms[0]!.chat([], 1));
  assert.equal(original.counts.chat, 1);
  assert.equal(rewritten.chat, 0);
});

test('the plan captured before the claim is the plan authorized — the caller map is never re-read after admission', async () => {
  const snapshot = sealedSnapshot();
  const adapters = adapterMap(snapshot);
  const first = snapshot.expectedArmIdentities[0]!;
  const original = adapters.get(first.participantId)!;
  const replacement = syntheticAdapter(first);

  // Hold the admission open, then mutate the caller's map + adapters while it is in flight.
  const store = new ScriptedStore();
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  store.onAdmit = async () => {
    await gate;
    return admitted({}, snapshot);
  };
  const pending = authorizePreparedDispatch({
    snapshot,
    adapters,
    request: request(snapshot),
    claimPort: new StoreClaimPort(store),
  });
  adapters.set(first.participantId, replacement); // swap the entry mid-admission
  const rewritten = { hasCredential: 0, chat: 0 };
  (original as unknown as { hasCredential: () => boolean }).hasCredential = () => {
    rewritten.hasCredential += 1;
    return false;
  };
  (original as unknown as { requestedModelId: string }).requestedModelId = 'tampered-model';
  openGate();

  const result = await pending;
  assert.equal(result.kind, 'Authorized');
  if (result.kind !== 'Authorized') return;
  // The authorized plan is the one captured BEFORE the claim: authenticated identity …
  assert.equal(result.dispatch.plan.arms[0]!.participantId, first.participantId);
  assert.equal(result.dispatch.plan.arms[0]!.requestedModelId, first.requestedModelId);
  // … and the originally bound methods, not the swapped-in adapter's and not the rewrites.
  assert.equal(result.dispatch.plan.arms[0]!.hasCredential(), true);
  assert.equal(original.counts.hasCredential, 1);
  assert.equal(replacement.counts.hasCredential, 0);
  assert.equal(rewritten.hasCredential, 0);
});

// ===========================================================================
// Crossed admissions
// ===========================================================================

/** Mint two independent genuine admissions, A and B, each on its own scripted store. */
async function twoAdmissions(snapshot: PreparedFireSnapshot, overA: Partial<AdmitAdmittedResult> = {}) {
  const storeA = new ScriptedStore();
  const storeB = new ScriptedStore();
  const { outcome: a } = await mintPermit(storeA, request(snapshot), admitted(overA, snapshot));
  const { outcome: b } = await mintPermit(storeB, request(snapshot, { ownerId: 'owner-B' }), admitted({}, snapshot));
  if (a.kind !== 'Authorized' || b.kind !== 'Authorized') throw new Error('fixture: expected two authorized mints');
  storeA.releaseCalls.length = 0;
  storeB.releaseCalls.length = 0;
  return { storeA, storeB, a, b };
}

test('the operational lease authority is resolved from the permit, and a foreign one is refused but still cleaned', async () => {
  const snapshot = sealedSnapshot();

  // (1) permit A + authority A → authorized, nothing released.
  {
    const { storeA, a } = await twoAdmissions(snapshot);
    const adapters = adapterMap(snapshot);
    const result = await authorizeWith({ snapshot, adapters, request: request(snapshot), outcome: a });
    assert.equal(result.kind, 'Authorized');
    if (result.kind !== 'Authorized') return;
    // The carried authority is the one mapped to the permit, not merely the supplied property.
    assert.strictEqual(result.dispatch.leaseAuthority, a.leaseAuthority);
    assert.deepEqual(storeA.releaseCalls, []);
  }

  // (2) permit A + a GENUINE authority from another admission, and (3) a forged/missing one.
  //     Each is a typed refusal that cleans A's leases through A's OWN authority, and the
  //     foreign value is never called.
  const foreignCases: Array<[string, (b: ClaimOutcome) => unknown]> = [
    ['another admission authority', (b) => (b as { leaseAuthority?: unknown }).leaseAuthority],
    ['forged authority', () => ({ releaseLease: () => Promise.resolve({ outcome: 'released' }), acquireRepairLease: () => Promise.reject(new Error('x')) })],
    ['missing authority', () => undefined],
  ];
  for (const [label, pick] of foreignCases) {
    const { storeA, storeB, a, b } = await twoAdmissions(snapshot);
    const permitA = a.permit;
    const crossed = { kind: 'Authorized', permit: permitA, leaseAuthority: pick(b) } as unknown as ClaimOutcome;
    const adapters = adapterMap(snapshot);
    await assert.rejects(
      () => authorizeWith({ snapshot, adapters, request: request(snapshot), outcome: crossed }),
      (e) => e instanceof DispatchAuthorizationError && e.reason === 'lease_authority_mismatch',
      label,
    );
    // Every distinct lease of permit A is released once, under A's own owner …
    assert.deepEqual(
      storeA.releaseCalls.map((r) => r.leaseId),
      permitA.initialLeases.map((l) => l.leaseId),
      `${label}: A's leases are released through A's authority`,
    );
    assert.ok(storeA.releaseCalls.every((r) => r.ownerId === permitA.ownerId), `${label}: A's owner`);
    // … and the foreign authority is never called.
    assert.deepEqual(storeB.releaseCalls, [], `${label}: the foreign authority is never used`);
    assert.equal(totalFacadeCalls(adapters), 0, `${label}: no adapter call`);
  }
});

test('an authority mismatch on a permit with duplicate lease ids releases each distinct id once', async () => {
  const snapshot = sealedSnapshot();
  const dup = leases(snapshot.expectedArmIdentities.length);
  dup[1] = { ...dup[1]!, leaseId: dup[0]!.leaseId };
  const { storeA, storeB, a, b } = await twoAdmissions(snapshot, { initialLeases: dup });
  const crossed: ClaimOutcome = {
    kind: 'Authorized',
    permit: a.permit,
    leaseAuthority: b.leaseAuthority,
  };
  await assert.rejects(
    () => authorizeWith({ snapshot, adapters: adapterMap(snapshot), request: request(snapshot), outcome: crossed }),
    (e) => e instanceof DispatchAuthorizationError && e.reason === 'lease_authority_mismatch',
  );
  assert.deepEqual(storeA.releaseCalls.map((r) => r.leaseId), [...new Set(dup.map((l) => l.leaseId))]);
  assert.deepEqual(storeB.releaseCalls, []);
});

test('an authority mismatch whose cleanup partly fails still attempts every lease and retains the mismatch cause', async () => {
  const snapshot = sealedSnapshot();
  const { storeA, storeB, a, b } = await twoAdmissions(snapshot);
  const permitA = a.permit;
  storeA.onRelease = (req): Promise<ReleaseResult> => {
    if (req.leaseId === 'lease-1') return Promise.resolve({ outcome: 'refused', reason: 'not_owner' });
    if (req.leaseId === 'lease-2') return Promise.reject(new Error('release boom'));
    return Promise.resolve({ outcome: 'released' });
  };
  const crossed: ClaimOutcome = {
    kind: 'Authorized',
    permit: permitA,
    leaseAuthority: b.leaseAuthority,
  };
  await assert.rejects(
    () => authorizeWith({ snapshot, adapters: adapterMap(snapshot), request: request(snapshot), outcome: crossed }),
    (error) => {
      assert.ok(error instanceof PreDispatchCleanupError);
      assert.ok(error.primary instanceof DispatchAuthorizationError);
      assert.equal((error.primary as DispatchAuthorizationError).reason, 'lease_authority_mismatch');
      assert.deepEqual(error.failures.map((f) => `${f.leaseId}=${f.result}`), ['lease-1=not_owner', 'lease-2=threw']);
      assert.deepEqual(error.attempts.map((x) => x.leaseId), permitA.initialLeases.map((l) => l.leaseId));
      return true;
    },
  );
  assert.deepEqual(storeA.releaseCalls.map((r) => r.leaseId), permitA.initialLeases.map((l) => l.leaseId));
  assert.deepEqual(storeB.releaseCalls, []);
});

// ===========================================================================
// Pre-admission request coherence
// ===========================================================================

test('a request that disagrees with the snapshot refuses before the claim', async () => {
  const snapshot = sealedSnapshot();
  const cases: Array<[DispatchRefusalReason, Partial<AdmitDispatchRequest>]> = [
    ['request_cohort_mismatch', { cohortId: 'b'.repeat(64) }],
    ['request_fire_mismatch', { fireId: 'b'.repeat(64) }],
    ['request_game_mismatch', { gameId: '00000000-0000-4000-8000-0000000000f9' }],
    ['request_proposal_mismatch', { proposedMarkets: ['moneyline'] }],
    ['scope_reservation_missing', { scopeReservations: { moneyline: { spendReservationUsdMicros: 10, preparedBytesDigest: 'a'.repeat(64) } } }],
    ['scope_reservation_digest_mismatch', { scopeReservations: { 'moneyline+total': { spendReservationUsdMicros: 10, preparedBytesDigest: 'b'.repeat(64) } } }],
  ];
  for (const [reason, over] of cases) {
    const store = new ScriptedStore();
    const adapters = adapterMap(snapshot);
    const port = new StoreClaimPort(store);
    await assert.rejects(
      () => authorizePreparedDispatch({ snapshot, adapters, request: request(snapshot, over), claimPort: port }),
      (e) => e instanceof DispatchAuthorizationError && e.reason === reason,
      reason,
    );
    assert.deepEqual(store.admitCalls, [], `${reason}: zero admissions`);
    assert.deepEqual(store.releaseCalls, [], `${reason}: zero releases`);
    assert.equal(totalFacadeCalls(adapters), 0);
  }
});

test('a supplied plan that is forged, or captured for a different snapshot, is refused before the claim', async () => {
  const snapshot = sealedSnapshot();
  const other = sealedSnapshot(['moneyline']); // a genuine plan, bound to a DIFFERENT snapshot
  const adapters = adapterMap(snapshot);
  const foreignPlan = buildDispatchPlan(other, adapterMap(other));
  assert.doesNotThrow(() => assertDispatchPlan(foreignPlan)); // genuine, but not this snapshot's

  for (const [label, plan] of [
    ['foreign plan', foreignPlan],
    ['structural copy', { ...foreignPlan } as DispatchPlan],
  ] as const) {
    const store = new ScriptedStore();
    await assert.rejects(
      () => authorizePreparedDispatch({ snapshot, adapters, plan, request: request(snapshot), claimPort: new StoreClaimPort(store) }),
      (e) => e instanceof DispatchAuthorizationError && e.reason === 'plan_not_bound_to_snapshot',
      label,
    );
    assert.deepEqual(store.admitCalls, [], `${label}: zero admissions`);
    assert.deepEqual(store.releaseCalls, [], `${label}: zero releases`);
    assert.equal(totalFacadeCalls(adapters), 0);
  }
});

// ===========================================================================
// The happy path
// ===========================================================================

test('a coherent snapshot, plan, request and admission authorize a branded dispatch', async () => {
  const snapshot = sealedSnapshot();
  const adapters = adapterMap(snapshot);
  const store = new ScriptedStore();
  store.onAdmit = () => Promise.resolve(admitted({}, snapshot));
  const result = await authorizePreparedDispatch({
    snapshot,
    adapters,
    request: request(snapshot),
    claimPort: new StoreClaimPort(store),
  });
  assert.equal(result.kind, 'Authorized');
  if (result.kind !== 'Authorized') return;
  const dispatch = result.dispatch;
  assert.doesNotThrow(() => assertAuthorizedDispatch(dispatch));
  assert.equal(dispatch.snapshot, snapshot);
  assert.equal(dispatch.permit.ownerId, OWNER);
  assert.equal(dispatch.plan.arms.length, snapshot.expectedArmIdentities.length);
  assert.deepEqual(store.releaseCalls, []); // an authorized dispatch releases nothing
  assert.equal(totalFacadeCalls(adapters), 0); // authorization never calls an adapter
});

test('a non-admitted claim yields no dispatch and no lease release', async () => {
  const snapshot = sealedSnapshot();
  const adapters = adapterMap(snapshot);
  const store = new ScriptedStore();
  for (const scripted of [
    (): Promise<AdmitResult> => Promise.resolve({ outcome: 'refused', reason: 'all_claimed', dispatchAuthorized: false }),
    (): Promise<AdmitResult> => Promise.reject(new Error('store down')),
  ]) {
    store.admitCalls.length = 0;
    store.releaseCalls.length = 0;
    store.onAdmit = scripted;
    const result = await authorizePreparedDispatch({
      snapshot,
      adapters,
      request: request(snapshot),
      claimPort: new StoreClaimPort(store),
    });
    assert.equal(result.kind, 'NotAdmitted');
    assert.deepEqual(store.releaseCalls, []);
    assert.equal(totalFacadeCalls(adapters), 0);
  }
});

// ===========================================================================
// Genuine-but-wrong permit matrix + cleanup
// ===========================================================================

/** Every post-admission rejection case: a GENUINE permit minted from a scripted result. */
async function wrongPermitCases(): Promise<Array<{ label: string; reason: DispatchRefusalReason; snapshot: PreparedFireSnapshot; store: ScriptedStore; outcome: ClaimOutcome }>> {
  const cases: Array<{ label: string; reason: DispatchRefusalReason; snapshot: PreparedFireSnapshot; store: ScriptedStore; outcome: ClaimOutcome }> = [];
  const add = async (
    label: string,
    reason: DispatchRefusalReason,
    build: (s: PreparedFireSnapshot) => { req?: Partial<AdmitDispatchRequest>; res?: Partial<AdmitAdmittedResult> },
  ): Promise<void> => {
    const snapshot = sealedSnapshot();
    const store = new ScriptedStore();
    const { req, res } = build(snapshot);
    const { outcome } = await mintPermit(store, request(snapshot, req ?? {}), admitted(res ?? {}, snapshot));
    store.releaseCalls.length = 0; // only count cleanup releases
    cases.push({ label, reason, snapshot, store, outcome });
  };

  await add('wrong cohort', 'permit_cohort_mismatch', () => ({ req: { cohortId: 'b'.repeat(64) } }));
  await add('wrong game', 'permit_game_mismatch', () => ({ req: { gameId: 'other-game' } }));
  await add('wrong fire id', 'permit_fire_id_mismatch', () => ({ req: { fireId: 'b'.repeat(64) } }));
  await add('wrong proposal', 'permit_proposal_mismatch', () => ({ req: { proposedMarkets: ['moneyline'] } }));
  await add('wrong owner', 'permit_owner_mismatch', () => ({ req: { ownerId: 'other-owner' } }));
  await add('wrong schema version', 'permit_schema_mismatch', () => ({ req: { expectedSchemaVersion: 99 } }));
  await add('wrong digest', 'permit_digest_mismatch', () => ({ res: { preparedBytesDigest: 'b'.repeat(64) } }));
  await add('claimed key with wrong game', 'claim_key_game_mismatch', () => ({
    res: { claimedKeys: [{ gameId: GAME_ID, market: 'moneyline' }, { gameId: 'other-game', market: 'total' }] },
  }));
  await add('duplicate claimed tuple', 'claim_key_duplicate', () => ({
    res: { claimedKeys: [{ gameId: GAME_ID, market: 'moneyline' }, { gameId: GAME_ID, market: 'moneyline' }] },
  }));
  await add('foreign claimed market', 'claim_scope_mismatch', () => ({
    res: { claimedKeys: [{ gameId: GAME_ID, market: 'moneyline' }, { gameId: GAME_ID, market: 'spread' }] },
  }));
  await add('strict retained subset', 'retained_scope_not_supported', () => ({
    res: { claimedKeys: [{ gameId: GAME_ID, market: 'moneyline' }] },
  }));
  await add('wrong initial lease count', 'lease_count_mismatch', (s) => ({ res: { initialLeases: leases(s.expectedArmIdentities.length - 1) } }));
  await add('duplicate arm index', 'lease_arm_index_duplicate', (s) => {
    const l = leases(s.expectedArmIdentities.length);
    l[1] = { ...l[1]!, armIndex: 0 };
    return { res: { initialLeases: l } };
  });
  await add('out-of-range arm index', 'lease_arm_index_invalid', (s) => {
    const l = leases(s.expectedArmIdentities.length);
    l[0] = { ...l[0]!, armIndex: 99 };
    return { res: { initialLeases: l } };
  });
  await add('duplicate lease id across arms', 'lease_id_duplicate', (s) => {
    const l = leases(s.expectedArmIdentities.length);
    l[1] = { ...l[1]!, leaseId: l[0]!.leaseId };
    return { res: { initialLeases: l } };
  });
  await add('non-live initial lease', 'lease_not_live', (s) => {
    const l = leases(s.expectedArmIdentities.length);
    l[0] = { ...l[0]!, state: 'expired' };
    return { res: { initialLeases: l } };
  });
  return cases;
}

test('every genuine-but-wrong permit is refused, releases each distinct lease once, and calls no adapter', async () => {
  for (const c of await wrongPermitCases()) {
    const adapters = adapterMap(c.snapshot);
    await assert.rejects(
      () => authorizeWith({ snapshot: c.snapshot, adapters, request: request(c.snapshot), outcome: c.outcome }),
      (e) => e instanceof DispatchAuthorizationError && e.reason === c.reason,
      `${c.label}: expected ${c.reason}`,
    );
    assert.equal(totalFacadeCalls(adapters), 0, `${c.label}: no adapter call`);
    // Cleanup: one release per DISTINCT admitted lease id, always under the permit's owner.
    const permit = (c.outcome as { permit: DispatchPermit }).permit;
    const distinct = [...new Set(permit.initialLeases.map((l) => l.leaseId))];
    assert.deepEqual(
      c.store.releaseCalls.map((r) => r.leaseId),
      distinct,
      `${c.label}: exactly one release per distinct lease id, in order`,
    );
    assert.ok(c.store.releaseCalls.every((r) => r.ownerId === permit.ownerId), `${c.label}: owner is the admitted owner`);
  }
});

// ===========================================================================
// Cleanup failure convergence
// ===========================================================================

test('cleanup attempts every lease, converges, and reports the complete failure set with the original cause', async () => {
  const snapshot = sealedSnapshot();
  const store = new ScriptedStore();
  const rosterSize = snapshot.expectedArmIdentities.length;
  assert.ok(rosterSize >= 4, 'fixture expects at least four arms');
  // A genuine permit whose retained scope is a strict subset (the typed refusal).
  const { outcome, permit } = await mintPermit(
    store,
    request(snapshot),
    admitted({ claimedKeys: [{ gameId: GAME_ID, market: 'moneyline' }] }, snapshot),
  );
  store.releaseCalls.length = 0;
  store.onRelease = (req): Promise<ReleaseResult> => {
    if (req.leaseId === 'lease-1') return Promise.resolve({ outcome: 'refused', reason: 'not_owner' });
    if (req.leaseId === 'lease-2') return Promise.reject(new Error('release boom'));
    return Promise.resolve({ outcome: 'released' });
  };
  const adapters = adapterMap(snapshot);
  await assert.rejects(
    () => authorizeWith({ snapshot, adapters, request: request(snapshot), outcome }),
    (error) => {
      assert.ok(error instanceof PreDispatchCleanupError);
      // the original cause is retained
      assert.ok(error.primary instanceof DispatchAuthorizationError);
      assert.equal((error.primary as DispatchAuthorizationError).reason, 'retained_scope_not_supported');
      // both failures are reported, with their outcomes
      assert.deepEqual(
        error.failures.map((f) => `${f.leaseId}=${f.result}`),
        ['lease-1=not_owner', 'lease-2=threw'],
      );
      // the complete attempt log covers every distinct lease
      assert.deepEqual(error.attempts.map((a) => a.leaseId), permit.initialLeases.map((l) => l.leaseId));
      return true;
    },
  );
  // Every lease — including those after the failures — received exactly one attempt.
  assert.deepEqual(store.releaseCalls.map((r) => r.leaseId), permit.initialLeases.map((l) => l.leaseId));
  assert.equal(totalFacadeCalls(adapters), 0);
});

test('duplicate admitted lease ids are released once and the authority violation stays loud', async () => {
  const snapshot = sealedSnapshot();
  const store = new ScriptedStore();
  const dup = leases(snapshot.expectedArmIdentities.length);
  dup[1] = { ...dup[1]!, leaseId: dup[0]!.leaseId };
  const { outcome } = await mintPermit(store, request(snapshot), admitted({ initialLeases: dup }, snapshot));
  store.releaseCalls.length = 0;
  const adapters = adapterMap(snapshot);
  await assert.rejects(
    () => authorizeWith({ snapshot, adapters, request: request(snapshot), outcome }),
    (e) => e instanceof DispatchAuthorizationError && e.reason === 'lease_id_duplicate',
  );
  const ids = store.releaseCalls.map((r) => r.leaseId);
  assert.equal(new Set(ids).size, ids.length, 'no distinct lease id is released twice');
  assert.deepEqual(ids, [...new Set(dup.map((l) => l.leaseId))]);
});

// ===========================================================================
// Plan / AuthorizedDispatch origin
// ===========================================================================

test('a structural copy of a plan or an authorized dispatch never authenticates', async () => {
  const snapshot = sealedSnapshot();
  const adapters = adapterMap(snapshot);
  const store = new ScriptedStore();
  store.onAdmit = () => Promise.resolve(admitted({}, snapshot));
  const result = await authorizePreparedDispatch({
    snapshot,
    adapters,
    request: request(snapshot),
    claimPort: new StoreClaimPort(store),
  });
  assert.equal(result.kind, 'Authorized');
  if (result.kind !== 'Authorized') return;
  assert.doesNotThrow(() => assertDispatchPlan(result.dispatch.plan));
  assert.doesNotThrow(() => assertAuthorizedDispatch(result.dispatch));
  assert.throws(() => assertDispatchPlan({ ...result.dispatch.plan } as DispatchPlan), DispatchAuthorizationError);
  assert.throws(() => assertAuthorizedDispatch({ ...result.dispatch } as AuthorizedDispatch), DispatchAuthorizationError);
  // Least authority: the authorized dispatch that flows to the lifecycle carries NO completion — the
  // completion capability is resolved by the spine from the permit after install, never handed to the
  // runner (which could otherwise settle a fire before its evidence is durably installed).
  assert.equal((result.dispatch as unknown as Record<string, unknown>).completion, undefined, 'no completion on the authorized dispatch');
  assert.deepEqual(Object.keys(result.dispatch).sort(), ['leaseAuthority', 'permit', 'plan', 'snapshot']);
  // A hand-assembled tuple of the genuine pieces is still not an authorized dispatch.
  const raw = {
    permit: result.dispatch.permit,
    snapshot: result.dispatch.snapshot,
    plan: result.dispatch.plan,
    leaseAuthority: result.dispatch.leaseAuthority,
  } as AuthorizedDispatch;
  assert.throws(() => assertAuthorizedDispatch(raw), DispatchAuthorizationError);
});
