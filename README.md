# ospex-benchmark

A sports-market decision benchmark running through [Ospex](https://ospex.org), the zero-vig peer-to-peer sports prediction protocol.

**The question:** given the same frozen pregame information bundle, the same decision deadline, and the same strict output contract, how do different frontier models perform at making sports-market decisions?

Each participating model receives an identical, content-hashed bundle (game identity, scheduled start, and timestamped reference odds for moneyline, run line, and total), returns forced forecasts for all three markets per game under a strict JSON schema, and is recorded with full provenance — requested and response-reported model IDs, timestamps, latency, token usage, the extracted answer text, and the complete provider response body it came out of. Forecasts are scored later against no-vig reference closing lines (closing-line value), which evaluates the price obtained rather than the noisy game result.

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

`src/shadowSmoke.ts` is the B0 shadow harness: it fetches an MLB slate with reference odds from the existing public read path, freezes a content-hashed single-game bundle per game, dispatches the cohort's frontier-model arms **per game** (games sequential, the arms concurrent within each game, outputs sealed per game so no arm can be conditioned on another's answer), validates every response against the strict schema with a real validator, runs the eight deterministic baselines, records everything with full provenance as NDJSON plus a human-readable summary — and stops. No scoring, no wallets, no chain access, no SSE.

Per-game dispatch means one game's failure affects only that game, and each game carries its own decision cutoff (its scheduled first pitch) — a slate cannot be batched when each game's deadline is independent.

**Deadline safety.** Games are dispatched in cutoff order (earliest first pitch first; canonical hash ordering is separate and stays by game ID). The clock is checked before each dispatch, before any repair, and on every response acceptance; each provider call is additionally bounded by the remaining time to its game's cutoff. A response that does not exist acceptably before first pitch — including when the decision window closes before a needed repair could even be dispatched — records the explicit outcome `cutoff_missed` and never emits decision records.

**Repair integrity.** A response gets at most one deterministic format repair, and the repair is accepted only when the initial response yields a complete, unambiguous decision fingerprint (every game/market with all decision-bearing fields) that the repair preserves exactly — selection, line, observed price, probabilities, confidence, abstention, and execution marking. An unparseable or incomplete initial response is unrepairable and stays `invalid_schema`; a repair blocked by transport (timeout/429/HTTP failure) records its transport outcome separately so a throttle is never readable as a schema failure.

**Model identity, fail-closed.** Every response-reported model ID must match the arm's approved list exactly (`APPROVED_REPORTED_MODEL_IDS` — the live preflight verified all four labs echo the requested ID verbatim). An unapproved ID — including a same-family substitution — reported-ID drift across games, or a successful response that reports no model ID at all fails the run loudly (only arms that never produced a response body, e.g. pure timeouts, are exempt and surfaced as warnings). Identity failures carry the machine code `MODEL_IDENTITY`; two arms that are indistinguishable as ENTRANTS — same reported model under the same configuration — carry `PROVIDER_COLLISION`.

**One participant, one configuration.** An arm is one competing configuration, not a lab and not a model line: a lab may enter several models, and one model may enter at several reasoning settings, provided each entry's settings differ. Each participant's settings are recorded in its own lab's vocabulary, verbatim and unmapped, hashed into the cohort identity, and stamped on the run. The scorer recomputes that digest, checks it against the precommitted roster, and checks that each attempt's recorded request actually carried the declared settings — so a setting that was declared but never sent makes a run unscoreable rather than a quietly cheaper answer. What no response can prove is whether the provider honoured the setting; nothing echoes one back.

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

Artifact safety: every byte serialized to NDJSON or the summary passes through credential redaction at the write chokepoint — parsed rationales, validation errors, reported IDs, and raw usage objects included, not just the model's answer text — and every dynamic console line prints through the same redactor.

### Retained response envelopes

