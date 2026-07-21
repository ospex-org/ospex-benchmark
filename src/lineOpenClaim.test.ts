import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertDispatchPermit,
  assertLeaseAuthority,
  assertReplayReleaseCapability,
  captureAdmitRequest,
  RehearsalClaimPort,
  StoreClaimPort,
} from './lineOpenClaim.js';
import type { ClaimOutcome, DispatchPermit } from './lineOpenClaim.js';
import { StoreWireError } from './store/atomicStore.js';
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
import type { MarketKey } from './types.js';

/**
 * The admission-authority boundary: request capture, permit minting/unforgeability, the
 * fail-closed result/throw matrix, and the same-admission lease authority. Every test drives
 * a scripted `AtomicStore` — no provider, database, or live path is contacted.
 */

const COHORT = 'c'.repeat(64);
const FIRE = 'f'.repeat(64);
const GAME = '00000000-0000-4000-8000-0000000000f1';
const OWNER = 'owner-host-1234-abc';
import { STORE_SCHEMA_VERSION as SCHEMA } from './store/constants.js';

function leases(count: number): Lease[] {
  return Array.from({ length: count }, (_, i) => ({
    leaseId: `lease-${i}`,
    armIndex: i,
    expiresAt: '2026-07-18T12:10:00.000Z',
    state: 'live' as const,
  }));
}

function claimedKeys(markets: readonly MarketKey[]): ClaimKey[] {
  return markets.map((market) => ({ gameId: GAME, market }));
}

function admittedResult(markets: readonly MarketKey[] = ['moneyline', 'total'], rosterSize = 3): AdmitAdmittedResult {
  return {
    outcome: 'admitted',
    claimedKeys: claimedKeys(markets),
    preparedBytesDigest: 'a'.repeat(64),
    initialLeases: leases(rosterSize),
    dispatchAuthorized: true,
  };
}

function request(over: Partial<AdmitDispatchRequest> = {}): AdmitDispatchRequest {
  return {
    cohortId: COHORT,
    fireId: FIRE,
    ownerId: OWNER,
    expectedSchemaVersion: SCHEMA,
    gameId: GAME,
    proposedMarkets: ['moneyline', 'total'],
    scopeReservations: {
      'moneyline+total': { spendReservationUsdMicros: 1000, preparedBytesDigest: 'a'.repeat(64) },
    },
    ...over,
  };
}

/** A scripted store: every call is recorded; each operation's behaviour is injectable. */
class ScriptedStore implements AtomicStore {
  readonly admitCalls: AdmitDispatchRequest[] = [];
  readonly releaseCalls: ReleaseLeaseRequest[] = [];
  readonly repairCalls: AcquireRepairLeaseRequest[] = [];

  onAdmit: (req: AdmitDispatchRequest) => Promise<AdmitResult> = () => Promise.resolve(admittedResult());
  onRelease: (req: ReleaseLeaseRequest) => Promise<ReleaseResult> = () => Promise.resolve({ outcome: 'released' });
  onRepair: (req: AcquireRepairLeaseRequest) => Promise<RepairLeaseResult> = () =>
    Promise.resolve({ outcome: 'refused', reason: 'concurrency', requestAuthorized: false });

  initCohortBudget(_req: InitCohortBudgetRequest): Promise<InitResult> {
    throw new Error('not used');
  }
  admitDispatch(req: AdmitDispatchRequest): Promise<AdmitResult> {
    this.admitCalls.push(req);
    return this.onAdmit(req);
  }
  acquireRepairLease(req: AcquireRepairLeaseRequest): Promise<RepairLeaseResult> {
    this.repairCalls.push(req);
    return this.onRepair(req);
  }
  releaseLease(req: ReleaseLeaseRequest): Promise<ReleaseResult> {
    this.releaseCalls.push(req);
    return this.onRelease(req);
  }
  completeClaim(_req: CompleteClaimRequest): Promise<CompleteResult> {
    throw new Error('not used');
  }
}

async function admitAuthorized(store: ScriptedStore, req = request()) {
  const outcome = await new StoreClaimPort(store).admit(req);
  assert.equal(outcome.kind, 'Authorized');
  if (outcome.kind !== 'Authorized') throw new Error('unreachable');
  return outcome;
}

// ===========================================================================
// Permit origin, request capture, detachment, freeze
// ===========================================================================

