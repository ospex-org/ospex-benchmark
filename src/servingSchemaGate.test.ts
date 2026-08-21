import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dialsThisMachine,
  DECLARED_DEFINER_EXEMPTIONS,
  GATE_EXIT,
  GATE_STARTUP_OPTIONS,
  isExemptDefiner,
  proveEncrypted,
  proveReadOnly,
  READ_ONLY_STARTUP_OPTION,
  readRowCounts,
  runChecks,
  runSchemaGate,
  SEARCH_PATH_STARTUP_OPTION,
  SERVING_SCHEMA_CHECKS,
} from './servingSchemaGate.js';
import type { GateCheck, GateConnection, GateQuery, SchemaGateDeps } from './servingSchemaGate.js';
import type { BenchmarkWriterConnection } from './benchmarkServingConfig.js';
import { SERVING_TABLES } from './servingStore.js';

/**
 * The preflight's own safety properties, which are the ones worth a suite: that
 * it cannot write, that it says so when it could, and that a failure anywhere
 * reaches the exit code.
 *
 * The SCHEMA assertions are not tested here and could not usefully be — they are
 * questions for a real PostgreSQL, and `yarn store:serving` is where a real one
 * lives. What this file pins is the machinery around them.
 */

function rowsFor(answers: Record<string, ReadonlyArray<Record<string, unknown>>>): {
  query: GateQuery;
  seen: string[];
} {
  const seen: string[] = [];
  const query: GateQuery = async (sql) => {
    seen.push(sql);
    for (const [needle, rows] of Object.entries(answers)) {
      if (sql.includes(needle)) return rows;
    }
    return [];
  };
  return { query, seen };
}

// ---------------------------------------------------------------------------
// The read-only precondition
// ---------------------------------------------------------------------------

test('read-only is proven by the refusal, not by the setting', async () => {
  const refuse = async (): Promise<never> => {
    throw Object.assign(new Error('cannot execute INSERT in a read-only transaction'), { code: '25006' });
  };
  assert.equal((await proveReadOnly(refuse)).ok, true);
});

test('a connection that ACCEPTS the probe is refused, and that is the whole point', async () => {
  // The negative control for the check above. If this passed, the gate would
  // run unreviewed statements against a database whose rows cannot be deleted,
  // in order to find out whether that was safe.
  const accept: GateQuery = async () => [];
  const verdict = await proveReadOnly(accept);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /ACCEPTED a write/);
});

test('a refusal for some OTHER reason does not count as proof', async () => {
  // 42501 means the role lacks INSERT here. That is not the question: a role
  // with no grant on this one table could still write to the other nine.
  for (const code of ['42501', '42P01', undefined]) {
    const other = async (): Promise<never> => {
      throw Object.assign(new Error('nope'), code === undefined ? {} : { code });
    };
    const verdict = await proveReadOnly(other);
    assert.equal(verdict.ok, false, `${String(code)} must not be read as a read-only refusal`);
    assert.match(verdict.detail, /could not prove/);
  }
});

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

test('an unencrypted session is refused unless the target is this machine', () => {
  assert.equal(proveEncrypted({ ssl: true, version: 'TLSv1.3' }, false).ok, true);
  assert.equal(proveEncrypted({ ssl: true, version: 'TLSv1.3' }, true).ok, true);
  assert.equal(proveEncrypted({ ssl: false, version: null }, true).ok, true);

  const remote = proveEncrypted({ ssl: false, version: null }, false);
  assert.equal(remote.ok, false);
  assert.match(remote.detail, /in the clear/);

  // A server that answers nothing is not an encrypted server.
  assert.equal(proveEncrypted({ ssl: undefined, version: undefined }, false).ok, false);
});

test('local is decided by the host DIALLED, and an unknown host is remote', () => {
  const derived = (host: string): BenchmarkWriterConnection => ({
    kind: 'derived', host, port: 5432, user: 'u', database: 'd', password: 'p',
    ssl: { rejectUnauthorized: false },
  });
  assert.equal(dialsThisMachine(derived('localhost')), true);
  assert.equal(dialsThisMachine(derived('127.0.0.1')), true);
  // The prefix trap: a name anybody can register. It must NOT read as local,
  // because reading it as local is what sends a password to it in the clear.
  assert.equal(dialsThisMachine(derived('127.0.0.1.evil.com')), false);
  assert.equal(dialsThisMachine(derived('db.example.com')), false);

  assert.equal(dialsThisMachine({ kind: 'dsn', connectionString: 'postgres://u:p@localhost:5436/d' }), true);
  assert.equal(dialsThisMachine({ kind: 'dsn', connectionString: 'postgres://u:p@db.example.com/d' }), false);
  // The host the driver DIALS, which a query parameter overrides.
  assert.equal(
    dialsThisMachine({ kind: 'dsn', connectionString: 'postgres://u:p@localhost/d?host=db.example.com' }),
    false,
    'a ?host= parameter is the host that gets dialled',
  );
});

