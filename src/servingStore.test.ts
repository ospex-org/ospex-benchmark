import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCEPTED_ATTEMPT_OUTCOMES,
  SERVING_STATEMENTS,
  SqlBenchmarkServingPort,
  UNNAMED_DRIFT_FIELD,
} from './servingStore.js';
import { canonicalConfigurationText, configurationSha256 } from './participantConfiguration.js';
import type {
  ArmAttempt,
  AttemptFacts,
  DecisionRationale,
  DecisionReveal,
  DecisionScore,
  DecisionSeal,
  ParticipantFacts,
  PublishOutcome,
  RosterFacts,
  RunFacts,
  ScoringRun,
} from './servingStore.js';
import type { ServingStoreDeps } from './servingStore.js';
import type { StoreQuery } from './store/atomicStore.js';

/**
 * The serving publisher driven over a scripted `StoreQuery`, so every mapping is
 * pinned WITHOUT a database: the outcome taxonomy, the exact payload each
 * statement sends, the client-side refusals that stand in for the schema's CHECK
 * constraints, the redaction of free text, the single retry on a lost race, and
 * — the property the whole module rests on — that NO method ever throws.
 *
 * The complement is `yarn store:serving`, which runs the same statements against
 * a real PostgreSQL carrying the projection schema. Neither suite subsumes the
 * other: this one cannot prove the SQL is valid or that a column lands where the
 * INSERT list says it does, and that one cannot cheaply enumerate every refusal.
 *
 * ⚠ This suite must stay DB-free. CI has no PostgreSQL and no secrets; a test
 *   here that opens a connection hangs the job until the step timeout.
 */

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Each invocation records the call and shifts the next canned response. */
function scriptedQuery(
  responses: Array<ReadonlyArray<Record<string, unknown>> | Error>,
): { deps: ServingStoreDeps; calls: Call[]; writes: () => number; locks: () => number } {
  const calls: Call[] = [];
  const isLock = (sql: string): boolean => sql === SERVING_STATEMENTS.lock;
  const query: StoreQuery = async (sql, params) => {
    calls.push({ sql, params });
    // Acquiring the lock consumes no scripted response: a test about the write
    // path scripts only the write.
    if (isLock(sql)) return [{ participant: null, cohort: null }];
    const next = responses.shift();
    if (next === undefined) throw new Error(`scripted query exhausted (call ${calls.length})`);
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    // A transaction is modelled as running the callback against the same
    // scripted query: the ORDER of statements is what the tests assert, and
    // that a real transaction is used at all is proved by the conformance suite.
    deps: { query, transactor: { transaction: (fn) => fn(query) } },
    calls,
    writes: () => calls.filter((c) => !isLock(c.sql)).length,
    locks: () => calls.filter((c) => isLock(c.sql)).length,
  };
}

/**
 * A scripted result row. `drift_rows` defaults to 0 — no disagreement — and the
 * contradiction cases below set it explicitly, because it is the COUNT and not
 * the name that decides the outcome: a drift row the statement could not label
 * arrives with `contradiction` null and must still be reported.
 */
const row = (over: Record<string, unknown> = {}): ReadonlyArray<Record<string, unknown>> =>
  [{ contradiction: null, ineligible_reason: null, parent_found: 1, inserted: 1, drift_rows: 0, ...over }];
const OK = row();
const DUP = row({ inserted: 0 });
const ORPHAN = row({ parent_found: 0, inserted: 0 });

/** The single JSON parameter a WRITE was handed, decoded. Lock statements are
 *  skipped, so an index means the same thing whether or not the call serialised. */
function sentPayload(calls: Call[], index = 0): Record<string, unknown> {
  const params = calls.filter((c) => c.sql !== SERVING_STATEMENTS.lock)[index]!.params;
  assert.equal(params.length, 1, 'exactly one parameter: the jsonb payload');
  return JSON.parse(params[0] as string) as Record<string, unknown>;
}

const SEALED = '2026-08-09T20:06:00.123456Z';
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);

/** Deliberately awkward: a key order that differs under RFC 8785 and under
 *  PostgreSQL's jsonb ordering, a non-ASCII key, a nested object, and a float
 *  no rounding leaves alone. A fixture of `{}` cannot catch a normalisation bug. */
const AWKWARD_CONFIGURATION = { b: 1, aa: { nested: true }, 'é': 0.30000000000000004 };

const RUN: RunFacts = Object.freeze({
  runId: 'smoke-v0-2026-08-09-aa11bb',
  cohortId: 'cohort-x',
  slateDate: '2026-08-09',
  network: 'polygon',
  deploymentRound: 'R5',
  startedAt: SEALED,
  bundleSha256: null,
  planSha256: null,
  promptScaffoldSha256: OTHER_DIGEST,
  promptScaffoldVersion: 'shadow-smoke-v0.5',
  responseSchemaVersion: 2,
  baselinePolicyVersion: null,
  priceVersion: 'prices-v1',
  benchmarkCommit: null,
  executionPolicy: 'fixed-moneyline-total',
});

const MODEL: ParticipantFacts = Object.freeze({
  participantId: 'lab-alpha', kind: 'model', labId: 'alpha', displayName: 'Alpha',
  modelId: 'alpha-v1', configuration: AWKWARD_CONFIGURATION,
});
const BASELINE: ParticipantFacts = Object.freeze({
  participantId: 'baseline-favorite', kind: 'baseline', labId: null, displayName: 'Favourite',
  modelId: null, configuration: null,
});
const ROSTER: RosterFacts = Object.freeze({ walletAddress: `0x${'1'.repeat(40)}` });

const FACTS: AttemptFacts = Object.freeze({
  attemptOrdinal: 0,
  suppliedMarkets: Object.freeze(['moneyline', 'total'] as const),
  sent: true,
  outcome: 'valid',
  requestedModelId: 'model-a',
  reportedModelId: 'model-a-2026',
  providerResponseId: 'resp-1',
  httpStatus: 200,
  providerStopReason: 'end_turn',
  turnCompleted: true,
  validationErrors: null,
  requestAt: '2026-08-09T20:05:00.000Z',
  responseAt: '2026-08-09T20:05:12.000Z',
  latencyMs: 12000,
  inputTokens: 4200,
  outputTokens: 900,
  reasoningTokens: null,
  billableOutputTokens: 900,
  billableSearchCount: null,
  searchEvidenceStatus: 'unknown_unproven',
  costUsd: 5.411942,
  priceVersion: 'prices-v1',
});

const NO_SOURCE = { sourcePath: null, sourceSha256: null };

function attempt(over: Partial<ArmAttempt> = {}): ArmAttempt {
  return { run: RUN, participant: MODEL, roster: ROSTER, gameId: 'game-1',
           facts: FACTS, source: { sourcePath: 'out/run.ndjson', sourceSha256: null }, ...over };
}

function seal(over: Partial<DecisionSeal> = {}): DecisionSeal {
  return {
    run: RUN, participant: MODEL, roster: ROSTER, gameId: 'game-1', attemptOrdinal: 0,
    market: 'moneyline', sealedAt: SEALED, forecastDigest: DIGEST, rationaleDigest: null,
    bundleSha256: null, responseSchemaVersion: 2, contestId: null, speculationId: null,
    source: { sourcePath: 'out/run.ndjson', sourceSha256: null }, ...over,
  };
}

const REF = { cohortId: 'cohort-x', participantId: 'lab-alpha', gameId: 'game-1', market: 'moneyline' } as const;

function reveal(over: Partial<DecisionReveal> = {}): DecisionReveal {
  return {
    decision: REF, revealedAt: '2026-08-09T20:40:00.000Z', selection: 'home', line: null,
    observedDecimal: 1.91, probWin: 0.55, probPush: null, probLoss: 0.45, confidence: 0.6,
    wouldAbstain: false, selectedForExecution: true, reasonCode: null,
    axisValuation: 4, axisTrend: 3, axisConsensus: 3, axisNews: 2, axisSoftness: 4,
    primaryAxis: 'valuation', primaryExpectation: 'line moves toward the pick',
    source: NO_SOURCE, ...over,
  };
}

function rationale(over: Partial<DecisionRationale> = {}): DecisionRationale {
  return { decision: REF, rationale: 'The number looks soft relative to the projection.',
           evidenceRefs: ['ref-1'], source: NO_SOURCE, ...over };
}