test('a genuine admission mints an authentic permit + lease authority; a structural copy does not', async () => {
  const { permit, leaseAuthority } = await admitAuthorized(new ScriptedStore());
  assert.doesNotThrow(() => assertDispatchPermit(permit));
  assert.doesNotThrow(() => assertLeaseAuthority(leaseAuthority));
  assert.throws(() => assertDispatchPermit({ ...permit }), /not minted by a store admission/);
  assert.throws(
    () => assertDispatchPermit(JSON.parse(JSON.stringify(permit)) as DispatchPermit),
    /not minted by a store admission/,
  );
  assert.throws(() => assertLeaseAuthority({ ...leaseAuthority }), /not minted by a store admission/);
});

test('the permit carries the admitted owner, schema version, proposal, keys, leases and digest', async () => {
  const { permit } = await admitAuthorized(new ScriptedStore());
  assert.equal(permit.cohortId, COHORT);
  assert.equal(permit.fireId, FIRE);
  assert.equal(permit.ownerId, OWNER);
  assert.equal(permit.expectedSchemaVersion, SCHEMA);
  assert.equal(permit.gameId, GAME);
  assert.deepEqual([...permit.proposedMarkets], ['moneyline', 'total']);
  assert.equal(permit.claimedKeys.length, 2);
  assert.equal(permit.initialLeases.length, 3);
  assert.equal(permit.preparedBytesDigest, 'a'.repeat(64));
});

test('a caller mutating its request DURING the store await cannot change the permit', async () => {
  const store = new ScriptedStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  store.onAdmit = async () => {
    await gate;
    return admittedResult();
  };
  const req = request();
  const pending = new StoreClaimPort(store).admit(req);
  // Mutate every request-derived field while the admission is in flight.
  req.cohortId = 'tampered-cohort';
  req.fireId = 'tampered-fire';
  req.ownerId = 'tampered-owner';
  req.expectedSchemaVersion = 999;
  req.gameId = 'tampered-game';
  (req.proposedMarkets as MarketKey[]).push('spread');
  release();
  const outcome = await pending;
  assert.equal(outcome.kind, 'Authorized');
  if (outcome.kind !== 'Authorized') return;
  assert.equal(outcome.permit.cohortId, COHORT);
  assert.equal(outcome.permit.fireId, FIRE);
  assert.equal(outcome.permit.ownerId, OWNER);
  assert.equal(outcome.permit.expectedSchemaVersion, SCHEMA);
  assert.equal(outcome.permit.gameId, GAME);
  assert.deepEqual([...outcome.permit.proposedMarkets], ['moneyline', 'total']);
  // The store also received the captured values, never the mutated ones.
  const sent = store.admitCalls[0]!;
  assert.equal(sent.cohortId, COHORT);
  assert.deepEqual([...sent.proposedMarkets], ['moneyline', 'total']);
});

test('the store mutating its own returned arrays after admission cannot change the permit', async () => {
  const store = new ScriptedStore();
  const result = admittedResult();
  store.onAdmit = () => Promise.resolve(result);
  const { permit } = await admitAuthorized(store);
  // Mutate the store's arrays and nested entries after the mint.
  (result.claimedKeys as ClaimKey[]).push({ gameId: 'other', market: 'spread' });
  (result.claimedKeys[0] as { gameId: string }).gameId = 'tampered';
  (result.initialLeases as Lease[]).pop();
  (result.initialLeases[0] as { leaseId: string }).leaseId = 'tampered-lease';
  assert.equal(permit.claimedKeys.length, 2);
  assert.equal(permit.claimedKeys[0]!.gameId, GAME);
  assert.equal(permit.initialLeases.length, 3);
  assert.equal(permit.initialLeases[0]!.leaseId, 'lease-0');
});

test('the permit graph is deeply immutable — nested mutation leaves values unchanged', async () => {
  const { permit } = await admitAuthorized(new ScriptedStore());
  const attempt = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* frozen: throwing is acceptable */
    }
  };
  attempt(() => ((permit as { ownerId: string }).ownerId = 'x'));
  attempt(() => ((permit.claimedKeys[0] as { market: MarketKey }).market = 'spread'));
  attempt(() => ((permit.initialLeases[0] as { state: string }).state = 'released'));
  attempt(() => (permit.initialLeases as Lease[]).push(leases(1)[0]!));
  assert.equal(permit.ownerId, OWNER);
  assert.equal(permit.claimedKeys[0]!.market, 'moneyline');
  assert.equal(permit.initialLeases[0]!.state, 'live');
  assert.equal(permit.initialLeases.length, 3);
});

