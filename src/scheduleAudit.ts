import { z } from 'zod';
import { closeAfterStart } from './clv.js';
import { isScheduleChanged, scheduleDriftMs, SCHEDULE_CHANGE_TOLERANCE_MS } from './scoring.js';
import { closeQuoteFromRow } from './scoring.js';
import type { ClosingLineRow, GamesTableRow } from './types.js';

/**
 * Close-schedule audit dataset contract
 * (out/close-schedule-audit-*.ndjson): what the production-captured closing
 * lines actually look like under the scorer's close-timing checks, measured
 * over the WHOLE captured corpus rather than over one run's picks.
 *
 * It answers three questions the scorer cannot answer from a single run:
 * how many captured closes the odds feed was still quoting after their own
 * recorded lock; how many have a lock that disagrees with the schedule row
 * they were copied from; and how the first is distributed across sports and
 * confidence classes.
 *
 * TWO REFERENCE TIMES, deliberately kept distinct:
 *
 * - The SCORER's `scheduleChanged` compares a close's `lock_time` against
 *   the FROZEN BUNDLE start the model actually saw (`SourceGame.startUtc`).
 *   That reference exists only inside a run file.
 * - This AUDIT has no run file, so it compares `lock_time` against the
 *   CURRENT schedule row (`games.match_time`) and reports the result under
 *   its own name, `scheduleChangedVsMatchTime`. Same classifier, same
 *   tolerance, DIFFERENT reference — the two numbers must never be read as
 *   the same measurement.
 *
 * WHAT THIS CANNOT SEE. `lock_time` is copied from `games.match_time` at
 * capture, so when a start moved earlier and the upstream capture never
 * noticed, both sides of the schedule comparison are the same wrong instant
 * and the drift reads as zero. The post-start-poll count is the only signal
 * here that does not come from the schedule record itself — it comes from
 * the feed's own behaviour — and even it cannot distinguish "the game had
 * not started" from "the feed quotes in-play". Establishing real first
 * pitch needs an independent source (the on-chain contest start served by
 * the public read API, or a league schedule feed); this audit measures what
 * is reachable from the public anon read path and says so.
 *
 * Completeness posture (identical to the totals extraction): the CLAIMED
 * source table is enumerated directly by keyset pagination on its identity
 * key — never via a pre-enumerated game list, which would silently hide
 * closes whose games row is missing or unexpected. Games are then looked up
 * by pinned ids. Every close seen is accounted for by an EXCLUSIVE verdict,
 * a close with no games row or an unclassifiable timestamp refuses the
 * whole snapshot, and the reader re-checks that arithmetic on every load.
 */

export class ScheduleAuditError extends Error {}

/**
 * Exclusive verdict, assigned in the SCORER's own gate order so the audit
 * describes what the scorer would do rather than a parallel opinion:
 *
 * - `not_fresh` — the upstream freshness classification already refuses it
 *   (`close_stale` / `close_not_captured`), which runs first;
 * - `post_start_poll` — the feed was still quoting the market after the
 *   row's own lock (`close_after_start`), which runs next;
 * - `schedule_changed` — neither refusal applies, but the lock disagrees
 *   with the schedule row by at least the tolerance. A TAG, not a refusal:
 *   the scorer still computes CLV for these;
 * - `clean` — none of the above.
 */
export const CLOSE_AUDIT_VERDICTS = [
  'not_fresh',
  'post_start_poll',
  'schedule_changed',
  'clean',
] as const;

export type CloseAuditVerdict = (typeof CLOSE_AUDIT_VERDICTS)[number];

export const closeScheduleAuditRecordSchema = z
  .object({
    recordType: z.literal('close_schedule_audit'),
    gameId: z.string().min(1),
    market: z.enum(['moneyline', 'spread', 'total']),
    sport: z.string().min(1),
    confidence: z.enum(['fresh', 'stale', 'missing']),
    lockTime: z.string().min(1),
    valueCapturedAt: z.union([z.string(), z.null()]),
    lastPolledAt: z.union([z.string(), z.null()]),
    pollGapSeconds: z.union([z.number(), z.null()]),
    /** The CURRENT schedule row — this audit's reference, not the scorer's. */
    gameMatchTime: z.string().min(1),
    /** Signed `lockTime - gameMatchTime` in ms. */
    matchTimeDriftMs: z.number(),
    scheduleChangedVsMatchTime: z.boolean(),
    closeAfterStart: z.boolean(),
    valueCapturedAfterLock: z.boolean(),
    valueCapturedAfterMatchTime: z.boolean(),
    verdict: z.enum(CLOSE_AUDIT_VERDICTS),
  })
  .strict();

