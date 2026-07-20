import { assertAuthorizedDispatch } from './lineOpenDispatch.js';
import type { AuthorizedDispatch, CleanupAttempt } from './lineOpenDispatch.js';
import type { AdmissionLeaseAuthority, DispatchPermit } from './lineOpenClaim.js';
import type { Lease } from './store/contract.js';

/**
 * The per-attempt concurrency-lease lifecycle (SPEC-line-open-evidence-model.md §4/§5): the
 * seam the dispatch path calls at its real HTTP boundaries so a durable lease backs exactly
 * one in-flight request and is freed the moment that request settles.
 *
 * It is created FROM a genuine `AuthorizedDispatch` and closes over that admission's own
 * lease authority, so the store, owner, cohort, fire, and schema version it uses are the ones
 * the admission committed to — there is no constructor argument through which a caller could
 * substitute them, and no module-global state, so two concurrent fires cannot alias each
 * other's slots. Each instance owns its own arm/ordinal state.
 *
 * Every operation is fail-loud: an unknown arm, an invalid ordinal, a repeated release, a
 * repair released without being acquired, a store refusal (`not_owner`), or a store throw is a
 * `LifecycleFaultError` — never a silent no-op, because a lease this process believes it freed
 * but did not is exactly the capacity leak the durable store exists to prevent.
 */

/**
 * One lease-release attempt this lifecycle made: the same three-value vocabulary the
 * pre-dispatch cleanup log uses, plus which arm the lease backed. `released` is the only
 * success; a refusal is `not_owner` (the store's only refusal reason) and a raise is `threw`.
 */
export interface LeaseReleaseAttempt extends CleanupAttempt {
  readonly armIndex: number;
}

/** A lifecycle misuse or store failure. Never raised for an ordinary refusal to authorize. */
export class LifecycleFaultError extends Error {
  /**
   * The COMPLETE ordered attempt log — released leases included — for a bulk release; empty
   * for a single-lease fault. An operator reading only the failures cannot tell whether the
   * rest were attempted at all, so the whole log travels with the fault.
   */
  readonly attempts: readonly LeaseReleaseAttempt[];
  /** Leases this fire still holds. DERIVED from `attempts`, so the two can never drift. */
  readonly failures: readonly LeaseReleaseAttempt[];
  constructor(message: string, attempts: readonly LeaseReleaseAttempt[] = []) {
    super(message);
    this.name = 'LifecycleFaultError';
    this.attempts = Object.freeze([...attempts]);
    this.failures = Object.freeze(this.attempts.filter((a) => a.result !== 'released'));
  }
}

/**
 * A lease cleanup that failed while ANOTHER failure was already propagating: both causes are
 * retained. The primary is what actually broke the attempt; the cleanup fault means this fire
 * is still holding a durable slot — exactly the truth a lone primary would hide.
 */
export class AttemptCleanupFaultError extends Error {
  /** The failure that was already propagating when cleanup ran. */
  readonly primary: unknown;
  /** Why the lease cleanup failed (a `LifecycleFaultError` for every raise from here). */
  readonly cleanup: unknown;
  constructor(primary: unknown, cleanup: unknown) {
    // Built from our OWN text only: coercing either retained value could throw and destroy
    // this error exactly when both causes are needed.
    super('an attempt failed and its lease cleanup also failed; both causes are retained');
    this.name = 'AttemptCleanupFaultError';
    this.primary = primary;
    this.cleanup = cleanup;
  }
}

/**
 * The dispatch path's view of the lease lifecycle. `armIndex` is the manifest roster index;
 * `repairOrdinal` numbers repairs within one arm from 1.
 */