Each attempt records two provider-derived values, deliberately separate: `answerText`, the answer the adapter extracted, and `responseEnvelope`, the **complete HTTP response body** it was extracted from, with a `sha256` over exactly the stored bytes and their UTF-8 length. Files written before this existed carry the extracted text alone, under its former name `rawResponse`; both names are read, and a record carrying neither is refused at the parse rather than read as an empty answer. Compatibility runs one way only: a checkout from before the rename requires `rawResponse` and cannot parse a file this build writes, so score and project a run with a build at least as new as the one that produced it.

The envelope is what makes an audit re-derivable. A per-attempt web-search audit is whatever the extractor of the day made of the response, so when a provider ships a shape that extractor does not recognize, the audit comes back empty and — with the body discarded — is indistinguishable from a model that did not search. Retaining the body separates the two:

```bash
yarn replay:search-audit out/<runId>.ndjson
```

re-extracts every attempt's audit from its retained envelope and reports where the result now differs. It reads the named files only: no provider is called and nothing is billed. On a **dry run** every *replayed* leg reports as changed, and that is correct: a mock's recorded audit is a hand-built fixture rather than something extracted from its (also synthetic) body, so the two are not meant to agree. (Legs that received nothing — a timeout, a throttle — report envelope-unavailable instead; the dry-run slate measured on 2026-08-21 split 11 replayed / 4 unavailable.) On a live run a changed leg means the parser now reads that response differently than it did at the time.

The command exits non-zero on two kinds of leg. An envelope present but **unreadable**, in the four ways that happens and reported apart: not a well-formed envelope (`malformed` — the same `.strict()` schema the scorer parses with, so a shape one refuses the other refuses), a body that does not reproduce its digest (`digest-mismatch`), a body that is not parseable JSON (`unparseable`), or no extractor registered for its provider (`no-extractor`). And a leg that received a response and retained nothing, in a file that is not a pre-retention archive (`unretained`) — the same reading the scorer gives the same bytes.

None of those is `envelope-unavailable` — "we could not read this", "there was nothing to read" and "this was thrown away" are readings this whole section exists to keep apart, and an archived file's honest answer is the second one, at exit 0. `--quiet` prints only the legs the exit code is about, one line each prefixed with their file, and nothing at all when there are none, which is the form to point at a directory of evidence.

The body is stored **as received** — not canonicalized, not re-serialized — because key order, whitespace and number formatting are part of what identifies an unrecognized shape. Credential values are substituted out before the digest is taken, so the digest covers exactly what is stored. Credentials travel in request headers, which the adapters hand straight to `fetch`; what is pinned by test is that across all four registry arms, neither the envelope, the recorded request params, nor the answer text carries a configured key value or any of the three auth header names. Retention covers a 2xx **whatever the body turns out to be** — a 200 whose body no parser understood is the shape the envelope exists for, and it used to be the one shape discarded. Keeping the bytes is only half of that, though, and the other half is structural: the envelope is sealed *before* any adapter reads the parse, and the read runs inside the one guard that owns the conversion, so a shape an adapter cannot walk raises a typed failure carrying the sealed bytes and the status rather than an untyped `TypeError` the runner would discard along with both. That guard is the only route to a parsed body — all four registry adapters go through it, and a fifth would have to.

What was measured rather than argued: over every adapter the production registry returns, a 2xx body of literal `null` (the one JSON value that throws on any property access — `undefined` is not expressible in JSON), and per provider a null or wrong-typed member where the extractor expects content, including a null element inside the array it walks. Those tables are in `src/providers/responseEnvelope.test.ts`, and the end-to-end case in `src/responseEnvelopeIntegrity.test.ts` reads the retained bytes and the `200` back off the written run file. The space of JSON values is not swept and cannot be; what the tables show is that the conversion is reached, and the guard is what carries it to shapes not in them. A non-2xx body retains nothing and keeps its existing truncated error detail, since a provider error body is the likeliest place request content is echoed back. A body that **drops mid-read** — `fetch` resolves at the headers, so a connection can fail after the status line — is recorded as status `0` rather than as the status on those headers, and retains nothing: a body that was never read is a transport failure, not a receipt, and calling it a 2xx would refuse an untampered run file for an envelope no code could produce.

