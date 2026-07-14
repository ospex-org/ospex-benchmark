# Line-Open Runner (watch mode)

## Why this exists

CLV asks one question: did you get a better number than the closing line?
Enter at (or near) the close and no forecast can look good — the line has
already absorbed everything, so economic CLV is structurally ≈ −vig and
margin-adjusted CLV ≈ 0 (the entry matches the market; the two metrics just
state that on different scales). The first live smoke proved it: every arm
landed within a point of −vig, because the slate was bundled hours after
the lines had matured. The methodology's
cutoff has always been *first eligible*; watch mode is the machinery that
actually honors it.

**Fire-at-detection only.** The runner never freezes a bundle for later use.
A harness that detects at time T and fires at T+Δ has watched the line move
for Δ — a cherry-pick surface indistinguishable from tout math, no matter how
honest the operator. Detection and firing are one event: the moment a game
becomes eligible, the bundle is assembled, hashed, and dispatched to all
twelve participants in the same breath, and the game is never touched again.

Two mechanisms, two jobs — they are complements, not substitutes:

- **The frozen bundle** is the *fairness* mechanism: all twelve participants
  (four model arms + eight deterministic baselines) receive identical
  information at the identical instant, entering at the same prices. Without
  it, a leaderboard measures fetch latency and plumbing differences, not
  forecasting.
- **The recorded pick** is the *commitment* mechanism. Today it is an NDJSON
  record with full provenance (hashes, timestamps, raw responses). The
  recording step is deliberately the single seam where, once wallets and a
  market to bet into exist, the pick becomes a signed on-chain commitment —
  etched, unfakeable, ordered by the chain before the outcome. Nothing
  upstream of that seam changes when that day comes.

## What "eligible" means (the fire condition)

A game fires the moment the existing bundle builder produces a request for
it — no separate detection predicate exists, so detection can never drift
from what participants are actually given. Concretely that means all of:

- status `upcoming`, first pitch in the future;
- all three markets (moneyline, spread, total) present with two-sided prices
  and lines where applicable;
- every quote fresh under the harness's existing quote-age policy.

MLB books typically hang the full board (totals wait on pitcher
confirmation) somewhat after the first moneyline appears; *first eligible*
is first complete board, which is also the first moment the fixed
moneyline+total execution policy is playable at all.

## Late-detection gate (entry honesty)

Firing is only honest if the entry price is genuinely the early number. At
detection, the runner computes the **board-completion time** — the newest of
the three markets' first price-history rows — and if that moment is older
than the late threshold (default 60 minutes), the game is recorded as
`late_detection` and **never fired**. This covers watcher downtime and first
boot against an already-open board: stale opportunities are excluded from
the cohort, not silently entered late. Excluded means excluded — there is no
retry, no deferred fire, no backfill.

## The per-game decision event

For one game, once, at detection:

1. Assemble a CURRENT snapshot (games read path + public odds read path):
   the working inputs are re-fetched whenever they are more than thirty
   seconds old — including AGAIN after the gate's board-history reads,
   which are network calls and can be slow — so every game is evaluated
   and fired on seconds-old prices no matter how long anything earlier
   took. Fire-at-detection holds per game, not merely per tick. Build and
   hash the bundle from that snapshot; the detection instant is stamped
   after final assembly, so bundle-assembly ≤ detection ≤ dispatch holds
   by construction (and the scorer verifies exactly that chain).
2. Verify the late-detection gate (ANY board timestamp after detection
   fails closed — never cached, never fired; the runtime accepts only
   what the scorer will).
3. Claim the game in the ledger — memory first, then disk — BEFORE any
   dispatch, so neither a crash nor a restart can ever double-bill.
4. Fire: dispatch all four model arms concurrently (existing per-game
   runner: injected clock, cutoff enforcement, repair rules, identity
   checks) and run all eight baselines against the same bundle.
5. Write one self-contained run file for the game (`out/`,
   `watch-v0-<slateDate>-<hex>.ndjson`) — run metadata **including the
   watch-gate provenance** (detection time, board-completion time, opener
   age, configured threshold — the scorer fail-closes on it for watch
   runs), the frozen bundle, every attempt with provenance, decisions,
   baselines. The existing scorer consumes these files unchanged.
6. Finalize the ledger entry with the outcome. Done forever.

Games are independent events: a provider failure, identity failure, or
integrity problem on one game poisons only that game's file; the watcher
logs it and keeps watching.

## The ledger (idempotency + audit)

`out/watch-ledger/<gameId>.json` — one file per handled game (existence =
handled; state is re-derived from disk on restart, so the watcher can never
double-fire across restarts). Each entry records the decision (`fired` |
`late_detection`), the board-completion timestamp and opener age, the bundle
and request hashes, the run file, and outcome tallies. Ledger writes go
through the same redaction chokepoint as every other artifact.

