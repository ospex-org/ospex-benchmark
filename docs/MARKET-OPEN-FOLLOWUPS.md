# Market-open integration follow-ups

B1 (#124) is accepted. **B2 implementation below awaits external R3; nothing is installed or enabled.** These dispositions close the B2 source/test items from [the #124 review](https://github.com/ospex-org/ospex-benchmark/pull/124#issuecomment-5613903597), not the remaining B3/B4 integration or activation gates. See [SPEC-market-open-mode.md](SPEC-market-open-mode.md) and [B2 admission contract](MARKET-OPEN-ADMISSION.md).

## D1 — history evidence and consumer admission (B2 implemented; B4 open)

B2 adds `bundle_game.sourceOddsReference`, explicitly discriminated as `market-open-history-v1` and resolving to the same run's `run_meta.marketOpen.source`. It binds event/cohort/run/game/market, opener ID/time and source/request/game hashes. `sourceOddsRows` stays empty; it is the legacy current-odds channel, not a place to fabricate a history row. Both markets and legacy-shape preservation are tested.

**B4 still required:** require the reference and immutable opener to resolve consistently; reject missing/crossed/inconsistent evidence before scoring or publication. Preserve historical replay. This PR does not enable consumer admission.

## D2 — identity versus dispatch permission (B2 implemented)

`assertMarketOpenPreparedRecordIdentity` owns permanent preparation/provenance/run/cohort/build/request/roster/fetch-time identity. `marketOpenRecordBoundary` separately enforces fixture or durable producer permission. B1's identity negative tests remain; the new boundary tests exercise independent context mutations, absent provenance, namespace squatting, copied preparation/receipt, unjournalled sends and changed producer context. Every actual initial/repair call additionally requires an already durable claim/reservation and single-use attempt intent.

## D3 — shared record validator ownership (B2 implemented)

`buildRecords` imports one small owned boundary and calls it unconditionally. The boundary is not an optional injected validator or caller registry. Producer permission requires the store's unforgeable in-process receipt for the exact prepared run/envelope and matching settled attempt evidence. Type-only reverse dependencies remain erased. Legacy records retain their exact prior game-record shape.

## D4 — fixture versus billable spend evidence (B2 implemented)

The B1 canned fixture remains known-zero and non-authorizing. `MarketOpenProducer` uses the real admission path and shared **billable** guard/pricing math in synthetic tests: initial plus repair costs, search evidence, missing initial/repair usage, missing search count, known over-cap actuals without clamping, cumulative reservation refusal, persistent halt, artifact failure, and SIGKILL/replay recovery. Attempts are durably claimed before every synthetic send. Unknown is never priced as zero; reservations are never automatically released. This proves code behavior, not actual provider invoices or production filesystem conformance.

## P2 — opener age versus dispatch lag (B2 implemented; bound proposed for R3)

Proposed maximum observation-to-send lag: **120,000 ms inclusive (two minutes)**, for every initial and repair. First pitch is an independent strict cutoff. Recheck after durable attempt-intent fsync; at 120,001 ms refuse without sending. Queue/recovery uses the original persisted first observation, never a refreshed time. Refused events keep their cumulative reservation and identity. An old opener remains the reference; no current-quote age gate is imposed on its timestamp. Tests cover both sides of the lag boundary, repairs, fsync delay and recovery.

## Remaining admission gates

- **B3:** execution intent extraction requires exact completed claim/run/market/source/accepted decision, with existing stake, first-pitch, line, liquidity and receipt safety unchanged.
- **B4:** namespace discovery, history-reference verification, scorer/denominator handling, reveals/writeups and serving cost/status publication plus actual public-view readback.
- **Activation:** separately approved source acquisition and service wiring, one authoritative local POSIX evidence root, credential isolation, deployment/recovery checks and operational relaunch. No automatic stale-lock stealing or unknown-spend override is implemented. Campaign/#122/#123 remain set aside, not deleted.
