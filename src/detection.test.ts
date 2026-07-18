import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateDisposition, evaluateCandidate } from './detection.js';
import type { CandidateDisposition, CandidateInput, CandidateState } from './detection.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';

// Observation window and a mid-window detection instant. W = 120 s, skew = 5 s.
const WINDOW_START = '2026-07-18T00:00:00.000Z';
const WINDOW_END = '2026-07-19T00:00:00.000Z';
const DETECTED_AT = '2026-07-18T12:00:00.000Z';
const W = 120_000;
const SKEW = 5_000;

/** An offset-qualified ISO instant shifted from `iso` by `ms`. */
function shift(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/** A valid two-sided opener row whose `captured_at_ms` matches `capturedAt`. */
function openerAt(capturedAt: string, overrides: Partial<TwoSidedHistoryRow> = {}): TwoSidedHistoryRow {
  return {
    id: 1,
    jsonodds_id: 'game-1',
    market: 'moneyline',
    source: 'jsonodds',
    line: null,
    away_odds_american: -120,
    away_odds_decimal: 1.83333,
    home_odds_american: 110,
    home_odds_decimal: 2.1,
    captured_at: capturedAt,
    captured_at_ms: Date.parse(capturedAt),
    ...overrides,
  };
}

function baseInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    gameId: 'game-1', // matches openerAt()'s jsonodds_id
    sport: 'mlb',
    market: 'moneyline',
    sportAllowList: ['mlb'],
    marketPolicyVersion: 'market-policy-v1',
    opener: openerAt(shift(DETECTED_AT, -60_000)), // age 60 s ≤ W
    detectedAt: DETECTED_AT,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    cleanEntryWindowMs: W,
    maxClockSkewMs: SKEW,
    ...overrides,
  };
}

// --- happy path -----------------------------------------------------------

test('eligible: opener in window and within W of detection', () => {
  const opener = openerAt(shift(DETECTED_AT, -60_000));
  assert.deepEqual(evaluateCandidate(baseInput({ opener })), {
    state: 'eligible',
    opener,
    openerAgeMs: 60_000,
  });
});

// --- policy ---------------------------------------------------------------

test('not_enabled: a market the policy disables for the sport (MLB run line)', () => {
  // MLB enables moneyline + total; the run line (the `spread` MarketKey) is OFF.
  assert.deepEqual(evaluateCandidate(baseInput({ market: 'spread' })), { state: 'not_enabled' });
});

test('not_enabled: a sport outside the cohort allow-list', () => {
  assert.deepEqual(evaluateCandidate(baseInput({ sport: 'nfl' })), { state: 'not_enabled' });
});

test('policy is checked before opener availability', () => {
  // Disabled market AND a missing opener → policy wins (not_enabled, not opener_not_visible).
  assert.deepEqual(
    evaluateCandidate(baseInput({ market: 'spread', opener: undefined })),
    { state: 'not_enabled' },
  );
});

// --- opener availability ---------------------------------------------------

test('opener_not_visible: no independent opener yet (transient)', () => {
  assert.deepEqual(evaluateCandidate(baseInput({ opener: undefined })), { state: 'opener_not_visible' });
});

// --- detection window ------------------------------------------------------

test('detected_before_window: detection precedes windowStart', () => {
  assert.deepEqual(
    evaluateCandidate(baseInput({ detectedAt: shift(WINDOW_START, -1) })),
    { state: 'detected_before_window' },
  );
});

test('detected_after_window: detection at windowEnd (upper bound exclusive)', () => {
  assert.deepEqual(
    evaluateCandidate(baseInput({ detectedAt: WINDOW_END })),
    { state: 'detected_after_window' },
  );
});

test('detected_before_window is checked before the opener-window gates', () => {
  // Both detection and opener are out of window; the detection gate reports first.
  const opener = openerAt(shift(WINDOW_END, 60_000));
  assert.deepEqual(
    evaluateCandidate(baseInput({ detectedAt: shift(WINDOW_START, -1), opener })),
    { state: 'detected_before_window' },
  );
});

// --- opener window ---------------------------------------------------------

