/**
 * NORMATIVE type contract for the atomic claim + budget/concurrency + lease store
 * (docs/SPEC-atomic-store.md). THIS FILE — not the Markdown — is the single source
 * of truth for the store's result unions, refusal taxonomies, request shapes, and
 * operation signatures. The spec prose narrates the state transitions and the
 * transaction order; it does NOT re-declare these members. `yarn typecheck`
 * mechanically enforces the cross-section consistency that prose cannot.
 *
 * Types only: no implementation, no classes, no runtime `enum`/`const`, no runtime
 * imports, no adapter / SQL / provider / live wiring. The durable-operations slice
 * implements `AtomicStore` against Supabase/Postgres (SPEC §11); this file fixes the
 * shapes and guarantees that slice — and the conformance slice — must satisfy.
 *
 * `tsc` cannot prove transaction ordering, runtime numeric validation, or that the
 * prose matches this code. Those obligations are stated as JSDoc here and narrated
 * in the spec; they are enforced at implementation time (typecheck + a real Postgres
 * scratch schema), not by this file.
 */

import type { MarketKey } from '../types.js';

// ---------------------------------------------------------------------------
// Shared value shapes
// ---------------------------------------------------------------------------

/**
 * An at-most-once claim key: one market of one game (SPEC §2.2). The claim ledger's
 * primary key is `(cohortId, gameId, market)`, so a key claimed once is never
 * re-claimed.
 */
export interface ClaimKey {
  gameId: string;
  market: MarketKey;
}

/** The lifecycle state of a concurrency lease as reported to the caller (SPEC §2.4). */
export type LeaseState = 'live' | 'released' | 'expired';

/**
 * A concurrency-lease slot as reported back to the caller (SPEC §2.4, §9). Each lease
 * backs exactly one roster arm's in-flight HTTP attempt, so a per-arm `finally` can
 * release exactly its own slot. `expiresAt` is an offset-ISO instant from the STORE
 * clock — never a worker clock (§7); capacity excludes the lease once it has passed.
 */
export interface Lease {
  leaseId: string;
  /** Which roster arm (0…rosterSize−1) this slot backs. */
  armIndex: number;
  expiresAt: string;
  state: LeaseState;
}

/**
 * The canonical scope key for a retained set of markets: the markets in the fixed
 * canonical order (moneyline, spread, total) joined with '+'. It is exactly one of
 * the seven nonempty subsets of a full board. Keying the reservation table by this
 * type makes duplicate, non-canonically-ordered, unknown-market, and multi-game
 * scope entries UNREPRESENTABLE — the scope-table uniqueness the store requires,
 * enforced by the compiler rather than by runtime deduplication.
 */
export type ScopeKey =
  | 'moneyline'
  | 'spread'
  | 'total'
  | 'moneyline+spread'
  | 'moneyline+total'
  | 'spread+total'
  | 'moneyline+spread+total';

/**
 * The caller's conservative per-attempt spend estimate + immutable prepared-request
 * bytes digest for one exact scope (SPEC §4.5, §6). `spendReservationUsdMicros` must
 * be a safe non-negative integer; a malformed digest or an unsafe/negative spend is a
 * runtime `invalid_input` refusal writing nothing (§4).
 */
export interface ScopeReservation {
  spendReservationUsdMicros: number;
  preparedBytesDigest: string;
}

// ---------------------------------------------------------------------------
// initCohortBudget — pin the caps + constants once at cohort boot (SPEC §1.1)
// ---------------------------------------------------------------------------

export interface InitCohortBudgetRequest {
  cohortId: string;
  schemaVersion: number;
  callCap: number;
  spendCapUsdMicros: number;
  concurrencyLimit: number;
  rosterSize: number;
  maxRepairsPerArm: number;
  initialLeaseBoundMs: number;
  repairLeaseBoundMs: number;
}

/**
 * `config_mismatch`: a pre-existing row whose pinned values differ from the request —
 * corruption / inconsistent init / a caller bug, which fails loud with NO reset (the
 * pins are invariant for a `cohortId`, since it hashes the manifest, §1.1).
 * `version_mismatch`: the store schema version differs. `invalid_input`: a malformed,
 * negative, fractional, or unsafe pin.
 */
export type InitRefusalReason = 'config_mismatch' | 'version_mismatch' | 'invalid_input';

export type InitResult =
  | { outcome: 'initialized' }
  | { outcome: 'refused'; reason: InitRefusalReason };

// ---------------------------------------------------------------------------
// admitDispatch — atomic claim + call/spend reservation + per-arm initial leases
// ---------------------------------------------------------------------------

/**
 * One dispatch's atomic claim + reservation request. The single-game boundary is
 * STRUCTURAL: one `gameId` and its `proposedMarkets`, never an array of
 * `(gameId, market)` pairs — a multi-game request cannot be represented. Runtime
 * validation (durable-operations slice), before any arithmetic, additionally rejects
 * — each an `invalid_input` refusal writing nothing:
 *  - an empty `proposedMarkets`, or duplicate / unknown markets, or non-canonical
 *    market ordering;
 *  - a `scopeReservations` map that is not EXACTLY the nonempty subsets of
 *    `proposedMarkets` (a missing subset, or an extra subset outside `proposedMarkets`);
 *  - a malformed prepared-bytes digest, or a non-safe / negative spend value.
 */
