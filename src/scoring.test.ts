import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BASELINE_POLICY_VERSION, runBaselines } from './baselines.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { CLOSE_QUALITY_REASONS } from './clv.js';
import { buildScorecardMarkdown } from './scorecard.js';
import type { BaselinePolicyVersion } from './baselines.js';
import {
  aggregateByParticipant,
  closeQuoteFromRow,
  closesByKey,
  emptyPrimaryEstimateNote,
  heldOutOfPrimary,
  inPrimaryStratum,
  isScheduleChanged,
  parseRunRecords,
  primaryScoreableCount,
  summariseEmptyPrimaryEstimate,
  SCHEDULE_CHANGE_TOLERANCE_MS,
  scheduleDriftMs,
  SCORING_POLICY_VERSION,
  scoredRecords,
  scoreRun,
  sideForSelection,
  verifyRunIntegrity,
} from './scoring.js';
import { runScoreCli } from './scoreRun.js';
import { makeGameBundle, makeRequest } from './testFactories.js';
import type { GameRequest } from './bundle.js';
import type { UnscoredReason } from './clv.js';
import type { MarketStats, ScoredPick } from './scoring.js';
import type { ClosingLineRow, GameBundle, SlateBundle } from './types.js';

// Fixture ladder parameter: the real committed k so ladder goldens are
// stable, threaded explicitly like the CLI threads the loaded artifact.
const TEST_LADDER = { k: 8.101061957791782, parameterVersion: 'TOTALS_V1_PROVISIONAL' };

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
  /** Overrides GAME_A's bundle total line (e.g. 9 for a push-capable line). */
  totalLineGameA?: number;
  /** Builds a v2-ERA run: run_meta stamps the v0.5 scaffold, and every archived
   *  body and decision record carries the v2 analysis fields. */
  schemaEra2?: boolean;
}): {
  lines: string[];
  requests: GameRequest[];
  slateSha256: string;
} {
  const gameABase = makeGameBundle({ gameId: GAME_A });
  const requests = [
    makeRequest('2026-07-12T16:15:00+00:00', {
      gameId: GAME_A,
      ...(options?.totalLineGameA !== undefined
        ? {
            markets: {
              ...gameABase.markets,
              // makeGameBundle builds a full board, so total is present.
              total: { ...gameABase.markets.total!, line: options.totalLineGameA },
            },
          }
        : {}),
    }),
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
      const common = {
        probabilities: { win: 0.55, push: 0, loss: 0.45 },
        confidence: 0.6,
        wouldAbstain: false,
        rationale: 'reference-price read',
        // v2-era bodies carry the (decision-bearing) analysis on every forecast.
        ...(options?.schemaEra2
          ? {
              axes: { valuation: 4, trend: 2, consensus: 3, news: 1, softness: 5 },
              primaryAxis: 'valuation',
              primaryExpectation: 'The reference price reads rich for the selected side.',
            }
          : {}),
      };
      // These scenarios build full three-market boards, so every block is present.
      const ml = game.markets.moneyline!;
      const rl = game.markets.runLine!;
      const total = game.markets.total!;
      const forecasts = arm.flipped
        ? [
            { market: 'moneyline', selection: game.awayTeam, line: null, observedDecimal: ml.awayDecimal, selectedForExecution: true, evidenceRefs: [ml.evidenceRef], ...common },
            { market: 'spread', selection: game.homeTeam, line: rl.line, observedDecimal: rl.homeDecimal, selectedForExecution: false, evidenceRefs: [rl.evidenceRef], ...common },
            { market: 'total', selection: 'under', line: total.line, observedDecimal: total.underDecimal, selectedForExecution: true, evidenceRefs: [total.evidenceRef], ...common },
          ]
        : [
            { market: 'moneyline', selection: game.homeTeam, line: null, observedDecimal: ml.homeDecimal, selectedForExecution: true, evidenceRefs: [ml.evidenceRef], ...common },
            { market: 'spread', selection: game.awayTeam, line: rl.line, observedDecimal: rl.awayDecimal, selectedForExecution: false, evidenceRefs: [rl.evidenceRef], ...common },
            { market: 'total', selection: 'over', line: total.line, observedDecimal: total.overDecimal, selectedForExecution: true, evidenceRefs: [total.evidenceRef], ...common },
          ];
      const rawResponse = JSON.stringify({
        schemaVersion: options?.schemaEra2 ? 2 : 1,
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
          // v2-era decision records carry the accepted forecast's analysis, which
          // the verifier cross-checks against the archived body.
          ...(options?.schemaEra2
            ? {
                axes: (forecast as { axes?: unknown }).axes,
                primaryAxis: (forecast as { primaryAxis?: unknown }).primaryAxis,
                primaryExpectation: (forecast as { primaryExpectation?: unknown }).primaryExpectation,
              }
            : {}),
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
    // A v2-era run is stamped with the scaffold that prompts schema v2; the
    // absent stamp keeps the default fixtures in the legacy v1 era.
    ...(options?.schemaEra2 ? { promptScaffoldVersion: 'shadow-smoke-v0.5' } : {}),
  });

  return { lines: records.map((l) => JSON.stringify(l)), requests, slateSha256 };
}

/**
 * Overrides for close rows whose stored p_novig is deliberately asymmetric:
 * the scorer validates stored probabilities against raw quotes and refuses
 * disagreements, so fixtures that shape probabilities directly drop the raw
 * decimals (a real legacy/degraded row) — economic still scores from the
 * stored values; shin has nothing to recompute from and the pick is
 * UNPAIRED in the sensitivity readout.
 */
const NOVIG_ONLY = { away_odds_decimal: null, home_odds_decimal: null };

/**
 * The frozen bundle start of each fixture game (`makeRequest`'s cutoffAt is
 * the game's scheduledStartUtc). A healthy close locks at its own game's
 * start, so the default fixture is SAME-SCHEDULE and its last feed sighting
 * precedes the lock — schedule drift and post-start gates are exercised by
 * explicit overrides, never by accident.
 */
const FIXTURE_START_UTC: Record<string, string> = {
  [GAME_A]: '2026-07-12T16:15:00+00:00',
  [GAME_B]: '2026-07-12T20:10:00+00:00',
};

function closeRow(
  gameId: string,
  market: 'moneyline' | 'spread' | 'total',
  overrides: Partial<ClosingLineRow> = {},
): ClosingLineRow {
  const lock = FIXTURE_START_UTC[gameId] ?? '2026-07-12T16:15:00+00:00';
  const lockMs = Date.parse(lock);
  // `poll_gap_seconds` is the knob; `last_polled_at` is DERIVED from it so a
  // gap-only override still describes a COHERENT row. The scorer now refuses a
  // row whose stored gap contradicts its own instants, so a fixture that moved
  // only the gap would trip that refusal instead of the gate under test.
  const base = {
    network: 'polygon',
    jsonodds_id: gameId,
    market,
    line: market === 'moneyline' ? null : market === 'spread' ? 1.5 : 8.5,
    away_odds_decimal: 2.0,
    home_odds_decimal: 2.0,
    away_p_novig: 0.5,
    home_p_novig: 0.5,
    value_captured_at: new Date(lockMs - 20_000).toISOString(),
    lock_time: lock,
    poll_gap_seconds: 15 as number | null,
    confidence: 'fresh' as 'fresh' | 'stale' | 'missing',
    source: 'reference',
    ...overrides,
  };
  // Tolerates a deliberately unparseable `lock_time` — some cases supply one to
  // prove the scorer refuses it, and the fixture must not die first.
  const baseLockMs = Date.parse(base.lock_time);
  const derivedLastPolled =
    base.poll_gap_seconds === null || !Number.isFinite(baseLockMs)
      ? null
      : new Date(baseLockMs - base.poll_gap_seconds * 1000).toISOString();
  return {
    ...base,
    last_polled_at:
      'last_polled_at' in overrides ? (overrides.last_polled_at ?? null) : derivedLastPolled,
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

test('a provider_error arm carrying an archived (empty or partial) body is a coherent unfinished turn — the run stays scoreable', () => {
  // The runner records an unfinished turn (paused tool loop / refusal /
  // output-cap stop / any non-final provider state) as a RECEIVED response:
  // provider_error with the body archived. The verifier accepts both the
  // empty-body and partial-body shapes — the earlier rule refused any
  // provider_error body, which would have made every such run unscoreable.
  for (const body of ['', '{"schemaVersion":2,"games":[{"gameId":"']) {
    const { lines } = fixtureRun({ extraArm: { participantId: 'timeout-arm', outcome: 'provider_error' } });
    const mutated = lines.map((line) => {
      const record = JSON.parse(line) as {
        recordType?: string;
        participantId?: string;
        reportedModelId?: unknown;
        attempt?: { rawResponse?: unknown; reportedModelId?: unknown; providerResponseId?: unknown };
      };
      if (record.recordType === 'arm_game_response' && record.participantId === 'timeout-arm' && record.attempt) {
        record.attempt.rawResponse = body;
        // A received response identifies its model, so the identity gate stays green.
        record.attempt.reportedModelId = 'stub-model-2';
        record.attempt.providerResponseId = 'resp-paused';
        record.reportedModelId = 'stub-model-2';
      }
      return JSON.stringify(record);
    });
    const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS_WITH_TIMEOUT });
    assert.deepEqual(violations, [], `an unfinished-turn body ${JSON.stringify(body)} must not poison the run`);
  }
});

test('a provider_error arm whose archived body VALIDATES is refused — a valid response cannot be demoted to a provider failure', () => {
  const { lines, requests } = fixtureRun({ extraArm: { participantId: 'timeout-arm', outcome: 'provider_error' } });
  const requestA = requests.find((r) => r.game.gameId === GAME_A);
  assert.ok(requestA);
  const game = requestA.game;
  const ml = game.markets.moneyline!;
  const rl = game.markets.runLine!;
  const total = game.markets.total!;
  const common = { probabilities: { win: 0.55, push: 0, loss: 0.45 }, confidence: 0.6, wouldAbstain: false, rationale: 'reference-price read' };
  const validatingBody = JSON.stringify({
    schemaVersion: 1,
    cohortId: 'test-cohort',
    participantId: 'timeout-arm',
    requestedModelId: 'stub-model-2',
    bundleSha256: requestA.requestSha256,
    executionPolicy: 'fixed-moneyline-total',
    games: [
      {
        gameId: game.gameId,
        forecasts: [
          { market: 'moneyline', selection: game.homeTeam, line: null, observedDecimal: ml.homeDecimal, selectedForExecution: true, evidenceRefs: [ml.evidenceRef], ...common },
          { market: 'spread', selection: game.awayTeam, line: rl.line, observedDecimal: rl.awayDecimal, selectedForExecution: false, evidenceRefs: [rl.evidenceRef], ...common },
          { market: 'total', selection: 'over', line: total.line, observedDecimal: total.overDecimal, selectedForExecution: true, evidenceRefs: [total.evidenceRef], ...common },
        ],
      },
    ],
  });
  const mutated = lines.map((line) => {
    const record = JSON.parse(line) as {
      recordType?: string;
      participantId?: string;
      gameId?: string;
      reportedModelId?: unknown;
      attempt?: { rawResponse?: unknown; reportedModelId?: unknown };
    };
    if (record.recordType === 'arm_game_response' && record.participantId === 'timeout-arm' && record.gameId === GAME_A && record.attempt) {
      record.attempt.rawResponse = validatingBody;
      record.attempt.reportedModelId = 'stub-model-2';
      record.reportedModelId = 'stub-model-2';
    }
    return JSON.stringify(record);
  });
  const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS_WITH_TIMEOUT });
  assert.ok(
    violations.some((v) => v.includes('recorded provider_error but the archived initial response validates')),
    `expected the demotion refusal, got: ${violations.join(' | ')}`,
  );
});

