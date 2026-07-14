import { canonicalize, sha256Hex } from './canonical.js';
import { bundleMarketKeys } from './markets.js';
import { SMOKE_LABEL } from './types.js';
import type { GameRequest } from './bundle.js';
import type {
  ArmSpec,
  BenchmarkResponse,
  ForecastOutput,
  GameBundle,
  MarketKey,
  SlateBundle,
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

/**
 * A bundle scoped to a market subset — the line-open case (e.g. moneyline +
 * total, no run line). Drops the absent markets' blocks and evidenceRefs so
 * the content hash matches what a scoped fire would produce.
 */
export function makeScopedGameBundle(
  markets: MarketKey[],
  overrides: Partial<GameBundle> = {},
): GameBundle {
  const full = makeGameBundle(overrides);
  const keep = new Set(markets);
  const scopedMarkets: GameBundle['markets'] = {};
  const marketRefs: string[] = [];
  if (keep.has('moneyline') && full.markets.moneyline) {
    scopedMarkets.moneyline = full.markets.moneyline;
    marketRefs.push(full.markets.moneyline.evidenceRef);
  }
  if (keep.has('spread') && full.markets.runLine) {
    scopedMarkets.runLine = full.markets.runLine;
    marketRefs.push(full.markets.runLine.evidenceRef);
  }
  if (keep.has('total') && full.markets.total) {
    scopedMarkets.total = full.markets.total;
    marketRefs.push(full.markets.total.evidenceRef);
  }
  return {
    ...full,
    markets: scopedMarkets,
    evidenceRefs: [
      `ev:${full.gameId}:identity`,
      `ev:${full.gameId}:schedule`,
      ...marketRefs,
    ],
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

/** A hashed request wrapping any (possibly scoped) game. */
export function makeRequestFromGame(
  game: GameBundle,
  slug = 'mil-pit-2026-07-12',
): GameRequest {
  const requestBundle: SlateBundle = {
    schemaVersion: 1,
    label: SMOKE_LABEL,
    league: 'mlb',
    slateDate: '2026-07-12',
    bundleTimestamp: '2026-07-12T14:05:00+00:00',
    cutoffAt: game.scheduledStartUtc,
    games: [game],
  };
  return {
    gameId: game.gameId,
    slug,
    game,
    requestBundle,
    requestSha256: sha256Hex(canonicalize(requestBundle)),
  };
}

function forecastFor(game: GameBundle, market: MarketKey): ForecastOutput {
  if (market === 'moneyline') {
    const ml = game.markets.moneyline;
    if (ml === undefined) throw new Error('makeValidResponse: moneyline absent');
    return {
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
    };
  }
  if (market === 'spread') {
    const rl = game.markets.runLine;
    if (rl === undefined) throw new Error('makeValidResponse: run line absent');
    return {
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
    };
  }
  const total = game.markets.total;
  if (total === undefined) throw new Error('makeValidResponse: total absent');
  return {
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
  };
}

/** A fully schema- and semantics-conformant response for makeRequest() —
 *  forecasts exactly the markets the request's bundle carries. */
export function makeValidResponse(
  request: GameRequest,
  arm: ArmSpec = TEST_ARM,
  cohortId: string = TEST_COHORT,
): BenchmarkResponse {
  const game = request.game;
  return {
    schemaVersion: 1,
    cohortId,
    participantId: arm.participantId,
    requestedModelId: arm.requestedModelId,
    bundleSha256: request.requestSha256,
    executionPolicy: 'fixed-moneyline-total',
    games: [
      {
        gameId: game.gameId,
        forecasts: bundleMarketKeys(game).map((market) => forecastFor(game, market)),
      },
    ],
  };
}
