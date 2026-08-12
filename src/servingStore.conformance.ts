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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { pgStoreQuery } from './store/atomicStore.js';
import { pgStoreTransactor } from './store/campaignTickJournal.js';
import { resolveBenchmarkWriterConnection } from './benchmarkServingConfig.js';
import { REQUIRED_SERVING_CAPABILITY } from './benchmarkServingClient.js';
import { SERVING_STATEMENTS, SqlBenchmarkServingPort } from './servingStore.js';
import {
  CONFIGURATION_DIGEST_VERSION,
  canonicalConfigurationText,
  configurationSha256,
} from './participantConfiguration.js';
import type { ParticipantConfiguration } from './participantConfiguration.js';
import type {
  ArmAttempt, AttemptFacts, DecisionSeal, ParticipantFacts, PublishOutcome, RunFacts,
} from './servingStore.js';
import { sha256Hex } from './canonical.js';
import { forecastDigest } from './schema.js';
import { PROJECTION_PARTICIPANTS } from './servingIdentity.js';
import { firedRun } from './servingTestRun.js';
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
  'benchmark_schema_capability',
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

/**
 * A configuration no plausible normalisation leaves alone.
 *
 * All four shipped arms declare `{}` today, and `{}` cannot catch a
 * normalisation bug: it has no keys to reorder, no number to round and no
 * character to re-encode. Each hazard here has something to damage — and the
 * key set is chosen so RFC 8785 order (aa, b, e-acute) differs from
 * PostgreSQL's jsonb order (b, aa, e-acute, by length then bytes). That is
 * what makes the round-trip below prove the VALUE survives rather than the
 * text, which is the only property the digest can rest on.
 */
const AWKWARD_CONFIGURATION = Object.freeze({
  b: 1,
  aa: { nested: true, list: [1, 2] },
  'é': 0.30000000000000004,
});

/**
 * A model entrant.
 *
 * ⚠ `modelId` DERIVES FROM THE PARTICIPANT ID, and that is not decoration.
 *   The entrant key `(lab_id, model_id, configuration)` is unique among
 *   models with NULLS NOT DISTINCT, and it is GLOBAL and insert-once - not
 *   scoped to a cohort. A shared literal here means the second check to run
 *   collides with the first, and a second RUN of this suite collides with
 *   the first run. Measured: 19 of 28 checks failed 23505 on exactly that.
 *   That the index bites this hard is the point; it is proved on purpose
 *   further down rather than worked around here.
 */
const model = (participantId: string, over: Partial<ParticipantFacts> = {}): ParticipantFacts => ({
  participantId,
  kind: 'model',
  labId: 'alpha',
  displayName: 'Alpha',
  modelId: `${participantId}-v1`,
  configuration: AWKWARD_CONFIGURATION,
  ...over,
});

/** A deterministic control. The database refuses one carrying either half of
 *  a model identity, and so does the port — in both directions. */
const CONTROL = {
  kind: 'baseline' as const, labId: null, modelId: null, configuration: null,
};

function armAttempt(cohortId: string, over: Partial<ArmAttempt> = {}): ArmAttempt {
  return {
    run: runFacts(cohortId),
    participant: model(`${cohortId}-alpha`),
    roster: { walletAddress: null },
    gameId: 'game-1', facts: facts(), source: NO_SOURCE, ...over,
  };
}