// ---------------------------------------------------------------------------
// The checks, as a set
// ---------------------------------------------------------------------------

test('NOTHING the checks issue can write, on either server-version branch', async () => {
  // The gate is pointed at a database whose rows are insert-once and whose
  // lifetime insert count is itself evidence. The server refuses writes, and
  // this is the second lock: a check added later that issues one is caught here,
  // in a suite with no database, rather than by the server on the day someone
  // runs it against production.
  //
  // Both branches, because the statement check picks its verb from the server
  // version and a sweep of one branch would leave the other unexamined.
  // Non-empty answers for the catalog reads too, so the checks that only issue
  // their SECOND query when the first returned rows are actually reached. With
  // an all-empty fake, two of them return early and this sweep never sees the
  // statements they would have sent.
  const catalog = {
    pg_roles: [{ rolname: 'anon' }, { rolname: 'service_role' }],
    pg_index: [{ name: 'i', cols: ['lab_id', 'model_id', 'configuration'], uniq: true,
                 nulls_not_distinct: true, valid: true, predicate: "(kind = 'model'::text)" }],
    pg_constraint: [{ def: 'CHECK (true)' }],
    'information_schema.columns': [{ name: 'confidence', p: 9, s: 8 }],
  };
  for (const version of [170010, 150000]) {
    const { query, seen } = rowsFor({ server_version_num: [{ v: version }], ...catalog });
    await runChecks(SERVING_SCHEMA_CHECKS, query);
    assert.ok(seen.length > 0, 'the checks issued no SQL at all, so this asserts nothing');
    for (const sql of seen) {
      const verb = sql.trimStart().slice(0, 40).toLowerCase();
      assert.ok(
        verb.startsWith('select') || verb.startsWith('explain (generic_plan)') || verb.startsWith('prepare'),
        `a check issued a statement that is not a read: ${sql.slice(0, 120)}`,
      );
    }
  }
});

test('a check that throws becomes a failed finding and does not stop the others', async () => {
  const order: string[] = [];
  const checks: GateCheck[] = [
    { name: 'first', run: async () => { order.push('first'); return { ok: true, detail: 'fine' }; } },
    { name: 'explodes', run: async () => { order.push('explodes'); throw new Error('the catalog is on fire'); } },
    { name: 'last', run: async () => { order.push('last'); return { ok: true, detail: 'fine' }; } },
  ];
  const findings = await runChecks(checks, async () => []);
  assert.deepEqual(order, ['first', 'explodes', 'last']);
  assert.deepEqual(findings.map((finding) => finding.ok), [true, false, true]);
  assert.match(findings[1]!.detail, /could not be run.*on fire/);
});

test('every check has a distinct name, because the report is read by name', () => {
  const names = SERVING_SCHEMA_CHECKS.map((check) => check.name);
  assert.equal(new Set(names).size, names.length, `duplicate check names: ${names.join(', ')}`);
  assert.ok(names.length >= 10, 'the check list looks truncated');
  // Exactly one informational check today. The distinction is load-bearing —
  // an informational finding must never fail the gate — so a second one being
  // added should be a decision, not a surprise.
  assert.equal(SERVING_SCHEMA_CHECKS.filter((check) => check.informational === true).length, 1);
});

test('the read-only option is the startup parameter, not a SET', () => {
  // A `SET` issued once reaches whichever pooled connection happened to serve
  // it; a startup option is applied by the server to every connection it opens.
  assert.equal(READ_ONLY_STARTUP_OPTION, '-c default_transaction_read_only=on');
});