test('the would-have-repaired rule mirrors the era: a v2-era v1-shaped initial without a repair is the SKIP, not a violation', () => {
  // (0) The v2-era fixture itself is clean.
  {
    const { lines } = fixtureRun({ schemaEra2: true });
    assert.deepEqual(verifyRunIntegrity(parseRunRecords(lines), { expectedArms: FIXTURE_ARMS }), []);
  }
  const dropDecisionsForGameA = (line: string): boolean => {
    const record = JSON.parse(line) as { recordType?: string; participantId?: string; gameId?: string };
    return !(record.recordType === 'decision' && record.participantId === 'model-arm' && record.gameId === GAME_A);
  };
  // (a) v2 era, v1-shaped initial (analysis stripped): the runner SKIPS that
  // repair — a fingerprintable no-repair invalid_schema arm is coherent.
  {
    const { lines } = fixtureRun({ schemaEra2: true });
    const mutated = lines
      .map((line) => {
        const record = JSON.parse(line) as {
          recordType?: string;
          participantId?: string;
          gameId?: string;
          outcome?: string;
          attempt?: { rawResponse?: string };
        };
        if (
          record.recordType === 'arm_game_response' &&
          record.participantId === 'model-arm' &&
          record.gameId === GAME_A &&
          record.attempt?.rawResponse !== undefined
        ) {
          record.outcome = 'invalid_schema';
          const body = JSON.parse(record.attempt.rawResponse) as {
            schemaVersion: number;
            games: Array<{ forecasts: Array<Record<string, unknown>> }>;
          };
          body.schemaVersion = 1;
          for (const g of body.games) {
            for (const f of g.forecasts) {
              delete f['axes'];
              delete f['primaryAxis'];
              delete f['primaryExpectation'];
            }
          }
          record.attempt.rawResponse = JSON.stringify(body);
        }
        return JSON.stringify(record);
      })
      .filter(dropDecisionsForGameA);
    const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
    assert.deepEqual(violations, [], 'a skipped repair after a v1-shaped initial is the v2-era runner behavior');
  }
  // (b) v2 era, a v2 body that fails only its cohort echo but fingerprints WITH
  // the analysis: that arm WOULD have been repaired — still a violation.
  {
    const { lines } = fixtureRun({ schemaEra2: true });
    const mutated = lines
      .map((line) => {
        const record = JSON.parse(line) as {
          recordType?: string;
          participantId?: string;
          gameId?: string;
          outcome?: string;
          attempt?: { rawResponse?: string };
        };
        if (
          record.recordType === 'arm_game_response' &&
          record.participantId === 'model-arm' &&
          record.gameId === GAME_A &&
          record.attempt?.rawResponse !== undefined
        ) {
          record.outcome = 'invalid_schema';
          const body = JSON.parse(record.attempt.rawResponse) as { cohortId: string };
          body.cohortId = 'wrong-cohort-echo';
          record.attempt.rawResponse = JSON.stringify(body);
        }
        return JSON.stringify(record);
      })
      .filter(dropDecisionsForGameA);
    const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
    assert.ok(
      violations.some((v) => v.includes('the harness would have attempted a repair')),
      `an analysis-carrying fingerprint must keep the rule: ${violations.join(' | ')}`,
    );
  }
  // (c) v1-ERA control: that era's runner repaired ANY fingerprintable initial,
  // so the same no-repair shape stays a violation there.
  {
    const { lines } = fixtureRun();
    const mutated = lines
      .map((line) => {
        const record = JSON.parse(line) as {
          recordType?: string;
          participantId?: string;
          gameId?: string;
          outcome?: string;
          attempt?: { rawResponse?: string };
        };
        if (
          record.recordType === 'arm_game_response' &&
          record.participantId === 'model-arm' &&
          record.gameId === GAME_A &&
          record.attempt?.rawResponse !== undefined
        ) {
          record.outcome = 'invalid_schema';
          const body = JSON.parse(record.attempt.rawResponse) as { cohortId: string };
          body.cohortId = 'wrong-cohort-echo';
          record.attempt.rawResponse = JSON.stringify(body);
        }
        return JSON.stringify(record);
      })
      .filter(dropDecisionsForGameA);
    const violations = verifyRunIntegrity(parseRunRecords(mutated), { expectedArms: FIXTURE_ARMS });
    assert.ok(
      violations.some((v) => v.includes('the harness would have attempted a repair')),
      `the v1 era keeps its original rule: ${violations.join(' | ')}`,
    );
  }
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
  const scored = scoreRun(run, [], TEST_LADDER);
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
    closeRow(GAME_A, 'spread', { ...NOVIG_ONLY, away_p_novig: 0.45, home_p_novig: 0.55 }),
    closeRow(GAME_A, 'total'),
    closeRow(GAME_B, 'moneyline', { ...NOVIG_ONLY, away_p_novig: 0.4, home_p_novig: 0.6 }),
  ];
  const scored = scoreRun(run, closes, TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
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
  const stats = aggregateByParticipant(scoreRun(run, [], TEST_LADDER), run, TEST_LADDER);
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
  const scored = scoreRun(run, [closeRow(GAME_A, 'moneyline')], TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const records = scoredRecords(run, scored, stats, '2026-07-12T21:00:00.000Z', TEST_LADDER);
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
  assert.equal(SCORING_POLICY_VERSION, 'scoring-v0.6.0');
});

test('every scored record type is stamped with the scoring policy version', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, [closeRow(GAME_A, 'moneyline')], TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const records = scoredRecords(run, scored, stats, '2026-07-12T21:00:00.000Z', TEST_LADDER);
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
    closeRow(GAME_B, 'moneyline', { ...NOVIG_ONLY, away_p_novig: 0.4, home_p_novig: 0.6 }),
  ];
  const scored = scoreRun(run, closes, TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);

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

  // The sensitivity readout is PAIRED: game B's close carries stored
  // probabilities without raw quotes, so its pick scores economically but
  // cannot pair — the paired count trails primaryScoreable and BOTH
  // sensitivity columns aggregate only game A. The proportional-paired mean
  // therefore equals game A's economic CLV, not the pooled two-game mean.
  assert.equal(model.primaryScoreable, 2);
  assert.equal(model.sensitivity.devigMethod, 'shin-v1');
  assert.equal(model.sensitivity.pairedPicksEconomic, 1);
  assert.equal(model.sensitivity.pairedPicksMarginAdjusted, 1);
  assert.equal(model.sensitivity.economic.proportional.meanClvPct, 8.5);
  assert.notEqual(model.sensitivity.economic.proportional.meanClvPct, model.gameLevel.meanClvPct);
  assert.ok(model.sensitivity.economic.shin.meanClvPct !== null);
  assert.ok(model.sensitivity.marginAdjusted.shin.meanClvPct !== null);

  // Scored records are self-contained: both entry sides, both metrics, the
  // named de-vig method, and the shin sensitivity block on scored rows.
  const records = scoredRecords(run, scored, stats, '2026-07-12T21:00:00.000Z', TEST_LADDER);
  const meta = records.find((r) => r['recordType'] === 'scored_run_meta');
  assert.ok(meta);
  assert.ok(meta['metrics']);
  assert.deepEqual(meta['devigMethods'], { primary: 'proportional-v1', sensitivity: ['shin-v1'] });
  // The de-vig methods are named on EVERY scored record type, including the
  // participant scorecards (the committed output contract).
  const cards = records.filter((r) => r['recordType'] === 'participant_scorecard');
  assert.ok(cards.length > 0);
  assert.ok(
    cards.every((r) =>
      JSON.stringify(r['devigMethods']) ===
      JSON.stringify({ primary: 'proportional-v1', sensitivity: ['shin-v1'] }),
    ),
  );
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
    closeRow(GAME_B, 'moneyline', { ...NOVIG_ONLY, away_p_novig: 0.4, home_p_novig: 0.6 }),
  ];
  const scored = scoreRun(run, closes, TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);

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

function syntheticScored(
  gameId: string,
  primaryClvPct: number | null,
  scheduleOverrides: Partial<Pick<ScoredPick, 'scheduleChanged' | 'scheduleDriftMs'>> = {},
): ScoredPick {
  return {
    scheduleDriftMs: 0,
    scheduleChanged: false,
    ...scheduleOverrides,
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
    axes: null,
    primaryAxis: null,
    primaryExpectation: null,
    side: 'away',
    entryOppositeDecimal: 2,
    ladder: null,
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
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
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
    closeRow(GAME_B, 'moneyline', { ...NOVIG_ONLY, away_p_novig: 0.4, home_p_novig: 0.6 }),
  ];
  const scored = scoreRun(run, closes, TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const markdown = buildScorecardMarkdown(run, scored, stats, '2026-07-12T21:00:00.000Z', TEST_LADDER);

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
    closeRow(GAME_A, 'moneyline', { ...NOVIG_ONLY, away_p_novig: 0.4, home_p_novig: 0.6 }),
    closeRow(GAME_A, 'spread', { ...NOVIG_ONLY, away_p_novig: 0.1, home_p_novig: 0.9 }),
    closeRow(GAME_A, 'total', { ...NOVIG_ONLY, away_p_novig: 0.1, home_p_novig: 0.9 }),
  ];
  const scored = scoreRun(run, closes, TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
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

  const markdown = buildScorecardMarkdown(run, scored, stats, '2026-07-12T21:00:00.000Z', TEST_LADDER);
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
  const scored = scoreRun(run, [], TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const markdown = buildScorecardMarkdown(run, scored, stats, '2026-07-12T21:00:00.000Z', TEST_LADDER);
  const byMarketAt = markdown.indexOf('## By market');
  assert.ok(byMarketAt > 0);
  const failedRows = [...markdown.matchAll(/\| timeout-arm \| 0 \| 0\/2 \| 0 \| — \| — \| — \| — \| — \| — \| 0 \| — \|/g)];
  assert.equal(failedRows.length, 3, 'the failed arm must appear in all three per-market tables');
  assert.ok(failedRows.every((m) => (m.index ?? -1) > byMarketAt));
});

// ---------------------------------------------------------------------------
// TOTALS_V1 ladder integration (added in scoring-v0.4.0)
// ---------------------------------------------------------------------------

test('every totals pick carries a ladder block; other markets carry none', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, [], TEST_LADDER);
  for (const pick of scored) {
    if (pick.market === 'total') {
      assert.ok(pick.ladder !== null, 'totals pick has a ladder block');
      assert.equal(pick.ladder.ladderVersion, 'TOTALS_V1');
      assert.equal(pick.ladder.parameterVersion, 'TOTALS_V1_PROVISIONAL');
      // No closes fetched: the shared availability gate is honored verbatim.
      assert.equal(pick.ladder.unscoredReason, 'close_missing');
    } else {
      assert.equal(pick.ladder, null);
    }
  }
});

test('integer same-line totals stay conditional-only; the ladder value is sensitivity output (E2E)', () => {
  // GAME_A bundle total moved to the push-capable line 9; the close is at
  // the same line with an even conditional split (2.0/2.0 -> 0.5/0.5).
  const { lines } = fixtureRun({ totalLineGameA: 9 });
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, [closeRow(GAME_A, 'total', { line: 9 })], TEST_LADDER);
  const over = scored.find(
    (p) => p.participantId === 'model-arm' && p.market === 'total' && p.gameId === GAME_A,
  );
  assert.ok(over && over.selection === 'over' && over.line === 9, 'fixture premise');
  // The primary columns are untouched while the candidate method's
  // validation is pending: conditional-only, exactly as before the ladder.
  assert.equal(over.result.conditionalClvPct, -4.5455);
  assert.equal(over.result.primaryClvPct, null);
  assert.equal(over.result.unscoredReason, 'push_capable_line');
  assert.equal(over.result.marginAdjustedConditionalClvPct, 0);
  // The ladder block carries the generalized value as separately labeled
  // sensitivity output: conditional shrunk by the push mass q_P =
  // 0.089517251326 (the independent golden at mu solved from (9, 0.5)).
  assert.ok(over.ladder !== null, 'ladder block present');
  assert.equal(over.ladder.unscoredReason, null);
  assert.equal(over.ladder.economicClvPct, -4.1386);
  assert.equal(over.ladder.qPushEntry, 0.0895);
  // Margin-adjusted zero-point survives the generalization EXACTLY: entry
  // and close both split 0.5/0.5, so q_W/q_e + q_P = (1-q_P) + q_P = 1.
  assert.equal(over.ladder.marginAdjustedClvPct, 0);
  // Coverage semantics: nothing enters the primary aggregates, and the pick
  // counts as conditional-only.
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const model = stats.find((s) => s.participantId === 'model-arm');
  assert.ok(model);
  assert.equal(model.byMarket['total']?.scoreable, 0);
  assert.equal(model.conditionalOnly, 1);
});

test('moved totals lines are priced by the ladder while exact-line stays unavailable (E2E)', () => {
  // Entry total 8.5 (fixture default), close at 9 with an even conditional
  // split: mu = 9.551675689313 (independent golden), above(8.5) =
  // 0.544758625663, below(8.5) = 0.455241374337.
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, [closeRow(GAME_A, 'total', { line: 9 })], TEST_LADDER);
  const over = scored.find(
    (p) => p.participantId === 'model-arm' && p.market === 'total' && p.gameId === GAME_A,
  );
  assert.ok(over && over.selection === 'over', 'fixture premise');
  assert.equal(over.result.unscoredReason, 'line_moved');
  assert.equal(over.result.primaryClvPct, null);
  assert.equal(over.result.lineMovementFavorable, 0.5);
  assert.ok(over.ladder !== null, 'ladder block present');
  assert.equal(over.ladder.unscoredReason, null);
  // econ = 100*(0.544758625663*1.90909 - 1) = 3.9993; half-line: no push.
  assert.equal(over.ladder.economicClvPct, 3.9993);
  assert.equal(over.ladder.qPushEntry, 0);
  const under = scored.find(
    (p) => p.participantId === 'baseline-under-total' && p.gameId === GAME_A,
  );
  assert.ok(under && under.line === 8.5, 'fixture premise');
  assert.equal(under.result.unscoredReason, 'line_moved');
  assert.equal(under.result.lineMovementFavorable, -0.5);
  // econ = 100*(0.455241374337*1.90909 - 1) = -13.0903.
  assert.equal(under.ladder?.economicClvPct, -13.0903);
});

