import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqlCampaignTickJournalPort } from './campaignTickJournal.js';
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
} {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const query: StoreQuery = async (sql, params) => {
    calls.push({ sql, params });
    return rows;
  };
  return { port: new SqlCampaignTickJournalPort(query), calls };
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
  await port.finish(71, 'validated_refused', null, '2026-08-05T12:00:05.000Z');
  assert.equal(calls.length, 1);
  const { sql, params } = calls[0]!;
  assert.match(sql, /update store\.campaign_ticks/);
  assert.match(sql, /finished_at is null/);
  assert.deepEqual(params, [71, '2026-08-05T12:00:05.000Z', 'validated_refused', null]);
});

test('resume: one INSERT of an already-finished resume row carrying the operator acknowledgment', async () => {
  const { port, calls } = scripted([]);
  await port.resume(COHORT, '2026-08-05T13:00:00.000Z', 'reviewed the loud failure');
  assert.equal(calls.length, 1);
  const { sql, params } = calls[0]!;
  assert.match(sql, /insert into store\.campaign_ticks/);
  assert.match(sql, /'resume'/);
  assert.deepEqual(params, [COHORT, '2026-08-05T13:00:00.000Z', 'operator_resumed', 'reviewed the loud failure']);
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

test('a query failure propagates — never an empty (clear) journal', async () => {
  const failing: StoreQuery = async () => {
    throw new Error('connection reset');
  };
  await assert.rejects(new SqlCampaignTickJournalPort(failing).entries(COHORT, 5), /connection reset/);
});
