import { resolveBenchmarkWriterConnection } from './benchmarkServingConfig.js';
import { SqlBenchmarkServingPort } from './servingStore.js';
import type { BenchmarkWriterConnection, UnresolvedReason } from './benchmarkServingConfig.js';
import type { BenchmarkServingPort } from './servingStore.js';

/**
 * Opens the benchmark serving publisher, or hands back a disabled one.
 *
 * The two halves it joins are pure on purpose and stay that way:
 * `benchmarkServingConfig.ts` turns environment into a decision and opens no
 * socket, and `servingStore.ts` takes an injected `StoreQuery` and imports no
 * driver. This module is the only place that holds both, so it is the only
 * place that imports `pg` — dynamically, so a dry run, a rehearsal or a unit
 * test never loads the driver at all.
 *
 * ── DISABLED IS A CONFIGURATION, NOT A DEGRADED MODE ─────────────────────────
 * With no credential the resolver returns `{resolved: false}`, this returns a
 * port constructed with `null`, and every publish resolves to `{outcome:
 * 'disabled'}` without touching the network. That is the shipped default and it
 * is why a caller may publish unconditionally: there is no second code path to
 * maintain, no stub to swap in, and turning the projection on is setting an
 * environment variable rather than changing a call site.
 *
 * ── WHY max IS 4 ─────────────────────────────────────────────────────────────
 * The scoped writer login carries `CONNECTION LIMIT 5`. `publishAttempt` and
 * `sealDecision` are serialized — each takes an advisory lock and then writes on
 * one pinned connection — and the runner dispatches its arms concurrently, so a
 * slate fans several of those out at once. Past the role's limit PostgreSQL
 * answers 53300 instead of writing, which this port classifies as `unavailable`
 * and, being fail-soft, drops silently. A pool that cannot exceed the limit
 * makes the queue wait instead.
 */

/** A pool config in the shape `pg` accepts, without importing `pg` for a type. */
interface PoolConfigLike {
  readonly connectionString?: string;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly database?: string;
  readonly password?: string;
  readonly ssl?: { readonly rejectUnauthorized: boolean; readonly ca?: string | undefined };
  readonly max: number;
  readonly connectionTimeoutMillis: number;
}

/** Below the role's `CONNECTION LIMIT 5`, so the pool queues rather than 53300s. */
export const SERVING_POOL_MAX = 4;

const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Whether the projection is being written, and when not, why not.
 *
 * Deliberately carries NO part of the target — not the host, not the DSN, not a
 * derived fragment of either. The connection string holds this role's password,
 * and a diagnostic that interpolates any slice of a credential-bearing string
 * eventually prints the credential: an extractor that means to take the host
 * returns the whole string for a libpq keyword DSN, and returns the password's
 * own tail when the password contains an `@`. A constant cannot. The operator
 * supplied the target and can read it back from their own environment; what
 * they cannot tell without being told is whether it was ACCEPTED, which is
 * exactly what `reason` reports.
 */
export type ServingStatus =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: UnresolvedReason };

export interface BenchmarkServingHandle {
  /** Safe to call unconditionally — disabled when unconfigured. */
  readonly port: BenchmarkServingPort;
  readonly status: ServingStatus;
  /** Idempotent, and never throws: a projection must not fail a run on the way out. */
  close(): Promise<void>;
}

/** One line for an operator, naming no part of the target. */
export function describeServingStatus(status: ServingStatus): string {
  return status.enabled
    ? 'serving projection: enabled'
    : `serving projection: disabled (${status.reason})`;
}

/**
 * The driver config for a resolved connection.
 *
 * The `ssl` key is OMITTED rather than set to `undefined` when there is none to
 * attach. The two are not equivalent to the driver: with no key it consults
 * `PGSSLMODE`, which is the operator's setting to make, and a present-but-
 * undefined key is a different input to that merge. `benchmarkServingConfig`
 * has already decided whether anything may be attached at all — a DSN that
 * states its own SSL policy arrives here carrying none, because the driver
 * would apply the URL's answer over ours in either direction.
 */
export function servingPoolConfig(connection: BenchmarkWriterConnection): PoolConfigLike {
  const shared = { max: SERVING_POOL_MAX, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS };
  if (connection.kind === 'dsn') {
    return {
      connectionString: connection.connectionString,
      ...(connection.ssl === undefined ? {} : { ssl: connection.ssl }),
      ...shared,
    };
  }
  return {
    host: connection.host,
    port: connection.port,
    user: connection.user,
    database: connection.database,
    password: connection.password,
    ssl: connection.ssl,
    ...shared,
  };
}

const DISABLED: Pick<BenchmarkServingHandle, 'close'> = { close: async () => {} };

/**
 * Resolve the environment and open the publisher.
 *
 * Never throws. A pool that cannot be constructed is reported as disabled with
 * the resolver's own vocabulary rather than propagated: this is the projection,
 * and nothing downstream authorizes anything on it.
 */
export async function openBenchmarkServing(): Promise<BenchmarkServingHandle> {
  const resolution = resolveBenchmarkWriterConnection();
  if (!resolution.resolved) {
    return { port: new SqlBenchmarkServingPort(null), status: { enabled: false, reason: resolution.reason }, ...DISABLED };
  }

  const { Pool } = await import('pg');
  const { pgStoreQuery } = await import('./store/atomicStore.js');
  const { pgStoreTransactor } = await import('./store/campaignTickJournal.js');

  const pool = new Pool(servingPoolConfig(resolution.connection));
  const query = pgStoreQuery(pool);
  return {
    port: new SqlBenchmarkServingPort({ query, transactor: pgStoreTransactor(pool) }),
    status: { enabled: true },
    close: async () => {
      try {
        await pool.end();
      } catch {
        // A pool that will not close cleanly is not a reason to fail a run that
        // has already written its artifact. The process is exiting either way.
      }
    },
  };
}