test('run_meta and participant_scorecard carry the ladder stamps and aggregates', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, [closeRow(GAME_A, 'total', { line: 9 })], TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const records = scoredRecords(run, scored, stats, '2026-07-12T21:00:00.000Z', TEST_LADDER);
  const meta = records.find((r) => r['recordType'] === 'scored_run_meta');
  assert.ok(meta);
  assert.deepEqual(meta['ladder'], {
    version: 'TOTALS_V1',
    parameterVersion: 'TOTALS_V1_PROVISIONAL',
    k: TEST_LADDER.k,
  });
  // GAME_A's over + under totals picks are ladder-scored (model + baselines);
  // GAME_B has no close. Cross-check the count against the picks themselves.
  const expected = scored.filter((p) => p.ladder?.economicClvPct != null).length;
  assert.ok(expected > 0, 'fixture premise: some picks are ladder-scored');
  assert.equal(meta['totalsLadderScoreable'], expected);
  const policy = meta['closePolicy'] as Record<string, unknown>;
  assert.ok(String(policy['integerLinePrimary']).includes('TOTALS_V1'), 'policy names the ladder');
  const card = records.find(
    (r) => r['recordType'] === 'participant_scorecard' && r['participantId'] === 'model-arm',
  );
  assert.ok(card);
  const ladderStats = card['totalsLadder'] as Record<string, unknown>;
  assert.equal(ladderStats['ladderVersion'], 'TOTALS_V1');
  assert.equal(ladderStats['parameterVersion'], 'TOTALS_V1_PROVISIONAL');
  assert.equal(ladderStats['ladderScoreable'], 1);
  // The single-market moneyline baselines have no totals exposure.
  const mlCard = records.find(
    (r) => r['recordType'] === 'participant_scorecard' && r['participantId'] === 'baseline-home-ml',
  );
  assert.ok(mlCard);
  assert.equal(mlCard['totalsLadder'], null);
});

test('the scorecard renders the ladder table, policy bullet, and moved-line ladder columns', () => {
  const { lines } = fixtureRun({ extraArm: { participantId: 'timeout-arm', outcome: 'timeout' } });
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, [closeRow(GAME_A, 'total', { line: 9 })], TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const markdown = buildScorecardMarkdown(run, scored, stats, '2026-07-12T21:00:00.000Z', TEST_LADDER);
  assert.ok(
    markdown.includes('## Totals ladder (`TOTALS_V1` candidate — sensitivity output pending validation)'),
    'ladder section present',
  );
  assert.ok(
    markdown.includes('preregistered CANDIDATE line-value method'),
    'candidate status disclosed in the policy bullet',
  );
  assert.ok(
    markdown.includes('Line movement alone never disqualifies a totals pick'),
    'the precise coverage claim, not an unconditional one',
  );
  assert.ok(
    markdown.includes(`dispersion parameter \`TOTALS_V1_PROVISIONAL\`, k = ${TEST_LADDER.k}`),
    'parameter provenance in the header bullet',
  );
  assert.ok(markdown.includes('parity oscillation'), 'known approximation disclosed');
  assert.ok(
    markdown.includes('| Ladder econ mean | Ladder econ median | Ladder margin-adj mean |'),
    'ladder table header',
  );
  // model-arm, FULL row: 2 totals picks, 1 ladder-scored (GAME_A moved over:
  // econ 3.9993, MA 100*(0.544758625663/0.5 - 1) = 8.9517), same-line column
  // empty (nothing scored at an unchanged line), movement +0.5 over the one
  // ladder-scored pick, GAME_B's totals close missing.
  assert.ok(
    markdown.includes(
      '| model-arm | 2 | 1 | 3.9993 | 3.9993 | 8.9517 | 8.9517 | — (0) | 0.5 | 0 | close_missing 1 |',
    ),
    'model-arm full ladder row',
  );
  // baseline-under-total: under side of the same moved line (econ -13.0903,
  // MA -8.9517, movement -0.5).
  assert.ok(
    markdown.includes(
      '| baseline-under-total | 2 | 1 | -13.0903 | -13.0903 | -8.9517 | -8.9517 | — (0) | -0.5 | 0 | close_missing 1 |',
    ),
    'baseline-under-total full ladder row',
  );
  // Survivor-bias rule: a fully-failed model arm keeps a zero row in the
  // ladder table — it must never vanish from the new surface.
  assert.ok(
    markdown.includes('| timeout-arm | 0 | 0 | — | — | — | — | — (0) | — | 0 | — |'),
    'failed arm keeps a zero ladder row',
  );
  // Own-column ranking, nulls last: the over side (+3.9993) above the under
  // baseline (-13.0903), and the null-mean failed arm dead last.
  const idx = (needle: string): number => {
    const at = markdown.indexOf(needle);
    assert.ok(at >= 0, `row present: ${needle}`);
    return at;
  };
  assert.ok(
    idx('| model-arm | 2 | 1 | 3.9993') < idx('| baseline-under-total | 2 | 1 | -13.0903'),
    'ranked by own ladder mean',
  );
  assert.ok(
    idx('| baseline-under-total | 2 | 1 | -13.0903') < idx('| timeout-arm | 0 | 0 |'),
    'null means rank last',
  );
  // The moved-lines table now carries the ladder values alongside movement.
  assert.ok(
    markdown.includes(
      '| Participant | Game | Market | Selection | Entry line | Closing line | Favorable movement | Ladder econ | Ladder margin-adj |',
    ),
    'moved-lines table has ladder columns',
  );
});

test('a gate-passing pick the ladder cannot solve is typed and DISCLOSED in the rendered scorecard', () => {
  // Same-line close at 6.5 with an extreme de-vigged over probability: the
  // exact-line metrics score it (fresh, consistent close), but the implied
  // mean falls below the solver bound — the ladder must refuse with a typed
  // reason that surfaces in the rendered table, never a silent hole. This is
  // exactly why every public surface says line movement ALONE never
  // disqualifies a pick, not that every gate-passing pick is priced.
  const { lines } = fixtureRun({ totalLineGameA: 6.5 });
  const run = parseRunRecords(lines);
  const scored = scoreRun(
    run,
    [
      closeRow(GAME_A, 'total', {
        line: 6.5,
        ...NOVIG_ONLY,
        away_p_novig: 1e-7,
        home_p_novig: 1 - 1e-7,
      }),
    ],
    TEST_LADDER,
  );
  const over = scored.find(
    (p) => p.participantId === 'model-arm' && p.market === 'total' && p.gameId === GAME_A,
  );
  assert.ok(over && over.selection === 'over' && over.line === 6.5, 'fixture premise');
  assert.equal(over.result.unscoredReason, null, 'exact-line metrics scored this pick');
  assert.ok(over.result.primaryClvPct !== null, 'primary is a number');
  assert.equal(over.ladder?.unscoredReason, 'ladder_unsolvable');
  assert.equal(over.ladder?.economicClvPct, null);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const markdown = buildScorecardMarkdown(run, scored, stats, '2026-07-12T21:00:00.000Z', TEST_LADDER);
  assert.match(markdown, /\| model-arm \| 2 \| 0 \| — \| — \| — \| — \| .* \| — \| 0 \| ladder_unsolvable 1, close_missing 1 \|/);
});

test('ladder participant aggregates are value-pinned: MA summaries, movement, unscored reasons', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, [closeRow(GAME_A, 'total', { line: 9 })], TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const model = stats.find((s) => s.participantId === 'model-arm');
  assert.ok(model && model.totalsLadder !== null, 'model ladder block');
  // One ladder-scored pick (GAME_A over, moved +0.5): econ 3.9993, MA
  // 100*(0.544758625663/0.5 - 1) = 8.9517; GAME_B's close is missing.
  assert.deepEqual(model.totalsLadder.gameLevel, {
    meanClvPct: 3.9993,
    medianClvPct: 3.9993,
    beatClosePct: 100,
  });
  assert.deepEqual(model.totalsLadder.gameLevelMarginAdjusted, {
    meanClvPct: 8.9517,
    medianClvPct: 8.9517,
    beatClosePct: 100,
  });
  assert.equal(model.totalsLadder.meanSignedMovement, 0.5);
  assert.deepEqual(model.totalsLadder.unscoredByReason, { close_missing: 1 });
  const under = stats.find((s) => s.participantId === 'baseline-under-total');
  assert.ok(under && under.totalsLadder !== null, 'under-total ladder block');
  // Under direction: the movement sign flips with the selection, and the MA
  // mirror is the negative of the over side at an even entry quote.
  assert.equal(under.totalsLadder.meanSignedMovement, -0.5);
  assert.deepEqual(under.totalsLadder.gameLevelMarginAdjusted, {
    meanClvPct: -8.9517,
    medianClvPct: -8.9517,
    beatClosePct: 0,
  });
});

test('a fully-failed model arm keeps a non-null totalsLadder block (survivor-bias rule)', () => {
  const { lines } = fixtureRun({ extraArm: { participantId: 'timeout-arm', outcome: 'timeout' } });
  const run = parseRunRecords(lines);
  const stats = aggregateByParticipant(scoreRun(run, [], TEST_LADDER), run, TEST_LADDER);
  const timeoutArm = stats.find((s) => s.participantId === 'timeout-arm');
  assert.ok(timeoutArm);
  assert.ok(timeoutArm.totalsLadder !== null, 'failed arm stays visible on the ladder surface');
  assert.equal(timeoutArm.totalsLadder.totalsPicks, 0);
  assert.equal(timeoutArm.totalsLadder.ladderScoreable, 0);
  assert.equal(timeoutArm.totalsLadder.gameLevel.meanClvPct, null);
  // Both stamps ride along even on a zero-decision row: the block still
  // states which method and parameter WOULD have priced its picks.
  assert.equal(timeoutArm.totalsLadder.ladderVersion, 'TOTALS_V1');
  assert.equal(timeoutArm.totalsLadder.parameterVersion, 'TOTALS_V1_PROVISIONAL');
});

test('ladder aggregation clusters within a game first and never swaps econ with margin-adjusted', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const ladderScoredPick = (gameId: string, econ: number, ma: number): ScoredPick => ({
    ...syntheticScored(gameId, null),
    ladder: {
      ladderVersion: 'TOTALS_V1',
      parameterVersion: 'TOTALS_V1_PROVISIONAL',
      unscoredReason: null,
      closeImpliedMean: 9,
      qWinEntry: 0.5,
      qPushEntry: 0,
      economicClvPct: econ,
      marginAdjustedClvPct: ma,
    },
  });
  // Two picks in GAME_A, one in GAME_B: game-level and per-pick MUST differ
  // (per-pick 20 vs game-level mean(15, 30) = 22.5), and the MA values are
  // deliberately half the econ values so a copy-paste swap cannot hide.
  const scored = [
    ladderScoredPick(GAME_A, 10, 5),
    ladderScoredPick(GAME_A, 20, 10),
    ladderScoredPick(GAME_B, 30, 15),
  ];
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const policy = stats.find((s) => s.participantId === 'synthetic-policy');
  assert.ok(policy && policy.totalsLadder !== null, 'synthetic policy has a ladder block');
  assert.equal(policy.totalsLadder.ladderScoreable, 3, 'scoreable counts VALUES, not games');
  assert.equal(policy.totalsLadder.perPick.meanClvPct, 20);
  assert.equal(policy.totalsLadder.gameLevel.meanClvPct, 22.5);
  assert.equal(policy.totalsLadder.perPickMarginAdjusted.meanClvPct, 10);
  assert.equal(policy.totalsLadder.gameLevelMarginAdjusted.meanClvPct, 11.25);
});

test('conditional-only counts exactly the picks with a conditional and NO primary', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const conditionalOnlyPick: ScoredPick = {
    ...syntheticScored(GAME_A, null),
    result: { ...syntheticScored(GAME_A, null).result, conditionalClvPct: -5 },
  };
  // A pick carrying BOTH a conditional value and a primary (possible only
  // under a future validated method) is not conditional-ONLY and must not
  // be double-counted.
  const conditionalWithPrimaryPick: ScoredPick = {
    ...syntheticScored(GAME_B, -4.1386),
    result: { ...syntheticScored(GAME_B, -4.1386).result, conditionalClvPct: -4.5455 },
  };
  const stats = aggregateByParticipant([conditionalOnlyPick, conditionalWithPrimaryPick], run, TEST_LADDER);
  const policy = stats.find((s) => s.participantId === 'synthetic-policy');
  assert.ok(policy);
  assert.equal(policy.conditionalOnly, 1);
});

// --- S3c: dynamic (scoped) scorer (SPEC-prepared-request.md §3, §6, §5-S3) ---

type ScopeMarket = 'moneyline' | 'spread' | 'total';
const SCOPE_BLOCK: Record<ScopeMarket, 'moneyline' | 'runLine' | 'total'> = {
  moneyline: 'moneyline',
  spread: 'runLine',
  total: 'total',
};

/**
 * A single-game v0.3 run whose game supplies only `present` markets (1-3). Real
 * hashes (recomputed exactly as the scorer does, via makeRequest's request
 * bundle), a valid scoped model response, and v0.3 baselines for the supplied
 * markets. `stampOverride` restamps the baseline policy version WITHOUT changing
 * the derived rows, so a v0.1/v0.2 stamp yields the scoped-under-full-board-policy
 * artifact the scorer must refuse.
 */
