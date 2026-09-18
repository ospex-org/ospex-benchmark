# Local owner-death recovery

`src/localProcessLock.ts` owns the benchmark writer's local lock protocol. It is reusable by the MVE reader in the **next** PR; this PR changes no reader, heartbeat, wrapper, pin, fixture or service.

## Scope and dependencies

- One private local-disk Linux root on one box, in one host PID namespace. `/proc/sys/kernel/random/boot_id` and `/proc/<pid>/stat` must be readable; util-linux `/usr/bin/flock` must be available. No added npm dependency.
- Not a lease, age threshold, distributed lock, network-filesystem lock or protection against an operator rewriting the private root. No wall-clock age authorizes takeover.
- New `owner.json`: `nonce` (64 lowercase hex), `pid`, `bootId` (Linux boot UUID), `processStartTicks` (exact decimal field 22 of `/proc/<pid>/stat`, clock ticks since boot). Start ticks are an identity, not a deadline.

## Exclusive ownership

Before inspecting or changing the marker, open the stable sibling `.writer-lock.guard` and take a nonblocking kernel `flock` on that **open file description**. The short-lived util-linux child receives that same descriptor as fd 3; its exit does not release the parent's lock. The parent retains the descriptor for the entire writer lifetime. Kernel cleanup releases it on process death/reboot. **Never unlink or rotate the guard file**: its persistent empty file is not a stale marker. A second new writer cannot inspect/reclaim/publish a marker while the first owns this guard.

The existing `.writer-lock/owner.json` plus directory inode still fence ownership, including against an old-version writer that does not understand the guard. Before each ledger mutation, verify the guard inode, marker inode and exact owner bytes. A concurrent legacy `mkdir` after an archive wins or loses against the new `mkdir`; a collision refuses rather than deleting the competing marker. A live legacy PID always blocks.

## Proof, not elapsed time

- Valid recorded boot ID differs from this boot: previous process is dead, even if its numeric PID now exists.
- Otherwise PID absent: `/proc` absence **and** `kill(pid, 0)` returns `ESRCH`. Permission errors/hidden process state are not death.
- Same recorded boot, PID exists, recorded process start ticks differ: PID was reused; original owner is dead.
- Same boot/PID/start ticks: refuse; owner is alive.
- Legacy/partial record missing boot ID or start ticks: an absent PID can still be reclaimed. An existing PID is ambiguous and blocks; do not infer identity from mtime, startup time, uptime, or age.
- Missing, malformed, symlinked or unreadable records, unavailable identity, kernel-lock failure and storage failures refuse with a cause-specific `LocalProcessLockError`. Incomplete markers without provable ownership require offline inspection, including a crash in the marker-creation/owner-install window. Never guess them dead.

## One durable record per reclaimed marker

Under the kernel guard, derive an ID from the previous marker's device/inode and exact owner-bytes SHA-256. Install `.writer-lock-recoveries/<id>.json` with no-clobber/file fsync/directory fsync. It contains `previousOwner`, `previousOwnerSha256`, `previousLock`, `reason`, `recoveredAt`, `recoveredBy`, current boot ID and observed process start ticks. Then recheck the marker and atomically rename it intact to `.writer-lock-recoveries/<id>.lock`, fsync both directories, and acquire a new marker.

The record is **write-ahead evidence**: if storage fails or the process dies before the archive, it may describe a verified recovery intent not yet completed. Retrying that same marker reuses the original record/timestamp rather than writing another. After the archive, there is no stale active marker to recover twice. A record does not claim the producer has started; successful store replay/startup is separate.

Clean close removes the active owner/marker, fsyncs the root, then closes the kernel descriptor. A poisoned store cannot clean-close. Failed construction drops its kernel descriptor but retains its marker, which blocks while that PID is alive and can be recovered after death. Do not remove any journal, configuration, reservation, attempt evidence or persisted accounting halt as part of lock recovery.

## Verified behavior and remaining integration

`marketOpenLockRecovery.test.ts` covers different-boot/dead/reused-PID takeover; live, legacy, malformed and incomplete records; no age takeover; actual SIGKILL; guard replacement/symlinks; concurrent child-process recovery; and record retry without duplication. The producer SIGKILL tests recover unsent claims without manual deletion and retain interrupted sends as unknown with **zero retries**. The store restart test checks initial/repair costs and reservations survive actual owner exit.

These are disposable synthetic tests, not a real host reboot, disk power-loss proof, provider send or live-lane exercise. The MVE wrapper still masks errors until the next reviewed PR; reader recovery and heartbeat down-alert deduplication are also deliberately deferred to that PR. No runtime activation is authorized by this change.
