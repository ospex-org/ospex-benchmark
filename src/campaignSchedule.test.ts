import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HEALTHY_TICK_OUTCOMES,
  OPERATOR_RESUMED,
  SCHEDULE_WINDOW_LIMIT,
  resolveScheduleState,
  tickDeadlineMs,
  unreviewedInFlightTick,
} from './campaignSchedule.js';
import type { ScheduleEntry } from './campaignSchedule.js';
import { buildCampaignManifest } from './campaignProfile.js';
import { cohortBoot } from './cohortBoot.js';

/**
 * The pure schedule halt rule: the healthy set, the stale-unfinished (crash) shape at its
 * exact boundary, the buried-crash sweep (ANY stale unfinished entry in the window, not
 * just the latest), the operator-resume window bound, fail-closed handling of unknown
 * outcomes and unreadable instants, order-independence, and the manifest-derived tick
 * deadline. Every case names the single behaviour that distinguishes it.
 */

const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const DEADLINE = 3_000_000; // the default campaign build's own deadline, asserted below

function entry(over: Partial<ScheduleEntry> & { id: number }): ScheduleEntry {
  return {
    kind: 'tick',
    startedAt: '2026-08-05T00:00:00.000Z',
    finishedAt: '2026-08-05T00:01:00.000Z',
    outcome: 'dispatched',
    detail: null,
    ...over,
  };
}

function resolve(entries: readonly ScheduleEntry[], nowMs: number = NOW) {
  return resolveScheduleState({ entries, nowMs, deadlineMs: DEADLINE, healthyOutcomes: HEALTHY_TICK_OUTCOMES });
}

test('the healthy set of THIS build is exactly the dispatched outcome — anything else halts for review', () => {
  assert.deepEqual([...HEALTHY_TICK_OUTCOMES], ['dispatched']);
  assert.equal(SCHEDULE_WINDOW_LIMIT, 50);
  assert.equal(OPERATOR_RESUMED, 'operator_resumed');
});

test('tick deadline derives from the booted manifest: dispatches × roster × (1 + repairs) × call timeout + slack', () => {
  const boot = (dispatches: number) =>
    cohortBoot({
      manifestBytes: buildCampaignManifest(NOW, {
        callCap: 800,
        windowForwardMs: 7 * 24 * 3_600_000,
        maxDispatchesPerTick: dispatches,
      }).bytes,
    }).manifest;
  // 1 dispatch × 4 arms × (1 + 1 repair) × 300 000 ms + 600 000 ms slack.
  assert.equal(tickDeadlineMs(boot(1)), 3_000_000);
  // The bound moves with the campaign's own pins: 2 dispatches double the call term.
  assert.equal(tickDeadlineMs(boot(2)), 5_400_000);
});

test('an empty journal is CLEAR — a campaign that never ticked has nothing to halt on', () => {
  assert.deepEqual(resolve([]), { kind: 'clear' });
});

test('a latest finished HEALTHY tick is CLEAR; any non-healthy or UNKNOWN outcome halts — including one from another build', () => {
  assert.deepEqual(resolve([entry({ id: 1 })]), { kind: 'clear' });
  // `validated_refused` is the PRE-activation build's healthy outcome: unknown to this
  // build, so a journal spanning the flip halts once for operator review (fail closed).
  for (const outcome of ['no_live_authorization', 'publication_refused', 'escalation_latched', 'dispatch_unresolved', 'dispatch_faulted', 'evidence_root_refused', 'loud_failure', 'validated_refused', null]) {
    const state = resolve([entry({ id: 1, outcome })]);
    assert.equal(state.kind, 'halted', `outcome ${String(outcome)} must halt — fail closed on anything outside the healthy set`);
    if (state.kind !== 'halted') continue;
    assert.match(state.why, /operator review required/);
  }
});

test('the stale-unfinished (crash) shape at its exact boundary: age = deadline halts, one ms fresher is in-flight', () => {
  const startedAt = new Date(NOW - DEADLINE).toISOString();
  const stale = resolve([entry({ id: 1, startedAt, finishedAt: null, outcome: null })]);
  assert.equal(stale.kind, 'halted');
  if (stale.kind === 'halted') assert.match(stale.why, /never finished within the tick deadline/);

  const fresh = resolve([entry({ id: 1, startedAt: new Date(NOW - DEADLINE + 1).toISOString(), finishedAt: null, outcome: null })]);
  assert.deepEqual(fresh, { kind: 'clear' }, 'an in-flight overlapping tick does not halt');
});

test('a crashed tick BURIED under later healthy ticks still halts — the sweep covers the whole window, not the latest entry', () => {
  const entries = [
    entry({ id: 1, startedAt: '2026-08-05T00:00:00.000Z', finishedAt: null, outcome: null }), // the crash
    entry({ id: 2, startedAt: '2026-08-05T01:00:00.000Z', finishedAt: '2026-08-05T01:01:00.000Z' }),
    entry({ id: 3, startedAt: '2026-08-05T02:00:00.000Z', finishedAt: '2026-08-05T02:01:00.000Z' }),
  ];
  const state = resolve(entries);
  assert.equal(state.kind, 'halted');
  if (state.kind === 'halted') assert.match(state.why, /tick 1 started .* never finished/);
});

