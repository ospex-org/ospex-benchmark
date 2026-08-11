import type { StoreQuery } from './atomicStore.js';
import type { CampaignTickJournalPort, CampaignTickOutcome, ScheduleEntry, ScheduleWindow } from '../campaignSchedule.js';
import { OPERATOR_RESUMED } from '../campaignSchedule.js';

/**
 * The SQL adapter for the campaign tick journal — INSERT/UPDATE/SELECT on
 * `store.campaign_ticks`, no touch of the money-critical store contract (the same posture
 * as the authorization and status-read adapters).
 *
 * `finish` is FIRST-WINS by construction: the UPDATE carries `finished_at is null`, so a
 * second finish — including a best-effort loud-failure finish that lost a race — affects
 * zero rows and changes nothing.
 *
 * `scheduleWindow` is the AUTHORITATIVE halt-rule input, assembled in ONE statement (one
 * snapshot): the durable latest-resume boundary row, EVERY unfinished tick after it, and
 * EVERY finished tick after it whose outcome is outside the healthy set — filtered reads
 * with deliberately NO row limit, because the filter is the halt question itself and a
 * newest-N sample of the raw journal cannot authoritatively decide that no unreviewed
 * halt cause exists. `entries` remains a bounded newest-first read for DISPLAY only.
 *
 * `begin` and `resume` participate in one serialization contract: both take the same
 * per-cohort advisory transaction lock, and `resume` is a CONDITIONAL append that commits
 * only while the journal frontier (max id) still equals the exact frontier the operator's
 * review read — any tick that begins in between moves the frontier and the resume refuses
 * (`frontier_moved`) instead of silently bounding the new entry out of the halt window.
 * The resume runs as a REAL transaction on one checked-out connection, taking the lock as
 * its own command and only then running the CAS as a second command: under READ COMMITTED
 * each command snapshots at its own start, so the CAS sees every row committed by the
 * begin that held the lock. A single statement with the lock inline cannot give that —
 * its snapshot is taken before it blocks on the lock, so a raced begin's committed row
 * could stay invisible to the frontier compare it finishes evaluating afterwards.
 *
 * Wire care: `id` arrives from `pg` as a bigint STRING (plain reads) or a JSON number
 * (the window read); timestamps arrive as `Date` (plain reads) or as `store._iso` text
 * (the window read). Every value converts through a checked path that refuses surprises
 * loudly, and the read side keeps `outcome` a plain string so an entry written by a newer
 * build reaches the halt rule (which fails closed on outcomes it does not recognize)
 * instead of breaking the read.
 */
/**
 * One checked-out connection, usable for several commands in one transaction.
 *
 * `release` takes an optional error, and passing one is not cosmetic: `pg-pool`
 * DESTROYS a client released with a truthy first argument and returns one
 * released without it to the idle set. A client whose transaction failed —
 * especially one whose statement never came back — must be destroyed, or the
 * next caller checks out a connection with a query still in flight.
 */
export interface PgTransactionClient {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(destroyBecause?: unknown): void;
}

/** The minimal pool shape the transactor needs — structural, so `pg` stays a
 *  runtime-wiring dependency here exactly as it is for `pgStoreQuery`. */
export interface PgPoolLike {
  connect(): Promise<PgTransactionClient>;
}

/** Run several commands on ONE checked-out connection inside BEGIN … COMMIT, rolling back
 *  on every error. A `Pool.query` sequence cannot stand in for this: successive calls may
 *  run on different connections, and an advisory xact lock taken on one of them guards
 *  nothing on the next. */
export interface StoreTransactor {
  transaction<T>(fn: (query: StoreQuery) => Promise<T>): Promise<T>;
}

/**
 * How long a rollback on a failing connection may take before it is abandoned.
 *
 * An unbounded rollback is not a safety measure, it is a second place to hang:
 * if the transaction failed because a statement never answered, `rollback` is
 * queued BEHIND that statement and waits just as long — so the `finally` that
 * hands the connection back is never reached, and the process cannot exit.
 * Measured: a pinned client with one hung statement kept Node alive
 * indefinitely, and only destroying it ended the process.
 *
 * Abandoning the rollback is safe because of what happens next: the client is
 * released WITH the error, which destroys the connection, and the server rolls
 * back an aborted transaction on its own when the backend goes away.
 */
export const TRANSACTOR_ROLLBACK_TIMEOUT_MS = 2_000;

export interface TransactorOptions {
  /** Injectable so the bound is a property the suite can exercise, not a comment. */
  readonly rollbackTimeoutMs?: number;
}

