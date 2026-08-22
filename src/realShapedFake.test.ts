import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INVALID_SCHEMA_GAME_ID,
  RATE_LIMITED_GAME_ID,
  buildFixtureSearchAudit,
  buildSchemaInvalidResponse,
  buildValidResponse,
} from './mock.js';
import type { RequestPayload } from './mock.js';
import { ProviderHttpError, ProviderTimeoutError } from './providers/errors.js';
import { createRealShapedFakeAdapters } from './realShapedFake.js';
import { envelopeVerificationFailures } from './providers/responseEnvelope.js';
import type { ProviderResponse } from './types.js';
import type { ChatTurn, GameBundle, ProviderAdapter } from './types.js';

/**
 * The real-shaped fake's PROVIDER ENVELOPE, owned directly: the whole-fire parity tests
 * cannot see `usageRaw`, response ids, or request params (none are persisted in the
 * artifact, and a known-zero capability's spend evaluation never reads the raw envelope),
 * so this suite drives each fake adapter directly and DEEP-EQUALS its COMPLETE
 * `ProviderResponse` — verbatim provider-specific `usageRaw` included. A mutation that
 * nulls or reshapes any envelope field fails here, not silently.
 *
 * `responseEnvelope` is the one field held out of the deep-equal and checked by
 * its PROPERTIES instead (`envelopeOf`): pinning the retained body as a literal
 * would restate the fake's own construction on both sides of the assertion and
 * prove only that the value was copied. Holding it out keeps the deep-equal
 * exhaustive — anything else added to `ProviderResponse` still fails here.
 */

const GAME_ID = '00000000-0000-4000-8000-00000000ffff';

/**
 * Split the retained envelope off a complete response, verifying it on the way:
 * it must reproduce its own digest and byte count, and its body must be the
 * provider body the answer text came out of.
 */
function envelopeOf(result: ProviderResponse): Omit<ProviderResponse, 'responseEnvelope'> {
  const { responseEnvelope, ...rest } = result;
  assert.deepEqual(envelopeVerificationFailures(responseEnvelope), []);
  const parsed = JSON.parse(responseEnvelope.body) as {
    output: Array<{ content: Array<{ text: string }> }>;
  };
  assert.equal(parsed.output[0]!.content[0]!.text, result.rawText, 'the answer came out of that body');
  assert.notEqual(responseEnvelope.body, result.rawText, 'the body is the envelope, not the answer');
  return rest;
}

function gameFixture(gameId: string): GameBundle {
  return {
    gameId,
    league: 'mlb',
    scheduledStartUtc: '2026-07-18T20:00:00+00:00',
    awayTeam: 'Milwaukee Brewers',
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: {
      moneyline: { awayDecimal: 1.74627, homeDecimal: 2.17, observedAt: '2026-07-18T11:58:00+00:00', evidenceRef: 'ev:ml' },
      total: { line: 8.5, overDecimal: 1.90909, underDecimal: 1.90909, observedAt: '2026-07-18T11:58:00+00:00', evidenceRef: 'ev:t' },
    },
    evidenceRefs: ['ev:identity', 'ev:ml', 'ev:t'],
  };
}

function payloadFor(participantId: string, requestedModelId: string, gameId: string): RequestPayload {
  return {
    cohortId: 'test-cohort',
    participantId,
    requestedModelId,
    executionPolicy: 'fixed-moneyline-total',
    bundleSha256: 'b'.repeat(64),
    bundle: { games: [gameFixture(gameId)] } as unknown as RequestPayload['bundle'],
  };
}

function turnsFor(payload: RequestPayload, options: { repair?: boolean } = {}): ChatTurn[] {
  const turns: ChatTurn[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: `instructions\nRequest:\n${JSON.stringify(payload)}` },
  ];
  if (options.repair) turns.push({ role: 'assistant', content: 'prior attempt' });
  return turns;
}

/** The fake's fence wrapper, recomputed independently for expected-value construction. */
function fenced(json: string): string {
  return `\`\`\`json\n${json}\n\`\`\``;
}

