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
 *                `max_turns` — xAI's documented request-side bound, which caps
 *                agentic TURNS rather than searches (legacy chat-completions
 *                Live Search was retired upstream).
 */

export const TOOL_INFERENCE_CONFIG_VERSION = 'tools-v1';

/**
 * The COMMON per-attempt search ceiling every arm is configured against.
 *
 * Two of the four providers enforce it exactly (`max_tool_calls` on OpenAI,
 * `max_uses` on Anthropic). xAI's documented request-side bound is `max_turns`,
 * which caps agentic TURNS — one turn may run tool calls in parallel — so it
 * bounds searches only coarsely, and the exact billable count is observed and
 * priced from the response counter. Google's grounding tool exposes NO cap of
 * any kind — its entire documented config is a time-range filter and a
 * search-type selector, and the model decides how many queries to run — so for
 * that arm the ceiling is a declared target that the harness OBSERVES and
 * PRICES rather than enforces. Those asymmetries are disclosed, not papered
 * over: see docs/SPEND-BOUND-PROOF.md, "Web-search fees".
 */
export const MAX_SEARCHES_PER_ATTEMPT = 5;

/**
 * How many times a provider may pause its own server-side tool loop and be
 * continued within ONE attempt. Zero: an attempt is exactly one billable
 * request, which is the unit the per-attempt reservation bounds and the unit
 * the spend proof prices. Raising this means re-deriving that bound — it is a
 * money decision recorded in hashed configuration, not an adapter detail.
 */
export const MAX_SERVER_TOOL_CONTINUATIONS = 0;

export const TOOL_INFERENCE_CONFIG = deepFreeze({
  version: TOOL_INFERENCE_CONFIG_VERSION,
  maxSearchesPerAttempt: MAX_SEARCHES_PER_ATTEMPT,
  maxServerToolContinuations: MAX_SERVER_TOOL_CONTINUATIONS,
  webSearch: {
    // Each arm is capped through the parameter ITS OWN provider documents as a
    // request field, never one borrowed from a sibling API:
    //  - openai `max_tool_calls` — documented request param, bounds built-in
    //    tool calls exactly. `include` requests the per-call source list; it is
    //    an OpenAI includable and is NOT sent to xAI, whose docs define no such
    //    value and which returns the consulted-source list in `citations` by
    //    default.
    //  - anthropic `max_uses` — documented on the tool object, bounds searches
    //    exactly (a further search returns a `max_uses_exceeded` tool error).
    //  - xai `max_turns` — the documented request-side bound. `max_tool_calls`
    //    appears ONLY in xAI's response schema, not its request parameters, so
    //    sending it would be an undocumented field that either 400s the call or
    //    is silently ignored. `max_turns` bounds agentic TURNS, and one turn can
    //    run tools in parallel, so it is a coarse bound: the exact billable
    //    count comes from the response counter and is priced.
    //  - google — no cap of any kind exists (its whole tool config is a
    //    time-range filter and a search-type selector).
    openai: {
      tool: { type: 'web_search' },
      capParam: 'max_tool_calls',
      capValue: MAX_SEARCHES_PER_ATTEMPT,
      include: ['web_search_call.action.sources'],
      capBoundsSearchesExactly: true,
    },
    anthropic: {
      tool: { type: 'web_search_20250305', name: 'web_search' },
      maxUses: MAX_SEARCHES_PER_ATTEMPT,
      capBoundsSearchesExactly: true,
    },
    google: { tool: { google_search: {} }, capBoundsSearchesExactly: false },
    xai: {
      tool: { type: 'web_search' },
      capParam: 'max_turns',
      capValue: MAX_SEARCHES_PER_ATTEMPT,
      capBoundsSearchesExactly: false,
    },
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
