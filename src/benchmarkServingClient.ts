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
 * only place on the SERVING path that imports `pg` — dynamically, so a dry
 * run, a rehearsal or a unit test never loads the driver at all. Other entry
 * points import it for their own pools; what matters here is that neither
 * half of this seam does.
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
  readonly query_timeout: number;
  readonly statement_timeout: number;
}

/** Below the role's `CONNECTION LIMIT 5`, so the pool queues rather than 53300s. */
export const SERVING_POOL_MAX = 4;

const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * The three bounds, and what each one actually buys. Measured, not traced —
 * every claim here is a row in the table in `benchmarkServingClient.test.ts`.
 *
 * `QUERY_TIMEOUT_MS` is the DRIVER's own read timeout. On `pool.query` it is the
 * whole fix by itself: the timer rejects the query, `pool.query`'s error path
 * calls `client.release(err)`, and `pg-pool` destroys a client released with an
 * error. It works against a server that has stopped answering entirely, because
 * it is a client-side timer. On a PINNED client it only rejects — releasing is
 * the caller's job — which is why the transactor had to change too.
 *
 * `STATEMENT_TIMEOUT_MS` is a real startup parameter, so the SERVER aborts the
 * statement. That protects the database rather than this process: a backend
 * that keeps running after the client walked away is holding a connection
 * against a role limited to five of them. It is deliberately BELOW the driver's
 * timeout so the tidy outcome — a 57014 the port classifies as `unavailable` —
 * is the one that normally happens.
 *
 * ⚠ It does NOT make this process exit. A frozen server cannot honour its own
 *   timeout, and that is precisely the outage case. Measured: with only these
 *   two set, a hung pinned client kept Node alive past 22 seconds.
 *
 * Both sit under `PER_WRITE_TIMEOUT_MS` in servingPublisher.ts, so the layer
 * that can actually end a statement gets to act before the layer that can only
 * stop waiting for it.
 */
export const QUERY_TIMEOUT_MS = 9_000;
export const STATEMENT_TIMEOUT_MS = 8_000;

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
  | {
      readonly enabled: false;
      readonly reason: UnresolvedReason | 'schema_not_ready' | 'driver_unavailable';
    };

const CLOSE_TIMEOUT_MS = 5_000;

/**
 * The schema capability this build's writes require.
 *
 * Version 2 is the migration that made a participant an ENTRANT: `model_id`,
 * `configuration`, `configuration_sha256`, the kind-dependent CHECKs that make a
 * model declare all of them and a control none, and the unique index over
 * `(lab_id, model_id, configuration)`.
 *
 * ⚠ IT IS A VERSION, NOT A COLUMN SNIFF, AND THAT IS THE WHOLE POINT. An earlier
 *   latch asked `information_schema` whether three column NAMES existed. Three
 *   nullable lookalike columns satisfy that — demonstrated on a scratch database
 *   with the names and none of the constraints, which the latch opened against —
 *   so it certified a schema that could still hold a permanently dimensionless
 *   entrant. A capability row is a claim the schema makes about itself, and one
 *   a publisher can only read.
 */
export const REQUIRED_SERVING_CAPABILITY = 2;

/**
 * What the database says it can serve, or 0.
 *
 * Absence is version 0 rather than an error: the capability table arrived WITH
 * the contract, so a database that has no row has not adopted it. Every
 * unreadable answer — a missing relation, a revoked grant, a query that never
 * comes back — resolves the same way, because the alternative is writing
 * permanent rows on the strength of a question that did not resolve.
 */