function scopedRun(
  present: ReadonlyArray<ScopeMarket>,
  stampOverride?: BaselinePolicyVersion,
  extraMarkets?: Record<string, unknown>,
): { lines: string[] } {
  const full = makeGameBundle({ gameId: GAME_A });
  // `extraMarkets` is merged in BEFORE hashing so the artifact stays hash-coherent
  // (e.g. an unknown market block bound into the recorded bundle); the recognized
  // present blocks then drive forecasts and baselines.
  const scopedMarkets: Record<string, unknown> = { ...extraMarkets };
  for (const marketKey of present) {
    const blockKey = SCOPE_BLOCK[marketKey];
    scopedMarkets[blockKey] = full.markets[blockKey];
  }
  const request = makeRequest('2026-07-12T16:15:00+00:00', {
    gameId: GAME_A,
    markets: scopedMarkets as GameBundle['markets'],
  });
  const game = request.game;
  const requestSha256 = request.requestSha256;
  const gameSha256 = sha256Hex(canonicalize(game));
  const slateSha256 = requestSha256; // single-game slate == the request bundle

  const markets = game.markets;
  const common = {
    probabilities: { win: 0.5, push: 0, loss: 0.5 },
    confidence: 0.6,
    wouldAbstain: false,
    rationale: 'reference-price read',
  };
  const forecasts: Array<Record<string, unknown>> = [];
  if (markets.moneyline) {
    forecasts.push({ market: 'moneyline', selection: game.homeTeam, line: null, observedDecimal: markets.moneyline.homeDecimal, selectedForExecution: true, evidenceRefs: [markets.moneyline.evidenceRef], ...common });
  }
  if (markets.runLine) {
    forecasts.push({ market: 'spread', selection: game.awayTeam, line: markets.runLine.line, observedDecimal: markets.runLine.awayDecimal, selectedForExecution: false, evidenceRefs: [markets.runLine.evidenceRef], ...common });
  }
  if (markets.total) {
    forecasts.push({ market: 'total', selection: 'over', line: markets.total.line, observedDecimal: markets.total.overDecimal, selectedForExecution: true, evidenceRefs: [markets.total.evidenceRef], ...common });
  }

  const rawResponse = JSON.stringify({
    schemaVersion: 1,
    cohortId: 'test-cohort',
    participantId: 'model-arm',
    requestedModelId: 'stub-model-1',
    bundleSha256: requestSha256,
    executionPolicy: 'fixed-moneyline-total',
    games: [{ gameId: game.gameId, forecasts }],
  });

  const identity = { label: LABEL, runId: 'test-run' };
  const records: Array<Record<string, unknown>> = [];
  records.push({ recordType: 'bundle_game', ...identity, gameId: game.gameId, slug: 'mil-pit-2026-07-12', cutoffAt: request.requestBundle.cutoffAt, gameSha256, requestSha256, bundle: game });
  records.push({ recordType: 'arm_game_response', ...identity, cohortId: 'test-cohort', participantId: 'model-arm', provider: 'openai', requestedModelId: 'stub-model-1', reportedModelId: 'stub-model-1', gameId: game.gameId, requestSha256, outcome: 'valid', cutoffAt: request.requestBundle.cutoffAt, repairUsed: false, attempt: { reportedModelId: 'stub-model-1', providerResponseId: 'resp-1', rawResponse, requestAt: '2026-07-12T14:07:00.001Z', responseAt: '2026-07-12T14:07:00.055Z', latencyMs: 54 }, repair: null });
  for (const f of forecasts) {
    records.push({ recordType: 'decision', ...identity, cohortId: 'test-cohort', participantId: 'model-arm', gameId: game.gameId, market: f['market'], selection: f['selection'], line: f['line'], observedDecimal: f['observedDecimal'], probabilities: f['probabilities'], confidence: f['confidence'], selectedForExecution: f['selectedForExecution'], wouldAbstain: f['wouldAbstain'], provider: 'openai', requestedModelId: 'stub-model-1', reportedModelId: 'stub-model-1', providerResponseId: 'resp-1', attemptUsed: 'initial', bundleSha256: requestSha256, gameSha256, slateSha256 });
  }

  // Always DERIVE the baseline rows under v0.3 (the scoped policy) so the fixture
  // can be built; STAMP with stampOverride so a v0.1/v0.2 stamp produces the
  // scoped-under-full-board-policy artifact the scorer refuses.
  const stampVersion: BaselinePolicyVersion = stampOverride ?? 'baselines-v0.3.0';
  const slateForBaselines = { ...request.requestBundle } as unknown as SlateBundle;
  let baselineCount = 0;
  for (const d of runBaselines(slateForBaselines, 'baselines-v0.3.0')) {
    records.push({ recordType: 'baseline_decision', ...identity, cohortId: 'test-cohort', participantId: d.participantId, policyVersion: stampVersion, gameId: d.gameId, market: d.market, selection: d.selection, line: d.line, observedDecimal: d.observedDecimal, slateSha256, gameSha256, requestSha256 });
    baselineCount += 1;
  }
  records.unshift({ recordType: 'run_meta', runId: 'test-run', cohortId: 'test-cohort', label: LABEL, mode: 'live', slateDate: '2026-07-12', slateSha256, bundleTimestamp: BUNDLE_TS, slateCutoffAt: '2026-07-12T16:15:00+00:00', eligibleGames: 1, armGameResults: 1, baselineDecisionCount: baselineCount, baselinePolicyVersion: stampVersion });

  return { lines: records.map((l) => JSON.stringify(l)) };
}

test('S3c: a scoped v0.3 run parses with only its supplied-market prices', () => {
  const run = parseRunRecords(scopedRun(['moneyline', 'total']).lines);
  const game = run.games.get(GAME_A);
  assert.ok(game);
  assert.ok(game.prices.moneyline);
  assert.ok(game.prices.total);
  assert.equal(game.prices.runLine, undefined);
});

test('S3c: every non-empty scoped board verifies clean under v0.3', () => {
  const combos: ScopeMarket[][] = [
    ['moneyline'],
    ['spread'],
    ['total'],
    ['moneyline', 'spread'],
    ['moneyline', 'total'],
    ['spread', 'total'],
    ['moneyline', 'spread', 'total'],
  ];
  for (const present of combos) {
    const run = parseRunRecords(scopedRun(present).lines);
    assert.deepEqual(
      verifyRunIntegrity(run, { expectedArms: FIXTURE_ARMS }),
      [],
      `scoped board [${present.join('+')}] must verify clean`,
    );
  }
});

test('S3c: a scoped artifact stamped with a full-board policy (v0.2) is refused', () => {
  const run = parseRunRecords(scopedRun(['moneyline', 'total'], 'baselines-v0.2.0').lines);
  const violations = verifyRunIntegrity(run, { expectedArms: FIXTURE_ARMS });
  assert.ok(
    violations.some((v) => v.includes('requires a full three-market board')),
    violations.join('; '),
  );
});

test('S3c: scoped denominators count only supplied markets', () => {
  const run = parseRunRecords(scopedRun(['moneyline', 'total']).lines);
  const scored = scoreRun(run, [], TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const model = stats.find((s) => s.participantId === 'model-arm');
  assert.ok(model);
  assert.equal(model.eligibleMarkets, 2); // 1 dispatched game x 2 supplied markets
  assert.equal(model.byMarket['moneyline']?.eligible, 1);
  assert.equal(model.byMarket['total']?.eligible, 1);
  assert.equal(model.byMarket['spread'], undefined); // run line not supplied
});

test('S3c: a decision for a market the scoped game does not supply is a violation', () => {
  const lines = scopedRun(['moneyline', 'total']).lines;
  // Full board (makeGameBundle) — its run-line price seeds the injected decision.
  const game = makeGameBundle({ gameId: GAME_A });
  const spreadDecision = JSON.stringify({
    recordType: 'decision',
    label: LABEL,
    runId: 'test-run',
    cohortId: 'test-cohort',
    participantId: 'model-arm',
    gameId: GAME_A,
    market: 'spread',
    selection: game.awayTeam,
    line: game.markets.runLine!.line,
    observedDecimal: game.markets.runLine!.awayDecimal,
    probabilities: { win: 0.5, push: 0, loss: 0.5 },
    confidence: 0.6,
    selectedForExecution: false,
    wouldAbstain: false,
    provider: 'openai',
    requestedModelId: 'stub-model-1',
    reportedModelId: 'stub-model-1',
    providerResponseId: 'resp-1',
    attemptUsed: 'initial',
    bundleSha256: 'x',
    gameSha256: null,
    slateSha256: 'x',
  });
  const violations = verifyRunIntegrity(parseRunRecords([...lines, spreadDecision]), {
    expectedArms: FIXTURE_ARMS,
  });
  assert.ok(
    violations.some((v) => v.includes('does not supply')),
    violations.join('; '),
  );
});

test('S3c: a total-less scoped board emits no totals ladder', () => {
  const run = parseRunRecords(scopedRun(['moneyline']).lines);
  const scored = scoreRun(run, [], TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const model = stats.find((s) => s.participantId === 'model-arm');
  assert.ok(model);
  assert.equal(model.totalsLadder, null); // no total supplied -> no ladder block
  assert.equal(model.byMarket['total'], undefined);
});

test('R1: an unknown market key in the recorded bundle is rejected (coherent artifact)', () => {
  // A hash-coherent v0.3 artifact carrying a recognized moneyline block plus a
  // raw unknown block: the scorer must not silently accept a four-key markets
  // object and report one eligible market.
  const { lines } = scopedRun(['moneyline'], undefined, {
    mysteryMarket: { awayDecimal: 2, homeDecimal: 2 },
  });
  assert.throws(() => parseRunRecords(lines), /Unrecognized key|mysteryMarket/);
});

test('R1: a zero-known-market bundle is rejected with a direct cardinality error', () => {
  const { lines } = scopedRun([]);
  assert.throws(() => parseRunRecords(lines), /at least one known market block/);
});

// ---------------------------------------------------------------------------
// Close timing: the schedule-change stratum and the post-start refusal
// (SPEC-line-open-evidence-model.md §7; acceptance case 32)
// ---------------------------------------------------------------------------

test('closeQuoteFromRow carries the capture timestamps into the metric — it must not narrow them away', () => {
  // This narrowing is the ONE hop that used to drop them: fetch, types,
  // wire validation and record emission all carried them, and the quote
  // handed to the metric did not, which is what made timing unjudgeable.
  const row = closeRow(GAME_A, 'total', {
    lock_time: '2026-07-12T16:15:00+00:00',
    value_captured_at: '2026-07-12T16:14:40+00:00',
    last_polled_at: '2026-07-12T16:20:05+00:00',
    poll_gap_seconds: -305,
  });
  const quote = closeQuoteFromRow(row);
  assert.equal(quote.lockTime, row.lock_time);
  assert.equal(quote.valueCapturedAt, row.value_captured_at);
  assert.equal(quote.lastPolledAt, row.last_polled_at);
  assert.equal(quote.pollGapSeconds, row.poll_gap_seconds);
  // The prices are unchanged by the widening.
  assert.equal(quote.line, row.line);
  assert.equal(quote.awayPNovig, row.away_p_novig);
  assert.equal(quote.confidence, row.confidence);
  // Nulls pass through as nulls, never as fabricated values.
  const sparse = closeQuoteFromRow(
    closeRow(GAME_A, 'moneyline', {
      value_captured_at: null,
      last_polled_at: null,
      poll_gap_seconds: null,
    }),
  );
  assert.equal(sparse.valueCapturedAt, null);
  assert.equal(sparse.lastPolledAt, null);
  assert.equal(sparse.pollGapSeconds, null);
});

test('the schedule-change tolerance is pinned to its literal value', () => {
  // The cohort runner takes this from its hashed manifest; the scoring CLI
  // has no manifest, so the two are kept equal by this pin plus the
  // manifest fixtures. A change here is a scoring-policy change.
  assert.equal(SCHEDULE_CHANGE_TOLERANCE_MS, 60_000);
});

test('scheduleDriftMs is signed and reports undeterminable as null, never as zero', () => {
  const base = '2026-07-12T16:15:00+00:00';
  assert.equal(scheduleDriftMs(base, base), 0);
  // Lock EARLIER than the frozen start = the schedule moved up after freeze.
  assert.equal(scheduleDriftMs('2026-07-12T15:15:00+00:00', base), -3_600_000);
  assert.equal(scheduleDriftMs('2026-07-12T17:15:00+00:00', base), 3_600_000);
  assert.equal(scheduleDriftMs('not-a-time', base), null);
  assert.equal(scheduleDriftMs(base, 'not-a-time'), null);
  assert.equal(scheduleDriftMs('', ''), null);
});

test('acceptance 32: schedule drift below, AT, and above the tolerance classifies deterministically', () => {
  const tol = SCHEDULE_CHANGE_TOLERANCE_MS;
  // Swept over BOTH directions and both sides of the boundary rather than
  // sampled: the classifier is abs() plus a >= comparison, so the whole
  // space is {sign} x {below, at, above} plus the undeterminable case.
  for (const sign of [1, -1]) {
    assert.equal(isScheduleChanged(sign * (tol - 1)), false, `below (${sign})`);
    assert.equal(isScheduleChanged(sign * tol), true, `at (${sign}) — the boundary is INCLUSIVE`);
    assert.equal(isScheduleChanged(sign * (tol + 1)), true, `above (${sign})`);
  }
  assert.equal(isScheduleChanged(0), false);
  // Undeterminable propagates; it is never collapsed into "unchanged".
  assert.equal(isScheduleChanged(null), null);
  // An explicit tolerance is honored (the cohort path supplies its own).
  assert.equal(isScheduleChanged(30_000, 60_000), false);
  assert.equal(isScheduleChanged(30_000, 30_000), true);
  assert.equal(isScheduleChanged(30_000, 0), true, 'a zero tolerance tags every drift');
});

/** A close for GAME_A whose lock is shifted off the frozen bundle start. */
function driftedClose(market: 'moneyline' | 'spread' | 'total', driftMs: number): ClosingLineRow {
  const lockMs = Date.parse(FIXTURE_START_UTC[GAME_A] as string) + driftMs;
  return closeRow(GAME_A, market, {
    lock_time: new Date(lockMs).toISOString(),
    value_captured_at: new Date(lockMs - 20_000).toISOString(),
    last_polled_at: new Date(lockMs - 15_000).toISOString(),
    poll_gap_seconds: 15,
  });
}

test('acceptance 32 end to end: a drifted close is TAGGED and its CLV is still computed', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const tol = SCHEDULE_CHANGE_TOLERANCE_MS;
  for (const [label, driftMs, expected] of [
    ['below', -(tol - 1), false],
    ['at', -tol, true],
    ['above', -(tol + 1), true],
    ['below (later)', tol - 1, false],
    ['at (later)', tol, true],
    ['above (later)', tol + 1, true],
  ] as const) {
    const scored = scoreRun(run, [driftedClose('moneyline', driftMs)], TEST_LADDER);
    const pick = scored.find((p) => p.gameId === GAME_A && p.market === 'moneyline');
    assert.ok(pick, label);
    assert.equal(pick.scheduleDriftMs, driftMs, label);
    assert.equal(pick.scheduleChanged, expected, label);
    // A TAG, NOT A REFUSAL: the CLV is computed either way, and both
    // variants are present together.
    assert.equal(pick.result.unscoredReason, null, label);
    assert.ok(pick.result.primaryClvPct !== null, label);
    assert.ok(pick.result.marginAdjustedClvPct !== null, label);
  }
});

test('a tagged pick leaves the PRIMARY estimate but stays in every denominator', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const sameSchedule = scoreRun(run, [closeRow(GAME_A, 'moneyline')], TEST_LADDER);
  const rescheduled = scoreRun(run, [driftedClose('moneyline', -3_600_000)], TEST_LADDER);

  const baseStats = aggregateByParticipant(sameSchedule, run, TEST_LADDER);
  const tagStats = aggregateByParticipant(rescheduled, run, TEST_LADDER);
  const base = baseStats.find((s) => s.participantId === 'model-arm');
  const tagged = tagStats.find((s) => s.participantId === 'model-arm');
  assert.ok(base && tagged);

  // Premise: the same-schedule run really does score this pick.
  assert.equal(base.primaryScoreable, 1);
  assert.ok(base.gameLevel.meanClvPct !== null);
  assert.equal(base.scheduleChangedExcluded, 0);

  // The tagged run withholds the VALUE...
  assert.equal(tagged.primaryScoreable, 0);
  assert.equal(tagged.marginAdjustedScoreable, 0);
  assert.equal(tagged.gamesScoreable, 0);
  assert.equal(tagged.gameLevel.meanClvPct, null);
  assert.equal(tagged.gameLevelMarginAdjusted.meanClvPct, null);
  assert.equal(tagged.perPick.meanClvPct, null);
  // ...and discloses exactly how many rows that was.
  assert.equal(tagged.scheduleChangedExcluded, 1);
  assert.equal(tagged.byMarket['moneyline']?.scheduleChangedExcluded, 1);
  assert.equal(tagged.byMarket['moneyline']?.scoreable, 0);

  // ...while every DENOMINATOR is untouched: a reschedule shrinks the
  // sample, it never hides the pick.
  assert.equal(tagged.games, base.games);
  assert.equal(tagged.eligibleMarkets, base.eligibleMarkets);
  assert.equal(tagged.validDecisions, base.validDecisions);
  assert.equal(tagged.byMarket['moneyline']?.picks, base.byMarket['moneyline']?.picks);
  assert.equal(tagged.byMarket['moneyline']?.eligible, base.byMarket['moneyline']?.eligible);
  // And it is NOT laundered into the unscored histogram — it was scored.
  assert.deepEqual(tagged.unscoredByReason, base.unscoredByReason);
});

