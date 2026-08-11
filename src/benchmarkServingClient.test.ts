import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import {
  describeServingStatus,
  REQUIRED_SERVING_CAPABILITY,
  openBenchmarkServing,
  servingPoolConfig,
  QUERY_TIMEOUT_MS,
  READINESS_TIMEOUT_MS,
  SERVING_POOL_MAX,
  STATEMENT_TIMEOUT_MS,
} from './benchmarkServingClient.js';
import { PER_WRITE_TIMEOUT_MS } from './servingPublisher.js';

/**
 * The driver config the publisher opens with, what it says about itself, and —
 * the one that matters most — whether a process that opened it can still exit
 * when the database stops answering.
 *
 * The TLS DECISION is not made here — `benchmarkServingConfig` makes it, and
 * its own suite checks each branch against a real `pg` client rather than
 * against a model of one. What this file pins is the hand-off: that a decision
 * to attach nothing produces a config with no `ssl` KEY, and that the status a
 * caller prints carries no part of the target.
 */

const SHARED = {
  max: SERVING_POOL_MAX,
  connectionTimeoutMillis: 10_000,
  query_timeout: QUERY_TIMEOUT_MS,
  statement_timeout: STATEMENT_TIMEOUT_MS,
};

test('a DSN is passed through whole, with the TLS the resolver attached', () => {
  assert.deepEqual(
    servingPoolConfig({
      kind: 'dsn',
      connectionString: 'postgresql://u:p@db.example.com:5432/postgres',
      ssl: { rejectUnauthorized: false },
    }),
    {
      connectionString: 'postgresql://u:p@db.example.com:5432/postgres',
      ssl: { rejectUnauthorized: false },
      ...SHARED,
    },
  );
});

test('when there is no TLS to attach the key is ABSENT, not undefined', () => {
  const config = servingPoolConfig({
    kind: 'dsn',
    connectionString: 'postgresql://u:p@db.example.com:5432/postgres?sslmode=require',
  });
  // The two are different inputs to the driver's merge: with no key it
  // consults PGSSLMODE, which is the operator's setting to make. This is the
  // shape the resolver produces for a DSN that states its own policy, and
  // attaching `ssl: undefined` beside it would be a different question asked.
  assert.equal(Object.hasOwn(config, 'ssl'), false);
  assert.deepEqual(config, {
    connectionString: 'postgresql://u:p@db.example.com:5432/postgres?sslmode=require',
    ...SHARED,
  });
});

test('a derived connection crosses as discrete fields, never as a rebuilt URL', () => {
  // Rebuilding a URL would mean percent-encoding a password that can contain a
  // `%`, and the encoded result round-trips through some parsers and not
  // others. Discrete fields have no encoding step to get wrong.
  assert.deepEqual(
    servingPoolConfig({
      kind: 'derived',
      host: 'db.example.com',
      port: 5432,
      user: 'benchmark_writer',
      database: 'postgres',
      password: 'pa%ss',
      ssl: { rejectUnauthorized: true, ca: 'PEM' },
    }),
    {
      host: 'db.example.com',
      port: 5432,
      user: 'benchmark_writer',
      database: 'postgres',
      password: 'pa%ss',
      ssl: { rejectUnauthorized: true, ca: 'PEM' },
      ...SHARED,
    },
  );
});

test('the pool stays under the writer role\'s connection limit', () => {
  // The scoped login carries CONNECTION LIMIT 5. Past it PostgreSQL answers
  // 53300 instead of writing, and the port is fail-soft, so that arrives as a
  // silently missing row rather than an error.
  assert.ok(SERVING_POOL_MAX < 5);
  assert.equal(SERVING_POOL_MAX, 4);
});

test('the status line names no part of the target', () => {
  // A diagnostic that interpolates any slice of a credential-bearing string
  // eventually prints the credential — an extractor meaning to take the host
  // returns the whole string for a keyword DSN, and the password's own tail
  // when the password contains an `@`. A constant cannot.
  assert.equal(describeServingStatus({ enabled: true }), 'serving projection: enabled');
  assert.equal(
    describeServingStatus({ enabled: false, reason: 'plaintext_dsn' }),
    'serving projection: disabled (plaintext_dsn)',
  );
});

