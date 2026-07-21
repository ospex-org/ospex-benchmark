import { deepFreeze } from './freeze.js';
import { StoreWireError } from './store/atomicStore.js';
import type {
  AdmitDispatchRequest,
  AdmitResult,
  AtomicStore,
  ClaimKey,
  CompleteResult,
  Lease,
  ReleaseResult,
  RepairLeaseResult,
  ScopeKey,
  ScopeReservation,
} from './store/contract.js';
import type { MarketKey } from './types.js';

/**
 * The admission-authority boundary between a durable claim and a paid dispatch
 * (SPEC-line-open-evidence-model.md §4/§5).
 *
 * A `DispatchPermit` is the unforgeable authorization to launch one fire's roster. It is
 * minted ONLY by a genuine store admission — the module-private mint below, reachable only
 * from `StoreClaimPort` on an `admitted` result carrying the `dispatchAuthorized: true`
 * literal — so a report-only rehearsal, which never admits, can never obtain one. The brand
 * is a module-private `WeakSet`, not a structural field: a cast, spread, or hand-built
 * object cannot forge it.
 *
 * Every request-derived field of a permit comes from the request this port CAPTURED before
 * the store await (never a later re-read of caller state), and every result-derived entry is
 * cloned out of the store's arrays, so neither a caller mutating its request across the await
 * nor the store mutating its own returned arrays afterwards can change an authorization.
 *
 * The permit carries the admitted `ownerId` and `expectedSchemaVersion`, and the same
 * admission also yields an opaque `AdmissionLeaseAuthority` that closes over the exact store
 * plus those captured values. Lease work — pre-dispatch cleanup here, and the attempt
 * lifecycle in a later slice — goes through that authority, so an owner or schema version can
 * never be substituted after admission by an independently supplied constructor argument.
 */

// ---------------------------------------------------------------------------
// The permit
// ---------------------------------------------------------------------------

export interface DispatchPermit {
  readonly cohortId: string;
  readonly fireId: string;
  /** The admitted owner identity; the sole owner for every later lease call. */
  readonly ownerId: string;
  /** The admitted store schema version; the sole version for every later lease call. */
  readonly expectedSchemaVersion: number;
  readonly gameId: string;
  /** The markets this dispatch PROPOSED, as captured from the admission request. */
  readonly proposedMarkets: readonly MarketKey[];
  /** Exactly the keys this dispatch claimed — the retained scope. */
  readonly claimedKeys: readonly ClaimKey[];
  /** The retained scope's prepared-bytes digest, echoed by the store. */
  readonly preparedBytesDigest: string;
  /** One initial lease per roster arm, keyed by manifest arm index. */
  readonly initialLeases: readonly Lease[];
}

const permits = new WeakSet<DispatchPermit>();

/** Throw unless `permit` was minted by a genuine store admission (forged or substituted). */
export function assertDispatchPermit(permit: DispatchPermit): void {
  if (!permits.has(permit)) {
    throw new Error('dispatch permit was not minted by a store admission (forged or substituted)');
  }
}

// ---------------------------------------------------------------------------
// The same-admission lease authority
// ---------------------------------------------------------------------------

/**
 * The opaque lease capability of ONE admission. It closes over the exact `AtomicStore` and
 * the captured `cohortId` / `fireId` / `ownerId` / `expectedSchemaVersion`, so a consumer
 * supplies only the lease id (or arm/ordinal) and CANNOT substitute a different owner,
 * schema version, or store. Minted together with the permit and carried with it.
 *
 * This slice uses `releaseLease` for pre-dispatch cleanup; the per-arm attempt lifecycle
 * (the initial/repair state machine driven at the HTTP boundary) is a later slice built on
 * top of this same authority.
 */
export interface AdmissionLeaseAuthority {
  releaseLease(leaseId: string): Promise<ReleaseResult>;
  acquireRepairLease(armIndex: number, repairOrdinal: number): Promise<RepairLeaseResult>;
}