async function servingCapability(
  query: (sql: string, params: readonly unknown[]) => Promise<ReadonlyArray<Record<string, unknown>>>,
): Promise<number> {
  const rows = await query(
    'select version from public.benchmark_schema_capability where capability = $1',
    ['serving_projection'],
  );
  const version = rows[0]?.['version'];
  return typeof version === 'number' && Number.isInteger(version) ? version : 0;
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
  if (status.reason === 'driver_unavailable') {
    return (
      'serving projection: disabled (the PostgreSQL driver is not installed in ' +
      'this environment)'
    );
  }
  if (status.reason === 'schema_not_ready') {
    return (
      'serving projection: HELD — the database does not report serving_projection ' +
      `capability ${REQUIRED_SERVING_CAPABILITY} or higher, so it cannot be relied ` +
      'on to record which entrant a participant is. Those rows are insert-once, ' +
      'so nothing is written until the schema says it can hold the whole identity.'
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
  const shared = {
    max: SERVING_POOL_MAX,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  };
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

/** The three runtime pieces this module needs, loaded together so one failure
 *  is one branch. */
async function loadDriver() {
  const [{ Pool }, { pgStoreQuery }, { pgStoreTransactor }] = await Promise.all([
    import('pg'),
    import('./store/atomicStore.js'),
    import('./store/campaignTickJournal.js'),
  ]);
  return { Pool, pgStoreQuery, pgStoreTransactor };
}

type ServingTransactorFactory = Awaited<ReturnType<typeof loadDriver>>['pgStoreTransactor'];

/**
 * Resolve the environment and open the publisher.
 *
 * Never throws, and that is load-bearing rather than tidy: a run calls this on
 * its way in, and the projection may not be able to end a benchmark night.
 * Everything that can fail is reported as a disabled status instead.
 *
 * ⚠ INCLUDING THE DRIVER IMPORT. `pg` is a devDependency, so a production
 *   install has no driver at all and `await import('pg')` REJECTS — which,
 *   unguarded, propagated straight out of a function documented never to
 *   throw. That is the shape a caller cannot defend against, because the whole
 *   reason it calls this unconditionally is that it is safe to.
 */
export async function openBenchmarkServing(
  bounds: ServingBounds = {},
): Promise<BenchmarkServingHandle> {
  const readinessTimeoutMs = bounds.readinessTimeoutMs ?? READINESS_TIMEOUT_MS;
  const closeTimeoutMs = bounds.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  const resolution = resolveBenchmarkWriterConnection();
  if (!resolution.resolved) {
    return { port: new SqlBenchmarkServingPort(null), status: { enabled: false, reason: resolution.reason }, ...DISABLED };
  }

  let pool: InstanceType<Awaited<ReturnType<typeof loadDriver>>['Pool']>;
  let query: ReturnType<Awaited<ReturnType<typeof loadDriver>>['pgStoreQuery']>;
  let transactor: ServingTransactorFactory;
  try {
    const driver = await loadDriver();
    pool = new driver.Pool(servingPoolConfig(resolution.connection));
    query = driver.pgStoreQuery(pool);
    transactor = driver.pgStoreTransactor;
  } catch {
    return {
      port: new SqlBenchmarkServingPort(null),
      status: { enabled: false, reason: 'driver_unavailable' },
      ...DISABLED,
    };
  }

  // Every client currently checked out — which is exactly the set `pool.end()`
  // will not drain, and therefore the set `closePool` has to destroy. Tracked
  // from the pool's own events rather than by wrapping `connect`, so a client
  // taken by any executor is covered.
  const live = new Set<EndableClient>();
  pool.on('acquire', (client: unknown) => { live.add(client as EndableClient); });
  pool.on('release', (_error: unknown, client: unknown) => { live.delete(client as EndableClient); });
  pool.on('remove', (client: unknown) => { live.delete(client as EndableClient); });
  const poolLike = pool as unknown as PoolLike;

  // Before a single row: does this schema say it can hold the entrant contract?
  //
  // BOUNDED, because this runs before anything else and an unbounded readiness
  // probe is a startup that never finishes. A probe that does not answer in
  // time is treated as not ready — the same fail-closed reading as one that
  // errors, and for the same reason: these rows cannot be corrected later.
  let capability: number;
  try {
    capability = await withDeadline(servingCapability(query), readinessTimeoutMs);
  } catch {
    capability = 0;
  }
  if (capability < REQUIRED_SERVING_CAPABILITY) {
    // Closed the same way as a live handle would be. Nothing was written, but a
    // startup that leaves a socket open still cannot exit.
    await closePool(poolLike, live, closeTimeoutMs);
    return {
      port: new SqlBenchmarkServingPort(null),
      status: { enabled: false, reason: 'schema_not_ready' },
      close: async () => {},
    };
  }

  return {
    port: new SqlBenchmarkServingPort({ query, transactor: transactor(pool) }),
    status: { enabled: true },
    close: () => closePool(poolLike, live, closeTimeoutMs),
  };
}

/**
 * How long the readiness probe may take.
 *
 * Below the driver's own `query_timeout` so this is the bound that decides, and
 * short because it runs once, before any work, on a path a run is waiting on.
 */
export const READINESS_TIMEOUT_MS = 5_000;

/**
 * The two bounds a caller may shorten.
 *
 * Injectable for one reason only: the guarantee this module exists to make is
 * "the process can still exit", and a child process proving that has to run in
 * about a second rather than about ten. The DEFAULTS are pinned separately, as
 * values, so shortening them in a test cannot quietly become shipping them.
 */
export interface ServingBounds {
  readonly readinessTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

/**
 * Resolve, or reject at the deadline. The work is not cancelled — the caller
 * stops waiting on it, and `closePool` is what ends the connection under it.
 *
 * The timer is REF'D, unlike the two in `closePool`, and the difference is the
 * rule: unref a timer you never clear, ref one you do. This one is cleared in
 * the `finally`, so it cannot hold the process open; unref'ing it would instead
 * let Node drain the loop and exit while this await was the only pending work,
 * leaving the caller's promise unsettled. `closePool`'s timers lose their race
 * and are never cleared, so they must not be ref'd.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('readiness probe did not answer')), ms);
    }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/**
 * Close the pool, and make the PROCESS bounded rather than only the caller.
 *
 * ── WHY THE OBVIOUS VERSION DOES NOT WORK ────────────────────────────────────
 * Racing `pool.end()` against a timer changes when this function returns. It
 * changes nothing about the connection: `pool.end()` only drains clients that
 * are IDLE, and a client checked out with a statement in flight is not idle, so
 * it is never touched and its socket stays open and referenced. Node then will
 * not exit, whatever exit code was set.
 *
 * Measured against PostgreSQL 17 on this machine, one hung write, `pool.query`
 * and a pinned client, each against a responsive server and a frozen one:
 *
 *   remedies                     | pool.query      | pinned client
 *   -----------------------------|-----------------|-----------------
 *   the bounded race alone       | never exited    | never exited
 *   + the two timeouts           | 8.1s / 9.2s     | never exited
 *   + release(err) only          | —               | 1.2s / 1.2s
 *   + destroying handles only    | 6.1s / 6.1s     | 6.2s / 6.2s
 *   all of them                  | 6.2s / 6.2s     | 1.2s / 1.2s
 *
 * So the destroy below is what turns "close returned" into "the process can
 * exit", and it covers the paths the driver's own timeouts do not — a frozen
 * server cannot enforce its own.
 *
 * One path it does NOT cover, stated rather than left implied: a client still
 * inside `connect()` has not emitted `acquire`, so it is not in `live` and the
 * loop below walks past it. What bounds that one is the pool's own connect
 * timer at `connectionTimeoutMillis`, which is 10s — twice this close bound.
 *
 * ── WHY DESTROYING IS SAFE HERE, AND WOULD NOT BE ON A MONEY PATH ────────────
 * Every projection write is an idempotent insert that either landed or did not,
 * and republishing the artifact reconciles both. Nothing downstream authorizes
 * anything on the result. A write abandoned here is a row `yarn project` will
 * write later, not a decision anyone acted on.
 *
 * `client.end()` rather than reaching for the socket: `end()` sets the client's
 * own ending flag first, which suppresses the error event it would otherwise
 * emit — and the pool has already removed its idle-error listener from a
 * checked-out client, so that event would be an uncaught exception at exit.
 */
async function closePool(
  pool: PoolLike,
  live: ReadonlySet<EndableClient>,
  closeTimeoutMs: number,
): Promise<void> {
  const drained = await Promise.race([
    pool.end().then(() => true, () => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), closeTimeoutMs).unref?.();
    }),
  ]);
  if (drained) return;

  for (const client of live) {
    try {
      client.end();
    } catch {
      // Already ending, or already gone. Either way this handle is not what is
      // holding the loop open.
    }
  }
  // One turn of the loop, so the destroyed sockets' close events are handled
  // before this returns. NOT a second drain: `end()` on an already-ending pool
  // hands back a promise that is already rejected, so awaiting it would settle
  // on the next microtask and measure nothing.
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

/** The two members of `pg`'s Pool this module uses, so `pg` stays dynamic. */
interface PoolLike {
  end(): Promise<void>;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

/** A checked-out client, narrowed to the one method that ends it. `@types/pg`
 *  does not declare `end()` on `PoolClient`, so the cast is named and local. */
interface EndableClient {
  end(): void;
}
