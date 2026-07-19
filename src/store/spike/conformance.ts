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
 * The load-bearing races are proven with a GENUINE-OVERLAP barrier, not just Promise.all:
 * competing calls run on DISTINCT pooled backends (asserted by pg_backend_pid); a gate
 * session holds the budget row (or, for the init race, an advisory lock via a scratch
 * BEFORE INSERT trigger) so both competitors are observably Lock-waiting in
 * pg_stat_activity — and unresolved — before the gate opens (§4). The store's own lock
 * then serializes them. The Promise.all loops remain as supplementary stress.
 * Self-test: `STORE_POOL_MAX=1 yarn store:spike` serializes every backend onto one
 * connection, so the barrier checks FAIL — a serialized harness cannot fake overlap.
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
// Real-overlap barrier machinery: distinct backends, a held gate, and an asserted
// lock-wait — so a genuinely-overlapping race is a TESTED fact, not an artifact of
// Promise.all that a single serialized connection would satisfy just as well.
// ---------------------------------------------------------------------------

interface Tracked<T> { promise: Promise<T>; settled: () => boolean; }
function track<T>(p: Promise<T>): Tracked<T> {
  let done = false;
  const promise = p.then(
    (v) => { done = true; return v; },
    (e: unknown) => { done = true; throw e; },
  );
  return { promise, settled: () => done };
}

interface Session { client: PoolClient; pid: number; }
// Acquire n DISTINCT pooled backends (asserted by pg_backend_pid). Under a starved pool
// (STORE_POOL_MAX=1) the 2nd connect() hits connectionTimeoutMillis and throws — so a
// serialized single-connection harness FAILS every barrier check instead of faking overlap.
async function distinctSessions(pool: Pool, n: number): Promise<Session[]> {
  const out: Session[] = [];
  try {
    for (let i = 0; i < n; i += 1) {
      const client = await pool.connect();
      const pid = Number((await client.query('select pg_backend_pid() as pid')).rows[0].pid);
      out.push({ client, pid });
    }
  } catch (err) {
    for (const ssn of out) ssn.client.release();
    throw err;
  }
  const pids = new Set(out.map((ssn) => ssn.pid));
  assert.equal(pids.size, n, `expected ${n} distinct backend PIDs, got ${JSON.stringify([...pids])}`);
  return out;
}

// Poll pg_stat_activity until EVERY listed backend is actively waiting on a Lock — the
// proof that both competitors are simultaneously in flight, blocked, before the gate opens.
async function bothLockWaiting(pool: Pool, pids: number[], timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const { rows } = await pool.query(
      'select pid, state, wait_event_type, wait_event from pg_stat_activity where pid = any($1::int[])',
      [pids],
    );
    const waiting = rows.filter((r) => r.state === 'active' && r.wait_event_type === 'Lock');
    if (waiting.length === pids.length) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`barrier: expected ${pids.length} sessions Lock-waiting; saw ${JSON.stringify(rows)}`);
    }
    await sleep(25);
  }
}

async function admitOn(client: PoolClient, a: AdmitArgs): Promise<Record<string, unknown>> {
  const res = await client.query('select store.admit_dispatch($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) as r', [
    a.cohort, a.fire, a.owner, VER, a.game, JSON.stringify(a.markets), JSON.stringify(a.scope),
  ]);
  return res.rows[0].r as Record<string, unknown>;
}
async function initOn(client: PoolClient, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await client.query('select store.init_cohort_budget($1::jsonb) as r', [JSON.stringify(p)]);
  return res.rows[0].r as Record<string, unknown>;
}

