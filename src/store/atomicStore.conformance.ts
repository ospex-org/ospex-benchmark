/**
 * Adapter conformance against REAL Postgres (SPEC-atomic-store.md): the `SqlAtomicStore`
 * driven over the checked-in SQL functions. It proves what the pure `atomicStore.test.ts`
 * suite cannot — that the adapter's zod result schemas accept EXACTLY the JSONB every SQL
 * branch emits, the request→arg mapping drives the functions end-to-end, AND (the
 * conformance gate F5 depends on) that the adapter is correct under GENUINELY OVERLAPPING
 * transactions and crash/restart. The overlap is proven three ways: a held-row BARRIER with
 * asserted lock-waits on distinct backends (case 8 claim race, case 25 budget race,
 * same-fireId, and the admit-vs-repair ceiling race — §13 row 8) — a serialized run cannot
 * pass these, since both competitors must be simultaneously lock-waiting before the gate
 * opens; an unbarriered concurrent STRESS race (budget stress, guarded against silent
 * serialization); and SEQUENTIAL release/expiry/crash tests driven across transactions
 * (cases 45/46, completion, crash/restart §8). Mirrors the SQL spike's setup (drop + apply
 * schema/functions on a scratch DB). NOT part of `yarn test` (that suite is pure and DB-free).
 *
 * Run: `docker run` a Postgres, then `STORE_DATABASE_URL=… yarn store:adapter`
 * (defaults to the spike's local Docker Postgres).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { sha256Hex } from '../canonical.js';
import { SqlAtomicStore, pgStoreQuery } from './atomicStore.js';
import type { AdmitDispatchRequest, AdmitResult, InitCohortBudgetRequest, RepairLeaseResult, ScopeKey } from './contract.js';
import type { MarketKey } from '../types.js';

const DATABASE_URL = process.env.STORE_DATABASE_URL ?? 'postgres://postgres:spike@localhost:5433/store_spike';
const SCHEMA_SQL = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const FUNCTIONS_SQL = readFileSync(new URL('./functions.sql', import.meta.url), 'utf8');

const VER = 1;
let nonce = 0;
const cohortName = (label: string): string => `adapter-${label}-${process.pid}-${(nonce += 1)}`;

function pins(cohortId: string, over: Partial<InitCohortBudgetRequest> = {}): InitCohortBudgetRequest {
  return {
    cohortId,
    schemaVersion: VER,
    callCap: 1_000_000,
    spendCapUsdMicros: 1_000_000_000,
    concurrencyLimit: 100,
    rosterSize: 4,
    maxRepairsPerArm: 1,
    initialLeaseBoundMs: 600_000,
    repairLeaseBoundMs: 300_000,
    ...over,
  };
}

const digestOf = (label: string): string => sha256Hex(label); // a real sha256-hex digest (the adapter validates the format)
// Contract-shaped scope reservations (the adapter maps these → the SQL {spend,digest}).
function scope(markets: MarketKey[]): AdmitDispatchRequest['scopeReservations'] {
  const subsets: MarketKey[][] = markets.length === 1 ? [markets] : [[markets[0]!], [markets[1]!], markets];
  const out: Partial<Record<ScopeKey, { spendReservationUsdMicros: number; preparedBytesDigest: string }>> = {};
  for (const s of subsets) out[s.join('+') as ScopeKey] = { spendReservationUsdMicros: 1000, preparedBytesDigest: digestOf(s.join('')) };
  return out;
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    console.log(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Concurrency machinery — genuinely overlapping transactions THROUGH the adapter (the
// conformance gate F5 depends on): each worker is a SqlAtomicStore over its OWN pooled
// backend (distinct pg_backend_pid), so a race is real and each backend's lock-wait is
// observable. Mocks cannot substitute for actual overlapping transactions (SPEC §12).
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Tracked<T> { promise: Promise<T>; settled: () => boolean; }
function track<T>(p: Promise<T>): Tracked<T> {
  let done = false;
  const promise = p.then((v) => { done = true; return v; }, (e: unknown) => { done = true; throw e; });
  return { promise, settled: () => done };
}

interface Worker { store: SqlAtomicStore; client: PoolClient; pid: number; }
async function makeWorkers(pool: Pool, n: number): Promise<Worker[]> {
  const out: Worker[] = [];
  try {
    for (let i = 0; i < n; i += 1) {
      const client = await pool.connect();
      const pid = Number((await client.query('select pg_backend_pid() as pid')).rows[0]!.pid);
      out.push({ store: new SqlAtomicStore(pgStoreQuery(client)), client, pid });
    }
  } catch (err) {
    for (const w of out) w.client.release();
    throw err;
  }
  const pids = new Set(out.map((w) => w.pid));
  assert.equal(pids.size, n, `expected ${n} distinct backend PIDs, got ${JSON.stringify([...pids])}`);
  return out;
}

async function bothLockWaiting(pool: Pool, pids: number[], timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const { rows } = await pool.query('select pid, state, wait_event_type from pg_stat_activity where pid = any($1::int[])', [pids]);
    const waiting = rows.filter((r) => r.state === 'active' && r.wait_event_type === 'Lock');
    if (waiting.length === pids.length) return;
    if (Date.now() - start > timeoutMs) throw new Error(`barrier: expected ${pids.length} sessions Lock-waiting; saw ${JSON.stringify(rows)}`);
    await sleep(25);
  }
}

// Race two adapter operations (distinct backends) behind a gate holding the cohort's budget
// row: both are asserted Lock-waiting + unresolved before the gate opens, then the store's own
// FOR UPDATE serializes them. Proves the ADAPTER (not just the SQL) is correct under overlap.
// Generic over the two op result types so an admit can race a repair-acquire (§13 row 8).
async function withGate<A, B>(
  pool: Pool,
  cohortId: string,
  buildA: (store: SqlAtomicStore) => Promise<A>,
  buildB: (store: SqlAtomicStore) => Promise<B>,
  after: (a: A, b: B) => Promise<void>,
): Promise<void> {
  const [gate, wa, wb] = (await makeWorkers(pool, 3)) as [Worker, Worker, Worker];
  let ta: Tracked<A> | null = null;
  let tb: Tracked<B> | null = null;
  try {
    await gate.client.query('begin');
    await gate.client.query('select 1 from store.cohort_budget where cohort_id=$1 for update', [cohortId]);
    ta = track(buildA(wa.store));
    tb = track(buildB(wb.store));
    await bothLockWaiting(pool, [wa.pid, wb.pid]);
    assert.ok(!ta.settled() && !tb.settled(), 'both adapter ops must block on the budget lock before release');
    await gate.client.query('rollback');
    const [a, b] = await Promise.all([ta.promise, tb.promise]);
    await after(a, b);
  } finally {
    try { await gate.client.query('rollback'); } catch { /* already ended */ }
    if (ta) await ta.promise.catch(() => undefined);
    if (tb) await tb.promise.catch(() => undefined);
    gate.client.release(); wa.client.release(); wb.client.release();
  }
}

