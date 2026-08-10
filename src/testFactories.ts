import { canonicalize, sha256Hex } from './canonical.js';
import { validateResponseText } from './schema.js';
import { SMOKE_LABEL } from './types.js';
import type { GameRequest } from './bundle.js';
import type { ArmSpec, BenchmarkResponse, ForecastOutput, GameBundle, SlateBundle } from './types.js';

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

export function makeGameBundle(overrides: Partial<GameBundle> = {}): GameBundle {
  const gameId = overrides.gameId ?? '00000000-0000-4000-8000-00000000t001';
  return {
    gameId,
    league: 'mlb',
    scheduledStartUtc: '2026-07-12T16:15:00+00:00',
    awayTeam: 'Milwaukee Brewers',
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: {
      moneyline: {
        awayDecimal: 1.74627,
        homeDecimal: 2.17,
        observedAt: '2026-07-12T14:02:11+00:00',
        evidenceRef: `ev:${gameId}:moneyline`,
      },
      runLine: {
        line: 1.5,
        awayHandicap: -1.5,
        homeHandicap: 1.5,
        awayDecimal: 2.3,
        homeDecimal: 1.66667,
        observedAt: '2026-07-12T14:02:11+00:00',
        evidenceRef: `ev:${gameId}:runline`,
      },
      total: {
        line: 8.5,
        overDecimal: 1.90909,
        underDecimal: 1.90909,
        observedAt: '2026-07-12T14:02:11+00:00',
        evidenceRef: `ev:${gameId}:total`,
      },
    },
    evidenceRefs: [
      `ev:${gameId}:identity`,
      `ev:${gameId}:schedule`,
      `ev:${gameId}:moneyline`,
      `ev:${gameId}:runline`,
      `ev:${gameId}:total`,
    ],
    ...overrides,
  };
}

export function makeRequest(
  cutoffAt = '2026-07-12T16:15:00+00:00',
  overrides: Partial<GameBundle> = {},
): GameRequest {
  const game = makeGameBundle({ scheduledStartUtc: cutoffAt, ...overrides });
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

/** A fully schema- and semantics-conformant response for makeRequest(). */
export function makeValidResponse(
  request: GameRequest,
  arm: ArmSpec = TEST_ARM,
  cohortId: string = TEST_COHORT,
): BenchmarkResponse {
  const game = request.game;
  // makeRequest/makeGameBundle always build a full three-market board.
  const ml = game.markets.moneyline!;
  const rl = game.markets.runLine!;
  const total = game.markets.total!;
  return {
    schemaVersion: 2,
    cohortId,
    participantId: arm.participantId,
    requestedModelId: arm.requestedModelId,
    bundleSha256: request.requestSha256,
    executionPolicy: 'fixed-moneyline-total',
    games: [
      {
        gameId: game.gameId,
        forecasts: [
          {
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
            axes: { valuation: 4, trend: 2, consensus: 3, news: 1, softness: 5 },
            primaryAxis: 'valuation',
            primaryExpectation: 'The away price reads rich against the implied probabilities.',
          },
          {
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
            axes: { valuation: 2, trend: 4, consensus: 1, news: 3, softness: 5 },
            primaryAxis: 'trend',
            primaryExpectation: 'Recent form favors the home side on the designated run line.',
          },
          {
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
            // The all-ones case: no primary driver, and an expectation stating
            // that no material movement is expected.
            axes: { valuation: 1, trend: 1, consensus: 1, news: 1, softness: 1 },
            primaryAxis: null,
            primaryExpectation: 'No material movement is expected in this total before close.',
          },
        ],
      },
    ],
  };
}

/**
 * An OVER-SCALE forecast the response validator accepts, with the validator's
 * verdict returned alongside so every caller can assert on it rather than trust
 * this comment.
 *
 * Every numeric carries more decimals than the serving projection's reveal
 * columns hold (`line numeric(10,4)`, `observed_decimal numeric(12,6)`,
 * probabilities and `confidence numeric(9,8)`), which is the case that made a
 * digest over unrounded floats unreproducible from the reveal.
 *
 * Producing one that is genuinely valid is fiddlier than it looks, which is why
 * it lives here instead of being retyped: probabilities must sum to 1 within
 * 1e-6, `observedDecimal` must EQUAL the bundle price for the selected side,
 * `line` must echo the bundle, and `push` must be 0 whenever the line is not an
 * integer — which an over-scale line always is. So the bundle carries the
 * over-scale price too.
 */
export function makeOverScaleAccepted(): {
  forecast: ForecastOutput;
  errors: readonly string[];
} {
  const base = makeRequest();
  const request = makeRequest('2026-07-12T16:15:00+00:00', {
    markets: {
      ...base.game.markets,
      runLine: {
        ...base.game.markets.runLine!,
        line: 1.50004,
        homeHandicap: 1.50004,
        awayHandicap: -1.50004,
        homeDecimal: 2.0537127,
      },
    },
  } as never);
  const response = makeValidResponse(request);
  const spread = response.games[0]!.forecasts.find((f) => f.market === 'spread')!;
  spread.line = 1.50004; //              numeric(10,4) holds 4
  spread.observedDecimal = 2.0537127; // numeric(12,6) holds 6
  spread.probabilities = { win: 0.523123456789, push: 0, loss: 0.476876543211 };
  spread.confidence = 0.613712345678; // numeric(9,8) holds 8

  const result = validateResponseText(
    JSON.stringify(response),
    request.requestBundle,
    request.requestSha256,
    TEST_ARM,
    TEST_COHORT
  );
  const accepted = result.parsed?.games[0]?.forecasts.find((f) => f.market === 'spread');
  return { forecast: (accepted ?? spread) as ForecastOutput, errors: result.errors };
}
