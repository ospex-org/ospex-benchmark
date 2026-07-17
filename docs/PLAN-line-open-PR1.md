# PLAN — line-open runner, PR 1 decomposition

**What this is:** a slicing-and-sequencing plan for **PR 1** of the Tier-0 line-open runner,
chopped into small, single-purpose, independently-mergeable sub-PRs.

**What this is NOT:** a spec. The two merged specs (`SPEC-line-open-evidence-model.md`,
`SPEC-line-open-speculation-runner.md`) are the contract; this only says *how the work is
sliced and in what order*.

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
- **S2 — baseline policy-version isolation**: v0.1/v0.2 full-board-only, only
  v0.3 scoped.
- **S3 — dynamic cardinality, re-homed**: the original 1.4 goal (per-market
  optional, derive from the present set), rebuilt on top of S1's prepared
  request. The validator/baseline/prompt derivations from the closed first
  attempt are reused.

S1→S2→S3 replace the single "1.4" row below; 1.5 (attempt provenance) already
merged; 1.6–1.9 follow S3 and now build on a request they can trust.

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

## Decomposition (9 sub-PRs)

| # | Goal (one thing) | Spec § | Size | Deps | Cases† | Isolated test |
|---|---|---|---|---|---|---|
| **1.1** | Versioned `(sport,market)` allow-list + `effectiveEnabled` + recomputed digest (new `marketPolicy.ts`) | §3.1 | S | — | 30,35 | allow-list isolation, default-disabled, digest |
| **1.2** | Strict `CohortManifestV1`→`cohortId`, boot gates, **`--live` hard-disable** (new `manifest.ts`) | §2 | M–L | 1.1 | 17,18,38 | fixture manifests, no network |
| **1.3** | Independent `odds_history` reads — `firstTwoSided` full-row identity + as-of quote + `validTwoSidedHistoryRowV1` (`fetchers.ts`,`wire.ts`) | §1, §5-V1 | M | — | 40 | fixture rows, id tiebreak, as-of exact |
| **1.4** | Dynamic-cardinality scoped bundle — per-market-optional, kill every hard-coded `3`, keep `runLine` name (`bundle.ts` + consumers) | §3.4, §4 | **L**‡ | — | 14 | 1/2/3-market cardinality, archived-corpus replay |
| **1.5** | Runner per-attempt provenance — distinct `initialRequestStartedAt`, causal-ordered timestamps, unique attempt #s, `dispatch_lag_exceeded`, V-lag-initial-only + `windowEnd`/first-pitch cutoff (`runner.ts`,`types.ts`) | §5 | M–L | 1.2 | 26,48 | fake clock; ordering/classification violations fail |
| **1.6** | Fire-artifact assembler — `armDigest` (domain-bound) + `responseSha256` (persisted post-redaction bytes) (new `fireArtifact.ts`,`records.ts`) | §4, §5 | M | 1.2,1.4,1.5 | 27,42 | digest recompute; mutation fails |
| **1.7** | Per-market detection + canonical window gates + deterministic admission ordering + prepared-snapshot→`detectedAt` sequencing (new `detect.ts`,`watch.ts`) | §3 | **L**‡ | 1.1,1.2,1.3,1.4 | 1,2,4,21,22,23,37,39 | fixtures + synthetic clock, no live |
| **1.8** | Atomic at-most-once claim + budget/spend reservation + `ConcurrencyLeaseV1` acquire/release/expire + claim/fire ledger + co-arrival partial-claim (new `claimStore.ts`,`watch.ts`) | §4 | **L**‡ | 1.2,1.6,1.7 | 8,9,24,25,45,46 | fake store/clock |
| **1.9** | True rehearsal (per-speculation "would-do" report, **writes no live ledger**) + PR-1 end-to-end integration (`watchMain.ts`) | §9, base §4 | M | all | — | rehearsal writes no live ledger; e2e fixture |

† Case tags are indicative (the 48-case matrix); some close fully only once their PR-2 half
(coverage / finalization) lands. ‡ Unavoidably coupling-heavy — see below.

## Sequencing

`1.1`→`1.2` are the foundation (policy + manifest/`cohortId` + the **`--live` hard-disable**,
which lands **before** any per-market firing path exists — a deliberate safety ordering).
`1.3` and `1.4` are independent of that pair and of each other, so they can land in any
order / in parallel. `1.5`→`1.6` build the arm + artifact model. `1.7` replaces the
board-scoped tick with per-market firing. `1.8` adds the durable claim/lease machinery.
`1.9` wires rehearsal and closes PR 1. Each branches from the then-current `main` after its
predecessor merges — sequential, not stacked.

## Unavoidable coupling (flagged — we isolate where we can)

- **1.4** — "every hard-coded `3` dies" ripples through `schema.ts` / `baselines.ts` /
  `prompt.ts` / `records.ts`; it can't be confined to `bundle.ts`. Mitigation: keep the
  `runLine` field name (don't rename to `spread`) so `verifyRunIntegrity` still replays the
  archived corpus.
- **1.5** — the `ArmOutcome` + attempt-provenance types (`types.ts`) and their first
  consumers (`runner.ts`,`records.ts`) must land together.
- **1.2** — the manifest/`cohortId` identity threads into 1.5/1.6/1.8 (`armDigest`, the
  artifact, the claim store). Its type surface is a shared dependency even though §2 isn't
  named in the §9 bullet — it's a grounded prerequisite (the §3 gates, §4 reservations, and
  §5 `armDigest` are unimplementable without it), not scope creep.
- **1.7 / 1.8** — both rewrite the `watch.ts` tick core; ordering 1.7 before 1.8 keeps each
  reviewable, but they touch adjacent lines of the same function.
- **1.7 and 1.8** may each split once more at implementation (detection-gates vs
  ordering-sequencing; claim/ledger vs budget/leases) if the diff runs large — decided when
  we see the diff, not pre-committed here.
