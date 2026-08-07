# Canonical MLB Benchmark Prompt Contract — v0 Draft

- Last updated UTC: 2026-08-07T00:00:00Z
- Status: the system prompt below is the live contract for prompt scaffold `shadow-smoke-v0.5` (beat-the-close axes prompt, response schema v2, ASCII punctuation); still not preregistered and not approved for a public cohort. The superseded pre-axes prompt is retained in the appendix.
- Parent methodology: [AGENT_BENCHMARK.md](AGENT_BENCHMARK.md)

## Design intent

Every model receives the same logical frozen bundle, the same declared web-search tool, and returns a forced forecast plus its five-axis line-movement read for each market the game supplies — one to three of moneyline, one designated run line, and one designated total. The cohort manifest then selects the moneyline and total (whichever the game supplies) for economic execution under either the recommended fixed moneyline+total policy or a separately labeled model-choice side+total policy.

The model does not size stakes or see later prices; each arm runs the cohort-declared provider web-search tool (tools-v1), and every executed query and result reference is recorded for audit. Forced forecasts provide the common paired comparison; execution and abstention are distinct policy layers.

This draft is a schema and behavior contract. The exact data fields, cutoff, reasoning settings, repair policy, execution-market policy, and public wording must be frozen before a canonical cohort.

## System prompt draft

```text
You are one participant in a preregistered sports-market decision benchmark running through Ospex.

Your goal is to beat the close. Beating the close is predicting line movement, not outcomes. Only things the market isn't potentially pricing in correctly carry weight.

A causal decomposition of line movement, in five axes:

Valuation: a number moves because someone reprices it.
Valuation is the knowledge of team strengths, statistics, player fatigue, travel, weather, and any applicable venue factor that impacts odds. While this information is all public, a contest that sits higher on the valuation axis is a contest where there appears to be a gap between these facts and the price.

Trend: a number moves because it structurally tends to move.
Trend is the knowledge of historical line movement and when/if this line movement is relevant to the current pricing model. Trend can be applied broadly, as in, odds tend to move in a direction when a certain team is involved, or very specifically, where under certain specific conditions, line movement correlates strongly to a given condition.

Consensus: a number moves because flow pushes it.
Consensus is the knowledge of how recreational and sharp backing should influence the line. Public narratives, pundit opinions, and momentum from social outlets may not be properly priced into current odds, as the overall news cycle may react to odds in a way that influences pricing.

News: a number moves because information arrives.
News is the knowledge of the probability and likelihood of an event occurring or a change in potential rosters, lineups or player injury status. Though these things cannot be predicted, the chance of these impacting the price is very real, and relevant movement related to which players are expected to be playing in the game, and how much, may not be appropriately represented in current odds.

Softness: a number moves because it was never firmly set.
Softness is the knowledge of a number's room to move, regardless of why. Not every line is equally defended, as a nationally televised game will have a more precise opener than a game involving teams outside the normal rotation, such as an Ivy League football matchup. Softness is the one axis that's market-structural rather than sport-analytical and can also be quantified as a measure of difficulty and opportunity.

Valuation is fundamental disagreement, trend is momentum, consensus is flow, news is catalyst timing, softness is liquidity and attention.

Rate each axis 1 to 5 for this specific contest: 1 no factor, 2 minor, 3 moderate, 4 strong, 5 dominant. Rate the opportunity, the chance this factor moves the number before close, not how much you know about it. A high rating means you expect movement, and your pick should be the side that benefits.

Name one axis as your primary driver, even if two or more share the highest rating: the one that actually drove the pick. For that axis, state in one sentence what you expect to happen and which direction it moves the number. If every axis is 1, name no primary driver and say you expect no material movement.

Most contests present one or two real opportunities, often none. A rating of 1 is a legitimate and common answer. Do not manufacture a factor to fill an axis. You are scored only on whether the number moved your way. Thorough analysis that lands on the wrong side scores worse than a thin read that lands on the right one.

Information that has been public for some time is already in the number. When you search, note when something became known. Only recent or still-emerging information can move a price that has already absorbed everything else.

Now the task. For every eligible game, forecast each supplied market. A game supplies one to three of the following, and you forecast exactly the markets it supplies:
1. Select a moneyline side.
2. Select a side on the designated spread/run line.
3. Select over or under on the designated total.

For each forecast, supply win/push/loss probabilities that sum to 1, your rationale, your five axis ratings, your primary driver and its one-sentence expectation, and whether you would ordinarily abstain. Follow the cohort's declared execution policy when marking forecasts for execution: either fixed moneyline+total (the moneyline and total forecasts, whichever the game supplies) or spread+total.

Use the exact market, line, team/side labels, and observed decimal prices from the bundle. Do not size stakes. A fixed equal-risk policy is applied by the harness.

Return only JSON matching the requested schema. Do not add prose outside the JSON. Market labels, lines, team and side names, and observed prices must come exactly from the bundle. Where a rationale rests on bundle facts, cite the relevant evidenceRef IDs; where it rests on outside reasoning or a search you performed, say so plainly rather than citing a bundle ref that does not support it. If required information is missing or contradictory, record the supplied reason code rather than inventing facts.
```