const leaseAuthorities = new WeakSet<AdmissionLeaseAuthority>();
/** The authority minted WITH each permit — the pairing is what makes "same-admission" real. */
const authorityOfPermit = new WeakMap<DispatchPermit, AdmissionLeaseAuthority>();

/** Throw unless `authority` was minted by a genuine store admission. */
export function assertLeaseAuthority(authority: AdmissionLeaseAuthority): void {
  if (!leaseAuthorities.has(authority)) {
    throw new Error('lease authority was not minted by a store admission (forged or substituted)');
  }
}

/**
 * The authority minted WITH `permit` — the operational one, resolved from the permit itself
 * rather than taken from whatever a caller supplied alongside it.
 *
 * This is what makes "same-admission" mechanical. Both brands can be genuine separately, so
 * authenticating each alone is not enough: a caller-supplied `ClaimPort` could pair one
 * admission's permit with another's authority, and every later bind check reads only the
 * permit — the authority's closed-over owner/cohort/fire/schema is opaque and would never be
 * compared, so releases would be issued for THIS fire's leases under the OTHER fire's owner.
 * Resolving here means a consumer never has to trust the pairing it was handed, AND a crossed
 * pair is still cleanable: this permit's own leases can be released through this authority.
 */
export function leaseAuthorityForPermit(permit: DispatchPermit): AdmissionLeaseAuthority {
  assertDispatchPermit(permit);
  const authority = authorityOfPermit.get(permit);
  if (authority === undefined) {
    // Unreachable for a genuine permit — the mint records the pair before returning it.
    throw new Error('no lease authority is mapped to this permit');
  }
  return authority;
}

// ---------------------------------------------------------------------------
// The same-admission completion capability
// ---------------------------------------------------------------------------

/**
 * The opaque, SETTLE-ONLY completion capability of ONE admission. It closes over the exact
 * `AtomicStore` and the captured `cohortId` / `fireId` / `expectedSchemaVersion`, and its single
 * `complete()` settles this fire's claim through the durable store. It carries no owner and no
 * actuals: the settle omits both `actualCalls` — the store settles calls to its own persisted
 * attempts-started floor — and `actualSpendUsdMicros` — the fixed-attempt reservation is a
 * conservative administrative ceiling the store cannot resolve to exact provider spend — so the
 * request has exactly those three own keys.
 *
 * Minted together with the permit and paired to it privately, so a consumer resolves it from the
 * permit (`completionForPermit`) rather than trusting a supplied value. It is never carried on the
 * lease authority or the authorized dispatch, so the attempt lifecycle is not handed a way to settle a
 * fire before its evidence is durably installed. Holding the permit and calling the exported resolver
 * is a latent capability under the trusted single-process model (the same posture as
 * `leaseAuthorityForPermit`), not a structural impossibility.
 */
export interface ClaimCompletionCapability {
  complete(): Promise<CompleteResult>;
}

const completionCapabilities = new WeakSet<ClaimCompletionCapability>();
/** The completion capability minted WITH each permit — resolved from the permit, never supplied. */
const completionOfPermit = new WeakMap<DispatchPermit, ClaimCompletionCapability>();

/** Throw unless `capability` was minted by a genuine store admission (forged or substituted). */
export function assertClaimCompletionCapability(capability: ClaimCompletionCapability): void {
  if (!completionCapabilities.has(capability)) {
    throw new Error('claim completion capability was not minted by a store admission (forged or substituted)');
  }
}

/**
 * The completion capability minted WITH `permit` — resolved from the permit itself, never taken from a
 * caller-supplied value, exactly like `leaseAuthorityForPermit`. The permit brand is asserted first, so
 * a forged or substituted permit throws here (the assertion propagates) before any settle is attempted.
 */
export function completionForPermit(permit: DispatchPermit): ClaimCompletionCapability {
  assertDispatchPermit(permit);
  const capability = completionOfPermit.get(permit);
  if (capability === undefined) {
    // Unreachable for a genuine permit — the mint records the pairing before returning it.
    throw new Error('no completion capability is mapped to this permit');
  }
  return capability;
}

