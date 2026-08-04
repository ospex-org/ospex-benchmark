import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqlCampaignStatusReadPort } from './campaignStatusRead.js';
import type { StoreQuery } from './atomicStore.js';

/**
 * The read-only status port over a scripted `StoreQuery`: the row→summary mappings are
 * pinned WITHOUT a database, including the two wire facts that would otherwise produce a
 * silently wrong money-adjacent report — `pg` returns `bigint` columns as STRINGS and
 * `timestamptz` as `Date` objects. Every count goes through one checked conversion that
 * throws on anything that is not a non-negative safe integer, and a failing query rejects
 * rather than reading as an empty campaign. The real-Postgres complement lives in the
 * campaign conformance runner (`yarn store:campaign-auth`), which drives these exact
 * statements against the real schema.
 */

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function scriptedQuery(
  responses: Array<ReadonlyArray<Record<string, unknown>> | Error>,
): { query: StoreQuery; calls: Call[] } {
  const calls: Call[] = [];
  const query: StoreQuery = async (sql, params) => {
    calls.push({ sql, params });
    const next = responses.shift();
    if (next === undefined) throw new Error(`scripted query exhausted (call ${calls.length}: ${sql})`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { query, calls };
}

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

test('budget maps the row with bigint-as-STRING conversion, and no row to null', async () => {
  const hit = scriptedQuery([
    [{ call_cap: '800', calls_reserved: '16', spend_cap_usd_micros: '80000000000', spend_reserved_usd_micros: '1600000000' }],
  ]);
  const budget = await new SqlCampaignStatusReadPort(hit.query).budget('c1');
  assert.deepEqual(budget, {
    callCap: 800,
    callsReserved: 16,
    spendCapUsdMicros: 80_000_000_000,
    spendReservedUsdMicros: 1_600_000_000,
  });
  assert.equal(hit.calls.length, 1);
  assert.deepEqual(hit.calls[0]!.params, ['c1']);

  const miss = scriptedQuery([[]]);
  assert.equal(await new SqlCampaignStatusReadPort(miss.query).budget('c1'), null);
});

test('budget THROWS on a count that is not a non-negative safe integer — never a silently wrong number', async () => {
  for (const bad of ['abc', '-1', null, undefined, '1.5', String(Number.MAX_SAFE_INTEGER + 2)]) {
    const { query } = scriptedQuery([
      [{ call_cap: bad, calls_reserved: '0', spend_cap_usd_micros: '0', spend_reserved_usd_micros: '0' }],
    ]);
    await assert.rejects(
      () => new SqlCampaignStatusReadPort(query).budget('c1'),
      /not a non-negative safe integer/,
      String(bad),
    );
  }
});

// ---------------------------------------------------------------------------
// fires
// ---------------------------------------------------------------------------

function fireRows(over: Record<string, unknown> = {}): ReadonlyArray<Record<string, unknown>> {
  return [
    {
      fires_admitted: '2',
      fires_completed: '1',
      fires_pending: '1',
      calls_made: '9',
      last_admitted_at: new Date('2026-08-05T12:00:00.000Z'),
      ...over,
    },
  ];
}
const CLAIM_ROWS = [{ claims_pending: '1', claims_completed: '3' }];
const LEASE_ROWS = [{ active_leases: '4' }];

test('fires maps the three aggregates — counts from strings, last_admitted_at from a Date — in three reads', async () => {
  const { query, calls } = scriptedQuery([fireRows(), CLAIM_ROWS, LEASE_ROWS]);
  const fires = await new SqlCampaignStatusReadPort(query).fires('c1');
  assert.deepEqual(fires, {
    firesAdmitted: 2,
    firesCompleted: 1,
    firesPending: 1,
    callsMade: 9,
    claimsPending: 1,
    claimsCompleted: 3,
    activeLeases: 4,
    lastAdmittedAt: '2026-08-05T12:00:00.000Z',
  });
  assert.equal(calls.length, 3);
  for (const call of calls) assert.deepEqual(call.params, ['c1']);
  // The lease read only counts UNRELEASED, UNEXPIRED slots — the liveness filter is in the
  // statement itself, so its absence would silently count dead leases as active.
  assert.ok(calls[2]!.sql.includes('released_at is null'), 'the lease read filters released slots');
  assert.ok(calls[2]!.sql.includes('expires_at > now()'), 'the lease read filters expired slots');
});

test('a campaign that never admitted anything reads as all-zero with a null last admission', async () => {
  const { query } = scriptedQuery([
    fireRows({ fires_admitted: '0', fires_completed: '0', fires_pending: '0', calls_made: '0', last_admitted_at: null }),
    [{ claims_pending: '0', claims_completed: '0' }],
    [{ active_leases: '0' }],
  ]);
  const fires = await new SqlCampaignStatusReadPort(query).fires('c1');
  assert.deepEqual(fires, {
    firesAdmitted: 0,
    firesCompleted: 0,
    firesPending: 0,
    callsMade: 0,
    claimsPending: 0,
    claimsCompleted: 0,
    activeLeases: 0,
    lastAdmittedAt: null,
  });
});

test('fires THROWS on malformed aggregates and on a missing aggregate row', async () => {
  const badCount = scriptedQuery([fireRows({ calls_made: 'lots' }), CLAIM_ROWS, LEASE_ROWS]);
  await assert.rejects(() => new SqlCampaignStatusReadPort(badCount.query).fires('c1'), /not a non-negative safe integer/);

  const badInstant = scriptedQuery([fireRows({ last_admitted_at: 12345 }), CLAIM_ROWS, LEASE_ROWS]);
  await assert.rejects(() => new SqlCampaignStatusReadPort(badInstant.query).fires('c1'), /neither a timestamp nor null/);

  const emptyAggregate = scriptedQuery([[], CLAIM_ROWS, LEASE_ROWS]);
  await assert.rejects(() => new SqlCampaignStatusReadPort(emptyAggregate.query).fires('c1'), /no row/);
});

test('a failing query REJECTS budget and fires — a broken database never reads as an empty campaign', async () => {
  const boom = new Error('connection lost');
  await assert.rejects(() => new SqlCampaignStatusReadPort(scriptedQuery([boom]).query).budget('c1'), /connection lost/);
  await assert.rejects(() => new SqlCampaignStatusReadPort(scriptedQuery([boom]).query).fires('c1'), /connection lost/);
  // A failure of the second or third aggregate read also propagates.
  await assert.rejects(
    () => new SqlCampaignStatusReadPort(scriptedQuery([fireRows(), boom]).query).fires('c1'),
    /connection lost/,
  );
});
