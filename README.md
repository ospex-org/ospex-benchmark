# ospex-benchmark

A sports-market decision benchmark running through [Ospex](https://ospex.org), the zero-vig peer-to-peer sports prediction protocol.

**The question:** given the same frozen pregame information bundle, the same decision deadline, and the same strict output contract, how do different frontier models perform at making sports-market decisions?

Each participating model receives an identical, content-hashed bundle (game identity, scheduled start, and timestamped reference odds for moneyline, run line, and total), returns forced forecasts for all three markets per game under a strict JSON schema, and is recorded with full provenance — requested and response-reported model IDs, timestamps, latency, token usage, and the raw response. Forecasts are scored later against no-vig reference closing lines (closing-line value), which evaluates the price obtained rather than the noisy game result.

## ⚠️ v0 is a shakedown, not a scored cohort

Everything produced by the current harness is labeled **`SMOKE_V0_NOT_A_COHORT`**. It exists to prove the pipeline — that providers answer, satisfy the schema, and that every pick can be joined back to its closing line. Its entry prices are captured **late** (lines opened days earlier), so any CLV computed from it does not reflect a real early-entry policy. **This data must never appear on a leaderboard.**

## What this is not

- **Not a general-intelligence benchmark.** It measures forced-choice market discrimination on one preregistered task and sample.
- **Not proof that any model can reliably beat an efficient market.** One cohort is one transparent datapoint with confidence intervals, not a ranking of model intelligence.
- **Not betting advice.** Nothing here is a recommendation to wager on anything.
- **Not a mixed leaderboard.** Canonical fixed-prompt cohorts and community/custom-prompt cohorts are never silently pooled.

## Methodology

The authoritative methodology lives in this repo:

- [`docs/AGENT_BENCHMARK.md`](docs/AGENT_BENCHMARK.md) — canonical benchmark design: layer boundaries, frozen-input and anti-leakage controls, deterministic baselines, CLV formulas, publication and claims policy.
- [`docs/BENCHMARK_PROMPT_V0.md`](docs/BENCHMARK_PROMPT_V0.md) — the v0 prompt and output-schema contract.
- [`docs/TOTALS_DISPERSION.md`](docs/TOTALS_DISPERSION.md) — the published MLB totals dispersion parameter (`TOTALS_V1_PROVISIONAL`): fit method, data, gates, and known approximations, feeding the totals ladder.

## Shadow smoke test (v0)

`src/shadowSmoke.ts` is the B0 shadow harness: it fetches an MLB slate with reference odds from the existing public read path, freezes a content-hashed single-game bundle per game, dispatches the four frontier-model arms **per game** (games sequential, the four arms concurrent within each game, outputs sealed per game so no arm can be conditioned on another's answer), validates every response against the strict schema with a real validator, runs the eight deterministic baselines, records everything with full provenance as NDJSON plus a human-readable summary — and stops. No scoring, no wallets, no chain access, no SSE.

Per-game dispatch means one game's failure affects only that game, and each game carries its own decision cutoff (its scheduled first pitch) — a slate cannot be batched when each game's deadline is independent.

**Deadline safety.** Games are dispatched in cutoff order (earliest first pitch first; canonical hash ordering is separate and stays by game ID). The clock is checked before each dispatch, before any repair, and on every response acceptance; each provider call is additionally bounded by the remaining time to its game's cutoff. A response that does not exist acceptably before first pitch — including when the decision window closes before a needed repair could even be dispatched — records the explicit outcome `cutoff_missed` and never emits decision records.

**Repair integrity.** A response gets at most one deterministic format repair, and the repair is accepted only when the initial response yields a complete, unambiguous decision fingerprint (every game/market with all decision-bearing fields) that the repair preserves exactly — selection, line, observed price, probabilities, confidence, abstention, and execution marking. An unparseable or incomplete initial response is unrepairable and stays `invalid_schema`; a repair blocked by transport (timeout/429/HTTP failure) records its transport outcome separately so a throttle is never readable as a schema failure.

**Model identity, fail-closed.** Every response-reported model ID must match the arm's approved list exactly (`APPROVED_REPORTED_MODEL_IDS` — the live preflight verified all four labs echo the requested ID verbatim). An unapproved ID — including a same-family substitution — reported-ID drift across games, or a successful response that reports no model ID at all fails the run loudly (only arms that never produced a response body, e.g. pure timeouts, are exempt and surfaced as warnings). Identity failures carry the machine code `MODEL_IDENTITY`; family-level collisions carry `PROVIDER_COLLISION`.

**Frozen-input freshness.** Every market row must carry a parseable feed-side observation timestamp that is neither in the future beyond a 2-minute clock-skew allowance nor older than 30 minutes at bundle assembly time; violations exclude the game with stable reason codes (`stale_quote:*`, `future_quote:*`, `invalid_quote_timestamp:*`). The bundle timestamp is the fetch **completion** time; an observation may nominally postdate it only within that explicit skew allowance (feed-side clocks are not our own), never beyond it.

### Requirements

Node.js ≥ 20.6 and yarn. Install dependencies with `yarn install`.

### Provider preflight

```bash
yarn preflight
```

Sends one trivial request per provider through the real adapter code path (the same `chat()` the smoke run uses) and prints, per arm: HTTP status, the **response-reported model ID**, the provider's verbatim usage object (the actual token field names), and latency. It asserts every metadata field the harness depends on is present, and exits non-zero naming any credentialed arm that fails. Arms without a credential report `credential_missing` and do not fail the preflight. Costs roughly a penny across all four providers. Flags: `--timeout-seconds` (default 120), `--max-output-tokens` (default 1024).

### Dry run (no credentials, no network)

```bash
yarn smoke:dry
```

Runs the full pipeline against a synthetic fixture slate with ONE injected synthetic clock anchored at the fixture's capture instant — it drives cutoff enforcement and every recorded timestamp, so dry artifacts are temporally consistent (`observedAt ≤ bundleTimestamp < requestAt < cutoffAt`) and enforcement is exercised rather than bypassed (run records carry `clockMode: synthetic-fixture`). Known limitation: the mock arms synthesize typed responses and never read the prompt scaffold, so a green dry run proves the pipeline, not real-model prompt efficacy — only a live run proves that. Four scripted mock arms exercise every path: valid responses, a wrong-echo response repaired into validity with identical decisions, a structurally incomplete response that is unrepairable (on one game only — proving the failure does not poison the rest of the slate), a simulated HTTP 429 producing `rate_limited`, and a timeout. Add `--simulate-collision` to watch the `PROVIDER_COLLISION` hard failure fire.

### Unit tests

```bash
yarn test
```

Covers the slate-date rules, the bundle builder (probable-pitcher forward-compatibility, quote freshness, dispatch-vs-hash ordering, per-game request hashing), the output schema and decision fingerprints, the runner's deadline/repair/transport behavior under an injected clock, the fail-closed model-identity checks, and record provenance plus the redaction chokepoint.

### Live shadow run

```bash
yarn smoke --date 2026-07-12
```

Environment (see `.env.example`): values come from environment variables; a local gitignored `.env` in the repo root is loaded automatically at startup (real environment variables always win, and only variable *names* are ever printed).

| Variable | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Read-only reference-odds snapshot (`current_odds`), public anon key |
| `OSPEX_API_URL` | Core API base URL (optional; defaults to production) |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `XAI_API_KEY` | Provider arms; a missing key yields an explicit `credential_missing` result, never a crash |

Output lands in `out/` (gitignored): `<runId>.ndjson` (one record per line: run metadata, per-game bundles with hashes, per-arm-per-game responses, per-decision records, baseline decisions) and `<runId>-summary.md`.

Every decision is keyed by `gameId` — the upstream odds-feed event identifier that the production closing-line capture also keys on — so each pick joins to its closing line for later scoring. Outcome codes are `valid`, `invalid_schema`, `timeout`, `credential_missing`, plus three deliberate extensions: `rate_limited` (HTTP 429 — a throttle must never read as a model failure), `provider_error` (other transport/HTTP failures), and `cutoff_missed` (the decision window closed first; never emits decisions).

Token accounting: each response's provider usage object is stored **verbatim** (`usageRaw`, including reasoning/thinking-token fields and any provider-reported cost figure) alongside normalized counts. Every live call carries an explicit output-token bound (default 16000, `--max-output-tokens`), recorded in the request params. Dollar cost is never fabricated — a price table can be applied retroactively; token counts cannot be recovered after the fact.

Artifact safety: every byte serialized to NDJSON or the summary passes through credential redaction at the write chokepoint — parsed rationales, validation errors, reported IDs, and raw usage objects included, not just raw response text — and every dynamic console line prints through the same redactor.

### Slate-date rule

**Store UTC, reason in ET, always.** A slate's date is the US Eastern calendar date of first pitch, and a single MLB slate legitimately spans two UTC dates — so a game's slate day is never derived from a UTC string prefix. The rule lives in one tested module, `src/slateDate.ts`.

## Line-open watch mode (fire-at-detection only)

```bash
yarn watch                 # long-running; polls every 5 minutes
yarn watch --once          # single pass (external schedulers)
yarn watch --dry-run       # fixture slate + mock providers, no credentials
```

The smoke enters a slate whenever it is run — often hours after lines
matured, where economic closing-line value is structurally ≈ −vig and
margin-adjusted CLV ≈ 0: the entry matches the market either way, and the
two metrics just state that on different scales. Watch mode is the
methodology's *first eligible* cutoff made real: it polls the same public
read path and, the moment a game becomes eligible (the bundle builder yields
a request — full board, two-sided, fresh quotes), it assembles, hashes, and
fires that one game to all twelve participants **in the same instant**, then
records it in a per-game ledger (`out/watch-ledger/`) and never touches it
again. One self-contained run file per fired game (`out/watch-v0-*.ndjson`)
— scored with the same `yarn score` command, verified by the same integrity
gates.

There is deliberately no deferred firing and no replay: a bundle is used the
instant it is built or not at all. A harness that fires later has watched
the line move in between — a cherry-pick surface no matter how honest the
operator. Entry honesty is enforced by the late-detection gate
(`--late-minutes`, default 60): a game whose full board completed longer ago
than that at detection is recorded as `late_detection` and excluded — never
entered late, never revisited. Watcher downtime therefore costs coverage,
not integrity.

Run files keep the `SMOKE_V0_NOT_A_COHORT` label (typed and
hash-load-bearing); watch runs are identified by the `watch-v0-` runId /
cohortId prefix and remain plumbing validation, not a cohort. Run one
watcher at a time — the ledger makes double-firing impossible across
restarts, not across concurrent processes. Full contract:
[`docs/LINE_OPEN_RUNNER.md`](docs/LINE_OPEN_RUNNER.md).

## Scoring (reference-closing CLV)

```bash
yarn score --run out/<runId>.ndjson
```

Joins a run's frozen decisions (and the deterministic baselines) to the production-captured closes by the verified game/market key and computes **reference-closing CLV** both ways per the methodology — one formula, two entry prices, always reported side by side. The **economic** metric keeps the frozen entry price vig-in: `100 · (D_e · q_s − 1)` with `q_s` the proportional no-vig closing probability of the selected side — the industry-standard reading, which sits at about minus the vig when nothing moves. The **margin-adjusted** metric replaces `D_e` with the fair price from the proportionally de-vigged two-sided entry quote, reducing to `100 · (q_close / q_entry − 1)` on push-free contracts — zero means the forecast exactly matched the market. De-vig methods are named and versioned on every scored record (`proportional-v1` primary at both ends, identical to the production closing-line capture; a `shin-v1` sensitivity recompute of both metrics is reported separately labeled — as a PAIRED comparison over the identical decision set with unpaired counts disclosed, and defined only on non-underround quotes, booksum >= 1). The whole close is validated before side selection — the stored no-vig pair must be complete, finite, within [0, 1], sum to 1, and (when the raw two-sided quotes are present) match their canonical recompute on BOTH sides; any failure refuses the close outright (`close_inconsistent`) for every participant and side rather than scoring from either representation. Policy, preregistered in the scored output: `fresh`-confidence closes only; exact-line price CLV only at the unchanged line (a moved spread/total reports signed favorable line movement instead of a number — never zero). **Totals additionally carry the `TOTALS_V1` ladder** (scoring `scoring-v0.4.0`): a versioned negative-binomial ladder solves the close-implied mean (push-conditioned at integer closing lines, parameter provenance in [`docs/TOTALS_DISPERSION.md`](docs/TOTALS_DISPERSION.md)) and prices every totals pick whose close passes the shared quality gates at its entry line with the generalized push-aware formula `100 · (q_W · D_e + q_P − 1)` — line movement never disqualifies a pick (gate-refused picks carry the same typed reasons as the exact-line metrics), integer same-line picks upgrade from conditional-only to primary via the ladder's `q_P`, and the push-excluded conditional variants of both metrics stay separately labeled alongside. The ladder version and dispersion-parameter version are stamped on every ladder-scored row. Auxiliary diagnostics (probability-scale movement, raw price ratio) ride along.

**Run integrity comes first — the trust model.** The scorer treats the run file's **archived raw provider responses and frozen bundles as the root of trust**, and re-derives every verdict from them; no recorded verdict, count, or label is trusted on its own. Before scoring, it recomputes every harness acceptance gate and refuses on any violation:

- every game, request, and slate hash recomputed from the embedded bundles;
- the **full harness validator** re-run on every archived accepted response against its hash-verified request bundle (a recorded `valid` that would not validate, or a valid response demoted to `invalid_schema`, is a violation), including the repair-acceptance rules (initial must fail with a complete fingerprint the accepted repair preserves);
- every decision re-derived from the accepted response — content and provenance — and backed by exactly one `valid` arm response per game;
- the deterministic baselines re-derived via `runBaselines` under the run's RECORDED policy version (v0.1.0 six policies, v0.2.0 adds the mirrored run-line pair) and compared exactly — archived runs keep verifying as newer baseline versions ship, and the per-decision version stamps are cross-checked against run_meta's `baselinePolicyVersion` (absent on pre-stamp archives); like every non-hashed manifest field, the stamps defend against incoherent edits, not a forger rewriting the whole file consistently — see the trust boundary below;
- the **identity/collision gate recomputed** from the archived reported model IDs and the approved-ID registry — the recomputed failure set must be empty regardless of whether `run_failure` records survive, and any surviving `run_failure` must correspond to a recomputed failure;
- the frozen arm manifest, manifest counts, uniqueness, cross-products, and per-record run/label/cohort identity all enforced.

What this cannot detect, by design: a forger who consistently rewrites the archived raw responses themselves (and the frozen bundles, and their hashes) is fabricating the primary evidence — no self-contained file format can distinguish that without provider-signed responses. The archived artifacts are the stated trust boundary.

**Coverage keeps failures in the denominators.** Every dispatched arm appears in the scorecard with its outcome counts (valid/timeout/rate-limited/…), eligible market count, and valid-decision count — an arm that timed out on every game still shows `0/N`, never vanishes. The **primary summary is the equal-weight game-level aggregate** (per-game mean CLV, averaged across games) per the methodology, and **cross-participant comparison is per market**: vig differs by market, so CLV is never pooled across markets when comparing participants with different market exposure (a moneyline-only baseline vs a three-market model). The scorecard renders a game-level table per market covering every active participant; pooled figures appear only alongside that breakdown, and per-pick pooling stays secondary.

Output: `<runId>-scored.ndjson` (per-pick `scored_decision` records with full provenance — reported model IDs, response IDs, all three hashes — plus per-participant scorecards) and `<runId>-scorecard.md`, both in the run's directory (gitignored). Every scored record is stamped with a `scoringPolicyVersion`, so artifacts produced by different engine behaviors are never silently compared; rescoring a run with a newer engine recomputes history rather than invalidating it. Records without the stamp predate versioning and are `scoring-v0.1.0` by definition; the version bumps on any change to scoring math, aggregation, or the scored-record/scorecard shape. Run it any time after the slate locks — before lock, every pick reports `close_missing` and the scorer says so. Decision CLV only: nothing here measures execution. This is a single reference source, so the metric is always labeled reference-closing CLV, not a market consensus.

Requires only `SUPABASE_URL` + `SUPABASE_ANON_KEY` (the same public read-only anon key).

## Published parameters (totals dispersion)

`data/` holds the committed inputs and output of the MLB totals dispersion fit — the parameter the totals ladder will consume ([`docs/TOTALS_DISPERSION.md`](docs/TOTALS_DISPERSION.md) is the methodology record):

```bash
yarn ingest:retrosheet --download   # historical finals -> data/retrosheet-mlb-totals-2023-2025.ndjson
yarn extract:totals                 # captured closing totals + finals -> data/inhouse-totals-<date>.ndjson
yarn fit:totals --inhouse data/inhouse-totals-<date>.ndjson   # -> data/totals-dispersion-TOTALS_V1_PROVISIONAL.json
```

The fit is deterministic given its committed inputs, refuses to publish on any gate failure, and the test suite recomputes the committed artifact from the committed datasets and requires exact equality. The historical finals derive from Retrosheet game logs. The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".

## Secrets discipline

This repo is public. Credentials are read from environment variables only — never from a file in the repo. `.env.example` lists variable names with empty values. Nothing in this codebase prints, logs, or serializes a credential, and run output is gitignored.

## License

[MIT](LICENSE)