test('the paired de-vig sensitivity readout excludes tagged picks from BOTH sides', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const tagged = aggregateByParticipant(
    scoreRun(run, [driftedClose('moneyline', -3_600_000)], TEST_LADDER),
    run,
    TEST_LADDER,
  ).find((s) => s.participantId === 'model-arm');
  assert.ok(tagged);
  // If the tag were enforced inside clusterByGame only, the disclosed
  // paired COUNT would still include the tagged row while neither summary
  // did — the count would describe a different set than the numbers.
  assert.equal(tagged.sensitivity.pairedPicksEconomic, 0);
  assert.equal(tagged.sensitivity.pairedPicksMarginAdjusted, 0);
  assert.equal(tagged.sensitivity.economic.proportional.meanClvPct, null);
  assert.equal(tagged.sensitivity.economic.shin.meanClvPct, null);

  // NEGATIVE CONTROL: the same run without the drift keeps the pairing.
  const clean = aggregateByParticipant(
    scoreRun(run, [closeRow(GAME_A, 'moneyline')], TEST_LADDER),
    run,
    TEST_LADDER,
  ).find((s) => s.participantId === 'model-arm');
  assert.ok(clean);
  assert.equal(clean.sensitivity.pairedPicksEconomic, 1);
  assert.ok(clean.sensitivity.economic.shin.meanClvPct !== null);
});

test('a tagged totals pick leaves the ladder aggregates AND the mean signed movement', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const clean = aggregateByParticipant(
    scoreRun(run, [closeRow(GAME_A, 'total', { line: 9.5 })], TEST_LADDER),
    run,
    TEST_LADDER,
  ).find((s) => s.participantId === 'model-arm');
  assert.ok(clean?.totalsLadder);
  // Premise: a moved line is ladder-scored and contributes movement.
  assert.equal(clean.totalsLadder.ladderScoreable, 1);
  assert.ok(clean.totalsLadder.meanSignedMovement !== null);

  const tagged = aggregateByParticipant(
    scoreRun(run, [{ ...driftedClose('total', -3_600_000), line: 9.5 }], TEST_LADDER),
    run,
    TEST_LADDER,
  ).find((s) => s.participantId === 'model-arm');
  assert.ok(tagged?.totalsLadder);
  assert.equal(tagged.totalsLadder.ladderScoreable, 0);
  // Movement is documented as an average over the LADDER-SCORED picks, so
  // it has to leave with them or the two numbers describe different sets.
  assert.equal(tagged.totalsLadder.meanSignedMovement, null);
  // Totals picks themselves stay in the denominator.
  assert.equal(tagged.totalsLadder.totalsPicks, clean.totalsLadder.totalsPicks);
});

test('a post-start close is refused end to end, and the ladder honors the same verdict', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, [closeRow(GAME_A, 'total', { poll_gap_seconds: -292 })], TEST_LADDER);
  const pick = scored.find((p) => p.participantId === 'model-arm' && p.market === 'total');
  assert.ok(pick);
  assert.equal(pick.result.unscoredReason, 'close_after_start');
  assert.equal(pick.result.primaryClvPct, null);
  assert.equal(pick.result.marginAdjustedClvPct, null);
  assert.equal(pick.ladder?.unscoredReason, 'close_after_start');
  assert.equal(pick.ladder?.economicClvPct, null);
  // It is an UNSCORED reason, not a stratum tag — the two mechanisms are
  // reported through different channels and must not be confused.
  assert.equal(pick.scheduleChanged, false);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const model = stats.find((s) => s.participantId === 'model-arm');
  assert.ok(model);
  assert.equal(model.unscoredByReason['close_after_start'], 1);
  assert.equal(model.scheduleChangedExcluded, 0);

  // NEGATIVE CONTROL: the same close with a healthy gap scores.
  const okScored = scoreRun(run, [closeRow(GAME_A, 'total')], TEST_LADDER);
  const okPick = okScored.find((p) => p.participantId === 'model-arm' && p.market === 'total');
  assert.ok(okPick);
  assert.equal(okPick.result.unscoredReason, null);
  assert.ok(okPick.ladder?.economicClvPct !== null);
});

test('a pick with no close has an undeterminable schedule verdict and STAYS in the primary stratum', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, [], TEST_LADDER);
  assert.ok(scored.length > 0);
  for (const pick of scored) {
    assert.equal(pick.close, null);
    assert.equal(pick.scheduleChanged, null, 'no close -> no comparison');
    assert.equal(pick.scheduleDriftMs, null);
    assert.equal(inPrimaryStratum(pick), true, 'null is not an exclusion');
    assert.equal(pick.result.unscoredReason, 'close_missing');
  }
});

test('scored records carry the capture timestamps, the drift, and the stratum verdict', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const drifted = driftedClose('moneyline', -3_600_000);
  const scored = scoreRun(run, [drifted], TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const records = scoredRecords(run, scored, stats, '2026-07-12T21:00:00.000Z', TEST_LADDER);

  const decision = records.find(
    (r) =>
      r['recordType'] === 'scored_decision' &&
      r['participantId'] === 'model-arm' &&
      r['market'] === 'moneyline' &&
      r['gameId'] === GAME_A,
  );
  assert.ok(decision);
  const closing = decision['closing'] as Record<string, unknown>;
  // All four capture timestamps survive onto the record — the narrowing
  // into the metric used to drop them, which is what made timing unjudgeable.
  assert.equal(closing['lockTime'], drifted.lock_time);
  assert.equal(closing['valueCapturedAt'], drifted.value_captured_at);
  assert.equal(closing['lastPolledAt'], drifted.last_polled_at);
  assert.equal(closing['pollGapSeconds'], drifted.poll_gap_seconds);
  assert.equal(decision['scheduledStartUtc'], FIXTURE_START_UTC[GAME_A]);
  assert.equal(decision['scheduleDriftMs'], -3_600_000);
  assert.equal(decision['scheduleChanged'], true);
  assert.equal(decision['inPrimaryStratum'], false);
  // The CLV itself is still on the record — tagged, not discarded.
  assert.ok(decision['primaryClvPct'] !== null);
  assert.ok(decision['marginAdjustedClvPct'] !== null);

  const meta = records.find((r) => r['recordType'] === 'scored_run_meta');
  assert.ok(meta);
  // Every participant with a moneyline pick on this game joins the SAME
  // close row, so the count is derived from the picks rather than guessed.
  const taggedPicks = scored.filter((p) => p.scheduleChanged === true).length;
  assert.ok(taggedPicks > 1, 'fixture premise: several participants share the drifted close');
  assert.equal(meta['scheduleChangedExcluded'], taggedPicks);
  assert.equal(meta['primaryScoreable'], 0, 'meta agrees with the participant aggregates');
  assert.equal(meta['marginAdjustedScoreable'], 0);
  assert.equal(meta['closeAfterStartRefused'], 0);
  const policy = meta['closePolicy'] as Record<string, unknown>;
  // The tolerance the tag was actually computed at is the one preregistered
  // on the record — not a second, independently-typed number.
  assert.equal(policy['scheduleChangeToleranceMs'], SCHEDULE_CHANGE_TOLERANCE_MS);
  assert.equal(
    isScheduleChanged(decision['scheduleDriftMs'] as number, policy['scheduleChangeToleranceMs'] as number),
    decision['scheduleChanged'],
    'the published tolerance reproduces the published verdict',
  );
  assert.ok(String(policy['scheduleChanged']).includes('STRATUM TAG'));
  // The limitation is preregistered in the machine-readable policy, not only
  // in prose a reader might skip.
  assert.ok(
    String(policy['startTimeLimitation']).includes('EARLIER'),
    'the undetectable case is stated in the scored output itself',
  );
});

test('run_meta counts the post-start refusals it actually emitted', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored = scoreRun(
    run,
    [closeRow(GAME_A, 'moneyline', { poll_gap_seconds: -292 })],
    TEST_LADDER,
  );
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const meta = scoredRecords(run, scored, stats, '2026-07-12T21:00:00.000Z', TEST_LADDER).find(
    (r) => r['recordType'] === 'scored_run_meta',
  );
  assert.ok(meta);
  const expected = scored.filter((p) => p.result.unscoredReason === 'close_after_start').length;
  assert.ok(expected > 0, 'fixture premise');
  assert.equal(meta['closeAfterStartRefused'], expected);
  assert.equal(meta['scheduleChangedExcluded'], 0);
});

test('the scorecard states both close-timing rules and discloses the held-out count', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, [driftedClose('moneyline', -3_600_000)], TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const markdown = buildScorecardMarkdown(
    run,
    scored,
    stats,
    '2026-07-12T21:00:00.000Z',
    TEST_LADDER,
  );
  assert.ok(markdown.includes('close_after_start'), 'the refusal is named');
  assert.ok(markdown.includes('scheduleChanged'), 'the tag is named');
  assert.ok(markdown.includes('Schedule-changed (held out)'), 'the coverage column exists');
  assert.ok(
    markdown.includes(String(SCHEDULE_CHANGE_TOLERANCE_MS)),
    'the tolerance is a published number, not an unstated constant',
  );
  // The undetectable case is in the published prose, not only the PR body.
  assert.ok(markdown.includes('EARLIER'));
  assert.ok(markdown.includes('not evidence that the game had not started'));
  // Header and divider still line up after the added column.
  const allLines = markdown.split('\n');
  const headerIndex = allLines.findIndex((l) => l.startsWith('| Participant | Games |'));
  assert.ok(headerIndex >= 0);
  const header = allLines[headerIndex] as string;
  const divider = allLines[headerIndex + 1] as string;
  assert.equal(
    (header.match(/\|/g) ?? []).length,
    (divider.match(/\|/g) ?? []).length,
    'coverage table header and divider have the same column count',
  );
});

