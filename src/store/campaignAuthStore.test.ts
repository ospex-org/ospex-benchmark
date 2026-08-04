import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqlCampaignAuthorizationPort } from './campaignAuthStore.js';
import type { StoreQuery } from './atomicStore.js';
import type { CampaignAuthorization } from '../campaignAuthorization.js';

/**
 * The production SQL authorization adapter, driven over a scripted `StoreQuery` so every
 * row-shape → result mapping is pinned WITHOUT a database: the armed/already_armed insert
 * mapping, the disarm tri-state (updated / already-disarmed / never-armed), the read's
 * null-vs-record mapping, the exact parameters each statement sends, and that a failing
 * query REJECTS rather than being swallowed into a success-shaped result. Inverting any of
 * these mappings in the adapter turns a test here red — the pure complement of the real-
 * Postgres conformance script (`yarn store:campaign-auth`).
 */

/** A minimal, structurally complete record; the adapter treats it as opaque data. */
const RECORD: CampaignAuthorization = Object.freeze({
  campaignAuthorizationVersion: 1,
  cohortId: 'cohort-abc',
  participantIds: Object.freeze(['p1', 'p2']),
  modelPriceTableVersion: 'guard-v1',
  modelPriceTableDigest: 'ab'.repeat(32),
  liveOptIn: true as const,
  observedCredentialedParticipantIds: Object.freeze(['p1', 'p2']),
  cohortSpendCapUsdMicros: 80_000_000_000,
  cohortCallCap: 800,
  maxConcurrentProviderRequests: 4,
  maxDispatchesPerTick: 1,
  maxRepairAttemptsPerArm: 1,
  evidenceRoot: '/srv/campaign-evidence',
  evidenceRootId: 'root-id-1',
  armedAt: '2026-08-05T00:00:00.000Z',
  expiresAt: '2026-08-12T00:00:00.000Z',
  disarmedAt: null,
});

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** A scripted query: each invocation records the call and shifts the next response. */
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
// read
// ---------------------------------------------------------------------------

test('read maps zero rows to null, and one row to its record value', async () => {
  const empty = scriptedQuery([[]]);
  assert.equal(await new SqlCampaignAuthorizationPort(empty.query).read('c1'), null);
  assert.deepEqual(empty.calls[0]!.params, ['c1'], 'the cohortId is the only parameter');

  const hit = scriptedQuery([[{ record: { ...RECORD } }]]);
  const value = await new SqlCampaignAuthorizationPort(hit.query).read('c1');
  assert.deepEqual(value, { ...RECORD });
});

test('read maps a malformed row (record column null or absent) to null, never a crash', async () => {
  const nullRecord = scriptedQuery([[{ record: null }]]);
  assert.equal(await new SqlCampaignAuthorizationPort(nullRecord.query).read('c1'), null);
  const missingColumn = scriptedQuery([[{ unexpected: 1 }]]);
  assert.equal(await new SqlCampaignAuthorizationPort(missingColumn.query).read('c1'), null);
});

// ---------------------------------------------------------------------------
// arm — the insert mapping the reviewer's inversion mutant targets
// ---------------------------------------------------------------------------

test('arm maps a returned row to "armed" and an empty return (conflict) to "already_armed"', async () => {
  const inserted = scriptedQuery([[{ cohort_id: RECORD.cohortId }]]);
  assert.equal(await new SqlCampaignAuthorizationPort(inserted.query).arm(RECORD), 'armed');

  const conflicted = scriptedQuery([[]]);
  assert.equal(await new SqlCampaignAuthorizationPort(conflicted.query).arm(RECORD), 'already_armed');
});

test('arm sends the cohortId and the exact JSON-serialized record as its parameters', async () => {
  const { query, calls } = scriptedQuery([[{ cohort_id: RECORD.cohortId }]]);
  await new SqlCampaignAuthorizationPort(query).arm(RECORD);
  assert.equal(calls.length, 1, 'exactly one statement');
  const [cohortId, json] = calls[0]!.params;
  assert.equal(cohortId, RECORD.cohortId);
  assert.deepEqual(JSON.parse(String(json)), { ...RECORD }, 'the stored JSON round-trips the record exactly');
});

// ---------------------------------------------------------------------------
// disarm — ONE statement, one snapshot; the SQL outcome is passed through, never inferred
// ---------------------------------------------------------------------------

test('disarm classifies in EXACTLY ONE statement for both outcomes, with [cohortId, at] parameters', async () => {
  const hit = scriptedQuery([[{ outcome: 'disarmed' }]]);
  assert.equal(await new SqlCampaignAuthorizationPort(hit.query).disarm('c1', '2026-08-06T00:00:00.000Z'), 'disarmed');
  assert.equal(hit.calls.length, 1, 'one statement — a later-snapshot presence probe is the race this bans');
  assert.deepEqual(hit.calls[0]!.params, ['c1', '2026-08-06T00:00:00.000Z']);

  const miss = scriptedQuery([[{ outcome: 'not_found' }]]);
  assert.equal(
    await new SqlCampaignAuthorizationPort(miss.query).disarm('c1', '2026-08-06T00:00:00.000Z'),
    'not_found',
  );
  assert.equal(miss.calls.length, 1, 'not_found comes from the SAME single statement, not a second query');
});

test('the single disarm statement carries the first-stop predicate and the snapshot CTE shape', async () => {
  // The SQL text IS the wire protocol here: these two fragments are exactly what the
  // durability contract depends on. Dropping the null-disarm predicate (a repeated stop
  // would then overwrite the FIRST stop instant) or the same-snapshot presence CTE (the
  // check/use race would return) must turn this red even without a live database.
  const { query, calls } = scriptedQuery([[{ outcome: 'disarmed' }]]);
  await new SqlCampaignAuthorizationPort(query).disarm('c1', '2026-08-06T00:00:00.000Z');
  const sql = calls[0]!.sql;
  assert.ok(sql.includes("record ->> 'disarmedAt' is null"), 'the FIRST-stop-wins predicate is present');
  assert.ok(/with\s+attempt\s+as/i.test(sql), 'the conditional update runs as a CTE of the one statement');
  assert.ok(/standing/i.test(sql), 'presence is read in the SAME statement snapshot');
});

test('disarm THROWS on an off-contract result shape — never coerced into an outcome', async () => {
  for (const rows of [[], [{ outcome: 'weird' }], [{ nope: 1 }], [{ outcome: 'disarmed' }, { outcome: 'disarmed' }]]) {
    await assert.rejects(
      () =>
        new SqlCampaignAuthorizationPort(scriptedQuery([rows as ReadonlyArray<Record<string, unknown>>]).query).disarm(
          'c1',
          '2026-08-06T00:00:00.000Z',
        ),
      /off-contract/,
      JSON.stringify(rows),
    );
  }
});

// ---------------------------------------------------------------------------
// failures propagate — a broken database must never read as a success shape
// ---------------------------------------------------------------------------

test('a failing query REJECTS read, arm, and disarm — never a success-shaped result', async () => {
  const boom = new Error('connection lost');
  await assert.rejects(() => new SqlCampaignAuthorizationPort(scriptedQuery([boom]).query).read('c1'), /connection lost/);
  await assert.rejects(() => new SqlCampaignAuthorizationPort(scriptedQuery([boom]).query).arm(RECORD), /connection lost/);
  await assert.rejects(
    () => new SqlCampaignAuthorizationPort(scriptedQuery([boom]).query).disarm('c1', '2026-08-06T00:00:00.000Z'),
    /connection lost/,
  );
});
