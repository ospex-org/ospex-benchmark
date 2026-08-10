import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildBundle } from './bundle.js';
import { runBaselines } from './baselines.js';
import { DEPLOYMENT_ROUND, NETWORK } from './config.js';
import { forecastDigest } from './schema.js';
import { ARMS } from './providers/index.js';
import { PROJECTION_PARTICIPANTS, projectionParticipant } from './servingIdentity.js';
import { asEnrolled, firedRun, fullBoardInputs, TEST_SLATE_DATE } from './servingTestRun.js';
import { projectRun, publishableRun, revealMatchesSeal } from './servingProjection.js';
import type { FiredRun } from './servingTestRun.js';
import type { JsonRecord, ProjectionPlan } from './servingProjection.js';

/**
 * The projector, probed against artifacts the RUNNER actually wrote.
 *
 * Every case below fires a real game through `fireEligibleGame` and then reads
 * the `.ndjson` off disk, rather than hand-writing the records. That is the
 * whole point: the reader's only contract is with the writer, and a hand-built
 * fixture would keep passing on the day `buildRecords` renames a field. A run
 * that produces no attempts or no decisions is therefore itself a failure, and
 * several cases assert exactly that before asserting anything finer.
 */

// ---------------------------------------------------------------------------
// A real fired run
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const NOW_MS = Date.parse('2026-07-20T12:00:30.000Z');

/** One real fired game, written to a temp dir this file cleans up. */
async function fire(
  options: { enrolled?: boolean; mode?: 'live' | 'dry-run' } = {},
): Promise<FiredRun> {
  return firedRun({ outDir: tempDir('serving-projection-'), ...options });
}

const NO_SOURCE = { sourcePath: null, sourceSha256: null };
const FIXED_CLOCK = { now: (): string => '2026-07-20T18:00:00.000Z' };

function planFor(run: FiredRun): ProjectionPlan {
  const gate = publishableRun(run.records);
  assert.ok(gate.publishable, `the run should be publishable: ${JSON.stringify(gate)}`);
  return projectRun(run.records, gate.header, NO_SOURCE, FIXED_CLOCK);
}

function planOf(records: readonly JsonRecord[]): ProjectionPlan {
  const gate = publishableRun(records);
  assert.ok(gate.publishable, `expected publishable, got ${JSON.stringify(gate)}`);
  return projectRun(records, gate.header, NO_SOURCE, FIXED_CLOCK);
}

// ---------------------------------------------------------------------------
// The gate — both directions
// ---------------------------------------------------------------------------

test('a clean live run is publishable, and every gate has something to refuse', async () => {
  const run = await fire();
  // The positive half is the negative control for all six below: without it,
  // every refusal case would still pass against a gate that refuses everything.
  assert.equal(publishableRun(run.records).publishable, true);

  const meta = run.records.find((record) => record['recordType'] === 'run_meta');
  assert.ok(meta);

  const withMeta = (patch: JsonRecord): JsonRecord[] =>
    run.records.map((record) => (record === meta ? { ...record, ...patch } : record));

  const refusals: Array<[label: string, records: JsonRecord[]]> = [
    ['a dry run', withMeta({ mode: 'dry-run' })],
    ['a synthetic clock', withMeta({ clockMode: 'synthetic-fixture' })],
    ['a foreign cohort', withMeta({ cohortId: 'campaign-a1b2c3' })],
    ['a bare slate-date cohort', withMeta({ cohortId: '2026-07-20' })],
    ['no projection stamp', withMeta({ projection: undefined })],
    ['an unknown network', withMeta({ projection: { ...(meta['projection'] as JsonRecord), network: 'sepolia' } })],
    ['no run_meta at all', run.records.filter((record) => record !== meta) as JsonRecord[]],
    [
      'a recorded identity failure',
      [...run.records, { recordType: 'run_failure', code: 'MODEL_IDENTITY', failures: ['x'] }],
    ],
  ];

  for (const [label, records] of refusals) {
    const gate = publishableRun(records);
    assert.equal(gate.publishable, false, `${label} must not be publishable`);
  }
});

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

