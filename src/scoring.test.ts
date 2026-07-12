import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASELINE_POLICY_VERSION, runBaselines } from './baselines.js';
import { canonicalize, sha256Hex } from './canonical.js';
import {
  aggregateByParticipant,
  parseRunRecords,
  scoredRecords,
  scoreRun,
  sideForSelection,
  verifyRunIntegrity,
} from './scoring.js';
import { makeRequest } from './testFactories.js';
import type { GameRequest } from './bundle.js';
import type { ClosingLineRow, SlateBundle } from './types.js';

const GAME_A = '00000000-0000-4000-8000-0000000000a1';
const GAME_B = '00000000-0000-4000-8000-0000000000b2';
const LABEL = 'SMOKE_V0_NOT_A_COHORT';
const BUNDLE_TS = '2026-07-12T14:05:00+00:00';

const FIXTURE_ARMS = [
  { participantId: 'model-arm', provider: 'openai', requestedModelId: 'stub-model-1' },
];
const FIXTURE_ARMS_WITH_TIMEOUT = [
  ...FIXTURE_ARMS,
  { participantId: 'timeout-arm', provider: 'xai', requestedModelId: 'stub-model-2' },
];

/**
 * Build a fully consistent run file (real hashes, correct echoes, arm
 * responses backing every model decision) for the given games. The default
 * game bundle prices are: ML away 1.74627 / home 2.17; run line +1.5 away
 * 2.3 / home 1.66667; total 8.5 over 1.90909 / under 1.90909.
 */