export const closeScheduleAuditMetaSchema = z
  .object({
    recordType: z.literal('close_schedule_audit_meta'),
    network: z.string().min(1),
    scheduleChangeToleranceMs: z.number().int().nonnegative(),
    /** Every closing line seen on the network, all markets. */
    closesSeen: z.number().int().nonnegative(),
    records: z.number().int().nonnegative(),
    gamesJoined: z.number().int().nonnegative(),
    /** EXCLUSIVE partition of every written record; sums to `records`. */
    verdicts: z.record(z.string(), z.number().int().nonnegative()),
    /** NON-exclusive raw counts — a row can appear in several of these. */
    closeAfterStartAny: z.number().int().nonnegative(),
    scheduleChangedVsMatchTimeAny: z.number().int().nonnegative(),
    notFreshAny: z.number().int().nonnegative(),
    pollGapNull: z.number().int().nonnegative(),
    valueCapturedAfterLockAny: z.number().int().nonnegative(),
    valueCapturedAfterMatchTimeAny: z.number().int().nonnegative(),
    lockEarlierThanMatchTime: z.number().int().nonnegative(),
    lockLaterThanMatchTime: z.number().int().nonnegative(),
    confidence: z.record(z.string(), z.number().int().nonnegative()),
    /** Sports of the games carrying a post-start-poll close. */
    postStartPollBySport: z.record(z.string(), z.number().int().nonnegative()),
    postStartPollGames: z.number().int().nonnegative(),
    lockTimeRange: z.union([z.tuple([z.string(), z.string()]), z.null()]),
    generatedAt: z.string().min(1),
  })
  .strict();

export type CloseScheduleAuditRecord = z.infer<typeof closeScheduleAuditRecordSchema>;
export type CloseScheduleAuditMeta = z.infer<typeof closeScheduleAuditMetaSchema>;

function afterStrict(a: string | null, b: string): boolean {
  if (a === null) return false;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return left > right;
}

/**
 * Classify ONE captured close against its schedule row.
 *
 * Throws when the row cannot be classified — an unparseable `lock_time` or
 * `match_time` makes the drift undeterminable, and a snapshot that quietly
 * called that "no drift" would be worse than no snapshot. The caller refuses
 * the whole run.
 *
 * The two behavioural predicates are the SCORER's own exported functions
 * (`closeAfterStart` via `closeQuoteFromRow`, and `isScheduleChanged`), not
 * re-derivations of them — the audit can only measure what the scorer does
 * if it asks the scorer.
 */
export function closeScheduleAuditRecord(
  close: ClosingLineRow,
  game: GamesTableRow,
  toleranceMs: number = SCHEDULE_CHANGE_TOLERANCE_MS,
): CloseScheduleAuditRecord {
  const driftMs = scheduleDriftMs(close.lock_time, game.match_time);
  if (driftMs === null) {
    throw new ScheduleAuditError(
      `close ${close.jsonodds_id}:${close.market} has an unparseable lock_time ` +
        `("${close.lock_time}") or games.match_time ("${game.match_time}") — ` +
        'refusing an unclassifiable snapshot',
    );
  }
  const changed = isScheduleChanged(driftMs, toleranceMs);
  if (changed === null) {
    throw new ScheduleAuditError(
      `close ${close.jsonodds_id}:${close.market} produced an undeterminable schedule ` +
        'verdict — refusing an unclassifiable snapshot',
    );
  }
  const postStart = closeAfterStart(closeQuoteFromRow(close));
  const notFresh = close.confidence !== 'fresh';
  const verdict: CloseAuditVerdict = notFresh
    ? 'not_fresh'
    : postStart
      ? 'post_start_poll'
      : changed
        ? 'schedule_changed'
        : 'clean';
  return {
    recordType: 'close_schedule_audit',
    gameId: close.jsonodds_id,
    market: close.market,
    sport: game.sport,
    confidence: close.confidence,
    lockTime: close.lock_time,
    valueCapturedAt: close.value_captured_at,
    lastPolledAt: close.last_polled_at,
    pollGapSeconds: close.poll_gap_seconds,
    gameMatchTime: game.match_time,
    matchTimeDriftMs: driftMs,
    scheduleChangedVsMatchTime: changed,
    closeAfterStart: postStart,
    valueCapturedAfterLock: afterStrict(close.value_captured_at, close.lock_time),
    valueCapturedAfterMatchTime: afterStrict(close.value_captured_at, game.match_time),
    verdict,
  };
}

