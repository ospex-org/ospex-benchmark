import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, Pool } from 'pg';
import type { ClientConfig } from 'pg';
import {
  dsnTlsDecision,
  effectiveStoreHost,
  isLoopbackStoreHost,
  PlaintextStoreConnectionError,
  storeConnectionConfig,
  type StoreConnectionConfig,
} from './connection.js';

/**
 * The TLS decision for the campaign store.
 *
 * ── WHY THESE TESTS PROBE A REAL CLIENT ──────────────────────────────────────
 *
 * The property that matters is not what `storeConnectionConfig` returns — it is
 * what node-postgres DOES with what it returns, and those differ. A connection
 * string's own SSL parameters are merged over a supplied `ssl` option, so a
 * config that looks encrypted can connect in the clear. Every claim below is
 * therefore checked against `new Client(...).connectionParameters`, the
 * effective configuration the driver will connect with, and the important ones
 * against `new Pool(...)` too.
 *
 * The headline property is a conjunction, and both halves have teeth:
 *
 *   remote  =>  encrypted, or refused outright. Never plaintext.
 *   local   =>  nothing added, or every developer's default workflow breaks
 *               (a local PostgreSQL has no TLS and demanding it fails outright
 *               rather than degrading).
 *
 * Neither half is checked against this module's own idea of "local" — that
 * would be circular, and a classifier that called a remote host local would
 * make the test agree with the bug. The fixtures below carry a hand-authored
 * `local` flag, and the sweep is quantified over it.
 */

/** Hosts that ARE this machine. Hand-authored — not derived from the module. */
const LOCAL_HOSTS = [
  'localhost',
  'LOCALHOST',
  '127.0.0.1',
  '127.0.0.5',
  '127.255.255.254',
  '0.0.0.0',
  '[::1]',
  '[0:0:0:0:0:0:0:1]',
];

/**
 * Hosts that are NOT this machine. The first four are the lookalikes: every one
 * is an ordinary registrable DNS name, and a `127.`-prefix or substring test
 * reads them as loopback and sends the credential to them in the clear.
 */
const REMOTE_HOSTS = [
  '127.0.0.1.evil.com',
  '127.example.com',
  'localhost.evil.com',
  '0.0.0.0.example.com',
  'db.example.com',
  'store.internal',
  '128.0.0.1',
  '1270.0.0.1',
];

/**
 * Every SSL-ish suffix that has ever been got wrong here, plus controls. The
 * comments record what the pinned driver actually does with each.
 */
const SUFFIXES = [
  '', //                                    nothing stated
  '?connect_timeout=10', //                 unrelated parameter, nothing stated
  '?sslmode=', //                           empty: the driver ignores it entirely
  '?ssl=', //                               empty: the driver makes it falsy
  '?ssl=0', //                              falsy
  '?ssl=1', //                              true
  '?ssl=true', //                           true
  '?ssl=false', //                          the truthy STRING "false"
  '?ssl=no-verify', //                      {rejectUnauthorized:false}
  '?sslmode=disable', //                    false
  '?sslmode=require', //                    {} (verify-full, on this version)
  '?sslmode=verify-full', //                {}
  '?sslmode=no-verify', //                  {rejectUnauthorized:false}
  '?sslmode=prefer', //                     {}
  '?%73slmode=disable', //                  the key decodes to sslmode -> false
  '?sslmode=require&sslmode=', //           LAST duplicate wins -> ignored
  '?sslmode=&sslmode=require', //           LAST duplicate wins -> {}
  '?ssl=1&ssl=0', //                        LAST duplicate wins -> false
  '?ssl=1&ssl=', //                         LAST duplicate wins -> ''
  '?sslnegotiation=direct', //              implies ssl: true
  '?uselibpqcompat=true', //                nothing stated on its own
  '?uselibpqcompat=true&sslmode=require', // {rejectUnauthorized:false}
  '?application_name=sslmode=disable', //   a VALUE, not a key: nothing stated
  '#sslmode=disable', //                    a FRAGMENT, not a query: nothing stated
];

interface Fixture {
  readonly dsn: string;
  readonly local: boolean;
  readonly label: string;
}

