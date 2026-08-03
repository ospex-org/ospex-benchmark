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
 * record and never deletes the row, so both the arming and the stop remain auditable. A
 * cohort is armed at most once, EVER — the primary key refuses every second arm, including
 * after a disarm; another campaign is a new manifest and therefore a new cohortId.
 */
export class SqlCampaignAuthorizationPort implements CampaignAuthorizationPort {
  constructor(private readonly query: StoreQuery) {}

  async read(cohortId: string): Promise<unknown | null> {
    const rows = await this.query('select record from store.campaign_authorizations where cohort_id = $1', [cohortId]);
    if (rows.length === 0) return null;
    return rows[0]!['record'] ?? null;
  }

  /**
   * Insert the record for a cohort never armed before. `on conflict do nothing` makes any
   * second arm for the same cohort a refusal rather than an overwrite — including after a
   * disarm: the record is immutable history, and running another campaign means a NEW
   * manifest (a new window gives a new cohortId), never a replacement of this one.
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
   * Stamp `disarmedAt` inside the stored record — classified in ONE SQL statement, one
   * PostgreSQL snapshot. The `attempt` CTE conditionally updates the live row (its
   * `disarmedAt is null` predicate is what preserves the FIRST stop instant — a repeated
   * stop never rewrites history); the `standing` CTE reads row presence in the SAME
   * statement snapshot. A standing row the update did not touch is either already disarmed
   * in the snapshot or was disarmed by a concurrent stop this statement waited on — both
   * truthfully `disarmed` — while a row INSERTED after the snapshot is invisible to both
   * CTEs and yields `not_found`, never a false `disarmed`. (The two-statement
   * update-then-presence-probe shape this replaces could observe such an insert in the
   * second query's LATER snapshot and misreport an ACTIVE authorization as stopped.)
   * `not_found` therefore means: no campaign was armed as of this statement's snapshot.
   * An off-contract result shape throws rather than being coerced.
   */
  async disarm(cohortId: string, at: string): Promise<'disarmed' | 'not_found'> {
    const rows = await this.query(
      `with attempt as (
         update store.campaign_authorizations
            set record = jsonb_set(record, '{disarmedAt}', to_jsonb($2::text), true)
          where cohort_id = $1
            and record ->> 'disarmedAt' is null
         returning cohort_id
       ),
       standing as (
         select cohort_id from store.campaign_authorizations where cohort_id = $1
       )
       select case
                when exists (select 1 from attempt) then 'disarmed'
                when exists (select 1 from standing) then 'disarmed'
                else 'not_found'
              end as outcome`,
      [cohortId, at],
    );
    const outcome = rows.length === 1 ? rows[0]!['outcome'] : undefined;
    if (outcome !== 'disarmed' && outcome !== 'not_found') {
      throw new Error(`disarm returned an off-contract result shape: ${JSON.stringify(rows)}`);
    }
    return outcome;
  }
}
