import { canonicalize, sha256Hex } from './canonical.js';
import { deepFreeze } from './freeze.js';

/**
 * Model price table: a per-model published-rate baseline, keyed on the EXACT
 * model-id string (no trim / case-fold / alias normalization), mirroring
 * `marketPolicy.ts`'s versioned, deep-frozen, digest-pinned registry. Rates are
 * integer USD-micros (1 USD = 1_000_000 USD-micros) per MILLION tokens — the
 * per-million basis keeps even sub-dollar-per-million prices integer, so the
 * canonical digest stays byte-stable (no floating-point representation). Input
 * and output token rates only; reasoning/thinking tokens bill at the output rate.
 *
 * The cohort manifest pins `modelPriceTableVersion` + `modelPriceTableDigest`; the
 * boot validator RECOMPUTES the digest for the recorded version and rejects a
 * mismatch, so a silent edit to a rate cannot pass as the pinned table. An unknown
 * version or an unpriced model fails closed (throws) — this baseline is the only
 * current price registry, and zero is never a valid price. Consumption of these
 * rates (token counting, the conservative spend estimate) is a later slice; this
 * module performs no arithmetic.
 *
 * Baseline snapshot as of 2026-07-20, from each provider's published API pricing
 * (input / output per million tokens, standard uncached tier):
 *   - `gpt-5.6-sol` ............ OpenAI (openai.com/api/pricing): $5 / $30
 *   - `claude-fable-5` ......... Anthropic (platform.claude.com/docs pricing): $10 / $50
 *   - `gemini-3.1-pro-preview` . Google (ai.google.dev pricing, <=200K tier): $2 / $12
 *   - `grok-4.5` ............... xAI (x.ai/api, <200K tier): $2 / $6
 * These are a dated baseline, not a claim of continuous freshness or exact final
 * billing. Price drift is a conscious `prices-vN` edit plus a manifest re-pin.
 */
export const MODEL_PRICE_TABLE_VERSIONS = Object.freeze(['prices-v1', 'prices-v2'] as const);
export type ModelPriceTableVersion = (typeof MODEL_PRICE_TABLE_VERSIONS)[number];

/** The price-table version the harness stamps on NEW runs. */
export const MODEL_PRICE_TABLE_VERSION: ModelPriceTableVersion = 'prices-v1';

/**
 * The CONSERVATIVE table the runtime spend guard prices against, and the version a
 * billable crossing manifest MUST pin. `prices-v2` uses each model's HIGHEST
 * conservatively-reachable published tier (the "price at the highest rate reachable"
 * option), so the derived-actual guard can only ever OVER-estimate real cost — the
 * one safe direction for a per-attempt hard-stop. `prices-v1` (the base/short-context
 * tier) is retained unchanged for historical replay/validation; the default stamped
 * version stays `prices-v1` so existing manifests/cohortIds do not churn.
 */
export const SPEND_GUARD_PRICE_TABLE_VERSION: ModelPriceTableVersion = 'prices-v2';

export function isModelPriceTableVersion(value: string): value is ModelPriceTableVersion {
  return (MODEL_PRICE_TABLE_VERSIONS as readonly string[]).includes(value);
}

/** One model's published token rates, in integer USD-micros per million tokens. */
export interface ModelPrice {
  readonly inputUsdMicrosPerMillionTokens: number;
  readonly outputUsdMicrosPerMillionTokens: number;
}

/** One price table: exact model-id → its rates. Module-private. */
type ModelPriceTable = Readonly<Record<string, ModelPrice>>;

const MODEL_PRICE_TABLE_V1: ModelPriceTable = {
  'gpt-5.6-sol': { inputUsdMicrosPerMillionTokens: 5_000_000, outputUsdMicrosPerMillionTokens: 30_000_000 },
  'claude-fable-5': { inputUsdMicrosPerMillionTokens: 10_000_000, outputUsdMicrosPerMillionTokens: 50_000_000 },
  'gemini-3.1-pro-preview': { inputUsdMicrosPerMillionTokens: 2_000_000, outputUsdMicrosPerMillionTokens: 12_000_000 },
  'grok-4.5': { inputUsdMicrosPerMillionTokens: 2_000_000, outputUsdMicrosPerMillionTokens: 6_000_000 },
};

