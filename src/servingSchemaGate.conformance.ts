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
 * ── THIS HARNESS IS DESTRUCTIVE, AND OWNS ITS TARGET BEFORE IT TOUCHES IT ─────
 * Unlike the store conformance, this connects as the OWNER — it has to, to
 * build hostile catalogs of SECURITY DEFINER functions and to grant EXECUTE on
 * them. That makes it capable of harm, so it refuses to touch anything it does
 * not own:
 *
 *   1. HOST is pinned to loopback with no override.
 *   2. Before any DDL or grant it proves the target is an EMPTY OWNED SCRATCH:
 *        - NO user object in ANY non-system schema (not only `public`) — a
 *          `business.real_data` table is as disqualifying as a `public` one;
 *        - NO user schema other than `public`;
 *        - NEITHER reserved role (`gate_conformance_probe`, `service_role`)
 *          already exists — it creates and owns both, and a pre-existing one
 *          means this is not a clean scratch (and would be a role it must not
 *          reuse or drop).
 *      Anything else is REFUSED with exit 2, its catalog untouched.
 *   3. It NEVER grants a database-level privilege. A fresh database already
 *      lets PUBLIC (hence the probe role) CONNECT, so no `GRANT … ON DATABASE`
 *      is issued and `pg_database.datacl` is left NULL — nothing to restore.
 *   4. Grants are per-function on the exact function created, never `ON ALL
 *      FUNCTIONS`, so no object it did not make can be altered.
 *   5. It tracks and drops only what it created — functions, then the two enum
 *      types and both reserved roles a bare server lacked. Full cleanup returns
 *      the database and cluster to their prior state, which is what lets a
 *      re-run pass the ownership guard exactly as the first run did.
 *
 * The refusal is one function, `refuseUnlessOwnedScratch`, that the command's
 * own startup and the process-level regression both drive; and a process-level
 * scenario spawns the ACTUAL entry point against hostile targets (a
 * pre-existing role, a business schema) and requires exit 2 with the target
 * unchanged — so a mutation that deletes the top-level guard is caught here, not
 * only in the helper.
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
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { DECLARED_DEFINER_EXEMPTIONS, GATE_STARTUP_OPTIONS, SERVING_SCHEMA_CHECKS } from './servingSchemaGate.js';

const HOST = process.env['BENCHMARK_GATE_CONFORMANCE_DB_HOST'] ?? 'localhost';
const PORT = Number(process.env['BENCHMARK_GATE_CONFORMANCE_DB_PORT'] ?? '5439');
const NAME = process.env['BENCHMARK_GATE_CONFORMANCE_DB_NAME'] ?? 'gate';
const OWNER_PASSWORD = process.env['BENCHMARK_GATE_CONFORMANCE_DB_PASSWORD'] ?? 't';
const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);

// A child invocation runs only the in-process scenarios against its own target,
// never the process-level ones — that is what stops the spawn from recursing.
const IS_CHILD = process.env['BENCHMARK_GATE_CONFORMANCE_CHILD'] === '1';
const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

if (!LOCAL.has(HOST)) {
  // No override exists on purpose: this suite CREATES SECURITY DEFINER
  // functions and rewrites EXECUTE grants. There is no legitimate remote target.
  console.error(`refusing non-local host ${HOST}: this suite builds hostile catalogs`);
  process.exit(2);
}

const PROBE_ROLE = 'gate_conformance_probe';
const PROBE_PASSWORD = 'gate_conformance_probe_pw';
const RESERVED_ROLES = [PROBE_ROLE, 'service_role'];

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
 * Everything that makes a target something other than an empty owned scratch: a
 * user object in ANY non-system schema, a user schema other than `public`, or a
 * reserved role that already exists. Reads only — this is the guard that decides
 * whether the destructive part may run, so it must never itself write.
 */
