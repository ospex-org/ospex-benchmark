import type { StoreQuery } from './atomicStore.js';

/**
 * The READ-ONLY status port for a campaign's durable store state, over the same
 * `StoreQuery` seam as every other adapter. Deliberately NOT a method on `AtomicStore`:
 * the money-critical store contract (admit/lease/complete/init, its schema version, and
 * its conformance suite) stays untouched — this port issues plain SELECTs, takes no locks,
 * and owns no write of any kind.
 *
 * The reads are separate statements, not one snapshot: this is a monitoring surface, and a
 * campaign that admits a fire between two reads simply shows up on the next status call.
 *
 * Wire care: `bigint` columns arrive from `pg` as STRINGS and `timestamptz` as `Date`
 * objects; every count is converted through one checked path that refuses anything that is
 * not a non-negative safe integer, so a wire surprise is a loud error — never a silently
 * wrong number on a money-adjacent report.
 */

export interface CampaignBudgetStatus {
  readonly callCap: number;
  readonly callsReserved: number;
  readonly spendCapUsdMicros: number;
  readonly spendReservedUsdMicros: number;
}

export interface CampaignFireStatus {
  readonly firesAdmitted: number;
  readonly firesCompleted: number;
  readonly firesPending: number;
  /** Attempts actually STARTED (`sum(made_calls)`) — the durable quantity closest to real
   *  provider spend; reservations are not invoices. */
  readonly callsMade: number;
  readonly claimsPending: number;
  readonly claimsCompleted: number;
  /** Unreleased, unexpired concurrency leases — nonzero means a dispatch is mid-flight (or
   *  crashed and not yet self-healed at its lease bound). */
  readonly activeLeases: number;
  /** The most recent fire admission instant (ISO), or null when no fire was ever admitted. */
  readonly lastAdmittedAt: string | null;
}

export interface CampaignStatusReadPort {
  /** The cohort's budget row, or null when no budget was ever initialized. */
  budget(cohortId: string): Promise<CampaignBudgetStatus | null>;
  /** Fire/claim/lease consumption; all-zero when the cohort never admitted anything. */
  fires(cohortId: string): Promise<CampaignFireStatus>;
}

function asCount(label: string, value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${label} is not a non-negative safe integer: ${String(value)}`);
  }
  return n;
}

function asInstantOrNull(label: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  throw new Error(`${label} is neither a timestamp nor null`);
}

export class SqlCampaignStatusReadPort implements CampaignStatusReadPort {
  constructor(private readonly query: StoreQuery) {}

  async budget(cohortId: string): Promise<CampaignBudgetStatus | null> {
    const rows = await this.query(
      `select call_cap, calls_reserved, spend_cap_usd_micros, spend_reserved_usd_micros
         from store.cohort_budget
        where cohort_id = $1`,
      [cohortId],
    );
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return {
      callCap: asCount('call_cap', row['call_cap']),
      callsReserved: asCount('calls_reserved', row['calls_reserved']),
      spendCapUsdMicros: asCount('spend_cap_usd_micros', row['spend_cap_usd_micros']),
      spendReservedUsdMicros: asCount('spend_reserved_usd_micros', row['spend_reserved_usd_micros']),
    };
  }

  async fires(cohortId: string): Promise<CampaignFireStatus> {
    const fireRows = await this.query(
      `select count(*)                                     as fires_admitted,
              count(*) filter (where status = 'completed') as fires_completed,
              count(*) filter (where status = 'pending')   as fires_pending,
              coalesce(sum(made_calls), 0)                 as calls_made,
              max(admitted_at)                             as last_admitted_at
         from store.fires
        where cohort_id = $1`,
      [cohortId],
    );
    const claimRows = await this.query(
      `select count(*) filter (where status = 'pending')   as claims_pending,
              count(*) filter (where status = 'completed') as claims_completed
         from store.claims
        where cohort_id = $1`,
      [cohortId],
    );
    const leaseRows = await this.query(
      `select count(*) as active_leases
         from store.concurrency_leases
        where cohort_id = $1
          and released_at is null
          and expires_at > now()`,
      [cohortId],
    );
    const fire = fireRows[0];
    const claim = claimRows[0];
    const lease = leaseRows[0];
    if (fire === undefined || claim === undefined || lease === undefined) {
      throw new Error('status aggregation returned no row — an aggregate select always yields one');
    }
    return {
      firesAdmitted: asCount('fires_admitted', fire['fires_admitted']),
      firesCompleted: asCount('fires_completed', fire['fires_completed']),
      firesPending: asCount('fires_pending', fire['fires_pending']),
      callsMade: asCount('calls_made', fire['calls_made']),
      claimsPending: asCount('claims_pending', claim['claims_pending']),
      claimsCompleted: asCount('claims_completed', claim['claims_completed']),
      activeLeases: asCount('active_leases', lease['active_leases']),
      lastAdmittedAt: asInstantOrNull('last_admitted_at', fire['last_admitted_at']),
    };
  }
}
