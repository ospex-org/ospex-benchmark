import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASELINE_POLICY_VERSION, runBaselines } from './baselines.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { buildScorecardMarkdown } from './scorecard.js';
import type { BaselinePolicyVersion } from './baselines.js';
import {
  aggregateByParticipant,
  parseRunRecords,
  SCORING_POLICY_VERSION,
  scoredRecords,
  scoreRun,
  sideForSelection,
  verifyRunIntegrity,
} from './scoring.js';
import { makeRequest } from './testFactories.js';
import type { GameRequest } from './bundle.js';
import type { MarketStats, ScoredPick } from './scoring.js';
import type { ClosingLineRow, SlateBundle } from './types.js';

const GAME_A = '00000000-0000-4000-8000-0000000000a1';
const GAME_B = '00000000-0000-4000-8000-0000000000b2';
const LABEL = 'SMOKE_V0_NOT_A_COHORT';
const BUNDLE_TS = '2026-07-12T14:05:00+00:00';

const FIXTURE_ARMS = [
  {
    participantId: 'model-arm',
    provider: 'openai',
    requestedModelId: 'stub-model-1',
    approvedReportedModelIds: ['stub-model-1'],
  },
];
const TIMEOUT_ARM = {
  participantId: 'timeout-arm',
  provider: 'xai',
  requestedModelId: 'stub-model-2',
  approvedReportedModelIds: ['stub-model-2'],
};
const FIXTURE_ARMS_WITH_TIMEOUT = [...FIXTURE_ARMS, TIMEOUT_ARM];
const SECOND_MODEL_ARM = {
  participantId: 'model-arm-2',
  provider: 'anthropic',
  requestedModelId: 'stub-model-3',
  approvedReportedModelIds: ['stub-model-3'],
};

/**
 * Build a fully consistent run file (real hashes, correct echoes, arm
 * responses backing every model decision) for the given games. The default
 * game bundle prices are: ML away 1.74627 / home 2.17; run line +1.5 away
 * 2.3 / home 1.66667; total 8.5 over 1.90909 / under 1.90909.
 */