export function pgStoreTransactor(pool: PgPoolLike, options: TransactorOptions = {}): StoreTransactor {
  const rollbackTimeoutMs = options.rollbackTimeoutMs ?? TRANSACTOR_ROLLBACK_TIMEOUT_MS;
  return {
    async transaction<T>(fn: (query: StoreQuery) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let failure: unknown;
      try {
        await client.query('begin isolation level read committed', []);
        const result = await fn(async (sql, params) => (await client.query(sql, params)).rows);
        await client.query('commit', []);
        return result;
      } catch (error) {
        // TRUTHY, not merely non-nullish. `pg-pool` decides whether to destroy
        // the client on the truthiness of this value, so `throw 0` or `throw ''`
        // would satisfy a `??` and still return a poisoned client to the idle
        // set. Nothing in this repo throws a falsy value today; the guard costs
        // a line and removes the class.
        failure = error === undefined || error === null || error === false
          || error === 0 || error === ''
          ? new Error(`the transaction failed with a falsy value: ${String(error)}`)
          : error;
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          // NOT unref'd, deliberately. The rule is: unref a timer you never
          // clear, ref one you do. This one is cleared in the `finally` below,
          // so it cannot outlive the call — and unref'ing it meant that when
          // this rollback was the only pending work, Node drained the loop and
          // exited before the deadline fired, so the release never ran and the
          // caller's promise never settled. Measured as a test the runner
          // reported as "cancelled: promise resolution is still pending but the
          // event loop has already resolved".
          await Promise.race([
            client.query('rollback', []),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('rollback did not answer')), rollbackTimeoutMs);
            }),
          ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
        } catch {
          // The primary error stands. Whether the rollback landed changes
          // nothing about what happens to this connection: it is destroyed
          // either way, by the release below.
        }
        throw error;
      } finally {
        // WITH THE ERROR, ALWAYS, WHEN THE TRANSACTION FAILED. `pg-pool` reads a
        // truthy first argument as "destroy this client"; a bare `release()`
        // puts it back in the idle set, and a client whose statement is still
        // in flight is poisoned — the next checkout queues behind a query that
        // may never return. Destroying it costs one reconnect on a path that
        // has already failed, which is the cheaper of the two mistakes.
        client.release(failure);
      }
    },
  };
}

export class SqlCampaignTickJournalPort implements CampaignTickJournalPort {
  constructor(
    private readonly query: StoreQuery,
    private readonly transactor: StoreTransactor,
  ) {}

