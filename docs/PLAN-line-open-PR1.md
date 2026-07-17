# PLAN — line-open runner, PR 1 decomposition

**What this is:** a slicing-and-sequencing plan for **PR 1** of the Tier-0 line-open runner,
chopped into small, single-purpose, independently-mergeable sub-PRs.

**What this is NOT:** a spec. The specs (`SPEC-line-open-evidence-model.md`,
`SPEC-line-open-speculation-runner.md`, and `SPEC-prepared-request.md`) are the contract;
this only says *how the work is sliced and in what order*.

**Review scope:** *is this the right decomposition + ordering?* — **not** the design (that
is settled in the specs). Please don't grow this doc into another spec; sizes/deps are
estimates re-confirmed at each sub-PR's start, and any **L** may split further at
implementation if its diff runs large.

## Re-sequencing (2026-07-16) — request integrity is the foundation, cardinality sits on it

The first attempt at **1.4 (dynamic-cardinality bundle)** surfaced that the runner
carries several independently-mutable aliases for what should be one request
(gameId / game / bundle-game / cutoff / hash), and that the hashed identity can
diverge from the bytes actually prompted, validated, and recorded. Those are
**request-integrity** properties — most of them predate the cardinality change —
so the dependency was backwards: request integrity is the **foundation**, dynamic
cardinality is a **feature on top of it**.

Re-sequenced accordingly (see `SPEC-prepared-request.md` for the contract):

- **S1 — prepared request** (new foundation): one immutable, normalized,
  plain-data `PreparedGameRequest` enforced at the pre-provider boundary. Built
  for the current fixed three-market bundle; **no cardinality change**.
- **S2 — baseline policy-version isolation**: v0.1/v0.2 require the full-board
  shape and fail closed on scoped input; **v0.3's scoped baselines are introduced
  later, in S3** (S2 lands only the historical guards).
- **S3 — dynamic cardinality, re-homed**: the original 1.4 goal (relax to 1–3
  present markets + v0.3 scoped baselines + derive from the present set), rebuilt
  on top of S1's prepared request. The validator/baseline/prompt derivations from
  the closed first attempt are reused.

S1→S2→S1d→S3 replace the former 1.4 work; 1.5 (attempt provenance) already
merged; 1.6–1.9 follow S3 and now build on a request they can trust.

