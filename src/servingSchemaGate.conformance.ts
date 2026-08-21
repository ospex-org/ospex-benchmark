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
 * passed a 41-row catalog as clean. Layer coverage is split deliberately: these
 * scenarios prove the SQL layer (what the census returns), and the unit suite's
 * 41-fake-row test proves the classification layer (what the verdict does with
 * rows) — a cap reintroduced in either place goes red somewhere.
 *
 * WHAT THE ROUND-TRIP SCENARIO DOES AND DOES NOT PROVE. Creating every declared
 * signature from its own exemption string and reading it back through the
 * census is a round trip through the server's normalizer: if an entry drifts
 * from the catalog's emission format (`int` for `integer`, a missing argument
 * name), the recreated function comes back under a different string and the
 * scenario reds. It does NOT prove the entries match the LIVE project's
 * functions — that is measured against production by `yarn gate:serving` itself.
 *
 * ── THIS HARNESS IS DESTRUCTIVE, AND OWNS ITS TARGET BEFORE IT TOUCHES IT ─────
 * Unlike the store conformance, this connects as the OWNER — it has to, to
 * build hostile catalogs of SECURITY DEFINER functions and to grant EXECUTE on
 * them. That makes it capable of harm, so two guards stand between it and any
 * database that is not a throwaway:
 *
 *   1. HOST is pinned to loopback with no override. There is no legitimate
 *      remote target.
 *   2. Before any DDL or grant, it proves the target's `public` schema is an
 *      EMPTY scratch — no relations, no routines, no user types. A database
 *      that holds anything of its own (a real function, a real table) is
 *      REFUSED with exit 2, its contents untouched. This is what stops a green
 *      run from silently rewriting grants on someone's local development
 *      database; the routine-canary scenario below proves the refusal fires
 *      and changes nothing.
 *
 * Everything it then creates — functions, and the two enum types and probe
 * role a bare server lacks — is tracked and dropped on the way out, and only
 * what it actually created (a role that already existed is left alone). Grants
 * are issued per-function on the exact function created, never `ON ALL
 * FUNCTIONS`, so no object it did not make can be altered. Full cleanup is also
 * what makes a re-run work: the second run finds the database empty again and
 * passes the ownership guard exactly as the first did (or use a fresh
 * container).
 *
 * The CHECK itself still runs as a dedicated non-superuser login: a superuser
 * sees EXECUTE on everything, so running the check as one would redden every
 * scenario for a reason under the harness's own name rather than the catalog
 * under test.
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
  // functions and rewrites EXECUTE grants. There is no legitimate remote target.
  console.error(`refusing non-local host ${HOST}: this suite builds hostile catalogs`);
  process.exit(2);
}

const PROBE_ROLE = 'gate_conformance_probe';
const PROBE_PASSWORD = 'gate_conformance_probe_pw';

/** `schema.name(identity arguments)` for every declared exemption. */
const DECLARED_FNS = [...DECLARED_DEFINER_EXEMPTIONS].map((entry) => entry.split(' -> ')[1]!);

type RowQuery = (sql: string, params?: readonly unknown[]) => Promise<ReadonlyArray<Record<string, unknown>>>;

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

/**
 * Every object in `public` that makes a database something other than an empty
 * scratch: a relation (table/view/sequence/matview/foreign table), a routine
 * of any kind, or a user type. Reads only — this is the guard that decides
 * whether the destructive part may run, so it must never itself write. The
 * routine union is what refuses a target holding someone else's function.
 */
async function scratchOffenders(query: RowQuery): Promise<string[]> {
  const rows = await query(
    `select kind || ' ' || name as offender from (
        select 'relation' as kind, c.relname as name
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
        union all
        select 'routine', p.proname
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
        union all
        select 'type', t.typname
          from pg_type t join pg_namespace n on n.oid = t.typnamespace
         where n.nspname = 'public' and t.typtype in ('e', 'c', 'd', 'r') and t.typcategory <> 'A'
      ) offenders order by 1`,
  );
  return rows.map((r) => String(r['offender']));
}

