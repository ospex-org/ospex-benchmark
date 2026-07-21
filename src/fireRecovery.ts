import { deepFreeze } from './freeze.js';
import { replayReleaseCapabilityForRecovery } from './lineOpenClaim.js';
import type { ReplayPendingRecovery } from './lineOpenClaim.js';

/**
 * Pending-replay cleanup mechanics (SPEC-atomic-store.md §4.3, SPEC-line-open-evidence-model.md §4).
 *
 * `releasePendingReplay` is a non-activating best-effort helper: given an AUTHENTICATED pending-replay
 * recovery, it releases that recovery's own initial concurrency leases through the recovery's paired,
 * lease-set-bound release-only capability. It has no canonical caller — a later coordinator owns the
 * decision of WHETHER to release (see below), and this helper only performs the mechanics safely.
 *
 * What a pending replay proves is narrow: a prior admission with this `fireId` committed and this retry
 * is not authorized to dispatch. It does NOT prove same owner, one process, that no provider call
 * started, that the original worker is dead, or that the artifact is absent (`fireId` excludes owner
 * identity; the store is expressly cross-process). So a `released` acknowledgement here is an idempotent
 * store acknowledgement, NOT proof that this call newly freed a slot: an unknown, already-released, or
 * expired lease can also acknowledge `released`. The only authoritative capacity state is the store's
 * own capacity query. The safe fallback for any lease that is not confirmed released is store-clock
 * lease expiry. Deciding it is SAFE to release at all — a known-no-dispatch, same-owner retry of an
 * ended attempt that received no dispatch authority and started no provider call — is the coordinator's
 * positive-provenance obligation, not this helper's.
 *
 * Authentication is aggregate-first: the capability is resolved from the authenticated recovery, so a
 * forged/spread-copied/proxied recovery — or a genuine capability crossed with another fire's lease
 * list — is rejected (the origin assertion PROPAGATES) before any release. A forged recovery is never
 * turned into an empty/`failed` report. Per-lease `not_owner` and `failed` never stop later attempts.
 */

/**
 * One lease-release attempt. `released` = the store's explicit idempotent `released` acknowledgement
 * (not proof of a freed slot). `not_owner` = the store's explicit owner-mismatch refusal (expected for
 * a fresh-owner restart or another worker). `failed` = the release is UNCONFIRMED — the invocation
 * rejected/threw, or its resolved value could not be classified — so it may or may not have committed;
 * no arbitrary thrown/resolved value is read, coerced, or formatted.
 */
export interface ReplayReleaseAttempt {
  readonly leaseId: string;
  readonly result: 'released' | 'not_owner' | 'failed';
}

/** The detached, deeply-frozen best-effort release report — all counts derived from the one attempts
 *  array. `releasedCount` counts store acknowledgements, NEVER capacity slots freed. */
export interface ReplayReleaseOutcome {
  readonly attempts: readonly ReplayReleaseAttempt[];
  readonly releasedCount: number;
  readonly notOwnerCount: number;
  readonly failedCount: number;
}

/**
 * Release the leases of an AUTHENTICATED pending-replay recovery, best-effort. Authenticates the exact
 * aggregate first (a forged/crossed recovery's origin assertion propagates), then attempts each DISTINCT
 * initial lease id ONCE, in recorded order, through the recovery's own lease-set-bound capability.
 * Classifies each attempt truthfully: only an exact `released` / an exact `refused`+`not_owner` map to
 * those statuses; a rejection, throw, trapping/absent discriminator, or unknown outcome/reason maps to a
 * fixed `failed` without reading arbitrary data. Never throws on a per-lease result; returns a detached,
 * deeply-frozen outcome.
 */
export async function releasePendingReplay(recovery: ReplayPendingRecovery): Promise<ReplayReleaseOutcome> {
  // Aggregate-first authentication: resolve the capability from the authenticated recovery, never from a
  // caller-supplied `recovery.cleanup`. A forged/crossed recovery throws HERE (propagates) — it is never
  // folded into an empty/failed report.
  const cleanup = replayReleaseCapabilityForRecovery(recovery);
  const leases = recovery.initialLeases; // the exact branded/frozen value

  const attempts: ReplayReleaseAttempt[] = [];
  const seen = new Set<string>();
  for (const lease of leases) {
    const leaseId = lease.leaseId; // read once, before dedup / call / attempt construction
    if (seen.has(leaseId)) continue; // one real lease is never released twice
    seen.add(leaseId);

    let result: 'released' | 'not_owner' | 'failed';
    try {
      const r = await cleanup.releaseLease(leaseId);
      // Capture each discriminator EXACTLY ONCE inside the guarded boundary. A throwing getter, a
      // primitive, or null is caught below and folds to `failed`; an unknown outcome/reason folds to
      // `failed`, never `not_owner`. Never format or inspect an arbitrary value.
      const outcome: unknown = (r as { outcome?: unknown }).outcome;
      if (outcome === 'released') {
        result = 'released';
      } else if (outcome === 'refused') {
        const reason: unknown = (r as { reason?: unknown }).reason;
        result = reason === 'not_owner' ? 'not_owner' : 'failed';
      } else {
        result = 'failed';
      }
    } catch {
      // Rejection / synchronous throw — unconfirmed; the thrown value is never read or formatted.
      result = 'failed';
    }
    attempts.push({ leaseId, result });
  }

  let releasedCount = 0;
  let notOwnerCount = 0;
  let failedCount = 0;
  for (const attempt of attempts) {
    if (attempt.result === 'released') releasedCount += 1;
    else if (attempt.result === 'not_owner') notOwnerCount += 1;
    else failedCount += 1;
  }
  return deepFreeze({ attempts: [...attempts], releasedCount, notOwnerCount, failedCount });
}
