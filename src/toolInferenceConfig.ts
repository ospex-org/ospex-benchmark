import { canonicalize, sha256Hex } from './canonical.js';
import { deepFreeze } from './freeze.js';

/**
 * The DECLARED tool-inference configuration: which server-side tools each
 * provider arm runs with, and the provider-native caps they run under. This
 * module is the single source both the adapters (request construction) and
 * the manifest (`toolInferenceConfigSha256`, recomputed at boot by
 * manifestValidate) read — so what a cohort declares and what its requests
 * actually send cannot drift apart.
 *
 * tools-v1 enables provider web search on all four arms, each through the
 * provider's own current mechanism:
 *   - openai   → Responses API server tool `{type: "web_search"}` with the
 *                top-level `max_tool_calls` cap and
 *                `include: ["web_search_call.action.sources"]` for auditability.
 *   - anthropic → Messages API server tool `web_search_20250305` (GA, flat
 *                block shape — the easiest to audit) with `max_uses`.
 *   - google   → generateContent `tools: [{google_search: {}}]`. Google
 *                exposes NO cap parameter — the model decides how many
 *                queries run; the audit records the executed count.
 *   - xai      → Responses API (Agent Tools) `{type: "web_search"}` with
 *                `max_tool_calls` (legacy chat-completions Live Search was
 *                retired upstream).
 */

export const TOOL_INFERENCE_CONFIG_VERSION = 'tools-v1';

export const TOOL_INFERENCE_CONFIG = deepFreeze({
  version: TOOL_INFERENCE_CONFIG_VERSION,
  webSearch: {
    openai: { tool: { type: 'web_search' }, maxToolCalls: 5, includeSources: true },
    anthropic: { tool: { type: 'web_search_20250305', name: 'web_search' }, maxUses: 5 },
    google: { tool: { google_search: {} } },
    xai: { tool: { type: 'web_search' }, maxToolCalls: 5 },
  },
} as const);

/**
 * The manifest-pinned digest of the declared tool configuration, recomputed
 * from code at boot (mirrors `promptScaffoldSha256`). Any change to the
 * enabled tools or their caps changes this hash, the manifest, and therefore
 * every new cohortId — a methodology change creates a new cohort.
 */
export function toolInferenceConfigSha256(): string {
  return sha256Hex(canonicalize(TOOL_INFERENCE_CONFIG));
}
