import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ProviderHttpError, ProviderTimeoutError } from './providers/errors.js';
import { presentMarkets } from './scopedMarkets.js';
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
  ProviderUsage,
  SlateBundle,
  SlateInputs,
} from './types.js';

/**
 * Dry-run backing: a synthetic fixture slate shaped byte-for-byte like the
 * real wire (core-api games rows + PostgREST current_odds rows), and four
 * scripted mock adapters. With per-game dispatch the scenarios prove that one
 * game's failure never poisons the rest of the slate:
 *
 * - openai arm    → valid, EXCEPT one game that returns HTTP 429 → rate_limited
 * - anthropic arm → structurally incomplete on ONE game (no decision
 *                   fingerprint → unrepairable → invalid_schema, repair
 *                   skipped); valid on every other game
 * - google arm    → prose+fenced JSON with a wrong cohortId echo on every
 *                   first attempt; the repair fixes the echo with identical
 *                   decisions → valid (fingerprint-preserving repair)
 * - xai arm       → never answers → timeout on every game
 *
 * The fixture carries a FIXED capture timestamp (observedAt <= capturedAt <
 * every cutoff), and the dry run injects a fixed clock just after it, so
 * cutoff enforcement runs for real yet deterministically.
 *
 * Game data is synthetic (reserved 00000000-… IDs); only the SHAPES are real.
 */

export const FIXTURE_SLATE_DATE = '2026-07-12';

/** Fixture game that the anthropic mock corrupts (schema-invalid). */
const INVALID_SCHEMA_GAME_ID = '00000000-0000-4000-8000-000000000001';
/** Fixture game on which the openai mock simulates an HTTP 429 throttle. */
const RATE_LIMITED_GAME_ID = '00000000-0000-4000-8000-000000000003';

const fixtureSchema = z.object({
  note: z.string(),
  capturedAt: z.string().min(1),
  games: z.array(gamesEndpointRowSchema),
  currentOdds: z.array(currentOddsRowSchema),
});

export function loadFixtureInputs(): SlateInputs {
  const url = new URL('../fixtures/dry-run-slate.json', import.meta.url);
  const parsed = fixtureSchema.parse(JSON.parse(readFileSync(url, 'utf8')));
  return {
    gamesRows: parsed.games as GamesEndpointRow[],
    oddsRows: parsed.currentOdds as CurrentOddsRow[],
    fetchStartedAt: parsed.capturedAt,
    fetchCompletedAt: parsed.capturedAt,
  };
}

/** Dry-run clock anchor: 2 minutes after capture, hours before every cutoff. */
export function fixtureNowMs(): number {
  return Date.parse('2026-07-12T14:07:00+00:00');
}

/**
 * The dry run's ONE synthetic clock: anchored at the fixture instant and
 * advancing at real speed. It drives cutoff enforcement AND every recorded
 * timestamp, so dry artifacts are temporally consistent (observedAt <=
 * bundleTimestamp < requestAt < cutoffAt) and latencies stay real.
 */
export function createFixtureClock(): () => number {
  const base = fixtureNowMs();
  const realStart = Date.now();
  return () => base + (Date.now() - realStart);
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

function parseRequestPayload(turns: ChatTurn[]): {
  payload: RequestPayload;
  isRepair: boolean;
  gameId: string;
} {
  const userTurn = turns.find((t) => t.role === 'user');
  if (!userTurn) throw new Error('mock adapter: no user turn in request');
  const marker = '\nRequest:\n';
  const at = userTurn.content.indexOf(marker);
  if (at === -1) throw new Error('mock adapter: request payload marker not found');
  const payload = JSON.parse(userTurn.content.slice(at + marker.length)) as RequestPayload;
  const gameId = payload.bundle.games[0]?.gameId ?? '';
  return { payload, isRepair: turns.some((t) => t.role === 'assistant'), gameId };
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
    if (!ml) throw new Error('mock buildForecast: moneyline requested but the scoped bundle has none');
    const homeIsFavorite = ml.homeDecimal <= ml.awayDecimal;
    selection = homeIsFavorite ? game.homeTeam : game.awayTeam;
    observedDecimal = homeIsFavorite ? ml.homeDecimal : ml.awayDecimal;
    otherDecimal = homeIsFavorite ? ml.awayDecimal : ml.homeDecimal;
    line = null;
    evidenceRef = ml.evidenceRef;
  } else if (market === 'spread') {
    const rl = game.markets.runLine;
    if (!rl) throw new Error('mock buildForecast: spread requested but the scoped bundle has none');
    const ml = game.markets.moneyline;
    // Deterministic contrast pick: take the run line on the moneyline underdog
    // when the moneyline is in scope; otherwise (a run-line-only split fire)
    // fall back to the run line's own higher-decimal side, so the mock handles
    // any cardinality without depending on a market outside the scope.
    const takeAway = ml
      ? ml.awayDecimal >= ml.homeDecimal
      : rl.awayDecimal >= rl.homeDecimal;
    selection = takeAway ? game.awayTeam : game.homeTeam;
    observedDecimal = takeAway ? rl.awayDecimal : rl.homeDecimal;
    otherDecimal = takeAway ? rl.homeDecimal : rl.awayDecimal;
    line = rl.line;
    evidenceRef = rl.evidenceRef;
  } else {
    const total = game.markets.total;
    if (!total) throw new Error('mock buildForecast: total requested but the scoped bundle has none');
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
    reasonCode: null,
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
      // One forecast per market present in the scoped bundle (§3.4) — three for
      // a co-arrival board, fewer for a split fire — never a hard-coded three.
      forecasts: presentMarkets(game).map((market) => buildForecast(game, market)),
    })),
  };
}

