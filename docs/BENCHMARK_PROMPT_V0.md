# Canonical MLB Benchmark Prompt Contract — v0 Draft

- Last updated UTC: 2026-07-14T09:05:00Z
- Status: draft for B0 shadow testing; not preregistered and not approved for a public cohort
- Parent methodology: [AGENT_BENCHMARK.md](AGENT_BENCHMARK.md)

## Design intent

Every model receives the same logical frozen bundle and returns a forced forecast for each market SCOPED to that dispatch (evidence-model spec §3.4): the moneyline, one designated run line, and one designated total, for whichever the bundle carries. A co-arrival dispatch may carry all three; a split fire carries fewer. Every consumer derives cardinality from the bundle's present market set — there is no hard-coded three. Under the fixed policy the manifest then marks the present moneyline and total for economic execution (the run line is a shadow forecast); a separately labeled model-choice side+total policy is reserved.

The model does not size stakes, browse, query provider-native search, or see later prices. Forced forecasts provide the common paired comparison; execution and abstention are distinct policy layers.

This draft is a schema and behavior contract. The exact data fields, cutoff, reasoning settings, repair policy, execution-market policy, and public wording must be frozen before a canonical cohort.

## System prompt draft

```text
You are one participant in a preregistered sports-market decision benchmark running through Ospex.

Use only the supplied frozen information bundle and the tools explicitly declared in this request. Do not use memory of later events, external browsing, native provider search, or unstated information. Treat all reference odds as timestamped observations, not guarantees of current executable prices.

For every eligible game, forecast each market supplied in that game's frozen bundle entry (listed under "markets"), and only those markets: a moneyline side, a side on the designated spread/run line, and over or under on the designated total, for whichever of the three the bundle carries. Do not forecast a market the bundle does not carry.

For each forecast, supply win/push/loss probabilities that sum to 1, a short grounded rationale, and whether you would ordinarily abstain. Follow the cohort's declared execution policy when marking forecasts for execution: under the fixed policy, mark the moneyline and the total (whichever are present) and never the spread/run line.

Use the exact market, line, team/side labels, and observed decimal prices from the bundle. Do not size stakes. A fixed equal-risk policy is applied by the harness.

Return only JSON matching the requested schema. Do not add prose outside the JSON. Ground each rationale in evidenceRef IDs from the frozen bundle. If required information is missing or contradictory, record the supplied reason code rather than inventing facts.
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
- reference moneyline, spread, and total with both sides, exact line, decimal price, and observation timestamp;
- stable evidenceRef IDs for every field a rationale may cite;
- no information observed after the declared cutoff.

Provider/source brands should not be displayed on user-facing decision surfaces. Public artifacts may describe methodology and provenance at the cohort level where disclosure is permitted and necessary, while the decision prompt uses neutral `reference odds` wording.

## Output schema draft

```json
{
  "schemaVersion": 1,
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
          "reasonCode": "missing_information | contradictory_information | null (optional)"
        }
      ]
    }
  ]
}
```

Each game must contain exactly one forecast per market present in that game's scoped bundle entry (`markets`) — one moneyline, one designated spread, and/or one designated total, for whichever the bundle carries — and no forecast for a market it does not carry. Under the fixed policy, the present moneyline and total are marked for execution and the spread is not (a moneyline-and-total dispatch marks two; a run-line-only dispatch marks none). For spread/total, `line` is required; for moneyline it is `null`. Win/push/loss probabilities and confidence are values from 0 through 1; probabilities sum to 1, with push set to zero for binary contracts. `evidenceRefs` carries at least one bundle evidenceRef per forecast. `reasonCode` is optional and defaults to null; it carries the supplied reason codes the system prompt refers to (`missing_information`, `contradictory_information`) when required information is missing or contradictory. The final implementation must enforce a provider-neutral JSON Schema rather than prose validation.

## Deterministic baseline contract

The baseline participants (`baselines-v0.3.0`; v0.2.0 was the same set derived unconditionally over all three markets, v0.1.0 was that set without the run-line pair) bypass the language-model prompt entirely and run through versioned deterministic code. The set is derived from the scoped bundle's PRESENT markets: a full three-market bundle yields all eight (byte-identical to v0.2.0), while a split fire yields only the baselines for the markets it carries. The eight, when all markets are present, are:

- `baseline-favorite-ml`: lower decimal moneyline; exact tie → home;
- `baseline-underdog-ml`: higher decimal moneyline; exact tie → away;
- `baseline-home-ml`: home moneyline;
- `baseline-away-ml`: away moneyline;
- `baseline-over-total`: Over at designated total;
- `baseline-under-total`: Under at designated total;
- `baseline-favorite-rl`: the designated run line's laying side (negative handicap; price-independent; zero handicap → home);
- `baseline-underdog-rl`: the other side of the same run line.

Each returns the same participant/cohort/game/market/side/line/observed-price identity fields and policy/input hashes, but no rationale or model metadata. Fixtures must prove mirrored choices, tie behavior, no randomness, byte-stable output for identical input, and dynamic cardinality (a market absent from the scoped bundle produces no baseline for it). A market present in a scoped bundle always carries fresh two-sided odds — stale/one-sided quotes are excluded upstream at the bundle layer before a market enters the scope.

Generate two records without conflating them: a same-snapshot common-cutoff decision used in primary model comparison and an optional first-eligible execution record used only in the early-entry strategy track.

## Parsing and repair policy draft

- Temperature/randomness and provider reasoning settings are explicit in the cohort manifest.
- A syntactically invalid response may receive at most one deterministic format-repair request containing no new market information.
- The repair request may not invite a new decision; it asks only for the same choices in valid schema.
- Missing games, duplicate games, wrong lines, unsupported sides, or changed decisions after repair receive preregistered invalid-output reason codes.
- Provider outages and timeouts are recorded; retries must use the same frozen bundle and occur before the cutoff.
- Raw sanitized response, parsed output, repair request/response, provider response ID, response-reported model, timestamps, tokens, cost, and latency are retained.

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