// Run `body` with two competitors blocked behind a gate that holds the cohort's budget
// row (the exact `FOR UPDATE` every admit takes first, §4). Asserts both are lock-waiting
// and unresolved before opening the gate; drains + releases every client on every path.
async function withBudgetGate(
  pool: Pool,
  cohortId: string,
  start: (a: PoolClient, b: PoolClient) => { a: Promise<Record<string, unknown>>; b: Promise<Record<string, unknown>> },
  after: (ra: Record<string, unknown>, rb: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const [gate, a, b] = (await distinctSessions(pool, 3)) as [Session, Session, Session];
  let tA: Tracked<Record<string, unknown>> | null = null;
  let tB: Tracked<Record<string, unknown>> | null = null;
  try {
    await gate.client.query('begin');
    await gate.client.query('select 1 from store.cohort_budget where cohort_id=$1 for update', [cohortId]);
    const started = start(a.client, b.client);
    tA = track(started.a);
    tB = track(started.b);
    await bothLockWaiting(pool, [a.pid, b.pid]);
    assert.ok(!tA.settled() && !tB.settled(), 'both competitors must block on the budget lock before release');
    await gate.client.query('rollback'); // open the gate; the store's own FOR UPDATE now serializes them
    const [ra, rb] = await Promise.all([tA.promise, tB.promise]);
    await after(ra, rb);
  } finally {
    try { await gate.client.query('rollback'); } catch { /* already ended */ }
    if (tA) await tA.promise.catch(() => undefined);
    if (tB) await tB.promise.catch(() => undefined);
    gate.client.release(); a.client.release(); b.client.release();
  }
}

// Force two initializers to overlap DETERMINISTICALLY. The scratch _spike_init_gate trigger
// (armed only for GATE:* cohorts) blocks every insert on an advisory lock the gate session
// holds, so both callers pass their "row absent?" SELECT and reach the INSERT before either
// commits — the exact double-absence window the init fix closes. Releasing the gate lets exactly
// one INSERT win; the loser's ON CONFLICT DO NOTHING affects zero rows, re-reads, and compares.
async function initRace(
  pool: Pool,
  label: string,
  overA: Partial<Record<string, number>>,
  overB: Partial<Record<string, number>>,
): Promise<{ cohortId: string; outcomes: string[]; reasons: unknown[]; rows: number; storedCallCap: number }> {
  const c = `GATE:${label}-${process.pid}-${(nonce += 1)}`;
  const [gate, a, b] = (await distinctSessions(pool, 3)) as [Session, Session, Session];
  let tA: Tracked<Record<string, unknown>> | null = null;
  let tB: Tracked<Record<string, unknown>> | null = null;
  try {
    const key = Number((await gate.client.query('select hashtext($1) as k', [c])).rows[0].k);
    await gate.client.query('select pg_advisory_lock($1::bigint)', [key]);
    tA = track(initOn(a.client, pins(c, overA)));
    tB = track(initOn(b.client, pins(c, overB)));
    await bothLockWaiting(pool, [a.pid, b.pid]);
    assert.ok(!tA.settled() && !tB.settled(), 'both inits must block in the widened insert window before release');
    await gate.client.query('select pg_advisory_unlock($1::bigint)', [key]);
    const [ra, rb] = await Promise.all([tA.promise, tB.promise]);
    const agg = await pool.query(
      'select count(*)::int as n, max(call_cap) as cap from store.cohort_budget where cohort_id=$1',
      [c],
    );
    return {
      cohortId: c,
      outcomes: [String(ra.outcome), String(rb.outcome)].sort(),
      reasons: [ra.reason, rb.reason],
      rows: Number(agg.rows[0].n),
      storedCallCap: Number(agg.rows[0].cap),
    };
  } finally {
    try { await gate.client.query('select pg_advisory_unlock_all()'); } catch { /* already released */ }
    if (tA) await tA.promise.catch(() => undefined);
    if (tB) await tB.promise.catch(() => undefined);
    gate.client.release(); a.client.release(); b.client.release();
  }
}

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
  // Default max 12 for real overlap; STORE_POOL_MAX=1 is the serialized-harness self-test
  // (the barrier checks must FAIL). connectionTimeoutMillis makes a starved pool throw
  // rather than hang, so the self-test terminates.
  const POOL_MAX = Number(process.env.STORE_POOL_MAX ?? '12');
  const pool = new Pool({ connectionString: DATABASE_URL, max: POOL_MAX, connectionTimeoutMillis: 8000 });
  const s = storeFor((sql, params) => pool.query(sql, params));

  // Fresh schema each run so a rerun is deterministic.
  await pool.query('drop schema if exists store cascade');
  await pool.query(SCHEMA_SQL);
  await pool.query(FUNCTIONS_SQL);

  // Harness-only scaffolding (NOT part of the production DDL in schema.sql/functions.sql):
  // a BEFORE INSERT trigger that lets the init-race checks force two initializers to overlap
  // deterministically. It arms ONLY for GATE:* cohorts (used exclusively by initRace), so it
  // is inert for every other conformance cohort.
  await pool.query(`create or replace function store._spike_init_gate() returns trigger language plpgsql as $fn$
begin
  if NEW.cohort_id like 'GATE:%' then perform pg_advisory_xact_lock(hashtext(NEW.cohort_id)::bigint); end if;
  return NEW;
end $fn$;`);
  await pool.query('create or replace trigger _spike_init_gate before insert on store.cohort_budget for each row execute function store._spike_init_gate()');

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

  // --- concurrent conflicting init must fail loud (real overlap, gated) ---
  await check('init race (same config): two SAME-config initializers overlap → both initialized, one row', async () => {
    const r = await initRace(pool, 'same', {}, {});
    assert.deepEqual(r.outcomes, ['initialized', 'initialized'], JSON.stringify(r));
    assert.equal(r.rows, 1); // one row; the loser re-read the winner and matched → no false config_mismatch
    // (the no-reset invariant is proven separately, on NONZERO counters — see 'init insert-once' below)
  });

  await check('init race (differing config): two DIFFERING-config initializers overlap → one initialized, one config_mismatch (loser never falsely initialized)', async () => {
    const r = await initRace(pool, 'cap', { callCap: 101 }, { callCap: 202 });
    assert.deepEqual(r.outcomes, ['initialized', 'refused'], JSON.stringify(r));
    assert.ok(r.reasons.includes('config_mismatch'), JSON.stringify(r));
    assert.equal(r.rows, 1); // exactly one row
    assert.ok(r.storedCallCap === 101 || r.storedCallCap === 202, `stored ${r.storedCallCap}`); // the winner's pins
  });

  await check('init race (differing version): two DIFFERING-version initializers overlap → one initialized, one version_mismatch', async () => {
    const r = await initRace(pool, 'ver', { schemaVersion: 1 }, { schemaVersion: 2 });
    assert.deepEqual(r.outcomes, ['initialized', 'refused'], JSON.stringify(r));
    assert.ok(r.reasons.includes('version_mismatch'), JSON.stringify(r));
    assert.equal(r.rows, 1);
  });

  // The no-reset invariant is load-bearing ONLY against NONZERO consumed counters: admit
  // to reserve, then re-init with the SAME config (a worker restart) and assert both
  // counters are UNCHANGED. A reset on the consistent-row path (which would double-spend
  // the cap after a restart) fails this — see the reset-mutation negative control in the PR.
  await check('init insert-once: a consistent re-init preserves NONZERO calls/spend reservations (never resets)', async () => {
    const c = cohortName('reinit-preserve');
    assert.equal((await s.init(pins(c))).outcome, 'initialized');
    await s.admit({ cohort: c, fire: 'f1', owner: 'w1', game: 'g1', markets: ['moneyline', 'total'], scope: fullScope(['moneyline', 'total']) });
    const calls = await s.callsReserved(c);
    const spend = await s.spendReserved(c);
    assert.ok(calls > 0 && spend > 0, `precondition: nonzero reservations, got calls=${calls} spend=${spend}`);
    assert.equal((await s.init(pins(c))).outcome, 'initialized'); // consistent re-init → initialized, no rewrite
    assert.equal(await s.callsReserved(c), calls); // NOT reset
    assert.equal(await s.spendReserved(c), spend); // NOT reset
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

  // --- case 25: budget race → at most one reservation (Promise.all stress; the gated
  //     overlap proof is 'case 25 (overlap-proven)' below) ---
  await check('case 25 (stress loop): concurrent admits race the final call slot → exactly one admitted', async () => {
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

  // --- same-fireId race: exactly one reservation + one lease set (Promise.all stress;
  //     the gated overlap proof is 'same-fireId (overlap-proven)' below) ---
  await check('same-fireId (stress loop): two concurrent SAME-fireId admits → one admitted, one replayed, one reservation', async () => {
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

  // --- real-overlap proof — a held budget row gates two DISTINCT sessions ---
  await check('case 25 (overlap-proven): gated distinct sessions both Lock-wait on the budget row; release → exactly one admitted', async () => {
    const c = cohortName('case25-barrier');
    await s.init(pins(c, { callCap: 8 })); // exactly ONE dispatch's callΔ (4×2) fits
    await withBudgetGate(
      pool,
      c,
      (a, b) => ({
        a: admitOn(a, { cohort: c, fire: 'fA', owner: 'wA', game: 'gA', markets: ['moneyline'], scope: fullScope(['moneyline']) }),
        b: admitOn(b, { cohort: c, fire: 'fB', owner: 'wB', game: 'gB', markets: ['moneyline'], scope: fullScope(['moneyline']) }),
      }),
      async (ra, rb) => {
        assert.deepEqual([String(ra.outcome), String(rb.outcome)].sort(), ['admitted', 'refused'], JSON.stringify([ra, rb]));
        assert.equal((ra.outcome === 'refused' ? ra : rb).reason, 'call_cap');
        assert.equal(await s.callsReserved(c), 8); // exactly one reservation, never 16
      },
    );
  });

  await check('same-fireId (overlap-proven): gated distinct sessions, SAME fireId; release → one admitted, one replayed, one reservation + one lease set', async () => {
    const c = cohortName('samefire-barrier');
    await s.init(pins(c));
    const args: AdmitArgs = { cohort: c, fire: 'f1', owner: 'w1', game: 'g1', markets: ['moneyline', 'total'], scope: fullScope(['moneyline', 'total']) };
    await withBudgetGate(
      pool,
      c,
      (a, b) => ({ a: admitOn(a, args), b: admitOn(b, args) }),
      async (ra, rb) => {
        assert.deepEqual([String(ra.outcome), String(rb.outcome)].sort(), ['admitted', 'replayed'], JSON.stringify([ra, rb]));
        assert.equal(await s.callsReserved(c), 8); // one reservation
        assert.equal((await s.leaseIdsFor(c, 'f1')).length, 4); // one lease set
      },
    );
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
