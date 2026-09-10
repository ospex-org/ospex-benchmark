# Market-open mode — B1 contract

**Selected replacement design; NOT installed or enabled.** Full-board watch stays
retired. Campaign runtime, #122 and #123 are set aside, not deleted. This page
authorizes no provider call, database write, bet, installation, or restart.

## Mechanic and identity

One event is **one `(game, market)` within an immutable cohort/policy identity**.
Dispatch at that market's **first eligible observation**, never waiting for sibling
markets, responses, or publication. Simultaneous openers are separate events.
Eligibility means a valid two-sided opener, an upcoming game before first pitch,
and the frozen sport/market allowlist. B2 must bound detection-to-send lag and
record late/refused/unknown outcomes; an earlier moneyline cannot suppress a total.

Use shared `buildGameBundle`, `buildGameRequest`, and `prepareGameRequest` for the
singleton market. Preserve the **actual history opener**: row ID, exact source
timestamp, prices/line, and canonical hash, separately from observation and model
request/response times. Never substitute current odds, invent sibling blocks,
refresh source timestamps, or relabel `boardCompletedAt` as opener evidence.
An old opener remains the reference: B1 has no maximum opener age; B2 bounds
observation-to-send lag. [Integration gates](MARKET-OPEN-FOLLOWUPS.md) cover history
record references, validator ownership, and known-zero versus billable spend.
Bind game, market, policy, request, claim, and run. Cohorts use the new
**`market-open-v1` namespace**, never `watch-v0`; historical runs retain their method.

The scoped policy reuses the existing allowlist and **`baselines-v0.3.0`**. The
shared response wire token remains `fixed-moneyline-total`; selected decisions must
be supplied and policy-enabled. Absent siblings are not passes or opportunities.
No spread betting, stake changes, or off-line totals pricing is authorized.

## Claim, run, and reuse

A **per-market durable claim must precede any billable send**, including repairs
under the same claim and reserved attempt budget. The stable claim key binds one
run, source hash, and prepared request; preparation is not admission or permission
to spend. B1 records a `required-before-send` contract with paid dispatch blocked.
B2 owns atomic persistence, completion after immutable artifact installation, and
explicit failure/unknown states; uncertainty never permits a fresh-identity retry.

Reuse shared runner/envelope and `buildRecords` primitives for `run_meta`,
`bundle_game`, `arm_game_response`, `decision`, and baseline records, adding
versioned market-open provenance—not a pretend watch ledger. Reuse
`conservativeSpend`/`spendGuard`, including initial/repair and search accounting.
Unknown cost is not zero; conservative estimates are not invoices. B1's executable
fixture is no-network, synthetic, and non-authorizing, not production evidence.

## Downstream ownership — separately authorized, not part of B1

- **B2, admission/producer:** single enforced writer, durable atomic claims and
  cumulative reservations, bounded independent workers, real usage/search evidence,
  immutable artifacts, unknown-spend halt, and crash/replay recovery.
- **B3, execution `scan_intents`:** require exact completed claim, cohort, market,
  run/source hash, and accepted arm decision—not “game fired” or newest file. Retain
  stake, cutoff, exact-line, and receipt controls; no liquidity remains explicit.
- **B4, scorer/scheduler:** admit the namespace and opener provenance, update file
  discovery and per-market denominators, preserve scoring math and failed arms.
  **Reveals/writeups and serving publisher:** their per-decision grain tolerates
  sibling runs; update admission/integrity gates, retain rationale/seal/reveal hashes,
  publish initial-plus-repair cost/status/version to existing FE ledger views, and
  prove replay and actual public-view readback.

**B1: R2 review. B2–B4: R3. Nothing activated; final relaunch is a separate gate.**
