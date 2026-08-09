import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveBenchmarkWriterConnection } from './benchmarkServingConfig.js';

/**
 * Resolution of the serving publisher's connection from the environment. Pure —
 * nothing here opens a socket.
 *
 * The properties worth pinning are the ones a mistake would make silent: that an
 * absent credential is `no_credential` rather than a connection to nowhere, that
 * a DSN is handed over UNPARSED (parsing it would break on a password containing
 * `%`), and that TLS is on by default rather than off.
 */

const VARS = [
  'BENCHMARK_DB_URL', 'BENCHMARK_WRITER', 'SUPABASE_URL', 'BENCHMARK_DB_HOST',
  'BENCHMARK_DB_PORT', 'BENCHMARK_DB_NAME', 'BENCHMARK_DB_USER', 'BENCHMARK_DB_CA',
] as const;

/** Run `fn` with exactly `env` set and every other resolver variable cleared, so
 *  a value leaking in from the developer's shell cannot change an outcome. */
function withEnv<T>(env: Partial<Record<(typeof VARS)[number], string>>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of VARS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return fn();
  } finally {
    for (const key of VARS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A password carrying every character class the generated credential does. `%`
// is the load-bearing one: `%-W` is not a valid percent-escape.
const AWKWARD = 'q=&*()V1fXi;(%-WH{R>';

test('no credential at all resolves to no_credential, not to a broken connection', () => {
  assert.deepEqual(withEnv({}, resolveBenchmarkWriterConnection),
    { resolved: false, reason: 'no_credential' });
  assert.deepEqual(withEnv({ SUPABASE_URL: 'https://abc.supabase.co' }, resolveBenchmarkWriterConnection),
    { resolved: false, reason: 'no_credential' });
});

test('a credential with no project URL is a distinct, nameable state', () => {
  assert.deepEqual(withEnv({ BENCHMARK_WRITER: AWKWARD }, resolveBenchmarkWriterConnection),
    { resolved: false, reason: 'no_project_url' });
});

test('a project URL that is not a URL is malformed, not merely absent', () => {
  // Collapsing the two would report a typo as "not configured", and the publisher
  // would sit silently disabled on a host that meant to enable it.
  for (const bad of ['not a url', 'abc.supabase.co', '://x']) {
    assert.deepEqual(
      withEnv({ BENCHMARK_WRITER: AWKWARD, SUPABASE_URL: bad }, resolveBenchmarkWriterConnection),
      { resolved: false, reason: 'malformed_project_url' }, `url=${bad}`,
    );
  }
});

test('the host is derived from the project reference', () => {
  const r = withEnv(
    { BENCHMARK_WRITER: AWKWARD, SUPABASE_URL: 'https://project-ref.supabase.co' },
    resolveBenchmarkWriterConnection,
  );
  assert.ok(r.resolved);
  assert.deepEqual(r.connection, {
    kind: 'derived',
    host: 'db.project-ref.supabase.co',
    port: 5432,
    user: 'benchmark_writer',
    database: 'postgres',
    password: AWKWARD,
    ssl: { rejectUnauthorized: false },
  });
});

test('the password is carried through byte-identical, never encoded', () => {
  // Discrete fields exist precisely so there is no encoding step. A resolver that
  // percent-encoded on the way out would hand the driver a wrong password.
  const r = withEnv(
    { BENCHMARK_WRITER: AWKWARD, SUPABASE_URL: 'https://abc.supabase.co' },
    resolveBenchmarkWriterConnection,
  );
  assert.ok(r.resolved && r.connection.kind === 'derived');
  assert.equal(r.connection.password, AWKWARD);
  assert.ok(r.connection.password.includes('%'), 'the awkward character really is in the fixture');
});

test('a DSN wins and is passed through unparsed', () => {
  // Parsing it here would mean decoding a password that can contain an invalid
  // percent-escape; `new URL(...).password` + decodeURIComponent throws on one.
  const dsn = `postgresql://benchmark_writer:${AWKWARD}@db.abc.supabase.co:5432/postgres`;
  const r = withEnv(
    { BENCHMARK_DB_URL: dsn, BENCHMARK_WRITER: 'ignored', SUPABASE_URL: 'https://abc.supabase.co' },
    resolveBenchmarkWriterConnection,
  );
  assert.ok(r.resolved);
  assert.deepEqual(r.connection, { kind: 'dsn', connectionString: dsn, ssl: { rejectUnauthorized: false } });
});

test('the DSN really is untouched — decoding it would have thrown', () => {
  // Negative control on the claim above: this is what a "normalising" resolver
  // would have done, and it fails.
  const dsn = `postgresql://benchmark_writer:${AWKWARD}@h:5432/postgres`;
  assert.throws(() => decodeURIComponent(new URL(dsn).password), { name: 'URIError' });
});

test('host, port, database and user are each overridable', () => {
  const r = withEnv({
    BENCHMARK_WRITER: AWKWARD,
    SUPABASE_URL: 'https://abc.supabase.co',
    BENCHMARK_DB_HOST: 'pooler.example.internal',
    BENCHMARK_DB_PORT: '6543',
    BENCHMARK_DB_NAME: 'scratch',
    BENCHMARK_DB_USER: 'benchmark_writer.abc',
  }, resolveBenchmarkWriterConnection);
  assert.ok(r.resolved && r.connection.kind === 'derived');
  assert.equal(r.connection.host, 'pooler.example.internal');
  assert.equal(r.connection.port, 6543);
  assert.equal(r.connection.database, 'scratch');
  assert.equal(r.connection.user, 'benchmark_writer.abc');
});

test('an override host removes the need for a project URL', () => {
  const r = withEnv({ BENCHMARK_WRITER: AWKWARD, BENCHMARK_DB_HOST: 'localhost' },
    resolveBenchmarkWriterConnection);
  assert.ok(r.resolved && r.connection.kind === 'derived');
  assert.equal(r.connection.host, 'localhost');
});

test('a port that is not a port is refused rather than silently defaulted', () => {
  for (const bad of ['0', '65536', 'abc', '5432.5', '-1']) {
    assert.deepEqual(
      withEnv({ BENCHMARK_WRITER: AWKWARD, BENCHMARK_DB_HOST: 'h', BENCHMARK_DB_PORT: bad },
        resolveBenchmarkWriterConnection),
      { resolved: false, reason: 'malformed_port' }, `port=${bad}`,
    );
  }
});

test('TLS is on by default, and a supplied CA turns verification on', () => {
  // The default is encrypted-but-unauthenticated, because the alternative that
  // works without a CA is plaintext. Measured: with no ssl option at all,
  // pg_stat_ssl reports ssl=false against the live endpoint.
  const plain = withEnv({ BENCHMARK_WRITER: AWKWARD, BENCHMARK_DB_HOST: 'h' },
    resolveBenchmarkWriterConnection);
  assert.ok(plain.resolved);
  assert.deepEqual(plain.connection.ssl, { rejectUnauthorized: false });

  const verified = withEnv({ BENCHMARK_WRITER: AWKWARD, BENCHMARK_DB_HOST: 'h',
    BENCHMARK_DB_CA: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----' },
    resolveBenchmarkWriterConnection);
  assert.ok(verified.resolved);
  assert.deepEqual(verified.connection.ssl, {
    rejectUnauthorized: true,
    ca: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
  });
});

test('the CA applies to a DSN connection too', () => {
  const r = withEnv({ BENCHMARK_DB_URL: 'postgresql://h/db', BENCHMARK_DB_CA: 'PEM' },
    resolveBenchmarkWriterConnection);
  assert.ok(r.resolved);
  assert.deepEqual(r.connection.ssl, { rejectUnauthorized: true, ca: 'PEM' });
});

test('a blank value counts as absent, the way every other credential here does', () => {
  // envValue() trims and treats '' as unset; the resolver must agree, or an
  // empty line in a .env file becomes an empty password sent to the server.
  assert.deepEqual(withEnv({ BENCHMARK_WRITER: '   ' }, resolveBenchmarkWriterConnection),
    { resolved: false, reason: 'no_credential' });
  assert.deepEqual(withEnv({ BENCHMARK_DB_URL: '', BENCHMARK_WRITER: '' }, resolveBenchmarkWriterConnection),
    { resolved: false, reason: 'no_credential' });
});