function fake(options?: { simulateCollision?: boolean; rateLimitedGameId?: string }): Map<string, ProviderAdapter> {
  return createRealShapedFakeAdapters({
    simulateCollision: options?.simulateCollision ?? false,
    ...(options?.rateLimitedGameId !== undefined ? { rateLimitedGameId: options.rateLimitedGameId } : {}),
  });
}

test('the fake rosters the four canonical arms with exact identities and credentials', () => {
  const adapters = fake();
  assert.deepEqual(
    [...adapters.keys()].sort(),
    ['anthropic-claude-fable-5', 'google-gemini-3.1-pro-preview', 'openai-gpt-5.6-sol', 'xai-grok-4.5'],
  );
  for (const [id, adapter] of adapters) {
    assert.ok(adapter.hasCredential(), `${id}: the fake always reports a credential`);
  }
  const openai = adapters.get('openai-gpt-5.6-sol')!;
  assert.equal(openai.provider, 'openai');
  assert.equal(openai.requestedModelId, 'gpt-5.6-sol');
  assert.equal(openai.credentialEnvVar, 'OPENAI_API_KEY');
});

test('openai fake: the COMPLETE ProviderResponse — fenced body, ids, and verbatim subset-reasoning usageRaw', async () => {
  const payload = payloadFor('openai-gpt-5.6-sol', 'gpt-5.6-sol', GAME_ID);
  const result = await fake().get('openai-gpt-5.6-sol')!.chat(turnsFor(payload), 5_000);
  assert.deepEqual(envelopeOf(result), {
    rawText: fenced(JSON.stringify(buildValidResponse(payload))),
    reportedModelId: 'gpt-5.6-sol',
    providerResponseId: 'resp_fakeffff',
    httpStatus: 200,
    usage: {
      inputTokens: 1490,
      outputTokens: 512,
      totalTokens: 2002,
      reasoningTokens: 256,
      billableOutputTokens: 512,
    },
    usageRaw: {
      input_tokens: 1490,
      output_tokens: 512,
      total_tokens: 2002,
      input_tokens_details: { cached_tokens: 128 },
      output_tokens_details: { reasoning_tokens: 256 },
    },
    requestParams: { endpoint: 'https://api.openai.com/v1/responses', model: 'gpt-5.6-sol' },
    searchAudit: buildFixtureSearchAudit('openai', GAME_ID),
  });
});

test('openai fake: HTTP 429 on the fixture throttle game AND on the configured gameId', async () => {
  const fixturePayload = payloadFor('openai-gpt-5.6-sol', 'gpt-5.6-sol', RATE_LIMITED_GAME_ID);
  await assert.rejects(
    () => fake().get('openai-gpt-5.6-sol')!.chat(turnsFor(fixturePayload), 5_000),
    (e: unknown) => e instanceof ProviderHttpError && e.status === 429,
  );
  const configuredPayload = payloadFor('openai-gpt-5.6-sol', 'gpt-5.6-sol', GAME_ID);
  await assert.rejects(
    () => fake({ rateLimitedGameId: GAME_ID }).get('openai-gpt-5.6-sol')!.chat(turnsFor(configuredPayload), 5_000),
    (e: unknown) => e instanceof ProviderHttpError && e.status === 429,
  );
});

