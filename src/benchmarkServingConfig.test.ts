import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, Pool } from 'pg';
import type { ClientConfig } from 'pg';
import { resolveBenchmarkWriterConnection } from './benchmarkServingConfig.js';
import type { ConnectionResolution } from './benchmarkServingConfig.js';

/**
 * Resolution of the serving publisher's connection from the environment. Pure —
 * nothing here opens a socket, though the sweeps at the bottom do build real
 * `pg` clients to read back what the driver WOULD connect with.
 *
 * The properties worth pinning are the ones a mistake would make silent: that an
 * absent credential is `no_credential` rather than a connection to nowhere, that
 * a DSN is handed over UNPARSED (parsing it would break on a password containing
 * `%`), and that TLS is on by default rather than off.
 */

const VARS = [
  'BENCHMARK_DB_URL', 'BENCHMARK_WRITER', 'SUPABASE_URL', 'BENCHMARK_DB_HOST',
  'BENCHMARK_DB_PORT', 'BENCHMARK_DB_NAME', 'BENCHMARK_DB_USER', 'BENCHMARK_DB_CA',
  'BENCHMARK_DB_ALLOW_PLAINTEXT',
  // Not the resolver's own, but the driver's: PGHOST is the fallback when a DSN
  // names no host, so a developer who exports it would otherwise move a fixture
  // between the local and remote halves of the sweep.
  'PGHOST',
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

/**
 * A file that certainly exists, for the SSL parameters that name one. `parse`
 * READS them, so a nonexistent path throws before any classification happens —
 * which is a different case, covered separately.
 */
const REAL_FILE = encodeURIComponent(fileURLToPath(import.meta.url));

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

test('a DSN that ASKS FOR TLS gets no ssl option beside it', () => {
  // `pg` parses SSL parameters out of the connection string and they override a
  // separately supplied `ssl` object, so returning a CA alongside one of these
  // would be a promise the driver throws away. Returning nothing says the true
  // thing: the URL decides, and BENCHMARK_DB_CA does not apply to it.
  for (const mode of ['require', 'no-verify', 'verify-full', 'prefer', 'bogus']) {
    const dsn = `postgresql://u:p@h.example.com:5432/postgres?sslmode=${mode}`;
    const r = withEnv({ BENCHMARK_DB_URL: dsn, BENCHMARK_DB_CA: 'PEM' }, resolveBenchmarkWriterConnection);
    assert.ok(r.resolved, mode);
    assert.deepEqual(r.connection, { kind: 'dsn', connectionString: dsn }, mode);
    assert.ok(!('ssl' in r.connection), `${mode}: no ssl key at all, not even undefined`);
  }
});

test('the four SSL parameters nothing here names still count as the URL deciding', () => {
  // The reason the predicate asks the driver's parser instead of inspecting
  // named parameters. Each of these REPLACES a supplied ssl object — measured
  // against a real client, they yield `true`, `{ca}`, `{cert}` and `{}` — so a
  // resolver that only knew `sslmode` and `ssl` reported a configured CA that
  // was discarded. None of the four is inspected by name: the whole predicate
  // is `'ssl' in parse(dsn)`, so a parameter nobody here has heard of counts
  // from the day the driver starts acting on it.
  for (const query of [
    'sslnegotiation=direct',
    `sslrootcert=${REAL_FILE}`,
    `sslcert=${REAL_FILE}`,
    `sslkey=${REAL_FILE}`,
  ]) {
    const dsn = `postgresql://u:p@h.example.com:5432/db?${query}`;
    const r = withEnv({ BENCHMARK_DB_URL: dsn, BENCHMARK_DB_CA: 'PEM' }, resolveBenchmarkWriterConnection);
    assert.ok(r.resolved, query);
    assert.ok(!('ssl' in r.connection), `${query}: the DSN is the whole story`);
  }
});

test('a DSN with no sslmode still gets one — the paired accept', () => {
  // Without this the tests above would pass against a resolver that had simply
  // stopped requesting TLS for every DSN.
  const dsn = 'postgresql://u:p@h.example.com:5432/postgres?connect_timeout=10';
  const r = withEnv({ BENCHMARK_DB_URL: dsn, BENCHMARK_DB_CA: 'PEM' }, resolveBenchmarkWriterConnection);
  assert.ok(r.resolved);
  assert.deepEqual(r.connection.ssl, { rejectUnauthorized: true, ca: 'PEM' });
});

test('an SSL parameter is recognised the way the DRIVER recognises one', () => {
  // A substring search got all four of these wrong, and each was measured
  // against a real client. The first three contain the text but state no
  // parameter, so TLS must still be attached — the substring version omitted it
  // and the connection went out in plaintext. The fourth percent-encodes the
  // key, so the driver DOES see it and disables TLS; the substring version
  // missed it and reported a verified CA that was thrown away.
  const looksLikeButIsNot = [
    'postgresql://u:p@h.example.com:5432/db?application_name=sslmode%3Ddisable',
    'postgresql://u:p@h.example.com:5432/db-sslmode=disable',
    'postgresql://u:p@h.example.com:5432/db#sslmode=disable',
  ];
  for (const dsn of looksLikeButIsNot) {
    const r = withEnv({ BENCHMARK_DB_URL: dsn, BENCHMARK_DB_CA: 'PEM' }, resolveBenchmarkWriterConnection);
    assert.ok(r.resolved);
    assert.deepEqual(r.connection.ssl, { rejectUnauthorized: true, ca: 'PEM' }, dsn);
  }
  const encoded = 'postgresql://u:p@h.example.com:5432/db?%73slmode=disable';
  assert.deepEqual(
    withEnv({ BENCHMARK_DB_URL: encoded, BENCHMARK_DB_CA: 'PEM' }, resolveBenchmarkWriterConnection),
    { resolved: false, reason: 'plaintext_dsn' },
    'a percent-encoded sslmode=disable is still a plaintext connection',
  );
});

// ─── the URL is not allowed to choose plaintext to another machine ───────────

test('a DSN that DISABLES TLS to another machine is refused', () => {
  // This role's password is inside the connection string, so a plaintext
  // connection to another machine puts it on the wire in the clear. The campaign
  // store refuses the same shape for the same reason.
  for (const query of ['sslmode=disable', 'ssl=0', 'ssl=', 'ssl=1&ssl=']) {
    assert.deepEqual(
      withEnv({ BENCHMARK_DB_URL: `postgresql://u:p@h.example.com:5432/db?${query}`,
        BENCHMARK_DB_CA: 'PEM' }, resolveBenchmarkWriterConnection),
      { resolved: false, reason: 'plaintext_dsn' }, query,
    );
  }
});

test('…but loopback is exempt, and the refusal has a named way out', () => {
  // A local PostgreSQL has no TLS; demanding it there fails outright rather than
  // degrading, so refusing would break the ordinary developer workflow.
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const dsn = `postgresql://u:p@${host}:5432/db?sslmode=disable`;
    const r = withEnv({ BENCHMARK_DB_URL: dsn }, resolveBenchmarkWriterConnection);
    assert.ok(r.resolved, host);
    assert.deepEqual(r.connection, { kind: 'dsn', connectionString: dsn }, host);
  }
  // And a remote plaintext target is reachable on purpose, said twice.
  const remote = 'postgresql://u:p@h.example.com:5432/db?sslmode=disable';
  const allowed = withEnv({ BENCHMARK_DB_URL: remote, BENCHMARK_DB_ALLOW_PLAINTEXT: '1' },
    resolveBenchmarkWriterConnection);
  assert.ok(allowed.resolved);
  assert.deepEqual(allowed.connection, { kind: 'dsn', connectionString: remote });
  // Only that exact value opts out — a truthy-looking one does not.
  assert.deepEqual(
    withEnv({ BENCHMARK_DB_URL: remote, BENCHMARK_DB_ALLOW_PLAINTEXT: 'true' },
      resolveBenchmarkWriterConnection),
    { resolved: false, reason: 'plaintext_dsn' },
  );
});