function decisionSeal(cohortId: string, over: Partial<DecisionSeal> = {}): DecisionSeal {
  return {
    run: runFacts(cohortId),
    participant: model(`${cohortId}-alpha`),
    roster: { walletAddress: null },
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
      `select a.attempt_ordinal, a.cost_usd, r.run_id, p.kind, c.wallet_address,
              p.model_id, p.configuration, p.configuration_sha256,
              p.configuration_digest_version
         from public.benchmark_arm_attempts a
         join public.benchmark_runs r on r.run_id = a.run_id
         join public.benchmark_participants p on p.participant_id = a.participant_id
         join public.benchmark_cohort_participants c
           on c.cohort_id = a.cohort_id and c.participant_id = a.participant_id
        where a.cohort_id = $1`, [cohortId]);
    assert.equal(rows.length, 1, 'all four rows exist and join');
    assert.equal(rows[0]!['cost_usd'], '5.411942', 'the cost survived the jsonb hop exactly');

    // THE ENTRANT IDENTITY, READ BACK OUT OF THE DATABASE.
    //
    // The digest is recomputed from the PARSED row rather than compared against
    // a rendering of it, and that distinction is the whole test: jsonb re-sorts
    // keys by length then bytes, so `configuration::text` is NOT the canonical
    // text the digest was taken over, and a check that compared strings would
    // fail on a correct implementation. What has to hold is that the VALUE
    // survives, so that a reader recomputing the digest from the stored row
    // arrives back at the stored digest.
    const stored = rows[0]!['configuration'] as ParticipantConfiguration;
    assert.equal(rows[0]!['model_id'], `${cohortId}-alpha-v1`);
    assert.equal(rows[0]!['configuration_digest_version'], CONFIGURATION_DIGEST_VERSION);
    assert.equal(configurationSha256(stored), rows[0]!['configuration_sha256'],
      'the stored digest recomputes from the stored configuration');
    assert.equal(configurationSha256(stored), configurationSha256(AWKWARD_CONFIGURATION),
      'and it is the digest of what was sent, so the entrant is the one that ran');
    assert.notEqual(canonicalConfigurationText(stored), JSON.stringify(stored),
      'the fixture must be one where jsonb key order differs from canonical order, ' +
      'or this check cannot tell a value round-trip from a text round-trip');
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
        roster: { walletAddress: `0x${String(i % 10).repeat(40)}` },
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
        participant: model(participantId, { labId: null }),
        facts: facts({ suppliedMarkets: ['moneyline', 'spread', 'total'] }),
      }))));
    assert.deepEqual([...new Set(attempts.map((o) => o.outcome))], ['published'],
      `attempts: ${JSON.stringify(attempts)}`);
    const markets = ['moneyline', 'spread', 'total'] as const;
    const seals = await Promise.all(ids.flatMap((participantId, i) => markets.map((market, j) =>
      port.sealDecision(decisionSeal(cohortId, {
        participant: model(participantId, { labId: null }),
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
        participant: model(`${cohortId}-p${i}`, { labId: `lab${i}` }),
        gameId: `game-${i}`,
      }))));
    assert.deepEqual(outcomes.map((o) => o.outcome), ['published', 'published', 'published', 'published'],
      `shared-run writes: ${JSON.stringify(outcomes)}`);
  });

  await check('a baseline seals with a NULL attempt_id and mints no attempt', async () => {
    const cohortId = cohortName('baseline');
    expect(await port.sealDecision(decisionSeal(cohortId, {
      participant: { ...CONTROL, participantId: `${cohortId}-fav`, displayName: 'Favourite' },
      roster: { walletAddress: null }, attemptOrdinal: null,
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
    assert.equal(out.outcome === 'contradiction' ? out.field : null, 'seal.forecastDigest');
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
      roster: { walletAddress: `0x${'4'.repeat(40)}` },
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
      participant: model(`${cohortId}-a`, { labId: 'a' }),
      roster: { walletAddress: wallet },
    })), 'published', 'first participant');
    const out = await port.publishAttempt(armAttempt(cohortId, {
      participant: model(`${cohortId}-b`, { labId: 'b' }),
      roster: { walletAddress: wallet }, gameId: 'game-2',
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
      roster: { walletAddress: null },
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
    // The seal commits to a digest OF THIS PROSE. The fixture used an arbitrary
    // digest, which was accepted until the binding existed - the shape the
    // binding was added to refuse.
    const prose = 'the number looks soft';
    await port.sealDecision(decisionSeal(cohortId, { rationaleDigest: sha256Hex(prose) }));
    expect(await port.publishRationale({
      decision, rationale: prose, evidenceRefs: ['ref-1', 'ref-2'], source: NO_SOURCE,
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

  await check('EVERY immutable seal fact is compared, not just the forecast digest', async () => {
    // A seal is a commitment, and `on conflict do nothing` absorbs a second one
    // silently unless something compares it. Reproduced before the fix: a replay
    // carrying a DIFFERENT rationaleDigest under the same key was reported
    // `duplicate` - the caller told the write was a benign repeat while the
    // stored row still committed to the original prose.
    const cohortId = cohortName('seal-facts');
    expect(await port.publishAttempt(armAttempt(cohortId)), 'published', 'the attempt');
    expect(await port.sealDecision(decisionSeal(cohortId, {
      rationaleDigest: DIGEST(0xaa),
    })), 'published', 'the original seal');

    // One case per fact, so a drift entry that is dropped later is named rather
    // than lost in an aggregate.
    const cases: ReadonlyArray<readonly [string, Partial<DecisionSeal>]> = [
      ['seal.rationaleDigest', { rationaleDigest: DIGEST(0xbb) }],
      ['seal.sealedAt', { sealedAt: '2026-08-09T21:00:00.000000Z' }],
      ['seal.contestId', { contestId: 'contest-9' }],
      ['seal.speculationId', { speculationId: 'spec-9' }],
      ['seal.bundleSha256', { bundleSha256: DIGEST(0xcc) }],
      ['seal.responseSchemaVersion', { responseSchemaVersion: 1 }],
    ];
    for (const [field, patch] of cases) {
      const out = await port.sealDecision(decisionSeal(cohortId, {
        rationaleDigest: DIGEST(0xaa), ...patch,
      }));
      expect(out, 'contradiction', `a replay changing ${field}`);
      assert.equal(out.outcome === 'contradiction' ? out.field : null, field);
    }

    // NEGATIVE CONTROL: a byte-identical replay is still a duplicate, so this is
    // a comparison rather than a blanket refusal of every second seal.
    expect(await port.sealDecision(decisionSeal(cohortId, { rationaleDigest: DIGEST(0xaa) })),
      'duplicate', 'an identical replay');
  });

  await check('PROSE MUST HASH TO THE DIGEST ITS SEAL COMMITTED TO', async () => {
    // The projection's whole claim about the withheld rationale is that
    // publishing it later is provably the original. Nothing checked that: the
    // seal stored a digest, and `publishRationale` inserted whatever text it was
    // handed. Reproduced before the fix - a replacement rationale landed
    // `published` under a digest of the prose it replaced.
    const cohortId = cohortName('rationale-binding');
    const prose = 'the original rationale, as sealed';
    expect(await port.publishAttempt(armAttempt(cohortId)), 'published', 'the attempt');
    expect(await port.sealDecision(decisionSeal(cohortId, {
      rationaleDigest: sha256Hex(prose),
    })), 'published', 'the seal');

    const ref = {
      cohortId, participantId: `${cohortId}-alpha`, gameId: 'game-1', market: 'moneyline' as const,
    };
    const swapped = await port.publishRationale({
      decision: ref, rationale: 'different prose entirely', evidenceRefs: [], source: NO_SOURCE,
    });
    expect(swapped, 'contradiction', 'prose that does not hash to the sealed digest');
    assert.equal(swapped.outcome === 'contradiction' ? swapped.field : null, 'rationale');

    const rows = await query(
      `select count(*)::int as n from public.benchmark_decision_rationales r
         join public.benchmark_decisions d on d.id = r.decision_id
        where d.cohort_id = $1`, [cohortId]);
    assert.equal(rows[0]!['n'], 0, 'and nothing was written');

    // NEGATIVE CONTROL: the prose the seal actually committed to still lands.
    expect(await port.publishRationale({
      decision: ref, rationale: prose, evidenceRefs: ['ref-1'], source: NO_SOURCE,
    }), 'published', 'the sealed prose');

    // And the stored text really does reproduce the stored digest, which is the
    // property a reader checks. Read back rather than assumed: the store
    // redacts on the way in, so the bytes hashed must be the bytes kept.
    const stored = await query(
      `select r.rationale, d.rationale_digest from public.benchmark_decision_rationales r
         join public.benchmark_decisions d on d.id = r.decision_id
        where d.cohort_id = $1`, [cohortId]);
    assert.equal(sha256Hex(String(stored[0]!['rationale'])), stored[0]!['rationale_digest']);
  });

  await check('ONE ENTRANT PER (lab, model, configuration), and the index is what says so', async () => {
    // The rule the whole identity model rests on. Two participant ids carrying
    // the same three values are the same competitor, and the database keeps one
    // of them - forever, because these rows are insert-once with no UPDATE.
    //
    // Proved deliberately, because the fixture helper above WORKS AROUND it by
    // deriving `modelId` from the participant id. A suite that only avoids
    // tripping a constraint has not shown the constraint is there.
    const cohortId = cohortName('entrant-collision');
    const shared = {
      labId: 'collide',
      modelId: `${cohortId}-same`,
      configuration: AWKWARD_CONFIGURATION,
    };
    expect(await port.publishAttempt(armAttempt(cohortId, {
      participant: model(`${cohortId}-first`, shared),
    })), 'published', 'the first entrant');

    const out = await port.publishAttempt(armAttempt(cohortId, {
      participant: model(`${cohortId}-second`, shared), gameId: 'game-2',
    }));
    expect(out, 'refused', 'a second participant id with the same entrant key');
    assert.equal(out.outcome === 'refused' ? out.constraint : null,
      'uq_benchmark_participant_entrant');
  });

  await check('THE SAME MODEL AT TWO SETTINGS IS TWO ENTRANTS, and both land', async () => {
    // The converse of the check above, and the capability the column exists
    // for. A schema that could not hold this would make "compare one model at
    // two reasoning levels" unrepresentable, which is the comparison the
    // identity model was extended to support.
    const cohortId = cohortName('two-settings');
    const sharedModel = `${cohortId}-shared-model`;
    for (const [suffix, configuration] of [
      ['low', { reasoning: { effort: 'low' } }],
      ['high', { reasoning: { effort: 'high' } }],
    ] as const) {
      expect(await port.publishAttempt(armAttempt(cohortId, {
        participant: model(`${cohortId}-${suffix}`, {
          labId: 'twoway', modelId: sharedModel, configuration,
        }),
        gameId: `game-${suffix}`,
      })), 'published', `the ${suffix} setting`);
    }
    const rows = await query(
      `select count(*)::int as n, count(distinct configuration_sha256)::int as digests
         from public.benchmark_participants where model_id = $1`, [sharedModel]);
    assert.equal(rows[0]!['n'], 2, 'two entrants share one model');
    assert.equal(rows[0]!['digests'], 2, 'and the configuration digest is what tells them apart');
  });

  await check('a changed configuration for a live entrant is a CONTRADICTION, not a silent replay', async () => {
    // A participant row is insert-once, so a second write declaring different
    // settings is absorbed by `on conflict do nothing` unless something compares
    // it. Without the drift check the caller is told `published` while the
    // stored row still describes the old setting, and every later decision is
    // attributed to a configuration that did not produce it.
    const cohortId = cohortName('config-drift');
    const participantId = `${cohortId}-drifter`;
    expect(await port.publishAttempt(armAttempt(cohortId, {
      participant: model(participantId),
    })), 'published', 'the original configuration');

    const out = await port.publishAttempt(armAttempt(cohortId, {
      participant: model(participantId, {
        configuration: { b: 2, aa: { nested: true, list: [1, 2] } },
      }),
      facts: facts({ attemptOrdinal: 1 }),
    }));
    expect(out, 'contradiction', 'a different configuration under the same participant');
    assert.match(String(out.outcome === 'contradiction' ? out.field : ''),
      /^participant\.configuration/);
    const rows = await query(
      'select count(*)::int as n from public.benchmark_arm_attempts where cohort_id = $1', [cohortId]);
    assert.equal(rows[0]!['n'], 1, 'and the contradicting write left nothing behind');
  });

  await check('a MISMATCHED drift array is a contradiction, never a duplicate', async () => {
    // The defect this check exists to catch on the NEXT edit rather than in
    // production. `unnest(text[], boolean[])` pads the shorter array with NULLs.
    // One predicate more than labels gives a differing row whose label is NULL,
    // `min(f)` drops NULLs, and the caller was told `duplicate` - a write the
    // gate had suppressed, reported as a benign repeat and therefore as success.
    //
    // Growing PARTICIPANT_DRIFT is exactly the edit that produces it, and this
    // change grew it by four entries. So the statement is mismatched on purpose
    // here and run against the real database.
    const cohortId = cohortName('drift-mismatch');
    // Capture what the port actually SENDS rather than rebuilding a forty-key
    // payload beside it: a fixture that supplies its own expected value proves
    // only that the code copies.
    let sent: readonly unknown[] | null = null;
    const recording = new SqlBenchmarkServingPort({
      query,
      transactor: {
        transaction: (fn) => pgStoreTransactor(pool).transaction(async (inner) => fn(
          async (sql, params) => {
            if (sql === SERVING_STATEMENTS.attempt) sent = params;
            return inner(sql, params);
          },
        )),
      },
    });
    expect(await recording.publishAttempt(armAttempt(cohortId)), 'published', 'the entrant exists');
    assert.notEqual(sent, null, 'the attempt statement was never seen, so nothing below is testing it');

    const MARKER = 'is distinct from input.configuration_digest_version]';
    assert.equal(SERVING_STATEMENTS.attempt.split(MARKER).length - 1, 1,
      'the injection point must be unique, or this is mutating something else');
    const mismatched = SERVING_STATEMENTS.attempt.replace(
      MARKER, 'is distinct from input.configuration_digest_version, true]');

    const [row] = await query(mismatched, sent!);
    assert.equal(row!['drift_rows'], 1, 'the unlabelled predicate still fires');
    assert.equal(row!['inserted'], 0, 'and the gate still suppresses the write');
    assert.equal(row!['contradiction'], 'drift.unlabelled',
      'and the coalesce names it, so min() cannot drop it');
    assert.equal(row!['parent_found'], 0,
      'parent_found reports the gate, so it cannot claim a parent for a suppressed write');

    // NEGATIVE CONTROL, and the point of the check: strip the coalesce and the
    // contradiction goes back to NULL, which is what the caller reads as
    // `duplicate`. Two independent layers now have to be defeated for the old
    // failure to return, and this shows each carries its own weight.
    // EVERY occurrence, not the first. This statement carries four coalesced
    // drift labels (run, participant, roster, attempt facts) and the injected
    // predicate is in the participant one — a `replace` strips only the run's,
    // leaves the participant's standing, and the control then "fails" by
    // reporting a correctly named contradiction. That is a mutation that never
    // applied, which is the one outcome a negative control must never score as
    // a result.
    const COALESCED = "coalesce(t.f, 'drift.unlabelled') as f";
    const labelSites = mismatched.split(COALESCED).length - 1;
    assert.equal(labelSites, 4, 'the attempt statement labels four drift sources');
    const unnamed = mismatched.replaceAll(COALESCED, 't.f');
    assert.equal(unnamed.split(COALESCED).length - 1, 0, 'and the mutation removed all of them');
    const [bare] = await query(unnamed, sent!);
    assert.equal(bare!['contradiction'], null,
      'without the coalesce the disagreement is nameless - this is the old defect');
    assert.equal(bare!['drift_rows'], 1,
      'and drift_rows is what still catches it, independently of any label');
  });

  await check('the LIVE schema reports the capability this build requires', async () => {
    // The readiness gate reads a version the schema states about itself, so the
    // constant it compares against has to be held against a real database
    // rather than against another copy of itself. A build requiring more than
    // the schema offers refuses to open at all; one requiring less opens
    // against a schema that cannot hold an entrant.
    const rows = await query(
      'select version from public.benchmark_schema_capability where capability = $1',
      ['serving_projection']);
    assert.equal(rows.length, 1, 'the capability row exists');
    assert.ok(Number(rows[0]!['version']) >= REQUIRED_SERVING_CAPABILITY,
      `schema reports ${String(rows[0]!['version'])}, this build requires ${REQUIRED_SERVING_CAPABILITY}`);
  });

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

  // -------------------------------------------------------------------------
  // End to end: a real fire, into this database
  // -------------------------------------------------------------------------
  //
  // Everything above drives the port with payloads this file builds. This drives
  // it with payloads the RUNNER builds, through the projector, from an artifact
  // a real fire wrote — which is the only arrangement that can catch a projector
  // emitting a shape the live schema will not take. A rename in buildRecords, a
  // column the projector stopped sending, a value the schema quietly rounds:
  // none of them are visible to a suite whose inputs are typed by hand.

  await check('a real fire publishes its own artifact into this database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'serving-e2e-'));
    try {
      // Its own game, so the decision key is unused. See FireOptions.gameId:
      // the fixture cohort is fixed, so a second run over one game contradicts
      // rather than duplicates.
      const gameId = `e2e-${process.pid}-${(nonce += 1)}`;
      const fired = await firedRun({ outDir: dir, enrolled: true, gameId, serving: port });

      const decisions = await query(
        `select participant_id, market from public.benchmark_decisions
          where cohort_id = $1 and game_id = $2 order by participant_id, market`,
        [fired.cohortId, gameId],
      );
      assert.ok(decisions.length > 0, 'the fire published no decision at all');

      // Every sealed decision has its reveal. The two are separate writes, so a
      // seal that lands without one is the shape a reader cannot resolve.
      const orphans = await query(
        `select d.id from public.benchmark_decisions d
           left join public.benchmark_decision_reveals r on r.decision_id = d.id
          where d.cohort_id = $1 and d.game_id = $2 and r.decision_id is null`,
        [fired.cohortId, gameId],
      );
      assert.equal(orphans.length, 0, `${orphans.length} sealed decisions have no reveal`);

      // The model entrant carries a whole identity, and the artifact's own
      // participant is the one that got it.
      const participants = [...new Set(decisions.map((row) => String(row['participant_id'])))];
      const rows = await query(
        `select participant_id, kind, lab_id, model_id, configuration, configuration_sha256
           from public.benchmark_participants where participant_id = any($1::text[])`,
        [participants],
      );
      const models = rows.filter((row) => row['kind'] === 'model');
      assert.ok(models.length > 0, 'the fire published no model participant');
      for (const row of models) {
        for (const column of ['lab_id', 'model_id', 'configuration', 'configuration_sha256']) {
          assert.notEqual(row[column], null, `${String(row['participant_id'])}: ${column} is null on a model`);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('the eight deterministic controls coexist, which is the partial index', async () => {
    // Every control declares (null, null, null). The entrant index is unique
    // with NULLS NOT DISTINCT, so if it were ever NOT partial on kind='model'
    // the second control would 23505 — and the publisher is fail-soft, so seven
    // of the eight baselines would go missing with nothing reported anywhere.
    //
    // Written through the real fire rather than by hand: the eight are exactly
    // the ones a night produces, so this fails if the registry grows a control
    // the schema cannot hold.
    const dir = mkdtempSync(join(tmpdir(), 'serving-controls-'));
    try {
      const gameId = `controls-${process.pid}-${(nonce += 1)}`;
      const fired = await firedRun({ outDir: dir, enrolled: true, gameId, serving: port });
      const controls = await query(
        `select distinct p.participant_id from public.benchmark_decisions d
           join public.benchmark_participants p on p.participant_id = d.participant_id
          where d.cohort_id = $1 and d.game_id = $2 and p.kind <> 'model'`,
        [fired.cohortId, gameId],
      );
      // Against the REGISTRY's own count rather than a literal, so enrolling a
      // ninth control fails here until the schema is shown to hold it — and so
      // the number cannot quietly drift down to the one a broken index allows.
      const enrolled = Object.values(PROJECTION_PARTICIPANTS).filter(
        (entry) => entry.kind !== 'model',
      ).length;
      assert.equal(
        controls.length,
        enrolled,
        `${controls.length} of ${enrolled} enrolled controls landed — with a non-partial ` +
          'entrant index exactly ONE would, which is what this check tells apart',
      );
      const identified = await query(
        `select participant_id from public.benchmark_participants
          where participant_id = any($1::text[])
            and num_nonnulls(lab_id, model_id, configuration, configuration_sha256) > 0`,
        [controls.map((row) => String(row['participant_id']))],
      );
      assert.equal(identified.length, 0, 'a control carries part of a model identity');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
