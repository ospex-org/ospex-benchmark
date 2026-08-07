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
// openai (registry arm; Responses API; max_output_tokens; declared web search)
// ---------------------------------------------------------------------------

test('openai registry adapter: COMPLETE exact request, finite output-token param, verbatim usageRaw with reasoning kept a SUBSET', async () => {
  const cannedUsage = {
    input_tokens: 100,
    output_tokens: 40,
    total_tokens: 140,
    input_tokens_details: { cached_tokens: 25 },
    output_tokens_details: { reasoning_tokens: 16 },
  };
  const { result, calls } = await withEnv('OPENAI_API_KEY', SYNTHETIC_KEY, () =>
    withCannedFetch(
      () =>
        jsonResponse({
          id: 'resp_canned_1',
          model: 'gpt-5.6-sol',
          output: [
            {
              type: 'web_search_call',
              id: 'ws_canned_1',
              status: 'completed',
              action: {
                type: 'search',
                query: 'brewers pirates probable pitchers',
                sources: ['https://news.example/one'],
              },
            },
            {
              type: 'message',
              content: [
                { type: 'output_text', text: '{"ok":', annotations: [] },
                {
                  type: 'output_text',
                  text: 'true}',
                  annotations: [
                    {
                      type: 'url_citation',
                      url: 'https://news.example/one',
                      title: 'Source One',
                      start_index: 0,
                      end_index: 5,
                    },
                  ],
                },
              ],
            },
          ],
          usage: cannedUsage,
        }),
      () => registryAdapter('openai-gpt-5.6-sol').chat(TURNS, 5_000, { maxOutputTokens: 16_000 }),
    ),
  );
  // Exactly one controlled invocation, DEEP-EQUALED in full: url, method, the entire header
  // object, and the entire body — an undeclared extra request field is a failure here.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    url: 'https://api.openai.com/v1/responses',
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SYNTHETIC_KEY}` },
    body: {
      model: 'gpt-5.6-sol',
      input: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
      tools: [{ type: 'web_search' }],
      max_tool_calls: 5,
      include: ['web_search_call.action.sources'],
      max_output_tokens: 16_000,
    },
  });
  assert.ok(Number.isFinite((calls[0]!.body as { max_output_tokens: number }).max_output_tokens));
  // Parser ownership: output_text blocks concatenate in order (search-call items
  // carry no answer text); identity + VERBATIM usageRaw survive; the reasoning
  // bucket stays the subset it is (billable output stays 40, never 40 + 16).
  assert.equal(result.rawText, '{"ok":true}');
  assert.equal(result.reportedModelId, 'gpt-5.6-sol');
  assert.equal(result.providerResponseId, 'resp_canned_1');
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.usage, {
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
    reasoningTokens: 16,
    billableOutputTokens: 40,
  });
  assert.deepEqual(result.usageRaw, cannedUsage);
  // The audit trail: the executed query, the sourced URL (title-less), and the
  // titled citation; openai reports no usage-side search counter.
  assert.deepEqual(result.searchAudit, {
    queries: [{ query: 'brewers pirates probable pitchers' }],
    results: [
      { url: 'https://news.example/one', title: null },
      { url: 'https://news.example/one', title: 'Source One' },
    ],
    searchCount: null,
    incomplete: [],
  });
});

// ---------------------------------------------------------------------------
// xai (registry arm; Responses API; ADDITIVE reasoning; top-level citations)
// ---------------------------------------------------------------------------

test('xai registry adapter: COMPLETE exact request under max_output_tokens, verbatim usageRaw with the ADDITIVE reasoning bucket intact', async () => {
  // Additive semantics: total = input + output + reasoning (90 + 30 + 400 = 520) —
  // the arithmetic the parser uses to derive billableOutputTokens = 430. Only
  // usageRaw carries the additive bucket verbatim; dropping it would silently
  // undercount the dominant cost component.
  const cannedUsage = {
    input_tokens: 90,
    output_tokens: 30,
    total_tokens: 520,
    output_tokens_details: { reasoning_tokens: 400 },
    server_side_tool_usage_details: { web_search_calls: 1 },
    cost_in_usd_ticks: 5_000_000,
  };
  const { result, calls } = await withEnv('XAI_API_KEY', SYNTHETIC_KEY, () =>
    withCannedFetch(
      () =>
        jsonResponse({
          id: 'resp-canned-xai-1',
          model: 'grok-4.5',
          output: [
            {
              type: 'web_search_call',
              id: 'ws-xai-1',
              status: 'completed',
              action: { type: 'search', query: 'grok injury search' },
            },
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'grok says hi',
                  annotations: [
                    { type: 'url_citation', url: 'https://x.example/cited', title: '1', start_index: 0, end_index: 4 },
                  ],
                },
              ],
            },
          ],
          citations: ['https://x.example/cited', 'https://x.example/other'],
          usage: cannedUsage,
        }),
      () => registryAdapter('xai-grok-4.5').chat(TURNS, 5_000, { maxOutputTokens: 16_000 }),
    ),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    url: 'https://api.x.ai/v1/responses',
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SYNTHETIC_KEY}` },
    body: {
      model: 'grok-4.5',
      input: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
      tools: [{ type: 'web_search' }],
      max_tool_calls: 5,
      max_output_tokens: 16_000,
    },
  });
  assert.ok(Number.isFinite((calls[0]!.body as { max_output_tokens: number }).max_output_tokens));
  assert.equal(result.rawText, 'grok says hi');
  assert.deepEqual(result.usage, {
    inputTokens: 90,
    outputTokens: 30,
    totalTokens: 520,
    reasoningTokens: 400,
    billableOutputTokens: 430,
  });
  assert.deepEqual(result.usageRaw, cannedUsage);
  const raw = result.usageRaw as { output_tokens_details: { reasoning_tokens: number } };
  assert.equal(raw.output_tokens_details.reasoning_tokens, 400, 'the additive bucket survives verbatim');
  // The audit trail: the executed query, the titled inline citation, and the
  // flat citations list (deduped against the identical titled entry only when
  // url AND title match); the billable search counter is the provider's own.
  assert.deepEqual(result.searchAudit, {
    queries: [{ query: 'grok injury search' }],
    results: [
      { url: 'https://x.example/cited', title: '1' },
      { url: 'https://x.example/cited', title: null },
      { url: 'https://x.example/other', title: null },
    ],
    searchCount: 1,
    incomplete: [],
  });
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
    output_tokens_details: { thinking_tokens: 12 },
    server_tool_use: { web_search_requests: 1 },
  };
  const { result, calls } = await withEnv('ANTHROPIC_API_KEY', SYNTHETIC_KEY, () =>
    withCannedFetch(
      () =>
        jsonResponse({
          id: 'msg_canned_1',
          model: 'claude-fable-5',
          content: [
            {
              type: 'server_tool_use',
              id: 'srvtoolu_canned_1',
              name: 'web_search',
              input: { query: 'brewers lineup news' },
            },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_canned_1',
              content: [
                {
                  type: 'web_search_result',
                  url: 'https://news.example/anthropic',
                  title: 'Lineup notes',
                  page_age: 'August 6, 2026',
                  encrypted_content: 'opaque',
                },
              ],
            },
            { type: 'text', text: 'hello ' },
            {
              type: 'text',
              text: 'world',
              citations: [
                {
                  type: 'web_search_result_location',
                  url: 'https://news.example/anthropic',
                  title: 'Lineup notes',
                  encrypted_index: 'opaque',
                  cited_text: 'notes',
                },
              ],
            },
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
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    },
  });
  assert.ok(Number.isFinite((calls[0]!.body as { max_tokens: number }).max_tokens));
  assert.equal(result.rawText, 'hello world', 'text blocks concatenate; tool blocks carry no answer text');
  assert.equal(result.reportedModelId, 'claude-fable-5');
  // output_tokens stays the inclusive billable total (thinking is a SUBSET
  // breakdown, never added on top).
  assert.deepEqual(result.usage, {
    inputTokens: 80,
    outputTokens: 20,
    totalTokens: 100,
    reasoningTokens: 12,
    billableOutputTokens: 20,
  });
  // Cache fields are ADDITIVE billing buckets that only exist in the verbatim object.
  assert.deepEqual(result.usageRaw, cannedUsage);
  // The audit trail: the executed query, the result block, and the citation
  // (identical url+title deduped); the search counter is the provider's own.
  assert.deepEqual(result.searchAudit, {
    queries: [{ query: 'brewers lineup news' }],
    results: [{ url: 'https://news.example/anthropic', title: 'Lineup notes' }],
    searchCount: 1,
    incomplete: [],
  });
});