## Frozen bundle requirements

The bundle should contain a versioned, normalized record for each game:

- canonical game ID, league, scheduled start, away/home teams;
- bundle timestamp, decision cutoff, and bundle SHA-256;
- status and eligibility flags;
- probable/confirmed starters and lineup status;
- injuries/availability fields included under the cohort's fixed data policy;
- weather/park fields included under the cohort's fixed data policy;
- selected historical/team/player features with source timestamps;
- reference prices for each supplied market — one to three of moneyline, spread, and total — each with both sides, exact line, decimal price, and observation timestamp;
- stable evidenceRef IDs for every field a rationale may cite;
- no information observed after the declared cutoff.

Provider/source brands should not be displayed on user-facing decision surfaces. Public artifacts may describe methodology and provenance at the cohort level where disclosure is permitted and necessary, while the decision prompt uses neutral `reference odds` wording.

## Output schema draft

```json
{
  "schemaVersion": 2,
  "cohortId": "string",
  "participantId": "string",
  "requestedModelId": "string",
  "bundleSha256": "64 lowercase hex characters",
  "executionPolicy": "fixed-moneyline-total | model-choice-side-total",
  "games": [
    {
      "gameId": "string",
      "forecasts": [
        {
          "market": "moneyline | spread | total",
          "selection": "exact supplied team/side/over/under label",
          "line": null,
          "observedDecimal": 0.0,
          "probabilities": {
            "win": 0.0,
            "push": 0.0,
            "loss": 0.0
          },
          "confidence": 0.0,
          "wouldAbstain": false,
          "selectedForExecution": false,
          "rationale": "short grounded rationale",
          "evidenceRefs": ["string"],
          "reasonCode": "missing_information | contradictory_information | null (optional)",
          "axes": {
            "valuation": 1,
            "trend": 1,
            "consensus": 1,
            "news": 1,
            "softness": 1
          },
          "primaryAxis": "valuation | trend | consensus | news | softness | null",
          "primaryExpectation": "one sentence on the primary axis, or that you expect no material movement"
        }
      ]
    }
  ]
}
```

Each game must contain exactly one forecast per market it supplies — one to three of moneyline, designated spread, and designated total. Under the fixed moneyline+total policy the moneyline and total forecasts (whichever the game supplies) are marked for execution and the spread is not. For spread/total, `line` is required; for moneyline it is `null`. Win/push/loss probabilities and confidence are values from 0 through 1; probabilities sum to 1, with push set to zero for binary contracts. `evidenceRefs` lists the bundle evidenceRefs the rationale actually rests on and may be empty when the rationale rests on outside reasoning or a search the model performed (the system prompt directs the model to say so rather than cite an unsupporting ref); every present entry must name an evidenceRef in that game's bundle record. `reasonCode` is optional and defaults to null; it carries the supplied reason codes the system prompt refers to (`missing_information`, `contradictory_information`) when required information is missing or contradictory. `axes` carries integer 1-5 scores on exactly the five named analysis axes; `primaryAxis` names the single axis most driving the forecast (null exactly when every axis is rated 1) and `primaryExpectation` is one single-line sentence, never null: with a named driver it states the expected development on that axis, and with no driver it states that no material movement is expected. Responses are validated by the versioned provider-neutral schema in the harness (response schema v2 = this document; v1 is the pre-axes shape retained for replay of archived records): new runs fail validation without the v2 fields, archived v1 records still parse.

## Deterministic baseline contract

The eight baseline participants (`baselines-v0.2.0`; v0.1.0 was the same set without the run-line pair) bypass the language-model prompt entirely and run through versioned deterministic code:

- `baseline-favorite-ml`: lower decimal moneyline; exact tie → home;
- `baseline-underdog-ml`: higher decimal moneyline; exact tie → away;
- `baseline-home-ml`: home moneyline;
- `baseline-away-ml`: away moneyline;
- `baseline-over-total`: Over at designated total;
- `baseline-under-total`: Under at designated total;
- `baseline-favorite-rl`: the designated run line's laying side (negative handicap; price-independent; zero handicap → home);
- `baseline-underdog-rl`: the other side of the same run line.

Each returns the same participant/cohort/game/market/side/line/observed-price identity fields and policy/input hashes, but no rationale or model metadata. Fixtures must prove mirrored choices, tie behavior, no randomness, and byte-stable output for identical input; missing/stale-market exclusion is enforced upstream at the bundle layer — a game without fresh two-sided odds in every designated market never reaches the baselines.

Generate two records without conflating them: a same-snapshot common-cutoff decision used in primary model comparison and an optional first-eligible execution record used only in the early-entry strategy track.

## Parsing and repair policy draft

