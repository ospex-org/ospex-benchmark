import { z } from 'zod';
import {
  closeAfterStart,
  closeTiming,
  closeValueAfterLock,
  POLL_GAP_COHERENCE_TOLERANCE_MS,
} from './closeTiming.js';
import { CLOSE_SOURCE } from './closeSource.js';
import { instantMs } from './time.js';
import { isScheduleChanged, scheduleDriftMs, SCHEDULE_CHANGE_TOLERANCE_MS } from './scoring.js';
import { closeQuoteFromRow } from './scoring.js';
import type { ClosingLineRow, GamesTableRow } from './types.js';

/**
 * Close-schedule audit dataset contract
 * (out/close-schedule-audit-*.ndjson): what the production-captured closing
 * lines actually look like under the scorer's close-timing checks, measured
 * over an observed lower-bound enumeration of the captured corpus rather
 * than over one run's picks.
 *
 * It answers three questions the scorer cannot answer from a single run:
 * how many captured closes the odds feed was still quoting after their own
 * recorded lock; how many have a lock that disagrees with the schedule row
 * they were copied from; and how the first is distributed across sports and
 * confidence classes.
 *
 * THREE REFERENCE TIMES, deliberately kept distinct:
 *
 * - The SCORER's `scheduleChanged` compares a close's `lock_time` against
 *   the FROZEN BUNDLE start the model actually saw (`SourceGame.startUtc`).
 *   That reference exists only inside a run file.
 * - This AUDIT has no run file, so it compares `lock_time` against the
 *   CURRENT schedule row (`games.match_time`) and reports the result under
 *   its own name, `scheduleChangedVsMatchTime`. Same classifier, same
 *   tolerance, DIFFERENT reference — the two numbers must never be read as
 *   the same measurement.
 * - It ALSO compares against `games.earliest_match_time`, the MONOTONE
 *   FLOOR, as `scheduleChangedVsEarliestMatchTime`.
 *
 * WHY BOTH, RATHER THAN REPLACING `match_time`. They answer different
 * questions and neither subsumes the other.
 *
 * `match_time` is mutable in BOTH directions, and it is the value
 * `lock_time` was copied from at capture — so comparing against it asks
 * "does this close still agree with the schedule row as it stands now?".
 * That is the right question for detecting that the row moved after
 * capture, but it makes a correctly-captured close look wrong after a
 * ROLLBACK: capture at an accepted earlier start, the feed later walks the
 * start back up, and the close now disagrees with a row it matched exactly
 * when it was written.
 *
 * The floor never rises, so comparing against it asks "was this close
 * anchored to a start we ever actually believed?" — a rollback cannot turn
 * a correctly-captured close into an apparent mismatch. Where the two
 * verdicts disagree, `scheduleVerdictsDisagree` counts it, and that
 * population is exactly where the mutable reference and the stable one tell
 * different stories.
 *
 * The floor is NULLABLE and a null propagates as null, never as zero drift
 * or as "unchanged" — a missing floor means the comparison was never
 * established. `earliestMatchTimeNull` is its denominator.
 *
 * WHAT NEITHER REFERENCE CAN SEE. `lock_time` is copied from
 * `games.match_time` at capture, so when a start moved earlier and the
 * upstream capture never noticed, the lock, the schedule row, AND the floor
 * are all the same wrong instant, and both drifts read as zero. The floor
 * fixes the rollback blind spot; it does not fix this one, because the
 * floor can only ever record starts the writer observed. The post-start-poll
 * count is the only signal here that does not come from the schedule record
 * itself — it comes from the feed's own behaviour — and even it cannot
 * distinguish "the game had not started" from "the feed quotes in-play".
 * Establishing real first pitch needs an independent source (the on-chain
 * contest start served by the public read API, or a league schedule feed);
 * this audit measures what is reachable from the public anon read path and
 * says so.
 *
 * Completeness posture (identical to the totals extraction): the CLAIMED
 * source table is enumerated directly by keyset pagination on its identity
 * key — never via a pre-enumerated game list, which would silently hide
 * closes whose games row is missing or unexpected. Games are then looked up
 * by pinned ids. Every close seen is accounted for by an EXCLUSIVE verdict,
 * a close with no games row or an unclassifiable timestamp refuses the
 * whole snapshot, and the reader re-checks that arithmetic on every load.
 *
 * THE LIMIT OF THAT ARITHMETIC, stated because it is easy to over-read: the
 * reader's checks prove the file is internally consistent and untruncated,
 * NOT that the enumeration covered the table. `closesSeen` comes from the
 * same fetch the records do, so a walk that silently narrowed its filter
 * would produce a smaller, perfectly self-verifying snapshot. Two things
 * cover that instead — the walker's own market-filter behaviour is unit
 * tested, and the `markets` histogram is published so a narrowed walk is
 * visible in the artifact (an unnarrowed audit reports all three markets).
 */

