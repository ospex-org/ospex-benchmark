import { canonicalize, sha256Hex } from './canonical.js';
import { MARKET_ORDER } from './scopedMarkets.js';
import { SMOKE_LABEL } from './types.js';
import type { GameRequest } from './bundle.js';
import type {
  ArmSpec,
  BenchmarkResponse,
  ForecastOutput,
  GameBundle,
  MarketKey,
  MoneylineBlock,
  RunLineBlock,
  SlateBundle,
  TotalBlock,
} from './types.js';

/**
 * Shared deterministic factories for unit tests: one synthetic game request
 * and a schema-conformant response for it. Test-only; not part of the runtime
 * path (nothing under src/ imports this except *.test.ts).
 */

export const TEST_ARM: ArmSpec = {
  participantId: 'stub-openai',
  provider: 'openai',
  requestedModelId: 'stub-model-1',
  credentialEnvVar: 'STUB_PROVIDER_KEY',
};

export const TEST_COHORT = 'test-cohort';

/**
 * A synthetic game bundle. By default it carries all three markets (the
 * archived full-board shape); pass `present` to build a scoped subset (a split
 * fire) — the markets, evidenceRefs, and every derived consumer follow the set.
 */
export function makeGameBundle(
  overrides: Partial<GameBundle> = {},
  present: readonly MarketKey[] = MARKET_ORDER,
): GameBundle {
  const gameId = overrides.gameId ?? '00000000-0000-4000-8000-00000000t001';
  const scope = new Set(present);
  const moneyline: MoneylineBlock = {
    awayDecimal: 1.74627,
    homeDecimal: 2.17,
    observedAt: '2026-07-12T14:02:11+00:00',
    evidenceRef: `ev:${gameId}:moneyline`,
  };
  const runLine: RunLineBlock = {
    line: 1.5,
    awayHandicap: -1.5,
    homeHandicap: 1.5,
    awayDecimal: 2.3,
    homeDecimal: 1.66667,
    observedAt: '2026-07-12T14:02:11+00:00',
    evidenceRef: `ev:${gameId}:runline`,
  };
  const total: TotalBlock = {
    line: 8.5,
    overDecimal: 1.90909,
    underDecimal: 1.90909,
    observedAt: '2026-07-12T14:02:11+00:00',
    evidenceRef: `ev:${gameId}:total`,
  };
  return {
    gameId,
    league: 'mlb',
    scheduledStartUtc: '2026-07-12T16:15:00+00:00',
    awayTeam: 'Milwaukee Brewers',
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: {
      ...(scope.has('moneyline') ? { moneyline } : {}),
      ...(scope.has('spread') ? { runLine } : {}),
      ...(scope.has('total') ? { total } : {}),
    },
    evidenceRefs: [
      `ev:${gameId}:identity`,
      `ev:${gameId}:schedule`,
      ...(scope.has('moneyline') ? [`ev:${gameId}:moneyline`] : []),
      ...(scope.has('spread') ? [`ev:${gameId}:runline`] : []),
      ...(scope.has('total') ? [`ev:${gameId}:total`] : []),
    ],
    ...overrides,
  };
}

export function makeRequest(
  cutoffAt = '2026-07-12T16:15:00+00:00',
  overrides: Partial<GameBundle> = {},
  present: readonly MarketKey[] = MARKET_ORDER,
): GameRequest {
  const game = makeGameBundle({ scheduledStartUtc: cutoffAt, ...overrides }, present);
  const requestBundle: SlateBundle = {
    schemaVersion: 1,
    label: SMOKE_LABEL,
    league: 'mlb',
    slateDate: '2026-07-12',
    bundleTimestamp: '2026-07-12T14:05:00+00:00',
    cutoffAt,
    games: [game],
  };
  return {
    gameId: game.gameId,
    slug: 'mil-pit-2026-07-12',
    game,
    requestBundle,
    requestSha256: sha256Hex(canonicalize(requestBundle)),
  };
}

/**
 * A fully schema- and semantics-conformant response for makeRequest(): exactly
 * one forecast per market present in the scoped bundle (§3.4), with the fixed
 * moneyline+total execution marking intersected with the present set.
 */
export function makeValidResponse(
  request: GameRequest,
  arm: ArmSpec = TEST_ARM,
  cohortId: string = TEST_COHORT,
): BenchmarkResponse {
  const game = request.game;
  const forecasts: ForecastOutput[] = [];
  const ml = game.markets.moneyline;
  if (ml) {
    forecasts.push({
      market: 'moneyline',
      selection: game.awayTeam,
      line: null,
      observedDecimal: ml.awayDecimal,
      probabilities: { win: 0.55, push: 0, loss: 0.45 },
      confidence: 0.6,
      wouldAbstain: false,
      selectedForExecution: true,
      rationale: 'Reference prices favor the away side.',
      evidenceRefs: [ml.evidenceRef],
      reasonCode: null,
    });
  }
  const rl = game.markets.runLine;
  if (rl) {
    forecasts.push({
      market: 'spread',
      selection: game.homeTeam,
      line: rl.line,
      observedDecimal: rl.homeDecimal,
      probabilities: { win: 0.5, push: 0, loss: 0.5 },
      confidence: 0.5,
      wouldAbstain: false,
      selectedForExecution: false,
      rationale: 'Half-run line at even implied odds.',
      evidenceRefs: [rl.evidenceRef],
      reasonCode: null,
    });
  }
  const total = game.markets.total;
  if (total) {
    forecasts.push({
      market: 'total',
      selection: 'over',
      line: total.line,
      observedDecimal: total.overDecimal,
      probabilities: { win: 0.5, push: 0, loss: 0.5 },
      confidence: 0.5,
      wouldAbstain: false,
      selectedForExecution: true,
      rationale: 'Total priced evenly at the designated line.',
      evidenceRefs: [total.evidenceRef],
      reasonCode: null,
    });
  }
  return {
    schemaVersion: 1,
    cohortId,
    participantId: arm.participantId,
    requestedModelId: arm.requestedModelId,
    bundleSha256: request.requestSha256,
    executionPolicy: 'fixed-moneyline-total',
    games: [{ gameId: game.gameId, forecasts }],
  };
}
