import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqlCampaignTickJournalPort, pgStoreTransactor } from './campaignTickJournal.js';
import type { PgTransactionClient, StoreTransactor } from './campaignTickJournal.js';
import type { StoreQuery } from './atomicStore.js';

/**
 * The tick-journal adapter over a scripted `StoreQuery`: the load-bearing SQL is pinned
 * (append-only inserts; the FIRST-WINS finish predicate; newest-first bounded reads), and
 * the wire mapping is exact — bigint ids arrive as strings, timestamps as Dates, and
 * every surprise is loud. The two-phase behaviour against real Postgres is proven by
 * `yarn store:campaign-auth` conformance.
 */

const COHORT = 'c'.repeat(64);

function scripted(rows: ReadonlyArray<Record<string, unknown>>): {
  port: SqlCampaignTickJournalPort;
  calls: Array<{ sql: string; params: readonly unknown[] }>;
  boundaries: string[];
} {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const boundaries: string[] = [];
  const query: StoreQuery = async (sql, params) => {
    calls.push({ sql, params });
    return rows;
  };
  const transactor: StoreTransactor = {
    async transaction<T>(fn: (q: StoreQuery) => Promise<T>): Promise<T> {
      boundaries.push('begin');
      try {
        const result = await fn(query);
        boundaries.push('commit');
        return result;
      } catch (error) {
        boundaries.push('rollback');
        throw error;
      }
    },
  };
  return { port: new SqlCampaignTickJournalPort(query, transactor), calls, boundaries };
}

test('begin: one INSERT of an unfinished tick entry, returning the id — bigint-string converted, surprises loud', async () => {
  const { port, calls } = scripted([{ id: '71' }]);
  assert.equal(await port.begin(COHORT, '2026-08-05T12:00:00.000Z'), 71);
  assert.equal(calls.length, 1);
  const { sql, params } = calls[0]!;
  assert.match(sql, /insert into store\.campaign_ticks/);
  assert.match(sql, /'tick'/);
  assert.match(sql, /returning id/);
  assert.deepEqual(params, [COHORT, '2026-08-05T12:00:00.000Z']);
  assert.doesNotMatch(sql, /finished_at|outcome/, 'a begun entry is UNFINISHED — no outcome is written at begin');

  await assert.rejects(scripted([]).port.begin(COHORT, '2026-08-05T12:00:00.000Z'), /returned no row/);
  for (const id of ['0', '-3', '1.5', 'x', null]) {
    await assert.rejects(scripted([{ id }]).port.begin(COHORT, '2026-08-05T12:00:00.000Z'), /not a positive safe integer/);
  }
});

test('finish: one UPDATE guarded by `finished_at is null` — the FIRST finish wins, a later one changes nothing', async () => {
  const { port, calls } = scripted([]);
  await port.finish(71, 'dispatched', null, '2026-08-05T12:00:05.000Z');
  assert.equal(calls.length, 1);
  const { sql, params } = calls[0]!;
  assert.match(sql, /update store\.campaign_ticks/);
  assert.match(sql, /finished_at is null/);
  assert.deepEqual(params, [71, '2026-08-05T12:00:05.000Z', 'dispatched', null]);
});

