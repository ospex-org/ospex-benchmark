/**
 * The definer-function check against REAL PostgreSQL catalogs it must refuse —
 * proving what the scripted-query suite cannot: that the census statement,
 * executed by a real server over a real pg_proc, returns every row the verdict
 * needs, and that the declared exemption strings match what
 * `pg_get_function_identity_arguments` actually emits.
 *
 * The review reproduction this pins (2026-08-21, PR #108): keyed on the bare
 * name, an undeclared overload `rpc_active_recovery_run(hostile text)`
 * classified as exempt; and with `limit 40` on the census, 40 overloads of a
 * declared name sorted ahead of an undeclared `zz_undeclared()` and the gate
 * passed a 41-row catalog as clean. Layer coverage is split deliberately:
 * these scenarios prove the SQL layer (what the census returns), and the unit
 * suite's 41-fake-row test proves the classification layer (what the verdict
 * does with rows) — a cap reintroduced in either place goes red somewhere.
 *
 * WHAT SCENARIO 2 DOES AND DOES NOT PROVE. Creating every declared signature
 * from its own exemption string and reading it back through the census is a
 * round trip through the server's normalizer: if an entry drifts from the
 * catalog's emission format (`int` for `integer`, a missing argument name),
 * the recreated function comes back under a different string and the scenario
 * reds. It does NOT prove the entries match the LIVE project's functions —
 * that is measured against production by `yarn gate:serving` itself.
 *
 * UNLIKE THE STORE CONFORMANCE, THIS CONNECTS AS THE OWNER — it has to, to
 * build hostile catalogs — so it may NEVER be pointed at a shared database.
 * The host is pinned to loopback with no override, and everything it creates
 * is dropped on the way out. The CHECK itself still runs as a dedicated
 * non-superuser login: a superuser sees EXECUTE on everything, so running the
 * check as one would redden every scenario for a reason under the harness's
 * own name rather than the catalog under test.
 *
 * NOT part of `yarn test`: that suite is pure, and CI has no database.
 *
 * SETUP — a bare disposable PostgreSQL 17, nothing pre-applied:
 *
 *   docker run -d --name gatefix -e POSTGRES_PASSWORD=t \
 *     -e POSTGRES_DB=gate -p 5439:5432 postgres:17-alpine
 *   yarn gate:serving:conformance
 */
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { DECLARED_DEFINER_EXEMPTIONS, GATE_STARTUP_OPTIONS, SERVING_SCHEMA_CHECKS } from './servingSchemaGate.js';

const HOST = process.env['BENCHMARK_GATE_CONFORMANCE_DB_HOST'] ?? 'localhost';
const PORT = Number(process.env['BENCHMARK_GATE_CONFORMANCE_DB_PORT'] ?? '5439');
const NAME = process.env['BENCHMARK_GATE_CONFORMANCE_DB_NAME'] ?? 'gate';
const OWNER_PASSWORD = process.env['BENCHMARK_GATE_CONFORMANCE_DB_PASSWORD'] ?? 't';
const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);

if (!LOCAL.has(HOST)) {
  // No override exists on purpose: this suite CREATES SECURITY DEFINER
  // functions and mangles EXECUTE grants. There is no legitimate remote target.
  console.error(`refusing non-local host ${HOST}: this suite builds hostile catalogs`);
  process.exit(2);
}

const PROBE_ROLE = 'gate_conformance_probe';
const PROBE_PASSWORD = 'gate_conformance_probe_pw';

/** `schema.name(identity arguments)` for every declared exemption. */
const DECLARED_FNS = [...DECLARED_DEFINER_EXEMPTIONS].map((entry) => entry.split(' -> ')[1]!);

const results: Array<{ name: string; ok: boolean }> = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok    ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const owner = new Client({ host: HOST, port: PORT, user: 'postgres', password: OWNER_PASSWORD, database: NAME });
await owner.connect();

