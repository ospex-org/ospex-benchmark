import { instantMs, isParseableInstant } from './time.js';
import type { CohortManifestV1 } from './manifest.js';

/**
 * The scheduler's DURABLE halt semantics (docs/CAMPAIGN-ACTIVATION.md §"The scheduler
 * contract"): a scheduled campaign stops scheduling on any journaled tick outcome outside
 * the healthy set, and on any tick that started and never finished — the unknown-outcome
 * crash shape — until a human resumes it.
 *
 * Cron cannot be trusted to stop itself, so the rule is enforced by the TICK, from the
 * store: every substantive tick journals a two-phase entry (begin → finish with a
 * semantic outcome), and a tick evaluates this rule before any journal write,
 * authorization read, or latch read, refusing to proceed while it reports halted. That
 * makes the halt durable (it survives restarts and reaches every box that reaches the
 * store), and it makes a journal-write failure safe in the conservative direction: a tick
 * that could not finish its entry leaves the stale unfinished row that halts the schedule
 * once the entry passes the tick deadline — until then it reads as in-flight, so the halt
 * arrives within one deadline, not instantly.
 *
 * The rule, over the entries SINCE THE LAST OPERATOR RESUME (newest first by journal id):
 *   - any tick entry that is unfinished and older than the tick deadline → HALTED
 *     (started, never finished — the crash shape; a fresh unfinished entry is an
 *     in-flight overlapping tick and does not halt);
 *   - ANY finished tick entry's outcome outside `healthyOutcomes` → HALTED — the sweep
 *     covers the whole window, so an overlapping slow tick's failure cannot be buried
 *     under a faster tick's healthy finish — and any outcome string this build does not
 *     know halts too (fail closed: a journal written by a different build is
 *     operator-review territory, never silently healthy);
 *   - otherwise CLEAR. An operator resume bounds the window: entries before it are
 *     history, already reviewed ({@link unreviewedInFlightTick} is what keeps that
 *     premise true — a resume refuses while an in-flight entry's outcome is still
 *     pending).
 *
 * Stated bounds. Callers take the rule's input from the journal's `scheduleWindow` read:
 * the durable latest-resume boundary plus EVERY unfinished tick and EVERY non-healthy
 * finished tick after it, in one snapshot — filtered, deliberately unbounded reads,
 * because a newest-N sample of the raw journal cannot authoritatively decide that no
 * unreviewed halt cause exists (the bounded `entries` read exists for display only).
 * A tick that fails before it can write its begin entry leaves no journal trace — such a
 * tick cannot reach a dispatch either (every dispatch path needs the same store), so it
 * is self-limiting and surfaces through its process exit code and monitoring. Staleness
 * compares the instant the RUNNER wrote at begin against the EVALUATOR's clock: on the
 * single-box cron this build targets, NTP-scale skew disappears into the deadline's slack
 * (a runner clock ahead by S delays crash detection by S; behind, it halts early — the
 * conservative direction).
 */

/** One journal row, as read back. `outcome` is deliberately a plain string on the read
 *  side: an outcome written by a NEWER build must reach the halt rule (which fails closed
 *  on anything it does not recognize), never break the read. */
export interface ScheduleEntry {
  /** The append-order authority (the journal's monotonically increasing id). */
  readonly id: number;
  readonly kind: 'tick' | 'resume';
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: string | null;
  readonly detail: string | null;
}

/** The semantic outcomes THIS build's tick can journal. `validated_refused` is the healthy
 *  outcome while activation is structurally disabled; the activation flip replaces it in
 *  {@link HEALTHY_TICK_OUTCOMES} with the real dispatched outcome. */
export type CampaignTickOutcome =
  | 'validated_refused'
  | 'no_live_authorization'
  | 'publication_refused'
  | 'escalation_latched'
  | 'loud_failure';

/** A resume row's outcome value. */
export const OPERATOR_RESUMED = 'operator_resumed';

