/**
 * The serving publisher against REAL PostgreSQL, proving what the scripted-query
 * suite cannot: that these statements are valid SQL, that one statement really
 * does satisfy the projection's composite foreign keys, that every column lands
 * where its INSERT list says it does, and that the outcomes the adapter maps are
 * the outcomes the database actually produces.
 *
 * IT CONNECTS AS THE SCOPED WRITER AND NOTHING ELSE. No owner escape hatch, no
 * TRUNCATE between checks — every run mints its own cohort id, so the suite is
 * append-only exactly like the port under test. That is deliberate: an owner
 * connection would let a check pass under privileges the runner will never have.
 *
 * ⚠ IT READS ITS OWN ENVIRONMENT VARIABLES, NOT THE PRODUCTION ONES, and defaults
 *   to a local scratch database. BENCHMARK_WRITER, BENCHMARK_DB_URL and
 *   SUPABASE_URL are never consulted here. A non-local host is refused unless an
 *   operator sets BENCHMARK_CONFORMANCE_ALLOW_REMOTE=1 and supplies that host's
 *   credential by hand — so reaching the live projection takes two deliberate
 *   acts, and neither happens by running this. That guard matters because the
 *   live tables carry zero lifetime inserts as an evidence property, and
 *   PostgreSQL counts an insert even when its transaction aborts.
 *
 * NOT part of `yarn test`: that suite is pure, and CI has no database.
 *
 * SETUP. The nine tables belong to the protocol's own schema, not to this repo,
 * and this repo deliberately keeps no copy of their definition — a second
 * definition is a second thing to drift. Point this at a disposable PostgreSQL 17
 * that already carries them, plus the scoped `benchmark_writer` login:
 *
 *   docker run -d --name bmserving -e POSTGRES_PASSWORD=t \
 *     -e POSTGRES_DB=ospex_serving_scratch -p 5436:5432 postgres:17-alpine
 *   # apply the benchmark serving-projection migrations and create the writer
 *   yarn store:serving
 *
 * Two prerequisites a bare PostgreSQL does not have, both of which stop a run:
 *
 *   - the projection's tables reference the protocol's own `public.network`
 *     enum, so it has to exist before the migration applies:
 *       CREATE TYPE public.network AS ENUM ('polygon', 'amoy');
 *   - the last check asserts the writer is REFUSED on protocol state, which
 *     needs a `public.commitments` relation the role has no grant on. Absent
 *     entirely, the query fails 42P01 instead of 42501 and the check reports a
 *     failure that says nothing about the code:
 *       CREATE TABLE public.commitments (id bigint);
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { pgStoreQuery } from './store/atomicStore.js';
import { pgStoreTransactor } from './store/campaignTickJournal.js';
import { resolveBenchmarkWriterConnection } from './benchmarkServingConfig.js';
import { SqlBenchmarkServingPort } from './servingStore.js';
import type { ArmAttempt, AttemptFacts, DecisionSeal, PublishOutcome, RunFacts } from './servingStore.js';
import { projectRun, publishableRun } from './servingProjection.js';
import { publishPlan } from './servingPublisher.js';
import { firedRun } from './servingTestRun.js';
import { decisionDigest, forecastDigest } from './schema.js';
import { makeOverScaleAccepted, makeOverScalePushAccepted } from './testFactories.js';
import type { ForecastOutput } from './types.js';

const HOST = process.env['BENCHMARK_CONFORMANCE_DB_HOST'] ?? 'localhost';
const PORT = Number(process.env['BENCHMARK_CONFORMANCE_DB_PORT'] ?? '5436');
const NAME = process.env['BENCHMARK_CONFORMANCE_DB_NAME'] ?? 'ospex_serving_scratch';
const PASSWORD = process.env['BENCHMARK_CONFORMANCE_DB_PASSWORD'] ?? 'harness_bw_pw';
const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);

const TABLES = [
  'benchmark_runs', 'benchmark_participants', 'benchmark_cohort_participants',
  'benchmark_arm_attempts', 'benchmark_decisions', 'benchmark_decision_reveals',
  'benchmark_decision_rationales', 'benchmark_scores', 'benchmark_scoring_runs',
];

const results: Array<{ name: string; ok: boolean }> = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok    ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const SEALED = '2026-08-09T20:06:00.123456Z';
const DIGEST = (n: number): string => n.toString(16).padStart(64, '0');
const NO_SOURCE = { sourcePath: null, sourceSha256: null };

let nonce = 0;
const cohortName = (label: string): string => `serving-${label}-${process.pid}-${(nonce += 1)}`;

function runFacts(cohortId: string): RunFacts {
  return {
    runId: `${cohortId}-run`, cohortId, slateDate: '2026-08-09', network: 'polygon',
    deploymentRound: 'R5', startedAt: SEALED, bundleSha256: null, planSha256: null,
    promptScaffoldSha256: DIGEST(0xbe), promptScaffoldVersion: 'shadow-smoke-v0.5',
    responseSchemaVersion: 2, baselinePolicyVersion: null, priceVersion: 'prices-v1',
    benchmarkCommit: null, executionPolicy: 'fixed-moneyline-total',
  };
}

const facts = (over: Partial<AttemptFacts> = {}): AttemptFacts => ({
  attemptOrdinal: 0, suppliedMarkets: ['moneyline', 'total'], sent: true, outcome: 'valid',
  requestedModelId: 'model-a', reportedModelId: 'model-a-2026', providerResponseId: 'resp-1',
  httpStatus: 200, providerStopReason: 'end_turn', turnCompleted: true, validationErrors: null,
  requestAt: '2026-08-09T20:05:00.000Z', responseAt: '2026-08-09T20:05:12.000Z',
  latencyMs: 12000, inputTokens: 4200, outputTokens: 900, reasoningTokens: null,
  billableOutputTokens: 900, billableSearchCount: null, searchEvidenceStatus: 'unknown_unproven',
  costUsd: 5.411942, priceVersion: 'prices-v1', ...over,
});

const MODEL = { participantId: 'alpha', kind: 'model' as const, labId: 'alpha', displayName: 'Alpha' };

function armAttempt(cohortId: string, over: Partial<ArmAttempt> = {}): ArmAttempt {
  return {
    run: runFacts(cohortId),
    participant: { ...MODEL, participantId: `${cohortId}-alpha` },
    roster: { armId: 'alpha-v1', walletAddress: null },
    gameId: 'game-1', facts: facts(), source: NO_SOURCE, ...over,
  };
}

function decisionSeal(cohortId: string, over: Partial<DecisionSeal> = {}): DecisionSeal {
  return {
    run: runFacts(cohortId),
    participant: { ...MODEL, participantId: `${cohortId}-alpha` },
    roster: { armId: 'alpha-v1', walletAddress: null },
    gameId: 'game-1', attemptOrdinal: 0, market: 'moneyline', sealedAt: SEALED,
    forecastDigest: DIGEST(1), rationaleDigest: null, bundleSha256: null,
    responseSchemaVersion: 2, contestId: null, speculationId: null, source: NO_SOURCE, ...over,
  };
}

/** Asserts an outcome, printing the whole thing on mismatch — a bare
 *  `assert.equal(out.outcome, ...)` hides the SQLSTATE that explains a failure. */
function expect(out: PublishOutcome, want: PublishOutcome['outcome'], context: string): void {
  assert.equal(out.outcome, want, `${context}: got ${JSON.stringify(out)}`);
}