test('the rehearsal port never admits and never yields a permit or lease authority', async () => {
  const outcome = await new RehearsalClaimPort().admit(request());
  assert.equal(outcome.kind, 'WouldAdmit');
  assert.ok(!('permit' in outcome));
  assert.ok(!('leaseAuthority' in outcome));
});

test('captureAdmitRequest detaches the proposal and every reservation entry', () => {
  const req = request();
  const captured = captureAdmitRequest(req);
  (req.proposedMarkets as MarketKey[]).push('spread');
  req.scopeReservations['moneyline+total']!.preparedBytesDigest = 'b'.repeat(64);
  assert.deepEqual(captured.proposedMarkets, ['moneyline', 'total']);
  assert.equal(captured.scopeReservations['moneyline+total']!.preparedBytesDigest, 'a'.repeat(64));
});

// ===========================================================================
// A — authorization: the literal conjunction is the sole paid gate
// ===========================================================================

test('authorization requires admitted AND the dispatchAuthorized literal — never the outcome name', async () => {
  // admitted + literal true -> Authorized (with a genuine permit).
  const authorized = await admitAuthorized(new ScriptedStore());
  assert.doesNotThrow(() => assertDispatchPermit(authorized.permit));

  // admitted WITHOUT the literal (a runtime skew) -> loud Fault, never a permit.
  const skewStore = new ScriptedStore();
  skewStore.onAdmit = () =>
    Promise.resolve({
      outcome: 'admitted',
      claimedKeys: claimedKeys(['moneyline']),
      preparedBytesDigest: 'a'.repeat(64),
      initialLeases: leases(1),
      dispatchAuthorized: false,
    } as unknown as AdmitResult);
  const skew = await new StoreClaimPort(skewStore).admit(request());
  assert.equal(skew.kind, 'Fault');
  assert.equal((skew as { reason?: string }).reason, 'admitted_without_authorization');
  assert.ok(!('permit' in skew));

  // TRUTHY NON-BOOLEAN values (a skewed store, a JSON round-trip, a hostile object) must NOT
  // authorize a paid dispatch — only the boolean `true` does. A truthiness check would wrongly
  // authorize every one of these; the `!== true` literal gate rejects them.
  for (const skewed of [1, 'true', {}, [], 'false', 0, null] as unknown[]) {
    const truthyStore = new ScriptedStore();
    truthyStore.onAdmit = () =>
      Promise.resolve({
        outcome: 'admitted',
        claimedKeys: claimedKeys(['moneyline']),
        preparedBytesDigest: 'a'.repeat(64),
        initialLeases: leases(1),
        dispatchAuthorized: skewed,
      } as unknown as AdmitResult);
    const outcome = await new StoreClaimPort(truthyStore).admit(request());
    assert.equal(outcome.kind, 'Fault', `dispatchAuthorized=${JSON.stringify(skewed)} must not authorize`);
    assert.equal((outcome as { reason?: string }).reason, 'admitted_without_authorization');
    assert.ok(!('permit' in outcome), `dispatchAuthorized=${JSON.stringify(skewed)} minted no permit`);
  }

  // A replay carrying a HOSTILE dispatchAuthorized:true still routes to its replay reaction,
  // never Authorized — the switch keys authorization on the admitted conjunction alone.
  const replayAuthStore = new ScriptedStore();
  replayAuthStore.onAdmit = () =>
    Promise.resolve({
      outcome: 'replayed',
      fireStatus: 'completed',
      claimedKeys: claimedKeys(['moneyline']),
      dispatchAuthorized: true,
    } as unknown as AdmitResult);
  const replayAuth = await new StoreClaimPort(replayAuthStore).admit(request());
  assert.equal(replayAuth.kind, 'Skip');
  assert.ok(!('permit' in replayAuth));
});

// ===========================================================================
// B — the exhaustive admit-reaction matrix
// ===========================================================================