test('the gate pins search_path, and carries both startup options together', () => {
  // The identity-args census renders custom type names relative to the session
  // search path; unpinned, a role default of `''` would render the protocol's
  // own RPCs as `public.network` and red a healthy database. Same-mechanism
  // reasoning as the read-only option: a startup parameter, not a SET, so the
  // server applies it to every connection it opens. Pinned to `public` because
  // that is where the exemption spellings were captured; `pg_catalog` is always
  // searched ahead of it, so built-in types stay bare regardless.
  assert.equal(SEARCH_PATH_STARTUP_OPTION, '-c search_path=public');
  assert.ok(GATE_STARTUP_OPTIONS.includes(READ_ONLY_STARTUP_OPTION), 'the read-only proof must survive');
  assert.ok(GATE_STARTUP_OPTIONS.includes(SEARCH_PATH_STARTUP_OPTION), 'the search_path pin must be present');
});

// ---------------------------------------------------------------------------
// The exit-code contract
// ---------------------------------------------------------------------------

const PASSING: GateCheck[] = [{ name: 'fine', run: async () => ({ ok: true, detail: 'fine' }) }];

function harness(
  over: Partial<SchemaGateDeps> & { connection?: GateConnection } = {},
): { deps: SchemaGateDeps; lines: string[]; closed: () => number } {
  const lines: string[] = [];
  let closes = 0;
  const counts = { value: 'benchmark_runs=0' };
  const ready: GateConnection = {
    kind: 'ready',
    localTarget: true,
    query: async (sql) => {
      if (sql.startsWith('insert')) {
        throw Object.assign(new Error('read only'), { code: '25006' });
      }
      if (sql.includes('pg_stat_ssl')) return [{ ssl: true, version: 'TLSv1.3' }];
      if (sql.includes('query_to_xml')) return [{ name: 'benchmark_runs', n: counts.value.split('=')[1] }];
      return [];
    },
    close: async () => { closes += 1; },
  };
  const { connection, ...rest } = over;
  return {
    deps: {
      argv: [],
      open: async () => connection ?? ready,
      checks: PASSING,
      log: { line: (message) => lines.push(message), error: (message) => lines.push(`ERROR ${message}`) },
      ...rest,
    },
    lines,
    closed: () => closes,
  };
}

test('a clean run exits 0 and closes the connection', async () => {
  const it = harness();
  assert.equal(await runSchemaGate(it.deps), GATE_EXIT.ok);
  assert.equal(it.closed(), 1);
  assert.ok(it.lines.some((line) => line.includes('PASS')));
});

test('one failed check fails the whole gate', async () => {
  const it = harness({
    checks: [...PASSING, { name: 'bad', run: async () => ({ ok: false, detail: 'wrong' }) }],
  });
  assert.equal(await runSchemaGate(it.deps), GATE_EXIT.failed);
  assert.equal(it.closed(), 1, 'the connection is closed even when a check failed');
});

test('an INFORMATIONAL finding never fails the gate, whatever it says', async () => {
  // The negative control for the line above: without this, marking a check
  // informational would be indistinguishable from deleting it.
  const it = harness({
    checks: [{ name: 'counts', informational: true, run: async () => ({ ok: false, detail: '900 rows' }) }],
  });
  assert.equal(await runSchemaGate(it.deps), GATE_EXIT.ok);
  assert.ok(it.lines.some((line) => line.startsWith('note') && line.includes('900 rows')));
});

test('a connection that could write is refused before a single check runs', async () => {
  let ran = 0;
  const it = harness({
    checks: [{ name: 'must not run', run: async () => { ran += 1; return { ok: true, detail: '' }; } }],
    connection: {
      kind: 'ready',
      localTarget: true,
      // Accepts everything, including the write probe.
      query: async () => [],
      close: async () => {},
    },
  });
  assert.equal(await runSchemaGate(it.deps), GATE_EXIT.refused);
  assert.equal(ran, 0, 'no check may run against a connection that can write');
});

test('an unencrypted remote session fails the gate even when every check passes', async () => {
  const it = harness({
    connection: {
      kind: 'ready',
      localTarget: false,
      query: async (sql) => {
        if (sql.startsWith('insert')) throw Object.assign(new Error('ro'), { code: '25006' });
        if (sql.includes('pg_stat_ssl')) return [{ ssl: false, version: null }];
        return [];
      },
      close: async () => {},
    },
  });
  assert.equal(await runSchemaGate(it.deps), GATE_EXIT.failed);
});

