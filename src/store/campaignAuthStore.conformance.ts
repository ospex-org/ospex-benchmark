/**
 * Campaign adapter conformance against REAL Postgres: the `SqlCampaignAuthorizationPort`
 * and the read-only `SqlCampaignStatusReadPort` driven over the checked-in schema, proving
 * what the pure scripted-query suites cannot — that the actual SQL statements against the
 * actual tables produce the mapped outcomes: JSONB round-trip on read, primary-key
 * immutability (a second arm refuses FOREVER, including after a disarm), first-disarm-wins
 * stamping, `not_found` only for a cohort never armed, the single-statement stop under a
 * deterministic race, and the status port's real budget/fires/claims/leases column reads.
 * Mirrors the atomic-store conformance setup (drop + apply schema/functions on a scratch
 * DB). NOT part of `yarn test` (that suite is pure and DB-free).
 *
 * Run: `docker run` a Postgres, then `STORE_DATABASE_URL=… yarn store:campaign-auth`
 * (defaults to the spike's local Docker Postgres).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { sha256Hex } from '../canonical.js';
import { SqlAtomicStore, pgStoreQuery } from './atomicStore.js';
import { SqlCampaignAuthorizationPort } from './campaignAuthStore.js';
import { SqlCampaignStatusReadPort } from './campaignStatusRead.js';
import { STORE_SCHEMA_VERSION } from './constants.js';
import type { CampaignAuthorization } from '../campaignAuthorization.js';

const DATABASE_URL = process.env.STORE_DATABASE_URL ?? 'postgres://postgres:spike@localhost:5433/store_spike';
const SCHEMA_SQL = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const FUNCTIONS_SQL = readFileSync(new URL('./functions.sql', import.meta.url), 'utf8');

let nonce = 0;
const cohortName = (label: string): string => `campauth-${label}-${process.pid}-${(nonce += 1)}`;

function record(cohortId: string, over: Partial<CampaignAuthorization> = {}): CampaignAuthorization {
  return {
    campaignAuthorizationVersion: 1,
    cohortId,
    participantIds: ['p1', 'p2', 'p3', 'p4'],
    modelPriceTableVersion: 'guard-v1',
    modelPriceTableDigest: 'ab'.repeat(32),
    liveOptIn: true,
    observedCredentialedParticipantIds: ['p1', 'p2', 'p3', 'p4'],
    cohortSpendCapUsdMicros: 80_000_000_000,
    cohortCallCap: 800,
    maxConcurrentProviderRequests: 4,
    maxDispatchesPerTick: 1,
    maxRepairAttemptsPerArm: 1,
    armedAt: '2026-08-05T00:00:00.000Z',
    expiresAt: '2026-08-12T00:00:00.000Z',
    disarmedAt: null,
    ...over,
  };
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    console.log(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4, connectionTimeoutMillis: 8000 });
  await pool.query('drop schema if exists store cascade');
  await pool.query(SCHEMA_SQL);
  await pool.query(FUNCTIONS_SQL);

  const port = new SqlCampaignAuthorizationPort(pgStoreQuery(pool));

  await check('read: a cohort never armed reads null', async () => {
    assert.equal(await port.read(cohortName('unknown')), null);
  });

  await check('arm → armed; read round-trips the EXACT record through JSONB', async () => {
    const c = cohortName('roundtrip');
    const rec = record(c);
    assert.equal(await port.arm(rec), 'armed');
    assert.deepEqual(await port.read(c), { ...rec, participantIds: [...rec.participantIds], observedCredentialedParticipantIds: [...rec.observedCredentialedParticipantIds] });
  });

  await check('a second arm refuses (already_armed) and the FIRST record stands untouched', async () => {
    const c = cohortName('immutable');
    const first = record(c);
    assert.equal(await port.arm(first), 'armed');
    const second = record(c, { cohortCallCap: 8, armedAt: '2026-08-06T00:00:00.000Z' });
    assert.equal(await port.arm(second), 'already_armed');
    const stored = (await port.read(c)) as CampaignAuthorization;
    assert.equal(stored.cohortCallCap, first.cohortCallCap, 'the standing record was not replaced');
    assert.equal(stored.armedAt, first.armedAt);
  });

  await check('disarm → disarmed; the stamp lands INSIDE the record', async () => {
    const c = cohortName('disarm');
    await port.arm(record(c));
    assert.equal(await port.disarm(c, '2026-08-06T12:00:00.000Z'), 'disarmed');
    const stored = (await port.read(c)) as CampaignAuthorization;
    assert.equal(stored.disarmedAt, '2026-08-06T12:00:00.000Z');
  });

  await check('a second disarm is idempotent and the FIRST stop instant is preserved', async () => {
    const c = cohortName('firststop');
    await port.arm(record(c));
    assert.equal(await port.disarm(c, '2026-08-06T12:00:00.000Z'), 'disarmed');
    assert.equal(await port.disarm(c, '2026-08-07T00:00:00.000Z'), 'disarmed');
    const stored = (await port.read(c)) as CampaignAuthorization;
    assert.equal(stored.disarmedAt, '2026-08-06T12:00:00.000Z', 'a repeated stop never rewrites history');
  });

  await check('arm AFTER disarm still refuses — the record is immutable history', async () => {
    const c = cohortName('norevive');
    await port.arm(record(c));
    await port.disarm(c, '2026-08-06T12:00:00.000Z');
    assert.equal(await port.arm(record(c)), 'already_armed');
    const stored = (await port.read(c)) as CampaignAuthorization;
    assert.notEqual(stored.disarmedAt, null, 'the disarmed record was not replaced by a live one');
  });

  await check('disarm of a cohort never armed → not_found', async () => {
    assert.equal(await port.disarm(cohortName('ghost'), '2026-08-06T12:00:00.000Z'), 'not_found');
  });

  await check('deterministic race: an arm landing right after the disarm statement can NEVER produce a false disarmed', async () => {
    // The reviewer-shaped interleaving that broke the two-statement disarm: the stop's first
    // statement finds nothing, then a concurrent arm INSERTS an active row, then the old
    // second (presence) statement — running in a LATER snapshot — saw the row and reported
    // 'disarmed' while the authorization was live. This seam wrapper forces exactly that
    // interleaving: the insert lands immediately after EACH statement returns and before the
    // adapter sees its rows. A single-statement adapter classifies from the pre-insert
    // snapshot and reports not_found (1 query); any adapter that consults a second statement
    // would observe the inserted row and misreport a live authorization as stopped.
    const c = cohortName('race');
    const rec = record(c);
    const baseQuery = pgStoreQuery(pool);
    let inserted = false;
    let statements = 0;
    const racingQuery: typeof baseQuery = async (sql, params) => {
      const rows = await baseQuery(sql, params);
      statements += 1;
      if (!inserted) {
        inserted = true;
        assert.equal(await port.arm(rec), 'armed'); // the concurrent arm, via the plain port
      }
      return rows;
    };
    const outcome = await new SqlCampaignAuthorizationPort(racingQuery).disarm(c, '2026-08-06T12:00:00.000Z');
    assert.equal(statements, 1, 'stop classification consulted exactly one statement');
    assert.equal(outcome, 'not_found', 'a row inserted after the snapshot must never read as disarmed');
    const standing = (await port.read(c)) as CampaignAuthorization;
    assert.equal(standing.disarmedAt, null, 'the concurrently armed authorization is STILL ACTIVE — proving a false STOPPED here would have lied');
  });

  await check('status reads: the REAL budget/fires/claims/leases columns map through SqlCampaignStatusReadPort', async () => {
    // The scripted-row unit suite pins the mappings; only a real database can prove the
    // column names and aggregate SQL themselves (a typo'd column would pass every fake).
    const c = cohortName('statusread');
    const store = new SqlAtomicStore(pgStoreQuery(pool));
    const reads = new SqlCampaignStatusReadPort(pgStoreQuery(pool));
    assert.equal(await reads.budget(c), null, 'no budget row reads as null');

    assert.deepEqual(
      await store.initCohortBudget({
        cohortId: c,
        schemaVersion: STORE_SCHEMA_VERSION,
        callCap: 800,
        spendCapUsdMicros: 80_000_000_000,
        concurrencyLimit: 8,
        rosterSize: 4,
        maxRepairsPerArm: 1,
        initialLeaseBoundMs: 600_000,
        repairLeaseBoundMs: 300_000,
      }),
      { outcome: 'initialized' },
    );
    const admitted = await store.admitDispatch({
      cohortId: c,
      fireId: 'f1',
      ownerId: 'w1',
      expectedSchemaVersion: STORE_SCHEMA_VERSION,
      gameId: 'g1',
      proposedMarkets: ['moneyline'],
      scopeReservations: {
        moneyline: { spendReservationUsdMicros: 800_000_000, preparedBytesDigest: sha256Hex('status-read-conformance') },
      },
    });
    assert.equal(admitted.outcome, 'admitted');

    assert.deepEqual(await reads.budget(c), {
      callCap: 800,
      callsReserved: 8, // roster 4 × (1 + 1 repair) — one dispatch's call delta
      spendCapUsdMicros: 80_000_000_000,
      spendReservedUsdMicros: 800_000_000,
    });
    const fires = await reads.fires(c);
    assert.equal(fires.firesAdmitted, 1);
    assert.equal(fires.firesPending, 1);
    assert.equal(fires.firesCompleted, 0);
    assert.equal(fires.callsMade, 0, 'no attempt was started');
    assert.equal(fires.claimsPending, 1);
    assert.equal(fires.claimsCompleted, 0);
    assert.equal(fires.activeLeases, 4, 'the roster-sized initial lease set is live');
    assert.equal(typeof fires.lastAdmittedAt, 'string', 'the admission instant round-trips');

    assert.deepEqual(await store.completeClaim({ cohortId: c, fireId: 'f1', expectedSchemaVersion: STORE_SCHEMA_VERSION }), {
      outcome: 'completed',
    });
    const after = await reads.fires(c);
    assert.equal(after.firesCompleted, 1);
    assert.equal(after.claimsCompleted, 1);
  });

  await pool.end();

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} campaign-auth conformance checks passed`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
