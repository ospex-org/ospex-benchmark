import { deepFreeze } from './freeze.js';
import type {
  AdmitDispatchRequest,
  AtomicStore,
  ClaimKey,
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
// Claim outcomes + ports
// ---------------------------------------------------------------------------

/**
 * A claim attempt's outcome. Only `Authorized` carries a permit (and its lease authority);
 * every other outcome authorizes zero dispatch and zero lease work. `WouldAdmit` is the
 * report-only rehearsal outcome — visibly non-canonical, never a permit.
 *
 * `Defer` / `Skip` are retained for later compatibility but are NOT produced here: this
 * slice maps a fresh admission and faults loud on everything else. Classifying replays and
 * refusals into terminal-vs-transient reactions is a later slice's contract.
 */
export type ClaimOutcome =
  | { readonly kind: 'Authorized'; readonly permit: DispatchPermit; readonly leaseAuthority: AdmissionLeaseAuthority }
  | { readonly kind: 'WouldAdmit' }
  | { readonly kind: 'Defer'; readonly reason: string }
  | { readonly kind: 'Skip'; readonly reason: string }
  | { readonly kind: 'Fault'; readonly reason: string };

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

  return { permit, leaseAuthority };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The store-backed claim port. It captures the request before the await, gates STRICTLY on
 * the `admitted` outcome AND its `dispatchAuthorized: true` literal (never the outcome name
 * alone), and mints only then.
 *
 * The failure path is TOTAL: a store rejection is caught without reading, coercing, or
 * formatting the thrown value — a hostile value whose `message` getter or `Symbol.toPrimitive`
 * throws would otherwise escape the fail-closed mapping as a raw error. The reason is a fixed
 * safe string.
 */
export class StoreClaimPort implements ClaimPort {
  constructor(private readonly store: AtomicStore) {}

  async admit(req: AdmitDispatchRequest): Promise<ClaimOutcome> {
    // Capture BEFORE the await; the caller's object is never read again.
    const captured = captureAdmitRequest(req);
    let result;
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
    } catch {
      // Do NOT format the thrown value (see above) — a fixed reason keeps the mapping total.
      return { kind: 'Fault', reason: 'store admitDispatch failed' };
    }
    // Read the discriminant ONCE; never coerce it into a message (the store's own value is
    // untrusted, and a hostile `toString` in a reason string would escape this mapping just
    // as a hostile raise would escape the catch above).
    const outcome: unknown = result.outcome;
    if (outcome === 'admitted' && result.dispatchAuthorized === true) {
      return { kind: 'Authorized', ...mintAdmission(this.store, captured, result) };
    }
    // Every replay, refusal, error result, and wire skew authorizes nothing. The terminal /
    // transient / replay-recovery reaction matrix is a later slice; here it is a loud fault.
    return { kind: 'Fault', reason: 'store admit did not authorize dispatch' };
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
