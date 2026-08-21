import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  parseScoredArtifact,
  projectScoredRun,
  publishableScoredRun,
} from './scoredProjection.js';
import type { ScoredHeader } from './scoredProjection.js';
import type { JsonRecord } from './servingProjection.js';
import type { SourceRef } from './servingStore.js';

/**
 * The scored-artifact reader, gate and mapping.
 *
 * Fixture discipline: values are chosen so a wrong implementation produces a
 * DIFFERENT answer, not a plausible one — the away and home close decimals
 * differ, the CLV values differ per pick, and the stratum/refusal flags appear
 * in both polarities. A fixture that is symmetric where the code could swap
 * two things cannot catch the swap.
 */

const SOURCE: SourceRef = { sourcePath: 'run-1-scored.ndjson', sourceSha256: null };

function meta(over: Record<string, unknown> = {}): JsonRecord {
  return {
    recordType: 'scored_run_meta',
    label: 'SMOKE_V0_NOT_A_COHORT',
    runId: 'run-1',
    cohortId: 'smoke-v0-2026-08-19',
    slateDate: '2026-08-19',
    slateSha256: 'ab'.repeat(32),
    sourceMode: 'live',
    scoredAt: '2026-08-20T04:00:00.000Z',
    scoringPolicyVersion: 'scoring-v0.6.0',
    integrityVerified: true,
    picks: 1,
    participantScorecards: 0,
    metric: 'reference-closing CLV',
    ladder: { version: 'TOTALS_V1_PROVISIONAL', parameterVersion: 'retrosheet-2023-25-v1', k: 8.101 },
    ...over,
  };
}

function decision(over: Record<string, unknown> = {}): JsonRecord {
  return {
    recordType: 'scored_decision',
    label: 'SMOKE_V0_NOT_A_COHORT',
    runId: 'run-1',
    scoredAt: '2026-08-20T04:00:00.000Z',
    scoringPolicyVersion: 'scoring-v0.6.0',
    kind: 'model',
    participantId: 'lab-alpha',
    provider: 'alpha',
    gameId: 'game-1',
    market: 'moneyline',
    selection: 'Away Team',
    side: 'away',
    entryDecimal: 2.1,
    devigMethod: 'proportional-v1',
    // Deliberately ASYMMETRIC: 2.05 !== 1.87, so a selected/opposing swap — or
    // an away/home mix-up — changes the projected value rather than passing on
    // a coincidence.
    closing: {
      line: 1.5,
      awayDecimal: 2.05,
      homeDecimal: 1.87,
      awayPNovig: 0.48,
      homePNovig: 0.52,
      confidence: 'fresh',
    },
    scheduleChanged: false,
    inPrimaryStratum: true,
    primaryClvPct: 3.21,
    unscoredReason: null,
    conditionalClvPct: null,
    marginAdjustedClvPct: 1.25,
    lineMovementFavorable: 0.5,
    ...over,
  };
}

function gateOf(records: JsonRecord[]): ReturnType<typeof publishableScoredRun> {
  return publishableScoredRun(records);
}

function reasonOf(records: JsonRecord[]): string {
  const gate = gateOf(records);
  assert.equal(gate.publishable, false, 'expected the gate to refuse');
  return gate.publishable ? '' : gate.reason;
}