test('userinfo with an EMPTY host is classified by the driver, not by new URL()', () => {
  // `new URL('postgres://u:pw@/db')` throws, so the previous predicate fell
  // through to its catch and reported "nothing stated" — attaching TLS and
  // announcing an encrypted connection for one the driver makes in PLAINTEXT.
  // The driver's parser has a dummy-host fallback and applies the sslmode.
  assert.throws(() => new URL('postgres://u:pw@/db?sslmode=disable'));
  for (const query of ['sslmode=disable', 'ssl=0']) {
    const dsn = `postgres://u:pw@/db?${query}`;
    // No host at all, so the driver falls back to PGHOST and then to localhost:
    // this really is a local plaintext connection, and the refusal must not fire.
    const local = withEnv({ BENCHMARK_DB_URL: dsn, BENCHMARK_DB_CA: 'PEM' },
      resolveBenchmarkWriterConnection);
    assert.ok(local.resolved, query);
    assert.ok(!('ssl' in local.connection), `${query}: the URL decides, and it said no TLS`);
    // …and when PGHOST names another machine, the same string is refused, because
    // that is the host the driver will actually dial.
    assert.deepEqual(
      withEnv({ BENCHMARK_DB_URL: dsn, PGHOST: 'db.example.com' }, resolveBenchmarkWriterConnection),
      { resolved: false, reason: 'plaintext_dsn' }, `${query} with PGHOST set`,
    );
  }
});

