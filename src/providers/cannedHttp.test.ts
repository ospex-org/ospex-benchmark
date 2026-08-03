import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderHttpError, ProviderTimeoutError } from './errors.js';
import { ARMS, createRealAdapters } from './index.js';
import type { ChatTurn, ProviderAdapter } from '../types.js';

/**
 * CANNED-HTTP parser ownership for each REAL provider adapter, exercised through the
 * PRODUCTION registry: every adapter under test comes from `createRealAdapters()` — never a
 * reconstructed factory config — so a miswired registry entry (wrong endpoint, wrong
 * output-token parameter name) fails here, not in production. Provider-shaped JSON is
 * driven through the ACTUAL request builder and response parser via a controlled
 * `globalThis.fetch` sentinel; no network is reachable (the sentinel is the only fetch and
 * every test asserts exactly the expected invocations).
 *
 * Request assertions DEEP-EQUAL the COMPLETE recorded call — exact URL, method, the entire
 * header object, and the entire parsed body — so an undeclared extra field (e.g. a sampling
 * override) is a failure, not a silent addition. Response assertions own FULL verbatim
 * `usageRaw` preservation: google's nonzero `thoughtsTokenCount` survives, xai's ADDITIVE
 * reasoning bucket survives, openai's reasoning stays a subset (preserved, never re-added),
 * anthropic's cache fields survive. 429 and timeout surface as the typed errors the runner
 * classifies. Credentials are synthetic values set per test — never real keys.
 */

const TURNS: ChatTurn[] = [
  { role: 'system', content: 'system prompt' },
  { role: 'user', content: 'user prompt' },
];

const SYNTHETIC_KEY = 'synthetic-test-credential';

interface RecordedCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

/** The production registry adapter for one canonical participant — the ONLY construction
 *  path these tests accept. */
function registryAdapter(participantId: string): ProviderAdapter {
  const adapter = createRealAdapters().get(participantId);
  if (adapter === undefined) throw new Error(`production registry has no adapter for ${participantId}`);
  return adapter;
}

/** Swap `globalThis.fetch` for a canned responder for the duration of `fn`; record every
 *  call COMPLETELY (url, method, full headers, full parsed body); ALWAYS restore. */
async function withCannedFetch<T>(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<T>,
): Promise<{ result: T; calls: RecordedCall[] }> {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      method: init?.method,
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    return respond(url, init ?? {});
  }) as typeof fetch;
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** Set a synthetic credential for the duration of `fn`; ALWAYS restore the prior value. */
async function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// the production registry itself
// ---------------------------------------------------------------------------

test('createRealAdapters() rosters exactly the four canonical arms with exact identities', () => {
  const adapters = createRealAdapters();
  assert.deepEqual(
    [...adapters.keys()].sort(),
    ARMS.map((a) => a.participantId).sort(),
    'the registry rosters exactly the canonical participant ids',
  );
  for (const arm of ARMS) {
    const adapter = adapters.get(arm.participantId)!;
    assert.equal(adapter.provider, arm.provider);
    assert.equal(adapter.requestedModelId, arm.requestedModelId);
    assert.equal(adapter.credentialEnvVar, arm.credentialEnvVar);
  }
});

// ---------------------------------------------------------------------------
// openai (registry arm; max_completion_tokens)
// ---------------------------------------------------------------------------