function score(over: Partial<DecisionScore> = {}): DecisionScore {
  return {
    decision: REF, scoringPolicyVersion: 'scoring-v0.6.0', economicClvPct: 1.85,
    marginAdjustedClvPct: 0.92, devigMethod: 'multiplicative', ladderVersion: 'TOTALS_V1',
    ladderParamVersion: 'TOTALS_V1_PROVISIONAL', refused: false, refusalReason: null,
    scheduleChanged: false, heldOutOfPrimary: false, closeDecimalSelected: 1.87,
    closeDecimalOpposing: 1.95, closeLine: null, lineMovementFavorable: null,
    scoredAt: '2026-08-10T04:00:00.000Z', source: NO_SOURCE, ...over,
  };
}

function scoringRun(over: Partial<ScoringRun> = {}): ScoringRun {
  return {
    cohortId: 'cohort-x', scoringPolicyVersion: 'scoring-v0.6.0', eligible: 24, scored: 20,
    refused: 4, scheduleHeldOut: 0, refusalReasons: { no_close: 4 }, rankingAllowed: false,
    rankingReason: 'n=4 per moneyline participant is descriptive noise, not ranking evidence',
    costPerPickComparable: false, benchmarkCommit: null,
    scoredAt: '2026-08-10T04:00:00.000Z', source: NO_SOURCE, ...over,
  };
}

/** Every method, so a property can be asserted across the whole surface rather
 *  than sampled on one of them. */
const EVERY_METHOD: ReadonlyArray<readonly [string, (p: SqlBenchmarkServingPort) => Promise<PublishOutcome>]> = [
  ['publishAttempt', (p) => p.publishAttempt(attempt())],
  ['sealDecision', (p) => p.sealDecision(seal())],
  ['revealDecision', (p) => p.revealDecision(reveal())],
  ['publishRationale', (p) => p.publishRationale(rationale())],
  ['publishScore', (p) => p.publishScore(score())],
  ['publishScoringRun', (p) => p.publishScoringRun(scoringRun())],
];

/** The four with a decision parent, which are the ones that can report it missing. */
const CHILD_METHODS = EVERY_METHOD.slice(2, 5);

// ---------------------------------------------------------------------------
// The payload keys must match the statement's record declaration
// ---------------------------------------------------------------------------

/**
 * Pull the column names out of a statement's `jsonb_to_record(...) as x(...)`.
 * Depth-aware, because `numeric(18,6)` puts a comma inside a type — splitting on
 * every comma would invent columns named `6)`.
 */
function declaredColumns(sql: string): string[] {
  const marker = 'as x(';
  const start = sql.indexOf(marker);
  assert.notEqual(start, -1, 'the statement unpacks its payload with `as x(...)`');
  let depth = 0;
  let end = -1;
  for (let i = start + marker.length - 1; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.notEqual(end, -1, 'the record declaration is balanced');
  const body = sql.slice(start + marker.length, end);
  const parts: string[] = [];
  let current = '';
  depth = 0;
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim().split(/\s+/)[0]!).filter((p) => p.length > 0);
}

/**
 * THE DRIFT THE JSONB HOP CANNOT DETECT. A key the payload omits arrives as NULL
 * and a key the declaration omits is silently dropped — both measured, neither
 * raises. So the two sides are compared directly, in both directions, for every
 * statement. Renaming a column on one side alone turns this red.
 *
 * This covers the JSON→record hop only. The record→INSERT hop inside each
 * statement is positional and invisible to any string test; the conformance
 * suite covers it by reading a written row back column by column.
 */
test('every payload key matches its statement record declaration, both ways', async () => {
  const cases: ReadonlyArray<readonly [string, string, (p: SqlBenchmarkServingPort) => Promise<unknown>]> = [
    ['attempt', SERVING_STATEMENTS.attempt, (p) => p.publishAttempt(attempt())],
    ['seal', SERVING_STATEMENTS.seal, (p) => p.sealDecision(seal())],
    ['reveal', SERVING_STATEMENTS.reveal, (p) => p.revealDecision(reveal())],
    ['rationale', SERVING_STATEMENTS.rationale, (p) => p.publishRationale(rationale())],
    ['score', SERVING_STATEMENTS.score, (p) => p.publishScore(score())],
    ['scoringRun', SERVING_STATEMENTS.scoringRun, (p) => p.publishScoringRun(scoringRun())],
  ];
  for (const [name, sql, call] of cases) {
    const s = scriptedQuery([OK]);
    await call(new SqlBenchmarkServingPort(s.deps));
    const declared = declaredColumns(sql).sort();
    const sent = Object.keys(sentPayload(s.calls)).sort();
    assert.deepEqual(sent, declared, `${name}: payload keys and record columns disagree`);
  }
});

test('the declaration parser survives a comma inside a type', () => {
  // A negative control on the test's own tool: if this split naively, `numeric`
  // types would contribute a phantom column and the comparison above would be
  // asserting against nonsense.
  const cols = declaredColumns('select * from jsonb_to_record($1) as x(a text, b numeric(18,6), c public.network)');
  assert.deepEqual(cols, ['a', 'b', 'c']);
});

// ---------------------------------------------------------------------------
// Disabled
// ---------------------------------------------------------------------------

test('a port with no query is disabled, and issues no statement at all', async () => {
  const port = new SqlBenchmarkServingPort(null);
  for (const [name, call] of EVERY_METHOD) {
    assert.deepEqual(await call(port), { outcome: 'disabled' }, `${name} is disabled`);
  }
});

test('disabled short-circuits BEFORE validation — an unconfigured publisher never refuses', async () => {
  // The negative control for the test above: with a query present this same
  // payload is `invalid_input`, so `disabled` is not standing in for a refusal.
  const bad = seal({ forecastDigest: 'not-a-digest' });
  assert.deepEqual(await new SqlBenchmarkServingPort(null).sealDecision(bad), { outcome: 'disabled' });
  const s = scriptedQuery([]);
  assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).sealDecision(bad), {
    outcome: 'invalid_input', reason: 'malformed_digest', field: 'forecastDigest',
  });
  assert.equal(s.calls.length, 0, 'a refused payload never reaches the database');
});

// ---------------------------------------------------------------------------
// Outcome mapping
// ---------------------------------------------------------------------------

test('one statement per publish, and the row counts map to the outcome', async () => {
  for (const [name, call] of EVERY_METHOD) {
    const ok = scriptedQuery([OK]);
    assert.deepEqual(await call(new SqlBenchmarkServingPort(ok.deps)), { outcome: 'published' }, name);
    assert.equal(ok.writes(), 1, `${name} issues exactly one WRITE statement`);

    const dup = scriptedQuery([DUP]);
    assert.deepEqual(await call(new SqlBenchmarkServingPort(dup.deps)), { outcome: 'duplicate' }, name);
  }
});

test('a decision the statement could not see is parent_missing, not duplicate', async () => {
  // The distinction the two counts exist for. `insert ... select` over an empty
  // source inserts nothing, raises nothing and returns success — indistinguishable
  // from a conflict if only the insert count were reported.
  for (const [name, call] of CHILD_METHODS) {
    const s = scriptedQuery([ORPHAN]);
    assert.deepEqual(await call(new SqlBenchmarkServingPort(s.deps)), { outcome: 'parent_missing' }, name);
  }
});

test('a seal whose attempt was never published is parent_missing', async () => {
  const s = scriptedQuery([ORPHAN]);
  assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).sealDecision(seal()),
    { outcome: 'parent_missing' });
});

test('neither an attempt nor a scoring run has a parent row to find', () => {
  // A scoring run selects a literal 1. Were that dropped, every such write would
  // silently report `parent_missing` and nothing would notice.
  assert.match(SERVING_STATEMENTS.scoringRun, /^\s*1\s+as parent_found,?$/m);
  // The attempt no longer does, and the reason is worth keeping: it has no
  // parent either, but a literal cannot report a gate CLOSED by a durable-fact
  // disagreement. That state arrived as inserted=0 with nothing else set, which
  // the mapping reads as `duplicate` — a suppressed write reported as a benign
  // repeat, and therefore as a success. It reports `gate.ok`, as the seal does.
  for (const sql of [SERVING_STATEMENTS.attempt, SERVING_STATEMENTS.seal]) {
    assert.match(sql, /\(select gate\.ok::int from gate\)\s+as parent_found/);
  }
  assert.ok(!/^\s*1\s+as parent_found,?$/m.test(SERVING_STATEMENTS.attempt),
    'the attempt reports the gate, not a literal');
});

