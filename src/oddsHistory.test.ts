import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  asOfQuote,
  firstTwoSided,
  instantMs,
  normalizeQuote,
  parseTwoSidedHistoryRow,
  parseTwoSidedHistoryRows,
  quotesEqual,
} from './oddsHistory.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';

/**
 * The independent odds_history read model (§1 / §5-V1 / §6). Fixtures are raw
 * source rows; the predicate validates them FAIL-CLOSED, and the derivations pick
 * the first two-sided appearance and the as-of quote by the ms-precise,
 * id-tiebroken, watermark-bounded order.
 */

function rawRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 100,
    jsonodds_id: 'game-1',
    market: 'total',
    source: 'jsonodds',
    line: 8.5,
    away_odds_american: -110,
    away_odds_decimal: 1.909,
    home_odds_american: -110,
    home_odds_decimal: 1.909,
    captured_at: '2026-07-16T00:00:00.000Z',
    sportspage_id: null, // extra passthrough columns must be tolerated
    created_at: '2026-07-16T00:00:00.000Z',
    ...over,
  };
}

function vrow(over: Record<string, unknown> = {}): TwoSidedHistoryRow {
  const row = parseTwoSidedHistoryRow(rawRow(over));
  assert.ok(row, 'fixture row must be valid');
  return row;
}

// --- validTwoSidedHistoryRowV1 predicate ---

test('a valid two-sided jsonodds row parses; the derived ms sort key is set', () => {
  const r = parseTwoSidedHistoryRow(rawRow());
  assert.ok(r);
  assert.equal(r.captured_at_ms, Date.parse('2026-07-16T00:00:00.000Z'));
  assert.equal(r.market, 'total');
  assert.equal(r.source, 'jsonodds');
});

test('a non-jsonodds source is rejected', () => {
  assert.equal(parseTwoSidedHistoryRow(rawRow({ source: 'sportspage_open' })), null);
});

test('an unknown market is rejected', () => {
  assert.equal(parseTwoSidedHistoryRow(rawRow({ market: 'firstbasket' })), null);
});

test('missing / zero / fractional / unsafe american odds are rejected', () => {
  for (const bad of [null, undefined, 0, -110.5, 9007199254740993]) {
    assert.equal(parseTwoSidedHistoryRow(rawRow({ away_odds_american: bad })), null, `away=${bad}`);
    assert.equal(parseTwoSidedHistoryRow(rawRow({ home_odds_american: bad })), null, `home=${bad}`);
  }
});

test('decimal odds must be finite and > 1', () => {
  for (const bad of [null, 1, 0.9, Infinity, NaN]) {
    assert.equal(parseTwoSidedHistoryRow(rawRow({ away_odds_decimal: bad })), null, `away=${bad}`);
    assert.equal(parseTwoSidedHistoryRow(rawRow({ home_odds_decimal: bad })), null, `home=${bad}`);
  }
});

test('line must be null for moneyline and finite for spread/total', () => {
  assert.ok(parseTwoSidedHistoryRow(rawRow({ market: 'moneyline', line: null })));
  assert.equal(parseTwoSidedHistoryRow(rawRow({ market: 'moneyline', line: 0 })), null); // moneyline needs null
  assert.equal(parseTwoSidedHistoryRow(rawRow({ market: 'total', line: null })), null); // total needs finite
  assert.ok(parseTwoSidedHistoryRow(rawRow({ market: 'spread', line: -1.5 })));
  assert.equal(parseTwoSidedHistoryRow(rawRow({ market: 'total', line: Infinity })), null);
});

test('captured_at must be an offset-qualified instant (µs accepted, naive rejected)', () => {
  assert.ok(parseTwoSidedHistoryRow(rawRow({ captured_at: '2026-07-16T00:00:00.123456+00:00' })));
  assert.equal(parseTwoSidedHistoryRow(rawRow({ captured_at: '2026-07-16T00:00:00' })), null);
  assert.equal(parseTwoSidedHistoryRow(rawRow({ captured_at: 'not-a-date' })), null);
});

