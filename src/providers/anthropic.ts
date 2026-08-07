import { envValue } from '../config.js';
import { postJson } from './http.js';
import { ProviderUnfinishedTurnError } from './errors.js';
import { TOOL_INFERENCE_CONFIG } from '../toolInferenceConfig.js';
import { deriveComparableUsage } from './comparableUsage.js';
import { extractAnthropicSearchAudit } from './searchAudit.js';
import type {
  ChatTurn,
  ProviderAdapter,
  ProviderCallOptions,
  ProviderResponse,
  ProviderUsage,
} from '../types.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 16000;

// The declared web-search server tool (tools-v1): GA on the Messages API (no
// beta header), flat block shape, capped by the provider's own `max_uses`.
const WEB_SEARCH = TOOL_INFERENCE_CONFIG.webSearch.anthropic;

export function createAnthropicAdapter(requestedModelId: string): ProviderAdapter {
  return {
    provider: 'anthropic',
    requestedModelId,
    credentialEnvVar: 'ANTHROPIC_API_KEY',
    hasCredential(): boolean {
      return envValue('ANTHROPIC_API_KEY') !== undefined;
    },
    async chat(
      turns: ChatTurn[],
      timeoutMs: number,
      options?: ProviderCallOptions,
    ): Promise<ProviderResponse> {
      const apiKey = envValue('ANTHROPIC_API_KEY');
      if (apiKey === undefined) throw new Error('ANTHROPIC_API_KEY is not set');
      const system = turns.find((t) => t.role === 'system')?.content ?? '';
      const messages = turns
        .filter((t) => t.role !== 'system')
        .map((t) => ({ role: t.role, content: t.content }));
      const maxTokens = options?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
      // A repair carries no declared tools (format-only, may not search).
      const withTools = (options?.tools ?? 'declared') === 'declared';
      const tools = [{ ...WEB_SEARCH.tool, max_uses: WEB_SEARCH.maxUses }];
      const body: Record<string, unknown> = {
        model: requestedModelId,
        max_tokens: maxTokens,
        system,
        messages,
      };
      if (withTools) body['tools'] = tools;
      const { status, json: raw } = await postJson({
        provider: 'anthropic',
        url: ANTHROPIC_URL,
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        body,
        timeoutMs,
      });
      const json = raw as {
        id?: unknown;
        model?: unknown;
        stop_reason?: unknown;
        content?: Array<{ type?: unknown; text?: unknown }>;
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      };

      const text = Array.isArray(json.content)
        ? json.content
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text as string)
            .join('')
        : '';
      const inputTokens =
        typeof json.usage?.input_tokens === 'number' ? json.usage.input_tokens : null;
      const outputTokens =
        typeof json.usage?.output_tokens === 'number' ? json.usage.output_tokens : null;
      const comparable = deriveComparableUsage('anthropic', json.usage ?? null);
      const usage: ProviderUsage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
        reasoningTokens: comparable.reasoningTokens,
        billableOutputTokens: comparable.billableOutputTokens,
      };

      // Terminal state: on the Messages API only `end_turn` and `stop_sequence`
      // are a finished turn. Everything else — `pause_turn`, `refusal`,
      // `max_tokens`, an unknown value, or a missing field — is HTTP 200 with
      // empty or partial content. Surfacing those as a typed failure carrying
      // the call's full evidence (status, ids, partial text, usage, audit)
      // keeps a truncated or paused turn from reading downstream as a model
      // that emitted invalid JSON.
      const stopReason = typeof json.stop_reason === 'string' ? json.stop_reason : 'missing';
      if (stopReason !== 'end_turn' && stopReason !== 'stop_sequence') {
        const detail =
          stopReason === 'pause_turn'
            ? 'the server-side tool loop hit its iteration limit; continuation is not enabled (maxServerToolContinuations)'
            : stopReason === 'refusal'
              ? 'the request was declined by the provider safety classifiers'
              : stopReason === 'max_tokens'
                ? 'the response hit its max_tokens output cap before the turn finished'
                : `the provider reported a non-final stop_reason "${stopReason}"`;
        throw new ProviderUnfinishedTurnError({
          provider: 'anthropic',
          stopReason,
          detail,
          httpStatus: status,
          providerResponseId: typeof json.id === 'string' ? json.id : null,
          reportedModelId: typeof json.model === 'string' ? json.model : null,
          rawText: text,
          usage,
          usageRaw: json.usage ?? null,
          searchAudit: extractAnthropicSearchAudit(raw),
        });
      }

      return {
        rawText: text,
        reportedModelId: typeof json.model === 'string' ? json.model : null,
        providerResponseId: typeof json.id === 'string' ? json.id : null,
        httpStatus: status,
        usage,
        usageRaw: json.usage ?? null,
        requestParams: {
          endpoint: ANTHROPIC_URL,
          model: requestedModelId,
          max_tokens: maxTokens,
          anthropic_version: ANTHROPIC_VERSION,
          ...(withTools ? { tools } : {}),
        },
        searchAudit: extractAnthropicSearchAudit(raw),
      };
    },
  };
}
