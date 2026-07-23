import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cutoffViolations,
  dispatchLagVerdict,
  initialDispatchGate,
  recomputeInitialDispatchGate,
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

// The scorer sources maxRepairAttemptsPerArm from the frozen manifest (Tier-0 = 1).
const order = (attempts: readonly AttemptTiming[], init: string, cap = 1): string[] =>
  verifyAttemptOrdering(attempts, init, cap);

// --- verifyAttemptOrdering (case 48) ---

test('a clean initial+repair sequence has no ordering violations', () => {
  assert.deepEqual(order([initial(), repair()], INITIAL_START), []);
});

test('a clean single initial (not accepted) has no ordering violations', () => {
  assert.deepEqual(order([initial({ acceptedAt: null })], INITIAL_START), []);
});

// --- nullable requestReceivedAt: a timeout/transport attempt has no receipt ---

test('a single unaccepted initial with no receipt (timeout) has no ordering violations', () => {
  assert.deepEqual(order([initial({ requestReceivedAt: null, acceptedAt: null })], INITIAL_START), []);
});

test('acceptedAt without a requestReceivedAt is an impossible provenance', () => {
  const violations = order([initial({ requestReceivedAt: null })], INITIAL_START);
  assert.ok(violations.some((m) => m.includes('acceptedAt present without a requestReceivedAt')));
});

test('a repair present with a receipt-less initial is an impossible causal timeline', () => {
  // A repair is dispatched only after the initial RESPONSE supplies a decision
  // fingerprint, so a repair cannot coexist with a receipt-less initial.
  const violations = order(
    [initial({ requestReceivedAt: null, acceptedAt: null }), repair()],
    INITIAL_START,
  );
  assert.ok(
    violations.some((m) => m.includes('repair attempt present without an initial requestReceivedAt')),
  );
});

test('cutoffViolations skips the receipt check for a receipt-less attempt', () => {
  assert.deepEqual(
    cutoffViolations({
      windowEnd: WINDOW_END,
      scheduledAtAtFire: FIRST_PITCH,
      initialRequestStartedAt: INITIAL_START,
      attempts: [initial({ requestReceivedAt: null, acceptedAt: null })],
    }),
    [],
  );
});

test('empty attempts is flagged', () => {
  assert.ok(order([], INITIAL_START).some((v) => /no attempts/.test(v)));
});

test('zero or two initial attempts is flagged', () => {
  assert.ok(order([repair()], INITIAL_START).some((v) => /exactly one initial/.test(v)));
  assert.ok(
    order([initial(), initial({ attemptNumber: 2 })], INITIAL_START).some((v) => /exactly one initial/.test(v)),
  );
});

test('non-increasing or duplicate attempt numbers are flagged (case 48)', () => {
  assert.ok(
    order([initial({ attemptNumber: 2 }), repair({ attemptNumber: 2 })], INITIAL_START).some((v) =>
      /strictly increasing/.test(v),
    ),
  );
  assert.ok(
    order([initial({ attemptNumber: 5 }), repair({ attemptNumber: 3 })], INITIAL_START).some((v) =>
      /strictly increasing/.test(v),
    ),
  );
});

test('an unsafe or non-positive attempt number is flagged', () => {
  for (const n of [0, -1, 1.5, NaN, 9007199254740992]) {
    assert.ok(
      order([initial({ attemptNumber: n })], INITIAL_START).some((v) => /safe positive integer/.test(v)),
      String(n),
    );
  }
});

test('per-attempt causal-order violations are flagged (case 48)', () => {
  // requestStartedAt after requestReceivedAt
  const started = order(
    [initial({ requestStartedAt: '2026-07-16T00:00:06.000Z', requestReceivedAt: '2026-07-16T00:00:05.000Z' })],
    '2026-07-16T00:00:06.000Z',
  );
  assert.ok(started.some((v) => /requestStartedAt is after requestReceivedAt/.test(v)), started.join('; '));
  // acceptedAt before requestReceivedAt
  const accepted = order(
    [initial({ requestReceivedAt: '2026-07-16T00:00:06.000Z', acceptedAt: '2026-07-16T00:00:05.000Z' })],
    INITIAL_START,
  );
  assert.ok(accepted.some((v) => /requestReceivedAt is after acceptedAt/.test(v)), accepted.join('; '));
});

test('the fire initialRequestStartedAt must equal the initial attempt start', () => {
  assert.ok(
    order([initial()], '2026-07-16T00:00:09.000Z').some((v) => /initialRequestStartedAt must equal/.test(v)),
  );
});

