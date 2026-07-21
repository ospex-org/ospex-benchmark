import { MARKET_ORDINAL } from './fireArtifact.js';
import { deepFreeze } from './freeze.js';
import { assertDispatchPermit, captureAdmitRequest, leaseAuthorityForPermit } from './lineOpenClaim.js';
import type { AdmissionLeaseAuthority, ClaimOutcome, ClaimPort, DispatchPermit } from './lineOpenClaim.js';
import { assertPreparedFireSnapshot, deriveFireId } from './preparedFire.js';
import type { PreparedFireSnapshot } from './preparedFire.js';
import type { AdmitDispatchRequest, ScopeKey } from './store/contract.js';
import type { ChatTurn, GameBundle, MarketKey, ProviderAdapter, ProviderCallOptions, ProviderResponse } from './types.js';

/**
 * The pre-dispatch authorization boundary (SPEC-line-open-evidence-model.md §4/§5): turn a
 * sealed `PreparedFireSnapshot` plus a roster of adapters into a branded `AuthorizedDispatch`
 * — or refuse, having released every admitted lease that will never back an HTTP call.
 *
 * The order is load-bearing. The complete adapter plan is built and frozen BEFORE the claim
 * is taken, so no durable claim is ever spent on a roster that cannot be dispatched, and no
 * adapter is re-read from a caller-owned `Map` afterwards (a `ReadonlyMap` is compile-time
 * only, and `Object.freeze(new Map())` does not prevent `set` / `delete`). The request is
 * likewise captured once and checked against the snapshot before admission, so a claim is
 * never taken for a request that disagrees with the evidence it claims to cover.
 *
 * After a genuine admission, every authorizing dimension is bound to the exact snapshot,
 * plan, and captured request before a single facade is handed on. Any disagreement — or a
 * retained scope narrower than the full proposal, which this non-activating path does not
 * support — refuses, releases every distinct admitted lease exactly once, and yields no
 * `AuthorizedDispatch`. Dispatch itself (the attempt lifecycle at the HTTP boundary) is a
 * later slice, which accepts only the branded value this module produces.
 *
 * No provider is contacted here, no artifact is produced or installed, and no claim is
 * completed.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DispatchRefusalReason =
  // pre-admission (no claim taken)
  | 'snapshot_fire_id_mismatch'
  | 'plan_missing_participant'
  | 'plan_unexpected_participant'
  | 'plan_identity_mismatch'
  | 'plan_method_not_callable'
  | 'plan_not_bound_to_snapshot'
  | 'request_cohort_mismatch'
  | 'request_fire_mismatch'
  | 'request_game_mismatch'
  | 'request_proposal_mismatch'
  | 'scope_reservation_missing'
  | 'scope_reservation_digest_mismatch'
  | 'prepared_scope_mismatch'
  // post-admission (claim taken; every admitted lease is released before refusing)
  | 'permit_cohort_mismatch'
  | 'permit_game_mismatch'
  | 'permit_proposal_mismatch'
  | 'permit_fire_id_mismatch'
  | 'permit_digest_mismatch'
  | 'permit_owner_mismatch'
  | 'permit_schema_mismatch'
  | 'lease_authority_mismatch'
  | 'claim_key_game_mismatch'
  | 'claim_key_duplicate'
  | 'claim_scope_mismatch'
  | 'retained_scope_not_supported'
  | 'lease_count_mismatch'
  | 'lease_arm_index_invalid'
  | 'lease_arm_index_duplicate'
  | 'lease_id_duplicate'
  | 'lease_not_live'
  | 'plan_roster_mismatch';

/** A typed pre-dispatch refusal: no adapter was called and no `AuthorizedDispatch` exists. */
export class DispatchAuthorizationError extends Error {
  readonly reason: DispatchRefusalReason;
  constructor(reason: DispatchRefusalReason, detail: string) {
    super(`dispatch not authorized (${reason}): ${detail}`);
    this.name = 'DispatchAuthorizationError';
    this.reason = reason;
  }
}

