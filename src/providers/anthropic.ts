import { envValue } from '../config.js';
import { postJson } from './http.js';
import { ProviderUnfinishedTurnError } from './errors.js';
import { TOOL_INFERENCE_CONFIG } from '../toolInferenceConfig.js';
import { deriveComparableUsage } from './comparableUsage.js';
import { extractAnthropicSearchAudit } from './searchAudit.js';
import { buildRequestPlan } from './requestPlan.js';
import type { ProviderRequestPlan } from './requestPlan.js';
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

/**
 * The request this adapter would send, built without sending it.
 *
 * Exported so a preflight can check a participant's configuration against the
 * REAL body: the add-only collision rule then runs on what would actually go
 * on the wire, rather than on a hand-maintained list of reserved names that
 * drifts from the adapter the first time the adapter changes.
 */
export function anthropicRequestPlan(args: {
  requestedModelId: string;
  turns: ChatTurn[];
  options?: ProviderCallOptions | undefined;
}): ProviderRequestPlan {
  const system = args.turns.find((t) => t.role === 'system')?.content ?? '';
  const messages = args.turns
    .filter((t) => t.role !== 'system')
    .map((t) => ({ role: t.role, content: t.content }));
  const maxTokens = args.options?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  // A repair carries no declared tools (format-only, may not search).
  const withTools = (args.options?.tools ?? 'declared') === 'declared';
  const body: Record<string, unknown> = {
    model: args.requestedModelId,
    max_tokens: maxTokens,
    system,
    messages,
  };
  if (withTools) body['tools'] = [{ ...WEB_SEARCH.tool, max_uses: WEB_SEARCH.maxUses }];
  return buildRequestPlan({
    endpoint: ANTHROPIC_URL,
    body,
    configuration: args.options?.configuration ?? {},
    // The prompt is bound by its own hash once per run; repeating it on every
    // attempt would multiply the artifact by the bundle.
    promptKeys: ['system', 'messages'],
    // The API version travels in a header, but it selects the request contract
    // — a change in it changes what was asked for — so it is recorded.
    recordedNonBody: { anthropic_version: ANTHROPIC_VERSION },
  });
}

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
      const plan = anthropicRequestPlan({ requestedModelId, turns, options });
      const { status, json: raw } = await postJson({
        provider: 'anthropic',
        url: plan.endpoint,
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        body: plan.body,
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

      const requestParams = plan.requestParams;

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
          requestParams,
        });
      }

      return {
        rawText: text,
        reportedModelId: typeof json.model === 'string' ? json.model : null,
        providerResponseId: typeof json.id === 'string' ? json.id : null,
        httpStatus: status,
        usage,
        usageRaw: json.usage ?? null,
        requestParams,
        searchAudit: extractAnthropicSearchAudit(raw),
      };
    },
  };
}
