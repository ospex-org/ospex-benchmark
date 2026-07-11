import { envValue } from '../config.js';
import { postJson } from './http.js';
import type {
  ChatTurn,
  ProviderAdapter,
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
export function createOpenAiCompatibleAdapter(options: {
  provider: ProviderName;
  requestedModelId: string;
  credentialEnvVar: string;
  baseUrl: string;
}): ProviderAdapter {
  return {
    provider: options.provider,
    requestedModelId: options.requestedModelId,
    credentialEnvVar: options.credentialEnvVar,
    hasCredential(): boolean {
      return envValue(options.credentialEnvVar) !== undefined;
    },
    async chat(turns: ChatTurn[], timeoutMs: number): Promise<ProviderResponse> {
      const apiKey = envValue(options.credentialEnvVar);
      if (apiKey === undefined) throw new Error(`${options.credentialEnvVar} is not set`);
      const url = `${options.baseUrl}/chat/completions`;
      const requestBody = {
        model: options.requestedModelId,
        messages: turns.map((t) => ({ role: t.role, content: t.content })),
      };
      const json = (await postJson({
        provider: options.provider,
        url,
        headers: { authorization: `Bearer ${apiKey}` },
        body: requestBody,
        timeoutMs,
      })) as {
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
      return {
        rawText: typeof content === 'string' ? content : '',
        reportedModelId: typeof json.model === 'string' ? json.model : null,
        providerResponseId: typeof json.id === 'string' ? json.id : null,
        usage,
        requestParams: { endpoint: url, model: options.requestedModelId },
      };
    },
  };
}