/**
 * The ownership guard the command runs before any DDL or grant. THROWS if the
 * target is not an empty scratch; returns silently if it is. Reads only, so a
 * refused target is left byte-for-byte as it was found. Extracted so the
 * no-mutation regression can drive the exact predicate the command refuses on,
 * not merely its ingredients.
 */
async function refuseUnlessEmptyScratch(query: RowQuery, dbLabel: string): Promise<void> {
  const offenders = await scratchOffenders(query);
  if (offenders.length > 0) {
    throw new Error(
      `refusing ${dbLabel}: its public schema is not an empty scratch — found ${offenders.join(', ')}. ` +
        'This suite creates functions and rewrites EXECUTE grants, so it must own an empty target. ' +
        'Point it at a fresh disposable database (docker run … -e POSTGRES_DB=gate … postgres:17-alpine).',
    );
  }
}

const owner = new Client({ host: HOST, port: PORT, user: 'postgres', password: OWNER_PASSWORD, database: NAME });
await owner.connect();
const ownerQuery: RowQuery = async (sql, params) =>
  (await owner.query(sql, params ? [...params] : undefined)).rows as ReadonlyArray<Record<string, unknown>>;

// ── OWNERSHIP GUARD ─ before any DDL, grant, or scenario ─────────────────────
// If the target is not an empty scratch, refuse without touching it. This is
// the line that keeps a green run from silently rewriting grants on a real
// local database; the routine-canary scenario below drives this exact function
// and proves it throws and mutates nothing.
try {
  await refuseUnlessEmptyScratch(ownerQuery, NAME);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await owner.end();
  process.exit(2);
}

/** Only what THIS run creates, so cleanup drops exactly that and a role or type
 *  that already existed is left untouched. */
const created: string[] = [];
const createdTypes: string[] = [];
const createdRoles: string[] = [];
let probe: Client | undefined;

async function bootstrap(): Promise<void> {
  // The declared signatures reference the protocol's own enum types, which a
  // scratch server does not have; their VALUES are irrelevant to routine
  // identity, only the type names matter. Create each only if absent, and
  // remember which we made, so cleanup never drops a pre-existing object.
  for (const [type, ddl] of [
    ['network', "create type public.network as enum ('polygon', 'amoy')"],
    ['position_type', "create type public.position_type as enum ('upper', 'lower')"],
  ] as const) {
    const exists = await ownerQuery(
      `select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = $1`,
      [type],
    );
    if (exists.length === 0) {
      await owner.query(ddl);
      createdTypes.push(`public.${type}`);
    }
  }
  for (const [role, ddl] of [
    ['service_role', 'create role service_role nologin'],
    [PROBE_ROLE, `create role ${PROBE_ROLE} login password '${PROBE_PASSWORD}'`],
  ] as const) {
    const exists = await ownerQuery('select 1 from pg_roles where rolname = $1', [role]);
    if (exists.length === 0) {
      await owner.query(ddl);
      createdRoles.push(role);
    }
  }
  await owner.query(`grant connect on database ${NAME} to ${PROBE_ROLE}`);
}

async function createDefiner(identity: string): Promise<void> {
  await owner.query(
    `create function ${identity} returns void language sql security definer as $f$ select null::void $f$`,
  );
  created.push(identity);
  // Scope the grant surface to EXACTLY this function — never `ON ALL FUNCTIONS`,
  // which would rewrite EXECUTE on every other function in the schema (the B2
  // hazard this harness was refused for). Creation grants EXECUTE to PUBLIC by
  // default; the scenarios need it to be service_role-only.
  await owner.query(`revoke execute on function ${identity} from public`);
  await owner.query(`grant execute on function ${identity} to service_role`);
}

/** The catalog's own answer, from the server, so a scenario proves the rows it
 *  claims to test really exist (a setup failure and a pass look identical
 *  otherwise). */