test('resume: ONE real transaction — the lock as its OWN command, THEN the frontier CAS — mapping 1 row to resumed, 0 to frontier_moved', async () => {
  const accepted = scripted([{ id: '9' }]);
  assert.equal(await accepted.port.resume(COHORT, '2026-08-05T13:00:00.000Z', 'reviewed the loud failure', 8), 'resumed');
  assert.deepEqual(accepted.boundaries, ['begin', 'commit'], 'both commands run inside one transaction');
  assert.equal(accepted.calls.length, 2, 'the lock and the CAS are SEPARATE commands');
  // (1) The per-cohort lock first, alone: when it returns, a raced begin has committed.
  assert.match(accepted.calls[0]!.sql, /^select pg_advisory_xact_lock\(hashtext\(\$1\)\)$/);
  assert.deepEqual(accepted.calls[0]!.params, [COHORT]);
  // (2) The frontier CAS second: its OWN snapshot, taken after the lock, sees that commit.
  //     A single statement with the lock inline snapshots before blocking — the exact
  //     shape the concurrent conformance regression proves buries a raced tick.
  const { sql, params } = accepted.calls[1]!;
  assert.match(sql, /insert into store\.campaign_ticks/);
  assert.match(sql, /'resume'/);
  assert.match(sql, /where \(select coalesce\(max\(id\), 0\) from store\.campaign_ticks where cohort_id = \$1\) = \$5/);
  assert.match(sql, /returning id/);
  assert.doesNotMatch(sql, /pg_advisory_xact_lock/, 'the CAS command must NOT re-take the lock inline');
  assert.deepEqual(params, [COHORT, '2026-08-05T13:00:00.000Z', 'operator_resumed', 'reviewed the loud failure', 8]);

  assert.equal(await scripted([]).port.resume(COHORT, '2026-08-05T13:00:00.000Z', null, 8), 'frontier_moved');
  const invalid = scripted([]);
  await assert.rejects(invalid.port.resume(COHORT, '2026-08-05T13:00:00.000Z', null, -1), /reviewed journal frontier/);
  await assert.rejects(invalid.port.resume(COHORT, '2026-08-05T13:00:00.000Z', null, 1.5), /reviewed journal frontier/);
  assert.deepEqual(invalid.boundaries, [], 'an invalid frontier is refused before any transaction opens');
});

test('pgStoreTransactor: BEGIN → commands on ONE checked-out client → COMMIT; ROLLBACK + rethrow on error; always released', async () => {
  const log: string[] = [];
  const clientOf = (failOn?: string): PgTransactionClient => ({
    async query(sql: string) {
      log.push(sql);
      if (failOn !== undefined && sql === failOn) throw new Error(`boom on ${sql}`);
      return { rows: [{ ok: 1 }] };
    },
    release() {
      log.push('release');
    },
  });

  const happy = pgStoreTransactor({ connect: async () => (log.push('connect'), clientOf()) });
  const result = await happy.transaction(async (query) => (await query('select 1', []))[0]);
  assert.deepEqual(result, { ok: 1 }, "the caller's queries run through the client");
  assert.deepEqual(log, ['connect', 'begin isolation level read committed', 'select 1', 'commit', 'release']);

  log.length = 0;
  const failing = pgStoreTransactor({ connect: async () => (log.push('connect'), clientOf('select 1')) });
  await assert.rejects(failing.transaction(async (query) => query('select 1', [])), /boom on select 1/);
  assert.deepEqual(log, ['connect', 'begin isolation level read committed', 'select 1', 'rollback', 'release']);

  log.length = 0;
  const doubleFault = pgStoreTransactor({ connect: async () => (log.push('connect'), clientOf('rollback')) });
  await assert.rejects(
    doubleFault.transaction(async () => {
      throw new Error('primary fault');
    }),
    /primary fault/,
    'a failing rollback never masks the primary error',
  );
  assert.deepEqual(log, ['connect', 'begin isolation level read committed', 'rollback', 'release']);
});

