import { priceForModel } from './modelPriceTable.js';
import type { ModelPrice } from './modelPriceTable.js';
import type { ProviderName } from './types.js';

/**
 * Conservative derived-actual spend for one billable provider attempt, in integer USD-micros.
 *
 * This is the runtime money guard's arithmetic core (the "consumption" slice the price table
 * defers): it prices a provider's VERBATIM `usageRaw` token buckets against a pinned price
 * table so a fire whose real cost crosses the per-attempt reservation can be hard-stopped. It
 * is deliberately an OVER-estimate — every ambiguity resolves toward pricing more, never less,
 * because an undercount is the one direction that fails to trip the guard.
 *
 * Per-provider token semantics differ and are NOT interchangeable (an undercount is silent):
 *   - OpenAI  → prompt·input + completion·output. `completion_tokens_details.reasoning_tokens`
 *               is a SUBSET already inside `completion_tokens` — never added again.
 *               `prompt_tokens_details.cached_tokens` is a subset of `prompt_tokens` — not added.
 *   - xAI     → prompt·input + (completion + reasoning)·output. `reasoning_tokens` is ADDITIVE
 *               (xAI `total = prompt + completion + reasoning`), so it IS added.
 *   - Anthropic → input·input + output·output (thinking folded into `output_tokens`);
 *               `cache_read_input_tokens` priced at the INPUT rate, `cache_creation_input_tokens`
 *               at the OUTPUT rate (conservative — cache-write bills 1.25–2× input), both ADDITIVE.
 *   - Google  → prompt·input + (candidates + thoughts)·output. `thoughtsTokenCount` is a SEPARATE
 *               additive bucket (Google `total = prompt + candidates + thoughts`), so it IS added;
 *               `cachedContentTokenCount` is a subset of prompt already priced at full input rate.
 *
 * Everything fails CLOSED to a typed {@link ConservativeSpendUnknownError} — never a sentinel 0.
 * An UNKNOWN spend must escalate, not read as zero.
 */

/**
 * Typed UNKNOWN: the conservative derived-actual cannot be computed with confidence — an unknown
 * provider / unpriced model / unknown price version, a malformed or internally-inconsistent
 * `usageRaw`, or an out-of-domain token count. The caller (the fire spine) MUST catch this and
 * fold it to an UNKNOWN guard verdict (escalate) — it is NEVER a value read as zero spend.
 */
export class ConservativeSpendUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConservativeSpendUnknownError';
  }
}

/**
 * Canonical model → provider registry, frozen. The arithmetic uses `provider` to pick usage
 * SEMANTICS and `requestedModelId` to pick PRICES; an incoherent pair would price the wrong
 * (often cheaper) cross-provider row. This registry rejects such a pair before pricing. A test
 * cross-checks it against the authenticated arm roster (`ARMS`) so it cannot drift.
 */
export const PROVIDER_BY_MODEL: Readonly<Record<string, ProviderName>> = Object.freeze({
  'gpt-5.6-sol': 'openai',
  'claude-fable-5': 'anthropic',
  'gemini-3.1-pro-preview': 'google',
  'grok-4.5': 'xai',
});

/** Tokens split into those billed at the input rate vs the output rate for one attempt. */
interface RateBuckets {
  readonly inputRateTokens: bigint;
  readonly outputRateTokens: bigint;
}

/**
 * Conservative derived-actual for one billable attempt's verbatim `usageRaw`, in USD-micros.
 *
 * `provider` and `requestedModelId` MUST be a coherent AUTHENTICATED pair (derived by the caller
 * from the dispatched arm, not an independent integration tuple), and `priceVersion` the manifest's
 * pinned version — a mismatched/cheaper model or an off-table id fails closed here before any verdict.
 * Throws {@link ConservativeSpendUnknownError} on any ambiguity (see the module doc).
 */
