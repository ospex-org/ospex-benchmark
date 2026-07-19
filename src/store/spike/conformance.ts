/**
 * SQL FEASIBILITY SPIKE conformance harness (SPEC-atomic-store.md §11 first gate).
 * Drives the store's plpgsql functions against a REAL Postgres with actual
 * overlapping sessions — mocks cannot substitute for concurrent DB transactions
 * (§12). It proves the load-bearing mechanisms the durable design assumes:
 *   - `cohort_budget FOR UPDATE` serializes the budget race + the same-fireId
 *     idempotency check (cases 25, 3/new);
 *   - the claim PK + `ON CONFLICT DO NOTHING` enforces at-most-once (case 8);
 *   - DB-time lease expiry frees capacity ACROSS transactions with no reclaim event
 *     and no worker clock (case 46), and never refunds the claim/budget;
 *   - the concurrency SUM ceiling holds under per-arm release + re-acquire (case 45);
 *   - settle-down-only floors at made_calls, and a negative spend cannot decrement a
 *     reservation (cases 12, 22).
 *
 * Run: `docker run` a Postgres, then `STORE_DATABASE_URL=… yarn store:spike`
 * (defaults to the spike's local Docker Postgres). NOT part of `yarn test` (that
 * suite is pure and DB-free); this is the store's real-Postgres gate.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';

const DATABASE_URL = process.env.STORE_DATABASE_URL ?? 'postgres://postgres:spike@localhost:5433/store_spike';
const here = new URL('.', import.meta.url);
const SCHEMA_SQL = readFileSync(new URL('../schema.sql', here), 'utf8');
const FUNCTIONS_SQL = readFileSync(new URL('../functions.sql', here), 'utf8');

const VER = 1;
let nonce = 0;
const cohortName = (label: string): string => `spike-${label}-${process.pid}-${(nonce += 1)}`;

// A generous, single-shape pinned config; `over` tweaks the caps/limits per test.
function pins(cohortId: string, over: Partial<Record<string, number>> = {}): Record<string, unknown> {
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

interface Store {
  init(p: Record<string, unknown>): Promise<{ outcome: string; reason?: string }>;
  admit(a: AdmitArgs): Promise<Record<string, unknown>>;
  acquireRepair(cohort: string, fire: string, owner: string, arm: number, ordinal: number): Promise<Record<string, unknown>>;
  release(lease: string, owner: string): Promise<Record<string, unknown>>;
  complete(cohort: string, fire: string, actualCalls: number | null, actualSpend: number | null): Promise<Record<string, unknown>>;
  callsReserved(cohort: string): Promise<number>;
  spendReserved(cohort: string): Promise<number>;
  claimCount(cohort: string): Promise<number>;
  claimStatus(cohort: string, game: string, market: string): Promise<string | null>;
  activeSlots(cohort: string): Promise<number>;
  leaseIdsFor(cohort: string, fire: string): Promise<string[]>;
}

interface AdmitArgs {
  cohort: string;
  fire: string;
  owner: string;
  game: string;
  markets: string[];
  scope: Record<string, { spend: number; digest: string }>;
}

function storeFor(exec: (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>): Store {
  const one = async (sql: string, params: unknown[]): Promise<Record<string, unknown>> =>
    (await exec(sql, params)).rows[0]!.r as Record<string, unknown>;
  const scalar = async (sql: string, params: unknown[]): Promise<unknown> => (await exec(sql, params)).rows[0]?.v;
  return {
    init: (p) => one('select store.init_cohort_budget($1::jsonb) as r', [JSON.stringify(p)]) as Promise<{ outcome: string; reason?: string }>,
    admit: (a) =>
      one('select store.admit_dispatch($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) as r', [
        a.cohort, a.fire, a.owner, VER, a.game, JSON.stringify(a.markets), JSON.stringify(a.scope),
      ]),
    acquireRepair: (cohort, fire, owner, arm, ordinal) =>
      one('select store.acquire_repair_lease($1,$2,$3,$4,$5,$6) as r', [cohort, fire, owner, arm, ordinal, VER]),
    release: (lease, owner) => one('select store.release_lease($1,$2) as r', [lease, owner]),
    complete: (cohort, fire, actualCalls, actualSpend) =>
      one('select store.complete_claim($1,$2,$3,$4,$5) as r', [cohort, fire, VER, actualCalls, actualSpend]),
    callsReserved: async (c) => Number(await scalar('select calls_reserved as v from store.cohort_budget where cohort_id=$1', [c])),
    spendReserved: async (c) => Number(await scalar('select spend_reserved_usd_micros as v from store.cohort_budget where cohort_id=$1', [c])),
    claimCount: async (c) => Number(await scalar('select count(*) as v from store.claims where cohort_id=$1', [c])),
    claimStatus: async (c, g, m) => (await scalar('select status as v from store.claims where cohort_id=$1 and game_id=$2 and market=$3', [c, g, m])) as string | null ?? null,
    activeSlots: async (c) => Number(await scalar('select coalesce(sum(1),0) as v from store.concurrency_leases where cohort_id=$1 and released_at is null and expires_at > now()', [c])),
    leaseIdsFor: async (c, f) => (await exec('select lease_id from store.concurrency_leases where cohort_id=$1 and fire_id=$2 order by arm_index', [c, f])).rows.map((row) => row.lease_id as string),
  };
}

const digestOf = (label: string): string => `${'0'.repeat(64 - label.length)}${label}`.slice(0, 64);
function fullScope(markets: string[]): Record<string, { spend: number; digest: string }> {
  // Every nonempty subset of a ≤2-market proposal, canonical '+' keys, cheap spend.
  const subsets: string[][] = markets.length === 1 ? [markets] : [[markets[0]!], [markets[1]!], markets];
  const out: Record<string, { spend: number; digest: string }> = {};
  for (const s of subsets) out[s.join('+')] = { spend: 1000, digest: digestOf(s.join('')) };
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

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
  const pool = new Pool({ connectionString: DATABASE_URL, max: 12 });
  const s = storeFor((sql, params) => pool.query(sql, params));

  // Fresh schema each run so a rerun is deterministic.
  await pool.query('drop schema if exists store cascade');
  await pool.query(SCHEMA_SQL);
  await pool.query(FUNCTIONS_SQL);

  // --- sanity: init + happy admit + idempotent replay ---
  await check('init + admit + idempotent same-fireId replay (sequential)', async () => {
    const c = cohortName('happy');
    assert.equal((await s.init(pins(c))).outcome, 'initialized');
    assert.equal((await s.init(pins(c))).outcome, 'initialized'); // insert-once, no reset
    const a = await s.admit({ cohort: c, fire: 'f1', owner: 'w1', game: 'g1', markets: ['moneyline', 'total'], scope: fullScope(['moneyline', 'total']) });
    assert.equal(a.outcome, 'admitted');
    assert.equal(a.dispatchAuthorized, true);
    assert.equal((a.initialLeases as unknown[]).length, 4);
    assert.equal(await s.callsReserved(c), 4 * (1 + 1)); // roster × (1+maxRepairs)
    const replay = await s.admit({ cohort: c, fire: 'f1', owner: 'w1', game: 'g1', markets: ['moneyline', 'total'], scope: fullScope(['moneyline', 'total']) });
    assert.equal(replay.outcome, 'replayed');
    assert.equal(replay.dispatchAuthorized, false);
    assert.equal(await s.callsReserved(c), 8); // NOT doubled
  });

  await check('admit before init fails closed (not_initialized, no rows)', async () => {
    const c = cohortName('noinit');
    const a = await s.admit({ cohort: c, fire: 'f1', owner: 'w1', game: 'g1', markets: ['moneyline'], scope: fullScope(['moneyline']) });
    assert.equal(a.reason, 'not_initialized');
    assert.equal(await s.claimCount(c), 0);
  });

  // --- case 8: at-most-once claim under a real race ---
  await check('case 8: concurrent admits (different fireIds, same key) → exactly one claims it', async () => {
    for (let i = 0; i < 12; i += 1) {
      const c = cohortName(`case8-${i}`);
      await s.init(pins(c));
      const args = (fire: string): AdmitArgs => ({ cohort: c, fire, owner: fire, game: 'g1', markets: ['moneyline'], scope: fullScope(['moneyline']) });
      const [a, b] = await Promise.all([s.admit(args('fA')), s.admit(args('fB'))]);
      const outcomes = [a.outcome, b.outcome].sort();
      assert.deepEqual(outcomes, ['admitted', 'refused'], `iter ${i}: ${JSON.stringify([a, b])}`);
      assert.equal((a.outcome === 'refused' ? a : b).reason, 'all_claimed');
      assert.equal(await s.claimCount(c), 1); // exactly one claim row
    }
  });

  // --- case 25: budget race → at most one reservation ---
  await check('case 25: concurrent admits race the final call slot → exactly one admitted', async () => {
    for (let i = 0; i < 12; i += 1) {
      const c = cohortName(`case25-${i}`);
      await s.init(pins(c, { callCap: 8 })); // exactly ONE dispatch's callΔ (4×2) fits
      const args = (fire: string, game: string): AdmitArgs => ({ cohort: c, fire, owner: fire, game, markets: ['moneyline'], scope: fullScope(['moneyline']) });
      const [a, b] = await Promise.all([s.admit(args('fA', 'gA')), s.admit(args('fB', 'gB'))]);
      const outcomes = [a.outcome, b.outcome].sort();
      assert.deepEqual(outcomes, ['admitted', 'refused'], `iter ${i}: ${JSON.stringify([a, b])}`);
      assert.equal((a.outcome === 'refused' ? a : b).reason, 'call_cap');
      assert.equal(await s.callsReserved(c), 8); // never 16 (no over-reservation)
    }
  });

  // --- same-fireId race: exactly one reservation + one lease set ---
  await check('new case: two concurrent SAME-fireId admits → one admitted, one replayed, one reservation', async () => {
    for (let i = 0; i < 12; i += 1) {
      const c = cohortName(`samefire-${i}`);
      await s.init(pins(c));
      const args: AdmitArgs = { cohort: c, fire: 'f1', owner: 'w1', game: 'g1', markets: ['moneyline', 'total'], scope: fullScope(['moneyline', 'total']) };
      const [a, b] = await Promise.all([s.admit(args), s.admit(args)]);
      const outcomes = [a.outcome, b.outcome].sort();
      assert.deepEqual(outcomes, ['admitted', 'replayed'], `iter ${i}: ${JSON.stringify([a, b])}`);
      assert.equal(await s.callsReserved(c), 8); // one reservation
      assert.equal((await s.leaseIdsFor(c, 'f1')).length, 4); // one lease set
    }
  });

  // --- case 46: DB-time lease expiry across transactions; no refund ---
  await check('case 46: capacity held until expiresAt, freed after (across txns); claim/budget stay consumed', async () => {
    const c = cohortName('case46');
    await s.init(pins(c, { concurrencyLimit: 4, initialLeaseBoundMs: 1500 }));
    const a1 = await s.admit({ cohort: c, fire: 'f1', owner: 'w1', game: 'g1', markets: ['moneyline'], scope: fullScope(['moneyline']) });
    assert.equal(a1.outcome, 'admitted');
    assert.equal(await s.activeSlots(c), 4);
    // Before expiry: the ceiling blocks a second dispatch.
    const blocked = await s.admit({ cohort: c, fire: 'f2', owner: 'w2', game: 'g2', markets: ['moneyline'], scope: fullScope(['moneyline']) });
    assert.equal(blocked.reason, 'concurrency');
    const reservedBefore = await s.callsReserved(c);
    await sleep(2000); // real time, ACROSS transactions — the lease self-heals at expiresAt
    assert.equal(await s.activeSlots(c), 0);
    const a2 = await s.admit({ cohort: c, fire: 'f2', owner: 'w2', game: 'g2', markets: ['moneyline'], scope: fullScope(['moneyline']) });
    assert.equal(a2.outcome, 'admitted', 'freed capacity is reusable after expiry');
    // No refund: the crashed fire's claim stays pending; budget stayed consumed (then grew for f2).
    assert.equal(await s.claimStatus(c, 'g1', 'moneyline'), 'pending');
    assert.equal(await s.callsReserved(c), reservedBefore + 8);
  });

  // --- case 45: per-arm release frees slots; ceiling holds ---
  await check('case 45: per-arm release frees capacity; re-acquire; SUM(active) never exceeds the limit', async () => {
    const c = cohortName('case45');
    await s.init(pins(c, { concurrencyLimit: 4 }));
    const a1 = await s.admit({ cohort: c, fire: 'f1', owner: 'w1', game: 'g1', markets: ['moneyline'], scope: fullScope(['moneyline']) });
    assert.equal(a1.outcome, 'admitted');
    assert.equal(await s.activeSlots(c), 4);
    assert.equal((await s.admit({ cohort: c, fire: 'f2', owner: 'w2', game: 'g2', markets: ['moneyline'], scope: fullScope(['moneyline']) })).reason, 'concurrency');
    for (const leaseId of await s.leaseIdsFor(c, 'f1')) {
      assert.equal((await s.release(leaseId, 'w1')).outcome, 'released');
      assert.ok((await s.activeSlots(c)) <= 4);
    }
    assert.equal(await s.activeSlots(c), 0);
    assert.equal((await s.admit({ cohort: c, fire: 'f2', owner: 'w2', game: 'g2', markets: ['moneyline'], scope: fullScope(['moneyline']) })).outcome, 'admitted');
    assert.equal(await s.activeSlots(c), 4);
    // owner-scoped: another worker cannot release my slot.
    const [someLease] = await s.leaseIdsFor(c, 'f2');
    assert.equal((await s.release(someLease!, 'intruder')).reason, 'not_owner');
  });

  // --- case 12: settle-down-only, floored, idempotent ---
  await check('case 12: completeClaim settles once to the made_calls floor; retry is a no-op; breach fails loud', async () => {
    const c = cohortName('case12');
    await s.init(pins(c));
    await s.admit({ cohort: c, fire: 'f1', owner: 'w1', game: 'g1', markets: ['moneyline'], scope: fullScope(['moneyline']) });
    assert.equal(await s.callsReserved(c), 8); // 4×(1+1)
    assert.equal((await s.complete(c, 'f1', null, null)).outcome, 'completed'); // omit → settle calls to made_calls (=4)
    assert.equal(await s.callsReserved(c), 4);
    assert.equal((await s.complete(c, 'f1', null, null)).outcome, 'completed'); // idempotent
    assert.equal(await s.callsReserved(c), 4); // not double-subtracted
    // an out-of-interval actual on a fresh fire fails loud.
    await s.admit({ cohort: c, fire: 'f2', owner: 'w2', game: 'g2', markets: ['moneyline'], scope: fullScope(['moneyline']) });
    assert.equal((await s.complete(c, 'f2', 999, null)).reason, 'invariant_breach'); // > call_reserved
    assert.equal((await s.complete(c, 'f2', -1, null)).reason, 'invalid_input'); // malformed
  });

  // --- case 22: a negative spend cannot decrement a reservation ---
  await check('case 22: a negative scope spend refuses invalid_input and writes nothing', async () => {
    const c = cohortName('case22');
    await s.init(pins(c));
    const bad = await s.admit({ cohort: c, fire: 'f1', owner: 'w1', game: 'g1', markets: ['moneyline'], scope: { moneyline: { spend: -100, digest: digestOf('m') } } });
    assert.equal(bad.reason, 'invalid_input');
    assert.equal(await s.callsReserved(c), 0);
    assert.equal(await s.spendReserved(c), 0);
    assert.equal(await s.claimCount(c), 0);
  });

  // --- repair idempotency + made_calls ≤ call_reserved ---
  await check('repair: idempotency-first replay; made_calls never exceeds call_reserved', async () => {
    const c = cohortName('repair');
    await s.init(pins(c, { rosterSize: 2, maxRepairsPerArm: 1, concurrencyLimit: 8 }));
    await s.admit({ cohort: c, fire: 'f1', owner: 'w1', game: 'g1', markets: ['moneyline'], scope: fullScope(['moneyline']) }); // call_reserved=2×2=4, made=2
    const r1 = await s.acquireRepair(c, 'f1', 'w1', 0, 1);
    assert.equal(r1.outcome, 'acquired');
    assert.equal(r1.requestAuthorized, true);
    const r1replay = await s.acquireRepair(c, 'f1', 'w1', 0, 1); // exact same key
    assert.equal(r1replay.outcome, 'replayed');
    assert.equal(r1replay.requestAuthorized, false); // re-increments nothing
    const r2 = await s.acquireRepair(c, 'f1', 'w1', 1, 1);
    assert.equal(r2.outcome, 'acquired'); // made_calls now 4 == call_reserved
    const overCap = await s.acquireRepair(c, 'f1', 'w1', 0, 2); // ordinal past maxRepairs
    assert.equal(overCap.reason, 'repair_limit');
    const differentOwner = await s.acquireRepair(c, 'f1', 'intruder', 0, 1);
    assert.equal(differentOwner.reason, 'not_owner');
  });

  // --- stress: many workers race a scarce budget / a single key ---
  await check('stress: 8 concurrent admits race 3 budget slots → exactly 3 admitted, no over-reservation', async () => {
    const c = cohortName('stress-budget');
    await s.init(pins(c, { callCap: 24 })); // 3 × callΔ(8)
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, k) => s.admit({ cohort: c, fire: `f${k}`, owner: `w${k}`, game: `g${k}`, markets: ['moneyline'], scope: fullScope(['moneyline']) })),
    );
    assert.equal(outcomes.filter((o) => o.outcome === 'admitted').length, 3, JSON.stringify(outcomes.map((o) => o.outcome)));
    assert.equal(await s.callsReserved(c), 24); // exactly 3×8, never more
  });

  await check('stress: 8 concurrent admits (distinct fireIds) on one key → exactly one claim', async () => {
    const c = cohortName('stress-key');
    await s.init(pins(c));
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, k) => s.admit({ cohort: c, fire: `f${k}`, owner: `w${k}`, game: 'g1', markets: ['moneyline'], scope: fullScope(['moneyline']) })),
    );
    assert.equal(outcomes.filter((o) => o.outcome === 'admitted').length, 1, JSON.stringify(outcomes.map((o) => o.outcome)));
    assert.equal(await s.claimCount(c), 1);
  });

  await pool.end();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} conformance checks passed`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