function fixtureRun(options?: {
  extraArm?: { participantId: string; outcome: string };
  /** Adds a second VALID model arm that takes the OPPOSITE side of every market. */
  secondModelArm?: boolean;
  /** Baseline policy version to derive and stamp (default: current). */
  baselinePolicyVersion?: BaselinePolicyVersion;
}): {
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

  const modelArms = [
    {
      participantId: 'model-arm',
      provider: 'openai',
      requestedModelId: 'stub-model-1',
      providerResponseId: 'resp-1',
      flipped: false,
    },
    ...(options?.secondModelArm
      ? [
          {
            participantId: SECOND_MODEL_ARM.participantId,
            provider: SECOND_MODEL_ARM.provider,
            requestedModelId: SECOND_MODEL_ARM.requestedModelId,
            providerResponseId: 'resp-2',
            flipped: true,
          },
        ]
      : []),
  ];

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

    for (const arm of modelArms) {
      // The forecasts drive BOTH the archived raw response and the decision
      // records, so they correspond exactly (as the harness guarantees). The
      // flipped arm takes the opposite side of every market at its own
      // bundle-valid price.
      const common = { probabilities: { win: 0.55, push: 0, loss: 0.45 }, confidence: 0.6, wouldAbstain: false, rationale: 'reference-price read' };
      const forecasts = arm.flipped
        ? [
            { market: 'moneyline', selection: game.awayTeam, line: null, observedDecimal: game.markets.moneyline.awayDecimal, selectedForExecution: true, evidenceRefs: [game.markets.moneyline.evidenceRef], ...common },
            { market: 'spread', selection: game.homeTeam, line: game.markets.runLine.line, observedDecimal: game.markets.runLine.homeDecimal, selectedForExecution: false, evidenceRefs: [game.markets.runLine.evidenceRef], ...common },
            { market: 'total', selection: 'under', line: game.markets.total.line, observedDecimal: game.markets.total.underDecimal, selectedForExecution: true, evidenceRefs: [game.markets.total.evidenceRef], ...common },
          ]
        : [
            { market: 'moneyline', selection: game.homeTeam, line: null, observedDecimal: game.markets.moneyline.homeDecimal, selectedForExecution: true, evidenceRefs: [game.markets.moneyline.evidenceRef], ...common },
            { market: 'spread', selection: game.awayTeam, line: game.markets.runLine.line, observedDecimal: game.markets.runLine.awayDecimal, selectedForExecution: false, evidenceRefs: [game.markets.runLine.evidenceRef], ...common },
            { market: 'total', selection: 'over', line: game.markets.total.line, observedDecimal: game.markets.total.overDecimal, selectedForExecution: true, evidenceRefs: [game.markets.total.evidenceRef], ...common },
          ];
      const rawResponse = JSON.stringify({
        schemaVersion: 1,
        cohortId: 'test-cohort',
        participantId: arm.participantId,
        requestedModelId: arm.requestedModelId,
        bundleSha256: request.requestSha256,
        executionPolicy: 'fixed-moneyline-total',
        games: [{ gameId: game.gameId, forecasts }],
      });

      records.push({
        recordType: 'arm_game_response',
        ...identity,
        cohortId: 'test-cohort',
        participantId: arm.participantId,
        provider: arm.provider,
        requestedModelId: arm.requestedModelId,
        reportedModelId: arm.requestedModelId,
        gameId: game.gameId,
        requestSha256: request.requestSha256,
        outcome: 'valid',
        cutoffAt: request.requestBundle.cutoffAt,
        repairUsed: false,
        attempt: {
          reportedModelId: arm.requestedModelId,
          providerResponseId: arm.providerResponseId,
          rawResponse,
          requestAt: '2026-07-12T14:07:00.001Z',
          responseAt: '2026-07-12T14:07:00.055Z',
          latencyMs: 54,
        },
        repair: null,
      });
      armResponseCount += 1;

      for (const forecast of forecasts) {
        records.push({
          recordType: 'decision',
          ...identity,
          cohortId: 'test-cohort',
          participantId: arm.participantId,
          gameId: game.gameId,
          market: forecast.market,
          selection: forecast.selection,
          line: forecast.line,
          observedDecimal: forecast.observedDecimal,
          probabilities: forecast.probabilities,
          confidence: forecast.confidence,
          selectedForExecution: forecast.selectedForExecution,
          wouldAbstain: forecast.wouldAbstain,
          provider: arm.provider,
          requestedModelId: arm.requestedModelId,
          reportedModelId: arm.requestedModelId,
          providerResponseId: arm.providerResponseId,
          attemptUsed: 'initial',
          bundleSha256: request.requestSha256,
          gameSha256,
          slateSha256,
        });
      }
    }
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
        cutoffAt: request.requestBundle.cutoffAt,
        repairUsed: false,
        attempt: {
          reportedModelId: null,
          providerResponseId: null,
          rawResponse: null,
          requestAt: '2026-07-12T14:07:00.001Z',
          responseAt: '2026-07-12T14:07:02.001Z',
          latencyMs: 2000,
        },
        repair: null,
      });
      armResponseCount += 1;
    }
  }

  // The deterministic baselines, re-derivable from the bundles (current
  // policy version unless a test pins an earlier one).
  const slateForBaselines: SlateBundle = {
    schemaVersion: 1,
    label: 'SMOKE_V0_NOT_A_COHORT',
    league: 'mlb',
    slateDate: '2026-07-12',
    bundleTimestamp: BUNDLE_TS,
    cutoffAt: '2026-07-12T16:15:00+00:00',
    games: requests.map((r) => r.game),
  };
  const baselineVersion = options?.baselinePolicyVersion ?? BASELINE_POLICY_VERSION;
  for (const decision of runBaselines(slateForBaselines, baselineVersion)) {
    const shas = shaByGame.get(decision.gameId);
    records.push({
      recordType: 'baseline_decision',
      ...identity,
      cohortId: 'test-cohort',
      participantId: decision.participantId,
      policyVersion: decision.policyVersion,
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
    // Real v0.1.0 archives predate the run_meta version stamp — emulate that
    // so the compat test exercises the legacy absent-stamp path.
    ...(baselineVersion !== 'baselines-v0.1.0' ? { baselinePolicyVersion: baselineVersion } : {}),
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

test('an archived baselines-v0.1.0 run still verifies clean under the current scorer', () => {
  // The compat contract: re-derivation runs under the RECORDED policy
  // version, so a pre-run-line archive (six baselines per game, no
  // run-line pair expected) verifies with zero violations. Forcing the
  // current version's expectations onto this run would fail it with
  // missing baseline-favorite-rl / baseline-underdog-rl decisions.
  const { lines } = fixtureRun({ baselinePolicyVersion: 'baselines-v0.1.0' });
  const run = parseRunRecords(lines);
  const baselinePicks = run.picks.filter((p) => p.kind === 'baseline');
  assert.equal(baselinePicks.length, 12);
  assert.ok(baselinePicks.every((p) => p.policyVersion === 'baselines-v0.1.0'));
  assert.ok(!baselinePicks.some((p) => p.participantId.endsWith('-rl')));
  assert.deepEqual(verifyRunIntegrity(run, { expectedArms: FIXTURE_ARMS }), []);
});

test('a current-version run carries the mirrored run-line pair and verifies clean', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const rlPicks = run.picks.filter(
    (p) => p.kind === 'baseline' && p.participantId.endsWith('-rl'),
  );
  // Fixture run line is the HOME handicap +1.5, so AWAY lays the runs:
  // favorite-rl = away team at the away price, underdog-rl = home team.
  assert.equal(rlPicks.length, 4);
  assert.ok(rlPicks.every((p) => p.market === 'spread' && p.line === 1.5));
  const favorite = rlPicks.find(
    (p) => p.participantId === 'baseline-favorite-rl' && p.gameId === GAME_A,
  );
  assert.ok(favorite);
  assert.equal(favorite.selection, 'Milwaukee Brewers');
  assert.equal(favorite.entryDecimal, 2.3);
  assert.deepEqual(verifyRunIntegrity(run, { expectedArms: FIXTURE_ARMS }), []);
});

test('mixed and unknown baseline policy versions are violations', () => {
  const { lines } = fixtureRun();
  const mixed = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (
      record['recordType'] === 'baseline_decision' &&
      record['participantId'] === 'baseline-home-ml' &&
      record['gameId'] === GAME_A
    ) {
      record['policyVersion'] = 'baselines-v0.1.0';
    }
    return JSON.stringify(record);
  });
  const mixedViolations = verifyRunIntegrity(parseRunRecords(mixed), { expectedArms: FIXTURE_ARMS });
  assert.ok(mixedViolations.some((v) => v.includes('mixed policy versions')));

  const unknown = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record['recordType'] === 'baseline_decision') {
      record['policyVersion'] = 'baselines-v9.9.9';
    }
    return JSON.stringify(record);
  });
  const unknownViolations = verifyRunIntegrity(parseRunRecords(unknown), { expectedArms: FIXTURE_ARMS });
  assert.ok(unknownViolations.some((v) => v.includes('unknown policy version baselines-v9.9.9')));
});

