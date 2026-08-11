import { createAnthropicAdapter, anthropicRequestPlan } from './anthropic.js';
import { createGoogleAdapter, googleRequestPlan } from './google.js';
import { createResponsesApiAdapter, responsesApiRequestPlan } from './responsesApi.js';
import { deepFreeze } from '../freeze.js';
import { TOOL_INFERENCE_CONFIG } from '../toolInferenceConfig.js';
import type { ResponsesApiConfig } from './responsesApi.js';
import type { ProviderRequestPlan } from './requestPlan.js';
import type { ArmSpec, ChatTurn, ProviderAdapter, ProviderCallOptions, ProviderName } from '../types.js';

/**
 * The arms of the cross-lab flagship cohort (docs/AGENT_BENCHMARK.md,
 * "Model configuration policy", candidate cohort as of 2026-07-11).
 *
 * An ARM is one competing configuration, not a lab and not a model line. The
 * roster below happens to be four models from four labs each setting no knobs,
 * but nothing here requires that: two arms may name the same model provided
 * their configurations differ, which is how one model competes at two
 * reasoning levels. Adding an arm is a money decision before it is a code one
 * — the per-fire reservation is derived from the roster size — so the size
 * pins in crossingProfile/campaignProfile are the gate, not this list.
 */
/**
 * Exact response-reported model IDs approved per arm, fail-closed: any other
 * reported ID — including a same-family substitution or a dated snapshot
 * alias — fails the run. The live preflight (2026-07-12) verified every
 * provider reports back exactly the requested ID; if a lab starts reporting a
 * dated alias, the preflight will fail first, and the alias can be reviewed
 * and added here deliberately.
 *
 * Keyed by participantId rather than by model, because two arms of one model
 * are two entrants and each approves its own reported IDs.
 */
export const APPROVED_REPORTED_MODEL_IDS: Record<string, string[]> = {
  'openai-gpt-5.6-sol': ['gpt-5.6-sol'],
  'anthropic-claude-fable-5': ['claude-fable-5'],
  'google-gemini-3.1-pro-preview': ['gemini-3.1-pro-preview'],
  'xai-grok-4.5': ['grok-4.5'],
};
// Freeze the canonical registry + its nested arrays: a one-time manifest
// preflight is only a lock if the checked runtime state cannot drift afterward.
deepFreeze(APPROVED_REPORTED_MODEL_IDS);

export function approvedReportedModelIds(participantId: string): string[] {
  return APPROVED_REPORTED_MODEL_IDS[participantId] ?? [];
}

export const ARMS: ArmSpec[] = [
  {
    participantId: 'openai-gpt-5.6-sol',
    provider: 'openai',
    requestedModelId: 'gpt-5.6-sol',
    credentialEnvVar: 'OPENAI_API_KEY',
    // Every arm in this cohort competes at its provider's defaults. `{}` says
    // that, and says it as a value: it is hashed, published and compared like
    // any other configuration, so "sets no knobs" is a precommitment rather
    // than a silence.
    configuration: {},
  },
  {
    participantId: 'anthropic-claude-fable-5',
    provider: 'anthropic',
    requestedModelId: 'claude-fable-5',
    credentialEnvVar: 'ANTHROPIC_API_KEY',
    configuration: {},
  },
  {
    participantId: 'google-gemini-3.1-pro-preview',
    provider: 'google',
    requestedModelId: 'gemini-3.1-pro-preview',
    credentialEnvVar: 'GEMINI_API_KEY',
    configuration: {},
  },
  {
    participantId: 'xai-grok-4.5',
    provider: 'xai',
    requestedModelId: 'grok-4.5',
    credentialEnvVar: 'XAI_API_KEY',
    configuration: {},
  },
];
deepFreeze(ARMS); // canonical roster — frozen so a validated preflight stays valid

/**
 * Per-PROVIDER Responses-API wiring. Keyed by provider rather than by arm
 * because it describes the API surface, not the entrant: two openai arms
 * differ in their configuration, never in their endpoint or cap parameter.
 */
