# SPEC — the atomic claim + budget/concurrency + lease store

**What this is:** the design contract for the **one durable, cross-process store** that guarantees a line-open cohort's at-most-once billing, its global call/spend caps, and its concurrency ceiling under concurrent workers — the "atomic at-most-once + budget/concurrency reservation" and "concurrency leases" of `SPEC-line-open-evidence-model.md` §4. It pins the state model, the transaction boundaries and global lock order, the idempotency and integer-accounting rules, the lease/server-time semantics, the crash/completion behavior, the typed refusal outcomes, the backend decision, and the map from the §10 acceptance cases to the two implementation slices that follow. It is **paper only**: no schema migration, no adapter, no runtime wiring, and no live execution land here.

**Why it exists.** The legacy watcher's operational state is a per-game JSON `LedgerEntry` in an in-process `Map` (`watch.ts`). That is structurally insufficient for the per-market no-wait model, in four independent ways, none a patch to the existing shape:

1. **Wrong key.** Keyed per game, but claims are per `(gameId, market)` — a game fires one market now and a sibling later.
2. **Not cross-process.** An in-process `Map` cannot serialize two workers. Per-key `O_EXCL` file claims still cannot enforce a *global* call/spend/concurrency cap across processes (§4).
3. **No budget accounting.** No cohort-wide call-attempt or spend reservation bounds the paid surface across concurrent dispatches.
4. **No leases.** Concurrency is a *transient* capacity that must be reclaimable on completion and crash-expiring — not a permanently consumed counter.

Nothing is live and no cohort state exists to migrate, so this is the cheapest moment to set the boundary once. The store begins clean with the first cohort; the legacy ledger is not migrated.

**Scope of this sub-arc (three slices).** This document is the first:

- **This spec** — the design + interface + backend decision + case map (paper; reviewed before any code).
- **The durable-operations slice** — the schema and the atomic operations against a real transactional backend; no watcher, no provider, no live calls. **Its first gate is the feasibility spike of §11 run against a scratch schema** (concurrent sessions, widened windows), including the concurrent same-`fireId` case.
- **The conformance slice** — the TypeScript adapter and its race/crash conformance suite exercised against **genuinely overlapping** transactions (mocks may supplement but cannot substitute).

The canonical runtime integration is a **later** slice that structurally depends on the conformance suite passing. `--live` stays hard-disabled throughout; no paid cohort runs before global coverage lands.

---

## 1. Design invariants (non-negotiable — from §4)

1. **One durable cross-process lock/transaction** covers the claim, the call reservation, the spend reservation, and the initial concurrency leases **together**, all-or-nothing.
2. **At-most-once claims**, keyed `(cohortId, gameId, market)`. A key claimed once is never re-claimed — not after completion, not after a crash.
3. **`cohortCallCap` counts provider HTTP attempts.** Each dispatch reserves `expectedArmRoster.length × (1 + maxRepairAttemptsPerArm)` attempts, once per dispatch regardless of scoped-market count.
4. **`cohortSpendCapUsdMicros` is a conservative pre-dispatch estimate**; unknown pricing **fails boot**.
5. **Two state classes.** *Consumed cohort accounting* — claim + call reservation + spend reservation — stays consumed; a crash after reservation leaves it consumed; a completed dispatch may **settle** actual counts through the same store but **never below attempts already made** and never below zero. *Transient concurrency capacity* is held as expiring, releasable leases.
6. **Leases are store-time-governed** and reclaimable **only at/after `expiresAt`**, measured by the store's clock, never a worker's. Reclaiming concurrency changes only in-flight capacity; it never refunds a claim/call/spend reservation and never permits a fire retry.
7. **The lease ceiling holds at every instant:** the sum of active, unexpired lease slots across all workers is `≤ maxConcurrentProviderRequests`.
8. **No canonical in-memory or single-process fallback** exists. There is exactly one store of record.

### 1.1 What the store derives vs. what it trusts the caller for

The store must not silently trust a caller-supplied *magnitude* against a pinned cap (a caller passing too small a call reservation would under-reserve and exceed the real cap). So the reservation magnitudes are **store-derived** wherever the inputs are cohort-constant, and the one genuinely per-fire input is trusted, recorded, and bounded:

- **Store-derived (never caller magnitudes):** the per-dispatch **call reservation** `= roster × (1 + maxRepairs)`, the **initial slot count** `= roster`, and every **lease-expiry bound** — all computed inside the store from values pinned at cohort boot (`roster`, `maxRepairs`, `maxDispatchLagMs`, `providerCallTimeoutMs`, `maxClockSkewMs`).
- **Caller-computed, store-recorded + cap-checked:** the **spend estimate**, which depends on this fire's exact input-token count (the store does not parse bundles). The store cannot recompute it, so it **records the per-fire spend reservation** (for the settle) and checks it against the pinned `cohortSpendCapUsdMicros`. The caller is the single trusted in-process runner (base spec §6); a buggy spend estimate is bounded above only by the cap and the conservative rules, which is the guarantee §4 actually promises (not exact billing).