test('deleting the run-line pair from a current-version run is caught', () => {
  const { lines } = fixtureRun();
  const withoutRl = lines.filter((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    return !(
      record['recordType'] === 'baseline_decision' &&
      typeof record['participantId'] === 'string' &&
      record['participantId'].endsWith('-rl')
    );
  });
  const violations = verifyRunIntegrity(parseRunRecords(withoutRl), { expectedArms: FIXTURE_ARMS });
  assert.ok(
    violations.some((v) => v.includes('baseline-favorite-rl') && v.includes('is missing')),
    'deleting the run-line pair must surface as missing deterministic baselines',
  );
});

test('a coherent version-downgrade edit is caught by the run_meta policy-version stamp', () => {
  // The review probe: restamp every baseline row to v0.1.0, delete the
  // run-line pair, and fix run_meta.baselineDecisionCount — three coherent
  // edits that would otherwise present as a legitimate v0.1.0 archive. The
  // run_meta baselinePolicyVersion stamp forces a fourth edit; a forger who
  // rewrites that too is outside the documented trust boundary (run files
  // are unsigned; the root of trust is the archived/published artifact).
  const { lines } = fixtureRun();
  const downgraded = lines
    .filter((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      return !(
        record['recordType'] === 'baseline_decision' &&
        typeof record['participantId'] === 'string' &&
        record['participantId'].endsWith('-rl')
      );
    })
    .map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record['recordType'] === 'baseline_decision') {
        record['policyVersion'] = 'baselines-v0.1.0';
      }
      if (record['recordType'] === 'run_meta') {
        record['baselineDecisionCount'] = 12;
      }
      return JSON.stringify(record);
    });
  const violations = verifyRunIntegrity(parseRunRecords(downgraded), { expectedArms: FIXTURE_ARMS });
  assert.ok(
    violations.some((v) => v.includes('run_meta baselinePolicyVersion')),
    'the run_meta stamp must contradict the downgraded per-decision stamps',
  );
});

test('a tampered run-line baseline at a bundle-valid price fails re-derivation', () => {
  const { lines } = fixtureRun();
  const mutated = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (
      record['recordType'] === 'baseline_decision' &&
      record['participantId'] === 'baseline-favorite-rl' &&
      record['gameId'] === GAME_A
    ) {
      // The OTHER side at its valid frozen price — bundle-valid, policy-false
      // (the away side lays on a +1.5 home handicap, not the home side).
      record['selection'] = 'Pittsburgh Pirates';
      record['observedDecimal'] = 1.66667;
    }
    return JSON.stringify(record);
  });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('does not match its deterministic re-derivation')));
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
  assert.ok(violations.some((v) => v.includes('fails the harness validator')));
});

