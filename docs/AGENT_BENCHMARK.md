# Ospex Agent Benchmark — Canonical MVE Design

- Last updated UTC: `2026-07-14T02:26:51Z`
- Status: accepted application-layer direction; methodology and harness gates remain in progress
- Scope: MLB-first, one fixed canonical cohort plus separately labeled open/community cohorts
- Prompt/schema working draft: [BENCHMARK_PROMPT_V0.md](BENCHMARK_PROMPT_V0.md)

## Purpose

The Ospex MVE began as a controlled fishbowl: market makers, agents, and Vince move small amounts of real value through the protocol while producing public lifecycle evidence. That remains the foundation.

The benchmark adds a distribution and participation hook on top of the fishbowl:

> Given the same frozen pregame information, tools, decision deadline, and execution rules, how do different models perform at making sports-market decisions?

This is a **sports-market decision benchmark running through Ospex**, not a general-intelligence benchmark and not proof that any model can reliably beat an efficient market. Its purpose is to generate reproducible evidence, interesting model/prompt comparisons, and real protocol use without changing the underlying Ospex protocol thesis.

## Layer boundaries

1. **Protocol evidence** — create, quote, match, cancel/invalidate, score, settle, claim, and reach final zero state.
2. **MVE fishbowl** — dedicated market makers, benchmark/research takers, recreational/system flow, and Vince's user experience.
3. **Canonical benchmark** — a preregistered cohort with fixed prompts, tools, inputs, timing, stakes, model configurations, and scoring.
4. **Open/community cohorts** — users may run custom prompts or models, but those results are labeled separately and never silently mixed into the canonical leaderboard.

The benchmark must not block protocol testing. Conversely, a protocol lifecycle success must not be marketed as a valid model benchmark unless the benchmark methodology gates also pass.

## Canonical v1 task

For every eligible game in a declared slate, each model first returns probabilities/selections for the same fixed market set: moneyline, one designated run line, and one designated total. This produces a common paired shadow sample even when the live execution policy places only two wagers.

The cohort manifest must preregister one two-decision execution policy:

1. **Recommended primary:** fixed moneyline plus fixed total for every model and game.
2. **Secondary side-choice track:** let each model choose moneyline or spread, plus a total decision.

The second track matches the original product idea but confounds model performance with market mix, so it must remain separately labeled and market-stratified.

Each output also records:

- model-estimated probability;
- confidence/rank;
- `wouldAbstain` as a non-executing secondary signal;
- short rationale grounded only in the frozen bundle;
- exact market, side, line, and observed price;
- strict machine-readable schema validity.

Forced shadow forecasts prevent cherry-picking and create a predictable paired sample. They measure **forced-choice market discrimination**, not bankroll management. A later selective policy may execute only when model-implied edge clears one common preregistered threshold; it must report coverage, abstentions, fills, and failures.

Use fixed equal risk per executed decision in canonical v1. Do not let models size stakes until model selection can be evaluated independently of sizing. The first valid call determines the live policy action; any shadow stochastic replicates are separately labeled and may never be searched for a preferred pick.

## Sample-size accounting

A normal 15-game MLB day yields about 30 decisions per model and about 210 per model over seven days. A four-model cohort therefore produces about 840 raw model-decision rows, but only about 210 distinct game-market opportunities; the four models see the same underlying events, so 840 must not be presented as 840 independent samples.

Schedule disruptions, the All-Star break, postponements, unavailable reference markets, invalid outputs, and unfilled Ospex orders reduce the realized sample. Report:

- eligible games and markets;
- valid model decisions;
- executable and filled decisions;
- CLV-measurable decisions;
- independent game-market count;
- exclusions with preregistered reason codes.

One week is a useful release-response/instrumentation datapoint, not a definitive ranking. Publish confidence intervals and continue cumulative cohorts. Freeze the confirmatory minimum after estimating variance on label-blinded pilot data; a provisional planning floor is about 500 unique regular-season games over 6–8 weeks, with no early stop because one arm is winning.

## Deterministic baselines and paired design

Canonical v1 uses six transparent, deterministic policy participants rather than asking LLMs to imitate simple behavior:

| Participant ID | Fixed action on every eligible game |
|---|---|
| `baseline-favorite-ml` | Take the lower-decimal-odds moneyline side; exact-price tie breaks to home. |
| `baseline-underdog-ml` | Take the higher-decimal-odds moneyline side; exact-price tie breaks to away. |
| `baseline-home-ml` | Take the home moneyline side. |
| `baseline-away-ml` | Take the away moneyline side. |
| `baseline-over-total` | Take Over at the designated total. |
| `baseline-under-total` | Take Under at the designated total. |

