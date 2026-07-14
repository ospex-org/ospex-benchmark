# Line-Open Runner (watch mode)

## Why this exists

CLV asks one question: did you get a better number than the closing line?
Enter at (or near) the close and no forecast can look good — the line has
already absorbed everything, so economic CLV is structurally ≈ −vig and
margin-adjusted CLV ≈ 0. The first live smoke proved it: every arm landed
within a point of −vig, because the slate was bundled hours after the lines
had matured. The methodology's cutoff has always been *first eligible*; watch
mode is the machinery that actually honors it.

## The one idea: the speculation is the unit

**Each market on each game is an independent entity.** It is detected on its
own, gated on its own first appearance, claimed on its own, fired on its own,
and recorded on its own. A "game" is only a label some speculations share.
There is no game-level fire, no game-level bundle, and no game-level readiness
check — those concepts were a bug (a stale moneyline riding in on a fresh run
line), and they are gone.

A professional bettor fires the instant a number they want appears; they do
not wait for the rest of the board. The runner behaves the same:
**odds appear → that speculation fires → done**, regardless of what any other
market on that game is doing. Nothing ever waits for another market.

## Detection and policy are different layers

- **Detection is universal.** Every market a league sends is detected,
  timestamped, and recorded — moneyline, total, run line — no exceptions.
- **Policy decides what to ACT ON.** `src/marketPolicy.ts` is a preregistered
  allow-list keyed on `(league, market)`. MLB acts on the moneyline and the
  total; the run line is detected and recorded `policy_disabled`, never
  dispatched. The policy is versioned code hashed into every run record, not a
  CLI flag — a per-invocation lever over which markets are entered would be a
  cherry-pick surface. A league absent from the allow-list dispatches nothing
  until its markets are explicitly listed in a version bump.

## Fire-at-detection (preserved verbatim)

The runner never freezes a bundle for later use. A harness that detects at
time T and fires at T+Δ has watched the line move for Δ — a cherry-pick
surface indistinguishable from tout math. Detection and firing are one event:
the bundle is built from the same `current_odds` snapshot detection reads and
dispatched in the same breath.