test('the round-4 probe: stripped run_failure records cannot hide a recomputed identity failure', () => {
  const { lines } = fixtureRun();
  // Forge an unapproved reported model ID everywhere it is archived — the
  // identity gate is recomputed from the archives, so no run_failure record
  // is needed to catch it.
  const mutated = lines.map((line) => {
    const record = JSON.parse(line) as {
      recordType?: string;
      reportedModelId?: string | null;
      attempt?: { reportedModelId?: string | null };
    };
    if (record.recordType === 'arm_game_response') {
      record.reportedModelId = 'unapproved-model-x';
      if (record.attempt) record.attempt.reportedModelId = 'unapproved-model-x';
    }
    if (record.recordType === 'decision') {
      (record as Record<string, unknown>)['reportedModelId'] = 'unapproved-model-x';
    }
    return JSON.stringify(record);
  });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
  assert.ok(
    violations.some((v) => v.startsWith('recomputed identity gate:') && v.includes('unapproved-model-x')),
  );
});

test('the round-4 probe: a semantically invalid accepted response is caught by the full harness validator', () => {
  const { lines } = fixtureRun();
  const mutated = lines.map((line) => {
    const record = JSON.parse(line) as {
      recordType?: string;
      gameId?: string;
      attempt?: { rawResponse?: string };
    };
    if (record.recordType === 'arm_game_response' && record.gameId === GAME_A && record.attempt?.rawResponse) {
      const raw = JSON.parse(record.attempt.rawResponse) as {
        executionPolicy: string;
        games: Array<{ forecasts: Array<{ probabilities: { win: number; push: number; loss: number } }> }>;
      };
      raw.executionPolicy = 'model-choice-side-total';
      const forecast = raw.games[0]?.forecasts[0];
      if (forecast) forecast.probabilities = { win: 0.8, push: 0, loss: 0.8 };
      record.attempt.rawResponse = JSON.stringify(raw);
    }
    // Mirror the broken probabilities in the decision record so the old
    // correspondence check alone would not catch it.
    if (record.recordType === 'decision' && record.gameId === GAME_A) {
      const decision = record as Record<string, unknown>;
      if (decision['market'] === 'moneyline') {
        decision['probabilities'] = { win: 0.8, push: 0, loss: 0.8 };
      }
    }
    return JSON.stringify(record);
  });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('fails the harness validator')));
});

test('the round-4 symmetric probe: a valid response demoted to invalid_schema is caught', () => {
  const { lines } = fixtureRun();
  const mutated = lines
    .filter((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      // Delete the demoted response's decisions, as a forger would.
      return !(record['recordType'] === 'decision' && record['gameId'] === GAME_B);
    })
    .map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record['recordType'] === 'arm_game_response' && record['gameId'] === GAME_B) {
        record['outcome'] = 'invalid_schema';
      }
      return JSON.stringify(record);
    });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
  assert.ok(
    violations.some((v) => v.includes('a valid response cannot be demoted')),
  );
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

test('the round-5 probe: a valid response demoted to cutoff_missed is caught by archived timing', () => {
  const { lines } = fixtureRun();
  const mutated = lines
    .filter((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      return !(record['recordType'] === 'decision' && record['gameId'] === GAME_A);
    })
    .map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record['recordType'] === 'arm_game_response' && record['gameId'] === GAME_A) {
        record['outcome'] = 'cutoff_missed';
      }
      return JSON.stringify(record);
    });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('cannot be demoted to a timing failure')));
});

test('the round-6 probe: blanked timing on a body-bearing cutoff_missed response is caught', () => {
  const { lines } = fixtureRun();
  const mutated = lines
    .filter((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      return !(record['recordType'] === 'decision' && record['gameId'] === GAME_A);
    })
    .map((line) => {
      const record = JSON.parse(line) as {
        recordType?: string;
        gameId?: string;
        outcome?: string;
        attempt?: { responseAt?: string | null; latencyMs?: number | null };
      };
      if (record.recordType === 'arm_game_response' && record.gameId === GAME_A && record.attempt) {
        record.outcome = 'cutoff_missed';
        record.attempt.responseAt = null;
        record.attempt.latencyMs = null;
      }
      return JSON.stringify(record);
    });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('archived timing fields are missing')));
});

test('the round-5 probe: a valid response whose responseAt is after the cutoff is caught', () => {
  const { lines } = fixtureRun();
  const mutated = lines.map((line) => {
    const record = JSON.parse(line) as {
      recordType?: string;
      gameId?: string;
      attempt?: { requestAt?: string; responseAt?: string; latencyMs?: number };
    };
    if (record.recordType === 'arm_game_response' && record.gameId === GAME_A && record.attempt) {
      // One second past this game's 16:15:00Z cutoff, latency kept consistent.
      record.attempt.requestAt = '2026-07-12T16:14:59.000Z';
      record.attempt.responseAt = '2026-07-12T16:15:01.000Z';
      record.attempt.latencyMs = 2000;
    }
    return JSON.stringify(record);
  });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
  assert.ok(violations.some((v) => v.includes('at or after the decision cutoff')));
});

