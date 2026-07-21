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

**Normative types.** The store's result unions, refusal taxonomies, request shapes, and operation signatures are defined once, normatively, in **`src/store/contract.ts`** (types only; `yarn typecheck`-enforced). This document narrates the state transitions and the transaction order and refers to the outcome/refusal **names** in context; it does **not** re-enumerate the union members. Where this prose and the typed contract could ever disagree, the typed contract governs.

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
- **Caller-computed, store-recorded + cap-checked:** the **spend reservation** — one deterministic fixed amount the trusted caller derives from authenticated boot state, not a token estimate. The manifest-pinned spend-reservation policy (`spendReservationPolicyVersion`) prices every possible provider HTTP attempt at `providerAttemptReservationUsdMicros`, and a fire reserves `roster × (1 + maxRepairs)` attempts. The store neither parses bundles nor counts tokens, so it **records the per-fire spend reservation** (for the settle) and checks it against the pinned `cohortSpendCapUsdMicros`. The caller is the single trusted in-process runner (base spec §6); the reservation is bounded above only by the cap and the conservative rules, which is the guarantee §4 actually promises (not exact billing).

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

### 2.4 Concurrency lease (one slot per row) — live, released, or crash-expiring

The lifecycle states below use the reported `LeaseState` vocabulary (`src/store/contract.ts`); `live` is the just-acquired, still-counting state.

```
live ──release (finally, per-arm, on response/timeout/abort/failure)──▶ released
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
  owner_id      text                -- acquiring worker/session identity (governing ConcurrencyLeaseV1.ownerId)
  arm_index     int                 -- which roster arm this slot backs (load-bearing for repair idempotency)
  attempt_kind  text                -- initial | repair
  repair_ordinal int null           -- per-arm repair ordinal ∈ [1, max_repairs_per_arm]
                                     --   (§5; canonical provenance attemptNumber = repair_ordinal + 1)
  acquired_at   timestamptz         -- store clock at insert (§7)
  expires_at    timestamptz         -- acquired_at + the pinned bound (§7)
  released_at   timestamptz null
  -- unique (cohort_id, fire_id, arm_index, attempt_kind, repair_ordinal) for PER-ARM repair idempotency
```

Rationale: the claim PK is at-most-once (case 8). The single `cohort_budget` row is the serialization point for the budget race (case 25) and every capacity check. The `fires` row makes the reservation recoverable for a correct settle and is the idempotency anchor. Leases are one-slot rows so per-arm release (behavior 3) is expressible and expiry is a time filter, not a counter that drifts across crashes (cases 45/46).

---

## 4. Transaction boundaries and the global lock order

**Global lock order (deadlock-free by construction):** every operation that touches `cohort_budget` acquires `SELECT … FROM cohort_budget WHERE cohort_id = ? FOR UPDATE` **first**, before any `fires` / `claims` / `concurrency_leases` write. `admitDispatch`, `acquireRepairLease`, and `completeClaim` all obey this single order, so no lock cycle can form. `releaseLease` touches only its own lease row and takes **no** budget lock (freeing capacity is conservative — a concurrent admit that has not yet observed the release merely under-admits, never over-admits).

**Input validation is fail-closed (every operation).** Every numeric input — reservation deltas, `actualCalls`/`actualSpend`, the pinned caps/bounds at boot, `armIndex`/`repairOrdinal`, and every checked sum/product — must be a **safe non-negative integer** (TypeScript `number` does not itself guarantee this). A negative, `NaN`, fractional, unsafe-magnitude, or null value is a **typed refusal writing nothing** (`invalid_input`), never a value that reaches the cap arithmetic — a naive upper-bound-only check would let a negative `spendΔ` pass the cap and *decrement* the reservation, freeing headroom (`cap 100 → admit −100 → admit +150` both accepted, stored 50). Market keys must be non-empty and one of the known markets. These RPC-level checks are backed by database `CHECK` constraints (non-negative counters, known markets/statuses, non-empty keys) and by exact `bigint` wire representation between TypeScript and Postgres (no float / unsafe-integer ambiguity), so the invariants hold even against a direct write.

### 4.1 `admitDispatch` — one transaction, all-or-nothing