function fixtureRun(options?: { extraArm?: { participantId: string; outcome: string } }): {
  lines: string[];
  requests: GameRequest[];
  slateSha256: string;
} {
  const requests = [
    makeRequest('2026-07-12T16:15:00+00:00', { gameId: GAME_A }),
    makeRequest('2026-07-12T20:10:00+00:00', { gameId: GAME_B }),
  ];

  const slateBundle = {
    schemaVersion: 1,
    label: LABEL,
    league: 'mlb',
    slateDate: '2026-07-12',
    bundleTimestamp: BUNDLE_TS,
    cutoffAt: '2026-07-12T16:15:00+00:00',
    games: requests.map((r) => r.game).sort((a, b) => (a.gameId < b.gameId ? -1 : 1)),
  };
  const slateSha256 = sha256Hex(canonicalize(slateBundle));

  const records: Array<Record<string, unknown>> = [];
  const identity = { label: LABEL, runId: 'test-run' };
  const shaByGame = new Map<string, { gameSha256: string; requestSha256: string }>();
  let armResponseCount = 0;
  let baselineCount = 0;

  for (const request of requests) {
    const game = request.game;
    const gameSha256 = sha256Hex(canonicalize(game));
    shaByGame.set(game.gameId, { gameSha256, requestSha256: request.requestSha256 });
    records.push({
      recordType: 'bundle_game',
      ...identity,
      gameId: game.gameId,
      slug: request.slug,
      cutoffAt: request.requestBundle.cutoffAt,
      gameSha256,
      requestSha256: request.requestSha256,
      bundle: game,
    });

    // The forecasts drive BOTH the archived raw response and the decision
    // records, so they correspond exactly (as the harness guarantees).
    const forecasts = [
      { market: 'moneyline', selection: game.homeTeam, line: null, observedDecimal: game.markets.moneyline.homeDecimal, probabilities: { win: 0.55, push: 0, loss: 0.45 }, confidence: 0.6, wouldAbstain: false, selectedForExecution: true, rationale: 'reference-price read', evidenceRefs: [game.markets.moneyline.evidenceRef] },
      { market: 'spread', selection: game.awayTeam, line: game.markets.runLine.line, observedDecimal: game.markets.runLine.awayDecimal, probabilities: { win: 0.55, push: 0, loss: 0.45 }, confidence: 0.6, wouldAbstain: false, selectedForExecution: false, rationale: 'reference-price read', evidenceRefs: [game.markets.runLine.evidenceRef] },
      { market: 'total', selection: 'over', line: game.markets.total.line, observedDecimal: game.markets.total.overDecimal, probabilities: { win: 0.55, push: 0, loss: 0.45 }, confidence: 0.6, wouldAbstain: false, selectedForExecution: true, rationale: 'reference-price read', evidenceRefs: [game.markets.total.evidenceRef] },
    ];
    const rawResponse = JSON.stringify({
      schemaVersion: 1,
      cohortId: 'test-cohort',
      participantId: 'model-arm',
      requestedModelId: 'stub-model-1',
      bundleSha256: request.requestSha256,
      executionPolicy: 'fixed-moneyline-total',
      games: [{ gameId: game.gameId, forecasts }],
    });

    records.push({
      recordType: 'arm_game_response',
      ...identity,
      cohortId: 'test-cohort',
      participantId: 'model-arm',
      provider: 'openai',
      requestedModelId: 'stub-model-1',
      reportedModelId: 'stub-model-1',
      gameId: game.gameId,
      requestSha256: request.requestSha256,
      outcome: 'valid',
      repairUsed: false,
      attempt: { reportedModelId: 'stub-model-1', providerResponseId: 'resp-1', rawResponse },
      repair: null,
    });
    armResponseCount += 1;
    if (options?.extraArm) {
      records.push({
        recordType: 'arm_game_response',
        ...identity,
        cohortId: 'test-cohort',
        participantId: options.extraArm.participantId,
        provider: 'xai',
        requestedModelId: 'stub-model-2',
        reportedModelId: null,
        gameId: game.gameId,
        requestSha256: request.requestSha256,
        outcome: options.extraArm.outcome,
        repairUsed: false,
        attempt: { reportedModelId: null, providerResponseId: null, rawResponse: null },
        repair: null,
      });
      armResponseCount += 1;
    }

    for (const forecast of forecasts) {
      records.push({
        recordType: 'decision',
        ...identity,
        cohortId: 'test-cohort',
        participantId: 'model-arm',
        gameId: game.gameId,
        market: forecast.market,
        selection: forecast.selection,
        line: forecast.line,
        observedDecimal: forecast.observedDecimal,
        probabilities: forecast.probabilities,
        confidence: forecast.confidence,
        selectedForExecution: forecast.selectedForExecution,
        wouldAbstain: forecast.wouldAbstain,
        provider: 'openai',
        requestedModelId: 'stub-model-1',
        reportedModelId: 'stub-model-1',
        providerResponseId: 'resp-1',
        attemptUsed: 'initial',
        bundleSha256: request.requestSha256,
        gameSha256,
        slateSha256,
      });
    }
  }

  // The six deterministic baselines, re-derivable from the bundles.
  const slateForBaselines: SlateBundle = {
    schemaVersion: 1,
    label: 'SMOKE_V0_NOT_A_COHORT',
    league: 'mlb',
    slateDate: '2026-07-12',
    bundleTimestamp: BUNDLE_TS,
    cutoffAt: '2026-07-12T16:15:00+00:00',
    games: requests.map((r) => r.game),
  };
  for (const decision of runBaselines(slateForBaselines)) {
    const shas = shaByGame.get(decision.gameId);
    records.push({
      recordType: 'baseline_decision',
      ...identity,
      cohortId: 'test-cohort',
      participantId: decision.participantId,
      policyVersion: BASELINE_POLICY_VERSION,
      gameId: decision.gameId,
      market: decision.market,
      selection: decision.selection,
      line: decision.line,
      observedDecimal: decision.observedDecimal,
      slateSha256,
      gameSha256: shas?.gameSha256 ?? null,
      requestSha256: shas?.requestSha256 ?? null,
    });
    baselineCount += 1;
  }

  records.unshift({
    recordType: 'run_meta',
    runId: 'test-run',
    cohortId: 'test-cohort',
    label: LABEL,
    mode: 'live',
    slateDate: '2026-07-12',
    slateSha256,
    bundleTimestamp: BUNDLE_TS,
    slateCutoffAt: '2026-07-12T16:15:00+00:00',
    eligibleGames: requests.length,
    armGameResults: armResponseCount,
    baselineDecisionCount: baselineCount,
  });

  return { lines: records.map((l) => JSON.stringify(l)), requests, slateSha256 };
}

