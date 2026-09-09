/** SH1–SH7: owned, no-volume localhost PostgreSQL only. No input DSN or env files.
 * `yarn store:hardening` needs the pre-existing postgres:17.10 image; never pulls it.
 * The legacy economic/race suites also run, but only against this owned scratch DB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { SqlAtomicStore, pgStoreQuery } from './atomicStore.js';
import { SqlCampaignAuthorizationPort } from './campaignAuthStore.js';
import { SqlCampaignTickJournalPort, pgStoreTransactor } from './campaignTickJournal.js';
import { SqlCampaignStatusReadPort } from './campaignStatusRead.js';
import { SqlUnresolvedFireReadPort } from './escalationLatchRead.js';
import { requireStoreRole } from './connection.js';
import type { CampaignAuthorization } from '../campaignAuthorization.js';

const root = new URL('../../', import.meta.url);
const sql = (name: string): string => readFileSync(new URL(name, import.meta.url), 'utf8');
const home = mkdtempSync(join(tmpdir(), 'ospex-store-hardening-home-'));
const name = `ospex-store-hardening-${randomUUID()}`;
const password = `scratch-${randomUUID()}`;
const roles = ['ospex_store_migrator', 'ospex_store_runtime', 'ospex_store_status'] as const;
const banned = ['anon', 'authenticated', 'service_role', 'outsider'] as const;
const tables = ['cohort_budget', 'fires', 'claims', 'concurrency_leases', 'campaign_authorizations', 'campaign_ticks'];
const calls = [
  `store.init_cohort_budget('{}'::jsonb)`,
  `store.admit_dispatch('absent','f','o',1,'g','["moneyline"]','{}')`,
  `store.acquire_repair_lease('absent','f','o',0,1,1)`,
  `store.release_lease('absent','o')`,
  `store.complete_claim('absent','f',1,null,null)`,
  `store._iso(now())`, `store._market_ord('total')`, `store._lease_state(null,now())`,
  `store._markets_canonical('["total"]')`, `store._scope_spend_safe('{}')`,
];
function docker(args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `docker ${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
}
function run(path: string, env: Record<string, string>, args: string[] = [], expected = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path, ...args], {
      cwd: root, env: { HOME: home, PATH: process.env.PATH!, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000, killSignal: 'SIGKILL',
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      console.log(`${path} ${args.join(' ')} exit=${code}\n${output}`);
      try { assert.equal(code, expected, path); resolve(output); } catch (e) { reject(e); }
    });
  });
}
async function denied(client: Pool | PoolClient, statement: string): Promise<void> {
  await assert.rejects(client.query(statement), (e: unknown) =>
    typeof e === 'object' && e !== null && 'code' in e && e.code === '42501', statement);
}

let owned = false;
const pools: Pool[] = [];
try {
  docker(['run', '--pull=never', '--detach', '--name', name, '--label', `ospex.store-hardening=${name}`,
    '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data',
    '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=store_hardening', 'postgres:17.10']);
  owned = true;
  const ports = JSON.parse(docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]));
  const binding = ports['5432/tcp'][0];
  assert.equal(binding.HostIp, '127.0.0.1');
  const url = (user: string): string => `postgres://${user}:${password}@127.0.0.1:${binding.HostPort}/store_hardening`;
  const pool = (user: string): Pool => {
    const p = new Pool({ connectionString: url(user), ssl: false, connectionTimeoutMillis: 1000, max: 8 });
    pools.push(p); return p;
  };
  const admin = pool('postgres');
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { await admin.query('select 1'); ready = true; break; } catch { await delay(100); }
  }
  assert.ok(ready, 'owned scratch PostgreSQL not ready');
  console.log(`PostgreSQL ${(await admin.query('show server_version')).rows[0].server_version}`);
  // Prove that a preexisting production-named cluster role cannot be dropped by
  // the standalone legacy harness. This role and sentinel belong to our test.
  await admin.query('create schema store; create table store.role_guard_sentinel(x int); insert into store.role_guard_sentinel values (73); create role ospex_store_status login');
  const roleBefore = (await admin.query("select oid, rolname, rolcanlogin from pg_roles where rolname='ospex_store_status'")).rows;
  assert.match(await run('src/store/campaignAuthStore.conformance.ts', { STORE_DATABASE_URL: url('postgres') }, [], 1), /preexisting dedicated store role/);
  assert.deepEqual((await admin.query("select oid, rolname, rolcanlogin from pg_roles where rolname='ospex_store_status'")).rows, roleBefore);
  assert.deepEqual((await admin.query('select x from store.role_guard_sentinel')).rows, [{ x: 73 }]);
  await admin.query('drop role ospex_store_status; drop schema store cascade');
  console.log('SH6 legacy cluster-role refusal preserves role and schema sentinel PASS');
  // Preserve the existing economic/race gates. Their destructive resets see only our DB.
  for (const path of ['src/store/spike/conformance.ts', 'src/store/atomicStore.conformance.ts', 'src/store/campaignAuthStore.conformance.ts']) {
    await run(path, { STORE_DATABASE_URL: url('postgres'), STORE_STATUS_DATABASE_URL: url('postgres') });
  }
  await admin.query('drop schema if exists store cascade');
  await admin.query('drop role if exists ospex_store_status');
  for (const role of [...roles, ...banned]) {
    await admin.query(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`);
  }
  await admin.query('grant create on database store_hardening to ospex_store_migrator');
  const owner = pool(roles[0]);
  const runtime = pool(roles[1]);
  const status = pool(roles[2]);
  const migrateEnv = { STORE_MIGRATION_DATABASE_URL: url(roles[0]) };
  for (const [p, role] of [[owner, roles[0]], [runtime, roles[1]], [status, roles[2]]] as const) {
    await requireStoreRole(p, role);
    await assert.rejects(requireStoreRole(admin, role), /requires standalone/);
  }
  await assert.rejects(requireStoreRole(runtime, roles[2]), /requires standalone/);
  await assert.rejects(requireStoreRole(owner, roles[1]), /requires standalone/);
  assert.match(await run('src/store/migrate.ts', { STORE_DATABASE_URL: url('postgres') }, [], 2), /no .env loading or runtime DSN fallback/);
  assert.match(await run('src/store/migrate.ts', { STORE_MIGRATION_DATABASE_URL: url('postgres') }, [], 1), /requires standalone/);
  await run('src/store/migrate.ts', migrateEnv);
  await run('src/store/migrate.ts', migrateEnv); // idempotent, no privilege widening
  await run('src/store/migrate.ts', migrateEnv, ['--check']);

  // Upgrade canonical tables with legacy invoker/default-path routines and broad
  // table/column/function grants, under the dedicated owner.
  await owner.query('drop schema store cascade');
  await owner.query(sql('schema.sql'));
  await owner.query(sql('functions.sql'));
  const signatures = (await owner.query(`select oid::regprocedure::text as signature from pg_proc
    where pronamespace = 'store'::regnamespace`)).rows;
  for (const { signature } of signatures) {
    await owner.query(`alter function ${signature} security invoker; alter function ${signature} reset all`);
  }
  await owner.query('grant usage on schema store to public; grant all on all tables in schema store to public; grant execute on all functions in schema store to public');
  await owner.query('grant update(calls_reserved) on store.cohort_budget to public');
  await run('src/store/migrate.ts', migrateEnv);
  for (const user of [roles[1], roles[2], ...banned]) {
    const p = user === roles[1] ? runtime : user === roles[2] ? status : pool(user);
    await denied(p, `create table store.escape (x int)`);
    await denied(p, 'set role ospex_store_migrator');
    for (const table of tables) {
      const writable = user === roles[1] && table.startsWith('campaign_');
      if (!writable) {
        await denied(p, `insert into store.${table} default values`);
        await denied(p, `update store.${table} set cohort_id = cohort_id where false`);
      }
      await denied(p, `delete from store.${table} where false`);
      await denied(p, `truncate store.${table}`);
      if (banned.includes(user as typeof banned[number])) await denied(p, `select * from store.${table}`);
      else await p.query(`select * from store.${table}`);
    }
    for (const call of calls.slice(user === roles[1] ? 5 : 0)) await denied(p, `select ${call}`);
    await denied(p, `select setval('store.campaign_ticks_id_seq', 999)`);
    if (user !== roles[1]) await denied(p, `select nextval('store.campaign_ticks_id_seq')`);
  }
  await denied(runtime, `update store.campaign_authorizations set cohort_id = 'escape'`);
  await denied(runtime, `update store.campaign_ticks set kind = 'resume'`);
  await denied(runtime, `insert into store.campaign_ticks(id,cohort_id,kind,started_at) values(99,'bad','tick',now())`);
  await denied(runtime, `create or replace function store.release_lease(text,text) returns jsonb language sql as 'select null::jsonb'`);
  await denied(runtime, 'alter role ospex_store_runtime createrole');
  await denied(runtime, 'set role ospex_store_status');
  console.log('SH3/SH4 denied DDL, direct money writes, extra campaign columns, helper/RPC/sequence and SET ROLE escapes');

  // All five RPCs through the real adapter as runtime; hostile caller search_path is ignored.
  await runtime.query(`set search_path = public, pg_temp`);
  const s = new SqlAtomicStore(pgStoreQuery(runtime));
  const pins = { cohortId: 'synthetic', schemaVersion: 1, callCap: 2, spendCapUsdMicros: 1000,
    concurrencyLimit: 1, rosterSize: 1, maxRepairsPerArm: 1, initialLeaseBoundMs: 60000, repairLeaseBoundMs: 60000 };
  assert.deepEqual(await s.initCohortBudget(pins), { outcome: 'initialized' });
  const req = { cohortId: pins.cohortId, fireId: 'fire', ownerId: 'worker', expectedSchemaVersion: 1,
    gameId: 'game', proposedMarkets: ['moneyline'] as const,
    scopeReservations: { moneyline: { spendReservationUsdMicros: 500, preparedBytesDigest: 'a'.repeat(64) } } };
  const a = await s.admitDispatch(req);
  assert.equal(a.outcome, 'admitted');
  assert.equal((await s.admitDispatch(req)).outcome, 'replayed');
  assert.equal(a.outcome === 'admitted' && a.dispatchAuthorized, true);
  assert.equal(a.outcome, 'admitted'); if (a.outcome !== 'admitted') throw new Error('unreachable');
  assert.deepEqual(await s.releaseLease({ leaseId: a.initialLeases[0]!.leaseId, ownerId: 'worker' }), { outcome: 'released' });
  const repair = await s.acquireRepairLease({ cohortId: pins.cohortId, fireId: 'fire', ownerId: 'worker', armIndex: 0, repairOrdinal: 1, expectedSchemaVersion: 1 });
  assert.equal(repair.outcome, 'acquired');
  assert.equal((await s.acquireRepairLease({ cohortId: pins.cohortId, fireId: 'fire', ownerId: 'worker', armIndex: 0, repairOrdinal: 1, expectedSchemaVersion: 1 })).outcome, 'replayed');
  assert.deepEqual(await s.completeClaim({ cohortId: pins.cohortId, fireId: 'fire', expectedSchemaVersion: 1, actualCalls: 2, actualSpendUsdMicros: 250 }), { outcome: 'completed' });
  assert.deepEqual(await s.completeClaim({ cohortId: pins.cohortId, fireId: 'fire', expectedSchemaVersion: 1, actualCalls: 2, actualSpendUsdMicros: 250 }), { outcome: 'completed' });
  assert.deepEqual(await s.admitDispatch({ ...req, gameId: 'other', fireId: 'other' }), { outcome: 'refused', reason: 'call_cap', dispatchAuthorized: false });
  assert.deepEqual((await runtime.query('select calls_reserved, spend_reserved_usd_micros from store.cohort_budget')).rows,
    [{ calls_reserved: '2', spend_reserved_usd_micros: '250' }]);

  // Real arm/stop/tick/resume SQL and SELECT-only status need no helper EXECUTE.
  const auth = new SqlCampaignAuthorizationPort(pgStoreQuery(runtime));
  const journal = new SqlCampaignTickJournalPort(pgStoreQuery(runtime), pgStoreTransactor(runtime));
  assert.equal(await auth.arm({ cohortId: pins.cohortId } as CampaignAuthorization), 'armed');
  assert.equal(await auth.disarm(pins.cohortId, '2026-01-01T00:00:00.000Z'), 'disarmed');
  const entry = await journal.begin(pins.cohortId, '2026-01-01T00:00:00.000Z');
  await journal.finish(entry, 'loud_failure', 'synthetic', '2026-01-01T00:01:00.000Z');
  assert.equal(await journal.resume(pins.cohortId, '2026-01-01T00:02:00.000Z', 'synthetic review', entry), 'resumed');
  const reads = new SqlCampaignStatusReadPort(pgStoreQuery(status));
  assert.equal((await reads.budget(pins.cohortId))?.callsReserved, 2);
  assert.equal((await reads.fires(pins.cohortId)).firesCompleted, 1);
  const statusJournal = new SqlCampaignTickJournalPort(pgStoreQuery(status), pgStoreTransactor(status));
  assert.equal((await statusJournal.scheduleWindow(pins.cohortId, [])).entries.length, 1);
  assert.equal((await statusJournal.entries(pins.cohortId, 20)).length, 2);
  assert.equal((await statusJournal.scheduleWindow(pins.cohortId, [])).entries[0]!.startedAt, '2026-01-01T00:02:00.000Z');
  assert.ok(await new SqlCampaignAuthorizationPort(pgStoreQuery(status)).read(pins.cohortId));
  assert.deepEqual(await new SqlUnresolvedFireReadPort(pgStoreQuery(status)).unresolvedFires(pins.cohortId), []);
  console.log('SH5 five RPCs, reservation/replay/repair/settlement and campaign/status adapters PASS');

  // Negative controls: mutate one catalog boundary, require the readback to reject,
  // observe the changed real permission, and roll the whole mutation back.
  const mutations = [
    ['PUBLIC column', 'grant update(calls_reserved) on store.cohort_budget to public'],
    ['status delete', 'grant delete on store.fires to ospex_store_status'],
    ['helper execute', 'grant execute on function store._iso(timestamptz) to ospex_store_runtime'],
    ['RPC public', 'grant execute on function store.release_lease(text,text) to public'],
    ['missing RPC', 'revoke execute on function store.complete_claim(text,text,int,bigint,bigint) from ospex_store_runtime'],
    ['status sequence', 'grant usage on sequence store.campaign_ticks_id_seq to ospex_store_status'],
    ['column grant option', 'grant update(record) on store.campaign_authorizations to ospex_store_runtime with grant option'],
    ['schema grant option', 'grant usage on schema store to ospex_store_runtime with grant option'],
    ['sequence grant option', 'grant usage on sequence store.campaign_ticks_id_seq to ospex_store_runtime with grant option'],
    ['PG17 MAINTAIN', 'grant maintain on store.fires to ospex_store_runtime'],
    ['helper unsafe path', 'alter function store._iso(timestamptz) reset search_path'],
    ['global defaults', 'alter default privileges for role ospex_store_migrator grant execute on functions to public'],
    ['schema defaults', 'alter default privileges for role ospex_store_migrator in schema store grant select on tables to ospex_store_status'],
    ['unsafe path', 'alter function store.release_lease(text,text) set search_path = public, store'],
    ['invoker', 'alter function store.release_lease(text,text) security invoker'],
    ['runtime create', 'grant create on schema store to ospex_store_runtime'],
    ['SET ROLE', 'grant ospex_store_migrator to ospex_store_runtime with inherit false'],
    ['role attribute', 'alter role ospex_store_runtime createrole'],
    ['unknown routine', `create function store.escape() returns int language sql security definer as 'select 1'`],
  ];
  for (const [label, mutation] of mutations) {
    const c = await admin.connect();
    try {
      await c.query('begin'); await c.query(mutation!); await c.query('savepoint before_verify');
      await assert.rejects(c.query(sql('verify.sql')), /store hardening:/, label);
      await c.query('rollback to savepoint before_verify');
      // A real granted forbidden write has teeth; it succeeds inside this rolled-back txn.
      if (label === 'PUBLIC column') {
        await c.query('set local role outsider');
        // PUBLIC schema usage is intentionally absent; grant it for the isolated bite only.
        await c.query('reset role'); await c.query('grant usage on schema store to outsider');
        await c.query('set local role outsider');
        await c.query('update store.cohort_budget set calls_reserved = 0');
        await c.query('reset role');
        assert.equal((await c.query('select calls_reserved from store.cohort_budget')).rows[0].calls_reserved, '0');
      }
      if (label === 'SET ROLE') { await c.query('set local session authorization ospex_store_runtime'); await c.query('set role ospex_store_migrator'); }
      if (label === 'column grant option') {
        await c.query('set local role ospex_store_runtime');
        await c.query('grant update(record) on store.campaign_authorizations to outsider');
        await c.query('reset role');
        assert.equal((await c.query("select has_column_privilege('outsider','store.campaign_authorizations','record','UPDATE') as allowed")).rows[0].allowed, true);
      }
      console.log(`SH6 mutation killed: ${label}`);
    } finally { await c.query('rollback'); c.release(); }
  }
  await run('src/store/migrate.ts', migrateEnv, ['--check']);
  // Transaction rollback on forbidden inherited privileges: no partial function replacement.
  // Committed catalog mutations must also fail the actual read-only CLI, not only
  // the in-transaction verifier. Remove only the synthetic grant in each finally.
  for (const [label, grant, revoke] of [
    ['column grant option', 'grant update(record) on store.campaign_authorizations to ospex_store_runtime with grant option', 'revoke grant option for update(record) on store.campaign_authorizations from ospex_store_runtime'],
    ['schema grant option', 'grant usage on schema store to ospex_store_status with grant option', 'revoke grant option for usage on schema store from ospex_store_status'],
    ['sequence grant option', 'grant usage on sequence store.campaign_ticks_id_seq to ospex_store_runtime with grant option', 'revoke grant option for usage on sequence store.campaign_ticks_id_seq from ospex_store_runtime'],
    ['PG17 MAINTAIN', 'grant maintain on store.fires to ospex_store_status', 'revoke maintain on store.fires from ospex_store_status'],
  ]) {
    await owner.query(grant!);
    try {
      assert.match(await run('src/store/migrate.ts', migrateEnv, ['--check'], 1), /store hardening:/);
      console.log(`SH6 --check mutation killed: ${label}`);
    } finally { await owner.query(revoke!); }
    await owner.query(sql('verify.sql'));
  }
  // Fail at post-DDL readback, not the pre-transaction identity guard. The sentinel
  // invoker definition WOULD be replaced, and the PUBLIC grant WOULD be removed,
  // but an unknown ACL recipient must abort and roll both changes back.
  await owner.query('alter function store.release_lease(text,text) security invoker; grant select on store.fires to outsider; grant select on store.fires to public');
  const fingerprint = async () => (await owner.query(`select p.oid, p.xmin::text, pg_get_functiondef(p.oid) as def, p.proacl::text
    from pg_proc p where pronamespace = 'store'::regnamespace order by p.oid`)).rows;
  const beforeReadbackFailure = await fingerprint();
  assert.match(await run('src/store/migrate.ts', migrateEnv, [], 1), /unexpected ACL recipient/);
  assert.deepEqual(await fingerprint(), beforeReadbackFailure, 'post-DDL failure restores every routine catalog row');
  assert.deepEqual((await owner.query("select has_table_privilege('outsider','store.fires','SELECT') as outsider, has_table_privilege('anon','store.fires','SELECT') as public")).rows, [{ outsider: true, public: true }]);
  await owner.query('revoke select on store.fires from outsider, public; alter function store.release_lease(text,text) security definer');
  await owner.query(sql('verify.sql'));
  assert.deepEqual((await runtime.query('select calls_reserved, spend_reserved_usd_micros from store.cohort_budget')).rows,
    [{ calls_reserved: '2', spend_reserved_usd_micros: '250' }], 'mutation writes and failed migration changed no money');
  console.log('SH7 post-DDL readback failure rolled back routine catalog rows + ACLs + money readback PASS');
  // The identity guard also refuses an inherited/SET ROLE escape before starting DDL.
  await admin.query('grant ospex_store_migrator to ospex_store_runtime with inherit false');
  const before = (await owner.query(`select pg_get_functiondef('store.release_lease(text,text)'::regprocedure) as def`)).rows;
  await run('src/store/migrate.ts', migrateEnv, [], 1);
  assert.deepEqual((await owner.query(`select pg_get_functiondef('store.release_lease(text,text)'::regprocedure) as def`)).rows, before);
  await admin.query('revoke ospex_store_migrator from ospex_store_runtime');
  await run('src/store/migrate.ts', migrateEnv, ['--check']);
  console.log('SH1–SH7 store hardening conformance PASS');
} finally {
  rmSync(home, { recursive: true, force: true });
  await Promise.all(pools.map(p => p.end()));
  if (owned) {
    assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "ospex.store-hardening"}}', name]), name);
    docker(['rm', '--force', name]);
    assert.notEqual(spawnSync('docker', ['inspect', name], { stdio: 'ignore' }).status, 0);
    console.log(`removed owned scratch container ${name}`);
  }
}