async function main(): Promise<void> {
  // max 12 gives headroom for the 8-worker stress + the 3-client barriers; connectionTimeout
  // so a starved pool throws rather than hangs.
  const pool = new Pool({ connectionString: DATABASE_URL, max: 12, connectionTimeoutMillis: 8000 });
  await pool.query('drop schema if exists store cascade');
  await pool.query(SCHEMA_SQL);
  await pool.query(FUNCTIONS_SQL);

  const store = new SqlAtomicStore(pgStoreQuery(pool));
  const claimCount = async (c: string): Promise<number> => Number((await pool.query('select count(*) as v from store.claims where cohort_id=$1', [c])).rows[0]!.v);
  const callsReserved = async (c: string): Promise<number> => Number((await pool.query('select calls_reserved as v from store.cohort_budget where cohort_id=$1', [c])).rows[0]!.v);
  const activeSlots = async (c: string): Promise<number> =>
    Number((await pool.query('select coalesce(sum(1),0) as v from store.concurrency_leases where cohort_id=$1 and released_at is null and expires_at > now()', [c])).rows[0]!.v);
  const claimStatus = async (c: string, g: string, m: string): Promise<string | null> =>
    (((await pool.query('select status as v from store.claims where cohort_id=$1 and game_id=$2 and market=$3', [c, g, m])).rows[0]?.v) ?? null) as string | null;
  const initialLeaseCount = async (c: string, f: string): Promise<number> =>
    Number((await pool.query("select count(*) as v from store.concurrency_leases where cohort_id=$1 and fire_id=$2 and attempt_kind='initial'", [c, f])).rows[0]!.v);
  // Guard the unbarriered stress races: if the pool can't supply the fan-out width, they would
  // silently serialize and lose their concurrency coverage. Fail loud instead.
  const FANOUT = 8;
  const assertPoolParallel = (): void => assert.ok((pool.options.max ?? 0) >= FANOUT, `stress fan-out needs pool max >= ${FANOUT}`);

  // --- the mapped happy-path lifecycle ---
  await check('lifecycle: init → admit(admitted) → acquireRepair(acquired) → release → complete(completed)', async () => {
    const c = cohortName('life');
    assert.deepEqual(await store.initCohortBudget(pins(c)), { outcome: 'initialized' });
    const a = await store.admitDispatch({ cohortId: c, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline', 'total'], scopeReservations: scope(['moneyline', 'total']) });
    assert.equal(a.outcome, 'admitted');
    assert.equal(a.dispatchAuthorized, true);
    if (a.outcome !== 'admitted') throw new Error('unreachable');
    assert.equal(a.initialLeases.length, 4);
    assert.equal(typeof a.preparedBytesDigest, 'string');
    const rep = await store.acquireRepairLease({ cohortId: c, fireId: 'f1', ownerId: 'w1', armIndex: 0, repairOrdinal: 1, expectedSchemaVersion: VER });
    assert.equal(rep.outcome, 'acquired');
    assert.equal(rep.requestAuthorized, true);
    if (rep.outcome !== 'acquired') throw new Error('unreachable');
    assert.equal((await store.releaseLease({ leaseId: rep.lease.leaseId, ownerId: 'w1' })).outcome, 'released');
    assert.deepEqual(await store.completeClaim({ cohortId: c, fireId: 'f1', expectedSchemaVersion: VER }), { outcome: 'completed' });
  });

  // --- idempotent replay: pending (leases) then completed (no leases) ---
  await check('idempotency: same-fireId re-admit replays pending (with leases) then completed (no leases)', async () => {
    const c = cohortName('replay');
    await store.initCohortBudget(pins(c));
    const req = { cohortId: c, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'] as MarketKey[], scopeReservations: scope(['moneyline']) };
    assert.equal((await store.admitDispatch(req)).outcome, 'admitted');
    const rp = await store.admitDispatch(req);
    assert.equal(rp.outcome, 'replayed');
    if (rp.outcome !== 'replayed') throw new Error('unreachable');
    assert.equal(rp.fireStatus, 'pending');
    assert.ok('initialLeases' in rp && rp.initialLeases.length === 4, 'pending replay returns the retained leases');
    await store.completeClaim({ cohortId: c, fireId: 'f1', expectedSchemaVersion: VER });
    const rc = await store.admitDispatch(req);
    assert.equal(rc.outcome, 'replayed');
    if (rc.outcome !== 'replayed') throw new Error('unreachable');
    assert.equal(rc.fireStatus, 'completed');
    assert.ok(!('initialLeases' in rc), 'completed replay carries no leases');
  });

  // --- every real SQL refusal maps through the adapter's schemas ---
  await check('admit refusals: not_initialized / version_mismatch / all_claimed / scope_reservation_missing / call_cap / concurrency', async () => {
    const noinit = cohortName('noinit');
    const notInit = await store.admitDispatch({ cohortId: noinit, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal(notInit.outcome === 'refused' && notInit.reason, 'not_initialized');

    const c = cohortName('refuse');
    await store.initCohortBudget(pins(c));
    const wrongVer = await store.admitDispatch({ cohortId: c, fireId: 'fv', ownerId: 'w1', expectedSchemaVersion: 999, gameId: 'gv', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal(wrongVer.outcome === 'refused' && wrongVer.reason, 'version_mismatch');
    // claim g1/moneyline with fA, then a different fire on the same key → all_claimed
    await store.admitDispatch({ cohortId: c, fireId: 'fA', ownerId: 'wA', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    const claimed = await store.admitDispatch({ cohortId: c, fireId: 'fB', ownerId: 'wB', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal(claimed.outcome === 'refused' && claimed.reason, 'all_claimed');
    // scope map missing the retained subset → scope_reservation_missing
    const missing = await store.admitDispatch({ cohortId: c, fireId: 'fS', ownerId: 'wS', expectedSchemaVersion: VER, gameId: 'gS', proposedMarkets: ['moneyline'], scopeReservations: { total: { spendReservationUsdMicros: 1000, preparedBytesDigest: digestOf('total') } } });
    assert.equal(missing.outcome === 'refused' && missing.reason, 'scope_reservation_missing');

    const cap = cohortName('cap');
    await store.initCohortBudget(pins(cap, { callCap: 8 })); // exactly one dispatch fits
    await store.admitDispatch({ cohortId: cap, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    const overCap = await store.admitDispatch({ cohortId: cap, fireId: 'f2', ownerId: 'w2', expectedSchemaVersion: VER, gameId: 'g2', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal(overCap.outcome === 'refused' && overCap.reason, 'call_cap');

    const conc = cohortName('conc');
    await store.initCohortBudget(pins(conc, { concurrencyLimit: 4 }));
    await store.admitDispatch({ cohortId: conc, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    const overConc = await store.admitDispatch({ cohortId: conc, fireId: 'f2', ownerId: 'w2', expectedSchemaVersion: VER, gameId: 'g2', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal(overConc.outcome === 'refused' && overConc.reason, 'concurrency');
  });

  // --- config_mismatch on a conflicting re-init ---
  await check('init: a conflicting re-init maps config_mismatch (no reset)', async () => {
    const c = cohortName('reinit');
    await store.initCohortBudget(pins(c));
    assert.deepEqual(await store.initCohortBudget(pins(c)), { outcome: 'initialized' }); // consistent re-init
    assert.deepEqual(await store.initCohortBudget(pins(c, { callCap: 42 })), { outcome: 'refused', reason: 'config_mismatch' });
  });

  // --- repair + complete refusals from real SQL ---
  await check('repair/complete refusals: not_owner / repair_limit / fire_not_pending / invariant_breach', async () => {
    const c = cohortName('rc');
    await store.initCohortBudget(pins(c, { rosterSize: 2, maxRepairsPerArm: 1, concurrencyLimit: 8 }));
    await store.admitDispatch({ cohortId: c, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal((await store.acquireRepairLease({ cohortId: c, fireId: 'f1', ownerId: 'w1', armIndex: 0, repairOrdinal: 1, expectedSchemaVersion: VER })).outcome, 'acquired');
    const notOwner = await store.acquireRepairLease({ cohortId: c, fireId: 'f1', ownerId: 'intruder', armIndex: 0, repairOrdinal: 1, expectedSchemaVersion: VER });
    assert.equal(notOwner.outcome === 'refused' && notOwner.reason, 'not_owner');
    const overLimit = await store.acquireRepairLease({ cohortId: c, fireId: 'f1', ownerId: 'w1', armIndex: 0, repairOrdinal: 2, expectedSchemaVersion: VER });
    assert.equal(overLimit.outcome === 'refused' && overLimit.reason, 'repair_limit');
    // out-of-interval actual → invariant_breach (a NEGATIVE actual would be caught client-side)
    const breach = await store.completeClaim({ cohortId: c, fireId: 'f1', expectedSchemaVersion: VER, actualCalls: 9_999 });
    assert.equal(breach.outcome === 'refused' && breach.reason, 'invariant_breach');
    // after a clean completion the fire is no longer pending → repair fire_not_pending
    await store.completeClaim({ cohortId: c, fireId: 'f1', expectedSchemaVersion: VER });
    const done = await store.acquireRepairLease({ cohortId: c, fireId: 'f1', ownerId: 'w1', armIndex: 1, repairOrdinal: 1, expectedSchemaVersion: VER });
    assert.equal(done.outcome === 'refused' && done.reason, 'fire_not_pending');
  });

  // --- client-side invalid_input writes NOTHING to the DB ---
  await check('client-side invalid_input (negative spend + malformed digest) refuses before the DB and writes nothing', async () => {
    const c = cohortName('badinput');
    await store.initCohortBudget(pins(c));
    const negSpend = await store.admitDispatch({ cohortId: c, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: { moneyline: { spendReservationUsdMicros: -100, preparedBytesDigest: digestOf('m') } } });
    assert.equal(negSpend.outcome === 'refused' && negSpend.reason, 'invalid_input');
    // a malformed (non-hex) digest must ALSO refuse before the DB — else a raw 22P05.
    const badDigest = await store.admitDispatch({ cohortId: c, fireId: 'f2', ownerId: 'w2', expectedSchemaVersion: VER, gameId: 'g2', proposedMarkets: ['moneyline'], scopeReservations: { moneyline: { spendReservationUsdMicros: 100, preparedBytesDigest: 'not-a-sha256' } } });
    assert.equal(badDigest.outcome === 'refused' && badDigest.reason, 'invalid_input');
    assert.equal(await claimCount(c), 0);
    assert.equal(await callsReserved(c), 0);
  });

  // --- the derived call product: bigint SQL arithmetic (no raw overflow) + the client guard ---
  await check('derived product: a large-but-safe roster yields a TYPED cap refusal (not a raw int4 overflow); a product beyond safe-int refuses invalid_input', async () => {
    // rosterSize*(1+maxRepairs) = 50000*50001 ≈ 2.5e9 — over int4 max, under 2^53. With the
    // SQL computing the product in bigint, admit gives a TYPED call_cap refusal, not raw 22003.
    const big = cohortName('bigroster');
    await store.initCohortBudget(pins(big, { rosterSize: 50_000, maxRepairsPerArm: 50_000, callCap: 1_000_000 }));
    const refused = await store.admitDispatch({ cohortId: big, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal(refused.outcome === 'refused' && refused.reason, 'call_cap');
    // boundary: maxRepairsPerArm at int4 max, roster 1 → the INNER `1 + maxRepairs` must also
    // be bigint (the product 2147483648 is a safe int, so the adapter admits it to the DB); a
    // raw 22003 here means the inner addition wasn't promoted.
    const edge = cohortName('addedge');
    await store.initCohortBudget(pins(edge, { rosterSize: 1, maxRepairsPerArm: 2_147_483_647, callCap: 1_000_000 }));
    const edgeRefused = await store.admitDispatch({ cohortId: edge, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal(edgeRefused.outcome === 'refused' && edgeRefused.reason, 'call_cap');
    // a product that overflows a safe integer is refused at init, before any DB row exists.
    const over = cohortName('overproduct');
    assert.deepEqual(await store.initCohortBudget(pins(over, { rosterSize: 2_000_000_000, maxRepairsPerArm: 2_000_000_000 })), { outcome: 'refused', reason: 'invalid_input' });
    assert.equal(Number((await pool.query('select count(*)::int as n from store.cohort_budget where cohort_id=$1', [over])).rows[0]!.n), 0);
  });

  // --- release not_owner from real SQL ---
  await check('release: a foreign owner maps not_owner', async () => {
    const c = cohortName('rel');
    await store.initCohortBudget(pins(c));
    const a = await store.admitDispatch({ cohortId: c, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    if (a.outcome !== 'admitted') throw new Error('expected admitted');
    const intruder = await store.releaseLease({ leaseId: a.initialLeases[0]!.leaseId, ownerId: 'intruder' });
    assert.equal(intruder.outcome === 'refused' && intruder.reason, 'not_owner');
  });

  // --- the admit `error` variant driven by real SQL (guards dispatchAuthorized) ---
  await check('admit error: a fireId reused for a DIFFERENT dispatch → fire_id_key_mismatch, dispatchAuthorized false', async () => {
    const c = cohortName('errkey');
    await store.initCohortBudget(pins(c));
    // f1 claims g1/moneyline + g1/total; re-admitting f1 with only [moneyline] drops a recorded claimed key.
    await store.admitDispatch({ cohortId: c, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline', 'total'], scopeReservations: scope(['moneyline', 'total']) });
    const mism = await store.admitDispatch({ cohortId: c, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal(mism.outcome, 'error');
    assert.equal(mism.outcome === 'error' && mism.reason, 'fire_id_key_mismatch');
    assert.equal(mism.dispatchAuthorized, false);
  });

  // --- the repair `replayed` variant + a non-`live` lease state, driven by real SQL ---
  await check('repair replayed: an identical same-key re-request replays (requestAuthorized false, same leaseId); a released lease round-trips state', async () => {
    const c = cohortName('reprep');
    await store.initCohortBudget(pins(c, { rosterSize: 2, maxRepairsPerArm: 1, concurrencyLimit: 8 }));
    await store.admitDispatch({ cohortId: c, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    const first = await store.acquireRepairLease({ cohortId: c, fireId: 'f1', ownerId: 'w1', armIndex: 0, repairOrdinal: 1, expectedSchemaVersion: VER });
    assert.equal(first.outcome, 'acquired');
    if (first.outcome !== 'acquired') throw new Error('unreachable');
    const replay = await store.acquireRepairLease({ cohortId: c, fireId: 'f1', ownerId: 'w1', armIndex: 0, repairOrdinal: 1, expectedSchemaVersion: VER });
    assert.equal(replay.outcome, 'replayed');
    if (replay.outcome !== 'replayed') throw new Error('unreachable');
    assert.equal(replay.requestAuthorized, false);
    assert.equal(replay.lease.leaseId, first.lease.leaseId); // the durable lease is echoed
    assert.equal(replay.lease.state, 'live');
    // release, then re-request → the _lease_state 'released' branch reaches the adapter's schema.
    assert.equal((await store.releaseLease({ leaseId: first.lease.leaseId, ownerId: 'w1' })).outcome, 'released');
    const afterRelease = await store.acquireRepairLease({ cohortId: c, fireId: 'f1', ownerId: 'w1', armIndex: 0, repairOrdinal: 1, expectedSchemaVersion: VER });
    assert.equal(afterRelease.outcome, 'replayed');
    if (afterRelease.outcome !== 'replayed') throw new Error('unreachable');
    assert.equal(afterRelease.lease.state, 'released');
  });

  // --- the remaining distinct refusal shapes: spend_cap + init/complete version_mismatch ---
  await check('refusals: admit spend_cap + init version_mismatch + complete version_mismatch map through the adapter', async () => {
    const sc = cohortName('spend');
    await store.initCohortBudget(pins(sc, { spendCapUsdMicros: 1000 })); // one scoped reservation (1000) fits; a second exceeds
    await store.admitDispatch({ cohortId: sc, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    const overSpend = await store.admitDispatch({ cohortId: sc, fireId: 'f2', ownerId: 'w2', expectedSchemaVersion: VER, gameId: 'g2', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal(overSpend.outcome === 'refused' && overSpend.reason, 'spend_cap');

    const vc = cohortName('ver');
    await store.initCohortBudget(pins(vc));
    assert.deepEqual(await store.initCohortBudget(pins(vc, { schemaVersion: 2 })), { outcome: 'refused', reason: 'version_mismatch' });
    await store.admitDispatch({ cohortId: vc, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    const cv = await store.completeClaim({ cohortId: vc, fireId: 'f1', expectedSchemaVersion: 999 });
    assert.equal(cv.outcome === 'refused' && cv.reason, 'version_mismatch');
  });

  // =========================================================================
  // Genuinely-overlapping + crash/restart conformance through the adapter
  // (the committed gate F5 depends on; SPEC §12 cases 8/25/45/46 + §8 crash).
  // =========================================================================

  // case 25: two distinct-backend admits, gated + asserted Lock-waiting → exactly one admitted.
  await check('case 25 (overlap-proven, adapter): gated distinct-backend admits race the budget → exactly one admitted', async () => {
    const c = cohortName('cc-case25');
    await store.initCohortBudget(pins(c, { callCap: 8 })); // exactly one dispatch's callΔ (4×2) fits
    await withGate(
      pool,
      c,
      (s) => s.admitDispatch({ cohortId: c, fireId: 'fA', ownerId: 'wA', expectedSchemaVersion: VER, gameId: 'gA', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) }),
      (s) => s.admitDispatch({ cohortId: c, fireId: 'fB', ownerId: 'wB', expectedSchemaVersion: VER, gameId: 'gB', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) }),
      async (a, b) => {
        assert.deepEqual([a.outcome, b.outcome].sort(), ['admitted', 'refused'], JSON.stringify([a, b]));
        const ref = a.outcome === 'refused' ? a : b;
        assert.equal(ref.outcome === 'refused' && ref.reason, 'call_cap');
        assert.equal(await callsReserved(c), 8);
      },
    );
  });

  // same-fireId: two distinct-backend admits of ONE fireId, gated → one admitted, one replayed.
  await check('same-fireId (overlap-proven, adapter): gated distinct-backend, SAME fireId → one admitted, one replayed, one reservation', async () => {
    const c = cohortName('cc-samefire');
    await store.initCohortBudget(pins(c));
    const req: AdmitDispatchRequest = { cohortId: c, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) };
    await withGate(
      pool,
      c,
      (s) => s.admitDispatch(req),
      (s) => s.admitDispatch(req),
      async (a, b) => {
        assert.deepEqual([a.outcome, b.outcome].sort(), ['admitted', 'replayed'], JSON.stringify([a, b]));
        assert.equal(await callsReserved(c), 8); // one reservation
        assert.equal(await claimCount(c), 1); // one claim
        assert.equal(await initialLeaseCount(c, 'f1'), 4); // one lease set (§12 new-case)
      },
    );
  });

  // case 8: two distinct-backend admits, DIFFERENT fireIds on the SAME key, gated + asserted
  // Lock-waiting → at-most-once holds: exactly one admitted, one all_claimed, one claim /
  // reservation / lease set. Barrier-proven (not Promise.all) so a serialized / non-overlapping
  // run cannot pass — the two admits must be simultaneously lock-waiting before the gate opens.
  await check('case 8 (overlap-proven, adapter): gated distinct-backend admits, different fireIds on ONE key → one admitted, one all_claimed, one claim', async () => {
    const c = cohortName('cc-case8');
    await store.initCohortBudget(pins(c));
    await withGate<AdmitResult, AdmitResult>(
      pool,
      c,
      (s) => s.admitDispatch({ cohortId: c, fireId: 'fA', ownerId: 'wA', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) }),
      (s) => s.admitDispatch({ cohortId: c, fireId: 'fB', ownerId: 'wB', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) }),
      async (a, b) => {
        assert.deepEqual([a.outcome, b.outcome].sort(), ['admitted', 'refused'], JSON.stringify([a, b]));
        const ref = a.outcome === 'refused' ? a : b;
        assert.equal(ref.outcome === 'refused' && ref.reason, 'all_claimed');
        assert.equal(await claimCount(c), 1); // at-most-once: exactly one claim
        assert.equal(await callsReserved(c), 8); // one reservation
        assert.deepEqual([await initialLeaseCount(c, 'fA'), await initialLeaseCount(c, 'fB')].sort(), [0, 4]); // one lease set
      },
    );
  });

  // budget stress: 8 concurrent admits race a scarce cap → exactly 3 admitted, no over-reservation.
  await check('budget stress (adapter): 8 concurrent admits race 3 budget slots → exactly 3 admitted', async () => {
    assertPoolParallel();
    const c = cohortName('cc-stress');
    await store.initCohortBudget(pins(c, { callCap: 24 })); // 3 × callΔ(8)
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, k) => store.admitDispatch({ cohortId: c, fireId: `f${k}`, ownerId: `w${k}`, expectedSchemaVersion: VER, gameId: `g${k}`, proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) })),
    );
    assert.equal(outcomes.filter((o) => o.outcome === 'admitted').length, 3, JSON.stringify(outcomes.map((o) => o.outcome)));
    assert.equal(await callsReserved(c), 24);
  });

  // case 45: saturate concurrency → per-arm releaseLease → re-acquire; ceiling holds throughout.
  await check('case 45 (adapter): saturate concurrency → per-arm releaseLease → re-acquire; SUM(active) never exceeds the limit', async () => {
    const c = cohortName('cc-case45');
    await store.initCohortBudget(pins(c, { concurrencyLimit: 4 }));
    const a1 = await store.admitDispatch({ cohortId: c, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    if (a1.outcome !== 'admitted') throw new Error('expected admitted');
    assert.equal(await activeSlots(c), 4);
    const blocked = await store.admitDispatch({ cohortId: c, fireId: 'f2', ownerId: 'w2', expectedSchemaVersion: VER, gameId: 'g2', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal(blocked.outcome === 'refused' && blocked.reason, 'concurrency');
    for (const lease of a1.initialLeases) {
      assert.equal((await store.releaseLease({ leaseId: lease.leaseId, ownerId: 'w1' })).outcome, 'released');
      assert.ok((await activeSlots(c)) <= 4);
    }
    assert.equal(await activeSlots(c), 0);
    assert.equal((await store.admitDispatch({ cohortId: c, fireId: 'f2', ownerId: 'w2', expectedSchemaVersion: VER, gameId: 'g2', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) })).outcome, 'admitted');
  });

  // case 46: crash (never release), driven ACROSS transactions → capacity self-heals at expiry;
  // the crashed fire's claim stays pending, budget stays consumed, freed capacity is reusable.
  await check('case 46 (adapter): crash-expiry across txns — capacity freed after expiresAt; claim pending, budget consumed, capacity reusable', async () => {
    const c = cohortName('cc-case46');
    // A 3s bound gives the PRE-expiry reads a wide margin (they only race a JS stall > the
    // bound); the post-expiry sleep(4000) clears it by 1s. `setTimeout` only fires late, never
    // early, so both directions have real slack — no spurious failure on a loaded runner.
    await store.initCohortBudget(pins(c, { concurrencyLimit: 4, initialLeaseBoundMs: 3000 }));
    const a1 = await store.admitDispatch({ cohortId: c, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal(a1.outcome, 'admitted');
    assert.equal(await activeSlots(c), 4);
    const blocked = await store.admitDispatch({ cohortId: c, fireId: 'f2', ownerId: 'w2', expectedSchemaVersion: VER, gameId: 'g2', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal(blocked.outcome === 'refused' && blocked.reason, 'concurrency');
    const reservedBefore = await callsReserved(c);
    await sleep(4000); // real time, across transactions, past the 3s bound — the lease self-heals
    assert.equal(await activeSlots(c), 0);
    const a2 = await store.admitDispatch({ cohortId: c, fireId: 'f2', ownerId: 'w2', expectedSchemaVersion: VER, gameId: 'g2', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal(a2.outcome, 'admitted', 'freed capacity is reusable after expiry');
    assert.equal(await claimStatus(c, 'g1', 'moneyline'), 'pending'); // the crashed fire's claim persists
    assert.equal(await callsReserved(c), reservedBefore + 8); // budget stayed consumed, then grew for f2
  });

  // crash/restart: a crashed fire's claim survives a restart (a NEW fireId re-admitting the key
  // refuses all_claimed, no second reservation); a stray complete of an unknown fire is a no-op.
  await check('crash/restart (adapter): the crashed claim blocks a NEW-fireId re-admit (all_claimed, no second reservation); an unknown complete is a no-op', async () => {
    const c = cohortName('cc-restart');
    await store.initCohortBudget(pins(c));
    const crashed = await store.admitDispatch({ cohortId: c, fireId: 'crashed', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal(crashed.outcome, 'admitted');
    const reserved = await callsReserved(c);
    // restart: the fireId is lost; a re-detection generates a NEW fireId and re-admits the same key.
    const readmit = await store.admitDispatch({ cohortId: c, fireId: 'restarted', ownerId: 'w2', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    assert.equal(readmit.outcome === 'refused' && readmit.reason, 'all_claimed'); // at-most-once survives the restart
    assert.equal(await callsReserved(c), reserved); // no second reservation
    assert.equal(await claimStatus(c, 'g1', 'moneyline'), 'pending'); // still the crashed fire's claim
    assert.deepEqual(await store.completeClaim({ cohortId: c, fireId: 'never-admitted', expectedSchemaVersion: VER }), { outcome: 'completed' }); // unknown fire → no-op
  });

  // §13 row 8: a gated admit-vs-repair-acquire race at the ceiling never exceeds the limit;
  // the repair-path `concurrency` refusal is exercised. roster 4, limit 5 → a pending fire
  // holds 4 slots, exactly 1 free: an admit needs 4 (can't fit), a repair needs 1 (fits).
  await check('ceiling (adapter): a gated admit-vs-repair-acquire race holds SUM(active) ≤ limit; the repair concurrency refusal emits', async () => {
    const c = cohortName('cc-ceiling');
    await store.initCohortBudget(pins(c, { rosterSize: 4, maxRepairsPerArm: 1, concurrencyLimit: 5 }));
    assert.equal((await store.admitDispatch({ cohortId: c, fireId: 'f0', ownerId: 'w0', expectedSchemaVersion: VER, gameId: 'g0', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) })).outcome, 'admitted');
    assert.equal(await activeSlots(c), 4);
    // gated race on distinct backends: whichever wins the budget lock, the ceiling holds —
    // the admit can't fit 4 in 1 free slot (→ concurrency), the repair takes the last slot.
    await withGate<AdmitResult, RepairLeaseResult>(
      pool,
      c,
      (s) => s.admitDispatch({ cohortId: c, fireId: 'fN', ownerId: 'wN', expectedSchemaVersion: VER, gameId: 'gN', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) }),
      (s) => s.acquireRepairLease({ cohortId: c, fireId: 'f0', ownerId: 'w0', armIndex: 0, repairOrdinal: 1, expectedSchemaVersion: VER }),
      async (a, b) => {
        assert.equal(a.outcome === 'refused' && a.reason, 'concurrency');
        assert.equal(b.outcome, 'acquired');
        assert.equal(await activeSlots(c), 5); // exactly the limit, never exceeded
      },
    );
    // now saturated (5 = limit): a further repair-acquire drives the repair-path concurrency refusal.
    const overRepair = await store.acquireRepairLease({ cohortId: c, fireId: 'f0', ownerId: 'w0', armIndex: 1, repairOrdinal: 1, expectedSchemaVersion: VER });
    assert.equal(overRepair.outcome === 'refused' && overRepair.reason, 'concurrency');
  });

  // §13 row 9 / §8 clean-completion: a full-roster dispatch whose arms are all released and
  // which then completes holds NO active leases (completeClaim does not release — the caller's
  // per-arm finally does — so the whole flow must be driven to prove the property).
  await check('completion (adapter): a full-roster dispatch, all arms released then completed, holds NO active leases', async () => {
    const c = cohortName('cc-complete');
    await store.initCohortBudget(pins(c, { concurrencyLimit: 8 }));
    const a = await store.admitDispatch({ cohortId: c, fireId: 'f1', ownerId: 'w1', expectedSchemaVersion: VER, gameId: 'g1', proposedMarkets: ['moneyline'], scopeReservations: scope(['moneyline']) });
    if (a.outcome !== 'admitted') throw new Error('expected admitted');
    assert.equal(await activeSlots(c), 4);
    for (const lease of a.initialLeases) assert.equal((await store.releaseLease({ leaseId: lease.leaseId, ownerId: 'w1' })).outcome, 'released'); // each arm's finally
    assert.equal((await store.completeClaim({ cohortId: c, fireId: 'f1', expectedSchemaVersion: VER })).outcome, 'completed');
    assert.equal(await activeSlots(c), 0); // a cleanly-completed dispatch holds no active leases
    assert.equal(await claimStatus(c, 'g1', 'moneyline'), 'completed');
  });

  await pool.end();

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} adapter conformance checks passed`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