1. **Version + existence, fail-closed.** `SELECT … FOR UPDATE` the cohort's budget row. **If no row is found, refuse `not_initialized` and write nothing** — a missing pinned row must never fall through to an uncapped, unserialized admission. If `schema_version` ≠ the client's pinned version, refuse `version_mismatch`.
2. **Idempotency, inside the lock.** With the budget row locked, check for an existing `fires` row for `fireId`. **If it exists, this is a replay of an admission that already committed in full** (the whole admission is one transaction — §5) — return the recorded `replayed` outcome, which **never** re-authorizes dispatch. It always carries the **`claimedKeys`** the fire owns and the fire status, and the two statuses differ in exactly one field: a **`pending`** fire additionally returns its **per-arm** `initial` leases (retained per §7, live/released/expired) so a still-live worker can resume per-arm release; a **`completed`** fire returns **no** leases, because completed-fire GC (§7) may already have pruned them. So a lost-response retry learns the true claimed scope (which co-arrival keys were dropped), can resume release while pending, and never re-arms a completed fire. A legitimate co-arrival retry re-sends the **original** proposal (the same `gameId` and `proposedMarkets`), whose derived proposed keys are a **superset** of the recorded `claimedKeys` (some keys were dropped) — so the replay is valid whenever `claimedKeys ⊆ proposedKeys`. **Fail loud** (`fire_id_key_mismatch`) **only** when a recorded claimed key is **absent** from the retry's proposed keys — a genuine reuse of the `fireId` for a different dispatch. Do nothing else.
3. **Recheck scope.** Retain the proposed keys **not already claimed by a different `fire_id`** (`claims.fire_id <> fireId`; after step 2 a same-fire key cannot reach here). A key claimed by another fire is dropped (co-arrival partial claim, §4 / case 24).
4. **Zero retained → refuse `all_claimed`**, write nothing.
5. **Derive the call/slot/lease reservations from pinned values** (not caller magnitudes, §1.1): `callΔ = roster_size × (1 + max_repairs_per_arm)`; `slotCount = roster_size`; the lease bounds from the pinned columns. The **spend** reservation `spendΔ` is looked up from the caller's `scopeReservations` table for the **retained** scope (§4.5), together with its `preparedBytesDigest`; a retained scope absent from the table refuses `scope_reservation_missing`.
6. **Check** all three caps: `calls_reserved + callΔ ≤ call_cap`, `spend_reserved + spendΔ ≤ spend_cap_usd_micros`, and `slotsInUse + slotCount ≤ concurrency_limit`, where `slotsInUse = SUM(1)` over this cohort's leases with `released_at IS NULL AND expires_at > store_now()`.
7. **If insufficient → refuse** with the binding reason (`call_cap` | `spend_cap` | `concurrency`), write nothing.
8. **If sufficient:** in the **same** transaction — insert `pending` claims for the retained keys (`ON CONFLICT (cohort_id, game_id, market) DO NOTHING`, capturing the **actual** inserted rows). **If zero rows were actually inserted**, refuse `all_claimed` and write nothing else (a defensive assertion: this transaction holds the budget-row lock, so no concurrent admit can commit a conflicting claim mid-transaction and this is unreachable under the lock order — but it guarantees the atomic-refusal invariant regardless). Otherwise: insert the `fires` row (`call_reserved = callΔ`, `spend_reserved = spendΔ`, `made_calls = slotCount`, `status = pending` — `made_calls` starts at the roster's initial attempts and each repair increments it); increment `calls_reserved += callΔ` and `spend_reserved += spendΔ`; insert `slotCount` one-slot `initial` lease rows (`arm_index` 0…roster−1, `owner_id`) with `expires_at = store_clock() + initial_lease_bound_ms`. Commit. Return `admitted` (`dispatchAuthorized: true`) with the actually-claimed keys, the retained scope's `preparedBytesDigest`, and the per-arm `initial` lease ids.

**Atomic refusal is the invariant:** any refusal (missing row, version, `all_claimed`, or a cap) writes **zero** `fires`/`claims`/`lease`/budget rows. Because budget and leases are written **only** on the ≥1-actual-insert path, no phantom reservation or phantom lease is possible.

### 4.2 `acquireRepairLease` — one slot, same lock, idempotency-FIRST

Takes the same `cohort_budget … FOR UPDATE` **first**. Its steps run in the order below so that the **durable-key idempotency lookup precedes every fresh-only check** — otherwise an exact same-key retry after the last permitted repair (when `made_calls == call_reserved`) would wrongly refuse `call_reserved_exhausted` instead of replaying. All refusals are typed and write nothing; a repair must never escape the reservation, because a *fresh* acquire authorizes one paid HTTP attempt (only `acquired` carries `requestAuthorized: true`; `replayed` and `refused` authorize zero).

1. **Validate + cohort state.** Validate the wire/domain shape (safe non-negative `armIndex`/`repairOrdinal`, etc. — else `invalid_input`); require an initialized cohort (`not_initialized`) and a matching `schema_version` (`version_mismatch`).
2. **Load the fire.** An **absent** `fires` row refuses `fire_not_pending`.
3. **Durable-key lookup, first.** Look up the exact durable repair key `(cohortId, fireId, armIndex, repairOrdinal)` (carried on the repair lease row).
4. **Existing key, owner matches → `replayed`.** Return the existing lease with its current state (`live`/`released`/`expired`) and `requestAuthorized: false`; run **no** fresh-only checks and **do not** increment `made_calls`. This holds whether the fire is still `pending` (a lost-response retry, including on a since-released or since-expired lease) or already `completed` **before** its permitted retention GC.
5. **Existing key, owner differs → `not_owner`**, authorizing zero calls.
6. **Missing key → the fresh-only checks** (reached only now): the fire is `pending` — an already-`completed` fire (including one whose repair key was already pruned by completed-fire GC) refuses `fire_not_pending`, which closes the repair-vs-`completeClaim` race in **both** orders since completion holds the same budget lock; `armIndex ∈ [0, roster_size)` else `invalid_arm`; `repairOrdinal` is the required **next fresh** per-arm ordinal within `[1, max_repairs_per_arm]` — a new key whose ordinal is not the next fresh one is `invalid_attempt`, and one past the cap is `repair_limit` (an **exact same-key retry never reaches this step**, so it is never `invalid_attempt`); a reserved attempt remains (`fire.made_calls < fire.call_reserved`) else `call_reserved_exhausted` (the hard guard against `made_calls > call_reserved`); capacity `slotsInUse + 1 ≤ concurrency_limit` else `concurrency`.
7. **Acquire.** Insert exactly one 1-slot `repair` lease (`expires_at = store_clock() + repair_lease_bound_ms`) — its `(cohortId, fireId, armIndex, repairOrdinal)` is the **durable idempotency anchor**, retained per §7 while the fire is replayable — increment `fires.made_calls += 1` **once**, and return `acquired` with `requestAuthorized: true`.

The idempotency key **must** carry `armIndex` (§5 numbers repairs per arm; a per-arm-only ordinal would collide two arms' repairs and hand one arm the other's lease). Completed-fire repair idempotency stops being replayable once that fire's permitted retention GC removes the key (§7) — after which the same-key retry falls to step 6 and refuses `fire_not_pending` — but **safety is unchanged**, because every non-`acquired` outcome authorizes zero calls.

### 4.3 `releaseLease` — idempotent, capacity-only, no budget lock

**Scoped to the lease's owner:** `releaseLease(leaseId, ownerId)` sets `released_at = store_clock()` only if the lease's `owner_id` matches (else a typed `not_owner` refusal — a worker may release only its own slots); a second call is a no-op. Releasing changes only in-flight capacity; it never refunds a claim/call/spend reservation, and it does not delete the row (the durable replay/idempotency record is retained per §7).

### 4.4 `completeClaim` — budget-lock-first, settle exactly once

Takes `cohort_budget … FOR UPDATE` first (lock order) and checks `expectedSchemaVersion` (else `version_mismatch`, no writes). **A `fireId` with no `fires` row is a no-op** (a crash before admit committed left nothing to settle). **Idempotent:** if the `fires` row is already `completed`, no-op (the settle never runs twice). Otherwise it **validates the reported actuals fail-closed**, distinguishing a *malformed* value from an *out-of-interval* one — the two conditions carry different, non-overlapping reasons:

- a supplied actual that is **null, fractional, unsafe, or negative** is a malformed wire value → `invalid_input`;
- a **well-typed, safe** actual that falls **outside the committed accounting interval** — `actualCalls < fire.made_calls`, `actualCalls > fire.call_reserved`, or `actualSpendUsdMicros > fire.spend_reserved` — fails LOUD → `invariant_breach`.

Both write nothing and leave the fire `pending`; an out-of-interval actual must **never** be silently clamped and the fire certified clean, because an actual above the reservation is a real accounting breach to surface, not hide. An **omitted** actual is *not* a null — it keeps the default settle (below). On valid actuals it atomically flips `fires.status` and this fire's claims to `completed`, and settles — settle-down-only, exactly once:

- **Calls:** `calls_reserved -= (fire.call_reserved − actualCalls)`. `fire.made_calls` (the persisted, GC-independent attempts-started count) is the floor an omitted `actualCalls` settles to.
- **Spend:** `spend_reserved -= (fire.spend_reserved − actualSpendUsdMicros)`. Omitted `actualSpendUsdMicros` leaves spend at the full reservation — the store cannot verify per-fire spend (§1.1), so a `made_calls` (attempt-count) floor is dimensionally meaningless for USD-micros and is deliberately not applied.

A crash before `completeClaim` performs no settle — the conservative reservation stays consumed.

### 4.5 Retained-scope projection (co-arrival partial claim, governing §3)

Because one game has at most three markets, its co-arrival group has at most **seven** nonempty scope subsets. The caller **precomputes, for every nonempty subset of the proposed markets, the immutable prepared request bytes and their conservative per-attempt spend estimate** (§6), and passes that `scope → ScopeReservation` table (the per-subset conservative spend + prepared-bytes digest, `src/store/contract.ts`) to `admitDispatch`. Inside the transaction, after the store determines the **actually-retained** scope (a co-arrival key claimed by another fire is dropped, case 24), it **selects the table entry for that exact retained subset**, returns its `preparedBytesDigest` — so the dispatched bytes are bound to the exact retained scope atomically inside the lock. A retained subset absent from the table fails closed (`scope_reservation_missing`). Under `fixed-attempt-v1` the reserved **spend is the same amount for every nonempty subset**, because the reservation prices provider-HTTP attempts (`roster × (1 + maxRepairs)`) and market count does not change the attempt count; the per-subset scope table and its exact `preparedBytesDigest` binding are **retained** regardless — do not delete them merely because spend is constant. The no-monotonicity rule is preserved for the prepared bytes and for any future per-subset pricing policy: the store never under-reserves if per-subset costs are non-monotone (no monotonicity assumption is needed). The **call/slot** reservation is per-dispatch (roster attempts) and is unchanged by a smaller scope. An already-claimed key receives **no** second provider forecast (case 24).

### 4.6 The capacity query is derived, not a counter

In-flight concurrency is always `SUM(1) WHERE released_at IS NULL AND expires_at > store_now()`, so a crashed, never-released lease self-heals at `expires_at` with no reclaim event and no counter to drift. Because every capacity-mutating path (`admitDispatch`, `acquireRepairLease`) holds the single budget-row lock before this read, the SUM a blocked operation reads always reflects all prior committed leases. This is the mechanism behind cases 45 and 46.

---

## 5. Idempotency

The `fireId` is a client-generated identifier for one dispatch attempt and the store's idempotency anchor.

- **`admitDispatch(fireId, …)` is idempotent per `fireId` — the check runs inside the budget-row lock (§4.1 step 2).** A retry after a lost response necessarily blocks behind the still-in-flight original on the `FOR UPDATE`; once the original commits, the retry sees the committed `fires` row and returns its recorded outcome, never a second reservation. (A pre-lock existence check may exist only as an optimization, never as the authoritative decision.)
- **A replay is informational, NEVER a fresh dispatch authorization.** Only a newly-committed admission (`outcome: 'admitted'`) authorizes launching the roster; a `replayed` outcome carries `dispatchAuthorized: false`. It reports the `fireStatus`, the `claimedKeys`, and — for a `pending` fire, whose lease rows are retained per §7 — the per-arm `initial` leases (each the normative `Lease` shape, `src/store/contract.ts`) so a still-live worker can resume **release** (behavior 3), but it never re-authorizes provider calls. This is the conservative choice: a `pending` row cannot distinguish a lost admission-response *before* any provider call from a crash *after* calls began, so letting a replay dispatch could double provider billing; forbidding it is safe and sacrifices only the rare lost-response-before-dispatch attempt (the same rule applies to a replayed repair lease). A `completed` fire's replay reports `fireStatus: 'completed'` + `claimedKeys` and is never re-armed. The idempotency + replay records survive GC (§7 prunes only non-replayable rows).
- **A same-`fireId` replay is valid when its `proposedKeys` is a superset of the recorded `claimedKeys`** — the co-arrival case: a lost-response retry re-sends the original proposal and learns from the returned `claimedKeys` which keys were dropped. It **fails loud** (`fire_id_key_mismatch`) only when a recorded claimed key is **absent** from the retry's proposal — a genuine reuse of the `fireId` for a different dispatch. (This resolves the prior open question.)
- **`acquireRepairLease`** is idempotent on `(cohortId, fireId, armIndex, repairOrdinal)` (the `armIndex` is required — §4.2), and its durable-key lookup precedes every fresh-only check so an exact same-key retry always `replayed`s (never a spurious `call_reserved_exhausted` / `invalid_attempt`); **`releaseLease`** and **`completeClaim`** are idempotent by construction.
- A crash-and-restart that loses the `fireId` does not need idempotency: the claim rows already exist, so a re-detection's admit (new `fireId`) finds the keys claimed and refuses `all_claimed` — at-most-once is enforced by the claim PK independently of idempotency.

---

## 6. Integer call/spend accounting

- All accounting is **exact integer** arithmetic on safe integers. No floats in the ledger.
- **Call reservation per dispatch** is **store-derived**: `roster_size × (1 + max_repairs_per_arm)` — initial attempts plus maximum repairs, once per dispatch regardless of scoped-market count. The caller never supplies this magnitude (§1.1).
- **Spend reservation per dispatch** is a deterministic fixed amount, **not** a token estimate. Each possible provider HTTP attempt reserves the manifest-pinned `providerAttemptReservationUsdMicros` (`spendReservationPolicyVersion`), so:

  ```
  callΔ  = roster_size × (1 + max_repairs_per_arm)
  spendΔ = callΔ × providerAttemptReservationUsdMicros
  ```

  computed with checked integer/`bigint` arithmetic (range-checked to a safe integer), the manifest amount validated against the code-owned policy value at boot. It is **not** exact external billing: if a usable per-fire actual is missing at completion the **full reservation remains consumed** (never a silent zero), and a reported or conservatively-derived actual **above** the reservation is an **invariant breach** (never clamped down). The store records the reservation per fire and checks it against the cap; it neither parses bundles nor counts tokens, so the §1.1 trust boundary applies.
- **Settle-down-only** (§4.4), only once (gated on the `pending`→`completed` transition): **calls** reduce toward the actual but never below the persisted `fire.made_calls` (the store-known attempts started) and never below zero; **spend** reduces toward the caller-reported actual with a floor of **zero** — the store cannot verify per-fire spend (§1.1), so an attempt-count floor is dimensionally meaningless and the conservative pre-dispatch bound is the guarantee. This keeps the cohort's paid surface bounded above by the reservations, across crashes.

The hard guarantees are the **call count**, the **token/output bounds**, and this **conservative estimate** — not exact external billing.

---

## 7. Store-time semantics and lease expiration

- **`store_now()` for the capacity filter is `transaction_timestamp()`** — stable within a reading transaction, so repeated capacity reads inside one transaction see one consistent instant and a lease cannot "expire mid-transaction." (It is a *different* instant from the `clock_timestamp()` that stamps `expires_at` below — deliberately: a freshly stamped lease's `expires_at` is always in the future of any reader's `transaction_timestamp()`, so it counts until it genuinely ages out.)
- **`expires_at` is stamped from `store_clock()` (`clock_timestamp()`) at the lease insert** — the *actual* acquire instant, which advances within the transaction. This matters because an admit may wait on the budget-row lock before inserting; anchoring `expires_at` to transaction start would shorten the lease by the lock-wait and could free an in-flight slot early. Stamping at the insert instant gives the lease its full pinned bound from acquisition.
- **Bounds (pinned, store-derived):** initial lease `maxDispatchLagMs + providerCallTimeoutMs + maxClockSkewMs`; repair lease `providerCallTimeoutMs + maxClockSkewMs`.
- **A lease is reclaimable only at/after `expires_at`** (the filter excludes it), by the store clock; no worker clock shortens or extends it. Expiry frees only in-flight capacity — never a claim/call/spend refund, never a fire retry.
- **Optional GC** may delete a lease row only when it is **non-counting AND no longer replayable**: `released_at IS NOT NULL OR expired`, **AND** its fire is `completed`, **AND** a retention window has passed. It must **never** prune a `pending` (or interrupted) fire's lease rows — those are the durable idempotency + replay anchor (a repair retry must stay idempotent, and a pending admission-replay must stay reconstructable). GC removing data that could change a future replay/idempotency outcome is forbidden. Because the settle floor is the persisted `fires.made_calls` (§4.4), GC never weakens the floor; and because the capacity SUM already excludes released/expired leases, retaining them costs only storage, not capacity.
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

The result and refusal unions are defined normatively in **`src/store/contract.ts`**; this section narrates their semantics rather than re-enumerating members (the compiler is the source of truth for the member lists).

- **`admitDispatch` → `AdmitResult`.** Exactly one of: `admitted` (the only outcome that authorizes launching the roster — `dispatchAuthorized: true`); `replayed` (informational, `dispatchAuthorized: false`, split by `fireStatus` into a `pending` variant that returns the per-arm initial leases and a `completed` variant that does not — §4.1 step 2); a `refused` carrying a single binding `reason`; or the fail-loud `error` `fire_id_key_mismatch`. Every refusal writes zero rows (§4.1).
- **`acquireRepairLease` → `RepairLeaseResult`.** Exactly one of: `acquired` (the only outcome that authorizes one paid HTTP attempt — `requestAuthorized: true`); `replayed` (an idempotent same-key retry, `requestAuthorized: false`); or `refused` with a single `reason` (`requestAuthorized: false`). The durable-key lookup precedes the fresh-only checks (§4.2).
- **`releaseLease` → `ReleaseResult`**, **`completeClaim` → `CompleteResult`**, and **`initCohortBudget` → `InitResult`** each return their success outcome or a `refused` carrying a single named `reason`. The `completeClaim` reasons are disjoint by construction — a malformed actual is `invalid_input`, a well-typed out-of-interval actual is `invariant_breach` (§4.4).

Every union is **fail-closed**: an unrecognized or uninitialized state never reads as an authorizing outcome, and a refusal writes nothing. Authorization literals live only on the two operations that gate a paid provider call: among `AdmitResult` and `RepairLeaseResult`, only an admit `admitted` and a repair `acquired` carry a `true` authorization literal, and **every** other variant — every replay, refusal, and the admit `error` — carries the explicit `false`. The non-authorizing operations (`initCohortBudget`, `releaseLease`, `completeClaim`) have no authorization flag at all.

---

## 10. The store interface (design)

The `AtomicStore` interface — its five operation signatures and their request/result types — is defined normatively in **`src/store/contract.ts`** (`yarn typecheck`-enforced). Instants are offset-ISO strings from the **store**; counts are integers. The guarantee each operation must satisfy:

- **`initCohortBudget`** — pin the caps AND the reservation constants under `cohortId`, insert-if-absent (never resets the reserved counters). On a pre-existing row it does **not** silently do-nothing: it compares every pinned value and returns `config_mismatch`/`version_mismatch` without mutation. The pins are invariant for a `cohortId` (which hashes the manifest), so a mismatch is corruption / a caller bug and must fail loud (§1.1).
- **`admitDispatch`** — the atomic at-most-once claim + call/spend reservation + one-slot-per-arm initial leases for the retained scope of one dispatch, idempotent per `fireId` inside the lock. The store **derives** the call/slot/lease magnitudes from the pinned constants; only the per-fire spend estimate is caller-supplied (recorded + cap-checked, §1.1). The single-game boundary (one `gameId` + its `proposedMarkets`) and the canonical, per-subset-unique `scopeReservations` map are **structural** in the request type (§4.5).
- **`acquireRepairLease`** — one fresh repair slot under the same budget lock, idempotency-first (§4.2): an existing durable key returns `replayed` (or `not_owner`); only a missing key runs the fresh-only checks (pending fire, valid arm, next `repairOrdinal`, repair limit, a remaining reserved attempt, capacity) before `acquired`.
- **`releaseLease`** — idempotent release of one slot, scoped to its owner (the per-arm `finally` path). No budget lock (§4.3).
- **`completeClaim`** — budget-lock-first, settle-once completion; schema-checked; fails loud on a well-typed out-of-interval actual (`invariant_breach`) and refuses a malformed one (`invalid_input`), never silently clamping (§4.4).

There is deliberately **no** `reclaimExpiredLeases` in the correctness path — expiry is a filter in the capacity query (§4.6). Any GC is housekeeping only (§7).

---

## 11. Backend decision and feasibility

**Decision: Supabase/Postgres**, through a narrow transactional SQL/RPC surface. Reasons: Ospex already runs operationally on Supabase; one server-side transaction covers claim + budget + leases together; the **store's clock** governs lease expiry rather than worker clocks; and it survives a future host/deploy change without a second store migration. A local single-file store (e.g. SQLite) is rejected under invariant §1.8 unless Tier 0 commits to one durable host — and even then it would need real multiprocess transactions, not the in-process counters this document replaces.

**Feasibility (the operations slice's first gate is to run this against a scratch schema).** The whole admission is one Postgres function under `READ COMMITTED` with an explicit row lock — the lock on the single `cohort_budget` row serializes the budget race *and the idempotency check*, and the claim primary key serializes duplicate claims:

```sql
-- sketch, not final DDL; run against a scratch schema (concurrent sessions, pg_sleep-widened
-- windows, and a two-session same-fireId race) before writing production code
create function admit_dispatch(p_cohort text, p_fire text, p_owner text, p_ver int,
                               p_game text, p_markets jsonb, p_scope_reservations jsonb)  -- single game; scope→{spend,bytesDigest} table
returns jsonb language plpgsql as $$
declare v cohort_budget%rowtype; v_slots int; v_call_delta bigint; v_spend_delta bigint;
        v_retained jsonb; v_inserted int;
begin
  -- 0. domain validation, fail-closed (a negative/unsafe spend must NOT reach the cap check)
  if not all_nonneg_safe_int(p_scope_reservations) then return refused('invalid_input'); end if;
  -- 1. lock + existence + version, fail-closed
  select * into v from cohort_budget where cohort_id = p_cohort for update;
  if not found then return refused('not_initialized'); end if;             -- never fall through uncapped
  if v.schema_version <> p_ver then return refused('version_mismatch'); end if;
  -- 2. idempotency INSIDE the lock: a committed prior admission for this fire is visible now.
  --    replay_of compares the proposed keys derived from p_game + p_markets to the recorded
  --    claimedKeys: valid when claimed ⊆ derived proposed keys (co-arrival retry), else
  --    fire_id_key_mismatch; a pending fire returns claimedKeys + per-arm initial leases + status,
  --    a completed fire returns claimedKeys + status (no leases)
  if exists (select 1 from fires where cohort_id = p_cohort and fire_id = p_fire) then
    return replay_of(p_cohort, p_fire, p_game, p_markets);
  end if;
  -- 3. retain only this game's markets claimed by NO OTHER fire (same-fire keys can't reach here after step 2)
  v_retained := (select jsonb_agg(m) from jsonb_array_elements_text(p_markets) m
                 where not exists (select 1 from claims c
                                   where c.cohort_id = p_cohort
                                     and c.game_id = p_game and c.market = m
                                     and c.fire_id <> p_fire));
  if v_retained is null then return refused('all_claimed'); end if;
  -- 4. store-derived call/slot magnitudes; spend = caller estimate for the EXACT retained scope (§4.5)
  v_call_delta := v.roster_size * (1 + v.max_repairs_per_arm);
  v_spend_delta := scope_reservation_for(p_scope_reservations, v_retained);
  if v_spend_delta is null then return refused('scope_reservation_missing'); end if;
  select coalesce(sum(1),0) into v_slots from concurrency_leases
    where cohort_id = p_cohort and released_at is null and expires_at > now();  -- now() = txn-stable
  -- 5. caps
  if v.calls_reserved + v_call_delta > v.call_cap                     then return refused('call_cap'); end if;
  if v.spend_reserved_usd_micros + v_spend_delta > v.spend_cap_usd_micros then return refused('spend_cap'); end if;
  if v_slots + v.roster_size > v.concurrency_limit                    then return refused('concurrency'); end if;
  -- 6. commit the whole admission; reservation/leases only on ≥1 ACTUAL claim insert
  with ins as (
    insert into claims (cohort_id, game_id, market, fire_id, status, claimed_at)
      select p_cohort, p_game, m, p_fire, 'pending', clock_timestamp()
      from jsonb_array_elements_text(v_retained) m
      on conflict (cohort_id, game_id, market) do nothing
      returning game_id, market)
  select count(*) into v_inserted from ins;
  if v_inserted = 0 then return refused('all_claimed'); end if;        -- phantom-reservation guard (defensive)
  insert into fires (cohort_id, fire_id, call_reserved, spend_reserved_usd_micros, made_calls, status, admitted_at)
    values (p_cohort, p_fire, v_call_delta, v_spend_delta, v.roster_size, 'pending', clock_timestamp());
  update cohort_budget set calls_reserved = calls_reserved + v_call_delta,
                           spend_reserved_usd_micros = spend_reserved_usd_micros + v_spend_delta
    where cohort_id = p_cohort;
  insert into concurrency_leases (lease_id, cohort_id, fire_id, owner_id, arm_index, attempt_kind, acquired_at, expires_at)
    select gen_random_uuid()::text, p_cohort, p_fire, p_owner, g.i - 1, 'initial', clock_timestamp(),
           clock_timestamp() + make_interval(secs => v.initial_lease_bound_ms / 1000.0)
    from generate_series(1, v.roster_size) as g(i);
  return admitted(p_cohort, p_fire);   -- actually-inserted keys + digest + per-arm initial leases
end $$;
```

The `for update` on one row makes the budget/idempotency check-and-reserve serializable without a full serializable isolation level; a same-`fireId` retry blocks on it and observes the committed prior admission at step 2. `now()` (`transaction_timestamp()`) is the stable read clock for the expiry filter; `clock_timestamp()` stamps `expires_at`/`claimed_at` at the true insert instant (§7). Every RPC also validates its integer inputs non-negative + safe (§4, `invalid_input`) — a negative/unsafe spend in the `p_scope_reservations` table is rejected *before* the cap check, so it can never decrement the reservation and free headroom. This sketch is **illustrative** — the normative outcome/refusal names are `src/store/contract.ts`, not re-enumerated here (the `refused(...)`/`admitted(...)`/`replay_of(...)` helpers stand in for them). `acquire_repair_lease` and `complete_claim` take the same `cohort_budget … for update` first, and `acquire_repair_lease` performs its **durable-key idempotency lookup before any fresh-only check** (§4.2). The operations slice must confirm all of this against a real scratch schema before production DDL.

### 11.1 RPC authority and permissions (fail-closed)

These functions can burn claims/budget, release capacity, or settle fires — and a Postgres function is executable by **any** role by default — so their authority is part of the contract. The durable-operations slice must:

- place the tables and functions in a **private/unexposed schema** (not the API-exposed one), and/or `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` on every function;
- `GRANT EXECUTE` only to the **dedicated runtime role** (the runner's service credential) — never `anon`/`authenticated`;
- choose `SECURITY INVOKER` vs a hardened `SECURITY DEFINER`, and for a `DEFINER` function pin a **safe explicit `search_path`** (Supabase requires this);
- **deny direct table DML** to the runtime role — all writes go through the atomic functions, so nothing bypasses the single-lock reservation;
- ship **migration assertions that verify the effective privileges** actually took, failing the migration otherwise.

The store credential is a service-only secret; these RPCs are never reachable from the public `anon`/`authenticated` roles.

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
3. **Idempotent admit, sequential AND concurrent:** a same-`fireId` retry — including two overlapping same-`fireId` admits, and a retry of a **partial co-arrival claim** (the retry re-sends the original superset proposal) — persists exactly one reservation + one lease set and returns the replay with the recorded `claimedKeys` (a still-`pending` fire additionally returns its per-arm initial leases so a live worker can resume release; a `completed` fire returns **no** leases — §4.1 step 2), never a second reservation and never a spurious `fire_id_key_mismatch` (§5; new case).
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
18. **Retained-scope spend binding:** the store reserves the spend for the EXACT retained subset from the scope table (§4.5); a partial claim whose proposed estimate exceeds the cap but whose retained subset fits is admitted; dispatched bytes/tokens/spend all match the retained scope; a retained subset absent from the table refuses `scope_reservation_missing`.
19. **Per-attempt pricing:** initial and repair attempts are priced separately; a repair's input bound includes the max prior response + scaffold; unknown pricing fails boot/admission (§6).
20. **Repair enforcement (idempotency-first):** the durable-key `(cohortId, fireId, armIndex, repairOrdinal)` lookup precedes the fresh-only checks — an **exact same-key retry `replayed`s** (authorizing zero calls, re-incrementing nothing) even after the last permitted repair (`made_calls == call_reserved`), never a spurious `call_reserved_exhausted`; an existing key held by another owner refuses `not_owner`. Only a **new** key runs the fresh-only checks: an absent/completed fire (`fire_not_pending`), an invalid arm (`invalid_arm`), a non-next-fresh ordinal (`invalid_attempt`), over the repair limit (`repair_limit`), no remaining reserved attempt (`call_reserved_exhausted`), or no capacity (`concurrency`) each refuses with zero writes. Only `acquired` authorizes one paid attempt; both repair-vs-complete race orders are safe; `made_calls` can never exceed `call_reserved` (§4.2).
21. **GC-durable idempotency + replay:** a repair retry after **release or expiry** (the durable key row is retained, §7) `replayed`s and re-authorizes nothing; once **permitted completed-fire GC** prunes that key, the same-key retry instead falls to the fresh-only checks and refuses `fire_not_pending` — still authorizing zero calls, so safety is unchanged (§4.2). A **pending** (or interrupted) fire's lease/repair keys are **never** pruned, so its admission-replay stays reconstructable after its leases expire; GC prunes only non-replayable (completed-fire, non-counting) rows (§7).
22. **Fail-closed accounting:** a negative/null/fractional/unsafe/overflow input refuses `invalid_input` and never decrements a reservation; a conflicting re-init refuses `config_mismatch` with no reset; `completeClaim` fails loud (`invariant_breach`) on an actual above the reservation or below `made_calls`, and schema-checks (§4, §4.4).
23. **Authorization + ownership + RPC authority:** only an admit `outcome: 'admitted'` (`dispatchAuthorized: true`) authorizes launching the roster, and only a repair `acquired` (`requestAuthorized: true`) authorizes one HTTP attempt — no other outcome does; leases carry `ownerId` and both `releaseLease` and the repair owner-check are owner-scoped (`not_owner`); the RPCs are revoked from public roles, granted only the runtime role, with migration privilege assertions (§5, §4.2, §4.3, §11.1).

---

## 14. Out of scope / deferred

Not in this sub-arc: migrating the legacy per-game ledger; backfilling old runs; a generic distributed job queue; multi-region failover; live execution; provider-dashboard reconciliation; touching unrelated Ospex services; and the canonical runtime integration (a later slice that structurally depends on the conformance suite passing). `--live` stays hard-disabled until the full stack passes complete review; no paid cohort runs before global coverage lands.
