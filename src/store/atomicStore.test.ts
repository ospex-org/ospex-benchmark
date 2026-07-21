import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqlAtomicStore, StoreWireError, pgStoreQuery } from './atomicStore.js';
import { STORE_SCHEMA_VERSION } from './constants.js';
import type { StoreQuery } from './atomicStore.js';
import type {
  AcquireRepairLeaseRequest,
  AdmitDispatchRequest,
  CompleteClaimRequest,
  InitCohortBudgetRequest,
} from './contract.js';
import type { MarketKey } from '../types.js';

/**
 * Pure adapter tests (no DB): the adapter is executor-injectable, so a fake `StoreQuery`
 * lets us cover the client-side `invalid_input` taxonomy, the JSONB→union mapping for
 * every variant, and `StoreWireError` exhaustively. The DB-backed `atomicStore.conformance.ts`
 * gate proves these authored JSONB shapes are exactly what the real SQL emits (so this
 * suite is never validating against self-invented shapes alone).
 */

// A recording fake executor; `rows` is what it returns to the adapter.
function stub(rows: ReadonlyArray<Record<string, unknown>>): {
  store: SqlAtomicStore;
  calls: Array<{ sql: string; params: readonly unknown[] }>;
} {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const q: StoreQuery = async (sql, params) => {
    calls.push({ sql, params });
    return rows;
  };
  return { store: new SqlAtomicStore(q), calls };
}
const r = (result: unknown): ReadonlyArray<Record<string, unknown>> => [{ r: result }];
const H = (c: string): string => c.repeat(64); // a valid 64-char lowercase-hex digest (c must be a hex char)

const initReq: InitCohortBudgetRequest = {
  cohortId: 'c1',
  schemaVersion: STORE_SCHEMA_VERSION,
  callCap: 100,
  spendCapUsdMicros: 1000,
  concurrencyLimit: 10,
  rosterSize: 4,
  maxRepairsPerArm: 1,
  initialLeaseBoundMs: 600_000,
  repairLeaseBoundMs: 300_000,
};
const admitReq: AdmitDispatchRequest = {
  cohortId: 'c1',
  fireId: 'f1',
  ownerId: 'w1',
  expectedSchemaVersion: STORE_SCHEMA_VERSION,
  gameId: 'g1',
  proposedMarkets: ['moneyline', 'total'],
  scopeReservations: {
    moneyline: { spendReservationUsdMicros: 500, preparedBytesDigest: H('a') },
    total: { spendReservationUsdMicros: 500, preparedBytesDigest: H('b') },
    'moneyline+total': { spendReservationUsdMicros: 1000, preparedBytesDigest: H('c') },
  },
};
const repairReq: AcquireRepairLeaseRequest = { cohortId: 'c1', fireId: 'f1', ownerId: 'w1', armIndex: 0, repairOrdinal: 1, expectedSchemaVersion: STORE_SCHEMA_VERSION };
const completeReq: CompleteClaimRequest = { cohortId: 'c1', fireId: 'f1', expectedSchemaVersion: STORE_SCHEMA_VERSION };
const leaseJson = { leaseId: 'L1', armIndex: 0, expiresAt: '2026-07-19T00:00:00.000Z', state: 'live' };

// --- initCohortBudget ---

test('init: malformed pins refuse invalid_input without touching the DB', async () => {
  const bad: Array<Partial<InitCohortBudgetRequest>> = [
    { cohortId: '' },
    { schemaVersion: 1.5 },
    { callCap: -1 },
    { spendCapUsdMicros: Number.NaN },
    { concurrencyLimit: Number.MAX_SAFE_INTEGER + 1 },
    { rosterSize: -0.0001 },
    { repairLeaseBoundMs: Number.POSITIVE_INFINITY },
    // int4 fields: a safe JS integer above int4 max must still refuse (else a raw
    // `integer out of range` at the `(…)::int` cast, not a typed invalid_input).
    { schemaVersion: 2_147_483_648 },
    { concurrencyLimit: 2_147_483_648 },
    { rosterSize: 2_147_483_648 },
    { initialLeaseBoundMs: 2_147_483_648 },
    // derived call product rosterSize*(1+maxRepairs) overflows a safe integer (each operand
    // is a valid int4, but the product isn't) → refuse, else int4 overflow at admit.
    { rosterSize: 2_000_000_000, maxRepairsPerArm: 2_000_000_000 },
  ];
  for (const patch of bad) {
    const { store, calls } = stub(r({ outcome: 'initialized' }));
    assert.deepEqual(await store.initCohortBudget({ ...initReq, ...patch }), { outcome: 'refused', reason: 'invalid_input' }, JSON.stringify(patch));
    assert.equal(calls.length, 0, `executor must not be called for ${JSON.stringify(patch)}`);
  }
});