test('every store admit outcome maps to its exact typed reaction, with no coverage verdict', async () => {
  const cases: Array<{ result: AdmitResult; kind: ClaimOutcome['kind']; reason: string }> = [
    { result: { outcome: 'replayed', fireStatus: 'pending', claimedKeys: claimedKeys(['moneyline']), initialLeases: leases(1), dispatchAuthorized: false }, kind: 'Skip', reason: 'replayed_pending' },
    { result: { outcome: 'replayed', fireStatus: 'completed', claimedKeys: claimedKeys(['moneyline']), dispatchAuthorized: false }, kind: 'Skip', reason: 'replayed_completed' },
    { result: { outcome: 'refused', reason: 'all_claimed', dispatchAuthorized: false }, kind: 'Skip', reason: 'all_claimed' },
    { result: { outcome: 'refused', reason: 'call_cap', dispatchAuthorized: false }, kind: 'Defer', reason: 'call_cap' },
    { result: { outcome: 'refused', reason: 'spend_cap', dispatchAuthorized: false }, kind: 'Defer', reason: 'spend_cap' },
    { result: { outcome: 'refused', reason: 'concurrency', dispatchAuthorized: false }, kind: 'Defer', reason: 'concurrency' },
    { result: { outcome: 'refused', reason: 'not_initialized', dispatchAuthorized: false }, kind: 'Fault', reason: 'not_initialized' },
    { result: { outcome: 'refused', reason: 'version_mismatch', dispatchAuthorized: false }, kind: 'Fault', reason: 'version_mismatch' },
    { result: { outcome: 'refused', reason: 'invalid_input', dispatchAuthorized: false }, kind: 'Fault', reason: 'invalid_input' },
    { result: { outcome: 'refused', reason: 'scope_reservation_missing', dispatchAuthorized: false }, kind: 'Fault', reason: 'scope_reservation_missing' },
    { result: { outcome: 'error', reason: 'fire_id_key_mismatch', dispatchAuthorized: false }, kind: 'Fault', reason: 'fire_id_key_mismatch' },
  ];
  for (const c of cases) {
    const store = new ScriptedStore();
    store.onAdmit = () => Promise.resolve(c.result);
    const outcome = await new StoreClaimPort(store).admit(request());
    assert.equal(outcome.kind, c.kind, `${String(c.result.outcome)}/${c.reason}: kind`);
    assert.equal((outcome as { reason?: string }).reason, c.reason, `${c.reason}: reason`);
    assert.ok(!('permit' in outcome), `${c.reason}: no permit`);
    // No local coverage verdict is ever manufactured (coverage is globally derived).
    assert.ok(!('coverageMiss' in outcome) && !('terminal' in outcome), `${c.reason}: no coverage field`);
    assert.deepEqual(store.releaseCalls, [], `${c.reason}: no release`);
    assert.deepEqual(store.repairCalls, [], `${c.reason}: no repair`);
  }
});

// ===========================================================================
// C — pending / completed replay recovery state
// ===========================================================================

test('a pending replay Skip carries detached, frozen keys + leases + a genuine release-only capability', async () => {
  const store = new ScriptedStore();
  const result: AdmitResult = {
    outcome: 'replayed',
    fireStatus: 'pending',
    claimedKeys: claimedKeys(['moneyline', 'total']),
    initialLeases: leases(3),
    dispatchAuthorized: false,
  };
  store.onAdmit = () => Promise.resolve(result);
  const outcome = await new StoreClaimPort(store).admit(request());
  assert.equal(outcome.kind, 'Skip');
  if (outcome.kind !== 'Skip' || outcome.reason !== 'replayed_pending') throw new Error('expected replayed_pending Skip');
  const { recovery } = outcome;
  assert.equal(recovery.claimedKeys.length, 2);
  assert.equal(recovery.initialLeases.length, 3);
  // The capability is genuine and RELEASE-ONLY (no repair-acquisition surface).
  assert.doesNotThrow(() => assertReplayReleaseCapability(recovery.cleanup));
  assert.ok(!('acquireRepairLease' in recovery.cleanup));
  // Minting it released nothing — the claim port never auto-releases a pending replay.
  assert.deepEqual(store.releaseCalls, []);
  // Binding is unit-testable: invoking the capability releases through the CAPTURED store + the
  // CAPTURED owner (a consumer supplies only a leaseId — it cannot substitute a different owner or
  // store). Production invocation is a later slice; a wrong-owner binding breaks this exact call.
  await recovery.cleanup.releaseLease('lease-0');
  assert.deepEqual(store.releaseCalls, [{ leaseId: 'lease-0', ownerId: OWNER }]);
  // A structural copy of the capability is rejected before any release.
  assert.throws(() => assertReplayReleaseCapability({ ...recovery.cleanup }), /not minted/);
  // A store mutation of its own returned arrays AFTER admit cannot alter the outcome.
  (result.claimedKeys as ClaimKey[]).push({ gameId: 'other', market: 'spread' });
  (result.claimedKeys[0] as { gameId: string }).gameId = 'tampered';
  (result.initialLeases as Lease[]).pop();
  (result.initialLeases[0] as { leaseId: string }).leaseId = 'tampered';
  assert.equal(recovery.claimedKeys.length, 2);
  assert.equal(recovery.claimedKeys[0]!.gameId, GAME);
  assert.equal(recovery.initialLeases.length, 3);
  assert.equal(recovery.initialLeases[0]!.leaseId, 'lease-0');
  // The recovery graph is frozen.
  assert.throws(() => (recovery.claimedKeys as ClaimKey[]).push({ gameId: 'x', market: 'spread' }));
});

