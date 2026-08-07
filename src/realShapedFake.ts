import {
  INVALID_SCHEMA_GAME_ID,
  RATE_LIMITED_GAME_ID,
  buildFixtureSearchAudit,
  buildSchemaInvalidResponse,
  buildValidResponse,
  parseRequestPayload,
} from './mock.js';
import { ProviderHttpError, ProviderTimeoutError } from './providers/errors.js';
import { deriveComparableUsage } from './providers/comparableUsage.js';
import type { ProviderAdapter, ProviderResponse, ProviderUsage, SearchAudit } from './types.js';

/**
 * The REAL-SHAPED, zero-network fake adapters: the same deterministic decisions and the
 * same scenario outcomes as the mock (valid everywhere; HTTP 429 on the throttle fixture;
 * schema-invalid on the corruption fixture; a prose+fenced wrong-cohort echo on every
 * first google attempt, repaired cleanly; typed xai timeout) — but wrapped in a REALISTIC
 * provider envelope: provider-formatted response ids, provider-true verbatim `usageRaw`
 * shapes (openai reasoning as a SUBSET bucket plus cached prompt tokens; anthropic cache
 * fields; google additive `thoughtsTokenCount`), and model-echo metadata, with response
 * text that wraps the same JSON the way real models actually deliver it (fences, prose).
 *
 * ZERO network by construction: no import of the HTTP layer, no `fetch` reference — a
 * network sentinel test drives a whole fire under a throwing `globalThis.fetch` to prove
 * the seam is never touched. Normalized token counts are IDENTICAL to the mock's, so a
 * dry-vs-real-shaped parity artifact differs only in the allow-listed leaves (response
 * text and its derived digests, timing). This fake COMPLEMENTS the canned-HTTP tests that
 * own the REAL adapters' parsers — a cooperating fake cannot prove a real parser preserves
 * billing fields, and the canned tests cannot exercise a whole fire without spend.
 */

export interface RealShapedFakeOptions {
  /** When true, the google arm echoes the openai arm's model id — the model-identity
   *  collision the fail-closed reported-id check must refuse. */
  readonly simulateCollision: boolean;
  /** When set, the openai arm answers HTTP 429 for THIS gameId too (the fixture throttle
   *  game always 429s, mirroring the mock) — lets a single-game fire exercise the
   *  rate-limit classification without the fixture slate. */
  readonly rateLimitedGameId?: string;
}

function response(options: {
  rawText: string;
  reportedModelId: string;
  responseId: string;
  requestedModelId: string;
  endpoint: string;
  usage: ProviderUsage;
  usageRaw: unknown;
  searchAudit: SearchAudit | null;
}): ProviderResponse {
  return {
    rawText: options.rawText,
    reportedModelId: options.reportedModelId,
    providerResponseId: options.responseId,
    httpStatus: 200,
    usage: options.usage,
    usageRaw: options.usageRaw,
    requestParams: { endpoint: options.endpoint, model: options.requestedModelId },
    searchAudit: options.searchAudit,
  };
}

/** Normalized counts + the SAME derived comparable fields the mock computes
 *  (both sides run the one shared derivation, so parity holds byte-for-byte). */
function usageWith(
  provider: 'openai' | 'anthropic' | 'google',
  usageRaw: unknown,
  base: { inputTokens: number; outputTokens: number; totalTokens: number },
): ProviderUsage {
  const comparable = deriveComparableUsage(provider, usageRaw);
  return {
    ...base,
    reasoningTokens: comparable.reasoningTokens,
    billableOutputTokens: comparable.billableOutputTokens,
  };
}

/** Wrap a body the way chat models actually deliver JSON: a fenced block with a preamble. */
function fenced(json: string): string {
  return `\`\`\`json\n${json}\n\`\`\``;
}