test('the round-5 probe: inconsistent latency or a foreign cutoff on a response is caught', () => {
  const { lines } = fixtureRun();
  const badLatency = lines.map((line) => {
    const record = JSON.parse(line) as {
      recordType?: string;
      gameId?: string;
      attempt?: { latencyMs?: number };
    };
    if (record.recordType === 'arm_game_response' && record.gameId === GAME_A && record.attempt) {
      record.attempt.latencyMs = 9999;
    }
    return JSON.stringify(record);
  });
  const latencyViolations = verifyRunIntegrity(parseRunRecords(badLatency), {
    expectedArms: FIXTURE_ARMS,
  });
  assert.ok(latencyViolations.some((v) => v.includes('latencyMs does not equal')));

  const badCutoff = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record['recordType'] === 'arm_game_response' && record['gameId'] === GAME_A) {
      record['cutoffAt'] = '2026-07-12T23:59:00+00:00';
    }
    return JSON.stringify(record);
  });
  const cutoffViolations = verifyRunIntegrity(parseRunRecords(badCutoff), {
    expectedArms: FIXTURE_ARMS,
  });
  assert.ok(cutoffViolations.some((v) => v.includes('does not match the hash-verified game cutoff')));
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
  // The failed arm stays on the per-market comparison surface too: a 0/N
  // entry in every market it was dispatched on, never a vanished row.
  for (const market of ['moneyline', 'spread', 'total']) {
    const entry: MarketStats | undefined = timeoutArm.byMarket[market];
    assert.ok(entry, `${market} entry missing for the failed arm`);
    assert.equal(entry.eligible, 2);
    assert.equal(entry.picks, 0);
    assert.equal(entry.gameLevel.meanClvPct, null);
  }
});

test('scoredRecords carry provenance (reported model, response id, hashes) and the label', () => {
  const { lines, slateSha256 } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, [closeRow(GAME_A, 'moneyline')]);
  const stats = aggregateByParticipant(scored, run);
  const records = scoredRecords(run, scored, stats, '2026-07-12T21:00:00.000Z');
  const decisions = records.filter((r) => r['recordType'] === 'scored_decision');
  // 6 model decisions + 16 deterministic baseline decisions (8 × 2 games).
  assert.equal(decisions.length, 22);
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

test('the scoring policy version is pinned to its literal value', () => {
  // A bump must be a conscious edit HERE too. 'scoring-v0.1.0' is reserved
  // for pre-stamp output by definition and must never be emitted.
  assert.equal(SCORING_POLICY_VERSION, 'scoring-v0.3.0');
});

test('every scored record type is stamped with the scoring policy version', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, [closeRow(GAME_A, 'moneyline')]);
  const stats = aggregateByParticipant(scored, run);
  const records = scoredRecords(run, scored, stats, '2026-07-12T21:00:00.000Z');
  assert.ok(records.length > 0);
  assert.ok(records.every((r) => r['scoringPolicyVersion'] === SCORING_POLICY_VERSION));
  const byType = new Set(records.map((r) => r['recordType']));
  assert.deepEqual(
    [...byType].sort(),
    ['participant_scorecard', 'scored_decision', 'scored_run_meta'],
  );
});

test('margin-adjusted CLV rides every scored surface: rows, aggregates, run meta', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const closes: ClosingLineRow[] = [
    closeRow(GAME_A, 'moneyline'),
    closeRow(GAME_B, 'moneyline', { away_p_novig: 0.4, home_p_novig: 0.6 }),
  ];
  const scored = scoreRun(run, closes);
  const stats = aggregateByParticipant(scored, run);

  // The wiring: the opposite side comes from the same bundle, so the model's
  // home-ML margin-adjusted CLV must equal 100*(q_close/q_entry - 1) with
  // q_entry from the bundle's two-sided quote (2.17 home / 1.74627 away).
  // The de-vig math itself is golden-pinned in clv.test.ts.
  const entryPHome = (1 / 2.17) / (1 / 2.17 + 1 / 1.74627);
  const expectGameA = Math.round(100 * (0.5 / entryPHome - 1) * 1e4) / 1e4;
  const modelMlPick = scored.find(
    (p) => p.participantId === 'model-arm' && p.market === 'moneyline' && p.gameId === GAME_A,
  );
  assert.ok(modelMlPick);
  assert.equal(modelMlPick.entryOppositeDecimal, 1.74627);
  assert.equal(modelMlPick.result.marginAdjustedClvPct, expectGameA);

  // Availability parity: the two metrics share every gate.
  for (const stat of stats) {
    assert.equal(stat.marginAdjustedScoreable, stat.primaryScoreable, stat.participantId);
  }
  const model = stats.find((s) => s.participantId === 'model-arm');
  assert.ok(model);
  assert.ok(model.gameLevelMarginAdjusted.meanClvPct !== null);
  assert.ok(model.byMarket['moneyline']?.gameLevelMarginAdjusted.meanClvPct !== null);
  assert.ok(model.gameLevelShin.economic.meanClvPct !== null);

  // Scored records are self-contained: both entry sides, both metrics, the
  // named de-vig method, and the shin sensitivity block on scored rows.
  const records = scoredRecords(run, scored, stats, '2026-07-12T21:00:00.000Z');
  const meta = records.find((r) => r['recordType'] === 'scored_run_meta');
  assert.ok(meta);
  assert.ok(meta['metrics']);
  assert.deepEqual(meta['devigMethods'], { primary: 'proportional-v1', sensitivity: ['shin-v1'] });
  const decisions = records.filter((r) => r['recordType'] === 'scored_decision');
  assert.ok(decisions.every((r) => r['devigMethod'] === 'proportional-v1'));
  assert.ok(decisions.every((r) => typeof r['entryOppositeDecimal'] === 'number'));
  const scoredRows = decisions.filter((r) => r['primaryClvPct'] !== null);
  assert.ok(scoredRows.length > 0);
  assert.ok(scoredRows.every((r) => r['marginAdjustedClvPct'] !== null));
  assert.ok(
    scoredRows.every(
      (r) => (r['sensitivity'] as { devigMethod?: string } | null)?.devigMethod === 'shin-v1',
    ),
  );
});

