/**
 * Campaign-authorization adapter conformance against REAL Postgres: the
 * `SqlCampaignAuthorizationPort` driven over the checked-in schema, proving what the pure
 * scripted-query suite cannot — that the actual SQL statements against the actual
 * `store.campaign_authorizations` table produce the mapped outcomes: JSONB round-trip on
 * read, primary-key immutability (a second arm refuses FOREVER, including after a disarm),
 * first-disarm-wins stamping, and `not_found` only for a cohort never armed. Mirrors the
 * atomic-store conformance setup (drop + apply schema/functions on a scratch DB). NOT part
 * of `yarn test` (that suite is pure and DB-free).
 *
 * Run: `docker run` a Postgres, then `STORE_DATABASE_URL=… yarn store:campaign-auth`
 * (defaults to the spike's local Docker Postgres).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { pgStoreQuery } from './atomicStore.js';
import { SqlCampaignAuthorizationPort } from './campaignAuthStore.js';
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