const MATRIX: Fixture[] = [];
for (const [hosts, local] of [
  [LOCAL_HOSTS, true],
  [REMOTE_HOSTS, false],
] as const) {
  for (const host of hosts) {
    for (const suffix of SUFFIXES) {
      MATRIX.push({
        dsn: `postgres://u:pw@${host}:5432/store${suffix}`,
        local,
        label: `${host}${suffix}`,
      });
    }
  }
}

/**
 * `?host=` OVERRIDES the authority — the driver dials the query parameter — so
 * the authority alone never decides the target. Each row states the real one.
 */
const HOST_OVERRIDES: Fixture[] = [
  { dsn: 'postgres://u:pw@localhost:5432/store?host=db.example.com', local: false, label: 'local authority, remote ?host' },
  { dsn: 'postgres://u:pw@127.0.0.1:5432/store?host=store.internal', local: false, label: 'loopback authority, remote ?host' },
  { dsn: 'postgres://u:pw@db.example.com:5432/store?host=localhost', local: true, label: 'remote authority, local ?host' },
  { dsn: 'postgres://u:pw@db.example.com:5432/store?host=127.0.0.1', local: true, label: 'remote authority, loopback ?host' },
  { dsn: 'postgres://u:pw@db.example.com:5432/store?host=', local: false, label: 'empty ?host falls back to the authority' },
  { dsn: 'postgres://u:pw@localhost:5432/store?host=/var/run/postgresql', local: true, label: 'unix socket via ?host' },
  { dsn: 'postgres://u:pw@%2Fvar%2Frun%2Fpostgresql/store', local: true, label: 'unix socket, percent-encoded' },
  { dsn: 'postgres://u:pw@localhost:5432/store?host=db.example.com&sslmode=disable', local: false, label: 'remote ?host + sslmode=disable' },
  // IPv6 loopback in LONGHAND, and only reachable through `?host=`. In the
  // authority the URL parser compresses `[0:0:0:0:0:0:0:1]` to `[::1]` before
  // this module ever sees it, so the authority form does NOT discriminate: a
  // literal `=== '::1'` comparison passes it. A query parameter is copied
  // through verbatim, so this is the input where canonicalisation is the only
  // thing that can produce the right answer.
  { dsn: 'postgres://u:pw@db.example.com:5432/store?host=0:0:0:0:0:0:0:1', local: true, label: 'IPv6 loopback longhand via ?host' },
  { dsn: 'postgres://u:pw@db.example.com:5432/store?host=::1', local: true, label: 'IPv6 loopback via ?host' },
  { dsn: 'postgres://u:pw@db.example.com:5432/store?host=[::1]', local: true, label: 'IPv6 loopback bracketed via ?host' },
];

const ALL: Fixture[] = [...MATRIX, ...HOST_OVERRIDES];

const LOCAL = 'postgres://postgres:spike@localhost:5433/store_spike';
const REMOTE = 'postgres://user:pw@db.example.com:5432/store';

// The awkward class: a generated password containing a `%` that begins no valid
// escape. Any implementation that re-serialises the URL corrupts it.
const AWKWARD = 'q=&*()V1fXi;(%-WH{R>';

const ENV_KEYS = ['STORE_DATABASE_CA', 'STORE_DATABASE_ALLOW_PLAINTEXT', 'PGHOST', 'PGSSLMODE'] as const;

