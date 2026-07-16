import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cutoffViolations,
  dispatchLagVerdict,
  verifyAttemptOrdering,
} from './attemptProvenance.js';
import type { AttemptTiming } from './attemptProvenance.js';

/**
 * §5 per-attempt timing provenance: causal ordering (case 48), the initial-only
 * V-lag (dispatch_lag_exceeded), and the windowEnd / first-pitch cutoff race
 * (case 26). Every fixture instant is offset-qualified; the checks fail closed.
 */

const INITIAL_START = '2026-07-16T00:00:05.000Z';
const WINDOW_END = '2026-07-16T00:02:00.000Z';
const FIRST_PITCH = '2026-07-16T01:00:00.000Z';

function initial(over: Partial<AttemptTiming> = {}): AttemptTiming {
  return {
    attemptNumber: 1,
    kind: 'initial',
    requestStartedAt: INITIAL_START,
    requestReceivedAt: '2026-07-16T00:00:06.000Z',
    acceptedAt: '2026-07-16T00:00:07.000Z',
    ...over,
  };
}
function repair(over: Partial<AttemptTiming> = {}): AttemptTiming {
  return {
    attemptNumber: 2,
    kind: 'repair',
    requestStartedAt: '2026-07-16T00:00:10.000Z',
    requestReceivedAt: '2026-07-16T00:00:11.000Z',
    acceptedAt: '2026-07-16T00:00:12.000Z',
    ...over,
  };
}

// --- verifyAttemptOrdering (case 48) ---

test('a clean initial+repair sequence has no ordering violations', () => {
  assert.deepEqual(verifyAttemptOrdering([initial(), repair()], INITIAL_START), []);
});

test('a clean single initial (not accepted) has no ordering violations', () => {
  assert.deepEqual(verifyAttemptOrdering([initial({ acceptedAt: null })], INITIAL_START), []);
});

test('empty attempts is flagged', () => {
  assert.ok(verifyAttemptOrdering([], INITIAL_START).some((v) => /no attempts/.test(v)));
});

test('zero or two initial attempts is flagged', () => {
  assert.ok(verifyAttemptOrdering([repair()], INITIAL_START).some((v) => /exactly one initial/.test(v)));
  assert.ok(
    verifyAttemptOrdering([initial(), initial({ attemptNumber: 2 })], INITIAL_START).some((v) => /exactly one initial/.test(v)),
  );
});

test('non-increasing or duplicate attempt numbers are flagged (case 48)', () => {
  assert.ok(
    verifyAttemptOrdering([initial({ attemptNumber: 2 }), repair({ attemptNumber: 2 })], INITIAL_START).some((v) =>
      /strictly increasing/.test(v),
    ),
  );
  assert.ok(
    verifyAttemptOrdering([initial({ attemptNumber: 5 }), repair({ attemptNumber: 3 })], INITIAL_START).some((v) =>
      /strictly increasing/.test(v),
    ),
  );
});

test('an unsafe or non-positive attempt number is flagged', () => {
  for (const n of [0, -1, 1.5, NaN, 9007199254740992]) {
    assert.ok(
      verifyAttemptOrdering([initial({ attemptNumber: n })], INITIAL_START).some((v) => /safe positive integer/.test(v)),
      String(n),
    );
  }
});

test('per-attempt causal-order violations are flagged (case 48)', () => {
  // requestStartedAt after requestReceivedAt
  const started = verifyAttemptOrdering(
    [initial({ requestStartedAt: '2026-07-16T00:00:06.000Z', requestReceivedAt: '2026-07-16T00:00:05.000Z' })],
    '2026-07-16T00:00:06.000Z',
  );
  assert.ok(started.some((v) => /requestStartedAt is after requestReceivedAt/.test(v)), started.join('; '));
  // acceptedAt before requestReceivedAt
  const accepted = verifyAttemptOrdering(
    [initial({ requestReceivedAt: '2026-07-16T00:00:06.000Z', acceptedAt: '2026-07-16T00:00:05.000Z' })],
    INITIAL_START,
  );
  assert.ok(accepted.some((v) => /requestReceivedAt is after acceptedAt/.test(v)), accepted.join('; '));
});

test('the fire initialRequestStartedAt must equal the initial attempt start', () => {
  assert.ok(
    verifyAttemptOrdering([initial()], '2026-07-16T00:00:09.000Z').some((v) => /initialRequestStartedAt must equal/.test(v)),
  );
});