- Temperature/randomness and provider reasoning settings are explicit in the cohort manifest.
- A syntactically invalid response may receive at most one deterministic format-repair request containing no new market information. The repair request carries NO declared tools, so it cannot search: a repair that could gather fresh information would be producing a second, independent read of the market rather than reformatting the first one.
- The repair request may not invite a new decision; it asks only for the same choices in valid schema. The five axis ratings, the named primary driver, and its expectation are DECISION-bearing: they are bound into the decision fingerprint, so a repair that changes or supplies them is rejected as a changed decision. A response that omitted the analysis entirely therefore cannot be repaired into one that has it — the runner skips the repair call outright in that case rather than paying for a request that cannot be accepted.
- Missing games, duplicate games, wrong lines, unsupported sides, or changed decisions after repair receive preregistered invalid-output reason codes.
- Provider outages and timeouts are recorded; retries must use the same frozen bundle and occur before the cutoff.
- Raw sanitized response, parsed output, repair request/response, provider response ID, response-reported model, timestamps, tokens, cost, and latency are retained, along with the per-attempt web-search audit: every executed query, every result reference, the billable search count, and any reason the audit is known to be partial.
- A response that is not a finished turn — a paused server-side tool loop, a provider refusal or safety stop, an output-cap truncation (`max_tokens` / `incomplete` / `MAX_TOKENS`), a terminated tool loop, a failed response, or any other non-final provider state — is recorded as a provider outcome carrying that call's full evidence (HTTP status, response and model ids, the partial sanitized text, usage, search audit, and the structured completion state: the provider's own stop reason plus a turn-completed flag), never as a schema failure and never as an accepted answer. Provider completion status is authoritative over body shape — even text that happens to form schema-valid JSON is refused when the provider declared the turn non-final, and offline verification reads the archived structured state to accept exactly that refusal while still rejecting the demotion of a genuinely completed valid response. Continuation of a paused turn is deliberately disabled (`maxServerToolContinuations`), because one attempt is the unit the per-attempt spend reservation bounds.

## Execution policy draft

- The canonical benchmark scores every common fixed-market shadow forecast even if it is not selected or no Ospex fill is available.
- A separate execution record links selected forecast → actual quote → preview → fill/no-fill → transaction.
- Fixed equal risk is applied by the harness, not the model.
- Decision-to-execution delay and price/line drift are reported.
- The signer must be the dedicated wallet for that model participant and must not be an active maker.
- Decision CLV uses the common frozen entry price; execution CLV uses the actual Ospex fill. Both compare with the no-vig exact-contract reference close.

## Open items before v1 freeze

1. Exact feature/data bundle and neutral tool surface.
2. Decision cutoff relative to first pitch and lineup confirmation.
3. Final primary execution policy: recommended fixed moneyline+total versus separately labeled model-choice side+total.
4. Provider-specific reasoning settings and output-schema mechanisms.
5. Exact invalid-output/timeout/retry reason codes.
6. Exact-line/alternate-line closing history, closing-source fallback/max-age rules, and moved-line reporting.
7. Independent push probabilities for integer lines and calibration treatment. (The reference-close formulas are settled: economic + margin-adjusted CLV under `proportional-v1`, with a `shin-v1` sensitivity variant — see AGENT_BENCHMARK.md "CLV methodology"; they are stamped on every scored record.)
8. Stake size and daily/global caps for B1/B2.
9. Public prompt/rationale redaction policy, if any.
10. Pilot-powered minimum unique-game sample, clustered inference, and multiple-comparison policy.

## Appendix: superseded pre-axes system prompt (scaffold v0.1-v0.3)

Retained verbatim for interpreting archived runs: every run stamped a
`promptScaffoldVersion` below `shadow-smoke-v0.4` was produced under this text and
validates against response schema v1.

```text
You are one participant in a preregistered sports-market decision benchmark running through Ospex.

Use only the supplied frozen information bundle and the tools explicitly declared in this request. Do not use memory of later events, external browsing, native provider search, or unstated information. Treat all reference odds as timestamped observations, not guarantees of current executable prices.

For every eligible game, forecast each supplied market. A game supplies one to three of the following, and you forecast exactly the markets it supplies:
1. Select a moneyline side.
2. Select a side on the designated spread/run line.
3. Select over or under on the designated total.

For each forecast, supply win/push/loss probabilities that sum to 1, a short grounded rationale, and whether you would ordinarily abstain. Follow the cohort's declared execution policy when marking forecasts for execution: either fixed moneyline+total (the moneyline and total forecasts, whichever the game supplies) or model-choice moneyline/spread+total.

Use the exact market, line, team/side labels, and observed decimal prices from the bundle. Do not size stakes. A fixed equal-risk policy is applied by the harness.

Return only JSON matching the requested schema. Do not add prose outside the JSON. Ground each rationale in evidenceRef IDs from the frozen bundle. If required information is missing or contradictory, record the supplied reason code rather than inventing facts.
```
