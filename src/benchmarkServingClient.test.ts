import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import {
  describeServingStatus,
  REQUIRED_SERVING_CAPABILITY,
  SCORES_SERVING_CAPABILITY,
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
function probeExits(
  mode: string,
  deadlineMs: number,
  closeStderr = false,
): Promise<{
  exited: boolean;
  ms: number;
  out: string;
  stdout: string;
  stderr: string;
  code: number | null;
  /** Whether the harness actually closed the child's stderr, and what it had
   *  printed by then — the two facts that make the closed-stderr case an
   *  measurement rather than a coincidence. */
  closedStderr: boolean;
  outAtClose: string;
}> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [...process.execArgv, 'src/servingCloseProbe.ts', mode], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    let stderr = '';
    let closedStderr = false;
    let outAtClose = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); stdout += String(chunk); });
    if (closeStderr) {
      // Closed when the child says READY, not at spawn: destroying the read end
      // before the child is up races its startup, and the resulting pipe state
      // is what made this measurement environment-dependent.
      //
      // Matched against the ACCUMULATED output, not the chunk: a marker split
      // across two reads would never match, the close would never happen, and
      // the case would pass having measured the child with a working stderr.
      child.stderr.on('error', () => { /* this end is ours, and we close it below */ });
      const closeWhenReady = (): void => {
        if (closedStderr || !stdout.includes('READY')) return;
        closedStderr = true;
        outAtClose = stdout;
        child.stdout.off('data', closeWhenReady);
        child.stderr.destroy();
      };
      child.stdout.on('data', closeWhenReady);
    } else {
      child.stderr.on('data', (chunk) => { out += String(chunk); stderr += String(chunk); });
    }
    const killer = setTimeout(() => {
      // The tree, not the root: on Windows killing the parent leaves the child
      // holding the socket, and the measurement never completes.
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
        .on('error', () => child.kill('SIGKILL'));
    }, deadlineMs);
    child.on('exit', (code) => {
      clearTimeout(killer);
      const ms = Date.now() - started;
      // The CODE, not just the fact of exiting. An uncaught exception also
      // exits — with 1 — so "it exited" cannot tell a clean shutdown from a
      // crash, and the crash is the failure one of these cases exists to catch.
      resolve({
        exited: ms < deadlineMs - 400, ms, out: out.trim(),
        stdout: stdout.trim(), stderr: stderr.trim(), code, closedStderr, outAtClose,
      });
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
for (const mode of ['held', 'stale', 'bogus', 'scores-held', 'enabled'] as const) {
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
    if (mode === 'scores-held') {
      // The premise that makes this mode discriminate: the probe answers a
      // version every RUN path accepts, and the open asks for the scores
      // requirement. If the two constants ever collapse, this mode pins
      // nothing and must be redesigned rather than quietly passing.
      assert.ok(REQUIRED_SERVING_CAPABILITY <= 2,
        'the probe answers 2, which must satisfy the run paths');
      assert.ok(SCORES_SERVING_CAPABILITY > 2,
        'and must fall short of the scores requirement, or nothing here discriminates');
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

test('a dropped connection does not take the process with it', async () => {
  // ── THE HAZARD ─────────────────────────────────────────────────────────────
  // `Pool` is an EventEmitter and every client it holds idle carries a listener
  // that ends in `pool.emit('error', …)`. Emitting 'error' on an emitter with
  // no listener THROWS, from a socket callback — outside the per-write race,
  // outside the port's try/catch, outside mirrorRunArtifact. So an ordinary
  // reset of an idle connection killed the whole process, which in `yarn watch`
  // means the watcher dies between games and the rest of the slate is never
  // fired and never ledgered.
  //
  // The probe's fake server answers the readiness query and then drops the
  // connection while the client sits idle in the pool.
  const result = await probeExits('reset', 8_000);

  assert.equal(result.exited, true, `the process did not exit: ${result.out}`);
  // ⚠ THE EXIT CODE IS THE ASSERTION. Without the listener this process also
  //   "exits" — Node prints the uncaught error and exits 1. Measured both ways
  //   against this exact probe: 1 with the listener removed, 0 with it.
  assert.equal(result.code, 0, `crashed instead of absorbing it: ${result.out}`);
  // And it reached the hazard: a run that never opened, or never had the
  // connection dropped, would exit 0 for reasons unrelated to the fix.
  assert.match(result.out, /reset: status=enabled/);
  assert.match(result.out, /reset: reachedServer=true/);
  // Absorbed, not swallowed. A failure nobody is waiting on has no outcome to
  // be folded into, so silence here would make a database that drops every
  // connection look exactly like one that works.
  assert.match(result.out, /reset: onError .*a pooled connection failed/);
});

test('a dropped connection does not take the process with it, even when the SINK throws', async () => {
  // The listener added for the case above runs inside an event handler, so a
  // throw out of IT is uncaught exactly like the one it exists to prevent. The
  // sink in production is `printError` — stderr — which raises EPIPE when the
  // run is piped into something that has exited. Fixing one crash by adding
  // another is not a fix, and nothing pinned the difference.
  const result = await probeExits('sink', 8_000);

  assert.equal(result.exited, true, `the process did not exit: ${result.out}`);
  assert.equal(result.code, 0, `the throwing sink killed the process: ${result.out}`);
  // Reached the hazard: the listener ran (so there was something to throw from)
  // and the process carried on past it.
  assert.match(result.out, /sink: onError .*a pooled connection failed/);
  assert.match(result.out, /sink: still running after the connection was dropped/);
});

test('a dropped connection does not take the process with it when STDERR IS GONE', async () => {
  // ── THE MECHANISM, AND WHY THE OBVIOUS GUARD MISSES IT ─────────────────────
  // The two cases above cover a listener that is absent and a sink that throws
  // where it is called. This is the third and it is the one that happens in
  // production: `printError` writes to stderr, the consumer is gone, and the
  // write does NOT throw at the call site. EPIPE arrives afterwards as an
  // `'error'` event on the stream, so the `try` around the sink catches
  // nothing — and the error carries the stack of the write's ORIGIN, so the
  // crash points at the logging line and reads exactly like a synchronous
  // throw. Measured: exit 7 through an uncaughtException probe, with the top
  // frames `printError` and the pool's listener.
  //
  // Discrimination: remove the stream listeners in console.ts and only THIS
  // case reddens; remove the try/catch in the pool listener and only `sink`
  // does. Neither guard can stand in for the other.
  const result = await probeExits('epipe', 8_000, true);

  assert.equal(result.exited, true, `the process did not exit: ${result.out}`);
  assert.equal(result.code, 0, `a closed stderr killed the process: ${result.out}`);
  // Reached the hazard: the pool opened, the connection was dropped, and the
  // report was attempted down the broken stream — then the run carried on.
  assert.match(result.out, /epipe: status=enabled/);
  assert.match(result.out, /epipe: still running after the connection was dropped/);
  // ── AND THAT THE PREMISE HELD ──────────────────────────────────────────────
  // Without these two, the case passes identically when the close never
  // happens — measured — which reduces it to "the process survives while
  // stderr works", the null hypothesis. The close is a race against the
  // child's own progress and nothing else observes whether it was won.
  assert.equal(result.closedStderr, true, 'stderr was never closed, so nothing here was measured');
  assert.doesNotMatch(
    result.outAtClose, /reported through the real sink/,
    'the report happened BEFORE stderr was closed, so it went down a working stream',
  );
});

test('an error event on a broken output stream cannot end the process', async () => {
  // ── THIS IS THE CASE THAT DISCRIMINATES THE GUARD ──────────────────────────
  // The event is emitted directly rather than by breaking a real pipe, because
  // EventEmitter semantics are identical on every platform and at every speed:
  // no listener throws, a listener does not. Node's stdio PIPES are not —
  // synchronous on Windows, asynchronous on POSIX — so the pipe route below
  // discriminates 5/5 on one and roughly 1/10 on the other. A reviewer running
  // Linux saw the mutant survive where it died here, and both measurements were
  // correct.
  //
  // The control is half the case and is asserted FIRST: it strips the listeners
  // and must crash. If it ever exits 0, the harness has stopped reaching the
  // hazard and the guarded assertion beside it would prove nothing.
  const control = await probeExits('stdio-unguarded', 8_000);
  assert.notEqual(
    control.code, 0,
    `the control survived, so this case can no longer tell the guard from its absence: ${control.out}`,
  );

  // AT THE EMIT, not somewhere earlier: a control asserted only on a non-zero
  // exit is satisfied by a child that failed to start.
  assert.match(control.out, /stdio-unguarded: about to emit/);
  assert.doesNotMatch(control.out, /survived the emit/);

  const guarded = await probeExits('stdio-guard', 8_000);
  assert.equal(guarded.code, 0, `a stream error ended the process: ${guarded.out}`);
  assert.match(guarded.out, /stdio-guard: survived the emit/);
});

test('a fault that is NOT a closed consumer is reported, on the OTHER stream', async () => {
  // The only case that executes the installed closures. `guardStream` is unit
  // tested with a fake emitter and a fake reporter, so the two lines that
  // decide WHICH stream a diagnostic lands on were installed and never run —
  // measured: swapping them so each stream reports to itself left the suite
  // green, and in production silenced the diagnostic entirely, because the
  // report goes to the stream that just failed and the once-per-stream latch
  // discards the resulting second error.
  const result = await probeExits('stdio-surprise', 8_000);

  assert.equal(result.code, 0, `an unexpected stream fault ended the process: ${result.out}`);
  assert.match(result.stdout, /stdio-surprise: survived the emit/);
  assert.match(
    result.stderr, /\[stdout\] unexpected output error ENOSPC/,
    `the stdout fault must be reported on STDERR; stderr was ${JSON.stringify(result.stderr)}`,
  );
  assert.doesNotMatch(
    result.stdout, /unexpected output error/,
    'reporting a stdout fault onto stdout is writing to the stream that just failed',
  );
});