/** Verdict partition re-derived from the records themselves. */
export function rederivedVerdicts(
  records: readonly CloseScheduleAuditRecord[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const verdict of CLOSE_AUDIT_VERDICTS) counts[verdict] = 0;
  for (const record of records) {
    counts[record.verdict] = (counts[record.verdict] ?? 0) + 1;
  }
  return counts;
}

/** Confidence histogram re-derived from the records themselves. */
export function rederivedAuditConfidence(
  records: readonly CloseScheduleAuditRecord[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    counts[record.confidence] = (counts[record.confidence] ?? 0) + 1;
  }
  return counts;
}

/** Sports carrying a post-start-poll close, re-derived from the records. */
export function rederivedPostStartBySport(
  records: readonly CloseScheduleAuditRecord[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    if (!record.closeAfterStart) continue;
    counts[record.sport] = (counts[record.sport] ?? 0) + 1;
  }
  return counts;
}

/** [min, max] lock time re-derived from the records themselves; null when empty. */
export function rederivedAuditLockTimeRange(
  records: readonly CloseScheduleAuditRecord[],
): [string, string] | null {
  let min: string | null = null;
  let max: string | null = null;
  for (const record of records) {
    if (min === null || record.lockTime < min) min = record.lockTime;
    if (max === null || record.lockTime > max) max = record.lockTime;
  }
  return min !== null && max !== null ? [min, max] : null;
}

export interface CloseScheduleAuditDataset {
  meta: CloseScheduleAuditMeta;
  records: CloseScheduleAuditRecord[];
}

/**
 * Parse + integrity-check a written audit dataset: exactly one leading meta
 * record, and every record-derivable meta field re-derived from the records
 * and compared — record count, the EXCLUSIVE verdict partition (which must
 * also sum to `closesSeen`, so a dropped row cannot hide), the confidence
 * histogram, the non-exclusive raw counts, the post-start sport histogram,
 * and the lock-time range. A truncated or edited file refuses to load.
 */
