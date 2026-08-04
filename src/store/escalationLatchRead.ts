import type { StoreQuery } from './atomicStore.js';
import type { UnresolvedFire, UnresolvedFireRead } from '../escalationLatch.js';

/**
 * The store-derived escalation-latch read: every cohort fire that is `pending` with NO
 * live lease — no lease that is both unreleased and unexpired at the store clock. An
 * escalated fire is in this state from strictly before its escalation evidence can exist
 * (the spine settles every lease before the spend guard runs, and deliberately never
 * settles an escalated claim), so this read latches every escalation without any write
 * of its own; it also holds crashed-unsettled and settle-failed fires, the conservative
 * direction for an unattended path (see `escalationLatch.ts`).
 *
 * Like `SqlCampaignStatusReadPort`, this is deliberately NOT a method on `AtomicStore`:
 * a plain SELECT, no lock, no write, no change to the money-critical store contract or
 * its conformance surface. Liveness uses the same `released_at is null and expires_at >
 * now()` filter as the store's own capacity read. Wire care: `admitted_at` arrives from
 * `pg` as a `Date`; anything else is a loud error, never a silently wrong instant.
 */
export class SqlUnresolvedFireReadPort implements UnresolvedFireRead {
  constructor(private readonly query: StoreQuery) {}

  async unresolvedFires(cohortId: string): Promise<readonly UnresolvedFire[]> {
    const rows = await this.query(
      `select f.fire_id, f.admitted_at
         from store.fires f
        where f.cohort_id = $1
          and f.status = 'pending'
          and not exists (
                select 1
                  from store.concurrency_leases l
                 where l.cohort_id = f.cohort_id
                   and l.fire_id = f.fire_id
                   and l.released_at is null
                   and l.expires_at > now()
              )
        order by f.admitted_at, f.fire_id`,
      [cohortId],
    );
    return rows.map((row) => {
      const fireId = row['fire_id'];
      if (typeof fireId !== 'string' || fireId === '') {
        throw new Error(`unresolved-fire read: fire_id is not a non-empty string: ${String(fireId)}`);
      }
      const admittedAt = row['admitted_at'];
      if (!(admittedAt instanceof Date)) {
        throw new Error(`unresolved-fire read: admitted_at is not a timestamp: ${String(admittedAt)}`);
      }
      return { fireId, admittedAt: admittedAt.toISOString() };
    });
  }
}
