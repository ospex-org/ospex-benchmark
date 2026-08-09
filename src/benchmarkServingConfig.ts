import { envValue } from './config.js';

/**
 * How the benchmark serving publisher reaches its database.
 *
 * Kept apart from `servingStore.ts` on purpose: that module takes an injected
 * `StoreQuery` and imports no `pg`, so it stays a pure library. This one resolves
 * environment into the shape a driver wants, and nothing else. It opens no
 * connection and is not wired into any run path yet — the producer that feeds the
 * projection is a separate decision.
 *
 * ── TLS, WHICH IS NOT THE DEFAULT AND HAS TO BE ASKED FOR ────────────────────
 * Measured against the live project, 2026-08-09, all three from this machine:
 *
 *   no `ssl` option        connects, and `pg_stat_ssl` reports ssl=false. The
 *                          password and every row cross the network in the clear.
 *                          This is what a bare `new Pool({ connectionString })`
 *                          gets you, which is the shape the rest of this repo
 *                          uses for its LOCAL store.
 *   ssl: true              refused — SELF_SIGNED_CERT_IN_CHAIN. The direct
 *                          endpoint presents a chain Node's default trust store
 *                          does not carry, so strict verification cannot succeed
 *                          without being handed the CA.
 *   rejectUnauthorized off connects over TLSv1.3.
 *
 * So the default here is ENCRYPTED BUT NOT AUTHENTICATED: it protects the
 * credential and the payload from a passive observer, and it does not prove the
 * host is the one it claims to be. That is a real limitation and it is the reason
 * BENCHMARK_DB_CA exists — supply the project's CA certificate and verification
 * turns on. The default is chosen because the only alternative that works out of
 * the box is plaintext, which is worse on every axis.
 */

/** What TLS to negotiate. `ca` present means the chain is verified against it. */
export interface TlsOption {
  readonly rejectUnauthorized: boolean;
  readonly ca?: string | undefined;
}

/**
 * Driver-shaped, but deliberately not a `pg` type — `pg` is a devDependency and
 * no module outside conformance and wiring imports it.
 *
 * A DSN is passed through UNPARSED. The generated password contains `%`, and a
 * `%` that does not begin a valid escape makes `new URL(...).password` +
 * `decodeURIComponent` throw `URIError: URI malformed` (measured). Parsing it
 * here to "normalise" it would introduce exactly that failure; the driver's own
 * parser handles the raw form correctly.
 */
export type BenchmarkWriterConnection =
  | { readonly kind: 'dsn'; readonly connectionString: string; readonly ssl?: TlsOption }
  | {
      readonly kind: 'derived';
      readonly host: string;
      readonly port: number;
      readonly user: string;
      readonly database: string;
      readonly password: string;
      readonly ssl: TlsOption;
    };

/** Why no connection could be resolved. None of these is an error: the publisher
 *  is disabled when unconfigured, which is its normal state. */
export type UnresolvedReason =
  | 'no_credential'
  | 'no_project_url'
  | 'malformed_project_url'
  | 'malformed_port'
  | 'malformed_dsn_ssl';

export type ConnectionResolution =
  | { readonly resolved: true; readonly connection: BenchmarkWriterConnection }
  | { readonly resolved: false; readonly reason: UnresolvedReason };

/** The scoped role the projection schema provisions: SELECT and INSERT on the
 *  nine tables, membership in nothing, so it reaches no protocol state. */
export const BENCHMARK_WRITER_ROLE = 'benchmark_writer';

const DEFAULT_PORT = 5432;
const DEFAULT_DATABASE = 'postgres';

function tls(): TlsOption {
  const ca = envValue('BENCHMARK_DB_CA');
  return ca === undefined ? { rejectUnauthorized: false } : { rejectUnauthorized: true, ca };
}

/**
 * Resolve the publisher's connection from the environment, or say why not.
 *
 * Two shapes, in precedence order:
 *
 *   BENCHMARK_DB_URL   a complete DSN, used verbatim. This is the variable the
 *                      projection schema's prerequisite block names, and it is
 *                      the right choice on a host that keeps one.
 *   BENCHMARK_WRITER   the role's password alone, with the host derived from
 *                      SUPABASE_URL — which is already present for the read
 *                      paths, so this needs no second copy of the project
 *                      reference. Host, port, database and user are each
 *                      overridable for a pooler or a scratch database.
 *
 * Returns discrete fields rather than a built URL in the second case. Building
 * one would mean percent-encoding a password that contains `%`, and the encoded
 * result then round-trips through some parsers and not others; discrete fields
 * have no encoding step to get wrong.
 */
