import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ProviderTimeoutError } from './providers/errors.js';
import { currentOddsRowSchema, gamesEndpointRowSchema } from './wire.js';
import type {
  BenchmarkResponse,
  ChatTurn,
  CurrentOddsRow,
  ForecastOutput,
  GameBundle,
  GamesEndpointRow,
  ProviderAdapter,
  ProviderResponse,
  SlateBundle,
  SlateInputs,
} from './types.js';

/**
 * Dry-run backing: a synthetic fixture slate shaped byte-for-byte like the
 * real wire (core-api games rows + PostgREST current_odds rows), and four
 * scripted mock adapters that exercise every pipeline path end to end:
 *
 * - openai arm    → valid on the first attempt
 * - anthropic arm → schema-violating JSON; deterministic repair returns the
 *                   same violation → final outcome invalid_schema
 * - google arm    → malformed (prose + broken JSON); repair returns valid
 * - xai arm       → never answers → timeout
 *
 * Game data is synthetic (reserved 00000000-… IDs); only the SHAPES are real.
 */

export const FIXTURE_SLATE_DATE = '2026-07-12';

const fixtureSchema = z.object({
  note: z.string(),
  games: z.array(gamesEndpointRowSchema),
  currentOdds: z.array(currentOddsRowSchema),
});