test('anthropic adapter: a max_uses_exceeded tool-result error object is recorded as an INCOMPLETE audit, never dropped', async () => {
  const { result } = await withEnv('ANTHROPIC_API_KEY', SYNTHETIC_KEY, () =>
    withCannedFetch(
      () =>
        jsonResponse({
          id: 'msg_canned_2',
          model: 'claude-fable-5',
          content: [
            {
              type: 'server_tool_use',
              id: 'srvtoolu_canned_2',
              name: 'web_search',
              input: { query: 'one query too many' },
            },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_canned_2',
              content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
            },
            { type: 'text', text: 'answer without that search' },
          ],
          usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
        }),
      () => registryAdapter('anthropic-claude-fable-5').chat(TURNS, 5_000, { maxOutputTokens: 16_000 }),
    ),
  );
  assert.deepEqual(result.searchAudit, {
    queries: [{ query: 'one query too many' }],
    results: [],
    searchCount: 1,
    incomplete: ['web_search_tool_result error: max_uses_exceeded'],
  });
});

test('anthropic adapter: a response with NO search activity carries searchAudit null — distinct from an empty audit', async () => {
  const { result } = await withEnv('ANTHROPIC_API_KEY', SYNTHETIC_KEY, () =>
    withCannedFetch(
      () =>
        jsonResponse({
          id: 'msg_canned_3',
          model: 'claude-fable-5',
          content: [{ type: 'text', text: 'no search needed' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      () => registryAdapter('anthropic-claude-fable-5').chat(TURNS, 5_000, { maxOutputTokens: 16_000 }),
    ),
  );
  assert.equal(result.searchAudit, null);
});

// ---------------------------------------------------------------------------
// google (registry arm; role mapping; generationConfig cap; ADDITIVE thoughts)
// ---------------------------------------------------------------------------

test('google registry adapter: COMPLETE exact request, finite generationConfig cap, verbatim usageMetadata with NONZERO thoughts', async () => {
  const cannedUsage = {
    promptTokenCount: 70,
    candidatesTokenCount: 10,
    thoughtsTokenCount: 900,
    toolUsePromptTokenCount: 40,
    totalTokenCount: 1_020,
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
              groundingMetadata: {
                webSearchQueries: ['brewers pirates weather', 'pnc park wind august 7'],
                searchEntryPoint: { renderedContent: '<div>widget</div>' },
                groundingChunks: [
                  { web: { uri: 'https://vertexaisearch.cloud.google.com/redirect-1', title: 'weather.example' } },
                ],
                groundingSupports: [
                  { segment: { startIndex: 0, endIndex: 10, text: 'the answer' }, groundingChunkIndices: [0] },
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
      tools: [{ google_search: {} }],
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
  // ADDITIVE thoughts bucket and the tool-use prompt bucket — the only place they survive.
  assert.deepEqual(result.usage, {
    inputTokens: 70,
    outputTokens: 10,
    totalTokens: 1_020,
    reasoningTokens: 900,
    billableOutputTokens: 910,
  });
  assert.deepEqual(result.usageRaw, cannedUsage);
  assert.equal((result.usageRaw as { thoughtsTokenCount: number }).thoughtsTokenCount, 900);
  // The audit trail: every executed query and the (redirect-URI) source chunk;
  // google reports no usage-side search counter.
  assert.deepEqual(result.searchAudit, {
    queries: [{ query: 'brewers pirates weather' }, { query: 'pnc park wind august 7' }],
    results: [{ url: 'https://vertexaisearch.cloud.google.com/redirect-1', title: 'weather.example' }],
    searchCount: null,
    incomplete: [],
  });
});

test('google adapter: grounding metadata MISSING while tool-use tokens prove a search ran is an INCOMPLETE audit, not a silent null', async () => {
  const { result } = await withEnv('GEMINI_API_KEY', SYNTHETIC_KEY, () =>
    withCannedFetch(
      () =>
        jsonResponse({
          responseId: 'resp-canned-2',
          modelVersion: 'gemini-3.1-pro-preview',
          candidates: [{ content: { parts: [{ text: 'grounded answer, metadata dropped' }] } }],
          usageMetadata: {
            promptTokenCount: 70,
            candidatesTokenCount: 10,
            thoughtsTokenCount: 5,
            toolUsePromptTokenCount: 33,
            totalTokenCount: 118,
          },
        }),
      () => registryAdapter('google-gemini-3.1-pro-preview').chat(TURNS, 5_000, { maxOutputTokens: 16_000 }),
    ),
  );
  assert.deepEqual(result.searchAudit, {
    queries: [],
    results: [],
    searchCount: null,
    incomplete: ['groundingMetadata missing while toolUsePromptTokenCount > 0'],
  });
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