// ---------------------------------------------------------------------------
// Coverage accounting and the rendered artifact — the numbers a reader sums
// ---------------------------------------------------------------------------

/**
 * Every markdown table in a rendered scorecard: the header line, its
 * divider, and every data row until the table ends. Asserting on the ARTIFACT
 * rather than on the row-building functions is the point — a column added to
 * one header and not to its rows renders a table every markdown viewer
 * mis-aligns, and no per-function test sees it.
 */
function markdownTables(
  markdown: string,
): Array<{ header: string; divider: string; rows: string[] }> {
  const lines = markdown.split('\n');
  const tables: Array<{ header: string; divider: string; rows: string[] }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i] ?? '';
    const divider = lines[i + 1] ?? '';
    if (!header.startsWith('|') || !/^\|(?:-+\|)+$/.test(divider)) continue;
    const rows: string[] = [];
    let j = i + 2;
    while ((lines[j] ?? '').startsWith('|')) {
      rows.push(lines[j] as string);
      j += 1;
    }
    tables.push({ header, divider, rows });
    i = j - 1;
  }
  return tables;
}

const pipes = (line: string): number => (line.match(/\|/g) ?? []).length;

/** A drifted close whose confidence/gap/line can be pushed off the happy path. */
function driftedRow(
  market: 'moneyline' | 'spread' | 'total',
  driftMs: number,
  overrides: Partial<ClosingLineRow> = {},
): ClosingLineRow {
  const merged = { ...driftedClose(market, driftMs), ...overrides };
  // Keep the row COHERENT: `last_polled_at` must follow the (possibly drifted)
  // lock and the (possibly overridden) gap. Spreading alone would leave it
  // describing the PRE-drift lock, and the scorer now refuses a row whose
  // stored gap contradicts its own instants — so a case meaning "post-start"
  // would land on `close_timing_unusable` instead.
  if ('last_polled_at' in overrides) return merged;
  const lockMs = Date.parse(merged.lock_time);
  return {
    ...merged,
    last_polled_at:
      merged.poll_gap_seconds === null || !Number.isFinite(lockMs)
        ? null
        : new Date(lockMs - merged.poll_gap_seconds * 1000).toISOString(),
  };
}

/**
 * Close sets that between them exercise every coverage bucket: nothing
 * captured, healthy, tagged-and-scored, tagged-but-already-refused (both
 * refusal families), tagged-and-line-moved, tagged-at-an-integer-line.
 */
function coverageScenarios(): Array<{ label: string; closes: ClosingLineRow[] }> {
  const tol = SCHEDULE_CHANGE_TOLERANCE_MS;
  return [
    { label: 'no closes at all', closes: [] },
    {
      label: 'healthy same-schedule closes',
      closes: [closeRow(GAME_A, 'moneyline'), closeRow(GAME_A, 'total')],
    },
    { label: 'tagged and scoreable', closes: [driftedRow('moneyline', -3_600_000)] },
    { label: 'tagged AT the tolerance', closes: [driftedRow('moneyline', -tol)] },
    {
      label: 'tagged but already stale',
      closes: [driftedRow('moneyline', -3_600_000, { confidence: 'stale' })],
    },
    {
      label: 'tagged but already post-start',
      closes: [driftedRow('moneyline', -3_600_000, { poll_gap_seconds: -292 })],
    },
    { label: 'tagged and line-moved', closes: [driftedRow('total', -3_600_000, { line: 9.5 })] },
    { label: 'tagged at an integer line', closes: [driftedRow('total', -3_600_000, { line: 9 })] },
    {
      label: 'mixed: one tagged-scored, one tagged-stale, one healthy',
      closes: [
        driftedRow('moneyline', -3_600_000),
        driftedRow('total', -3_600_000, { confidence: 'stale' }),
        closeRow(GAME_B, 'moneyline'),
      ],
    },
  ];
}

test('coverage arithmetic holds in every bucket: valid = primary-scoreable + held out + unscored', () => {
  // The published contract, swept rather than sampled. It is exactly what a
  // held-out count taken as "every tagged pick" breaks: a tagged pick some
  // earlier gate had already refused would be counted twice (once under its
  // reason, once as held out) and the columns would sum past the denominator.
  const { lines } = fixtureRun({
    secondModelArm: true,
    extraArm: { participantId: 'timeout-arm', outcome: 'timeout' },
  });
  const run = parseRunRecords(lines);
  let sawHeldOut = 0;
  let sawTaggedButRefused = 0;
  for (const { label, closes } of coverageScenarios()) {
    const scored = scoreRun(run, closes, TEST_LADDER);
    const stats = aggregateByParticipant(scored, run, TEST_LADDER);
    for (const stat of stats) {
      const unscored = Object.values(stat.unscoredByReason).reduce((a, b) => a + b, 0);
      assert.equal(
        stat.primaryScoreable + stat.scheduleChangedExcluded + unscored,
        stat.validDecisions,
        `${label} / ${stat.participantId}: participant coverage must sum to validDecisions`,
      );
      assert.ok(
        stat.scheduleChangedExcluded <= stat.scheduleChangedTagged,
        `${label} / ${stat.participantId}: held out cannot exceed tagged`,
      );
      sawHeldOut += stat.scheduleChangedExcluded;
      sawTaggedButRefused += stat.scheduleChangedTagged - stat.scheduleChangedExcluded;
      for (const [market, marketStat] of Object.entries(stat.byMarket)) {
        const marketUnscored = Object.values(marketStat.unscoredByReason).reduce((a, b) => a + b, 0);
        assert.equal(
          marketStat.scoreable + marketStat.scheduleChangedExcluded + marketUnscored,
          marketStat.picks,
          `${label} / ${stat.participantId} / ${market}: per-market coverage must sum to picks`,
        );
      }
    }
  }
  // The sweep is not vacuous: it really did produce both a held-out row and
  // a tagged-but-already-refused row, which are the two sides of the fix.
  assert.ok(sawHeldOut > 0, 'the sweep exercised the held-out case');
  assert.ok(sawTaggedButRefused > 0, 'the sweep exercised the tagged-but-already-refused case');
});

test('a tagged pick an earlier gate already refused is disclosed ONCE, under that gate', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  for (const [label, overrides, reason] of [
    ['stale', { confidence: 'stale' as const }, 'close_stale'],
    ['post-start', { poll_gap_seconds: -292 }, 'close_after_start'],
  ] as const) {
    const scored = scoreRun(run, [driftedRow('moneyline', -3_600_000, overrides)], TEST_LADDER);
    const stat = aggregateByParticipant(scored, run, TEST_LADDER).find(
      (s) => s.participantId === 'model-arm',
    );
    assert.ok(stat, label);
    assert.equal(stat.unscoredByReason[reason], 1, `${label}: disclosed under its own reason`);
    // TAGGED (the schedule really did move) but nothing was withheld: there
    // was no value to withhold, so it is not a coverage line item.
    assert.equal(stat.scheduleChangedTagged, 1, label);
    assert.equal(stat.scheduleChangedExcluded, 0, label);
    assert.equal(stat.byMarket['moneyline']?.scheduleChangedExcluded, 0, label);
    // ...and the sensitivity stratum has nothing to publish for it either.
    assert.equal(stat.scheduleChangedStratum.picks, 1, label);
    assert.equal(stat.scheduleChangedStratum.scoreable, 0, label);
    assert.equal(stat.scheduleChangedStratum.gameLevel.meanClvPct, null, label);
  }

  // NEGATIVE CONTROL: the same drift on a HEALTHY close does count as held
  // out — so the zeroes above are about the earlier refusal, not about the
  // counter having stopped working.
  const healthy = aggregateByParticipant(
    scoreRun(run, [driftedRow('moneyline', -3_600_000)], TEST_LADDER),
    run,
    TEST_LADDER,
  ).find((s) => s.participantId === 'model-arm');
  assert.ok(healthy);
  assert.equal(healthy.scheduleChangedTagged, 1);
  assert.equal(healthy.scheduleChangedExcluded, 1);
});

test('every rendered table has data rows with its header column count', () => {
  // The artifact-level check. A column added to a header without its row
  // builder (or removed from a row builder without its header) shifts every
  // later cell one column left in any markdown renderer — including the
  // held-out count the whole disclosure argument rests on.
  const { lines } = fixtureRun({
    secondModelArm: true,
    extraArm: { participantId: 'timeout-arm', outcome: 'timeout' },
  });
  const run = parseRunRecords(lines);
  let tablesChecked = 0;
  let rowsChecked = 0;
  for (const { label, closes } of coverageScenarios()) {
    const scored = scoreRun(run, closes, TEST_LADDER);
    const stats = aggregateByParticipant(scored, run, TEST_LADDER);
    const markdown = buildScorecardMarkdown(
      run,
      scored,
      stats,
      '2026-07-12T21:00:00.000Z',
      TEST_LADDER,
    );
    const tables = markdownTables(markdown);
    assert.ok(tables.length >= 4, `${label}: the scorecard renders its tables`);
    for (const table of tables) {
      tablesChecked += 1;
      assert.equal(pipes(table.divider), pipes(table.header), `${label}: divider width`);
      assert.ok(
        table.rows.length > 0,
        `${label}: table "${table.header.slice(0, 40)}" has data rows`,
      );
      for (const row of table.rows) {
        rowsChecked += 1;
        assert.equal(
          pipes(row),
          pipes(table.header),
          `${label}: data row column count\nheader: ${table.header}\nrow:    ${row}`,
        );
      }
    }
  }
  assert.ok(tablesChecked > 30 && rowsChecked > 100, 'the sweep really rendered tables and rows');
});

test('the coverage table names the held-out column and shows both counts when they differ', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  // model-arm gets TWO tagged picks: one scoreable (held out) and one the
  // freshness gate had already refused (tagged, nothing withheld).
  const scored = scoreRun(
    run,
    [driftedRow('moneyline', -3_600_000), driftedRow('total', -3_600_000, { confidence: 'stale' })],
    TEST_LADDER,
  );
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const model = stats.find((s) => s.participantId === 'model-arm');
  assert.ok(model);
  assert.equal(model.scheduleChangedTagged, 2, 'fixture premise');
  assert.equal(model.scheduleChangedExcluded, 1, 'fixture premise');
  const markdown = buildScorecardMarkdown(
    run,
    scored,
    stats,
    '2026-07-12T21:00:00.000Z',
    TEST_LADDER,
  );
  assert.ok(
    markdown.includes('| 1 (of 2 tagged) |'),
    'the cell distinguishes what was withheld from what was tagged',
  );
  // The prose above the table says exactly this, and is published — not a
  // code comment a reader never sees.
  assert.ok(markdown.includes('A schedule-changed pick is never dropped'));
  assert.ok(markdown.includes('counts the tagged picks that CARRIED a value'));
  assert.ok(markdown.includes('disclosed under their own reason'));
  // Per-market disclosure too — the README claims per participant AND per
  // market, so the per-market table has to carry the column.
  const byMarketAt = markdown.indexOf('## By market');
  assert.ok(byMarketAt > 0);
  const marketHeaderAt = markdown.indexOf(
    '| Participant | Picks | Scoreable/eligible |',
    byMarketAt,
  );
  assert.ok(marketHeaderAt > byMarketAt);
  assert.ok(
    (markdown.slice(marketHeaderAt).split('\n')[0] ?? '').includes('Schedule-changed (held out)'),
    'the per-market table discloses the held-out count',
  );

  // NEGATIVE CONTROL: with a single tagged-and-scoreable pick the cell is a
  // bare number — the parenthetical appears only when the counts differ.
  const single = scoreRun(run, [driftedRow('moneyline', -3_600_000)], TEST_LADDER);
  const singleMd = buildScorecardMarkdown(
    run,
    single,
    aggregateByParticipant(single, run, TEST_LADDER),
    '2026-07-12T21:00:00.000Z',
    TEST_LADDER,
  );
  assert.ok(!singleMd.includes('tagged)'), 'no parenthetical when tagged === held out');
});