test('an unenrolled participant is skipped with a reason, never named at write time', async () => {
  const run = await fire();
  const plan = planFor(run);
  // TEST_ARM is not in the registry, so its attempt and its three decisions are
  // all refused — and the reasons say so rather than the rows appearing under
  // an invented display name.
  assert.equal(plan.attempts.length, 0);
  assert.equal(plan.decisions.filter((d) => d.seal.participant.kind === 'model').length, 0);
  assert.ok(plan.skipped.some((reason) => reason.includes('not enrolled')));
  assert.ok(
    plan.skipped.filter((reason) => reason.includes('not enrolled')).length >= 4,
    'the attempt and each of its three decisions should each say why',
  );
});

test('the controls DO publish, because they are enrolled', async () => {
  const plan = planFor(await fire());
  const baselines = plan.decisions.filter((d) => d.seal.participant.kind === 'baseline');
  // A full board yields eight controls: four moneyline, two total, two run line.
  assert.equal(baselines.length, 8);
  for (const { seal, reveal, rationale } of baselines) {
    assert.equal(seal.attemptOrdinal, null, 'a control makes no provider call');
    assert.equal(seal.participant.labId, null, 'a control is never bucketed under a lab');
    assert.equal(seal.rationaleDigest, null);
    assert.equal(seal.responseSchemaVersion, null);
    assert.equal(rationale, null, 'a control authored no prose');
    assert.equal(reveal.probWin, null);
    assert.equal(reveal.confidence, null);
    assert.equal(reveal.axisValuation, null);
    assert.ok(reveal.selection.length > 0);
    assert.ok(typeof reveal.observedDecimal === 'number');
  }
});

// ---------------------------------------------------------------------------
// The eligible denominator
// ---------------------------------------------------------------------------

test('a full board publishes all three, with the run line named "spread"', async () => {
  const plan = planOf(asEnrolled((await fire()).records));
  assert.ok(plan.attempts.length > 0);
  for (const attempt of plan.attempts) {
    // The bundle stores the run line under `runLine`; the response and the
    // projection both call it `spread`, and that mapping is the repo's own.
    assert.deepEqual([...attempt.facts.suppliedMarkets], ['moneyline', 'spread', 'total']);
  }
});

test('suppliedMarkets states what the BUNDLE offered, not what came back', async () => {
  // The discriminating input: strip a market from the RECORDED BUNDLE while
  // leaving all three forecasts in the response. Derived from the response the
  // answer is three — the denominator equal to the numerator, every coverage
  // figure reading 100%. Derived from the bundle it is two.
  const records = asEnrolled((await fire()).records).map((record) => {
    if (record['recordType'] !== 'bundle_game') return record;
    const bundle = record['bundle'] as JsonRecord;
    const markets = { ...(bundle['markets'] as JsonRecord) };
    delete markets['runLine'];
    return { ...record, bundle: { ...bundle, markets } };
  });

  const decisions = records.filter((record) => record['recordType'] === 'decision');
  assert.equal(decisions.length, 3, 'the response must still carry all three, or nothing is proven');

  const plan = planOf(records);
  assert.ok(plan.attempts.length > 0);
  for (const attempt of plan.attempts) {
    assert.deepEqual([...attempt.facts.suppliedMarkets], ['moneyline', 'total']);
  }
});

test('an attempt whose game has no recorded bundle is skipped, not given a guess', async () => {
  const records = asEnrolled((await fire()).records).filter(
    (record) => record['recordType'] !== 'bundle_game',
  );
  const plan = planOf(records);
  assert.equal(plan.attempts.length, 0);
  assert.ok(plan.skipped.some((reason) => reason.includes('supplies its markets')));
});

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------

test('an arm that made one call publishes exactly ordinal 0, marked sent', async () => {
  const run = await fire();
  const rewritten = asEnrolled(run.records);
  const plan = planOf(rewritten);

  assert.equal(plan.attempts.length, 1);
  const attempt = plan.attempts[0]!;
  assert.equal(attempt.facts.attemptOrdinal, 0);
  assert.equal(attempt.facts.sent, true);
  assert.equal(attempt.facts.outcome, 'valid');
  assert.equal(attempt.facts.httpStatus, 200);
  assert.equal(attempt.facts.reportedModelId, 'stub-model-1');
  assert.equal(attempt.facts.inputTokens, 100);
  assert.equal(attempt.facts.outputTokens, 50);
  // The adapter reports no comparable-usage split and no search audit at all.
  // Every one of these is UNKNOWN and must never be published as a zero.
  assert.equal(attempt.facts.reasoningTokens, null);
  assert.equal(attempt.facts.billableSearchCount, null);
  assert.equal(attempt.facts.searchEvidenceStatus, 'no_search_evidence');
  // No cost is computed on this path, so no price table priced it.
  assert.equal(attempt.facts.costUsd, null);
  assert.equal(attempt.facts.priceVersion, null);
  assert.ok(typeof attempt.facts.responseAt === 'string', 'a received response has a receipt');
});

