# Market-open integration follow-ups

B1 remains fixture-only. These are bounded B2–B4 admission gates from
[PR #124's external review](https://github.com/ospex-org/ospex-benchmark/pull/124#issuecomment-5613903597),
not authorization to implement or activate those slices. The reviewed predecessor
is `1b57ae2ea1b8896f89e9791161c5ff739d55481a`; the governing mechanic remains
[SPEC-market-open-mode.md](SPEC-market-open-mode.md).

## D1 — history evidence and consumer admission (B2 → B4)

B1 deliberately leaves `bundle_game.sourceOddsRows` empty: that legacy channel
holds `current_odds` rows, not history openers. The authoritative evidence is
`run_meta.marketOpen.source`, joined by `runId` and bound to event game/market,
request and source hashes. Empty `sourceOddsRows` alone is neither evidence of a
missing opener nor permission to score a market-open run. B1 tests pin the empty
array, matching run ID, and complete `run_meta` provenance together.

Before B4 admits live market-open artifacts, B2 must provide an explicit
history-source discriminator/reference on the game record, without fabricating a
`CurrentOddsRow`. B4 must require that reference to resolve to the same run's
immutable opener, validate game/market/request/source identity, and reject a
missing, crossed, or inconsistent reference. Preserve legacy record behavior and
historical replay. B1 does not change the record format to pre-implement B2.

## D2 — identity versus dispatch permission (B2)

Before adding paid admission, split the permanent prepared-run identity checks
from the temporary dry-run/synthetic-clock gate. Keep the provenance membership,
run/cohort/build, request, roster and original observation-time bindings intact;
B1 tests now pin the previously uncovered roster and both fetch-time clauses.
Opening a mode gate must not weaken any identity check. B2 must prove those
negative cases still fail and separately prove durable claim/budget admission
before any initial or repair send. No live permission is added by B1.

## D3 — shared record validator ownership (B2 integration)

Retain the current cheap, non-circular feature import for B1; do not introduce a
registry solely for this test correction. When separating admission from identity,
keep a small owned validation boundary rather than making the shared record
primitive import each future runtime. If an injected validator/registry is used,
it must be code-owned and mandatory for the market-open namespace, not an optional
caller hook that bypasses validation. Test legacy compatibility and namespace
squatting/absent-provenance rejection before consumer admission.

## D4 — fixture spend evidence (B2)

The canned fixture uses `billingClass: 'known-zero'`. Its passing spend verdict
proves shared-guard composition only; it cannot prove billable usage accounting or
cap enforcement. The separately pinned reservation is an administrative upper
reservation, not an invoice. B2 must exercise billable initial/repair/search costs,
missing/unknown usage, cumulative reservations, over-cap halt, and durable recovery
through the real admission path before any paid operation.

## P2 — immutable opener age is not dispatch lag (B2)

B1 intentionally accepts an old opener as the historical reference, retaining its
original timestamp. Assembly at that instant makes the shared current-quote age
check zero; it imposes no maximum opener age. Future-openers and at/after-first-
pitch observations are still refused. B2 must bound observation-to-send lag and
preserve the first observation through recovery, not impose an accidental
current-quote freshness gate on historical openers or refresh source timestamps.
