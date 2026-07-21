import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releasePendingReplay } from './fireRecovery.js';
import { StoreClaimPort } from './lineOpenClaim.js';
import type { ReplayPendingRecovery } from './lineOpenClaim.js';
import { STORE_SCHEMA_VERSION as SCHEMA } from './store/constants.js';
import type {
  AcquireRepairLeaseRequest,
  AdmitDispatchRequest,
  AdmitResult,
  AtomicStore,
  CompleteClaimRequest,
  CompleteResult,
  InitCohortBudgetRequest,
  InitResult,
  ReleaseLeaseRequest,
  ReleaseResult,
  RepairLeaseResult,
} from './store/contract.js';
import type { MarketKey } from './types.js';

/**
 * Pending-replay lease-release mechanics. Genuine recoveries are minted by a real `StoreClaimPort` over
 * a scripted store that admits as `replayed`/`pending`; each `releaseLease` outcome is scripted. No
 * provider, database, or live path is contacted.
 */

const COHORT = 'c'.repeat(64);
const FIRE = 'f'.repeat(64);
const GAME = '00000000-0000-4000-8000-0000000000f1';
const OWNER = 'owner-host-1234-abc';
const DIGEST = 'a'.repeat(64);

/** A store that admits as `replayed`/`pending` with the given lease ids, and scripts `releaseLease`. */
class RecoveryStore implements AtomicStore {
  readonly releaseCalls: ReleaseLeaseRequest[] = [];
  onRelease: (req: ReleaseLeaseRequest) => Promise<ReleaseResult> = () => Promise.resolve({ outcome: 'released' });
  constructor(private readonly leaseIds: readonly string[]) {}
  initCohortBudget(_r: InitCohortBudgetRequest): Promise<InitResult> {
    throw new Error('not used');
  }
  admitDispatch(_req: AdmitDispatchRequest): Promise<AdmitResult> {
    return Promise.resolve({
      outcome: 'replayed',
      fireStatus: 'pending',
      claimedKeys: [{ gameId: GAME, market: 'moneyline' as MarketKey }],
      initialLeases: this.leaseIds.map((leaseId, i) => ({
        leaseId,
        armIndex: i,
        expiresAt: '2026-07-18T12:10:00.000Z',
        state: 'live' as const,
      })),
      dispatchAuthorized: false,
    });
  }
  acquireRepairLease(_r: AcquireRepairLeaseRequest): Promise<RepairLeaseResult> {
    return Promise.resolve({ outcome: 'refused', reason: 'concurrency', requestAuthorized: false });
  }
  releaseLease(req: ReleaseLeaseRequest): Promise<ReleaseResult> {
    this.releaseCalls.push(req);
    return this.onRelease(req);
  }
  completeClaim(_r: CompleteClaimRequest): Promise<CompleteResult> {
    return Promise.resolve({ outcome: 'completed' });
  }
}

async function genuineRecovery(store: RecoveryStore, owner = OWNER): Promise<ReplayPendingRecovery> {
  const outcome = await new StoreClaimPort(store).admit({
    cohortId: COHORT,
    fireId: FIRE,
    ownerId: owner,
    expectedSchemaVersion: SCHEMA,
    gameId: GAME,
    proposedMarkets: ['moneyline'],
    scopeReservations: { moneyline: { spendReservationUsdMicros: 1, preparedBytesDigest: DIGEST } },
  });
  if (outcome.kind !== 'Skip' || outcome.reason !== 'replayed_pending') {
    throw new Error(`expected replayed_pending, got ${outcome.kind}`);
  }
  return outcome.recovery;
}

// ===========================================================================
// genuine recovery — mixed outcomes, order, counts
// ===========================================================================

test('a genuine recovery attempts every distinct lease once in order; mixed outcomes all converge', async () => {
  const store = new RecoveryStore(['l0', 'l1', 'l2']);
  const boom = new Error('release transport failed');
  store.onRelease = (req) => {
    if (req.leaseId === 'l0') return Promise.resolve({ outcome: 'released' });
    if (req.leaseId === 'l1') return Promise.resolve({ outcome: 'refused', reason: 'not_owner' });
    return Promise.reject(boom); // l2
  };
  const recovery = await genuineRecovery(store);
  const out = await releasePendingReplay(recovery);
  assert.deepEqual(store.releaseCalls.map((c) => c.leaseId), ['l0', 'l1', 'l2'], 'each lease attempted once, in order');
  assert.deepEqual(out.attempts, [
    { leaseId: 'l0', result: 'released' },
    { leaseId: 'l1', result: 'not_owner' },
    { leaseId: 'l2', result: 'failed' },
  ]);
  assert.equal(out.releasedCount, 1);
  assert.equal(out.notOwnerCount, 1);
  assert.equal(out.failedCount, 1);
});