  async begin(cohortId: string, startedAtIso: string): Promise<number> {
    // The per-cohort advisory xact lock (released at this autocommit statement's end)
    // serializes begin against the resume CAS: a begin is either committed and visible to
    // the frontier compare, or it starts strictly after the resume committed and lands
    // above the boundary — never invisibly below it.
    const rows = await this.query(
      `insert into store.campaign_ticks (cohort_id, kind, started_at)
       select $1, 'tick', $2::timestamptz
         from (select pg_advisory_xact_lock(hashtext($1))) as serialize
       returning id`,
      [cohortId, startedAtIso],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('tick journal begin returned no row — an INSERT ... RETURNING always yields one');
    return asEntryId(row['id']);
  }

  async finish(entryId: number, outcome: CampaignTickOutcome, detail: string | null, finishedAtIso: string): Promise<void> {
    // First finish wins: an already-finished entry is left exactly as it was.
    await this.query(
      `update store.campaign_ticks
          set finished_at = $2, outcome = $3, detail = $4
        where id = $1 and finished_at is null`,
      [entryId, finishedAtIso, outcome, detail],
    );
  }

  async resume(
    cohortId: string,
    atIso: string,
    detail: string | null,
    expectedFrontierId: number,
  ): Promise<'resumed' | 'frontier_moved'> {
    if (!Number.isSafeInteger(expectedFrontierId) || expectedFrontierId < 0) {
      throw new Error(`resume requires the reviewed journal frontier id, got ${String(expectedFrontierId)}`);
    }
    // A REAL transaction on one checked-out connection. The per-cohort advisory lock is
    // its OWN command: when it returns, any `begin` that held the lock has committed (or
    // rolled back). Only THEN does the frontier CAS run, as a second command — under READ
    // COMMITTED its snapshot is taken at ITS start, after the lock, so a raced begin's
    // row is visible to the max(id) compare. Zero rows = the journal advanced (a tick
    // began, or another resume landed) — nothing is written, the operator reviews again.
    return await this.transactor.transaction(async (query) => {
      await query('select pg_advisory_xact_lock(hashtext($1))', [cohortId]);
      const rows = await query(
        `insert into store.campaign_ticks (cohort_id, kind, started_at, finished_at, outcome, detail)
       select $1, 'resume', $2::timestamptz, $2::timestamptz, $3, $4
        where (select coalesce(max(id), 0) from store.campaign_ticks where cohort_id = $1) = $5
       returning id`,
        [cohortId, atIso, OPERATOR_RESUMED, detail, expectedFrontierId],
      );
      return rows.length > 0 ? 'resumed' : 'frontier_moved';
    });
  }

  async scheduleWindow(cohortId: string, healthyOutcomes: readonly string[]): Promise<ScheduleWindow> {
    // ONE statement, one snapshot: the boundary, the frontier, and the two COMPLETE
    // filtered reads. Deliberately no row limit on either halt-relevant read — the
    // filters ARE the halt question, so an empty result is an authoritative "none
    // exists" and a non-empty result halts regardless of size.
    const rows = await this.query(
      `with boundary as (
         select coalesce(max(id), 0) as resume_id
           from store.campaign_ticks
          where cohort_id = $1 and kind = 'resume'
       )
       select
         (select coalesce(max(id), 0) from store.campaign_ticks where cohort_id = $1) as frontier_id,
         (select json_build_object(
                   'id', r.id, 'kind', r.kind, 'startedAt', store._iso(r.started_at),
                   'finishedAt', case when r.finished_at is null then null else store._iso(r.finished_at) end,
                   'outcome', r.outcome, 'detail', r.detail)
            from store.campaign_ticks r
           where r.cohort_id = $1 and r.kind = 'resume' and r.id = (select resume_id from boundary)) as resume_row,
         (select coalesce(json_agg(json_build_object(
                   'id', u.id, 'kind', u.kind, 'startedAt', store._iso(u.started_at),
                   'finishedAt', null, 'outcome', u.outcome, 'detail', u.detail) order by u.id desc), '[]'::json)
            from store.campaign_ticks u
           where u.cohort_id = $1 and u.kind = 'tick' and u.finished_at is null
             and u.id > (select resume_id from boundary)) as unfinished_rows,
         (select coalesce(json_agg(json_build_object(
                   'id', f.id, 'kind', f.kind, 'startedAt', store._iso(f.started_at),
                   'finishedAt', store._iso(f.finished_at), 'outcome', f.outcome, 'detail', f.detail) order by f.id desc), '[]'::json)
            from store.campaign_ticks f
           where f.cohort_id = $1 and f.kind = 'tick' and f.finished_at is not null
             and f.id > (select resume_id from boundary)
             and (f.outcome is null or not (f.outcome = any($2)))) as unhealthy_rows`,
      [cohortId, [...healthyOutcomes]],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('tick journal window read returned no row — the aggregate select always yields one');
    const entries: ScheduleEntry[] = [];
    if (row['resume_row'] !== null && row['resume_row'] !== undefined) entries.push(asJsonEntry(row['resume_row']));
    for (const value of asJsonArray('unfinished_rows', row['unfinished_rows'])) entries.push(asJsonEntry(value));
    for (const value of asJsonArray('unhealthy_rows', row['unhealthy_rows'])) entries.push(asJsonEntry(value));
    return { frontierId: asFrontierId(row['frontier_id']), entries };
  }

  async entries(cohortId: string, limit: number): Promise<readonly ScheduleEntry[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error(`tick journal read requires a positive entry limit, got ${String(limit)}`);
    }
    const rows = await this.query(
      `select id, kind, started_at, finished_at, outcome, detail
         from store.campaign_ticks
        where cohort_id = $1
        order by id desc
        limit $2`,
      [cohortId, limit],
    );
    return rows.map(asScheduleEntry);
  }

}

function asScheduleEntry(row: Record<string, unknown>): ScheduleEntry {
  const kind = row['kind'];
  if (kind !== 'tick' && kind !== 'resume') {
    throw new Error(`tick journal read: kind is neither tick nor resume: ${String(kind)}`);
  }
  return {
    id: asEntryId(row['id']),
    kind,
    startedAt: asInstant('started_at', row['started_at']),
    finishedAt: row['finished_at'] === null || row['finished_at'] === undefined ? null : asInstant('finished_at', row['finished_at']),
    outcome: asTextOrNull('outcome', row['outcome']),
    detail: asTextOrNull('detail', row['detail']),
  };
}

function asFrontierId(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`tick journal frontier id is not a non-negative safe integer: ${String(value)}`);
  }
  return n;
}

function asJsonArray(label: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`tick journal ${label} is not a JSON array`);
  return value;
}

/** Checked conversion of one window-read JSON entry (ids as JSON numbers, instants as
 *  `store._iso` text) into the ONE `ScheduleEntry` wire shape. */
function asJsonEntry(value: unknown): ScheduleEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('tick journal window entry is not a JSON object');
  }
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (kind !== 'tick' && kind !== 'resume') {
    throw new Error(`tick journal window entry kind is neither tick nor resume: ${String(kind)}`);
  }
  const startedAt = record['startedAt'];
  if (typeof startedAt !== 'string' || startedAt.length === 0) {
    throw new Error('tick journal window entry startedAt is not a non-empty string');
  }
  const finishedAt = record['finishedAt'] ?? null;
  if (finishedAt !== null && typeof finishedAt !== 'string') {
    throw new Error('tick journal window entry finishedAt is neither text nor null');
  }
  const outcome = record['outcome'] ?? null;
  if (outcome !== null && typeof outcome !== 'string') {
    throw new Error('tick journal window entry outcome is neither text nor null');
  }
  const detail = record['detail'] ?? null;
  if (detail !== null && typeof detail !== 'string') {
    throw new Error('tick journal window entry detail is neither text nor null');
  }
  return { id: asEntryId(record['id']), kind, startedAt, finishedAt, outcome, detail };
}

function asEntryId(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`tick journal id is not a positive safe integer: ${String(value)}`);
  }
  return n;
}

function asInstant(label: string, value: unknown): string {
  if (!(value instanceof Date)) {
    throw new Error(`tick journal ${label} is not a timestamp: ${String(value)}`);
  }
  return value.toISOString();
}

function asTextOrNull(label: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`tick journal ${label} is neither text nor null: ${String(value)}`);
  return value;
}