test('opener_before_window: opener predates windowStart even though age ≤ W', () => {
  // The spec insufficiency case: opener just before windowStart but within W of
  // detection. The bare age gate would admit it; the window gate must reject it.
  const opener = openerAt(shift(WINDOW_START, -30_000));
  assert.deepEqual(
    evaluateCandidate(baseInput({ detectedAt: shift(WINDOW_START, 30_000), opener })),
    { state: 'opener_before_window', opener },
  );
});

test('opener_after_window: opener at windowEnd (upper bound exclusive), before the skew gate', () => {
  // Opener is after detection (would otherwise be a skew case) AND at/after
  // windowEnd; the window gate reports first.
  const opener = openerAt(WINDOW_END);
  assert.deepEqual(
    evaluateCandidate(baseInput({ opener })),
    { state: 'opener_after_window', opener },
  );
});

test('opener at windowStart is inside the window (lower bound inclusive)', () => {
  const opener = openerAt(WINDOW_START);
  assert.deepEqual(
    evaluateCandidate(baseInput({ detectedAt: shift(WINDOW_START, 60_000), opener })),
    { state: 'eligible', opener, openerAgeMs: 60_000 },
  );
});

// --- clock skew ------------------------------------------------------------

test('clock_skew_defer: opener stamped after detection, within tolerance', () => {
  const opener = openerAt(shift(DETECTED_AT, 3_000));
  assert.deepEqual(
    evaluateCandidate(baseInput({ opener })),
    { state: 'clock_skew_defer', opener, skewMs: 3_000 },
  );
});

test('clock_skew_defer: skew exactly at tolerance (inclusive)', () => {
  const opener = openerAt(shift(DETECTED_AT, SKEW));
  assert.deepEqual(
    evaluateCandidate(baseInput({ opener })),
    { state: 'clock_skew_defer', opener, skewMs: SKEW },
  );
});

test('clock_skew_fault: opener stamped after detection beyond tolerance', () => {
  const opener = openerAt(shift(DETECTED_AT, SKEW + 1));
  assert.deepEqual(
    evaluateCandidate(baseInput({ opener })),
    { state: 'clock_skew_fault', opener, skewMs: SKEW + 1 },
  );
});

// --- clean-entry staleness -------------------------------------------------

test('stale_entry: opener older than W', () => {
  const opener = openerAt(shift(DETECTED_AT, -(W + 1)));
  assert.deepEqual(
    evaluateCandidate(baseInput({ opener })),
    { state: 'stale_entry', opener, openerAgeMs: W + 1 },
  );
});

test('age exactly 0 is eligible', () => {
  const opener = openerAt(DETECTED_AT);
  assert.deepEqual(evaluateCandidate(baseInput({ opener })), { state: 'eligible', opener, openerAgeMs: 0 });
});

test('age exactly W is eligible (upper bound inclusive)', () => {
  const opener = openerAt(shift(DETECTED_AT, -W));
  assert.deepEqual(evaluateCandidate(baseInput({ opener })), { state: 'eligible', opener, openerAgeMs: W });
});

test('age W + 1 ms is stale (one past the inclusive bound)', () => {
  const opener = openerAt(shift(DETECTED_AT, -(W + 1)));
  assert.equal(evaluateCandidate(baseInput({ opener })).state, 'stale_entry');
});

test('detection at windowStart is inside the window (lower bound inclusive)', () => {
  const opener = openerAt(WINDOW_START);
  assert.deepEqual(
    evaluateCandidate(baseInput({ detectedAt: WINDOW_START, opener })),
    { state: 'eligible', opener, openerAgeMs: 0 },
  );
});

// --- operational disposition ----------------------------------------------

