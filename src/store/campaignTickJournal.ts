import type { StoreQuery } from './atomicStore.js';
import type { CampaignTickJournalPort, CampaignTickOutcome, ScheduleEntry } from '../campaignSchedule.js';
import { OPERATOR_RESUMED } from '../campaignSchedule.js';

/**
 * The SQL adapter for the campaign tick journal — plain INSERT/UPDATE/SELECT on
 * `store.campaign_ticks`, no lock, no touch of the money-critical store contract (the
 * same posture as the authorization and status-read adapters).
 *
 * `finish` is FIRST-WINS by construction: the UPDATE carries `finished_at is null`, so a
 * second finish — including a best-effort loud-failure finish that lost a race — affects
 * zero rows and changes nothing. Wire care: `id` arrives from `pg` as a bigint STRING and
 * `started_at`/`finished_at` as `Date`; every value is converted through a checked path
 * that refuses surprises loudly, and the read side keeps `outcome` a plain string so an
 * entry written by a newer build reaches the halt rule (which fails closed on outcomes it
 * does not recognize) instead of breaking the read.
 */
export class SqlCampaignTickJournalPort implements CampaignTickJournalPort {
  constructor(private readonly query: StoreQuery) {}

  async begin(cohortId: string, startedAtIso: string): Promise<number> {
    const rows = await this.query(
      `insert into store.campaign_ticks (cohort_id, kind, started_at)
       values ($1, 'tick', $2)
       returning id`,
      [cohortId, startedAtIso],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('tick journal begin returned no row — an INSERT ... RETURNING always yields one');
    return asEntryId(row['id']);
  }

  async finish(entryId: number, outcome: CampaignTickOutcome, detail: string | null, finishedAtIso: string): Promise<void> {
    // First finish wins: an already-finished entry is left exactly as it was.
    await this.query(
      `update store.campaign_ticks
          set finished_at = $2, outcome = $3, detail = $4
        where id = $1 and finished_at is null`,
      [entryId, finishedAtIso, outcome, detail],
    );
  }

  async resume(cohortId: string, atIso: string, detail: string | null): Promise<void> {
    await this.query(
      `insert into store.campaign_ticks (cohort_id, kind, started_at, finished_at, outcome, detail)
       values ($1, 'resume', $2, $2, $3, $4)`,
      [cohortId, atIso, OPERATOR_RESUMED, detail],
    );
  }

  async entries(cohortId: string, limit: number): Promise<readonly ScheduleEntry[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error(`tick journal read requires a positive entry limit, got ${String(limit)}`);
    }
    const rows = await this.query(
      `select id, kind, started_at, finished_at, outcome, detail
         from store.campaign_ticks
        where cohort_id = $1
        order by id desc
        limit $2`,
      [cohortId, limit],
    );
    return rows.map((row) => {
      const kind = row['kind'];
      if (kind !== 'tick' && kind !== 'resume') {
        throw new Error(`tick journal read: kind is neither tick nor resume: ${String(kind)}`);
      }
      return {
        id: asEntryId(row['id']),
        kind,
        startedAt: asInstant('started_at', row['started_at']),
        finishedAt: row['finished_at'] === null || row['finished_at'] === undefined ? null : asInstant('finished_at', row['finished_at']),
        outcome: asTextOrNull('outcome', row['outcome']),
        detail: asTextOrNull('detail', row['detail']),
      };
    });
  }
}

function asEntryId(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`tick journal id is not a positive safe integer: ${String(value)}`);
  }
  return n;
}

function asInstant(label: string, value: unknown): string {
  if (!(value instanceof Date)) {
    throw new Error(`tick journal ${label} is not a timestamp: ${String(value)}`);
  }
  return value.toISOString();
}

function asTextOrNull(label: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`tick journal ${label} is neither text nor null: ${String(value)}`);
  return value;
}
