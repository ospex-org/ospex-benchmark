import { dsnFacts, isLocalHost } from '../dsnFacts.js';
import { envValue } from '../config.js';
import type { DsnTlsDecision } from '../dsnFacts.js';

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
 * So the decision is made here, once, for every place the campaign store is
 * opened: the runner's two pools, the fire runner's, and the three conformance
 * entry points, which take the same operator-supplied variable.
 *
 * ── THE RULES ────────────────────────────────────────────────────────────────
 *
 * 1. **A local target gets nothing added.** A local PostgreSQL has no TLS, and
 *    demanding it there does not degrade — it fails outright with "The server
 *    does not support SSL connections". The default developer workflow has to
 *    keep working or this helper is a bug. Adding NOTHING is not the same as
 *    adding `ssl: false`: with no key the driver consults `PGSSLMODE`, so an
 *    operator who exports it gets TLS demanded locally too. That is their
 *    setting to make, and overriding it here would take the choice away.
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
 * Rules 1, 2 and 3 are checked in that order. Rule 4 is not a fourth branch —
 * it is a constraint on rule 2, the case where the URL's own answer is "no
 * encryption" and the target is not this machine, so in the code it is reached
 * before rule 3's fallthrough.
 *
 * Both facts the rules turn on — the host the driver will dial, and what the URL
 * itself decides about TLS — come from `dsnFacts.ts`, which asks the driver's
 * own connection-string parser rather than modelling it. That module carries the
 * measurements, and the serving publisher's resolver reads the same two facts
 * from it, so the two cannot drift apart.
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

/** Re-exported so a caller of this module needs only this import. */
export type { DsnTlsDecision };

/**
 * The host node-postgres will actually dial, including a `?host=` query
 * parameter — which OVERRIDES the authority, so the authority alone is not the
 * target — and the environment fallback the driver applies when neither states
 * one. Null when the string cannot be inspected.
 */
export function effectiveStoreHost(databaseUrl: string): string | null {
  return dsnFacts(databaseUrl).host;
}

/**
 * What the URL itself decides about TLS.
 *
 * `unstated` is the only answer that leaves room to attach anything: in the
 * other two the driver will apply the URL's own setting over whatever is
 * supplied beside it.
 */
export function dsnTlsDecision(databaseUrl: string): DsnTlsDecision {
  return dsnFacts(databaseUrl).tls;
}

/** True when the target is this machine, so no TLS is requested. */
export function isLoopbackStoreHost(databaseUrl: string): boolean {
  return isLocalHost(dsnFacts(databaseUrl).host);
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
  const { host, tls } = dsnFacts(databaseUrl);
  if (isLocalHost(host)) return { connectionString: databaseUrl };
  if (tls === 'encrypts') return { connectionString: databaseUrl };
  if (tls === 'plaintext') {
    if (envValue('STORE_DATABASE_ALLOW_PLAINTEXT') !== '1') throw new PlaintextStoreConnectionError();
    return { connectionString: databaseUrl };
  }
  return { connectionString: databaseUrl, ssl: configuredTls() };
}