The bundle hash in the ledger is the future anchor for input-commitment
publication (publishing hashes at fire time to the public evidence layer),
which is deliberately out of scope here.

## Labels and cohorts

Run files keep the existing frozen record label (it is typed and
participates in every content hash); watch runs are identified by their
`runId`/`cohortId` prefix `watch-v0-`. Like the smoke, **watch-v0 output is
plumbing validation, not a cohort** — nothing from it belongs on a
leaderboard.

## Reading the tick line

Every poll prints exactly one line:

```
tick 2026-07-14T19:05:19.302Z: 1 in window · 1 watched · 0 fired · 0 late · 0 deferred · 0 failed
```

The timestamp is when the pass *started*, taken from the same injected clock
that stamps the records. The six counters are per-tick, and they count
**games**, not markets:

- **in window** — rows the games read path returned: MLB games whose first
  pitch falls between now and now + `--window-hours` (default 168). It is the
  raw row count from the tick's first fetch, taken *before* dedupe and
  *before* the ledger filter, so it also counts games already handled in an
  earlier tick, games with no odds posted at all, and any duplicate row. A
  census, not a denominator.
- **watched** — candidates evaluated this tick and found not (yet)
  actionable, leaving no ledger entry: the bundle builder refused to produce a
  request (the usual case — the board is not complete yet), or the game left
  the refreshed snapshot, or its first pitch passed mid-tick. This is the
  resting state; a watched game is re-detected from scratch every tick.
- **fired** — games that became eligible and were dispatched to all twelve
  participants this tick, run file written, ledger entry finalized. Terminal:
  a game fires exactly once, ever.
- **late** — games that became eligible but whose board completed more than
  `--late-minutes` (default 60) before detection. Recorded `late_detection`
  and never fired. Also terminal — excluded means excluded.
- **deferred** — eligible games whose late gate could not be evaluated yet
  because a first-appearance history row was not readable. Benign for a tick
  or two (history lags the snapshot). Deferral happens only *after* a game is
  eligible, so a game still waiting on its board reads as `watched`, never as
  `deferred`.
- **failed** — per-game failures: a board-history read that *threw*, a fire
  that errored, a fire that came back collision-failed (the identity check —
  file kept, permanently unscoreable), or a malformed row / failed ledger
  write. Any `failed` makes the pass non-healthy, and `--once` exits nonzero.
- **CAP HIT** — appended only when `--max-fires-per-tick` (default 10) stopped
  the loop with candidates remaining. By design, but never silent; the
  unclaimed games are re-detected next tick.

The counters **do not sum**, and are not meant to. `in window` is the raw
census; the other five count only *unhandled candidates*. A game in the ledger
is filtered out before the loop and contributes to `in window` and to nothing
else — so the healthy steady state *after* a slate is handled is
`N in window · 0 watched · 0 fired · …`, all zeros. Within one tick a candidate
increments at most one counter; across ticks the same game legitimately moves
between buckets, so summing a column over time double-counts games.

Two counts read backwards from the obvious:

- A **collision-failed fire counts as `failed`, not `fired`** — but the
  providers were already billed and the run file was written. `failed` does
  not mean "no spend."
- **`fired` means dispatched without a collision failure.** It does not mean
  the models answered: every arm can time out and the game still counts as
  fired. Arm health lives in the ledger entry's `armOutcomes` and in the run
  file, never in the tick line.

## Is the watcher healthy?

Healthy and idle is `N in window · M watched` with the last four counters at
zero. Most ticks look like that: lines open in bursts, and most games in a
168h window have no complete board yet. `fired`, `late`, `deferred` and
`failed` are the only counters that report that something *happened*.

- `0 in window` — no MLB game has a first pitch inside the window. Correct
  during the All-Star break and the off-season. The games table mirrors what
  the odds feed has published, not the full published MLB schedule, so a
  post-break slate appears a few days out rather than all at once.
- `watched` pinned with no fires — the normal pre-fire holding pattern. The
  common cause is a half-open board: MLB books hang the moneyline and total
  before the run line, and there is no partial-board eligibility.
- `deferred` on one tick, gone the next — a one-cycle history lag, by design.
- `deferred` on the same game every tick — the first-appearance read path is
  broken, not slow. The runner escalates once past the late threshold, but
  that warning is in-memory only and its clock resets on every restart.
- `late` — the watcher was not running, or not looking, when that board
  completed. Expected on first boot against an already-open board; otherwise
  it is the direct cost of downtime, and the game is burned permanently.
  **Downtime is destructive:** a board that completes while the watcher is
  down is excluded forever, not entered late. That is the entry-honesty
  guarantee working, and it is also the reason to keep the process up.
