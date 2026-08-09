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
 *   ?host=//HOST/pipe/x                   read as a unix socket by a leading
 *                                         slash — on Windows it is a UNC name
 *                                         and the credential went to HOST over
 *                                         SMB, also in the clear
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
 * generated matrix of connection strings; both predicates agreed on every one.
 * Those sweeps are in `connection.test.ts`. The runs that need a server — a
 * live PostgreSQL with TLS off, and a listener reading the first bytes off the
 * socket — are recorded in the pull request, since they need a non-loopback
 * address and cannot run in CI.
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

/** Host NAMES that mean this machine. Addresses are classified below. */
const LOCAL_HOST_NAMES = new Set(['localhost']);

/** What a connection string says about TLS, as the driver reads it. */
export type DsnTlsDecision = 'unstated' | 'encrypts' | 'plaintext';

/** Everything the decision needs, from ONE parse of the string. */
interface DsnFacts {
  /** The host the driver will dial; null when the string cannot be inspected. */
  readonly host: string | null;
  readonly tls: DsnTlsDecision;
}

/**
 * Read both facts out of the driver's own parse, once.
 *
 * Once, because `parse` reads `sslcert` / `sslkey` / `sslrootcert` off the disk;
 * asking twice would read them twice. It also THROWS when such a path does not
 * exist — the driver throws the same way a moment later on the same string, so
 * there is nothing to recover here. A null host means "cannot classify", which
 * every caller treats as remote, and `unstated` then attaches TLS: the failure
 * is a driver error on connect, not a silent plaintext send.
 *
 * The host fallback chain mirrors the driver's own `val()`: the parsed host,
 * else PGHOST, else `pg.defaults.host`, which is `'localhost'` and which
 * nothing in this repo reassigns.
 */
function dsnFacts(databaseUrl: string): DsnFacts {
  // A falsy connection string is not parsed by the driver AT ALL:
  // `ConnectionParameters` only consults it when truthy, so an empty one leaves
  // the host to the environment rather than to the URL.
  if (!databaseUrl) return { host: process.env['PGHOST'] || DEFAULT_HOST, tls: 'unstated' };
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(databaseUrl);
  } catch {
    return { host: null, tls: 'unstated' };
  }
  return {
    host: parsed.host || process.env['PGHOST'] || DEFAULT_HOST,
    // An own `ssl` key IS "the URL overrides whatever I attach" — see the header.
    tls: !('ssl' in parsed) ? 'unstated' : parsed.ssl ? 'encrypts' : 'plaintext',
  };
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
 * Whether an IPv6 address reaches this machine.
 *
 * Three families, each measured against a listener on this machine:
 *   ::1                loopback, in every spelling
 *   ::                 the unspecified address, the IPv6 twin of 0.0.0.0
 *   ::ffff:127.x.x.x   IPv4-mapped loopback, and ::ffff:0.0.0.0
 *
 * The canonical form renders a mapped address as two hex groups, so
 * `::ffff:127.0.0.1` is `::ffff:7f00:1` and the top byte of the first group is
 * the first IPv4 octet. `::ffff:112.0.0.1` is `::ffff:7000:1`, which is why the
 * test is on that byte rather than on the text.
 */
function isLocalIpv6(host: string): boolean {
  const canonical = canonicalIpv6(host);
  if (canonical === null) return false;
  if (canonical === '::1' || canonical === '::') return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped === null) return false;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return high >>> 8 === 127 || (high === 0 && low === 0);
}

/**
 * Whether a host names this machine.
 *
 * Unknown answers false — a host this cannot place is treated as remote, so the
 * failure mode is a loud "the server does not support SSL connections" against
 * a local server rather than a silent plaintext send to a remote one. The legacy
 * inet_aton spellings of loopback land there; see the note at the bottom.
 */
function isLocalHost(host: string | null): boolean {
  if (host === null) return false;
  // A leading slash is the driver's own domain-socket test — but only ONE.
  // ⚠ `//HOST/pipe/x` is a UNC name on Windows, and the driver hands it
  //   straight to `net.connect({ path })`, where the SMB redirector dials HOST
  //   on port 445. Measured on win32: an outbound SYN to another machine, and
  //   the StartupMessage and cleartext password delivered to a listener
  //   addressed by a non-loopback IPv4 of this box. "A unix socket never leaves
  //   the machine" is true on POSIX and false here, so a second slash forfeits
  //   the local verdict and the target gets TLS. A backslash forfeits it too:
  //   Windows treats the two separators as interchangeable, so a slash-prefixed
  //   path carrying backslashes can denote the same UNC name. That half is a
  //   conservative rule rather than a measured one — only the `//` form was
  //   observed leaving the machine — and its cost is a loud failure against a
  //   POSIX socket path with a backslash in it.
  if (host.startsWith('/')) return !host.startsWith('//') && !host.includes('\\');
  const bracketed = /^\[(.*)\]$/.exec(host);
  const bare = (bracketed === null ? host : bracketed[1]!).toLowerCase();
  // One trailing dot is the root-anchored spelling of a NAME, and `localhost.`
  // really does reach this machine — measured, it connects to a listener on
  // 127.0.0.1. The dot is stripped for the NAME comparison only and never
  // before an address test, because `127.0.0.1.` is not this machine: it is
  // ENOTFOUND, a DNS name whose top-level label `1` does not exist. And
  // `127.0.0.1.evil.com.` stays a name that is not localhost.
  if (LOCAL_HOST_NAMES.has(bare.endsWith('.') ? bare.slice(0, -1) : bare)) return true;
  // 127.0.0.0/8 and 0.0.0.0, but as ADDRESSES. A `127.` prefix test also
  // accepts `127.0.0.1.evil.com`, which is a name anybody can register.
  if (net.isIPv4(bare)) return bare.startsWith('127.') || bare === '0.0.0.0';
  if (net.isIPv6(bare)) return isLocalIpv6(bare);
  // Everything else is remote, INCLUDING spellings that would in fact reach
  // this machine — the legacy inet_aton forms `0177.0.0.1`, `2130706433` and
  // `0x7f000001` among them. Recognising those means reimplementing inet_aton,
  // which is the kind of model this module exists to avoid. The cost is a loud
  // failure against a local server, or a refusal that names its own way out,
  // rather than a quiet plaintext send to a remote one.
  return false;
}

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