test('byMarket reports game-clustered stats and per-market unscored reasons, never pooled across markets', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  // Game A: ML scored (+8.5 for home 2.17 @ 0.5), spread line MOVED (1.5 →
  // 2.5), total scored at the unchanged half line (1.90909 @ 0.5 → −4.5455).
  // Game B: only ML scored (2.17 @ 0.6 → +30.2); spread/total close_missing.
  const closes: ClosingLineRow[] = [
    closeRow(GAME_A, 'moneyline'),
    closeRow(GAME_A, 'spread', { line: 2.5 }),
    closeRow(GAME_A, 'total'),
    closeRow(GAME_B, 'moneyline', { away_p_novig: 0.4, home_p_novig: 0.6 }),
  ];
  const scored = scoreRun(run, closes);
  const stats = aggregateByParticipant(scored, run);

  const model = stats.find((s) => s.participantId === 'model-arm');
  assert.ok(model);
  const ml = model.byMarket['moneyline'];
  assert.ok(ml);
  assert.deepEqual(
    { eligible: ml.eligible, picks: ml.picks, scoreable: ml.scoreable, gamesScoreable: ml.gamesScoreable },
    { eligible: 2, picks: 2, scoreable: 2, gamesScoreable: 2 },
  );
  assert.equal(ml.gameLevel.meanClvPct, 19.35);
  assert.equal(ml.gameLevel.beatClosePct, 100);
  assert.deepEqual(ml.unscoredByReason, {});

  const spread = model.byMarket['spread'];
  assert.ok(spread);
  assert.equal(spread.picks, 2);
  assert.equal(spread.scoreable, 0);
  assert.equal(spread.gamesScoreable, 0);
  assert.equal(spread.gameLevel.meanClvPct, null);
  assert.deepEqual(spread.unscoredByReason, { line_moved: 1, close_missing: 1 });

  const total = model.byMarket['total'];
  assert.ok(total);
  assert.equal(total.scoreable, 1);
  assert.equal(total.gameLevel.meanClvPct, -4.5455);
  assert.deepEqual(total.unscoredByReason, { close_missing: 1 });

  // Baselines carry the same per-market shape — they are the per-market
  // comparison partners, not a models-only extra.
  const homeMl = stats.find((s) => s.participantId === 'baseline-home-ml');
  assert.ok(homeMl);
  assert.equal(homeMl.byMarket['moneyline']?.gameLevel.meanClvPct, 19.35);

  // The per-market mean is NOT the pooled mean: pooling would mix the
  // moneyline's +19.35 with the total's −4.5455.
  assert.notEqual(model.gameLevel.meanClvPct, ml.gameLevel.meanClvPct);
});

function syntheticScored(gameId: string, primaryClvPct: number | null): ScoredPick {
  return {
    kind: 'baseline',
    participantId: 'synthetic-policy',
    gameId,
    market: 'total',
    selection: 'over',
    line: 8.5,
    entryDecimal: 2,
    probabilities: null,
    confidenceValue: null,
    policyVersion: 'synthetic-v0',
    modelWinProbability: null,
    wouldAbstain: null,
    selectedForExecution: null,
    provider: null,
    requestedModelId: null,
    reportedModelId: null,
    providerResponseId: null,
    attemptUsed: null,
    echoedRequestSha256: null,
    echoedGameSha256: null,
    echoedSlateSha256: null,
    side: 'away',
    entryOppositeDecimal: 2,
    result: {
      primaryClvPct,
      unscoredReason: primaryClvPct === null ? 'close_missing' : null,
      conditionalClvPct: null,
      marginAdjustedClvPct: primaryClvPct,
      marginAdjustedConditionalClvPct: null,
      lineMovementFavorable: null,
      closingPNovigSelected: null,
      entryPNovigSelected: null,
      sensitivity: null,
      aux: null,
    },
    close: null,
  };
}

