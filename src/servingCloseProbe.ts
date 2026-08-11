import { createServer } from 'node:net';
import { openBenchmarkServing } from './benchmarkServingClient.js';
import type { ArmAttempt } from './servingStore.js';

/**
 * Does a process that opened the serving publisher still EXIT when the database
 * stops answering?
 *
 * Spawned as a child by `benchmarkServingClient.test.ts`, which measures whether
 * the child exits and how long it takes. It has to be a separate process because
 * that is the whole question: a promise settling proves nothing about whether
 * Node can drain its event loop, and every earlier version of this code raced a
 * timer, returned promptly, and then hung forever holding a socket.
 *
 * ── WHY IT SPEAKS POSTGRESQL RATHER THAN USING ONE ───────────────────────────
 * The failure being reproduced is a server that ACCEPTS the connection and then
 * never answers — the shape of a network partition or a frozen host, and the
 * one case a server-side `statement_timeout` cannot rescue, because the server
 * is not in a position to enforce anything. A real PostgreSQL cannot be asked
 * to behave that way without pausing the host, and `yarn test` has no database
 * at all. A little wire protocol gives the exact condition, in CI, with no
 * dependency.
 *
 * ── THE MODES, AND WHY THE LAST ONE IS NOT OPTIONAL ───────────────────────────────────────
 *
 *   held      the readiness probe never answers, so the publisher takes its
 *             schema-latch branch and closes there. MUST exit.
 *   stale     the database reports an OLDER capability than this build needs -
 *             the lookalike-schema case a column-name check used to accept.
 *             MUST refuse to open, and MUST exit.
 *   bogus     the database answers, but with no version in it. MUST refuse to
 *             open: an unreadable answer is version 0, and a build that turned
 *             it into NaN instead would compare `NaN < 2`, get false, and OPEN.
 *             A mutant did exactly that and survived until this mode existed.
 *   enabled   the readiness probe IS answered, so the publisher opens for real;
 *             then one attempt — the path that pins a client for a lock plus a
 *             statement — never answers, and the handle's own `close()` runs.
 *             MUST exit. This is the close a run actually calls, and nothing
 *             else in the suite reaches it.
 *   hold      the close this replaced: race `pool.end()` against a timer and
 *             hand back. MUST NOT exit. Without it, a mode that exited for some
 *             unrelated reason — a server that hung up, a pool that never
 *             connected — would read as a passing test.
 */

const TEXT_OID = 25;
const INT4_OID = 23;

const tagged = (type: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'latin1');
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};

const kv = (key: string, value: string): Buffer => Buffer.from(`${key}\0${value}\0`, 'utf8');

/** A one-column result set of text values, then ReadyForQuery. */
function resultSet(column: string, values: readonly string[], oid = TEXT_OID): Buffer {
  const describe = Buffer.alloc(2 + column.length + 1 + 18);
  describe.writeInt16BE(1, 0);
  describe.write(`${column}\0`, 2, 'utf8');
  let at = 2 + column.length + 1;
  describe.writeInt32BE(0, at); at += 4;      // table oid
  describe.writeInt16BE(0, at); at += 2;      // column attribute
  describe.writeInt32BE(oid, at); at += 4;
  describe.writeInt16BE(-1, at); at += 2;     // variable width
  describe.writeInt32BE(-1, at); at += 4;     // no type modifier
  describe.writeInt16BE(0, at);               // text format
  const rows = values.map((value) => {
    const bytes = Buffer.from(value, 'utf8');
    const body = Buffer.alloc(2 + 4 + bytes.length);
    body.writeInt16BE(1, 0);
    body.writeInt32BE(bytes.length, 2);
    bytes.copy(body, 6);
    return tagged('D', body);
  });
  return Buffer.concat([
    tagged('T', describe),
    ...rows,
    tagged('C', Buffer.from(`SELECT ${values.length}\0`, 'utf8')),
    tagged('Z', Buffer.from('I')),
  ]);
}

/**
 * Enough of the wire protocol to be believed, and then silence.
 *
 * `answerFirstQuery` decides whether the readiness probe gets a result: with it
 * the publisher opens ENABLED and the silence lands on the write instead.
 *
 * `sawQuery` is not diagnostics. Without it this probe passed while never
 * connecting at all: the resolver attaches `ssl` when no CA is configured, this
 * server refuses TLS, and `pg` errored out in milliseconds — so the process
 * exited promptly for a reason that had nothing to do with the code under test,
 * and a build with the fix removed passed identically.
 */
