import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  closeAfterStart,
  closeTiming,
  closeValueAfterLock,
  POLL_GAP_COHERENCE_TOLERANCE_MS,
  type RawCloseTiming,
} from './closeTiming.js';

const LOCK = '2026-07-12T20:10:00+00:00';
const LOCK_MS = Date.parse(LOCK);

/** A coherent row: `lastPolledAt` is derived from the gap, as production rows are. */
function raw(overrides: Partial<RawCloseTiming> = {}): RawCloseTiming {
  const base = {
    lockTime: LOCK,
    valueCapturedAt: '2026-07-12T20:09:40+00:00',
    pollGapSeconds: 15 as number | null,
    ...overrides,
  };
  // Tolerates the deliberately-broken inputs these cases supply (an
  // unparseable lock, a non-finite gap): the fixture must not die before the
  // code under test gets to refuse them.
  const lockMs = Date.parse(base.lockTime);
  const derived =
    base.pollGapSeconds === null ||
    !Number.isFinite(base.pollGapSeconds) ||
    !Number.isFinite(lockMs)
      ? null
      : new Date(lockMs - base.pollGapSeconds * 1000).toISOString();
  return {
    ...base,
    lastPolledAt: 'lastPolledAt' in overrides ? (overrides.lastPolledAt ?? null) : derived,
  };
}

/** An instant `ms` from the lock, always offset-qualified. */
const fromLock = (ms: number): string => new Date(LOCK_MS + ms).toISOString();

const violations = (t: ReturnType<typeof closeTiming>): readonly string[] =>
  t.kind === 'unusable' ? t.violations : [];

// ── strict parsing ──────────────────────────────────────────────────────────

test('an offset-less instant is REFUSED, never read as host-local time', () => {
  // The defect this replaces: bare `Date.parse` reads an offset-less ISO
  // string as LOCAL time, so this same pair produced drift 0 on a UTC host and
  // 14400000 on a US-Eastern one. Rejecting the input is what makes the
  // verdict independent of the machine that computed it.
  for (const field of ['lockTime', 'valueCapturedAt', 'lastPolledAt'] as const) {
    const t = closeTiming(raw({ [field]: '2026-07-12T20:10:00', pollGapSeconds: null }));
    assert.equal(t.kind, 'unusable', field);
    assert.ok(
      violations(t).some((v) => /offset-qualified/.test(v)),
      `${field}: ${violations(t).join('; ')}`,
    );
  }
});

test('a null valueCapturedAt / lastPolledAt is ABSENT evidence, not unreadable evidence', () => {
  // The market was never seen in the snapshot; upstream already downgrades
  // that to close_stale. Refusing it here would double-count one refusal
  // under a second name and quietly change coverage.
  const t = closeTiming(raw({ valueCapturedAt: null, lastPolledAt: null, pollGapSeconds: null }));
  assert.equal(t.kind, 'usable');
  assert.equal(closeAfterStart(t), false, 'a never-seen market is not "after start"');
  assert.equal(closeValueAfterLock(t), false);
});

// ── coherence between the stored gap and the raw instants ───────────────────

test('a stored gap that contradicts its own instants is unusable', () => {
  // The forged row from the review: the gap claims the poll preceded lock by
  // an hour while last_polled_at says it came two hours after.
  const t = closeTiming(raw({ pollGapSeconds: 3600, lastPolledAt: fromLock(2 * 3600 * 1000) }));
  assert.equal(t.kind, 'unusable');
  assert.ok(violations(t).some((v) => /disagrees with lock_time - last_polled_at/.test(v)));
});

test('the coherence tolerance is a boundary, swept from both sides', () => {
  // Stored gaps are integer seconds, so a sub-second residual is rounding and
  // must be tolerated; anything past the tolerance is a contradiction.
  const at = (residualMs: number) =>
    closeTiming({
      lockTime: LOCK,
      valueCapturedAt: null,
      lastPolledAt: fromLock(-15_000 + residualMs),
      pollGapSeconds: 15,
    }).kind;
  assert.equal(at(0), 'usable');
  assert.equal(at(POLL_GAP_COHERENCE_TOLERANCE_MS), 'usable', 'exactly at tolerance is tolerated');
  assert.equal(at(POLL_GAP_COHERENCE_TOLERANCE_MS + 1), 'unusable');
  assert.equal(at(-POLL_GAP_COHERENCE_TOLERANCE_MS), 'usable', 'symmetric');
  assert.equal(at(-(POLL_GAP_COHERENCE_TOLERANCE_MS + 1)), 'unusable');
});