test('per-market aggregation clusters within a game first (future multi-pick runs)', () => {
  // One pick per game/market is the shape today; the clustering must hold if
  // a run ever carries several picks in the same game and market.
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored: ScoredPick[] = [
    syntheticScored(GAME_A, 2),
    syntheticScored(GAME_A, 0),
    syntheticScored(GAME_B, 3),
  ];
  const stats = aggregateByParticipant(scored, run);
  const policy = stats.find((s) => s.participantId === 'synthetic-policy');
  assert.ok(policy);
  const total = policy.byMarket['total'];
  assert.ok(total);
  assert.equal(total.picks, 3);
  assert.equal(total.gamesScoreable, 2);
  // Game level: mean(mean(2, 0), 3) = mean(1, 3) = 2 — not the per-pick 5/3.
  assert.equal(total.gameLevel.meanClvPct, 2);
  assert.equal(total.perPick.meanClvPct, 1.6667);
  assert.equal(total.gameLevel.beatClosePct, 100);
  assert.equal(total.perPick.beatClosePct, 66.6667);
});

test('the scorecard renders per-market game-level tables for every participant and states the never-pool rule', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const closes: ClosingLineRow[] = [
    closeRow(GAME_A, 'moneyline'),
    closeRow(GAME_A, 'spread', { line: 2.5 }),
    closeRow(GAME_A, 'total'),
    closeRow(GAME_B, 'moneyline', { away_p_novig: 0.4, home_p_novig: 0.6 }),
  ];
  const scored = scoreRun(run, closes);
  const stats = aggregateByParticipant(scored, run);
  const markdown = buildScorecardMarkdown(run, scored, stats, '2026-07-12T21:00:00.000Z');

  assert.ok(markdown.includes(`- Scoring policy: \`${SCORING_POLICY_VERSION}\``));
  assert.ok(markdown.includes('never pool CLV across markets'));
  // Both metrics side by side, the named de-vig methods, and the shin
  // sensitivity section.
  assert.ok(markdown.includes('**margin-adjusted**'));
  assert.ok(markdown.includes('Margin-adj game-mean'));
  assert.ok(markdown.includes('Margin-adj mean'));
  assert.ok(markdown.includes('proportional-v1'));
  assert.ok(markdown.includes('## De-vig sensitivity'));
  assert.ok(markdown.indexOf('| model-arm |', markdown.indexOf('## De-vig sensitivity')) > 0);
  assert.ok(markdown.includes('pooled across each participant’s markets — context only'));
  const byMarketAt = markdown.indexOf('## By market');
  assert.ok(byMarketAt > 0);
  for (const heading of ['### Moneyline', '### Spread (run line)', '### Total']) {
    assert.ok(markdown.indexOf(heading) > byMarketAt, `${heading} missing from the by-market section`);
  }
  // Baselines appear in the per-market tables (moneyline shown with the
  // same game-level numbers as the models' moneyline picks).
  assert.ok(markdown.indexOf('| baseline-home-ml | 2 | 2/2 | 2 | 19.35 |') > byMarketAt);
  // Per-market unscored reasons are visible where the quarantine happens.
  assert.ok(markdown.includes('line_moved 1, close_missing 1'));
  // The run-line baseline pair renders in the spread table alongside models.
  const spreadHeadingAt = markdown.indexOf('### Spread (run line)');
  assert.ok(markdown.indexOf('| baseline-favorite-rl |', spreadHeadingAt) > spreadHeadingAt);
  assert.ok(markdown.indexOf('| baseline-underdog-rl |', spreadHeadingAt) > spreadHeadingAt);
  // The ordering CONTRACT (market's own mean, never the pooled aggregate) is
  // pinned by the dedicated opposing-order test below — single-market
  // baselines cannot distinguish the two comparators.
});