// ---------------------------------------------------------------------------
// Claim outcomes + ports
// ---------------------------------------------------------------------------

/**
 * A capacity refusal — the candidate stays clean and MAY be retried on a later tick, never
 * terminal: turning it into a permanent loss would burn a live speculation. A call/spend
 * reservation MAY settle downward as siblings complete, but an omitted actual spend keeps the
 * full reservation, so a spend refusal is not guaranteed to clear; deferral is bounded by the
 * clean-window / cutoff policy — the scheduler stops retrying once the candidate is no longer clean.
 */
export type DeferReason = 'call_cap' | 'spend_cap' | 'concurrency';

/**
 * A terminal-for-dispatch outcome for THIS candidate. It carries NO coverage verdict — whether
 * a verified artifact ultimately exists is derived globally elsewhere, not asserted here.
 */
export type SkipReason = 'all_claimed' | 'replayed_pending' | 'replayed_completed';

export type FaultReason =
  | 'not_initialized'
  | 'version_mismatch'
  | 'invalid_input'
  | 'scope_reservation_missing'
  | 'fire_id_key_mismatch'
  | 'admitted_without_authorization'
  | 'store_result_mismatch'
  | 'store_admit_failed';

/**
 * The opaque, RELEASE-ONLY cleanup capability for a pending-replay fire. It closes over the exact
 * `AtomicStore`, the captured `ownerId`, AND the exact set of the recovery's own initial lease ids, so
 * a consumer supplies only a lease id and CANNOT substitute a different owner or store — and CANNOT
 * release a lease outside its own recovery: a lease id not in the bound set is refused with a fixed
 * authority error BEFORE any store call (a genuine capability of one fire can never release another
 * fire's lease, even under a shared owner). It exposes release ONLY — never repair acquisition,
 * provider authorization, or a permit. This slice MINTS it but never invokes it; a later slice owns the
 * release decision (`not_owner` / expiry / interruption) and drives it.
 */
export interface ReplayReleaseCapability {
  releaseLease(leaseId: string): Promise<ReleaseResult>;
}

const replayReleaseCapabilities = new WeakSet<ReplayReleaseCapability>();

/** Throw unless `capability` was minted by a genuine pending-replay (forged or substituted). */
export function assertReplayReleaseCapability(capability: ReplayReleaseCapability): void {
  if (!replayReleaseCapabilities.has(capability)) {
    throw new Error('replay release capability was not minted by a store admission (forged or substituted)');
  }
}

/**
 * The detached recovery state a pending-replay Skip carries for a later slice to release. It is
 * SELF-IDENTIFYING (the captured `cohortId` / `fireId` / `ownerId` of the admission this recovery
 * belongs to), deeply frozen, WeakSet-BRANDED, and privately paired to its cleanup capability — so a
 * later consumer resolves the capability FROM the authenticated aggregate (`replayReleaseCapabilityForRecovery`)
 * rather than trusting a `recovery.cleanup` supplied alongside a free lease list. A structural/spread
 * copy or a `Proxy` wrapper is not branded and is rejected before any field is read.
 */
export interface ReplayPendingRecovery {
  readonly cohortId: string;
  readonly fireId: string;
  readonly ownerId: string;
  readonly claimedKeys: readonly ClaimKey[];
  readonly initialLeases: readonly Lease[];
  readonly cleanup: ReplayReleaseCapability;
}

const replayRecoveries = new WeakSet<ReplayPendingRecovery>();
/** The cleanup capability minted WITH each recovery — resolved from the recovery, never supplied. */
const capabilityOfRecovery = new WeakMap<ReplayPendingRecovery, ReplayReleaseCapability>();

/** Throw unless `recovery` was minted by a genuine pending-replay (forged, spread-copied, or proxied). */
export function assertReplayPendingRecovery(recovery: ReplayPendingRecovery): void {
  if (!replayRecoveries.has(recovery)) {
    throw new Error('replay pending recovery was not minted by a store admission (forged or substituted)');
  }
}

