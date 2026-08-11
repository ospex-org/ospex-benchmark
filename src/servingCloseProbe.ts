import { createServer } from 'node:net';
import { openBenchmarkServing } from './benchmarkServingClient.js';
import type { Server } from 'node:net';

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
 * at all. Forty lines of wire protocol gives the exact condition, in CI, with no
 * dependency: complete the handshake so the pool believes it is connected, then
 * read every query and reply to none.
 *
 * Two modes, and the negative one is not optional:
 *
 *   close   the shipped path — `openBenchmarkServing()`, one write that never
 *           answers, then `close()`. MUST exit.
 *   hold    the close this replaced: race `pool.end()` against a timer and
 *           return. MUST NOT exit. Without it, a `close` that exited for some
 *           unrelated reason — a fake server that hung up, a pool that never
 *           connected — would read as a passing test.
 */

/** Enough of the startup exchange for `pg` to consider itself connected. */
function fakePostgres(): Promise<{ port: number; server: Server }> {
  const server = createServer((socket) => {
    let sawStartup = false;
    socket.on('data', (chunk) => {
      if (!sawStartup) {
        // An SSLRequest is a bare 8-byte packet whose second int32 is 80877103.
        // Refuse TLS with 'N' and wait for the real StartupMessage; anything
        // else IS the StartupMessage.
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
      // A query arrived. Saying nothing is the entire point of this server.
    });
    socket.on('error', () => { /* the client is expected to destroy this */ });
    // ⚠ UNREF THE SERVER SIDE. Both ends of this connection live in this
    //   process, so a ref'd accepted socket would hold the event loop open by
    //   itself and every mode would "never exit" — including the one that is
    //   supposed to. That happened, and it read exactly like the fix failing.
    //   Only the client's own handles may decide this measurement.
    socket.unref();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      const address = server.address();
      resolve({ port: typeof address === 'object' && address !== null ? address.port : 0, server });
    });
  });
}

const tagged = (type: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'latin1');
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};

const kv = (key: string, value: string): Buffer =>
  Buffer.from(`${key}\0${value}\0`, 'utf8');

const say = (message: string): void => { process.stdout.write(`${message}\n`); };

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'close';
  const { port } = await fakePostgres();
  // A loopback address and a throwaway password for a server that exists for
  // the length of this process. The resolver exempts loopback from its TLS
  // rule, so no plaintext override is needed and none is set — a test that
  // reaches for that flag is a test that could also reach a real host.
  process.env['BENCHMARK_DB_URL'] = `postgres://probe:probe@127.0.0.1:${port}/probe`;
  delete process.env['BENCHMARK_WRITER'];
  delete process.env['BENCHMARK_DB_CA'];

  if (mode === 'hold') {
    // The close this replaced, reproduced against the same silent server: race
    // the drain against a timer and hand back. It is a NEGATIVE CONTROL, so it
    // is meant to hang — if it ever exits, the harness has stopped being able
    // to tell a bounded process from an unbounded one and every `close` verdict
    // beside it is worthless.
    const { Pool } = await import('pg');
    const { pgStoreQuery } = await import('./store/atomicStore.js');
    const pool = new Pool({ connectionString: process.env['BENCHMARK_DB_URL'], max: 4 });
    const query = pgStoreQuery(pool);
    const hung = query('select 1', []);
    hung.catch(() => undefined);
    await Promise.race([hung, delay(300)]);
    await Promise.race([pool.end().catch(() => undefined), delay(300)]);
    say('hold: close returned');
    return;
  }

  // Short bounds so the measurement is about whether the process exits, not
  // about how patient the defaults are. The defaults themselves are pinned
  // separately, as values.
  const serving = await openBenchmarkServing({ readinessTimeoutMs: 300, closeTimeoutMs: 300 });
  say(`close: status=${serving.status.enabled ? 'enabled' : serving.status.reason}`);
  await serving.close();
  say('close: returned');
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

main().then(
  () => say('main resolved'),
  (error: unknown) => say(`main rejected: ${String(error)}`),
);