test('row counts that MOVED fail the gate — the gate must change nothing', async () => {
  // The gate's own negative control, and the reason it is worth having beside
  // the 25006 proof: that one says a write is impossible, this one says none
  // happened. Two mechanisms, so a hole in either is still caught by the other.
  let call = 0;
  const it = harness({
    connection: {
      kind: 'ready',
      localTarget: true,
      query: async (sql) => {
        if (sql.startsWith('insert')) throw Object.assign(new Error('ro'), { code: '25006' });
        if (sql.includes('pg_stat_ssl')) return [{ ssl: true, version: 'TLSv1.3' }];
        if (sql.includes('query_to_xml')) {
          call += 1;
          return [{ name: 'benchmark_runs', n: call === 1 ? '0' : '1' }];
        }
        return [];
      },
      close: async () => {},
    },
  });
  assert.equal(await runSchemaGate(it.deps), GATE_EXIT.failed);
  assert.ok(it.lines.some((line) => line.includes('MOVED')));
});

test('unconfigured and refused are told apart, and neither reads as success', async () => {
  for (const [connection, expected] of [
    [{ kind: 'unconfigured', reason: 'no credential' }, GATE_EXIT.unconfigured],
    [{ kind: 'refused', reason: 'the driver is missing' }, GATE_EXIT.refused],
  ] as const) {
    const it = harness({ connection });
    const code = await runSchemaGate(it.deps);
    assert.equal(code, expected);
    assert.notEqual(code, GATE_EXIT.ok);
  }
});

test('--help is not a failure and opens nothing', async () => {
  let opened = 0;
  const it = harness({ argv: ['--help'], open: async () => { opened += 1; throw new Error('unreachable'); } });
  assert.equal(await runSchemaGate(it.deps), GATE_EXIT.ok);
  assert.equal(opened, 0);
  assert.ok(it.lines.some((line) => line.includes('usage: yarn gate:serving')));
});

test('the exit codes are distinct, so a wrapper can tell them apart', () => {
  const codes = Object.values(GATE_EXIT);
  assert.equal(new Set(codes).size, codes.length, `duplicate exit codes: ${codes.join(', ')}`);
  assert.deepEqual(GATE_EXIT, { ok: 0, failed: 1, usage: 2, unconfigured: 3, refused: 4, crashed: 5 });
});

test('the row-count reading names every table it was asked about', async () => {
  // Built FROM the parameter the code sent, not from a literal this test also
  // feeds in: a fake that ignores the table list would let the bookend narrow to
  // a single table and still pass.
  const sent: unknown[][] = [];
  const query: GateQuery = async (sql, params) => {
    sent.push([...(params ?? [])]);
    if (!sql.includes('query_to_xml')) return [];
    const tables = (params?.[0] ?? []) as string[];
    return tables.map((name, index) => ({ name, n: String(index) }));
  };
  const counts = await readRowCounts(query);
  assert.deepEqual(sent[0], [[...SERVING_TABLES]], 'the bookend must ask about every table');
  assert.equal(counts.split(' ').length, SERVING_TABLES.length);
  assert.match(counts, /^benchmark_runs=0 /);
});

test('the reach check asks about COLUMN-level grants, not just table-level', async () => {
  // Asserted on the statement that was SENT, because the semantics live in the
  // SQL and no fake can evaluate them. A role holding UPDATE on one column of a
  // protocol table is reachable; `has_table_privilege` answers false for it, so
  // a table-level-only question reports "reaches nothing" about a role that
  // reaches something.
  const { query, seen } = rowsFor({});
  const check = SERVING_SCHEMA_CHECKS.find((entry) => entry.name.includes('reaches nothing'));
  assert.ok(check, 'the reach check is gone');
  await check.run(query);
  const sql = seen.join('\n');
  for (const verb of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
    assert.match(sql, new RegExp(`has_any_column_privilege\\(c\\.oid, '${verb}'\\)`), `column-level ${verb}`);
  }
  for (const verb of ['DELETE', 'TRUNCATE', 'TRIGGER']) {
    assert.match(sql, new RegExp(`has_table_privilege\\(c\\.oid, '${verb}'\\)`), `table-level ${verb}`);
  }
  // Sequences answer a different family of functions entirely, and are the
  // class a table-and-view sweep misses.
  assert.match(sql, /has_sequence_privilege/);
});

