import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileAsOfVsCurrent } from './lineOpenReconcile.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { CurrentOddsRow } from './types.js';

/**
 * As-of reconciliation. Every test drives the exported reconciler directly; the
 * private current-row normalizer is exercised only THROUGH it (no second public
 * export). Quotes use MLB totals with a non-null line and asymmetric prices so a
 * one-field drift is observable.
 */

const GAME_A = '00000000-0000-4000-8000-00000000000a';
const GAME_B = '00000000-0000-4000-8000-00000000000b';
const DETECTED_AT = '2026-07-18T12:00:30.000Z';
const OPENER_AT = '2026-07-18T12:00:00.000Z'; // <= detectedAt

/** A valid two-sided TOTAL history row (line 8.5, asymmetric -115 / -105). */
function totalHist(over: Partial<TwoSidedHistoryRow> = {}): TwoSidedHistoryRow {
  const captured_at = over.captured_at ?? OPENER_AT;
  return {
    id: 1,
    jsonodds_id: GAME_A,
    market: 'total',
    source: 'jsonodds',
    line: 8.5,
    away_odds_american: -115,
    away_odds_decimal: 1.86957,
    home_odds_american: -105,
    home_odds_decimal: 1.95238,
    ...over,
    captured_at,
    captured_at_ms: over.captured_at_ms ?? Date.parse(captured_at),
  };
}

/** A current_odds TOTAL row (same quote orientation; timestamps deliberately
 *  distinct from the history row's `captured_at`). */
function totalCurrent(over: Partial<CurrentOddsRow> = {}): CurrentOddsRow {
  return {
    network: 'polygon',
    jsonodds_id: GAME_A,
    market: 'total',
    line: 8.5,
    away_odds_american: -115,
    home_odds_american: -105,
    upstream_last_updated: '2026-07-18T11:58:00+00:00',
    poll_captured_at: '2026-07-18T12:00:25+00:00',
    changed_at: '2026-07-18T11:58:00+00:00',
    ...over,
  };
}

function reconcile(over: {
  gameId?: string;
  market?: 'moneyline' | 'spread' | 'total';
  historyRows: readonly TwoSidedHistoryRow[];
  historyWatermark?: number | null;
  detectedAt?: string;
  current: CurrentOddsRow;
}): boolean {
  return reconcileAsOfVsCurrent({
    gameId: over.gameId ?? GAME_A,
    market: over.market ?? 'total',
    historyRows: over.historyRows,
    historyWatermark: over.historyWatermark ?? null,
    detectedAt: over.detectedAt ?? DETECTED_AT,
    current: over.current,
  });
}

// --- match despite differing timestamps ------------------------------

test('reconciliation accepts a matched as-of quote despite differing timestamps', () => {
  // The history captured_at (12:00:00) and the current-row timestamps (11:58) differ,
  // but the (line, away, home) quote matches — accept.
  const history = [totalHist()];
  const current = totalCurrent({
    upstream_last_updated: '2026-07-18T12:00:10+00:00',
    changed_at: '2026-07-18T12:00:10+00:00',
    poll_captured_at: '2026-07-18T12:00:28+00:00',
  });
  assert.equal(reconcile({ historyRows: history, current }), true);
});

test('a moneyline as-of quote with a null line reconciles on prices alone', () => {
  const ml = totalHist({ market: 'moneyline', line: null, away_odds_american: -134, home_odds_american: 117 });
  const current = totalCurrent({ market: 'moneyline', line: null, away_odds_american: -134, home_odds_american: 117 });
  assert.equal(reconcile({ market: 'moneyline', historyRows: [ml], current }), true);
});

// --- drifted quote defers -------------------------------------------

test('reconciliation defers a drifted quote', () => {
  const history = [totalHist()]; // away -115
  // away price moved -115 -> -120; line + home unchanged.
  assert.equal(reconcile({ historyRows: history, current: totalCurrent({ away_odds_american: -120 }) }), false);
  // home price moved.
  assert.equal(reconcile({ historyRows: history, current: totalCurrent({ home_odds_american: -108 }) }), false);
});

// --- no as-of quote -------------------------------------------------

test('reconciliation refuses when no as-of quote exists', () => {
  // The only history row is stamped AFTER detection, so no row is at or before it.
  const after = '2026-07-18T12:01:00.000Z';
  const history = [totalHist({ captured_at: after, captured_at_ms: Date.parse(after) })];
  assert.equal(reconcile({ historyRows: history, current: totalCurrent() }), false);
});

// --- null american prices throw via the exported reconciler ----------