function headerOf(records: JsonRecord[]): ScoredHeader {
  const gate = gateOf(records);
  assert.equal(gate.publishable, true, `expected publishable, got: ${gate.publishable ? '' : gate.reason}`);
  if (!gate.publishable) throw new Error('unreachable');
  return gate.header;
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

test('malformed NDJSON refuses with the line number, never skips', () => {
  assert.throws(() => parseScoredArtifact('{"a":1}\nnot json\n'), /scored artifact line 2 is not valid JSON/);
  assert.throws(() => parseScoredArtifact('[1,2]\n'), /scored artifact line 1 is not a JSON object/);
  // Blank lines are the NDJSON convention, not corruption.
  assert.equal(parseScoredArtifact('\n{"a":1}\n\n').length, 1);
});

test('a number that overflows a double refuses the file rather than projecting Infinity', () => {
  // `1e400` is valid JSON and parses to Infinity — the exact shape that once
  // threw out of the run publisher. Here it must die in the schema, typed.
  const records = parseScoredArtifact(
    [JSON.stringify(meta()), JSON.stringify(decision({ primaryClvPct: 1 })).replace('"primaryClvPct":1', '"primaryClvPct":1e400')].join('\n'),
  );
  assert.match(reasonOf([...records]), /primaryClvPct/);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a well-formed scored artifact is publishable and the header carries the meta facts', () => {
  const header = headerOf([meta(), decision()]);
  assert.deepEqual(header, {
    runId: 'run-1',
    cohortId: 'smoke-v0-2026-08-19',
    slateDate: '2026-08-19',
    label: 'SMOKE_V0_NOT_A_COHORT',
    scoringPolicyVersion: 'scoring-v0.6.0',
    scoredAt: '2026-08-20T04:00:00.000Z',
    ladderVersion: 'TOTALS_V1_PROVISIONAL',
    ladderParamVersion: 'retrosheet-2023-25-v1',
  });
});

test('no meta, and TWO IDENTICAL metas, both refuse', () => {
  assert.match(reasonOf([decision()]), /no scored_run_meta/);
  // Identical duplicates on purpose: a checker that indexes records by type
  // before counting keeps the last one and sees nothing wrong — only a count
  // over the RAW list can flag this, so this case is what proves the count
  // rule is load-bearing on its own.
  assert.match(reasonOf([meta(), meta(), decision()]), /two scored_run_meta/);
});

test('a dry-run scoring pass is refused — mock forecasts under real model ids', () => {
  assert.match(reasonOf([meta({ sourceMode: 'dry-run' }), decision()]), /not a live run/);
});

test('a file that does not claim integrityVerified is refused', () => {
  assert.match(reasonOf([meta({ integrityVerified: false }), decision()]), /integrityVerified/);
});

test('a cohort outside the published namespace is refused — same rule as the run path', () => {
  assert.match(reasonOf([meta({ cohortId: 'test-cohort' }), decision()]), /outside the published namespace/);
  // And the namespace the run path publishes under is accepted, both minters.
  headerOf([meta({ cohortId: 'watch-v0-2026-08-19' }), decision()]);
  headerOf([meta({ cohortId: 'smoke-v0-2026-08-19' }), decision()]);
});

test('an unknown record type refuses the whole file', () => {
  assert.match(
    reasonOf([meta(), decision(), { recordType: 'scored_summary_v2', anything: 1 }]),
    /unknown recordType/,
  );
});

function scorecard(over: Record<string, unknown> = {}): JsonRecord {
  return {
    recordType: 'participant_scorecard',
    label: 'SMOKE_V0_NOT_A_COHORT',
    runId: 'run-1',
    scoredAt: '2026-08-20T04:00:00.000Z',
    scoringPolicyVersion: 'scoring-v0.6.0',
    participantId: 'lab-alpha',
    eligibleMarkets: 3,
    ...over,
  };
}

test('a coherent scorecard record is tolerated and never projected', () => {
  const gate = gateOf([meta({ participantScorecards: 1 }), decision(), scorecard()]);
  assert.equal(gate.publishable, true);
  if (gate.publishable) assert.equal(gate.decisions.length, 1);
});

test('a scorecard from another pass refuses the file — it is part of what source_sha256 binds', () => {
  for (const [field, value] of [
    ['runId', 'run-2'],
    ['label', 'SOME_OTHER_LABEL'],
    ['scoringPolicyVersion', 'scoring-v0.5.0'],
    ['scoredAt', '2026-08-21T04:00:00.000Z'],
  ] as const) {
    assert.match(
      reasonOf([meta({ participantScorecards: 1 }), decision(), scorecard({ [field]: value })]),
      new RegExp(`participant_scorecard record 3 disagrees with scored_run_meta on ${field}`),
      field,
    );
  }
  const legacy = scorecard();
  delete (legacy as Record<string, unknown>)['scoredAt'];
  assert.match(reasonOf([meta({ participantScorecards: 1 }), decision(), legacy]), /participant_scorecard record 3 does not match/);
});

test('a refusal reason beside a live CLV value refuses the file — the pair the scorer never emits', () => {
  for (const carrier of [
    { primaryClvPct: 2.4, marginAdjustedClvPct: null },
    { primaryClvPct: null, marginAdjustedClvPct: 1.1 },
  ]) {
    assert.match(
      reasonOf([meta(), decision({ ...carrier, unscoredReason: 'push_capable_line' })]),
      /carries a refusal reason and a CLV value at once/,
      JSON.stringify(carrier),
    );
  }
  // Both legitimate polarities still gate: refused-with-nulls, and value-with-no-reason.
  headerOf([
    meta({ picks: 2 }),
    decision({ primaryClvPct: null, marginAdjustedClvPct: null, unscoredReason: 'close_missing' }),
    decision({ gameId: 'game-2' }),
  ]);
});

test('a decision disagreeing with the meta on any identity field refuses the file', () => {
  for (const [field, value] of [
    ['runId', 'run-2'],
    ['label', 'SOME_OTHER_LABEL'],
    ['scoringPolicyVersion', 'scoring-v0.5.0'],
    ['scoredAt', '2026-08-21T04:00:00.000Z'],
  ] as const) {
    assert.match(
      reasonOf([meta(), decision({ [field]: value })]),
      new RegExp(`disagrees with scored_run_meta on ${field}`),
      field,
    );
  }
});

test('two rows claiming one (participant, game, market) refuse the file as ambiguous', () => {
  // Different values on purpose: whichever row a keep-the-last reader kept
  // would look internally consistent, which is exactly why the file must not
  // be read at all.
  // picks: 2, so the declared-count check agrees and the duplicate KEY is the
  // only thing that can refuse — the wrong-reason trap, avoided on purpose.
  assert.match(
    reasonOf([meta({ picks: 2 }), decision({ primaryClvPct: 1 }), decision({ primaryClvPct: 2 })]),
    /two scored_decision records claim lab-alpha \/ game-1 \/ moneyline/,
  );
  // The same pick identity fields varied one at a time are all distinct picks.
  headerOf([
    meta({ picks: 4 }),
    decision(),
    decision({ participantId: 'lab-beta' }),
    decision({ gameId: 'game-2' }),
    decision({ market: 'total', selection: 'over', side: 'away' }),
  ]);
});

test('an artifact with no scored decisions is refused, not silently published as nothing', () => {
  assert.match(reasonOf([meta({ picks: 0 })]), /no scored decisions/);
});

test('a TRUNCATED artifact is refused — the file is held to its own declared counts', () => {
  // The review reproduction: meta declares two picks, the file carries one.
  // Without the count check this gated publishable, published a partial pass,
  // exited zero, and bound the row to the truncated file's sha forever.
  assert.match(
    reasonOf([meta({ picks: 2 }), decision()]),
    /declares picks = 2 but carries 1 scored_decision/,
  );
  // The mirror: an extra decision the meta never declared. DISTINCT pick keys
  // on purpose — with a duplicate key the uniqueness rule would refuse first
  // and this case would pass for the wrong reason.
  assert.match(
    reasonOf([meta({ picks: 1 }), decision(), decision({ gameId: 'game-2' })]),
    /declares picks = 1 but carries 2 scored_decision/,
  );
  // And the scorecard half: never projected, but part of the file every row's
  // source_sha256 binds — a file missing them is not the canonical record.
  assert.match(
    reasonOf([meta({ participantScorecards: 1 }), decision()]),
    /declares participantScorecards = 1 but carries 0 participant_scorecard/,
  );
  assert.match(
    reasonOf([meta(), decision(), scorecard()]),
    /declares participantScorecards = 0 but carries 1 participant_scorecard/,
  );
});

test('an older scored format is refused with a re-score instruction, not guessed at', () => {
  const legacy = decision();
  delete (legacy as Record<string, unknown>)['inPrimaryStratum'];
  assert.match(reasonOf([meta(), legacy]), /re-score the run with the current scorer/);
});

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

function projected(records: JsonRecord[]): ReturnType<typeof projectScoredRun> {
  const gate = gateOf(records);
  assert.equal(gate.publishable, true, `fixture must gate: ${gate.publishable ? '' : gate.reason}`);
  if (!gate.publishable) throw new Error('unreachable');
  return projectScoredRun(gate.header, gate.decisions, SOURCE);
}

test('a scored pick maps onto the score row, field by field', () => {
  const [row] = projected([meta(), decision()]);
  assert.deepEqual(row, {
    decision: { cohortId: 'smoke-v0-2026-08-19', participantId: 'lab-alpha', gameId: 'game-1', market: 'moneyline' },
    runId: 'run-1',
    label: 'SMOKE_V0_NOT_A_COHORT',
    scoringPolicyVersion: 'scoring-v0.6.0',
    economicClvPct: 3.21,
    marginAdjustedClvPct: 1.25,
    devigMethod: 'proportional-v1',
    ladderVersion: 'TOTALS_V1_PROVISIONAL',
    ladderParamVersion: 'retrosheet-2023-25-v1',
    refused: false,
    refusalReason: null,
    scheduleChanged: false,
    heldOutOfPrimary: false,
    closeDecimalSelected: 2.05,
    closeDecimalOpposing: 1.87,
    closeLine: 1.5,
    lineMovementFavorable: 0.5,
    scoredAt: '2026-08-20T04:00:00.000Z',
    source: SOURCE,
  });
});

test('the close columns follow the SIDE — away selects away, home selects home', () => {
  // The asymmetric fixture is what gives this test teeth: 2.05 !== 1.87.
  const [away, home] = projected([
    meta({ picks: 2 }),
    decision({ side: 'away' }),
    decision({ gameId: 'game-2', side: 'home', selection: 'Home Team' }),
  ]);
  assert.equal(away!.closeDecimalSelected, 2.05);
  assert.equal(away!.closeDecimalOpposing, 1.87);
  assert.equal(home!.closeDecimalSelected, 1.87);
  assert.equal(home!.closeDecimalOpposing, 2.05);
});

test('a pick with no captured close projects null close columns, not zeros', () => {
  const [row] = projected([
    meta(),
    decision({ closing: null, primaryClvPct: null, marginAdjustedClvPct: null, lineMovementFavorable: null, unscoredReason: 'close_missing' }),
  ]);
  assert.equal(row!.closeDecimalSelected, null);
  assert.equal(row!.closeDecimalOpposing, null);
  assert.equal(row!.closeLine, null);
});

test('refusal is the equivalence the schema CHECK states, in both directions', () => {
  const [scored, refused] = projected([
    meta({ picks: 2 }),
    decision(),
    decision({
      gameId: 'game-2',
      primaryClvPct: null,
      marginAdjustedClvPct: null,
      unscoredReason: 'close_stale',
    }),
  ]);
  assert.equal(scored!.refused, false);
  assert.equal(scored!.refusalReason, null);
  assert.equal(refused!.refused, true);
  assert.equal(refused!.refusalReason, 'close_stale');
});

test('heldOutOfPrimary is the negation of the artifact stratum verdict, in both directions', () => {
  const [inStratum, heldOut] = projected([
    meta({ picks: 2 }),
    decision({ inPrimaryStratum: true, scheduleChanged: false }),
    decision({ gameId: 'game-2', inPrimaryStratum: false, scheduleChanged: true }),
  ]);
  assert.equal(inStratum!.heldOutOfPrimary, false);
  assert.equal(inStratum!.scheduleChanged, false);
  assert.equal(heldOut!.heldOutOfPrimary, true);
  assert.equal(heldOut!.scheduleChanged, true);
});

test('an undeterminable schedule verdict crosses as null, never coerced to a boolean', () => {
  const [row] = projected([meta(), decision({ scheduleChanged: null })]);
  assert.equal(row!.scheduleChanged, null);
});

test('a NON-DEFAULT label and runId thread through — the default-valued fixture cannot see a hardcode', () => {
  // Every other fixture in this file carries SMOKE_V0_NOT_A_COHORT and run-1,
  // which is exactly what a build that HARDCODES either value would emit — so
  // those fixtures cannot discriminate it. This one sits where the fixture and
  // the plausible hardcode disagree.
  const [row] = projected([
    meta({ label: 'CANONICAL-2027-W1', runId: 'run-x9' }),
    decision({ label: 'CANONICAL-2027-W1', runId: 'run-x9' }),
  ]);
  assert.equal(row!.label, 'CANONICAL-2027-W1');
  assert.equal(row!.runId, 'run-x9');
});

test('every row rides the run label and runId — the eligibility handle and the run binding', () => {
  const rows = projected([meta({ picks: 2 }), decision(), decision({ gameId: 'game-2' })]);
  for (const row of rows) {
    assert.equal(row.label, 'SMOKE_V0_NOT_A_COHORT');
    assert.equal(row.runId, 'run-1');
    assert.equal(row.ladderVersion, 'TOTALS_V1_PROVISIONAL');
    assert.equal(row.ladderParamVersion, 'retrosheet-2023-25-v1');
    assert.equal(row.source, SOURCE);
  }
});

// ---------------------------------------------------------------------------
// The reader and the real writer cannot drift silently
// ---------------------------------------------------------------------------

test('the schema fields this module consumes exist in the real scorer output shape', () => {
  // The full writer→reader agreement runs in scoring.test.ts, where the run
  // fixture lives, over records the REAL `scoredRecords` emitted. This is the
  // cheap tripwire beside the schema: the fixture above must not drift into a
  // shape the reader itself defines, which would make every case here
  // self-referential. Parsing the fixture through the artifact reader (bytes,
  // not objects) keeps at least the JSON round trip honest.
  const text = [meta(), decision()].map((record) => JSON.stringify(record)).join('\n');
  const gate = publishableScoredRun(parseScoredArtifact(text));
  assert.equal(gate.publishable, true);
});

// A wiring pin, structural on purpose: the two entry points that open the
// serving client for SCORES must ask for the scores capability, and that
// wiring lives in entry-point blocks a unit test cannot execute. The regex
// anchors on the call expression — an option key inside `openBenchmarkServing(`
// braces — which no comment reproduces.
for (const [file, entry] of [
  ['src/projectScoresMain.ts', 'yarn project:scores'],
  ['src/scoreRun.ts', 'yarn score --publish'],
] as const) {
  test(`${entry} opens the serving client at the scores capability`, () => {
    const source = readFileSync(file, 'utf8');
    assert.match(
      source,
      /openBenchmarkServing\(\{[^)]*requiredCapability: SCORES_SERVING_CAPABILITY/,
      `${file} must pass requiredCapability: SCORES_SERVING_CAPABILITY to openBenchmarkServing`,
    );
  });
}
