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
 * option is present and the URL carries no `sslmode`.
 *
 * So the decision is made here, once, for every call site.
 *
 * ── THE RULES, IN ORDER ──────────────────────────────────────────────────────
 *
 * 1. **The URL's own `sslmode` wins, and nothing is added.** Measured: when a
 *    connection string carries `sslmode`, it overrides an explicit `ssl` option
 *    in BOTH directions — `?sslmode=disable` with `ssl: {…}` connects in the
 *    clear, and `?sslmode=require` with `ssl: false` still demands TLS. Adding
 *    an `ssl` option next to an `sslmode` would therefore be a coin flip
 *    dressed as a policy. If the operator has stated a mode, that is the answer.
 *
 * 2. **A loopback host gets nothing added.** A local PostgreSQL has no TLS, and
 *    demanding it there does not degrade — it fails outright with "The server
 *    does not support SSL connections". The default developer workflow has to
 *    keep working or this helper is a bug.
 *
 * 3. **Anything else gets TLS.** Encrypted by default; verified when
 *    `STORE_DATABASE_CA` supplies the certificate authority.
 *
 * A host this cannot parse is treated as remote — fail closed toward
 * encryption. The escape hatch for a non-loopback host that genuinely has no
 * TLS (a service name on a container network, say) is rule 1: put
 * `?sslmode=disable` in the URL and say so deliberately.
 *
 * ⚠ `sslmode=require` DOES NOT MEAN WHAT IT MEANS IN libpq. node-postgres
 *   currently treats `prefer`, `require` and `verify-ca` as aliases for
 *   `verify-full`, and warns at runtime that it will adopt libpq's weaker
 *   semantics in a future major. Against an endpoint whose chain is not in
 *   Node's trust store — Supabase's direct endpoint, for one — `require` fails
 *   with SELF_SIGNED_CERT_IN_CHAIN. The mode that means "encrypt but do not
 *   verify" is `no-verify`, which is also what rule 3 produces without a CA.
 */

/** What TLS to negotiate. `ca` present means the chain is verified against it. */
export interface StoreTlsOption {
  readonly rejectUnauthorized: boolean;
  readonly ca?: string | undefined;
}

/**
 * Driver-shaped, but deliberately not a `pg` type — `pg` is a devDependency and
 * no module outside conformance and runtime wiring imports it.
 */
export interface StoreConnectionConfig {
  readonly connectionString: string;
  readonly ssl?: StoreTlsOption;
}

/** Hosts that cannot offer TLS and must not be asked for it. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '']);

/**
 * The host, extracted WITHOUT a URL parser.
 *
 * `new URL()` is avoided on purpose: a generated password can contain a `%`
 * that begins no valid escape, and any code path that decodes or re-serialises
 * the userinfo either throws or silently rewrites the password. Reading the
 * substring after the last `@` cannot touch it.
 *
 * Returns null when the shape is unrecognisable, which callers treat as remote.
 */
function hostOf(databaseUrl: string): string | null {
  const scheme = databaseUrl.indexOf('://');
  if (scheme === -1) return null;
  const at = databaseUrl.lastIndexOf('@');
  const authority = databaseUrl.slice(at > scheme ? at + 1 : scheme + 3);
  const hostPort = authority.split(/[/?]/)[0] ?? '';
  const bracketed = /^\[([^\]]*)\]/.exec(hostPort);
  if (bracketed) return bracketed[1]!.toLowerCase();
  const colon = hostPort.lastIndexOf(':');
  return (colon === -1 ? hostPort : hostPort.slice(0, colon)).toLowerCase();
}

/** Whether the URL already states an sslmode. Looked for only AFTER the
 *  userinfo, so a password containing the literal text cannot fake one. */
function statesSslMode(databaseUrl: string): boolean {
  const scheme = databaseUrl.indexOf('://');
  if (scheme === -1) return false;
  const at = databaseUrl.lastIndexOf('@');
  return databaseUrl.slice(at > scheme ? at + 1 : scheme + 3).includes('sslmode=');
}

/** True when the host is one that cannot serve TLS, so none is requested. */
export function isLoopbackStoreHost(databaseUrl: string): boolean {
  const host = hostOf(databaseUrl);
  if (host === null) return false;
  return LOOPBACK.has(host) || host.startsWith('127.');
}

/**
 * Build the pg configuration for the campaign store, adding TLS only when the
 * target is remote and the URL has not already decided the question.
 */
export function storeConnectionConfig(databaseUrl: string): StoreConnectionConfig {
  if (statesSslMode(databaseUrl) || isLoopbackStoreHost(databaseUrl)) {
    return { connectionString: databaseUrl };
  }
  const ca = envValue('STORE_DATABASE_CA');
  return {
    connectionString: databaseUrl,
    ssl: ca === undefined ? { rejectUnauthorized: false } : { rejectUnauthorized: true, ca },
  };
}
