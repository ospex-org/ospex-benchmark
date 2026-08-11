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
  | { readonly enabled: false; readonly reason: UnresolvedReason | 'schema_not_ready' };

const CLOSE_TIMEOUT_MS = 5_000;

/**
 * The columns the participant contract requires before anything may be written.
 *
 * A participant row records WHICH ARM ran, and an arm is a model plus the
 * configuration it ran under — the same model at two reasoning levels is two
 * competitors, and a row that cannot say which is which cannot be corrected.
 * These rows are insert-once with no UPDATE.
 */
const REQUIRED_PARTICIPANT_COLUMNS = ['model_id', 'configuration', 'configuration_sha256'];

/**
 * Refuse to open against a schema that cannot record what an arm IS.
 *
 * A latch, not a lint, and it blocks deliberately. Until it existed the only
 * thing between the current schema and permanent dimensionless participant rows
 * was that nobody had set the credential — and the README and `.env.example`
 * both explain how to set it. "We are relying on no one turning it on" is not a
 * control; a precondition the code enforces is.
 *
 * It lifts by itself when the migration lands, so nobody has to remember to
 * remove it.
 */
async function missingParticipantColumns(
  query: (sql: string, params: readonly unknown[]) => Promise<ReadonlyArray<Record<string, unknown>>>,
): Promise<string[]> {
  const rows = await query(
    `select column_name from information_schema.columns
      where table_schema = 'public'
        and table_name = 'benchmark_participants'
        and column_name = any($1)`,
    [REQUIRED_PARTICIPANT_COLUMNS],
  );
  const present = new Set(rows.map((row) => String(row['column_name'])));
  return REQUIRED_PARTICIPANT_COLUMNS.filter((column) => !present.has(column));
}

export interface BenchmarkServingHandle {
  /** Safe to call unconditionally — disabled when unconfigured. */
  readonly port: BenchmarkServingPort;
  readonly status: ServingStatus;
  /** Idempotent, and never throws: a projection must not fail a run on the way out. */
  close(): Promise<void>;
}

/** One line for an operator, naming no part of the target. */
export function describeServingStatus(status: ServingStatus): string {
  if (status.enabled) return 'serving projection: enabled';
  if (status.reason === 'schema_not_ready') {
    return (
      'serving projection: HELD — the database cannot yet record which arm a ' +
      `participant is (missing ${REQUIRED_PARTICIPANT_COLUMNS.join(', ')} on ` +
      'benchmark_participants). Participant rows are insert-once, so nothing is ' +
      'written until the schema can hold the whole identity.'
    );
  }
  return `serving projection: disabled (${status.reason})`;
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

  // Before a single row: can this schema hold the participant contract? A
  // failure to ANSWER counts as not ready, because the alternative is writing
  // permanent rows on the strength of a question that did not resolve.
  let missing: string[];
  try {
    missing = await missingParticipantColumns(query);
  } catch {
    missing = REQUIRED_PARTICIPANT_COLUMNS;
  }
  if (missing.length > 0) {
    try {
      await pool.end();
    } catch {
      // Nothing was written; a pool that will not drain is not worth reporting.
    }
    return {
      port: new SqlBenchmarkServingPort(null),
      status: { enabled: false, reason: 'schema_not_ready' },
      close: async () => {},
    };
  }

  return {
    port: new SqlBenchmarkServingPort({ query, transactor: pgStoreTransactor(pool) }),
    status: { enabled: true },
    close: async () => {
      // BOUNDED, for the same reason every write is. A write that timed out was
      // abandoned by the waiter, not cancelled at the server, so its statement
      // may still be running when the pool is asked to drain — and `pool.end()`
      // waits for its clients. An unbounded wait here hands back at the exit
      // the stall that was just prevented at every write.
      //
      // Abandoning the drain is safe in a way abandoning a money write would
      // not be: every projection write is an idempotent insert that either
      // lands or does not, and republishing the artifact reconciles either way.
      try {
        await Promise.race([
          pool.end(),
          new Promise<void>((resolve) => {
            setTimeout(resolve, CLOSE_TIMEOUT_MS).unref?.();
          }),
        ]);
      } catch {
        // A pool that will not close cleanly is not a reason to fail a run that
        // has already written its artifact.
      }
    },
  };
}