function fakePostgres(answer: number | 'silent' | 'bogus'): Promise<{ port: number; sawQuery: () => boolean }> {
  let sawQuery = false;
  const server = createServer((socket) => {
    let sawStartup = false;
    let answered = false;
    socket.on('data', (chunk) => {
      if (!sawStartup) {
        // An SSLRequest is a bare 8-byte packet whose second int32 is 80877103.
        if (chunk.length === 8 && chunk.readInt32BE(4) === 80877103) {
          socket.write(Buffer.from('N'));
          return;
        }
        sawStartup = true;
        socket.write(Buffer.concat([
          tagged('R', Buffer.alloc(4)),                               // AuthenticationOk
          tagged('S', kv('client_encoding', 'UTF8')),
          tagged('S', kv('standard_conforming_strings', 'on')),
          tagged('K', Buffer.alloc(8)),                               // BackendKeyData
          tagged('Z', Buffer.from('I')),                              // ReadyForQuery
        ]));
        return;
      }
      sawQuery = true;
      if (answer !== 'silent' && !answered) {
        answered = true;
        // The readiness probe asks what the schema says it can serve. An int4
        // column, because the publisher requires a real integer; `bogus`
        // answers with a differently named one, which is what a schema that
        // has the table but not the contract looks like.
        socket.write(answer === 'bogus'
          ? resultSet('capability_version', ['2'])
          : resultSet('version', [String(answer)], INT4_OID));
        return;
      }
      // Saying nothing is the entire point of this server.
    });
    socket.on('error', () => { /* the client is expected to destroy this */ });
    // ⚠ UNREF THE SERVER SIDE. Both ends of this connection live in this
    //   process, so a ref'd accepted socket would hold the event loop open by
    //   itself and every mode would "never exit" — including the ones that are
    //   supposed to. That happened, and it read exactly like the fix failing.
    //   Only the client's own handles may decide this measurement.
    socket.unref();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : 0,
        sawQuery: () => sawQuery,
      });
    });
  });
}

const say = (message: string): void => { process.stdout.write(`${message}\n`); };
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * A valid attempt, so the write reaches the DATABASE rather than being turned
 * away by client-side validation. A payload the port refuses would leave no
 * hung connection at all, and the measurement would be of nothing.
 */
function probeAttempt(): ArmAttempt {
  const at = '2026-08-09T20:05:00.000Z';
  return {
    run: {
      runId: 'probe-run', cohortId: 'probe-cohort', slateDate: '2026-08-09',
      network: 'polygon', deploymentRound: 'R5', startedAt: at,
      bundleSha256: null, planSha256: null, promptScaffoldSha256: null,
      promptScaffoldVersion: null, responseSchemaVersion: 2,
      baselinePolicyVersion: null, priceVersion: null, benchmarkCommit: null,
      executionPolicy: null,
    },
    participant: {
      participantId: 'probe-arm', kind: 'model', labId: 'probe',
      displayName: 'Probe', modelId: 'probe-v1', configuration: {},
    },
    roster: { walletAddress: null },
    gameId: 'probe-game',
    facts: {
      attemptOrdinal: 0, suppliedMarkets: ['moneyline'], sent: true, outcome: 'valid',
      requestedModelId: 'probe-v1', reportedModelId: null, providerResponseId: null,
      httpStatus: 200, providerStopReason: null, turnCompleted: null,
      validationErrors: null, requestAt: at, responseAt: at, latencyMs: 1,
      inputTokens: null, outputTokens: null, reasoningTokens: null,
      billableOutputTokens: null, billableSearchCount: null,
      searchEvidenceStatus: null, costUsd: null, priceVersion: null,
    },
    source: { sourcePath: null, sourceSha256: null },
  };
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'held';
  const answer = mode === 'enabled' ? 2
    : mode === 'stale' ? 1
    : mode === 'bogus' ? 'bogus' as const
    : 'silent' as const;
  const { port, sawQuery } = await fakePostgres(answer);
  // `sslmode=disable` is LOAD-BEARING, not tidiness. With no CA configured the
  // resolver attaches `ssl: { rejectUnauthorized: false }`, `pg` opens with an
  // SSLRequest, this server refuses it, and the connection dies before a query
  // is ever sent. A DSN that states its own policy makes the resolver attach
  // nothing, and loopback is exempt from the plaintext refusal — so no
  // environment override is needed, and none is set: a probe that reaches for
  // that flag is a probe that could also reach a real host.
  process.env['BENCHMARK_DB_URL'] = `postgres://probe:probe@127.0.0.1:${port}/probe?sslmode=disable`;
  delete process.env['BENCHMARK_WRITER'];
  delete process.env['BENCHMARK_DB_CA'];

  if (mode === 'hold') {
    const { Pool } = await import('pg');
    const { pgStoreQuery } = await import('./store/atomicStore.js');
    const pool = new Pool({ connectionString: process.env['BENCHMARK_DB_URL'], max: 4 });
    const hung = pgStoreQuery(pool)('select 1', []);
    hung.catch(() => undefined);
    await Promise.race([hung, delay(300)]);
    await Promise.race([pool.end().catch(() => undefined), delay(300)]);
    say(`hold: reachedServer=${sawQuery()}`);
    say('hold: close returned');
    return;
  }

  // Short bounds so the measurement is about whether the process exits, not
  // about how patient the defaults are. The defaults are pinned separately, as
  // values, by the ordering test.
  const serving = await openBenchmarkServing({ readinessTimeoutMs: 300, closeTimeoutMs: 300 });
  say(`${mode}: status=${serving.status.enabled ? 'enabled' : serving.status.reason}`);
  say(`${mode}: reachedServer=${sawQuery()}`);

  if (serving.status.enabled) {
    // The transactor path: a lock and a statement on ONE pinned client, which
    // is the connection `pool.end()` cannot drain. Abandoned the way the
    // publisher abandons it, without waiting for the driver's own timeout.
    const write = serving.port.publishAttempt(probeAttempt());
    const outcome = await Promise.race([write, delay(300).then(() => null)]);
    say(`${mode}: write=${outcome === null ? 'abandoned' : outcome.outcome}`);
  }

  await serving.close();
  say(`${mode}: close returned`);
}

main().then(
  () => say('main resolved'),
  (error: unknown) => say(`main rejected: ${String(error)}`),
);
