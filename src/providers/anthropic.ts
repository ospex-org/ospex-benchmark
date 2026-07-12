import { envValue } from '../config.js';
import { postJson } from './http.js';
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
      const { status, json: raw } = await postJson({
        provider: 'anthropic',
        url: ANTHROPIC_URL,
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        body: { model: requestedModelId, max_tokens: maxTokens, system, messages },
        timeoutMs,
      });
      const json = raw as {
        id?: unknown;
        model?: unknown;
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
      const usage: ProviderUsage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
      };
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
        },
      };
    },
  };
}
