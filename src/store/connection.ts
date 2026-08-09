import net from 'node:net';
import { parse } from 'pg-connection-string';
import { envValue } from '../config.js';

/**
 * How the campaign store reaches PostgreSQL.
 *
 * The store defaults to a local Docker instance, and for that a plain
 * connection string is right. But `STORE_DATABASE_URL` is an operator-supplied
 * value and the runbook sanctions pointing it at a managed instance — at which
 * point a bare `new Pool({ connectionString })` sends the password and every
 * row across the network in cleartext, successfully and with no warning. That
 * is not a hypothetical default: it is what node-postgres does when no `ssl`
 * option is present and the URL carries no SSL parameter.
 *
 * So the decision is made here, once, for every call site.
 *
 * ── THE RULES, IN ORDER ──────────────────────────────────────────────────────
 *
 * 1. **A local target gets nothing added.** A local PostgreSQL has no TLS, and
 *    demanding it there does not degrade — it fails outright with "The server
 *    does not support SSL connections". The default developer workflow has to
 *    keep working or this helper is a bug.
 *
 * 2. **A URL that states its own SSL policy wins, and nothing is added.** When a
 *    connection string carries an SSL parameter the driver applies it OVER a
 *    separately supplied `ssl` option, in both directions, so adding one
 *    alongside would be a coin flip dressed as a policy. `STORE_DATABASE_CA`
 *    does not apply to such a URL.
 *
 * 3. **Anything else gets TLS.** Encrypted by default; verified when
 *    `STORE_DATABASE_CA` supplies the certificate authority.
 *
 * 4. **A remote target that ends up with no TLS is REFUSED**, unless
 *    `STORE_DATABASE_ALLOW_PLAINTEXT=1` says to send it in the clear on
 *    purpose. Rule 2 hands the decision to the operator; rule 4 makes them say
 *    it twice when the decision is "no encryption to another machine".
 *
 * ── WHY THIS ASKS THE DRIVER INSTEAD OF READING THE URL ──────────────────────
 *
 * The previous version searched the text after the userinfo for `sslmode=` and
 * read the host out of the authority with a substring. Both were models of the
 * driver, and both were wrong in ways that sent the credential out in
 * plaintext. Measured against the pinned driver:
 *
 *   ?sslmode=                             matched the text, states nothing
 *   ?application_name=sslmode=disable     matched the text, states nothing
 *   #sslmode=disable                      matched the text, states nothing
 *   ?sslmode=require&sslmode=             matched the text; the driver keeps the
 *                                         LAST duplicate, which states nothing
 *   ?%73slmode=disable                    did NOT match; the driver decodes the
 *                                         key and disables TLS
 *   ?ssl=0                                did NOT match; disables TLS
 *   ?host=db.example.com on a localhost   authority read as local; the driver
 *   authority                             dials the query parameter instead
 *   127.0.0.1.evil.com                    read as loopback by a `127.` prefix
 *                                         test — it is an ordinary registrable
 *                                         name and the credential went to it in
 *                                         the clear
 *
 * So nothing here predicts what the driver will do. It calls the driver's own
 * connection-string parser — the same `pg-connection-string` module `pg` itself
 * calls, kept on the same version range so a single copy is hoisted — and reads
 * the answer back:
 *
 *   the DSN's SSL policy   `ConnectionParameters` merges the parsed connection
 *                          string OVER the supplied config, so an own `ssl` key
 *                          in the parse result IS "the URL overrides whatever I
 *                          attach". Nothing else has to be enumerated.
 *   the host it will dial  the parse result's host, which already has any
 *                          `?host=` override applied.
 *
 * Verified by differential test against a real `pg.Client` and `pg.Pool` over a
 * generated matrix of connection strings, and by a live server with TLS off.
 * Both predicates agreed on every one; see `connection.test.ts`.
 *
 * ── WHY THERE IS NO RULE ABOUT DUPLICATE OR EMPTY SSL PARAMETERS ─────────────
 *
 * Because rule 4 already covers them, and a second parser to detect them would
 * reintroduce the defect above. Every duplicate is resolved by the driver's own
 * parser, and whatever it resolves to then meets rule 4 — so a duplicate can
 * only ever end in TLS or in a refusal, never in a silent downgrade. Measured
 * over all 200 duplicate combinations of `ssl` and `sslmode`: 170 end in TLS,
 * 30 end with no TLS and are refused. Same for an empty `?ssl=`, which the
 * driver turns into a falsy value: refused, not guessed at.
 *
 * ⚠ `sslmode=require` DOES NOT MEAN WHAT IT MEANS IN libpq. node-postgres
 *   currently treats `prefer`, `require` and `verify-ca` as aliases for
 *   `verify-full`, and warns at runtime that it will adopt libpq's weaker
 *   semantics in a future major. Against an endpoint whose chain is not in
 *   Node's trust store — a managed provider's direct endpoint, for one —
 *   `require` fails with SELF_SIGNED_CERT_IN_CHAIN. The mode that means
 *   "encrypt but do not verify" is `no-verify`, which is also what rule 3
 *   produces without a CA.
 */

/** What TLS to negotiate. `ca` present means the chain is verified against it. */
export interface StoreTlsOption {
  readonly rejectUnauthorized: boolean;
  readonly ca?: string | undefined;
}

/**
 * Driver-shaped, but deliberately not a `pg` type — `pg` is a devDependency and
 * no module outside conformance and runtime wiring imports it. The connection
 * string is carried through BYTE-IDENTICAL: a generated password can contain a
 * `%` that begins no valid escape, and any code path that re-serialises the
 * userinfo corrupts it. Reading a parse result cannot.
 */