The **caps and all pinned constants are written to the store at cohort boot** from the strictly-parsed manifest, under the `cohortId`. Because `cohortId` is the hash of the manifest (§2), a given `cohortId` always maps to the same pinned values, so a boot that finds an existing row for its `cohortId` need not (and must not) rewrite it.

---

## 2. State model

Four lifecycles, all rows keyed under one `cohortId`.

### 2.1 Fire (per dispatch) — the idempotency + settle anchor

```
(absent) ──admitDispatch──▶ pending ──completeClaim──▶ completed
                              │
                              └──(worker crash; never advances)──▶ interrupted (pending forever)
```

One row per `fireId` records the fire's **persisted call/spend reservation** (so the settle can compute an exact per-fire delta), its status, and its **persisted `made_calls`** (the count of attempts started — the settle floor for calls, durable and independent of lease-row retention). Its existence is the idempotency signal; its `pending`→`completed` transition gates the settle to fire exactly once.

### 2.2 Claim (per `(gameId, market)`) — monotonic, never refunded

```
unclaimed ──admitDispatch──▶ pending ──completeClaim──▶ completed
                               └──(crash)──▶ interrupted (pending forever)
```

A `pending` or `completed` claim blocks any further claim of the same key (at-most-once). `interrupted` is a `pending` claim whose fire never completed; global coverage (§6) reads it as an incomplete fire / miss, never a clean entry. There is **no** transition back to `unclaimed`.

### 2.3 Cohort budget (per `cohortId`) — monotonic reservations, settle-down-only

`callsReserved` and `spendReservedUsdMicros` only ever **increase** at admission, checked against the pinned caps. On clean completion, `completeClaim` may **settle** them toward the actuals through the same store, but a settle only reduces toward the actual, **never below the attempts already made** and never below zero, and fires **exactly once** per fire (§6).

### 2.4 Concurrency lease (one slot per row) — acquired, released, or crash-expiring

```
acquired ──release (finally, per-arm, on response/timeout/abort/failure)──▶ released
   │
   └──(no release; expiresAt passes by store clock)──▶ expired (capacity auto-reclaimed)
```

