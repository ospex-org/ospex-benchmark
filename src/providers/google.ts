import { envValue } from '../config.js';
import { postJson } from './http.js';
import type { ChatTurn, ProviderAdapter, ProviderResponse, ProviderUsage } from '../types.js';

const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export function createGoogleAdapter(requestedModelId: string): ProviderAdapter {
  return {
    provider: 'google',
    requestedModelId,
    credentialEnvVar: 'GEMINI_API_KEY',
    hasCredential(): boolean {
      return envValue('GEMINI_API_KEY') !== undefined;
    },
    async chat(turns: ChatTurn[], timeoutMs: number): Promise<ProviderResponse> {
      const apiKey = envValue('GEMINI_API_KEY');
      if (apiKey === undefined) throw new Error('GEMINI_API_KEY is not set');
      const system = turns.find((t) => t.role === 'system')?.content ?? '';
      const contents = turns
        .filter((t) => t.role !== 'system')
        .map((t) => ({
          role: t.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: t.content }],
        }));
      // Key travels in a header, never in the URL, so it cannot leak into
      // recorded request params or error messages.
      const url = `${GOOGLE_BASE}/${requestedModelId}:generateContent`;
      const json = (await postJson({
        provider: 'google',
        url,
        headers: { 'x-goog-api-key': apiKey },
        body: { systemInstruction: { parts: [{ text: system }] }, contents },
        timeoutMs,
      })) as {
        responseId?: unknown;
        modelVersion?: unknown;
        candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
        usageMetadata?: {
          promptTokenCount?: unknown;
          candidatesTokenCount?: unknown;
          totalTokenCount?: unknown;
        };
      };

      const parts = json.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts)
        ? parts
            .filter((p) => typeof p.text === 'string')
            .map((p) => p.text as string)
            .join('')
        : '';
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
      };
      return {
        rawText: text,
        reportedModelId: typeof json.modelVersion === 'string' ? json.modelVersion : null,
        providerResponseId: typeof json.responseId === 'string' ? json.responseId : null,
        usage,
        requestParams: { endpoint: url, model: requestedModelId },
      };
    },
  };
}