**Update (2026-07-17):** S1 and S2 are **merged**. **S1d** — the sealed
run-envelope / adversarial **artifact-producer boundary** deferred from S1c's
convergence — was specified separately (`SPEC-artifact-producer.md`: threat model
+ closed A1–A6 matrix) and now sequences **between S2 and S3** as **S1d-spec**
(PR #27, paper-reviewed) → **S1d-impl** (one code PR judged only on A1–A6).

## PR 1 scope (spec §9)

- **In:** per-market no-wait firing; independent at-most-once claims + crash linkage; the
  atomic budget / concurrency-lease reservation; fire artifacts + one terminal arm outcome
  per expected arm + provenance / `armDigest` / `responseSha256`; rehearsal mode; unit +
  adversarial-fixture tests. **`--live` hard-disabled throughout.**
- **Out (later):** global `U/F/C/M/X/D` coverage reconciliation, close capture, CLV,
  scorecard, bootstrap → **PR 2**; the budget-bounded live canary → **PR 3**.

Nothing on `main` implements the per-market design yet (the closed earlier attempt is not
here), so PR 1 builds fresh atop the reusable primitives: `canonicalize`/`sha256Hex`, the
`odds_history` fetchers + keyset walk, the redaction chokepoint, the fixture clock + mock
adapters, the decision-fingerprint helpers, and the provider arms/roster.

## Decomposition

Merged prerequisites, then the re-sequenced foundation-first slices, then the
remaining runner slices.

| # | Goal (one thing) | Spec § | Status / Deps | Isolated test |
|---|---|---|---|---|
| **1.1** | Versioned `(sport,market)` allow-list + `effectiveEnabled` + recomputed digest (`marketPolicy.ts`) | speculation §3.1 | **merged** | allow-list isolation, default-disabled, digest |
| **1.2** | Strict `CohortManifestV1`→`cohortId`, boot gates, **`--live` hard-disable** (`manifest.ts`) | evidence §2 | **merged** | fixture manifests, no network |
| **1.3** | Independent `odds_history` reads — `firstTwoSided` + as-of quote + `validTwoSidedHistoryRowV1` | evidence §1, §5-V1 | **merged** | fixture rows, id tiebreak, as-of exact |
| **1.5** | Runner per-attempt provenance — causal-ordered timestamps, unique attempt #s, `dispatch_lag_exceeded`, V-lag-initial-only + first-pitch cutoff | evidence §5 | **merged** | fake clock; ordering/classification violations fail |
| **S1** | **Prepared request** — immutable, normalized, plain-data `PreparedGameRequest` at the pre-provider boundary, using **exactly the current three markets** (no cardinality change) | `SPEC-prepared-request` §1–2 | **merged** (S1a+S1b+S1c; S1c #25 `1792b50`) | S1 matrix (§5): aliases/hash/cutoff/plain-data; zero adapter calls on any invalid request |
| **S2** | **Baseline version isolation** — v0.1/v0.2 require the full-board shape and fail closed on scoped input; **no v0.3 scoped behavior yet** | `SPEC-prepared-request` §3 | **merged** (#26 `b8be24b`) | S2 matrix: v0.1/v0.2 goldens unchanged; scoped input rejected under v0.1/v0.2 |
| **S1d-spec** | **Sealed run-envelope contract** — the artifact-producer boundary deferred from S1c: bounded threat model + closed A1–A6 matrix (link, don't duplicate) | `SPEC-artifact-producer` | **PR #27, spec-only, in review** | paper review of the closed matrix |
| **S1d-impl** | **Sealed `RunEnvelope`** — one branded, deep-frozen run envelope the producers authenticate (`assertRunEnvelope`), per A1–A6 | `SPEC-artifact-producer` | after S1d-spec | §6 A1–A6 matrix; A6 byte-compat over **both** producers |
| **S3** | **Dynamic cardinality + v0.3** — relax the prepared boundary to **1–3 present markets**, introduce v0.3 scoped baselines, re-home the validator/baseline/prompt derive-from-present-markets logic (keep `runLine` name) | `SPEC-prepared-request` §2.2/§3/§4 | after **S1d-impl** | S3 matrix: all seven combinations; archived-corpus replay |
| **1.6** | Fire-artifact assembler — `armDigest` (domain-bound) + `responseSha256` (persisted post-redaction bytes) | evidence §4, §5 | after S3 | digest recompute; mutation fails |
| **1.7** | Per-market detection + canonical window gates + deterministic admission ordering (`detect.ts`, rewrites `watch.ts`) | speculation §3 | after S3 | fixtures + synthetic clock, no live |
| **1.8** | Atomic at-most-once claim + budget/spend reservation + `ConcurrencyLeaseV1` + claim/fire ledger + co-arrival partial-claim | evidence §4 | after 1.6, 1.7 | fake store/clock |
| **1.9** | True rehearsal (per-speculation "would-do" report, **writes no live ledger**) + PR-1 end-to-end integration (`watchMain.ts`) | speculation §9 | after all | rehearsal writes no live ledger; e2e fixture |

## Sequencing

```
merged (1.1 / 1.2 / 1.3 / 1.5 / S1 / S2)  →  S1d-spec  →  S1d-impl  →  S3  →  1.6  →  1.7  →  1.8  →  1.9
```

`1.1`–`1.3` (policy + manifest/`cohortId` + `--live` hard-disable + `odds_history` reads),
`1.5` (attempt provenance), and the foundation slices **S1** (immutable prepared request) +
**S2** (historical baseline-version guards) are merged. Then **S1d** — the sealed
run-envelope / artifact-producer boundary (`SPEC-artifact-producer.md`) — lands as
**S1d-spec** (PR #27, paper-reviewed) → **S1d-impl** (one code PR judged only on A1–A6) →
**S3** (dynamic 1–3-market cardinality + v0.3 scoped baselines, built on S1). Then **1.6**
(fire artifact) → **1.7** (per-market detection, replaces the board-scoped tick) → **1.8**
(atomic claim + lease) → **1.9** (rehearsal + integration). Each branches from the
then-current `main` after its predecessor merges — sequential, not stacked.

## Coupling (flagged — we isolate where we can)

- **S1** — the prepared request is **one atomic boundary** (strict parse → derive hashes →
  deep-freeze → wire at dispatch), deliberately not a set of scattered guards. It stays
  confined to the request-preparation + dispatch path and changes no cardinality.
- **S1d** — the sealed run envelope is confined to the **producer boundary** (`runner.ts`
  `runSlate`/`sealDispatch` + `records.ts` / `summary.ts`); it changes the dispatch→artifact
  *handoff*, not any recorded value (A6 byte-compat over both producers), so it stays
  independent of S3's cardinality work.
- **S3** — "derive from the present market set" ripples through `schema.ts` / `baselines.ts`
  / `prompt.ts` / `records.ts`; keep the `runLine` field name (don't rename to `spread`) so
  `verifyRunIntegrity` replays the archived corpus. This is the coupling the first attempt
  hit; it is cleanly separable now that S1 owns request integrity.
- **1.7 / 1.8** — both rewrite the `watch.ts` tick core; ordering 1.7 before 1.8 keeps each
  reviewable, and either may split once more at implementation if the diff runs large.