test('id must be a safe positive integer', () => {
  for (const bad of [0, -1, 1.5, 9007199254740993, null]) {
    assert.equal(parseTwoSidedHistoryRow(rawRow({ id: bad })), null, `id=${bad}`);
  }
});

test('parseTwoSidedHistoryRows drops invalid rows and reports the count', () => {
  const { rows, dropped } = parseTwoSidedHistoryRows([
    rawRow({ id: 1 }),
    rawRow({ id: 2, source: 'sportspage_open' }),
    rawRow({ id: 3 }),
  ]);
  assert.deepEqual(rows.map((r) => r.id), [1, 3]);
  assert.equal(dropped, 1);
  assert.throws(() => parseTwoSidedHistoryRows({ not: 'an array' }));
});

// --- derivations ---

test('firstTwoSided picks the earliest by (captured_at, id); a post-watermark row is ignored (case 40)', () => {
  const t0 = '2026-07-16T00:00:00.000Z';
  const early = vrow({ id: 50, captured_at: t0 });
  const earlyTie = vrow({ id: 40, captured_at: t0 }); // same ms, lower id wins the tiebreak
  const later = vrow({ id: 10, captured_at: '2026-07-16T00:05:00.000Z' });
  const postWatermark = vrow({ id: 200, captured_at: '2026-07-15T23:00:00.000Z' }); // earliest of all, high id
  const rows = [later, early, earlyTie, postWatermark];
  // No watermark: the genuinely-earliest row wins even with the highest id.
  assert.equal(firstTwoSided(rows)?.id, 200);
  // Watermark 100 excludes id 200 -> the earliest eligible is the (t0, id 40) tiebreak winner.
  assert.equal(firstTwoSided(rows, 100)?.id, 40);
  assert.equal(firstTwoSided([]), undefined);
});

test('asOfQuote returns the greatest captured_at <= t (inclusive), id tiebreak DESC, watermark-bounded', () => {
  const a = vrow({ id: 1, captured_at: '2026-07-16T00:00:00.000Z' });
  const b = vrow({ id: 2, captured_at: '2026-07-16T00:03:00.000Z' });
  const bTie = vrow({ id: 5, captured_at: '2026-07-16T00:03:00.000Z' }); // same ms, higher id wins DESC
  const c = vrow({ id: 3, captured_at: '2026-07-16T00:10:00.000Z' });
  const rows = [a, b, bTie, c];
  // t exactly at b's ms -> inclusive, and the higher id (5) wins the tiebreak.
  assert.equal(asOfQuote(rows, '2026-07-16T00:03:00.000Z')?.id, 5);
  // t between the b-group and c -> the b-group is the latest <= t.
  assert.equal(asOfQuote(rows, '2026-07-16T00:05:00.000Z')?.id, 5);
  // t before the first row -> undefined.
  assert.equal(asOfQuote(rows, '2026-07-15T23:00:00.000Z'), undefined);
  // watermark 4 excludes the higher-id tie (id 5) -> id 2 wins its ms group.
  assert.equal(asOfQuote(rows, '2026-07-16T00:03:00.000Z', 4)?.id, 2);
});

test('asOfQuote rejects a naive (offset-less) t', () => {
  assert.throws(() => asOfQuote([], '2026-07-16T00:03:00'), /explicit offset/);
});

test('instantMs requires an explicit offset and honors the offset', () => {
  assert.equal(instantMs('2026-07-16T00:00:00.000Z'), Date.parse('2026-07-16T00:00:00.000Z'));
  assert.equal(instantMs('2026-07-16T05:00:00.000+05:00'), Date.parse('2026-07-16T00:00:00.000Z'));
  assert.throws(() => instantMs('2026-07-16T00:00:00'), /explicit offset/);
  assert.throws(() => instantMs('nope'), /explicit offset/);
});

// --- normalization (V1 quote identity) ---

test('normalizeQuote uses line + both american odds; decimal is not part of quote identity', () => {
  const q = normalizeQuote(vrow({ line: 8.5, away_odds_american: -105, home_odds_american: -115 }));
  assert.deepEqual(q, { line: 8.5, away_odds_american: -105, home_odds_american: -115 });
  // Two rows differing only in decimal odds normalize equal.
  const a = normalizeQuote(vrow({ away_odds_decimal: 1.9 }));
  const b = normalizeQuote(vrow({ away_odds_decimal: 1.95 }));
  assert.ok(quotesEqual(a, b));
});