test('row counts that cannot be READ are not reported as unchanged', async () => {
  // Two nulls compare equal. Without the null guard the gate would announce
  // "the gate wrote nothing" having measured nothing at all — on exactly the
  // misconfiguration it exists to find, a missing grant on one table.
  const it = harness({
    connection: {
      kind: 'ready',
      localTarget: true,
      query: async (sql) => {
        if (sql.startsWith('insert')) throw Object.assign(new Error('ro'), { code: '25006' });
        if (sql.includes('pg_stat_ssl')) return [{ ssl: true, version: 'TLSv1.3' }];
        if (sql.includes('query_to_xml')) throw Object.assign(new Error('denied'), { code: '42501' });
        return [];
      },
      close: async () => {},
    },
  });
  assert.equal(await runSchemaGate(it.deps), GATE_EXIT.failed);
  assert.ok(
    it.lines.some((line) => line.includes('could not be read')),
    `the operator must be told the bookend proved nothing; got ${JSON.stringify(it.lines)}`,
  );
});

test('a table whose policies stop covering this role is a FAILURE, not a pass', async () => {
  // RLS being enabled is not the same as this role being able to write through
  // it. Measured against PostgreSQL 17: with the writer policy retargeted at
  // another role the gate passed, and the real insert came back 42501,
  // "new row violates row-level security policy".
  const check = SERVING_SCHEMA_CHECKS.find((entry) => entry.name.includes('write THROUGH'));
  assert.ok(check, 'the RLS policy check is gone');

  const healthy = { name: 'benchmark_runs', writable: '1', readable: '1', restrictive: '0', policies: 'p' };
  assert.equal((await check.run(async () => [healthy])).ok, true, 'the control must pass');

  for (const [what, row] of [
    ['no INSERT policy', { ...healthy, writable: '0' }],
    ['no SELECT policy', { ...healthy, readable: '0' }],
    ['a RESTRICTIVE policy', { ...healthy, restrictive: '1' }],
  ] as const) {
    const verdict = await check.run(async () => [row]);
    assert.equal(verdict.ok, false, `${what} must fail`);
    assert.match(verdict.detail, /benchmark_runs/);
  }

  // The capability table needs SELECT but must NOT need INSERT — every
  // statement reads the stored row to detect drift, and a writer that could
  // insert the capability row would be authorising its own writes.
  const capability = { name: 'benchmark_schema_capability', writable: '0', readable: '1', restrictive: '0', policies: 'p' };
  assert.equal((await check.run(async () => [capability])).ok, true);
});

test('a SECURITY DEFINER function this role can execute is a FAILURE', async () => {
  // The grid and the relation sweep both answer "what may this role touch
  // DIRECTLY". A SECURITY DEFINER function runs as its owner, so EXECUTE on one
  // is a door around both — measured: with no grant of any kind on a table
  // outside the projection, the writer inserted into it through such a function.
  const check = SERVING_SCHEMA_CHECKS.find((entry) => entry.name.includes('SECURITY DEFINER'));
  assert.ok(check, 'the function-reachability check is gone');

  assert.equal((await check.run(async () => [])).ok, true, 'none executable is the healthy state');

  const verdict = await check.run(async () => [
    { role: 'benchmark_writer', fn: 'public.rpc_something(p_id bigint)', from_extension: false },
  ]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /benchmark_writer -> public\.rpc_something\(p_id bigint\)/);

  // Asked for the OTHER roles too: for the writer such a function is a way out
  // of its grants, for a browser-facing key a way in to the projection. A check
  // that asked only about the connected role would close one half.
  const { query, seen } = rowsFor({});
  await check.run(query);
  const sql = seen.join('\n');
  assert.match(sql, /has_function_privilege\(named\.role, p\.oid, 'EXECUTE'\)/);
  assert.match(sql, /rolname = any\(\$1::text\[\]\) or rolname = current_user/);
});