/** The outcomes a scheduler may follow with another tick. Everything else halts. */
export const HEALTHY_TICK_OUTCOMES: readonly string[] = Object.freeze(['validated_refused']);

/** How many journal entries the bounded DISPLAY read returns (newest first). Display
 *  only: the halt evaluation reads the unbounded `scheduleWindow`, never this. */
export const SCHEDULE_WINDOW_LIMIT = 50;

export type ScheduleState =
  | { readonly kind: 'clear' }
  | { readonly kind: 'halted'; readonly why: string };

/** The authoritative halt-rule input: the journal frontier the review witnessed (`max`
 *  entry id for the cohort, 0 when empty) and the COMPLETE halt-relevant entry set — the
 *  latest resume boundary row plus every unfinished tick and every non-healthy finished
 *  tick after it, read in one snapshot. */
export interface ScheduleWindow {
  readonly frontierId: number;
  readonly entries: readonly ScheduleEntry[];
}

/**
 * The durable journal seam (implemented over SQL in `store/campaignTickJournal.ts`).
 * `begin` appends an unfinished tick entry and returns its id; `finish` stamps outcome +
 * instant on that entry EXACTLY ONCE (the first finish wins; a later finish changes
 * nothing — so a best-effort loud-failure finish racing nothing can never rewrite a
 * decided outcome); `scheduleWindow` reads the authoritative halt-rule input (see
 * {@link ScheduleWindow} — filtered and unbounded, because a newest-N sample of the raw
 * journal cannot authoritatively decide that no unreviewed halt cause exists);
 * `resume` is the CONDITIONAL operator acknowledgment — it commits only while the journal
 * frontier still equals the exact `expectedFrontierId` the operator's review read, and
 * `begin`/`resume` serialize on one per-cohort lock, so a tick can never slip below a
 * resume boundary unseen; `entries` is a bounded newest-first read for DISPLAY only.
 * Every failure rejects.
 */
export interface CampaignTickJournalPort {
  begin(cohortId: string, startedAtIso: string): Promise<number>;
  finish(entryId: number, outcome: CampaignTickOutcome, detail: string | null, finishedAtIso: string): Promise<void>;
  resume(cohortId: string, atIso: string, detail: string | null, expectedFrontierId: number): Promise<'resumed' | 'frontier_moved'>;
  scheduleWindow(cohortId: string, healthyOutcomes: readonly string[]): Promise<ScheduleWindow>;
  entries(cohortId: string, limit: number): Promise<readonly ScheduleEntry[]>;
}

/**
 * The serial worst case a single tick is allowed to take before an unfinished journal
 * entry reads as a crash: every dispatch the tick may admit, every arm of each, every
 * repair of each arm, at the pinned per-call timeout — plus a fixed slack for everything
 * that is not a provider call. Derived from the booted manifest so the bound moves with
 * the campaign's own pins, never a free constant at the call site.
 */
export const TICK_DEADLINE_SLACK_MS = 600_000;

export function tickDeadlineMs(manifest: CohortManifestV1): number {
  const { maxDispatchesPerTick, maxRepairAttemptsPerArm, providerCallTimeoutMs } = manifest.constants;
  const rosterSize = manifest.expectedArmRoster.length;
  const worstCaseCalls = maxDispatchesPerTick * rosterSize * (1 + maxRepairAttemptsPerArm);
  const deadline = worstCaseCalls * providerCallTimeoutMs + TICK_DEADLINE_SLACK_MS;
  if (!Number.isSafeInteger(deadline) || deadline <= 0) {
    throw new Error(`tick deadline does not derive to a positive safe integer (${deadline})`);
  }
  return deadline;
}

/**
 * Evaluate the halt rule. Pure; the entries may arrive in any order (the journal id is
 * the append-order authority and is re-sorted here). Fails CLOSED on anything it cannot
 * read: a non-finite clock throws; an entry whose `startedAt` does not parse halts.
 */