Retention is uncapped on that path, so a run file grows by roughly the size of every response body it received. Measured on a dry-run artifact (synthetic bodies, 2026-08-21): envelopes were 33,885 of its 144,346 bytes, so retention added about 31% to what the same file would otherwise weigh. A live body carries grounding chunks and citations and is larger; that multiple has not been measured.

Envelopes are **private evidence**. They live in the run file under `out/` (gitignored), and the serving projection publishes no column carrying one — what it takes from an envelope is whether one exists **and can still be parsed**, which is what separates a provable `no_search_evidence` from an `unknown_unproven` nobody can check. Presence alone is not enough now that retention covers every 2xx: a leg holding a proxy's HTML error page carries bytes that verify against their own digest and support no re-derivation at all, and it publishes `unknown_unproven` — the same reading `replay:search-audit` gives it.

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

Joins a run's frozen decisions (and the deterministic baselines) to the production-captured closes by the verified game/market key and computes **reference-closing CLV** both ways per the methodology — one formula, two entry prices, always reported side by side. The **economic** metric keeps the frozen entry price vig-in: `100 · (D_e · q_s − 1)` with `q_s` the proportional no-vig closing probability of the selected side — the industry-standard reading, which sits at about minus the vig when nothing moves. The **margin-adjusted** metric replaces `D_e` with the fair price from the proportionally de-vigged two-sided entry quote, reducing to `100 · (q_close / q_entry − 1)` on push-free contracts — zero means the forecast exactly matched the market. De-vig methods are named and versioned on every scored record (`proportional-v1` primary at both ends, identical to the production closing-line capture; a `shin-v1` sensitivity recompute of both metrics is reported separately labeled — as a PAIRED comparison over the identical decision set with unpaired counts disclosed, and defined only on non-underround quotes, booksum >= 1). The whole close is validated before side selection — the stored no-vig pair must be complete, finite, within [0, 1], sum to 1, and (when the raw two-sided quotes are present) match their canonical recompute on BOTH sides; any failure refuses the close outright (`close_inconsistent`) for every participant and side rather than scoring from either representation. Policy, preregistered in the scored output: `fresh`-confidence closes only; exact-line price CLV only at the unchanged line (a moved spread/total reports signed favorable line movement instead of a number — never zero).

**Close timing is judged from evidence, not assumed** (scoring `scoring-v0.6.0`). Every close carries its capture timestamps — `lock_time`, `value_captured_at`, `last_polled_at`, `poll_gap_seconds` — into the metric and onto the scored record, and two independent things are done with them.