export interface AdmitDispatchRequest {
  cohortId: string;
  fireId: string;
  ownerId: string;
  expectedSchemaVersion: number;
  gameId: string;
  /** This game's proposed markets — canonical order, no duplicates (runtime-checked). */
  proposedMarkets: readonly MarketKey[];
  /**
   * Exactly one reservation per nonempty subset of `proposedMarkets`, keyed by its
   * canonical `ScopeKey`. The store selects the entry for the ACTUALLY-RETAINED scope
   * inside the budget lock and reserves that (SPEC §4.5); a retained subset absent
   * from the map refuses `scope_reservation_missing`.
   */
  scopeReservations: Readonly<Partial<Record<ScopeKey, ScopeReservation>>>;
}

export type AdmitRefusalReason =
  | 'not_initialized'
  | 'version_mismatch'
  | 'invalid_input'
  | 'all_claimed'
  | 'scope_reservation_missing'
  | 'call_cap'
  | 'spend_cap'
  | 'concurrency';

/**
 * A newly-committed admission — the ONLY admit outcome that authorizes launching the
 * roster (`dispatchAuthorized: true`, SPEC §5). Carries the actually-claimed keys, the
 * retained scope's prepared-bytes digest, and one initial lease per roster arm.
 */
export interface AdmitAdmittedResult {
  outcome: 'admitted';
  claimedKeys: readonly ClaimKey[];
  preparedBytesDigest: string;
  initialLeases: readonly Lease[];
  dispatchAuthorized: true;
}

/**
 * An idempotent replay of an already-committed admission (SPEC §4.1 step 2, §5). It is
 * informational and NEVER authorizes dispatch. A `pending` fire's lease rows are
 * retained (§7), so the pending variant returns them so a still-live worker can resume
 * per-arm release; a `completed` fire's leases may already be GC-pruned, so the
 * completed variant carries NO leases — matching the §7 GC rule.
 */
export type AdmitReplayResult =
  | {
      outcome: 'replayed';
      fireStatus: 'pending';
      claimedKeys: readonly ClaimKey[];
      initialLeases: readonly Lease[];
      dispatchAuthorized: false;
    }
  | {
      outcome: 'replayed';
      fireStatus: 'completed';
      claimedKeys: readonly ClaimKey[];
      dispatchAuthorized: false;
    };

/** An atomic refusal (SPEC §4.1): writes zero fires / claims / lease / budget rows.
 *  Carries the explicit `false` authorization literal, mirroring `RepairLeaseResult`. */
export interface AdmitRefusedResult {
  outcome: 'refused';
  reason: AdmitRefusalReason;
  dispatchAuthorized: false;
}

/**
 * A fail-loud caller bug: the same `fireId` reused for a DIFFERENT dispatch — a
 * recorded claimed key is absent from the retry's proposal (SPEC §4.1 step 2, §5).
 * Modelled distinctly from a refusal (a refusal is a normal, expected outcome).
 */
export interface AdmitErrorResult {
  outcome: 'error';
  reason: 'fire_id_key_mismatch';
  dispatchAuthorized: false;
}

export type AdmitResult =
  | AdmitAdmittedResult
  | AdmitReplayResult
  | AdmitRefusedResult
  | AdmitErrorResult;

// ---------------------------------------------------------------------------
// acquireRepairLease — one fresh repair slot, same budget lock, idempotent
// ---------------------------------------------------------------------------

/**
 * A single fresh repair-attempt slot for one arm. `repairOrdinal` numbers repairs
 * per arm in `[1, maxRepairsPerArm]`; it maps to the canonical provenance numbering
 * `attemptNumber = repairOrdinal + 1` (the initial attempt is `attemptNumber` 1 —
 * see `attemptProvenance.ts`), so a repair's ordinal is never confused with the
 * overall attempt number. The durable idempotency key is
 * `(cohortId, fireId, armIndex, repairOrdinal)`; `armIndex` is required so two arms'
 * repairs cannot collide.
 */
export interface AcquireRepairLeaseRequest {
  cohortId: string;
  fireId: string;
  ownerId: string;
  armIndex: number;
  repairOrdinal: number;
  expectedSchemaVersion: number;
}

/**
 * The repair refusal taxonomy — one term per condition, no synonyms:
 *  - `not_initialized` / `version_mismatch`: cohort state;
 *  - `invalid_input`: a malformed / null / unsafe / out-of-domain argument;
 *  - `fire_not_pending`: an absent or already-`completed` fire (including a completed
 *    fire whose durable repair key has been pruned by permitted completed-fire GC);
 *  - `invalid_arm`: `armIndex` outside `[0, rosterSize)`;
 *  - `invalid_attempt`: a NEW (nonexistent) key whose ordinal is not the required next
 *    fresh ordinal — an exact same-key retry is NOT `invalid_attempt`, it replays;
 *  - `repair_limit`: the per-arm repair cap is already reached;
 *  - `call_reserved_exhausted`: no reserved attempt remains (`made_calls == call_reserved`);
 *  - `concurrency`: the lease ceiling would be exceeded;
 *  - `not_owner`: the existing durable key is held by a different owner.
 */
