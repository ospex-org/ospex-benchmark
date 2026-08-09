import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLoopbackStoreHost, storeConnectionConfig } from './connection.js';

/**
 * The TLS decision for the campaign store. Pure — nothing here opens a socket.
 *
 * The property that matters is a conjunction, and both halves have teeth: a
 * remote target must get TLS (or the credential crosses in the clear), and a
 * local one must NOT (or every developer's default workflow breaks, because
 * demanding TLS from a server without it fails outright rather than degrading).
 * Each assertion below is paired with its opposite for that reason.
 */

const LOCAL = 'postgres://postgres:spike@localhost:5433/store_spike';
const REMOTE = 'postgres://user:pw@db.example.com:5432/store';

// The awkward class: a generated password containing a `%` that begins no valid
// escape. Any implementation that parses and re-serialises the URL corrupts it.
const AWKWARD = 'q=&*()V1fXi;(%-WH{R>';

function withCa<T>(ca: string | undefined, fn: () => T): T {
  const previous = process.env['STORE_DATABASE_CA'];
  if (ca === undefined) delete process.env['STORE_DATABASE_CA'];
  else process.env['STORE_DATABASE_CA'] = ca;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env['STORE_DATABASE_CA'];
    else process.env['STORE_DATABASE_CA'] = previous;
  }
}

test('a local target gets no ssl option at all', () => {
  for (const url of [
    LOCAL,
    'postgres://postgres:pw@127.0.0.1:5432/db',
    'postgres://postgres:pw@127.0.0.5:5432/db',
    'postgres://postgres:pw@0.0.0.0:5432/db',
    'postgres://postgres:pw@[::1]:5432/db',
    'postgres://localhost:5432/db',
    'postgres://LOCALHOST:5432/db',
  ]) {
    const config = withCa(undefined, () => storeConnectionConfig(url));
    assert.deepEqual(config, { connectionString: url }, url);
    assert.ok(!('ssl' in config), `${url}: no ssl key at all, not even undefined`);
  }
});

test('the shipped default is local — a change here breaks every developer', () => {
  // The negative control for the whole module. If this ever starts requesting
  // TLS, `yarn runner:fire` against the local Docker store stops working with
  // "The server does not support SSL connections".
  assert.ok(isLoopbackStoreHost('postgres://postgres:spike@localhost:5433/store_spike'));
});

test('a remote target gets TLS', () => {
  const config = withCa(undefined, () => storeConnectionConfig(REMOTE));
  assert.deepEqual(config, { connectionString: REMOTE, ssl: { rejectUnauthorized: false } });
});

test('a supplied CA turns verification on', () => {
  const config = withCa('-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
    () => storeConnectionConfig(REMOTE));
  assert.deepEqual(config.ssl, {
    rejectUnauthorized: true,
    ca: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
  });
});

test('the CA is ignored for a local target — it does not force TLS on by the back door', () => {
  const config = withCa('PEM', () => storeConnectionConfig(LOCAL));
  assert.deepEqual(config, { connectionString: LOCAL });
});

test('an sslmode already in the URL wins, and nothing is added', () => {
  // Measured: when a connection string carries sslmode it overrides an explicit
  // `ssl` option in BOTH directions, so adding one alongside would be a coin
  // flip. `disable` is the documented escape hatch for a non-loopback host that
  // genuinely has no TLS.
  for (const mode of ['disable', 'require', 'no-verify', 'verify-full', 'prefer']) {
    const url = `${REMOTE}?sslmode=${mode}`;
    assert.deepEqual(withCa('PEM', () => storeConnectionConfig(url)), { connectionString: url }, mode);
  }
  const combined = `${REMOTE}?connect_timeout=10&sslmode=disable`;
  assert.deepEqual(withCa(undefined, () => storeConnectionConfig(combined)), { connectionString: combined });
});

test('an unrelated query parameter does NOT count as stating an sslmode', () => {
  // The paired accept for the test above: without this, any URL with a query
  // string would silently opt out of TLS.
  const url = `${REMOTE}?connect_timeout=10`;
  assert.deepEqual(withCa(undefined, () => storeConnectionConfig(url)).ssl, { rejectUnauthorized: false });
});

test('an sslmode inside the PASSWORD cannot fake one', () => {
  // Only the text after the userinfo is examined. A password that happens to
  // contain `sslmode=` would otherwise disable TLS for a remote host.
  const url = 'postgres://user:has-sslmode=disable-inside@db.example.com:5432/store';
  assert.deepEqual(withCa(undefined, () => storeConnectionConfig(url)).ssl, { rejectUnauthorized: false });
});

test('a host that looks local inside the password does not make the target local', () => {
  const url = 'postgres://user:localhost@db.example.com:5432/store';
  assert.equal(isLoopbackStoreHost(url), false);
  assert.deepEqual(withCa(undefined, () => storeConnectionConfig(url)).ssl, { rejectUnauthorized: false });
});

test('the connection string is passed through byte-identical, never rewritten', () => {
  // The reason this module does no URL parsing: `new URL(...)` round-tripping a
  // password containing `%` either throws on decode or silently re-encodes it,
  // and a rewritten password is a connection that fails for a reason nobody
  // will look for here.
  for (const url of [
    `postgres://postgres:${AWKWARD}@db.example.com:5432/store`,
    `postgres://postgres:${AWKWARD}@localhost:5433/store_spike`,
  ]) {
    assert.equal(withCa(undefined, () => storeConnectionConfig(url)).connectionString, url);
  }
  assert.ok(AWKWARD.includes('%'), 'the awkward character really is in the fixture');
});

test('an encoded @ in the password does not confuse the host', () => {
  const url = 'postgres://user:pa%40ss@db.example.com:5432/store';
  assert.equal(isLoopbackStoreHost(url), false);
  const local = 'postgres://user:pa%40ss@localhost:5432/store';
  assert.equal(isLoopbackStoreHost(local), true);
});

test('an unrecognisable URL fails CLOSED, toward encryption', () => {
  for (const url of ['not-a-url', 'postgres:missing-slashes', '']) {
    assert.deepEqual(withCa(undefined, () => storeConnectionConfig(url)).ssl,
      { rejectUnauthorized: false }, url);
  }
});

test('a URL with no database path still resolves its host', () => {
  assert.equal(isLoopbackStoreHost('postgres://postgres:pw@localhost'), true);
  assert.equal(isLoopbackStoreHost('postgres://postgres:pw@db.example.com'), false);
});
