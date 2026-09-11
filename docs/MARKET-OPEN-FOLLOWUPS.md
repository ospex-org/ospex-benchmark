# Market-open integration follow-ups

B1 (#124) is accepted. **B2 received external R3 at `f52f779`; review corrections and the advisory-timing change are authorized for merge. Nothing is installed or enabled.** These dispositions close the B2 source/test items from [the #124 review](https://github.com/ospex-org/ospex-benchmark/pull/124#issuecomment-5613903597), not the remaining B3/B4 integration or activation gates. See [SPEC-market-open-mode.md](SPEC-market-open-mode.md) and [B2 admission contract](MARKET-OPEN-ADMISSION.md).

**B4 sequence (source-only):** the operator authorized three PRs after the serving schema conflict was verified: benchmark discovery/scoring with SQL publication explicitly blocked; indexer attempt/timing schema prerequisite; then MVE scheduler/reveals/serving plus replay and actual anonymous FE-view readback. See [B4.1 scoring contract](MARKET-OPEN-SCORING.md). No activation or public-readback claim is implied by this first PR.

## D1 — history evidence and consumer admission (B2 implemented; B4 open)

B2 adds `bundle_game.sourceOddsReference`, explicitly discriminated as `market-open-history-v1` and resolving to the same run's `run_meta.marketOpen.source`. It binds event/cohort/run/game/market, opener ID/time and source/request/game hashes. `sourceOddsRows` stays empty; it is the legacy current-odds channel, not a place to fabricate a history row. Both markets and legacy-shape preservation are tested.

**B4 still required:** require the reference and immutable opener to resolve consistently; reject missing/crossed/inconsistent evidence before scoring or publication. Require `mode === 'live'` and `clockMode === 'wall'`; fixture-labelled streams must not enter production. Preserve historical replay. This PR does not enable consumer admission.

## D2 — identity versus dispatch permission (B2 implemented)

`assertMarketOpenPreparedRecordIdentity` owns permanent preparation/provenance/run/cohort/build/request/roster/fetch-time identity. `marketOpenRecordBoundary` separately enforces fixture or durable producer permission. B1's identity negative tests remain; the new boundary tests exercise independent context mutations, absent provenance, namespace squatting, copied preparation/receipt, unjournalled sends and changed producer context. Every actual initial/repair call additionally requires an already durable claim/reservation and single-use attempt intent.

## D3 — shared record validator ownership (B2 implemented)

`buildRecords` imports one small owned boundary and calls it unconditionally. The boundary is not an optional injected validator or caller registry. Producer permission requires the store's unforgeable in-process receipt for the exact prepared run/envelope and matching settled attempt evidence. Type-only reverse dependencies remain erased. Legacy records retain their exact prior game-record shape.

## D4 — fixture versus billable spend evidence (B2 implemented)

The B1 canned fixture remains known-zero and non-authorizing. `MarketOpenProducer` uses the real admission path and shared **billable** guard/pricing math in synthetic tests: initial plus repair costs, search evidence, missing initial/repair usage, missing search count, known over-cap actuals without clamping, cumulative reservation refusal, persistent halt, artifact failure, and SIGKILL/replay recovery. Attempts are durably claimed before every synthetic send. Unknown is never priced as zero; reservations are never automatically released. This proves code behavior, not actual provider invoices or production filesystem conformance.

## P2 — timestamps and advisory dispatch lag (B2 implemented)

**Timestamps, not trip wires. Monitoring, not gating.** Record opener presence (the history row's actual capture timestamp), first observation, claim, each arm's initial/repair send and response, and artifact installation. Observation-to-send lag remains on the run and `status()` heartbeat payload. Its configurable warning threshold defaults to **120,000 ms**; exceeding it records/surfaces a warning and never refuses or halts work. No lag-refusal or held-reservation-on-lag-refusal path remains. First pitch and spend caps remain hard stops; unknown spend is never permission to spend again.

The actual send reading follows intent fsync. Queue/recovery preserves the original first observation and claim time and continues before first pitch regardless of elapsed lag. An old opener remains the reference; no current-quote age gate applies. Transport timeout is the remaining time to first pitch, not a fixed duration. Tests pin both threshold sides, configurable/in-flight status, late initial/repair sends, post-fsync readings, recovery and preserved first-pitch stops. Final artifact installation time lives in the completion journal/status because immutable pre-install records cannot contain their future installation time.

**B4 status note:** initial hard-cutoff refusals use the shared `dispatch_lag_exceeded` arm category; repairs can retain `invalid_schema` plus the cutoff detail. Neither represents an advisory-lag refusal now. Diagnose lag using the timing fields/warnings across both roles, not just the arm's terminal category. B4 still owns service heartbeat/public status wiring.

## R3 filesystem follow-up (not enforced by B2)

The store rejects Windows and protects canonical local paths, but POSIX does not prove a local filesystem class. Before activation verify the evidence root is not NFS/SMB/9p/DrvFs. A future deployment-hardening change should enforce and pin supported mount types at open/replay; this PR does not claim network-filesystem detection or conformance.

## B4 third PR — bounded publisher no-change exit

Scope added after the accepted Supabase I/O investigation: in **ospex-mve serving**,
return early when no relevant input changed since the last successfully published
watermark, **before** rebuilding source/key/version/latest/aggregate working sets.
Caller-side or function-side is permitted; a function-side change is a migration
for the operator to apply, not permission for an agent to execute production SQL.
This is a narrow no-change fast path, **not** a full incremental publisher redesign.

- The watermark/change boundary must cover every input that can change the existing
  ledger or aggregates, including new evidence, late scoring/corrections, repairs,
  statuses and publication versions. A max game/creation timestamp alone is not
  proof of no change. Preserve append-only versions and historical/as-of semantics.
- Advance durable publication state only after successful publication; failures
  must remain retryable. Inputs arriving during a publication must still be seen
  on the next invocation. Missing/uncertain watermark takes the existing full path.
- Synthetic regressions: unchanged second invocation performs no working-set
  rebuild and no append; new evidence and a late correction each force the old
  publication path; failed publication retries; racing input is not lost. Prove
  replay equivalence and actual anonymous FE-view readback as already required.
- This is change detection, not freshness gating: timestamps remain monitoring
  labels. Never skip a changed completed run because it is old.

Operational containment is separate: the operator moved compute from Micro to
Small and authorized an hourly publisher timer while the benchmark is paused.
Use the next 24-hour observability graphs as the monitoring signal; no I/O root
cause is claimed by the capacity/cadence changes. No pruning, VACUUM FULL, new
indexes, support ticket or automatic activation belongs to this scope.

## Remaining admission gates

- **B3:** execution intent extraction requires exact completed claim/run/market/source/accepted decision, with existing stake, first-pitch, line, liquidity and receipt safety unchanged.
- **B4:** namespace discovery, history-reference verification, scorer/denominator handling, reveals/writeups and serving cost/status publication plus actual public-view readback.
- **Activation:** separately approved source acquisition and service wiring, one authoritative local POSIX evidence root, credential isolation, deployment/recovery checks and operational relaunch. No automatic stale-lock stealing or unknown-spend override is implemented. Campaign/#122/#123 remain set aside, not deleted.
