import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  closingTotalRecord,
  closingTotalRecordSchema,
  parseInhouseTotalsDataset,
} from './inhouseTotals.js';
import type { ClosingTotalRecord, InhouseTotalsMetaRecord } from './inhouseTotals.js';
import type { ClosingLineRow, GamesTableRow } from './types.js';

// Fixtures mirror the REAL wire shapes: a closing_lines PostgREST row as the
// production scorer already consumes it, and a games-table row as the live
// probe returned it (scores latched, final_type 'Finished', status STILL
// 'upcoming' — completion must be judged from scores + final_type).

function closeRow(overrides: Partial<ClosingLineRow> = {}): ClosingLineRow {
  return {
    network: 'polygon',
    jsonodds_id: 'c0a2f8f0-0000-0000-0000-000000000001',
    market: 'total',
    line: 8.5,
    away_odds_decimal: 1.90476,
    home_odds_decimal: 1.90476,
    away_p_novig: 0.5,
    home_p_novig: 0.5,
    value_captured_at: '2026-07-12T19:59:41+00:00',
    last_polled_at: '2026-07-12T20:09:41+00:00',
    lock_time: '2026-07-12T20:10:00+00:00',
    poll_gap_seconds: 19,
    confidence: 'fresh',
    source: 'jsonodds',
    ...overrides,
  };
}

function gameRow(overrides: Partial<GamesTableRow> = {}): GamesTableRow {
  return {
    network: 'polygon',
    jsonodds_id: 'c0a2f8f0-0000-0000-0000-000000000001',
    sport: 'mlb',
    match_time: '2026-07-12T20:10:00+00:00',
    status: 'upcoming',
    home_score: 4,
    away_score: 3,
    final_type: 'Finished',
    score_captured: true,
    ...overrides,
  };
}

test('a finished game with scores becomes a pair record (final attached)', () => {
  const record = closingTotalRecord(closeRow(), gameRow());
  assert.ok(record !== null, 'expected a record');
  assert.deepEqual(record.final, { awayScore: 3, homeScore: 4, total: 7, finalType: 'Finished' });
  assert.equal(record.line, 8.5);
  assert.equal(record.gameId, 'c0a2f8f0-0000-0000-0000-000000000001');
  // The builder's output always satisfies the reader's schema.
  assert.deepEqual(closingTotalRecordSchema.parse(record), record);
});

test('status is IGNORED for completion — scores + final_type decide', () => {
  // The live shape: finals keep status 'upcoming'. A record built from it
  // must still carry the final.
  const record = closingTotalRecord(closeRow(), gameRow({ status: 'upcoming' }));
  assert.ok(record?.final !== null && record !== null, 'final must attach despite status');
});

test('scores without final_type Finished do NOT attach a final', () => {
  const record = closingTotalRecord(closeRow(), gameRow({ final_type: 'Postponed' }));
  assert.ok(record !== null, 'record still written');
  assert.equal(record.final, null);
});

test('missing scores mean no final, even when final_type says Finished', () => {
  const record = closingTotalRecord(closeRow(), gameRow({ home_score: null }));
  assert.ok(record !== null, 'record still written');
  assert.equal(record.final, null);
});

test('a totals close without a line is dropped (returns null)', () => {
  assert.equal(closingTotalRecord(closeRow({ line: null }), gameRow()), null);
});

// ---------------------------------------------------------------------------
// dataset contract
// ---------------------------------------------------------------------------

function record(final: ClosingTotalRecord['final']): ClosingTotalRecord {
  const built = closingTotalRecord(
    closeRow(),
    final === null ? gameRow({ home_score: null, away_score: null, final_type: null }) : gameRow(),
  );
  if (built === null) throw new Error('fixture record unexpectedly null');
  return built;
}

function meta(overrides: Partial<InhouseTotalsMetaRecord> = {}): InhouseTotalsMetaRecord {
  return {
    recordType: 'inhouse_totals_meta',
    network: 'polygon',
    sport: 'mlb',
    mlbGames: 2,
    records: 2,
    pairs: 1,
    droppedNullLine: 0,
    finalsWithheldNotFinished: 0,
    confidence: { fresh: 2 },
    lockTimeRange: ['2026-07-12T20:10:00+00:00', '2026-07-12T20:10:00+00:00'],
    generatedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

function datasetText(metaRecord: InhouseTotalsMetaRecord, records: ClosingTotalRecord[]): string {
  return [metaRecord, ...records].map((r) => JSON.stringify(r)).join('\n');
}

test('parseInhouseTotalsDataset: happy path with re-derived pair count', () => {
  const dataset = parseInhouseTotalsDataset(
    datasetText(meta(), [record({ awayScore: 3, homeScore: 4, total: 7, finalType: 'Finished' }), record(null)]),
  );
  assert.equal(dataset.records.length, 2);
  assert.equal(dataset.meta.pairs, 1);
});

test('parseInhouseTotalsDataset: record-count mismatch is refused', () => {
  const text = datasetText(meta({ records: 3 }), [record(null), record(null)]);
  assert.throws(() => parseInhouseTotalsDataset(text), /truncated or edited/);
});

test('parseInhouseTotalsDataset: pair-count mismatch is refused', () => {
  const text = datasetText(meta({ pairs: 0 }), [
    record({ awayScore: 3, homeScore: 4, total: 7, finalType: 'Finished' }),
    record(null),
  ]);
  assert.throws(() => parseInhouseTotalsDataset(text), /truncated or edited/);
});