First, a close whose market the odds feed was still quoting **after** the row's own recorded lock — its last sighting of the market **at least 1000ms past** that lock — is refused outright as `close_after_start`. The threshold is not zero because `poll_gap_seconds` is stored at integer-second granularity, so a poll a few hundred milliseconds after the lock rounds to a stored gap of `0`; the tolerance absorbs exactly that quantisation and nothing more (measured over the captured corpus, refused rows sit at least 260s past lock and the rows it admits at most 467ms). Two adjacent checks are **strict**, with no tolerance, because they compare direct timestamps rather than an integer-second derived value: a price whose `value_captured_at` is even one millisecond past its own lock is refused as `close_value_after_lock`, and the same holds against the schedule row. Separately, a row whose stored gap disagrees with its own timestamps, whose timestamps carry no explicit UTC offset, or which claims `fresh` confidence while missing the capture instants that claim rests on, establishes nothing and is refused as `close_timing_unusable` rather than being judged on either representation. The refusal: the feed's own behaviour contradicts the recorded cutoff, so the row's pre-game status is not established, and — like every close-quality gate — the refusal is selection-independent and is honored identically by the totals ladder. This is the negative-side bound on the same poll-gap quantity whose positive side the upstream freshness classification already bounds; that classification is one-sided, so arbitrarily negative gaps reach the scorer stamped `fresh` and this gate is the only thing that sees them. It is a **conservative refusal on ambiguous evidence, not a finding of contamination** — a negative gap fits at least three readings (the recorded start was early and the captured value is a genuine pre-game price; the feed quotes in-play; or the feed had simply not yet dropped the game from its live snapshot), and the row alone does not separate them. The corpus carries real counter-evidence too: across every close `yarn audit:closes` enumerated, **zero** rows have a `value_captured_at` that post-dates their own lock, so on the rows measured every refused row's price was recorded at or before its cutoff. That audit walks `closing_lines` by identity key, which rules out repagination dropping a row but **does not** prove it observed every committed row — identity is allocated before commit, and the public anon read path offers no snapshot to close that gap — so read its counts as a lower bound rather than a census. The refusal is the same posture `close_inconsistent` already takes toward an unestablished row, and its cost is published (`closeAfterStartRefused` per run, plus the audit's rate over the closes it enumerated) rather than absorbed silently.

Second, a close whose lock differs from the frozen bundle's scheduled start by at least the schedule-change tolerance (`SCHEDULE_CHANGE_TOLERANCE_MS`, 60000 ms — the generated rehearsal manifest imports the same constant, so the cohort path and `yarn score` tag at one threshold) is **tagged** `scheduleChanged` — a stratum tag, not a refusal: the CLV is still computed and recorded in full, the pick stays in every coverage denominator, and what it loses is membership in the primary same-schedule estimate. Two counts are published per participant and per market: `scheduleChangedTagged` (every tagged pick) and `scheduleChangedExcluded` (the tagged picks that carried a value — exactly what the tag removed from `primaryScoreable`; a tagged pick some earlier gate had already refused is disclosed under that gate's reason instead, never counted twice). The coverage table holds to one arithmetic: **valid decisions = primary-scoreable + schedule-changed held out + the unscored reasons.** And the withheld values are republished rather than discarded — the scorecard's **reschedule-sensitivity stratum** recomputes the primary aggregates over the tagged picks alone (SPEC §7), so a reader can see whether the rescheduled picks behaved differently instead of taking the exclusion on trust.

**Known limitation, published rather than smoothed over.** The recorded lock is the game's scheduled start as it was known when the close was captured — a *prediction* of first pitch, never ground truth. Neither check above detects a start that moved **earlier** without the upstream capture noticing: in that case the lock, the schedule row it was copied from, and the frozen bundle's scheduled start are all the *same wrong instant*, so no comparison available to this scorer can separate them. Closing that gap needs an independent start-time source (the on-chain contest start served by the public read API, or a league schedule feed). Until one is wired, a close passing these gates is not evidence that the game had not started. `yarn audit:closes` measures how much of the captured corpus each check touches.

**Totals additionally carry the `TOTALS_V1` candidate ladder** (scoring `scoring-v0.4.0`): a versioned negative-binomial ladder solves the close-implied mean (push-conditioned at integer closing lines, parameter provenance in [`docs/TOTALS_DISPERSION.md`](docs/TOTALS_DISPERSION.md)) and prices every totals pick inside its method domain (MLB, half-step lines within a finite rail) whose close passes the shared quality gates and solves, at its entry line, with the generalized push-aware formula `100 · (q_W · D_e + q_P − 1)` — line movement alone never disqualifies a pick, and every refusal carries a typed, disclosed reason. `TOTALS_V1` is the preregistered CANDIDATE line-value method: until its independent alternate-ladder validation artifact is published, ladder columns are sensitivity output — separately labeled, never pooled into the primary metrics — and integer same-line picks remain conditional-only. The ladder version and dispersion-parameter version are stamped on every ladder-scored row. Auxiliary diagnostics (probability-scale movement, raw price ratio) ride along.

**Run integrity comes first — the trust model.** The scorer treats the run file's **archived raw provider responses and frozen bundles as the root of trust**, and re-derives every verdict from them; no recorded verdict, count, or label is trusted on its own. Before scoring, it recomputes every harness acceptance gate and refuses on any violation:

- every game, request, and slate hash recomputed from the embedded bundles;
- the **full harness validator** re-run on every archived accepted response against its hash-verified request bundle (a recorded `valid` that would not validate, or a valid response demoted to `invalid_schema`, is a violation), including the repair-acceptance rules (initial must fail with a complete fingerprint the accepted repair preserves);
- every decision re-derived from the accepted response — content and provenance — and backed by exactly one `valid` arm response per game;
- the deterministic baselines re-derived via `runBaselines` under the run's RECORDED policy version (v0.1.0 six policies, v0.2.0 adds the mirrored run-line pair) and compared exactly — archived runs keep verifying as newer baseline versions ship, and the per-decision version stamps are cross-checked against run_meta's `baselinePolicyVersion` (absent on pre-stamp archives); like every non-hashed manifest field, the stamps defend against incoherent edits, not a forger rewriting the whole file consistently — see the trust boundary below;
- the **identity/collision gate recomputed** from the archived reported model IDs and the approved-ID registry — the recomputed failure set must be empty regardless of whether `run_failure` records survive, and any surviving `run_failure` must correspond to a recomputed failure;
- every **retained response envelope** re-hashed from the body stored beside it, so an artifact edited after the fact does not describe itself; and an envelope **required** on every attempt that received a response — a leg with a body and no envelope is lost evidence, not a shrug. That requirement is the default and is waived only for a file that reads as a coherent pre-retention archive as a whole: no `run_meta.evidenceEra`, every leg's answer under the pre-#92 name `rawResponse`, and no `responseEnvelope` key anywhere. Those files are reported as envelope-unavailable rather than failed for a field that did not exist when they were written. Deleting the era stamp from a modern artifact, or nulling its envelopes, does not buy the waiver — each of a run's `2N+1` era markers can only raise enforcement. A **2xx status is itself a receipt**, so a 200 whose body was discarded cannot exempt itself by having no content fields left; that status is read from three places in the same record — the numeric `httpStatus`, the status its `errorDetail` states in prose, and the *absence* of the `httpStatus` key, which is read fail-closed because every build that has written a leg wrote that key. What none of this defends against is a forger who rewrites the whole file consistently (see the trust boundary below): the envelope is bound to nothing outside the file, so a re-sealed body verifies clean. Two bounds worth stating rather than leaving to be found. The cheapest such rewrite needs no digest work at all — renaming every `answerText` to `rawResponse`, dropping every envelope key and dropping the stamp is one `sed`, and the file then reads as a genuine archive; cross-checking the other modern stamps it still carries (`promptScaffoldVersion`, `armRoster`, `watch`, `projection`) would raise that cost and is not done. And a single *errored* leg — one with no answer, no model id and no response id — can still be erased by rewriting all three status carriers into one consistent story, which is three fields on one leg rather than one. What the rules above buy is that no single field decides either question;
- the frozen arm manifest, manifest counts, uniqueness, cross-products, and per-record run/label/cohort identity all enforced.

What this cannot detect, by design: a forger who consistently rewrites the archived raw responses themselves (and the frozen bundles, and their hashes) is fabricating the primary evidence — no self-contained file format can distinguish that without provider-signed responses. The archived artifacts are the stated trust boundary.

**Coverage keeps failures in the denominators.** Every dispatched arm appears in the scorecard with its outcome counts (valid/timeout/rate-limited/…), eligible market count, and valid-decision count — an arm that timed out on every game still shows `0/N`, never vanishes. The **primary summary is the equal-weight game-level aggregate** (per-game mean CLV, averaged across games) per the methodology, and **cross-participant comparison is per market**: vig differs by market, so CLV is never pooled across markets when comparing participants with different market exposure (a moneyline-only baseline vs a three-market model). The scorecard renders a game-level table per market covering every active participant; pooled figures appear only alongside that breakdown, and per-pick pooling stays secondary.