test('a duplicated or empty SSL parameter resolves the way the DRIVER resolves it', () => {
  // These were refused as "malformed" by a predicate that could not tell what the
  // driver would do with them. It can be asked instead, and every one of them has
  // an unambiguous answer — the driver keeps the LAST duplicate.
  const cases: Array<[string, 'attached' | 'deferred' | 'refused']> = [
    ['sslmode=', 'attached'], //                     ignored by the driver
    ['sslmode=require&sslmode=', 'attached'], //     last is empty -> ignored
    ['sslmode=&sslmode=require', 'deferred'], //     last wins -> {}
    ['ssl=&ssl=1', 'deferred'], //                   last wins -> true
    ['sslmode=disable&sslmode=verify-full', 'deferred'], // last wins -> {}
    ['ssl=1&ssl=', 'refused'], //                    last wins -> "" -> no TLS
  ];
  for (const [query, want] of cases) {
    const dsn = `postgresql://u:p@h.example.com:5432/db?${query}`;
    const r = withEnv({ BENCHMARK_DB_URL: dsn, BENCHMARK_DB_CA: 'PEM' }, resolveBenchmarkWriterConnection);
    if (want === 'refused') {
      assert.deepEqual(r, { resolved: false, reason: 'plaintext_dsn' }, query);
      continue;
    }
    assert.ok(r.resolved, query);
    assert.equal('ssl' in r.connection, want === 'attached', `${query}: expected ${want}`);
  }
});

test('any single value that keeps TLS is deferred to, WITHOUT judging what it means', () => {
  // There is no list of accepted values, because there was one twice and it was
  // wrong both times: it rejected `ssl=no-verify`, which the driver supports,
  // and accepted `ssl=false`, which the driver turns into the truthy string
  // "false". Enumerating meaning is a prediction about the driver; this predicts
  // nothing, it reads back what the driver decided.
  for (const good of ['sslmode=prefer', 'sslmode=require', 'sslmode=verify-ca',
    'sslmode=verify-full', 'sslmode=no-verify', 'sslmode=bogus',
    'ssl=true', 'ssl=false', 'ssl=1', 'ssl=no-verify', 'ssl=yes',
    'sslmode=verify-full&ssl=1']) {
    const dsn = `postgresql://u:p@h.example.com:5432/db?${good}`;
    const r = withEnv({ BENCHMARK_DB_URL: dsn, BENCHMARK_DB_CA: 'PEM' }, resolveBenchmarkWriterConnection);
    assert.ok(r.resolved, good);
    assert.ok(!('ssl' in r.connection), `${good}: the DSN is the whole story`);
  }
});

test('a DSN too malformed to parse still gets TLS rather than silently none', () => {
  // The direction is deliberate: being wrong about the report is recoverable,
  // sending the credential in clear is not.
  const r = withEnv({ BENCHMARK_DB_URL: 'not a url at all', BENCHMARK_DB_CA: 'PEM' },
    resolveBenchmarkWriterConnection);
  assert.ok(r.resolved);
  assert.deepEqual(r.connection.ssl, { rejectUnauthorized: true, ca: 'PEM' });
});