test('per-market tables rank by the market’s own mean even when the pooled order is OPPOSITE', () => {
  // Review-round probe: an ordering test only has teeth when the correct
  // comparator (byMarket gameLevel mean) and the prohibited one (pooled
  // gameLevel mean) disagree on the fixture. Two multi-market arms take
  // opposite sides of every market; game A closes are chosen so model-arm
  // wins the MONEYLINE while model-arm-2 wins the POOLED aggregate:
  //   ML:     model-arm home 2.17@0.6 → +30.2 ; model-arm-2 away 1.74627@0.4 → −30.15
  //   spread: model-arm away 2.3@0.1  → −77   ; model-arm-2 home 1.66667@0.9 → +50
  //   total:  model-arm over @0.1     → −80.9 ; model-arm-2 under @0.9      → +71.8
  //   pooled: model-arm −42.57 < model-arm-2 +30.56 — the REVERSE of the ML order.
  const { lines } = fixtureRun({
    secondModelArm: true,
    extraArm: { participantId: 'timeout-arm', outcome: 'timeout' },
  });
  const run = parseRunRecords(lines);
  const expectedArms = [...FIXTURE_ARMS, SECOND_MODEL_ARM, TIMEOUT_ARM];
  assert.deepEqual(verifyRunIntegrity(run, { expectedArms }), []);
  const closes: ClosingLineRow[] = [
    closeRow(GAME_A, 'moneyline', { away_p_novig: 0.4, home_p_novig: 0.6 }),
    closeRow(GAME_A, 'spread', { away_p_novig: 0.1, home_p_novig: 0.9 }),
    closeRow(GAME_A, 'total', { away_p_novig: 0.1, home_p_novig: 0.9 }),
  ];
  const scored = scoreRun(run, closes);
  const stats = aggregateByParticipant(scored, run);
  const arm1 = stats.find((s) => s.participantId === 'model-arm');
  const arm2 = stats.find((s) => s.participantId === 'model-arm-2');
  assert.ok(arm1 && arm2);

  // Pin the premise: the two comparators disagree on this fixture.
  const pooled1 = arm1.gameLevel.meanClvPct;
  const pooled2 = arm2.gameLevel.meanClvPct;
  const ml1 = arm1.byMarket['moneyline']?.gameLevel.meanClvPct;
  const ml2 = arm2.byMarket['moneyline']?.gameLevel.meanClvPct;
  assert.ok(pooled1 !== null && pooled2 !== null && ml1 != null && ml2 != null);
  assert.ok(pooled2 > pooled1, 'fixture premise: model-arm-2 must win the pooled aggregate');
  assert.ok(ml1 > ml2, 'fixture premise: model-arm must win the moneyline market');

  const markdown = buildScorecardMarkdown(run, scored, stats, '2026-07-12T21:00:00.000Z');
  const mlAt = markdown.indexOf('### Moneyline');
  const spreadAt = markdown.indexOf('### Spread (run line)');
  const totalAt = markdown.indexOf('### Total');
  assert.ok(mlAt > 0 && spreadAt > mlAt && totalAt > spreadAt);

  // Moneyline table: model-arm above model-arm-2 (the pooled comparator
  // would render the opposite). '| model-arm |' cannot match inside the
  // '| model-arm-2 |' cell, so the cell match is exact.
  const arm1MlRow = markdown.indexOf('| model-arm |', mlAt);
  const arm2MlRow = markdown.indexOf('| model-arm-2 |', mlAt);
  assert.ok(arm1MlRow > mlAt && arm2MlRow > mlAt && arm1MlRow < spreadAt && arm2MlRow < spreadAt);
  assert.ok(arm1MlRow < arm2MlRow, 'moneyline table must follow the moneyline means');

  // Spread table: the market's own order flips — model-arm-2 first.
  const arm1SpreadRow = markdown.indexOf('| model-arm |', spreadAt);
  const arm2SpreadRow = markdown.indexOf('| model-arm-2 |', spreadAt);
  assert.ok(arm1SpreadRow > spreadAt && arm2SpreadRow > spreadAt && arm1SpreadRow < totalAt && arm2SpreadRow < totalAt);
  assert.ok(arm2SpreadRow < arm1SpreadRow, 'spread table must follow the spread means');

  // Nothing-scoreable rows sort last: the timeout arm renders below both
  // scoring arms in the moneyline table.
  const timeoutMlRow = markdown.indexOf('| timeout-arm |', mlAt);
  assert.ok(timeoutMlRow > mlAt && timeoutMlRow < spreadAt);
  assert.ok(timeoutMlRow > arm1MlRow && timeoutMlRow > arm2MlRow, 'null results must sort last');
});

test('a fully-failed arm keeps 0/N rows in every rendered per-market table', () => {
  const { lines } = fixtureRun({ extraArm: { participantId: 'timeout-arm', outcome: 'timeout' } });
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, []);
  const stats = aggregateByParticipant(scored, run);
  const markdown = buildScorecardMarkdown(run, scored, stats, '2026-07-12T21:00:00.000Z');
  const byMarketAt = markdown.indexOf('## By market');
  assert.ok(byMarketAt > 0);
  const failedRows = [...markdown.matchAll(/\| timeout-arm \| 0 \| 0\/2 \| 0 \| — \| — \| — \| — \| — \| — \|/g)];
  assert.equal(failedRows.length, 3, 'the failed arm must appear in all three per-market tables');
  assert.ok(failedRows.every((m) => (m.index ?? -1) > byMarketAt));
});