// ===========================================================================
// aggregate authentication — forged recoveries propagate before any release
// ===========================================================================

test('a structural (spread) copy of the recovery is rejected before any release', async () => {
  const store = new RecoveryStore(['l0', 'l1']);
  const recovery = await genuineRecovery(store);
  await assert.rejects(() => releasePendingReplay({ ...recovery }), /not minted/);
  assert.deepEqual(store.releaseCalls, [], 'zero store calls for a forged aggregate');
});

test('a property-trapping proxy recovery is rejected by origin before any field read', async () => {
  const store = new RecoveryStore(['l0', 'l1']);
  const recovery = await genuineRecovery(store);
  let reads = 0;
  const proxy = new Proxy(recovery, {
    get(t, p, r) {
      reads += 1;
      return Reflect.get(t, p, r);
    },
  });
  await assert.rejects(() => releasePendingReplay(proxy as ReplayPendingRecovery), /not minted/);
  assert.equal(reads, 0, 'no field of a forged recovery was read');
  assert.deepEqual(store.releaseCalls, []);
});

test('a crossed same-owner aggregate (genuine cleanup A + fire B lease list) is rejected; B is never released', async () => {
  const storeA = new RecoveryStore(['a0', 'a1']);
  const recoveryA = await genuineRecovery(storeA);
  const storeB = new RecoveryStore(['b0', 'b1']);
  const recoveryB = await genuineRecovery(storeB);
  // A hand-built aggregate pairing A's genuine cleanup with B's lease list, one shared owner.
  const crossed = {
    cohortId: recoveryA.cohortId,
    fireId: recoveryA.fireId,
    ownerId: recoveryA.ownerId,
    claimedKeys: recoveryA.claimedKeys,
    initialLeases: recoveryB.initialLeases,
    cleanup: recoveryA.cleanup,
  } as ReplayPendingRecovery;
  await assert.rejects(() => releasePendingReplay(crossed), /not minted/);
  assert.deepEqual(storeA.releaseCalls, [], 'A makes no calls for a crossed aggregate');
  assert.deepEqual(storeB.releaseCalls, [], 'B receives zero release calls');
});

test('a genuine capability cannot release another fire’s lease directly (lease-set bound, before the store)', async () => {
  const storeA = new RecoveryStore(['a0', 'a1']);
  const recoveryA = await genuineRecovery(storeA);
  const storeB = new RecoveryStore(['b0', 'b1']);
  await genuineRecovery(storeB);
  await assert.rejects(() => recoveryA.cleanup.releaseLease('b0'), /outside its recovery/);
  assert.deepEqual(storeA.releaseCalls, [], 'a foreign lease id makes zero store calls; B stays live');
});

// ===========================================================================
// truthful classification — released / not_owner / failed
// ===========================================================================

test('a different-owner recovery returns not_owner for every lease; all attempted, no throw', async () => {
  const store = new RecoveryStore(['l0', 'l1', 'l2']);
  store.onRelease = () => Promise.resolve({ outcome: 'refused', reason: 'not_owner' });
  const recovery = await genuineRecovery(store);
  const out = await releasePendingReplay(recovery);
  assert.equal(out.notOwnerCount, 3);
  assert.equal(out.releasedCount, 0);
  assert.equal(out.failedCount, 0);
  assert.deepEqual(store.releaseCalls.map((c) => c.leaseId), ['l0', 'l1', 'l2'], 'all attempted');
});

test('a hostile release rejection folds to failed WITHOUT reading the thrown value; later leases still attempted', async () => {
  const store = new RecoveryStore(['l0', 'l1']);
  let touched = false;
  const hostile = new Proxy(
    {},
    {
      get() {
        touched = true;
        throw new Error('the thrown release value must never be read');
      },
    },
  );
  store.onRelease = (req) => (req.leaseId === 'l0' ? Promise.reject(hostile) : Promise.resolve({ outcome: 'released' }));
  const recovery = await genuineRecovery(store);
  const out = await releasePendingReplay(recovery);
  assert.equal(touched, false, 'the thrown value was never read or formatted');
  assert.deepEqual(out.attempts, [
    { leaseId: 'l0', result: 'failed' },
    { leaseId: 'l1', result: 'released' },
  ]);
  assert.equal(out.failedCount, 1);
  assert.equal(out.releasedCount, 1);
});