test('with no credential the handle is disabled and every write is a no-op', async () => {
  const saved = {
    url: process.env['BENCHMARK_DB_URL'],
    writer: process.env['BENCHMARK_WRITER'],
    supabase: process.env['SUPABASE_URL'],
  };
  delete process.env['BENCHMARK_DB_URL'];
  delete process.env['BENCHMARK_WRITER'];
  delete process.env['SUPABASE_URL'];
  try {
    const handle = await openBenchmarkServing();
    assert.deepEqual(handle.status, { enabled: false, reason: 'no_credential' });
    // Unconditionally callable is the whole point: there is no second code
    // path for "not configured", and turning the projection on is an
    // environment variable rather than a change at any call site.
    assert.deepEqual(await handle.port.publishAttempt({} as never), { outcome: 'disabled' });
    assert.deepEqual(await handle.port.sealDecision({} as never), { outcome: 'disabled' });
    // Closing a handle that never opened anything must not throw.
    await handle.close();
    await handle.close();
  } finally {
    for (const [name, value] of [
      ['BENCHMARK_DB_URL', saved.url],
      ['BENCHMARK_WRITER', saved.writer],
      ['SUPABASE_URL', saved.supabase],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('the bounds are ordered so the layer that can END a statement acts first', () => {
  // Each of these can stop the wait; only some of them can stop the WORK.
  //   statement_timeout  the server aborts the statement (57014 -> unavailable)
  //   query_timeout      the driver rejects, and on pool.query releases with the
  //                      error, which destroys the connection
  //   PER_WRITE_TIMEOUT  the publisher stops awaiting; nothing is cancelled
  // Reversing any pair silently demotes the strong remedy to the weak one: the
  // publisher would walk away first and leave the statement running.
  assert.ok(STATEMENT_TIMEOUT_MS < QUERY_TIMEOUT_MS,
    'the server must give up before the driver, so the tidy 57014 is the normal outcome');
  assert.ok(QUERY_TIMEOUT_MS < PER_WRITE_TIMEOUT_MS,
    'the driver must give up before the publisher, or nothing ever destroys the connection');
  // The readiness probe runs before any work and a run is waiting on it, so it
  // is bounded well inside a single write.
  assert.ok(READINESS_TIMEOUT_MS < QUERY_TIMEOUT_MS);
});

/**
 * Spawn `servingCloseProbe.ts` and report whether the CHILD PROCESS exited.
 *
 * `process.execArgv` is reused so the child runs under whatever loader this
 * suite is running under, rather than hard-coding one. stdio is piped and
 * drained and a hard kill fires at the deadline: a probe whose failure mode is
 * "produces no output" needs its own liveness proof.
 */
function probeExits(mode: string, deadlineMs: number): Promise<{ exited: boolean; ms: number; out: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [...process.execArgv, 'src/servingCloseProbe.ts', mode], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { out += String(chunk); });
    const killer = setTimeout(() => {
      // The tree, not the root: on Windows killing the parent leaves the child
      // holding the socket, and the measurement never completes.
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
        .on('error', () => child.kill('SIGKILL'));
    }, deadlineMs);
    child.on('exit', () => {
      clearTimeout(killer);
      const ms = Date.now() - started;
      resolve({ exited: ms < deadlineMs - 400, ms, out: out.trim() });
    });
  });
}

// Spawning a child under a TypeScript loader is slow, and both cases wait out a
// real deadline. Generous, because the assertion is "bounded", not "fast".
const PROBE_DEADLINE_MS = 12_000;

/**
 * The two shapes a run can be in when the database goes quiet, and the close
 * each one takes. `held` closes from the schema-latch branch; `enabled` closes
 * through the handle a run holds — a different call site, and until this case
 * existed nothing in the suite reached it.
 */
for (const mode of ['held', 'stale', 'enabled'] as const) {
  test(`a process whose database stopped answering still EXITS (${mode})`, { timeout: 60_000 }, async () => {
    // THE guarantee of this module, and the one no promise-level assertion can
    // make: `close()` resolving says nothing about whether Node can drain its
    // event loop. Every earlier version returned promptly on a timer and then
    // held an open socket forever.
    const closed = await probeExits(mode, PROBE_DEADLINE_MS);
    assert.ok(closed.exited, `the probe never exited (${closed.ms}ms). Output:
${closed.out}`);

    // ⚠ AND IT MUST EXIT BEFORE THE DRIVER'S OWN TIMEOUT COULD HAVE DONE IT.
    //   Without this bound the test passed on a build with the handle destroy
    //   removed: `query_timeout` rejected at 9s, `pool.query` released with the
    //   error, and the pool destroyed the client — so the process exited for a
    //   reason that had nothing to do with the code under test. Measured by a
    //   mutant that survived until this line existed.
    assert.ok(
      closed.ms < QUERY_TIMEOUT_MS,
      `the probe took ${closed.ms}ms, long enough that query_timeout ` +
        `(${QUERY_TIMEOUT_MS}ms) could be what ended it rather than the close. Output:
${closed.out}`,
    );

    // A child that died on an import error also "exits". These require evidence
    // it got all the way through, and — the assertion that was missing — that
    // it reached the server at all: the probe used to fail TLS negotiation and
    // die in milliseconds without ever sending a query, so there was no hung
    // connection for the close to deal with.
    assert.match(closed.out, new RegExp(`${mode}: reachedServer=true`),
      `the probe never got a query to the server. Output:
${closed.out}`);
    assert.match(closed.out, new RegExp(`${mode}: close returned`),
      `the probe exited without reaching its close. Output:
${closed.out}`);
    assert.match(closed.out, new RegExp(`${mode}: status=${mode === 'enabled' ? 'enabled' : 'schema_not_ready'}`),
      `the probe took the wrong branch. Output:
${closed.out}`);
    if (mode === 'stale') {
      // The reviewer's case: a database whose schema has the lookalike
      // columns and none of the contract. A column-name check opened against
      // it; a capability VERSION refuses it.
      assert.ok(REQUIRED_SERVING_CAPABILITY > 1,
        'the probe reports capability 1, so the requirement must exceed it to discriminate');
    }
    if (mode === 'enabled') {
      // And the write really was left in flight on a pinned client, rather than
      // refused client-side before it ever opened one.
      assert.match(closed.out, /enabled: write=abandoned/,
        `the write never reached the database, so no client was pinned. Output:
${closed.out}`);
    }
  });
}

test('NEGATIVE CONTROL: the close this replaced does NOT exit', { timeout: 60_000 }, async () => {
  // Without this, the tests above pass on a build with no fix at all — a fake
  // server that hung up, or a pool that never connected, would let the process
  // exit for reasons unrelated to destroying a live handle. This runs the OLD
  // close (race `pool.end()` against a timer, hand back) against the same
  // silent server, and it must hang.
  const held = await probeExits('hold', PROBE_DEADLINE_MS);
  assert.match(held.out, /hold: reachedServer=true/,
    `the control did not reach the server either, so it proves nothing. Output:
${held.out}`);
  assert.equal(
    held.exited,
    false,
    `the negative control exited in ${held.ms}ms, so this suite can no longer tell a bounded ` +
      `process from an unbounded one and the tests above prove nothing. Output:
${held.out}`,
  );
});