- `failed` — always real. The reason is on stderr immediately above the tick
  line, and the ledger entry names it (`fireError`, `collisionFailed`).
- No tick line at all, only `tick <ts> failed: …` — the tick's first fetch
  threw (API down, timeout, a rejected wire body). Loud and correct: the loop
  sleeps and ticks again.

What the tick line will **not** tell you — the states that read healthy while
nothing will ever fire:

- **`watched` never says why.** A game waiting for its run line and a game
  whose odds read silently returned an empty array look identical on the tick
  line. The exclusion reason (`missing_market:spread`, `stale_quote:total`,
  `no_odds_rows`, …) is computed inside the bundle builder and then discarded.
  If `watched` stays pinned, read the board directly rather than trusting the
  counter.
- **A quiet `deferred` loop is the worst case.** A read that is *filtered* to
  an empty result rather than *denied* (a narrowed row policy rather than a
  revoked grant) returns 200 with `[]`: every candidate defers forever,
  `failed` stays 0, and `--once` exits 0. A denied read throws and lands in
  `failed`, which is the loud case.
- **The aged-inputs stop is invisible.** `inputs still aged after refresh —
  stopping this tick` breaks the candidate loop early, increments no counter
  and sets no summary field, so the tick still reports healthy. The stderr
  line is its only trace.
- **A fire with dead credentials still counts as `fired`.** A missing or
  expired provider key is an arm *outcome*, not a throw, so a fire in which
  every arm failed prints `1 fired · 0 failed` — and the game is ledgered
  forever. `yarn preflight` before a board completes is the cheap way to know
  the arms are alive; there is no un-fire.
- Nothing about `watched` / `deferred` / `CAP HIT` is written to disk. That
  history exists only in the terminal — capture stdout if it should outlive
  the session.

Checking state by hand, when the counters are not enough:

- **Why is this game only `watched`?** Read its board — all three markets must
  be present and two-sided, with non-null `line` on spread and total, and no
  quote older than thirty minutes:
  `GET $SUPABASE_URL/rest/v1/current_odds?select=market,line,away_odds_american,home_odds_american,upstream_last_updated&network=eq.polygon&jsonodds_id=eq.<gameId>`
  Two rows (moneyline, total) and no spread is the ordinary half-open board:
  `missing_market:spread`.
- **Is the history read path alive?** (the silent-deferral hole)
  `GET $SUPABASE_URL/rest/v1/odds_history?select=captured_at,market&order=captured_at.desc&limit=3`
  Rows means the grant and the row policy are both intact; `[]` here, while
  `current_odds` still reads, is the regression the deferral warning is about.
- **What has been handled?** `ls out/watch-ledger/` — one file per game,
  existence means handled forever. The startup banner prints the same count.
  A ledger entry's `decision` is written *before* dispatch, so `"fired"` there
  means *claimed*, not *succeeded*: reconcile on `fireError` / `collisionFailed`
  and the run file, never on `decision` alone.

## Operations

- `yarn watch` — long-running loop; `--poll-seconds` (default 300),
  `--window-hours` (default 168), `--late-minutes` (default 60, max 1440),
  `--max-fires-per-tick` (default 10 — a circuit breaker on per-tick spend:
  once hit, the tick stops loudly, unclaimed games re-evaluate next tick,
  and the pass reports non-healthy), `--out` (default `out`), `--once`
  (single pass, for external schedulers and tests; exits nonzero when the
  pass failed — including per-game failures, collision-failed fires, and a
  hit spend cap), `--dry-run` (fixture
  inputs + mock adapters + synthetic clock; no credentials, no spend,
  writes to an ephemeral directory unless `--out` is given; exercised by
  tests).
- Entries are never made on aged inputs: sequential fires consume wall time,
  and once a tick's fetched snapshot is older than ten minutes the tick
  stops — unclaimed games are re-DETECTED next tick from fresh inputs
  (re-detection, not deferred firing). A game whose first pitch passes
  mid-tick is likewise never claimed.
- A game deferred on a missing first-appearance history row for longer than
  the late threshold triggers a one-time loud warning — a prolonged deferral
  means the history read path itself is broken, not that data is slow.
- One instance at a time (model calls cost real money; the ledger makes
  double-fire impossible across restarts but not across two concurrent
  processes).
- `yarn preflight` before a live session remains the ritual.
- Scoring is unchanged: after closes land, `yarn score --run out/<runId>.ndjson`
  per fired game.

## Non-goals (this change)

- No deferred firing or replay tooling of any kind.
- No per-market re-entry (one fire per game at full-board detection).
- No publication of bundles/hashes to the public evidence layer (follow-up).
- No on-chain commitments (the seam is documented above; the upgrade slots
  into the recording step when wallets and a book to bet into exist).
- No changes to bundle eligibility, the runner, records, prompts, or the
  scorer.