/** One lease-release attempt made while cleaning up an unstarted admission. */
export interface CleanupAttempt {
  readonly leaseId: string;
  /** `released` is the only success; `not_owner` is the store's refusal; `threw` is a raise. */
  readonly result: 'released' | 'not_owner' | 'threw';
}

/**
 * Cleanup could not release every admitted lease. It retains the ORIGINAL refusal (the
 * primary cause) plus the complete attempt log, so the operator sees both why the dispatch
 * was refused and which leases are still held.
 */
export class PreDispatchCleanupError extends Error {
  readonly primary: Error;
  readonly failures: readonly CleanupAttempt[];
  readonly attempts: readonly CleanupAttempt[];
  constructor(primary: Error, failures: readonly CleanupAttempt[], attempts: readonly CleanupAttempt[]) {
    // The message is built from OUR OWN counts and result codes only — never from a
    // store-supplied lease id, whose coercion could throw and destroy this typed error
    // (losing the primary cause and the failed-lease list exactly when they are needed).
    super(
      `pre-dispatch cleanup failed for ${failures.length} of ${attempts.length} lease(s) after ` +
        `${primary.name}: ${failures.map((f) => f.result).join(', ')}`,
    );
    this.name = 'PreDispatchCleanupError';
    this.primary = primary;
    this.failures = deepFreeze([...failures]);
    this.attempts = deepFreeze([...attempts]);
  }
}

// ---------------------------------------------------------------------------
// The dispatch plan
// ---------------------------------------------------------------------------

/**
 * One arm's captured dispatch capability: its authenticated identity plus the EXACT method
 * references bound at capture time. Rewriting the caller's adapter object (or its map entry)
 * afterwards cannot change what these call — the references are already held. They may close
 * over the adapter's own legitimate internal state; this is capture, not a sandbox.
 */
export interface ArmFacade {
  readonly participantId: string;
  readonly provider: string;
  readonly requestedModelId: string;
  readonly credentialEnvVar: string;
  readonly hasCredential: () => boolean;
  readonly chat: (turns: ChatTurn[], timeoutMs: number, options?: ProviderCallOptions) => Promise<ProviderResponse>;
}

/** The complete, ordered, immutable roster capture — built before any claim is taken. */
export interface DispatchPlan {
  /** One facade per expected arm, in authenticated roster order. */
  readonly arms: readonly ArmFacade[];
}

const plans = new WeakSet<DispatchPlan>();
/** The exact snapshot a plan was captured for — module-private, so the binding is unforgeable. */
const planSnapshot = new WeakMap<DispatchPlan, PreparedFireSnapshot>();

/** Throw unless `plan` was produced by `buildDispatchPlan`. */
export function assertDispatchPlan(plan: DispatchPlan): void {
  if (!plans.has(plan)) {
    throw new DispatchAuthorizationError('plan_not_bound_to_snapshot', 'plan was not produced by buildDispatchPlan');
  }
}

/**
 * Capture the complete roster→adapter relation for an authenticated snapshot. Requires
 * exactly the expected participant set (no missing, no unexpected), each adapter's identity
 * to equal the authenticated expectation, and both `hasCredential` and `chat` to be callable;
 * captures the bound method references once, in roster order, then freezes and brands the
 * plan and binds it to this exact snapshot.
 */
