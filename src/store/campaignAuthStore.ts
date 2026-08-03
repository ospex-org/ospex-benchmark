import type { StoreQuery } from './atomicStore.js';
import type { CampaignAuthorization, CampaignAuthorizationPort } from '../campaignAuthorization.js';

/**
 * The durable home for campaign authorizations, over the same `StoreQuery` seam the atomic
 * store uses. Deliberately NOT a method on `AtomicStore`: the money-critical store contract
 * and its conformance suite stay untouched, and this table is read by no admit/lease/
 * complete path, so it changes no admitted-money behavior.
 *
 * The JSON record is the single source of truth — there are no denormalized columns to drift
 * from it. Arming INSERTs and refuses to overwrite; disarming writes `disarmedAt` INSIDE the
 * record and never deletes the row, so both the arming and the stop remain auditable, and a
 * disarmed campaign can never be silently re-armed by a second `arm` call.
 */
export class SqlCampaignAuthorizationPort implements CampaignAuthorizationPort {
  constructor(private readonly query: StoreQuery) {}

  async read(cohortId: string): Promise<unknown | null> {
    const rows = await this.query('select record from store.campaign_authorizations where cohort_id = $1', [cohortId]);
    if (rows.length === 0) return null;
    return rows[0]!['record'] ?? null;
  }

  /**
   * Insert the record for a cohort not already armed. `on conflict do nothing` makes a
   * second arm a no-op rather than an overwrite: re-arming is an explicit disarm-then-arm
   * of a NEW cohort, never a silent replacement of live terms.
   */
  async arm(record: CampaignAuthorization): Promise<'armed' | 'already_armed'> {
    const rows = await this.query(
      `insert into store.campaign_authorizations (cohort_id, record)
       values ($1, $2::jsonb)
       on conflict (cohort_id) do nothing
       returning cohort_id`,
      [record.cohortId, JSON.stringify(record)],
    );
    return rows.length === 1 ? 'armed' : 'already_armed';
  }

  /**
   * Stamp `disarmedAt` inside the stored record. Idempotent, and it never overwrites an
   * earlier stop instant — the FIRST disarm is the true one, and a repeated stop must not
   * rewrite that history. Returns `not_found` only when no campaign was ever armed.
   */
  async disarm(cohortId: string, at: string): Promise<'disarmed' | 'not_found'> {
    const rows = await this.query(
      `update store.campaign_authorizations
          set record = jsonb_set(record, '{disarmedAt}', to_jsonb($2::text), true)
        where cohort_id = $1
          and record ->> 'disarmedAt' is null
        returning cohort_id`,
      [cohortId, at],
    );
    if (rows.length === 1) return 'disarmed';
    // No row updated: either already disarmed (still 'disarmed' — the stop holds) or absent.
    const existing = await this.query('select 1 as present from store.campaign_authorizations where cohort_id = $1', [
      cohortId,
    ]);
    return existing.length === 1 ? 'disarmed' : 'not_found';
  }
}