test('a contradiction outranks every other branch', async () => {
  // It is the one integrity failure a projection of commitments exists to make
  // visible, and it can arrive alongside a successful insert (a new decision, an
  // older roster row that disagrees) — so it has to be reported first or it is
  // reported never.
  for (const [name, call] of EVERY_METHOD) {
    for (const shape of [row({ contradiction: 'forecastDigest', drift_rows: 1 }),
                         row({ contradiction: 'forecastDigest', drift_rows: 1, inserted: 0 }),
                         row({ contradiction: 'roster.walletAddress', drift_rows: 1, parent_found: 0, inserted: 0 }),
                         row({ contradiction: 'participant.kind', drift_rows: 1, ineligible_reason: 'unsent' })]) {
      const s = scriptedQuery([shape]);
      const out = await call(new SqlBenchmarkServingPort(s.deps));
      assert.equal(out.outcome, 'contradiction', `${name} on ${JSON.stringify(shape[0])}`);
    }
  }
  const s = scriptedQuery([row({ contradiction: 'participant.configuration', drift_rows: 1 })]);
  assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).publishAttempt(attempt()),
    { outcome: 'contradiction', field: 'participant.configuration' });
});

test('the COUNT decides a contradiction, not the name — an unlabelled drift row is still one', async () => {
  // The two `unnest` arrays in a drift check are parallel, and a flag with no
  // name yields a differing row whose label is NULL, which `min()` then drops.
  // Reported on the name alone this arrived as inserted=0 with no
  // contradiction, which the mapping reads as `duplicate`: a SUPPRESSED write
  // reported as a benign repeat, and therefore as a success.
  const s = scriptedQuery([row({ contradiction: null, drift_rows: 1, inserted: 0 })]);
  assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).publishAttempt(attempt()),
    { outcome: 'contradiction', field: UNNAMED_DRIFT_FIELD });
  // The paired accept, which is what makes the count discriminating rather than
  // a blanket refusal: no drift rows and no insert really is a duplicate.
  const dup = scriptedQuery([row({ contradiction: null, drift_rows: 0, inserted: 0 })]);
  assert.deepEqual(await new SqlBenchmarkServingPort(dup.deps).publishAttempt(attempt()),
    { outcome: 'duplicate' });
});

test('the seal statement really does compare the stored digest', async () => {
  // The mapping above is only meaningful if the SQL can produce a contradiction.
  assert.match(SERVING_STATEMENTS.seal,
    /d\.forecast_digest is distinct from input\.forecast_digest/);
  assert.match(SERVING_STATEMENTS.seal,
    /c\.wallet_address is distinct from input\.wallet_address/);
});

test('an off-contract result shape resolves to unavailable rather than throwing', async () => {
  // Every case below carries a well-formed `drift_rows` EXCEPT the two that are
  // about it, so each row is off-contract on exactly the field it names — a
  // missing `drift_rows` is itself refused, and without it here these cases
  // would all pass for that reason instead of the one they were written for.
  for (const rows of [[], [{}],
    [{ contradiction: null, ineligible_reason: null, parent_found: 'one', inserted: 1, drift_rows: 0 }],
    [{ contradiction: 7, ineligible_reason: null, parent_found: 1, inserted: 1, drift_rows: 0 }],
    [{ contradiction: null, ineligible_reason: 9, parent_found: 1, inserted: 1, drift_rows: 0 }],
    [{ contradiction: null, ineligible_reason: null, parent_found: 1, inserted: 1 }],
    [{ contradiction: null, ineligible_reason: null, parent_found: 1, inserted: 1, drift_rows: '0' }],
    [OK[0]!, OK[0]!]]) {
    const s = scriptedQuery([rows]);
    const out = await new SqlBenchmarkServingPort(s.deps).sealDecision(seal());
    assert.equal(out.outcome, 'unavailable', `rows=${JSON.stringify(rows)}`);
  }
});

// ---------------------------------------------------------------------------
// Failure classification, the retry, and that nothing propagates
// ---------------------------------------------------------------------------

test('a database refusal carries its SQLSTATE and constraint', async () => {
  const err = Object.assign(new Error('violates foreign key constraint'), {
    code: '23503', constraint: 'fk_benchmark_decision_attempt',
  });
  const s = scriptedQuery([err]);
  assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).sealDecision(seal()), {
    outcome: 'refused',
    sqlstate: '23503',
    constraint: 'fk_benchmark_decision_attempt',
    detail: 'Error: violates foreign key constraint',
  });
  assert.equal(s.writes(), 1, 'an integrity refusal is NOT retried');
});

test('detail can quote the offending value, which is why it is diagnostic and not public', async () => {
  // The documented bound. Redaction covers enrolled credential VALUES only, so a
  // game id or a malformed literal reaches this field — the docstring says so
  // rather than claiming the outcome is free of input text.
  const s = scriptedQuery([Object.assign(new Error('date/time field value out of range: "2026-13-45"'),
    { code: '22008' })]);
  const out = await new SqlBenchmarkServingPort(s.deps).publishScore(score());
  assert.ok(out.outcome === 'refused' && out.detail.includes('2026-13-45'));
});

test('a privilege refusal is reported as refused, not as an outage', async () => {
  // 42501 is the intended signal when something tries to UPDATE or DELETE, and it
  // must be distinguishable from the database being unreachable — one is a bug in
  // the caller, the other is transient.
  const s = scriptedQuery([Object.assign(new Error('permission denied'), { code: '42501' })]);
  const out = await new SqlBenchmarkServingPort(s.deps).publishScore(score());
  assert.equal(out.outcome, 'refused');
  assert.equal(out.outcome === 'refused' ? out.sqlstate : null, '42501');
  assert.equal(out.outcome === 'refused' ? out.constraint : 'unset', null, 'no constraint named');
});

test('an outage that DOES carry a SQLSTATE is still unavailable, not refused', async () => {
  // 53300 too_many_connections is the one that prompted this: the scoped role
  // carries CONNECTION LIMIT 5, and a fan-out that exceeds it gets a server
  // error with a SQLSTATE. Reporting that as `refused` reads as "the database
  // rejected your row" — the caller would go hunting for a producer bug that
  // does not exist, and would not retry the thing that would have worked.
  for (const code of ['53300', '53200', '08006', '08003', '57014', '58030']) {
    const s = scriptedQuery([Object.assign(new Error('transient'), { code })]);
    const out = await new SqlBenchmarkServingPort(s.deps).publishScore(score());
    assert.equal(out.outcome, 'unavailable', code);
  }
  // The paired accept: a genuine rejection still reports as one, so this is not
  // a blanket downgrade of every server error.
  for (const code of ['23505', '23503', '42501', '22008']) {
    const s = scriptedQuery([Object.assign(new Error('rejected'), { code })]);
    const out = await new SqlBenchmarkServingPort(s.deps).publishScore(score());
    assert.equal(out.outcome, 'refused', code);
  }
});

test('a failure with no SQLSTATE is unavailable', async () => {
  for (const thrown of [
    new Error('connect ETIMEDOUT'),
    Object.assign(new Error('nope'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('nope'), { code: 42501 }),
  ]) {
    const s = scriptedQuery([thrown]);
    const out = await new SqlBenchmarkServingPort(s.deps).sealDecision(seal());
    assert.equal(out.outcome, 'unavailable', `thrown=${String(thrown)}`);
  }
});

test('a lost race on a SHARED parent row is retried exactly once', async () => {
  // Two writes that merely share a run or roster row overlap constantly. The
  // conflict target names one unique index; the redundant composite-FK-target
  // index can raise 23505 instead, aborting the whole statement. Measured at
  // 3-4% under a four-way concurrent share.
  for (const constraint of ['uq_benchmark_run_identity', 'uq_benchmark_cohort_participant_network',
    'benchmark_runs_pkey', 'uq_benchmark_arm_attempt']) {
    const s = scriptedQuery([Object.assign(new Error('duplicate key'), { code: '23505', constraint }), OK]);
    assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).sealDecision(seal()),
      { outcome: 'published' }, constraint);
    assert.equal(s.writes(), 2, `${constraint} was retried`);
  }
  for (const code of ['40001', '40P01']) {
    const s = scriptedQuery([Object.assign(new Error('serialization'), { code }), OK]);
    assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).sealDecision(seal()),
      { outcome: 'published' }, code);
    assert.equal(s.writes(), 2);
  }
});