/**
 * `prices-v2` — the conservative guard table: each model's HIGHEST conservatively-reachable
 * published tier (snapshot observed 2026-07-23, reconcile again immediately before any paid
 * crossing). A max-context prompt escalates the WHOLE request to the upper tier for the
 * two-tier models, so a table whose only job is to OVER-estimate defaults to that upper tier:
 *   - `gpt-5.6-sol` ........... OpenAI: $12.50 / $60. OUTPUT $60 = Priority Processing (a project can
 *       default requests that omit `service_tier` to Priority, and the adapter omits it — so Priority
 *       is reachable). INPUT $12.50 = a conservative long-context prompt-cache write: the pricing page
 *       states cache-write at 1.25× the STANDARD input ($6.25) but does not bound it in the >272K
 *       regime, so we use 1.25× the $10 long-context input; this also over-covers the $10 long-context
 *       and Priority input rates.
 *   - `claude-fable-5` ........ Anthropic, single tier (no long-context premium): $10 / $50
 *   - `gemini-3.1-pro-preview`  Google, >200K tier: $4 / $18
 *   - `grok-4.5` .............. xAI, ≥200K tier (higher rate on all tokens): $4 / $12
 * Reasoning/thinking bill at the OUTPUT rate; the per-provider derived-actual (a later slice)
 * multiplies the right token buckets by these input/output rates — this module holds only the
 * rates and does no arithmetic.
 */
const MODEL_PRICE_TABLE_V2: ModelPriceTable = {
  'gpt-5.6-sol': { inputUsdMicrosPerMillionTokens: 12_500_000, outputUsdMicrosPerMillionTokens: 60_000_000 },
  'claude-fable-5': { inputUsdMicrosPerMillionTokens: 10_000_000, outputUsdMicrosPerMillionTokens: 50_000_000 },
  'gemini-3.1-pro-preview': { inputUsdMicrosPerMillionTokens: 4_000_000, outputUsdMicrosPerMillionTokens: 18_000_000 },
  'grok-4.5': { inputUsdMicrosPerMillionTokens: 4_000_000, outputUsdMicrosPerMillionTokens: 12_000_000 },
};

/**
 * The version→table registry, **deep-frozen** so neither the registry, the price
 * tables, nor their rate rows can be mutated at runtime. `prices-v1` therefore
 * denotes exactly one immutable table, and its digest can never go stale relative
 * to what the boot validator actually reads.
 */
const PRICE_TABLES: Readonly<Record<ModelPriceTableVersion, ModelPriceTable>> = deepFreeze({
  'prices-v1': MODEL_PRICE_TABLE_V1,
  'prices-v2': MODEL_PRICE_TABLE_V2,
});

/** The price table for a KNOWN version; throws on an unknown version. */
export function modelPriceTableForVersion(version: string): Readonly<Record<string, ModelPrice>> {
  if (!isModelPriceTableVersion(version)) {
    throw new Error(`unknown model price table version: ${version}`);
  }
  return PRICE_TABLES[version];
}

/**
 * The price for a KNOWN model in a KNOWN version, fail-closed. Resolves the table
 * first (an unknown version throws), then does an EXACT OWN-KEY lookup — an
 * inherited key (`toString`, `__proto__`, …) or any unpriced model throws, never
 * returning `undefined`, zero, a zero-valued row, the first row, or the default row.
 */
export function priceForModel(
  modelId: string,
  version: string = MODEL_PRICE_TABLE_VERSION,
): ModelPrice {
  const table = modelPriceTableForVersion(version);
  if (!Object.hasOwn(table, modelId)) {
    throw new Error(`unknown model price: ${modelId}`);
  }
  return table[modelId]!;
}

/**
 * The recomputed digest of a KNOWN version — the SHA-256 of the canonical
 * serialization of its price table. The manifest pins `modelPriceTableDigest`; the
 * boot validator recomputes this and rejects a mismatch (an unknown version throws
 * before hashing), so a silent rate edit cannot pass as the pinned table.
 */
export function modelPriceTableDigest(version: string): string {
  return sha256Hex(canonicalize(modelPriceTableForVersion(version)));
}

/** Digest of the current price-table version, for convenience. */
export const MODEL_PRICE_TABLE_DIGEST: string = modelPriceTableDigest(MODEL_PRICE_TABLE_VERSION);