test('the definer census carries the FULL routine identity and is never capped', async () => {
  // Review reproduction (2026-08-21, disposable PG 17): with the fn keyed on
  // name alone, an undeclared overload `rpc_active_recovery_run(hostile text)`
  // classified as exempt; and with `limit 40` on the census, 40 overloads of a
  // declared name sorted ahead of an undeclared `zz_undeclared()` and the gate
  // passed over a 41-row catalog. Both properties live in the STATEMENT, so
  // they are asserted on the statement that was sent (no fake can evaluate
  // SQL) — the behavioural halves are pinned by the tests below and by the
  // hostile-catalog conformance suite against real PostgreSQL.
  const check = SERVING_SCHEMA_CHECKS.find((entry) => entry.name.includes('SECURITY DEFINER'));
  assert.ok(check, 'the function-reachability check is gone');
  const { query, seen } = rowsFor({});
  await check.run(query);
  const census = seen.find((sql) => sql.includes('pg_get_function_identity_arguments'));
  assert.ok(census, 'the census statement is gone');
  assert.ok(
    census.includes("n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn"),
    'fn must be the whole routine identity — name-only keying exempts every overload of a declared name',
  );
  assert.doesNotMatch(census, /\blimit\b/i, 'a capped census lets an undeclared row hide beyond the cap');
  // The three predicates that MAKE this the SECURITY DEFINER check. Each is a
  // total bypass if flipped or dropped, and none is reachable through the fake
  // query harness — so pin them on the emitted statement, positively AND
  // against the inverting mutation, or a `not p.prosecdef` edit ships green in
  // CI (the census-shape locator alone would still match it). Measured: the
  // adversarial pass reproduced exactly that against the unit suite.
  assert.match(census, /\band p\.prosecdef\b/, 'must census only SECURITY DEFINER functions');
  assert.doesNotMatch(census, /not\s+p\.prosecdef/, 'a negated predicate blinds the check to every definer function');
  assert.match(census, /has_function_privilege\(named\.role, p\.oid, 'EXECUTE'\)/, 'must ask about EXECUTE for the role');
  assert.match(census, /n\.nspname = 'public'/, 'must be scoped to the public schema, as documented');
});

test('an undeclared row cannot hide behind 40 declared ones', async () => {
  // The classification layer's half of the truncation guarantee: 41 rows, the
  // undeclared one SORTED LAST — exactly where a leading cap would cut. Only a
  // build that classifies every row can name it.
  const check = SERVING_SCHEMA_CHECKS.find((entry) => entry.name.includes('SECURITY DEFINER'));
  assert.ok(check, 'the function-reachability check is gone');
  const declared = [...DECLARED_DEFINER_EXEMPTIONS].map((entry) => {
    const [role, fn] = entry.split(' -> ');
    return { role, fn, from_extension: false };
  });
  const forty = Array.from({ length: 40 }, (_, i) => declared[i % declared.length]!);
  const verdict = await check.run(async () => [
    ...forty,
    { role: 'service_role', fn: 'public.zz_undeclared()', from_extension: false },
  ]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /service_role -> public\.zz_undeclared\(\)/);
});

test('the failure header states the WHOLE violating count, not the truncated display count', async () => {
  // The detail shows at most 20 violating rows and then "… and N more not
  // displayed"; the leading count must be the full census, never the shown
  // slice, or a red verdict under-reports how many doors are open. Every OTHER
  // definer fixture has exactly one violating row, where violating.length and
  // shown.length coincide and cannot tell a `${shown.length}` mutation apart —
  // so this fixture deliberately sits ABOVE the display cap. Guarded so a later
  // edit cannot quietly drop it back under 20 and un-discriminate the test.
  const check = SERVING_SCHEMA_CHECKS.find((entry) => entry.name.includes('SECURITY DEFINER'));
  assert.ok(check, 'the function-reachability check is gone');
  const DISPLAY_CAP = 20;
  const violatingRows = Array.from({ length: 25 }, (_, i) => ({
    role: 'service_role',
    fn: `public.zz_undeclared_${String(i).padStart(2, '0')}()`,
    from_extension: false,
  }));
  assert.ok(violatingRows.length > DISPLAY_CAP, 'the fixture must exceed the display cap to discriminate');
  const verdict = await check.run(async () => violatingRows);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /^25 executable/, 'the header counts every violating row, not the 20 shown');
  assert.doesNotMatch(verdict.detail, /^20 executable/, 'a truncated-count header would read 20 here');
  assert.match(verdict.detail, /and 5 more not displayed/, 'the elided remainder is announced with its own count');
});