export interface StoreConnectionConfig {
  readonly connectionString: string;
  readonly ssl?: StoreTlsOption;
}

/**
 * Rule 4. Refusing is deliberate: this is a credential-safety gate, not an
 * advisory check, and the alternative to refusing is putting a database
 * password on the wire in the clear.
 *
 * The message names no host and carries no part of the URL — the whole point of
 * the refusal is that the URL holds a credential, and this error is reported
 * and recorded like any other.
 */
export class PlaintextStoreConnectionError extends Error {
  constructor() {
    super(
      'STORE_DATABASE_URL disables TLS for a host that is not loopback, so the ' +
        'database password would cross the network in cleartext. Remove the ssl ' +
        'or sslmode parameter from the URL to encrypt (the default for a remote ' +
        'host), or set STORE_DATABASE_ALLOW_PLAINTEXT=1 to send it in the clear ' +
        'on purpose.'
    );
    this.name = 'PlaintextStoreConnectionError';
  }
}

/** What the driver falls back to when neither the URL nor PGHOST names a host. */
const DEFAULT_HOST = 'localhost';

/** Hosts that name this machine, and so cannot be reached over a network. */
const LOCAL_HOSTS = new Set(['localhost', '0.0.0.0']);

/** What a connection string says about TLS, as the driver reads it. */
export type DsnTlsDecision = 'unstated' | 'encrypts' | 'plaintext';

/**
 * The parse result, or null when the string cannot be inspected.
 *
 * `parse` reads `sslcert` / `sslkey` / `sslrootcert` off the disk and throws
 * when the path does not exist. The driver throws the same way a moment later
 * on the same string, so there is nothing to recover here — null means "cannot
 * classify", and every caller treats that as remote-and-unstated, which fails
 * toward encryption.
 */
function inspect(databaseUrl: string): ReturnType<typeof parse> | null {
  // A falsy connection string is not parsed by the driver AT ALL:
  // `ConnectionParameters` only consults it when truthy, so an empty one leaves
  // the host to the environment rather than to the URL.
  if (!databaseUrl) return null;
  try {
    return parse(databaseUrl);
  } catch {
    return null;
  }
}

/** IPv6 in its canonical compressed form, so every spelling of ::1 compares equal. */
function canonicalIpv6(host: string): string | null {
  try {
    return new URL(`http://[${host}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/**
 * Whether a host names this machine.
 *
 * Unknown answers false — a host this cannot place is treated as remote, so the
 * failure mode is a loud "the server does not support SSL connections" against
 * a local server rather than a silent plaintext send to a remote one. An exotic
 * spelling of a local address (`::ffff:127.0.0.1`) lands there.
 */
function isLocalHost(host: string | null): boolean {
  if (host === null) return false;
  // The driver's own domain-socket test is a leading slash, and a unix socket
  // never leaves the machine.
  if (host.startsWith('/')) return true;
  const bracketed = /^\[(.*)\]$/.exec(host);
  const bare = (bracketed === null ? host : bracketed[1]!).toLowerCase();
  if (LOCAL_HOSTS.has(bare)) return true;
  // 127.0.0.0/8, but as an ADDRESS. A `127.` prefix test also accepts
  // `127.0.0.1.evil.com`, which is a name anybody can register.
  if (net.isIPv4(bare)) return bare.startsWith('127.');
  if (net.isIPv6(bare)) return canonicalIpv6(bare) === '::1';
  return false;
}

/**
 * The host node-postgres will actually dial, including a `?host=` query
 * parameter — which OVERRIDES the authority, so the authority alone is not the
 * target — and the environment fallback the driver applies when neither states
 * one.
 *
 * Null when the string cannot be inspected.
 */
export function effectiveStoreHost(databaseUrl: string): string | null {
  if (!databaseUrl) return process.env['PGHOST'] || DEFAULT_HOST;
  const parsed = inspect(databaseUrl);
  if (parsed === null) return null;
  return parsed.host || process.env['PGHOST'] || DEFAULT_HOST;
}

/**
 * What the URL itself decides about TLS.
 *
 * `unstated` is the only answer that leaves room to attach anything: in the
 * other two the driver will apply the URL's own setting over whatever is
 * supplied beside it.
 */
export function dsnTlsDecision(databaseUrl: string): DsnTlsDecision {
  const parsed = inspect(databaseUrl);
  if (parsed === null || !('ssl' in parsed)) return 'unstated';
  return parsed.ssl ? 'encrypts' : 'plaintext';
}

/** True when the target is this machine, so no TLS is requested. */
export function isLoopbackStoreHost(databaseUrl: string): boolean {
  return isLocalHost(effectiveStoreHost(databaseUrl));
}

function configuredTls(): StoreTlsOption {
  const ca = envValue('STORE_DATABASE_CA');
  return ca === undefined ? { rejectUnauthorized: false } : { rejectUnauthorized: true, ca };
}

/**
 * Build the pg configuration for the campaign store.
 *
 * Throws `PlaintextStoreConnectionError` when the result would put the
 * credential on the wire in the clear to another machine and no explicit
 * opt-out is set.
 */
export function storeConnectionConfig(databaseUrl: string): StoreConnectionConfig {
  if (isLoopbackStoreHost(databaseUrl)) return { connectionString: databaseUrl };

  const decision = dsnTlsDecision(databaseUrl);
  if (decision === 'encrypts') return { connectionString: databaseUrl };
  if (decision === 'plaintext') {
    if (envValue('STORE_DATABASE_ALLOW_PLAINTEXT') !== '1') throw new PlaintextStoreConnectionError();
    return { connectionString: databaseUrl };
  }
  return { connectionString: databaseUrl, ssl: configuredTls() };
}