/**
 * The cleanup capability paired WITH `recovery` — resolved from the recovery itself after
 * authenticating the exact aggregate, never taken from a caller-supplied `recovery.cleanup`. The
 * aggregate brand is asserted FIRST (before any field read), so a forged/crossed recovery throws here
 * (the assertion propagates) before any release; a genuine recovery yields the capability bound to that
 * recovery's own leases.
 */
export function replayReleaseCapabilityForRecovery(recovery: ReplayPendingRecovery): ReplayReleaseCapability {
  assertReplayPendingRecovery(recovery);
  const capability = capabilityOfRecovery.get(recovery);
  if (capability === undefined) {
    // Unreachable for a genuine recovery — the mint records the pairing before returning it.
    throw new Error('no cleanup capability is mapped to this pending recovery');
  }
  return capability;
}

/**
 * A claim attempt's outcome. Only `Authorized` carries a permit (and its lease authority) and
 * authorizes paid dispatch; every other outcome authorizes zero dispatch. `WouldAdmit` is the
 * report-only rehearsal outcome — visibly non-canonical, never a permit. `Defer` is retryable
 * while the candidate is clean; `Skip` is terminal for THIS dispatch (with no coverage verdict);
 * `Fault` is a loud non-authorizing failure. The typed reason discriminates why, so a consumer
 * never parses prose. A `replayed_pending` Skip additionally carries detached recovery state.
 */
export type ClaimOutcome =
  | { readonly kind: 'Authorized'; readonly permit: DispatchPermit; readonly leaseAuthority: AdmissionLeaseAuthority }
  | { readonly kind: 'WouldAdmit' }
  | { readonly kind: 'Defer'; readonly reason: DeferReason }
  | { readonly kind: 'Skip'; readonly reason: 'all_claimed' }
  | { readonly kind: 'Skip'; readonly reason: 'replayed_completed'; readonly claimedKeys: readonly ClaimKey[] }
  | { readonly kind: 'Skip'; readonly reason: 'replayed_pending'; readonly recovery: ReplayPendingRecovery }
  | { readonly kind: 'Fault'; readonly reason: FaultReason };