test('anthropic fake: the COMPLETE ProviderResponse — verbatim usageRaw with BOTH cache fields', async () => {
  const payload = payloadFor('anthropic-claude-fable-5', 'claude-fable-5', GAME_ID);
  const result = await fake().get('anthropic-claude-fable-5')!.chat(turnsFor(payload), 5_000);
  assert.deepEqual(envelopeOf(result), {
    rawText: fenced(JSON.stringify(buildValidResponse(payload))),
    reportedModelId: 'claude-fable-5',
    providerResponseId: 'msg_fakeffff',
    httpStatus: 200,
    usage: {
      inputTokens: 1512,
      outputTokens: 498,
      totalTokens: 2010,
      reasoningTokens: 120,
      billableOutputTokens: 498,
    },
    usageRaw: {
      input_tokens: 1512,
      output_tokens: 498,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens_details: { thinking_tokens: 120 },
      server_tool_use: { web_search_requests: 1 },
    },
    requestParams: { endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-fable-5' },
    searchAudit: buildFixtureSearchAudit('anthropic', GAME_ID),
  });
});

test('anthropic fake: the corruption fixture game returns the SHARED schema-invalid body, envelope unchanged', async () => {
  const payload = payloadFor('anthropic-claude-fable-5', 'claude-fable-5', INVALID_SCHEMA_GAME_ID);
  const result = await fake().get('anthropic-claude-fable-5')!.chat(turnsFor(payload), 5_000);
  assert.equal(result.rawText, fenced(JSON.stringify(buildSchemaInvalidResponse(payload))));
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.usage, {
    inputTokens: 1512,
    outputTokens: 498,
    totalTokens: 2010,
    reasoningTokens: 120,
    billableOutputTokens: 498,
  });
});

test('google fake initial: the COMPLETE ProviderResponse — prose+fence wrong-cohort echo, ADDITIVE thoughts usageRaw', async () => {
  const payload = payloadFor('google-gemini-3.1-pro-preview', 'gemini-3.1-pro-preview', GAME_ID);
  const wrongEcho = { ...buildValidResponse(payload), cohortId: 'fake-wrong-cohort' };
  const result = await fake().get('google-gemini-3.1-pro-preview')!.chat(turnsFor(payload), 5_000);
  assert.deepEqual(envelopeOf(result), {
    rawText: `Forecast batch follows.\n${fenced(JSON.stringify(wrongEcho))}\nEnd of batch.`,
    reportedModelId: 'gemini-3.1-pro-preview',
    providerResponseId: 'resp-fake-ffff',
    httpStatus: 200,
    usage: {
      inputTokens: 1465,
      outputTokens: 471,
      totalTokens: 2451,
      reasoningTokens: 305,
      billableOutputTokens: 776,
    },
    usageRaw: {
      promptTokenCount: 1465,
      candidatesTokenCount: 471,
      thoughtsTokenCount: 305,
      toolUsePromptTokenCount: 210,
      totalTokenCount: 2451,
    },
    requestParams: {
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent',
      model: 'gemini-3.1-pro-preview',
    },
    searchAudit: buildFixtureSearchAudit('google', GAME_ID),
  });
});

test('google fake repair: clean fenced body with the repair response id — decisions identical to the valid build', async () => {
  const payload = payloadFor('google-gemini-3.1-pro-preview', 'gemini-3.1-pro-preview', GAME_ID);
  const result = await fake().get('google-gemini-3.1-pro-preview')!.chat(turnsFor(payload, { repair: true }), 5_000);
  assert.equal(result.rawText, fenced(JSON.stringify(buildValidResponse(payload))));
  assert.equal(result.providerResponseId, 'resp-fake-r-ffff');
  assert.equal(result.reportedModelId, 'gemini-3.1-pro-preview');
});

test('google fake under collision: the reported id echoes the openai arm — the identity check must catch it', async () => {
  const payload = payloadFor('google-gemini-3.1-pro-preview', 'gemini-3.1-pro-preview', GAME_ID);
  const result = await fake({ simulateCollision: true }).get('google-gemini-3.1-pro-preview')!.chat(turnsFor(payload), 5_000);
  assert.equal(result.reportedModelId, 'gpt-5.6-sol');
});

test('xai fake: rejects directly with the typed timeout the runner classifies', async () => {
  const payload = payloadFor('xai-grok-4.5', 'grok-4.5', GAME_ID);
  await assert.rejects(
    () => fake().get('xai-grok-4.5')!.chat(turnsFor(payload), 1_234),
    (e: unknown) => e instanceof ProviderTimeoutError,
  );
});