function buildSchemaInvalidResponse(payload: RequestPayload): BenchmarkResponse {
  const invalid = structuredClone(buildValidResponse(payload));
  const game = invalid.games[0];
  if (game) {
    // Drop the spread forecast: on the three-market fixture game this violates
    // the required per-market forecast set (a missing scoped market).
    game.forecasts = game.forecasts.filter((f) => f.market !== 'spread');
    const forecast = game.forecasts[0];
    if (forecast) {
      // Break probability coherence: win/push/loss no longer sum to 1.
      forecast.probabilities.win = round6(Math.min(1, forecast.probabilities.win + 0.2));
    }
  }
  return invalid;
}

// ---------------------------------------------------------------------------
// Mock adapters
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockResponse(options: {
  rawText: string;
  reportedModelId: string;
  responseId: string;
  requestedModelId: string;
  usage: ProviderUsage;
  usageRaw: unknown;
}): ProviderResponse {
  return {
    rawText: options.rawText,
    reportedModelId: options.reportedModelId,
    providerResponseId: options.responseId,
    httpStatus: 200,
    usage: options.usage,
    usageRaw: options.usageRaw,
    requestParams: { mock: true, model: options.requestedModelId },
  };
}

/** Provider-realistic raw usage shapes, so the dry run proves verbatim capture. */
const OPENAI_USAGE_RAW = {
  prompt_tokens: 1490,
  completion_tokens: 512,
  total_tokens: 2002,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 256 },
};
const ANTHROPIC_USAGE_RAW = { input_tokens: 1512, output_tokens: 498 };
const GOOGLE_USAGE_RAW = {
  promptTokenCount: 1465,
  candidatesTokenCount: 471,
  thoughtsTokenCount: 305,
  totalTokenCount: 2241,
};

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
      const { payload, gameId } = parseRequestPayload(turns);
      if (gameId === RATE_LIMITED_GAME_ID) {
        throw new ProviderHttpError('openai', 429, 'simulated throttle (mock)');
      }
      return mockResponse({
        // Reported IDs mirror verified live behavior: exact echo of the
        // requested ID (see the approved-alias identity policy).
        rawText: JSON.stringify(buildValidResponse(payload)),
        reportedModelId: 'gpt-5.6-sol',
        responseId: `mock-openai-${gameId.slice(-4)}`,
        requestedModelId: 'gpt-5.6-sol',
        usage: { inputTokens: 1490, outputTokens: 512, totalTokens: 2002 },
        usageRaw: OPENAI_USAGE_RAW,
      });
    },
  });

  adapters.set('anthropic-claude-fable-5', {
    provider: 'anthropic',
    requestedModelId: 'claude-fable-5',
    credentialEnvVar: 'ANTHROPIC_API_KEY',
    hasCredential: () => true,
    async chat(turns): Promise<ProviderResponse> {
      await sleep(60);
      const { payload, gameId } = parseRequestPayload(turns);
      // One game stays schema-invalid through the repair; the others are
      // valid — proving one game's failure does not poison the slate.
      const body =
        gameId === INVALID_SCHEMA_GAME_ID
          ? buildSchemaInvalidResponse(payload)
          : buildValidResponse(payload);
      return mockResponse({
        rawText: JSON.stringify(body),
        reportedModelId: 'claude-fable-5',
        responseId: `mock-anthropic-${gameId.slice(-4)}`,
        requestedModelId: 'claude-fable-5',
        usage: { inputTokens: 1512, outputTokens: 498, totalTokens: 2010 },
        usageRaw: ANTHROPIC_USAGE_RAW,
      });
    },
  });

  adapters.set('google-gemini-3.1-pro-preview', {
    provider: 'google',
    requestedModelId: 'gemini-3.1-pro-preview',
    credentialEnvVar: 'GEMINI_API_KEY',
    hasCredential: () => true,
    async chat(turns): Promise<ProviderResponse> {
      await sleep(50);
      const { payload, isRepair, gameId } = parseRequestPayload(turns);
      const reported = options.simulateCollision ? 'gpt-5.6-sol' : 'gemini-3.1-pro-preview';
      const usage: ProviderUsage = { inputTokens: 1465, outputTokens: 471, totalTokens: 2241 };
      if (isRepair) {
        // The repair fixes only the echo; decisions are byte-identical, so
        // the fingerprint-preservation check accepts it.
        return mockResponse({
          rawText: JSON.stringify(buildValidResponse(payload)),
          reportedModelId: reported,
          responseId: `mock-google-r-${gameId.slice(-4)}`,
          requestedModelId: 'gemini-3.1-pro-preview',
          usage,
          usageRaw: GOOGLE_USAGE_RAW,
        });
      }
      // Initial attempt: complete, fingerprintable decisions wrapped in prose
      // and fences, but echoing the WRONG cohortId — a semantic failure the
      // single deterministic repair may fix without touching any decision.
      const wrongEcho = { ...buildValidResponse(payload), cohortId: 'mock-wrong-cohort' };
      const fenced = `Here are my forecasts:\n\`\`\`json\n${JSON.stringify(wrongEcho)}\n\`\`\`\nGood luck!`;
      return mockResponse({
        rawText: fenced,
        reportedModelId: reported,
        responseId: `mock-google-${gameId.slice(-4)}`,
        requestedModelId: 'gemini-3.1-pro-preview',
        usage,
        usageRaw: GOOGLE_USAGE_RAW,
      });
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
