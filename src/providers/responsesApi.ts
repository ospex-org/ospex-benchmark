import { envValue } from '../config.js';
import { postJson } from './http.js';
import { deriveComparableUsage } from './comparableUsage.js';
import { extractResponsesSearchAudit } from './searchAudit.js';
import type {
  ChatTurn,
  ProviderAdapter,
  ProviderCallOptions,
  ProviderName,
  ProviderResponse,
  ProviderUsage,
} from '../types.js';

/**
 * Adapter for Responses-API providers (OpenAI itself and xAI's Agent Tools
 * surface). This replaced the chat-completions adapter when provider web
 * search was enabled: neither provider serves server-side web search on
 * chat completions for these arms (openai gates it to specialized search
 * models there; xai retired chat-completions Live Search upstream), and the
 * Responses API is also the only surface that reports the EXECUTED search
 * queries (`web_search_call` output items) the audit trail requires.
 *
 * Requests stay minimal beyond the declared tool section: model + input
 * turns + the registry-selected caps — no sampling overrides, so
 * reasoning-model parameter restrictions cannot reject the call.
 */
export function createResponsesApiAdapter(config: {
  provider: ProviderName;
  requestedModelId: string;
  credentialEnvVar: string;
  baseUrl: string;
  /** Registry-selected output-cap field. Keeping it explicit makes upstream contract drift
   *  visible in the complete-wire canned tests and straightforward to update. */
  maxTokensParam: string;
  /** The declared web-search tool entry (tools-v1), sent verbatim in `tools`. */
  webSearchTool: Record<string, unknown>;
  /** The declared cap on server-side tool calls (`max_tool_calls`). */
  maxToolCalls: number;
  /** Extra `include` entries (openai: web_search_call.action.sources). */
  include?: readonly string[] | undefined;
}): ProviderAdapter {
  return {
    provider: config.provider,
    requestedModelId: config.requestedModelId,
    credentialEnvVar: config.credentialEnvVar,
    hasCredential(): boolean {
      return envValue(config.credentialEnvVar) !== undefined;
    },
    async chat(
      turns: ChatTurn[],
      timeoutMs: number,
      options?: ProviderCallOptions,
    ): Promise<ProviderResponse> {
      const apiKey = envValue(config.credentialEnvVar);
      if (apiKey === undefined) throw new Error(`${config.credentialEnvVar} is not set`);
      const url = `${config.baseUrl}/responses`;
      const requestBody: Record<string, unknown> = {
        model: config.requestedModelId,
        input: turns.map((t) => ({ role: t.role, content: t.content })),
        tools: [config.webSearchTool],
        max_tool_calls: config.maxToolCalls,
      };
      if (config.include !== undefined && config.include.length > 0) {
        requestBody['include'] = [...config.include];
      }
      if (options?.maxOutputTokens !== undefined) {
        requestBody[config.maxTokensParam] = options.maxOutputTokens;
      }
      const { status, json: raw } = await postJson({
        provider: config.provider,
        url,
        headers: { authorization: `Bearer ${apiKey}` },
        body: requestBody,
        timeoutMs,
      });
      const json = raw as {
        id?: unknown;
        model?: unknown;
        output?: Array<{ type?: unknown; content?: Array<{ type?: unknown; text?: unknown }> }>;
        usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown };
      };

      // The answer text: every `output_text` block of every `message` output
      // item, in order (search-call items and annotations carry no answer text).
      const rawText = Array.isArray(json.output)
        ? json.output
            .filter((item) => item.type === 'message' && Array.isArray(item.content))
            .flatMap((item) => item.content ?? [])
            .filter((block) => block.type === 'output_text' && typeof block.text === 'string')
            .map((block) => block.text as string)
            .join('')
        : '';
      const comparable = deriveComparableUsage(config.provider, json.usage ?? null);
      const usage: ProviderUsage = {
        inputTokens: typeof json.usage?.input_tokens === 'number' ? json.usage.input_tokens : null,
        outputTokens:
          typeof json.usage?.output_tokens === 'number' ? json.usage.output_tokens : null,
        totalTokens: typeof json.usage?.total_tokens === 'number' ? json.usage.total_tokens : null,
        reasoningTokens: comparable.reasoningTokens,
        billableOutputTokens: comparable.billableOutputTokens,
      };
      const requestParams: Record<string, unknown> = {
        endpoint: url,
        model: config.requestedModelId,
        tools: [config.webSearchTool],
        max_tool_calls: config.maxToolCalls,
      };
      if (config.include !== undefined && config.include.length > 0) {
        requestParams['include'] = [...config.include];
      }
      if (options?.maxOutputTokens !== undefined) {
        requestParams[config.maxTokensParam] = options.maxOutputTokens;
      }
      return {
        rawText,
        reportedModelId: typeof json.model === 'string' ? json.model : null,
        providerResponseId: typeof json.id === 'string' ? json.id : null,
        httpStatus: status,
        usage,
        usageRaw: json.usage ?? null,
        requestParams,
        searchAudit: extractResponsesSearchAudit(raw),
      };
    },
  };
}
