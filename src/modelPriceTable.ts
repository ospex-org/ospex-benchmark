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
 * current price registry, and zero is never a valid price. Token accounting and
 * conservative spend arithmetic live in `conservativeSpend.ts` / `spendGuard.ts`;
 * this module remains the immutable rate registry and performs no arithmetic.
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
export const MODEL_PRICE_TABLE_VERSIONS = Object.freeze(['prices-v1', 'prices-v2', 'prices-v3', 'prices-v4'] as const);
export type ModelPriceTableVersion = (typeof MODEL_PRICE_TABLE_VERSIONS)[number];

/** The price-table version the harness stamps on NEW runs. */
export const MODEL_PRICE_TABLE_VERSION: ModelPriceTableVersion = 'prices-v1';

/**
 * The CONSERVATIVE table the runtime spend guard prices against, and the version a
 * billable crossing manifest MUST pin. `prices-v4` retains the v3 search fees and
 * updates the OpenAI row to the highest currently reachable Fast long-context rates.
 * Earlier tables remain immutable for replay. The default stamped version stays
 * `prices-v1` so existing historical manifests/cohortIds do not churn.
 */
export const SPEND_GUARD_PRICE_TABLE_VERSION: ModelPriceTableVersion = 'prices-v4';

export function isModelPriceTableVersion(value: string): value is ModelPriceTableVersion {
  return (MODEL_PRICE_TABLE_VERSIONS as readonly string[]).includes(value);
}

/** One model's published token rates, in integer USD-micros per million tokens. */
export interface ModelPrice {
  readonly inputUsdMicrosPerMillionTokens: number;
  readonly outputUsdMicrosPerMillionTokens: number;
  /**
   * Integer USD-micros per BILLABLE web search, present only in tables that
   * price the declared search tool (`prices-v3` onward). Absent means the table
   * cannot price search: a version pinned without it fails CLOSED the moment an
   * attempt reports a nonzero search count, rather than silently pricing the
   * fee at zero.
   */
  readonly searchUsdMicrosPerSearch?: number | undefined;
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
 * `prices-v2` — the conservative upper-tier token table (the guard table through prices-v2;
 * `prices-v3` keeps these rates and adds search fees): each model's HIGHEST
 * conservatively-reachable published tier (snapshot observed 2026-07-23, reconcile again
 * immediately before any paid
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
 * Reasoning/thinking bill at the OUTPUT rate; the conservative spend path multiplies the right
 * token buckets by these input/output rates — this module holds only the rates and does no
 * arithmetic.
 */
const MODEL_PRICE_TABLE_V2: ModelPriceTable = {
  'gpt-5.6-sol': { inputUsdMicrosPerMillionTokens: 12_500_000, outputUsdMicrosPerMillionTokens: 60_000_000 },
  'claude-fable-5': { inputUsdMicrosPerMillionTokens: 10_000_000, outputUsdMicrosPerMillionTokens: 50_000_000 },
  'gemini-3.1-pro-preview': { inputUsdMicrosPerMillionTokens: 4_000_000, outputUsdMicrosPerMillionTokens: 18_000_000 },
  'grok-4.5': { inputUsdMicrosPerMillionTokens: 4_000_000, outputUsdMicrosPerMillionTokens: 12_000_000 },
};

/**
 * `prices-v3` — the conservative guard table WITH the web-search fee, and the version a
 * billable manifest must pin now that every arm runs the declared search tool. Token rates
 * are `prices-v2`'s unchanged; the addition is `searchUsdMicrosPerSearch`, each provider's
 * published per-invocation search fee (snapshot observed 2026-08-07, reconcile again
 * immediately before any paid run):
 *   - `gpt-5.6-sol` ........... OpenAI: $10.00 / 1,000 calls = $0.01 per call. Billed per
 *       search ACTION ("Search actions incur a tool call cost"); page-navigation actions
 *       carry no documented fee. Search content tokens bill as ordinary model tokens.
 *   - `claude-fable-5` ........ Anthropic: $10.00 / 1,000 searches = $0.01 per search. "Each
 *       web search counts as one use, regardless of the number of results returned"; errored
 *       searches are not billed. Search results bill as input tokens.
 *   - `gemini-3.1-pro-preview`  Google: $14.00 / 1,000 executed QUERIES = $0.014 per query
 *       (Gemini 3.x bills per query the model chooses to execute, not per prompt; the free
 *       monthly allowance is deliberately NOT modeled — a guard that assumed free searches
 *       would under-count). Retrieved context is not charged as input tokens.
 *   - `grok-4.5` .............. xAI: $5.00 / 1,000 calls = $0.005 per call; only successful
 *       executions bill.
 * The unit differs per provider (call vs executed query) and each table row prices the unit
 * that provider actually bills, which is why the count is derived per provider rather than
 * normalized. `prices-v1`/`prices-v2` are retained UNCHANGED for replay of evidence produced
 * under them; the default stamped version stays `prices-v1`.
 */
const MODEL_PRICE_TABLE_V3: ModelPriceTable = {
  'gpt-5.6-sol': {
    inputUsdMicrosPerMillionTokens: 12_500_000,
    outputUsdMicrosPerMillionTokens: 60_000_000,
    searchUsdMicrosPerSearch: 10_000,
  },
  'claude-fable-5': {
    inputUsdMicrosPerMillionTokens: 10_000_000,
    outputUsdMicrosPerMillionTokens: 50_000_000,
    searchUsdMicrosPerSearch: 10_000,
  },
  'gemini-3.1-pro-preview': {
    inputUsdMicrosPerMillionTokens: 4_000_000,
    outputUsdMicrosPerMillionTokens: 18_000_000,
    searchUsdMicrosPerSearch: 14_000,
  },
  'grok-4.5': {
    inputUsdMicrosPerMillionTokens: 4_000_000,
    outputUsdMicrosPerMillionTokens: 12_000_000,
    searchUsdMicrosPerSearch: 5_000,
  },
};

/**
 * `prices-v4` — same search-fee units and non-OpenAI token rates as v3, reconciled
 * against official pricing on 2026-08-10. OpenAI Fast mode may be selected as the
 * project default when the adapter omits `service_tier`; its long-context rates are
 * $20/M input, $25/M cache writes, and $90/M output. The single input-rate field
 * therefore uses $25/M so cache-write/input accounting cannot underprice any
 * reachable input bucket. The $90/M output rate covers Fast long-context output.
 */
const MODEL_PRICE_TABLE_V4: ModelPriceTable = {
  ...MODEL_PRICE_TABLE_V3,
  'gpt-5.6-sol': {
    inputUsdMicrosPerMillionTokens: 25_000_000,
    outputUsdMicrosPerMillionTokens: 90_000_000,
    searchUsdMicrosPerSearch: 10_000,
  },
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
  'prices-v3': MODEL_PRICE_TABLE_V3,
  'prices-v4': MODEL_PRICE_TABLE_V4,
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