test('openai registry adapter: COMPLETE exact request, finite output-token param, verbatim usageRaw with reasoning kept a SUBSET', async () => {
  const cannedUsage = {
    prompt_tokens: 100,
    completion_tokens: 40,
    total_tokens: 140,
    prompt_tokens_details: { cached_tokens: 25 },
    completion_tokens_details: { reasoning_tokens: 16 },
  };
  const { result, calls } = await withEnv('OPENAI_API_KEY', SYNTHETIC_KEY, () =>
    withCannedFetch(
      () =>
        jsonResponse({
          id: 'chatcmpl-canned-1',
          model: 'gpt-5.6-sol',
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: cannedUsage,
        }),
      () => registryAdapter('openai-gpt-5.6-sol').chat(TURNS, 5_000, { maxOutputTokens: 16_000 }),
    ),
  );
  // Exactly one controlled invocation, DEEP-EQUALED in full: url, method, the entire header
  // object, and the entire body — an undeclared extra request field is a failure here.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    url: 'https://api.openai.com/v1/chat/completions',
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SYNTHETIC_KEY}` },
    body: {
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
      max_completion_tokens: 16_000,
    },
  });
  assert.ok(Number.isFinite((calls[0]!.body as { max_completion_tokens: number }).max_completion_tokens));
  // Parser ownership: text, identity, and VERBATIM usageRaw — the reasoning bucket
  // survives as the subset it is (normalized output stays 40, never 40 + 16).
  assert.equal(result.rawText, '{"ok":true}');
  assert.equal(result.reportedModelId, 'gpt-5.6-sol');
  assert.equal(result.providerResponseId, 'chatcmpl-canned-1');
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 40, totalTokens: 140 });
  assert.deepEqual(result.usageRaw, cannedUsage);
});

// ---------------------------------------------------------------------------
// xai (registry arm; max_tokens; ADDITIVE reasoning)
// ---------------------------------------------------------------------------

test('xai registry adapter: COMPLETE exact request under max_tokens, verbatim usageRaw with the ADDITIVE reasoning bucket intact', async () => {
  // Additive semantics: total = prompt + completion + reasoning (90 + 30 + 400 = 520).
  // Only usageRaw carries the additive bucket — dropping it would silently undercount
  // the dominant cost component, which is exactly what verbatim preservation prevents.
  const cannedUsage = {
    prompt_tokens: 90,
    completion_tokens: 30,
    total_tokens: 520,
    completion_tokens_details: { reasoning_tokens: 400 },
  };
  const { result, calls } = await withEnv('XAI_API_KEY', SYNTHETIC_KEY, () =>
    withCannedFetch(
      () =>
        jsonResponse({
          id: 'canned-xai-1',
          model: 'grok-4.5',
          choices: [{ message: { content: 'grok says hi' } }],
          usage: cannedUsage,
        }),
      () => registryAdapter('xai-grok-4.5').chat(TURNS, 5_000, { maxOutputTokens: 16_000 }),
    ),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    url: 'https://api.x.ai/v1/chat/completions',
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SYNTHETIC_KEY}` },
    body: {
      model: 'grok-4.5',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
      max_tokens: 16_000,
    },
  });
  assert.ok(Number.isFinite((calls[0]!.body as { max_tokens: number }).max_tokens));
  assert.deepEqual(result.usage, { inputTokens: 90, outputTokens: 30, totalTokens: 520 });
  assert.deepEqual(result.usageRaw, cannedUsage);
  const raw = result.usageRaw as { completion_tokens_details: { reasoning_tokens: number } };
  assert.equal(raw.completion_tokens_details.reasoning_tokens, 400, 'the additive bucket survives verbatim');
});

// ---------------------------------------------------------------------------
// anthropic (registry arm; system split; always-set max_tokens; cache fields)
// ---------------------------------------------------------------------------

test('anthropic registry adapter: COMPLETE exact request, finite max_tokens, verbatim usageRaw with BOTH cache fields', async () => {
  const cannedUsage = {
    input_tokens: 80,
    output_tokens: 20,
    cache_creation_input_tokens: 64,
    cache_read_input_tokens: 512,
  };
  const { result, calls } = await withEnv('ANTHROPIC_API_KEY', SYNTHETIC_KEY, () =>
    withCannedFetch(
      () =>
        jsonResponse({
          id: 'msg_canned_1',
          model: 'claude-fable-5',
          content: [
            { type: 'text', text: 'hello ' },
            { type: 'text', text: 'world' },
          ],
          usage: cannedUsage,
        }),
      () => registryAdapter('anthropic-claude-fable-5').chat(TURNS, 5_000, { maxOutputTokens: 16_000 }),
    ),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': SYNTHETIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: 'claude-fable-5',
      max_tokens: 16_000,
      system: 'system prompt',
      messages: [{ role: 'user', content: 'user prompt' }],
    },
  });
  assert.ok(Number.isFinite((calls[0]!.body as { max_tokens: number }).max_tokens));
  assert.equal(result.rawText, 'hello world', 'text blocks concatenate');
  assert.equal(result.reportedModelId, 'claude-fable-5');
  assert.deepEqual(result.usage, { inputTokens: 80, outputTokens: 20, totalTokens: 100 });
  // Cache fields are ADDITIVE billing buckets that only exist in the verbatim object.
  assert.deepEqual(result.usageRaw, cannedUsage);
});

