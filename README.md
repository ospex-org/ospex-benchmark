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

## Shadow smoke test (v0)

`src/shadowSmoke.ts` is the B0 shadow harness: it fetches an MLB slate with reference odds from the existing public read path, freezes a content-hashed single-game bundle per game, dispatches the four frontier-model arms **per game** (games sequential, the four arms concurrent within each game, outputs sealed per game so no arm can be conditioned on another's answer), validates every response against the strict schema with a real validator, runs the six deterministic baselines, records everything with full provenance as NDJSON plus a human-readable summary — and stops. No scoring, no wallets, no chain access, no SSE.

Per-game dispatch means one game's failure affects only that game, and each game carries its own decision cutoff (its scheduled first pitch) — a slate cannot be batched when each game's deadline is independent.

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

Runs the full pipeline against a synthetic fixture slate and four scripted mock arms that exercise every path: valid responses, a malformed response repaired into validity, a schema-violating response that stays invalid after the single deterministic repair (on one game only — proving the failure does not poison the rest of the slate), a simulated HTTP 429 producing `rate_limited`, and a timeout. Add `--simulate-collision` to watch the `PROVIDER_COLLISION` hard failure fire.

### Unit tests

```bash
yarn test
```

Covers the slate-date rules and the bundle builder (including the probable-pitcher forward-compatibility and per-game request hashing).

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

Every decision is keyed by `gameId` — the upstream odds-feed event UUID that the production closing-line capture also keys on — so each pick joins to its closing line for later scoring. Outcome codes are `valid`, `invalid_schema`, `timeout`, `credential_missing`, plus two deliberate extensions: `rate_limited` (HTTP 429 — a throttle must never read as a model failure) and `provider_error` (other transport/HTTP failures).

Token accounting: each response's provider usage object is stored **verbatim** (`usageRaw`, including reasoning/thinking-token fields) alongside normalized counts. Dollar cost is never fabricated — a price table can be applied retroactively; token counts cannot be recovered after the fact.

### Slate-date rule

**Store UTC, reason in ET, always.** A slate's date is the US Eastern calendar date of first pitch, and a single MLB slate legitimately spans two UTC dates — so a game's slate day is never derived from a UTC string prefix. The rule lives in one tested module, `src/slateDate.ts`.

## Secrets discipline

This repo is public. Credentials are read from environment variables only — never from a file in the repo. `.env.example` lists variable names with empty values. Nothing in this codebase prints, logs, or serializes a credential, and run output is gitignored.

## License

[MIT](LICENSE)