const RESPONSES_API_PROVIDERS: Partial<Record<ProviderName, Omit<ResponsesApiConfig, 'requestedModelId'>>> =
  {
    // openai + xai run on their Responses APIs: neither serves server-side web
    // search on chat completions for these arms, and only the Responses surface
    // reports the executed search queries the audit trail requires.
    openai: {
      provider: 'openai',
      credentialEnvVar: 'OPENAI_API_KEY',
      baseUrl: 'https://api.openai.com/v1',
      maxTokensParam: 'max_output_tokens',
      webSearchTool: { ...TOOL_INFERENCE_CONFIG.webSearch.openai.tool },
      toolCapParam: TOOL_INFERENCE_CONFIG.webSearch.openai.capParam,
      toolCapValue: TOOL_INFERENCE_CONFIG.webSearch.openai.capValue,
      include: [...TOOL_INFERENCE_CONFIG.webSearch.openai.include],
    },
    xai: {
      provider: 'xai',
      credentialEnvVar: 'XAI_API_KEY',
      baseUrl: 'https://api.x.ai/v1',
      maxTokensParam: 'max_output_tokens',
      webSearchTool: { ...TOOL_INFERENCE_CONFIG.webSearch.xai.tool },
      toolCapParam: TOOL_INFERENCE_CONFIG.webSearch.xai.capParam,
      toolCapValue: TOOL_INFERENCE_CONFIG.webSearch.xai.capValue,
    },
  };

function responsesApiConfig(arm: ArmSpec): ResponsesApiConfig {
  const base = RESPONSES_API_PROVIDERS[arm.provider];
  if (base === undefined) {
    throw new Error(`no Responses-API wiring for provider "${arm.provider}"`);
  }
  return { ...base, requestedModelId: arm.requestedModelId };
}

/**
 * The live adapter for one arm.
 *
 * Derived FROM the roster entry rather than written beside it. The previous
 * shape spelled each model id a second time in this file, so an arm could be
 * added to `ARMS` and wired to a different model here with nothing to catch
 * it — and under one-arm-per-model that mistake was at least loud, because the
 * reported id would fail its approved list. With two arms of one model it
 * would not be: both report the same id, and the only difference is the
 * configuration, which the response does not echo.
 */
function createAdapter(arm: ArmSpec): ProviderAdapter {
  switch (arm.provider) {
    case 'anthropic':
      return createAnthropicAdapter(arm.requestedModelId);
    case 'google':
      return createGoogleAdapter(arm.requestedModelId);
    case 'openai':
    case 'xai':
      return createResponsesApiAdapter(responsesApiConfig(arm));
  }
}

export function createRealAdapters(): Map<string, ProviderAdapter> {
  const adapters = new Map<string, ProviderAdapter>();
  for (const arm of ARMS) adapters.set(arm.participantId, createAdapter(arm));
  return adapters;
}

/**
 * The request an arm WOULD send for a given set of turns, without sending it.
 *
 * This is how a configuration is validated before any money is spent: the
 * add-only rule in `applyConfiguration` throws on the real body, so calling
 * this across an arm's legs proves the configuration can be merged at all.
 * Sharing the adapters' own builders is the point — a separate model of what
 * each adapter sets would drift from the adapter, and the drift would only
 * surface on a live call.
 */
export function planArmRequest(
  arm: ArmSpec,
  turns: ChatTurn[],
  options?: ProviderCallOptions | undefined,
): ProviderRequestPlan {
  const withConfiguration: ProviderCallOptions = { ...options, configuration: arm.configuration };
  switch (arm.provider) {
    case 'anthropic':
      return anthropicRequestPlan({
        requestedModelId: arm.requestedModelId,
        turns,
        options: withConfiguration,
      });
    case 'google':
      return googleRequestPlan({
        requestedModelId: arm.requestedModelId,
        turns,
        options: withConfiguration,
      });
    case 'openai':
    case 'xai':
      return responsesApiRequestPlan({
        config: responsesApiConfig(arm),
        turns,
        options: withConfiguration,
      });
  }
}