test('the participant is the durable lab and the version lives on the roster', async () => {
  const run = await fire();
  const enrolled = ARMS[1]!.participantId; // anthropic-claude-fable-5
  const plan = planOf(asEnrolled(run.records, 1));
  const attempt = plan.attempts[0]!;

  assert.equal(attempt.participant.participantId, 'lab-anthropic');
  assert.equal(attempt.participant.kind, 'model');
  assert.equal(attempt.participant.labId, 'anthropic');
  assert.equal(attempt.participant.displayName, 'Anthropic');
  // The version-scoped id is the runner's own participant id, and it is the
  // ONLY place the model version appears. A model deprecation mints a new one
  // of these under the same participant.
  assert.equal(attempt.roster.armId, enrolled);
  assert.equal(attempt.roster.walletAddress, null);
});

// ---------------------------------------------------------------------------
// The commitment
// ---------------------------------------------------------------------------

test("a model's published digest is exactly forecastDigest() of the forecast it came from", async () => {
  const run = await fire();
  const rewritten = asEnrolled(run.records);
  const plan = planOf(rewritten);

  const models = plan.decisions.filter((d) => d.seal.participant.kind === 'model');
  assert.equal(models.length, 3, 'a full board seals three markets');

  // Rebuilt from the artifact's own decision records through the PUBLIC digest
  // function, so this compares the projector's composition against the one the
  // repair check and the golden already pin. A composition that drifted would
  // still be 64 hex characters and would still store, silently unverifiable
  // forever — this is what makes that loud.
  for (const { seal } of models) {
    const record = rewritten.find(
      (r) =>
        r['recordType'] === 'decision' &&
        r['gameId'] === seal.gameId &&
        r['market'] === seal.market,
    );
    assert.ok(record);
    const probabilities = record['probabilities'] as { win: number; push: number; loss: number };
    assert.equal(
      seal.forecastDigest,
      forecastDigest({
        market: seal.market,
        selection: record['selection'] as string,
        line: record['line'] as number | null,
        observedDecimal: record['observedDecimal'] as number,
        probabilities,
        confidence: record['confidence'] as number,
        wouldAbstain: record['wouldAbstain'] as boolean,
        selectedForExecution: record['selectedForExecution'] as boolean,
        rationale: record['rationale'] as string,
        evidenceRefs: record['evidenceRefs'] as string[],
        axes: (record['axes'] ?? undefined) as never,
        primaryAxis: (record['primaryAxis'] ?? undefined) as never,
        primaryExpectation: (record['primaryExpectation'] ?? undefined) as never,
      }),
    );
  }
});

test('every reveal reproduces its own seal, for both kinds of participant', async () => {
  const run = await fire();
  const rewritten = asEnrolled(run.records);
  const plan = planOf(rewritten);

  const kinds = new Set(plan.decisions.map((d) => d.seal.participant.kind));
  assert.deepEqual([...kinds].sort(), ['baseline', 'model'], 'both kinds must be exercised');
  for (const decision of plan.decisions) assert.equal(revealMatchesSeal(decision), true);
});