test('quotesEqual is exact on line + americans; moneyline null lines compare equal', () => {
  const base = { market: 'moneyline', line: null, away_odds_american: 120, home_odds_american: -140 };
  const ml1 = normalizeQuote(vrow(base));
  const ml2 = normalizeQuote(vrow(base));
  assert.ok(quotesEqual(ml1, ml2));
  assert.ok(!quotesEqual(ml1, normalizeQuote(vrow({ ...base, away_odds_american: 121 }))));
});

// --- fail-closed hardening + boundary proofs (adversarial review) ---

test('a captured_at whose offset passes the regex but is out of range (NaN) is rejected', () => {
  // zod's datetime regex accepts +99:99 but Date.parse yields NaN — it must NOT
  // survive into the sort key, or it would poison firstTwoSided/asOfQuote.
  assert.equal(parseTwoSidedHistoryRow(rawRow({ captured_at: '2026-07-16T00:00:00+99:99' })), null);
  const { rows, dropped } = parseTwoSidedHistoryRows([
    rawRow({ id: 1 }),
    rawRow({ id: 2, captured_at: '2026-07-16T00:00:00+99:99' }),
  ]);
  assert.deepEqual(rows.map((r) => r.id), [1]);
  assert.equal(dropped, 1);
});

test('instantMs and asOfQuote reject an out-of-range-offset (NaN) instant', () => {
  assert.throws(() => instantMs('2026-07-16T00:00:00+99:99'));
  assert.throws(() => asOfQuote([], '2026-07-16T00:00:00+99:99'));
});

test('the watermark boundary is inclusive — id === watermark is retained', () => {
  const r10 = vrow({ id: 10, captured_at: '2026-07-16T00:01:00.000Z' });
  const r20 = vrow({ id: 20, captured_at: '2026-07-16T00:02:00.000Z' });
  // firstTwoSided: watermark 10 keeps id 10 (==wm), excludes id 20; a strict `<` bug would return undefined.
  assert.equal(firstTwoSided([r10, r20], 10)?.id, 10);
  // asOfQuote: watermark 20 keeps id 20 (==wm, the latest); a strict `<` bug would return id 10.
  assert.equal(asOfQuote([r10, r20], '2026-07-16T00:05:00.000Z', 20)?.id, 20);
});

test('sub-ms differences collapse to equal ms so the id tiebreak decides order', () => {
  const loId = vrow({ id: 3, captured_at: '2026-07-16T00:00:00.123001+00:00' });
  const hiId = vrow({ id: 7, captured_at: '2026-07-16T00:00:00.123999+00:00' });
  assert.equal(loId.captured_at_ms, hiId.captured_at_ms); // both truncate to .123
  assert.equal(firstTwoSided([loId, hiId])?.id, 3); // equal ms -> lower id wins ASC
  assert.equal(asOfQuote([loId, hiId], '2026-07-16T00:00:01.000Z')?.id, 7); // equal ms -> higher id wins DESC
});

test('a watermark below every id yields undefined (all rows excluded)', () => {
  const r10 = vrow({ id: 10, captured_at: '2026-07-16T00:01:00.000Z' });
  const r20 = vrow({ id: 20, captured_at: '2026-07-16T00:02:00.000Z' });
  assert.equal(firstTwoSided([r10, r20], 5), undefined);
  assert.equal(asOfQuote([r10, r20], '2026-07-16T00:05:00.000Z', 5), undefined);
});

test('the derivations refuse a mixed (jsonodds_id, market) input (fail-closed)', () => {
  const a = vrow({ id: 1, jsonodds_id: 'game-1', market: 'total' });
  const b = vrow({ id: 2, jsonodds_id: 'game-2', market: 'total' });
  assert.throws(() => firstTwoSided([a, b]), /single \(jsonodds_id, market\) pair/);
  assert.throws(() => asOfQuote([a, b], '2026-07-16T00:05:00.000Z'), /single \(jsonodds_id, market\) pair/);
});