test('a gap with no last_polled_at to corroborate it is unusable', () => {
  const t = closeTiming(raw({ pollGapSeconds: 15, lastPolledAt: null }));
  assert.equal(t.kind, 'unusable');
  assert.ok(violations(t).some((v) => /cannot be corroborated/.test(v)));
});

test('a non-finite gap is unusable', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const t = closeTiming(raw({ pollGapSeconds: bad }));
    assert.equal(t.kind, 'unusable', String(bad));
    assert.ok(violations(t).some((v) => /not a finite number/.test(v)));
  }
});

test('every problem is reported at once, not just the first', () => {
  // Accumulating mirrors attemptProvenance's integrity check: an operator
  // fixing one violation should not discover a second on the next run.
  const t = closeTiming({
    lockTime: '2026-07-12T20:10:00',
    valueCapturedAt: 'not-a-date',
    lastPolledAt: 'also-not-a-date',
    pollGapSeconds: 15,
  });
  assert.equal(t.kind, 'unusable');
  assert.equal(violations(t).length, 3, violations(t).join('; '));
});

// ── verdicts refuse to answer from unusable evidence ────────────────────────

test('asking for a verdict on unusable evidence THROWS rather than answering false', () => {
  // The whole point of the typed refusal: a call site that forgot to classify
  // first must fail loudly, not publish a clean verdict it never established.
  const t = closeTiming(raw({ lockTime: 'garbage' }));
  assert.equal(t.kind, 'unusable');
  assert.throws(() => closeAfterStart(t), /classify close_timing_unusable first/);
  assert.throws(() => closeValueAfterLock(t), /classify close_timing_unusable first/);
});

test('closeAfterStart sweeps the boundary and is derived from the instants', () => {
  const at = (deltaMs: number): boolean =>
    closeAfterStart(
      closeTiming({
        lockTime: LOCK,
        valueCapturedAt: null,
        lastPolledAt: fromLock(deltaMs),
        pollGapSeconds: -Math.round(deltaMs / 1000),
      }),
    );
  assert.equal(at(-15_000), false, 'polled well before lock');
  assert.equal(at(0), false, 'polled exactly at lock is not AFTER it');
  assert.equal(at(POLL_GAP_COHERENCE_TOLERANCE_MS - 1), false, 'sub-second rounding is tolerated');
  assert.equal(at(POLL_GAP_COHERENCE_TOLERANCE_MS), true, 'a full second past lock is past lock');
  assert.equal(at(9_700_231), true, 'the largest post-lock delta in the live corpus');
});

test('closeValueAfterLock is distinct from closeAfterStart', () => {
  // One asks whether the FEED was still listing the market; the other whether
  // the VALUE we would score was recorded past the cutoff.
  const t = closeTiming({
    lockTime: LOCK,
    valueCapturedAt: fromLock(60_000),
    lastPolledAt: fromLock(-15_000),
    pollGapSeconds: 15,
  });
  assert.equal(t.kind, 'usable');
  assert.equal(closeAfterStart(t), false, 'the feed stopped listing it before lock');
  assert.equal(closeValueAfterLock(t), true, '...but the price is from after lock');
});

// ── the verdict must not depend on the host's timezone ───────────────────────

test('the verdict does not depend on the host timezone', () => {
  // A direct guard on the original defect. Every accepted instant is
  // offset-qualified, so parsing is absolute and this holds by construction —
  // but assert it, because the failure it guards was invisible on a UTC host
  // and only appeared for operators elsewhere.
  const original = process.env.TZ;
  const results: string[] = [];
  try {
    for (const tz of ['UTC', 'America/New_York', 'Asia/Kolkata']) {
      process.env.TZ = tz;
      const t = closeTiming(raw({ pollGapSeconds: -30 }));
      results.push(`${t.kind}:${t.kind === 'usable' ? closeAfterStart(t) : 'n/a'}`);
      // An offset-LESS instant stays refused in every zone; under the old
      // `Date.parse` implementation it would have been silently accepted with
      // a different meaning in each.
      assert.equal(closeTiming(raw({ lockTime: '2026-07-12T20:10:00' })).kind, 'unusable', tz);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
  assert.equal(new Set(results).size, 1, `verdict differed across timezones: ${results.join(', ')}`);
});