test('the reveal check catches a transposition the database would accept', async () => {
  const run = await fire();
  const rewritten = asEnrolled(run.records);
  const plan = planOf(rewritten);

  const model = plan.decisions.find(
    (d) => d.seal.participant.kind === 'model' && d.reveal.probWin !== d.reveal.probLoss,
  );
  assert.ok(model, 'need a decision whose win and loss differ, or the swap is a no-op');
  // The reveal write has no drift check of its own, so this is the only thing
  // between a transposed pair and a permanently unverifiable public row.
  assert.equal(
    revealMatchesSeal({
      ...model,
      reveal: { ...model.reveal, probWin: model.reveal.probLoss, probLoss: model.reveal.probWin },
    }),
    false,
  );
  // …and so is a confidence that moved. The delta is 1e-7, comfortably above
  // the column's 8-decimal scale: a smaller one is absorbed by the quantiser on
  // both sides and would let a real mapping error through while the case
  // stayed green.
  assert.equal(
    revealMatchesSeal({
      ...model,
      reveal: { ...model.reveal, confidence: (model.reveal.confidence ?? 0) + 1e-7 },
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Nothing in the plan may come from the process doing the publishing
// ---------------------------------------------------------------------------

test('the plan is a pure function of the artifact, whatever the build thinks today', async () => {
  const run = await fire();
  const gate = publishableRun(run.records);
  assert.ok(gate.publishable);

  const first = projectRun(run.records, gate.header, NO_SOURCE, FIXED_CLOCK);
  const later = projectRun(run.records, gate.header, NO_SOURCE, {
    now: () => '2027-01-01T00:00:00.000Z',
  });

  // Only the reveal instant may differ — it IS the moment of publication, and
  // it is the one value the projection compares against nothing.
  assert.deepEqual(later.attempts, first.attempts);
  assert.deepEqual(
    later.decisions.map((d) => d.seal),
    first.decisions.map((d) => d.seal),
  );
  for (const [index, decision] of later.decisions.entries()) {
    assert.equal(decision.reveal.revealedAt, '2027-01-01T00:00:00.000Z');
    assert.deepEqual(
      { ...decision.reveal, revealedAt: null },
      { ...first.decisions[index]!.reveal, revealedAt: null },
    );
  }
});

test("the run's frozen identity comes from the artifact's stamp, not from this build", async () => {
  const run = await fire();
  const meta = run.records.find((record) => record['recordType'] === 'run_meta');
  assert.ok(meta);

  // An artifact written by a DIFFERENT build: another round, another network,
  // another commit. Republishing it must reproduce what it says, because the
  // stored row it is completing was written from those values — re-deriving
  // them here would contradict that row and drop the whole write.
  const foreign = run.records.map((record) =>
    record === meta
      ? {
          ...record,
          projection: {
            network: 'amoy',
            deploymentRound: 'R6',
            responseSchemaVersion: 7,
            benchmarkCommit: 'c0ffee',
          },
        }
      : record,
  );
  const gate = publishableRun(foreign);
  assert.ok(gate.publishable);
  const plan = projectRun(foreign, gate.header, NO_SOURCE, FIXED_CLOCK);

  const seal = plan.decisions[0]?.seal;
  assert.ok(seal);
  assert.equal(seal.run.network, 'amoy');
  assert.equal(seal.run.deploymentRound, 'R6');
  assert.equal(seal.run.responseSchemaVersion, 7);
  assert.equal(seal.run.benchmarkCommit, 'c0ffee');
});

test('a control seals at the run\'s open, and no later than any model in it', async () => {
  const run = await fire();
  const rewritten = asEnrolled(run.records);
  const plan = planOf(rewritten);
  const runOpenedAt = rewritten.find((r) => r['recordType'] === 'run_meta')?.['createdAt'];
  assert.equal(typeof runOpenedAt, 'string');

  const models = plan.decisions.filter((d) => d.seal.participant.kind === 'model');
  const controls = plan.decisions.filter((d) => d.seal.participant.kind === 'baseline');
  assert.ok(models.length > 0 && controls.length > 0);

  for (const control of controls) assert.equal(control.seal.sealedAt, runOpenedAt);
  for (const model of models) {
    // The accepted attempt's own acceptance instant, carried by the artifact.
    // Not the attempt's settle time, which is stamped on timeouts too.
    const record = rewritten.find(
      (r) => r['recordType'] === 'decision' && r['market'] === model.seal.market,
    );
    assert.ok(record);
    assert.equal(model.seal.sealedAt, record['acceptedAt']);
    assert.ok(
      Date.parse(model.seal.sealedAt) >= Date.parse(String(runOpenedAt)),
      'a model seals at or after the run opened',
    );
  }
});

test('a decision whose accepted attempt has no acceptedAt is skipped, not given a substitute', async () => {
  const run = await fire({ enrolled: true });
  const rewritten = run.records.map((record) =>
    record['recordType'] === 'decision' ? { ...record, acceptedAt: null } : record,
  );
  const plan = planOf(rewritten);

  assert.equal(plan.decisions.filter((d) => d.seal.participant.kind === 'model').length, 0);
  assert.ok(plan.skipped.some((reason) => reason.includes('acceptedAt')));
  // Negative control: the controls in the same run are unaffected, so this is
  // a targeted skip rather than the projector refusing everything.
  assert.equal(plan.decisions.filter((d) => d.seal.participant.kind === 'baseline').length, 8);
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test('every arm and every control the runner can emit is enrolled', () => {
  for (const arm of ARMS) {
    assert.ok(
      projectionParticipant(arm.participantId),
      `arm ${arm.participantId} is not enrolled — it would be silently unpublishable`,
    );
  }

  // Derived by RUNNING the baseline policy rather than by restating a list, so
  // a new control added to the policy fails here instead of vanishing from the
  // projection.
  const build = buildBundle(fullBoardInputs(), TEST_SLATE_DATE, { requireFuture: false });
  const emitted = new Set(runBaselines(build.slateBundle).map((d) => d.participantId));
  assert.ok(emitted.size >= 8);
  for (const participantId of emitted) {
    assert.ok(projectionParticipant(participantId), `control ${participantId} is not enrolled`);
  }
});

test('the registry obeys the rules the projection enforces', () => {
  const labs = new Set<string>();
  for (const [runnerId, entry] of Object.entries(PROJECTION_PARTICIPANTS)) {
    assert.ok(entry.displayName.length > 0, `${runnerId} has no display name`);
    if (entry.kind === 'model') {
      assert.ok(entry.labId !== null, `${runnerId} is a model with no lab`);
      assert.equal(entry.participantId, `lab-${entry.labId}`);
      assert.equal(entry.armId, runnerId, 'a model carries its version-scoped id');
      // One participant per lab. The roster is keyed (cohort, participant), so
      // the day one lab fields two arms in one cohort they would collide —
      // this is the assertion that says so before the data does.
      assert.equal(labs.has(entry.labId), false, `two arms share lab ${entry.labId}`);
      labs.add(entry.labId);
    } else {
      // The projection refuses a non-model carrying a lab: a leaderboard
      // grouped by lab must never bucket a deterministic control under a vendor.
      assert.equal(entry.labId, null, `${runnerId} is not a model but carries a lab`);
      assert.equal(entry.participantId, runnerId, 'a control id is already durable');
      assert.equal(entry.armId, null, 'a control takes its version from the run');
    }
  }
});

test('the run identity the artifact stamps is the frozen literal, spelled out here', async () => {
  // Written as literals rather than compared against the constants the code
  // reads, so an accidental edit to either fails instead of agreeing with
  // itself. `deploymentRound` is part of the key a decision uses to reach its
  // provider call, so an R6 redeploy has to change this deliberately.
  assert.equal(NETWORK, 'polygon');
  assert.equal(DEPLOYMENT_ROUND, 'R5');

  const run = await fire();
  const meta = run.records.find((record) => record['recordType'] === 'run_meta');
  const stamp = meta?.['projection'] as JsonRecord;
  assert.equal(stamp['network'], 'polygon');
  assert.equal(stamp['deploymentRound'], 'R5');
  assert.equal(stamp['responseSchemaVersion'], 2);
  // Advisory: absent on a tree with no git, and null costs only a provenance
  // pointer. What it must never be is resolved at publish time.
  assert.ok(stamp['benchmarkCommit'] === null || typeof stamp['benchmarkCommit'] === 'string');
});

test('display names are literals, not a derivation of the id', () => {
  // Pinned by value. A derivation would be a permanent contradiction the day
  // anyone edited it: the name is compared on every later write for that
  // participant, in every cohort, and a disagreement drops the write entirely.
  assert.deepEqual(
    Object.fromEntries(
      Object.values(PROJECTION_PARTICIPANTS).map((e) => [e.participantId, e.displayName]),
    ),
    {
      'lab-openai': 'OpenAI',
      'lab-anthropic': 'Anthropic',
      'lab-google': 'Google',
      'lab-xai': 'xAI',
      'baseline-favorite-ml': 'Moneyline favorite',
      'baseline-underdog-ml': 'Moneyline underdog',
      'baseline-home-ml': 'Moneyline home',
      'baseline-away-ml': 'Moneyline away',
      'baseline-over-total': 'Total over',
      'baseline-under-total': 'Total under',
      'baseline-favorite-rl': 'Run line favorite',
      'baseline-underdog-rl': 'Run line underdog',
    },
  );
});
