import { createAnthropicAdapter } from './anthropic.js';
import { createGoogleAdapter } from './google.js';
import { createOpenAiCompatibleAdapter } from './openaiCompatible.js';
import type { ArmSpec, ProviderAdapter } from '../types.js';

/**
 * The four arms of the cross-lab flagship cohort (docs/AGENT_BENCHMARK.md,
 * "Model configuration policy", candidate cohort as of 2026-07-11).
 */
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