async function ownershipOffenders(query: RowQuery): Promise<string[]> {
  const objects = await query(
    `select offender from (
        select 'relation ' || n.nspname || '.' || c.relname as offender
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
           and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
        union all
        select 'routine ' || n.nspname || '.' || p.proname
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
        union all
        select 'type ' || n.nspname || '.' || t.typname
          from pg_type t join pg_namespace n on n.oid = t.typnamespace
         where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
           and t.typtype in ('e', 'c', 'd', 'r') and t.typcategory <> 'A'
        union all
        select 'schema ' || nspname
          from pg_namespace
         where nspname !~ '^pg_' and nspname not in ('information_schema', 'public')
      ) o order by offender`,
  );
  const roles = await query(
    'select \'reserved role \' || rolname as offender from pg_roles where rolname = any($1::text[]) order by 1',
    [RESERVED_ROLES],
  );
  return [...objects, ...roles].map((r) => String(r['offender']));
}

/**
 * The ownership guard the command runs before any DDL or grant. THROWS if the
 * target is not an empty owned scratch; returns silently if it is. Reads only,
 * so a refused target is left byte-for-byte as it was found. Extracted so the
 * no-mutation regression can drive the exact predicate the command refuses on.
 */
async function refuseUnlessOwnedScratch(query: RowQuery, dbLabel: string): Promise<void> {
  const offenders = await ownershipOffenders(query);
  if (offenders.length > 0) {
    throw new Error(
      `refusing ${dbLabel}: not an empty owned scratch — found ${offenders.join(', ')}. ` +
        'This suite creates functions, rewrites EXECUTE grants, and owns both reserved roles, ' +
        'so it must be pointed at a fresh disposable database with neither reserved role present ' +
        '(docker run … -e POSTGRES_DB=gate … postgres:17-alpine).',
    );
  }
}

const owner = new Client({ host: HOST, port: PORT, user: 'postgres', password: OWNER_PASSWORD, database: NAME });
await owner.connect();
const ownerQuery: RowQuery = async (sql, params) =>
  (await owner.query(sql, params ? [...params] : undefined)).rows as ReadonlyArray<Record<string, unknown>>;

// ── OWNERSHIP GUARD ─ before any DDL, grant, or scenario ─────────────────────
// If the target is not an empty owned scratch, refuse without touching it. This
// is the line that keeps a green run from mutating a real local database; the
// no-mutation scenario drives this exact function, and the process-level
// scenario proves the wired entry point exits 2 here.
try {
  await refuseUnlessOwnedScratch(ownerQuery, NAME);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await owner.end();
  process.exit(2);
}

/** Only what THIS run creates, so cleanup drops exactly that. Past the guard,
 *  neither reserved role and no user object exists, so these are unconditional. */
const created: string[] = [];
const createdTypes: string[] = [];
const createdRoles: string[] = [];
let probe: Client | undefined;

async function bootstrap(): Promise<void> {
  // The declared signatures reference the protocol's own enum types, which a
  // scratch server does not have; their VALUES are irrelevant to routine
  // identity, only the type names matter. The guard has already proven neither
  // type nor reserved role exists, so these create-and-own unconditionally —
  // and NO `grant connect on database`, because a fresh database already lets
  // PUBLIC connect, so issuing one would be the DB-ACL change the guard forbids.
  for (const [type, ddl] of [
    ['network', "create type public.network as enum ('polygon', 'amoy')"],
    ['position_type', "create type public.position_type as enum ('upper', 'lower')"],
  ] as const) {
    await owner.query(ddl);
    createdTypes.push(`public.${type}`);
  }
  await owner.query('create role service_role nologin');
  createdRoles.push('service_role');
  await owner.query(`create role ${PROBE_ROLE} login password '${PROBE_PASSWORD}'`);
  createdRoles.push(PROBE_ROLE);
}

