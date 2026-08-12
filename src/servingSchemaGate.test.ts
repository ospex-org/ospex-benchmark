import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dialsThisMachine,
  GATE_EXIT,
  proveEncrypted,
  proveReadOnly,
  READ_ONLY_STARTUP_OPTION,
  readRowCounts,
  runChecks,
  runSchemaGate,
  SERVING_SCHEMA_CHECKS,
} from './servingSchemaGate.js';
import type { GateCheck, GateConnection, GateQuery, SchemaGateDeps } from './servingSchemaGate.js';
import type { BenchmarkWriterConnection } from './benchmarkServingConfig.js';

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
  for (const version of [170010, 150000]) {
    const { query, seen } = rowsFor({ server_version_num: [{ v: version }] });
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
  const { query } = rowsFor({
    query_to_xml: [{ name: 'benchmark_runs', n: '0' }, { name: 'benchmark_decisions', n: '7' }],
  });
  assert.equal(await readRowCounts(query), 'benchmark_runs=0 benchmark_decisions=7');
});
