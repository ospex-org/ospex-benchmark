import { instantMs, isParseableInstant } from './time.js';
import type { CohortManifestV1 } from './manifest.js';

/**
 * The scheduler's DURABLE halt semantics (docs/CAMPAIGN-ACTIVATION.md §"What the scheduler
 * itself must specify"): a scheduled campaign stops scheduling on any journaled tick
 * outcome outside the healthy set, and on any tick that started and never finished — the
 * unknown-outcome crash shape — until a human resumes it.
 *
 * Cron cannot be trusted to stop itself, so the rule is enforced by the TICK, from the
 * store: every substantive tick journals a two-phase entry (begin → finish with a semantic
 * outcome), and before doing anything else a tick evaluates this rule over the journal and
 * refuses to proceed while it reports halted. That makes the halt durable (it survives
 * restarts and reaches every box that reaches the store), and it makes a journal-write
 * failure safe in the conservative direction: a tick that could not finish its entry
 * leaves exactly the stale unfinished row that halts the schedule until a human looks.
 *
 * The rule, over the entries SINCE THE LAST OPERATOR RESUME (newest first by journal id):
 *   - any tick entry that is unfinished and older than the tick deadline → HALTED
 *     (started, never finished — the crash shape; a fresh unfinished entry is an
 *     in-flight overlapping tick and does not halt);
 *   - the latest FINISHED tick entry's outcome outside `healthyOutcomes` → HALTED —
 *     including any outcome string this build does not know (fail closed: a journal
 *     written by a different build is operator-review territory, never silently healthy);
 *   - otherwise CLEAR. An operator resume bounds the window: entries before it are
 *     history, already reviewed.
 *
 * Two stated bounds. The rule sees the entries it is given (callers read the most recent
 * `SCHEDULE_WINDOW_LIMIT`); an unfinished entry buried deeper than that is outside the
 * schedule window — the escalation latch, not the journal, is the money backstop for an
 * old crashed dispatch (its unresolved fire latches every admission). And a tick that
 * fails before it can write its begin entry leaves no journal trace — such a tick cannot
 * reach a dispatch either (every dispatch path needs the same store), so it is
 * self-limiting and surfaces through its process exit code and monitoring.
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

/** How many journal entries the halt evaluation reads (newest first). */
export const SCHEDULE_WINDOW_LIMIT = 50;

export type ScheduleState =
  | { readonly kind: 'clear' }
  | { readonly kind: 'halted'; readonly why: string };

/**
 * The durable journal seam (implemented over SQL in `store/campaignTickJournal.ts`).
 * `begin` appends an unfinished tick entry and returns its id; `finish` stamps outcome +
 * instant on that entry EXACTLY ONCE (the first finish wins; a later finish changes
 * nothing — so a best-effort loud-failure finish racing nothing can never rewrite a
 * decided outcome); `resume` appends the operator acknowledgment that bounds the halt
 * window; `entries` reads the newest entries first. Every failure rejects.
 */
export interface CampaignTickJournalPort {
  begin(cohortId: string, startedAtIso: string): Promise<number>;
  finish(entryId: number, outcome: CampaignTickOutcome, detail: string | null, finishedAtIso: string): Promise<void>;
  resume(cohortId: string, atIso: string, detail: string | null): Promise<void>;
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
  const ordered = [...entries].sort((a, b) => b.id - a.id);
  const resumeIndex = ordered.findIndex((entry) => entry.kind === 'resume');
  const window = resumeIndex === -1 ? ordered : ordered.slice(0, resumeIndex);

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

  const latestFinished = window.find((entry) => entry.kind === 'tick' && entry.finishedAt !== null);
  if (latestFinished !== undefined && !healthyOutcomes.includes(latestFinished.outcome ?? '')) {
    return {
      kind: 'halted',
      why:
        `tick ${latestFinished.id} finished ${latestFinished.finishedAt} with outcome ` +
        `${JSON.stringify(latestFinished.outcome)} — operator review required before scheduling continues`,
    };
  }
  return { kind: 'clear' };
}