test('the retry is bounded at one, so a persistent race surfaces', async () => {
  const err = () => Object.assign(new Error('duplicate key'),
    { code: '23505', constraint: 'uq_benchmark_run_identity' });
  const s = scriptedQuery([err(), err()]);
  const out = await new SqlBenchmarkServingPort(s.deps).sealDecision(seal());
  assert.equal(out.outcome, 'refused');
  assert.equal(s.writes(), 2, 'exactly two attempts, never a third');
});

test('an INTEGRITY violation is never retried — the allowlist is not "any 23505"', async () => {
  // The negative control for the retry. A shared wallet and a stale attempt
  // citation are real disagreements; retrying would refuse twice and bury why.
  for (const constraint of ['uq_benchmark_cohort_wallet', 'benchmark_reveals_not_before_seal', null]) {
    const s = scriptedQuery([Object.assign(new Error('violation'), { code: '23505', constraint })]);
    const out = await new SqlBenchmarkServingPort(s.deps).sealDecision(seal());
    assert.equal(out.outcome, 'refused', String(constraint));
    assert.equal(s.writes(), 1, `${String(constraint)} must NOT be retried`);
  }
});

test('NO method throws, whatever the query does — the run cannot be halted here', async () => {
  // The single property this module exists to guarantee, asserted across the whole
  // surface rather than on one method. Note this INVERTS the money-path adapters,
  // whose tests require a rejection.
  for (const [name, call] of EVERY_METHOD) {
    for (const err of [new Error('boom'), Object.assign(new Error('sqlstate'), { code: '08006' })]) {
      const s = scriptedQuery([err, err]);
      const out = await call(new SqlBenchmarkServingPort(s.deps));
      assert.ok(out.outcome === 'refused' || out.outcome === 'unavailable', `${name} folded ${err.message}`);
    }
  }
});

test('a query that rejects with a non-Error still folds to an outcome', async () => {
  const query: StoreQuery = async () => { throw 'plain string rejection'; };
  const out = await new SqlBenchmarkServingPort({ query, transactor: { transaction: (fn) => fn(query) } }).sealDecision(seal());
  assert.equal(out.outcome, 'unavailable');
});

// ---------------------------------------------------------------------------
// Payload content
// ---------------------------------------------------------------------------

test('an attempt is publishable on its own — a failed arm is representable', async () => {
  // The opportunity denominator. A refused or non-final call produces an attempt
  // row and NO decisions; without a standalone write, coverage would be computed
  // over successes only.
  const s = scriptedQuery([OK]);
  assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).publishAttempt(attempt({
    facts: { ...FACTS, sent: false, outcome: 'credential_missing',
      providerResponseId: null, httpStatus: null, providerStopReason: null,
      turnCompleted: null, responseAt: null, latencyMs: null },
  })), { outcome: 'published' });
  const payload = sentPayload(s.calls);
  assert.equal(payload['sent'], false);
  assert.equal(payload['attempt_outcome'], 'credential_missing');
  assert.deepEqual(payload['supplied_markets'], ['moneyline', 'total'],
    'it still occupies the per-market denominator');
});

test('the seal cites an attempt by ordinal and never writes one', async () => {
  // Writing it here is what made three concurrent market seals lose two of three.
  assert.ok(!/insert into public\.benchmark_arm_attempts/.test(SERVING_STATEMENTS.seal),
    'the seal inserts no attempt');
  assert.match(SERVING_STATEMENTS.attempt, /insert into public\.benchmark_arm_attempts/);
  const s = scriptedQuery([OK]);
  await new SqlBenchmarkServingPort(s.deps).sealDecision(seal({ attemptOrdinal: 1 }));
  const payload = sentPayload(s.calls);
  assert.equal(payload['has_attempt'], true);
  assert.equal(payload['attempt_ordinal'], 1);
});

test('a baseline seals with no attempt at all', async () => {
  const s = scriptedQuery([OK]);
  await new SqlBenchmarkServingPort(s.deps).sealDecision(seal({
    participant: BASELINE, roster: { walletAddress: null }, attemptOrdinal: null,
  }));
  const payload = sentPayload(s.calls);
  assert.equal(payload['has_attempt'], false);
  assert.equal(payload['attempt_ordinal'], null);
});

test('a MODEL forecast with no attempt is refused — it would read as a baseline', async () => {
  // The foreign key is MATCH SIMPLE, so a NULL attempt_id satisfies it and the row
  // becomes indistinguishable from a deterministic baseline that made no call,
  // while also vanishing from the attempt-based denominator.
  assert.deepEqual(
    await refusal((p) => p.sealDecision(seal({ attemptOrdinal: null }))),
    { outcome: 'invalid_input', reason: 'model_without_attempt', field: 'attemptOrdinal' },
  );
  // ...and the paired accept: a baseline may, which is what makes this discriminating.
  const s = scriptedQuery([OK]);
  assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).sealDecision(seal({
    participant: BASELINE, roster: { walletAddress: null }, attemptOrdinal: null,
  })), { outcome: 'published' });
});

test('the refusal histogram travels as an object, not as JSON inside JSON', async () => {
  // Double-encoding it stores a jsonb STRING whose content is JSON. Nothing
  // raises, the row looks populated, and every `->>` against it returns nothing.
  const s = scriptedQuery([OK]);
  await new SqlBenchmarkServingPort(s.deps).publishScoringRun(scoringRun({ refusalReasons: { no_close: 4 } }));
  const sent = sentPayload(s.calls)['refusal_reasons'];
  assert.equal(typeof sent, 'object', 'an object, not a string');
  assert.deepEqual(sent, { no_close: 4 });
});

test('a refusal histogram count that is not a count is refused', async () => {
  assert.deepEqual(
    await refusal((p) => p.publishScoringRun(scoringRun({ refusalReasons: { no_close: -1 } }))),
    { outcome: 'invalid_input', reason: 'number_out_of_range', field: 'refusalReasons.no_close' },
  );
});

test('instants cross as the producer wrote them — microseconds are not rounded away', async () => {
  // A JS Date would truncate to milliseconds. The reveal compares its copied
  // sealed_at against revealed_at in a CHECK, so the two have to stay exact.
  const s = scriptedQuery([OK]);
  await new SqlBenchmarkServingPort(s.deps).sealDecision(seal());
  assert.equal(sentPayload(s.calls)['sealed_at'], '2026-08-09T20:06:00.123456Z');
});

test('the reveal does NOT send sealed_at — the statement copies it from the parent', async () => {
  // Supplying it would let a pick be published stamped before the commitment it
  // belongs to, with the composite foreign key satisfied by the caller's own value.
  const s = scriptedQuery([OK]);
  await new SqlBenchmarkServingPort(s.deps).revealDecision(reveal());
  assert.ok(!('sealed_at' in sentPayload(s.calls)), 'sealed_at is not an input');
  assert.match(SERVING_STATEMENTS.reveal, /parent\.sealed_at/);
});

test('every statement is an append that can never overwrite', async () => {
  for (const [name, sql] of Object.entries(SERVING_STATEMENTS)) {
    // The lock statement is a pure read. It has no conflict to resolve, and
    // requiring one of it would assert the wrong thing about the right statement.
    if (name === 'lock') {
      assert.ok(!/\binsert\b/i.test(sql), 'the lock statement writes nothing at all');
    } else {
      assert.ok(/on conflict[\s\S]*?do nothing/i.test(sql), `${name} resolves a conflict by doing nothing`);
    }
    assert.ok(!/do update/i.test(sql), `${name} contains no DO UPDATE`);
    assert.ok(!/\bupdate\s+public\./i.test(sql), `${name} updates no table`);
    assert.ok(!/\bdelete\s+from\b/i.test(sql), `${name} deletes nothing`);
    assert.ok(!/currval|lastval|nextval/i.test(sql), `${name} touches no sequence function`);
  }
});

test('the roster conflict targets its primary key, so a wallet collision still raises', async () => {
  // A bare `on conflict do nothing` would swallow the wallet bijection — the
  // constraint that stops one wallet binding two participants in a cohort.
  for (const sql of [SERVING_STATEMENTS.attempt, SERVING_STATEMENTS.seal]) {
    assert.match(sql, /on conflict \(cohort_id, participant_id\) do nothing/);
  }
});