/**
 * What the enumeration behind an artifact actually guarantees, carried IN the
 * artifact so a retained NDJSON is self-describing.
 *
 * A reader who has only the file — not the console output that produced it —
 * would otherwise see authoritative-looking counts with no indication that the
 * walk cannot prove it observed every committed row. Identity is allocated
 * before commit, so a transaction holding a low id can commit after the cursor
 * has passed it; over the public anon REST path there is no snapshot to close
 * that gap. The counts are a LOWER BOUND, and the file now says so in a field
 * a machine can check.
 */
export const AUDIT_ENUMERATION_SEMANTICS = 'keyset-lower-bound-non-snapshot-v1';

export class ScheduleAuditError extends Error {}

/**
 * The completeness disclosure the CLI prints and the artifact's
 * `enumerationSemantics` field encodes. Exported so the wording itself is
 * pinned by a test: it is the only place a reader of the console output learns
 * that these counts are a lower bound, and quietly reverting it to a
 * completeness claim would otherwise be invisible.
 */
export const AUDIT_COMPLETENESS_DISCLOSURE =
  'COMPLETENESS: the rows above are what ONE keyset walk over closing_lines.id observed. ' +
  'Paging by identity key rules out the offset-pagination failure — a concurrent insert ' +
  'shifting page boundaries so one row duplicates and another drops — and the walk refuses ' +
  'a non-increasing id. It does NOT prove the enumeration saw every committed row: identity ' +
  'is allocated before commit, so a transaction holding a LOW id can commit after the ' +
  'cursor has already passed it, and that row is missed. Reading this over the public anon ' +
  'REST path there is no transaction, no repeatable-read snapshot and no visibility cursor ' +
  'to close that gap, so the guarantee is a non-snapshot lower bound rather than a census. ' +
  `Artifacts stamp this as enumerationSemantics=${AUDIT_ENUMERATION_SEMANTICS}. ` +
  'Treat these counts as a lower bound on the corpus, and re-run if a figure is load-bearing.';

/**
 * Refuse an empty corpus BEFORE anything is written.
 *
 * "0 closes, 0 problems" is the most dangerous possible clean bill of health: a
 * zero-row walk is indistinguishable from one whose filter silently narrowed to
 * nothing. Pure and exported so the CLI's refusal is testable without running
 * the CLI — `auditCloses.ts` executes `main()` on import, so the guard cannot
 * be reached there.
 */
