import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregateByParticipant,
  parseRunRecords,
  scoredRecords,
  scoreRun,
  sideForSelection,
} from './scoring.js';
import type { ClosingLineRow } from './types.js';

const GAME_ID = '00000000-0000-4000-8000-0000000000s1';

function runLines(): string[] {
  const meta = {
    recordType: 'run_meta',
    runId: 'test-run',
    cohortId: 'test-cohort',
    label: 'SMOKE_V0_NOT_A_COHORT',
    mode: 'live',
    slateDate: '2026-07-12',
    slateSha256: 'f'.repeat(64),
  };
  const bundleGame = {
    recordType: 'bundle_game',
    gameId: GAME_ID,
    slug: 'mil-pit-2026-07-12',
    bundle: {
      gameId: GAME_ID,
      awayTeam: 'Milwaukee Brewers',
      homeTeam: 'Pittsburgh Pirates',
      scheduledStartUtc: '2026-07-12T16:15:00+00:00',
    },
  };
  const decisionBase = {
    recordType: 'decision',
    participantId: 'model-arm',
    gameId: GAME_ID,
    probabilities: { win: 0.55, push: 0, loss: 0.45 },
    confidence: 0.6,
    selectedForExecution: true,
    wouldAbstain: false,
  };
  const decisions = [
    { ...decisionBase, market: 'moneyline', selection: 'Pittsburgh Pirates', line: null, observedDecimal: 1.8 },
    { ...decisionBase, market: 'spread', selection: 'Milwaukee Brewers', line: -1.5, observedDecimal: 2.0, selectedForExecution: false },
    { ...decisionBase, market: 'total', selection: 'over', line: 8, observedDecimal: 1.9 },
  ];
  const baseline = {
    recordType: 'baseline_decision',
    participantId: 'baseline-away-ml',
    policyVersion: 'baselines-v0.1.0',
    gameId: GAME_ID,
    market: 'moneyline',
    selection: 'Milwaukee Brewers',
    line: null,
    observedDecimal: 2.1,
  };
  return [meta, bundleGame, ...decisions, baseline].map((r) => JSON.stringify(r));
}

function closeRow(overrides: Partial<ClosingLineRow>): ClosingLineRow {
  return {
    network: 'polygon',
    jsonodds_id: GAME_ID,
    market: 'moneyline',
    line: null,
    away_odds_decimal: 2.0,
    home_odds_decimal: 2.0,
    away_p_novig: 0.5,
    home_p_novig: 0.5,
    value_captured_at: '2026-07-12T16:14:40+00:00',
    last_polled_at: '2026-07-12T16:15:05+00:00',
    lock_time: '2026-07-12T16:15:00+00:00',
    poll_gap_seconds: -5,
    confidence: 'fresh',
    source: 'reference',
    ...overrides,
  };
}

const CLOSES: ClosingLineRow[] = [
  closeRow({}),
  // spread closed at a DIFFERENT line: primary unavailable, movement reported
  closeRow({ market: 'spread', line: -2.5, away_p_novig: 0.45, home_p_novig: 0.55 }),
  // integer total at the same line: push-capable
  closeRow({ market: 'total', line: 8 }),
];

test('parseRunRecords extracts meta, games, model decisions, and baselines', () => {
  const run = parseRunRecords(runLines());
  assert.equal(run.runId, 'test-run');
  assert.equal(run.games.size, 1);
  assert.equal(run.picks.length, 4);
  assert.equal(run.picks.filter((p) => p.kind === 'model').length, 3);
  assert.equal(run.picks.filter((p) => p.kind === 'baseline').length, 1);
});

test('parseRunRecords fails loudly without run_meta', () => {
  assert.throws(() => parseRunRecords(runLines().slice(1)), /no run_meta/);
});

test('sideForSelection maps team names and over/under; rejects unknown labels', () => {
  const game = { awayTeam: 'Milwaukee Brewers', homeTeam: 'Pittsburgh Pirates' };
  assert.equal(sideForSelection('moneyline', 'Milwaukee Brewers', game), 'away');
  assert.equal(sideForSelection('spread', 'Pittsburgh Pirates', game), 'home');
  assert.equal(sideForSelection('total', 'over', game), 'away');
  assert.equal(sideForSelection('total', 'under', game), 'home');
  assert.throws(() => sideForSelection('moneyline', 'Chicago Cubs', game), /matches neither/);
});

test('scoreRun end to end: moneyline scores, moved spread reports movement, integer total is conditional', () => {
  const run = parseRunRecords(runLines());
  const scored = scoreRun(run, CLOSES);

  const ml = scored.find((p) => p.kind === 'model' && p.market === 'moneyline');
  assert.ok(ml);
  // Home at 1.8 against a 0.5 no-vig close: 100 * (1.8*0.5 - 1) = -10.
  assert.equal(ml.result.primaryClvPct, -10.0);

  const baseline = scored.find((p) => p.kind === 'baseline');
  assert.ok(baseline);
  // Away at 2.1 against 0.5: +5 — baselines score through the same path.
  assert.equal(baseline.result.primaryClvPct, 5.0);

  const spread = scored.find((p) => p.market === 'spread');
  assert.ok(spread);
  assert.equal(spread.result.unscoredReason, 'line_moved');
  // Selected away (Milwaukee) at +1.5; closed +2.5: unfavorable -1.0.
  assert.equal(spread.result.lineMovementFavorable, -1.0);

  const total = scored.find((p) => p.market === 'total');
  assert.ok(total);
  assert.equal(total.result.unscoredReason, 'push_capable_line');
  assert.equal(total.result.conditionalClvPct, -5.0);
});

test('missing close rows are unscored close_missing (pre-lock behavior)', () => {
  const run = parseRunRecords(runLines());
  const scored = scoreRun(run, []);
  assert.ok(scored.every((p) => p.result.unscoredReason === 'close_missing'));
  assert.ok(scored.every((p) => p.result.primaryClvPct === null));
});

test('aggregateByParticipant: counts, reasons, and models-before-baselines ordering', () => {
  const run = parseRunRecords(runLines());
  const stats = aggregateByParticipant(scoreRun(run, CLOSES));
  assert.equal(stats.length, 2);
  const model = stats.find((s) => s.participantId === 'model-arm');
  assert.ok(model);
  assert.equal(model.kind, 'model');
  assert.equal(model.picks, 3);
  assert.equal(model.primaryScoreable, 1);
  assert.equal(model.meanClvPct, -10.0);
  assert.equal(model.beatClosePct, 0);
  assert.equal(model.conditionalOnly, 1);
  assert.deepEqual(model.unscoredByReason, { line_moved: 1, push_capable_line: 1 });
  assert.equal(stats[0]?.kind, 'model');
  assert.equal(stats[1]?.kind, 'baseline');
});

test('scoredRecords carry the label, the policy, and one record per pick plus scorecards', () => {
  const run = parseRunRecords(runLines());
  const scored = scoreRun(run, CLOSES);
  const stats = aggregateByParticipant(scored);
  const records = scoredRecords(run, scored, stats, '2026-07-12T21:00:00.000Z');
  assert.equal(records.filter((r) => r['recordType'] === 'scored_run_meta').length, 1);
  assert.equal(records.filter((r) => r['recordType'] === 'scored_decision').length, 4);
  assert.equal(records.filter((r) => r['recordType'] === 'participant_scorecard').length, 2);
  assert.ok(records.every((r) => r['label'] === 'SMOKE_V0_NOT_A_COHORT'));
});
