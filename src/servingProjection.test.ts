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
import { enrolledLabs, entrantKey, PROJECTION_PARTICIPANTS, projectionParticipant } from './servingIdentity.js';
import type { ProjectionParticipant } from './servingIdentity.js';
import type { ParticipantConfiguration } from './participantConfiguration.js';
import { firedRun, fullBoardInputs, TEST_SLATE_DATE, withContradictoryModel } from './servingTestRun.js';
import { projectRun, publishableRun, revealMatchesSeal } from './servingProjection.js';
import type { FiredRun, FireOptions } from './servingTestRun.js';
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

/** One real fired game, written to a temp dir this file cleans up. */
async function fire(options: Omit<FireOptions, 'outDir'> = {}): Promise<FiredRun> {
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
  const plan = planOf((await fire({ enrolled: true })).records);
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
  const records = (await fire({ enrolled: true })).records.map((record) => {
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
  const records = (await fire({ enrolled: true })).records.filter(
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
  const plan = planOf((await fire({ enrolled: true })).records);

  assert.equal(plan.attempts.length, 1);
  const attempt = plan.attempts[0]!;
  assert.equal(attempt.facts.attemptOrdinal, 0);
  assert.equal(attempt.facts.sent, true);
  assert.equal(attempt.facts.outcome, 'valid');
  assert.equal(attempt.facts.httpStatus, 200);
  assert.equal(attempt.facts.reportedModelId, ARMS[0]!.requestedModelId);
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

test('an arm that never sent publishes the denominator row, and claims no response', async () => {
  // The whole reason a failed call gets a row: without it every rate is
  // computed over successes alone. And the row has to be honest about what did
  // not happen — the attempt's settle instant is stamped on timeouts and
  // transport failures too, so publishing it raw would have every failure
  // claiming a response it never received.
  const plan = planOf((await fire({ enrolled: true, behaviour: 'unsent' })).records);

  assert.equal(plan.attempts.length, 1, 'the failed arm must still occupy its opportunity');
  const facts = plan.attempts[0]!.facts;
  assert.equal(facts.sent, false);
  assert.equal(facts.outcome, 'credential_missing');
  assert.equal(facts.requestAt, null);
  assert.equal(facts.responseAt, null);
  assert.equal(facts.httpStatus, null);
  assert.equal(facts.reportedModelId, null);
  // …while the markets it never got to forecast are still its denominator.
  assert.deepEqual([...facts.suppliedMarkets], ['moneyline', 'spread', 'total']);
  // Negative control: no decisions, because nothing came back to seal.
  assert.equal(plan.decisions.filter((d) => d.seal.participant.kind === 'model').length, 0);
});

test('an attempt that was sent and got nothing back claims no receipt', async () => {
  // The discriminating case, and the only one: the runner stamps the attempt's
  // settle instant on a transport failure as well as on a real response, so
  // publishing that field raw would have every timeout and every dropped
  // connection claiming a reply it never received. An arm that never SENT
  // cannot show this — its response fields are already null, so the guard and
  // its absence agree.
  const plan = planOf((await fire({ enrolled: true, behaviour: 'transport-failure' })).records);

  assert.equal(plan.attempts.length, 1);
  const facts = plan.attempts[0]!.facts;
  assert.equal(facts.sent, true, 'the request did go out');
  assert.ok(facts.requestAt !== null);
  assert.notEqual(facts.outcome, 'valid');
  // What the runner recorded, and what the projection publishes, differ here —
  // deliberately.
  const leg = plan.attempts[0]!;
  assert.equal(facts.httpStatus, null, 'nothing came back');
  assert.equal(facts.responseAt, null, 'so there is no receipt to publish');
  assert.ok(facts.latencyMs !== null, 'the attempt still took time, and that is measured');
  void leg;

  // Negative control: the successful run publishes a receipt, so the rule is
  // "withhold when nothing arrived" rather than "never publish".
  const ok = planOf((await fire({ enrolled: true })).records);
  assert.ok(ok.attempts[0]!.facts.responseAt !== null);
});

test('a repaired arm publishes both calls, and the seal cites the one that was accepted', async () => {
  const plan = planOf((await fire({ enrolled: true, behaviour: 'repaired' })).records);

  const ordinals = plan.attempts.map((a) => a.facts.attemptOrdinal).sort();
  assert.deepEqual(ordinals, [0, 1], 'the initial call and its repair are separate rows');

  // Response-level facts are repeated on the repair row by design, so either
  // row alone describes the opportunity — and pinning a denominator to ordinal
  // 0 stays correct for an arm that was repaired to valid.
  const initial = plan.attempts.find((a) => a.facts.attemptOrdinal === 0);
  const repair = plan.attempts.find((a) => a.facts.attemptOrdinal === 1);
  assert.ok(initial && repair);
  assert.equal(initial.facts.outcome, repair.facts.outcome);
  assert.deepEqual([...initial.facts.suppliedMarkets], [...repair.facts.suppliedMarkets]);

  const models = plan.decisions.filter((d) => d.seal.participant.kind === 'model');
  assert.ok(models.length > 0, 'the repair must have produced forecasts');
  for (const { seal } of models) assert.equal(seal.attemptOrdinal, 1, 'the seal cites the repair');
});

test('the participant is the ARM, with the lab and the model in their own fields', async () => {
  const run = await fire({ enrolled: true });
  const enrolled = ARMS[0]!;
  const plan = planOf(run.records);
  const attempt = plan.attempts[0]!;

  assert.equal(attempt.participant.participantId, enrolled.participantId);
  assert.equal(attempt.participant.kind, 'model');
  assert.equal(attempt.participant.labId, 'openai');
  assert.equal(attempt.participant.displayName, 'GPT-5.6 Sol');
  // The exact model string requested, and the setting it competes at, are the
  // PARTICIPANT's — two thirds of the entrant key `(lab_id, model_id,
  // configuration)` the database indexes uniquely. Not the participant id,
  // which is an arbitrary durable key, and no longer the roster either: the
  // roster used to copy the model string per cohort, and a second copy of an
  // identity is a thing that can disagree with the first.
  assert.equal(attempt.participant.modelId, enrolled.requestedModelId);
  assert.deepEqual(attempt.participant.configuration, enrolled.configuration);
  // The roster is now the wallet binding and nothing else.
  assert.deepEqual(attempt.roster, { walletAddress: null });
});

// ---------------------------------------------------------------------------
// The commitment
// ---------------------------------------------------------------------------

test("a model's published digest is exactly forecastDigest() of the forecast it came from", async () => {
  const run = await fire({ enrolled: true });
  // Over-scale on purpose. The response schema bounds these fields by range and
  // never by precision — a model that computes one chance in three returns
  // sixteen decimals — while the reveal columns hold four, six and eight. A
  // fixture already within scale cannot tell a build that quantises before
  // hashing from one that does not, and the difference is a commitment no
  // reader can ever check.
  const rewritten = run.records.map((record) =>
    record['recordType'] === 'decision'
      ? {
          ...record,
          observedDecimal: 2.0537145,
          confidence: 0.613712355,
          probabilities: { win: 0.523123465, push: 0, loss: 0.476876535 },
        }
      : record,
  );
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
  const run = await fire({ enrolled: true });
  const rewritten = run.records;
  const plan = planOf(rewritten);

  const kinds = new Set(plan.decisions.map((d) => d.seal.participant.kind));
  assert.deepEqual([...kinds].sort(), ['baseline', 'model'], 'both kinds must be exercised');
  for (const decision of plan.decisions) assert.equal(revealMatchesSeal(decision), true);
});

test('the reveal check catches a transposition the database would accept', async () => {
  const run = await fire({ enrolled: true });
  const rewritten = run.records;
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
  const run = await fire({ enrolled: true });
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
  const run = await fire({ enrolled: true });
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
  const run = await fire({ enrolled: true });
  const rewritten = run.records;
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

test('a participant is one ARM, so a lab may field several', () => {
  // The property that makes multiple models per lab possible, asserted directly
  // rather than left to follow from the current roster happening to have one
  // arm each. Every key in the projection is scoped by participant — the
  // roster, the provider call, the decision — so a participant that named the
  // LAB would make two of its models collide on all three.
  for (const [runnerId, entry] of Object.entries(PROJECTION_PARTICIPANTS)) {
    assert.equal(entry.participantId, runnerId, `${runnerId} is not its own participant`);
    assert.ok(entry.displayName.length > 0, `${runnerId} has no display name`);
    if (entry.kind === 'model') {
      // The vendor lives in its own column, which is what a lab-level view
      // groups on. Discarding it at write time would be unrecoverable; a
      // GROUP BY never is.
      assert.ok(entry.labId !== null, `${runnerId} is a model with no lab`);
      assert.ok(runnerId.startsWith(`${entry.labId}-`), `${runnerId} does not name its lab`);
      // Both halves, because the pair is what the entrant key is made of. A
      // model declaring one and not the other satisfies "it has a model" and is
      // a permanently dimensionless entrant — the row is insert-once.
      assert.ok(entry.modelId !== null, `${runnerId} is a model with no model id`);
      assert.ok(entry.configuration !== null, `${runnerId} is a model with no configuration`);
    } else {
      // The projection refuses a non-model carrying a lab: a leaderboard
      // grouped by lab must never bucket a deterministic control under a vendor.
      assert.equal(entry.labId, null, `${runnerId} is not a model but carries a lab`);
      // A control used to declare an `armId` that FELL BACK to the baseline
      // policy version. That behaviour is retired rather than renamed: the
      // database refuses a non-model that declares a model or a configuration
      // at all, so there is nothing for a fallback to fill in — and the policy
      // version a control ran under is a property of the RUN, recorded once as
      // `benchmark_runs.baseline_policy_version` rather than copied per cohort.
      assert.equal(entry.modelId, null, `${runnerId} is not a model but declares one`);
      assert.equal(entry.configuration, null, `${runnerId} is not a model but sets knobs`);
    }
  }

  // And the concrete consequence, on a roster that does not yet exercise it:
  // two arms sharing a lab are two participants, with two roster rows, two
  // provider calls and two sets of picks. Nothing in the registry or the
  // schema treats the shared lab as a collision — the conformance suite proves
  // the database agrees.
  // Three arms of one lab: two different models, and two VARIANTS of one of
  // them. The variants are the hard case — same lab, same model, differing only
  // in a setting — and they are exactly as distinct as anything else, because
  // the entrant key is `(lab_id, model_id, configuration)` and the setting is
  // part of it.
  const arm = (
    participantId: string,
    displayName: string,
    modelId: string,
    configuration: ParticipantConfiguration,
  ): ProjectionParticipant => ({
    participantId, kind: 'model', labId: 'openai', displayName, modelId, configuration,
    provider: 'openai', approvedReportedModelIds: [modelId],
  });
  const oneLab: ProjectionParticipant[] = [
    arm('openai-gpt-5.6-sol-low', 'GPT-5.6 Sol (low)', 'gpt-5.6-sol', { reasoning_effort: 'low' }),
    arm('openai-gpt-5.6-sol-high', 'GPT-5.6 Sol (high)', 'gpt-5.6-sol', { reasoning_effort: 'high' }),
    arm('openai-gpt-5.7-x', 'GPT-5.7 X', 'gpt-5.7-x', {}),
  ];
  assert.equal(new Set(oneLab.map((p) => p.labId)).size, 1, 'all three share a lab');
  assert.equal(new Set(oneLab.map((p) => p.modelId)).size, 2, 'two of them share a model line');
  // Distinct as the DATABASE counts them, through the same composition its
  // unique index uses, rather than by inspecting the ids. Give the two variants
  // one configuration and this drops to 2 — three participant ids the database
  // would only ever hold one pair of, which is the case worth pinning.
  assert.equal(new Set(oneLab.map(entrantKey)).size, 3, 'and all three are distinct entrants');
  assert.equal(new Set(oneLab.map((p) => p.participantId)).size, 3, 'and all three are distinct participants');

  assert.deepEqual(enrolledLabs(), ['anthropic', 'google', 'openai', 'xai']);
});

test('every arm the runner can dispatch is enrolled, by construction', () => {
  // Derived from the frozen roster rather than restated, so a fifth arm — a
  // second model from a lab already present, say — fails here instead of
  // silently never reaching the projection.
  for (const arm of ARMS) {
    assert.ok(projectionParticipant(arm.participantId), `arm ${arm.participantId} is not enrolled`);
  }
  assert.equal(ARMS.length, 4);
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
      'openai-gpt-5.6-sol': 'GPT-5.6 Sol',
      'anthropic-claude-fable-5': 'Claude Fable 5',
      'google-gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
      'xai-grok-4.5': 'Grok 4.5',
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
