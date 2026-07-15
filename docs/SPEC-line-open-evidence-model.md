# SPEC — line-open runner: the evidence & verification model

Status: **PR 0 (spec-only), pre-code gate.** Target repo: `ospex-benchmark`.
Companion to `SPEC-line-open-speculation-runner.md` (base spec, committed
alongside this file). This document **supersedes** base §3.5/§3.6 and base §5
(sequencing), and **hardens** base §3.3. Everything else in the base spec
stands — and because PR 0 commits BOTH specs into the repo, "the base spec
stands" now points at an immutable, reviewable file.

This is the model the implementation PRs (1→3) are built against. It exists
because six code rounds each surfaced a fresh *model* gap; the fix is to specify
the evidence model, review it on paper, then build fresh (superseding the closed
PRs #10/#11). It has been through three paper-review iterations; this revision
folds the final review's seven precision corrections and three decisions, plus
source-fact reconciliations verified directly against the live writer/indexer
code.

> **Changelog (this revision — the "finite contract-tightening" pass).**
> The architecture is settled: I1/I2/I3, per-fire evidence bound as-of its own
> fire, derive-don't-trust, the cohort manifest, `snapshotObservedAt` dropped,
> V-lag, corrected V4, V8. This revision makes it precise:
> 1. **One canonical disposition type** shared by `run.speculation_status` and
>    `fire_coverage_snapshot.dispositions`; a `denominatorSha256` in the
>    pre-dispatch envelope binds both copies; V5 compares them **directly** (the
>    `state→decision` map is used only for the generic transition ledger). The
>    `entered` decision is given exact temporal semantics.
> 2. **Detection narrowed to what the archive can prove.** The writer discards
>    one-sided tuples before writing, so `odds_history` cannot substantiate a raw
>    `one_sided`; the derivable reason is **`market_never_two_sided`**.
> 3. **Census manifest strengthened** — rich frozen entries, a deterministic
>    paginated builder, a source-snapshot hash + row count, fail-closed on
>    truncation, and publication/anchoring **before `windowStart`**.
> 4. **Every load-bearing constant pinned** in the manifest (§6). The clean
>    window **W = 120 s is total**, never `W + skew`; the committed skew is a
>    **new `maxClockSkewMs = 5_000`** that *replaces* the repo's existing 2-minute
>    `FUTURE_QUOTE_SKEW_MS` (bundle.ts) at the line-open as-of sites (else the
>    effective window is 4 minutes).
> 5. **I1 reconciled with finite capacity** — no sibling coupling, but dispatch
>    is subject to precommitted global capacity/spend caps; overload emits a typed
>    `capacity_deferred`, never a moved-forward `detectedAt`.
> 6. **Crash/persistence ordering** specified (§3.4) with an explicit failure
>    contract: any crash that persists only one of run/snapshot is unhealthy,
>    at-most-once, and cohort-rejecting.
> 7. **Full state/reason matrix (§7) + transition-ledger state machine (§8).**
> Decisions folded (§9): `MAX_DISPATCH_LAG_MS = 10 s` measured at the provider
> HTTP boundary; the reschedule policy; and the published root is an **on-chain
> Polygon anchor**.
>
> **Precision hardening (internal adversarial pass).** A further pass tightened the
> model without changing the architecture: `entered` is a **pre-dispatch claim** the
> scorer substantiates (not a post-hoc predicate on the already-frozen hash);
> **coverage disposition and scoring outcome are separate axes** (§7a/§7b), so
> `zero_valid_arms`/`credential_missing` are scoring outcomes, not ledger states; the
> transition-ledger state machine (§8) is made reachable and 1:1 with its reasons; a
> new **`not_yet_two_sided`** (as-of) is distinguished from whole-window
> `market_never_two_sided`; the overload priority is a **total order** (…, `gameId`);
> V-lag is labeled **custody, not independent**; and a **V6 anchor-timestamp check**
> enforces the precommitment (manifest anchored before `windowStart`).
>
> **Second paper-review pass (7 finite blockers, all code-grounded).** The census
> walk terminates on an **empty page only** with an **immutable `jsonodds_id`
> cursor** under one MVCC snapshot (matching the repo's proven `keysetWalk`);
> change-based `odds_history` is **not observation freshness**, so `stale_quote`
> becomes UNKNOWN and `market_never_two_sided` scans first-appearance **to
> finalization** (openers can predate `windowStart`); `first_pitch_passed` uses the
> **frozen** `scheduledAtAtFreeze` (live `match_time` is mutable), with a typed
> `schedule_changed` for divergence and `out_of_cohort_observed` (renamed — the
> archive can't prove a reschedule-in); the overload conflict is resolved by a
> deterministic **pre-gate admission phase** (a capacity deferral makes the canonical
> cohort **incomplete/unranked** → salvage); `evaluating→absent` is removed
> (finalization-only); the **exhaustive arm-outcome enum** matches code (`valid` not
> `ok`; `provider_error`/`cutoff_missed` added; no free absence marker); and §9.3 is
> an **implementable anchor contract** (inventory-root, calldata domain, chainId 137,
> `anchorWallet`, finalized block, bounded `finalization ≤ postRoot ≤ +15 min`). The
> writer stamps `captured_at` at **millisecond** precision (`toISOString`), corrected
> from the earlier µs claim.
>
> **Source-fact reconciliation (verified against live code, this pass):**
> - The live `games` table **does** carry advisory `home_score`/`away_score`/
>   `final_type`/`score_captured` (added in the odds-payload-persistence work);
>   they are writer-captured game-log data, **never** an input to scoring here. An
>   earlier draft wrongly said `games` lacks score columns — corrected. The census
>   is frozen **not** because scores are absent but because **`match_time` is
>   mutable** (the writer updates it on ≥ 1-minute reschedule drift), so a
>   post-slate `match_time` query is not a stable membership census.
> - `odds_history` is confirmed **change-based** (a price-unchanged poll writes no
>   row) and **two-sided-only** (the writer drops one-sided tuples before either
>   table is written). Its natural key is
>   `(jsonodds_id, market, line, source, captured_at)`; `captured_at` is stamped by
>   the writer via `toISOString()` (**millisecond** precision); `source ∈ {jsonodds,
>   sportspage_open}`.

## 0. Why this companion exists

The base spec nailed the *unit* (the speculation) and the *firing model*
(per-market, fire-at-detection) but not the *evidence & verification model*. That
gap was filled ad-hoc across six code rounds, each finding a fresh model gap. The
load-bearing one, reproduced at head: a valid per-market sequence — moneyline
fires tick 1, total fires tick 2 — makes the moneyline run **unscoreable**,
because the coverage binding compared a per-fire run against the log's
cumulative-latest state. One wrong model (game-centric, trust-based coverage)
surfaced as four separate "bugs." This document specifies the model so the
implementation stops chasing symptoms.

## 1. Three invariants

**I1 — No speculation waits on another (latency contract + mechanism).** With
market A ready and its siblings' reads held open, A fires. Mechanism: per-market
detect/gate/claim/fire share **no single awaited path**; each board read is
independently scheduled and fault/timeout-isolated. **No-wait batching:** markets
may share one dispatch only if already ready in the same non-awaited scheduling
turn; **no timer/coalescing window may delay an already-ready fire**;
history-read concurrency is bounded **without** a global `Promise.all` barrier.

**I1 is not unconditional — it is bounded by precommitted capacity, resolved in a
pre-gate admission phase.** "Nothing waits" cannot be literally true while
concurrency and paid-call budgets are finite; and a deterministic tick-wide
priority **cannot** depend on the order gate reads happen to finish (with cap 1, if
a lower-priority candidate's gate returns while a higher-priority sibling's read is
still pending, firing the former violates the total order and waiting for the
latter violates no-wait). Resolve this by separating **admission** (deterministic,
before any async read) from **gating** (independent, no-wait):

1. At tick start, **freeze** the tick's candidate identities and **one** `detectedAt`.
2. **Sort** the frozen candidates by the deterministic total order — market-enum
   order, then `gameId` lexical (a genuine total order: network is pinned, so
   `gameId` = `jsonodds_id` is unique and `(market, gameId)` is unique across the
   tick) — **before** any asynchronous history/gate read.
3. **Admit** at most `maxDispatchesPerTick`, and **atomically reserve** the global
   `cohortCallCap`/`cohortSpendCap` for the admitted set.
4. Run only the **admitted** candidates' gates, each **independently** and
   fault/timeout-isolated — *this* is where I1's no-wait applies: no admitted gate
   waits on a sibling's I/O, preparation, history result, or batching decision; no
   timer/coalescing window delays an already-ready admitted fire; history-read
   concurrency is bounded **without** a global `Promise.all` barrier.
5. **No opportunistic backfill** — a slot whose admitted gate fails is **not**
   refilled from a non-admitted candidate during that tick (backfill would
   reintroduce completion-order dependence).

A non-admitted candidate is recorded **`capacity_deferred`** (§7); `detectedAt` is
**not** moved forward. Per-tick deferral is **transient** — a candidate re-detected
and cleanly fired on a later tick stays `entered` in the canonical cohort. **Only a
*terminal* capacity deferral taints the corpus:** a market a cap kept from **ever**
firing within the cohort (a `deferred`-survivor — never fired before it fell outside
W/V-lag or before finalization) is capacity-shaped sample selection, so it is routed
to a separately labeled **salvage cohort** and its presence makes the **canonical
cohort incomplete/unranked** (§7), never scored as ordinary canonical coverage. A
per-tick `maxDispatchesPerTick` deferral that re-fires next tick does **not** un-rank
the cohort.

**I2 — A game produces multiple artifacts; each is bound *as of its own fire*.**
Separate dispatches across ticks → separate run files. Every coverage check
reconciles against the state **as of that fire's `detectedAt`**, never
cumulative-latest.

**I3 — Derive, don't trust.** Every enforced claim is **recomputed** or
**reconciled** against **hash-covered, precommitted, or independently-sourced**
ground truth. **Corollary:** recomputing a verdict over *unhashed,
non-independent* inputs is not compliant — it only moves the forgery one hop (see
V4 + §5).

## 2. Ground truth available to the scorer

- **`odds_history`** — append-only; PK is a surrogate `id`; the natural key is
  `(jsonodds_id, market, line, source, captured_at)`. **Change-based:** the writer
  appends a row only when a price/line actually changes (a poll that merely bumps
  the upstream timestamp with identical prices writes no row), and it appends the
  history row **before** advancing `current_odds`. **Two-sided-only:** the writer
  drops any market where either side fails to parse to a non-zero American number
  *before* writing either table, so every `odds_history` row is a validated
  two-sided quote. Each row carries `line, away_odds_american,
  away_odds_decimal, home_odds_american, home_odds_decimal`, with
  `source ∈ {jsonodds, sportspage_open}` and a `captured_at` the writer stamps via
  `new Date().toISOString()` — **millisecond** precision on the writer's clock (the
  column is `timestamptz`/µs-capable, but the writer never exercises sub-ms).
  Change-based ⇒ the greatest `captured_at ≤ t` row for a
  `(jsonodds_id, market, source)` **is** the exact live two-sided *price* at `t`.
  - **`source` discipline:** `jsonodds` is the live feed the runner detects from;
    `sportspage_open` is a separate opening-line reference used by the CLV
    baselines, **not** the detection feed. **All detection/opener/as-of
    derivations here filter `source = jsonodds`** — the runner can only act on what
    its feed shows, and mixing in a `sportspage_open` row that predates the
    jsonodds appearance would misstate opener age.
  - **Change-based ≠ observation freshness (load-bearing).** A poll that
    re-confirms an unchanged price writes **no** row, so time-since-the-last-row is
    *price age*, not *observation freshness*. The observation-freshness signals
    (`current_odds.poll_captured_at` / `upstream_last_updated`, which advance every
    poll even on a flat quote) live in `current_odds` — overwritten, and **not** in
    the scorer's inputs. Two consequences: **(a)** a live, repeatedly-refreshed
    **flat** quote cannot be independently labeled `stale` from `odds_history` (so
    `stale_quote` is not a scorer-verified disposition — §7; fire-side freshness is
    V1b); **(b)** for a census game, `market_never_two_sided` means **no first
    two-sided `source=jsonodds` row at or before finalization** — *not* merely no
    change row inside `[windowStart, windowEnd)`. An opener that appeared before
    `windowStart` and stayed flat has no in-window row yet was two-sided throughout
    (→ `delayed_open`/`late_detection`, never `market_never_two_sided`).
  - **Ordering needs an explicit tiebreak.** The one existing reader
    (`fetchFirstBoardAppearance`) uses `order=captured_at.asc` with **no** tiebreak,
    so equal-ms rows resolve server-arbitrarily. Every as-of / first-appearance read
    must pin an `id` tiebreak: **V1** as-of = `order=captured_at.desc,id.desc&limit=1`;
    **V2/V8** first-appearance = `order=captured_at.asc,id.asc&limit=1`. (The exact
    predicate `(jsonodds_id, market, source, captured_at)` has no dedicated index;
    the scorer leans on `idx_odds_history_jsonodds (jsonodds_id, captured_at DESC)`
    and filters `market`/`source` in-row — fine at scoring volume, a future index is
    an optimization, not a blocker.)
- **`games`** — carries `match_time` (`timestamptz NOT NULL`) which the writer
  **actively updates** on reschedules of ≥ 1 minute (sub-minute jitter is
  ignored). PK is composite `(network, jsonodds_id)`,
  so `gameId = jsonodds_id` within a pinned network. Teams are `home_team_id` /
  `away_team_id` (`uuid` FKs to `teams`). Advisory `home_score`/`away_score`/
  `final_type`/`score_captured` exist but are writer-captured game-log data,
  **never an input to scoring here** (the on-chain oracle owns settlement). Because
  `match_time` is mutable, a post-slate `match_time` query is **not** a stable
  membership census — a game can move out of a later window. **The census is
  frozen in the cohort manifest (§3.0), not re-derived from live `games`.**
- **The run file's `arm_game_response` records + a post-response arm digest
  (§5)** — the recompute basis for V4.

**A new bounded as-of fetcher is required** (V1). The existing reader
(`fetchFirstBoardAppearance`) is direction-wrong (`order=captured_at.asc&limit=1`
returns the *earliest* row), unbounded by an as-of cutoff, and selects only
`captured_at`. V1 needs the greatest `captured_at ≤ detectedAt` **with the full
quote**:
`jsonodds_id=eq&market=eq&source=eq.jsonodds&captured_at=lte.<detectedAt>&order=captured_at.desc&limit=1&select=<full quote>`.

## 3. Evidence artifacts

### 3.0 The cohort manifest — precommitment

`cohort-manifest.json`, created and **published/anchored BEFORE `windowStart`**
(not merely before the first fire — "before first fire" still lets an operator see
the board and then pick the window). It is the single source of the parameters an
operator must not be able to choose after seeing the board:

```
cohort-manifest {
  artifactSchemaVersion,
  cohortId,
  network,                       // pinned explicitly (e.g. "polygon")
  sports: [ ... ],               // e.g. ["mlb"]
  windowStart, windowEnd,        // the operating window; windowStart is AFTER this
                                 //   manifest's external publication/anchor time
  gameIdCensus: [                // FROZEN at cohort start — rich entries, not bare IDs
    { gameId,                    //   = games.jsonodds_id
      sport,                     //   = games.sport
      scheduledAtAtFreeze,       //   = games.match_time captured at freeze (mutable later)
      homeTeamId, awayTeamId },  //   = games.home_team_id / away_team_id (uuid)
    ...
  ],
  censusSourceSnapshotSha256,    // hash of the canonical ordered census rows
  censusSourceRowCount,          // row count the deterministic builder read
  constants: { ... },            // ALL load-bearing constants — see §6
  marketPolicyVersion, marketPolicyDigest,
  expectedArmRoster: [           // per participant
    { participantId, provider, requestedModelId, approvedReportedModelIds: [ ... ] },
    ...
  ],
  promptScaffoldSha256,
  toolInferenceConfigSha256,
  baselinePolicyVersion,
  repairPolicyVersion,
  runnerCommitSha                // the runner/code commit the cohort runs
}
```

`cohortManifestSha256 = sha256Hex(canonicalize(manifest))`. **Every fire envelope
and every coverage record references `cohortManifestSha256`**, and the scorer
requires every run + coverage record of a cohort to reference the **same**
manifest. Hashing alone is not immutability (§5) — the manifest's teeth come from
being **published and anchored before the cohort's window opens**.

**Deterministic census builder — one consistent snapshot, immutable cursor,
empty-page termination.** The frozen census must be a coherent point-in-time
snapshot, which rules out the naive walk two ways the repo already knows about:
- **Terminate on an EMPTY page only, never a short page.** A server row-cap below
  the requested limit makes *every* page "short" and silently truncates the walk;
  the repo's proven `keysetWalk` (with its regression test for a cap-below-limit
  server) deliberately assumes no page size and stops only on an empty page. The
  census builder MUST reuse that contract.
- **Cursor on an IMMUTABLE column.** Ordering by `(match_time, jsonodds_id)` is
  unsafe: `match_time` is mutable, so a game rescheduled behind the cursor
  mid-walk can vanish from the census. Order by the **immutable `jsonodds_id`**
  (ascending; unique within the pinned network), so the cursor cannot move under a
  reschedule.
- **One MVCC snapshot.** PostgREST paginates across separate transactions, so a
  multi-page HTTP walk is not itself snapshot-consistent. Build the census in a
  **single server-side snapshot** — one SQL/RPC function that scans the whole window
  under one transaction (repeatable read), captures each row's `match_time` as
  `scheduledAtAtFreeze`, and returns the frozen rows; a mutation after that snapshot
  cannot alter the census (that is the point of freezing). If a server-side function
  is unavailable, the HTTP walk must be reconciled to stability (two consecutive
  full reads agree) before it is trusted.
Membership filter (`network` + `sports` + `match_time ∈ [windowStart, windowEnd)`)
is evaluated **on the snapshot's `match_time`**, frozen as `scheduledAtAtFreeze`.
**A truncated/partial read is a FAILURE, not a benign zero** (base §3.7 read-path
canary, at census scope). The builder records `censusSourceSnapshotSha256` (over the
canonical ordered rows) and `censusSourceRowCount` so the census is reproducible and
tamper-evident. **Tests (§11):** server cap below page size; match-time mutation
during the walk; partial/truncated response; non-advancing cursor.

### 3.1 The per-fire run file — one dispatch's evidence

- `run_meta`: `runId`; `fireId`; `cohortId`; `detectedAt`; `bundleSnapshotTs`;
  the **fire envelope** (§5) and its `fireEnvelopeSha256`; the
  `denominatorSha256` (below); `cohortManifestSha256`. No fire-timing fields are
  folded into the model-facing bundle (base §3.4 replay stays intact).
- `bundle_game`: the scoped bundle — exactly the fired market(s), quotes
  hash-covered; **byte-identical in shape to today's bundle.**
- `decision` records: fired market(s) only. A game's markets are scored across
  their respective run files, each **once** (enforced by the fire↔run linkage,
  V6).
- `arm_game_response` records: **exactly one** explicit outcome (§5 enum) per
  **expected-roster** arm — a *missing* record is an integrity violation, **not** an
  absence marker — plus the post-response arm digest (§5).
- `speculation_status` — the embedded **as-of denominator**: the canonical
  ordered list of `Disposition` records (below), one per **declared** market of the
  game (including `policy_disabled` markets), **as of `detectedAt`**. This is the
  same structure the fire snapshot carries; `denominatorSha256` binds them. Each
  `not_entered` reason is evaluated **as of `detectedAt`** — a declared,
  policy-enabled market with no `source=jsonodds` two-sided row *as of this fire* is
  **`not_yet_two_sided`** (§7), which is distinct from the whole-window
  **`market_never_two_sided`** the slate pass derives (V3). The two must not be
  conflated: the headline multi-fire case depends on it — in the moneyline's tick-1
  denominator `total` is `not_yet_two_sided`, **not** `market_never_two_sided`
  (which would be false, since `total` opens at tick 2).

**The canonical `Disposition` type** (used identically in `run.speculation_status`
and `fire_coverage_snapshot.dispositions`):

```
Disposition {
  market,                         // 'moneyline' | 'spread' | 'total'
  decision,                       // 'entered' | 'not_entered'
  reason,                         // machine reason (§7); for entered it is 'fired'
  enteredFireId?, enteredRunId?   // REQUIRED iff decision === 'entered'
}
```

- The **denominator** is the `Disposition[]` for all declared markets, ordered by
  market-enum order, and `denominatorSha256 = sha256Hex(canonicalize(denominator))`
  is computed at detection (pre-dispatch) and carried in the fire envelope.
- **`entered` is a pre-dispatch claim; the scorer substantiates it.** The
  denominator's bytes are frozen at detection (step 1, §3.4). The market firing in
  *this* dispatch is written `entered` with the **current** fireId/runId; a sibling
  claimed/fired in an earlier dispatch is written `entered` with **its** earlier
  fireId/runId; markets not claimed are written `not_entered` + machine reason.
  This is the runner's optimistic pre-dispatch **claim**, and `denominatorSha256`
  covers exactly these frozen bytes. A firing market is written `entered` even
  though, at the instant of writing, no request has started and nothing has
  finalized — the label is the claim, not yet the verdict.
- **Substantiation (what the scorer checks).** A written `entered` claim is
  **substantiated** — and the fire becomes a clean artifact — **iff** (a) at least
  one real provider request **started** within V-lag of `detectedAt`, **and** (b) a
  complete run artifact and fire snapshot were persisted and finalized (§3.4). On a
  clean fire the finalized `run.speculation_status` and `snapshot.dispositions` are
  **byte-identical** to the frozen denominator, so both hash to the envelope's
  `denominatorSha256` (V5(a)). If (b) never occurs (crash), no complete run+snapshot
  exists: V5 is moot, V6's linkage cannot resolve, and the claim is **retracted** at
  slate level to `not_entered` / `fire_interrupted` (C-class, cohort-failing) — the
  runner never gets *scored* credit for an entry it cannot substantiate. A finalized
  fire in which **≥1 arm was sent** but every sent arm failed is still a substantiated
  `entered`; its *scoring* outcome is `zero_valid_arms` (§V4, §7) — a valid, honest,
  unscoreable failed-event artifact, not a retraction. (If **no** arm ever started,
  clause (a) fails → `fire_interrupted`, not `zero_valid_arms`. Coverage decision and
  scoring outcome are different axes — §7.)
- **In-flight siblings.** Because I1 forbids waiting, a sibling may be claimed and
  dispatched but not yet finalized when a later fire freezes its denominator.
  Recording that sibling `entered` (referencing its own fireId/runId) is correct
  under the claim model — its authoritative substantiation lives in its **own**
  fire's run+snapshot, and **V6 independently checks that every `entered`
  disposition across all denominators resolves to exactly one verifier-green run
  artifact**. A sibling that never finalizes is caught there (referenced artifact
  missing/incomplete → cohort-failing), so no separate in-flight reason is needed.

### 3.2 The atomic fire-coverage snapshot + the transition ledger

Two things, deliberately separated:

- **`fire_coverage_snapshot`** — emitted **atomically per fire** (not
  reconstructed from tick-end transitions, which race the fire's own `detectedAt`):

  ```
  fire_coverage_snapshot {
    cohortId, fireId, runId, detectedAt, gameId,
    cohortManifestSha256,
    denominatorSha256,                 // MUST equal the run's and the envelope's
    dispositions: Disposition[],       // the SAME canonical denominator as the run
    fireEnvelopeSha256
  }
  ```

  Every disposition here is explicitly "as of this fire." **V5 binds the run to
  this exact `fireId` and compares the two `Disposition[]` directly** — it does not
  reconstruct a fire's as-of view from generic transitions, and it needs no
  `state→decision` map (both sides are already dispositions).

- **The transition ledger** (`line-open-coverage.ndjson`, append-only) — a SECOND
  self-report for **markets that never produce a completed fire artifact** (never
  fired, or a fire that did not finalize). Each record carries a **pinned `state`
  enum** value **and its explicit §7 `reason`**, so its class (G/H/C) is
  unambiguous directly from the pinned reason (§8);
  `snapshotAt` = the tick instant. Its teeth come only from (a) coherence with the
  fire snapshots / embedded denominators — reconciled **by the V6 slate pass** via
  the `state↔decision` map (that map is used **only** for the ledger, never in V5)
  — and (b) reconciliation against the independent `odds_history` (V3) and the
  frozen census (V6). A `state`/`reason` the independent sources cannot
  substantiate is **UNKNOWN/unscoreable** — the ledger alone proves nothing about a
  dropped market.

### 3.3 The frozen census + slate-pass hygiene

The `gameIdCensus` is **frozen in the manifest at cohort start** (§3.0); live
`games` cannot provide a stable as-of membership (§2).

**Reschedule policy (decided — §9.2). The frozen `scheduledAtAtFreeze` is the
canonical cutoff for every schedule-derived gate; live `match_time` is never used to
reconstruct a historical cutoff** (it is mutable and cannot say what it was at
detection, and there is no append-only schedule history — §2). Instead:
- **`first_pitch_passed`** is computed against the frozen `scheduledAtAtFreeze`
  (deterministic, precommitted), **not** the live value.
- Any **material** divergence between `scheduledAtAtFreeze` and live `games.match_time`
  at finalization (≥ `scheduleChangeToleranceMs`, default the writer's 60 s) is a
  typed, non-fired **`schedule_changed`** outcome (H) for that census game — the
  game **stays in the denominator**, keeps its original `scheduledAtAtFreeze`, and is
  **not** paid-fired outside its frozen window. This single reason covers a
  reschedule-out *and* an in-window reschedule (both are just "the schedule moved");
  it does not attempt to prove direction, which the archive cannot.
- A game absent from the frozen census that appears in `odds_history` within the
  window gets an **`out_of_cohort_observed`** coverage record (V6) — renamed from
  "rescheduled_in" because a non-census game with history does **not** prove a
  reschedule-in (it may be newly discovered/added); the archive only proves it was
  *observed*. It still cannot vanish silently.

The slate pass also: pins `network` (from the manifest); uses the immutable-cursor,
empty-page-termination walk over `games`/`odds_history` (§3.0); runs only at a
**finalization point** (`windowEnd + ingestionGraceMs`, §6); and **fails closed on
any truncated/partial source read** (a short page is a failure, not a benign zero —
base §3.7 read-path canary, at slate scope).

### 3.4 Crash / persistence ordering (the failure contract)

"Atomic snapshot" means one complete snapshot **record**, not an atomic
transaction spanning the run file. That is acceptable only with an explicit
failure contract. The runner persists in this order:

1. Persist the **pending claim + pre-dispatch envelope** (incl. `denominatorSha256`).
   The claim is an `O_EXCL` create — at-most-once.
2. **Start provider requests** within V-lag (§V-lag), measured at the provider
   HTTP-request boundary per arm.
3. Persist the **arm outcomes / run artifact**.
4. Persist the **complete `fire_coverage_snapshot`** and **finalize** the claim
   (`dispatchStatus: completed`).

**Failure contract.** Any crash boundary that yields only one of {run, snapshot},
or a claim that never finalized, must:
- **exit unhealthy / nonzero** (`--once` returns nonzero; V7);
- remain **at-most-once** (the consumed `O_EXCL` claim prevents a re-fire /
  re-bill);
- cause **V6 to reject the cohort** (the fire↔run linkage cannot resolve);
- **never** render as a clean `entered`-and-scored fire: the pre-dispatch
  `entered` **claim** (§3.1) is **retracted** at slate level to `not_entered` /
  `fire_interrupted`, because no complete run+snapshot exists to substantiate it.

This includes a crash **after a billed provider request** (step 2) but before the
coverage append (step 3/4): the spend is real, the evidence is incomplete, and the
cohort is loudly flagged rather than silently crediting an entry. §11 requires a
crash/failure test after **each** step, including a coverage-append failure after a
billed request.

## 4. The verification model (the scorer — derive, don't trust)

All `captured_at ≤ detectedAt` comparisons are **inclusive** and compared at
**millisecond precision** (the writer stamps `captured_at` at ms — M-note). The
committed cross-host allowance is `maxClockSkewMs` (§6), **not** the repo's legacy
2-minute skew.

- **V1 — Entry quote, derived.** For each market **fired in this dispatch**,
  re-derive the `source=jsonodds` quote **as of `detectedAt`** (greatest
  `captured_at ≤ detectedAt`, `id DESC` tiebreak) and require the bundle's recorded
  quote to match the **`line` AND both American odds** (home-side spread convention
  included), compared on the **integer American** values (then re-derive the decimal
  via the bundle's `americanToDecimal`). Change-based history ⇒ exact match; the
  only tolerance is `maxClockSkewMs`. No row at/before `detectedAt`, or no match
  within skew ⇒ **UNKNOWN/unscoreable** (never a silent pass, never an
  auto-violation).
- **V1b — Freshness gap, derived.** Require
  `detectedAt − bundleSnapshotTs ≤ freshFireMs` (within skew); both are
  fire-envelope-covered (§5). Catches a stale snapshot that fires **even on a flat
  market** (which V1 alone misses).
- **V2 — Opener age, derived.** `openerAge = detectedAt − firstAppearance ≤
  lateThresholdMs`, against `source=jsonodds` `odds_history`, within skew;
  `firstAppearance` = **first two-sided** appearance (= first jsonodds row, since
  the writer only writes two-sided rows).
- **V3 — Two-sided detection, derived (per-fire as-of vs slate whole-window).**
  Two related checks on the same independent source (`source=jsonodds`
  `odds_history`):
  - *Per-fire (as-of):* a denominator disposition that claims the market was on the
    board must have a row with `captured_at ≤ detectedAt`; none ⇒ violation. A
    declared market with **no** such row as of `detectedAt` is **`not_yet_two_sided`**
    (it may open on a later tick).
  - *Slate (whole-history):* a market with **no** first two-sided `source=jsonodds`
    row **at or before finalization** is **`market_never_two_sided`** (V6/slate). The
    opener may predate `windowStart` and stay flat (no in-window change row) yet be
    two-sided throughout (§2), so this scans first-appearance, not in-window rows.
  The archive cannot prove a raw one-sided appearance — the writer discards those —
  so no `one_sided` reason is claimable, and there is no self-attested detection
  field to forge.
- **V4 — Arm-outcome policy, recomputed against the precommitted roster.**
  Recompute per **expected-roster** arm (manifest), over the **canonically digested**
  content and the **exhaustive `outcome` enum (§5)**:
  - **exactly one outcome record per expected arm** — a **missing** record is an
    integrity violation (there is **no** free "absence marker");
  - **`credential_missing`** on a **required** arm ⇒ structural **fire failure**
    (should have been blocked at boot);
  - **any other non-`valid` outcome** (`invalid_schema` / `timeout` / `rate_limited` /
    `provider_error` / `cutoff_missed` / `dispatch_lag_exceeded`, §5) ⇒ a **valid
    negative** for that participant, retained in its denominator — **not** an event
    failure;
  - **zero valid arms** (≥ 1 arm sent, none `valid`) ⇒ no scoreable model decisions,
    but a **valid, honest, unscoreable failed-event artifact** — scoring outcome
    `zero_valid_arms` (§7b); the fire's coverage disposition stays `entered`/`fired`
    — not an integrity violation;
  - **partial valid cohort** ⇒ **score the valid arms**, preserve every failed arm
    in coverage.
  Deleting a `FIRE_FAILED` record **or** an arm record remains detectable (roster +
  one-record-per-arm + digest).
- **V5 — As-of coverage binding (multi-fire).** Bind the run to its
  `fire_coverage_snapshot` (by `fireId`) and compare the two `Disposition[]`
  **directly**: (a) `run.speculation_status` **equals** `snapshot.dispositions`, and
  both hash to the envelope's `denominatorSha256`; (b) every market **fired in this
  dispatch** is `entered` in the snapshot referencing **this** fireId/runId; (c) the
  set of `entered` dispositions ⊇ the set of fired markets. A later sibling fire
  emits its **own** snapshot at its own `detectedAt`, so the earlier fire's binding
  is untouched — **both run files of a two-tick game score**. (The `state↔decision`
  map is **not** used here; it applies only to reconciling the generic transition
  ledger for never-fired markets.)
- **V6 — Slate completeness + fire↔run linkage + ledger & anchor reconciliation.**
  A **distinct slate pass** (`yarn score --slate <cohort>`), over the frozen census
  (§3.3) + `odds_history` + all fire snapshots/run files + the transition ledger:
  - every policy-enabled `(census game, market)` **or** `(game, market)` with a
    `source=jsonodds` appearance in the window **must** have a coverage disposition —
    else violation (a non-census observed game needs `out_of_cohort_observed`;
    no first two-sided row to finalization is `market_never_two_sided`);
  - **every `entered` disposition — across *all* run denominators and fire
    snapshots, not only each fire's own firing market — resolves to exactly one
    verifier-green run artifact, and back** (`enteredFireId`/`enteredRunId` resolve;
    no duplicate fires; no missing/incomplete/interrupted referenced fire — §3.4) —
    else slate violation. This is what substantiates in-flight-sibling claims (§3.1);
  - **ledger reconciliation:** every transition-ledger terminal reconciles with the
    fire snapshots / embedded denominators under the `state↔decision` map (the map's
    **only** use), and its `state`+`reason` is substantiated by `odds_history` (V3) /
    the census — an unsubstantiated ledger claim is UNKNOWN, not a pass;
  - **anchor timestamps (the precommitment teeth — §5 layers 2/3, §9.3):** per the
    §9.3 contract — the manifest-root anchor `anchorBlockTime < windowStart`; the
    post-cohort-root anchor `finalization ≤ anchorBlockTime ≤ finalization +
    postRootMaxDelayMs` (**bounded**, not merely `≥`); each tx `status == 1`, `from
    == anchorWallet`, on `anchorChainId == 137`, in a **finalized** block. Any unmet
    ⇒ cohort rejected (C). Without this the "cannot be chosen after seeing the board"
    guarantee is unenforced.
  A watch cohort is "scored" only once the slate pass is green. This is the only
  **independent** anti-drop check (V5 is coherence between two self-reports).
  *(Honest residual: a game absent from BOTH the frozen census AND `odds_history` is
  invisible to everyone — the stated trust limit.)*
- **V7 — Crash-recovery health (RUNTIME, PR-1).** A `fire_interrupted` claim makes
  the tick non-healthy → `--once` nonzero (§3.4). *(Custody-bounded: an operator can
  delete a stranded claim; this is an operational-health signal, not a
  forgery-proof check.)*
- **V8 — Fire-at-open eligibility.** Re-derive the first **two-sided** instant from
  `source=jsonodds` `odds_history` and require
  **`detectedAt ≤ firstTwoSided + W`**, `W = cleanOpenWindowMs = 120_000` — a
  **total** window, **not** `W + skew`. Compare at millisecond precision; skew never
  *widens* W. If cross-host skew makes the boundary ambiguous (within
  `maxClockSkewMs` of the bound), classify **UNKNOWN** and make **no clean-stratum
  paid dispatch** — skew only *narrows* the clean set. Entries after W but within
  `lateThresholdMs` are **`delayed_open`** — recorded in coverage, **never pooled
  with clean open-CLV, and for the MVE not dispatched to paid models by default**
  (delayed-model data only under an explicit separate cohort/policy).
- **V-lag — Dispatch lag (custody-bounded, like V7).** For every dispatched arm,
  `0 ≤ firstRequestAt − detectedAt ≤ maxDispatchLagMs` (= 10 s, §9.1), measured at
  the **provider HTTP-request boundary** per arm (not promise/task creation),
  timeout/cutoff handling preserved. Both operands are **benchmark-host** events, so
  **no clock-skew allowance applies** — the 10 s bound is exact. An arm not started
  within the bound is **not sent** and recorded with arm-outcome
  **`dispatch_lag_exceeded`** — a V4-style valid negative for that participant
  (§V4/§5), so a *partial* fire still scores its sent arms; only if **no** arm starts
  is the fire `fire_interrupted` (§3.1). `firstRequestAt` is **custody, not
  independent proof**: it is covered by the post-response arm digest (§5) for
  internal-consistency/immutability but has no independent source, so V-lag is a
  runtime/custody health signal (like V7), **not** an independent content verifier.

**M-note (timestamps).** The DB query stays `captured_at ≤ detectedAt` (inclusive).
The writer stamps `captured_at` via `new Date().toISOString()` — **millisecond**
precision (the `timestamptz` column is µs-capable but the writer never exercises
sub-ms), so `Date.parse` (ms) is exact for `source=jsonodds` rows; comparisons must
simply not truncate **below** ms, and must pin an `id` tiebreak on equal-ms rows
(§2). The committed cross-host allowance is **`maxClockSkewMs = 5_000`**; the
**cross-host as-of sites (V1/V2/V8)** use it in place of the legacy 120_000-ms
`FUTURE_QUOTE_SKEW_MS` (bundle.ts) (§6). **V-lag takes no skew** —
both its operands are benchmark-host. A cross-host boundary genuinely ambiguous
under `maxClockSkewMs` is **UNKNOWN**, never silently reclassified.

## 5. Trust model — consistency vs. precommitment vs. immutability vs. independence

A stored SHA-256 is **not** "unforgeable" — a digest beside editable data is
recomputable after editing. The model rests on four distinct layers, stated
honestly:

1. **Internal consistency** — recomputable digests (`requestSha256`,
   `fireEnvelopeSha256`, `denominatorSha256`, the arm digest): catch *inconsistent*
   edits.
2. **Precommitment** — the cohort manifest exists and is published/anchored
   **before `windowStart`**: fixes W, the window, the frozen census, the roster, and
   the policy so they cannot be chosen after seeing the board.
3. **Post-publication immutability** — the manifest and the per-cohort artifact
   root are anchored on-chain (§9.3): a durable external timestamp no local clock can
   backdate.
4. **Independent honesty** — `odds_history`, the frozen census, the on-chain
   anchor timestamps, and source reconciliation (V1–V3, V6, V8): the only checks
   that constrain *content*, not just consistency. (V-lag is **not** here — its
   operands are benchmark-host, so it is custody/health, not independent.)

**Fire envelope (PRE-dispatch), covers at least:**
`artifactSchemaVersion, cohortManifestSha256, cohortId, fireId, runId,
requestSha256, denominatorSha256, detectedAt, bundleSnapshotTs`.

**Arm digest (POST-response — a separate, later digest that cannot be in a
pre-dispatch envelope),** canonically covers per expected-roster arm:
`participantId, requestedModelId, reportedModelId, outcome, firstRequestAt,
providerResponseId, acceptedAttempt, rawResponseHash`. It is included in the
**post-cohort artifact root** (anchored per §9.3). **This is custody integrity, NOT
independent proof of what the provider returned** — `firstRequestAt` in particular is
custody (it feeds V-lag, a health signal, not an independent check).

**The exhaustive `outcome` enum** (the code's `ArmOutcome`, plus the one value V-lag
introduces). Every expected-roster arm has **exactly one** outcome record; a
*missing* record is an **integrity violation** (V4), **not** an outcome — there is no
free "absence marker." Every non-`valid` outcome is a valid negative retained in the
participant's denominator ("failures never leave the denominator"):

| outcome | request sent? | role | class |
|---|---|---|---|
| `valid` | sent, validated | the **only** scoreable decision (emits 3 decision records) | contributes **G** |
| `invalid_schema` | sent (body present) | denominator negative | H |
| `timeout` | sent (transport failure) | denominator negative | H |
| `rate_limited` | sent (HTTP 429) | denominator negative — a throttle must never read as a model failure | H |
| `provider_error` | sent (other transport/HTTP) | denominator negative | H |
| `cutoff_missed` | **mixed** — sent-late, or never-sent if the decision cutoff already passed at dispatch | denominator negative; never emits decision records | H |
| `dispatch_lag_exceeded` **(NEW)** | **never sent** — first request would start > `maxDispatchLagMs` after `detectedAt` (V-lag) | denominator negative | H |
| `credential_missing` | **never sent** — no credential (should be blocked at boot) | denominator negative; a **required** arm makes the fire structural-fail | C |

**Fire-level (§7b) from the arm set:** a substantiated (`entered`) fire requires
**≥1 arm sent** (§3.1(a)); among substantiated fires, ≥1 `valid` ⇒ **scoreable (G)**,
else **`zero_valid_arms` (H)**; a required `credential_missing` ⇒ **C**. **Zero arms
sent** (all `credential_missing` / `dispatch_lag_exceeded` / cutoff-passed-at-dispatch)
⇒ the fire is unsubstantiated → `fire_interrupted` (§7a, C), never clean.

## 6. Pinned constants & config

All load-bearing constants live in the manifest's `constants` block (or a versioned
methodology/config digest the manifest references) so they are precommitted and
hashed. Values:

| Constant | Value | Notes / reconciliation with existing code |
|---|---|---|
| `freshFireMs` | `30_000` | **Reuses** existing `FRESH_FIRE_MS` (watch.ts). V1b bound. |
| `cleanOpenWindowMs` (**W**) | `120_000` | V8 clean-open window, **total**. No named `W` exists today. |
| `maxClockSkewMs` | `5_000` | **NEW. Replaces** the repo's only legacy 2-minute skew `FUTURE_QUOTE_SKEW_MS` (bundle.ts, `2*60*1000`) at the line-open as-of sites. **Must not be added on top of W** (that would make the effective window 4 min). |
| `maxDispatchLagMs` | `10_000` | **NEW** (nearest existing is `MAX_INPUT_AGE_MS = 600_000`, unrelated). V-lag; measured at the provider HTTP boundary. |
| `lateThresholdMs` | `1_800_000` | **NEW** (30 min). Retunes the deleted `--late-minutes` flag (today `options.lateMinutes`, default **60**, range 1–1440; scorer field `lateThresholdMinutes`) into a committed constant per base §3.2. No `LATE_THRESHOLD_MS` exists in code. V2 / `late_detection` / `delayed_open` upper bound. |
| `ingestionGraceMs` | `900_000` | **NEW** (15 min). Slate finalization = `windowEnd + ingestionGraceMs`. |
| `maxQuoteAgeMs` | `1_800_000` | **Reuses** `MAX_QUOTE_AGE_MS` (30 min). **Runtime** dispatch-eligibility bound on the `current_odds` snapshot age; **not scorer-verifiable** from change-based `odds_history` (§2), so a runtime `stale_quote` decline scores as UNKNOWN (§7), never clean H. |
| `scheduleChangeToleranceMs` | `60_000` | **NEW** (matches the writer's 1-min drift). `schedule_changed` threshold: `|liveMatchTime − scheduledAtAtFreeze| ≥` this ⇒ typed non-fired outcome (§7, §9.2). |
| `historyReadTimeoutMs` | pin at implementation | Bounded as-of read; no global `Promise.all` barrier. |
| `historyReadConcurrency` | pin at implementation | Bounded fan-out for the slate pass. |
| `maxDispatchesPerTick` | pin at implementation | Per-tick claim cap. **NEW, manifest-pinned** — **replaces** the base spec's free `--max-fires-per-tick` flag (today `options.maxFiresPerTick`, `DEFAULT_MAX_FIRES_PER_TICK`, default **10**; a per-invocation lever is the cherry-pick surface this benchmark forbids). Base §4 notes it needs retuning upward for per-speculation claims (~30 on the first tick), so the manifest pins the value; there is no `DEFAULT_MAX_DISPATCHES_PER_TICK`. Overflow → `capacity_deferred` (transient — re-detected next tick). |
| `cohortSpendCap` / `cohortCallCap` | pin at implementation | Global **cohort-lifetime** capacity/spend ceiling (I1 bound); **atomically reserved at admission** (§1); overflow → `capacity_deferred` (→ salvage cohort; canonical cohort incomplete). |
| `anchorChainId` | `137` | Polygon mainnet (§9.3). |
| `anchorWallet` / `anchorTarget` | pin at implementation | Dedicated evidence-anchor EOA (same wallet for both roots) + tx `to` (default self-send). |
| `anchorVersion` | `v1` | Calldata domain version (§9.3). |
| `postRootMaxDelayMs` | `900_000` | **NEW** (15 min). Bounds the post-cohort anchor: `finalization ≤ anchorBlockTime ≤ finalization + postRootMaxDelayMs` (§9.3). |
| `marketPolicyVersion` / `marketPolicyDigest` | from `marketPolicy.ts` | `market-policy-v1` + digest. |
| `promptScaffoldSha256` / `toolInferenceConfigSha256` / `baselinePolicyVersion` / `repairPolicyVersion` / `runnerCommitSha` | per cohort | Precommit the exact model-facing scaffold, inference config, baselines, repair policy, and code commit. |

**The one that bites:** W and `maxClockSkewMs` are different constants with
different jobs. W is the size of the clean window (120 s total). `maxClockSkewMs`
(5 s) is only the tolerance for comparing a writer-host `captured_at` against a
benchmark-host `detectedAt`; it never enlarges W. The implementation must not reuse
the 120_000-ms legacy skew for any line-open as-of comparison.

## 7. State & reason matrix

Two different axes — **do not conflate them**:
- **Coverage disposition** = a `Disposition.decision` + `reason` in a denominator or
  the transition ledger: `entered` (reason `fired`) or `not_entered` (+ reason).
- **Scoring outcome** = how the scorer classifies an `entered` fire's arms; a V4
  determination over the run's `arm_game_response` records, **not** a coverage reason.

Classes: **G** = green/scoreable, **H** = honest-but-unscoreable (valid
coverage/evidence, no model score), **C** = cohort-failing (fails the slate/health
and blocks "scored"), **UNKNOWN** = not independently verifiable → not clean coverage
(if it masks a two-sided market, V6 flags the hole), **salvage** = excluded from the
canonical cohort into a separately labeled salvage cohort (its presence makes the
canonical cohort incomplete/unranked).

**7a. Coverage dispositions.**

| disposition (`decision`) | Meaning | Independent verifier | Class |
|---|---|---|---|
| `fired` (`entered`) | A **claim** the runner fired this market (§3.1) | its scoring outcome — §7b | **G**/**H**/**C** per §7b |
| `not_yet_two_sided` (`not_entered`) | No `source=jsonodds` two-sided row **as of `detectedAt`** (may open later) | V3 per-fire (as-of) | **H** |
| `market_never_two_sided` (`not_entered`) | No first two-sided `source=jsonodds` row **at or before finalization** (an opener may predate `windowStart` — §2) | V3 slate (whole history to finalization) | **H** |
| `policy_disabled` (`not_entered`) | Detected but not policy-enabled for this league | market policy version/digest (manifest) | **H** |
| `late_detection` (`not_entered`) | Opener age > `lateThresholdMs` at first eligible tick | V2 vs `odds_history` first appearance | **H** |
| `delayed_open` (`not_entered`) | Two-sided, but `detectedAt > firstTwoSided + W` (≤ late) | V8 (outside clean W, inside late) | **H** |
| `stale_quote` (`not_entered`) | Runtime decline: the `current_odds` snapshot was older than `maxQuoteAgeMs` | **NOT scorer-verifiable** — change-based `odds_history` is *price age*, not observation freshness (§2); the freshness signal lives in `current_odds`, which the scorer cannot read | **UNKNOWN** |
| `first_pitch_passed` (`not_entered`) | `detectedAt` after the **frozen** scheduled start | vs `scheduledAtAtFreeze` (manifest census); live `match_time` cannot reconstruct the detection-time cutoff (§9.2) | **H** |
| `capacity_deferred` (`not_entered`) | Ready, but a per-tick/global cap blocked **admission** (§1) and it never fired within the cohort | the cap (manifest) + the admission total-order (§1) | **salvage** |
| `history_unavailable` (`not_entered`) | An as-of / slate read could not be completed (bounded read failed) | read-path canary (fail-closed, not zero) | **C** |
| `fire_interrupted` (`not_entered`) | A fire was claimed but run+snapshot never finalized (§3.4) — the `entered` claim is retracted | V7 health + V6 linkage (unresolved) | **C** |
| `schedule_changed` (`not_entered`) | Census game whose live `match_time` diverges from `scheduledAtAtFreeze` by ≥ `scheduleChangeToleranceMs` (covers reschedule-out **and** in-window reschedule; not paid-fired outside the frozen window) | `scheduledAtAtFreeze` vs live `match_time` (V6/slate) | **H** |
| `out_of_cohort_observed` (`not_entered`) | Non-census game observed in `odds_history` in the window — the archive cannot prove reschedule-in vs newly-discovered (§9.2) | V6 observed-universe reconciliation | **H** |

**7b. Scoring outcomes of an `entered` (`fired`) fire** — V4 over the run's arms:

| outcome | Meaning | Independent verifier | Class |
|---|---|---|---|
| scoreable | Finalized fire with **≥1 valid arm** | V1, V1b, V2, V3, **V4**, V5, V8 (clean); V-lag = custody | **G** |
| `zero_valid_arms` | Finalized, **substantiated** fire (**≥1 arm sent**) with **no** `valid` arm — every sent arm a non-`valid` outcome (§5). **Zero** arms sent ⇒ `fire_interrupted` (§7a, C), not this. | V4 (roster recompute) + V5 linkage | **H** |
| `credential_missing` | A **required** arm had no credential — structural (should have been blocked at boot) | V4 (roster; boot gate) | **C** |

**Notes.** `market_never_opened` (base draft) is folded into the pair
`not_yet_two_sided` (as-of) / `market_never_two_sided` (whole-history); `one_sided`
is **removed** and `stale_quote` is **reclassified UNKNOWN** (unprovable from
change-based history — §2/V3). The per-arm outcomes are the exhaustive enum of §5;
every non-`valid` outcome is a **valid negative retained in the participant's
denominator** ("failures never leave the denominator"), so a *partial* fire still
scores its sent arms (§V4). A **C**-class disposition/outcome anywhere in a cohort
blocks "scored"; **H** is valid published coverage carrying no model score;
**UNKNOWN**/**salvage** are excluded from clean coverage / the canonical cohort; only
**G** contributes a scoreable model decision.

## 8. Transition-ledger state machine

The transition ledger (§3.2) records the lifecycle of markets that do **not**
produce a completed fire artifact — every `not_entered` outcome, plus a claimed fire
that did not finalize (`interrupted`). Markets that fire and finalize
(`entered`/`fired`, including the `zero_valid_arms` scoring outcome, §7b) are
evidenced by the run file + `fire_coverage_snapshot`, **not** this ledger; they
appear here at most as the transient `ready`→`fired` handoff. Two slate/census
outcomes (`schedule_changed`, `out_of_cohort_observed`) are produced by the **V6
slate pass**, not the tick ledger.

Each record carries a pinned `state` **and** its explicit §7 `reason` (so the class
G/H/C is unambiguous directly from the pinned reason). The `state↔decision` map
(`fired ⇔ entered`; every other
state ⇔ `not_entered` with the record's `reason`) is used **only** for the V6 ledger
reconciliation.

**States.** During the window a not-yet-fired market stays **transient**; a
window-lifetime verdict (`absent`/`late`/`delayed`) is knowable only at finalization,
so it is **never** taken mid-window (a premature terminal + the no-regression rule
would freeze a wrong tick-1 verdict).
- *Transient:* `detected`, `evaluating`, `ready`, `pending_open`, `deferred`.
- *Terminal — event-driven (immediate; each monotone or fail-closed):* `disabled`
  (→ `policy_disabled`), `first_pitch_passed` (→ `first_pitch_passed`; monotone —
  `detectedAt` past the frozen cutoff never un-passes), `read_failed` (→
  `history_unavailable`, **C**; fail-closed), `interrupted` (→ `fire_interrupted`, **C**).
- *Terminal — finalization-resolved (assigned ONLY at finalization from full
  odds_history + census):* `absent` (→ `market_never_two_sided`), `late` (→
  `late_detection`), `delayed` (→ `delayed_open`), `deferred`-survivor (→
  `capacity_deferred`, salvage). (`schedule_changed` / `out_of_cohort_observed` are
  V6/slate-produced.)
- *Handoff:* `fired` — exits the ledger; authoritative evidence is the run + snapshot.
There is **no** `stale` state: `stale_quote` is a runtime decline the scorer cannot
verify (UNKNOWN — §2/§7).

**Legal transitions.**
- `detected → { disabled | evaluating }`
- `evaluating → { ready | pending_open | first_pitch_passed | deferred | read_failed }`
  — note **no** `absent`/`late`/`delayed` edge: those are finalization-only.
- `pending_open → { evaluating | ready | pending_open | deferred }` and
  `deferred → { evaluating | ready | pending_open | deferred }` — re-evaluated each
  tick (a not-yet-two-sided or cap-deferred market is re-detected; it may open, be
  admitted, or defer again).
- `ready → { fired | interrupted }` — a claimed fire either finalizes (`fired`,
  handoff) or crashes (`interrupted`).
Any edge not in this graph (e.g. `detected→ready` without a gate result,
`evaluating→absent` mid-window, or `fired→ready`) is illegal.

**Rules.**
- **Legal transitions only** — the graph above.
- **Stable record order** — appended in nondecreasing `snapshotAt`; the scorer reads
  in that order; ties broken by a per-record monotonic sequence.
- **Finalization** — at `windowEnd + ingestionGraceMs`, a market's terminal
  disposition is its last **event-driven** terminal if it has one; otherwise it is
  resolved from the full odds_history + census: a two-sided opener with
  `openerAge > lateThresholdMs` → `late`; a two-sided opener past `firstTwoSided + W`
  (≤ late) → `delayed`; **no** first two-sided row at or before finalization →
  `absent`/`market_never_two_sided`; a `deferred` survivor → `capacity_deferred`
  (salvage). A market left `ready` (a claimed fire that neither finalized nor crashed),
  or still transient with a **clean-window** two-sided opener it never fired, is a
  **coverage hole** → cohort-failing (V6 — a runner bug, not a benign state).
- **No terminal-state regression** — once a market reaches a terminal state, a later
  record moving it backward is a **violation**, not an overwrite.

## 9. Confirmed decisions

**9.1 `maxDispatchLagMs = 10 s`.** Measured at the actual provider HTTP-request
boundary for each arm, not when a promise/task is created. Both operands
(`firstRequestAt`, `detectedAt`) are benchmark-host, so **no clock-skew allowance
applies** and the 10 s bound is exact (M-note). An arm not started within 10 s is
**not sent** and recorded as arm-outcome `dispatch_lag_exceeded` — a V4 valid
negative, so a *partial* fire still scores its sent arms; only an all-arms-late fire
is `fire_interrupted`. Preserve the cohort evidence and return nonzero runtime health
(a custody/health signal, like V7).

**9.2 Reschedule policy — frozen cutoff, no historical reconstruction.** Membership
is frozen at cohort start; census rows keep their original `scheduledAtAtFreeze`,
which is the **canonical cutoff** for every schedule-derived gate (e.g.
`first_pitch_passed`). Live `games.match_time` is **not** used to reconstruct a
detection-time cutoff — it is mutable and there is no append-only schedule history,
so the live value cannot say what it was at detection. A **material** divergence
(≥ `scheduleChangeToleranceMs`) between `scheduledAtAtFreeze` and live `match_time` at
finalization is a typed, non-fired **`schedule_changed`** outcome (covers a
reschedule-out **and** an in-window reschedule; the game stays in the denominator,
never paid-fired outside its frozen window). A game absent from the frozen census
that appears in `odds_history` gets **`out_of_cohort_observed`** (V6) — the archive
cannot prove a reschedule-in versus a newly-discovered game, so the reason claims
only *observation*. Both keep such games from disappearing silently.

**9.3 Published root = on-chain Polygon anchor (exact contract).** Git commit/tag
dates are locally selectable and do not prove an object existed before the window;
the anchor is on-chain. All human-readable manifests/artifacts live in the public
evidence repository (`ospex-artifacts`); Polygon carries the durable timestamp (§5
layer 3).

**Root construction.** A root is `sha256` over a canonical **inventory**: a JSON
array — sorted by `path` bytewise ascending — of `{ path, sha256 }` entries, where
`path` is the artifact's **repo-relative POSIX path** (forward slashes, no `./`
prefix) and `sha256` is over the artifact's **raw file bytes** (not a re-canonicalized
record — file-byte hashing is unambiguous for published files).
`root = sha256Hex(canonicalJSON(inventory))`.
- The **manifest root** covers just `cohort-manifest.json`.
- The **post-cohort root** covers the ordered inventory of: the manifest, every run
  artifact, every fire snapshot, the transition ledger, and the relevant source
  snapshots/digests.

**Calldata.** A zero-value transaction (no contract, no approvals) whose calldata is
the UTF-8 bytes of `ospex-anchor/v1/<manifest|postcohort>/<cohortId>/<rootHexLower>`
— domain-prefixed, versioned, and self-describing, so the verifier can locate and
recompute it.

**Pinned in the manifest:** `anchorChainId = 137` (Polygon mainnet); `anchorWallet`
(the dedicated evidence-anchor EOA — **the same wallet publishes BOTH roots**);
`anchorTarget` (the tx `to`; default a self-send to `anchorWallet`, so no third
party is touched); `anchorVersion = v1`; `postRootMaxDelayMs = 900_000`.

**Timing.** The manifest root is anchored **before `windowStart`**; the post-cohort
root **within `postRootMaxDelayMs` of finalization**.

**Verification (V6 anchor check — the enforced contract).** For each root the scorer
reads the transaction whose calldata decodes to it and requires ALL of:
- `chainId == anchorChainId`, `from == anchorWallet`, `to == anchorTarget`, calldata
  version `v1`, `cohortId` matches;
- `receipt.status == 1` and the tx is in a **finalized** block (read at the
  `finalized` tag — a reorg that orphans the anchor requires a re-anchor; only a
  finalized inclusion is honored);
- **manifest root:** `anchorBlockTime < windowStart`;
- **post-cohort root:** `finalization ≤ anchorBlockTime ≤ finalization + postRootMaxDelayMs`
  — a **bounded** window (not merely `≥ finalization`, so a root anchored much later
  is rejected), where `finalization = windowEnd + ingestionGraceMs`.
Any condition unmet ⇒ cohort rejected (C).

## 10. Re-cut — close #10/#11, spec PR, then three fresh slices

**#10 and #11 are closed as superseded (not merged).** Their immutable head SHAs
(#10 `92a2089`, #11 `809c977`) remain available; selected leaf/library work may be
ported, but the orchestration/evidence model is rebuilt from this spec.

| PR | Content | `--live` |
|---|---|---|
| **0 — spec only** | Commit the base spec + this evidence-model spec into the repo; the cohort-manifest schema (§3.0), the pinned constants (§6), the state/reason matrix (§7), the transition-ledger state machine (§8), the hash domains + trust boundaries (§5), and the test matrix (§11). **Merge after paper signoff.** | n/a |
| **1 — orchestration, rehearsal only** | Per-market independently-scheduled paths; no sibling barrier; no-wait batching + bounded concurrency; capacity-bounded I1 with `capacity_deferred`; pending/completed/failed lifecycle; interrupted-restart unhealthy/nonzero (V7); crash-ordering (§3.4). No live run files. | **hard-disabled** |
| **2 — event evidence + single-fire verifier** | Mandatory `artifactSchemaVersion`; cohort/fire/run identity; fire envelope + `denominatorSha256` + arm digest; V1, V1b, V2, V3, corrected V4, V8, V-lag; clean single-fire E2E. | **hard-disabled** |
| **3 — event-scoped coverage + independent slate pass** | Atomic fire-coverage snapshots; canonical `Disposition` in both sites; fire↔run one-to-one linkage; multi-fire both-score; frozen/reschedule-safe census; full V5/V6 slate pass; on-chain anchor (§9.3). **Only this PR may enable `--live`, after the whole stack passes adversarial review.** | **enabled here only** |

Each PR branches from the **then-current `main` after its predecessor merges** — no
long-lived stacked pair. PRs 0 and 1 are **not** developed concurrently. Run no
cohort until PR-3 merges.

## 11. Test matrix

- **Multi-fire both-score:** moneyline tick 1, total tick 2 → two run files, each
  binds to its own `fire_coverage_snapshot`, both pass V1–V5; each scored once.
- **No sibling stall:** A ready, **N>1** siblings' reads held open → A fires
  (latency assertion).
- **No-wait batching:** a ready market never delayed by a coalescing window or a
  sibling's not-yet-ready state.
- **Capacity overload:** more ready markets than the cohort cap → deterministic
  priority; the deferred markets carry typed `capacity_deferred`; `detectedAt` is not
  moved forward; a deferred market that falls outside W/V-lag is not clean-dispatched.
- **Stale price / stale gap:** reprice between snapshot and `detectedAt` → V1;
  `bundleSnapshotTs > freshFireMs` before `detectedAt` on a flat market → V1b.
- **Dispatch lag:** an arm whose HTTP request starts `> maxDispatchLagMs` after
  `detectedAt` → V-lag `dispatch_lag_exceeded` (not sent); a *partial* fire still
  scores its sent arms; **all** arms late → `fire_interrupted`.
- **Shopping window:** `detectedAt > firstTwoSided + W` → V8 `delayed_open` (not
  pooled); a boundary within `maxClockSkewMs` → UNKNOWN, not clean.
- **Skew does not widen W:** an entry that is clean only if the legacy 120 s skew is
  added is classified `delayed_open`, not clean.
- **V4 policy:** one arm `timeout`, others valid → scores the valid arms, failed arm
  retained (NOT an event failure); zero valid → `zero_valid_arms` failed-event
  artifact; stripped `FIRE_FAILED` **and** stripped credential-missing arm → still
  refused (roster recompute); missing expected-arm record → integrity violation.
- **Crash ordering:** crash after each of §3.4 steps 1–4, including a
  coverage-append failure after a billed provider request → unhealthy/nonzero,
  at-most-once, V6 rejects the cohort, never rendered clean-entered.
- **Coherent drop:** a market dropped from both run file and ledger → V6 (frozen
  census / `source=jsonodds` appearance).
- **Exactly once:** duplicate fire of one speculation, or a fired transition with no
  green run artifact → V6 linkage violation.
- **Forged detection:** disposition claims appearance, no `source=jsonodds` row ≤
  `detectedAt` → V3.
- **Reschedule (B3):** a census game whose live `match_time` diverges ≥
  `scheduleChangeToleranceMs` from `scheduledAtAtFreeze` → `schedule_changed`, not
  paid-fired; `first_pitch_passed` computed vs the **frozen** cutoff so a rain-delay
  reschedule-later never suppresses an opener detected before the frozen first pitch;
  a non-census game with `odds_history` rows → `out_of_cohort_observed` (V6).
- **Manifest binding:** a run/coverage record referencing a different
  `cohortManifestSha256`, or a denominator whose hash ≠ the envelope's
  `denominatorSha256` → violation.
- **Census builder (B1):** a server that caps every page below the requested limit →
  the walk still returns ALL rows (empty-page termination, never short-page); a
  `match_time` mutation mid-walk drops/duplicates nothing (immutable `jsonodds_id`
  cursor + one MVCC snapshot); a truncated/partial response → build failure
  (fail-closed); a non-advancing cursor → error, not silent truncation.
- **Terminal regression:** a ledger record moving a market backward out of a
  terminal state → violation.
- **As-of vs whole-window detection:** moneyline fires tick 1 while `total` is not
  yet two-sided → run1's denominator marks `total` `not_yet_two_sided` (V3 as-of),
  **not** `market_never_two_sided`; `total` opens tick 2, so the slate V3
  (whole-window) does not flag `market_never_two_sided`.
- **Admission determinism (B4):** more ready candidates than the cap, with gate
  reads finishing out of priority order → admission is decided over **frozen candidate
  identities before any read** (a slower higher-priority `(market, gameId)` is admitted
  over a faster lower-priority one); a failed admitted slot is **not** backfilled that
  tick; a per-tick-deferred market that **re-fires** next tick stays `entered` and
  keeps the cohort rankable; a `deferred`-survivor that **never** fires → salvage, and
  its presence makes the canonical cohort **incomplete/unranked**. `detectedAt`
  unchanged.
- **Anchor contract (B7):** a manifest anchor at/after `windowStart` → rejected; a
  post-cohort root before `finalization` **or** after `finalization + postRootMaxDelayMs`
  (e.g. +20 min) → rejected; a wrong `from`/`anchorChainId`/`anchorTarget`, an
  unfinalized block, or `receipt.status != 1` → rejected; calldata whose recomputed
  inventory root ≠ the published root → rejected.
- **Transient at finalization:** a market left in `evaluating`/`ready` at
  finalization → cohort-failing; a `pending_open` that never opened → `absent`/
  `market_never_two_sided`; a `deferred` that never fired → `capacity_deferred` (salvage).
- **No premature terminal (B5):** a tick-1 `evaluating→absent` is rejected as illegal;
  a market not-yet-open at tick 1 that opens at tick 2 is never frozen `absent`.
- **Opener predates window (B2):** a market whose first two-sided row precedes
  `windowStart` and stays flat (no in-window change row) → `delayed_open`/`late_detection`,
  **never** `market_never_two_sided`.
- **Stale not scorer-verified (B2):** a runtime `stale_quote` decline where
  `odds_history` shows a fresh change row → UNKNOWN, not clean H; if it masks a clean
  two-sided market → V6 coverage hole.
- **Arm-outcome enum (B6):** `cutoff_missed` distinguishes never-sent (cutoff passed
  at dispatch) from sent-late; a required `credential_missing` → C; a missing
  expected-roster record → integrity violation (no absence marker); ≥1 `valid` scores,
  all-non-`valid` → `zero_valid_arms`.
- **Unsubstantiated ledger reason:** a ledger `absent`/`schedule_changed` record whose
  `reason` cannot be reconciled against `source=jsonodds` `odds_history` / live
  `match_time` → UNKNOWN (not a pass).
- **Backward compatibility:** archived smoke-corpus replay still passes (bundle
  shape unchanged).