test('every malformed resolved release value maps to failed, never not_owner, and never escapes', async () => {
  const malformed: unknown[] = [
    null,
    undefined,
    7,
    'released', // a bare primitive, not { outcome: 'released' }
    {},
    { outcome: 'weird' },
    { outcome: 'refused' }, // missing reason
    { outcome: 'refused', reason: 'weird' }, // unknown reason
    { outcome: 'refused', reason: 'concurrency' }, // a reason foreign to release (belongs to another op)
    Object.defineProperty({}, 'outcome', { get() { throw new Error('hostile outcome getter'); } }),
    Object.defineProperty({ outcome: 'refused' }, 'reason', { get() { throw new Error('hostile reason getter'); } }),
    new Proxy({}, { get() { throw new Error('trapping proxy'); } }),
  ];
  for (let i = 0; i < malformed.length; i += 1) {
    const store = new RecoveryStore(['l0']);
    store.onRelease = () => Promise.resolve(malformed[i] as unknown as ReleaseResult);
    const recovery = await genuineRecovery(store);
    const out = await releasePendingReplay(recovery);
    assert.deepEqual(out.attempts, [{ leaseId: 'l0', result: 'failed' }], `malformed #${i} -> failed`);
    assert.equal(out.notOwnerCount, 0, `malformed #${i} is never not_owner`);
  }
});

// ===========================================================================
// dedup, counts, freeze, empty
// ===========================================================================

test('duplicate lease ids are attempted only on first occurrence, order stable', async () => {
  const store = new RecoveryStore(['l0', 'l0', 'l1', 'l0']);
  const recovery = await genuineRecovery(store);
  const out = await releasePendingReplay(recovery);
  assert.deepEqual(store.releaseCalls.map((c) => c.leaseId), ['l0', 'l1'], 'one store call per distinct id');
  assert.deepEqual(out.attempts.map((a) => a.leaseId), ['l0', 'l1']);
  assert.equal(out.releasedCount, 2);
});

test('each count equals its own tally in the single attempts array, and the outcome graph is deeply frozen', async () => {
  // Mixed outcomes so no count equals the lease/attempt total — a count derived from any separate
  // source (e.g. `leases.length`) diverges from its tally and reds here, not only by luck of a fixture.
  const store = new RecoveryStore(['l0', 'l1', 'l2']);
  store.onRelease = (req) =>
    req.leaseId === 'l0'
      ? Promise.resolve({ outcome: 'released' })
      : req.leaseId === 'l1'
        ? Promise.resolve({ outcome: 'refused', reason: 'not_owner' })
        : Promise.reject(new Error('transport failed'));
  const recovery = await genuineRecovery(store);
  const out = await releasePendingReplay(recovery);
  assert.equal(out.releasedCount, out.attempts.filter((a) => a.result === 'released').length);
  assert.equal(out.notOwnerCount, out.attempts.filter((a) => a.result === 'not_owner').length);
  assert.equal(out.failedCount, out.attempts.filter((a) => a.result === 'failed').length);
  assert.equal(out.releasedCount + out.notOwnerCount + out.failedCount, out.attempts.length);
  assert.notEqual(out.releasedCount, out.attempts.length, 'the fixture is mixed, so no count equals the total');
  // Deeply frozen + detached.
  assert.ok(Object.isFrozen(out), 'outcome frozen');
  assert.ok(Object.isFrozen(out.attempts), 'attempts array frozen');
  assert.ok(out.attempts.every((a) => Object.isFrozen(a)), 'each attempt frozen');
  assert.throws(() => (out.attempts as ReplayReleaseMutable[]).push({ leaseId: 'x', result: 'released' }));
});
type ReplayReleaseMutable = { leaseId: string; result: 'released' | 'not_owner' | 'failed' };

test('an empty authenticated lease list returns an empty frozen report with zero counts', async () => {
  const store = new RecoveryStore([]);
  const recovery = await genuineRecovery(store);
  const out = await releasePendingReplay(recovery);
  assert.deepEqual(out.attempts, []);
  assert.equal(out.releasedCount, 0);
  assert.equal(out.notOwnerCount, 0);
  assert.equal(out.failedCount, 0);
  assert.deepEqual(store.releaseCalls, []);
  assert.ok(Object.isFrozen(out));
});
