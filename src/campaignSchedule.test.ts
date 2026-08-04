import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HEALTHY_TICK_OUTCOMES,
  OPERATOR_RESUMED,
  SCHEDULE_WINDOW_LIMIT,
  resolveScheduleState,
  tickDeadlineMs,
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
    outcome: 'validated_refused',
    detail: null,
    ...over,
  };
}

function resolve(entries: readonly ScheduleEntry[], nowMs: number = NOW) {
  return resolveScheduleState({ entries, nowMs, deadlineMs: DEADLINE, healthyOutcomes: HEALTHY_TICK_OUTCOMES });
}

test('the healthy set of THIS build is exactly the structural refusal — the flip replaces it deliberately', () => {
  assert.deepEqual([...HEALTHY_TICK_OUTCOMES], ['validated_refused']);
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

test('a latest finished HEALTHY tick is CLEAR; any non-healthy or UNKNOWN outcome halts — including one from a newer build', () => {
  assert.deepEqual(resolve([entry({ id: 1 })]), { kind: 'clear' });
  for (const outcome of ['no_live_authorization', 'publication_refused', 'escalation_latched', 'loud_failure', 'dispatched', null]) {
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