export function resolveScheduleState(input: {
  entries: readonly ScheduleEntry[];
  nowMs: number;
  deadlineMs: number;
  healthyOutcomes: readonly string[];
}): ScheduleState {
  const { entries, nowMs, deadlineMs, healthyOutcomes } = input;
  if (!Number.isFinite(nowMs)) {
    throw new Error('the schedule halt rule requires a finite clock reading — a non-finite reading fails closed');
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new Error(`the schedule halt rule requires a positive tick deadline, got ${deadlineMs}`);
  }
  const window = windowSinceLastResume(entries);

  // ANY stale unfinished tick in the window halts — not just the latest entry, so a
  // crashed tick buried under later healthy ticks still surfaces for review.
  for (const entry of window) {
    if (entry.kind !== 'tick' || entry.finishedAt !== null) continue;
    if (!isParseableInstant(entry.startedAt)) {
      return {
        kind: 'halted',
        why: `journal entry ${entry.id} carries an unreadable start instant ${JSON.stringify(entry.startedAt)} — unknown outcome`,
      };
    }
    const ageMs = nowMs - instantMs(entry.startedAt);
    if (ageMs >= deadlineMs) {
      return {
        kind: 'halted',
        why:
          `tick ${entry.id} started ${entry.startedAt} and never finished within the tick deadline ` +
          `(${deadlineMs} ms) — unknown outcome`,
      };
    }
  }

  // ANY finished tick outcome in the window outside the healthy set halts — newest first,
  // so the reported entry is the most recent violation. A latest-only check would let an
  // overlapping slow tick's failure be buried forever under a faster tick's healthy
  // finish; every outcome in the window gets reviewed, whatever order it landed in.
  for (const entry of window) {
    if (entry.kind !== 'tick' || entry.finishedAt === null) continue;
    if (!healthyOutcomes.includes(entry.outcome ?? '')) {
      return {
        kind: 'halted',
        why:
          `tick ${entry.id} finished ${entry.finishedAt} with outcome ` +
          `${JSON.stringify(entry.outcome)} — operator review required before scheduling continues`,
      };
    }
  }
  return { kind: 'clear' };
}

function windowSinceLastResume(entries: readonly ScheduleEntry[]): readonly ScheduleEntry[] {
  const ordered = [...entries].sort((a, b) => b.id - a.id);
  const resumeIndex = ordered.findIndex((entry) => entry.kind === 'resume');
  return resumeIndex === -1 ? ordered : ordered.slice(0, resumeIndex);
}

/**
 * The window's IN-FLIGHT unfinished tick, if any: an entry whose outcome does not exist
 * yet and therefore cannot have been reviewed. `campaign:resume` refuses while one exists —
 * a resume row appended now would bound that entry out of the halt window forever, so its
 * eventual crash or failure could never halt the schedule. An unfinished entry whose
 * start instant cannot be read counts as in-flight (fail closed: its age cannot prove it
 * stale); an entry at or past the deadline is the stale crash shape — already a halt
 * cause the operator is reviewing, so it does not block the resume that acknowledges it.
 * Stated bound: a tick that outlives its deadline and finishes later lands before the
 * resume boundary — the deadline is the operating contract for how long a tick may run.
 */
export function unreviewedInFlightTick(input: {
  entries: readonly ScheduleEntry[];
  nowMs: number;
  deadlineMs: number;
}): ScheduleEntry | null {
  const { entries, nowMs, deadlineMs } = input;
  if (!Number.isFinite(nowMs)) {
    throw new Error('the in-flight check requires a finite clock reading — a non-finite reading fails closed');
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new Error(`the in-flight check requires a positive tick deadline, got ${deadlineMs}`);
  }
  for (const entry of windowSinceLastResume(entries)) {
    if (entry.kind !== 'tick' || entry.finishedAt !== null) continue;
    if (!isParseableInstant(entry.startedAt)) return entry; // unreadable age: fail closed, in-flight
    if (nowMs - instantMs(entry.startedAt) < deadlineMs) return entry;
  }
  return null;
}