function closeRow(
  gameId: string,
  market: 'moneyline' | 'spread' | 'total',
  overrides: Partial<ClosingLineRow> = {},
): ClosingLineRow {
  return {
    network: 'polygon',
    jsonodds_id: gameId,
    market,
    line: market === 'moneyline' ? null : market === 'spread' ? 1.5 : 8.5,
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

test('a consistent run file passes integrity verification', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  assert.deepEqual(verifyRunIntegrity(run, { expectedArms: FIXTURE_ARMS }), []);
});

test('a run with a recorded run_failure is refused', () => {
  const { lines } = fixtureRun();
  lines.push(
    JSON.stringify({
      recordType: 'run_failure',
      label: LABEL,
      runId: 'test-run',
      code: 'PROVIDER_COLLISION',
      failures: ['x'],
    }),
  );
  const violations = verifyRunIntegrity(parseRunRecords(lines), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('not scoreable')));
});

test('the review mutation — a changed entry price with unchanged hashes — is caught', () => {
  const { lines } = fixtureRun();
  const mutated = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record['recordType'] === 'decision' && record['market'] === 'moneyline' && record['gameId'] === GAME_A) {
      record['observedDecimal'] = 99;
    }
    return JSON.stringify(record);
  });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('does not match the frozen bundle price')));
});

test('a tampered bundle is caught by hash recomputation', () => {
  const { lines } = fixtureRun();
  const mutated = lines.map((line) => {
    const record = JSON.parse(line) as {
      recordType?: string;
      gameId?: string;
      bundle?: { markets: { moneyline: { awayDecimal: number } } };
    };
    if (record.recordType === 'bundle_game' && record.gameId === GAME_A && record.bundle) {
      record.bundle.markets.moneyline.awayDecimal = 9.99;
    }
    return JSON.stringify(record);
  });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('gameSha256')));
});

test('a fabricated decision with no backing arm response is caught', () => {
  const { lines } = fixtureRun();
  const anyDecision = lines.find(
    (line) => (JSON.parse(line) as Record<string, unknown>)['recordType'] === 'decision',
  );
  assert.ok(anyDecision);
  const decision = JSON.parse(anyDecision) as Record<string, unknown>;
  decision['participantId'] = 'ghost-arm';
  lines.push(JSON.stringify(decision));
  const violations = verifyRunIntegrity(parseRunRecords(lines), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('no arm_game_response')));
});

test('a valid arm response with missing decisions is caught, as is a wrong per-market count', () => {
  const { lines } = fixtureRun();
  const withoutOneDecision = lines.filter((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    return !(
      record['recordType'] === 'decision' &&
      record['gameId'] === GAME_B &&
      record['market'] === 'total'
    );
  });
  const violations = verifyRunIntegrity(parseRunRecords(withoutOneDecision), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('expected exactly one decision per market')));
});

test('the round-2 probe: a decision swapped to the other bundle-valid side is caught against the accepted response', () => {
  const { lines } = fixtureRun();
  const mutated = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record['recordType'] === 'decision' && record['market'] === 'moneyline' && record['gameId'] === GAME_A) {
      // Milwaukee at its VALID frozen-bundle price — bundle checks alone
      // cannot catch this; only correspondence with the archived response can.
      record['selection'] = 'Milwaukee Brewers';
      record['observedDecimal'] = 1.74627;
    }
    return JSON.stringify(record);
  });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('does not match the accepted provider response')));
});

test('forged decision provenance metadata is caught against the accepted attempt', () => {
  const { lines } = fixtureRun();
  const mutated = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record['recordType'] === 'decision' && record['market'] === 'total' && record['gameId'] === GAME_A) {
      record['reportedModelId'] = 'some-other-model';
      record['providerResponseId'] = 'forged-response-id';
    }
    return JSON.stringify(record);
  });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('provenance does not match the accepted attempt')));
});

test('an arm response whose request hash does not match the game is caught', () => {
  const { lines } = fixtureRun();
  const mutated = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record['recordType'] === 'arm_game_response' && record['gameId'] === GAME_B) {
      record['requestSha256'] = '0'.repeat(64);
    }
    return JSON.stringify(record);
  });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes("does not match the game's request hash")));
});

test('deleting an arm entirely is caught by the manifest count and cross-product', () => {
  const { lines } = fixtureRun({ extraArm: { participantId: 'timeout-arm', outcome: 'timeout' } });
  const withoutTimeoutArm = lines.filter((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    return !(
      record['recordType'] === 'arm_game_response' && record['participantId'] === 'timeout-arm'
    );
  });
  const violations = verifyRunIntegrity(parseRunRecords(withoutTimeoutArm), { expectedArms: FIXTURE_ARMS_WITH_TIMEOUT });
  assert.ok(violations.some((v) => v.includes('arm-game responses but')));
});