test('begin takes the same per-cohort advisory lock the resume CAS serializes on', async () => {
  const { port, calls } = scripted([{ id: '71' }]);
  await port.begin(COHORT, '2026-08-05T12:00:00.000Z');
  assert.match(calls[0]!.sql, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
});

test('entries: newest first, bounded, exact wire mapping — Date→ISO, null finish, plain-string outcome', async () => {
  const { port, calls } = scripted([
    {
      id: '9',
      kind: 'tick',
      started_at: new Date('2026-08-05T12:00:00.000Z'),
      finished_at: null,
      outcome: null,
      detail: null,
    },
    {
      id: '8',
      kind: 'resume',
      started_at: new Date('2026-08-05T11:00:00.000Z'),
      finished_at: new Date('2026-08-05T11:00:00.000Z'),
      outcome: 'operator_resumed',
      detail: 'reviewed',
    },
  ]);
  assert.deepEqual(await port.entries(COHORT, 50), [
    { id: 9, kind: 'tick', startedAt: '2026-08-05T12:00:00.000Z', finishedAt: null, outcome: null, detail: null },
    {
      id: 8,
      kind: 'resume',
      startedAt: '2026-08-05T11:00:00.000Z',
      finishedAt: '2026-08-05T11:00:00.000Z',
      outcome: 'operator_resumed',
      detail: 'reviewed',
    },
  ]);
  const { sql, params } = calls[0]!;
  assert.match(sql, /order by id desc/);
  assert.match(sql, /limit \$2/);
  assert.deepEqual(params, [COHORT, 50]);
});

test('entries: a non-positive or fractional limit is refused BEFORE any query; wire surprises are loud', async () => {
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    const { port, calls } = scripted([]);
    await assert.rejects(port.entries(COHORT, limit), /positive entry limit/);
    assert.equal(calls.length, 0);
  }
  const base = { id: '1', started_at: new Date(), finished_at: null, outcome: null, detail: null };
  await assert.rejects(scripted([{ ...base, kind: 'other' }]).port.entries(COHORT, 5), /neither tick nor resume/);
  await assert.rejects(scripted([{ ...base, kind: 'tick', started_at: '2026-08-05' }]).port.entries(COHORT, 5), /not a timestamp/);
  await assert.rejects(scripted([{ ...base, kind: 'tick', outcome: 42 }]).port.entries(COHORT, 5), /neither text nor null/);
});

test('scheduleWindow: ONE statement, boundary-anchored, filtered and UNBOUNDED — the reads that decide clear carry no row limit', async () => {
  const windowRow = {
    frontier_id: '12',
    resume_row: { id: 7, kind: 'resume', startedAt: '2026-08-05T10:00:00.000Z', finishedAt: '2026-08-05T10:00:00.000Z', outcome: 'operator_resumed', detail: 'reviewed' },
    unfinished_rows: [
      { id: 12, kind: 'tick', startedAt: '2026-08-05T12:00:00.000Z', finishedAt: null, outcome: null, detail: null },
    ],
    unhealthy_rows: [
      { id: 9, kind: 'tick', startedAt: '2026-08-05T11:00:00.000Z', finishedAt: '2026-08-05T11:00:05.000Z', outcome: 'loud_failure', detail: 'boom' },
    ],
  };
  const { port, calls } = scripted([windowRow]);
  const window = await port.scheduleWindow(COHORT, ['dispatched']);
  assert.equal(window.frontierId, 12);
  assert.deepEqual(
    window.entries.map((e) => [e.id, e.kind, e.outcome]),
    [[7, 'resume', 'operator_resumed'], [12, 'tick', null], [9, 'tick', 'loud_failure']],
    'the boundary row, every unfinished tick after it, every non-healthy finished tick after it',
  );
  assert.equal(calls.length, 1, 'one statement — one snapshot');
  const { sql, params } = calls[0]!;
  assert.match(sql, /with boundary as/);
  assert.match(sql, /kind = 'resume'/);
  // BOTH halt-relevant reads are anchored strictly after the durable latest-resume boundary...
  assert.equal((sql.match(/id > \(select resume_id from boundary\)/g) ?? []).length, 2);
  // ...and carry NO row limit: a newest-N sample cannot authoritatively decide clear.
  assert.doesNotMatch(sql, /limit/i);
  // The unhealthy filter fails closed on a null outcome and excludes only the healthy set.
  assert.match(sql, /outcome is null or not \(f\.outcome = any\(\$2\)\)/);
  assert.match(sql, /finished_at is null/);
  assert.match(sql, /finished_at is not null/);
  assert.deepEqual(params, [COHORT, ['dispatched']]);
});