test('a repair starting before the initial response was received is flagged (case 48)', () => {
  const r = repair({ requestStartedAt: '2026-07-16T00:00:05.500Z' }); // before the initial's received (06)
  assert.ok(
    order([initial(), r], INITIAL_START).some((v) => /before the initial's requestReceivedAt/.test(v)),
  );
});

test('a malformed attempt timestamp is flagged', () => {
  const v = order([initial({ requestStartedAt: '2026-07-16T00:00:05' })], '2026-07-16T00:00:05');
  assert.ok(v.some((x) => /not a valid offset-qualified instant/.test(x)), v.join('; '));
});

test('causal + cross-attempt EQUALITY is allowed (started==received==accepted, repair.start==initial.received)', () => {
  const t = '2026-07-16T00:00:05.000Z';
  // started == received == accepted -> clean (the <= bounds are inclusive).
  assert.deepEqual(order([initial({ requestStartedAt: t, requestReceivedAt: t, acceptedAt: t })], t), []);
  // repair.requestStartedAt == the initial's requestReceivedAt (06) -> clean (>= is inclusive).
  assert.deepEqual(order([initial(), repair({ requestStartedAt: '2026-07-16T00:00:06.000Z' })], INITIAL_START), []);
});

test('two repairs exceed the Tier-0 cap (maxRepairAttemptsPerArm = 1) and are flagged', () => {
  const r2 = repair({ attemptNumber: 2, requestStartedAt: '2026-07-16T00:00:10.000Z', requestReceivedAt: '2026-07-16T00:00:11.000Z', acceptedAt: '2026-07-16T00:00:12.000Z' });
  const r3 = repair({ attemptNumber: 3, requestStartedAt: '2026-07-16T00:00:15.000Z', requestReceivedAt: '2026-07-16T00:00:16.000Z', acceptedAt: '2026-07-16T00:00:17.000Z' });
  const v = order([initial(), r2, r3], INITIAL_START); // cap defaults to 1 in the wrapper
  assert.ok(v.some((x) => /too many repair attempts: 2 > maxRepairAttemptsPerArm 1/.test(x)), v.join('; '));
});

test('the per-repair loop checks EVERY repair against the initial response (not just the first)', () => {
  // Under a relaxed cap of 2, a valid 3-attempt chain is clean; the SECOND repair
  // starting before the initial response is still flagged (naming repair 3).
  const r2 = repair({ attemptNumber: 2, requestStartedAt: '2026-07-16T00:00:10.000Z', requestReceivedAt: '2026-07-16T00:00:11.000Z', acceptedAt: '2026-07-16T00:00:12.000Z' });
  const r3 = repair({ attemptNumber: 3, requestStartedAt: '2026-07-16T00:00:15.000Z', requestReceivedAt: '2026-07-16T00:00:16.000Z', acceptedAt: '2026-07-16T00:00:17.000Z' });
  assert.deepEqual(order([initial(), r2, r3], INITIAL_START, 2), []);
  const r3bad = repair({ attemptNumber: 3, requestStartedAt: '2026-07-16T00:00:05.500Z', requestReceivedAt: '2026-07-16T00:00:16.000Z', acceptedAt: '2026-07-16T00:00:17.000Z' });
  const v = order([initial(), r2, r3bad], INITIAL_START, 2);
  assert.ok(v.some((x) => /repair 3: requestStartedAt is before the initial's requestReceivedAt/.test(x)), v.join('; '));
});

test('an unknown attempt kind, or a repair listed before the initial, is flagged (case 48 taxonomy)', () => {
  // Unknown kind is rejected at runtime (not trusted from the TS union).
  const other = { attemptNumber: 2, kind: 'other' as unknown as AttemptTiming['kind'], requestStartedAt: '2026-07-16T00:00:10.000Z', requestReceivedAt: '2026-07-16T00:00:11.000Z', acceptedAt: null };
  assert.ok(order([initial(), other], INITIAL_START).some((x) => /unknown kind/.test(x)));
  // A repair listed/numbered before the sole initial is not a valid history.
  const r1 = repair({ attemptNumber: 1, requestStartedAt: '2026-07-16T00:00:10.000Z' });
  const i2 = initial({ attemptNumber: 2, requestStartedAt: '2026-07-16T00:00:05.000Z' });
  const v = order([r1, i2], '2026-07-16T00:00:05.000Z');
  assert.ok(v.some((x) => /the first attempt must be the initial/.test(x)), v.join('; '));
});

test('verifyAttemptOrdering throws on a malformed maxRepairAttemptsPerArm cap', () => {
  for (const bad of [NaN, Infinity, -1, 1.5, 9007199254740992]) {
    assert.throws(() => verifyAttemptOrdering([initial()], INITIAL_START, bad as number), String(bad));
  }
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

test('a response RECEIVED at/after first pitch is a cutoff violation even when acceptedAt is null (case 26)', () => {
  const inWindowStart = '2026-07-16T00:01:00.000Z'; // < windowEnd, < first pitch
  // received 1ms before first pitch, not accepted -> clean.
  const before = initial({ requestStartedAt: inWindowStart, requestReceivedAt: '2026-07-16T00:59:59.999Z', acceptedAt: null });
  assert.deepEqual(
    cutoffViolations({ windowEnd: WINDOW_END, scheduledAtAtFire: FIRST_PITCH, initialRequestStartedAt: inWindowStart, attempts: [before] }),
    [],
  );
  // initial received exactly at, and after, first pitch with acceptedAt null -> violation.
  for (const rcv of [FIRST_PITCH, '2026-07-16T01:00:05.000Z']) {
    const late = initial({ requestStartedAt: inWindowStart, requestReceivedAt: rcv, acceptedAt: null });
    const v = cutoffViolations({ windowEnd: WINDOW_END, scheduledAtAtFire: FIRST_PITCH, initialRequestStartedAt: inWindowStart, attempts: [late] });
    assert.ok(v.some((x) => /initial response \(attempt 1\) received at\/after first pitch/.test(x)), `${rcv}: ${v.join('; ')}`);
  }
  // repair received exactly at, and after, first pitch with acceptedAt null -> violation.
  for (const rcv of [FIRST_PITCH, '2026-07-16T01:00:05.000Z']) {
    const lateRepair = repair({ requestStartedAt: '2026-07-16T00:59:00.000Z', requestReceivedAt: rcv, acceptedAt: null });
    const v = cutoffViolations({ windowEnd: WINDOW_END, scheduledAtAtFire: FIRST_PITCH, initialRequestStartedAt: INITIAL_START, attempts: [initial(), lateRepair] });
    assert.ok(v.some((x) => /repair response \(attempt 2\) received at\/after first pitch/.test(x)), `${rcv}: ${v.join('; ')}`);
  }
  // repair received after windowEnd but before first pitch -> clean (first pitch, not windowEnd, bounds a receipt).
  const repairAfterWindow = repair({ requestStartedAt: '2026-07-16T00:03:00.000Z', requestReceivedAt: '2026-07-16T00:03:30.000Z', acceptedAt: '2026-07-16T00:03:31.000Z' });
  assert.deepEqual(
    cutoffViolations({ windowEnd: WINDOW_END, scheduledAtAtFire: FIRST_PITCH, initialRequestStartedAt: INITIAL_START, attempts: [initial(), repairAfterWindow] }),
    [],
  );
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

// --- initialDispatchGate (the send-time gate; §5; frozen precedence first-pitch > windowEnd > V-lag) ---

const G_DETECTED = '2026-07-16T00:00:00.000Z';
const G_MAX = 10_000;
const G_WINDOW_FAR = '2026-07-16T02:00:00.000Z';
const G_PITCH_FAR = '2026-07-16T03:00:00.000Z';

type GateInput = Parameters<typeof initialDispatchGate>[0];
/** All non-target bounds pinned CLEAN by default (windowEnd + first pitch far, V-lag within). */
function gate(over: Partial<GateInput> = {}): ReturnType<typeof initialDispatchGate> {
  return initialDispatchGate({
    detectedAt: G_DETECTED,
    windowEnd: G_WINDOW_FAR,
    scheduledAtAtFire: G_PITCH_FAR,
    initialRequestStartedAt: '2026-07-16T00:00:05.000Z',
    maxDispatchLagMs: G_MAX,
    ...over,
  });
}

test('initialDispatchGate: a clean initial start (all bounds satisfied) is ok', () => {
  assert.deepEqual(gate(), { ok: true });
});

test('initialDispatchGate: V-lag boundaries are inclusive at both ends', () => {
  // start == detectedAt + maxDispatchLagMs exactly (upper inclusive) -> ok.
  assert.deepEqual(gate({ initialRequestStartedAt: '2026-07-16T00:00:10.000Z' }), { ok: true });
  // start == detectedAt (lag 0, lower inclusive) -> ok.
  assert.deepEqual(gate({ initialRequestStartedAt: G_DETECTED }), { ok: true });
});

test('initialDispatchGate: V-lag over the cap or backdated is dispatch_lag_exceeded (windowEnd + first pitch clean)', () => {
  // start == detectedAt + max + 1ms -> exceeded.
  assert.deepEqual(gate({ initialRequestStartedAt: '2026-07-16T00:00:10.001Z' }), {
    ok: false,
    outcome: 'dispatch_lag_exceeded',
  });
  // start < detectedAt (backdated) -> exceeded (two-sided).
  assert.deepEqual(gate({ initialRequestStartedAt: '2026-07-15T23:59:59.000Z' }), {
    ok: false,
    outcome: 'dispatch_lag_exceeded',
  });
});

test('initialDispatchGate: windowEnd is a strict (exclusive) bound -> cutoff_missed at/after (V-lag + first pitch clean)', () => {
  // A near windowEnd inside the V-lag window so V-lag stays clean and windowEnd is isolated.
  const windowEnd = '2026-07-16T00:00:05.000Z';
  // start == windowEnd exactly -> cutoff_missed.
  assert.deepEqual(gate({ windowEnd, initialRequestStartedAt: windowEnd }), { ok: false, outcome: 'cutoff_missed' });
  // start 1ms before windowEnd -> ok.
  assert.deepEqual(gate({ windowEnd, initialRequestStartedAt: '2026-07-16T00:00:04.999Z' }), { ok: true });
});

test('initialDispatchGate: first pitch is a strict (exclusive) bound -> cutoff_missed at/after (windowEnd + V-lag clean)', () => {
  const scheduledAtAtFire = '2026-07-16T00:00:03.000Z';
  // start == first pitch exactly -> cutoff_missed.
  assert.deepEqual(gate({ scheduledAtAtFire, initialRequestStartedAt: scheduledAtAtFire }), {
    ok: false,
    outcome: 'cutoff_missed',
  });
  // start 1ms before first pitch -> ok.
  assert.deepEqual(gate({ scheduledAtAtFire, initialRequestStartedAt: '2026-07-16T00:00:02.999Z' }), { ok: true });
});

test('initialDispatchGate: windowEnd OUTRANKS V-lag — a start violating BOTH is cutoff_missed (first pitch clean)', () => {
  // detectedAt = windowEnd - max - 1ms, start = windowEnd: lag = max + 1 (V-lag violated) AND start
  // >= windowEnd (windowEnd violated) on one reading. Frozen precedence returns cutoff_missed.
  const windowEnd = '2026-07-16T00:00:05.000Z';
  const detectedAt = '2026-07-15T23:59:54.999Z'; // windowEnd - 10.001s
  assert.deepEqual(
    gate({ detectedAt, windowEnd, initialRequestStartedAt: windowEnd, scheduledAtAtFire: G_PITCH_FAR }),
    { ok: false, outcome: 'cutoff_missed' },
  );
});

test('initialDispatchGate: first pitch OUTRANKS V-lag — a start violating BOTH is cutoff_missed (windowEnd clean)', () => {
  // detectedAt = firstPitch - max - 1ms, start = firstPitch: lag = max + 1 (V-lag violated) AND
  // start >= first pitch (first-pitch violated); windowEnd far. Precedence returns cutoff_missed.
  const scheduledAtAtFire = '2026-07-16T00:00:05.000Z';
  const detectedAt = '2026-07-15T23:59:54.999Z';
  assert.deepEqual(
    gate({ detectedAt, scheduledAtAtFire, initialRequestStartedAt: scheduledAtAtFire, windowEnd: G_WINDOW_FAR }),
    { ok: false, outcome: 'cutoff_missed' },
  );
});

test('initialDispatchGate: first pitch and windowEnd both violated is cutoff_missed', () => {
  const windowEnd = '2026-07-16T00:00:04.000Z';
  const scheduledAtAtFire = '2026-07-16T00:00:05.000Z';
  assert.deepEqual(
    gate({ windowEnd, scheduledAtAtFire, initialRequestStartedAt: '2026-07-16T00:00:06.000Z' }),
    { ok: false, outcome: 'cutoff_missed' },
  );
});

test('initialDispatchGate: every operand is parsed up front — a malformed field throws', () => {
  const bad = '2026-07-16T00:00:00'; // offset-less: instantMs rejects it
  // Each timing operand malformed in isolation (other bounds clean) -> throws.
  assert.throws(() => gate({ detectedAt: bad }));
  assert.throws(() => gate({ windowEnd: bad }));
  assert.throws(() => gate({ scheduledAtAtFire: bad }));
  assert.throws(() => gate({ initialRequestStartedAt: bad }));
  // A non-safe / negative cap -> throws.
  for (const cap of [NaN, Infinity, -1, 1.5, 9007199254740992]) {
    assert.throws(() => gate({ maxDispatchLagMs: cap as number }), String(cap));
  }
});

test('initialDispatchGate: a malformed lower-precedence operand is NOT hidden by a higher-precedence timing violation', () => {
  const bad = '2026-07-16T00:00:00'; // offset-less
  const nearPitch = '2026-07-16T00:00:03.000Z';
  const afterPitch = '2026-07-16T00:00:05.000Z'; // >= first pitch: a first-pitch violation ALSO holds
  // First pitch is violated (would return cutoff_missed), yet a malformed windowEnd still throws.
  assert.throws(() =>
    gate({ scheduledAtAtFire: nearPitch, initialRequestStartedAt: afterPitch, windowEnd: bad }),
  );
  // First pitch violated, yet a malformed detectedAt (consumed by the V-lag verdict) still throws.
  assert.throws(() =>
    gate({ scheduledAtAtFire: nearPitch, initialRequestStartedAt: afterPitch, detectedAt: bad }),
  );
  // windowEnd violated (first pitch clean), yet a malformed detectedAt still throws.
  const nearWindow = '2026-07-16T00:00:03.000Z';
  assert.throws(() =>
    gate({ windowEnd: nearWindow, initialRequestStartedAt: '2026-07-16T00:00:04.000Z', detectedAt: bad, scheduledAtAtFire: G_PITCH_FAR }),
  );
});

// --- recomputeInitialDispatchGate (B3-R2: scorer-side independent re-derivation) ---

test('B3-R2: recomputeInitialDispatchGate re-derives the gate verdict from operands alone — never the recorded terminal', () => {
  // Manifest-derived bounds (windowEnd < first pitch); the two V-lag bounds pinned wide by default.
  const detectedAt = '2026-07-16T00:00:00.000Z';
  const windowEnd = '2026-07-16T00:02:00.000Z';
  const firstPitch = '2026-07-16T01:00:00.000Z';
  const maxDispatchLagMs = 10_000;

  // 1. A never-sent cutoff_missed (windowEnd crossing): start >= windowEnd, < first pitch → cutoff_missed.
  assert.deepEqual(
    recomputeInitialDispatchGate({
      detectedAt,
      initialRequestStartedAt: '2026-07-16T00:02:05.000Z',
      scheduledAtAtFire: firstPitch,
      windowEnd,
      maxDispatchLagMs,
      recordedTerminalOutcome: 'cutoff_missed',
    }),
    { ok: false, outcome: 'cutoff_missed' },
  );

  // 2a. A never-sent dispatch_lag_exceeded (over the cap): lag == max + 1ms.
  assert.deepEqual(
    recomputeInitialDispatchGate({
      detectedAt,
      initialRequestStartedAt: '2026-07-16T00:00:10.001Z',
      scheduledAtAtFire: firstPitch,
      windowEnd,
      maxDispatchLagMs,
      recordedTerminalOutcome: 'dispatch_lag_exceeded',
    }),
    { ok: false, outcome: 'dispatch_lag_exceeded' },
  );
  // 2b. A never-sent dispatch_lag_exceeded (two-sided/backdated): initialRequestStartedAt < detectedAt.
  assert.deepEqual(
    recomputeInitialDispatchGate({
      detectedAt,
      initialRequestStartedAt: '2026-07-15T23:59:59.000Z',
      scheduledAtAtFire: firstPitch,
      windowEnd,
      maxDispatchLagMs,
      recordedTerminalOutcome: 'dispatch_lag_exceeded',
    }),
    { ok: false, outcome: 'dispatch_lag_exceeded' },
  );

  // 3. THE DISCRIMINATOR — a SENT cutoff_missed: the initial started IN TIME (before windowEnd/first
  //    pitch, within V-lag), so the initial gate returns ok; the terminal cutoff_missed came from
  //    LATER acceptance timing (non-empty attempts elsewhere), NOT an initial refusal. The helper
  //    must return ok and NEVER equate the recorded terminal with an initial gate refusal.
  assert.deepEqual(
    recomputeInitialDispatchGate({
      detectedAt,
      initialRequestStartedAt: '2026-07-16T00:00:05.000Z',
      scheduledAtAtFire: firstPitch,
      windowEnd,
      maxDispatchLagMs,
      recordedTerminalOutcome: 'cutoff_missed',
    }),
    { ok: true },
  );

  // 4. A sent, valid arm: in time → ok.
  assert.deepEqual(
    recomputeInitialDispatchGate({
      detectedAt,
      initialRequestStartedAt: '2026-07-16T00:00:05.000Z',
      scheduledAtAtFire: firstPitch,
      windowEnd,
      maxDispatchLagMs,
      recordedTerminalOutcome: 'valid',
    }),
    { ok: true },
  );
});