export function createRealShapedFakeAdapters(options: RealShapedFakeOptions): Map<string, ProviderAdapter> {
  const adapters = new Map<string, ProviderAdapter>();

  adapters.set('openai-gpt-5.6-sol', {
    provider: 'openai',
    requestedModelId: 'gpt-5.6-sol',
    credentialEnvVar: 'OPENAI_API_KEY',
    hasCredential: () => true,
    async chat(turns): Promise<ProviderResponse> {
      const { payload, gameId } = parseRequestPayload(turns);
      if (gameId === RATE_LIMITED_GAME_ID || gameId === options.rateLimitedGameId) {
        throw new ProviderHttpError('openai', 429, 'simulated throttle (real-shaped fake)');
      }
      // usageRaw in openai's true Responses-API shape (the live adapter's
      // surface) — reasoning is a SUBSET of output_tokens, cached a subset of
      // input_tokens. Normalized counts IDENTICAL to the mock (parity).
      const usageRaw = {
        input_tokens: 1490,
        output_tokens: 512,
        total_tokens: 2002,
        input_tokens_details: { cached_tokens: 128 },
        output_tokens_details: { reasoning_tokens: 256 },
      };
      return response({
        rawText: fenced(JSON.stringify(buildValidResponse(payload))),
        reportedModelId: 'gpt-5.6-sol',
        responseId: `resp_fake${gameId.slice(-4)}`,
        requestedModelId: 'gpt-5.6-sol',
        endpoint: 'https://api.openai.com/v1/responses',
        usage: usageWith('openai', usageRaw, { inputTokens: 1490, outputTokens: 512, totalTokens: 2002 }),
        usageRaw,
        searchAudit: buildFixtureSearchAudit('openai', gameId),
      });
    },
  });

  adapters.set('anthropic-claude-fable-5', {
    provider: 'anthropic',
    requestedModelId: 'claude-fable-5',
    credentialEnvVar: 'ANTHROPIC_API_KEY',
    hasCredential: () => true,
    async chat(turns): Promise<ProviderResponse> {
      const { payload, gameId } = parseRequestPayload(turns);
      const body =
        gameId === INVALID_SCHEMA_GAME_ID
          ? buildSchemaInvalidResponse(payload)
          : buildValidResponse(payload);
      // Anthropic's true shape: cache fields present and ADDITIVE (outside
      // input_tokens); thinking a read-only SUBSET breakdown of output_tokens;
      // the search counter under usage.server_tool_use.
      const usageRaw = {
        input_tokens: 1512,
        output_tokens: 498,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens_details: { thinking_tokens: 120 },
        server_tool_use: { web_search_requests: 1 },
      };
      return response({
        rawText: fenced(JSON.stringify(body)),
        reportedModelId: 'claude-fable-5',
        responseId: `msg_fake${gameId.slice(-4)}`,
        requestedModelId: 'claude-fable-5',
        endpoint: 'https://api.anthropic.com/v1/messages',
        usage: usageWith('anthropic', usageRaw, { inputTokens: 1512, outputTokens: 498, totalTokens: 2010 }),
        usageRaw,
        searchAudit: buildFixtureSearchAudit('anthropic', gameId),
      });
    },
  });

  adapters.set('google-gemini-3.1-pro-preview', {
    provider: 'google',
    requestedModelId: 'gemini-3.1-pro-preview',
    credentialEnvVar: 'GEMINI_API_KEY',
    hasCredential: () => true,
    async chat(turns): Promise<ProviderResponse> {
      const { payload, isRepair, gameId } = parseRequestPayload(turns);
      const reported = options.simulateCollision ? 'gpt-5.6-sol' : 'gemini-3.1-pro-preview';
      // Google's true verbatim shape: thoughts are a SEPARATE ADDITIVE bucket,
      // and grounded search results a separate tool-use prompt bucket the
      // total includes (2241 base + 210 tool-use).
      const usageRaw = {
        promptTokenCount: 1465,
        candidatesTokenCount: 471,
        thoughtsTokenCount: 305,
        toolUsePromptTokenCount: 210,
        totalTokenCount: 2451,
      };
      const usage = usageWith('google', usageRaw, {
        inputTokens: 1465,
        outputTokens: 471,
        totalTokens: 2451,
      });
      const endpoint =
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent';
      if (isRepair) {
        // The repair fixes only the echo; decisions are byte-identical (fingerprint-preserving).
        return response({
          rawText: fenced(JSON.stringify(buildValidResponse(payload))),
          reportedModelId: reported,
          responseId: `resp-fake-r-${gameId.slice(-4)}`,
          requestedModelId: 'gemini-3.1-pro-preview',
          endpoint,
          usage,
          usageRaw,
          searchAudit: buildFixtureSearchAudit('google', gameId),
        });
      }
      // Initial attempt: the SAME wrong-cohort-echo scenario as the mock, in different prose.
      const wrongEcho = { ...buildValidResponse(payload), cohortId: 'fake-wrong-cohort' };
      return response({
        rawText: `Forecast batch follows.\n${fenced(JSON.stringify(wrongEcho))}\nEnd of batch.`,
        reportedModelId: reported,
        responseId: `resp-fake-${gameId.slice(-4)}`,
        requestedModelId: 'gemini-3.1-pro-preview',
        endpoint,
        usage,
        usageRaw,
        searchAudit: buildFixtureSearchAudit('google', gameId),
      });
    },
  });

  adapters.set('xai-grok-4.5', {
    provider: 'xai',
    requestedModelId: 'grok-4.5',
    credentialEnvVar: 'XAI_API_KEY',
    hasCredential: () => true,
    async chat(_turns, timeoutMs): Promise<ProviderResponse> {
      // Model the mock's timeout outcome without a wall-clock wait. Timing is an
      // allow-listed parity leaf; classification comes from the typed error.
      throw new ProviderTimeoutError('xai', timeoutMs);
    },
  });

  return adapters;
}