export function assertNonEmptyCorpus(closeCount: number, network: string): void {
  if (closeCount > 0) return;
  throw new ScheduleAuditError(
    `no closing lines found on network "${network}" from source "${CLOSE_SOURCE}" — ` +
      'refusing to certify an empty corpus. Check the network and source filters and that the ' +
      'public read path is reachable',
  );
}

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
    /**
     * Provenance, carried per record so the artifact can be checked against
     * the corpus it claims to describe. Previously the network lived only in
     * meta, where it was whatever the CALLER asked for — an audit run as
     * "polygon" over another network's rows produced a clean-looking artifact
     * stamped polygon. The reader re-checks both against meta.
     */
    network: z.string().min(1),
    // A LITERAL, not a free string. Record-vs-meta agreement alone is not
    // enough: rewriting meta AND every record together to another feed left a
    // globally rebranded artifact that still validated. Binding the format to
    // the canonical source makes that rewrite unparseable.
    source: z.literal(CLOSE_SOURCE),
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
    /** The MONOTONE FLOOR, or null when the games row carries none. */
    gameEarliestMatchTime: z.union([z.string().min(1), z.null()]),
    /** Signed `lockTime - gameEarliestMatchTime` in ms; null iff no floor. */
    earliestMatchTimeDriftMs: z.union([z.number(), z.null()]),
    scheduleChangedVsEarliestMatchTime: z.union([z.boolean(), z.null()]),
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
    /** The one feed every close in this corpus came from; every record must
     *  agree with it, so a mixed-source blend cannot hide behind an average. */
    closeSource: z.literal(CLOSE_SOURCE),
    /** See {@link AUDIT_ENUMERATION_SEMANTICS} — a literal, so an artifact
     *  cannot quietly re-describe itself as complete. */
    enumerationSemantics: z.literal(AUDIT_ENUMERATION_SEMANTICS),
    scheduleChangeToleranceMs: z.number().int().nonnegative(),
    /** Closing lines OBSERVED on the network by this walk, all markets — a
     *  lower bound on the table, not a census. See `enumerationSemantics`. */
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
    /** The same schedule-change count taken against the MONOTONE FLOOR instead
     *  of the mutable `match_time`. Published beside, never instead of, the
     *  `…VsMatchTime` figure — they answer different questions. */
    scheduleChangedVsEarliestMatchTimeAny: z.number().int().nonnegative(),
    /** Records whose games row carried NO floor, so the floor comparison was
     *  not established. The denominator for the count above. */
    earliestMatchTimeNull: z.number().int().nonnegative(),
    /** Records where the two references DISAGREE about whether the schedule
     *  changed — the population where a rollback or a post-capture move makes
     *  the mutable reference tell a different story from the stable one. */
    scheduleVerdictsDisagree: z.number().int().nonnegative(),
    confidence: z.record(z.string(), z.number().int().nonnegative()),
    /**
     * Rows per market. Published because it is the one field in which an
     * incomplete ENUMERATION is visible to a reader: every other count is
     * derived from the same fetch, so a walk that silently narrowed to one
     * market would self-verify. An unnarrowed audit reports all three
     * markets; a single key here means the walk was filtered.
     */
    markets: z.record(z.string(), z.number().int().nonnegative()),
    /** Sports of the games carrying a post-start-poll close. */
    postStartPollBySport: z.record(z.string(), z.number().int().nonnegative()),
    postStartPollGames: z.number().int().nonnegative(),
    lockTimeRange: z.union([z.tuple([z.string(), z.string()]), z.null()]),
    generatedAt: z.string().min(1),
  })
  .strict();

export type CloseScheduleAuditRecord = z.infer<typeof closeScheduleAuditRecordSchema>;
export type CloseScheduleAuditMeta = z.infer<typeof closeScheduleAuditMetaSchema>;

/**
 * Strictly ordered comparison between two instants, at the shared
 * second-granularity tolerance.
 *
 * Both sides go through the repo's canonical `instantMs`, which REJECTS a
 * timestamp carrying no explicit offset. The previous version used bare
 * `Date.parse` and returned `false` when either side failed to parse — so a row
 * whose timestamps could not be read was published as "not after", i.e. clean,
 * and an unclassifiable row was certified. An unreadable comparison is now a
 * refusal, matching every other unclassifiable case in this builder.
 */
