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
  | { readonly kind: 'dsn'; readonly connectionString: string; readonly ssl: TlsOption }
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
  | 'malformed_port';

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
    return { resolved: true, connection: { kind: 'dsn', connectionString: dsn, ssl: tls() } };
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
  let hostname: string;
  try {
    hostname = new URL(raw).hostname;
  } catch {
    return null;
  }
  const ref = hostname.split('.')[0];
  if (ref === undefined || ref.length === 0 || !hostname.includes('.')) return null;
  return `db.${ref}.supabase.co`;
}