test('deleting baseline decisions is caught by the manifest count', () => {
  const { lines } = fixtureRun();
  const withoutBaselines = lines.filter((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    return record['recordType'] !== 'baseline_decision';
  });
  const violations = verifyRunIntegrity(parseRunRecords(withoutBaselines), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('baseline decisions but')));
});

test('a partially deleted baseline breaks the baseline×game cross-product', () => {
  const { lines } = fixtureRun();
  let removed = false;
  const partial = lines.filter((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (!removed && record['recordType'] === 'baseline_decision' && record['gameId'] === GAME_B) {
      removed = true;
      return false;
    }
    return true;
  });
  const violations = verifyRunIntegrity(parseRunRecords(partial), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('is missing')));
});

test('the round-3 probe: a tampered baseline at a bundle-valid price fails re-derivation', () => {
  const { lines } = fixtureRun();
  const mutated = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (
      record['recordType'] === 'baseline_decision' &&
      record['participantId'] === 'baseline-away-ml' &&
      record['gameId'] === GAME_A
    ) {
      // The HOME team at its valid frozen price — bundle-valid, policy-false.
      record['selection'] = 'Pittsburgh Pirates';
      record['observedDecimal'] = 2.17;
    }
    return JSON.stringify(record);
  });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('does not match its deterministic re-derivation')));
});

test('duplicate run_meta and duplicate bundle_game records are structural errors', () => {
  const { lines } = fixtureRun();
  const meta = lines.find(
    (line) => (JSON.parse(line) as Record<string, unknown>)['recordType'] === 'run_meta',
  );
  assert.ok(meta);
  assert.throws(() => parseRunRecords([...lines, meta]), /more than one run_meta/);
  const bundleGame = lines.find(
    (line) => (JSON.parse(line) as Record<string, unknown>)['recordType'] === 'bundle_game',
  );
  assert.ok(bundleGame);
  assert.throws(() => parseRunRecords([...lines, bundleGame]), /more than one bundle_game/);
});

test('a forged accepted-response top-level identity is caught', () => {
  const { lines } = fixtureRun();
  const mutated = lines.map((line) => {
    const record = JSON.parse(line) as {
      recordType?: string;
      gameId?: string;
      attempt?: { rawResponse?: string };
    };
    if (record.recordType === 'arm_game_response' && record.gameId === GAME_A && record.attempt?.rawResponse) {
      const raw = JSON.parse(record.attempt.rawResponse) as Record<string, unknown>;
      raw['cohortId'] = 'forged-cohort';
      record.attempt.rawResponse = JSON.stringify(raw);
    }
    return JSON.stringify(record);
  });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('raw response identity does not match')));
});

test('a relabeled arm is caught by the frozen arm manifest', () => {
  const { lines } = fixtureRun({ extraArm: { participantId: 'timeout-arm', outcome: 'timeout' } });
  const mutated = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record['recordType'] === 'arm_game_response' && record['participantId'] === 'timeout-arm') {
      record['participantId'] = 'fake-arm';
    }
    return JSON.stringify(record);
  });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), {
    expectedArms: FIXTURE_ARMS_WITH_TIMEOUT,
  });
  assert.ok(violations.some((v) => v.includes('expected arm timeout-arm has no responses')));
  assert.ok(violations.some((v) => v.includes('unexpected arm fake-arm')));
});

test('a record stamped with another run/cohort identity is caught', () => {
  const { lines } = fixtureRun();
  const mutated = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record['recordType'] === 'decision' && record['market'] === 'spread' && record['gameId'] === GAME_B) {
      record['cohortId'] = 'someone-elses-cohort';
    }
    return JSON.stringify(record);
  });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('cohortId does not match run_meta')));
});

test('parseRunRecords fails loudly without run_meta', () => {
  const { lines } = fixtureRun();
  assert.throws(() => parseRunRecords(lines.slice(1)), /no run_meta/);
});

test('sideForSelection maps team names and over/under; rejects unknown labels', () => {
  const game = { awayTeam: 'Milwaukee Brewers', homeTeam: 'Pittsburgh Pirates' };
  assert.equal(sideForSelection('moneyline', 'Milwaukee Brewers', game), 'away');
  assert.equal(sideForSelection('spread', 'Pittsburgh Pirates', game), 'home');
  assert.equal(sideForSelection('total', 'over', game), 'away');
  assert.equal(sideForSelection('total', 'under', game), 'home');
  assert.throws(() => sideForSelection('moneyline', 'Chicago Cubs', game), /matches neither/);
});

