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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { sha256Hex } from '../canonical.js';
import { buildCampaignAuthorization } from '../campaignAuthorization.js';
import { buildCampaignManifest } from '../campaignProfile.js';
import { buildCohortBudgetInitRequest } from '../cohortBudgetInit.js';
import { cohortBoot } from '../cohortBoot.js';
import { SqlAtomicStore, pgStoreQuery } from './atomicStore.js';
import { SqlCampaignAuthorizationPort } from './campaignAuthStore.js';
import { SqlCampaignStatusReadPort } from './campaignStatusRead.js';
import { SqlUnresolvedFireReadPort } from './escalationLatchRead.js';
import { SqlCampaignTickJournalPort, pgStoreTransactor } from './campaignTickJournal.js';
import { resolveScheduleState } from '../campaignSchedule.js';
import type { ScheduleEntry } from '../campaignSchedule.js';
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
    // made_calls is seeded with the ROSTER SIZE at admission (the initial arms count as
    // started the moment the dispatch is admitted — the calls settle floor) and grows by
    // one per acquired repair lease. This assertion is what taught us that; a fake cannot.
    assert.equal(fires.callsMade, 4, 'the admitted roster counts as started attempts');
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

  await check('escalation-latch read: released leases latch a pending fire; settlement clears it; live leases never latch', async () => {
    // The unit suite pins the SQL text and the wire mapping; only a real database proves
    // the predicate against the actual tables — that a fire is OFF the latch while its
    // roster leases are live, ON it once every lease is released with the claim still
    // pending (the exact durable shadow an escalated fire leaves), and OFF again when the
    // claim settles.
    const c = cohortName('latchread');
    const store = new SqlAtomicStore(pgStoreQuery(pool));
    const latchRead = new SqlUnresolvedFireReadPort(pgStoreQuery(pool));
    assert.deepEqual(await latchRead.unresolvedFires(c), [], 'a cohort with no fires is clear');

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
        moneyline: { spendReservationUsdMicros: 800_000_000, preparedBytesDigest: sha256Hex('latch-read-conformance') },
      },
    });
    assert.equal(admitted.outcome, 'admitted');
    if (admitted.outcome !== 'admitted') return;
    assert.deepEqual(await latchRead.unresolvedFires(c), [], 'live initial leases keep an in-flight fire OFF the latch');

    for (const lease of admitted.initialLeases) {
      assert.deepEqual(await store.releaseLease({ leaseId: lease.leaseId, ownerId: 'w1' }), { outcome: 'released' });
    }
    const latched = await latchRead.unresolvedFires(c);
    assert.equal(latched.length, 1, 'a pending fire with every lease released is ON the latch');
    assert.equal(latched[0]!.fireId, 'f1');
    assert.ok(!Number.isNaN(Date.parse(latched[0]!.admittedAt)), 'the admission instant round-trips as an instant');

    // The correlation, behaviourally: a SECOND in-flight fire's live leases must not mask
    // the unresolved one, and the unresolved fire's released leases must not latch the
    // in-flight one. A dropped lease-to-fire correlation in the anti-join fails exactly
    // here — any live lease in the cohort would read the whole cohort as clear.
    const second = await store.admitDispatch({
      cohortId: c,
      fireId: 'f2',
      ownerId: 'w1',
      expectedSchemaVersion: STORE_SCHEMA_VERSION,
      gameId: 'g2',
      proposedMarkets: ['moneyline'],
      scopeReservations: {
        moneyline: { spendReservationUsdMicros: 800_000_000, preparedBytesDigest: sha256Hex('latch-read-second-fire') },
      },
    });
    assert.equal(second.outcome, 'admitted');
    assert.deepEqual(
      (await latchRead.unresolvedFires(c)).map((f) => f.fireId),
      ['f1'],
      "the latch is per-fire: f2's live leases do not mask unresolved f1, and f1's released leases do not latch in-flight f2",
    );

    assert.deepEqual(await store.completeClaim({ cohortId: c, fireId: 'f1', expectedSchemaVersion: STORE_SCHEMA_VERSION }), {
      outcome: 'completed',
    });
    assert.deepEqual(await latchRead.unresolvedFires(c), [], 'settling the unresolved fire clears the latch (f2 stays live-leased)');
  });

  await check('escalation-latch read: an EXPIRED never-released lease latches — the crash shape self-reports at its lease bound', async () => {
    // A zero lease bound expires each lease at its own acquire instant, so by this read
    // every lease is expired-but-unreleased — the durable shape of a dispatch whose
    // process died holding its leases. Pending + no LIVE lease ⇒ latched, with no
    // release call ever made.
    const c = cohortName('latchexpiry');
    const store = new SqlAtomicStore(pgStoreQuery(pool));
    const latchRead = new SqlUnresolvedFireReadPort(pgStoreQuery(pool));
    assert.deepEqual(
      await store.initCohortBudget({
        cohortId: c,
        schemaVersion: STORE_SCHEMA_VERSION,
        callCap: 800,
        spendCapUsdMicros: 80_000_000_000,
        concurrencyLimit: 8,
        rosterSize: 4,
        maxRepairsPerArm: 1,
        initialLeaseBoundMs: 0,
        repairLeaseBoundMs: 0,
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
        moneyline: { spendReservationUsdMicros: 800_000_000, preparedBytesDigest: sha256Hex('latch-expiry-conformance') },
      },
    });
    assert.equal(admitted.outcome, 'admitted');
    const latched = await latchRead.unresolvedFires(c);
    assert.equal(latched.length, 1, 'expired never-released leases leave the pending fire latched');
    assert.equal(latched[0]!.fireId, 'f1');
  });

  const HEALTHY = ['validated_refused'];
  const RULE_NOW = Date.parse('2026-08-05T12:00:00.000Z');
  const RULE_DEADLINE = 3_000_000; // the default campaign build's deadline (pinned in the pure suite)
  const ruleState = (entries: readonly ScheduleEntry[]) =>
    resolveScheduleState({ entries, nowMs: RULE_NOW, deadlineMs: RULE_DEADLINE, healthyOutcomes: HEALTHY });

  await check('tick journal: two-phase begin/finish against real rows; the FIRST finish wins; the window read is boundary-anchored', async () => {
    const c = cohortName('journal');
    const journal = new SqlCampaignTickJournalPort(pgStoreQuery(pool), pgStoreTransactor(pool));
    assert.deepEqual(await journal.scheduleWindow(c, HEALTHY), { frontierId: 0, entries: [] });

    const id1 = await journal.begin(c, '2026-08-05T11:59:00.000Z');
    let window = await journal.scheduleWindow(c, HEALTHY);
    assert.equal(window.frontierId, id1);
    assert.deepEqual(
      window.entries,
      [{ id: id1, kind: 'tick', startedAt: '2026-08-05T11:59:00.000Z', finishedAt: null, outcome: null, detail: null }],
      'a begun entry is durably UNFINISHED — the crash shape the halt rule detects',
    );

    await journal.finish(id1, 'validated_refused', null, '2026-08-05T11:59:05.000Z');
    await journal.finish(id1, 'loud_failure', 'a later racer', '2026-08-05T11:59:09.000Z');
    const rows = await journal.entries(c, 10);
    assert.equal(rows[0]!.outcome, 'validated_refused', 'the FIRST finish stands — a later finish changes nothing');
    assert.equal(rows[0]!.finishedAt, '2026-08-05T11:59:05.000Z');
    assert.equal(rows[0]!.detail, null);
    window = await journal.scheduleWindow(c, HEALTHY);
    assert.deepEqual(window.entries, [], 'a healthy finished tick is not halt-relevant');
    assert.equal(window.frontierId, id1, 'the frontier still witnesses it');
  });

  await check('journal counterexample: 51 unfinished ticks — the window returns ALL of them, the stale oldest included, and the rule halts', async () => {
    // A bounded newest-N read once omitted the stale oldest here and read the schedule
    // clear; the window read is filtered and unbounded, so it cannot.
    const c = cohortName('allunfinished');
    const journal = new SqlCampaignTickJournalPort(pgStoreQuery(pool), pgStoreTransactor(pool));
    const staleId = await journal.begin(c, '2026-08-04T00:00:00.000Z'); // a day old — stale
    for (let i = 0; i < 50; i += 1) {
      await journal.begin(c, new Date(RULE_NOW - 1_000 * (50 - i)).toISOString()); // all fresh
    }
    const window = await journal.scheduleWindow(c, HEALTHY);
    assert.equal(window.entries.length, 51, 'every unfinished tick is in the window — no newest-N blind spot');
    assert.ok(window.entries.some((e) => e.id === staleId), 'the stale oldest is present');
    const state = ruleState(window.entries);
    assert.equal(state.kind, 'halted');
    if (state.kind === 'halted') assert.match(state.why, new RegExp(`tick ${staleId} started`));
  });

  await check('journal counterexample: reviewed crash + resume + 51 healthy ticks — the boundary is durable, the schedule stays clear', async () => {
    // The resume row is read directly as the boundary; it can never fall out of a
    // bounded recent window, so already-reviewed history can never re-halt the campaign.
    const c = cohortName('durableboundary');
    const journal = new SqlCampaignTickJournalPort(pgStoreQuery(pool), pgStoreTransactor(pool));
    const crashId = await journal.begin(c, '2026-08-04T00:00:00.000Z'); // stale crash
    const reviewed = await journal.scheduleWindow(c, HEALTHY);
    assert.equal(ruleState(reviewed.entries).kind, 'halted');
    assert.equal(await journal.resume(c, '2026-08-04T02:00:00.000Z', 'reviewed the crash', reviewed.frontierId), 'resumed');
    for (let i = 0; i < 51; i += 1) {
      const startIso = new Date(RULE_NOW - 60_000 * (51 - i)).toISOString();
      const id = await journal.begin(c, startIso);
      await journal.finish(id, 'validated_refused', null, new Date(RULE_NOW - 60_000 * (51 - i) + 5_000).toISOString());
    }
    const window = await journal.scheduleWindow(c, HEALTHY);
    assert.ok(window.entries.some((e) => e.kind === 'resume'), 'the boundary row is present regardless of how much followed it');
    assert.ok(!window.entries.some((e) => e.id === crashId), 'the reviewed crash sits before the boundary');
    assert.equal(ruleState(window.entries).kind, 'clear');
  });

  await check('journal counterexample: a tick beginning after the review moves the frontier — the stale resume is REFUSED and the raced failure still halts', async () => {
    const c = cohortName('frontiercas');
    const journal = new SqlCampaignTickJournalPort(pgStoreQuery(pool), pgStoreTransactor(pool));
    await journal.begin(c, '2026-08-04T00:00:00.000Z'); // the stale halt cause under review
    const reviewed = await journal.scheduleWindow(c, HEALTHY);
    assert.equal(ruleState(reviewed.entries).kind, 'halted');

    // The race: a tick begins after the operator's review read, before the acknowledgment.
    const racedId = await journal.begin(c, new Date(RULE_NOW - 1_000).toISOString());
    assert.equal(
      await journal.resume(c, '2026-08-05T11:59:00.000Z', 'reviewed the crash', reviewed.frontierId),
      'frontier_moved',
      'the acknowledgment is refused against a moved frontier',
    );
    assert.ok(!(await journal.entries(c, 10)).some((e) => e.kind === 'resume'), 'nothing was written');

    // The raced tick later fails; with no resume row, its outcome is in the window and halts.
    await journal.finish(racedId, 'loud_failure', null, new Date(RULE_NOW).toISOString());
    const after = await journal.scheduleWindow(c, HEALTHY);
    assert.ok(after.entries.some((e) => e.id === racedId && e.outcome === 'loud_failure'), 'the raced failure is never hidden');
    assert.equal(ruleState(after.entries).kind, 'halted');

    // A resume at the CURRENT frontier — the raced outcome reviewed too — succeeds and clears.
    assert.equal(await journal.resume(c, '2026-08-05T12:00:30.000Z', 'reviewed both', after.frontierId), 'resumed');
    const cleared = await journal.scheduleWindow(c, HEALTHY);
    assert.equal(ruleState(cleared.entries).kind, 'clear');
  });

  await check('journal counterexample: a resume racing an UNCOMMITTED begin waits on the lock and is then refused — the raced failure still halts', async () => {
    // The single-statement CAS failed exactly here: its snapshot was taken before it
    // blocked on the lock, so a begin committing while it waited stayed invisible to the
    // frontier compare and the resume buried the raced tick. The transactional resume
    // takes the lock as its OWN command and snapshots the CAS afterwards.
    const c = cohortName('uncommittedrace');
    const journal = new SqlCampaignTickJournalPort(pgStoreQuery(pool), pgStoreTransactor(pool));
    await journal.begin(c, '2026-08-04T00:00:00.000Z'); // the stale halt cause under review
    const reviewed = await journal.scheduleWindow(c, HEALTHY);
    assert.equal(ruleState(reviewed.entries).kind, 'halted');

    // Hold the EXACT production begin after its lock acquisition, before commit: the
    // production statement runs on a dedicated client inside an open transaction (the
    // advisory xact lock is reentrant there), so its row is inserted and the lock is held
    // until the explicit commit below.
    const clientA = await pool.connect();
    let racedId: number;
    try {
      await clientA.query('begin');
      await clientA.query('select pg_advisory_xact_lock(hashtext($1))', [c]);
      const heldTransactor = {
        transaction(): Promise<never> {
          throw new Error('the held begin never opens its own transaction');
        },
      };
      const heldPort = new SqlCampaignTickJournalPort(
        async (sql, params) => (await clientA.query(sql, params as unknown[])).rows,
        heldTransactor,
      );
      racedId = await heldPort.begin(c, '2026-08-05T11:59:50.000Z');

      // The production resume, dispatched WHILE the begin holds the lock uncommitted: it
      // must wait — it cannot settle before the lock is released.
      const resumePromise = journal.resume(c, '2026-08-05T11:59:55.000Z', 'reviewed the crash', reviewed.frontierId);
      const probe = await Promise.race([
        resumePromise.then(() => 'settled' as const),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 300)),
      ]);
      assert.equal(probe, 'pending', 'the resume waits while the begin owns the lock');

      await clientA.query('commit'); // release the begin
      assert.equal(await resumePromise, 'frontier_moved', 'the post-lock CAS snapshot sees the raced commit');
    } finally {
      clientA.release();
    }
    assert.ok(!(await journal.entries(c, 10)).some((e) => e.kind === 'resume'), 'no resume row was written');

    // The raced tick later fails; nothing bounded it out, so it halts.
    await journal.finish(racedId, 'loud_failure', null, '2026-08-05T12:00:00.000Z');
    const after = await journal.scheduleWindow(c, HEALTHY);
    assert.ok(after.entries.some((e) => e.id === racedId && e.outcome === 'loud_failure'), 'the raced failure is in the authoritative window');
    assert.equal(ruleState(after.entries).kind, 'halted');
  });

  await check('READ-ONLY public CLI: campaign:status runs as a SELECT-only role and rewrites NO catalog state', async () => {
    // Arm a real campaign via the admin ports: manifest → budget → authorization.
    const startMs = Date.now();
    const weekMs = 7 * 24 * 3_600_000;
    const built = buildCampaignManifest(startMs, { callCap: 800, windowForwardMs: weekMs });
    const booted = cohortBoot({ manifestBytes: built.bytes });
    const store = new SqlAtomicStore(pgStoreQuery(pool));
    assert.deepEqual(await store.initCohortBudget(buildCohortBudgetInitRequest(booted)), { outcome: 'initialized' });
    const roster = booted.manifest.expectedArmRoster.map((arm) => arm.participantId);
    assert.equal(
      await port.arm(
        buildCampaignAuthorization({
          booted,
          observedCredentialedParticipantIds: roster,
          armedAtMs: startMs,
          expiresAtMs: startMs + weekMs,
        }),
      ),
      'armed',
    );
    const manifestPath = join(mkdtempSync(join(tmpdir(), 'campaign-ro-status-')), 'manifest.json');
    writeFileSync(manifestPath, built.bytes);

    // Seed one finished healthy tick so the RO role provably SELECTs real journal rows
    // (an empty journal would render the none-recorded branch without touching the table).
    const journal = new SqlCampaignTickJournalPort(pgStoreQuery(pool), pgStoreTransactor(pool));
    const seededTick = await journal.begin(booted.cohortId, new Date(startMs).toISOString());
    await journal.finish(seededTick, 'validated_refused', null, new Date(startMs + 1_000).toISOString());

    // A SELECT-only role: it cannot create schemas, tables, or functions — the exact
    // capability the monitoring read must not need.
    await pool.query('drop role if exists campaign_status_ro');
    await pool.query("create role campaign_status_ro login password 'ro-conformance'");
    await pool.query('grant usage on schema store to campaign_status_ro');
    await pool.query('grant select on all tables in schema store to campaign_status_ro');
    const roUrl = new URL(DATABASE_URL);
    roUrl.username = 'campaign_status_ro';
    roUrl.password = 'ro-conformance';

    // Fingerprint the store-function catalog rows (oid:xmin): any CREATE OR REPLACE — even
    // one that re-installs identical source — rewrites a row and changes this string.
    const fingerprint = async (): Promise<string> => {
      const { rows } = await pool.query(
        `select coalesce(string_agg(p.oid::text || ':' || p.xmin::text, ',' order by p.oid), '') as fp
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'store'`,
      );
      return String(rows[0]!.fp);
    };
    const before = await fingerprint();

    // The REAL public CLI, as the read-only role, real argv/stdin.
    const cliPath = fileURLToPath(new URL('../campaignMain.ts', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, 'status', '--manifest', manifestPath], {
      cwd: dirname(dirname(cliPath)),
      encoding: 'utf8',
      timeout: 120_000,
      input: '',
      env: {
        ...process.env,
        STORE_DATABASE_URL: roUrl.toString(),
        OPENAI_API_KEY: 'synthetic-test-credential',
        ANTHROPIC_API_KEY: 'synthetic-test-credential',
        GEMINI_API_KEY: 'synthetic-test-credential',
        GOOGLE_API_KEY: '',
        XAI_API_KEY: 'synthetic-test-credential',
      },
    });
    const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.equal(result.status, 0, `the read-only role renders the live report and exits 0; out=${out}`);
    assert.ok(out.includes('authorization LIVE'), `the report rendered; out=${out}`);
    assert.ok(
      out.includes('latch  clear — no unresolved fire'),
      `the escalation-latch read ran under the SELECT-only role; out=${out}`,
    );
    assert.ok(
      out.includes(`ticks  last tick ${seededTick} started`) && out.includes('(validated_refused)'),
      `the RO role SELECTed the real journal row; out=${out}`,
    );
    assert.ok(out.includes('sched  clear — scheduling may continue'), `the schedule state rendered; out=${out}`);
    assert.ok(out.includes('next tick would AUTHORIZE'), `the verdict rendered; out=${out}`);
    assert.equal(await fingerprint(), before, 'the monitoring read rewrote NO store-function catalog row');
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