test('the quote derivation refuses a row missing american prices', () => {
  const history = [totalHist()];
  assert.throws(
    () => reconcile({ historyRows: history, current: totalCurrent({ away_odds_american: null }) }),
    /missing an american price/,
  );
  assert.throws(
    () => reconcile({ historyRows: history, current: totalCurrent({ home_odds_american: null }) }),
    /missing an american price/,
  );
});

// --- latest as-of, never the opener ---------------------------------

test('reconciliation compares the latest as-of, never the opener', () => {
  const opener = totalHist({ id: 1, captured_at: '2026-07-18T12:00:00.000Z', away_odds_american: -115, home_odds_american: -105 });
  const later = totalHist({ id: 2, captured_at: '2026-07-18T12:00:20.000Z', away_odds_american: -120, home_odds_american: 105 });
  const history = [opener, later]; // both <= detectedAt (12:00:30); as-of = later
  // current == latest -> true
  assert.equal(reconcile({ historyRows: history, current: totalCurrent({ away_odds_american: -120, home_odds_american: 105 }) }), true);
  // current == opener (stale) -> false
  assert.equal(reconcile({ historyRows: history, current: totalCurrent({ away_odds_american: -115, home_odds_american: -105 }) }), false);
});

// --- a line-only reprice defers -------------------------------------

test('a line-only reprice defers', () => {
  const history = [totalHist({ line: 8.5 })];
  // identical prices, differing line -> false
  assert.equal(reconcile({ historyRows: history, current: totalCurrent({ line: 9 }) }), false);
  // matched line -> true
  assert.equal(reconcile({ historyRows: history, current: totalCurrent({ line: 8.5 }) }), true);
});

// --- as-of honors the watermark -------------------------------------

test('as-of quote honors the history watermark', () => {
  const r1 = totalHist({ id: 1, captured_at: '2026-07-18T12:00:00.000Z', away_odds_american: -115, home_odds_american: -105 });
  const r2 = totalHist({ id: 2, captured_at: '2026-07-18T12:00:10.000Z', away_odds_american: -120, home_odds_american: 105 });
  const history = [r1, r2];
  // watermark 1 drops r2 -> as-of = r1; current == r1 -> true
  assert.equal(
    reconcile({ historyRows: history, historyWatermark: 1, current: totalCurrent({ away_odds_american: -115, home_odds_american: -105 }) }),
    true,
  );
  // unbounded (null) -> as-of = r2; current == r1 -> false (proves the watermark was honored)
  assert.equal(
    reconcile({ historyRows: history, historyWatermark: null, current: totalCurrent({ away_odds_american: -115, home_odds_american: -105 }) }),
    false,
  );
});

// --- a same-valued quote from a crossed pair cannot reconcile --------

test('a crossed current row cannot reconcile even with identical values', () => {
  // The history is the correct pair; the current row carries identical values but a
  // different game — the current-pair identity check throws (control: drop that check).
  const history = [totalHist({ jsonodds_id: GAME_A })];
  assert.throws(
    () => reconcile({ gameId: GAME_A, historyRows: history, current: totalCurrent({ jsonodds_id: GAME_B }) }),
    /does not bind to the expected candidate pair/,
  );
  // A crossed MARKET on the current row is likewise refused.
  assert.throws(
    () => reconcile({ gameId: GAME_A, market: 'total', historyRows: history, current: totalCurrent({ market: 'moneyline' }) }),
    /does not bind to the expected candidate pair/,
  );
});

test('a homogeneous crossed-pair history cannot reconcile even with identical values', () => {
  // The current row is correct; the whole history is a homogeneous FOREIGN pair
  // (single-pair, so assertSinglePair passes) — the expected-pair carrier bind throws
  // (control: drop the history expected-pair check).
  const foreign = [totalHist({ jsonodds_id: GAME_B })];
  assert.throws(
    () => reconcile({ gameId: GAME_A, historyRows: foreign, current: totalCurrent({ jsonodds_id: GAME_A }) }),
    /history evidence .* does not bind to the expected candidate pair/,
  );
});

// --- mixed history pairs fail through the canonical owner -------------

test('mixed history pairs fail through the canonical owner', () => {
  // Two different pairs in one array: asOfQuote runs assertSinglePair over the FULL
  // array (the control that bypasses this by passing only the first row would let the
  // homogeneous check pass and miss the mix).
  const mixed = [totalHist({ id: 1, jsonodds_id: GAME_A }), totalHist({ id: 2, jsonodds_id: GAME_B })];
  assert.throws(
    () => reconcile({ gameId: GAME_A, historyRows: mixed, current: totalCurrent({ jsonodds_id: GAME_A }) }),
    /single \(jsonodds_id, market\) pair/,
  );
});

test('an empty history returns false (no as-of), correct pair or not', () => {
  assert.equal(reconcile({ historyRows: [], current: totalCurrent() }), false);
});