export interface AttemptLifecyclePort {
  /** Free the arm's initial slot; call once, immediately after its initial attempt settles
   *  (or is skipped without a call). */
  releaseInitial(armIndex: number): Promise<void>;
  /** Reserve one repair slot immediately before the repair request. `authorized: false` means
   *  send nothing — and release nothing, because nothing was taken. */
  acquireRepair(armIndex: number, repairOrdinal: number): Promise<{ authorized: boolean }>;
  /** Free the slot acquired for exactly this `(armIndex, repairOrdinal)`. */
  releaseRepair(armIndex: number, repairOrdinal: number): Promise<void>;
}

/** The lifecycle plus the pre-launch bulk release the canonical dispatch path needs. */
export interface AdmissionAttemptLifecycle extends AttemptLifecyclePort {
  /**
   * Release every initial lease that has not been released and whose arm has NOT started an
   * HTTP request — for a canonical failure after authorization but before any arm launches.
   * Every lease is attempted even if one fails, and the complete attempt log is reported.
   */
  releaseAllUnstarted(): Promise<void>;
}

function keyOf(armIndex: number, repairOrdinal: number): string {
  return `${armIndex}:${repairOrdinal}`;
}

/**
 * Build the lifecycle for one authorized dispatch. Authenticates the branded value, indexes
 * the permit's already-validated initial leases by arm index, and closes over that
 * admission's lease authority.
 */
