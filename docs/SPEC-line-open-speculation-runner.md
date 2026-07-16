# SPEC — line-open runner: the speculation is the unit

Status: **base spec — the unit + firing model; read alongside the Tier-0
evidence-model spec.** Target repo: `ospex-benchmark`.

> **Supersession banner (read first).** This base spec nailed the *unit* and the
> *firing model*; the **Tier-0 evidence & measurement model** is specified in the
> companion `SPEC-line-open-evidence-model.md`, committed beside this file. Tier 0 is a
> **statistical instrument with transparent coverage**, not an adversarial protocol.
> Where they differ, the Tier-0 spec wins:
> - **§3.6 (independent entry timing from `odds_history`) stands and is central** — it
>   is a retained Tier-0 protection (independent first-appearance + as-of quote
>   verification).
> - **§3.5's *intent* stands — coverage is a *published number*** — but Tier-0 derives
>   it **globally at scoring time** from the independent `odds_history` universe
>   (`U − F`), **not** from a per-fire denominator embedded in each artifact. An
>   operational miss is *reported*, not cohort-poisoning. The per-fire
>   `speculation_status` mechanism and machine-reason enum sketched in §3.5 do **not**
>   carry into Tier 0 — markets that never fired are the global `U − F` miss set with
>   **advisory** reasons (Tier-0 spec §6).
> - **§3.3 (per-market, no-wait firing) stands** (independent claims; a ready market
>   never waits for a sibling). Capacity/spend caps come from the manifest, and a
>   capacity miss is *reported* in coverage.
> - **§5 sequencing (PR A / PR B) is superseded** by the Tier-0 re-cut (PR 0 → 3,
>   `--live` only in PR 3). The A+B stack (PRs #10/#11) was closed unmerged.
> - **§4's rehearsal + per-tick cap:** rehearsal ships in **PR 1**; the per-tick and
>   cohort caps come from the manifest (the `--max-fires-per-tick` / `--late-minutes`
>   levers are canonical-mode-locked to the manifest). The base-spec figure "default
>   10" is stale.
> Everything not called out above still stands; this file is the immutable, reviewable
> base the Tier-0 spec builds on.

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
   moneyline and total, not run lines. A run line may still be detected and
   noted — it simply is not dispatched to the participants.

The run line is not "filtered out." It is seen and **deliberately not acted
upon**. Detection is complete; action is policy.

**Tier-0 note.** Universal detection is an operational convenience, not a Tier-0
requirement. Policy-disabled markets may surface in **non-canonical
diagnostics**, but Tier 0 requires **no** canonical detection or status artifact
for them; the final universe is **policy-enabled only** (Tier-0 spec §6).

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
  firing markets nobody affirmatively chose. (Detection stays universal
  operationally: an unlisted market may still be detected and noted in
  non-canonical diagnostics; Tier 0 requires no canonical `policy_disabled`
  artifact — the final universe is policy-enabled only.)
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
market can never ride in on a fresh one. (`firstAppearance` here is the Tier-0
`firstTwoSided` appearance — evidence spec §1; the two names denote one
quantity.)

**The threshold is a manifest constant — `cleanEntryWindowMs = 120_000` (= `W`)
— not a CLI flag.** `--late-minutes` is not a canonical lever. Today the scorer
checks `openerAgeMinutes ≤ lateThresholdMinutes` where the threshold is copied
from a flag accepting up to 1440 — so `--late-minutes 1440` enters 23-hour-old
lines and the scorer certifies them honest. The clean-entry window is an
entry-honesty parameter, preregistered exactly as the market policy is: pinned
in the manifest and hashed into `cohortId`, and filtered against each
speculation's own independently-derived first appearance. Tier 0 additionally
gates on the full **canonical window** (Tier-0 spec §3), not opener age alone.

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
  request to **every arm in `expectedArmRoster`** (Tier-0 spec §2);
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

**Requirement (Tier-0 form).** The cherry-pick surface is closed by **globally
derived coverage**, not a per-fire self-reported denominator. Tier 0
reconstructs the expected universe `U` from the independent `odds_history` first
appearances at scoring time and reconciles it against the fired keys `F` into
published `U/F/C/M/X/D` coverage (Tier-0 spec §6). A dropped market shows up as a
miss in `M = U − F`; it cannot hide, because membership is derived from the
independent feed, not attested per fire. The per-market `speculation_status`
record and machine-reason enum sketched here do **not** carry into Tier 0 —
runner miss reasons are **advisory diagnostics** attached to `M`, never the
denominator.

Per-market firing is only safe *with* published coverage. It is not optional —
but in Tier 0 that coverage is the global `odds_history` reconciliation, not an
embedded per-fire denominator.

### 3.6 Independently verifiable entry timing

`firstAppearanceAt` (the Tier-0 `firstTwoSided` appearance, evidence spec §1) is
currently whatever the runner writes, and the scorer validates it against
itself. `odds_history` is append-only and the scorer can already reach it.

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
  (Tier-0 spec §2): a cohort constant that **must be < `W` = 120_000 ms**, not a
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
the window will be hours old, fall outside its clean-entry window, and become a
coverage miss on the first tick. A single accidental live boot closes the slate.
(Tier 0 records this as a global `M = U − F` miss, not a permanent per-market
ledger stamp.)

**Rehearsal mode is mandatory and ships in PR 1.** It reports what it *would*
do, per speculation, with reasons, and writes **no live ledger**. No live run is
possible until rehearsal output has been reviewed, and `--live` is hard-disabled
until PR 3 (Tier-0 spec §9).

**The caps come from the manifest.** `maxDispatchesPerTick` and the cohort
call/spend caps (`cohortCallCap` / `cohortSpendCapUsdMicros`) are manifest
constants, not CLI defaults; the stale "`--max-fires-per-tick` default 10"
figure does not apply in canonical mode. On the first tick that finds them,
~15 games × 2 markets ≈ 30 candidate claims, bounded by those manifest caps.

## 5. Sequencing

There is **no honest quick unblock.** Narrowing the watched markets to
`[moneyline, total]` without the per-market gate still measures entry age off
the newer of the two — the same class of bug, shipped onto the highest-value
runs we will ever record. The gate and the market scope land together.

**Sequencing is the Tier-0 PR 0 → 3 plan (Tier-0 spec §9), which supersedes the
earlier PR A / PR B split** (the A+B stack, PRs #10/#11, was closed unmerged):
PR 0 is this spec pair; PR 1 is per-market no-wait firing + fire artifacts +
at-most-once + rehearsal; PR 2 is global coverage reconciliation + close capture
+ CLV + scorecard; PR 3 is the budget-bounded live canary. `--live` is
**hard-disabled through PR 2**. The cherry-pick surface PR 1 creates is closed by
PR 2's global `U/F/C` reconciliation — **do not run any paid cohort before
PR 2's coverage lands.**

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

**The authoritative acceptance matrix is the Tier-0 spec §10** (cases 1–33). The
still-current unit/firing checks below are a subset of it; the per-market
`policy_disabled` / `late_detection` **status-record** assertions from the
earlier draft are superseded by global coverage reconciliation (Tier-0 spec §6)
and are **not** Tier-0 acceptance criteria.

- A simulated three-market game with three distinct arrival times produces
  **three independent fires** at three honest opener ages — the primary test,
  not an edge case (Tier-0 §10 case 2).
- A simulated co-arrival of moneyline + total produces one dispatch but **two
  independently-claimed, independently-gated, independently-recorded**
  speculations (Tier-0 §10 cases 3, 24).
- **Policy isolation:** a `(league, market)` absent from the committed market
  policy is never dispatched; enabling NFL spread later says nothing about MLB.
- A stale moneyline (open 3h) and a fresh total (open 2m) on one game: the total
  fires and the moneyline is **not** entered — nothing lets the moneyline ride
  in on the total's freshness. Under Tier 0 the un-entered moneyline surfaces as
  a global `M` miss, not a per-market status stamp.
- The scorer re-derives each speculation's first appearance from `odds_history`
  and refuses a run whose opener age doesn't reconcile (§3.6; Tier-0 V1/V2).
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