Batching is a transport detail, not a coupling. When two enabled markets are
ready in the same tick (MLB's moneyline and total open in the same feed cycle),
they share ONE dispatch to all twelve participants — but each is claimed,
gated, and recorded independently. A batched dispatch and N separate
dispatches produce the same per-speculation records.

## The per-market late gate (entry honesty)

Firing is only honest if the entry price is genuinely the early number. Each
speculation is gated on its OWN first board appearance:

```
openerAge = detectedAt − firstAppearance(game, market)
```

A speculation fires only if its own age is within the threshold — a committed
constant of **30 minutes**, not a flag. A market whose opener is older is
recorded `late_detection` and **never fired**. This covers watcher downtime and
first boot against an already-open board: a stale opportunity is excluded, not
silently entered late. Excluded means excluded — no retry, no deferred fire, no
backfill. Because the gate is per market, a stale moneyline can never ride in
on a fresh total.

## The per-fire decision event

For one game's ready speculations, once, at detection:

1. Assemble a CURRENT snapshot (games read path + public odds read path),
   re-fetched whenever more than thirty seconds old — including again after the
   gate's board-history reads. Build and hash the bundle carrying exactly the
   ready markets; detection is stamped after assembly, so
   bundle-assembly ≤ detection ≤ dispatch holds by construction.
2. Apply the per-market late gate (a first appearance after detection fails
   closed — never cached, never fired; a small skew allowance mirrors the
   bundle's future-quote tolerance).
3. Claim each ready speculation in the ledger — memory first, then disk —
   BEFORE any dispatch, so neither a crash nor a restart can double-bill.
4. Fire: dispatch all four model arms concurrently and run all eight baselines
   against the same bundle. The prompt, required forecasts, baselines, and the
   scorer's denominator all derive from the bundle's own market set — every
   hard-coded "3" is gone.
5. Write one self-contained run file (`out/`, `watch-v0-<slateDate>-<hex>.ndjson`)
   — run metadata **including per-market watch-gate provenance** (detection
   time, and each market's first appearance + opener age + the committed
   threshold), the frozen bundle, every attempt, decisions, baselines. The
   scorer re-verifies each market's opener age from this artifact.
6. Finalize each speculation's ledger entry. Done forever.

## The ledger (idempotency + audit)

`out/line-open-ledger/<gameId>/<market>.json` — one file per handled
speculation. Existence means handled forever; the set is re-derived from disk
on restart, so a speculation fires at most once, ever, across restarts. Each
entry records the decision (`fired` | `late_detection`), the market's first
appearance and opener age, the bundle and request hashes, the run file, and the
outcome. A corrupt file is treated as handled (never risk a double-fire). Ledger
writes pass the same redaction chokepoint as every other artifact.

## The published denominator (what makes per-market firing safe)

Per-market firing creates a selective-retention surface: once the moneyline can
fire without the total, "moneyline entered, total not" is the ordinary case, and
a total that was quietly dropped looks exactly like one that never opened. So
the corpus must carry the **negative space**, not just what fired:

- Every fired run file embeds a `speculation_status` record for **every market
  of that game** — `entered` (with its first-appearance evidence), or
  `not_entered` with a machine-readable reason (`policy_disabled`,
  `market_never_opened`, `late_detection`, `one_sided`, `stale_quote`, …). A
  game that fires only its moneyline still records, in the same file, that its
  total never opened and its run line was policy-disabled.
- A game that fires **nothing** produces no run file, so an append-only coverage
  log (`out/line-open-coverage.ndjson`, emitted on state change) carries those
  dispositions too.
- The scorer **enforces** consistency: for a watch run, the `entered` set must
  equal the bundle's market set and the gated set — a market marked `not_entered`
  that actually fired, or an entry with no denominator, is a hard violation.
  Coverage becomes a published number, and a silently-dropped market becomes a
  detectable contradiction rather than an invisible gap.

## Independently verified entry timing

The recorded opener age is not taken on faith. `verifyWatchEntryTiming`
re-derives each entered market's first board appearance from the append-only
`odds_history` and reconciles the run's self-reported timing against it, within
a bounded cross-clock skew (the runner and the writer stamp on different hosts).
A claimed opener the log refutes is a violation; a market the log cannot resolve
is a typed UNKNOWN (surfaced, never a silent pass and never a permanent
fail-closed — that would strand the fresh-open path). This converts the
fire-at-detection claim from self-attested to independently checked.

## Rehearsal mode (mandatory before a first live boot)

On first boot, every enabled market already open in the window is hours old and
would be correctly-but-irreversibly ledgered `late_detection` — one accidental
live boot burns the whole board. `yarn watch --rehearse` evaluates every
speculation and prints what it WOULD do (fire / exclude late, with reasons),
writing no ledger and dispatching nothing. Review its output before any live
run.

## Reading the tick line

Every poll prints one line:

```
tick <ts>: 4 games · 12 specs · 7 fired (4 dispatches) · 0 late · 0 deferred · 1 blocked · 4 disabled · 0 handled · 0 failed
```

The counters are per tick and count **speculations** (game × market), not
games, except `games` and `dispatches`:

- **games** — games in the lookahead window (the raw census).
- **specs** — (game, market) pairs evaluated this tick, excluding ones already
  terminal in the ledger.
- **fired** — speculations newly dispatched this tick.
- **dispatches** — billing events (a batched co-arrival is one dispatch of four
  model calls, however many markets it carries).
- **late** — speculations newly excluded `late_detection` (their opener was
  older than the 30-minute threshold). Terminal.
- **deferred** — buildable speculations whose first-appearance history row is
  not visible yet (transient; retried next tick).
- **blocked** — enabled speculations not fireable now: the market has not opened
  (`market_never_opened`), is one-sided, is stale, or the first pitch has
  passed.
- **disabled** — speculations withheld by policy (the MLB run line).
- **handled** — speculations already terminal in the ledger (census-only).
- **failed** — per-speculation failures (a thrown history read, a fire error, a
  collision-failed fire, a malformed row). Any `failed` makes the pass
  non-healthy and `--once` exits nonzero.
- **CAP HIT** / **REHEARSAL** — suffixes for a hit dispatch cap or report-only
  mode.

Healthy and idle is `N games · M specs` with `fired/late/deferred/failed` at
zero and the rest census. A per-speculation status snapshot is written to
`out/line-open-status.json` each tick (state + reason + first appearance per
speculation), so "why is this only blocked" is answerable from a file rather
than inferred from the counters — the exclusion reason a naive counter hides.

## Operations

- `yarn watch` — long-running loop; `--poll-seconds` (default 60, min 30),
  `--window-hours` (default 168), `--max-dispatches-per-tick` (default 20 — a
  circuit breaker on per-tick spend; once hit, the tick stops loudly and
  unclaimed speculations re-evaluate next tick), `--out` (default `out`),
  `--once` (single pass; exits nonzero on any failure or a hit cap),
  `--rehearse` (report-only, implies `--once`), `--dry-run` (fixture inputs +
  mock adapters + synthetic clock; ephemeral out dir unless `--out` given;
  implies `--once`). The late-detection threshold and the market policy are
  committed constants, not flags.
- One instance per `--out` directory (model calls cost real money; the ledger
  makes double-fire impossible across restarts but not across two concurrent
  processes).
- `yarn preflight` before a live session remains the ritual — a fire with dead
  credentials still counts as fired, and the ledger is one-shot.
- Scoring is unchanged: after closes land, `yarn score --run out/<runId>.ndjson`
  per fired game.

## Labels and cohorts

Run files keep the frozen record label `SMOKE_V0_NOT_A_COHORT` (typed and
hash-load-bearing); watch runs are identified by the `watch-v0-` runId /
cohortId prefix. Like the smoke, **watch-v0 output is plumbing validation, not
a cohort** — nothing from it belongs on a leaderboard. A scoped fire's market
subset and its bumped prompt scaffold mean new runs are not scaffold-comparable
with the archived three-market smoke corpus (which was never a cohort either).

## Non-goals (this change)

- No host/deployment change — it runs where it runs today.
- No new leagues enabled, no spread ladder, no Shin de-vig.
- No on-chain commitments (the recording step is the documented seam for that
  upgrade when wallets and a book to bet into exist).