test('an SSL parameter naming a file that does not exist gets TLS, and fails at connect', () => {
  // `parse` READS sslrootcert/sslcert/sslkey, and throws when the path is wrong.
  // The driver throws the same way on the same string a moment later, naming the
  // file — which is more use than a resolution failure here would be — so the
  // resolver defers to that rather than reporting a reason of its own.
  const dsn = 'postgresql://u:p@h.example.com:5432/db?sslrootcert=./no-such-ca.pem';
  const r = withEnv({ BENCHMARK_DB_URL: dsn, BENCHMARK_DB_CA: 'PEM' }, resolveBenchmarkWriterConnection);
  assert.ok(r.resolved);
  assert.deepEqual(r.connection.ssl, { rejectUnauthorized: true, ca: 'PEM' });
  assert.throws(() => new Client({ connectionString: dsn }), /ENOENT/);
});

test('an sslmode inside the DSN password cannot fake one', () => {
  const dsn = 'postgresql://u:has-sslmode=disable-inside@h.example.com:5432/postgres';
  const r = withEnv({ BENCHMARK_DB_URL: dsn }, resolveBenchmarkWriterConnection);
  assert.ok(r.resolved);
  assert.deepEqual(r.connection.ssl, { rejectUnauthorized: false });
});

test('a project URL is checked for SHAPE, not just split on a dot', () => {
  // Taking the first label of any hostname turned these into a plausible-looking
  // Supabase database host that belongs to nobody — a connection attempt, with
  // the credential, against a name the operator never named.
  for (const bad of [
    'https://project-ref.example.com',
    'https://supabase.co',
    'ftp://project-ref.supabase.co',
    'http://project-ref.supabase.co',
    'https://a.b.supabase.co',
  ]) {
    assert.deepEqual(
      withEnv({ BENCHMARK_WRITER: AWKWARD, SUPABASE_URL: bad }, resolveBenchmarkWriterConnection),
      { resolved: false, reason: 'malformed_project_url' }, bad,
    );
  }
  // ...and the real shape still resolves, so the check is not simply refusing.
  const good = withEnv({ BENCHMARK_WRITER: AWKWARD, SUPABASE_URL: 'https://Project-Ref.supabase.co' },
    resolveBenchmarkWriterConnection);
  assert.ok(good.resolved && good.connection.kind === 'derived');
  assert.equal(good.connection.host, 'db.project-ref.supabase.co');
});

test('a blank value counts as absent, the way every other credential here does', () => {
  // envValue() trims and treats '' as unset; the resolver must agree, or an
  // empty line in a .env file becomes an empty password sent to the server.
  assert.deepEqual(withEnv({ BENCHMARK_WRITER: '   ' }, resolveBenchmarkWriterConnection),
    { resolved: false, reason: 'no_credential' });
  assert.deepEqual(withEnv({ BENCHMARK_DB_URL: '', BENCHMARK_WRITER: '' }, resolveBenchmarkWriterConnection),
    { resolved: false, reason: 'no_credential' });
});

// ─── differentially against the driver, over a generated matrix ──────────────

/**
 * The effective connection parameters a client resolves to. `@types/pg` does
 * not declare `connectionParameters`, so the cast is where the untyped surface
 * is acknowledged once rather than at every call.
 */
function effectiveSsl(config: ClientConfig): unknown {
  return (new Client(config) as unknown as { connectionParameters: { ssl: unknown } })
    .connectionParameters.ssl;
}

/** Same, via a Pool — the shape a caller actually constructs. */
function effectiveSslViaPool(config: ClientConfig): unknown {
  const pool = new Pool(config) as unknown as { Client: typeof Client; options: ClientConfig };
  return (new pool.Client(pool.options) as unknown as { connectionParameters: { ssl: unknown } })
    .connectionParameters.ssl;
}

/** What a caller builds from a resolved DSN connection. */
function clientConfig(r: ConnectionResolution): ClientConfig {
  assert.ok(r.resolved && r.connection.kind === 'dsn');
  const { connectionString, ssl } = r.connection;
  return ssl === undefined ? { connectionString } : { connectionString, ssl };
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '127.5.5.5', '[::1]', '0.0.0.0'];
const REMOTE_HOSTS = ['h.example.com', 'db.example.com', '203.0.113.9', '127.0.0.1.evil.com'];