Output: `<runId>-scored.ndjson` (per-pick `scored_decision` records with full provenance — reported model IDs, response IDs, all three hashes — plus per-participant scorecards) and `<runId>-scorecard.md`, both in the run's directory (gitignored). Every scored record is stamped with a `scoringPolicyVersion`, so artifacts produced by different engine behaviors are never silently compared; rescoring a run with a newer engine recomputes history rather than invalidating it. Records without the stamp predate versioning and are `scoring-v0.1.0` by definition; the version bumps on any change to scoring math, aggregation, or the scored-record/scorecard shape. Run it any time after the slate locks — before lock, every pick reports `close_missing` and the scorer says so. Decision CLV only: nothing here measures execution. This is a single reference source, so the metric is always labeled reference-closing CLV, not a market consensus.

Requires only `SUPABASE_URL` + `SUPABASE_ANON_KEY` (the same public read-only anon key).

With `--publish`, the scorer additionally publishes the scored artifact it just
wrote onto the serving projection — the same call `yarn project:scores` makes
over the same bytes on disk, so a one-step publish and a later recovery cannot
disagree. Scoring output is written either way; a publish that does not land in
full exits 1, and the recovery is `yarn project:scores <scored file>`. This leg
needs the serving writer configured (below) against a schema at the scores
capability.

## Serving projection (optional, not wired to a run)

Benchmark output reaches the public today only after settlement, through a
reviewed evidence PR. The serving projection exists to make a sealed forecast
readable inside the gap between the decision and first pitch — on the 2026-08-07
run that gap was 5h34m, while the artifact landed roughly 19h after the decision.

`src/servingStore.ts` is the publisher for it: an append-only writer over nine
`benchmark_*` tables, connecting as a scoped role that holds `SELECT` and
`INSERT` and no mutating verb. A sealed forecast cannot be rewritten and a
published pick can be neither edited nor retracted, because the privilege to do
either is absent rather than merely unused. Every write is one statement, and
every method returns a typed outcome instead of throwing — a benchmark night is
never lost because a projection was unavailable.

A provider call is published in its own right, before the forecasts it produced:

```
await publishAttempt(...)   // once per (participant, game, attempt ordinal)
await sealDecision(...)     // once per market on that call
```

That ordering is part of the contract. A refused or non-final call produces an
attempt row and no decisions, and that row is the opportunity denominator — a
failed arm has to be representable or coverage is computed over successes only.

### Who a row belongs to

A participant is **one competing configuration**: `(lab_id, model_id,
configuration)`, unique among models. Two models from one lab are two entrants,
and the same model at two reasoning levels is two entrants — that comparison is
the point, so the identity has to be able to express it. `configuration` is the
lab's own vocabulary stored verbatim, never normalised, because a normalisation
is a permanent claim of equivalence between settings nobody can defend as equal.
`{}` is a real value meaning "sets no knobs".

The rows are insert-once with no `UPDATE` grant, so an entrant written without
its settings could never be corrected. Every write compares what the caller
supplied against what is stored and refuses on any disagreement rather than
absorbing it.

### Publishing an artifact

The projection is a view **of the artifact**, not a second thing a run emits. A
run writes its NDJSON, and publication reads that file back:

```bash
yarn project out/run-2026-08-09.ndjson [more.ndjson ...]
```

Live publication and recovery are the same call over the same bytes, which is
what makes republishing safe: every write is idempotent, so a row already
present reports `duplicate` and nothing changes. The publisher is fail-soft — it
cannot halt a benchmark night — so a write lost to a network blip is lost
quietly, and re-running this command is how it comes back.

`yarn project` exits **non-zero whenever it did not publish**, including when it
was never configured. That is the opposite of the run paths, deliberately: there
the projection is a side effect and a missing credential must never fail a
night, while here publishing is the entire job.

| exit | meaning |
|---|---|
| 0 | every row is published or already present |
| 1 | publication was attempted and something did not land |
| 2 | usage — no files, or a named file does not exist |
| 3 | no credential is configured, so nothing was attempted |
| 4 | configured, but the publisher was refused |
| 5 | the command itself failed |

### Publishing scored results

The scorer's output gets the same treatment. `yarn score` writes
`<runId>-scored.ndjson` beside the run file, and:

```bash
yarn project:scores out/run-2026-08-09-scored.ndjson [more-scored.ndjson ...]
```

publishes one `benchmark_scores` row per scored pick — both CLV metrics side by
side, the refusal reason when a pick was unscored, the close values it was
judged against, and the run **label** on every row. The label is the read-path
eligibility handle: rows are insert-once, so which runs count toward a
leaderboard is decided by filtering on the stored label, never by republishing.
Scores land against the decisions `yarn project` already sealed — publish the
run artifact first, or every row reports `parent_missing`. The exit-code
contract is `yarn project`'s, through the same implementation.

Idempotency is per `(decision, scoring policy version)` and judged on values:
republishing the same pass — even regenerated, with a fresh timestamp in a
fresh file — reports `duplicate`, while a pass claiming **different** values
under the same policy version reports `contradiction` naming the field, and a
scored artifact from a different execution of the slate than the one whose
decisions are published reports `contradiction` on the run id. A rescore under
a **new** policy version adds rows beside the old ones; nothing is ever
overwritten. Scored files from dry runs, from cohorts outside the published
namespace, or in a format older than the current scorer are refused with a
reason — a scored artifact is derived, so re-running `yarn score` over the
canonical run file regenerates it in the current format.

The scores path requires serving-schema capability **3** (the label column);
the run paths above require 2 and are deliberately unaffected — a watch night
must not be held hostage to a scores migration.

### When a run publishes

`yarn watch` and `yarn smoke` publish each artifact as soon as they have written
it — the watcher once per fired game, the smoke once for the slate. Both read the
file back rather than republishing what is in memory, so a live publication and a
recovery are the same call over the same bytes.

The projection cannot fail a run. Every write returns a typed outcome instead of
throwing, the whole publication is bounded, and the publisher is wrapped so that
even a defect in the publisher itself is logged and stepped over — the artifact is
already on disk by then, and `yarn project` re-derives whatever did not land. A
projection problem never reaches a tick's exit code.

Publishing is *unconditional*, not conditional on being configured: with no
credential the port answers `disabled` for every write without opening a socket,
which is the shipped default and the reason there is one code path rather than a
wired one and an unwired one. It also means the artifact is verified and projected
on every fire whether or not anything is written — so a producer bug, such as a
reveal that does not reproduce its own seal, is reported on an unconfigured host
too.

**A dry run publishes nothing and opens nothing.** `--dry-run` on either command
is documented as "no credentials, no network", and that covers the projection:
the credential is not resolved and no connection is made. Nothing is lost by it —
the publisher's own gate reads `mode` out of the artifact and refuses a dry run
anyway.

Not wired, and worth saying so explicitly: the line-open speculation runner and
the campaign path (`yarn runner:fire`, `yarn campaign:tick`) emit *fire artifacts*,
a different shape the projection has no table for. Nothing there publishes.

Those paths write **no run NDJSON at all**, so the fire artifact is the only place
their evidence survives process exit — and a cohort is armed once, ever, so what a
campaign did not retain cannot be recovered later. Each sent attempt there keeps the
**complete provider response body** beside the extracted answer, sealed with its own
`sha256` and UTF-8 length, and every one of those bodies is inside the `armDigest`
domain. The write, the sink install and every re-parse re-hash each retained body and
**require** one on any attempt whose record says a response came back — an answer, a
reported model ID, a 2xx status, or an `ok` transport, read as four separate carriers
so nulling one does not make a received response look like silence. The one waiver is
an artifact carrying none of the optional attempt fields anywhere in it, which is what
a pre-retention artifact looks like; unlike the run file's rule this one has no era
stamp to delete, because deleting a body moves a digest that is already recomputed.
The bound is the same as the run file's and worth repeating: a *coherent* whole-file
rewrite — every key stripped and every arm digest forged, or a body re-sealed — still
verifies. This is integrity, not tamper resistance. `docs/SPEC-line-open-evidence-model.md`
specifies both rules.

### Before enabling it against a database

```bash
yarn gate:serving
```