export function parseCloseScheduleAuditDataset(text: string): CloseScheduleAuditDataset {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new ScheduleAuditError('audit dataset is empty');
  const meta = closeScheduleAuditMetaSchema.parse(JSON.parse(lines[0] ?? ''));
  const records = lines
    .slice(1)
    .map((line) => closeScheduleAuditRecordSchema.parse(JSON.parse(line)));
  if (records.length !== meta.records) {
    throw new ScheduleAuditError(
      `meta says ${meta.records} records but the dataset holds ${records.length} — truncated or edited?`,
    );
  }
  // Every close seen must be written: this audit drops nothing, so the
  // exclusive partition has to account for the full enumeration.
  if (meta.closesSeen !== meta.records) {
    throw new ScheduleAuditError(
      `meta coverage arithmetic fails: ${meta.closesSeen} closes seen != ${meta.records} records`,
    );
  }
  const verdicts = rederivedVerdicts(records);
  const verdictTotal = Object.values(verdicts).reduce((a, b) => a + b, 0);
  if (verdictTotal !== meta.closesSeen) {
    throw new ScheduleAuditError(
      `verdict partition sums to ${verdictTotal}, not the ${meta.closesSeen} closes seen — ` +
        'the partition is not exclusive/exhaustive',
    );
  }
  for (const key of new Set([...Object.keys(verdicts), ...Object.keys(meta.verdicts)])) {
    if ((verdicts[key] ?? 0) !== (meta.verdicts[key] ?? 0)) {
      throw new ScheduleAuditError(
        `meta verdict partition disagrees with the records at "${key}" — truncated or edited?`,
      );
    }
  }
  const confidence = rederivedAuditConfidence(records);
  for (const key of new Set([...Object.keys(confidence), ...Object.keys(meta.confidence)])) {
    if ((confidence[key] ?? 0) !== (meta.confidence[key] ?? 0)) {
      throw new ScheduleAuditError(
        `meta confidence histogram disagrees with the records at "${key}" — truncated or edited?`,
      );
    }
  }
  const bySport = rederivedPostStartBySport(records);
  for (const key of new Set([...Object.keys(bySport), ...Object.keys(meta.postStartPollBySport)])) {
    if ((bySport[key] ?? 0) !== (meta.postStartPollBySport[key] ?? 0)) {
      throw new ScheduleAuditError(
        `meta post-start sport histogram disagrees with the records at "${key}" — truncated or edited?`,
      );
    }
  }
  const raw: Array<[string, number, number]> = [
    ['closeAfterStartAny', meta.closeAfterStartAny, records.filter((r) => r.closeAfterStart).length],
    [
      'scheduleChangedVsMatchTimeAny',
      meta.scheduleChangedVsMatchTimeAny,
      records.filter((r) => r.scheduleChangedVsMatchTime).length,
    ],
    ['notFreshAny', meta.notFreshAny, records.filter((r) => r.confidence !== 'fresh').length],
    ['pollGapNull', meta.pollGapNull, records.filter((r) => r.pollGapSeconds === null).length],
    [
      'valueCapturedAfterLockAny',
      meta.valueCapturedAfterLockAny,
      records.filter((r) => r.valueCapturedAfterLock).length,
    ],
    [
      'valueCapturedAfterMatchTimeAny',
      meta.valueCapturedAfterMatchTimeAny,
      records.filter((r) => r.valueCapturedAfterMatchTime).length,
    ],
    [
      'lockEarlierThanMatchTime',
      meta.lockEarlierThanMatchTime,
      records.filter((r) => r.matchTimeDriftMs < 0).length,
    ],
    [
      'lockLaterThanMatchTime',
      meta.lockLaterThanMatchTime,
      records.filter((r) => r.matchTimeDriftMs > 0).length,
    ],
    [
      'postStartPollGames',
      meta.postStartPollGames,
      new Set(records.filter((r) => r.closeAfterStart).map((r) => r.gameId)).size,
    ],
  ];
  for (const [name, claimed, actual] of raw) {
    if (claimed !== actual) {
      throw new ScheduleAuditError(
        `meta ${name} says ${claimed} but the records hold ${actual} — truncated or edited?`,
      );
    }
  }
  const range = rederivedAuditLockTimeRange(records);
  if (JSON.stringify(range) !== JSON.stringify(meta.lockTimeRange)) {
    throw new ScheduleAuditError(
      'meta lockTimeRange disagrees with the records — truncated or edited?',
    );
  }
  return { meta, records };
}

/**
 * Build the meta record from the records, using the SAME helpers the reader
 * re-derives with — writer and integrity check cannot drift.
 */
export function closeScheduleAuditMeta(options: {
  network: string;
  toleranceMs: number;
  closesSeen: number;
  gamesJoined: number;
  records: readonly CloseScheduleAuditRecord[];
  generatedAt: string;
}): CloseScheduleAuditMeta {
  const { records } = options;
  return {
    recordType: 'close_schedule_audit_meta',
    network: options.network,
    scheduleChangeToleranceMs: options.toleranceMs,
    closesSeen: options.closesSeen,
    records: records.length,
    gamesJoined: options.gamesJoined,
    verdicts: rederivedVerdicts(records),
    closeAfterStartAny: records.filter((r) => r.closeAfterStart).length,
    scheduleChangedVsMatchTimeAny: records.filter((r) => r.scheduleChangedVsMatchTime).length,
    notFreshAny: records.filter((r) => r.confidence !== 'fresh').length,
    pollGapNull: records.filter((r) => r.pollGapSeconds === null).length,
    valueCapturedAfterLockAny: records.filter((r) => r.valueCapturedAfterLock).length,
    valueCapturedAfterMatchTimeAny: records.filter((r) => r.valueCapturedAfterMatchTime).length,
    lockEarlierThanMatchTime: records.filter((r) => r.matchTimeDriftMs < 0).length,
    lockLaterThanMatchTime: records.filter((r) => r.matchTimeDriftMs > 0).length,
    confidence: rederivedAuditConfidence(records),
    postStartPollBySport: rederivedPostStartBySport(records),
    postStartPollGames: new Set(records.filter((r) => r.closeAfterStart).map((r) => r.gameId)).size,
    lockTimeRange: rederivedAuditLockTimeRange(records),
    generatedAt: options.generatedAt,
  };
}
