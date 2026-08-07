# Conservative spend accounting: the $100/attempt reservation, what it bounds, and what it only detects

The runtime spend guard reserves a flat **$100 per provider attempt**
(`PROVIDER_ATTEMPT_RESERVATION_USD_MICROS`), prices each attempt's conservatively-derived actual
cost after the response returns, and halts the fire — and, through the escalation latch, the
campaign — the moment that derived actual crosses the reservation. The reservation is an
ADMINISTRATIVE accounting unit, and its backing splits into two regimes:

- **Token spend** is bounded before dispatch: every request carries a finite `maxOutputTokens`,
  input is bounded by each model's context window, and the worked table below shows that the
  worst-case token cost of one attempt at the conservative guard table is **strictly below $100**
  for every model on the roster.
- **Search spend** is bounded before dispatch only where the provider documents a request-side
  search cap (OpenAI `max_tool_calls`, Anthropic `max_uses`). xAI's `max_turns` bounds turns, not
  the tool calls a turn may run in parallel, and Google documents **no cap of any kind** — so on
  those arms nothing in the request prevents a single call from executing more searches than the
  declared ceiling, and the guard's role there is **priced detection and halt after the response,
  not prevention of a single call's overage**. The $100 figure is therefore a reservation the
  accounting enforces and a tripwire the guard prices against — not a proof that no single call
  can invoice more.

The guard prices real cost against `prices-v3` — `prices-v2`'s token rates (each model's
**highest conservatively-reachable published tier**, so the proof below holds without tracking
which context tier a given prompt lands in) plus the per-search fees of the declared web-search
tool. `prices-v1` (the base/short-context tier) and `prices-v2` (no search fees) are retained for
historical replay only.

## Bounding model

For one attempt the conservative cost is

```
cost = input_tokens × input_rate + billable_output_tokens × output_rate
```

priced at the conservative upper tier (token rates identical in `prices-v2` and `prices-v3`). Two
facts bound each factor:

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

## Per-model TOKEN worst case (rates identical in prices-v2/v3, observed 2026-07-23)

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

Every model's worst-case TOKEN attempt is below $100, so for token spend
`roster × (1 + maxRepairsPerArm) × $100` is a sound per-fire ceiling and a token-driven guard trip
indicates a genuine anomaly. Search fees sit on top of these figures and are NOT all bounded
before dispatch — see the next section for which arms cap them and which the guard can only
detect after the fact.

## Web-search fees (tools-v1)

Every arm runs the cohort-declared web-search tool, which adds a PER-INVOCATION fee on top of
the token model above. Those fees are now PRICED INTO the derived actual (`prices-v3`), not
assumed away: each attempt carries a billable search count, and the guard multiplies it by the
provider's published rate. Rates and units as observed 2026-08-07 (each provider bills a
different unit, so each row prices the unit that provider actually bills):

| arm | fee | unit | request-side bound |
|---|---|---|---|
| `gpt-5.6-sol` | $10.00 / 1k | search ACTION | `max_tool_calls: 5` — documented request param, bounds built-in tool calls |
| `claude-fable-5` | $10.00 / 1k | search (one use regardless of results; errors unbilled) | `max_uses: 5` — bounds searches exactly |
| `gemini-3.1-pro-preview` | $14.00 / 1k | executed QUERY (one prompt may run several) | **none exists** |
| `grok-4.5` | $5.00 / 1k | successful call | `max_turns: 5` — coarse: one turn may run tools in parallel |

Two provider facts are load-bearing and were verified against current official documentation
rather than assumed:

- **Google exposes no cap of any kind.** Its entire grounding tool config is a time-range filter
  and a search-type selector; the model decides how many queries to run, and Gemini 3.x bills per
  executed query. `TOO_MANY_TOOL_CALLS` exists as a provider stop, but no documentation states a
  numeric limit it enforces, so it is not relied on as a bound.
- **xAI documents `max_turns`, not `max_tool_calls`, as a request parameter** (`max_tool_calls`
  appears only in its response schema). Sending the undocumented field would either fail the
  request or be silently ignored, so the declared cap rides the documented parameter — and it
  bounds TURNS: a single turn may run tool calls in parallel, so `max_turns: 5` does not cap the
  search count itself.