test('each shared parent insert is guarded by not exists as well as on conflict', async () => {
  // The guard is what keeps the concurrent case rare enough for one retry to
  // cover; without it every write speculatively inserts every parent row.
  for (const sql of [SERVING_STATEMENTS.attempt, SERVING_STATEMENTS.seal]) {
    for (const table of ['benchmark_runs', 'benchmark_participants', 'benchmark_cohort_participants']) {
      assert.ok(new RegExp(`not exists \\(select 1 from public\\.${table}\\b`).test(sql),
        `${table} insert is guarded`);
    }
  }
});

// ---------------------------------------------------------------------------
// Redaction — the chokepoint a direct database write would otherwise bypass
// ---------------------------------------------------------------------------

test('free text is redacted before it is sent', async () => {
  // writeNdjson() runs redactSecrets over every line it emits; a publisher writing
  // objects straight to Postgres does not pass through it. Model prose and
  // provider validation errors are the fields that can carry an echoed credential.
  const previous = process.env['XAI_API_KEY'];
  process.env['XAI_API_KEY'] = 'xai-super-secret-value';
  try {
    const s = scriptedQuery([OK, OK]);
    const port = new SqlBenchmarkServingPort(s.deps);
    await port.publishRationale(rationale({
      rationale: 'the provider replied with xai-super-secret-value in the body',
      evidenceRefs: ['ref xai-super-secret-value'],
    }));
    const sent = sentPayload(s.calls);
    assert.equal(sent['rationale'], 'the provider replied with [REDACTED] in the body');
    assert.deepEqual(sent['evidence_refs'], ['ref [REDACTED]']);

    await port.publishAttempt(attempt({
      facts: { ...FACTS, validationErrors: ['schema mismatch near xai-super-secret-value'] },
    }));
    assert.deepEqual(sentPayload(s.calls, 1)['validation_errors'], ['schema mismatch near [REDACTED]']);
  } finally {
    if (previous === undefined) delete process.env['XAI_API_KEY'];
    else process.env['XAI_API_KEY'] = previous;
  }
});

test('the redaction test is not vacuous — the same text is unredacted with no key set', async () => {
  // Negative control. Without it the assertion above would still pass against a
  // build that replaced every rationale with a constant.
  const previous = process.env['XAI_API_KEY'];
  delete process.env['XAI_API_KEY'];
  try {
    const s = scriptedQuery([OK]);
    await new SqlBenchmarkServingPort(s.deps).publishRationale(
      rationale({ rationale: 'the provider replied with xai-super-secret-value in the body' }),
    );
    assert.equal(sentPayload(s.calls)['rationale'],
      'the provider replied with xai-super-secret-value in the body');
  } finally {
    if (previous !== undefined) process.env['XAI_API_KEY'] = previous;
  }
});

test('an error message is redacted before it becomes a detail', async () => {
  const previous = process.env['XAI_API_KEY'];
  process.env['XAI_API_KEY'] = 'xai-super-secret-value';
  try {
    const s = scriptedQuery([new Error('auth failed for xai-super-secret-value')]);
    const out = await new SqlBenchmarkServingPort(s.deps).sealDecision(seal());
    assert.equal(out.outcome, 'unavailable');
    assert.ok(!JSON.stringify(out).includes('xai-super-secret-value'), 'the credential is gone');
    assert.match(out.outcome === 'unavailable' ? out.detail : '', /\[REDACTED\]/);
  } finally {
    if (previous === undefined) delete process.env['XAI_API_KEY'];
    else process.env['XAI_API_KEY'] = previous;
  }
});

test('a very long error detail is bounded', async () => {
  const s = scriptedQuery([new Error('x'.repeat(5000))]);
  const out = await new SqlBenchmarkServingPort(s.deps).sealDecision(seal());
  assert.ok(out.outcome === 'unavailable' && out.detail.length <= 300, 'detail is truncated');
});

// ---------------------------------------------------------------------------
// Client-side refusals — one per CHECK constraint they stand in for
// ---------------------------------------------------------------------------

async function refusal(call: (p: SqlBenchmarkServingPort) => Promise<PublishOutcome>): Promise<PublishOutcome> {
  const s = scriptedQuery([]);
  const out = await call(new SqlBenchmarkServingPort(s.deps));
  assert.equal(s.calls.length, 0, 'a refused payload never reaches the database');
  return out;
}