export function buildDispatchPlan(
  snapshot: PreparedFireSnapshot,
  adapters: ReadonlyMap<string, ProviderAdapter>,
): DispatchPlan {
  assertPreparedFireSnapshot(snapshot);
  const expected = snapshot.expectedArmIdentities;
  const expectedIds = new Set(expected.map((e) => e.participantId));
  for (const key of adapters.keys()) {
    if (!expectedIds.has(key)) {
      throw new DispatchAuthorizationError('plan_unexpected_participant', `adapter "${key}" is not an expected arm`);
    }
  }
  const arms: ArmFacade[] = expected.map((identity) => {
    const adapter = adapters.get(identity.participantId);
    if (adapter === undefined) {
      throw new DispatchAuthorizationError(
        'plan_missing_participant',
        `no adapter for expected arm "${identity.participantId}"`,
      );
    }
    // Read every adapter property EXACTLY ONCE, then validate and retain those locals. An
    // accessor can return a different value per read, so validating one read and capturing
    // another would let a per-read adapter pass this gate and dispatch something else.
    const provider: unknown = adapter.provider;
    const requestedModelId: unknown = adapter.requestedModelId;
    const credentialEnvVar: unknown = adapter.credentialEnvVar;
    const hasCredential: unknown = adapter.hasCredential;
    const chat: unknown = adapter.chat;
    if (provider !== identity.provider || requestedModelId !== identity.requestedModelId) {
      throw new DispatchAuthorizationError(
        'plan_identity_mismatch',
        `adapter "${identity.participantId}" does not match its authenticated provider/model identity`,
      );
    }
    if (typeof hasCredential !== 'function' || typeof chat !== 'function') {
      throw new DispatchAuthorizationError(
        'plan_method_not_callable',
        `adapter "${identity.participantId}" does not expose callable hasCredential/chat`,
      );
    }
    return {
      // Identity comes from the AUTHENTICATED roster, never from the adapter — the adapter's
      // values were only ever checked for equality against it.
      participantId: identity.participantId,
      provider: identity.provider,
      requestedModelId: identity.requestedModelId,
      credentialEnvVar: typeof credentialEnvVar === 'string' ? credentialEnvVar : '',
      // Bind the captured references NOW: a later rewrite of adapter.hasCredential /
      // adapter.chat, or a replacement of the map entry, cannot be observed.
      hasCredential: (hasCredential as () => boolean).bind(adapter),
      chat: (chat as ArmFacade['chat']).bind(adapter),
    };
  });
  const plan: DispatchPlan = Object.freeze({ arms: Object.freeze(arms.map((a) => Object.freeze(a))) });
  plans.add(plan);
  planSnapshot.set(plan, snapshot);
  return plan;
}

// ---------------------------------------------------------------------------
// The authorized dispatch
// ---------------------------------------------------------------------------

/**
 * The branded product of a complete pre-dispatch authorization: the exact permit, the exact
 * snapshot it authorizes, the immutable plan, and the same-admission lease authority the
 * attempt lifecycle must use. A later slice's canonical dispatch entry accepts only this
 * value — never a raw `{ permit, snapshot, plan }` tuple — so the gate below cannot be
 * skipped by a caller that assembles the pieces itself.
 */
export interface AuthorizedDispatch {
  readonly permit: DispatchPermit;
  readonly snapshot: PreparedFireSnapshot;
  readonly plan: DispatchPlan;
  readonly leaseAuthority: AdmissionLeaseAuthority;
}

const authorized = new WeakSet<AuthorizedDispatch>();