export function deriveConservativeActualUsdMicros(input: {
  provider: ProviderName;
  requestedModelId: string;
  priceVersion: string;
  usageRaw: unknown;
}): number {
  const { provider, requestedModelId, priceVersion, usageRaw } = input;
  const who = `${provider}:${requestedModelId}`;

  // Fail closed on a provider/model mismatch BEFORE pricing — the provider selects usage
  // semantics while an independent model id selects prices, so an incoherent pair would price a
  // wrong (often cheaper) cross-provider row rather than the model actually dispatched.
  const expectedProvider = Object.hasOwn(PROVIDER_BY_MODEL, requestedModelId)
    ? PROVIDER_BY_MODEL[requestedModelId]
    : undefined;
  if (expectedProvider !== provider) {
    throw new ConservativeSpendUnknownError(
      `${who}: provider/model mismatch — "${requestedModelId}" is not a ${provider} model`,
    );
  }

  let price: ModelPrice;
  try {
    // Exact own-key lookup; throws for an unknown version or an unpriced model (never a default).
    price = priceForModel(requestedModelId, priceVersion);
  } catch (error) {
    throw new ConservativeSpendUnknownError(`${who}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const usage = asUsageRecord(usageRaw, who);
  const { inputRateTokens, outputRateTokens } = extractRateBuckets(provider, usage, who);

  const numerator =
    inputRateTokens * BigInt(price.inputUsdMicrosPerMillionTokens) +
    outputRateTokens * BigInt(price.outputUsdMicrosPerMillionTokens);
  const derived = ceilDivUsdMicros(numerator);
  if (derived > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConservativeSpendUnknownError(`${who}: derived spend ${derived} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(derived);
}

/**
 * Conservative (ceiling) division of a USD-micros numerator by the per-million-token basis.
 * Rounds a non-divisible product UP so the guard can only over-estimate. `numerator` is
 * nonnegative by construction (token counts ≥ 0, rates > 0). Exported for direct testing.
 */
export function ceilDivUsdMicros(numerator: bigint): bigint {
  const ONE_MILLION = 1_000_000n;
  return (numerator + ONE_MILLION - 1n) / ONE_MILLION;
}

function extractRateBuckets(provider: ProviderName, usage: Record<string, unknown>, who: string): RateBuckets {
  switch (provider) {
    case 'openai': {
      const prompt = readRequiredCount(usage, 'prompt_tokens', who);
      const completion = readRequiredCount(usage, 'completion_tokens', who);
      // reasoning ⊆ completion (already counted); cached ⊆ prompt (already counted) — neither added.
      assertTotalConsistency(usage, 'total_tokens', prompt + completion, who);
      return { inputRateTokens: prompt, outputRateTokens: completion };
    }
    case 'xai': {
      const prompt = readRequiredCount(usage, 'prompt_tokens', who);
      const completion = readRequiredCount(usage, 'completion_tokens', who);
      const details = readNestedRecord(usage, 'completion_tokens_details', who);
      const reasoningPresent = Object.hasOwn(details, 'reasoning_tokens');
      const reasoning = readOptionalCount(details, 'reasoning_tokens', `${who}.completion_tokens_details`);
      // reasoning is ADDITIVE for xAI (total = prompt + completion + reasoning) and cost-dominant.
      // If it is not reported, a corroborating total MUST prove it was zero; with neither, we cannot
      // distinguish a genuine non-thinking response from a truncated one — so it is UNKNOWN, not zero.
      requireAdditiveCorroboration(reasoningPresent, usage, 'total_tokens', 'reasoning_tokens', who);
      assertTotalConsistency(usage, 'total_tokens', prompt + completion + reasoning, who);
      return { inputRateTokens: prompt, outputRateTokens: completion + reasoning };
    }
    case 'anthropic': {
      const inputTokens = readRequiredCount(usage, 'input_tokens', who);
      const outputTokens = readRequiredCount(usage, 'output_tokens', who); // thinking folded in
      const cacheRead = readOptionalCount(usage, 'cache_read_input_tokens', who); // priced at INPUT rate
      const cacheCreation = readOptionalCount(usage, 'cache_creation_input_tokens', who); // priced at OUTPUT rate
      return {
        inputRateTokens: inputTokens + cacheRead,
        outputRateTokens: outputTokens + cacheCreation,
      };
    }
    case 'google': {
      const prompt = readRequiredCount(usage, 'promptTokenCount', who);
      const candidates = readRequiredCount(usage, 'candidatesTokenCount', who);
      const thoughtsPresent = Object.hasOwn(usage, 'thoughtsTokenCount');
      const thoughts = readOptionalCount(usage, 'thoughtsTokenCount', who); // ADDITIVE, at output rate
      // thoughtsTokenCount is additive and cost-dominant; if unreported, a corroborating total MUST
      // prove it zero. With neither the field nor a total, cost is UNKNOWN — never assumed zero.
      requireAdditiveCorroboration(thoughtsPresent, usage, 'totalTokenCount', 'thoughtsTokenCount', who);
      // cachedContentTokenCount ⊆ prompt, already priced at the full input rate (conservative) — ignored.
      assertTotalConsistency(usage, 'totalTokenCount', prompt + candidates + thoughts, who);
      return { inputRateTokens: prompt, outputRateTokens: candidates + thoughts };
    }
    default: {
      const _exhaustive: never = provider;
      void _exhaustive;
      throw new ConservativeSpendUnknownError(`unknown provider: ${describe(provider)}`);
    }
  }
}

/** A present `totalField` MUST equal the reconstructed sum; absence is not an inconsistency. */
function assertTotalConsistency(
  usage: Record<string, unknown>,
  totalField: string,
  expected: bigint,
  who: string,
): void {
  if (!Object.hasOwn(usage, totalField)) return;
  const total = asTokenCount(usage[totalField], `${who}.${totalField}`);
  if (total !== expected) {
    throw new ConservativeSpendUnknownError(
      `${who}: ${totalField} ${total} != reconstructed ${expected} (token accounting inconsistent)`,
    );
  }
}

/**
 * For a provider whose reasoning/thinking bucket is ADDITIVE and cost-dominant: if the additive
 * field is absent, a corroborating total MUST be present (its value is checked by
 * {@link assertTotalConsistency}, which then proves the additive bucket was zero). With NEITHER
 * the field nor a total, the cost cannot be confirmed — a typed UNKNOWN, never an assumed zero.
 */
function requireAdditiveCorroboration(
  additivePresent: boolean,
  usage: Record<string, unknown>,
  totalField: string,
  additiveField: string,
  who: string,
): void {
  if (!additivePresent && !Object.hasOwn(usage, totalField)) {
    throw new ConservativeSpendUnknownError(
      `${who}: ${additiveField} absent and no ${totalField} to corroborate zero — cannot confirm cost (UNKNOWN, not zero)`,
    );
  }
}

function asUsageRecord(value: unknown, who: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConservativeSpendUnknownError(`${who}: usageRaw is not a token object (${describe(value)})`);
  }
  return value as Record<string, unknown>;
}

/** A nested object field (own-key only); absent → empty (optional sub-fields default 0). Present non-object → UNKNOWN. */
function readNestedRecord(obj: Record<string, unknown>, field: string, who: string): Record<string, unknown> {
  if (!Object.hasOwn(obj, field)) return {};
  const value = obj[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConservativeSpendUnknownError(`${who}.${field} is present but not an object (${describe(value)})`);
  }
  return value as Record<string, unknown>;
}

/** A REQUIRED own-key nonnegative-safe-integer token count as bigint. */
function readRequiredCount(obj: Record<string, unknown>, field: string, who: string): bigint {
  if (!Object.hasOwn(obj, field)) {
    throw new ConservativeSpendUnknownError(`${who}: missing required token field "${field}"`);
  }
  return asTokenCount(obj[field], `${who}.${field}`);
}

/** An OPTIONAL own-key token count (absent → 0n); a present value must be a valid count. */
function readOptionalCount(obj: Record<string, unknown>, field: string, who: string): bigint {
  if (!Object.hasOwn(obj, field)) return 0n;
  return asTokenCount(obj[field], `${who}.${field}`);
}

function asTokenCount(value: unknown, who: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ConservativeSpendUnknownError(`${who} is not a nonnegative safe integer (${describe(value)})`);
  }
  return BigInt(value);
}

/** Describe a rejected value for an error WITHOUT coercing a hostile object. */
function describe(value: unknown): string {
  return typeof value === 'number' ? String(value) : typeof value;
}