test('an overload of a declared name is refused unless its own signature is declared', async () => {
  // Overloads are separate functions. The declared signature stays exempt; the
  // same name under ANY other argument list is a function nobody has reviewed.
  const check = SERVING_SCHEMA_CHECKS.find((entry) => entry.name.includes('SECURITY DEFINER'));
  assert.ok(check, 'the function-reachability check is gone');
  const [first] = DECLARED_DEFINER_EXEMPTIONS;
  const declaredFn = first!.split(' -> ')[1]!;
  const overloadFn = declaredFn.replace(/\(.*\)$/, '(hostile text)');
  assert.notEqual(overloadFn, declaredFn, 'the fixture must differ in arguments only');
  const verdict = await check.run(async () => [
    { role: 'service_role', fn: declaredFn, from_extension: false },
    { role: 'service_role', fn: overloadFn, from_extension: false },
  ]);
  assert.equal(verdict.ok, false, 'the undeclared overload must redden the gate');
  assert.ok(verdict.detail.includes(`service_role -> ${overloadFn}`), 'and be named exactly');
  assert.ok(
    !verdict.detail.startsWith('2 executable'),
    'the declared signature is still exempt — exactly one row violates',
  );
  assert.ok(verdict.detail.startsWith('1 executable'), 'the count states the whole census');
});

test('the forbidden-reader question covers every verb, not just the reads', async () => {
  // Asserted on the statement that was SENT: the semantics live in the SQL and
  // no fake can evaluate them. Measured — a DELETE granted to a browser-facing
  // key passed the read-only version of this question while that role really
  // could delete published rows.
  const check = SERVING_SCHEMA_CHECKS.find((entry) => entry.name.includes('public read keys'));
  assert.ok(check, 'the read-keys check is gone');
  const { query, seen } = rowsFor({ pg_roles: [{ rolname: 'anon' }] });
  await check.run(query);
  const sql = seen.join('\n');
  assert.match(sql, /unnest\(\$3::text\[\]\) as v/, 'the verbs must be a parameter, not two hard-coded reads');
  assert.match(sql, /has_table_privilege\(r, 'public\.' \|\| t, v\)/);
  assert.match(sql, /has_any_column_privilege\(r, 'public\.' \|\| t, v\)/);
});

test('definer exemptions may only ever name the read API, exactly, one pair at a time', () => {
  // The roles this check exists to keep OUT of definer functions can never be
  // exempted: an entry for the writer would be a declared way out of its own
  // grants, and one for a browser key a declared way in. Refused by SHAPE, so
  // the review that would catch it does not have to be the last line.
  assert.ok(DECLARED_DEFINER_EXEMPTIONS.size > 0);
  for (const entry of DECLARED_DEFINER_EXEMPTIONS) {
    // The parenthesised identity-argument list is REQUIRED: an entry without
    // one can never match what the census emits, and a name-only entry is the
    // shape that exempted an unreviewed overload. The argument character class
    // is deliberately narrow — the 18 shipped signatures need nothing more,
    // and a future entry needing more (array types, quoted identifiers) should
    // widen it here, consciously, in review.
    assert.match(
      entry,
      /^service_role -> public\.[a-z0-9_]+\([a-z0-9_, ]*\)$/,
      `${entry}: an exemption is service_role, one exact public function WITH its identity arguments, nothing else`,
    );
  }
});

test('exemption membership is the FULL role-and-function pair, nothing looser', () => {
  const [first] = DECLARED_DEFINER_EXEMPTIONS;
  const fn = first!.split(' -> ')[1]!;
  assert.equal(isExemptDefiner('service_role', fn), true);
  // The half a role-only or prefix match would get wrong, one case each:
  // the SAME function under a role that may never hold an exemption...
  assert.equal(isExemptDefiner('benchmark_writer', fn), false);
  assert.equal(isExemptDefiner('anon', fn), false);
  // ...an UNLISTED function under the exempted role — a new definer RPC
  // must arrive as a gate failure until someone looks at it and declares it...
  assert.equal(isExemptDefiner('service_role', 'public.rpc_added_next_week(p_id bigint)'), false);
  // ...and the SAME NAME with different identity arguments: an overload is a
  // separate function, and membership on the name alone would exempt every
  // overload anyone ever creates under it.
  const overload = fn.replace(/\(.*\)$/, '(hostile text)');
  assert.notEqual(overload, fn);
  assert.equal(isExemptDefiner('service_role', overload), false);
  // The bare name — the pre-fix key shape — may never match an entry again.
  assert.equal(isExemptDefiner('service_role', fn.replace(/\(.*\)$/, '')), false);
});