test('the reschedule-sensitivity stratum republishes exactly the values the tag withheld', () => {
  // SPEC-line-open-evidence-model.md §7 asks for both halves: exclude from
  // the primary same-schedule estimate AND show in a separate stratum. The
  // exclusion without the readout would leave the withheld numbers visible
  // only inside per-pick NDJSON.
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const clean = aggregateByParticipant(
    scoreRun(run, [closeRow(GAME_A, 'moneyline')], TEST_LADDER),
    run,
    TEST_LADDER,
  ).find((s) => s.participantId === 'model-arm');
  const tagged = scoreRun(run, [driftedRow('moneyline', -3_600_000)], TEST_LADDER);
  const taggedStats = aggregateByParticipant(tagged, run, TEST_LADDER);
  const model = taggedStats.find((s) => s.participantId === 'model-arm');
  assert.ok(clean && model);
  assert.ok(clean.gameLevel.meanClvPct !== null, 'fixture premise: the clean run scores it');

  // Primary is empty...
  assert.equal(model.primaryScoreable, 0);
  assert.equal(model.gameLevel.meanClvPct, null);
  // ...and the stratum carries the identical number the primary would have.
  assert.equal(model.scheduleChangedStratum.picks, 1);
  assert.equal(model.scheduleChangedStratum.scoreable, 1);
  assert.equal(model.scheduleChangedStratum.gamesScoreable, 1);
  assert.equal(model.scheduleChangedStratum.gameLevel.meanClvPct, clean.gameLevel.meanClvPct);
  assert.equal(model.scheduleChangedStratum.perPick.meanClvPct, clean.perPick.meanClvPct);
  assert.equal(
    model.scheduleChangedStratum.gameLevelMarginAdjusted.meanClvPct,
    clean.gameLevelMarginAdjusted.meanClvPct,
  );

  const markdown = buildScorecardMarkdown(
    run,
    tagged,
    taggedStats,
    '2026-07-12T21:00:00.000Z',
    TEST_LADDER,
  );
  assert.ok(markdown.includes('## Reschedule-sensitivity stratum'), 'the stratum table is rendered');
  assert.ok(markdown.includes('| Participant | Tagged picks | Scoreable | Games scoreable |'));
  assert.ok(
    markdown.includes(`| model-arm | 1 | 1 | 1 | ${clean.gameLevel.meanClvPct} |`),
    'the withheld value is printed, not merely counted',
  );

  // NEGATIVE CONTROL: a same-schedule run renders NO stratum table — the
  // section is evidence that something was held out, never boilerplate.
  const cleanScored = scoreRun(run, [closeRow(GAME_A, 'moneyline')], TEST_LADDER);
  const cleanMd = buildScorecardMarkdown(
    run,
    cleanScored,
    aggregateByParticipant(cleanScored, run, TEST_LADDER),
    '2026-07-12T21:00:00.000Z',
    TEST_LADDER,
  );
  assert.ok(!cleanMd.includes('## Reschedule-sensitivity stratum'));
});

test('the ladder table discloses its OWN held-out count', () => {
  // A tagged totals pick leaves ladderScoreable via clusterByGame but carries
  // no ladder.unscoredReason, so without this column the ladder table shows a
  // shortfall with no explanation anywhere in the row.
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored = scoreRun(run, [driftedRow('total', -3_600_000, { line: 9.5 })], TEST_LADDER);
  const stats = aggregateByParticipant(scored, run, TEST_LADDER);
  const model = stats.find((s) => s.participantId === 'model-arm');
  assert.ok(model?.totalsLadder);
  assert.equal(model.totalsLadder.ladderScoreable, 0);
  assert.equal(model.totalsLadder.scheduleChangedExcluded, 1);
  const markdown = buildScorecardMarkdown(
    run,
    scored,
    stats,
    '2026-07-12T21:00:00.000Z',
    TEST_LADDER,
  );
  const ladderAt = markdown.indexOf('## Totals ladder');
  assert.ok(ladderAt > 0);
  const ladderHeader = markdown
    .slice(ladderAt)
    .split('\n')
    .find((l) => l.startsWith('| Participant |'));
  assert.ok(ladderHeader?.includes('Schedule-changed (held out)'), 'ladder table discloses it');

  // NEGATIVE CONTROL: the same close without the drift is ladder-scored and
  // the held-out count is zero.
  const cleanStats = aggregateByParticipant(
    scoreRun(run, [closeRow(GAME_A, 'total', { line: 9.5 })], TEST_LADDER),
    run,
    TEST_LADDER,
  ).find((s) => s.participantId === 'model-arm');
  assert.ok(cleanStats?.totalsLadder);
  assert.equal(cleanStats.totalsLadder.ladderScoreable, 1);
  assert.equal(cleanStats.totalsLadder.scheduleChangedExcluded, 0);
});

test('run_meta ladder and schedule counters agree with the participant aggregates', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const cases: Array<{
    label: string;
    closes: ClosingLineRow[];
    expectLadder: 'zero' | 'positive';
  }> = [
    {
      label: 'same-schedule totals',
      closes: [closeRow(GAME_A, 'total', { line: 9.5 })],
      expectLadder: 'positive',
    },
    {
      label: 'tagged totals',
      closes: [driftedRow('total', -3_600_000, { line: 9.5 })],
      expectLadder: 'zero',
    },
  ];
  for (const { label, closes, expectLadder } of cases) {
    const scored = scoreRun(run, closes, TEST_LADDER);
    const stats = aggregateByParticipant(scored, run, TEST_LADDER);
    const meta = scoredRecords(run, scored, stats, '2026-07-12T21:00:00.000Z', TEST_LADDER).find(
      (r) => r['recordType'] === 'scored_run_meta',
    );
    assert.ok(meta, label);
    const ladderSum = stats.reduce((sum, s) => sum + (s.totalsLadder?.ladderScoreable ?? 0), 0);
    assert.equal(meta['totalsLadderScoreable'], ladderSum, `${label}: meta ladder count`);
    if (expectLadder === 'positive') {
      assert.ok(ladderSum > 0, `${label}: fixture premise — something was ladder-scored`);
    } else {
      assert.equal(ladderSum, 0, `${label}: fixture premise — the tag withheld it`);
    }
    assert.equal(
      meta['primaryScoreable'],
      stats.reduce((sum, s) => sum + s.primaryScoreable, 0),
      `${label}: meta primary count`,
    );
    assert.equal(
      meta['scheduleChangedExcluded'],
      stats.reduce((sum, s) => sum + s.scheduleChangedExcluded, 0),
      `${label}: meta held-out count`,
    );
    assert.equal(
      meta['scheduleChangedTagged'],
      stats.reduce((sum, s) => sum + s.scheduleChangedTagged, 0),
      `${label}: meta tagged count`,
    );
  }
});

test('run_meta scheduleUndetermined counts the picks with no determinable comparison', () => {
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  // No closes at all: every pick's schedule verdict is undeterminable, and
  // that is DISTINCT from "unchanged" — the counter exists to keep the two
  // apart in the published meta.
  const none = scoreRun(run, [], TEST_LADDER);
  const noneMeta = scoredRecords(
    run,
    none,
    aggregateByParticipant(none, run, TEST_LADDER),
    '2026-07-12T21:00:00.000Z',
    TEST_LADDER,
  ).find((r) => r['recordType'] === 'scored_run_meta');
  assert.ok(noneMeta);
  assert.ok(none.length > 0, 'fixture premise');
  assert.equal(noneMeta['scheduleUndetermined'], none.length, 'every pick is undetermined');
  assert.equal(noneMeta['scheduleChangedTagged'], 0);

  // A run where SOME picks have a close: the counter must drop by exactly
  // the picks that got one, not to zero and not stay at the total.
  const some = scoreRun(run, [closeRow(GAME_A, 'moneyline')], TEST_LADDER);
  const someMeta = scoredRecords(
    run,
    some,
    aggregateByParticipant(some, run, TEST_LADDER),
    '2026-07-12T21:00:00.000Z',
    TEST_LADDER,
  ).find((r) => r['recordType'] === 'scored_run_meta');
  assert.ok(someMeta);
  const withClose = some.filter((p) => p.close !== null).length;
  assert.ok(withClose > 0 && withClose < some.length, 'fixture premise: a partial join');
  assert.equal(someMeta['scheduleUndetermined'], some.length - withClose);
});

test('every close-quality reason a run actually emits is preregistered in closePolicy', () => {
  // Cross-artifact, not a source string compared with itself: the reasons
  // come from the scored picks, the text from the published policy block.
  const { lines } = fixtureRun();
  const run = parseRunRecords(lines);
  const scored = scoreRun(
    run,
    [
      closeRow(GAME_A, 'moneyline', { poll_gap_seconds: -292 }),
      closeRow(GAME_A, 'total', { confidence: 'stale' }),
    ],
    TEST_LADDER,
  );
  const meta = scoredRecords(
    run,
    scored,
    aggregateByParticipant(scored, run, TEST_LADDER),
    '2026-07-12T21:00:00.000Z',
    TEST_LADDER,
  ).find((r) => r['recordType'] === 'scored_run_meta');
  assert.ok(meta);
  const policyText = JSON.stringify(meta['closePolicy']);
  const emitted = new Set(
    scored
      .map((p) => p.result.unscoredReason)
      .filter((r): r is (typeof CLOSE_QUALITY_REASONS)[number] =>
        (CLOSE_QUALITY_REASONS as readonly (string | null)[]).includes(r),
      ),
  );
  assert.ok(emitted.has('close_after_start'), 'fixture premise');
  assert.ok(emitted.has('close_stale'), 'fixture premise');
  assert.ok(emitted.has('close_missing'), 'fixture premise');
  // Stronger than "the reasons this run happened to emit": EVERY reason the
  // scorer can emit must be declared, so a code a reader meets in the records
  // is never one the preregistered policy failed to mention.
  for (const reason of CLOSE_QUALITY_REASONS) {
    assert.ok(policyText.includes(reason), `closePolicy preregisters ${reason}`);
  }
  for (const reason of emitted) {
    assert.ok(policyText.includes(reason), `closePolicy names the emitted reason ${reason}`);
  }
  assert.ok(
    policyText.includes('CONSERVATIVE refusal'),
    'the post-start gate publishes that its evidence is ambiguous, not conclusive',
  );
});

test('scheduleDriftMs REFUSES an offset-less instant instead of reading it as host-local time', () => {
  // The original defect: bare `Date.parse` reads an offset-less ISO string as
  // LOCAL time, so this exact pair produced 0 on a UTC host and 14400000 on a
  // US-Eastern one — and `isScheduleChanged` flipped false -> true with it. A
  // verdict that depends on the scoring machine's timezone is not a
  // measurement. Refusing the input is what makes it one.
  assert.equal(scheduleDriftMs('2026-07-30T19:00:00', '2026-07-30T19:00:00Z'), null);
  assert.equal(scheduleDriftMs('2026-07-30T19:00:00Z', '2026-07-30T19:00:00'), null);
  assert.equal(isScheduleChanged(scheduleDriftMs('2026-07-30T19:00:00', '2026-07-30T19:00:00Z')), null);

  // NEGATIVE CONTROLS: offset-qualified pairs still compute, signed, and an
  // explicit non-UTC offset is honoured rather than ignored.
  assert.equal(scheduleDriftMs('2026-07-30T19:00:00Z', '2026-07-30T19:00:00Z'), 0);
  assert.equal(scheduleDriftMs('2026-07-30T18:00:00Z', '2026-07-30T19:00:00Z'), -3_600_000);
  assert.equal(scheduleDriftMs('2026-07-30T19:00:00-04:00', '2026-07-30T23:00:00Z'), 0);
});

test('closesByKey REFUSES a duplicate rather than silently keeping the last row seen', () => {
  // `new Map(rows.map(...))` kept whichever row arrived last, so two rows
  // differing only by network or feed collapsed into one and the scorer priced
  // against an arbitrary winner with nothing published to say a choice was made.
  const a = closeRow(GAME_A, 'total');
  assert.throws(
    () => closesByKey([a, { ...a, source: 'rundown' }]),
    /refusing to score against an ambiguous close/,
  );
  // NEGATIVE CONTROL: distinct (game, market) pairs still index.
  assert.equal(closesByKey([a, closeRow(GAME_A, 'moneyline')]).size, 2);
});

test('a bundle start with no explicit offset REJECTS the run at parse', () => {
  // The reference the schedule-drift comparison is taken against. An
  // offset-less value would be read as host-local by a bare `Date.parse`, and
  // refusing it only downstream would leave the pick inside the primary
  // stratum carrying `scheduleChanged === null` — fail-closed parsing followed
  // by fail-open aggregation. It is refused where it enters instead.
  const { lines } = fixtureRun();
  // Target the JSON key, not the bare value: `cutoffAt` carries the same
  // instant and appears first, so a value-only replace would edit that and
  // leave the bundle field untouched — the test would then pass for no reason.
  const broken = lines.map((line) =>
    line.replace(
      `"scheduledStartUtc":"${FIXTURE_START_UTC[GAME_A] as string}"`,
      '"scheduledStartUtc":"2026-07-12T16:15:00"',
    ),
  );
  assert.notDeepEqual(broken, lines, 'fixture premise: the bundle start appears in the run file');
  assert.throws(() => parseRunRecords(broken), /scheduledStartUtc|offset/i);
  // NEGATIVE CONTROL: the untouched fixture still parses.
  assert.doesNotThrow(() => parseRunRecords(lines));
});

test('a SCORED pick whose schedule comparison is undeterminable cannot enter the primary stratum', () => {
  // `null` still means "no determinable comparison". For a pick with no close
  // that is the honest status quo and it stays in — it contributes no value to
  // the estimate either way. But a pick that produced a CLV while its schedule
  // verdict is unknown would join the same-schedule estimate on a comparison
  // nobody established.
  assert.equal(
    inPrimaryStratum(syntheticScored(GAME_A, 4.2, { scheduleChanged: null, scheduleDriftMs: null })),
    false,
    'scored + undeterminable is held out',
  );
  assert.equal(
    inPrimaryStratum(syntheticScored(GAME_A, null, { scheduleChanged: null, scheduleDriftMs: null })),
    true,
    'UNSCORED + undeterminable stays in — it withholds nothing',
  );
  // NEGATIVE CONTROLS: the ordinary strata are unchanged.
  assert.equal(inPrimaryStratum(syntheticScored(GAME_A, 4.2, { scheduleChanged: false })), true);
  assert.equal(inPrimaryStratum(syntheticScored(GAME_A, 4.2, { scheduleChanged: true })), false);
});