test('candidateDisposition maps every state to eligible / defer / reject', () => {
  const cases: Array<[CandidateInput, 'eligible' | 'defer' | 'reject']> = [
    [baseInput(), 'eligible'],
    [baseInput({ market: 'spread' }), 'reject'], // not_enabled
    [baseInput({ opener: undefined }), 'defer'], // opener_not_visible
    [baseInput({ detectedAt: shift(WINDOW_START, -1) }), 'defer'], // detected_before_window
    [baseInput({ detectedAt: WINDOW_END }), 'reject'], // detected_after_window
    [
      baseInput({ detectedAt: shift(WINDOW_START, 30_000), opener: openerAt(shift(WINDOW_START, -30_000)) }),
      'reject',
    ], // opener_before_window
    [baseInput({ opener: openerAt(WINDOW_END) }), 'reject'], // opener_after_window
    [baseInput({ opener: openerAt(shift(DETECTED_AT, 3_000)) }), 'defer'], // clock_skew_defer
    [baseInput({ opener: openerAt(shift(DETECTED_AT, SKEW + 1)) }), 'reject'], // clock_skew_fault
    [baseInput({ opener: openerAt(shift(DETECTED_AT, -(W + 1))) }), 'reject'], // stale_entry
  ];
  const seen = new Set<string>();
  for (const [input, expected] of cases) {
    const verdict = evaluateCandidate(input);
    seen.add(verdict.state);
    assert.equal(candidateDisposition(verdict), expected, `${verdict.state} → ${expected}`);
  }
  // Every one of the ten states is exercised.
  assert.equal(seen.size, 10);
});

// --- fail-closed on malformed config / instants ---------------------------

test('throws on an offset-less detectedAt instant', () => {
  assert.throws(() => evaluateCandidate(baseInput({ detectedAt: '2026-07-18T12:00:00' })), /offset/);
});

test('throws on an unparseable window bound', () => {
  assert.throws(() => evaluateCandidate(baseInput({ windowEnd: 'not-an-instant' })));
});

test('throws when windowStart is not strictly before windowEnd', () => {
  assert.throws(
    () => evaluateCandidate(baseInput({ windowStart: WINDOW_END, windowEnd: WINDOW_END })),
    /windowStart must be strictly before windowEnd/,
  );
});

test('throws on a negative clean-entry window', () => {
  assert.throws(() => evaluateCandidate(baseInput({ cleanEntryWindowMs: -1 })), /cleanEntryWindowMs/);
});

test('throws on a non-integer clock-skew bound', () => {
  assert.throws(() => evaluateCandidate(baseInput({ maxClockSkewMs: 1.5 })), /maxClockSkewMs/);
});

// --- candidate ↔ opener identity binding --------------------------

test('throws when the opener is from a different game — jsonodds_id mismatch', () => {
  const opener = openerAt(shift(DETECTED_AT, -30_000), { jsonodds_id: 'game-b' });
  assert.throws(
    () => evaluateCandidate(baseInput({ gameId: 'game-a', opener })),
    /does not match candidate/,
  );
});

test('throws when the opener is for a different market — market mismatch', () => {
  // Candidate `total`, but a same-game moneyline opener.
  const opener = openerAt(shift(DETECTED_AT, -30_000)); // market moneyline
  assert.throws(
    () => evaluateCandidate(baseInput({ market: 'total', opener })),
    /does not match candidate/,
  );
});

test('refuses the stale-market-via-fresh-sibling substitution', () => {
  // The exact substitution class the per-market binding eliminates: a fresh TOTAL
  // opener paired with a MONEYLINE candidate would age-gate as eligible without it.
  const freshTotalOpener = openerAt(shift(DETECTED_AT, -30_000), { market: 'total', line: 8.5 });
  assert.throws(
    () => evaluateCandidate(baseInput({ market: 'moneyline', opener: freshTotalOpener })),
    /does not match candidate/,
  );
});

test('each enabled market is independently evaluable with its OWN opener', () => {
  const mlOpener = openerAt(shift(DETECTED_AT, -60_000), { market: 'moneyline', line: null });
  const totalOpener = openerAt(shift(DETECTED_AT, -60_000), { market: 'total', line: 8.5 });
  assert.equal(evaluateCandidate(baseInput({ market: 'moneyline', opener: mlOpener })).state, 'eligible');
  assert.equal(evaluateCandidate(baseInput({ market: 'total', opener: totalOpener })).state, 'eligible');
});

// --- opener time coherence -------------------------------------------