export function loadFixtureInputs(): SlateInputs {
  const url = new URL('../fixtures/dry-run-slate.json', import.meta.url);
  const parsed = fixtureSchema.parse(JSON.parse(readFileSync(url, 'utf8')));
  return {
    gamesRows: parsed.games as GamesEndpointRow[],
    oddsRows: parsed.currentOdds as CurrentOddsRow[],
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Deterministic mock forecasting
// ---------------------------------------------------------------------------

interface RequestPayload {
  cohortId: string;
  participantId: string;
  requestedModelId: string;
  executionPolicy: 'fixed-moneyline-total';
  bundleSha256: string;
  bundle: SlateBundle;
}

function parseRequestPayload(turns: ChatTurn[]): { payload: RequestPayload; isRepair: boolean } {
  const userTurn = turns.find((t) => t.role === 'user');
  if (!userTurn) throw new Error('mock adapter: no user turn in request');
  const marker = '\nRequest:\n';
  const at = userTurn.content.indexOf(marker);
  if (at === -1) throw new Error('mock adapter: request payload marker not found');
  const payload = JSON.parse(userTurn.content.slice(at + marker.length)) as RequestPayload;
  return { payload, isRepair: turns.some((t) => t.role === 'assistant') };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function devigProbability(selectedDecimal: number, otherDecimal: number): number {
  const pSelected = 1 / selectedDecimal;
  const pOther = 1 / otherDecimal;
  return pSelected / (pSelected + pOther);
}

function buildForecast(
  game: GameBundle,
  market: 'moneyline' | 'spread' | 'total',
): ForecastOutput {
  let selection: string;
  let line: number | null;
  let observedDecimal: number;
  let otherDecimal: number;
  let evidenceRef: string;

  if (market === 'moneyline') {
    const ml = game.markets.moneyline;
    const homeIsFavorite = ml.homeDecimal <= ml.awayDecimal;
    selection = homeIsFavorite ? game.homeTeam : game.awayTeam;
    observedDecimal = homeIsFavorite ? ml.homeDecimal : ml.awayDecimal;
    otherDecimal = homeIsFavorite ? ml.awayDecimal : ml.homeDecimal;
    line = null;
    evidenceRef = ml.evidenceRef;
  } else if (market === 'spread') {
    const rl = game.markets.runLine;
    const ml = game.markets.moneyline;
    // Deterministic contrast pick: take the run line on the moneyline underdog.
    const takeAway = ml.awayDecimal >= ml.homeDecimal;
    selection = takeAway ? game.awayTeam : game.homeTeam;
    observedDecimal = takeAway ? rl.awayDecimal : rl.homeDecimal;
    otherDecimal = takeAway ? rl.homeDecimal : rl.awayDecimal;
    line = rl.line;
    evidenceRef = rl.evidenceRef;
  } else {
    const total = game.markets.total;
    selection = 'over';
    observedDecimal = total.overDecimal;
    otherDecimal = total.underDecimal;
    line = total.line;
    evidenceRef = total.evidenceRef;
  }

  const marketLine = market === 'moneyline' ? null : line;
  const pushCapable = marketLine !== null && Number.isInteger(marketLine);
  const pWin = devigProbability(observedDecimal, otherDecimal);
  const push = pushCapable ? 0.05 : 0;
  const win = round6(pWin * (1 - push));
  const loss = round6(1 - win - push);

  return {
    market,
    selection,
    line,
    observedDecimal,
    probabilities: { win, push, loss },
    confidence: 0.55,
    wouldAbstain: false,
    selectedForExecution: market !== 'spread',
    rationale: `Reference prices imply the selected side at ${observedDecimal}; no additional signal in the frozen bundle.`,
    evidenceRefs: [evidenceRef],
  };
}

function buildValidResponse(payload: RequestPayload): BenchmarkResponse {
  return {
    schemaVersion: 1,
    cohortId: payload.cohortId,
    participantId: payload.participantId,
    requestedModelId: payload.requestedModelId,
    bundleSha256: payload.bundleSha256,
    executionPolicy: payload.executionPolicy,
    games: payload.bundle.games.map((game) => ({
      gameId: game.gameId,
      forecasts: [
        buildForecast(game, 'moneyline'),
        buildForecast(game, 'spread'),
        buildForecast(game, 'total'),
      ],
    })),
  };
}

function buildSchemaInvalidResponse(payload: RequestPayload): BenchmarkResponse {
  const invalid = structuredClone(buildValidResponse(payload));
  const firstGame = invalid.games[0];
  if (firstGame) {
    // Drop the spread forecast: violates the exactly-three-forecasts contract.
    firstGame.forecasts = firstGame.forecasts.filter((f) => f.market !== 'spread');
  }
  const secondGame = invalid.games[1];
  const forecast = secondGame?.forecasts[0];
  if (forecast) {
    // Break probability coherence: win/push/loss no longer sum to 1.
    forecast.probabilities.win = round6(Math.min(1, forecast.probabilities.win + 0.2));
  }
  return invalid;
}

// ---------------------------------------------------------------------------
// Mock adapters
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockResponse(
  rawText: string,
  reportedModelId: string,
  responseId: string,
  requestedModelId: string,
): ProviderResponse {
  return {
    rawText,
    reportedModelId,
    providerResponseId: responseId,
    usage: { inputTokens: 4213, outputTokens: 1877, totalTokens: 6090 },
    requestParams: { mock: true, model: requestedModelId },
  };
}

export function createMockAdapters(options: {
  simulateCollision: boolean;
}): Map<string, ProviderAdapter> {
  const adapters = new Map<string, ProviderAdapter>();

  adapters.set('openai-gpt-5.6-sol', {
    provider: 'openai',
    requestedModelId: 'gpt-5.6-sol',
    credentialEnvVar: 'OPENAI_API_KEY',
    hasCredential: () => true,
    async chat(turns): Promise<ProviderResponse> {
      await sleep(40);
      const { payload } = parseRequestPayload(turns);
      return mockResponse(
        JSON.stringify(buildValidResponse(payload)),
        'gpt-5.6-sol-2026-05-01',
        'mock-openai-1',
        'gpt-5.6-sol',
      );
    },
  });

  adapters.set('anthropic-claude-fable-5', {
    provider: 'anthropic',
    requestedModelId: 'claude-fable-5',
    credentialEnvVar: 'ANTHROPIC_API_KEY',
    hasCredential: () => true,
    async chat(turns): Promise<ProviderResponse> {
      await sleep(60);
      const { payload } = parseRequestPayload(turns);
      // Returns the same schema violation on the repair attempt too — the
      // dry run's guaranteed invalid_schema outcome.
      return mockResponse(
        JSON.stringify(buildSchemaInvalidResponse(payload)),
        'claude-fable-5',
        'mock-anthropic-1',
        'claude-fable-5',
      );
    },
  });

  adapters.set('google-gemini-3.1-pro-preview', {
    provider: 'google',
    requestedModelId: 'gemini-3.1-pro-preview',
    credentialEnvVar: 'GEMINI_API_KEY',
    hasCredential: () => true,
    async chat(turns): Promise<ProviderResponse> {
      await sleep(50);
      const { payload, isRepair } = parseRequestPayload(turns);
      const reported = options.simulateCollision
        ? 'gpt-5.6-sol-2026-05-01'
        : 'gemini-3.1-pro-preview-0611';
      if (isRepair) {
        return mockResponse(
          JSON.stringify(buildValidResponse(payload)),
          reported,
          'mock-google-2',
          'gemini-3.1-pro-preview',
        );
      }
      const corrupted = JSON.stringify(buildValidResponse(payload)).replace(
        '"schemaVersion":1',
        '"schemaVersion":1,,',
      );
      const malformed = `Here are my forecasts for the slate:\n\`\`\`json\n${corrupted}\n\`\`\`\nGood luck!`;
      return mockResponse(malformed, reported, 'mock-google-1', 'gemini-3.1-pro-preview');
    },
  });

  adapters.set('xai-grok-4.5', {
    provider: 'xai',
    requestedModelId: 'grok-4.5',
    credentialEnvVar: 'XAI_API_KEY',
    hasCredential: () => true,
    async chat(_turns, timeoutMs): Promise<ProviderResponse> {
      await sleep(timeoutMs + 250);
      throw new ProviderTimeoutError('xai', timeoutMs);
    },
  });

  return adapters;
}
