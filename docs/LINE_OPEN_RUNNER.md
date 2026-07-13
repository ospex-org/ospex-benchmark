# Line-Open Runner (watch mode)

## Why this exists

CLV asks one question: did you get a better number than the closing line?
Enter at (or near) the close and the answer is structurally ≈ −vig no matter
how good the forecast is — the line has already absorbed everything, and the
first live smoke proved it (every arm landed within a point of −vig, because
the slate was bundled hours after the lines had matured). The methodology's
cutoff has always been *first eligible*; watch mode is the machinery that
actually honors it.

**Fire-at-detection only.** The runner never freezes a bundle for later use.
A harness that detects at time T and fires at T+Δ has watched the line move
for Δ — a cherry-pick surface indistinguishable from tout math, no matter how
honest the operator. Detection and firing are one event: the moment a game
becomes eligible, the bundle is assembled, hashed, and dispatched to all ten
participants in the same breath, and the game is never touched again.

Two mechanisms, two jobs — they are complements, not substitutes:

- **The frozen bundle** is the *fairness* mechanism: all ten participants
  (four model arms + six deterministic baselines) receive identical
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

1. Assemble inputs fetched *this* poll cycle (games read path + public odds
   read path), filtered to the game; build and hash the bundle.
2. Verify the late-detection gate.
3. Fire: dispatch all four model arms concurrently (existing per-game
   runner: injected clock, cutoff enforcement, repair rules, identity
   checks) and run all six baselines against the same bundle.
4. Write one self-contained run file for the game (`out/`,
   `watch-v0-<slateDate>-<hex>.ndjson`) — run metadata, the frozen bundle,
   every attempt with provenance, decisions, baselines. The existing scorer
   consumes these files unchanged.
5. Append the game to the ledger. Done forever.

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

## Operations

- `yarn watch` — long-running loop; `--poll-seconds` (default 300),
  `--window-hours` (default 168), `--late-minutes` (default 60),
  `--out` (default `out`), `--once` (single pass, for external schedulers
  and tests), `--dry-run` (fixture inputs + mock adapters + synthetic clock;
  no credentials, no spend, exercised by tests).
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