The declared `maxSearchesPerAttempt` is therefore enforced provider-side on **two** arms (OpenAI
`max_tool_calls`, Anthropic `max_uses`) and OBSERVED-AND-PRICED on xAI and Google.

### What the reservation does NOT bound: search volume on the uncapped arms

For xAI and Google, no request parameter prevents a single call from running more searches than
the declared ceiling, so the per-attempt reservation is not a pre-dispatch bound on that call's
search fees. What the harness does instead: the response's billable search count is priced at
`prices-v3` into the derived actual, an attempt whose derived actual crosses the reservation is a
BREACH that refuses settlement, and the escalation latch stops the campaign from admitting any
further dispatch. That is detection-and-halt of an overage that has already been billed — it
limits how many such calls a campaign can make — the already-admitted fire's attempts
finish, and the latch refuses every subsequent dispatch — not what those calls invoice.

For scale, at Google's $0.014-per-query fee an attempt would need ~7,143 executed queries for
search fees alone to reach $100 (~5,411 on top of Google's worst-case token figure above) —
absurdly far beyond the declared ceiling of 5, but "absurd" is an expectation about model
behavior, not a provider guarantee; nothing documented hard-stops the loop below that number
before the spend occurs.

There is also a residual PARITY asymmetry: xAI and Google may execute more searches than the
capped arms, so the cohort cannot claim identical search budgets across arms. That is disclosed
rather than asserted away. If strict parity is required, the remedy is a tools-v1 config change
(drop the uncapped arms' search tools), not a code change — and they would then be the only arms
without search, which is its own parity problem.

### Unknown counts escalate; they never read as free

A response that proves a search ran but does not permit deriving the count — Gemini 3.x previews
have been observed omitting `groundingMetadata` while `toolUsePromptTokenCount` shows tool use —
yields `searchCount: null`, which the arithmetic treats as UNPRICEABLE and raises as the same typed
UNKNOWN an absent additive token bucket raises. The fire escalates rather than settling on a fee
assumed to be zero. Pinning a pre-search price version (`prices-v1`/`prices-v2`) while a nonzero
search count is recorded fails closed the same way.

The count is persisted per attempt in the spend sidecar, so the offline pair verifier recomputes
the search fee from durable evidence for the two providers (OpenAI, Google) whose usage objects
carry no search counter of their own. Anthropic and xAI additionally report counters in `usage`,
which are whitelisted into the sidecar as independent corroboration.

One documented ambiguity remains, in the safe direction: OpenAI does not state whether a single
search action carrying several query strings bills as one call or several. The count follows the
per-action wording (one call), while an item whose action cannot be read is counted as a search
anyway — over-estimating rather than omitting.

### Usage shapes

The openai and xai arms report usage in their Responses-API shape
(`input_tokens`/`output_tokens`/`output_tokens_details.reasoning_tokens`); the guard prices BOTH
that shape and the legacy chat-completions shape, so archived sidecar evidence keeps re-verifying.
Reasoning is a SUBSET of output on OpenAI and Anthropic and ADDITIVE on Google and xAI; for the
xAI Responses shape, whose docs do not state it, additivity is decided per response by arithmetic
against `total_tokens`, pricing the larger reading when no total discriminates.

## Caveats

- These rates are a **dated snapshot** (published token tiers observed 2026-07-23, search fees
  2026-08-07), not a claim of continuous freshness. Re-reconcile the pinned conservative table
  (`prices-v3`) against current official pricing **immediately before any paid crossing**.
- Where official documentation does not explicitly state a billing detail (e.g. that a provider's
  reasoning/thinking tokens bill at the output rate), the guard adopts the **conservative** (higher)
  treatment; the derived-actual over-estimates rather than under-estimates in every such case.
- The accounting unit is **per attempt** — what the reservation encodes. A provider/price change
  that could invalidate the token table is a versioned `prices-vN` edit plus a manifest re-pin,
  not a silent rate change.

Sources (official provider documentation; token pages observed 2026-07-24, search-fee
pages 2026-08-07):

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

Rate values live in `modelPriceTable.ts` (`prices-v3`), pinned by digest in the cohort manifest and
recomputed at boot. Re-reconcile against current official pricing immediately before any paid crossing.