/** Throw unless `dispatch` was produced by `authorizePreparedDispatch`. */
export function assertAuthorizedDispatch(dispatch: AuthorizedDispatch): void {
  if (!authorized.has(dispatch)) {
    throw new DispatchAuthorizationError(
      'plan_not_bound_to_snapshot',
      'authorized dispatch was not produced by authorizePreparedDispatch (forged or substituted)',
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalMarkets(markets: readonly MarketKey[]): MarketKey[] {
  return [...markets].sort((a, b) => MARKET_ORDINAL[a] - MARKET_ORDINAL[b]);
}

/** Set equality, order-insensitive — for a relation whose order the STORE chooses. */
function sameMarkets(a: readonly MarketKey[], b: readonly MarketKey[]): boolean {
  const sa = canonicalMarkets(a);
  const sb = canonicalMarkets(b);
  return sa.length === sb.length && sa.every((m, i) => m === sb[i]);
}

/** Exact-sequence equality — for a proposal, which must already BE canonical. A
 *  non-canonically-ordered proposal is a caller/store defect, not a presentation detail. */
function sameSequence(a: readonly MarketKey[], b: readonly MarketKey[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

/**
 * The canonical reservation key for a market set (the store's `ScopeKey` grammar). Exported so
 * the composition spine keys its single full-scope reservation through the SAME canonical
 * sort/join the gate uses, rather than duplicating the canonicalization.
 */
export function scopeKeyOf(markets: readonly MarketKey[]): ScopeKey {
  return canonicalMarkets(markets).join('+') as ScopeKey;
}

/** The present-market scope of a request game, canonical order (`runLine` is `spread`). */
function presentScope(game: GameBundle): MarketKey[] {
  const scope: MarketKey[] = [];
  if (game.markets.moneyline != null) scope.push('moneyline');
  if (game.markets.runLine != null) scope.push('spread');
  if (game.markets.total != null) scope.push('total');
  return canonicalMarkets(scope);
}

function refuse(reason: DispatchRefusalReason, detail: string): never {
  throw new DispatchAuthorizationError(reason, detail);
}

/**
 * Release every DISTINCT admitted lease that will never back an HTTP call, through the
 * same-admission authority (so the owner cannot be substituted). One attempt per distinct
 * lease id; a throw or a `not_owner` refusal does not stop the remaining attempts, and only
 * `released` counts as clean.
 */
async function releaseAdmittedLeases(
  authority: AdmissionLeaseAuthority,
  leases: readonly { leaseId: string }[],
): Promise<{ attempts: CleanupAttempt[]; failures: CleanupAttempt[] }> {
  const attempts: CleanupAttempt[] = [];
  const failures: CleanupAttempt[] = [];
  const seen = new Set<string>();
  for (const lease of leases) {
    if (seen.has(lease.leaseId)) continue; // one real lease is never double-released
    seen.add(lease.leaseId);
    let attempt: CleanupAttempt;
    try {
      const result = await authority.releaseLease(lease.leaseId);
      attempt = { leaseId: lease.leaseId, result: result.outcome === 'released' ? 'released' : 'not_owner' };
    } catch {
      // Never format the thrown value — a hostile raise must not escape cleanup.
      attempt = { leaseId: lease.leaseId, result: 'threw' };
    }
    attempts.push(attempt);
    if (attempt.result !== 'released') failures.push(attempt);
  }
  return { attempts, failures };
}

/**
 * Refuse AFTER a genuine admission: release every distinct admitted lease, then propagate the
 * original refusal when cleanup was clean, or a typed cleanup error retaining that original
 * cause and the complete attempt log when it was not.
 */
async function refuseAfterAdmission(
  reason: DispatchRefusalReason,
  detail: string,
  permit: DispatchPermit,
  authority: AdmissionLeaseAuthority,
): Promise<never> {
  const primary = new DispatchAuthorizationError(reason, detail);
  const { attempts, failures } = await releaseAdmittedLeases(authority, permit.initialLeases);
  if (failures.length > 0) throw new PreDispatchCleanupError(primary, failures, attempts);
  throw primary;
}

// ---------------------------------------------------------------------------
// The authorization
// ---------------------------------------------------------------------------

export interface AuthorizePreparedDispatchInput {
  /** A genuine `sealPreparedFire` output — the sole evidence authority. */
  snapshot: PreparedFireSnapshot;
  /** The caller's adapters; captured into an immutable plan before any claim is taken. */
  adapters: ReadonlyMap<string, ProviderAdapter>;
  /**
   * An already-captured plan. Optional: when omitted the plan is built here (still before
   * the claim). When supplied it must be a genuine `buildDispatchPlan` output bound to THIS
   * exact snapshot — a forged or foreign plan is refused before any claim is taken, so a
   * caller that captured its own plan cannot smuggle a different roster past this gate.
   */
  plan?: DispatchPlan;
  /** The admission request; captured once and checked against the snapshot before admission. */
  request: AdmitDispatchRequest;
  claimPort: ClaimPort;
}

export type AuthorizePreparedDispatchResult =
  | { readonly kind: 'Authorized'; readonly dispatch: AuthorizedDispatch }
  /** The claim did not authorize a paid dispatch — a rehearsal, a capacity `Defer` (retryable
   *  while clean), a terminal `Skip`, or a `Fault`. This wrapper dispatches nothing and holds no
   *  lease of its own; a pending-replay `Skip` carries its own detached release-only recovery
   *  capability, which a later slice decides whether to invoke. */
  | { readonly kind: 'NotAdmitted'; readonly outcome: Exclude<ClaimOutcome, { kind: 'Authorized' }> };

/**
 * Authorize one prepared fire for dispatch. Throws `DispatchAuthorizationError` for every
 * authority violation (and `PreDispatchCleanupError` when a post-admission refusal could not
 * release every admitted lease); returns `NotAdmitted` when the claim itself did not
 * authorize. No adapter is ever called from here.
 */
export async function authorizePreparedDispatch(
  input: AuthorizePreparedDispatchInput,
): Promise<AuthorizePreparedDispatchResult> {
  const { snapshot, adapters, claimPort } = input;

  // (1) Authenticate the evidence authority before reading any of its fields.
  assertPreparedFireSnapshot(snapshot);

  // (2) The complete plan is captured BEFORE the claim — a claim is never spent on a roster
  //     that cannot be dispatched, and no adapter is re-read after admission. A supplied plan
  //     must itself be genuine (the assert below); its snapshot binding is checked in (3).
  let plan: DispatchPlan;
  if (input.plan === undefined) {
    plan = buildDispatchPlan(snapshot, adapters);
  } else {
    plan = input.plan;
    assertDispatchPlan(plan);
  }

  // (3) Capture the request once, then check it against the snapshot. Reading the caller's
  //     request exactly once means the values checked here are the values admitted.
  const request = captureAdmitRequest(input.request);

  const recomputedFireId = deriveFireId({
    cohortId: snapshot.booted.cohortId,
    gameId: snapshot.prepared.gameId,
    proposedMarkets: snapshot.proposedMarkets,
    detectedAt: snapshot.detectedAt,
    preparedSnapshotDigest: snapshot.preparedSnapshotDigest,
  });
  if (recomputedFireId !== snapshot.fireId) {
    refuse('snapshot_fire_id_mismatch', 'the snapshot fire id does not recompute from its own operands');
  }
  if (planSnapshot.get(plan) !== snapshot) {
    refuse('plan_not_bound_to_snapshot', 'the dispatch plan was captured for a different snapshot');
  }
  if (request.cohortId !== snapshot.booted.cohortId) {
    refuse('request_cohort_mismatch', `request cohort ${request.cohortId} != snapshot ${snapshot.booted.cohortId}`);
  }
  if (request.fireId !== snapshot.fireId) {
    refuse('request_fire_mismatch', `request fire ${request.fireId} != snapshot ${snapshot.fireId}`);
  }
  if (request.gameId !== snapshot.prepared.gameId) {
    refuse('request_game_mismatch', `request game ${request.gameId} != snapshot ${snapshot.prepared.gameId}`);
  }
  if (!sameSequence(request.proposedMarkets, snapshot.proposedMarkets)) {
    refuse('request_proposal_mismatch', 'request proposed markets != the canonical snapshot proposal');
  }
  // The consumed S1 guarantee, re-checked rather than redefined.
  if (!sameMarkets(presentScope(snapshot.prepared.game), snapshot.proposedMarkets)) {
    refuse('prepared_scope_mismatch', 'the prepared request scope != the snapshot proposal');
  }
  // The full-scope reservation this non-activating path fires under must carry the exact
  // prepared request bytes. (Its spend estimate is priced by its own owner, not here.)
  const fullScopeKey = scopeKeyOf(snapshot.proposedMarkets);
  const reservation = request.scopeReservations[fullScopeKey];
  if (reservation === undefined) {
    refuse('scope_reservation_missing', `no scope reservation for the full scope "${fullScopeKey}"`);
  }
  if (reservation.preparedBytesDigest !== snapshot.prepared.requestSha256) {
    refuse('scope_reservation_digest_mismatch', 'the full-scope reservation digest != the prepared request digest');
  }

  // (4) Take the claim. Only a genuine admission yields a permit + lease authority.
  const outcome = await claimPort.admit(request);
  if (outcome.kind !== 'Authorized') {
    // A non-authorized outcome is forwarded intact — it carries its own typed reason, and a
    // pending replay carries detached keys/leases + a release-only recovery capability for a later
    // slice. This dispatch boundary itself releases nothing and dispatches nothing.
    return { kind: 'NotAdmitted', outcome };
  }
  const permit = outcome.permit;
  const suppliedAuthority: AdmissionLeaseAuthority | undefined = outcome.leaseAuthority;

  // (5) Bind every authorizing dimension to the exact snapshot / plan / captured request.
  //     From here every refusal first releases the admitted leases.
  //
  //     The PERMIT is the authority anchor: the operational lease authority is resolved from
  //     the permit's own mint, never taken from what the claim outcome supplied. So a supplied
  //     authority is only ever COMPARED — a missing, forged, or crossed one is a typed refusal
  //     and is never called — while this permit's leases stay cleanable through their own
  //     authority. Trusting the supplied value instead would either release this fire's leases
  //     under another admission's owner, or (refusing without cleanup) leak them to expiry.
  assertDispatchPermit(permit);
  const leaseAuthority = leaseAuthorityForPermit(permit);
  if (suppliedAuthority !== leaseAuthority) {
    return refuseAfterAdmission(
      'lease_authority_mismatch',
      'the supplied lease authority is not the one minted with this permit',
      permit,
      leaseAuthority,
    );
  }

  if (permit.cohortId !== snapshot.booted.cohortId) {
    return refuseAfterAdmission('permit_cohort_mismatch', 'permit cohort != snapshot cohort', permit, leaseAuthority);
  }
  if (permit.gameId !== snapshot.prepared.gameId) {
    return refuseAfterAdmission('permit_game_mismatch', 'permit game != snapshot game', permit, leaseAuthority);
  }
  if (permit.fireId !== snapshot.fireId || permit.fireId !== recomputedFireId) {
    return refuseAfterAdmission('permit_fire_id_mismatch', 'permit fire id != the recomputed snapshot fire id', permit, leaseAuthority);
  }
  if (!sameSequence(permit.proposedMarkets, snapshot.proposedMarkets)) {
    return refuseAfterAdmission('permit_proposal_mismatch', 'permit proposal != the canonical snapshot proposal', permit, leaseAuthority);
  }
  if (permit.preparedBytesDigest !== snapshot.prepared.requestSha256) {
    return refuseAfterAdmission('permit_digest_mismatch', 'permit digest != the prepared request digest', permit, leaseAuthority);
  }
  // The admitted owner/schema are the only values any later lease call may use.
  if (permit.ownerId !== request.ownerId) {
    return refuseAfterAdmission('permit_owner_mismatch', 'permit owner != the captured admission owner', permit, leaseAuthority);
  }
  if (permit.expectedSchemaVersion !== request.expectedSchemaVersion) {
    return refuseAfterAdmission('permit_schema_mismatch', 'permit schema version != the captured admission version', permit, leaseAuthority);
  }

  // Claimed keys: each bound to this game, each tuple unique. Detail strings are built from
  // OUR OWN positions — never by coercing a store-supplied value, whose `toString` could throw
  // and escape as a raw error before the refusal (and its lease cleanup) ever ran.
  const claimedMarketSet = new Set<unknown>();
  for (const [i, key] of permit.claimedKeys.entries()) {
    if (key.gameId !== permit.gameId) {
      return refuseAfterAdmission('claim_key_game_mismatch', `claimed key at position ${i} is not bound to the permit game`, permit, leaseAuthority);
    }
    // gameId is now proven identical for every key, so tuple uniqueness reduces to market
    // uniqueness — compared by value in a Set, never by building a coerced string key.
    if (claimedMarketSet.has(key.market)) {
      return refuseAfterAdmission('claim_key_duplicate', `claimed key at position ${i} repeats an earlier market`, permit, leaseAuthority);
    }
    claimedMarketSet.add(key.market);
  }
  // Full-claim only: the retained scope must equal the proposal (and the prepared scope). A
  // strict subset is a typed refusal — the per-subset projection is a later slice.
  const claimedMarkets = permit.claimedKeys.map((k) => k.market);
  if (!sameMarkets(claimedMarkets, snapshot.proposedMarkets)) {
    const proposed = new Set<MarketKey>(snapshot.proposedMarkets);
    const isStrictSubset = claimedMarkets.length < proposed.size && claimedMarkets.every((m) => proposed.has(m));
    return isStrictSubset
      ? refuseAfterAdmission('retained_scope_not_supported', `the retained scope (${claimedMarkets.length} of ${proposed.size} markets) is narrower than the proposal`, permit, leaseAuthority)
      : refuseAfterAdmission('claim_scope_mismatch', 'claimed markets != the proposed / prepared scope', permit, leaseAuthority);
  }

  // Initial leases: one per expected arm, a unique live bijection over [0, rosterSize), with
  // globally unique lease ids.
  const rosterSize = snapshot.expectedArmIdentities.length;
  if (permit.initialLeases.length !== rosterSize) {
    return refuseAfterAdmission('lease_count_mismatch', `${permit.initialLeases.length} initial leases != roster ${rosterSize}`, permit, leaseAuthority);
  }
  const seenArmIndexes = new Set<number>();
  const seenLeaseIds = new Set<unknown>();
  for (const [i, lease] of permit.initialLeases.entries()) {
    if (!Number.isInteger(lease.armIndex) || lease.armIndex < 0 || lease.armIndex >= rosterSize) {
      return refuseAfterAdmission('lease_arm_index_invalid', `initial lease at position ${i} has an arm index outside [0, ${rosterSize})`, permit, leaseAuthority);
    }
    if (seenArmIndexes.has(lease.armIndex)) {
      return refuseAfterAdmission('lease_arm_index_duplicate', `initial lease at position ${i} repeats an earlier arm index`, permit, leaseAuthority);
    }
    seenArmIndexes.add(lease.armIndex);
    if (seenLeaseIds.has(lease.leaseId)) {
      return refuseAfterAdmission('lease_id_duplicate', `initial lease at position ${i} repeats an earlier lease id`, permit, leaseAuthority);
    }
    seenLeaseIds.add(lease.leaseId);
    if (lease.state !== 'live') {
      return refuseAfterAdmission('lease_not_live', `initial lease at position ${i} is not live`, permit, leaseAuthority);
    }
  }

  // The plan is this snapshot's, and its ordered roster is the authenticated one.
  assertDispatchPlan(plan);
  if (plan.arms.length !== rosterSize) {
    return refuseAfterAdmission('plan_roster_mismatch', 'plan arm count != roster size', permit, leaseAuthority);
  }
  for (let i = 0; i < rosterSize; i += 1) {
    const facade = plan.arms[i]!;
    const identity = snapshot.expectedArmIdentities[i]!;
    if (
      facade.participantId !== identity.participantId ||
      facade.provider !== identity.provider ||
      facade.requestedModelId !== identity.requestedModelId
    ) {
      return refuseAfterAdmission('plan_roster_mismatch', `plan arm ${i} does not equal the authenticated roster entry`, permit, leaseAuthority);
    }
  }

  // (6) Authorized: a deeply-frozen, branded value carrying the exact permit, snapshot,
  //     immutable plan, and the same-admission lease authority the lifecycle must use.
  const dispatch: AuthorizedDispatch = deepFreeze({ permit, snapshot, plan, leaseAuthority });
  authorized.add(dispatch);
  return { kind: 'Authorized', dispatch };
}