// ---------------------------------------------------------------------------
// google (registry arm; role mapping; generationConfig cap; ADDITIVE thoughts)
// ---------------------------------------------------------------------------

test('google registry adapter: COMPLETE exact request, finite generationConfig cap, verbatim usageMetadata with NONZERO thoughts', async () => {
  const cannedUsage = {
    promptTokenCount: 70,
    candidatesTokenCount: 10,
    thoughtsTokenCount: 900,
    totalTokenCount: 980,
  };
  const turns: ChatTurn[] = [...TURNS, { role: 'assistant', content: 'earlier answer' }];
  const { result, calls } = await withEnv('GEMINI_API_KEY', SYNTHETIC_KEY, () =>
    withCannedFetch(
      () =>
        jsonResponse({
          responseId: 'resp-canned-1',
          modelVersion: 'gemini-3.1-pro-preview',
          candidates: [
            {
              content: {
                parts: [
                  { text: 'internal deliberation', thought: true },
                  { text: 'the answer' },
                ],
              },
            },
          ],
          usageMetadata: cannedUsage,
        }),
      () => registryAdapter('google-gemini-3.1-pro-preview').chat(turns, 5_000, { maxOutputTokens: 16_000 }),
    ),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': SYNTHETIC_KEY },
    body: {
      systemInstruction: { parts: [{ text: 'system prompt' }] },
      contents: [
        { role: 'user', parts: [{ text: 'user prompt' }] },
        { role: 'model', parts: [{ text: 'earlier answer' }] },
      ],
      generationConfig: { maxOutputTokens: 16_000 },
    },
  });
  assert.ok(
    Number.isFinite((calls[0]!.body as { generationConfig: { maxOutputTokens: number } }).generationConfig.maxOutputTokens),
  );
  assert.equal(result.rawText, 'the answer', 'thought parts are excluded from answer text');
  assert.equal(result.reportedModelId, 'gemini-3.1-pro-preview');
  assert.equal(result.providerResponseId, 'resp-canned-1');
  // The typed parse reads only three counts; the verbatim runtime object must retain the
  // ADDITIVE thoughts bucket — this is the only place it survives.
  assert.deepEqual(result.usage, { inputTokens: 70, outputTokens: 10, totalTokens: 980 });
  assert.deepEqual(result.usageRaw, cannedUsage);
  assert.equal((result.usageRaw as { thoughtsTokenCount: number }).thoughtsTokenCount, 900);
});

// ---------------------------------------------------------------------------
// classification shapes: 429 and timeout, per typed error, through the registry
// ---------------------------------------------------------------------------

test('an HTTP 429 surfaces as ProviderHttpError with status 429 (the rate_limited classification shape)', async () => {
  await withEnv('OPENAI_API_KEY', SYNTHETIC_KEY, async () => {
    await withCannedFetch(
      () => new Response('slow down', { status: 429 }),
      async () => {
        await assert.rejects(
          () => registryAdapter('openai-gpt-5.6-sol').chat(TURNS, 5_000, { maxOutputTokens: 16_000 }),
          (e: unknown) => e instanceof ProviderHttpError && e.status === 429,
        );
        return null;
      },
    );
  });
});

test('an aborted call surfaces as ProviderTimeoutError (the timeout classification shape)', async () => {
  await withEnv('ANTHROPIC_API_KEY', SYNTHETIC_KEY, async () => {
    await withCannedFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          // Never respond; reject only when the adapter's own timeout aborts the signal.
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      async () => {
        await assert.rejects(
          () => registryAdapter('anthropic-claude-fable-5').chat(TURNS, 30, { maxOutputTokens: 16_000 }),
          (e: unknown) => e instanceof ProviderTimeoutError,
        );
        return null;
      },
    );
  });
});