test('throws on an opener whose derived captured_at_ms is NaN', () => {
  const opener = openerAt(shift(DETECTED_AT, -60_000));
  opener.captured_at_ms = Number.NaN;
  assert.throws(() => evaluateCandidate(baseInput({ opener })), /coherent derivation/);
});

test('throws on an opener whose captured_at_ms is infinite', () => {
  const opener = openerAt(shift(DETECTED_AT, -60_000));
  opener.captured_at_ms = Number.POSITIVE_INFINITY;
  assert.throws(() => evaluateCandidate(baseInput({ opener })), /coherent derivation/);
});

test('throws when captured_at_ms disagrees with captured_at', () => {
  const opener = openerAt(shift(DETECTED_AT, -60_000));
  opener.captured_at_ms += 1_000; // 1 s off the true derivation
  assert.throws(() => evaluateCandidate(baseInput({ opener })), /coherent derivation/);
});

test('throws on an opener with a malformed (offset-less) captured_at instant', () => {
  const opener = openerAt(shift(DETECTED_AT, -60_000));
  opener.captured_at = '2026-07-18T11:59:00'; // no offset — instantMs rejects it first
  assert.throws(() => evaluateCandidate(baseInput({ opener })), /offset/);
});

// --- evidence immutability -------------------------------------------

test('mutating the caller opener after evaluation cannot change the verdict evidence', () => {
  const opener = openerAt(shift(DETECTED_AT, -60_000));
  const verdict = evaluateCandidate(baseInput({ opener }));
  assert.equal(verdict.state, 'eligible');
  if (verdict.state !== 'eligible') return;
  const judged = { ...verdict.opener };
  // Mutate the caller's SOURCE row after the verdict was produced.
  opener.market = 'total';
  opener.captured_at = shift(DETECTED_AT, -10_800_000);
  opener.captured_at_ms = Date.parse(opener.captured_at);
  // The retained evidence is a detached snapshot — unchanged.
  assert.deepEqual(verdict.opener, judged);
  assert.equal(verdict.opener.market, 'moneyline');
  assert.equal(verdict.openerAgeMs, 60_000);
});

test('the returned opener evidence is frozen — mutation through the verdict is refused', () => {
  const opener = openerAt(shift(DETECTED_AT, -60_000));
  const verdict = evaluateCandidate(baseInput({ opener }));
  assert.equal(verdict.state, 'eligible');
  if (verdict.state !== 'eligible') return;
  assert.ok(Object.isFrozen(verdict.opener));
  assert.throws(() => {
    verdict.opener.market = 'total';
  });
});

// --- terminal window closure vs opener presence -----------------

test('window-position × opener-presence cross-product', () => {
  const goodOpener = openerAt(shift(DETECTED_AT, -60_000)); // in-window, matching, age 60 s
  const before = shift(WINDOW_START, -1);
  const inside = DETECTED_AT;
  const atEnd = WINDOW_END;
  const after = shift(WINDOW_END, 60_000);
  const cases: Array<[string, string, TwoSidedHistoryRow | undefined, CandidateState, CandidateDisposition]> = [
    ['before', before, undefined, 'detected_before_window', 'defer'],
    ['before', before, goodOpener, 'detected_before_window', 'defer'],
    ['inside', inside, undefined, 'opener_not_visible', 'defer'],
    ['inside', inside, goodOpener, 'eligible', 'eligible'],
    // At/after the exclusive windowEnd is TERMINAL regardless of opener visibility —
    // a missing opener must NOT downgrade it to a transient defer.
    ['atEnd', atEnd, undefined, 'detected_after_window', 'reject'],
    ['atEnd', atEnd, goodOpener, 'detected_after_window', 'reject'],
    ['after', after, undefined, 'detected_after_window', 'reject'],
    ['after', after, goodOpener, 'detected_after_window', 'reject'],
  ];
  for (const [label, detectedAt, opener, expectedState, expectedDisposition] of cases) {
    const presence = opener ? 'present' : 'absent';
    const verdict = evaluateCandidate(baseInput({ detectedAt, opener }));
    assert.equal(verdict.state, expectedState, `${label}/${presence} state`);
    assert.equal(candidateDisposition(verdict), expectedDisposition, `${label}/${presence} disposition`);
  }
});