// Bare-container bootstrap, idempotent so a re-run or a pre-provisioned
// database both work. The declared signatures reference the protocol's own
// enum types, which a scratch server does not have; their VALUES are
// irrelevant to routine identity, only the type names matter.
for (const statement of [
  "do $$ begin create type public.network as enum ('polygon', 'amoy'); exception when duplicate_object then null; end $$",
  "do $$ begin create type public.position_type as enum ('upper', 'lower'); exception when duplicate_object then null; end $$",
  'do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$',
  `do $$ begin create role ${PROBE_ROLE} login password '${PROBE_PASSWORD}'; exception when duplicate_object then null; end $$`,
  `grant connect on database ${NAME} to ${PROBE_ROLE}`,
]) {
  await owner.query(statement);
}

const probe = new Client({ host: HOST, port: PORT, user: PROBE_ROLE, password: PROBE_PASSWORD, database: NAME });
await probe.connect();
const probeQuery = async (sql: string, params?: readonly unknown[]) =>
  (await probe.query(sql, params ? [...params] : undefined)).rows as ReadonlyArray<Record<string, unknown>>;

const definerCheck = SERVING_SCHEMA_CHECKS.find((entry) => entry.name.includes('SECURITY DEFINER'));

/** Functions created so far, by full identity, so teardown drops exactly them. */
const created: string[] = [];
async function createDefiner(identity: string): Promise<void> {
  await owner.query(
    `create function ${identity} returns void language sql security definer as $f$ select null::void $f$`,
  );
  created.push(identity);
  // Creation grants EXECUTE to PUBLIC by default; the scenarios need the grant
  // surface to be exactly service_role, every time an object is added.
  await owner.query('revoke execute on all functions in schema public from public');
  await owner.query('grant execute on all functions in schema public to service_role');
}

/** The catalog's own answer, from the server, so a scenario proves the rows it
 *  claims to test really exist (a setup failure and a pass look identical
 *  otherwise). */