test('init: a bigint cap above int4 max is accepted (bigint fields are not over-restricted to int4)', async () => {
  const { store, calls } = stub(r({ outcome: 'initialized' }));
  assert.deepEqual(await store.initCohortBudget({ ...initReq, callCap: 5_000_000_000, spendCapUsdMicros: 9_000_000_000 }), { outcome: 'initialized' });
  assert.equal(calls.length, 1, 'a safe bigint above int4 max must pass client validation and reach the DB');
});

test('init: maxRepairsPerArm at int4 max (roster 1) is accepted — the derived product stays a safe integer', async () => {
  const { store, calls } = stub(r({ outcome: 'initialized' }));
  // product = 1 * (1 + 2147483647) = 2147483648: a safe int, so the adapter admits it; the SQL
  // must then compute the inner `1 + maxRepairs` in bigint (proven end-to-end in conformance).
  assert.deepEqual(await store.initCohortBudget({ ...initReq, rosterSize: 1, maxRepairsPerArm: 2_147_483_647 }), { outcome: 'initialized' });
  assert.equal(calls.length, 1);
});

test('init: maps initialized / config_mismatch / version_mismatch', async () => {
  assert.deepEqual(await stub(r({ outcome: 'initialized' })).store.initCohortBudget(initReq), { outcome: 'initialized' });
  assert.deepEqual(await stub(r({ outcome: 'refused', reason: 'config_mismatch' })).store.initCohortBudget(initReq), { outcome: 'refused', reason: 'config_mismatch' });
  assert.deepEqual(await stub(r({ outcome: 'refused', reason: 'version_mismatch' })).store.initCohortBudget(initReq), { outcome: 'refused', reason: 'version_mismatch' });
});

test('init: an off-contract DB shape throws StoreWireError', async () => {
  // init SQL never emits invalid_input (it casts pins) — a DB invalid_input is a skew.
  await assert.rejects(() => stub(r({ outcome: 'refused', reason: 'invalid_input' })).store.initCohortBudget(initReq), StoreWireError);
  await assert.rejects(() => stub(r({ outcome: 'bogus' })).store.initCohortBudget(initReq), StoreWireError);
  await assert.rejects(() => stub([]).store.initCohortBudget(initReq), StoreWireError); // 0 rows
  await assert.rejects(() => stub([{ r: { outcome: 'initialized' } }, { r: { outcome: 'initialized' } }]).store.initCohortBudget(initReq), StoreWireError); // 2 rows
});

test('init: sends the pinned config as one jsonb arg', async () => {
  const { store, calls } = stub(r({ outcome: 'initialized' }));
  await store.initCohortBudget(initReq);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /store\.init_cohort_budget\(\$1::jsonb\)/);
  assert.deepEqual(JSON.parse(calls[0]!.params[0] as string), {
    cohortId: 'c1',
    schemaVersion: STORE_SCHEMA_VERSION,
    callCap: 100,
    spendCapUsdMicros: 1000,
    concurrencyLimit: 10,
    rosterSize: 4,
    maxRepairsPerArm: 1,
    initialLeaseBoundMs: 600_000,
    repairLeaseBoundMs: 300_000,
  });
});

// --- admitDispatch ---