Each baseline produces one action per eligible game on its declared market. It has no language-model call, rationale, discretion, stake sizing, rerun, or hidden tool. Record the policy version, frozen input hash, selected side/line/price, timestamps, eligibility/exclusion reason, and eventual fill/close/settlement exactly as for a model arm.

Score each policy in two clearly separated tracks:

1. **Common-cutoff decision baseline (primary model comparison):** apply the deterministic rule to the same frozen reference snapshot used by the four lab models. This removes early-entry timing as a confound.
2. **First-eligible early execution (separate system-strategy track):** execute as soon as a preregistered gate says the game/market, fresh two-sided reference odds, Ospex speculation, executable maker quote, signer, and caps are all ready. Record `firstEligibleAt`, decision/fill latency, actual price, and execution CLV.

Never compare an early-fill baseline's execution CLV directly with a later model's common-cutoff decision CLV as if the difference were model reasoning. The early track intentionally measures the combined fixed rule plus timing/execution policy.

The six policies form three mirrored pairs—favorite/underdog, home/away, over/under—and are not six independent sources of evidence. Pair model moneyline results with the four moneyline controls and model total results with the two total controls. Cluster uncertainty by game/day and emphasize within-game model-to-baseline differences with preregistered multiplicity handling.

## Frozen-input and anti-leakage controls

Every model in a canonical cohort receives the same logical information bundle, generated at the same cutoff and identified by a content hash. The runner must record:

- cohort ID and ruleset version;
- bundle timestamp and SHA-256;
- prompt/system/scaffold version and SHA-256;
- exact tool definitions and returned tool data;
- model provider, requested model ID, response-reported model/version when available, and model parameters;
- request/response timestamps, provider response ID, token usage, latency, and cost;
- parsed decision and raw sanitized response;
- decision deadline and any retry/repair attempt.

Proxy/archive every tool response. Launch provider calls concurrently where practical and seal each output until all arms submit so no participant or operator can condition a later arm on an earlier answer.

Do not give one provider native web/search access while another sees only the frozen bundle. Provider-native search, browsing, code execution, memory, and hidden multi-agent modes are disabled unless equivalent, logged tools are deliberately supplied to every participant.

Decisions must be committed before the closing snapshot exists. No reruns after seeing later prices. The first valid call determines any live action; transport retries and format-only repairs follow fixed rules. Invalid output handling, provider outage handling, and exclusion rules must be fixed before the cohort starts.

## Model configuration policy

Two benchmark families are useful and must remain distinct:

### Cross-lab flagship cohort

Use one broadly available flagship single-model route from each lab, with exact model IDs and explicit provider-native reasoning settings recorded. The first candidate cohort as of 2026-07-11 is:

- OpenAI `gpt-5.6-sol`;
- Anthropic `claude-fable-5`;
- Google `gemini-3.1-pro-preview`;
- xAI `grok-4.5`.

Direct provider APIs are preferred over consumer-subscription/OAuth aliases for public reproducibility, usage accounting, and stable request metadata. A preview or moving alias must be disclosed; if a fixed snapshot is unavailable, bound the cohort by exact dates and preserve response metadata.

Provider reasoning controls are not perfectly equivalent. Canonical v1 compares each lab's documented high-capability **single-model** configuration, records the differences, and does not claim equal compute. OpenAI multi-agent `ultra` and analogous managed multi-agent modes are separate experiments.

### Within-family cost/capability cohort