async function censusCount(): Promise<number> {
  const rows = await owner.query(
    `select count(*)::int as n
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
  );
  return rows.rows[0].n as number;
}

try {
  await check('the harness itself: check runs as a non-superuser, or every verdict is about the harness', async () => {
    const rows = await probeQuery('select current_user as u, (select rolsuper from pg_roles where rolname = current_user) as s');
    assert.equal(rows[0]!['u'], PROBE_ROLE);
    assert.equal(rows[0]!['s'], false, 'a superuser probe holds EXECUTE on everything and reddens every scenario');
  });

  await check('a clean catalog passes', async () => {
    assert.equal(await censusCount(), 0, 'the scratch database must start with no definer grants');
    const verdict = await definerCheck!.run(probeQuery);
    assert.equal(verdict.ok, true);
    assert.match(verdict.detail, /^no role this gate checks may execute/);
  });

  await check('every declared exemption string round-trips through a real catalog', async () => {
    for (const fn of DECLARED_FNS) await createDefiner(fn);
    assert.equal(await censusCount(), DECLARED_FNS.length);
    const verdict = await definerCheck!.run(probeQuery);
    assert.equal(verdict.ok, true, verdict.detail);
    assert.match(verdict.detail, /^18 definer grant\(s\), every one a declared exemption/);
    assert.ok(!verdict.detail.includes('prune'), 'every entry must be matched — a prune note means one drifted from the emission format');
  });

  await check('the search_path pin holds the census to bare type names under a hostile role default', async () => {
    // The catalog here is exactly the 18 declared functions (previous
    // scenario), twelve of which carry custom types (network, position_type)
    // whose rendering depends on the session search_path. Force the probe
    // role's default to exclude public — the `ALTER ROLE … SET search_path =
    // ''` hardening Supabase's linter encourages — and prove BOTH directions:
    //   (a) an UNPINNED connection inherits the hostile default, the census
    //       renders `public.network`, and the gate reds on the protocol's own
    //       RPCs — the coupling the identity-args form introduced is real;
    //   (b) a connection carrying the gate's OWN startup options pins
    //       search_path=public over the role default, the census renders bare
    //       names, and the gate passes.
    // Without (a) the scenario could pass by the coupling never existing;
    // without (b) the pin could be a no-op. Both are required.
    await owner.query(`alter role ${PROBE_ROLE} set search_path = ''`);
    try {
      const unpinned = new Client({ host: HOST, port: PORT, user: PROBE_ROLE, password: PROBE_PASSWORD, database: NAME });
      await unpinned.connect();
      try {
        const q = async (sql: string, params?: readonly unknown[]) =>
          (await unpinned.query(sql, params ? [...params] : undefined)).rows as ReadonlyArray<Record<string, unknown>>;
        const verdict = await definerCheck!.run(q);
        assert.equal(verdict.ok, false, 'unpinned, a hostile role default must red the gate — this is the coupling the pin removes');
        assert.ok(verdict.detail.includes('public.network'), 'the schema-qualified rendering is exactly what breaks the declared match');
      } finally {
        await unpinned.end();
      }

      const pinned = new Client({
        host: HOST, port: PORT, user: PROBE_ROLE, password: PROBE_PASSWORD, database: NAME,
        options: GATE_STARTUP_OPTIONS,
      });
      await pinned.connect();
      try {
        const q = async (sql: string, params?: readonly unknown[]) =>
          (await pinned.query(sql, params ? [...params] : undefined)).rows as ReadonlyArray<Record<string, unknown>>;
        const verdict = await definerCheck!.run(q);
        assert.equal(verdict.ok, true, `the pin must restore the pass: ${verdict.detail}`);
        assert.match(verdict.detail, /^18 definer grant\(s\), every one a declared exemption/);
      } finally {
        await pinned.end();
      }
    } finally {
      await owner.query(`alter role ${PROBE_ROLE} reset search_path`);
    }
  });

  await check('an overload of a declared name is refused; the declared signature stays exempt', async () => {
    await createDefiner('public.rpc_recovery_run_complete(p_id bigint, hostile text)');
    const verdict = await definerCheck!.run(probeQuery);
    assert.equal(verdict.ok, false, 'an unreviewed overload under a reviewed name must redden the gate');
    assert.ok(verdict.detail.includes('service_role -> public.rpc_recovery_run_complete(p_id bigint, hostile text)'));
    assert.match(verdict.detail, /^1 executable/, 'exactly one row violates: the 18 declared signatures are still exempt');
  });

  await check('an undeclared function cannot hide behind 40 rows that sort ahead of it', async () => {
    // The review's flood, rebuilt for real: 39 more overloads plus
    // `zz_undeclared`, which sorts LAST — exactly where a `limit 40` cut it.
    for (let arity = 2; arity <= 40; arity += 1) {
      const args = Array.from({ length: arity }, (_, i) => `a${i + 1} integer`).join(', ');
      await createDefiner(`public.rpc_recovery_run_complete(${args})`);
    }
    await createDefiner('public.zz_undeclared()');
    const catalog = await censusCount();
    assert.equal(catalog, DECLARED_FNS.length + 1 + 39 + 1, 'the flood must really be in the catalog');
    const verdict = await definerCheck!.run(probeQuery);
    assert.equal(verdict.ok, false);
    // The count in the detail is the truncation proof: it equals the number of
    // violating catalog rows, so no row was dropped between server and verdict.
    assert.match(verdict.detail, /^41 executable/);
    assert.ok(verdict.detail.includes('and 21 more not displayed'), 'display truncation must announce itself with the count');
  });
} finally {
  for (const identity of created.reverse()) {
    try {
      await owner.query(`drop function if exists ${identity}`);
    } catch {
      // teardown is best-effort on a disposable database
    }
  }
  await probe.end();
  await owner.end();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
if (failed.length > 0) process.exit(1);