async function censusCount(): Promise<number> {
  const rows = await ownerQuery(
    `select count(*)::int as n
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
  );
  return rows[0]!['n'] as number;
}

const definerCheck = SERVING_SCHEMA_CHECKS.find((entry) => entry.name.includes('SECURITY DEFINER'));

try {
  // Runs FIRST, while public is still pristine, so the only offender the guard
  // can find is the canary — isolating the routine detection from the enum
  // types bootstrap will add next.
  await check('a routine canary makes the target non-scratch, is named as the offender, and is left untouched', async () => {
    const canary = 'public.ospex_gate_canary(x integer)';
    const canaryRef = "'public.ospex_gate_canary(integer)'::regprocedure";
    await owner.query(`create function ${canary} returns integer language sql as $c$ select x $c$`);
    try {
      await owner.query(
        `comment on function ${canary} is 'ospex gate conformance canary — the guard must leave this byte-for-byte untouched'`,
      );
      // Revoking PUBLIC materialises proacl to the owner's own grant, so a stray
      // `grant … to service_role` would show up as an ACL change.
      await owner.query(`revoke execute on function ${canary} from public`);

      const snapshot = async () => {
        const rows = await ownerQuery(
          `select pg_get_functiondef(${canaryRef}) as def,
                  obj_description(${canaryRef}, 'pg_proc') as comment,
                  coalesce((select proacl::text from pg_proc where oid = ${canaryRef}), '<null>') as acl`,
        );
        return rows[0] as { def: string; comment: string; acl: string };
      };
      const before = await snapshot();

      // Drive the EXACT function the command refuses on, and require it to
      // throw naming the canary — proving a routine-bearing target is refused
      // before any mutation, since this call is the command's first act.
      await assert.rejects(
        refuseUnlessEmptyScratch(ownerQuery, NAME),
        (error: Error) => error.message.includes('ospex_gate_canary') && /not an empty scratch/.test(error.message),
        'the guard must refuse a target holding a routine canary and name it',
      );

      const after = await snapshot();
      assert.equal(after.def, before.def, 'the guard must not alter the canary definition');
      assert.equal(after.comment, before.comment, 'the guard must not alter the canary comment');
      assert.equal(after.acl, before.acl, 'the guard must not alter the canary ACL');
    } finally {
      await owner.query(`drop function if exists ${canary}`);
    }
  });

  await bootstrap();
  probe = new Client({ host: HOST, port: PORT, user: PROBE_ROLE, password: PROBE_PASSWORD, database: NAME });
  await probe.connect();
  const probeQuery: RowQuery = async (sql, params) =>
    (await probe!.query(sql, params ? [...params] : undefined)).rows as ReadonlyArray<Record<string, unknown>>;

  await check('the harness itself: check runs as a non-superuser, or every verdict is about the harness', async () => {
    const rows = await probeQuery('select current_user as u, (select rolsuper from pg_roles where rolname = current_user) as s');
    assert.equal(rows[0]!['u'], PROBE_ROLE);
    assert.equal(rows[0]!['s'], false, 'a superuser probe holds EXECUTE on everything and reddens every scenario');
  });

  await check('a clean catalog passes (empty-scratch first run)', async () => {
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
        const q: RowQuery = async (sql, params) =>
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
        const q: RowQuery = async (sql, params) =>
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
  // Drop exactly what this run created, in dependency order: functions first
  // (they reference the types and are granted to the role), then the types and
  // roles this run made — never one it found already there.
  for (const identity of created.reverse()) {
    try {
      await owner.query(`drop function if exists ${identity}`);
    } catch {
      // teardown is best-effort on a disposable database
    }
  }
  for (const type of createdTypes.reverse()) {
    try {
      await owner.query(`drop type if exists ${type}`);
    } catch {
      // best-effort
    }
  }
  if (probe) {
    try {
      await probe.end();
    } catch {
      // best-effort
    }
  }
  for (const role of createdRoles.reverse()) {
    try {
      // A role holding a grant (the probe role is granted CONNECT on the
      // database) cannot be dropped while that dependency stands. `DROP OWNED
      // BY` revokes every privilege granted TO this role in this database and
      // drops anything it owns — safe because these are roles THIS run created,
      // which own nothing of anyone else's — so the DROP ROLE then succeeds and
      // leaves no residue. A fresh container is still the guaranteed reset, and
      // the ownership guard refuses a dirty rerun.
      await owner.query(`drop owned by ${role}`);
      await owner.query(`drop role if exists ${role}`);
    } catch {
      // best-effort on a disposable database
    }
  }
  await owner.end();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
if (failed.length > 0) process.exit(1);