test('a completed replay Skip carries detached keys and NO leases or capability', async () => {
  const store = new ScriptedStore();
  const result: AdmitResult = {
    outcome: 'replayed',
    fireStatus: 'completed',
    claimedKeys: claimedKeys(['moneyline']),
    dispatchAuthorized: false,
  };
  store.onAdmit = () => Promise.resolve(result);
  const outcome = await new StoreClaimPort(store).admit(request());
  assert.equal(outcome.kind, 'Skip');
  if (outcome.kind !== 'Skip' || outcome.reason !== 'replayed_completed') throw new Error('expected replayed_completed Skip');
  assert.equal(outcome.claimedKeys.length, 1);
  assert.ok(!('recovery' in outcome) && !('initialLeases' in outcome));
  // A post-return store mutation cannot alter it.
  (result.claimedKeys as ClaimKey[]).push({ gameId: 'other', market: 'spread' });
  (result.claimedKeys[0] as { gameId: string }).gameId = 'tampered';
  assert.equal(outcome.claimedKeys.length, 1);
  assert.equal(outcome.claimedKeys[0]!.gameId, GAME);
  assert.deepEqual(store.releaseCalls, []);
});

// ===========================================================================
// D — thrown values: a genuine wire skew rejects; everything else faults
// ===========================================================================

test('a genuine StoreWireError propagates by identity (rejects) — never a soft Fault', async () => {
  const wire = new StoreWireError('admitDispatch', 'contract skew');
  const store = new ScriptedStore();
  store.onAdmit = () => Promise.reject(wire);
  await assert.rejects(() => new StoreClaimPort(store).admit(request()), (e: unknown) => e === wire);
  const store2 = new ScriptedStore();
  store2.onAdmit = () => {
    throw wire;
  };
  await assert.rejects(() => new StoreClaimPort(store2).admit(request()), (e: unknown) => e === wire);
});

test('every non-wire thrown value collapses to a fixed Fault without being read or formatted', async () => {
  const hostileMessage = {
    get message(): string {
      throw new Error('hostile message getter');
    },
    [Symbol.toPrimitive](): never {
      throw new Error('hostile toPrimitive');
    },
  };
  // A `getPrototypeOf`-trapping proxy and a revoked proxy each make a PLAIN `instanceof` throw.
  const protoTrap = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('getPrototypeOf trap');
      },
    },
  );
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const thrownValues: unknown[] = [
    new Error('ordinary'),
    hostileMessage,
    protoTrap,
    revocable.proxy,
    null,
    undefined,
    'a primitive string',
    42,
  ];
  for (const thrown of thrownValues) {
    const store = new ScriptedStore();
    store.onAdmit = () => Promise.reject(thrown);
    const outcome = await new StoreClaimPort(store).admit(request());
    assert.equal(outcome.kind, 'Fault', `thrown ${typeof thrown}`);
    assert.equal((outcome as { reason?: string }).reason, 'store_admit_failed');
    assert.ok(!('permit' in outcome));
    assert.deepEqual(store.releaseCalls, []);
  }
});

// ===========================================================================
// The same-admission lease authority
// ===========================================================================

test('the lease authority binds the captured store, owner, cohort, fire and schema version', async () => {
  const store = new ScriptedStore();
  const { leaseAuthority } = await admitAuthorized(store);

  await leaseAuthority.releaseLease('lease-0');
  assert.deepEqual(store.releaseCalls, [{ leaseId: 'lease-0', ownerId: OWNER }]);

  await leaseAuthority.acquireRepairLease(2, 1);
  assert.deepEqual(store.repairCalls, [
    { cohortId: COHORT, fireId: FIRE, ownerId: OWNER, armIndex: 2, repairOrdinal: 1, expectedSchemaVersion: SCHEMA },
  ]);
  // There is no argument through which a caller could supply a different owner or version.
});