test('malformed digests are refused with the field that carried them', async () => {
  for (const bad of ['', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)} `, 'z'.repeat(64)]) {
    assert.deepEqual(await refusal((p) => p.sealDecision(seal({ forecastDigest: bad }))),
      { outcome: 'invalid_input', reason: 'malformed_digest', field: 'forecastDigest' },
      `digest=${JSON.stringify(bad)}`);
  }
  assert.deepEqual(await refusal((p) => p.sealDecision(seal({ rationaleDigest: 'nope' }))),
    { outcome: 'invalid_input', reason: 'malformed_digest', field: 'rationaleDigest' });
});

test('a valid digest is accepted — the digest check is not refusing everything', async () => {
  const s = scriptedQuery([OK]);
  assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).sealDecision(seal()), { outcome: 'published' });
});

test('naive and unparseable instants are refused', async () => {
  for (const bad of ['2026-08-09 20:06:00', '2026-08-09T20:06:00', 'yesterday', '']) {
    assert.deepEqual(await refusal((p) => p.sealDecision(seal({ sealedAt: bad }))),
      { outcome: 'invalid_input', reason: 'malformed_instant', field: 'sealedAt' },
      `instant=${JSON.stringify(bad)}`);
  }
});

test('a slate date must be a real calendar date, not merely the right shape', async () => {
  // `2026-13-45` passes a shape check and reaches the server as a 22008, which
  // arrives as `refused` quoting the value instead of a typed refusal naming the
  // field. Feb 29 is the discriminating case: valid in 2024, not in 2026.
  for (const bad of ['2026-13-01', '2026-00-01', '2026-02-30', '2026-04-31', '2026-02-29',
    '2026-8-9', '09/08/2026', '2026-08-09T00:00:00Z', '']) {
    assert.deepEqual(await refusal((p) => p.sealDecision(seal({ run: { ...RUN, slateDate: bad } }))),
      { outcome: 'invalid_input', reason: 'malformed_date', field: 'run.slateDate' },
      `slate=${JSON.stringify(bad)}`);
  }
  for (const good of ['2026-08-09', '2024-02-29', '2000-02-29', '2026-12-31']) {
    const s = scriptedQuery([OK]);
    assert.deepEqual(
      await new SqlBenchmarkServingPort(s.deps).sealDecision(seal({ run: { ...RUN, slateDate: good } })),
      { outcome: 'published' }, `slate=${good}`);
  }
});

test('a wallet must be lowercase hex of the right length', async () => {
  for (const bad of [`0x${'A'.repeat(40)}`, `0x${'1'.repeat(39)}`, '1'.repeat(42), '']) {
    assert.deepEqual(
      await refusal((p) => p.sealDecision(seal({ roster: { walletAddress: bad } }))),
      { outcome: 'invalid_input', reason: 'malformed_wallet', field: 'roster.walletAddress' },
      `wallet=${JSON.stringify(bad)}`);
  }
});

test('a non-model may not carry a lab id', async () => {
  assert.deepEqual(
    await refusal((p) => p.sealDecision(seal({
      participant: { participantId: 'baseline-x', kind: 'baseline', labId: 'alpha', displayName: 'X',
                     modelId: null, configuration: null },
      attemptOrdinal: null, roster: { walletAddress: null },
    }))),
    { outcome: 'invalid_input', reason: 'lab_id_on_non_model', field: 'participant.labId' },
  );
  // The converse is deliberately allowed: a model with no lab id is legitimate.
  // `{}` here rather than the awkward fixture, because "sets no knobs" is a real
  // shipped configuration and has to stay covered somewhere.
  const s = scriptedQuery([OK]);
  assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).sealDecision(seal({
    participant: { participantId: 'lab-alpha', kind: 'model', labId: null, displayName: 'Alpha',
                   modelId: 'alpha-v1', configuration: {} },
  })), { outcome: 'published' });
});

test('supplied_markets is bounded exactly as the CHECK bounds it', async () => {
  const bad: ReadonlyArray<readonly string[]> = [
    [], ['moneyline', 'moneyline'], ['moneyline', 'spread', 'total', 'moneyline'], ['runLine'],
  ];
  for (const markets of bad) {
    assert.deepEqual(
      await refusal((p) => p.publishAttempt(attempt({
        facts: { ...FACTS, suppliedMarkets: markets as never },
      }))),
      { outcome: 'invalid_input', reason: 'supplied_markets_malformed', field: 'facts.suppliedMarkets' },
      `markets=${JSON.stringify(markets)}`);
  }
  // ...and all three together are fine, so the bound is not simply refusing.
  const s = scriptedQuery([OK]);
  assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).publishAttempt(attempt({
    facts: { ...FACTS, suppliedMarkets: ['moneyline', 'spread', 'total'] },
  })), { outcome: 'published' });
});

test('an attempt that was never sent may not describe a provider response', async () => {
  assert.deepEqual(
    await refusal((p) => p.publishAttempt(attempt({ facts: { ...FACTS, sent: false } }))),
    { outcome: 'invalid_input', reason: 'unsent_attempt_has_response', field: 'facts.sent' },
  );
});

test('the attempt ordinal admits only the initial call and its repair', async () => {
  for (const ordinal of [-1, 2, 1.5]) {
    assert.deepEqual(
      await refusal((p) => p.publishAttempt(attempt({ facts: { ...FACTS, attemptOrdinal: ordinal } }))),
      { outcome: 'invalid_input', reason: 'attempt_ordinal_out_of_range', field: 'facts.attemptOrdinal' },
      `ordinal=${ordinal}`);
    assert.deepEqual(
      await refusal((p) => p.sealDecision(seal({ attemptOrdinal: ordinal }))),
      { outcome: 'invalid_input', reason: 'attempt_ordinal_out_of_range', field: 'attemptOrdinal' },
      `seal ordinal=${ordinal}`);
  }
  // Both admitted ordinals are accepted — a repaired arm publishes two rows.
  for (const ordinal of [0, 1]) {
    const s = scriptedQuery([OK]);
    assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).publishAttempt(
      attempt({ facts: { ...FACTS, attemptOrdinal: ordinal } })), { outcome: 'published' });
  }
});

test('probabilities and axes are bounded', async () => {
  for (const value of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(await refusal((p) => p.revealDecision(reveal({ probWin: value }))),
      { outcome: 'invalid_input', reason: 'number_out_of_range', field: 'probWin' }, `prob=${value}`);
  }
  for (const value of [0, 6, 2.5]) {
    assert.deepEqual(await refusal((p) => p.revealDecision(reveal({ axisTrend: value }))),
      { outcome: 'invalid_input', reason: 'number_out_of_range', field: 'axisTrend' }, `axis=${value}`);
  }
  // The endpoints are inside the domain.
  const s = scriptedQuery([OK]);
  assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).revealDecision(
    reveal({ probWin: 0, probLoss: 1, axisTrend: 1, axisSoftness: 5 })), { outcome: 'published' });
});

test('an axis name outside the five is refused', async () => {
  assert.deepEqual(await refusal((p) => p.revealDecision(reveal({ primaryAxis: 'vibes' }))),
    { outcome: 'invalid_input', reason: 'malformed_identifier', field: 'primaryAxis' });
});

test('a market outside the domain is refused, wherever it appears', async () => {
  assert.deepEqual(await refusal((p) => p.sealDecision(seal({ market: 'runLine' as never }))),
    { outcome: 'invalid_input', reason: 'market_out_of_domain', field: 'market' });
  assert.deepEqual(await refusal((p) => p.publishScore(score({
    decision: { cohortId: 'c', participantId: 'p', gameId: 'g', market: 'runLine' as never },
  }))), { outcome: 'invalid_input', reason: 'market_out_of_domain', field: 'decision.market' });
});

test('a refusal and its reason must agree in both directions', async () => {
  assert.deepEqual(await refusal((p) => p.publishScore(score({ refused: true, refusalReason: null }))),
    { outcome: 'invalid_input', reason: 'refusal_reason_mismatch', field: 'refused' });
  assert.deepEqual(await refusal((p) => p.publishScore(score({ refused: false, refusalReason: 'no_close' }))),
    { outcome: 'invalid_input', reason: 'refusal_reason_mismatch', field: 'refused' });
});

test('a NUL byte in text is refused here rather than becoming a raw 22P05', async () => {
  const nul = String.fromCharCode(0);
  assert.deepEqual(await refusal((p) => p.sealDecision(seal({ gameId: `game${nul}1` }))),
    { outcome: 'invalid_input', reason: 'malformed_identifier', field: 'gameId' });
  assert.deepEqual(await refusal((p) => p.publishRationale(rationale({ rationale: `prose${nul}` }))),
    { outcome: 'invalid_input', reason: 'malformed_identifier', field: 'rationale' });
});

test('an empty identifier is refused', async () => {
  assert.deepEqual(await refusal((p) => p.sealDecision(seal({ gameId: '' }))),
    { outcome: 'invalid_input', reason: 'malformed_identifier', field: 'gameId' });
});

test('a network outside the enum is refused before the cast', async () => {
  assert.deepEqual(
    await refusal((p) => p.sealDecision(seal({ run: { ...RUN, network: 'ethereum' as never } }))),
    { outcome: 'invalid_input', reason: 'network_out_of_domain', field: 'run.network' });
});

// ---------------------------------------------------------------------------
// Attempt eligibility - resolving an attempt is not the same as it being usable
// ---------------------------------------------------------------------------

test('an attempt that exists but cannot carry the forecast is its own outcome', async () => {
  // Distinct from parent_missing on purpose: "you published the wrong attempt"
  // and "you published none" are different producer bugs. All three of these
  // landed a PUBLISHED decision before the eligibility test existed.
  for (const reason of ['unsent', 'outcome_not_accepted', 'market_not_supplied']) {
    const s = scriptedQuery([row({ ineligible_reason: reason, parent_found: 0, inserted: 0 })]);
    assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).sealDecision(seal()),
      { outcome: 'attempt_not_eligible', reason }, reason);
  }
});

test('the seal statement tests all three eligibility conditions', () => {
  // Anchored on the executable comparison, not the prose explaining it: a
  // substring test for a word like "unsent" would match the comment too.
  assert.match(SERVING_STATEMENTS.seal, /array\[not cited\.sent,/);
  assert.match(SERVING_STATEMENTS.seal, /not \(cited\.outcome = any\(input\.accepted_outcomes\)\)/);
  assert.match(SERVING_STATEMENTS.seal, /not \(input\.market = any\(cited\.supplied_markets\)\)/);
});

test('the accepted-outcome set is sent with the seal, not assumed by the SQL', async () => {
  const s = scriptedQuery([OK]);
  await new SqlBenchmarkServingPort(s.deps).sealDecision(seal());
  assert.deepEqual(sentPayload(s.calls)['accepted_outcomes'], [...ACCEPTED_ATTEMPT_OUTCOMES]);
  assert.deepEqual([...ACCEPTED_ATTEMPT_OUTCOMES], ['valid'],
    'widening this is a deliberate change to what may carry a decision');
});

// ---------------------------------------------------------------------------
// Durable-fact drift, and the write suppression that goes with it
// ---------------------------------------------------------------------------

test('every durable parent fact a caller supplies is compared against the stored one', () => {
  // A participant first written as kind=model and later sealed against as a
  // baseline produced a published decision with attempt_id NULL under a
  // participant the database still calls a model. The model_without_attempt
  // guard checks what the CALLER said; only this comparison sees what is stored.
  for (const fragment of [
    /'participant\.kind','participant\.labId','participant\.displayName'/,
    /p\.kind\s+is distinct from input\.kind/,
    // The entrant key the database indexes uniquely, all three parts of it. A
    // participant re-sealed at a DIFFERENT setting is a different competitor,
    // and absorbing that silently would score two configurations as one.
    /p\.model_id\s+is distinct from input\.model_id/,
    /p\.configuration is distinct from input\.configuration_canonical::jsonb/,
    /p\.configuration_sha256 is distinct from input\.configuration_sha256/,
    /array\['roster\.walletAddress'\]/,
    /'run\.slateDate','run\.startedAt'/,
    /r\.slate_date\s+is distinct from input\.slate_date/,
  ]) {
    assert.match(SERVING_STATEMENTS.seal, fragment);
    assert.match(SERVING_STATEMENTS.attempt, fragment);
  }
});

/**
 * Pull the two parallel arrays out of every `unnest(array[…], array[…])` in a
 * statement. Depth-aware for the same reason `declaredColumns` is: a cast or a
 * function call inside an element puts commas at a deeper level.
 *
 * SQL LINE COMMENTS ARE STRIPPED FIRST, and that is not tidiness. The comment
 * explaining the jsonb comparison inside the participant drift check contains a
 * comma, which counted as an extra element and reported 7 names against 8
 * comparisons on correct SQL. None of these statements has a `--` inside a
 * string literal, so the strip is safe here and would need revisiting if one
 * ever did.
 */
function unnestPairs(source: string): Array<readonly [names: number, flags: number]> {
  const sql = source.replace(/--[^\n]*/g, '');
  const pairs: Array<readonly [number, number]> = [];
  const marker = 'unnest(';
  for (let at = sql.indexOf(marker); at !== -1; at = sql.indexOf(marker, at + 1)) {
    let depth = 0;
    let end = -1;
    for (let i = at + marker.length - 1; i < sql.length; i += 1) {
      if (sql[i] === '(') depth += 1;
      else if (sql[i] === ')') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    assert.notEqual(end, -1, 'the unnest call is balanced');
    // The arguments, split at depth 1 relative to `unnest(` — each is an
    // `array[…]` literal, whose own elements are one level deeper again.
    const counts: number[] = [];
    let elements = 1;
    depth = 0;
    for (let i = at + marker.length; i < end; i += 1) {
      const ch = sql[i];
      if (ch === '(' || ch === '[') depth += 1;
      else if (ch === ')' || ch === ']') {
        depth -= 1;
        if (depth === 0) { counts.push(elements); elements = 1; }
      } else if (ch === ',' && depth === 1) elements += 1;
    }
    assert.equal(counts.length, 2, `unnest takes two arrays, found ${counts.length}`);
    pairs.push([counts[0]!, counts[1]!]);
  }
  return pairs;
}

test('every drift check names exactly as many fields as it tests', () => {
  // `unnest` pads the shorter array with NULLs. A name with no flag is silently
  // never checked; a flag with no name yields a differing row labelled NULL,
  // which `min()` drops. The second is survivable only because `drift_rows`
  // reports on the COUNT — the first is not detectable at all at runtime, which
  // is why it is pinned here on the SQL text.
  let checked = 0;
  for (const [name, sql] of Object.entries(SERVING_STATEMENTS)) {
    for (const [names, flags] of unnestPairs(sql)) {
      assert.equal(names, flags, `${name}: ${names} field names against ${flags} comparisons`);
      checked += 1;
    }
  }
  // Negative control on the parser: it has to have found the four drift checks
  // in each of the two serialized statements, or it is asserting over nothing.
  // A floor rather than an equality, so adding a drift check does not redden
  // this while DELETING one still does. Measured at 8.
  assert.ok(checked >= 8, `expected at least 8 unnest pairs, parsed ${checked}`);
});

test('the parser counts elements, not commas at any depth or inside a comment', () => {
  // Its own negative control. Were this depth-blind, a cast or a nested call
  // would inflate one side and the assertion above would fail on correct SQL —
  // or, worse, agree by coincidence. The comment case is not hypothetical: it
  // is what the real participant drift check looks like.
  assert.deepEqual(unnestPairs("unnest(array['a','b'], array[x is distinct from y, f(p, q)])"), [[2, 2]]);
  assert.deepEqual(unnestPairs("unnest(array['a'], array[c::jsonb is distinct from d])"), [[1, 1]]);
  assert.deepEqual(unnestPairs('unnest(\n  array[\'a\',\'b\'],\n  array[p,\n        -- semantic, not textual\n        q]\n)'), [[2, 2]]);
  // ...and it still catches a genuine mismatch, so stripping comments has not
  // turned the check into one that always agrees.
  assert.deepEqual(unnestPairs("unnest(array['a','b'], array[t])"), [[2, 1]]);
});

// ---------------------------------------------------------------------------
// The entrant key: a model declares a model and a setting, a control neither
// ---------------------------------------------------------------------------

test('the kind rule is enforced in BOTH directions', async () => {
  // Half of the pair is the interesting failure: a model carrying a modelId and
  // a null configuration satisfies "it has a model" and is a permanently
  // dimensionless entrant, because the row is insert-once.
  const cases: ReadonlyArray<readonly [string, Partial<ParticipantFacts>, string, string]> = [
    ['a model with no configuration', { configuration: null },
      'model_without_configuration', 'participant.configuration'],
    ['a model with no model id', { modelId: null },
      'model_without_configuration', 'participant.configuration'],
    ['a model with neither', { modelId: null, configuration: null },
      'model_without_configuration', 'participant.configuration'],
  ];
  for (const [label, patch, reason, field] of cases) {
    assert.deepEqual(
      await refusal((p) => p.publishAttempt(attempt({ participant: { ...MODEL, ...patch } }))),
      { outcome: 'invalid_input', reason, field }, label);
  }
  // ...and the other direction, on every non-model kind rather than one of them.
  for (const kind of ['baseline', 'maker', 'human'] as const) {
    for (const patch of [{ modelId: 'alpha-v1' }, { configuration: AWKWARD_CONFIGURATION }]) {
      assert.deepEqual(
        await refusal((p) => p.sealDecision(seal({
          participant: { ...BASELINE, kind, ...patch }, attemptOrdinal: null,
          roster: { walletAddress: null },
        }))),
        { outcome: 'invalid_input', reason: 'configuration_on_non_model', field: 'participant.modelId' },
        `${kind} ${JSON.stringify(patch)}`);
    }
  }
});

test('a configuration the digest grammar refuses never reaches the database', async () => {
  // The same grammar the artifact stamp is held to, checked here because the
  // database can only answer with a 22P02 or a CHECK name — neither of which
  // says which key was wrong.
  const out = await refusal((p) => p.publishAttempt(attempt({
    participant: { ...MODEL, configuration: { nested: {} } },
  })));
  assert.equal(out.outcome, 'invalid_input');
  assert.equal(out.outcome === 'invalid_input' ? out.reason : '', 'malformed_configuration');
  assert.ok(out.outcome === 'invalid_input' && out.field.startsWith('participant.configuration'),
    `the refusal names the offending key, got ${out.outcome === 'invalid_input' ? out.field : ''}`);
});

test('the digest and its version are DERIVED from the configuration, never supplied', async () => {
  // A caller that passed both could pass two that disagree, and the row is
  // insert-once, so the wrong one would be permanent. The configuration crosses
  // as its CANONICAL TEXT so what PostgreSQL parses is exactly what was hashed.
  const s = scriptedQuery([OK]);
  await new SqlBenchmarkServingPort(s.deps).publishAttempt(attempt());
  const sent = sentPayload(s.calls);
  assert.equal(sent['model_id'], 'alpha-v1');
  assert.equal(sent['configuration_canonical'], canonicalConfigurationText(AWKWARD_CONFIGURATION));
  assert.equal(sent['configuration_sha256'], configurationSha256(AWKWARD_CONFIGURATION));
  assert.equal(sent['configuration_digest_version'], 1);
  // The canonical text is not merely `JSON.stringify` of the object — the
  // fixture's key order and its non-ASCII key are what discriminate the two.
  assert.notEqual(sent['configuration_canonical'], JSON.stringify(AWKWARD_CONFIGURATION));

  // A control sends all four as null, which is what the database's own CHECK
  // requires of a non-model.
  const control = scriptedQuery([OK]);
  await new SqlBenchmarkServingPort(control.deps).sealDecision(seal({
    participant: BASELINE, attemptOrdinal: null, roster: { walletAddress: null },
  }));
  const blank = sentPayload(control.calls);
  for (const key of ['model_id', 'configuration_canonical', 'configuration_sha256',
    'configuration_digest_version']) {
    assert.equal(blank[key], null, `${key} is null on a control`);
  }
});

test('a contradiction or an unusable attempt writes NOTHING, including the parents', () => {
  // parent_missing used to commit a run, a participant and a roster row while
  // reporting that nothing was inserted, and the roster it left behind was
  // immutable, so publishing the real attempt afterwards could only contradict it.
  for (const sql of [SERVING_STATEMENTS.seal, SERVING_STATEMENTS.attempt]) {
    assert.match(sql, /not exists \(select 1 from drift\) and exists \(select 1 from child_ready\) as ok/);
    const inserts = sql.split('insert into public.').length - 1;
    const gated = sql.split('where gate.ok').length - 1;
    assert.equal(gated, inserts, `all ${inserts} inserts gated, found ${gated}`);
  }
});

// ---------------------------------------------------------------------------
// The post-write verification
// ---------------------------------------------------------------------------

test('a seal and an attempt take the lock BEFORE the write; the others do not', async () => {
  // The drift check inside a single statement reads a snapshot taken before the
  // statement began, so a concurrent writer that has not committed is invisible
  // — the gate passes, the child lands, and nothing checked afterwards can
  // un-commit it. Measured before this: a hundred conflicting-wallet races all
  // reported `contradiction` and 58 had written their child anyway.
  for (const [name, call] of EVERY_METHOD) {
    const s = scriptedQuery([OK]);
    await call(new SqlBenchmarkServingPort(s.deps));
    const serialized = name === 'sealDecision' || name === 'publishAttempt';
    assert.equal(s.locks(), serialized ? 1 : 0, `${name} locks`);
    if (serialized) {
      assert.equal(s.calls[0]!.sql, SERVING_STATEMENTS.lock, `${name}: lock comes FIRST`);
      assert.notEqual(s.calls[1]!.sql, SERVING_STATEMENTS.lock, `${name}: then the write`);
    }
  }
});

test('the lock is taken on the participant and the cohort, in that order', async () => {
  // Run and roster rows are cohort-scoped, but benchmark_participants is keyed
  // by participant alone and shared across cohorts, so a cohort-only lock leaves
  // a first-write race on a participant two cohorts introduce at once. A single
  // fixed order everywhere is what makes a deadlock cycle impossible.
  const s = scriptedQuery([OK]);
  await new SqlBenchmarkServingPort(s.deps).sealDecision(seal());
  assert.deepEqual(s.calls[0]!.params, ['lab-alpha', 'cohort-x']);
  assert.match(SERVING_STATEMENTS.lock, /participant:' \|\| \$1[\s\S]*cohort:' \|\| \$2/);
});

test('the lock keys come from the payload that was already built', async () => {
  // Deriving them separately would let the lock and the write disagree about
  // which rows they cover, which is the one thing the lock exists to prevent.
  const s = scriptedQuery([OK]);
  await new SqlBenchmarkServingPort(s.deps).publishAttempt(attempt({
    run: { ...RUN, cohortId: 'other-cohort' },
    participant: { ...MODEL, participantId: 'other-participant' },
  }));
  const payload = sentPayload(s.calls);
  assert.deepEqual(s.calls[0]!.params, [payload['participant_id'], payload['cohort_id']]);
});

test('a serialized write runs the lock and the statement on ONE connection', async () => {
  // Two commands on different connections would not share the transaction, and
  // the second would not get the post-lock snapshot the whole design rests on.
  const seen: string[][] = [];
  let opened = 0;
  const query: StoreQuery = async (sql) => {
    seen[opened - 1]!.push(sql === SERVING_STATEMENTS.lock ? 'lock' : 'write');
    return OK;
  };
  const deps: ServingStoreDeps = {
    query: async () => { throw new Error('a serialized write must not use the loose query'); },
    transactor: { transaction: async (fn) => { opened += 1; seen.push([]); return fn(query); } },
  };
  assert.deepEqual(await new SqlBenchmarkServingPort(deps).sealDecision(seal()), { outcome: 'published' });
  assert.equal(opened, 1, 'one transaction');
  assert.deepEqual(seen[0], ['lock', 'write'], 'both commands inside it, in order');
});

// ---------------------------------------------------------------------------
// Fail-soft: serialisation is inside the boundary
// ---------------------------------------------------------------------------

test('a value that cannot be serialised is a typed refusal, not a thrown TypeError', async () => {
  // Measured on the previous build: turnCompleted: 1n reached JSON.stringify
  // outside the try and threw straight out of a method documented never to throw.
  const s = scriptedQuery([]);
  const out = await new SqlBenchmarkServingPort(s.deps).publishAttempt(
    attempt({ facts: { ...FACTS, turnCompleted: 1n as unknown as boolean } }));
  assert.deepEqual(out, { outcome: 'invalid_input', reason: 'not_a_boolean', field: 'facts.turnCompleted' });
  assert.equal(s.writes(), 0, 'it never reached the database');
});

test('every boolean field is type-checked rather than passed through', async () => {
  const bad = 1n as unknown as boolean;
  const cases: ReadonlyArray<readonly [string, (p: SqlBenchmarkServingPort) => Promise<PublishOutcome>]> = [
    ['facts.sent', (p) => p.publishAttempt(attempt({ facts: { ...FACTS, sent: bad } }))],
    ['wouldAbstain', (p) => p.revealDecision(reveal({ wouldAbstain: bad }))],
    ['selectedForExecution', (p) => p.revealDecision(reveal({ selectedForExecution: bad }))],
    ['scheduleChanged', (p) => p.publishScore(score({ scheduleChanged: bad }))],
    ['heldOutOfPrimary', (p) => p.publishScore(score({ heldOutOfPrimary: bad }))],
    ['rankingAllowed', (p) => p.publishScoringRun(scoringRun({ rankingAllowed: bad }))],
    ['costPerPickComparable', (p) => p.publishScoringRun(scoringRun({ costPerPickComparable: bad }))],
  ];
  for (const [field, call] of cases) {
    const out = await refusal(call);
    assert.equal(out.outcome, 'invalid_input', field);
    assert.equal(out.outcome === 'invalid_input' ? out.field : '', field);
    assert.equal(out.outcome === 'invalid_input' ? out.reason : '', 'not_a_boolean', field);
  }
});

test('an integer beyond a PostgreSQL int is refused here, not by the driver', async () => {
  const over = 2_147_483_648;
  const cases: ReadonlyArray<readonly [string, (p: SqlBenchmarkServingPort) => Promise<PublishOutcome>]> = [
    ['facts.latencyMs', (p) => p.publishAttempt(attempt({ facts: { ...FACTS, latencyMs: over } }))],
    ['facts.inputTokens', (p) => p.publishAttempt(attempt({ facts: { ...FACTS, inputTokens: over } }))],
    ['eligible', (p) => p.publishScoringRun(scoringRun({ eligible: over }))],
  ];
  for (const [field, call] of cases) {
    assert.deepEqual(await refusal(call),
      { outcome: 'invalid_input', reason: 'number_out_of_range', field }, field);
  }
  // ...and the largest value that DOES fit is accepted, so the bound is not
  // simply refusing everything large.
  const s = scriptedQuery([OK]);
  assert.deepEqual(await new SqlBenchmarkServingPort(s.deps).publishAttempt(
    attempt({ facts: { ...FACTS, latencyMs: 2_147_483_647 } })), { outcome: 'published' });
});

test('every drift source LABELS its padded row, so min() can never drop one', () => {
  // The other half of the cardinality check above. That one catches a mismatch
  // at review time; this catches a drift CTE added later WITHOUT the coalesce,
  // which is the shape that reintroduces "a suppressed write reported as a
  // duplicate".
  //
  // Anchored on executable structure, not on a phrase: the regex requires the
  // coalesced select to be immediately followed by the `from` line of a real
  // table. The surrounding comments in servingStore.ts discuss coalescing at
  // length, and a looser matcher would happily match the prose (rule 3c).
  // `[^\n]*,` after the source covers the table alias — `from public.foo p, input,`.
  const LABELLED = /select coalesce\(t\.f, '[a-z.]+'\) as f\s*\n\s*from (?:public\.\w+|cited)[^\n]*,/g;
  const BARE = /select t\.f\s*\n\s*from (?:public\.\w+|cited)[^\n]*,/g;

  for (const [name, sql] of [
    ['attempt', SERVING_STATEMENTS.attempt],
    ['seal', SERVING_STATEMENTS.seal],
  ] as const) {
    const bare = sql.match(BARE) ?? [];
    assert.deepEqual(bare, [], `${name} has an unlabelled drift source: ${bare.join(' | ')}`);
  }
  // A floor, so deleting a whole drift source reddens. The attempt statement
  // labels run, participant, roster and the attempt facts; the seal labels the
  // first three plus its eligibility reasons.
  assert.ok((SERVING_STATEMENTS.attempt.match(LABELLED) ?? []).length >= 4,
    'the attempt statement labels four drift sources');
  assert.ok((SERVING_STATEMENTS.seal.match(LABELLED) ?? []).length >= 4,
    'the seal statement labels three drift sources and its eligibility reasons');

  // NEGATIVE CONTROL: the matcher must actually reject the bare form, or the
  // assertions above are green against anything.
  const stripped = SERVING_STATEMENTS.attempt.replaceAll("coalesce(t.f, 'drift.unlabelled') as f", 't.f');
  assert.ok((stripped.match(BARE) ?? []).length >= 4, 'the bare matcher recognises what it is looking for');
});