Ask the configured database whether it can hold these writes, before any are
sent. It checks the capability version, hands every statement the publisher will
run to the server's own planner, reads the privilege grid at table *and* column
level, and confirms the entrant identity index is unique, nulls-not-distinct and
partial on models — the three properties whose absence is silent.

It also asks the questions a privilege grid alone cannot answer:

- **what the *other* roles can reach**, by every verb — the browser-facing keys
  must not touch the projection at all, and the read API's key must hold no
  privilege of any kind on the model-authored rationale;
- **whether the writer can write *through* row level security.** RLS being
  enabled is not the same as a policy admitting this role: a table whose only
  permissive policy stops naming the writer refuses every insert while every
  grant in the grid still says yes;
- **whether a `SECURITY DEFINER` function carries the role past its grants.**
  Such a function runs as its owner, so `EXECUTE` on one is a door around the
  whole grid — and `EXECUTE` is granted to `PUBLIC` by default.

It is read-only and proves it: the connection carries
`default_transaction_read_only=on`, the server is made to refuse a write before
anything else is asked, and the row counts are compared before and after. That
matters because the projection's zero lifetime inserts are themselves evidence,
and PostgreSQL counts an insert even when its transaction aborts.

Nothing calls it automatically. A preflight that can fail for its own reasons has
no business standing between a slate and a fire.

```bash
# unit tests run with the rest of the suite; they open no connection
yarn test

# the real-PostgreSQL suite, against a scratch database that already carries the
# projection schema. It refuses a non-local host, mints a fresh cohort per run,
# and connects as the scoped role with no owner escape hatch. Its last two checks
# fire a real run and publish the artifact end to end.
yarn store:serving
```

Configuration is entirely optional: with no credential the publisher is disabled
and every write returns `disabled` without touching the network. See the
`BENCHMARK_*` entries in `.env.example`.

TLS is requested explicitly, because a PostgreSQL connection with no `ssl` option
negotiates none. Supplying `BENCHMARK_DB_CA` turns on chain verification;
without it the connection is encrypted but not authenticated, since the
endpoint's certificate chain is not one Node trusts by default.

**One exception, and it is the driver's rule rather than this repo's:** if the
DSN itself states an SSL policy, that wins. The driver parses SSL settings out of
the connection string and applies them over anything supplied alongside, the CA
included, so `BENCHMARK_DB_CA` does not apply to such a URL.

| the DSN | what happens |
|---|---|
| states nothing about SSL | the configured TLS is attached, and nothing in the URL can discard it |
| asks for TLS | deferred to entirely — what the setting means is between you and the driver |
| disables TLS | refused as `plaintext_dsn`, unless the target is loopback or `BENCHMARK_DB_ALLOW_PLAINTEXT=1` |

The third row is the only place this repo overrides the URL, and it is the same
rule the campaign store applies to `STORE_DATABASE_URL`: the role's password is
inside the connection string, so a plaintext connection to another machine puts
it on the wire in the clear. Loopback is exempt, because a local PostgreSQL has
no TLS and demanding it there fails outright rather than degrading.

**Which parameters count is not a list kept here.** The question "does this URL
state its own SSL policy?" is put to the driver's own connection-string parser
rather than answered by inspecting parameter names, so `sslnegotiation`,
`sslrootcert`, `sslcert` and `sslkey` are covered without being named, and a
repeated or empty parameter resolves to whatever the driver resolves it to. Two
earlier versions of this modelled the parser instead — one with a substring
search, one with `URLSearchParams` — and both were wrong in ways that reported an
encrypted connection for one the driver made in plaintext. A differential sweep
over a generated matrix of connection strings checks the resolver's output
against a real `pg.Client` on every one.

Deferring to a value this repo does not recognise is safe rather than lax: an
unrecognised `sslmode` makes the driver negotiate TLS against the system trust
store, which fails loudly against an endpoint whose chain Node does not carry —
it never downgrades quietly.

Worth knowing regardless of any of this: the driver treats `sslmode=require` as
`verify-full`, so `no-verify` is the mode that means encrypt-without-verifying.

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