test('a non-healthy FINISHED outcome BURIED under a later healthy finish still halts — the overlap shape', () => {
  // Slow tick 1 finished loud_failure AFTER fast tick 2 already finished healthy: the
  // journal orders by id, so the failure sits below the healthy finish. A latest-only
  // check would read this clear forever; the sweep covers every finished outcome.
  const entries = [
    entry({ id: 1, startedAt: '2026-08-05T00:00:00.000Z', finishedAt: '2026-08-05T03:00:00.000Z', outcome: 'loud_failure' }),
    entry({ id: 2, startedAt: '2026-08-05T00:30:00.000Z', finishedAt: '2026-08-05T00:31:00.000Z' }),
  ];
  const state = resolve(entries);
  assert.equal(state.kind, 'halted');
  if (state.kind === 'halted') assert.match(state.why, /tick 1 finished .* "loud_failure"/);
});

test('TWO resumes: only the NEWEST bounds the window — reviewed-then-rehalted-then-reviewed history stays clear', () => {
  // [bad, resume, bad, resume]: a bound at the OLDEST resume would leave the second bad
  // tick in the window and halt; only the newest-resume bound reads this clear.
  const entries = [
    entry({ id: 1, outcome: 'loud_failure' }),
    entry({ id: 2, kind: 'resume', outcome: OPERATOR_RESUMED }),
    entry({ id: 3, outcome: 'escalation_latched' }),
    entry({ id: 4, kind: 'resume', outcome: OPERATOR_RESUMED }),
  ];
  assert.deepEqual(resolve(entries), { kind: 'clear' });
});

test('an operator resume bounds the window: bad history BEFORE it clears; anything bad AFTER it halts again', () => {
  const resumeRow = entry({ id: 2, kind: 'resume', outcome: OPERATOR_RESUMED });
  assert.deepEqual(resolve([entry({ id: 1, outcome: 'loud_failure' }), resumeRow]), { kind: 'clear' });
  assert.deepEqual(
    resolve([entry({ id: 1, startedAt: '2026-08-05T00:00:00.000Z', finishedAt: null, outcome: null }), resumeRow]),
    { kind: 'clear' },
    'a crashed tick before the resume was reviewed by the operator who resumed',
  );
  const after = resolve([resumeRow, entry({ id: 3, outcome: 'escalation_latched' })]);
  assert.equal(after.kind, 'halted', 'a resume clears history, never the future');
  assert.deepEqual(resolve([resumeRow]), { kind: 'clear' }, 'a resume row alone is clear — it is never itself a tick outcome');
});

test('order-independence: the journal id is the append authority, whatever order entries arrive in', () => {
  const shuffled = [
    entry({ id: 3, startedAt: '2026-08-05T02:00:00.000Z', finishedAt: '2026-08-05T02:01:00.000Z' }),
    entry({ id: 1, startedAt: '2026-08-05T00:00:00.000Z', finishedAt: null, outcome: null }),
    entry({ id: 2, kind: 'resume', outcome: OPERATOR_RESUMED }),
  ];
  // Sorted by id, the crash (1) precedes the resume (2): reviewed history, clear.
  assert.deepEqual(resolve(shuffled), { kind: 'clear' });
});

test('unreviewedInFlightTick: a fresh unfinished tick blocks a resume; stale, finished, pre-resume, and unreadable shapes behave as stated', () => {
  const fresh = entry({ id: 5, startedAt: new Date(NOW - 1_000).toISOString(), finishedAt: null, outcome: null });
  const stale = entry({ id: 6, startedAt: new Date(NOW - DEADLINE).toISOString(), finishedAt: null, outcome: null });
  const args = (entries: readonly ScheduleEntry[]) => ({ entries, nowMs: NOW, deadlineMs: DEADLINE });

  assert.equal(unreviewedInFlightTick(args([fresh]))?.id, 5, 'a fresh unfinished tick is in flight — unreviewable');
  assert.equal(unreviewedInFlightTick(args([stale])), null, 'a stale entry is the reviewed crash shape — resume may acknowledge it');
  assert.equal(unreviewedInFlightTick(args([entry({ id: 7 })])), null, 'a finished tick has an outcome — nothing pending');
  assert.equal(
    unreviewedInFlightTick(args([fresh, entry({ id: 9, kind: 'resume', outcome: OPERATOR_RESUMED })])),
    null,
    'an in-flight entry BEFORE the last resume is outside the window',
  );
  const unreadable = unreviewedInFlightTick(args([entry({ id: 8, startedAt: 'garbage', finishedAt: null, outcome: null })]));
  assert.equal(unreadable?.id, 8, 'an unreadable age cannot prove staleness — fail closed, counts as in flight');
  assert.throws(() => unreviewedInFlightTick({ entries: [], nowMs: Number.NaN, deadlineMs: DEADLINE }), /finite clock/);
});

test('fail closed on what cannot be read: an unreadable start instant halts; a broken clock or deadline throws', () => {
  const bad = resolve([entry({ id: 1, startedAt: 'not-an-instant', finishedAt: null, outcome: null })]);
  assert.equal(bad.kind, 'halted');
  if (bad.kind === 'halted') assert.match(bad.why, /unreadable start instant/);

  assert.throws(() => resolve([], Number.NaN), /finite clock reading/);
  for (const deadlineMs of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => resolveScheduleState({ entries: [], nowMs: NOW, deadlineMs, healthyOutcomes: HEALTHY_TICK_OUTCOMES }),
      /positive tick deadline/,
    );
  }
});