test('admit: malformed request refuses invalid_input (dispatchAuthorized false) without touching the DB', async () => {
  const bad: Array<Partial<AdmitDispatchRequest>> = [
    { cohortId: '' },
    { fireId: '' },
    { ownerId: '' },
    { gameId: '' },
    { expectedSchemaVersion: 2.5 },
    { proposedMarkets: [] },
    { proposedMarkets: ['total', 'moneyline'] }, // non-canonical
    { proposedMarkets: ['moneyline', 'moneyline'] }, // duplicate
    { proposedMarkets: ['x'] as unknown as MarketKey[] }, // unknown market
    { expectedSchemaVersion: 2_147_483_648 }, // above int4 max (p_ver)
    { cohortId: `c${String.fromCharCode(0)}` }, // a NUL in a text param (would raw-error)
    { scopeReservations: { moneyline: { spendReservationUsdMicros: -1, preparedBytesDigest: H('a') } } }, // negative spend
    { scopeReservations: { moneyline: { spendReservationUsdMicros: 1.5, preparedBytesDigest: H('a') } } }, // fractional spend
    { scopeReservations: { moneyline: { spendReservationUsdMicros: 1, preparedBytesDigest: '' } } }, // empty digest
    { scopeReservations: { moneyline: { spendReservationUsdMicros: 1, preparedBytesDigest: 'nothex-but-nonempty' } } }, // non-hex digest
    { scopeReservations: { moneyline: { spendReservationUsdMicros: 1, preparedBytesDigest: H('a').slice(0, 63) } } }, // wrong length
    { scopeReservations: { moneyline: { spendReservationUsdMicros: 1, preparedBytesDigest: 'A'.repeat(64) } } }, // uppercase, not lowercase hex
    { scopeReservations: { moneyline: { spendReservationUsdMicros: 1, preparedBytesDigest: `${H('a').slice(0, 63)}${String.fromCharCode(0)}` } } }, // NUL in digest (would raw 22P05)
  ];
  for (const patch of bad) {
    const { store, calls } = stub(r({ outcome: 'admitted' }));
    assert.deepEqual(await store.admitDispatch({ ...admitReq, ...patch }), { outcome: 'refused', reason: 'invalid_input', dispatchAuthorized: false }, JSON.stringify(patch));
    assert.equal(calls.length, 0, `executor must not be called for ${JSON.stringify(patch)}`);
  }
});

test('admit: maps admitted / replayed(pending,completed) / refused / error', async () => {
  const claimed = [{ gameId: 'g1', market: 'moneyline' }];
  assert.deepEqual(
    await stub(r({ outcome: 'admitted', claimedKeys: claimed, preparedBytesDigest: H('c'), initialLeases: [leaseJson], dispatchAuthorized: true })).store.admitDispatch(admitReq),
    { outcome: 'admitted', claimedKeys: claimed, preparedBytesDigest: H('c'), initialLeases: [leaseJson], dispatchAuthorized: true },
  );
  assert.deepEqual(
    await stub(r({ outcome: 'replayed', fireStatus: 'pending', claimedKeys: claimed, initialLeases: [leaseJson], dispatchAuthorized: false })).store.admitDispatch(admitReq),
    { outcome: 'replayed', fireStatus: 'pending', claimedKeys: claimed, initialLeases: [leaseJson], dispatchAuthorized: false },
  );
  const completedReplay = await stub(r({ outcome: 'replayed', fireStatus: 'completed', claimedKeys: claimed, dispatchAuthorized: false })).store.admitDispatch(admitReq);
  assert.deepEqual(completedReplay, { outcome: 'replayed', fireStatus: 'completed', claimedKeys: claimed, dispatchAuthorized: false });
  assert.ok(!('initialLeases' in completedReplay), 'a completed replay carries no leases');
  for (const reason of ['not_initialized', 'version_mismatch', 'invalid_input', 'all_claimed', 'scope_reservation_missing', 'call_cap', 'spend_cap', 'concurrency'] as const) {
    assert.deepEqual(await stub(r({ outcome: 'refused', reason, dispatchAuthorized: false })).store.admitDispatch(admitReq), { outcome: 'refused', reason, dispatchAuthorized: false });
  }
  assert.deepEqual(await stub(r({ outcome: 'error', reason: 'fire_id_key_mismatch', dispatchAuthorized: false })).store.admitDispatch(admitReq), { outcome: 'error', reason: 'fire_id_key_mismatch', dispatchAuthorized: false });
});