test('a repair starting before the initial response was received is flagged (case 48)', () => {
  const r = repair({ requestStartedAt: '2026-07-16T00:00:05.500Z' }); // before the initial's received (06)
  assert.ok(
    verifyAttemptOrdering([initial(), r], INITIAL_START).some((v) => /before the initial's requestReceivedAt/.test(v)),
  );
});

test('a malformed attempt timestamp is flagged', () => {
  const v = verifyAttemptOrdering([initial({ requestStartedAt: '2026-07-16T00:00:05' })], '2026-07-16T00:00:05');
  assert.ok(v.some((x) => /not a valid offset-qualified instant/.test(x)), v.join('; '));
});

test('causal + cross-attempt EQUALITY is allowed (started==received==accepted, repair.start==initial.received)', () => {
  const t = '2026-07-16T00:00:05.000Z';
  // started == received == accepted -> clean (the <= bounds are inclusive).
  assert.deepEqual(verifyAttemptOrdering([initial({ requestStartedAt: t, requestReceivedAt: t, acceptedAt: t })], t), []);
  // repair.requestStartedAt == the initial's requestReceivedAt (06) -> clean (>= is inclusive).
  assert.deepEqual(verifyAttemptOrdering([initial(), repair({ requestStartedAt: '2026-07-16T00:00:06.000Z' })], INITIAL_START), []);
});

test('multiple repairs: a clean 3-attempt chain passes; a LATER repair before the initial response is flagged', () => {
  const r2 = repair({ attemptNumber: 2, requestStartedAt: '2026-07-16T00:00:10.000Z', requestReceivedAt: '2026-07-16T00:00:11.000Z', acceptedAt: '2026-07-16T00:00:12.000Z' });
  const r3 = repair({ attemptNumber: 3, requestStartedAt: '2026-07-16T00:00:15.000Z', requestReceivedAt: '2026-07-16T00:00:16.000Z', acceptedAt: '2026-07-16T00:00:17.000Z' });
  assert.deepEqual(verifyAttemptOrdering([initial(), r2, r3], INITIAL_START), []);
  // The THIRD attempt starts before the initial's requestReceivedAt (06) — the per-repair loop must catch it, not just the first repair.
  const r3bad = repair({ attemptNumber: 3, requestStartedAt: '2026-07-16T00:00:05.500Z', requestReceivedAt: '2026-07-16T00:00:16.000Z', acceptedAt: '2026-07-16T00:00:17.000Z' });
  const v = verifyAttemptOrdering([initial(), r2, r3bad], INITIAL_START);
  assert.ok(v.some((x) => /repair 3: requestStartedAt is before the initial's requestReceivedAt/.test(x)), v.join('; '));
});

// --- dispatchLagVerdict (V-lag -> dispatch_lag_exceeded) ---

test('dispatchLagVerdict: within lag is ok; beyond or negative is dispatch_lag_exceeded', () => {
  const detectedAt = '2026-07-16T00:00:00.000Z';
  const max = 10000;
  assert.equal(dispatchLagVerdict({ detectedAt, initialRequestStartedAt: '2026-07-16T00:00:05.000Z', maxDispatchLagMs: max }), 'ok');
  assert.equal(dispatchLagVerdict({ detectedAt, initialRequestStartedAt: '2026-07-16T00:00:10.000Z', maxDispatchLagMs: max }), 'ok'); // == max (inclusive)
  assert.equal(dispatchLagVerdict({ detectedAt, initialRequestStartedAt: detectedAt, maxDispatchLagMs: max }), 'ok'); // lag 0
  assert.equal(
    dispatchLagVerdict({ detectedAt, initialRequestStartedAt: '2026-07-16T00:00:10.001Z', maxDispatchLagMs: max }),
    'dispatch_lag_exceeded',
  ); // > max
  assert.equal(
    dispatchLagVerdict({ detectedAt, initialRequestStartedAt: '2026-07-15T23:59:59.000Z', maxDispatchLagMs: max }),
    'dispatch_lag_exceeded',
  ); // negative lag
});

test('dispatchLagVerdict throws on a malformed cap or instant (fail-closed)', () => {
  const detectedAt = '2026-07-16T00:00:00.000Z';
  const started = '2026-07-16T00:00:05.000Z';
  for (const bad of [NaN, Infinity, -1, 1.5, 9007199254740992]) {
    assert.throws(() => dispatchLagVerdict({ detectedAt, initialRequestStartedAt: started, maxDispatchLagMs: bad as number }), String(bad));
  }
  assert.throws(() => dispatchLagVerdict({ detectedAt: '2026-07-16T00:00:00', initialRequestStartedAt: started, maxDispatchLagMs: 10000 }));
});

// --- cutoffViolations (case 26) ---

test('a clean fire has no cutoff violations', () => {
  assert.deepEqual(
    cutoffViolations({ windowEnd: WINDOW_END, scheduledAtAtFire: FIRST_PITCH, initialRequestStartedAt: INITIAL_START, attempts: [initial(), repair()] }),
    [],
  );
});

test('an initial request at/after windowEnd is a cutoff violation', () => {
  const late = '2026-07-16T00:02:30.000Z'; // after windowEnd (00:02)
  const v = cutoffViolations({
    windowEnd: WINDOW_END,
    scheduledAtAtFire: FIRST_PITCH,
    initialRequestStartedAt: late,
    attempts: [initial({ requestStartedAt: late, requestReceivedAt: '2026-07-16T00:02:31.000Z', acceptedAt: '2026-07-16T00:02:32.000Z' })],
  });
  assert.ok(v.some((x) => /initial request started at\/after windowEnd/.test(x)), v.join('; '));
});

test('a repair after windowEnd but before first pitch is NOT a cutoff violation', () => {
  const r = repair({
    requestStartedAt: '2026-07-16T00:03:00.000Z',
    requestReceivedAt: '2026-07-16T00:03:01.000Z',
    acceptedAt: '2026-07-16T00:03:02.000Z',
  });
  assert.deepEqual(
    cutoffViolations({ windowEnd: WINDOW_END, scheduledAtAtFire: FIRST_PITCH, initialRequestStartedAt: INITIAL_START, attempts: [initial(), r] }),
    [],
  );
});

test('any request at/after first pitch is a cutoff violation (case 26)', () => {
  const lateRepair = repair({
    requestStartedAt: '2026-07-16T01:00:05.000Z',
    requestReceivedAt: '2026-07-16T01:00:06.000Z',
    acceptedAt: '2026-07-16T01:00:07.000Z',
  });
  const v = cutoffViolations({ windowEnd: WINDOW_END, scheduledAtAtFire: FIRST_PITCH, initialRequestStartedAt: INITIAL_START, attempts: [initial(), lateRepair] });
  assert.ok(v.some((x) => /started at\/after first pitch/.test(x)), v.join('; '));
});

test('a response accepted at/after first pitch is a cutoff violation, in isolation (case 26)', () => {
  // Request starts within window; only the accept crosses first pitch (a hung response).
  const acceptedLate = initial({
    requestStartedAt: '2026-07-16T00:01:00.000Z',
    requestReceivedAt: '2026-07-16T00:01:30.000Z',
    acceptedAt: '2026-07-16T01:00:31.000Z',
  });
  const v = cutoffViolations({
    windowEnd: WINDOW_END,
    scheduledAtAtFire: FIRST_PITCH,
    initialRequestStartedAt: '2026-07-16T00:01:00.000Z',
    attempts: [acceptedLate],
  });
  assert.ok(v.some((x) => /accepted at\/after first pitch/.test(x)), v.join('; '));
  assert.ok(!v.some((x) => /windowEnd/.test(x)), 'the in-window request must not trip the windowEnd check');
});

test('a null initial (never sent) skips the windowEnd check', () => {
  assert.deepEqual(
    cutoffViolations({ windowEnd: WINDOW_END, scheduledAtAtFire: FIRST_PITCH, initialRequestStartedAt: null, attempts: [] }),
    [],
  );
});

test('cutoffViolations flags a malformed timestamp', () => {
  const v = cutoffViolations({ windowEnd: '2026-07-16T00:02:00', scheduledAtAtFire: FIRST_PITCH, initialRequestStartedAt: INITIAL_START, attempts: [initial()] });
  assert.ok(v.some((x) => /not a valid offset-qualified instant/.test(x)), v.join('; '));
});

test('cutoff bounds are inclusive at the EXACT instant (>=)', () => {
  // A request starting exactly at first pitch is a violation.
  const atFirstPitch = initial({ requestStartedAt: FIRST_PITCH, requestReceivedAt: '2026-07-16T01:00:01.000Z', acceptedAt: '2026-07-16T01:00:02.000Z' });
  assert.ok(
    cutoffViolations({ windowEnd: WINDOW_END, scheduledAtAtFire: FIRST_PITCH, initialRequestStartedAt: FIRST_PITCH, attempts: [atFirstPitch] }).some((x) =>
      /started at\/after first pitch/.test(x),
    ),
  );
  // An accept exactly at first pitch (request strictly before) is a violation, in isolation.
  const acceptAtFirstPitch = initial({ requestStartedAt: '2026-07-16T00:01:00.000Z', requestReceivedAt: '2026-07-16T00:01:30.000Z', acceptedAt: FIRST_PITCH });
  const va = cutoffViolations({ windowEnd: WINDOW_END, scheduledAtAtFire: FIRST_PITCH, initialRequestStartedAt: '2026-07-16T00:01:00.000Z', attempts: [acceptAtFirstPitch] });
  assert.ok(va.some((x) => /accepted at\/after first pitch/.test(x)), va.join('; '));
  assert.ok(!va.some((x) => /started at\/after first pitch/.test(x)), 'a request strictly before first pitch must not trip the start check');
  // An initial starting exactly at windowEnd is a violation.
  const atWindowEnd = initial({ requestStartedAt: WINDOW_END, requestReceivedAt: '2026-07-16T00:02:01.000Z', acceptedAt: '2026-07-16T00:02:02.000Z' });
  assert.ok(
    cutoffViolations({ windowEnd: WINDOW_END, scheduledAtAtFire: FIRST_PITCH, initialRequestStartedAt: WINDOW_END, attempts: [atWindowEnd] }).some((x) =>
      /initial request started at\/after windowEnd/.test(x),
    ),
  );
});
