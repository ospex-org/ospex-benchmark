# SPEC — line-open runner: the speculation is the unit

Status: **base spec — architecture approved; read alongside the evidence-model
spec.** Target repo: `ospex-benchmark`.

> **Supersession banner (read first).** This base spec nailed the *unit* and the
> *firing model*; the *evidence & verification model* is specified — and in places
> corrects this document — in the companion `SPEC-line-open-evidence-model.md`,
> committed beside this file. Where they differ, the evidence-model spec wins:
> - **§5 sequencing (PR A / PR B) is superseded** by the evidence-model spec's
>   re-cut (PR 0 → 3, `--live` enabled only in PR 3). The original A+B stack (PRs
>   #10/#11) was closed unmerged and rebuilt.
> - **§3.5 (publish the denominator) and §3.6 (independent entry timing) are
>   superseded** by the evidence-model spec (the canonical `Disposition` type, the
>   atomic per-fire coverage snapshot, and V1–V8/V-lag).
> - **§3.3 (independent-by-default firing) is hardened** there (no-wait batching
>   bounded by precommitted capacity; `capacity_deferred`).
> - The reason enum sketched in §3.5 is superseded by the evidence-model spec's
>   **state/reason matrix (§7)**: `market_never_opened` → the pair
>   `not_yet_two_sided` (as-of) / `market_never_two_sided` (whole-window), and
>   `one_sided` is **removed** (the writer discards one-sided tuples, so the archive
>   cannot prove it).
> - **§4's PR labels and per-tick cap are repointed.** Rehearsal mode ships in
>   **PR 1** (evidence-model §10), not "PR A". The per-tick claim cap becomes the
>   hashed manifest **`maxDispatchesPerTick`** (value pinned in the manifest) — the
>   free `--max-fires-per-tick` flag (`DEFAULT_MAX_FIRES_PER_TICK`, default 10) is
>   **deleted** (a per-invocation lever is the cherry-pick surface this benchmark
>   forbids, exactly as §3.2 deleted `--late-minutes`). §4's note that the cap
>   "needs retuning" is honored by pinning it in the manifest (evidence-model §6).
> Everything not called out above still stands; this file is the immutable,
> reviewable base the evidence-model spec builds on.

## 1. Why (and the part that is worse than a feature gap)

The runner today refuses to fire a game until **all three** markets
(moneyline, run line, total) are on the board, two-sided and fresh. We do not
bet the run line, and waiting for a market we do not bet lets the markets we
DO bet drift. But the measurement below shows the defect is worse than a
delay.

### Measured, 24 MLB games (first pitches 2026-07-09 → 2026-07-13)

Per game, the first appearance of each market in `odds_history`:

| | result |
|---|---|
| moneyline → total gap | **0 seconds in 24 of 24 games** (same feed poll cycle) |
| run line lag after moneyline | min 0s · **median 3h 09m** · max 7h 54m |
| games that never got a run line | 0 of 24 (but the post-break NYM@PHI game still has none, ~26h in) |

The two markets we bet open **together**; the market we do not bet opens
**hours later**.

### The consequence in the current code

`boardCompletedAt()` reduces the three markets to the **newest** first
appearance, and the late gate measures `detectedAt − boardCompletedAt`. With
the run line landing ~3h after the moneyline and total, on a typical game the
runner would:

1. hold the game as `watched` for ~3 hours while the moneyline and total sit
   open and drift;
2. fire the instant the run line lands;
3. compute `openerAgeMinutes` from the **run line** — i.e. ≈ 0;
4. stamp `run_meta.watch.openerAgeMinutes ≈ 0` into the artifact;
5. **enter a moneyline and total that have been open for three hours.**

The scorer fail-closes on that provenance — and it would *pass*, because it
only checks the runner's number against the runner's own threshold. The
current design does not merely enter late. **It certifies a stale entry as
fresh**, and would have done so on essentially every MLB game.

The feature ask (don't wait on the run line) and the integrity fix (don't
measure entry age off a market we didn't enter) are the same change.

## 2. The one idea

> **Each market on each game is an independent entity.** It is detected on its
> own, gated on its own, fired on its own, and recorded on its own. A "game"
> is nothing but a label that some speculations happen to share.

There is no game-level fire, no game-level bundle, no game-level readiness
check. Those concepts *are* the bug — delete them. A professional bettor fires
the instant a number they want appears; they do not wait on the rest of the
board. **Odds appear → that speculation fires → done**, regardless of what any
other market on that game is doing.

"A game fires once, ever" becomes **"a speculation fires once, ever."**

## 3. Detection and policy are different layers — never conflate them

This separation is the core of the fix.

1. **Detection is universal.** *Every* market that appears is detected,
   timestamped, and recorded — moneyline, total, run line, spread, whatever a
   league sends. No market is ever ignored at the detection layer.

2. **Policy decides what to *do* with a detected speculation.** MLB scores
   moneyline and total, not run lines. A run line is still detected and still
   recorded — with reason `policy_disabled` — it simply is not dispatched to
   the participants.

The run line is not "filtered out." It is seen, logged, and **deliberately not
acted upon**. Detection is complete; action is policy.

### 3.1 Market policy: a per-`(league, market)` allow-list in code

`src/marketPolicy.ts`, versioned, hashed into the run record:

```
MARKET_POLICY_V1 = {
  mlb: ['moneyline', 'total'],      // run line supported, deliberately OFF
  // nfl: ['moneyline', 'spread', 'total'],   // when we enable it
}
```

- Keyed on **`(league, market)`**, and it is an **allow-list** — never
  global-per-market, never a deny-list. Turning off the MLB run line says
  nothing about NFL spreads; enabling NFL spread later is one versioned entry,
  not a change to MLB.
- **Default for any unlisted `(league, market)` is disabled.** A market
  dispatches only if that league explicitly lists it. Adding a league
  therefore fires *nothing* until its markets are enumerated in a
  policy-version bump — there is no path by which a new league silently starts
  firing markets nobody affirmatively chose. (Detection stays universal: an
  unlisted market is still detected and recorded `policy_disabled`; only
  *action* is withheld.)
- **No `--markets` CLI flag.** A per-invocation lever over which markets are
  entered is exactly the cherry-pick surface this benchmark cannot have.

Spread stays fully supported everywhere (types, prompt, schema, baselines,
scorer) and is simply not enabled for MLB.

### 3.2 The late gate goes per speculation

`boardCompletedAt()` (newest-of-N) is **deleted**. Each speculation is gated
on its own first appearance:

```
openerAge = detectedAt − firstAppearance(game, market)
```

A speculation fires only if its **own** age is inside the threshold. A stale
market can never ride in on a fresh one.

**The threshold is a committed constant — 30 minutes — not a CLI flag.**
`--late-minutes` is deleted. Today the scorer checks
`openerAgeMinutes ≤ lateThresholdMinutes` where the threshold is copied from a
flag accepting up to 1440 — so `--late-minutes 1440` enters 23-hour-old lines
and the scorer certifies them honest. The threshold is an entry-honesty
parameter and is preregistered exactly as the market policy is: stored and
hashed into the run record, and filtered against each speculation's own
recorded first appearance.

### 3.3 Firing: independent by default, batched as a transport detail

Fire-at-detection is **preserved verbatim**. No capture/dispatch split, no
bundle held for later — the bundle is built from the same `current_odds`
snapshot detection reads. This is the one thing the runner exists to forbid;
do not reintroduce it under any refactor.

At each detection, for each game:

- `ready` = every **policy-enabled** market that is **open, unclaimed, and
  individually inside its own late gate**;
- if `ready` is non-empty: build **one** bundle over exactly those markets,
  hash it, **claim each speculation independently**, and dispatch **one**
  request to all twelve participants;
- markets not ready are not in that bundle. They are re-detected on later ticks
  and may fire in their own later dispatch. **Nothing ever waits for another
  market.**

Batching is a **network optimization**, not a coupling. A batched dispatch and
N separate dispatches must produce **the same per-speculation records**.

**Design and test for the fully independent case as the primary path** — three
markets, three arrival times, three fires. Co-arrival batching is the
optimization layered on top, never the assumption. MLB moneyline+total
co-arrive in 24/24 measured games; NFL is expected to open spread, total and
moneyline hours apart, and must need no special-casing.

### 3.4 The bundle carries exactly the markets firing in that dispatch

`GameBundle.markets` becomes per-market optional. The bundle a participant
receives contains exactly the speculations firing in that dispatch — so the
prompt, the required forecast set, the baselines, the records, and the
scorer's denominator all derive from **one** source: the bundle's own market
set. **Every hard-coded `3` dies.**

Two consequences to disclose rather than paper over:

- A split fire means the total is forecast without the moneyline in context,
  while a co-arrival fire has both. The information set is correlated with
  arrival timing. That is inherent to "take what we have when we have it"; it
  is recorded in the (hashed) bundle and must be **stratified in the
  scorecard**, not hidden.
- `PROMPT_SCAFFOLD_VERSION` and the baselines policy version both bump, so new
  runs are not scaffold-comparable with the archived smoke runs. Those were
  never a cohort — but say so.

**Do not rename `markets.runLine` to `markets.spread`.** `verifyRunIntegrity`
replays archived bundles carrying `runLine`; the rename silently breaks replay
of the existing corpus for a cosmetic gain.

### 3.5 Publish the denominator — the load-bearing safety property

Today entry is **non-discretionary**: all three markets or none, so "we chose
not to enter that market" is not expressible. Omission is structurally
impossible, which is why nobody has to trust us.

The moment we can fire the moneyline without the total, **"moneyline entered,
total not" becomes the ordinary case** — and a total that was quietly dropped
looks exactly like a total that never opened. The only record of the
difference is a gitignored local directory.

That is a cherry-pick surface, and per-market firing creates it.

**Requirement:** the corpus must contain the **negative space**. Every (game,
market) the runner sees gets a typed, hashed `speculation_status` record —
`entered` (with full provenance) or `not_entered` with a machine-readable
reason (`market_never_opened`, `late_detection`, `stale_quote`, `one_sided`,
`first_pitch_passed`, `policy_disabled`, …) carrying its first-appearance
evidence. The scorer **reads and enforces** it (today it ignores
`excluded_game` records entirely), so coverage is a published number and a
dropped market is a detectable hole rather than an invisible one.

Per-market firing is only safe *with* this. It is not optional.

### 3.6 Independently verifiable entry timing

`firstAppearanceAt` is currently whatever the runner writes, and the scorer
validates it against itself. `odds_history` is append-only and the scorer can
already reach it.

**The scorer re-derives each speculation's first appearance from
`odds_history` at scoring time** and refuses a run whose claimed opener age
does not reconcile. That converts the central honesty claim from
*self-attested* to *independently verified*.

Cross-clock caveat: `captured_at` is written by the writer's host, `detectedAt`
by the benchmark's host. Use a bounded skew allowance (mirroring the bundle's
`FUTURE_QUOTE_SKEW_MS`). **Do not fail closed forever on a negative age** —
that strands exactly the fresh-open path we care about.

### 3.7 Observability: make "watched" impossible to misread

Non-eligibility is currently a **thrown exception that is then discarded**, and
health is defined as the absence of errors. That is why `1 watched` cannot be
told apart from a silently-empty read path.

- Replace the throw with a pure typed evaluation per speculation:
  `evaluate(game, market, inputs, now) → { state, reason }`. Nothing thrown,
  nothing discarded.
- Log **state transitions**, not ticks: `nym-phi total: blocked(no_odds_rows)
  → open → fired`.
- Write a **status snapshot** each tick (`out/watch-status.json`): every
  speculation, state, reason, first appearance, opener age, plus each read
  path's last-successful-read timestamp.
- **Read-path canaries.** The dangerous failure is a row policy that filters to
  empty rather than denying (PostgREST returns `200 []`, which reads as
  "nothing to do"). Assert positively that each read path returns data; an
  empty result from a path that should have rows is a **failure**, not a benign
  zero. "Absent" and "unknown" are different answers.
- Surface the two conditions that currently exit 0 while doing nothing: the
  aged-inputs stop, and a permanently-deferred speculation.
- Print the enabled policy and the per-speculation block reasons **on boot**.

### 3.8 Detection latency (and two dead ends worth recording)

Chain today: book hangs the line → writer polls the feed (~30s) → snapshot
write → our poll (**300s default**). The poll dominates.

- **Poll cadence is a committed constant (superseded).** The "30–60s recommendation"
  is superseded by the normative **`pollIntervalMs = 30_000`** pinned in the manifest
  (evidence-model §6, §5): a cohort constant that **must be < `W` = 120_000 ms**, not a
  per-invocation `--poll-seconds` lever. The floor is already 30s.
- **Dead end — core-api SSE (`/v1/stream/odds`):** keyed on an on-chain
  `contestId`. These games have no contest. Unusable here.
- **Dead end — tailing `odds_history`:** it takes a row on every *price
  change*, so it is a reprice feed, not an opener feed; and the writer appends
  history **before** committing the snapshot, so a tail detector can see a
  market the bundle cannot yet be built from — which, with claim-before-fire,
  would permanently burn the speculation. Keep detecting from the same
  `current_odds` snapshot the bundle is built from.

## 4. Two hazards to handle before the first live run

**The first live boot burns the board.** Every enabled market already open in
the window will be hours old, fail its late gate, and be ledgered
`late_detection` — permanently, on the first tick. A single accidental live
boot closes the slate.

**Rehearsal mode is mandatory and ships in PR A.** It reports what it *would*
do, per speculation, with reasons, and writes **no live ledger**. No live run
is possible until rehearsal output has been reviewed.

**The spend cap needs retuning.** `--max-fires-per-tick` (default 10) now
counts *speculation* claims; ~15 games × 2 markets = 30 claims on the first
tick that finds them.

## 5. Sequencing

There is **no honest quick unblock.** Narrowing the watched markets to
`[moneyline, total]` without the per-market gate still measures entry age off
the newer of the two — the same class of bug, shipped onto the highest-value
runs we will ever record. The gate and the market scope land together.

| PR | Content |
|---|---|
| **A** | Market policy + universal detection + partial bundles + per-speculation late gate + per-speculation ledger + prompt/schema/baselines derived from the bundle's market set + scorer accepts scoped runs + **rehearsal mode** |
| **B** | Publish the denominator (§3.5) + scorer enforces coverage + independent first-appearance verification (§3.6) |

**A and B ship together, or back-to-back with nothing merged in between.** A
creates the cherry-pick surface; B is what closes it. **Do not run any cohort
in the gap.**

Docs (`LINE_OPEN_RUNNER.md`, the methodology doc, the prompt doc) ship **with**
the PR that changes the behaviour.

## 6. Explicitly out of scope

- No host/deployment change. It runs where it runs today — the operator's call.
- No spread ladder, no new leagues enabled, no Shin de-vig.
- Do not touch closing-line capture, the scoring formulas, or the CLV engine
  beyond what §3.5/§3.6 require.
- **No backfill.** Openers already entered late are sunk and stay as-is; their
  *labels* become honest once §3.6 re-derivation lands, but they are not
  re-entered.

## 7. Verification

- A simulated three-market game with three distinct arrival times produces
  **three independent fires** at three honest opener ages — the primary test,
  not an edge case.
- A simulated co-arrival of moneyline + total produces one dispatch but **two
  independently-claimed, independently-gated, independently-recorded**
  speculations.
- A run line on an MLB game is detected and recorded `policy_disabled`, and
  never dispatched.
- **Policy isolation:** MLB run line disabled + NFL spread enabled produces
  exactly that. A league absent from `MARKET_POLICY_V1` fires nothing (every
  market `policy_disabled`) until explicitly listed.
- A stale moneyline (open 3h) and a fresh total (open 2m) on one game: the
  total fires, the moneyline is recorded `late_detection`, and nothing lets the
  moneyline ride in on the total's freshness.
- The scorer rejects a run whose claimed opener age doesn't reconcile with
  `odds_history`.
- `verifyRunIntegrity` still replays the archived smoke corpus (game-scoped
  bundles carrying `runLine`) — backward compatibility by recorded policy
  version.
- Rehearsal mode writes no live ledger and prints, per speculation, what it
  would do and why.

## 8. The clock

Openers land roughly **26–52h before first pitch**, and the post-break slate is
opening now (NYM@PHI's moneyline and total opened 2026-07-14 19:04 UTC). A
speculation whose opener lands while the runner is down, or before the fix
ships, is **permanently un-enterable** at an honest age. Every day of delay
forfeits that day's openers.