const SUFFIXES = [
  '', '?connect_timeout=10', '?application_name=sslmode=disable', '#sslmode=disable',
  '?ssl=true', '?ssl=false', '?ssl=1', '?ssl=0', '?ssl=', '?ssl=no-verify', '?ssl=yes',
  '?sslmode=disable', '?sslmode=require', '?sslmode=verify-full', '?sslmode=no-verify',
  '?sslmode=prefer', '?sslmode=bogus', '?sslmode=', '?%73slmode=disable',
  '?sslmode=require&sslmode=', '?sslmode=&sslmode=require', '?ssl=1&ssl=0', '?ssl=1&ssl=',
  '?sslnegotiation=direct', '?uselibpqcompat=true', '?uselibpqcompat=true&sslmode=require',
  `?sslrootcert=${REAL_FILE}`, `?sslcert=${REAL_FILE}`, `?sslkey=${REAL_FILE}`,
];

interface Fixture {
  readonly dsn: string;
  readonly local: boolean;
  readonly label: string;
}

const MATRIX: Fixture[] = [];
for (const [hosts, local] of [[LOCAL_HOSTS, true], [REMOTE_HOSTS, false]] as const) {
  for (const host of hosts) {
    for (const suffix of SUFFIXES) {
      MATRIX.push({
        dsn: `postgres://u:pw@${host}:5432/serving${suffix}`,
        local,
        label: `${host}${suffix}`,
      });
    }
  }
}

test('SWEEP: the resolver never attaches TLS the driver would discard, nor claims TLS it will not get', () => {
  // The whole point of the change, checked at the level of the ARTIFACT a caller
  // holds rather than of the predicate inside. A sentinel identifies survival
  // exactly: if the driver hands back the very object supplied, the URL stated
  // nothing and attaching was meaningful; anything else means the URL overrode
  // it and attaching was a lie.
  assert.ok(MATRIX.length >= 260, `the sweep must cover the space, got ${MATRIX.length}`);
  let attached = 0;
  let deferred = 0;
  let refused = 0;
  for (const { dsn, local, label } of MATRIX) {
    const r = withEnv({ BENCHMARK_DB_URL: dsn, BENCHMARK_DB_CA: 'PEM' }, resolveBenchmarkWriterConnection);
    const sentinel = { rejectUnauthorized: false, ca: 'PEM' };
    const withSentinel = effectiveSsl({ connectionString: dsn, ssl: sentinel } as ClientConfig);
    const survives = withSentinel === sentinel;

    if (!r.resolved) {
      refused += 1;
      assert.equal(r.reason, 'plaintext_dsn', `${label}: refused for an unexpected reason`);
      assert.equal(local, false, `${label}: a local target must never be refused`);
      assert.ok(!withSentinel, `${label}: refused a connection the driver would have encrypted`);
      continue;
    }
    const config = clientConfig(r);
    if ('ssl' in config) {
      attached += 1;
      assert.ok(survives, `${label}: attached an ssl option the driver discards`);
      assert.ok(effectiveSsl(config), `${label}: attached TLS and the driver has none`);
      assert.deepEqual(effectiveSslViaPool(config), effectiveSsl(config), `${label}: pool and client disagree`);
    } else {
      deferred += 1;
      assert.ok(!survives, `${label}: attached nothing where the driver would have kept it`);
      if (!effectiveSsl(config)) {
        assert.ok(local, `${label}: deferred to a plaintext URL for a host that is not this machine`);
      }
    }
  }
  // Every branch must actually occur, or the property passes vacuously.
  assert.ok(attached > 0 && deferred > 0 && refused > 0,
    `attached=${attached} deferred=${deferred} refused=${refused}`);
});

test('SWEEP: a target that is not this machine is encrypted or refused, never plaintext', () => {
  // The headline safety property, stated on its own so it cannot be lost inside
  // the parity check above.
  const remote = MATRIX.filter((fixture) => !fixture.local);
  assert.ok(remote.length >= 100, `got ${remote.length}`);
  for (const { dsn, label } of remote) {
    const r = withEnv({ BENCHMARK_DB_URL: dsn, BENCHMARK_DB_CA: 'PEM' }, resolveBenchmarkWriterConnection);
    if (!r.resolved) continue;
    assert.ok(effectiveSsl(clientConfig(r)),
      `${label}: the driver would connect with NO TLS to a host that is not this machine`);
  }
});