export function resolveBenchmarkWriterConnection(): ConnectionResolution {
  const dsn = envValue('BENCHMARK_DB_URL');
  if (dsn !== undefined) {
    // ⚠ A DSN THAT STATES AN sslmode IS AUTHORITATIVE, and nothing is attached
    //   beside it. `pg` parses SSL parameters out of the connection string and
    //   they OVERRIDE a separately supplied `ssl` object — measured on the
    //   pinned driver, by constructing a real client rather than inspecting this
    //   return value:
    //
    //     ?sslmode=disable      + ssl:{rejectUnauthorized:true, ca}  ->  ssl false
    //     ?sslmode=require      + ssl:{rejectUnauthorized:true, ca}  ->  ssl {}
    //     ?sslmode=verify-full  + ssl:{rejectUnauthorized:true, ca}  ->  ssl {}
    //
    //   So returning a CA alongside one of those was a promise the driver threw
    //   away — `sslmode=disable` in particular reported "verified TLS" for a
    //   connection with no TLS at all. Returning nothing says the true thing:
    //   the URL decides, and BENCHMARK_DB_CA does not apply to it.
    const intent = dsnSslIntent(dsn);
    if (intent === 'malformed') return { resolved: false, reason: 'malformed_dsn_ssl' };
    return intent === 'stated'
      ? { resolved: true, connection: { kind: 'dsn', connectionString: dsn } }
      : { resolved: true, connection: { kind: 'dsn', connectionString: dsn, ssl: tls() } };
  }

  const password = envValue('BENCHMARK_WRITER');
  if (password === undefined) return { resolved: false, reason: 'no_credential' };

  const host = envValue('BENCHMARK_DB_HOST') ?? derivedHost();
  if (host === null) return { resolved: false, reason: 'malformed_project_url' };
  if (host === undefined) return { resolved: false, reason: 'no_project_url' };

  const rawPort = envValue('BENCHMARK_DB_PORT');
  let port = DEFAULT_PORT;
  if (rawPort !== undefined) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return { resolved: false, reason: 'malformed_port' };
    }
    port = parsed;
  }

  return {
    resolved: true,
    connection: {
      kind: 'derived',
      host,
      port,
      user: envValue('BENCHMARK_DB_USER') ?? BENCHMARK_WRITER_ROLE,
      database: envValue('BENCHMARK_DB_NAME') ?? DEFAULT_DATABASE,
      password,
      ssl: tls(),
    },
  };
}

/**
 * `https://<ref>.supabase.co` -> `db.<ref>.supabase.co`, the direct endpoint.
 *
 * `undefined` when SUPABASE_URL is absent, `null` when it is present but not a
 * URL this can read — the two are different situations and collapsing them would
 * report a typo as "not configured".
 */
function derivedHost(): string | null | undefined {
  const raw = envValue('SUPABASE_URL');
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // The shape is checked, not merely split. Taking the first label of any
  // hostname turned `https://project-ref.example.com` and even `https://supabase.co`
  // into a plausible-looking Supabase database host that belongs to nobody —
  // a connection attempt, with the credential, against a name the operator
  // never named. A self-hosted or proxied deployment sets BENCHMARK_DB_HOST.
  const match = /^([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
  if (url.protocol !== 'https:' || match === null) return null;
  return `db.${match[1]!.toLowerCase()}.supabase.co`;
}

/** What a DSN says about TLS. */
type DsnSslIntent = 'absent' | 'stated' | 'malformed';

/**
 * What a DSN says about TLS, decided the way the DRIVER decides it, and with
 * three answers rather than two.
 *
 * A substring search got four shapes wrong, each measured against a real client:
 * `?application_name=sslmode=disable`, `/db-sslmode=disable` and
 * `#sslmode=disable` all matched the text while stating nothing, so nothing was
 * attached and the connection went out in PLAINTEXT; `?%73slmode=disable` did
 * not match, so a CA was attached that the driver decoded past and discarded.
 * `URLSearchParams` does the same decoding the driver does — values are not
 * keys, a path is not a query, a fragment is not a query, and `%73` is `s`.
 *
 * ── WHY THERE IS NO LIST OF ACCEPTED VALUES ─────────────────────────────────
 * There was one, twice, and it was wrong both times: it rejected `ssl=no-verify`
 * which the driver genuinely supports, and accepted `ssl=false` which the driver
 * turns into the truthy STRING `"false"`. Enumerating what a value MEANS is a
 * prediction about the driver, and every prediction here has eventually
 * disagreed with it. So this predicts nothing about meaning. It asks only
 * whether the parameter is unambiguous:
 *
 *   absent      -> attach TLS; nothing in the URL can discard it
 *   present, appearing ONCE, non-empty
 *               -> defer entirely. Whatever it means is the driver's business
 *                  and the operator's choice, and attaching beside it would only
 *                  be discarded.
 *   anything else (empty, or repeated)
 *               -> refuse. The publisher stays disabled with a nameable reason
 *                  rather than guessing.
 *
 * DUPLICATES ARE THE REASON FOR THE COUNT. `URLSearchParams.get()` returns the
 * FIRST occurrence and the driver keeps the LAST, so a repeated parameter is
 * where the two can still disagree. Measured, with a CA supplied:
 *
 *   ?sslmode=require&sslmode=   first says require, so nothing was attached;
 *                               the driver's empty last value made it ignore
 *                               sslmode entirely -> PLAINTEXT.
 *   ?sslmode=&sslmode=require   first is empty, so a CA was attached; the
 *                               driver's last value won and discarded it -> {}.
 *   ?ssl=1&ssl=                 first says 1, nothing attached; driver -> "".
 *
 * EMPTY IS REFUSED RATHER THAN IGNORED, even though an empty `sslmode` alone is
 * measurably discarded by the driver and would be safe to attach past. Relying
 * on that is relying on a quirk, and quirk-dependence is what produced this
 * round. One rule, no exceptions, nothing to rot.
 *
 * The bound worth stating: across every shape measured, the driver acts on any
 * non-empty `sslmode` or `ssl` — an unrecognised mode yields `{}`, which is TLS
 * against the system trust store, never a silent downgrade. Only an empty value
 * is ignored, and that is refused.
 *
 * An unparseable DSN reports `absent`, so TLS is attached rather than silently
 * omitted. Being wrong about the report is recoverable; sending the credential
 * in clear is not.
 */
function dsnSslIntent(dsn: string): DsnSslIntent {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return 'absent';
  }
  const values = [...url.searchParams.getAll('sslmode'), ...url.searchParams.getAll('ssl')];
  if (values.length === 0) return 'absent';
  if (url.searchParams.getAll('sslmode').length > 1) return 'malformed';
  if (url.searchParams.getAll('ssl').length > 1) return 'malformed';
  if (values.some((value) => value === '')) return 'malformed';
  return 'stated';
}
