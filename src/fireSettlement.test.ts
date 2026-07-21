import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCompleteResult, settleCompletedFire } from './fireSettlement.js';
import { StoreClaimPort } from './lineOpenClaim.js';
import type { DispatchPermit } from './lineOpenClaim.js';
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
  RepairLeaseResult,
} from './store/contract.js';

/**
 * Post-install claim settlement: the total classification of a store completion result and the
 * settle capability resolution. No provider, database, or live path is contacted — a genuine permit is
 * minted by a real `StoreClaimPort` over a scripted store, and hostile/malformed runtime values are
 * fed directly to the classifier.
 */

const COHORT = 'c'.repeat(64);
const FIRE = 'f'.repeat(64);
const GAME = '00000000-0000-4000-8000-0000000000f1';
const OWNER = 'owner-host-1234-abc';
const DIGEST = 'a'.repeat(64);

/** A minimal store that auto-admits one moneyline claim and records/scripts `completeClaim`. */
class MiniStore implements AtomicStore {
  readonly completeCalls: CompleteClaimRequest[] = [];
  onComplete: (req: CompleteClaimRequest) => Promise<CompleteResult> = () => Promise.resolve({ outcome: 'completed' });

  initCohortBudget(_req: InitCohortBudgetRequest): Promise<InitResult> {
    throw new Error('not used');
  }
  admitDispatch(req: AdmitDispatchRequest): Promise<AdmitResult> {
    return Promise.resolve({
      outcome: 'admitted',
      claimedKeys: req.proposedMarkets.map((market) => ({ gameId: req.gameId, market })),
      preparedBytesDigest: DIGEST,
      initialLeases: req.proposedMarkets.map((_, i) => ({
        leaseId: `lease-${i}`,
        armIndex: i,
        expiresAt: '2026-07-18T12:10:00.000Z',
        state: 'live' as const,
      })),
      dispatchAuthorized: true,
    });
  }
  acquireRepairLease(_req: AcquireRepairLeaseRequest): Promise<RepairLeaseResult> {
    return Promise.resolve({ outcome: 'refused', reason: 'concurrency', requestAuthorized: false });
  }
  releaseLease(_req: ReleaseLeaseRequest): Promise<{ outcome: 'released' }> {
    return Promise.resolve({ outcome: 'released' });
  }
  completeClaim(req: CompleteClaimRequest): Promise<CompleteResult> {
    this.completeCalls.push(req);
    return this.onComplete(req);
  }
}

async function genuinePermit(store: MiniStore): Promise<DispatchPermit> {
  const outcome = await new StoreClaimPort(store).admit({
    cohortId: COHORT,
    fireId: FIRE,
    ownerId: OWNER,
    expectedSchemaVersion: SCHEMA,
    gameId: GAME,
    proposedMarkets: ['moneyline'],
    scopeReservations: { moneyline: { spendReservationUsdMicros: 1, preparedBytesDigest: DIGEST } },
  });
  if (outcome.kind !== 'Authorized') throw new Error(`expected Authorized, got ${outcome.kind}`);
  return outcome.permit;
}

// ===========================================================================
// classifyCompleteResult — total over every resolved runtime value
// ===========================================================================

test('a completed result classifies as settled', () => {
  assert.deepEqual(classifyCompleteResult({ outcome: 'completed' }), { status: 'settled' });
});

test('each known refusal classifies as its exact unsettled reason', () => {
  for (const reason of ['version_mismatch', 'invariant_breach', 'invalid_input'] as const) {
    assert.deepEqual(classifyCompleteResult({ outcome: 'refused', reason }), { status: 'unsettled', reason });
  }
});

test('every malformed / hostile resolved value folds to store_result_mismatch, never escaping', () => {
  const mismatch = { status: 'unsettled', reason: 'store_result_mismatch' } as const;
  const hostile: unknown[] = [
    null,
    undefined,
    7,
    'x',
    true,
    {},
    { outcome: 'weird' },
    { outcome: 'refused' }, // known outcome, missing reason
    { outcome: 'refused', reason: 'weird' }, // known outcome, unknown reason
    { outcome: 'refused', reason: 'not_owner' }, // a reason foreign to completion (belongs to another op)
    Object.defineProperty({}, 'outcome', { get() { throw new Error('hostile outcome getter'); } }),
    Object.defineProperty({ outcome: 'refused' }, 'reason', { get() { throw new Error('hostile reason getter'); } }),
    new Proxy({}, { get() { throw new Error('trapping proxy'); } }),
  ];
  // Use the index in the message, never `String(value)` — a trapping proxy throws on any coercion.
  hostile.forEach((value, i) => {
    assert.deepEqual(
      classifyCompleteResult(value as unknown as CompleteResult),
      mismatch,
      `hostile value #${i} folds to a fixed mismatch`,
    );
  });
});

// ===========================================================================
// settleCompletedFire — resolve, invoke, classify
// ===========================================================================

test('a genuine settle that completes returns settled and sends exactly the captured identity', async () => {
  const store = new MiniStore();
  const permit = await genuinePermit(store);
  const status = await settleCompletedFire(permit);
  assert.deepEqual(status, { status: 'settled' });
  assert.equal(store.completeCalls.length, 1);
  assert.deepEqual(Object.keys(store.completeCalls[0]!).sort(), ['cohortId', 'expectedSchemaVersion', 'fireId']);
});

test('a store refusal folds to the exact typed unsettled reason', async () => {
  for (const reason of ['version_mismatch', 'invariant_breach', 'invalid_input'] as const) {
    const store = new MiniStore();
    const permit = await genuinePermit(store);
    store.onComplete = () => Promise.resolve({ outcome: 'refused', reason });
    assert.deepEqual(await settleCompletedFire(permit), { status: 'unsettled', reason });
  }
});

test('a complete() rejection folds to store_complete_failed WITHOUT reading the thrown value', async () => {
  const store = new MiniStore();
  const permit = await genuinePermit(store);
  let touched = false;
  const hostile = new Proxy(
    {},
    {
      get() {
        touched = true;
        throw new Error('the thrown value must never be read');
      },
    },
  );
  store.onComplete = () => Promise.reject(hostile);
  const status = await settleCompletedFire(permit);
  assert.deepEqual(status, { status: 'unsettled', reason: 'store_complete_failed' });
  assert.equal(touched, false, 'the thrown value was never read, coerced, or formatted');
});

test('a resolved malformed value from complete() folds to store_result_mismatch', async () => {
  const store = new MiniStore();
  const permit = await genuinePermit(store);
  store.onComplete = () => Promise.resolve(null as unknown as CompleteResult);
  assert.deepEqual(await settleCompletedFire(permit), { status: 'unsettled', reason: 'store_result_mismatch' });
});

test('a forged or substituted permit propagates its brand assertion — never a soft unsettled', async () => {
  const store = new MiniStore();
  const permit = await genuinePermit(store);
  await assert.rejects(
    () => settleCompletedFire({ ...permit }),
    /not minted by a store admission|forged|substituted/,
  );
  // A genuine permit never rejects; the resolution is proven-infallible for it.
  await assert.doesNotReject(() => settleCompletedFire(permit));
});