async function createDefiner(identity: string): Promise<void> {
  await owner.query(
    `create function ${identity} returns void language sql security definer as $f$ select null::void $f$`,
  );
  created.push(identity);
  // Scope the grant surface to EXACTLY this function — never `ON ALL FUNCTIONS`,
  // which would rewrite EXECUTE on every other function in the schema. Creation
  // grants EXECUTE to PUBLIC by default; the scenarios need it service_role-only.
  await owner.query(`revoke execute on function ${identity} from public`);
  await owner.query(`grant execute on function ${identity} to service_role`);
}

async function censusCount(): Promise<number> {
  const rows = await ownerQuery(
    `select count(*)::int as n
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
  );
  return rows[0]!['n'] as number;
}

/** Invoke the ACTUAL command as a child process against `dbName`, so a scenario
 *  proves the WIRED entry point behaves, not just an extracted helper. Fast: a
 *  refused target exits in the guard, a clean one runs the ~2s in-process set. */
function runEntryPoint(dbName: string): { status: number | null; output: string } {
  const result = spawnSync(`npx tsx "${SELF}"`, {
    cwd: REPO_ROOT,
    shell: true,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, BENCHMARK_GATE_CONFORMANCE_CHILD: '1', BENCHMARK_GATE_CONFORMANCE_DB_NAME: dbName },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** A collision-resistant SQL-safe name. Ownership is established only when this
 *  run's CREATE DATABASE succeeds; cleanup never drops a pre-existing name. */
function ownedChildDatabase(label: string): string {
  return `ospex_gate_${label}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

/** A deterministic fingerprint of a database's user catalog plus its datacl, so
 *  "identical post-run state" is a byte comparison rather than a vibe. */
async function catalogFingerprint(dbName: string): Promise<string> {
  const client = new Client({ host: HOST, port: PORT, user: 'postgres', password: OWNER_PASSWORD, database: dbName });
  await client.connect();
  try {
    const rows = await client.query(
      `select coalesce(string_agg(x, '|' order by x), '<empty>') as fp from (
          select 'schema:' || nspname as x from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'
          union all select 'rel:' || n.nspname || '.' || c.relname
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and c.relkind in ('r','p','v','m','S','f')
          union all select 'proc:' || n.nspname || '.' || p.proname
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
          union all select 'type:' || n.nspname || '.' || t.typname
            from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and t.typtype in ('e','c','d','r') and t.typcategory <> 'A'
          union all select 'datacl:' || coalesce((select datacl::text from pg_database where datname = $1), '<null>')
        ) f`,
      [dbName],
    );
    return String(rows.rows[0]!['fp']);
  } finally {
    await client.end();
  }
}

/** Cluster-wide reserved-role state: attributes/config, memberships, and
 *  database-role settings, so a child's refusal is proved byte-identical. */
async function reservedRoleState(): Promise<string> {
  const roles = await ownerQuery(
    `select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
            rolcanlogin, rolreplication, rolconnlimit,
            rolvaliduntil::text as rolvaliduntil, rolbypassrls, rolconfig
       from pg_roles where rolname = any($1::text[]) order by rolname`,
    [RESERVED_ROLES],
  );
  const memberships = await ownerQuery(
    `select pg_get_userbyid(roleid) as role_name,
            pg_get_userbyid(member) as member_name,
            pg_get_userbyid(grantor) as grantor_name,
            admin_option, inherit_option, set_option
       from pg_auth_members
      where pg_get_userbyid(roleid) = any($1::text[])
         or pg_get_userbyid(member) = any($1::text[])
      order by role_name, member_name, grantor_name`,
    [RESERVED_ROLES],
  );
  const settings = await ownerQuery(
    `select r.rolname, coalesce(d.datname, '<all>') as database_name, s.setconfig
       from pg_db_role_setting s
       join pg_roles r on r.oid = s.setrole
       left join pg_database d on d.oid = s.setdatabase
      where r.rolname = any($1::text[])
      order by r.rolname, database_name`,
    [RESERVED_ROLES],
  );
  return JSON.stringify({ roles, memberships, settings });
}

const definerCheck = SERVING_SCHEMA_CHECKS.find((entry) => entry.name.includes('SECURITY DEFINER'));

try {
  if (!IS_CHILD) {
    // ── Process-level regressions: the WIRED entry point against hostile
    //    targets. These run first, while the cluster has neither reserved role
    //    and this database is pristine, and each fully undoes its own fixture.
    await check('the wired command refuses a target where a reserved role already exists, role and DB ACL untouched', async () => {
      // This child DB is collision-resistant and run-owned: CREATE (never a
      // pre-drop) establishes ownership, and cleanup only drops it after that
      // CREATE succeeded. Revoking PUBLIC CONNECT recreates the reported hostile
      // fixture without changing NAME's ACL representation.
      const childDb = ownedChildDatabase('role');
      let createdFixtureDb = false;
      let createdFixtureRole = false;
      try {
        await owner.query(`create database ${childDb}`);
        createdFixtureDb = true;
        await owner.query(`revoke connect on database ${childDb} from public`);
        await owner.query(`create role ${PROBE_ROLE} login password '${PROBE_PASSWORD}'`);
        createdFixtureRole = true;
        const roleConfigBefore = await reservedRoleState();
        const aclBefore = await catalogFingerprint(childDb);
        const child = runEntryPoint(childDb);
        assert.equal(child.status, 2, `a pre-existing reserved role must exit 2; got ${child.status}\n${child.output}`);
        assert.ok(child.output.includes(`reserved role ${PROBE_ROLE}`), `the refusal must name the role: ${child.output}`);
        assert.equal(await reservedRoleState(), roleConfigBefore, 'the pre-existing role must be untouched');
        assert.equal(await catalogFingerprint(childDb), aclBefore, 'the target database ACL/catalog must be untouched');
      } finally {
        if (createdFixtureRole) {
          await owner.query(`drop owned by ${PROBE_ROLE}`).catch(() => undefined);
          await owner.query(`drop role if exists ${PROBE_ROLE}`).catch(() => undefined);
        }
        if (createdFixtureDb) await owner.query(`drop database ${childDb} with (force)`).catch(() => undefined);
      }
    });

    await check('the wired command refuses a target holding a non-public business schema, data untouched', async () => {
      let createdFixtureSchema = false;
      try {
        await owner.query('create schema business');
        createdFixtureSchema = true;
        await owner.query('create table business.real_data(id int primary key)');
        await owner.query("comment on table business.real_data is 'must survive exact'");
        await owner.query('insert into business.real_data values (1)');
        const before = await catalogFingerprint(NAME);
        const rowsBefore = await ownerQuery('select id from business.real_data order by id');
        const relationBefore = await ownerQuery(
          `select pg_get_userbyid(c.relowner) as owner,
                  coalesce(c.relacl::text, '<null>') as acl,
                  obj_description(c.oid, 'pg_class') as comment
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'business' and c.relname = 'real_data'`,
        );
        const child = runEntryPoint(NAME);
        assert.equal(child.status, 2, `a non-public business schema must exit 2; got ${child.status}\n${child.output}`);
        assert.ok(child.output.includes('business'), `the refusal must name the business schema: ${child.output}`);
        assert.equal(await catalogFingerprint(NAME), before, 'the business schema catalog must be untouched');
        assert.deepEqual(await ownerQuery('select id from business.real_data order by id'), rowsBefore, 'the business data must be untouched');
        assert.deepEqual(
          await ownerQuery(
            `select pg_get_userbyid(c.relowner) as owner,
                    coalesce(c.relacl::text, '<null>') as acl,
                    obj_description(c.oid, 'pg_class') as comment
               from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'business' and c.relname = 'real_data'`,
          ),
          relationBefore,
          'the business relation owner, ACL, and comment must be untouched',
        );
      } finally {
        if (createdFixtureSchema) await owner.query('drop schema business cascade').catch(() => undefined);
      }
    });

    await check('the wired command runs and RE-runs on an empty target with byte-identical catalog state', async () => {
      const before = `${await catalogFingerprint(NAME)}||roles:${await reservedRoleState()}`;
      const run1 = runEntryPoint(NAME);
      assert.equal(run1.status, 0, `the first run on an empty target must pass; got ${run1.status}\n${run1.output}`);
      assert.ok(run1.output.includes('7/7 scenarios passed'), `the child runs its in-process scenarios: ${run1.output}`);
      const run2 = runEntryPoint(NAME);
      assert.equal(run2.status, 0, `the rerun must pass; got ${run2.status}\n${run2.output}`);
      assert.ok(run2.output.includes('7/7 scenarios passed'), `the rerun runs its in-process scenarios: ${run2.output}`);
      const after = `${await catalogFingerprint(NAME)}||roles:${await reservedRoleState()}`;
      assert.equal(after, before, 'two full runs must leave the catalog and cluster roles exactly as found');
    });
  }

  // ── In-process scenarios (both the parent and every child run these) ────────
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
                  pg_get_userbyid(p.proowner) as owner,
                  coalesce(p.proacl::text, '<null>') as acl
             from pg_proc p where p.oid = ${canaryRef}`,
        );
        return rows[0] as { def: string; comment: string; owner: string; acl: string };
      };
      const before = await snapshot();

      // Drive the EXACT function the command refuses on, and require it to throw
      // naming the canary — proving a routine-bearing target is refused before
      // any mutation, since this call is the command's first act.
      await assert.rejects(
        refuseUnlessOwnedScratch(ownerQuery, NAME),
        (error: Error) => error.message.includes('ospex_gate_canary') && /not an empty owned scratch/.test(error.message),
        'the guard must refuse a target holding a routine canary and name it',
      );

      const after = await snapshot();
      assert.equal(after.def, before.def, 'the guard must not alter the canary definition');
      assert.equal(after.comment, before.comment, 'the guard must not alter the canary comment');
      assert.equal(after.owner, before.owner, 'the guard must not alter the canary owner');
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
    // ⚠ THE `^` ABOVE ANCHORS THE HEAD AND SEES NOTHING APPENDED AFTER IT, so
    //   on its own it passes silently through any change to this branch — it
    //   would have accepted eighteen pruning instructions printed onto a
    //   healthy scratch catalog. The two assertions below are what actually
    //   hold the branch: the unmatched count is REPORTED here, because on the
    //   live projection an empty census means every declared entry is stale;
    //   and it is never phrased as an instruction, because from here the gate
    //   cannot tell a wholesale revoke from a scratch database's first run.
    assert.ok(
      verdict.detail.includes(`${DECLARED_DEFINER_EXEMPTIONS.size} declared exemption(s) matched nothing here`),
      'the unmatched declared count is reported on the empty-census branch',
    );
    assert.ok(!verdict.detail.includes('prune'), 'and this branch never instructs a prune');
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
    // The catalog here is exactly the 18 declared functions (previous scenario),
    // twelve of which carry custom types (network, position_type) whose
    // rendering depends on the session search_path. Force the probe role's
    // default to exclude public — the `ALTER ROLE … SET search_path = ''`
    // hardening Supabase's linter encourages — and prove BOTH directions:
    //   (a) an UNPINNED connection inherits the hostile default, the census
    //       renders `public.network`, and the gate reds — the coupling is real;
    //   (b) a connection carrying the gate's OWN startup options pins
    //       search_path=public over the role default and the gate passes.
    // The role is one THIS run created and drops, so this alters nothing
    // pre-existing (the ownership guard has already refused a pre-existing one).
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
  // (they reference the types and are granted to the role), then the types, then
  // the reserved roles — `DROP OWNED BY` clears any grant the role still holds so
  // the DROP ROLE succeeds and leaves no residue.
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
      await owner.query(`drop owned by ${role}`);
      await owner.query(`drop role if exists ${role}`);
    } catch {
      // best-effort; the ownership guard refuses a dirty rerun, and a fresh
      // container is the guaranteed reset.
    }
  }
  await owner.end();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
if (failed.length > 0) process.exit(1);