export type RepairRefusalReason =
  | 'not_initialized'
  | 'version_mismatch'
  | 'invalid_input'
  | 'fire_not_pending'
  | 'invalid_arm'
  | 'invalid_attempt'
  | 'repair_limit'
  | 'call_reserved_exhausted'
  | 'concurrency'
  | 'not_owner';

/**
 * Repair-lease result. The durable-key idempotency lookup runs BEFORE the fresh-only
 * checks (SPEC §4.2), so an exact same-key retry — even after the last permitted
 * repair, when `made_calls == call_reserved` — REPLAYS rather than wrongly refusing
 * `call_reserved_exhausted`. Only `acquired` authorizes one paid HTTP request; both
 * `replayed` and `refused` authorize zero (`requestAuthorized: false`). A `replayed`
 * result returns the existing lease with its current state (`live` / `released` /
 * `expired`) and re-increments nothing.
 */
export type RepairLeaseResult =
  | { outcome: 'acquired'; lease: Lease; requestAuthorized: true }
  | { outcome: 'replayed'; lease: Lease; requestAuthorized: false }
  | { outcome: 'refused'; reason: RepairRefusalReason; requestAuthorized: false };

// ---------------------------------------------------------------------------
// releaseLease — owner-scoped, capacity-only, no budget lock (SPEC §4.3)
// ---------------------------------------------------------------------------

export interface ReleaseLeaseRequest {
  leaseId: string;
  ownerId: string;
}

/**
 * Owner-scoped and idempotent (SPEC §4.3): a second release is a no-op. `not_owner`
 * refuses a release whose `ownerId` does not match the lease — a worker releases only
 * its own slots. Releasing frees only in-flight capacity; it never refunds a
 * claim / call / spend reservation and never permits a fire retry.
 */
export type ReleaseResult =
  | { outcome: 'released' }
  | { outcome: 'refused'; reason: 'not_owner' };

// ---------------------------------------------------------------------------
// completeClaim — budget-lock-first, settle exactly once (SPEC §4.4)
// ---------------------------------------------------------------------------

/**
 * Settle-once completion. An OMITTED actual keeps the default: calls settle to the
 * persisted `made_calls` floor, and spend stays at the full reservation (the store
 * cannot verify per-fire spend, §1.1). An omission is NOT a null — a present value
 * must be a safe non-negative integer, and an explicit null is `invalid_input`.
 */
export interface CompleteClaimRequest {
  cohortId: string;
  fireId: string;
  expectedSchemaVersion: number;
  /** Actual attempts started; omit to settle calls to the persisted `made_calls` floor. */
  actualCalls?: number;
  /** Actual spend; omit to leave spend at the full reservation. */
  actualSpendUsdMicros?: number;
}

/**
 * `invalid_input` and `invariant_breach` are DISJOINT: `invalid_input` is a malformed
 * / null / fractional / unsafe / negative actual; `invariant_breach` is a WELL-TYPED,
 * safe actual outside the committed accounting interval — `actualCalls < made_calls`,
 * `actualCalls > call_reserved`, or `actualSpendUsdMicros > spend_reserved` — which
 * fails LOUD and is never silently clamped (SPEC §4.4).
 */
export type CompleteRefusalReason = 'version_mismatch' | 'invariant_breach' | 'invalid_input';

/**
 * `completed` also covers the idempotent no-ops: an already-`completed` fire (the
 * settle never runs twice) and a `fireId` with no `fires` row (a crash before admit
 * committed left nothing to settle) — SPEC §4.4.
 */
export type CompleteResult =
  | { outcome: 'completed' }
  | { outcome: 'refused'; reason: CompleteRefusalReason };

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * The one durable, cross-process store (docs/SPEC-atomic-store.md). Every operation
 * that touches the budget takes `SELECT … FROM cohort_budget WHERE cohort_id = ? FOR
 * UPDATE` FIRST — the global lock order (SPEC §4) — so no lock cycle can form;
 * `releaseLease` alone takes no budget lock. The store DERIVES the call / slot / lease
 * magnitudes from cohort-boot-pinned constants (§1.1); only the per-fire spend estimate
 * is caller-supplied (recorded + cap-checked). There is exactly one store of record;
 * no in-memory or single-process fallback exists (§1.8).
 */
export interface AtomicStore {
  initCohortBudget(req: InitCohortBudgetRequest): Promise<InitResult>;
  admitDispatch(req: AdmitDispatchRequest): Promise<AdmitResult>;
  acquireRepairLease(req: AcquireRepairLeaseRequest): Promise<RepairLeaseResult>;
  releaseLease(req: ReleaseLeaseRequest): Promise<ReleaseResult>;
  completeClaim(req: CompleteClaimRequest): Promise<CompleteResult>;
}