**Each lease holds exactly one slot** (§4 behavior 3 requires releasing *each* arm's slot the moment *that* HTTP attempt ends). An initial admission acquires `roster` separate 1-slot lease rows — one per expected arm — so each arm's `finally` releases exactly its own. A repair acquires one more 1-slot lease. A lease counts toward in-flight capacity while it is **neither released nor expired** (`released_at IS NULL AND expires_at > store_now()`). Expiry is **implicit**: an expired lease stops counting with no reclaim event; an optional GC (§7) may prune only non-counting rows. A cleanly completed fire holds **no** active leases; a crashed fire may hold leases until their `expiresAt`, after which that capacity is reusable while the crashed fire stays `pending`.

---

## 3. Data model (design-level; not the final DDL)

Four tables. Every timestamp is written and compared with the **store's** clock (§7), never a worker clock.

```
cohort_budget                       -- one row per cohort, written once at boot from the manifest
  cohort_id            text  PK
  schema_version       int          -- store schema version (fail-closed mismatch check, §9)
  call_cap             bigint       -- cohortCallCap (pinned)
  spend_cap_usd_micros bigint       -- cohortSpendCapUsdMicros (pinned)
  concurrency_limit    int          -- maxConcurrentProviderRequests (pinned)
  roster_size          int          -- expectedArmRoster.length (pinned; for store-derived call/slot)
  max_repairs_per_arm  int          -- maxRepairAttemptsPerArm (pinned)
  initial_lease_bound_ms int        -- maxDispatchLagMs + providerCallTimeoutMs + maxClockSkewMs (pinned)
  repair_lease_bound_ms  int        -- providerCallTimeoutMs + maxClockSkewMs (pinned)
  calls_reserved         bigint     -- monotonic; ≤ call_cap
  spend_reserved_usd_micros bigint  -- monotonic; ≤ spend_cap_usd_micros

fires                               -- one row per dispatch: idempotency + settle anchor
  cohort_id      text
  fire_id        text
  call_reserved  bigint             -- this fire's reserved attempts (store-derived at admit)
  spend_reserved_usd_micros bigint  -- this fire's reserved spend (caller estimate, recorded)
  made_calls     bigint             -- attempts STARTED (= roster at admit, += 1 per repair);
                                     --   the PERSISTED, GC-independent settle floor for calls
  status         text               -- pending | completed
  admitted_at    timestamptz
  completed_at   timestamptz null
  PRIMARY KEY (cohort_id, fire_id)

claims                              -- the at-most-once claim ledger
  cohort_id  text
  game_id    text
  market     text                   -- upstream vocabulary: moneyline | spread | total
  fire_id    text
  status     text                   -- pending | completed
  claimed_at   timestamptz
  PRIMARY KEY (cohort_id, game_id, market)     -- enforces at-most-once
  -- secondary index on (cohort_id, fire_id) for the idempotency/replay path

concurrency_leases                  -- one slot per row; releasable, crash-expiring
  lease_id      text  PK
  cohort_id     text
  fire_id       text
  arm_index     int                 -- which roster arm this slot backs (load-bearing for repair idempotency)
  attempt_kind  text                -- initial | repair
  attempt_index int null            -- per-arm repair index (§5 numbers attempts per arm)
  acquired_at   timestamptz         -- store clock at insert (§7)
  expires_at    timestamptz         -- acquired_at + the pinned bound (§7)
  released_at   timestamptz null
  -- unique (cohort_id, fire_id, arm_index, attempt_kind, attempt_index) for PER-ARM repair idempotency
```

Rationale: the claim PK is at-most-once (case 8). The single `cohort_budget` row is the serialization point for the budget race (case 25) and every capacity check. The `fires` row makes the reservation recoverable for a correct settle and is the idempotency anchor. Leases are one-slot rows so per-arm release (behavior 3) is expressible and expiry is a time filter, not a counter that drifts across crashes (cases 45/46).

---

## 4. Transaction boundaries and the global lock order

**Global lock order (deadlock-free by construction):** every operation that touches `cohort_budget` acquires `SELECT … FROM cohort_budget WHERE cohort_id = ? FOR UPDATE` **first**, before any `fires` / `claims` / `concurrency_leases` write. `admitDispatch`, `acquireRepairLease`, and `completeClaim` all obey this single order, so no lock cycle can form. `releaseLease` touches only its own lease row and takes **no** budget lock (freeing capacity is conservative — a concurrent admit that has not yet observed the release merely under-admits, never over-admits).

### 4.1 `admitDispatch` — one transaction, all-or-nothing

1. **Version + existence, fail-closed.** `SELECT … FOR UPDATE` the cohort's budget row. **If no row is found, refuse `not_initialized` and write nothing** — a missing pinned row must never fall through to an uncapped, unserialized admission. If `schema_version` ≠ the client's pinned version, refuse `version_mismatch`.
2. **Idempotency, inside the lock.** With the budget row locked, check for an existing `fires` row for `fireId`. **If it exists, this is a replay of an admission that already committed in full** (the whole admission is one transaction — §5) — return its recorded outcome: the **`claimedKeys`** it owns, the **per-arm** `initial` leases (`{leaseId, armIndex, state}` — live/released/expired), and the fire status (`pending`/`completed`), so a lost-response retry learns the true claimed scope (which co-arrival keys were dropped), can resume per-arm release, tell a live admission from a settled one, and never re-arm a completed fire. A legitimate co-arrival retry re-sends the **original** `proposedKeys`, which is a **superset** of the recorded `claimedKeys` (some keys were dropped) — so the replay is valid whenever `claimedKeys ⊆ proposedKeys`. **Fail loud** (`fire_id_key_mismatch`) **only** when a recorded claimed key is **absent** from the retry's `proposedKeys` — a genuine reuse of the `fireId` for a different dispatch. Do nothing else.
3. **Recheck scope.** Retain the proposed keys **not already claimed by a different `fire_id`** (`claims.fire_id <> fireId`; after step 2 a same-fire key cannot reach here). A key claimed by another fire is dropped (co-arrival partial claim, §4 / case 24).
4. **Zero retained → refuse `all_claimed`**, write nothing.
5. **Derive reservations from pinned values** (not caller magnitudes, §1.1): `callΔ = roster_size × (1 + max_repairs_per_arm)`; `slotCount = roster_size`; the lease bounds from the pinned columns. The **spend** reservation is the caller's per-fire estimate, recorded as-is.
6. **Check** all three caps: `calls_reserved + callΔ ≤ call_cap`, `spend_reserved + spendΔ ≤ spend_cap_usd_micros`, and `slotsInUse + slotCount ≤ concurrency_limit`, where `slotsInUse = SUM(1)` over this cohort's leases with `released_at IS NULL AND expires_at > store_now()`.
7. **If insufficient → refuse** with the binding reason (`call_cap` | `spend_cap` | `concurrency`), write nothing.
8. **If sufficient:** in the **same** transaction — insert `pending` claims for the retained keys (`ON CONFLICT (cohort_id, game_id, market) DO NOTHING`, capturing the **actual** inserted rows). **If zero rows were actually inserted**, refuse `all_claimed` and write nothing else (a defensive assertion: this transaction holds the budget-row lock, so no concurrent admit can commit a conflicting claim mid-transaction and this is unreachable under the lock order — but it guarantees the atomic-refusal invariant regardless). Otherwise: insert the `fires` row (`call_reserved = callΔ`, `spend_reserved = spendΔ`, `made_calls = slotCount`, `status = pending` — `made_calls` starts at the roster's initial attempts and each repair increments it); increment `calls_reserved += callΔ` and `spend_reserved += spendΔ`; insert `slotCount` one-slot `initial` lease rows (`arm_index` 0…roster−1) with `expires_at = store_clock() + initial_lease_bound_ms`. Commit. Return `Admitted` with the actually-claimed keys and the per-arm `initial` lease ids.

**Atomic refusal is the invariant:** any refusal (missing row, version, `all_claimed`, or a cap) writes **zero** `fires`/`claims`/`lease`/budget rows. Because budget and leases are written **only** on the ≥1-actual-insert path, no phantom reservation or phantom lease is possible.

### 4.2 `acquireRepairLease` — one slot, same lock, idempotent

Takes the same `cohort_budget … FOR UPDATE` **first** and performs the same fail-closed `not_initialized` / `version_mismatch` checks as `admitDispatch` (the lock also serializes the capacity check, §1.7 / case 45). Idempotent on `(cohortId, fireId, armIndex, attemptIndex)` — the key **must** carry `armIndex` because governing §5 numbers attempts **per arm** (each arm: initial 1, repair 2), so a per-arm-only `attemptIndex` would collide two arms' repairs and hand one arm the other's lease, breaching the ceiling. A retried repair acquire returns the existing lease, never leaking a slot. Checks `slotsInUse + 1 ≤ concurrency_limit`; on success inserts one 1-slot `repair` lease (`expires_at = store_clock() + repair_lease_bound_ms`) and increments `fires.made_calls += 1`; else refuses `concurrency`. It does **not** validate `fireId` against a live claim and does **not** enforce `maxRepairAttemptsPerArm` — the reservation already bought those attempts, and per-arm repair budgeting is the runner's responsibility.

### 4.3 `releaseLease` — idempotent, capacity-only, no budget lock

Sets `released_at = store_clock()` for the lease if unreleased; a second call is a no-op. Releasing changes only in-flight capacity; it never refunds a claim/call/spend reservation.

### 4.4 `completeClaim` — budget-lock-first, settle exactly once

Takes `cohort_budget … FOR UPDATE` first (lock order). **A `fireId` with no `fires` row is a no-op** (a crash before admit committed left nothing to settle). **Idempotent:** if the `fires` row is already `completed`, no-op (the settle never runs twice). Otherwise, atomically flip `fires.status` and this fire's claims to `completed`, and settle both counters — settle-down-only, exactly once:

- **Calls (store-verified floor):** `calls_reserved -= (fire.call_reserved − clamp(actualCalls, fire.made_calls, fire.call_reserved))`. The floor `fire.made_calls` is the **persisted** attempts-started count (not derived from lease rows, so GC cannot weaken it), never below it, never below zero. If `actualCalls` is omitted, settle calls down to `fire.made_calls`.
- **Spend (caller-trusted, floor of zero):** `spend_reserved -= (fire.spend_reserved − clamp(actualSpendUsdMicros, 0, fire.spend_reserved))`. The store cannot verify per-fire spend (§1.1), so its only floor is zero and the conservative pre-dispatch bound is the guarantee, not exact billing; a `made_calls` (attempt-count) floor is dimensionally meaningless for USD-micros and is deliberately **not** applied. If `actualSpendUsdMicros` is omitted, spend stays at the full reservation.

A crash before `completeClaim` performs no settle — the conservative reservation stays consumed.

### 4.5 Retained-scope projection (co-arrival partial claim, governing §3)

The caller computes the spend estimate and prepares the request bytes for its **proposed** scope, then calls `admitDispatch`. The store returns the **actually-claimed** scope, which may be smaller (a co-arrival key claimed by another fire is dropped). The caller then **synchronously re-projects** the request/bundle bytes for exactly the claimed scope before any dispatch (governing §3), and the over-reserved spend for the dropped keys is recovered by the completion **settle** (§4.4) — never a mid-flight refund. The **call/slot** reservation is per-dispatch (roster attempts) and is unchanged by a smaller scope. An already-claimed key receives **no** second provider forecast (case 24).

### 4.6 The capacity query is derived, not a counter

In-flight concurrency is always `SUM(1) WHERE released_at IS NULL AND expires_at > store_now()`, so a crashed, never-released lease self-heals at `expires_at` with no reclaim event and no counter to drift. Because every capacity-mutating path (`admitDispatch`, `acquireRepairLease`) holds the single budget-row lock before this read, the SUM a blocked operation reads always reflects all prior committed leases. This is the mechanism behind cases 45 and 46.

---

## 5. Idempotency

The `fireId` is a client-generated identifier for one dispatch attempt and the store's idempotency anchor.

- **`admitDispatch(fireId, …)` is idempotent per `fireId` — the check runs inside the budget-row lock (§4.1 step 2).** A retry after a lost response necessarily blocks behind the still-in-flight original on the `FOR UPDATE`; once the original commits, the retry sees the committed `fires` row and returns its recorded outcome, never a second reservation. (A pre-lock existence check may exist only as an optimization, never as the authoritative decision.)
- **Replay return is liveness-aware and resumable:** it reports the fire `status` (`pending`/`completed`), the `claimedKeys`, and the **per-arm** `initial` leases (`{leaseId, armIndex, state}`), so a lost-response retry learns the true claimed scope, can resume per-arm release (behavior 3), never treats a released/expired lease as live, and never re-dispatches a `completed` fire.
- **A same-`fireId` replay is valid when its `proposedKeys` is a superset of the recorded `claimedKeys`** — the co-arrival case: a lost-response retry re-sends the original proposal and learns from the returned `claimedKeys` which keys were dropped. It **fails loud** (`fire_id_key_mismatch`) only when a recorded claimed key is **absent** from the retry's proposal — a genuine reuse of the `fireId` for a different dispatch. (This resolves the prior open question.)
- **`acquireRepairLease`** is idempotent on `(cohortId, fireId, attemptIndex)`; **`releaseLease`** and **`completeClaim`** are idempotent by construction.
- A crash-and-restart that loses the `fireId` does not need idempotency: the claim rows already exist, so a re-detection's admit (new `fireId`) finds the keys claimed and refuses `all_claimed` — at-most-once is enforced by the claim PK independently of idempotency.

---

## 6. Integer call/spend accounting

- All accounting is **exact integer** arithmetic on safe integers. No floats in the ledger.
- **Call reservation per dispatch** is **store-derived**: `roster_size × (1 + max_repairs_per_arm)` — initial attempts plus maximum repairs, once per dispatch regardless of scoped-market count. The caller never supplies this magnitude (§1.1).
- **Spend reservation per dispatch** is the caller's conservative estimate `Σ_arm price(model, inputTokens, maxOutputTokens, toolPolicy) × (1 + maxRepairs)` in USD-micros from the manifest-pinned price table; **unknown pricing for any expected arm fails boot**. The store records it per fire and checks it against the cap; it cannot recompute it (per-fire input tokens), so the trust boundary of §1.1 applies.
- **Settle-down-only** (§4.4), only once (gated on the `pending`→`completed` transition): **calls** reduce toward the actual but never below the persisted `fire.made_calls` (the store-known attempts started) and never below zero; **spend** reduces toward the caller-reported actual with a floor of **zero** — the store cannot verify per-fire spend (§1.1), so an attempt-count floor is dimensionally meaningless and the conservative pre-dispatch bound is the guarantee. This keeps the cohort's paid surface bounded above by the reservations, across crashes.

The hard guarantees are the **call count**, the **token/output bounds**, and this **conservative estimate** — not exact external billing.

---

## 7. Store-time semantics and lease expiration

- **`store_now()` for the capacity filter is `transaction_timestamp()`** — stable within a reading transaction, so repeated capacity reads inside one transaction see one consistent instant and a lease cannot "expire mid-transaction." (It is a *different* instant from the `clock_timestamp()` that stamps `expires_at` below — deliberately: a freshly stamped lease's `expires_at` is always in the future of any reader's `transaction_timestamp()`, so it counts until it genuinely ages out.)
- **`expires_at` is stamped from `store_clock()` (`clock_timestamp()`) at the lease insert** — the *actual* acquire instant, which advances within the transaction. This matters because an admit may wait on the budget-row lock before inserting; anchoring `expires_at` to transaction start would shorten the lease by the lock-wait and could free an in-flight slot early. Stamping at the insert instant gives the lease its full pinned bound from acquisition.
- **Bounds (pinned, store-derived):** initial lease `maxDispatchLagMs + providerCallTimeoutMs + maxClockSkewMs`; repair lease `providerCallTimeoutMs + maxClockSkewMs`.
- **A lease is reclaimable only at/after `expires_at`** (the filter excludes it), by the store clock; no worker clock shortens or extends it. Expiry frees only in-flight capacity — never a claim/call/spend refund, never a fire retry.
- **Optional GC** may delete only **non-counting** rows (`released_at IS NOT NULL OR expires_at <= store_now()`); it must never prune a still-counting lease. Because the settle floor is the **persisted `fires.made_calls`** (not derived from lease rows, §4.4), GC is pure housekeeping and cannot weaken the floor — it may prune freely, including a `pending` (interrupted) fire's released/expired leases.
- **Testing note:** because `transaction_timestamp()` does not advance within a transaction, case 46 expiry cannot be exercised with a `pg_sleep` inside one transaction — the conformance slice must drive expiry **across** transactions.

---

## 8. Completion and crash behavior

| Point of failure | Fire/claim | Call/spend | Concurrency | Re-fire? |
|---|---|---|---|---|
| Crash **before** admit commits | none (txn rolled back) | none | none | key still clean; may be re-detected |
| Crash **after** admit, before requests | `pending` | **consumed** | leases held until `expires_at` | **no** (key claimed) |
| Crash **during** requests | `pending` | **consumed** | leases held until their `expires_at` | **no** |
| Crash **before** `completeClaim` | `pending` (interrupted) | **consumed** (no settle) | leases held/expiring | **no** |
| Clean completion | `completed` | consumed (settled once) | **no** active leases (all released) | **no** |

At-most-once holds at every point because the claim row exists the instant the admission commits and never returns to `unclaimed`. A crashed fire's capacity recovers purely by lease expiry; its budget stays consumed; the pair surfaces as an incomplete fire / miss in global coverage (§6), never a clean entry.

---

## 9. Typed refusal outcomes

```
AdmitResult =
  | { outcome: 'admitted'; fireId; claimedKeys; initialLeases: Lease[] }
  | { outcome: 'replayed'; fireId; claimedKeys; fireStatus: 'pending'|'completed'; initialLeases: Lease[] }
  | { outcome: 'refused'; reason: 'not_initialized' | 'version_mismatch'
                                  | 'all_claimed' | 'call_cap' | 'spend_cap' | 'concurrency' }
  | { outcome: 'error'; kind: 'fire_id_key_mismatch' }

Lease = { leaseId; armIndex; expiresAt; state: 'live'|'released'|'expired' }
```

`acquireRepairLease` returns `{ leaseId; expiresAt } | { refused: 'concurrency' | 'not_initialized' | 'version_mismatch' }`. The reasons are exhaustive and fail-closed: an unrecognized/uninitialized state never reads as `admitted`, and a refusal writes nothing.

---

## 10. The store interface (design)

The contract the durable-operations and conformance slices implement. Instants are offset-ISO strings from the **store**; counts are integers. Final field names are the operations slice's to settle; the shapes and guarantees are fixed here.

```ts
interface AtomicStore {
  /** Cohort boot: pin the caps AND the reservation constants under cohortId, INSERT-ONCE
   *  (ON CONFLICT DO NOTHING — never resets the reserved counters). The pinned values are
   *  invariant for a cohortId because cohortId hashes the manifest. */
  initCohortBudget(req: {
    cohortId: string; schemaVersion: number;
    callCap: number; spendCapUsdMicros: number; concurrencyLimit: number;
    rosterSize: number; maxRepairsPerArm: number;
    initialLeaseBoundMs: number; repairLeaseBoundMs: number;
  }): Promise<void>;

  /** Atomic at-most-once claim + call/spend reservation + one-slot-per-arm initial leases for
   *  the retained scope of one dispatch. Idempotent per fireId (inside the lock). The store
   *  DERIVES the call/slot/lease magnitudes from the pinned constants; only the per-fire spend
   *  estimate is caller-supplied (recorded + cap-checked, §1.1). */
  admitDispatch(req: {
    cohortId: string; fireId: string; expectedSchemaVersion: number;
    proposedKeys: ReadonlyArray<{ gameId: string; market: MarketKey }>;
    spendReservationUsdMicros: number;
  }): Promise<AdmitResult>;

  /** One fresh repair slot, same budget lock, idempotent per (fireId, armIndex, attemptIndex).
   *  armIndex is required so two arms' repairs cannot collide (§5 numbers attempts per arm). */
  acquireRepairLease(req: {
    cohortId: string; fireId: string; armIndex: number; attemptIndex: number; expectedSchemaVersion: number;
  }): Promise<{ leaseId: string; expiresAt: string }
            | { refused: 'concurrency' | 'not_initialized' | 'version_mismatch' }>;

  /** Idempotent release of one slot (the per-arm finally path). No budget lock. */
  releaseLease(leaseId: string): Promise<void>;

  /** Budget-lock-first, settle-once completion; settle floored at the store-known made-count. */
  completeClaim(req: {
    cohortId: string; fireId: string; actualCalls?: number; actualSpendUsdMicros?: number;
  }): Promise<void>;
}
```

There is deliberately **no** `reclaimExpiredLeases` in the correctness path — expiry is a filter in the capacity query (§4.6). Any GC is housekeeping only (§7).

---

## 11. Backend decision and feasibility

**Decision: Supabase/Postgres**, through a narrow transactional SQL/RPC surface. Reasons: Ospex already runs operationally on Supabase; one server-side transaction covers claim + budget + leases together; the **store's clock** governs lease expiry rather than worker clocks; and it survives a future host/deploy change without a second store migration. A local single-file store (e.g. SQLite) is rejected under invariant §1.8 unless Tier 0 commits to one durable host — and even then it would need real multiprocess transactions, not the in-process counters this document replaces.

**Feasibility (the operations slice's first gate is to run this against a scratch schema).** The whole admission is one Postgres function under `READ COMMITTED` with an explicit row lock — the lock on the single `cohort_budget` row serializes the budget race *and the idempotency check*, and the claim primary key serializes duplicate claims:

```sql
-- sketch, not final DDL; run against a scratch schema (concurrent sessions, pg_sleep-widened
-- windows, and a two-session same-fireId race) before writing production code
create function admit_dispatch(p_cohort text, p_fire text, p_ver int,
                               p_keys jsonb, p_spend_delta bigint)
returns jsonb language plpgsql as $$
declare v cohort_budget%rowtype; v_slots int; v_call_delta bigint; v_retained jsonb; v_inserted int;
begin
  -- 1. lock + existence + version, fail-closed
  select * into v from cohort_budget where cohort_id = p_cohort for update;
  if not found then return refused('not_initialized'); end if;             -- never fall through uncapped
  if v.schema_version <> p_ver then return refused('version_mismatch'); end if;
  -- 2. idempotency INSIDE the lock: a committed prior admission for this fire is visible now.
  --    replay_of compares p_keys to the recorded claimedKeys: valid when claimed ⊆ p_keys
  --    (co-arrival retry), else fire_id_key_mismatch; returns claimedKeys + per-arm initial leases + status
  if exists (select 1 from fires where cohort_id = p_cohort and fire_id = p_fire) then
    return replay_of(p_cohort, p_fire, p_keys);
  end if;
  -- 3. retain only keys claimed by NO OTHER fire (same-fire keys can't reach here after step 2)
  v_retained := (select jsonb_agg(k) from jsonb_array_elements(p_keys) k
                 where not exists (select 1 from claims c
                                   where c.cohort_id = p_cohort
                                     and c.game_id = k->>'gameId' and c.market = k->>'market'
                                     and c.fire_id <> p_fire));
  if v_retained is null then return refused('all_claimed'); end if;
  -- 4. store-derived call/slot magnitudes; spend is the recorded caller estimate
  v_call_delta := v.roster_size * (1 + v.max_repairs_per_arm);
  select coalesce(sum(1),0) into v_slots from concurrency_leases
    where cohort_id = p_cohort and released_at is null and expires_at > now();  -- now() = txn-stable
  -- 5. caps
  if v.calls_reserved + v_call_delta > v.call_cap                     then return refused('call_cap'); end if;
  if v.spend_reserved_usd_micros + p_spend_delta > v.spend_cap_usd_micros then return refused('spend_cap'); end if;
  if v_slots + v.roster_size > v.concurrency_limit                    then return refused('concurrency'); end if;
  -- 6. commit the whole admission; reservation/leases only on ≥1 ACTUAL claim insert
  with ins as (
    insert into claims (cohort_id, game_id, market, fire_id, status, claimed_at)
      select p_cohort, k->>'gameId', k->>'market', p_fire, 'pending', clock_timestamp()
      from jsonb_array_elements(v_retained) k
      on conflict (cohort_id, game_id, market) do nothing
      returning game_id, market)
  select count(*) into v_inserted from ins;
  if v_inserted = 0 then return refused('all_claimed'); end if;        -- phantom-reservation guard (defensive)
  insert into fires (cohort_id, fire_id, call_reserved, spend_reserved_usd_micros, made_calls, status, admitted_at)
    values (p_cohort, p_fire, v_call_delta, p_spend_delta, v.roster_size, 'pending', clock_timestamp());
  update cohort_budget set calls_reserved = calls_reserved + v_call_delta,
                           spend_reserved_usd_micros = spend_reserved_usd_micros + p_spend_delta
    where cohort_id = p_cohort;
  insert into concurrency_leases (lease_id, cohort_id, fire_id, arm_index, attempt_kind, acquired_at, expires_at)
    select gen_random_uuid()::text, p_cohort, p_fire, g.i - 1, 'initial', clock_timestamp(),
           clock_timestamp() + make_interval(secs => v.initial_lease_bound_ms / 1000.0)
    from generate_series(1, v.roster_size) as g(i);
  return admitted(p_cohort, p_fire);   -- actually-inserted keys + per-arm initial leases
end $$;
```

The `for update` on one row makes the budget/idempotency check-and-reserve serializable without a full serializable isolation level; a same-`fireId` retry blocks on it and observes the committed prior admission at step 2. `now()` (`transaction_timestamp()`) is the stable read clock for the expiry filter; `clock_timestamp()` stamps `expires_at`/`claimed_at` at the true insert instant (§7). `acquire_repair_lease` and `complete_claim` take the same `cohort_budget … for update` first. The operations slice must confirm all of this against a real scratch schema before production DDL.

---

## 12. Acceptance-case → slice map (§10)

| Case | Requirement | Durable-operations slice | Conformance slice |
|---|---|---|---|
| **8** | Duplicate claim workers overlap → only one paid dispatch | claim PK + `ON CONFLICT DO NOTHING` inside the atomic admit | two overlapping sessions, **different** fireIds, same key → exactly one `admitted`, one `pending` claim |
| **(new)** | Two concurrent admits, **same** `fireId`, overlapping keys | idempotency check **inside** the `FOR UPDATE` lock (§4.1 step 2) | the retry blocks on the lock, then returns the identical replay — exactly one reservation + one lease set |
| **25** | Two workers race the final budget slot → at most one reservation/dispatch | `FOR UPDATE` on the single `cohort_budget` row; check-then-reserve in one txn | two sessions race the last call/spend slot → exactly one `admitted`, the other `refused` |
| **45** | Dispatch completes, releases leases; a second acquires them; slots never exceed the cap | per-arm 1-slot leases; `releaseLease` sets `released_at`; capacity query excludes released/expired | saturate to the cap, release per-arm, re-acquire; assert `SUM(active unexpired) ≤ limit` throughout, incl. an admit-vs-repair-acquire race at the ceiling |
| **46** | Crash after claim/lease → not reclaimable before `expiresAt`, reclaimable after; claim/call/spend stay consumed; no redispatch | `expires_at > store_now()` filter; no settle on crash; claim stays `pending` | acquire + never release, driven **across** transactions; before `expiresAt` capacity held, after `expiresAt` free; claim still `pending`, budget still consumed, no re-admit |

Mocks may supplement these but **cannot substitute** for actual overlapping database transactions.

---

## 13. Acceptance matrix (frozen for the implementation slices)

1. `admitDispatch` is atomic: any refusal (`not_initialized`, `version_mismatch`, `all_claimed`, or a cap) writes **zero** fires/claims/lease/budget rows; budget + leases are written only on the ≥1-actual-insert path (no phantom reservation).
2. At-most-once: a key claimed by one fire is never claimed by another; concurrent claims of one key (different fireIds) yield exactly one `pending` claim (case 8).
3. **Idempotent admit, sequential AND concurrent:** a same-`fireId` retry — including two overlapping same-`fireId` admits, and a retry of a **partial co-arrival claim** (the retry re-sends the original superset proposal) — yields exactly one reservation + one lease set and returns the replay with the recorded `claimedKeys` + per-arm leases, never a second reservation and never a spurious `fire_id_key_mismatch` (§5; new case).
4. **Fail-closed on an uninitialized cohort:** admit/repair-acquire against a missing `cohort_budget` row refuse `not_initialized` and write nothing (never an uncapped, unserialized admission).
5. **`initCohortBudget` is insert-once:** a re-init on restart preserves `calls_reserved`/`spend_reserved` (never resets), and the pinned values are invariant for a `cohortId`.
6. Budget race: concurrent admits never over-reserve past `cohortCallCap`/`cohortSpendCapUsdMicros`; at most one wins the final slot (case 25).
7. **Store-derived magnitudes:** the call reservation is `roster × (1 + maxRepairs)` and the slot count is `roster`, computed from pinned values — a caller cannot under-reserve them (§1.1).
8. Concurrency ceiling: `SUM(active, unexpired 1-slot leases) ≤ maxConcurrentProviderRequests` at every instant, including an admit-vs-repair-acquire race (invariant §1.7; cases 45).
9. **Per-arm release:** each arm's `finally` releases exactly its own slot; a completed full-roster dispatch holds no active leases; a second dispatch acquires the freed slots (behavior 3; case 45).
10. **Store-time leases:** `expires_at` is stamped at the acquire instant and no lease decision depends on a worker clock; case 46 is driven across transactions (§7).
11. Crash-expiry + no-refund/no-redispatch: an unreleased lease holds capacity until `expires_at` and not less; after `expires_at` its capacity is reusable; the claim stays `pending`, call/spend stay consumed, no re-admit (case 46).
12. **Settle-once, floored:** `completeClaim` settles at most once (gated on `pending`→`completed`), never below the store-known made-count, never below zero; a retried complete does not double-subtract.
13. **Lock order / no deadlock:** admit, repair-acquire, and complete all take `cohort_budget FOR UPDATE` first; no admit/complete lock cycle exists.
14. **Store/schema-version mismatch** fails closed (`version_mismatch`) rather than silently reserving.
15. `fire_id_key_mismatch`: a same-`fireId` re-admit fails loud (writing nothing) **only** when a recorded claimed key is **absent** from the retry's `proposedKeys` — a genuine reuse for a different dispatch; a superset proposal is a valid replay (§5).
16. **Per-arm repair idempotency:** two arms' repairs never collide — the idempotency key carries `armIndex`, so each arm gets its own repair lease and the ceiling holds (§4.2).
17. **Spend settle floor is zero, not the attempt count:** `completeClaim` settles spend toward the caller actual with a floor of zero (caller-trusted, §1.1), while calls floor at the persisted `made_calls`; a missing `fires` row is a no-op (§4.4).

---

## 14. Out of scope / deferred

Not in this sub-arc: migrating the legacy per-game ledger; backfilling old runs; a generic distributed job queue; multi-region failover; live execution; provider-dashboard reconciliation; touching unrelated Ospex services; and the canonical runtime integration (a later slice that structurally depends on the conformance suite passing). `--live` stays hard-disabled until the full stack passes complete review; no paid cohort runs before global coverage lands.
