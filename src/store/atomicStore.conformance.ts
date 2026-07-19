/**
 * Adapter conformance against REAL Postgres (SPEC-atomic-store.md): the `SqlAtomicStore`
 * driven over the checked-in SQL functions. It proves what the pure `atomicStore.test.ts`
 * suite cannot — that the adapter's zod result schemas accept EXACTLY the JSONB every SQL
 * branch emits, and the request→arg mapping drives the functions correctly end-to-end.
 * Mirrors the SQL spike's setup (drop + apply schema/functions on a scratch DB). NOT part
 * of `yarn test` (that suite is pure and DB-free).
 *
 * Run: `docker run` a Postgres, then `STORE_DATABASE_URL=… yarn store:adapter`
 * (defaults to the spike's local Docker Postgres).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { sha256Hex } from '../canonical.js';
import { SqlAtomicStore, pgStoreQuery } from './atomicStore.js';
import type { AdmitDispatchRequest, InitCohortBudgetRequest, ScopeKey } from './contract.js';
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

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
  await pool.query('drop schema if exists store cascade');
  await pool.query(SCHEMA_SQL);
  await pool.query(FUNCTIONS_SQL);

  const store = new SqlAtomicStore(pgStoreQuery(pool));
  const claimCount = async (c: string): Promise<number> => Number((await pool.query('select count(*) as v from store.claims where cohort_id=$1', [c])).rows[0]!.v);
  const callsReserved = async (c: string): Promise<number> => Number((await pool.query('select calls_reserved as v from store.cohort_budget where cohort_id=$1', [c])).rows[0]!.v);

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