/** The claim seam: admit one fire's dispatch, atomically, at most once. */
export interface ClaimPort {
  admit(req: AdmitDispatchRequest): Promise<ClaimOutcome>;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** The exact admission request captured before the store await — fresh plain data. */
export interface CapturedAdmitRequest {
  cohortId: string;
  fireId: string;
  ownerId: string;
  expectedSchemaVersion: number;
  gameId: string;
  proposedMarkets: MarketKey[];
  scopeReservations: Partial<Record<ScopeKey, ScopeReservation>>;
}

/**
 * Read every caller-owned request property EXACTLY ONCE into fresh plain data. A property
 * accessor can return a different value per read, so the captured value — not the caller's
 * object — is what is sent to the store, bound into the permit, and used for every later
 * lease call.
 */
export function captureAdmitRequest(req: AdmitDispatchRequest): CapturedAdmitRequest {
  const reservations: Partial<Record<ScopeKey, ScopeReservation>> = {};
  const source = req.scopeReservations;
  for (const key of Object.keys(source) as ScopeKey[]) {
    const entry = source[key];
    if (entry === undefined) continue;
    reservations[key] = {
      spendReservationUsdMicros: entry.spendReservationUsdMicros,
      preparedBytesDigest: entry.preparedBytesDigest,
    };
  }
  return {
    cohortId: req.cohortId,
    fireId: req.fireId,
    ownerId: req.ownerId,
    expectedSchemaVersion: req.expectedSchemaVersion,
    gameId: req.gameId,
    proposedMarkets: [...req.proposedMarkets],
    scopeReservations: reservations,
  };
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

/**
 * Mint an authenticated permit + its same-admission lease authority from a genuine
 * admission. Module-private: only `StoreClaimPort` can reach it, so no other path — least
 * of all a report-only rehearsal — can produce an authorization.
 *
 * Request-derived fields come from `captured`; result-derived entries are CLONED out of the
 * store's arrays; the whole permit graph is then recursively frozen, so neither a later
 * caller mutation nor a later store mutation can reach into an authorization.
 */
function mintAdmission(
  store: AtomicStore,
  captured: CapturedAdmitRequest,
  result: { claimedKeys: readonly ClaimKey[]; preparedBytesDigest: string; initialLeases: readonly Lease[] },
): { permit: DispatchPermit; leaseAuthority: AdmissionLeaseAuthority } {
  const permit: DispatchPermit = deepFreeze({
    cohortId: captured.cohortId,
    fireId: captured.fireId,
    ownerId: captured.ownerId,
    expectedSchemaVersion: captured.expectedSchemaVersion,
    gameId: captured.gameId,
    proposedMarkets: [...captured.proposedMarkets],
    claimedKeys: result.claimedKeys.map((k) => ({ gameId: k.gameId, market: k.market })),
    preparedBytesDigest: result.preparedBytesDigest,
    initialLeases: result.initialLeases.map((l) => ({
      leaseId: l.leaseId,
      armIndex: l.armIndex,
      expiresAt: l.expiresAt,
      state: l.state,
    })),
  });
  permits.add(permit);

  // The authority closes over the exact store + captured identity: a consumer passes only a
  // lease id / arm+ordinal and cannot substitute owner, schema version, cohort, fire, or store.
  const leaseAuthority: AdmissionLeaseAuthority = Object.freeze({
    releaseLease: (leaseId: string): Promise<ReleaseResult> =>
      store.releaseLease({ leaseId, ownerId: captured.ownerId }),
    acquireRepairLease: (armIndex: number, repairOrdinal: number): Promise<RepairLeaseResult> =>
      store.acquireRepairLease({
        cohortId: captured.cohortId,
        fireId: captured.fireId,
        ownerId: captured.ownerId,
        armIndex,
        repairOrdinal,
        expectedSchemaVersion: captured.expectedSchemaVersion,
      }),
  });
  leaseAuthorities.add(leaseAuthority);
  authorityOfPermit.set(permit, leaseAuthority); // the pairing this admission authorizes

  // The same-admission completion capability: settle-only, closed over the exact store + captured
  // identity, paired privately to the permit. Built here (the sole store×captured meeting point) but
  // NOT returned onto the authorized outcome — the spine resolves it from the permit after install.
  // The request has exactly three own keys; both actuals are omitted (never an explicit `undefined`).
  const completion: ClaimCompletionCapability = Object.freeze({
    complete: (): Promise<CompleteResult> =>
      store.completeClaim({
        cohortId: captured.cohortId,
        fireId: captured.fireId,
        expectedSchemaVersion: captured.expectedSchemaVersion,
      }),
  });
  completionCapabilities.add(completion);
  completionOfPermit.set(permit, completion);

  return { permit, leaseAuthority };
}

/**
 * Mint the detached recovery state for a pending-replay result. Order: clone the exact claimed keys and
 * initial leases (so a later store mutation of its own returned arrays cannot reach the outcome), build
 * the exact allowed lease-id Set from the cloned leases, build the RELEASE-ONLY capability closed over
 * the exact store + captured owner + that Set, build + deep-freeze the recovery with the captured
 * identity, then BRAND the recovery and privately PAIR it to its capability. This function NEVER invokes
 * a release — a later slice decides when a pending replay may be cleaned up. Every value comes from the
 * SAME `admitDispatch` result the caller already read.
 *
 * The capability is bound to the recovery's own lease ids: a lease id not in the set is refused with a
 * fixed authority error (the untrusted id is NEVER put in the message) before any store call, so a
 * genuine capability can never release another fire's lease under a shared owner.
 */
function mintReplayCleanup(
  store: AtomicStore,
  captured: CapturedAdmitRequest,
  result: { claimedKeys: readonly ClaimKey[]; initialLeases: readonly Lease[] },
): ReplayPendingRecovery {
  const claimedKeys = result.claimedKeys.map((k) => ({ gameId: k.gameId, market: k.market }));
  const initialLeases = result.initialLeases.map((l) => ({
    leaseId: l.leaseId,
    armIndex: l.armIndex,
    expiresAt: l.expiresAt,
    state: l.state,
  }));
  // The exact set of THIS recovery's own lease ids — unreachable to any consumer.
  const allowedLeaseIds = new Set(initialLeases.map((l) => l.leaseId));

  const cleanup: ReplayReleaseCapability = Object.freeze({
    releaseLease: (leaseId: string): Promise<ReleaseResult> => {
      if (!allowedLeaseIds.has(leaseId)) {
        // A lease outside this recovery — refuse before any store call. The untrusted id is not read
        // into the message; only this fire's own leases can be released through this capability.
        return Promise.reject(new Error('replay release capability was asked to release a lease outside its recovery'));
      }
      return store.releaseLease({ leaseId, ownerId: captured.ownerId });
    },
  });
  replayReleaseCapabilities.add(cleanup);

  const recovery: ReplayPendingRecovery = deepFreeze({
    cohortId: captured.cohortId,
    fireId: captured.fireId,
    ownerId: captured.ownerId,
    claimedKeys,
    initialLeases,
    cleanup,
  });
  replayRecoveries.add(recovery);
  capabilityOfRecovery.set(recovery, cleanup); // the pairing this admission authorizes
  return recovery;
}

/** Clone claimed keys out of a store result so a later store mutation cannot reach the outcome. */
function cloneClaimedKeys(keys: readonly ClaimKey[]): readonly ClaimKey[] {
  return deepFreeze(keys.map((k) => ({ gameId: k.gameId, market: k.market })));
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The store-backed claim port. It captures the request before the await, then classifies the
 * store's admit result into an EXHAUSTIVE, typed reaction:
 *  - `admitted` AND the `dispatchAuthorized: true` literal → `Authorized` (the sole paid gate is
 *    the conjunction, never the outcome name alone); `admitted` WITHOUT the literal → a loud
 *    `Fault` (a runtime-skew store never authorizes);
 *  - `replayed`/`pending` → a `Skip` carrying detached recovery state + a release-only cleanup
 *    capability (a later slice releases); `replayed`/`completed` → a `Skip` with detached keys;
 *  - a capacity refusal (`call_cap`/`spend_cap`/`concurrency`) → `Defer` (retryable while clean);
 *  - `all_claimed` → a terminal `Skip`; the loud refusals + `fire_id_key_mismatch` → `Fault`.
 * The nested `switch` is compiler-exhaustive over the outcome, replay status, and refusal reason
 * (a new store union member breaks the build); a value a cast or custom store slips past the
 * types still collapses to a fixed non-authorizing `Fault`.
 *
 * The failure path is TOTAL: a store rejection is classified WITHOUT reading, coercing, or
 * formatting the thrown value. A genuine `StoreWireError` re-throws by identity (a loud
 * contract-skew signal); everything else — ordinary errors, primitives, hostile getters or
 * coercers, `getPrototypeOf`-trapping proxies, and revoked proxies — collapses to a fixed safe
 * `Fault`. Because a plain `instanceof` itself THROWS for a revoked or prototype-trapping proxy,
 * the check is guarded so such a value can never escape.
 */
export class StoreClaimPort implements ClaimPort {
  constructor(private readonly store: AtomicStore) {}

  async admit(req: AdmitDispatchRequest): Promise<ClaimOutcome> {
    // Capture BEFORE the await; the caller's object is never read again.
    const captured = captureAdmitRequest(req);
    let result: AdmitResult;
    try {
      result = await this.store.admitDispatch({
        cohortId: captured.cohortId,
        fireId: captured.fireId,
        ownerId: captured.ownerId,
        expectedSchemaVersion: captured.expectedSchemaVersion,
        gameId: captured.gameId,
        proposedMarkets: captured.proposedMarkets,
        scopeReservations: captured.scopeReservations,
      });
    } catch (thrown) {
      // A plain `instanceof` walks the prototype chain, which a revoked or `getPrototypeOf`-
      // trapping proxy makes THROW — so guard it. A genuine wire skew re-throws by identity;
      // every other thrown value collapses to the fixed reason WITHOUT being read or formatted.
      let wire = false;
      try {
        wire = thrown instanceof StoreWireError;
      } catch {
        wire = false;
      }
      if (wire) throw thrown;
      return { kind: 'Fault', reason: 'store_admit_failed' };
    }
    return this.classify(captured, result);
  }

  /**
   * Exhaustively classify a genuine store result. The compile-time `never` at each nested
   * default makes a new outcome / replay status / refusal reason a BUILD error; the runtime
   * fault at each default fail-closes a value a cast or custom store slipped past the types.
   */
  private classify(captured: CapturedAdmitRequest, result: AdmitResult): ClaimOutcome {
    switch (result.outcome) {
      case 'admitted': {
        // The sole paid gate is the conjunction — the outcome AND the literal `true`. The type
        // annotation is erased at runtime, so compare by STRICT IDENTITY, never truthiness: a
        // skewed store returning a truthy non-boolean (`1`, `"true"`, `{}`, `[]`) must NOT
        // authorize a paid dispatch — only the boolean `true` does.
        if (result.dispatchAuthorized !== true) {
          return { kind: 'Fault', reason: 'admitted_without_authorization' };
        }
        return { kind: 'Authorized', ...mintAdmission(this.store, captured, result) };
      }
      case 'replayed':
        switch (result.fireStatus) {
          case 'pending':
            return {
              kind: 'Skip',
              reason: 'replayed_pending',
              recovery: mintReplayCleanup(this.store, captured, result),
            };
          case 'completed':
            return { kind: 'Skip', reason: 'replayed_completed', claimedKeys: cloneClaimedKeys(result.claimedKeys) };
          default: {
            const _exhaustiveReplay: never = result;
            void _exhaustiveReplay;
            return { kind: 'Fault', reason: 'store_result_mismatch' };
          }
        }
      case 'refused':
        switch (result.reason) {
          case 'call_cap':
          case 'spend_cap':
          case 'concurrency':
            return { kind: 'Defer', reason: result.reason };
          case 'all_claimed':
            return { kind: 'Skip', reason: 'all_claimed' };
          case 'not_initialized':
          case 'version_mismatch':
          case 'invalid_input':
          case 'scope_reservation_missing':
            return { kind: 'Fault', reason: result.reason };
          default: {
            const _exhaustiveRefusal: never = result;
            void _exhaustiveRefusal;
            return { kind: 'Fault', reason: 'store_result_mismatch' };
          }
        }
      case 'error':
        switch (result.reason) {
          case 'fire_id_key_mismatch':
            return { kind: 'Fault', reason: 'fire_id_key_mismatch' };
          default: {
            const _exhaustiveError: never = result;
            void _exhaustiveError;
            return { kind: 'Fault', reason: 'store_result_mismatch' };
          }
        }
      default: {
        const _exhaustiveOutcome: never = result;
        void _exhaustiveOutcome;
        return { kind: 'Fault', reason: 'store_result_mismatch' };
      }
    }
  }
}

/**
 * The report-only rehearsal claim port. It NEVER admits and NEVER mints a permit or lease
 * authority, so a rehearsal run is structurally incapable of authorizing a paid dispatch.
 */
export class RehearsalClaimPort implements ClaimPort {
  admit(_req: AdmitDispatchRequest): Promise<ClaimOutcome> {
    return Promise.resolve({ kind: 'WouldAdmit' });
  }
}
