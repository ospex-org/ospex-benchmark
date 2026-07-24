# Conservative spend bound: why $100/attempt dominates worst-case real cost

The runtime spend guard reserves a flat **$100 per provider attempt**
(`PROVIDER_ATTEMPT_RESERVATION_USD_MICROS`) and hard-stops a fire whose conservatively-derived
actual cost crosses it. This document proves that, for every model on the roster, the worst-case
cost of a single attempt priced at the conservative guard table (`prices-v2`) is **strictly below
$100**, with substantial headroom — so the reservation is a safe over-estimate, not a value that a
legitimate attempt can breach.

The guard prices real cost against `prices-v2` — each model's **highest conservatively-reachable
published tier** — precisely so this proof holds without tracking which context tier a given prompt
lands in. `prices-v1` (the base/short-context tier) is retained for historical replay only.

## Bounding model

For one attempt the conservative cost is

```
cost = input_tokens × input_rate + billable_output_tokens × output_rate
```

priced at the `prices-v2` upper tier. Two facts bound each factor:

- **Input tokens** are bounded by the model's **context window**. The dispatch always sends a finite
  `maxOutputTokens` (sourced from the required manifest constant), but `maxOutputTokens` does **not**
  bound prompt tokens — which is exactly why the guard prices at the long-context tier: a prompt that
  could cross the tier threshold is priced at the rate it would actually bill.
- **Billable output tokens** (including reasoning/thinking, which bill at the output rate) are bounded
  per provider as follows:
  - **OpenAI / Anthropic** — reasoning/thinking is folded *inside* the completion/output token count,
    which the model's max-output envelope bounds.
  - **Google / xAI** — reasoning/thinking is reported as a *separate additive* bucket
    (`thoughtsTokenCount` / `reasoning_tokens`) and is **not** capped by `maxOutputTokens`. It is
    instead bounded by the model's overall token envelope (there is no separate documented
    thinking-budget contract to rely on), and priced at the output rate.

## Per-model worst case (prices-v2, observed 2026-07-23)

| Model | Ctx / max out | Tier used (in / out per M) | Worst-case attempt | Headroom to $100 |
|---|---|---|---|---|
| `gpt-5.6-sol` (OpenAI) | 1,050,000 / 128,000 | $12.50 / $60 | 1,050,000·$12.50 + 128,000·$60 = **$20.805** | $79.195 |
| `claude-fable-5` (Anthropic) | 1M / 128K | $10 / $50 (single tier) | 1M·$50 + 128K·$50 = **$56.40** | $43.60 |
| `gemini-3.1-pro-preview` (Google) | 1,048,576 / 65,536 | $4 / $18 (>200K) | 1,048,576·$4 + (1,048,576 + 65,536)·$18 = **$24.248320** | $75.751680 |
| `grok-4.5` (xAI) | 500K / — | $4 / $12 (≥200K) | 0.5M·$4 + 0.5M·$12 = **$8.00** | $92.00 |

Notes on the worst cases that are *not* simply base input + output:

- **OpenAI** — output uses the **Priority Processing** rate ($60/M): a project can default requests
  that omit `service_tier` to Priority, and the unchanged adapter omits it, so Priority is reachable.
  Input uses **$12.50/M**: the pricing page bills automatic prompt-cache writes at 1.25× the *standard*
  input ($6.25) but does not bound them in the >272K regime, so the conservative row uses 1.25× the $10
  long-context input — which also over-covers the $10 long-context and $10 Priority input rates.
- **Anthropic** — the derived-actual prices `cache_creation_input_tokens` at the **output** rate
  (cache-write bills 1.25–2× input; the output rate dominates it, so it is the conservative choice).
  The binding worst case treats the entire 1M-token context as cache-creation billed at $50/M, giving
  $56.40 — well under $100.
- **Google / xAI** — the additive reasoning/thinking bucket is bounded by the model's total token
  envelope and priced at the output rate. Bounding thinking by the *full* input envelope (a deliberate
  over-estimate) leaves $24.248320 (Gemini) and $8.00 (xAI).

Every model's worst-case attempt is below $100, so `roster × (1 + maxRepairsPerArm) × $100` is a
sound per-fire ceiling and the per-attempt guard can only trip on a genuine anomaly.

## Caveats

- These rates are a **dated snapshot** (published tiers observed 2026-07-23), not a claim of
  continuous freshness. Re-reconcile the pinned `prices-v2` table against current official pricing
  **immediately before any paid crossing**.
- Where official documentation does not explicitly state a billing detail (e.g. that a provider's
  reasoning/thinking tokens bill at the output rate), the guard adopts the **conservative** (higher)
  treatment; the derived-actual over-estimates rather than under-estimates in every such case.
- The bound is **per attempt** — the unit the reservation encodes. A provider/price change that could
  invalidate it is a versioned `prices-vN` edit plus a manifest re-pin, not a silent rate change.

Sources (official provider documentation, observed 2026-07-24):

- OpenAI — pricing, priority processing, prompt caching, model card:
  <https://developers.openai.com/api/docs/pricing>,
  <https://developers.openai.com/api/docs/guides/priority-processing>,
  <https://developers.openai.com/api/docs/guides/prompt-caching>,
  <https://developers.openai.com/api/docs/models/gpt-5.6-sol>
- Anthropic — pricing, model overview, prompt caching:
  <https://platform.claude.com/docs/en/about-claude/pricing>,
  <https://platform.claude.com/docs/en/about-claude/models/overview>,
  <https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>
- Google Gemini — model card, pricing, tokens:
  <https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview>,
  <https://ai.google.dev/gemini-api/docs/pricing>,
  <https://ai.google.dev/gemini-api/docs/tokens>
- xAI — model card, usage tracking:
  <https://docs.x.ai/developers/models/grok-4.5>,
  <https://docs.x.ai/developers/model-capabilities/text/usage-tracking>

Rate values live in `modelPriceTable.ts` (`prices-v2`), pinned by digest in the cohort manifest and
recomputed at boot. Re-reconcile against current official pricing immediately before any paid crossing.