test('missing close rows are unscored close_missing (pre-lock behavior)', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, []);
  assert.ok(scored.every((p) => p.result.unscoredReason === 'close_missing'));
  assert.ok(scored.every((p) => p.result.primaryClvPct === null));
});

test('equal-weight game-level primary differs from per-pick pooling and is the primary summary', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  // Game A: all three markets close fresh at even no-vig.
  //   home ML 2.17 @ 0.5  -> +8.5
  //   away RL 2.3  @ 0.45 -> +3.5
  //   over  8.5 1.90909 @ 0.5 -> -4.5455
  //   game A mean = 2.4848
  // Game B: only the moneyline closes (home 2.17 @ 0.6 -> +30.2).
  const closes: ClosingLineRow[] = [
    closeRow(GAME_A, 'moneyline'),
    closeRow(GAME_A, 'spread', { away_p_novig: 0.45, home_p_novig: 0.55 }),
    closeRow(GAME_A, 'total'),
    closeRow(GAME_B, 'moneyline', { away_p_novig: 0.4, home_p_novig: 0.6 }),
  ];
  const scored = scoreRun(run, closes);
  const stats = aggregateByParticipant(scored, run);
  const model = stats.find((s) => s.participantId === 'model-arm');
  assert.ok(model);
  assert.equal(model.primaryScoreable, 4);
  assert.equal(model.gamesScoreable, 2);
  // Primary: (2.4848 + 30.2) / 2 — each game weighs equally.
  assert.equal(model.gameLevel.meanClvPct, 16.3424);
  // Secondary per-pick pooling weighs game A 3x: (8.5+3.5-4.5455+30.2)/4.
  assert.equal(model.perPick.meanClvPct, 9.4136);
  assert.equal(model.gameLevel.beatClosePct, 100);
});

test('arms with zero valid decisions stay in the denominators (no survivor bias)', () => {
  const { lines } = fixtureRun({ extraArm: { participantId: 'timeout-arm', outcome: 'timeout' } });
  const run = parseRunRecords(lines);
  assert.deepEqual(verifyRunIntegrity(run, { expectedArms: FIXTURE_ARMS_WITH_TIMEOUT }), []);
  const stats = aggregateByParticipant(scoreRun(run, []), run);
  const timeoutArm = stats.find((s) => s.participantId === 'timeout-arm');
  assert.ok(timeoutArm);
  assert.equal(timeoutArm.kind, 'model');
  assert.equal(timeoutArm.games, 2);
  assert.equal(timeoutArm.eligibleMarkets, 6);
  assert.equal(timeoutArm.validDecisions, 0);
  assert.equal(timeoutArm.primaryScoreable, 0);
  assert.deepEqual(timeoutArm.armOutcomes, { timeout: 2 });
});

test('scoredRecords carry provenance (reported model, response id, hashes) and the label', () => {
  const { lines, slateSha256 } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, [closeRow(GAME_A, 'moneyline')]);
  const stats = aggregateByParticipant(scored, run);
  const records = scoredRecords(run, scored, stats, '2026-07-12T21:00:00.000Z');
  const decisions = records.filter((r) => r['recordType'] === 'scored_decision');
  // 6 model decisions + 12 deterministic baseline decisions (6 × 2 games).
  assert.equal(decisions.length, 18);
  const modelDecision = decisions.find((r) => r['kind'] === 'model');
  assert.ok(modelDecision);
  assert.equal(modelDecision['reportedModelId'], 'stub-model-1');
  assert.equal(modelDecision['providerResponseId'], 'resp-1');
  assert.equal(modelDecision['slateSha256'], slateSha256);
  assert.ok(typeof modelDecision['gameSha256'] === 'string');
  assert.ok(typeof modelDecision['requestSha256'] === 'string');
  assert.ok(records.every((r) => r['label'] === 'SMOKE_V0_NOT_A_COHORT'));
  const meta = records.find((r) => r['recordType'] === 'scored_run_meta');
  assert.ok(meta);
  assert.equal(meta['integrityVerified'], true);
});
