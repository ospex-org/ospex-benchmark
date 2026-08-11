import { googleApiKey } from '../config.js';
import { postJson } from './http.js';
import { ProviderUnfinishedTurnError } from './errors.js';
import { TOOL_INFERENCE_CONFIG } from '../toolInferenceConfig.js';
import { deriveComparableUsage } from './comparableUsage.js';
import { extractGoogleSearchAudit } from './searchAudit.js';
import { buildRequestPlan } from './requestPlan.js';
import type { ProviderRequestPlan } from './requestPlan.js';
import type {
  ChatTurn,
  ProviderAdapter,
  ProviderCallOptions,
  ProviderResponse,
  ProviderUsage,
} from '../types.js';

const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// The declared Google Search grounding tool (tools-v1). Google exposes no
// cap parameter — the model decides how many queries run; the audit records
// the executed queries and the tool-use token bucket evidences that one ran.
const WEB_SEARCH = TOOL_INFERENCE_CONFIG.webSearch.google;

/**
 * The request this adapter would send, built without sending it. See
 * `anthropicRequestPlan` for why the builder is exported.
 *
 * Note the shape of the evidence this produces: `maxOutputTokens` is recorded
 * where it actually lives on the wire, inside `generationConfig`, rather than
 * re-flattened to a top-level key it never had. That nesting is also what
 * makes `generationConfig` usable by a configuration — a participant may add
 * `generationConfig.thinkingConfig` beside the cohort's cap, and is refused if
 * it tries to set the cap itself.
 */
export function googleRequestPlan(args: {
  requestedModelId: string;
  turns: ChatTurn[];
  options?: ProviderCallOptions | undefined;
}): ProviderRequestPlan {
  const system = args.turns.find((t) => t.role === 'system')?.content ?? '';
  const contents = args.turns
    .filter((t) => t.role !== 'system')
    .map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.content }],
    }));
  // A repair carries no declared tools (format-only, may not search).
  const withTools = (args.options?.tools ?? 'declared') === 'declared';
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
  };
  if (withTools) body['tools'] = [WEB_SEARCH.tool];
  if (args.options?.maxOutputTokens !== undefined) {
    body['generationConfig'] = { maxOutputTokens: args.options.maxOutputTokens };
  }
  return buildRequestPlan({
    // Key travels in a header, never in the URL, so it cannot leak into
    // recorded request params or error messages.
    endpoint: `${GOOGLE_BASE}/${args.requestedModelId}:generateContent`,
    body,
    configuration: args.options?.configuration ?? {},
    promptKeys: ['systemInstruction', 'contents'],
    // Gemini names the model in the URL rather than the body; it is recorded
    // because which model was asked for is the point of the record.
    recordedNonBody: { model: args.requestedModelId },
  });
}

export function createGoogleAdapter(requestedModelId: string): ProviderAdapter {
  return {
    provider: 'google',
    requestedModelId,
    // GOOGLE_API_KEY is accepted as a fallback name (see config.googleApiKey).
    credentialEnvVar: 'GEMINI_API_KEY',
    hasCredential(): boolean {
      return googleApiKey() !== undefined;
    },
    async chat(
      turns: ChatTurn[],
      timeoutMs: number,
      options?: ProviderCallOptions,
    ): Promise<ProviderResponse> {
      const apiKey = googleApiKey();
      if (apiKey === undefined) throw new Error('GEMINI_API_KEY / GOOGLE_API_KEY is not set');
      const plan = googleRequestPlan({ requestedModelId, turns, options });
      const url = plan.endpoint;
      const { status, json: raw } = await postJson({
        provider: 'google',
        url,
        headers: { 'x-goog-api-key': apiKey },
        body: plan.body,
        timeoutMs,
      });
      const json = raw as {
        responseId?: unknown;
        modelVersion?: unknown;
        candidates?: Array<{
          content?: { parts?: Array<{ text?: unknown; thought?: unknown }> };
          finishReason?: unknown;
        }>;
        promptFeedback?: { blockReason?: unknown };
        usageMetadata?: {
          promptTokenCount?: unknown;
          candidatesTokenCount?: unknown;
          totalTokenCount?: unknown;
        };
      };

      const parts = json.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts)
        ? parts
            // Thinking models may emit thought parts; only answer text counts.
            .filter((p) => typeof p.text === 'string' && p.thought !== true)
            .map((p) => p.text as string)
            .join('')
        : '';
      const comparable = deriveComparableUsage('google', json.usageMetadata ?? null);
      const usage: ProviderUsage = {
        inputTokens:
          typeof json.usageMetadata?.promptTokenCount === 'number'
            ? json.usageMetadata.promptTokenCount
            : null,
        outputTokens:
          typeof json.usageMetadata?.candidatesTokenCount === 'number'
            ? json.usageMetadata.candidatesTokenCount
            : null,
        totalTokens:
          typeof json.usageMetadata?.totalTokenCount === 'number'
            ? json.usageMetadata.totalTokenCount
            : null,
        reasoningTokens: comparable.reasoningTokens,
        billableOutputTokens: comparable.billableOutputTokens,
      };
      const requestParams = plan.requestParams;

      // Terminal state: only `finishReason: "STOP"` on the first candidate is a
      // finished turn. `MAX_TOKENS`, `TOO_MANY_TOOL_CALLS`, safety/recitation
      // stops, any other value, a missing field, or a blocked prompt with no
      // candidate at all is HTTP 200 with empty or truncated content — typed as
      // an unfinished turn carrying the call's full evidence (status, ids,
      // partial text, usage, audit), so it is never scored as the model's
      // invalid JSON, nor accepted as its answer.
      const blockReason =
        typeof json.promptFeedback?.blockReason === 'string' ? json.promptFeedback.blockReason : null;
      const finishReason =
        typeof json.candidates?.[0]?.finishReason === 'string'
          ? json.candidates[0].finishReason
          : blockReason !== null
            ? `blocked:${blockReason}`
            : 'missing';
      if (finishReason !== 'STOP') {
        const detail =
          finishReason === 'MAX_TOKENS'
            ? 'the response hit its maxOutputTokens cap before finishing'
            : finishReason === 'TOO_MANY_TOOL_CALLS'
              ? 'the provider terminated the server-side tool loop before the turn finished'
              : blockReason !== null && json.candidates?.[0] === undefined
                ? 'the prompt was blocked by the provider before any candidate was produced'
                : `the provider reported finishReason "${finishReason}", not "STOP"`;
        throw new ProviderUnfinishedTurnError({
          provider: 'google',
          stopReason: finishReason,
          detail,
          httpStatus: status,
          providerResponseId: typeof json.responseId === 'string' ? json.responseId : null,
          reportedModelId: typeof json.modelVersion === 'string' ? json.modelVersion : null,
          rawText: text,
          usage,
          usageRaw: json.usageMetadata ?? null,
          searchAudit: extractGoogleSearchAudit(raw),
          requestParams,
        });
      }

      return {
        rawText: text,
        reportedModelId: typeof json.modelVersion === 'string' ? json.modelVersion : null,
        providerResponseId: typeof json.responseId === 'string' ? json.responseId : null,
        httpStatus: status,
        usage,
        usageRaw: json.usageMetadata ?? null,
        requestParams,
        searchAudit: extractGoogleSearchAudit(raw),
      };
    },
  };
}
