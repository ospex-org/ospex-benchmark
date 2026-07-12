import { googleApiKey } from '../config.js';
import { postJson } from './http.js';
import type {
  ChatTurn,
  ProviderAdapter,
  ProviderCallOptions,
  ProviderResponse,
  ProviderUsage,
} from '../types.js';

const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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
      const system = turns.find((t) => t.role === 'system')?.content ?? '';
      const contents = turns
        .filter((t) => t.role !== 'system')
        .map((t) => ({
          role: t.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: t.content }],
        }));
      const body: Record<string, unknown> = {
        systemInstruction: { parts: [{ text: system }] },
        contents,
      };
      if (options?.maxOutputTokens !== undefined) {
        body['generationConfig'] = { maxOutputTokens: options.maxOutputTokens };
      }
      // Key travels in a header, never in the URL, so it cannot leak into
      // recorded request params or error messages.
      const url = `${GOOGLE_BASE}/${requestedModelId}:generateContent`;
      const { status, json: raw } = await postJson({
        provider: 'google',
        url,
        headers: { 'x-goog-api-key': apiKey },
        body,
        timeoutMs,
      });
      const json = raw as {
        responseId?: unknown;
        modelVersion?: unknown;
        candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; thought?: unknown }> } }>;
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
      const requestParams: Record<string, unknown> = { endpoint: url, model: requestedModelId };
      if (options?.maxOutputTokens !== undefined) {
        requestParams['maxOutputTokens'] = options.maxOutputTokens;
      }
      return {
        rawText: text,
        reportedModelId: typeof json.modelVersion === 'string' ? json.modelVersion : null,
        providerResponseId: typeof json.responseId === 'string' ? json.responseId : null,
        httpStatus: status,
        usage,
        usageRaw: json.usageMetadata ?? null,
        requestParams,
      };
    },
  };
}