test('scheduleWindow: an empty journal yields frontier 0 and no entries; malformed JSON entries are loud', async () => {
  const { port } = scripted([{ frontier_id: '0', resume_row: null, unfinished_rows: [], unhealthy_rows: [] }]);
  assert.deepEqual(await port.scheduleWindow(COHORT, ['dispatched']), { frontierId: 0, entries: [] });

  const bad = scripted([{ frontier_id: '1', resume_row: null, unfinished_rows: [{ id: 1, kind: 'other', startedAt: 'x' }], unhealthy_rows: [] }]);
  await assert.rejects(bad.port.scheduleWindow(COHORT, ['dispatched']), /neither tick nor resume/);
});

test('a query failure propagates — never an empty (clear) journal', async () => {
  const failing: StoreQuery = async () => {
    throw new Error('connection reset');
  };
  const neverTransacts: StoreTransactor = {
    transaction(): Promise<never> {
      throw new Error('unreached');
    },
  };
  await assert.rejects(new SqlCampaignTickJournalPort(failing, neverTransacts).entries(COHORT, 5), /connection reset/);
});

test('pgStoreTransactor releases WITH the error, because that is what destroys the client', async () => {
  // `pg-pool` reads a truthy first argument to `release` as "destroy this
  // client" and puts one released without it back in the idle set. A client
  // whose statement is still in flight is poisoned, and the next checkout
  // queues behind a query that may never return — measured as a process that
  // could not exit at all.
  //
  // Asserting on what `release` RECEIVED rather than that it was called: the
  // old test logged the string 'release' and would have stayed green through
  // this entire change.
  const received: unknown[] = [];
  const clientOf = (failOn?: string): PgTransactionClient => ({
    async query(sql: string) {
      if (failOn !== undefined && sql === failOn) throw new Error(`boom on ${sql}`);
      return { rows: [{ ok: 1 }] };
    },
    release(destroyBecause?: unknown) {
      received.push(destroyBecause);
    },
  });

  const happy = pgStoreTransactor({ connect: async () => clientOf() });
  await happy.transaction(async (query) => query('select 1', []));
  assert.deepEqual(received, [undefined],
    'a committed transaction leaves a healthy connection — destroying it would churn the pool');

  received.length = 0;
  const failing = pgStoreTransactor({ connect: async () => clientOf('select 1') });
  await assert.rejects(failing.transaction(async (query) => query('select 1', [])));
  assert.equal(received.length, 1);
  const destroyBecause = received[0] as object | undefined;
  assert.ok(destroyBecause instanceof Error,
    `release must get the error itself, got ${String(destroyBecause)}`);
  assert.match(destroyBecause.message, /boom on select 1/);
});

test('a rollback that never answers cannot stop the client being released', async () => {
  // The second place this could hang, and the one that used to. If the
  // transaction failed because a statement never came back, `rollback` is
  // queued BEHIND that statement and waits exactly as long — so the `finally`
  // that hands the connection back is never reached.
  let released: unknown = null;
  const client: PgTransactionClient = {
    async query(sql: string) {
      if (sql === 'rollback') return new Promise<never>(() => { /* never settles */ });
      if (sql === 'select 1') throw new Error('the primary fault');
      return { rows: [] };
    },
    release(destroyBecause?: unknown) { released = destroyBecause; },
  };
  const transactor = pgStoreTransactor({ connect: async () => client }, { rollbackTimeoutMs: 20 });

  await assert.rejects(
    transactor.transaction(async (query) => query('select 1', [])),
    /the primary fault/,
    'the primary error still wins — abandoning the rollback must not replace it',
  );
  assert.ok(released instanceof Error, 'the client was released, and released with the error');

  // NEGATIVE CONTROL: a rollback that DOES answer is still awaited, so the
  // bound is a deadline rather than a blanket refusal to wait.
  const seen: string[] = [];
  const prompt: PgTransactionClient = {
    async query(sql: string) {
      seen.push(sql);
      if (sql === 'select 1') throw new Error('fault');
      return { rows: [] };
    },
    release() { seen.push('release'); },
  };
  await assert.rejects(
    pgStoreTransactor({ connect: async () => prompt }, { rollbackTimeoutMs: 20 })
      .transaction(async (query) => query('select 1', [])),
  );
  assert.deepEqual(seen,
    ['begin isolation level read committed', 'select 1', 'rollback', 'release']);
});