function withEnv<T>(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    const next = overrides[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * The effective connection parameters a client resolves to. `@types/pg` does
 * not declare `connectionParameters`, so the cast is where the untyped surface
 * is acknowledged once rather than at every call.
 */
interface EffectiveParameters {
  readonly host: string;
  readonly ssl: unknown;
  readonly isDomainSocket: boolean;
  readonly password: string;
}

function parametersOf(client: Client): EffectiveParameters {
  return (client as unknown as { connectionParameters: EffectiveParameters }).connectionParameters;
}

/** The configuration node-postgres will ACTUALLY connect with. */
function effective(config: StoreConnectionConfig): { host: string; ssl: unknown; socket: boolean } {
  const parameters = parametersOf(new Client({ ...config } as ClientConfig));
  return { host: parameters.host, ssl: parameters.ssl, socket: parameters.isDomainSocket };
}

/** Same, via a Pool — the shape every call site actually constructs. */
function effectiveViaPool(config: StoreConnectionConfig): { host: string; ssl: unknown } {
  const pool = new Pool({ ...config } as ClientConfig) as unknown as {
    Client: typeof Client;
    options: ClientConfig;
  };
  const parameters = parametersOf(new pool.Client(pool.options));
  return { host: parameters.host, ssl: parameters.ssl };
}

/** Resolve, reporting a refusal rather than throwing out of the sweep. */
function resolve(dsn: string): { refused: true } | { refused: false; config: StoreConnectionConfig } {
  try {
    return { refused: false, config: storeConnectionConfig(dsn) };
  } catch (error) {
    assert.ok(
      error instanceof PlaintextStoreConnectionError,
      `${dsn}: refused for an unexpected reason: ${String(error)}`
    );
    return { refused: true };
  }
}

// ─── the headline property ───────────────────────────────────────────────────

test('SWEEP: a target that is not this machine is encrypted or refused, never plaintext', () => {
  const remote = ALL.filter((fixture) => !fixture.local);
  assert.ok(remote.length >= 190, `the sweep must actually cover the space, got ${remote.length}`);

  let encrypted = 0;
  let refused = 0;
  for (const { dsn, label } of remote) {
    const outcome = resolve(dsn);
    if (outcome.refused) {
      refused += 1;
      continue;
    }
    const client = effective(outcome.config);
    const pool = effectiveViaPool(outcome.config);
    assert.ok(client.ssl, `${label}: the driver would connect with NO TLS to a remote host`);
    assert.ok(pool.ssl, `${label}: the pool would connect with NO TLS to a remote host`);
    assert.deepEqual(pool.ssl, client.ssl, `${label}: pool and client disagree`);
    encrypted += 1;
  }
  // Both outcomes must actually occur, or the property is passing vacuously.
  assert.ok(encrypted > 0 && refused > 0, `encrypted=${encrypted} refused=${refused}`);
});

test('SWEEP: a local target gets nothing added — the paired negative control', () => {
  const local = ALL.filter((fixture) => fixture.local);
  assert.ok(local.length >= 190, `got ${local.length}`);
  for (const { dsn, label } of local) {
    const outcome = resolve(dsn);
    assert.equal(outcome.refused, false, `${label}: a local target must never be refused`);
    if (outcome.refused) continue;
    assert.deepEqual(outcome.config, { connectionString: dsn }, label);
    assert.ok(!('ssl' in outcome.config), `${label}: no ssl key at all, not even undefined`);
  }
});

// ─── the two predicates, differentially against the driver ───────────────────

test('SWEEP: effectiveStoreHost is the host the driver will actually dial', () => {
  for (const { dsn, label } of ALL) {
    const actual = parametersOf(new Client({ connectionString: dsn })).host;
    assert.equal(effectiveStoreHost(dsn), actual, `${label}: host model diverged from the driver`);
  }
});

test('SWEEP: dsnTlsDecision matches what the driver does to a supplied ssl option', () => {
  // A sentinel identifies survival exactly: if the driver hands back the very
  // object supplied, the URL stated nothing and attaching is meaningful. If it
  // hands back anything else, the URL overrode it and attaching is a lie.
  const sentinel = { rejectUnauthorized: false };
  for (const { dsn, label } of ALL) {
    const actual = parametersOf(new Client({ connectionString: dsn, ssl: sentinel })).ssl;
    const survived = actual === sentinel;
    const decision = dsnTlsDecision(dsn);
    assert.equal(decision === 'unstated', survived, `${label}: decided ${decision}, survived=${survived}`);
    if (!survived) {
      assert.equal(decision === 'encrypts', Boolean(actual), `${label}: decided ${decision}, driver ssl=${String(actual)}`);
    }
  }
});

// ─── the shapes the review measured, one named case each ─────────────────────

test('a text match on sslmode does not count as stating one', () => {
  // Each of these matched a substring search of everything after the userinfo,
  // stated nothing to the driver, and so went out in PLAINTEXT.
  for (const suffix of [
    '?sslmode=',
    '?application_name=sslmode=disable',
    '#sslmode=disable',
    '?sslmode=require&sslmode=',
  ]) {
    const dsn = `${REMOTE}${suffix}`;
    const config = withEnv({}, () => storeConnectionConfig(dsn));
    assert.ok(effective(config).ssl, `${suffix}: connected without TLS`);
  }
  // And a password that happens to contain the text states nothing either.
  const inPassword = 'postgres://user:has-sslmode=disable-inside@db.example.com:5432/store';
  assert.ok(withEnv({}, () => effective(storeConnectionConfig(inPassword)).ssl));
});

test('an encoded or non-sslmode spelling DOES state one, and is honoured', () => {
  // The paired accept. A substring search missed all of these, attached TLS the
  // driver then discarded, and reported encryption for a plaintext connection.
  for (const suffix of ['?%73slmode=disable', '?ssl=0', '?ssl=']) {
    assert.throws(
      () => withEnv({}, () => storeConnectionConfig(`${REMOTE}${suffix}`)),
      PlaintextStoreConnectionError,
      suffix
    );
  }
  for (const suffix of ['?ssl=no-verify', '?sslnegotiation=direct', '?ssl=1']) {
    const config = withEnv({ STORE_DATABASE_CA: 'PEM' }, () => storeConnectionConfig(`${REMOTE}${suffix}`));
    assert.deepEqual(config, { connectionString: `${REMOTE}${suffix}` }, suffix);
    assert.ok(effective(config).ssl, suffix);
  }
});

test('a query host override decides the target, not the authority', () => {
  const outbound = 'postgres://u:pw@localhost:5432/store?host=db.example.com';
  assert.equal(isLoopbackStoreHost(outbound), false);
  const config = withEnv({}, () => storeConnectionConfig(outbound));
  assert.ok(effective(config).ssl, 'a localhost authority dialling a remote host must still encrypt');
  assert.equal(effective(config).host, 'db.example.com');

  // The paired accept: an override pointing back at this machine is local, and
  // must not have TLS forced on it.
  const inbound = `${REMOTE}?host=localhost`;
  assert.equal(isLoopbackStoreHost(inbound), true);
  assert.deepEqual(withEnv({ STORE_DATABASE_CA: 'PEM' }, () => storeConnectionConfig(inbound)), {
    connectionString: inbound,
  });
});

test('a registrable name that merely looks like loopback is remote', () => {
  // `127.0.0.1.evil.com` is a name anybody can register. A `startsWith('127.')`
  // test reads it as loopback and sends the database password to it in clear.
  for (const host of ['127.0.0.1.evil.com', '127.example.com', 'localhost.evil.com', '127.0.0.1.', '127.0.0.1x']) {
    const dsn = `postgres://u:pw@${host}:5432/store`;
    assert.equal(isLoopbackStoreHost(dsn), false, host);
    assert.ok(withEnv({}, () => effective(storeConnectionConfig(dsn)).ssl), host);
  }
  // The paired accept: real loopback addresses.
  for (const host of ['127.0.0.1', '127.0.0.5', 'localhost', '[::1]', '[0:0:0:0:0:0:0:1]']) {
    assert.equal(isLoopbackStoreHost(`postgres://u:pw@${host}:5432/store`), true, host);
  }
  // …and IPv6 longhand where it is NOT pre-compressed for us. In an authority
  // the URL parser rewrites `[0:0:0:0:0:0:0:1]` to `[::1]`, so the case above
  // is satisfied by a literal comparison and proves nothing about
  // canonicalisation. Through `?host=` the value arrives byte-for-byte.
  for (const host of ['0:0:0:0:0:0:0:1', '::1', '[::1]', '0000:0000:0000:0000:0000:0000:0000:0001']) {
    const dsn = `postgres://u:pw@db.example.com:5432/store?host=${encodeURIComponent(host)}`;
    assert.equal(effectiveStoreHost(dsn), host, `${host}: fixture is pre-normalised, so it cannot discriminate`);
    assert.equal(isLoopbackStoreHost(dsn), true, host);
  }
  // The negative control for canonicalisation: a NON-loopback IPv6 address must
  // not be swept up by it.
  for (const host of ['::2', '2001:db8::1', '::ffff:8.8.8.8']) {
    const dsn = `postgres://u:pw@localhost:5432/store?host=${encodeURIComponent(host)}`;
    assert.equal(isLoopbackStoreHost(dsn), false, host);
    assert.ok(withEnv({}, () => effective(storeConnectionConfig(dsn)).ssl), host);
  }
});

test('a unix domain socket is local and gets no TLS', () => {
  for (const dsn of [
    'postgres://u:pw@localhost:5432/store?host=/var/run/postgresql',
    'postgres://u:pw@%2Fvar%2Frun%2Fpostgresql/store',
  ]) {
    assert.equal(effective({ connectionString: dsn }).socket, true, `${dsn}: fixture is not a socket`);
    assert.deepEqual(withEnv({ STORE_DATABASE_CA: 'PEM' }, () => storeConnectionConfig(dsn)), {
      connectionString: dsn,
    });
  }
});

// ─── the refusal, and its escape hatch ───────────────────────────────────────

test('a remote target with TLS switched off is refused', () => {
  for (const suffix of ['?sslmode=disable', '?ssl=0', '?ssl=', '?ssl=1&ssl=0', '?ssl=1&ssl=']) {
    assert.throws(() => withEnv({}, () => storeConnectionConfig(`${REMOTE}${suffix}`)), PlaintextStoreConnectionError, suffix);
  }
});

test('the refusal message carries no part of the connection string', () => {
  const secretive = `postgres://user:${AWKWARD}@db.example.com:5432/store?sslmode=disable`;
  const error = withEnv({}, () => {
    try {
      storeConnectionConfig(secretive);
      return null;
    } catch (caught) {
      return caught as Error;
    }
  });
  assert.ok(error instanceof PlaintextStoreConnectionError);
  const text = `${error.message}${error.stack ?? ''}`;
  assert.ok(!text.includes(AWKWARD), 'the password reached the error');
  assert.ok(!text.includes('db.example.com'), 'the host reached the error');
  assert.ok(text.includes('STORE_DATABASE_ALLOW_PLAINTEXT'), 'the message must name the way out');
});

test('the opt-out is explicit, exact, and only then permits plaintext', () => {
  const dsn = `${REMOTE}?sslmode=disable`;
  const allowed = withEnv({ STORE_DATABASE_ALLOW_PLAINTEXT: '1' }, () => storeConnectionConfig(dsn));
  assert.deepEqual(allowed, { connectionString: dsn });
  assert.equal(effective(allowed).ssl, false, 'the opt-out really does connect in the clear');
  // Anything other than the exact value keeps the refusal.
  for (const value of ['0', 'true', 'yes', 'TRUE', ' ', 'on']) {
    assert.throws(
      () => withEnv({ STORE_DATABASE_ALLOW_PLAINTEXT: value }, () => storeConnectionConfig(dsn)),
      PlaintextStoreConnectionError,
      JSON.stringify(value)
    );
  }
});

test('the opt-out does NOT switch off TLS where nothing asked it to', () => {
  // The negative control for the escape hatch: it permits a URL's own choice,
  // it does not become a global "no TLS" switch.
  const config = withEnv({ STORE_DATABASE_ALLOW_PLAINTEXT: '1' }, () => storeConnectionConfig(REMOTE));
  assert.deepEqual(config, { connectionString: REMOTE, ssl: { rejectUnauthorized: false } });
  assert.ok(effective(config).ssl);
});

// ─── the surrounding contract, unchanged ─────────────────────────────────────

test('the shipped default is local — a change here breaks every developer', () => {
  // The negative control for the whole module. If this ever starts requesting
  // TLS, `yarn runner:fire` against the local Docker store stops working with
  // "The server does not support SSL connections".
  assert.ok(isLoopbackStoreHost('postgres://postgres:spike@localhost:5433/store_spike'));
  assert.deepEqual(withEnv({}, () => storeConnectionConfig(LOCAL)), { connectionString: LOCAL });
});

test('a remote target gets TLS, and a supplied CA turns verification on', () => {
  assert.deepEqual(withEnv({}, () => storeConnectionConfig(REMOTE)), {
    connectionString: REMOTE,
    ssl: { rejectUnauthorized: false },
  });
  const pem = '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----';
  const verified = withEnv({ STORE_DATABASE_CA: pem }, () => storeConnectionConfig(REMOTE));
  assert.deepEqual(verified.ssl, { rejectUnauthorized: true, ca: pem });
  assert.deepEqual(effective(verified).ssl, { rejectUnauthorized: true, ca: pem });
});

test('the CA is ignored for a local target — it does not force TLS on by the back door', () => {
  assert.deepEqual(withEnv({ STORE_DATABASE_CA: 'PEM' }, () => storeConnectionConfig(LOCAL)), {
    connectionString: LOCAL,
  });
});

test('the connection string is passed through byte-identical, never rewritten', () => {
  for (const url of [
    `postgres://postgres:${AWKWARD}@db.example.com:5432/store`,
    `postgres://postgres:${AWKWARD}@localhost:5433/store_spike`,
  ]) {
    const config = withEnv({}, () => storeConnectionConfig(url));
    assert.equal(config.connectionString, url);
    // …and the driver still reads the password back out of it unharmed.
    assert.equal(parametersOf(new Client({ ...config } as ClientConfig)).password, AWKWARD);
  }
  assert.ok(AWKWARD.includes('%'), 'the awkward character really is in the fixture');
});

test('PGHOST decides the target when the URL names no host', () => {
  // The driver falls back to the environment, so the URL alone is not the
  // target. A remote PGHOST with a hostless URL must still be encrypted.
  const hostless = 'postgres://user:pw@/store';
  assert.equal(withEnv({ PGHOST: 'db.example.com' }, () => effectiveStoreHost(hostless)), 'db.example.com');
  assert.ok(withEnv({ PGHOST: 'db.example.com' }, () => storeConnectionConfig(hostless).ssl));
  assert.deepEqual(withEnv({ PGHOST: 'localhost' }, () => storeConnectionConfig(hostless)), {
    connectionString: hostless,
  });
  // An empty connection string is not parsed by the driver at all.
  assert.equal(withEnv({ PGHOST: 'db.example.com' }, () => effectiveStoreHost('')), 'db.example.com');
  assert.equal(withEnv({}, () => effectiveStoreHost('')), 'localhost');
});

test('an uninspectable URL fails CLOSED, toward encryption', () => {
  // `parse` reads sslcert/sslkey/sslrootcert off the disk and throws when the
  // path is absent. That cannot be classified, so it is treated as remote and
  // unstated: TLS is attached and the driver raises its own error on connect.
  const dsn = `${REMOTE}?sslrootcert=/nonexistent/ca.pem`;
  assert.equal(effectiveStoreHost(dsn), null);
  assert.equal(dsnTlsDecision(dsn), 'unstated');
  assert.deepEqual(withEnv({}, () => storeConnectionConfig(dsn)), {
    connectionString: dsn,
    ssl: { rejectUnauthorized: false },
  });
  // `not-a-url` resolves, in the driver, to the host `base` — remote, so TLS.
  assert.ok(withEnv({}, () => storeConnectionConfig('not-a-url').ssl));
  // `postgres:missing-slashes` names no host, so the driver dials localhost.
  // Attaching TLS there would protect nothing and break the connection, which
  // is why "fail closed" is stated as a HOST question and not an SSL one: the
  // conservative answer is the driver's real target, not a blanket encrypt.
  assert.equal(withEnv({}, () => effectiveStoreHost('postgres:missing-slashes')), 'localhost');
  assert.deepEqual(withEnv({}, () => storeConnectionConfig('postgres:missing-slashes')), {
    connectionString: 'postgres:missing-slashes',
  });
  assert.ok(withEnv({ PGHOST: 'db.example.com' }, () => storeConnectionConfig('postgres:missing-slashes').ssl));
});
