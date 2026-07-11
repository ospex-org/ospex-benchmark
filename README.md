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

`src/shadowSmoke.ts` is the B0 shadow harness: it fetches an MLB slate with reference odds from the existing public read path, freezes it into a content-hashed bundle, sends the identical bundle to four frontier-model arms concurrently (outputs sealed until all four settle), validates every response against the strict schema with a real validator, runs the six deterministic baselines, records everything with full provenance as NDJSON plus a human-readable summary — and stops. No scoring, no wallets, no chain access, no SSE.

### Requirements

Node.js ≥ 20.6 and yarn. Install dependencies with `yarn install`.

### Dry run (no credentials, no network)

```bash
yarn smoke:dry
```

Runs the full pipeline against a synthetic fixture slate and four scripted mock arms that exercise every path: a valid response, a malformed response repaired into validity, a schema-violating response that stays invalid after the single deterministic repair, and a timeout. Add `--simulate-collision` to watch the `PROVIDER_COLLISION` hard failure fire.

### Live shadow run

```bash
yarn smoke --date 2026-07-12
```

Environment (see `.env.example`; values via environment variables only — with Node ≥ 20.6 you can keep them in a local gitignored `.env` and run `node --env-file=.env node_modules/.bin/tsx src/shadowSmoke.ts`):

| Variable | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Read-only reference-odds snapshot (`current_odds`), public anon key |
| `OSPEX_API_URL` | Core API base URL (optional; defaults to production) |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY` | Provider arms; a missing key yields an explicit `credential_missing` result, never a crash |

Output lands in `out/` (gitignored): `<runId>.ndjson` (one record per line: run metadata, per-game bundles with hashes, arm responses, per-decision records, baseline decisions) and `<runId>-summary.md`.

Every decision is keyed by `gameId` — the upstream odds-feed event UUID that the production closing-line capture also keys on — so each pick joins to its closing line for later scoring. Outcome codes are `valid`, `invalid_schema`, `timeout`, `credential_missing`, plus `provider_error` as a deliberate extension for transport/HTTP failures that are none of the above.

## Secrets discipline

This repo is public. Credentials are read from environment variables only — never from a file in the repo. `.env.example` lists variable names with empty values. Nothing in this codebase prints, logs, or serializes a credential, and run output is gitignored.

## License

[MIT](LICENSE)