function afterStrict(label: string, a: string | null, b: string): boolean {
  if (a === null) return false;
  let left: number;
  let right: number;
  try {
    left = instantMs(a);
    right = instantMs(b);
  } catch (err) {
    throw new ScheduleAuditError(
      `${label}: cannot compare "${a}" against "${b}" — ${(err as Error).message}`,
    );
  }
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
/**
 * The RAW, unjudged half of an audit record — the evidence. Every other field
 * is a pure function of these, which is what lets the reader recompute a
 * record instead of trusting it.
 */
export interface CloseScheduleAuditEvidence {
  gameId: string;
  market: 'moneyline' | 'spread' | 'total';
  confidence: 'fresh' | 'stale' | 'missing';
  lockTime: string;
  valueCapturedAt: string | null;
  lastPolledAt: string | null;
  pollGapSeconds: number | null;
  gameMatchTime: string;
  /**
   * `games.earliest_match_time` — the MONOTONE FLOOR, or null when the row
   * carries none. See the "THIRD REFERENCE TIME" note in the module header for
   * why it is reported ALONGSIDE `gameMatchTime` rather than replacing it.
   */
  gameEarliestMatchTime: string | null;
}

/** The JUDGED half. Field-for-field what {@link deriveCloseScheduleAuditFields} returns. */
export interface CloseScheduleAuditDerived {
  matchTimeDriftMs: number;
  scheduleChangedVsMatchTime: boolean;
  /**
   * Signed `lockTime - gameEarliestMatchTime` in ms, or null when the row has
   * no floor. NULL IS NOT ZERO: a missing floor means the comparison was never
   * established, and reporting it as zero drift would manufacture agreement.
   */
  earliestMatchTimeDriftMs: number | null;
  /** Same classifier and tolerance as `scheduleChangedVsMatchTime`, against the
   *  floor. Null exactly when `earliestMatchTimeDriftMs` is null. */
  scheduleChangedVsEarliestMatchTime: boolean | null;
  closeAfterStart: boolean;
  valueCapturedAfterLock: boolean;
  valueCapturedAfterMatchTime: boolean;
  verdict: CloseAuditVerdict;
}

/** The derived keys, listed once so the reader's re-check is exhaustive by
 *  construction — adding a derived field without verifying it becomes a type
 *  error rather than a silent gap in the verification. */
export const CLOSE_SCHEDULE_AUDIT_DERIVED_KEYS = [
  'matchTimeDriftMs',
  'scheduleChangedVsMatchTime',
  'earliestMatchTimeDriftMs',
  'scheduleChangedVsEarliestMatchTime',
  'closeAfterStart',
  'valueCapturedAfterLock',
  'valueCapturedAfterMatchTime',
  'verdict',
] as const satisfies ReadonlyArray<keyof CloseScheduleAuditDerived>;

/**
 * Derive every judged field of an audit record from its raw evidence.
 *
 * ONE implementation, used by the writer AND the reader — that is the whole
 * point. The reader recomputes each record from the record's own timestamps
 * and refuses on any disagreement, so an artifact edited to say
 * `valueCapturedAfterLock: false` while its `valueCapturedAt` says otherwise
 * no longer parses. Two separate implementations could drift, and the
 * verification would then be checking a copy of the bug.
 */
export function deriveCloseScheduleAuditFields(
  evidence: CloseScheduleAuditEvidence,
  toleranceMs: number,
): CloseScheduleAuditDerived {
  const where = `close ${evidence.gameId}:${evidence.market}`;
  const driftMs = scheduleDriftMs(evidence.lockTime, evidence.gameMatchTime);
  if (driftMs === null) {
    throw new ScheduleAuditError(
      `${where} has an unparseable lock_time ("${evidence.lockTime}") or ` +
        `games.match_time ("${evidence.gameMatchTime}") — refusing an unclassifiable snapshot`,
    );
  }
  const changed = isScheduleChanged(driftMs, toleranceMs);
  if (changed === null) {
    throw new ScheduleAuditError(
      `${where} produced an undeterminable schedule verdict — refusing an unclassifiable snapshot`,
    );
  }
  // Timing evidence is validated before any timing verdict is derived from it.
  // Same posture as the two refusals above — an unclassifiable row aborts the
  // audit rather than being published with a verdict nothing established.
  // `afterStrict` used to answer this by turning an unparseable instant into
  // `false`, so a row we could not read was reported clean.
  const timing = closeTiming({
    lockTime: evidence.lockTime,
    valueCapturedAt: evidence.valueCapturedAt,
    lastPolledAt: evidence.lastPolledAt,
    pollGapSeconds: evidence.pollGapSeconds,
    confidence: evidence.confidence,
  });
  if (timing.kind === 'unusable') {
    throw new ScheduleAuditError(
      `${where} has unusable timing evidence (${timing.violations.join('; ')}) — ` +
        'refusing an unclassifiable snapshot',
    );
  }
  // THE FLOOR COMPARISON IS ADDITIVE — it does not touch driftMs, `changed`,
  // or the verdict. Every existing number in this artifact keeps its exact
  // meaning; the floor is published beside them, not in place of them.
  //
  // A null floor propagates as null rather than refusing the snapshot, which is
  // the one place this differs from `gameMatchTime` above. `match_time` is
  // NOT NULL and a close cannot exist without one, so an unparseable value
  // there is corruption. The floor is legitimately nullable, so absence is an
  // ordinary state and must not abort an otherwise-classifiable audit.
  let earliestDriftMs: number | null = null;
  let changedVsEarliest: boolean | null = null;
  if (evidence.gameEarliestMatchTime !== null) {
    earliestDriftMs = scheduleDriftMs(evidence.lockTime, evidence.gameEarliestMatchTime);
    if (earliestDriftMs === null) {
      throw new ScheduleAuditError(
        `${where} has an unparseable games.earliest_match_time ` +
          `("${evidence.gameEarliestMatchTime}") — refusing an unclassifiable snapshot`,
      );
    }
    changedVsEarliest = isScheduleChanged(earliestDriftMs, toleranceMs);
    if (changedVsEarliest === null) {
      throw new ScheduleAuditError(
        `${where} produced an undeterminable floor schedule verdict — ` +
          'refusing an unclassifiable snapshot',
      );
    }
  }

  const postStart = closeAfterStart(timing);
  const notFresh = evidence.confidence !== 'fresh';
  return {
    matchTimeDriftMs: driftMs,
    scheduleChangedVsMatchTime: changed,
    earliestMatchTimeDriftMs: earliestDriftMs,
    scheduleChangedVsEarliestMatchTime: changedVsEarliest,
    closeAfterStart: postStart,
    valueCapturedAfterLock: closeValueAfterLock(timing),
    valueCapturedAfterMatchTime: afterStrict(
      `${where} value_captured_at vs games.match_time`,
      evidence.valueCapturedAt,
      evidence.gameMatchTime,
    ),
    verdict: notFresh
      ? 'not_fresh'
      : postStart
        ? 'post_start_poll'
        : changed
          ? 'schedule_changed'
          : 'clean',
  };
}

/**
 * Do the two schedule references DISAGREE about this close?
 *
 * ONE definition, used by the writer's counter and the reader's re-check, for
 * the same reason `deriveCloseScheduleAuditFields` is shared: two copies could
 * drift and the verification would then be checking a copy of the bug.
 *
 * A row with no floor is NOT a disagreement — nothing was established to
 * disagree with.
 */
export function scheduleVerdictsDisagree(record: {
  scheduleChangedVsMatchTime: boolean;
  scheduleChangedVsEarliestMatchTime: boolean | null;
}): boolean {
  if (record.scheduleChangedVsEarliestMatchTime === null) return false;
  return record.scheduleChangedVsMatchTime !== record.scheduleChangedVsEarliestMatchTime;
}

export function closeScheduleAuditRecord(
  close: ClosingLineRow,
  game: GamesTableRow,
  toleranceMs: number = SCHEDULE_CHANGE_TOLERANCE_MS,
): CloseScheduleAuditRecord {
  const evidence: CloseScheduleAuditEvidence = {
    gameId: close.jsonodds_id,
    market: close.market,
    confidence: close.confidence,
    lockTime: close.lock_time,
    valueCapturedAt: close.value_captured_at,
    lastPolledAt: close.last_polled_at,
    pollGapSeconds: close.poll_gap_seconds,
    gameMatchTime: game.match_time,
    gameEarliestMatchTime: game.earliest_match_time,
  };
  return {
    recordType: 'close_schedule_audit',
    // Provenance travels WITH the record. Without it the artifact cannot be
    // checked against the corpus it claims to describe — meta carried a
    // caller-supplied network and the records carried no identity at all.
    network: close.network,
    // The canonical literal, not `close.source`. The builder refuses any row
    // whose source differs before reaching here, so the two are equal by
    // construction — writing the constant makes the artifact's binding to it
    // explicit rather than incidental.
    source: CLOSE_SOURCE,
    sport: game.sport,
    ...evidence,
    ...deriveCloseScheduleAuditFields(evidence, toleranceMs),
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

/** Rows per market, re-derived from the records themselves. */
export function rederivedAuditMarkets(
  records: readonly CloseScheduleAuditRecord[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    counts[record.market] = (counts[record.market] ?? 0) + 1;
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
  // A META-ONLY dataset is empty too, and that was the dangerous case: the
  // previous check caught only a zero-byte string, so an artifact reporting
  // `closesSeen: 0` with no records parsed clean and read as "audited the
  // corpus, found nothing wrong". A zero-row walk is indistinguishable from a
  // walk whose filter silently narrowed to nothing, so it certifies nothing.
  // The CLI refuses the same condition before writing, which is what stops it
  // emitting an artifact its own verifier would reject.
  if (lines.length === 1) {
    throw new ScheduleAuditError(
      'audit dataset carries meta but no records — an empty corpus certifies nothing ' +
        'and must not be read as a clean one',
    );
  }
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
  // RECOMPUTE, do not trust. Every judged field of every record is re-derived
  // from that record's OWN raw timestamps and compared.
  //
  // Without this the reader only checked that the aggregates agreed with the
  // records — so editing one record's `valueCapturedAfterLock` to `false` and
  // leaving its timestamps untouched produced a file that verified perfectly,
  // because the aggregates were themselves recomputed from the edited flag.
  // The evidence and the verdict are now cross-checked against each other, by
  // the same function that wrote them.
  //
  // Identity is re-checked here too: a record from another network or another
  // feed cannot sit inside an artifact that claims this one.
  for (const record of records) {
    if (record.network !== meta.network) {
      throw new ScheduleAuditError(
        `record ${record.gameId}:${record.market} is on network "${record.network}" but the ` +
          `dataset claims "${meta.network}" — truncated or edited?`,
      );
    }
    if (record.source !== meta.closeSource) {
      throw new ScheduleAuditError(
        `record ${record.gameId}:${record.market} came from source "${record.source}" but the ` +
          `dataset claims "${meta.closeSource}" — truncated or edited?`,
      );
    }
    const derived = deriveCloseScheduleAuditFields(record, meta.scheduleChangeToleranceMs);
    for (const key of CLOSE_SCHEDULE_AUDIT_DERIVED_KEYS) {
      if (record[key] !== derived[key]) {
        throw new ScheduleAuditError(
          `record ${record.gameId}:${record.market} says ${key}=${JSON.stringify(record[key])} ` +
            `but its own evidence derives ${JSON.stringify(derived[key])} — truncated or edited?`,
        );
      }
    }
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
  const markets = rederivedAuditMarkets(records);
  for (const key of new Set([...Object.keys(markets), ...Object.keys(meta.markets)])) {
    if ((markets[key] ?? 0) !== (meta.markets[key] ?? 0)) {
      throw new ScheduleAuditError(
        `meta market histogram disagrees with the records at "${key}" — truncated or edited?`,
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
    [
      'scheduleChangedVsEarliestMatchTimeAny',
      meta.scheduleChangedVsEarliestMatchTimeAny,
      // `=== true` states the intent: this counts ESTABLISHED changes, and a
      // null is "not established" rather than "unchanged". For `boolean|null`
      // a truthiness filter yields the same number, so this is explicitness
      // rather than a behavioural guard — the guard that does carry weight is
      // `earliestMatchTimeNull`, which publishes the denominator so the count
      // cannot be read as if every row had been compared.
      records.filter((r) => r.scheduleChangedVsEarliestMatchTime === true).length,
    ],
    [
      'earliestMatchTimeNull',
      meta.earliestMatchTimeNull,
      records.filter((r) => r.gameEarliestMatchTime === null).length,
    ],
    [
      'scheduleVerdictsDisagree',
      meta.scheduleVerdictsDisagree,
      records.filter(scheduleVerdictsDisagree).length,
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
 * Assemble a whole audit snapshot from the two fetched row sets — the pure
 * core of `yarn audit:closes`, kept out of the CLI so its REFUSALS are
 * reachable from tests rather than only from a live run.
 *
 * Three refusals, all of them "rather than publish a number that is a
 * guess":
 *
 * - duplicate `(game, market)` closes — `(network, jsonodds_id, market)` is
 *   unique upstream, so a duplicate means the source is not what this audit
 *   thinks it is enumerating;
 * - a close with no `games` row — it has no reference time at all, so every
 *   schedule count below it would be invented;
 * - an unparseable timestamp — refused inside `closeScheduleAuditRecord`.
 *
 * JOIN KEY: `(network, jsonodds_id)`. Callers pass rows already scoped to
 * one network, and `games` is keyed on that pair, so the lookup cannot fan
 * out. `contest_id` is never read on either side: it carries residue from an
 * earlier deployment epoch, and grouping on it would silently mix two
 * different contest-id spaces.
 */
export function buildCloseScheduleAudit(options: {
  network: string;
  toleranceMs: number;
  closes: readonly ClosingLineRow[];
  games: readonly GamesTableRow[];
  generatedAt: string;
}): CloseScheduleAuditDataset {
  const { closes, games } = options;

  // IDENTITY BINDING, asserted before anything is measured.
  //
  // The fetcher filters on network and source server-side, but the artifact is
  // built HERE — and this is where a hand-assembled, replayed, or
  // cross-network dataset enters. Without these checks the builder accepts
  // rows from another network or another feed and then stamps the CALLER's
  // requested network into the artifact's meta, so the audit certifies a
  // corpus it never examined. The network is a property of the ROWS; the
  // caller's request is only a request until the rows agree with it.
  const foreignClose = closes.find((close) => close.network !== options.network);
  if (foreignClose !== undefined) {
    throw new ScheduleAuditError(
      `closing line ${foreignClose.jsonodds_id}:${foreignClose.market} is on network ` +
        `"${foreignClose.network}" but the audit was requested for "${options.network}" — ` +
        'refusing a cross-network snapshot',
    );
  }
  const foreignSource = closes.find((close) => close.source !== CLOSE_SOURCE);
  if (foreignSource !== undefined) {
    throw new ScheduleAuditError(
      `closing line ${foreignSource.jsonodds_id}:${foreignSource.market} came from source ` +
        `"${foreignSource.source}" but the canonical close source is "${CLOSE_SOURCE}" — ` +
        'refusing a mixed-source snapshot',
    );
  }
  const foreignGame = games.find((game) => game.network !== options.network);
  if (foreignGame !== undefined) {
    throw new ScheduleAuditError(
      `games row ${foreignGame.jsonodds_id} is on network "${foreignGame.network}" but the ` +
        `audit was requested for "${options.network}" — refusing a cross-network snapshot`,
    );
  }

  const keys = new Set(closes.map((close) => `${close.jsonodds_id}:${close.market}`));
  if (keys.size !== closes.length) {
    throw new ScheduleAuditError(
      'duplicate closing-line rows for one (game, market) — refusing the snapshot',
    );
  }
  // Joined on (network, jsonodds_id), never on jsonodds_id alone and never on
  // contest_id — the same rule the rest of the protocol follows, because a
  // deployment epoch reset makes contest ids ambiguous and a bare game id can
  // collide across networks. The binding assertions above already force one
  // network, so this is the join being explicit about its own key rather than
  // relying on an invariant established elsewhere.
  const gameKey = (network: string, jsonoddsId: string): string => `${network}::${jsonoddsId}`;
  const gameById = new Map(games.map((game) => [gameKey(game.network, game.jsonodds_id), game]));
  const orphans = closes.filter(
    (close) => !gameById.has(gameKey(close.network, close.jsonodds_id)),
  );
  if (orphans.length > 0) {
    throw new ScheduleAuditError(
      `${orphans.length} closing line(s) have no games row ` +
        `(first: ${orphans[0]?.jsonodds_id ?? ''}) — refusing an unclassifiable snapshot`,
    );
  }

  const records: CloseScheduleAuditRecord[] = [];
  for (const close of closes) {
    const game = gameById.get(gameKey(close.network, close.jsonodds_id));
    if (game === undefined) {
      throw new ScheduleAuditError('unreachable: orphan closes were refused above');
    }
    records.push(closeScheduleAuditRecord(close, game, options.toleranceMs));
  }
  records.sort((a, b) =>
    a.lockTime === b.lockTime
      ? `${a.gameId}:${a.market}`.localeCompare(`${b.gameId}:${b.market}`)
      : a.lockTime.localeCompare(b.lockTime),
  );

  const meta = closeScheduleAuditMeta({
    network: options.network,
    toleranceMs: options.toleranceMs,
    // Derived from the SAME array the records came from: `closesSeen` is the
    // enumeration's own claim, and the reader checks it against `records`.
    closesSeen: closes.length,
    gamesJoined: games.length,
    records,
    generatedAt: options.generatedAt,
  });
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
    closeSource: CLOSE_SOURCE,
    enumerationSemantics: AUDIT_ENUMERATION_SEMANTICS,
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
    // `=== true` states the intent — established changes only. See the
    // reader's matching re-check for why this is explicitness, not a guard.
    scheduleChangedVsEarliestMatchTimeAny: records.filter(
      (r) => r.scheduleChangedVsEarliestMatchTime === true,
    ).length,
    earliestMatchTimeNull: records.filter((r) => r.gameEarliestMatchTime === null).length,
    scheduleVerdictsDisagree: records.filter(scheduleVerdictsDisagree).length,
    confidence: rederivedAuditConfidence(records),
    markets: rederivedAuditMarkets(records),
    postStartPollBySport: rederivedPostStartBySport(records),
    postStartPollGames: new Set(records.filter((r) => r.closeAfterStart).map((r) => r.gameId)).size,
    lockTimeRange: rederivedAuditLockTimeRange(records),
    generatedAt: options.generatedAt,
  };
}