test('primary-scoreable requires BOTH conjuncts, so a fully schedule-tagged run counts zero', () => {
  // The exact shape from the defect report: every scored pick is
  // schedule-tagged, so it is held out of the primary same-schedule estimate
  // while still carrying a CLV value.
  const allTagged = [
    syntheticScored(GAME_A, 4.2, { scheduleChanged: true }),
    syntheticScored(GAME_B, -1.5, { scheduleChanged: true }),
  ];

  // THE FIXTURE PREMISE, asserted rather than assumed: the LOOSE predicate —
  // "carries a value", which is what the scorer CLI used to count — is
  // non-zero here. Without this the test below would pass against a corpus
  // that is empty for an unrelated reason, and the bug it pins would be
  // invisible.
  assert.equal(
    allTagged.filter((p) => p.result.primaryClvPct !== null).length,
    2,
    'fixture premise: the loose predicate counts these, which is why the two readouts disagreed',
  );

  assert.equal(primaryScoreableCount(allTagged), 0, 'in-stratum AND valued — neither pick is in-stratum');
  assert.equal(heldOutOfPrimary(allTagged), 2, 'both were scored and both were removed by the tag');

  // NEGATIVE CONTROLS — the count must not be trivially zero.
  assert.equal(
    primaryScoreableCount([syntheticScored(GAME_A, 4.2, { scheduleChanged: false })]),
    1,
    'an untagged, valued pick IS primary-scoreable',
  );
  // Untagged but unscored: in the stratum, no value. Counting it would make
  // `scoreable N/M` claim coverage the estimate never received.
  assert.equal(
    primaryScoreableCount([syntheticScored(GAME_A, null, { scheduleChanged: false })]),
    0,
    'an untagged pick with no close is not scoreable either',
  );
  assert.equal(
    heldOutOfPrimary([syntheticScored(GAME_A, null, { scheduleChanged: true })]),
    0,
    'a tagged pick that carried NO value had nothing to withhold',
  );

  // The mixed case is what the CLI note branches on: some scoreable, so the
  // note does not fire at all.
  const mixed = [...allTagged, syntheticScored(GAME_A, 0.5, { scheduleChanged: false })];
  assert.equal(primaryScoreableCount(mixed), 1);
  assert.equal(heldOutOfPrimary(mixed), 2);
});

test('the empty-primary-estimate note names WHICH cause, and stays silent when there is none', () => {
  const allTagged = [
    syntheticScored(GAME_A, 4.2, { scheduleChanged: true }),
    syntheticScored(GAME_B, -1.5, { scheduleChanged: true }),
  ];

  // Schedule-tagged: the picks WERE scored, so telling the operator to re-run
  // after the slate locks would be actively wrong. This is the branch that did
  // not exist before — the note simply never fired on this input.
  const tagged = emptyPrimaryEstimateNote(allTagged);
  assert.ok(tagged !== null, 'a fully-tagged run must produce a note');
  assert.match(tagged, /0 of 2 pick\(s\)/);
  assert.match(tagged, /2 scored but HELD OUT/);
  assert.match(tagged, /Re-running will NOT change those/);
  assert.doesNotMatch(
    tagged,
    /not scored at all/,
    'with nothing refused, the note must not invent a refusal bullet',
  );
  assert.doesNotMatch(
    tagged,
    /slate has not locked yet/,
    'the held-out branch must NOT tell the operator to re-run — that is the other cause',
  );

  // Refusal-only: no closes at all. Keeps the re-run hint, attached to the
  // refused subset rather than offered as run-level advice.
  const noCloses = emptyPrimaryEstimateNote([
    syntheticScored(GAME_A, null, { scheduleChanged: false }),
    syntheticScored(GAME_B, null, { scheduleChanged: false }),
  ]);
  assert.ok(noCloses !== null);
  assert.match(noCloses, /2 not scored at all: close_missing 2/);
  assert.match(noCloses, /slate has not locked yet/);
  assert.doesNotMatch(noCloses, /HELD OUT/);

  // NEGATIVE CONTROL — the note must not fire when anything IS scoreable.
  // Without this the function could return a string unconditionally and every
  // assertion above would still pass.
  assert.equal(
    emptyPrimaryEstimateNote([syntheticScored(GAME_A, 0.5, { scheduleChanged: false })]),
    null,
    'one scoreable pick is enough to suppress the note entirely',
  );
  assert.equal(
    emptyPrimaryEstimateNote([...allTagged, syntheticScored(GAME_A, 0.5, { scheduleChanged: false })]),
    null,
    'tagged picks alongside a scoreable one still suppress it',
  );
});

/** Restamp a pick's refusal reason — `syntheticScored` only ever emits
 *  `close_missing`, and the note must enumerate whatever reasons a run mixes. */
function refusedFor(pick: ScoredPick, reason: UnscoredReason | null): ScoredPick {
  return { ...pick, result: { ...pick.result, unscoredReason: reason } };
}

test('B2: a MIXED zero reports each subset separately and never gives run-level advice', () => {
  // The reviewer's exact counterexample: one valued pick held out by a schedule
  // change, one close_missing pick, primary-scoreable 0. The old wording said
  // "1 pick(s) WERE scored ... Re-running will not change this" — true of the
  // held-out pick, and WRONG for the missing close, where a later re-run may
  // well fill it.
  const mixedZero = [
    syntheticScored(GAME_A, 4.2, { scheduleChanged: true }), // scored, held out
    syntheticScored(GAME_B, null, { scheduleChanged: false }), // close_missing
  ];
  assert.equal(primaryScoreableCount(mixedZero), 0, 'premise: the estimate really is empty');

  const note = emptyPrimaryEstimateNote(mixedZero);
  assert.ok(note !== null);
  // BOTH subsets are named, with their own remedy.
  assert.match(note, /1 scored but HELD OUT/);
  assert.match(note, /Re-running will NOT change those/);
  assert.match(note, /1 not scored at all: close_missing 1/);
  assert.match(note, /slate has not locked yet/);
  // THE REGRESSION GUARD: the held-out remedy must be scoped to "those", never
  // stated as a fact about the run.
  assert.doesNotMatch(
    note,
    /Re-running will not change this\b/,
    'run-level advice would mis-describe the close_missing pick sitting beside it',
  );

  // The partition is EXHAUSTIVE — that is what lets the note report subsets
  // instead of asserting one cause.
  const s = summariseEmptyPrimaryEstimate(mixedZero);
  assert.equal(s.heldOut + s.unscored + s.unexplained, s.picks);
  assert.deepEqual(s, {
    picks: 2,
    heldOut: 1,
    unscored: 1,
    unscoredByReason: { close_missing: 1 },
    unexplained: 0,
  });
  assert.equal(s.heldOut, heldOutOfPrimary(mixedZero), 'agrees with the shared held-out counter');

  // Several distinct reasons are enumerated rather than generalised.
  const twoReasons = [
    syntheticScored(GAME_A, 4.2, { scheduleChanged: true }),
    syntheticScored(GAME_B, null),
    refusedFor(syntheticScored(GAME_A, null), 'close_stale'),
  ];
  const multi = emptyPrimaryEstimateNote(twoReasons);
  assert.ok(multi !== null);
  assert.match(multi, /2 not scored at all: close_missing 1, close_stale 1/);

  // A pick with no value AND no recorded reason is its own bucket — never
  // silently folded into either remedy.
  const unexplained = [refusedFor(syntheticScored(GAME_A, null), null)];
  const note3 = emptyPrimaryEstimateNote(unexplained);
  assert.ok(note3 !== null);
  assert.match(note3, /1 produced no primary value and recorded no refusal reason/);
  assert.doesNotMatch(note3, /not scored at all/);
  assert.deepEqual(summariseEmptyPrimaryEstimate(unexplained), {
    picks: 1,
    heldOut: 0,
    unscored: 0,
    unscoredByReason: {},
    unexplained: 1,
  });
});

// ---------------------------------------------------------------------------
// B1: the PRODUCTION CLI call site, not a rehearsal of it
// ---------------------------------------------------------------------------

/**
 * THE GAP THIS CLOSES, stated exactly. Every test above exercises the pure
 * helpers. A reviewer reverted ONLY `scoreRun.ts` — back to the loose
 * `primaryClvPct !== null` count, with the `emptyPrimaryEstimateNote` call
 * removed — left the well-tested helpers untouched, and the whole suite still
 * passed 1139/1139. Helper coverage cannot see the bug return at the call site.
 *
 * So this drives the REAL `runScoreCli` end to end. Four things are injected —
 * the network read, the two output sinks, and WHICH frozen arm manifest
 * integrity verifies against (never whether it verifies; production keeps
 * `defaultExpectedArms()`). Argument parsing, the run-file read, integrity
 * verification itself, the ladder load, scoring, aggregation, the artifact
 * writes and the summary block are all the production code paths.
 *
 * SCOPE, stated because a neighbouring comment was once too strong: this
 * exercises `runScoreCli`, NOT the process entry point. That the entrypoint
 * still self-executes at all is a separate child-process test in
 * `cli.integration.test.ts` — an always-false entry guard is invisible here.
 *
 * The fixture is chosen so the two predicates DISAGREE — every pick that
 * carries a CLV is schedule-tagged, so the strict count is 0 while the loose
 * count is not. That is what makes the revert observable in stdout.
 */
test('B1: the CLI summary goes through the shared predicate — a loose count at the call site is caught', async () => {
  // Importing `./scoreRun.js` must NOT run a scoring pass. If the entry guard
  // were wrong, the module would have executed against the test runner's argv,
  // thrown UsageError ("--run is required") and set exitCode 2 at import time.
  assert.equal(process.exitCode ?? 0, 0, 'importing the CLI module must not run it');

  const { lines } = fixtureRun();
  const dir = mkdtempSync(join(tmpdir(), 'ospex-score-cli-'));
  const runPath = join(dir, 'run.ndjson');
  writeFileSync(runPath, lines.join('\n'), 'utf8');

  const priorUrl = process.env['SUPABASE_URL'];
  const priorKey = process.env['SUPABASE_ANON_KEY'];
  process.env['SUPABASE_URL'] = 'https://scorecli.invalid';
  process.env['SUPABASE_ANON_KEY'] = 'anon-key-not-used-fetch-is-injected';

  const out: string[] = [];
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  try {
    const code = await runScoreCli(['--run', runPath, '--out', dir], {
      // Every close is shifted two hours off the frozen bundle start, so each
      // pick it reaches is SCORED (a CLV is computed) and simultaneously
      // schedule-TAGGED. No network is touched.
      fetchCloses: async () => [
        driftedClose('moneyline', -TWO_HOURS),
        driftedClose('spread', -TWO_HOURS),
        driftedClose('total', -TWO_HOURS),
      ],
      printLine: (line) => out.push(line),
      printError: (line) => out.push(line),
      expectedArms: FIXTURE_ARMS,
    });
    assert.equal(code, 0, `the run itself must succeed, else this asserts nothing. CLI said:\n${out.join('\n')}`);

    const text = out.join('\n');

    // FIXTURE PREMISE, asserted rather than assumed. Without a pick that the
    // LOOSE predicate would have counted, the note would fire under both the
    // fixed and the reverted code and this test would prove nothing.
    assert.match(
      text,
      /scoreable 0\//,
      'premise: the per-participant lines report a zero, which is the disagreement being pinned',
    );

    // THE ASSERTION THAT DIES ON THE REVERT.
    assert.match(text, /nothing was primary-scoreable/, 'the CLI printed the note');
    assert.match(text, /HELD OUT of the primary same-schedule estimate/);
    assert.match(text, /Re-running will NOT change those/);
  } finally {
    if (priorUrl === undefined) delete process.env['SUPABASE_URL'];
    else process.env['SUPABASE_URL'] = priorUrl;
    if (priorKey === undefined) delete process.env['SUPABASE_ANON_KEY'];
    else process.env['SUPABASE_ANON_KEY'] = priorKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B1 NEGATIVE CONTROL: with an untagged scoreable pick the CLI prints NO note', async () => {
  // The other half. Without this, a `runScoreCli` that printed the note
  // unconditionally would satisfy the test above.
  const { lines } = fixtureRun();
  const dir = mkdtempSync(join(tmpdir(), 'ospex-score-cli-ok-'));
  const runPath = join(dir, 'run.ndjson');
  writeFileSync(runPath, lines.join('\n'), 'utf8');

  const priorUrl = process.env['SUPABASE_URL'];
  const priorKey = process.env['SUPABASE_ANON_KEY'];
  process.env['SUPABASE_URL'] = 'https://scorecli.invalid';
  process.env['SUPABASE_ANON_KEY'] = 'anon-key-not-used-fetch-is-injected';

  const out: string[] = [];
  try {
    const code = await runScoreCli(['--run', runPath, '--out', dir], {
      // On-schedule closes: scored AND in the primary stratum.
      fetchCloses: async () => [
        driftedClose('moneyline', 0),
        driftedClose('spread', 0),
        driftedClose('total', 0),
      ],
      printLine: (line) => out.push(line),
      printError: (line) => out.push(line),
      expectedArms: FIXTURE_ARMS,
    });
    assert.equal(code, 0, `CLI said:\n${out.join('\n')}`);
    assert.doesNotMatch(out.join('\n'), /nothing was primary-scoreable/);
  } finally {
    if (priorUrl === undefined) delete process.env['SUPABASE_URL'];
    else process.env['SUPABASE_URL'] = priorUrl;
    if (priorKey === undefined) delete process.env['SUPABASE_ANON_KEY'];
    else process.env['SUPABASE_ANON_KEY'] = priorKey;
    rmSync(dir, { recursive: true, force: true });
  }
});
