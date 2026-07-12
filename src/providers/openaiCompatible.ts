import { envValue } from '../config.js';
import { postJson } from './http.js';
import type {
  ChatTurn,
  ProviderAdapter,
  ProviderCallOptions,
  ProviderName,
  ProviderResponse,
  ProviderUsage,
} from '../types.js';

/**
 * Adapter for OpenAI-compatible chat-completions APIs (OpenAI itself and
 * xAI). Requests are minimal on purpose: model + messages, no sampling
 * overrides, so reasoning-model parameter restrictions cannot reject the
 * call. Whatever the provider defaults to is recorded as the configuration.
 */
export function createOpenAiCompatibleAdapter(config: {
  provider: ProviderName;
  requestedModelId: string;
  credentialEnvVar: string;
  baseUrl: string;
  /** Param name for the output cap ('max_completion_tokens' on OpenAI, 'max_tokens' on xAI). */
  maxTokensParam: string;
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
      const url = `${config.baseUrl}/chat/completions`;
      const requestBody: Record<string, unknown> = {
        model: config.requestedModelId,
        messages: turns.map((t) => ({ role: t.role, content: t.content })),
      };
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
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
      };

      const content = json.choices?.[0]?.message?.content;
      const usage: ProviderUsage = {
        inputTokens: typeof json.usage?.prompt_tokens === 'number' ? json.usage.prompt_tokens : null,
        outputTokens:
          typeof json.usage?.completion_tokens === 'number' ? json.usage.completion_tokens : null,
        totalTokens: typeof json.usage?.total_tokens === 'number' ? json.usage.total_tokens : null,
      };
      const requestParams: Record<string, unknown> = {
        endpoint: url,
        model: config.requestedModelId,
      };
      if (options?.maxOutputTokens !== undefined) {
        requestParams[config.maxTokensParam] = options.maxOutputTokens;
      }
      return {
        rawText: typeof content === 'string' ? content : '',
        reportedModelId: typeof json.model === 'string' ? json.model : null,
        providerResponseId: typeof json.id === 'string' ? json.id : null,
        httpStatus: status,
        usage,
        usageRaw: json.usage ?? null,
        requestParams,
      };
    },
  };
}
