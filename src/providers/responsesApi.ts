import { envValue, redactAndTruncate } from '../config.js';
import { postJson } from './http.js';
import { ProviderUnfinishedTurnError } from './errors.js';
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
  /**
   * The provider's OWN documented request-side bound on agentic tool use —
   * `max_tool_calls` for OpenAI, `max_turns` for xAI (whose request parameters
   * do not include `max_tool_calls`). Registry-selected for the same reason as
   * the output-cap field: an undocumented parameter name is a live 400 or a
   * silently uncapped run, and keeping it explicit makes upstream drift visible
   * in the complete-wire canned tests.
   */
  toolCapParam: string;
  toolCapValue: number;
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
      // A repair carries no declared tools, so the tool block, its cap, and the
      // tool-scoped `include` all drop off the wire together (an `include`
      // naming a tool that is not declared is not a request this API accepts).
      const withTools = (options?.tools ?? 'declared') === 'declared';
      const requestBody: Record<string, unknown> = {
        model: config.requestedModelId,
        input: turns.map((t) => ({ role: t.role, content: t.content })),
      };
      if (withTools) {
        requestBody['tools'] = [config.webSearchTool];
        requestBody[config.toolCapParam] = config.toolCapValue;
        if (config.include !== undefined && config.include.length > 0) {
          requestBody['include'] = [...config.include];
        }
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
        status?: unknown;
        incomplete_details?: { reason?: unknown };
        error?: { code?: unknown; message?: unknown };
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
      // Recorded params mirror the wire exactly, so the evidence shows whether
      // this attempt could search at all.
      const requestParams: Record<string, unknown> = {
        endpoint: url,
        model: config.requestedModelId,
      };
      if (withTools) {
        requestParams['tools'] = [config.webSearchTool];
        requestParams[config.toolCapParam] = config.toolCapValue;
        if (config.include !== undefined && config.include.length > 0) {
          requestParams['include'] = [...config.include];
        }
      }
      if (options?.maxOutputTokens !== undefined) {
        requestParams[config.maxTokensParam] = options.maxOutputTokens;
      }

      // Terminal state: the Responses API stamps a root `status`; only
      // `completed` is a finished turn. `incomplete` (e.g. it hit
      // max_output_tokens), `failed`, anything else, or a missing field is
      // typed as an unfinished turn carrying the call's full evidence (status,
      // ids, partial text, usage, audit), so a truncated or failed response is
      // never scored as the model's invalid JSON — nor accepted as its answer.
      const rootStatus = typeof json.status === 'string' ? json.status : 'missing';
      if (rootStatus !== 'completed') {
        const incompleteReason =
          typeof json.incomplete_details?.reason === 'string' ? json.incomplete_details.reason : null;
        const errorMessage =
          typeof json.error?.message === 'string' ? redactAndTruncate(json.error.message, 300) : null;
        const detail =
          rootStatus === 'incomplete'
            ? `the provider reported an incomplete response${incompleteReason === null ? '' : ` (${incompleteReason})`}`
            : rootStatus === 'failed'
              ? `the provider reported a failed response${errorMessage === null ? '' : `: ${errorMessage}`}`
              : `the provider reported response status "${rootStatus}", not "completed"`;
        throw new ProviderUnfinishedTurnError({
          provider: config.provider,
          stopReason: rootStatus,
          detail,
          httpStatus: status,
          providerResponseId: typeof json.id === 'string' ? json.id : null,
          reportedModelId: typeof json.model === 'string' ? json.model : null,
          rawText,
          usage,
          usageRaw: json.usage ?? null,
          searchAudit: extractResponsesSearchAudit(raw),
          requestParams,
        });
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
