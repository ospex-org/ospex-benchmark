import { createAnthropicAdapter } from './anthropic.js';
import { createGoogleAdapter } from './google.js';
import { createOpenAiCompatibleAdapter } from './openaiCompatible.js';
import { deepFreeze } from '../freeze.js';
import type { ArmSpec, ProviderAdapter } from '../types.js';

/**
 * The four arms of the cross-lab flagship cohort (docs/AGENT_BENCHMARK.md,
 * "Model configuration policy", candidate cohort as of 2026-07-11).
 */
/**
 * Exact response-reported model IDs approved per arm, fail-closed: any other
 * reported ID — including a same-family substitution or a dated snapshot
 * alias — fails the run. The live preflight (2026-07-12) verified every
 * provider reports back exactly the requested ID; if a lab starts reporting a
 * dated alias, the preflight will fail first, and the alias can be reviewed
 * and added here deliberately.
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
  },
  {
    participantId: 'anthropic-claude-fable-5',
    provider: 'anthropic',
    requestedModelId: 'claude-fable-5',
    credentialEnvVar: 'ANTHROPIC_API_KEY',
  },
  {
    participantId: 'google-gemini-3.1-pro-preview',
    provider: 'google',
    requestedModelId: 'gemini-3.1-pro-preview',
    credentialEnvVar: 'GEMINI_API_KEY',
  },
  {
    participantId: 'xai-grok-4.5',
    provider: 'xai',
    requestedModelId: 'grok-4.5',
    credentialEnvVar: 'XAI_API_KEY',
  },
];
deepFreeze(ARMS); // canonical roster — frozen so a validated preflight stays valid

export function createRealAdapters(): Map<string, ProviderAdapter> {
  const adapters = new Map<string, ProviderAdapter>();
  adapters.set(
    'openai-gpt-5.6-sol',
    createOpenAiCompatibleAdapter({
      provider: 'openai',
      requestedModelId: 'gpt-5.6-sol',
      credentialEnvVar: 'OPENAI_API_KEY',
      baseUrl: 'https://api.openai.com/v1',
      maxTokensParam: 'max_completion_tokens',
    }),
  );
  adapters.set('anthropic-claude-fable-5', createAnthropicAdapter('claude-fable-5'));
  adapters.set('google-gemini-3.1-pro-preview', createGoogleAdapter('gemini-3.1-pro-preview'));
  adapters.set(
    'xai-grok-4.5',
    createOpenAiCompatibleAdapter({
      provider: 'xai',
      requestedModelId: 'grok-4.5',
      credentialEnvVar: 'XAI_API_KEY',
      baseUrl: 'https://api.x.ai/v1',
      maxTokensParam: 'max_tokens',
    }),
  );
  return adapters;
}