test('admit: off-contract shapes throw StoreWireError', async () => {
  const claimed = [{ gameId: 'g1', market: 'moneyline' }];
  const okAdmitted = { outcome: 'admitted', claimedKeys: claimed, preparedBytesDigest: H('c'), initialLeases: [leaseJson], dispatchAuthorized: true };
  await assert.rejects(() => stub(r({ outcome: 'replayed', fireStatus: 'pending', claimedKeys: [], dispatchAuthorized: false })).store.admitDispatch(admitReq), StoreWireError); // pending missing leases
  await assert.rejects(() => stub(r({ outcome: 'admitted' })).store.admitDispatch(admitReq), StoreWireError); // missing fields
  await assert.rejects(() => stub(r({ outcome: 'refused', reason: 'nope', dispatchAuthorized: false })).store.admitDispatch(admitReq), StoreWireError); // unknown reason
  // strict: an unknown extra field is a skew, not silently stripped.
  await assert.rejects(() => stub(r({ ...okAdmitted, surprise: 1 })).store.admitDispatch(admitReq), StoreWireError);
  // a completed replay carrying forbidden leases must throw, not be silently rewritten.
  await assert.rejects(() => stub(r({ outcome: 'replayed', fireStatus: 'completed', claimedKeys: claimed, initialLeases: [leaseJson], dispatchAuthorized: false })).store.admitDispatch(admitReq), StoreWireError);
  // result semantics: bad lease instant, empty lease id, empty / non-hex result digest.
  await assert.rejects(() => stub(r({ ...okAdmitted, initialLeases: [{ ...leaseJson, expiresAt: 'not-an-instant' }] })).store.admitDispatch(admitReq), StoreWireError);
  await assert.rejects(() => stub(r({ ...okAdmitted, initialLeases: [{ ...leaseJson, leaseId: '' }] })).store.admitDispatch(admitReq), StoreWireError);
  await assert.rejects(() => stub(r({ ...okAdmitted, preparedBytesDigest: '' })).store.admitDispatch(admitReq), StoreWireError);
  await assert.rejects(() => stub(r({ ...okAdmitted, preparedBytesDigest: 'nothex' })).store.admitDispatch(admitReq), StoreWireError);
});

test('admit: maps the request to positional args + a {spend,digest} scope jsonb', async () => {
  const { store, calls } = stub(r({ outcome: 'admitted', claimedKeys: [], preparedBytesDigest: H('a'), initialLeases: [], dispatchAuthorized: true }));
  await store.admitDispatch(admitReq);
  const { sql, params } = calls[0]!;
  assert.match(sql, /store\.admit_dispatch\(\$1,\$2,\$3,\$4,\$5,\$6::jsonb,\$7::jsonb\)/);
  assert.deepEqual(params.slice(0, 5), ['c1', 'f1', 'w1', STORE_SCHEMA_VERSION, 'g1']);
  assert.deepEqual(JSON.parse(params[5] as string), ['moneyline', 'total']);
  assert.deepEqual(JSON.parse(params[6] as string), {
    moneyline: { spend: 500, digest: H('a') },
    total: { spend: 500, digest: H('b') },
    'moneyline+total': { spend: 1000, digest: H('c') },
  });
});

// --- acquireRepairLease ---

test('repair: malformed request refuses invalid_input without touching the DB', async () => {
  const bad: Array<Partial<AcquireRepairLeaseRequest>> = [
    { cohortId: '' },
    { fireId: '' },
    { armIndex: -1 },
    { armIndex: 0.5 },
    { armIndex: 2_147_483_648 }, // above int4 max (p_arm)
    { repairOrdinal: 0 }, // below 1
    { repairOrdinal: 1.5 },
    { repairOrdinal: 2_147_483_648 }, // above int4 max (p_ordinal)
    { expectedSchemaVersion: -1 },
  ];
  for (const patch of bad) {
    const { store, calls } = stub(r({ outcome: 'acquired', lease: leaseJson, requestAuthorized: true }));
    assert.deepEqual(await store.acquireRepairLease({ ...repairReq, ...patch }), { outcome: 'refused', reason: 'invalid_input', requestAuthorized: false }, JSON.stringify(patch));
    assert.equal(calls.length, 0, `executor must not be called for ${JSON.stringify(patch)}`);
  }
});

