import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeServingStatus,
  openBenchmarkServing,
  servingPoolConfig,
  SERVING_POOL_MAX,
} from './benchmarkServingClient.js';

/**
 * The driver config the publisher opens with, and what it says about itself.
 *
 * The TLS DECISION is not made here — `benchmarkServingConfig` makes it, and
 * its own suite checks each branch against a real `pg` client rather than
 * against a model of one. What this file pins is the hand-off: that a decision
 * to attach nothing produces a config with no `ssl` KEY, and that the status a
 * caller prints carries no part of the target.
 */

const SHARED = { max: SERVING_POOL_MAX, connectionTimeoutMillis: 10_000 };

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