A separate OpenAI-family cohort may compare `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and a frozen baseline such as `gpt-5.5`. This is useful for price/performance analysis but is not provider diversity.

Never swap a model during a cohort. A newly released model starts a new cohort or a clearly versioned extension.

## Wallet and signer isolation

Every economic participant has one dedicated wallet identity for the cohort. A wallet may not serve as both an active market maker and a benchmark/model taker in the same run or overlapping window.

Minimum canonical topology after live-wallet gates pass:

- two dedicated maker wallets;
- four dedicated benchmark-taker wallets, one per lab model participant;
- six dedicated deterministic-policy wallets, one per baseline participant;
- Vince's separate user wallet;
- optional separate creator/postgame/operator wallet where operationally useful.

This produces 13 public/economic fishbowl participants before support roles: two makers, four lab-model agents, six deterministic baselines, and Vince.

Creating keystores and role manifests is separate from funding. Wallets should be created and dry-verified before funding; funding and approvals remain bounded and staged. No benchmark key or provider credential enters public docs/artifacts.

This rule is a durable lesson from Block K (artifact PR #49): all model fills were marked `selfMatch: false`, but dual-use of active maker wallets as model takers caused conservative unknown-own-fill holds in market-maker monitoring. That was a harness role-isolation defect, not a demonstrated protocol self-match.

## Closing snapshot policy

Preregister one neutral reference-closing path or a fixed source list, the de-vig method, fallback order, maximum quote age, delayed/postponed-game rules, and treatment of missing sides/feed errors. Use the last source-timestamped quote before official first pitch/in-play status; never select a later or alternative close because it improves an arm's score.

If multiple fixed sources are eventually used, de-vig each source first and aggregate their closing probabilities with one frozen rule such as the median. Until then, describe the metric as **reference-closing CLV** rather than a universal market consensus.

## CLV methodology

Closing-line value is the primary short-horizon signal because it evaluates the price obtained rather than the noisy game result. It is not literally cheat-proof: timing leakage, mutable prompts, inconsistent sources, cherry-picked exclusions, line mismatches, and delayed execution can invalidate it. The controls above make it auditable.

Keep two CLV concepts separate:

- **Decision CLV (primary model metric):** the standardized reference price attached to the model's frozen decision versus the approved close. This isolates selection from Ospex liquidity and maker pricing.
- **Execution CLV (end-to-end metric):** the actual Ospex fill price versus the approved close. This measures selection plus quote availability, maker price, and execution delay.

A no-fill decision can still receive decision CLV if its frozen price and close are valid. It cannot receive execution CLV or realized P&L. Different models must not be ranked as if different maker quotes were model intelligence.

For execution comparisons, give every arm equal quote capacity or isolated identical liquidity lanes. Random fill ordering and quote depletion must not become a hidden model-performance variable.

### Same-outcome, same-line reference-closing CLV

For a unit-stake ticket on selected side `s`:

- `D_e` is the common frozen entry price for decision CLV or actual Ospex fill price for execution CLV, in decimal odds including returned stake;
- `C_s` and `C_o` are the closing decimal odds for both sides of the exact same contract;
- proportional no-vig closing probability is:

```text
q_s = (1 / C_s) / ((1 / C_s) + (1 / C_o))
```

Primary ticket CLV, expressed as closing-implied expected ROI percentage points, is:

```text
reference_clv_pct = 100 * (D_e * q_s - 1)
```

Positive means the entry price beat the no-vig reference close. Do **not** de-vig the Ospex/common entry price: it is the price actually offered. Remove vig only from the external two-sided closing reference.

Also preserve and report the raw entry/closing odds, simple/log decimal-price ratio, and the auxiliary probability-scale movement `100 * (q_s - 1 / D_e)`. These are diagnostics, not competing undisclosed primary formulas.

If the close comes from one designated reference path rather than a fixed multi-book consensus, call the metric **reference-closing CLV** rather than implying a universal market close.

### Push-capable lines

For v1, half-run spreads/totals have the cleanest binary CLV. For integer lines, exact scoring requires closing probabilities for win, push, and loss. With `q_W` and `q_P`:

```text
reference_clv_pct = 100 * (q_W * D_e + q_P - 1)
```

Ordinary two-sided prices generally do not identify push probability. Without a preregistered independent `q_P`, mark integer-line primary CLV unavailable or separately label it conditional CLV; do not pool it silently with directly observed binary CLV.

### Spread and total line movement

Price-only CLV is valid only at the same line. If the main closing spread/total moves, do not silently compare unlike contracts or discard the row without disclosure.

Preferred order:

1. capture the closing price for the exact line taken from line-history/alternate-line data;
2. if unavailable, report numeric primary CLV as unavailable, not zero;
3. report favorable signed line movement separately:
   - spread: `entry_handicap - closing_handicap` from the selected team's perspective;
   - over: `closing_total - entry_total`;
   - under: `entry_total - closing_total`;
4. keep any frozen run-distribution conversion as separately labeled sensitivity analysis, not pooled primary CLV.

Do not attach the new main-line odds to the old contract or invent a conversion between runs and price.

The current Ospex closing-line path has already produced a line-mismatch/null-CLV case. Exact-line closing history or an approved line-value method is a launch gate for credible all-market benchmark claims.

## Scorecard

Primary benchmark outputs:

- mean and median no-vig reference-closing CLV in expected-ROI percentage points;
- percentage beating the no-vig reference close;
- auxiliary raw/log price ratio and probability-scale movement;
- CLV-measurable `n`, total eligible `n`, and exclusion counts;
- equal-weight game-level aggregate as the primary summary, with market-stratified results also reported;
- per-market game-level results as the cross-participant comparison surface: never pool CLV across markets when comparing participants with different market exposure; a pooled figure appears only alongside its per-market breakdown;
- a scoring-policy version stamped on every scored record, so artifacts from different scoring-engine behaviors are never silently compared (unstamped scored output predates versioning and is v0.1.0 by definition);
- results by moneyline, spread, total, model, day, and cohort;
- uncertainty intervals clustered by game/day rather than treating every model row as independent;
- paired differences against every model and preregistered non-LLM baseline, with a preregistered multiple-comparison correction.

Secondary outputs:

- ROI, P&L, win rate, drawdown, and units;
- calibration, Brier score, and clipped log loss from submitted probabilities, plus deltas versus the decision-time no-vig market baseline;
- `wouldAbstain` performance and confidence calibration;
- fill rate, decision-to-execution delay, execution slippage, no-fill rate;
- token usage, API cost, latency, invalid-output rate, and retries;
- protocol lifecycle, settlement, claim, and final-zero evidence.

ROI remains important because actual funds move through Ospex, but it should not rank a one-week cohort ahead of CLV and calibration.

## Publication and claims policy

Before a canonical cohort starts, publish or timestamp the methodology manifest, prompt/tool hashes, model IDs/settings, cutoff/exclusion rules, stake rule, and CLV formula. Afterward publish sanitized inputs, decisions, fills/transactions, closing snapshots, outcomes, costs, and caveats.

Defensible wording:

- "On this preregistered MLB sports-market task and sample, model X had higher measured CLV than model Y."
- "This is one transparent datapoint, not a general model-intelligence ranking or proof of sustainable betting profit."

Avoid:

- "Model X is smarter/better overall."
- "CLV proves the model will win."
- "Four models × 210 markets equals 840 independent trials."
- ranking canonical fixed-prompt cohorts together with community custom-prompt cohorts.

Before broad promotion or public participation, obtain appropriate legal/compliance review for the jurisdictions, wagering/market language, eligibility, model-betting claims, and user-acquisition surfaces involved. These docs define experimental methodology, not legal conclusions.

## Operational scale and cost

At current protocol fees, creating all three markets costs 2.5 USDC per game (one contest plus three speculations). A normal 15-game day is therefore 37.5 USDC in creation fees and a 105-game week is 262.5 USDC before stakes or gas. Standardizing on two markets would be 30 USDC/day and 210 USDC/normal week. The July 11–17 All-Star-break window has 48 scheduled games: 120 USDC for three markets or 96 USDC for two.

Block K's measured SSE capacity also limits the present two-maker topology to two all-market games per concurrent subrun. A normal 15-game slate would require multiple staggered subruns unless subscriptions are multiplexed, capacity is increased safely, or makers are distributed. Full-slate benchmark operations therefore need automation/capacity work; they should not be approximated with one oversized writer wave.

## Ramp to a public benchmark

### B0 — methodology and shadow harness

- finalize strict output schema, frozen bundle, timing, tools, exclusions, CLV definitions, and artifact schema;
- run all candidate models in shadow mode with no economic execution;
- test provider outages, retries, model identity, token/cost capture, exact-line closing capture, and deterministic scoring.

### B1 — role-isolated micro-live

- two dedicated makers and dedicated non-maker takers only;
- two to four games, all market types, tiny fixed stakes;
- prove zero own-state alerts, correct attribution, clean aggregate gates, first-attempt postgame parsing, and final zero state.

### B2 — canonical seven-day cohort

- four dedicated model wallets and direct provider routes;
- all eligible games, one side decision plus one total decision per game;
- fixed stake, frozen prompt/tools, complete public methodology and scorecard.

### B3 — cumulative and open cohorts

- rolling canonical leaderboard across enough events to narrow uncertainty;
- versioned model-release cohorts;
- separate prompt-engineering challenges and community-defined cohorts;
- downloadable runner/SDK path so outsiders can reproduce or create clearly labeled variants.

## Current readiness on 2026-07-11

Ready now:

- bounded all-market protocol lifecycle testing;
- two-maker concurrent quoting within measured SSE capacity when targets are partitioned;
- frozen model input/prompt hashes and model decision ledgers;
- closing-line capture, settlement, claim, and artifact publication;
- shadow within-OpenAI model comparison.

Not ready for a public canonical benchmark yet:

- dedicated wallets for each model participant;
- direct API credentials/routes for all four labs;
- a provider-neutral runner with equivalent tools and explicit reasoning settings;
- exact-line CLV coverage for moved spreads/totals;
- stable aggregate pre-live gate and first-attempt postgame schema handling;
- a live canonical participant registry in the frontend;
- preregistered methodology and enough observations for meaningful claims;
- automated full-slate setup/subrun scheduling within SSE capacity and an explicit daily creation-fee/gas budget;
- appropriate legal/compliance review before broad public promotion or participation.

The immediate objective is not to fund the full fishbowl. It is to close B0/B1 with clean role isolation, then provision and shadow-test the four-lab cohort before B2.