test('repair: maps acquired / replayed / refused', async () => {
  assert.deepEqual(await stub(r({ outcome: 'acquired', lease: leaseJson, requestAuthorized: true })).store.acquireRepairLease(repairReq), { outcome: 'acquired', lease: leaseJson, requestAuthorized: true });
  assert.deepEqual(await stub(r({ outcome: 'replayed', lease: leaseJson, requestAuthorized: false })).store.acquireRepairLease(repairReq), { outcome: 'replayed', lease: leaseJson, requestAuthorized: false });
  for (const reason of ['not_initialized', 'version_mismatch', 'invalid_input', 'fire_not_pending', 'invalid_arm', 'invalid_attempt', 'repair_limit', 'call_reserved_exhausted', 'concurrency', 'not_owner'] as const) {
    assert.deepEqual(await stub(r({ outcome: 'refused', reason, requestAuthorized: false })).store.acquireRepairLease(repairReq), { outcome: 'refused', reason, requestAuthorized: false });
  }
});

// --- releaseLease ---

test('release: maps released / not_owner and always calls the DB (no invalid_input)', async () => {
  const rel = stub(r({ outcome: 'released' }));
  assert.deepEqual(await rel.store.releaseLease({ leaseId: 'L1', ownerId: 'w1' }), { outcome: 'released' });
  assert.equal(rel.calls.length, 1);
  assert.match(rel.calls[0]!.sql, /store\.release_lease\(\$1,\$2\)/);
  assert.deepEqual(await stub(r({ outcome: 'refused', reason: 'not_owner' })).store.releaseLease({ leaseId: 'L1', ownerId: 'w1' }), { outcome: 'refused', reason: 'not_owner' });
});

// --- completeClaim ---

test('complete: a present malformed actual refuses invalid_input; omitted actuals pass through as null', async () => {
  const bad: Array<Partial<CompleteClaimRequest>> = [
    { cohortId: '' },
    { fireId: '' },
    { actualCalls: -1 },
    { actualCalls: 1.5 },
    { actualSpendUsdMicros: Number.MAX_SAFE_INTEGER + 1 },
    { expectedSchemaVersion: Number.NaN },
    { expectedSchemaVersion: 2_147_483_648 }, // above int4 max (p_ver)
  ];
  for (const patch of bad) {
    const { store, calls } = stub(r({ outcome: 'completed' }));
    assert.deepEqual(await store.completeClaim({ ...completeReq, ...patch }), { outcome: 'refused', reason: 'invalid_input' }, JSON.stringify(patch));
    assert.equal(calls.length, 0, `executor must not be called for ${JSON.stringify(patch)}`);
  }
  const omitted = stub(r({ outcome: 'completed' }));
  await omitted.store.completeClaim(completeReq);
  assert.deepEqual(omitted.calls[0]!.params, ['c1', 'f1', STORE_SCHEMA_VERSION, null, null]);
  const present = stub(r({ outcome: 'completed' }));
  await present.store.completeClaim({ ...completeReq, actualCalls: 4, actualSpendUsdMicros: 250 });
  assert.deepEqual(present.calls[0]!.params, ['c1', 'f1', STORE_SCHEMA_VERSION, 4, 250]);
});

test('complete: maps completed / refused', async () => {
  assert.deepEqual(await stub(r({ outcome: 'completed' })).store.completeClaim(completeReq), { outcome: 'completed' });
  for (const reason of ['version_mismatch', 'invariant_breach', 'invalid_input'] as const) {
    assert.deepEqual(await stub(r({ outcome: 'refused', reason })).store.completeClaim(completeReq), { outcome: 'refused', reason });
  }
});

// --- pgStoreQuery ---

test('pgStoreQuery: extracts rows from a pg-shaped result', async () => {
  const q = pgStoreQuery({ query: async () => ({ rows: [{ r: { outcome: 'released' } }] }) });
  assert.deepEqual(await q('select store.release_lease($1,$2) as r', ['L1', 'w1']), [{ r: { outcome: 'released' } }]);
});
