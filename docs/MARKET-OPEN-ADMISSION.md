# Market-open B2: admission and producer

**Source-only; awaiting external R3. Nothing installed or enabled.** This is a library boundary, not a new service or a relaunch command. Campaign/#122/#123 remain alternatives. B3 execution and B4 consumer/publication admission remain closed.

## API and authority

`MarketOpenProducer` accepts one immutable cohort name/date, an absolute local evidence root, a cumulative USD-micro cap, and the pinned roster's transport adapters. It does not load credentials, construct providers, query Supabase, or publish. `observe(observation)` synchronously commits admission and schedules that single market. `admit` commits without dispatch (also the crash boundary); `recover` schedules only unsent claims. `drain` waits for all owned jobs; `close` drains before releasing its writer lock. Caller-owned adapter maps, methods and artifact-root options are captured before admission.

The observation boundary is trusted: callers supply the complete history result for exactly one game/market and its real first eligible observation time. No current-odds or full-board completion adapter is substituted. Source-acquisition/activation wiring must preserve this contract; this PR does not install a Supabase reader. B1 validates/prepares the singleton request and immutable opener. An existing admitted event is reconstructed from its ORIGINAL persisted preparation, not the newest observation or source row.

## Proposed lag policy — two minutes

`MARKET_OPEN_ADMISSION_POLICY` freezes **120,000 ms inclusive** from the original `observedAt` to *each actual adapter send*, initial or repair. A separate admission-policy digest pins this policy into the root config and produced artifact without rewriting the accepted B1 cohort-policy bytes. Two independent market workers, 60,000 ms per-attempt timeout and 6,000 maximum output tokens are fixed with it.

- A send at 120,000 ms is eligible only if still strictly before first pitch. At 120,001 ms, before observation, or at/after first pitch: no send.
- Recheck after durable attempt-intent fsync, immediately before `adapter.chat`. The request timestamp uses that same fresh clock reading. A no-send after intent is settled as known zero, not guessed spend.
- A queued/recovered event already outside the bound is durably `refused`. A per-arm/repair refusal after dispatch begins stays an explicit failed outcome; it never fabricates a pick. Other eligible markets do not wait for this event.
- Never refresh `observedAt`, opener timestamps, event identity, or the reservation to retry. Reservations are lifetime cumulative, not reusable balances; even late/refused admitted work retains its reservation. No automatic lag override.
- This is an observation-to-send bound, not a maximum historical opener age or a response-completion deadline. The shared runner independently enforces first-pitch acceptance and decision-preserving, tools-disabled repairs.

## Single writer, atomicity, accounting

One private **local POSIX** root is the authoritative ledger for a cohort. The host must provision that one root consistently; copying it or supplying another root is not an authorized second writer. Shared/network filesystems and multi-host writers are unsupported. An exclusive `.writer-lock` directory, owner nonce and inode verification fence concurrent writers. There is no lease expiry, PID/mtime takeover, or automatic stale-lock deletion. Lock or persistence uncertainty poisons the handle and leaves the lock in place.

The store uses the campaign sink's `installBytesNoClobber`/`nodeArtifactFs`: write temporary bytes, file fsync, no-clobber hard link, directory fsync. Each canonical hash-chained journal operation commits the whole per-market claim, original preparation, initial+repair slots and cumulative reservation in one install. Replays verify canonical shapes, sequence, hashes, pinned config and artifacts; malformed/truncated/drifting roots fail closed. The chain detects damage, not an adversary allowed to rewrite the entire private root.

Each initial/repair slot has a durable intent before send and immutable evidence after settlement, before validation or repair. The shared runner owns request/response timestamps, raw usage, provider response envelope, search audit, request parameters and outcome. The producer always applies the shared **billable** conservative pricing/guard path—even to the synthetic test adapters. Missing usage or search accounting is unknown, never B1's mock-only known-zero escape. Known costs use the pinned price table; over-reservation actuals are not clamped. Unknown spend or a per-attempt/cumulative breach halts all future initial/repair sends and admissions; already in-flight responses still settle and retain evidence.

The scheduler has two independent market workers; each invokes the existing runner for ONE prepared market and its fixed roster concurrently. It does not call the runner's legacy multi-game serial loop. Thus a slow moneyline does not block a total; a third event queues under the bound. No worker clears a halt or retries an uncertain send.

## Record and artifact boundary

The shared `buildRecords` calls `marketOpenRecordBoundary` unconditionally. B1 permanent identity checks remain owned by preparation; fixture-only permission is separate from producer permission. The producer's store-owned receipt binds the exact prepared run AND exact envelope, with each recorded send matching settled journal evidence. Copying a receipt/envelope, squatting the namespace, dropping provenance, or changing run/cohort/build/roster/request/fetch timestamps cannot bypass it.

`bundle_game.sourceOddsReference` is an explicit `market-open-history-v1` reference to that run's `run_meta.marketOpen.source`, bound to event, game, market, opener and hashes. `sourceOddsRows` remains empty: no invented `CurrentOddsRow`. Legacy records keep their prior shape. B4 must validate this reference before consumer admission.

The producer installs one immutable, canonical `<eventId>.json` containing policy, shared records, spend verdict and admission evidence. Only after installation and artifact read/hash/fsync verification does a terminal journal entry attach it and permit clean completion. Invalid arm outcomes remain `failed`; accounting uncertainty remains `unknown`. Neither is promoted to `completed` merely because an artifact exists. Consumer discovery and trusted public publication are not added here.

## Recovery and stop semantics

- `claimed`, no attempt intent: rebuild the exact persisted preparation; send only inside the original lag/first-pitch bounds. Otherwise refuse without sending.
- `running` after interruption, including settled attempts but no completion: persist `unknown`, retain the reservation and halt the cohort. Never resend or recreate an identity to repair an uncertain run.
- `completed`/`failed`/`unknown`/`refused`: stable replay; no provider dispatch. A completed artifact must still match its hash and durable path on reopening.
- An artifact installed before a lost terminal commit is orphan evidence, **not completion authority**. Preserve it for offline reconciliation; this version conservatively halts instead of automatically adopting it.
- Journal/config/artifact damage, fsync ambiguity or stale writer locks: stop. An operator must first prove all writers stopped and preserve the root, then clear ONLY the stale lock under exclusive offline control. This is a prerequisite to reopening, not permission to clear a persisted halt or edit the journal. No online unlock/unknown-spend override API exists in B2.

SIGKILL tests kill disposable synthetic child processes at claim and send, prove reopening cannot steal the lock, then perform test-only offline clearance after `waitpid`. Unsent claims recover with their original clock; interrupted sends recover unknown with zero retries. These tests do not claim power-loss or network-filesystem conformance.

## Acceptance evidence

- `marketOpenProducer.test.ts`: real admission-before-send/repair assertions, independent bounded workers, exact replay, billable initial/repair/search costs, missing initial/repair/search usage, known over-cap halt, cumulative cap refusal, first-observation lag boundaries/recovery, fsync crossing the lag bound, artifact-install failure, SIGKILL claim/send recovery and exclusive writer.
- `marketOpenStore.test.ts`: atomic reservation/replay, writer exclusion, initial/repair persistence, unknown halt and damaged journal rejection.
- `marketOpenRecordBoundary.test.ts` plus unchanged `marketOpen.test.ts`: history reference, owned permission, unjournalled envelope rejection, exact identity negatives, namespace/absent-provenance rejection and legacy compatibility.
- All test files are in canonical `yarn test`. All new adapters/data are synthetic and perform no network or credential access. No provider, Supabase, production-data, betting, service or publication operation is part of verification.
