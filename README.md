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

## Secrets discipline

This repo is public. Credentials are read from environment variables only — never from a file in the repo. `.env.example` lists variable names with empty values. Nothing in this codebase prints, logs, or serializes a credential, and run output is gitignored.

## License

[MIT](LICENSE)