async function main(): Promise<void> {
  if (!LOCAL.has(HOST) && process.env['BENCHMARK_CONFORMANCE_ALLOW_REMOTE'] !== '1') {
    console.error(
      `refusing to run against a non-local host (${HOST}).\n` +
      'This suite INSERTS rows. The production projection carries zero lifetime\n' +
      'inserts as an evidence property, and PostgreSQL counts an insert even when\n' +
      'its transaction aborts. Set BENCHMARK_CONFORMANCE_ALLOW_REMOTE=1 only for a\n' +
      'remote database you are certain is disposable.',
    );
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    host: HOST, port: PORT, database: NAME, user: 'benchmark_writer', password: PASSWORD,
    // At most 4: the scoped role carries CONNECTION LIMIT 5, and exceeding it
    // returns 53300 rather than a write. A suite that ignores the limit measures
    // its own pool, not the code — 29 of 36 concurrent seals 'lost' that way.
    max: 4, connectionTimeoutMillis: 10_000,
  });
  const query = pgStoreQuery(pool);
  const port = new SqlBenchmarkServingPort({ query, transactor: pgStoreTransactor(pool) });

  const who = await query('select current_user as u', []);
  assert.equal(who[0]?.['u'], 'benchmark_writer', 'the suite must run as the scoped role');
  const present = await query(
    `select count(*)::int as n from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = any($1)`, [TABLES]);
  if (present[0]?.['n'] !== TABLES.length) {
    console.error(
      `expected ${TABLES.length} benchmark_* tables, found ${String(present[0]?.['n'])}.\n` +
      'Apply the benchmark serving-projection migrations to this database first —\n' +
      'see the SETUP block at the top of this file.',
    );
    await pool.end();
    process.exitCode = 1;
    return;
  }

  // ── the write paths ───────────────────────────────────────────────────────

  await check('an attempt lands run, participant, roster and the call in ONE statement', async () => {
    const cohortId = cohortName('attempt');
    expect(await port.publishAttempt(armAttempt(cohortId)), 'published', 'attempt');
    const rows = await query(
      `select a.attempt_ordinal, a.cost_usd, r.run_id, p.kind, c.arm_id
         from public.benchmark_arm_attempts a
         join public.benchmark_runs r on r.run_id = a.run_id
         join public.benchmark_participants p on p.participant_id = a.participant_id
         join public.benchmark_cohort_participants c
           on c.cohort_id = a.cohort_id and c.participant_id = a.participant_id
        where a.cohort_id = $1`, [cohortId]);
    assert.equal(rows.length, 1, 'all four rows exist and join');
    assert.equal(rows[0]!['cost_usd'], '5.411942', 'the cost survived the jsonb hop exactly');
  });

  await check('A FAILED ARM IS PUBLISHABLE, with no decision anywhere', async () => {
    // The opportunity denominator. A refused or non-final call produces an attempt
    // row and zero decisions; if that row were only writable as a side effect of
    // sealing, coverage would be computed over successes only.
    const cohortId = cohortName('failedarm');
    expect(await port.publishAttempt(armAttempt(cohortId, {
      facts: facts({
        sent: false, outcome: 'credential_missing', providerResponseId: null, httpStatus: null,
        providerStopReason: null, turnCompleted: null, responseAt: null, latencyMs: null,
        suppliedMarkets: ['moneyline', 'spread', 'total'],
      }),
    })), 'published', 'failed arm');
    const rows = await query(
      `select count(*)::int as opportunities
         from public.benchmark_arm_attempts a, unnest(a.supplied_markets) m
        where a.cohort_id = $1 and a.attempt_ordinal = 0`, [cohortId]);
    assert.equal(rows[0]!['opportunities'], 3, 'the failed arm occupies three market opportunities');
    const decisions = await query(
      'select count(*)::int as n from public.benchmark_decisions where cohort_id = $1', [cohortId]);
    assert.equal(decisions[0]!['n'], 0, 'and produced no decision');
  });

  await check('a repaired arm publishes BOTH attempt rows', async () => {
    // Ordinal 0 is the initial call and 1 the deterministic format repair.
    // Denominators pin ordinal 0, so writing only the accepted repair would erase
    // the arm from coverage entirely.
    const cohortId = cohortName('repair');
    expect(await port.publishAttempt(armAttempt(cohortId)), 'published', 'ordinal 0');
    expect(await port.publishAttempt(armAttempt(cohortId, {
      facts: facts({ attemptOrdinal: 1, providerResponseId: 'resp-2' }),
    })), 'published', 'ordinal 1');
    expect(await port.sealDecision(decisionSeal(cohortId, { attemptOrdinal: 1 })), 'published', 'seal');
    const rows = await query(
      `select (select count(*)::int from public.benchmark_arm_attempts where cohort_id = $1) as attempts,
              (select a.attempt_ordinal from public.benchmark_decisions d
                 join public.benchmark_arm_attempts a on a.id = d.attempt_id
                where d.cohort_id = $1) as cited`, [cohortId]);
    assert.equal(rows[0]!['attempts'], 2, 'both rows exist');
    assert.equal(rows[0]!['cited'], 1, 'the decision cites the accepted repair');
  });

  await check('a replayed attempt and a replayed seal are both duplicate', async () => {
    const cohortId = cohortName('replay');
    expect(await port.publishAttempt(armAttempt(cohortId)), 'published', 'attempt');
    expect(await port.publishAttempt(armAttempt(cohortId)), 'duplicate', 'attempt replay');
    expect(await port.sealDecision(decisionSeal(cohortId)), 'published', 'seal');
    expect(await port.sealDecision(decisionSeal(cohortId)), 'duplicate', 'seal replay');
    const n = await query(
      'select count(*)::int as n from public.benchmark_decisions where cohort_id = $1', [cohortId]);
    assert.equal(n[0]!['n'], 1);
  });

  await check('THREE MARKETS OF ONE CALL SEAL CONCURRENTLY, and all three land', async () => {
    // The port's primary use case, and the shape that lost two of three when the
    // seal also inserted the attempt: the losers' ON CONFLICT skipped the insert
    // while their snapshot could not yet see the winner's row.
    const cohortId = cohortName('concurrent');
    expect(await port.publishAttempt(armAttempt(cohortId, {
      facts: facts({ suppliedMarkets: ['moneyline', 'spread', 'total'] }),
    })), 'published', 'attempt first');
    const outcomes = await Promise.all((['moneyline', 'spread', 'total'] as const).map((market, i) =>
      port.sealDecision(decisionSeal(cohortId, { market, forecastDigest: DIGEST(0x100 + i) }))));
    assert.deepEqual(outcomes.map((o) => o.outcome), ['published', 'published', 'published'],
      `concurrent seals: ${JSON.stringify(outcomes)}`);
    const rows = await query(
      `select count(*)::int as decisions, count(distinct attempt_id)::int as attempts
         from public.benchmark_decisions where cohort_id = $1`, [cohortId]);
    assert.equal(rows[0]!['decisions'], 3);
    assert.equal(rows[0]!['attempts'], 1, 'all three cite ONE attempt — telemetry counted once');
  });

  await check('A CONCURRENT CONTRADICTION WRITES NOTHING', async () => {
    // The guarantee that a single statement could not provide. Its drift check
    // reads a snapshot taken before the statement began, so a writer committing
    // a conflicting parent in between is invisible: the gate passes and the
    // child lands. Measured that way — 100 conflicting-wallet races all reported
    // `contradiction` and 58 had written their child anyway.
    //
    // The lock is taken as its own command and the write follows as a second
    // one, so the write reads a snapshot that already contains the winner.
    const cohortId = cohortName('concurrent-contradiction');
    const attempts = await Promise.all(Array.from({ length: 16 }, (_, i) =>
      port.publishAttempt(armAttempt(cohortId, {
        roster: { armId: 'v1', walletAddress: `0x${String(i % 10).repeat(40)}` },
        gameId: `game-${i}`,
      }))));
    const published = attempts.filter((o) => o.outcome === 'published').length;
    const kinds = [...new Set(attempts.map((o) => o.outcome))].sort();
    assert.deepEqual(kinds, ['contradiction', 'published'],
      `every write is one or the other: ${JSON.stringify(attempts)}`);
    const stored = await query(
      'select count(*)::int as n from public.benchmark_arm_attempts where cohort_id = $1', [cohortId]);
    assert.equal(stored[0]!['n'], published,
      'exactly the published writes left a row — a contradiction left none');
    const rosters = await query(
      'select count(*)::int as n from public.benchmark_cohort_participants where cohort_id = $1', [cohortId]);
    assert.equal(rosters[0]!['n'], 1, 'one roster row, from the winner');
  });

  await check('a full arm fan-out seals concurrently with NO loss', async () => {
    // The realistic shape at realistic width: twelve arms on one game, each with
    // three markets, all sharing one run row — 12 concurrent attempts then 36
    // concurrent seals. Every one must land; anything less is silent data loss
    // on a benchmark night, which is precisely when this runs.
    const cohortId = cohortName('fanout');
    const ids = Array.from({ length: 12 }, (_, i) => `${cohortId}-p${i}`);
    const attempts = await Promise.all(ids.map((participantId) =>
      port.publishAttempt(armAttempt(cohortId, {
        participant: { ...MODEL, participantId, labId: null },
        facts: facts({ suppliedMarkets: ['moneyline', 'spread', 'total'] }),
      }))));
    assert.deepEqual([...new Set(attempts.map((o) => o.outcome))], ['published'],
      `attempts: ${JSON.stringify(attempts)}`);
    const markets = ['moneyline', 'spread', 'total'] as const;
    const seals = await Promise.all(ids.flatMap((participantId, i) => markets.map((market, j) =>
      port.sealDecision(decisionSeal(cohortId, {
        participant: { ...MODEL, participantId, labId: null },
        market, forecastDigest: DIGEST(0x1000 + i * 8 + j),
      })))));
    assert.deepEqual([...new Set(seals.map((o) => o.outcome))], ['published'],
      `seals: ${JSON.stringify(seals.filter((o) => o.outcome !== 'published'))}`);
    const n = await query(
      'select count(*)::int as n from public.benchmark_decisions where cohort_id = $1', [cohortId]);
    assert.equal(n[0]!['n'], 36, 'all 36 forecasts stored');
  });

  await check('four participants sharing one run row write concurrently without loss', async () => {
    // The other concurrency shape: the conflict target names one unique index, and
    // the redundant composite-FK-target index can raise 23505 instead, aborting the
    // whole statement. Measured at 3-4% before the not-exists guard and the retry.
    const cohortId = cohortName('sharedrun');
    const outcomes = await Promise.all([0, 1, 2, 3].map((i) =>
      port.publishAttempt(armAttempt(cohortId, {
        participant: { ...MODEL, participantId: `${cohortId}-p${i}`, labId: `lab${i}` },
        gameId: `game-${i}`,
      }))));
    assert.deepEqual(outcomes.map((o) => o.outcome), ['published', 'published', 'published', 'published'],
      `shared-run writes: ${JSON.stringify(outcomes)}`);
  });

  await check('a baseline seals with a NULL attempt_id and mints no attempt', async () => {
    const cohortId = cohortName('baseline');
    expect(await port.sealDecision(decisionSeal(cohortId, {
      participant: { participantId: `${cohortId}-fav`, kind: 'baseline', labId: null, displayName: 'Favourite' },
      roster: { armId: null, walletAddress: null }, attemptOrdinal: null,
      market: 'spread', forecastDigest: DIGEST(5),
    })), 'published', 'baseline seal');
    const rows = await query(
      `select d.attempt_id,
              (select count(*)::int from public.benchmark_arm_attempts where cohort_id = $1) as attempts
         from public.benchmark_decisions d where d.cohort_id = $1`, [cohortId]);
    assert.equal(rows[0]!['attempt_id'], null);
    assert.equal(rows[0]!['attempts'], 0);
  });

  await check('a seal whose attempt was never published is parent_missing, not a silent drop', async () => {
    const cohortId = cohortName('noattempt');
    expect(await port.sealDecision(decisionSeal(cohortId)), 'parent_missing', 'seal without attempt');
    const n = await query(
      'select count(*)::int as n from public.benchmark_decisions where cohort_id = $1', [cohortId]);
    assert.equal(n[0]!['n'], 0);
  });

  // ── contradictions ────────────────────────────────────────────────────────

  await check('a seal that CONTRADICTS the stored commitment is reported, not swallowed', async () => {
    const cohortId = cohortName('contradict');
    await port.publishAttempt(armAttempt(cohortId));
    expect(await port.sealDecision(decisionSeal(cohortId, { forecastDigest: DIGEST(0xaa) })),
      'published', 'first seal');
    const out = await port.sealDecision(decisionSeal(cohortId, { forecastDigest: DIGEST(0xbb) }));
    expect(out, 'contradiction', 'second seal with a different digest');
    assert.equal(out.outcome === 'contradiction' ? out.field : null, 'forecastDigest');
    const stored = await query(
      'select forecast_digest from public.benchmark_decisions where cohort_id = $1', [cohortId]);
    assert.equal(stored[0]!['forecast_digest'], DIGEST(0xaa), 'the original commitment stands');
    // Negative control: the SAME digest replayed is a plain duplicate, so the
    // contradiction branch is discriminating rather than firing on every replay.
    expect(await port.sealDecision(decisionSeal(cohortId, { forecastDigest: DIGEST(0xaa) })),
      'duplicate', 'identical replay');
  });

  await check('a wallet supplied after the roster exists is reported, not silently dropped', async () => {
    // First write wins and the writer holds no UPDATE, so a later wallet is not
    // stored. The wallet is the join key to an on-chain fill; losing it quietly
    // would kill that join for the whole cohort.
    const cohortId = cohortName('wallet-late');
    expect(await port.publishAttempt(armAttempt(cohortId)), 'published', 'no wallet');
    const out = await port.publishAttempt(armAttempt(cohortId, {
      roster: { armId: 'alpha-v1', walletAddress: `0x${'4'.repeat(40)}` },
      facts: facts({ attemptOrdinal: 1 }),
    }));
    expect(out, 'contradiction', 'wallet arriving late');
    assert.equal(out.outcome === 'contradiction' ? out.field : null, 'roster.walletAddress');
  });

  await check('one wallet cannot bind two participants in a cohort', async () => {
    // What stops a wallet acting as both maker and benchmark taker in one run, and
    // the reason the roster conflict targets its primary key rather than being a
    // bare `do nothing`. Deliberately NOT in the retry allowlist.
    const cohortId = cohortName('wallet-share');
    const wallet = `0x${'2'.repeat(40)}`;
    expect(await port.publishAttempt(armAttempt(cohortId, {
      participant: { ...MODEL, participantId: `${cohortId}-a`, labId: 'a' },
      roster: { armId: 'v1', walletAddress: wallet },
    })), 'published', 'first participant');
    const out = await port.publishAttempt(armAttempt(cohortId, {
      participant: { ...MODEL, participantId: `${cohortId}-b`, labId: 'b' },
      roster: { armId: 'v1', walletAddress: wallet }, gameId: 'game-2',
    }));
    expect(out, 'refused', 'second participant on the same wallet');
    assert.equal(out.outcome === 'refused' ? out.constraint : null, 'uq_benchmark_cohort_wallet');
  });

  await check('a forecast citing an attempt from another run is REFUSED, leaving nothing behind', async () => {
    // The composite foreign key exists so a re-run of the same slate cannot bind
    // this run's forecast to a stale execution's tokens, latency and cost. A single
    // statement is one transaction, so the run row minted alongside must be gone.
    const cohortId = cohortName('staleattempt');
    const orphanRunId = `${cohortId}-run-2`;
    await port.publishAttempt(armAttempt(cohortId));
    const out = await port.sealDecision(decisionSeal(cohortId, {
      run: { ...runFacts(cohortId), runId: orphanRunId }, market: 'total', forecastDigest: DIGEST(7),
    }));
    expect(out, 'refused', 'seal citing another run');
    assert.equal(out.outcome === 'refused' ? out.sqlstate : null, '23503');
    const n = await query(
      'select count(*)::int as n from public.benchmark_runs where run_id = $1', [orphanRunId]);
    assert.equal(n[0]!['n'], 0, 'no partial run row survived the refusal');
  });

  // ── EVERY COLUMN LANDS WHERE THE INSERT LIST SAYS ─────────────────────────

  await check('EVERY attempt column round-trips to its own column, not a neighbour', async () => {
    // The record-to-INSERT hop inside each statement is positional, and no string
    // test can see two same-typed columns swapped. Measured: four such swaps
    // survived both suites. Every value below is unique to its column, so one
    // comparison kills the whole class at once.
    const cohortId = cohortName('roundtrip-attempt');
    await port.publishAttempt(armAttempt(cohortId, {
      roster: { armId: 'ARM-ID', walletAddress: null },
      facts: facts({
        attemptOrdinal: 1, suppliedMarkets: ['spread'], sent: true, outcome: 'OUTCOME',
        requestedModelId: 'REQUESTED', reportedModelId: 'REPORTED', providerResponseId: 'RESPONSE-ID',
        httpStatus: 201, providerStopReason: 'STOP-REASON', turnCompleted: false,
        validationErrors: ['VALIDATION-ERROR'],
        requestAt: '2026-08-09T01:01:01.000Z', responseAt: '2026-08-09T02:02:02.000Z',
        latencyMs: 111, inputTokens: 222, outputTokens: 333, reasoningTokens: 444,
        billableOutputTokens: 555, billableSearchCount: 666, searchEvidenceStatus: 'EVIDENCE-STATUS',
        costUsd: 7.777777, priceVersion: 'PRICE-VERSION',
      }),
      source: { sourcePath: 'SOURCE-PATH', sourceSha256: DIGEST(0x5e) },
    }));
    const rows = await query(
      'select * from public.benchmark_arm_attempts where cohort_id = $1', [cohortId]);
    const stored = rows[0]!;
    const want: Record<string, unknown> = {
      attempt_ordinal: 1, sent: true, outcome: 'OUTCOME', requested_model_id: 'REQUESTED',
      reported_model_id: 'REPORTED', provider_response_id: 'RESPONSE-ID', http_status: 201,
      provider_stop_reason: 'STOP-REASON', turn_completed: false, latency_ms: 111,
      input_tokens: 222, output_tokens: 333, reasoning_tokens: 444, billable_output_tokens: 555,
      billable_search_count: 666, search_evidence_status: 'EVIDENCE-STATUS',
      cost_usd: '7.777777', price_version: 'PRICE-VERSION', source_path: 'SOURCE-PATH',
      source_sha256: DIGEST(0x5e), game_id: 'game-1', deployment_round: 'R5',
    };
    for (const [column, expected] of Object.entries(want)) {
      assert.deepEqual(stored[column], expected, `${column} holds the wrong value`);
    }
    assert.deepEqual(stored['supplied_markets'], ['spread']);
    assert.deepEqual(stored['validation_errors'], ['VALIDATION-ERROR']);
    assert.equal((stored['request_at'] as Date).toISOString(), '2026-08-09T01:01:01.000Z');
    assert.equal((stored['response_at'] as Date).toISOString(), '2026-08-09T02:02:02.000Z');
  });

  await check('EVERY run and decision column round-trips to its own column', async () => {
    const cohortId = cohortName('roundtrip-run');
    const run: RunFacts = {
      ...runFacts(cohortId), bundleSha256: DIGEST(0xb1), planSha256: DIGEST(0xb2),
      promptScaffoldSha256: DIGEST(0xb3), promptScaffoldVersion: 'SCAFFOLD-VERSION',
      responseSchemaVersion: 7, baselinePolicyVersion: 'BASELINE-POLICY',
      priceVersion: 'RUN-PRICE', benchmarkCommit: 'COMMIT', executionPolicy: 'EXECUTION-POLICY',
    };
    await port.publishAttempt(armAttempt(cohortId, { run }));
    await port.sealDecision(decisionSeal(cohortId, {
      run, contestId: 'CONTEST', speculationId: 'SPECULATION', rationaleDigest: DIGEST(0xd2),
      bundleSha256: DIGEST(0xd3), responseSchemaVersion: 9, forecastDigest: DIGEST(0xd1),
      source: { sourcePath: 'DECISION-PATH', sourceSha256: DIGEST(0xd4) },
    }));
    const r = (await query('select * from public.benchmark_runs where cohort_id = $1', [cohortId]))[0]!;
    for (const [column, expected] of Object.entries({
      bundle_sha256: DIGEST(0xb1), plan_sha256: DIGEST(0xb2), prompt_scaffold_sha256: DIGEST(0xb3),
      prompt_scaffold_version: 'SCAFFOLD-VERSION', response_schema_version: 7,
      baseline_policy_version: 'BASELINE-POLICY', price_version: 'RUN-PRICE',
      benchmark_commit: 'COMMIT', execution_policy: 'EXECUTION-POLICY', deployment_round: 'R5',
    })) assert.deepEqual(r[column], expected, `benchmark_runs.${column} holds the wrong value`);

    const d = (await query('select * from public.benchmark_decisions where cohort_id = $1', [cohortId]))[0]!;
    for (const [column, expected] of Object.entries({
      contest_id: 'CONTEST', speculation_id: 'SPECULATION', forecast_digest: DIGEST(0xd1),
      rationale_digest: DIGEST(0xd2), bundle_sha256: DIGEST(0xd3), response_schema_version: 9,
      source_path: 'DECISION-PATH', source_sha256: DIGEST(0xd4), market: 'moneyline',
    })) assert.deepEqual(d[column], expected, `benchmark_decisions.${column} holds the wrong value`);
  });

  // The checks that prove the commitment is worth anything: seal a real
  // forecastDigest(), reveal the SAME forecast through the port, read the row
  // back out of PostgreSQL, recompute the digest from what was stored, and
  // require it to equal the seal.
  //
  // Both fixtures are deliberately over-scale, and it takes two of them because
  // the validator refuses a non-zero push on any fractional line while a line is
  // over-scale only when it is fractional — so no single forecast can exercise
  // the rounding of BOTH the line and the push:
  //
  //   the spread   line, observedDecimal, win, loss and confidence all carry
  //                more decimals than their columns hold; push is 0.
  //   the total    a whole-number line, so push carries an over-scale value —
  //                the only shape in which that column is ever exercised with
  //                anything but zero.
  //
  // Hashing the raw value and storing the rounded one produced two different
  // digests with nothing anywhere reporting a problem; that is the failure this
  // exists to keep out. Note that the RAW values are handed to revealDecision,
  // exactly as a producer would: the port quantises them through the same module
  // the digest does, which is what makes the two agree without the caller having
  // to remember anything.
  const roundTrips: Array<[string, () => { forecast: ForecastOutput; errors: readonly string[] },
                           Record<string, string>]> = [
    ['a SPREAD over-scale in line, price, win, loss and confidence', makeOverScaleAccepted, {
      line: '1.5234', observed_decimal: '2.053714', prob_win: '0.52312346',
      prob_push: '0.00000000', prob_loss: '0.47687653', confidence: '0.61371235',
    }],
    ['a whole-number TOTAL carrying an over-scale PUSH', makeOverScalePushAccepted, {
      line: '8.0000', observed_decimal: '1.909090', prob_win: '0.48765432',
      prob_push: '0.06172839', prob_loss: '0.45061728', confidence: '0.55432110',
    }],
  ];

  for (const [label, make, atColumnScale] of roundTrips) {
    await check(`A SEALED DIGEST SURVIVES THE REVEAL ROUND TRIP: ${label}`, async () => {
      const { forecast, errors } = make();
      // The round trip only means something if it starts from input a producer
      // could actually have been handed, so the validator's verdict is asserted
      // rather than assumed. An earlier version of this check cast a hand-written
      // object through `as unknown` and used probabilities summing to 1.33 — it
      // would never have reached this code path in life.
      assert.deepEqual(errors, [], 'the over-scale forecast must be one the validator accepts');
      const sealed = forecastDigest(forecast);

      // The attempt, the seal and the reveal all have to be about the fixture's
      // OWN market. Storing it under the default moneyline key would still pass
      // — `market` is outside the digest and the numeric columns are shared —
      // which is exactly why it would prove nothing: the validator's verdict
      // would be about a different decision from the one written.
      const market = forecast.market;
      const cohortId = cohortName('digest-roundtrip');
      const decision = { cohortId, participantId: `${cohortId}-alpha`, gameId: 'game-1', market };
      await port.publishAttempt(armAttempt(cohortId, { facts: facts({ suppliedMarkets: [market] }) }));
      expect(
        await port.sealDecision(decisionSeal(cohortId, { market, forecastDigest: sealed })),
        'published', 'seal'
      );
      expect(await port.revealDecision({
        decision, revealedAt: '2026-08-09T20:40:00.000Z', selection: forecast.selection,
        line: forecast.line, observedDecimal: forecast.observedDecimal,
        probWin: forecast.probabilities.win, probPush: forecast.probabilities.push,
        probLoss: forecast.probabilities.loss, confidence: forecast.confidence,
        wouldAbstain: forecast.wouldAbstain, selectedForExecution: forecast.selectedForExecution,
        reasonCode: null,
        axisValuation: forecast.axes!.valuation, axisTrend: forecast.axes!.trend,
        axisConsensus: forecast.axes!.consensus, axisNews: forecast.axes!.news,
        axisSoftness: forecast.axes!.softness,
        primaryAxis: forecast.primaryAxis!, primaryExpectation: forecast.primaryExpectation!,
        source: NO_SOURCE,
      }), 'published', 'reveal');

      const stored = (await query(
        `select r.*, d.forecast_digest, d.market from public.benchmark_decision_reveals r
           join public.benchmark_decisions d on d.id = r.decision_id where d.cohort_id = $1`, [cohortId]))[0]!;
      assert.equal(stored['forecast_digest'], sealed, 'the seal did not store the digest it was given');
      // The row written must be about the decision the validator accepted. Without
      // this the check passes with the two out of step, since market is outside
      // the digest and every numeric column is shared across markets.
      assert.equal(stored['market'], forecast.market, 'stored a different market from the one validated');

      // Rebuild the forecast from the REVEALED row and recompute.
      const revealed = {
        ...forecast,
        selection: String(stored['selection']),
        line: Number(stored['line']),
        observedDecimal: Number(stored['observed_decimal']),
        probabilities: {
          win: Number(stored['prob_win']),
          push: Number(stored['prob_push']),
          loss: Number(stored['prob_loss']),
        },
        confidence: Number(stored['confidence']),
        axes: {
          valuation: Number(stored['axis_valuation']), trend: Number(stored['axis_trend']),
          consensus: Number(stored['axis_consensus']), news: Number(stored['axis_news']),
          softness: Number(stored['axis_softness']),
        },
        primaryAxis: stored['primary_axis'],
        primaryExpectation: stored['primary_expectation'],
      } as unknown as ForecastOutput;
      assert.equal(
        forecastDigest(revealed), sealed,
        'the digest recomputed from the revealed row does not match the seal — the commitment is unverifiable'
      );

      // And the stored decimals really are at the column scale, so this passed
      // for the right reason rather than because PostgreSQL happened to keep
      // them. Every numeric the digest covers is read back, prob_push included:
      // a column nobody reads back is a column that can be written wrong.
      //
      // What this pins, measured by removing the port's quantiser one column at
      // a time: ALL SIX redden. Every fixture value sits where `toFixed` and
      // PostgreSQL's own numeric rounding disagree — the spread carries line,
      // observed_decimal, win, loss and confidence; the total carries push,
      // which only a whole-number line admits.
      //
      // An earlier version of this comment claimed three of them could not be
      // pinned: a whole-number line has nothing to round, a boundary price could
      // not stay one americanToDecimal emits, and the third probability was
      // fixed by the other two summing to 1. The first two are true OF THE TOTAL
      // FIXTURE and were quietly generalised to both; the third was simply
      // wrong, since the validator's tolerance is 1e-6 and not zero. While that
      // was believed, the line, observed_decimal and prob_loss quantisers could
      // each be deleted with all 27 checks still passing.
      assert.deepEqual(
        {
          line: stored['line'], observed_decimal: stored['observed_decimal'],
          prob_win: stored['prob_win'], prob_push: stored['prob_push'],
          prob_loss: stored['prob_loss'], confidence: stored['confidence'],
        },
        atColumnScale
      );
    });
  }

  await check('EVERY quantised column has a fixture PostgreSQL rounds differently', async () => {
    // The round trips above only pin the port's quantiser for a column when the
    // fixture value for it sits where `toFixed` and PostgreSQL's own numeric
    // rounding DISAGREE. Where they agree, deleting that column's quantiser
    // changes nothing and the check stays green — measured, three columns were
    // in exactly that state.
    //
    // So the property is asserted here rather than left to whoever picked the
    // numbers. Tidy a fixture value and this goes red naming the column, which
    // is a far better failure than a quantiser quietly ceasing to be tested.
    const columns = [
      ['line', 'numeric(10,4)', 4],
      ['observed_decimal', 'numeric(12,6)', 6],
      ['prob_win', 'numeric(9,8)', 8],
      ['prob_push', 'numeric(9,8)', 8],
      ['prob_loss', 'numeric(9,8)', 8],
      ['confidence', 'numeric(9,8)', 8],
    ] as const;
    const rawValues = (f: ForecastOutput): Record<string, number | null> => ({
      line: f.line,
      observed_decimal: f.observedDecimal,
      prob_win: f.probabilities.win,
      prob_push: f.probabilities.push,
      prob_loss: f.probabilities.loss,
      confidence: f.confidence,
    });
    const fixtures = [
      ['spread', rawValues(makeOverScaleAccepted().forecast)],
      ['total', rawValues(makeOverScalePushAccepted().forecast)],
    ] as const;

    const unpinned: string[] = [];
    const pinnedBy: string[] = [];
    for (const [column, type, scale] of columns) {
      const discriminating: string[] = [];
      for (const [fixture, values] of fixtures) {
        const value = values[column];
        if (value === null || value === undefined) continue;
        const stored = (await query(`select ($1::${type})::text as v`, [String(value)]))[0]!['v'];
        if (Number(stored) !== Number(value.toFixed(scale))) discriminating.push(fixture);
      }
      if (discriminating.length === 0) unpinned.push(column);
      else pinnedBy.push(`${column}<-${discriminating.join('+')}`);
    }
    assert.deepEqual(unpinned, [],
      `these columns' quantisers are not pinned by any fixture — their values round the ` +
      `same way in JavaScript and in PostgreSQL, so removing the quantiser would change ` +
      `nothing. Pinned: ${pinnedBy.join(', ')}`);
  });

  await check('EVERY reveal and score column round-trips to its own column', async () => {
    const cohortId = cohortName('roundtrip-reveal');
    const decision = { cohortId, participantId: `${cohortId}-alpha`, gameId: 'game-1', market: 'moneyline' as const };
    await port.publishAttempt(armAttempt(cohortId));
    await port.sealDecision(decisionSeal(cohortId));
    expect(await port.revealDecision({
      decision, revealedAt: '2026-08-09T20:40:00.000Z', selection: 'SELECTION',
      line: 1.5, observedDecimal: 2.25, probWin: 0.11, probPush: 0.22, probLoss: 0.33,
      confidence: 0.44, wouldAbstain: true, selectedForExecution: false, reasonCode: 'REASON-CODE',
      axisValuation: 1, axisTrend: 2, axisConsensus: 3, axisNews: 4, axisSoftness: 5,
      primaryAxis: 'softness', primaryExpectation: 'PRIMARY-EXPECTATION',
      source: { sourcePath: 'REVEAL-PATH', sourceSha256: null },
    }), 'published', 'reveal');
    const v = (await query(
      `select r.* from public.benchmark_decision_reveals r
         join public.benchmark_decisions d on d.id = r.decision_id where d.cohort_id = $1`, [cohortId]))[0]!;
    for (const [column, expected] of Object.entries({
      selection: 'SELECTION', line: '1.5000', observed_decimal: '2.250000',
      prob_win: '0.11000000', prob_push: '0.22000000', prob_loss: '0.33000000',
      confidence: '0.44000000', would_abstain: true, selected_for_execution: false,
      reason_code: 'REASON-CODE', axis_valuation: 1, axis_trend: 2, axis_consensus: 3,
      axis_news: 4, axis_softness: 5, primary_axis: 'softness',
      primary_expectation: 'PRIMARY-EXPECTATION', source_path: 'REVEAL-PATH',
    })) assert.deepEqual(v[column], expected, `benchmark_decision_reveals.${column} holds the wrong value`);

    expect(await port.publishScore({
      decision, scoringPolicyVersion: 'POLICY', economicClvPct: 1.111111,
      marginAdjustedClvPct: 2.222222, devigMethod: 'DEVIG', ladderVersion: 'LADDER',
      ladderParamVersion: 'LADDER-PARAM', refused: true, refusalReason: 'REFUSAL-REASON',
      scheduleChanged: true, heldOutOfPrimary: false, closeDecimalSelected: 3.333333,
      closeDecimalOpposing: 4.444444, closeLine: 5.5555, lineMovementFavorable: 6.6666,
      scoredAt: '2026-08-10T04:00:00.000Z', source: { sourcePath: 'SCORE-PATH', sourceSha256: null },
    }), 'published', 'score');
    const s = (await query(
      `select s.* from public.benchmark_scores s
         join public.benchmark_decisions d on d.id = s.decision_id where d.cohort_id = $1`, [cohortId]))[0]!;
    for (const [column, expected] of Object.entries({
      scoring_policy_version: 'POLICY', economic_clv_pct: '1.111111',
      margin_adjusted_clv_pct: '2.222222', devig_method: 'DEVIG', ladder_version: 'LADDER',
      ladder_param_version: 'LADDER-PARAM', refused: true, refusal_reason: 'REFUSAL-REASON',
      schedule_changed: true, held_out_of_primary: false, close_decimal_selected: '3.333333',
      close_decimal_opposing: '4.444444', close_line: '5.5555', line_movement_favorable: '6.6666',
      source_path: 'SCORE-PATH',
    })) assert.deepEqual(s[column], expected, `benchmark_scores.${column} holds the wrong value`);
  });

  // ── the reveal's insert-once and chronology properties ────────────────────

  await check('the reveal copies the parent seal instant to the microsecond', async () => {
    const cohortId = cohortName('reveal-seal');
    const decision = { cohortId, participantId: `${cohortId}-alpha`, gameId: 'game-1', market: 'moneyline' as const };
    await port.publishAttempt(armAttempt(cohortId));
    await port.sealDecision(decisionSeal(cohortId));
    expect(await port.revealDecision({
      decision, revealedAt: '2026-08-09T20:40:00.000Z', selection: 'home', line: null,
      observedDecimal: null, probWin: null, probPush: null, probLoss: null, confidence: null,
      wouldAbstain: null, selectedForExecution: null, reasonCode: null, axisValuation: null,
      axisTrend: null, axisConsensus: null, axisNews: null, axisSoftness: null,
      primaryAxis: null, primaryExpectation: null, source: NO_SOURCE,
    }), 'published', 'reveal');
    const rows = await query(
      `select r.sealed_at = d.sealed_at as same,
              to_char(r.sealed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as us
         from public.benchmark_decision_reveals r
         join public.benchmark_decisions d on d.id = r.decision_id
        where d.cohort_id = $1`, [cohortId]);
    assert.equal(rows[0]!['same'], true, 'the copied seal instant equals the parent');
    assert.equal(rows[0]!['us'], '2026-08-09T20:06:00.123456', 'to the microsecond');
  });

  await check('a published pick can be neither edited nor retracted', async () => {
    const cohortId = cohortName('revealonce');
    const decision = { cohortId, participantId: `${cohortId}-alpha`, gameId: 'game-1', market: 'moneyline' as const };
    const blank = {
      decision, line: null, observedDecimal: null, probWin: null, probPush: null, probLoss: null,
      confidence: null, wouldAbstain: null, selectedForExecution: null, reasonCode: null,
      axisValuation: null, axisTrend: null, axisConsensus: null, axisNews: null, axisSoftness: null,
      primaryAxis: null, primaryExpectation: null, source: NO_SOURCE,
    };
    await port.publishAttempt(armAttempt(cohortId));
    await port.sealDecision(decisionSeal(cohortId));
    expect(await port.revealDecision({ ...blank, revealedAt: '2026-08-09T20:40:00.000Z', selection: 'home' }),
      'published', 'first reveal');
    expect(await port.revealDecision({ ...blank, revealedAt: '2026-08-09T21:00:00.000Z', selection: 'away' }),
      'duplicate', 'second reveal');
    const rows = await query(
      `select r.selection from public.benchmark_decision_reveals r
         join public.benchmark_decisions d on d.id = r.decision_id where d.cohort_id = $1`, [cohortId]);
    assert.equal(rows[0]!['selection'], 'home', 'the original selection stands');
  });

  await check('a reveal stamped before its own seal is refused by the database', async () => {
    const cohortId = cohortName('chronology');
    const decision = { cohortId, participantId: `${cohortId}-alpha`, gameId: 'game-1', market: 'moneyline' as const };
    await port.publishAttempt(armAttempt(cohortId));
    await port.sealDecision(decisionSeal(cohortId));
    const out = await port.revealDecision({
      decision, revealedAt: '2026-08-09T19:00:00.000Z', selection: 'home', line: null,
      observedDecimal: null, probWin: null, probPush: null, probLoss: null, confidence: null,
      wouldAbstain: null, selectedForExecution: null, reasonCode: null, axisValuation: null,
      axisTrend: null, axisConsensus: null, axisNews: null, axisSoftness: null,
      primaryAxis: null, primaryExpectation: null, source: NO_SOURCE,
    });
    expect(out, 'refused', 'reveal before seal');
    assert.equal(out.outcome === 'refused' ? out.constraint : null, 'benchmark_reveals_not_before_seal');
  });

  await check('rationale and scoring run land, and a rescore adds a row beside the old one', async () => {
    const cohortId = cohortName('tail');
    const decision = { cohortId, participantId: `${cohortId}-alpha`, gameId: 'game-1', market: 'moneyline' as const };
    await port.publishAttempt(armAttempt(cohortId));
    await port.sealDecision(decisionSeal(cohortId, { rationaleDigest: DIGEST(0x10) }));
    expect(await port.publishRationale({
      decision, rationale: 'the number looks soft', evidenceRefs: ['ref-1', 'ref-2'], source: NO_SOURCE,
    }), 'published', 'rationale');
    const base = {
      decision, marginAdjustedClvPct: null, devigMethod: null, ladderVersion: null,
      ladderParamVersion: null, refused: false, refusalReason: null, scheduleChanged: null,
      heldOutOfPrimary: null, closeDecimalSelected: null, closeDecimalOpposing: null,
      closeLine: null, lineMovementFavorable: null, scoredAt: '2026-08-10T04:00:00.000Z',
      source: NO_SOURCE,
    };
    expect(await port.publishScore({ ...base, scoringPolicyVersion: 'v6', economicClvPct: 1 }),
      'published', 'v6');
    expect(await port.publishScore({ ...base, scoringPolicyVersion: 'v6', economicClvPct: 99 }),
      'duplicate', 'same version again');
    expect(await port.publishScore({ ...base, scoringPolicyVersion: 'v7', economicClvPct: 2 }),
      'published', 'v7');
    expect(await port.publishScoringRun({
      cohortId, scoringPolicyVersion: 'v6', eligible: 2, scored: 1, refused: 1,
      scheduleHeldOut: 0, refusalReasons: { no_close: 1 }, rankingAllowed: false,
      rankingReason: 'n is descriptive noise, not ranking evidence', costPerPickComparable: false,
      benchmarkCommit: null, scoredAt: '2026-08-10T04:00:00.000Z', source: NO_SOURCE,
    }), 'published', 'scoring run');

    const rows = await query(
      `select (select count(*)::int from public.benchmark_decision_rationales r
                 join public.benchmark_decisions d on d.id = r.decision_id where d.cohort_id = $1) as rationales,
              (select count(*)::int from public.benchmark_scores s
                 join public.benchmark_decisions d on d.id = s.decision_id where d.cohort_id = $1) as scores,
              (select s.economic_clv_pct from public.benchmark_scores s
                 join public.benchmark_decisions d on d.id = s.decision_id
                where d.cohort_id = $1 and s.scoring_policy_version = 'v6') as first_score,
              (select refusal_reasons from public.benchmark_scoring_runs where cohort_id = $1) as reasons`,
      [cohortId]);
    assert.equal(rows[0]!['rationales'], 1);
    assert.equal(rows[0]!['scores'], 2, 'both scores are retained');
    assert.equal(rows[0]!['first_score'], '1.000000', 'the superseded score was NOT overwritten');
    assert.deepEqual(rows[0]!['reasons'], { no_close: 1 }, 'the jsonb histogram round-tripped');
  });

  await check('a child whose decision does not exist is parent_missing, not an error', async () => {
    const decision = { cohortId: cohortName('nodecision'), participantId: 'nobody', gameId: 'g', market: 'total' as const };
    expect(await port.publishRationale({ decision, rationale: 'x', evidenceRefs: [], source: NO_SOURCE }),
      'parent_missing', 'rationale');
    expect(await port.revealDecision({
      decision, revealedAt: SEALED, selection: 'over', line: null, observedDecimal: null,
      probWin: null, probPush: null, probLoss: null, confidence: null, wouldAbstain: null,
      selectedForExecution: null, reasonCode: null, axisValuation: null, axisTrend: null,
      axisConsensus: null, axisNews: null, axisSoftness: null, primaryAxis: null,
      primaryExpectation: null, source: NO_SOURCE,
    }), 'parent_missing', 'reveal');
  });

  // ── negative controls: the grant is what makes the guarantees real ────────

  await check('the resolver agrees with what the DRIVER actually does about TLS', async () => {
    // Asserting the returned object is not enough and never was: the driver
    // parses SSL out of the connection string and overrides what it is handed.
    // This builds a real client for each shape and compares the claim against
    // `connectionParameters.ssl`. It opens no connection.
    const saved = { ...process.env };
    try {
      // The host is h.example.com throughout, so every `refuse` below is the
      // plaintext-to-another-machine rule and not something else.
      const cases: ReadonlyArray<readonly [string, 'tls' | 'defer' | 'refuse']> = [
        ['', 'tls'],
        ['?application_name=sslmode%3Ddisable', 'tls'],
        ['?sslmode=', 'tls'], //                  empty: the driver ignores it entirely
        ['?sslmode=disable', 'refuse'], //        the credential would go out in clear
        ['?sslmode=no-verify', 'defer'],
        ['?%73slmode=disable', 'refuse'], //      the driver decodes the key
        ['?ssl=', 'refuse'], //                   empty ssl= becomes "" -> no TLS
        ['?sslmode=bogus', 'defer'],
        // Not named anywhere in the resolver: it asks the driver's parser.
        ['?sslnegotiation=direct', 'defer'],
        // Duplicates: the driver keeps the LAST, and that is the answer used.
        ['?sslmode=require&sslmode=', 'tls'], //  last is empty -> ignored
        ['?sslmode=&sslmode=require', 'defer'], //last wins -> {}
        ['?ssl=1&ssl=', 'refuse'], //             last wins -> "" -> no TLS
        ['?ssl=&ssl=1', 'defer'], //              last wins -> true
        // Every value the ssl= family can carry, deferred to without judging it.
        ['?ssl=true', 'defer'],
        ['?ssl=false', 'defer'], //               the truthy STRING "false"
        ['?ssl=0', 'refuse'], //                  genuinely falsy -> no TLS
        ['?ssl=1', 'defer'],
        ['?ssl=no-verify', 'defer'],
      ];
      for (const [query, want] of cases) {
        const dsn = `postgresql://u:p@h.example.com:5432/db${query}`;
        process.env['BENCHMARK_DB_URL'] = dsn;
        process.env['BENCHMARK_DB_CA'] = 'PEM-CA';
        delete process.env['BENCHMARK_WRITER'];
        // Both would move a case between branches if the shell exported them.
        delete process.env['BENCHMARK_DB_ALLOW_PLAINTEXT'];
        delete process.env['PGHOST'];
        const resolution = resolveBenchmarkWriterConnection();
        if (want === 'refuse') {
          assert.deepEqual(resolution, { resolved: false, reason: 'plaintext_dsn' },
            `${query || '(none)'} must be refused as plaintext`);
          continue;
        }
        assert.ok(resolution.resolved && resolution.connection.kind === 'dsn', query);
        const claimed = resolution.connection.ssl;
        const client = new Client({ connectionString: dsn, ...(claimed ? { ssl: claimed } : {}) });
        const effective = (client as unknown as { connectionParameters: { ssl: unknown } })
          .connectionParameters.ssl;
        if (want === 'tls') {
          assert.deepEqual(effective, { rejectUnauthorized: true, ca: 'PEM-CA' },
            `${query || '(none)'}: the CA the resolver promised must be the CA the driver uses`);
        } else {
          assert.equal(claimed, undefined, `${query}: the resolver must promise nothing`);
        }
      }
    } finally {
      process.env = saved;
    }
  });

  await check('the role cannot UPDATE or DELETE any of the nine tables', async () => {
    for (const table of TABLES) {
      await assert.rejects(() => query(`delete from public.${table} where true`, []),
        (e: unknown) => (e as { code?: string }).code === '42501', `delete ${table} must be refused`);
    }
    for (const [table, column] of [['benchmark_decisions', 'market'],
      ['benchmark_decision_reveals', 'selection'], ['benchmark_scores', 'devig_method']] as const) {
      await assert.rejects(() => query(`update public.${table} set ${column} = 'x'`, []),
        (e: unknown) => (e as { code?: string }).code === '42501', `update ${table} must be refused`);
    }
  });

  await check('the role reaches no protocol state and no identity sequence', async () => {
    await assert.rejects(() => query('select 1 from public.commitments limit 1', []),
      (e: unknown) => (e as { code?: string }).code === '42501', 'commitments is unreachable');
    for (const seq of ['benchmark_arm_attempts_id_seq', 'benchmark_decisions_id_seq',
      'benchmark_scores_id_seq']) {
      await assert.rejects(() => query(`select currval('public.${seq}')`, []),
        (e: unknown) => (e as { code?: string }).code === '42501', `currval(${seq}) is unreachable`);
    }
  });

  // ── a real fired run, projected and published end to end ──────────────────
  //
  // Everything above builds its payloads by hand. This section builds none: it
  // fires a game through the runner, reads the artifact the runner wrote, and
  // publishes it through the same function the watcher calls. That is the only
  // check that can fail if the PROJECTOR disagrees with the schema — a bad
  // instant format, an over-long identifier, a roster shape the constraints
  // refuse — and because the publisher is fail-soft, the production symptom of
  // any of those is a projection that quietly stays empty.

  const artifactDir = mkdtempSync(join(tmpdir(), 'serving-conformance-'));
  try {
    // A fresh cohort per suite run, exactly like every check above: these
    // tables are append-only and nothing here truncates. The date moves rather
    // than the prefix because the publisher's gate requires the cohort to be
    // in the runner's own namespace, and that check is worth keeping honest.
    const stamp = `${2100 + Math.floor(Math.random() * 800)}-01-${String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')}`;
    const fired = await firedRun({ outDir: artifactDir, enrolled: true });
    const records = fired.records.map((record) => ({
      ...record,
      ...(record['cohortId'] === undefined ? {} : { cohortId: `watch-v0-${stamp}` }),
      ...(record['slateDate'] === undefined ? {} : { slateDate: stamp }),
      ...(record['runId'] === undefined ? {} : { runId: `watch-v0-${stamp}-${randomBytes(3).toString('hex')}` }),
    }));

    const gate = publishableRun(records);
    assert.ok(gate.publishable, `the fired run must be publishable: ${JSON.stringify(gate)}`);
    const plan = projectRun(
      records,
      gate.header,
      { sourcePath: 'conformance.ndjson', sourceSha256: null },
      { now: () => new Date().toISOString() },
    );
    const silent = { line: (): void => {}, error: (message: string): void => console.log(`      ${message}`) };

    await check('a projected run is accepted by the real schema, every row', async () => {
      assert.ok(plan.attempts.length > 0, 'the fired run produced no attempts');
      assert.ok(plan.decisions.length > 0, 'the fired run produced no decisions');
      assert.deepEqual(plan.skipped, [], 'nothing should have been skipped');

      const summary = await publishPlan(port, plan, silent);
      // One write per attempt, plus seal + reveal for every decision, plus a
      // rationale for each model decision. Anything refused shows up here as a
      // shortfall rather than as a log line nobody reads.
      const expected =
        plan.attempts.length +
        plan.decisions.length * 2 +
        plan.decisions.filter((d) => d.rationale !== null).length;
      assert.deepEqual(summary.rejected, {}, 'the schema refused something the projector built');
      assert.equal(summary.published, expected, 'not every projected row landed');
    });

    await check('the commitment survives the round trip through the real numeric columns', async () => {
      // The point of sealing before the game is that a reader can recompute the
      // digest from the published reveal. That only holds if the value the
      // producer hashed is the value PostgreSQL stored — the two round
      // differently at the column's scale, which is why the producer quantises
      // first. This reads the stored row back and does the reader's job.
      const model = plan.decisions.find((d) => d.seal.participant.kind === 'model');
      assert.ok(model, 'need a model decision');
      const rows = await query(
        `select r.selection, r.line, r.observed_decimal, r.prob_win, r.prob_push, r.prob_loss,
                r.confidence, r.would_abstain, r.selected_for_execution,
                r.axis_valuation, r.axis_trend, r.axis_consensus, r.axis_news, r.axis_softness,
                r.primary_axis, r.primary_expectation, d.forecast_digest
           from public.benchmark_decision_reveals r
           join public.benchmark_decisions d on d.id = r.decision_id
          where d.cohort_id = $1 and d.participant_id = $2 and d.game_id = $3 and d.market = $4`,
        [model.seal.run.cohortId, model.seal.participant.participantId, model.seal.gameId, model.seal.market],
      );
      assert.equal(rows.length, 1, 'the reveal was not stored');
      const row = rows[0]!;
      const n = (value: unknown): number | null => (value === null ? null : Number(value));
      const axes = row['axis_valuation'] === null ? null : {
        valuation: Number(row['axis_valuation']), trend: Number(row['axis_trend']),
        consensus: Number(row['axis_consensus']), news: Number(row['axis_news']),
        softness: Number(row['axis_softness']),
      };
      assert.equal(
        decisionDigest({
          selection: String(row['selection']),
          line: n(row['line']),
          observedDecimal: n(row['observed_decimal']),
          win: n(row['prob_win']),
          push: n(row['prob_push']),
          loss: n(row['prob_loss']),
          confidence: n(row['confidence']),
          wouldAbstain: row['would_abstain'] as boolean | null,
          selectedForExecution: row['selected_for_execution'] as boolean | null,
          axes,
          primaryAxis: row['primary_axis'] as never,
          primaryExpectation: row['primary_expectation'] as string | null,
        }),
        row['forecast_digest'],
        'the stored reveal does not reproduce the commitment sealed beside it',
      );
    });

    await check('republishing the same artifact changes nothing and reports duplicates', async () => {
      // This is the recovery path: a write lost to a blip is recovered by
      // running the publisher over the same file again. It has to be a no-op
      // when nothing was lost, or recovery would be its own hazard.
      const before = await query('select count(*)::int as n from public.benchmark_decisions where cohort_id = $1', [plan.cohortId]);
      const summary = await publishPlan(port, plan, silent);
      const after = await query('select count(*)::int as n from public.benchmark_decisions where cohort_id = $1', [plan.cohortId]);

      assert.deepEqual(summary.rejected, {}, 'a republish must refuse nothing');
      assert.equal(summary.published, 0, 'a republish must write nothing new');
      assert.ok(summary.duplicate > 0, 'and must report the rows it found already present');
      assert.equal(after[0]?.['n'], before[0]?.['n'], 'the row count moved');
    });

    await check('a decision sealed under a re-minted runId is refused, never silently split', async () => {
      // This is the hazard that decides what recovery has to mean. The attempt
      // key carries no run, so a second process re-firing the same game
      // resolves the FIRST run's provider call and then tries to hang a
      // decision citing the SECOND run off it. The composite foreign key stops
      // that — a decision must not name a run whose provider call belongs to
      // another one — and the refusal is the correct outcome, not a defect.
      //
      // Staged on a cohort of its own with only the ATTEMPTS published, because
      // once a decision exists the whole thing is absorbed as a duplicate and
      // the key is never evaluated. That is why re-running the publisher over
      // an unchanged artifact is safe while re-firing the game is not.
      const other = `${stamp.slice(0, 4)}-02-${stamp.slice(8)}`;
      // A new run id as well as a new cohort: the run row is keyed on the id
      // alone and its cohort is one of the thirteen facts compared on every
      // later write, so reusing it would be refused as a contradiction long
      // before the foreign key under test was reached.
      const stagedRunId = `watch-v0-${other}-${randomBytes(3).toString('hex')}`;
      const staged = records.map((record) => ({
        ...record,
        ...(record['cohortId'] === undefined ? {} : { cohortId: `watch-v0-${other}` }),
        ...(record['slateDate'] === undefined ? {} : { slateDate: other }),
        ...(record['runId'] === undefined ? {} : { runId: stagedRunId }),
      }));

      const first = publishableRun(staged);
      assert.ok(first.publishable);
      const attemptsOnly = projectRun(staged, first.header, { sourcePath: null, sourceSha256: null }, {
        now: () => new Date().toISOString(),
      });
      const landed = await publishPlan(
        port,
        { ...attemptsOnly, decisions: [] },
        { line: () => {}, error: () => {} },
      );
      assert.equal(landed.published, attemptsOnly.attempts.length, 'the attempts must land first');

      const reMinted = staged.map((record) =>
        record['runId'] === undefined
          ? record
          : { ...record, runId: `watch-v0-${other}-${randomBytes(3).toString('hex')}` },
      );
      const second = publishableRun(reMinted);
      assert.ok(second.publishable);
      const replan = projectRun(reMinted, second.header, { sourcePath: null, sourceSha256: null }, {
        now: () => new Date().toISOString(),
      });
      const summary = await publishPlan(
        port,
        { ...replan, attempts: [] },
        { line: () => {}, error: () => {} },
      );

      // The model decisions cite an attempt and are refused; the controls cite
      // none, so they land under the new run and are the negative control that
      // says the refusal is about the citation rather than about the run id.
      const models = replan.decisions.filter((d) => d.seal.attemptOrdinal !== null).length;
      assert.ok(models > 0, 'need a decision that cites a provider call');
      assert.equal(summary.rejected['refused'], models, 'every citing decision must be refused');
    });
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }

  await pool.end();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} serving-store conformance checks passed`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