export function createAttemptLifecycle(dispatch: AuthorizedDispatch): AdmissionAttemptLifecycle {
  assertAuthorizedDispatch(dispatch);
  const permit: DispatchPermit = dispatch.permit;
  const authority: AdmissionLeaseAuthority = dispatch.leaseAuthority;

  // Per-instance state. A module-level map keyed by arm index would alias concurrent fires.
  const initialByArm = new Map<number, Lease>();
  for (const lease of permit.initialLeases) initialByArm.set(lease.armIndex, lease);
  const initialReleaseStarted = new Set<number>();
  const repairAcquireStarted = new Set<string>();
  const repairLeases = new Map<string, Lease>();
  const repairReleaseStarted = new Set<string>();

  /**
   * One release through the admission's own authority, classified into OUR OWN three-value
   * vocabulary. The store's value never reaches a message: a hostile `outcome` must not turn
   * a lifecycle fault into an unrelated coercion throw, and a raise must not escape raw.
   */
  const attemptRelease = async (leaseId: string): Promise<LeaseReleaseAttempt['result']> => {
    try {
      const { outcome } = await authority.releaseLease(leaseId);
      return outcome === 'released' ? 'released' : 'not_owner';
    } catch {
      return 'threw';
    }
  };

  /** The throwing form: anything but `released` is a lifecycle fault. */
  const release = async (leaseId: string, what: string): Promise<void> => {
    const result = await attemptRelease(leaseId);
    if (result !== 'released') {
      throw new LifecycleFaultError(`${what} release ${result === 'threw' ? 'threw' : 'was refused (not_owner)'}`);
    }
  };

  const requireKnownArm = (armIndex: number): Lease => {
    const lease = initialByArm.get(armIndex);
    if (lease === undefined) throw new LifecycleFaultError(`unknown arm index ${String(armIndex)}`);
    return lease;
  };

  return {
    async releaseInitial(armIndex: number): Promise<void> {
      const lease = requireKnownArm(armIndex);
      // Mark BEFORE awaiting the store: a throw must not leave the arm eligible for a second
      // release in the same invocation chain (the runner's own guard notwithstanding).
      if (initialReleaseStarted.has(armIndex)) {
        throw new LifecycleFaultError(`initial lease for arm ${armIndex} was already released`);
      }
      initialReleaseStarted.add(armIndex);
      await release(lease.leaseId, `arm ${armIndex} initial lease`);
    },

    async acquireRepair(armIndex: number, repairOrdinal: number): Promise<{ authorized: boolean }> {
      requireKnownArm(armIndex);
      if (!Number.isInteger(repairOrdinal) || repairOrdinal < 1) {
        throw new LifecycleFaultError(`invalid repair ordinal ${String(repairOrdinal)} for arm ${armIndex}`);
      }
      const key = keyOf(armIndex, repairOrdinal);
      if (repairAcquireStarted.has(key)) {
        throw new LifecycleFaultError(`repair ${repairOrdinal} for arm ${armIndex} was already acquired`);
      }
      repairAcquireStarted.add(key);

      let result;
      try {
        // Only the arm/ordinal are supplied; cohort, fire, owner and schema come from the
        // admission the authority closed over.
        result = await authority.acquireRepairLease(armIndex, repairOrdinal);
      } catch {
        throw new LifecycleFaultError(`repair ${repairOrdinal} for arm ${armIndex} acquire threw`);
      }
      // A replay or refusal takes nothing, so nothing is released for it either.
      if (result.outcome !== 'acquired') return { authorized: false };

      // A returned lease must actually back THIS arm's repair and must not alias a slot this
      // lifecycle already holds — otherwise a later release would free the wrong slot.
      const lease = result.lease;
      const held = new Set<string>([
        ...[...initialByArm.values()].map((l) => l.leaseId),
        ...[...repairLeases.values()].map((l) => l.leaseId),
      ]);
      const problem =
        // An `acquired` outcome WITHOUT the authorization literal is self-contradictory: the
        // store handed back a slot while denying the request, so the slot must be returned
        // rather than silently leaked (every other malformed `acquired` shape is cleaned too).
        result.requestAuthorized !== true
          ? 'was not authorized'
          : lease.armIndex !== armIndex
          ? 'is bound to a different arm'
          : lease.state !== 'live'
            ? 'is not live'
            : held.has(lease.leaseId)
              ? 'aliases a lease this fire already holds'
              : null;
      if (problem !== null) {
        // Give the slot back once, send nothing, and fail loud with the cleanup outcome.
        const cleanup = await attemptRelease(lease.leaseId);
        throw new LifecycleFaultError(
          `repair ${repairOrdinal} for arm ${armIndex} acquired a lease that ${problem} (cleanup: ${cleanup})`,
        );
      }
      repairLeases.set(key, lease);
      return { authorized: true };
    },

    async releaseRepair(armIndex: number, repairOrdinal: number): Promise<void> {
      requireKnownArm(armIndex);
      const key = keyOf(armIndex, repairOrdinal);
      const lease = repairLeases.get(key);
      if (lease === undefined) {
        throw new LifecycleFaultError(
          `repair ${repairOrdinal} for arm ${armIndex} was never acquired by this lifecycle`,
        );
      }
      if (repairReleaseStarted.has(key)) {
        throw new LifecycleFaultError(`repair ${repairOrdinal} for arm ${armIndex} was already released`);
      }
      repairReleaseStarted.add(key);
      await release(lease.leaseId, `arm ${armIndex} repair ${repairOrdinal} lease`);
    },

    async releaseAllUnstarted(): Promise<void> {
      // Pre-launch only: no arm has begun an HTTP request, so every unreleased initial lease
      // is unstarted. Attempt them all — one failure must not strand the rest — and record
      // EVERY attempt in permit order, released ones included: "two leases failed" without the
      // complete log leaves an operator unable to tell whether the others were even tried.
      const attempts: LeaseReleaseAttempt[] = [];
      for (const [armIndex, lease] of initialByArm) {
        if (initialReleaseStarted.has(armIndex)) continue;
        initialReleaseStarted.add(armIndex);
        // Retain WHICH lease each attempt was for — an operator needs identities, not counts.
        attempts.push({ armIndex, leaseId: lease.leaseId, result: await attemptRelease(lease.leaseId) });
      }
      const held = attempts.filter((a) => a.result !== 'released');
      if (held.length > 0) {
        throw new LifecycleFaultError(
          `pre-launch lease release failed for ${held.length} of ${attempts.length} lease(s)`,
          attempts,
        );
      }
    },
  };
}
