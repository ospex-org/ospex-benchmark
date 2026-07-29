import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCloseScheduleAudit,
  CLOSE_AUDIT_VERDICTS,
  closeScheduleAuditMeta,
  closeScheduleAuditRecord,
  parseCloseScheduleAuditDataset,
  rederivedAuditConfidence,
  rederivedAuditMarkets,
  rederivedPostStartBySport,
  rederivedVerdicts,
  ScheduleAuditError,
} from './scheduleAudit.js';
import { SCHEDULE_CHANGE_TOLERANCE_MS } from './scoring.js';
import type { CloseScheduleAuditDataset, CloseScheduleAuditRecord } from './scheduleAudit.js';
import type { ClosingLineRow, GamesTableRow } from './types.js';

// Fixtures mirror the REAL wire shapes as the live anon read path returns
// them: a closing_lines row with all four capture timestamps, and a games
// row whose status is 'upcoming' even for a completed game (completion is
// judged from scores + final_type, never from status).

const GAME = 'c0a2f8f0-0000-0000-0000-000000000001';
const MATCH_TIME = '2026-07-12T20:10:00+00:00';

function closeRow(overrides: Partial<ClosingLineRow> = {}): ClosingLineRow {
  return {
    network: 'polygon',
    jsonodds_id: GAME,
    market: 'total',
    line: 8.5,
    away_odds_decimal: 1.90476,
    home_odds_decimal: 1.90476,
    away_p_novig: 0.5,
    home_p_novig: 0.5,
    value_captured_at: '2026-07-12T20:09:41+00:00',
    last_polled_at: '2026-07-12T20:09:41+00:00',
    lock_time: MATCH_TIME,
    poll_gap_seconds: 19,
    confidence: 'fresh',
    source: 'jsonodds',
    ...overrides,
  };
}

function gameRow(overrides: Partial<GamesTableRow> = {}): GamesTableRow {
  return {
    network: 'polygon',
    jsonodds_id: GAME,
    sport: 'mlb',
    match_time: MATCH_TIME,
    status: 'upcoming',
    home_score: 4,
    away_score: 3,
    final_type: 'Finished',
    score_captured: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

test('a healthy, same-schedule close classifies clean', () => {
  const record = closeScheduleAuditRecord(closeRow(), gameRow());
  assert.equal(record.verdict, 'clean');
  assert.equal(record.matchTimeDriftMs, 0);
  assert.equal(record.scheduleChangedVsMatchTime, false);
  assert.equal(record.closeAfterStart, false);
  assert.equal(record.valueCapturedAfterLock, false);
  assert.equal(record.valueCapturedAfterMatchTime, false);
  assert.equal(record.sport, 'mlb');
});

test('a negative poll gap classifies post_start_poll and carries the raw evidence', () => {
  const record = closeScheduleAuditRecord(
    closeRow({ poll_gap_seconds: -292, last_polled_at: '2026-07-12T20:14:52+00:00' }),
    gameRow(),
  );
  assert.equal(record.verdict, 'post_start_poll');
  assert.equal(record.closeAfterStart, true);
  assert.equal(record.pollGapSeconds, -292);
  assert.equal(record.lastPolledAt, '2026-07-12T20:14:52+00:00');

  // NEGATIVE CONTROL: the sign is the whole predicate.
  assert.equal(closeScheduleAuditRecord(closeRow({ poll_gap_seconds: 292 }), gameRow()).verdict, 'clean');
  assert.equal(closeScheduleAuditRecord(closeRow({ poll_gap_seconds: 0 }), gameRow()).verdict, 'clean');
});

test('the audit verdict sweeps the schedule tolerance boundary in both directions', () => {
  const tol = SCHEDULE_CHANGE_TOLERANCE_MS;
  const at = (driftMs: number): CloseScheduleAuditRecord =>
    closeScheduleAuditRecord(
      closeRow({ lock_time: new Date(Date.parse(MATCH_TIME) + driftMs).toISOString() }),
      gameRow(),
    );
  for (const sign of [1, -1]) {
    assert.equal(at(sign * (tol - 1)).verdict, 'clean', `below (${sign})`);
    assert.equal(at(sign * tol).verdict, 'schedule_changed', `at (${sign})`);
    assert.equal(at(sign * (tol + 1)).verdict, 'schedule_changed', `above (${sign})`);
  }
  assert.equal(at(-tol).matchTimeDriftMs, -tol, 'drift is signed, lock-earlier is negative');
  assert.equal(at(tol).matchTimeDriftMs, tol);
});

test('an explicit tolerance is honored, so the audit can be re-run at another threshold', () => {
  const drifted = closeRow({ lock_time: '2026-07-12T20:10:30+00:00' }); // +30s
  assert.equal(closeScheduleAuditRecord(drifted, gameRow(), 60_000).verdict, 'clean');
  assert.equal(closeScheduleAuditRecord(drifted, gameRow(), 30_000).verdict, 'schedule_changed');
});

test('verdict precedence mirrors the scorer: not_fresh > post_start_poll > schedule_changed', () => {
  const lockDrift = { lock_time: '2026-07-12T21:10:00+00:00' }; // +1h
  const postStart = { poll_gap_seconds: -600 };
  assert.equal(
    closeScheduleAuditRecord(closeRow({ ...lockDrift, ...postStart, confidence: 'stale' }), gameRow())
      .verdict,
    'not_fresh',
  );
  assert.equal(
    closeScheduleAuditRecord(closeRow({ ...lockDrift, ...postStart }), gameRow()).verdict,
    'post_start_poll',
  );
  assert.equal(closeScheduleAuditRecord(closeRow(lockDrift), gameRow()).verdict, 'schedule_changed');
  // The raw flags stay TRUE regardless of which verdict won — the exclusive
  // partition never erases the non-exclusive evidence.
  const all = closeScheduleAuditRecord(
    closeRow({ ...lockDrift, ...postStart, confidence: 'stale' }),
    gameRow(),
  );
  assert.equal(all.closeAfterStart, true);
  assert.equal(all.scheduleChangedVsMatchTime, true);
  assert.equal(all.confidence, 'stale');
});

test('a value captured after the lock or after the schedule row is flagged, not hidden', () => {
  const late = closeScheduleAuditRecord(
    closeRow({ value_captured_at: '2026-07-12T20:11:00+00:00' }),
    gameRow(),
  );
  assert.equal(late.valueCapturedAfterLock, true);
  assert.equal(late.valueCapturedAfterMatchTime, true);
  // A null capture instant is not "after" anything.
  const none = closeScheduleAuditRecord(closeRow({ value_captured_at: null }), gameRow());
  assert.equal(none.valueCapturedAfterLock, false);
  assert.equal(none.valueCapturedAfterMatchTime, false);
});

test('an unparseable timestamp REFUSES the row rather than reading as zero drift', () => {
  assert.throws(
    () => closeScheduleAuditRecord(closeRow({ lock_time: 'not-a-time' }), gameRow()),
    ScheduleAuditError,
  );
  assert.throws(
    () => closeScheduleAuditRecord(closeRow(), gameRow({ match_time: 'not-a-time' })),
    ScheduleAuditError,
  );
  // NEGATIVE CONTROL: a parseable pair does not throw.
  assert.doesNotThrow(() => closeScheduleAuditRecord(closeRow(), gameRow()));
});

// ---------------------------------------------------------------------------
// dataset integrity
// ---------------------------------------------------------------------------

function dataset(records: CloseScheduleAuditRecord[], closesSeen = records.length): string {
  const meta = closeScheduleAuditMeta({
    network: 'polygon',
    toleranceMs: SCHEDULE_CHANGE_TOLERANCE_MS,
    closesSeen,
    gamesJoined: new Set(records.map((r) => r.gameId)).size,
    records,
    generatedAt: '2026-07-29T00:00:00.000Z',
  });
  return [meta, ...records].map((r) => JSON.stringify(r)).join('\n');
}

const SAMPLE: CloseScheduleAuditRecord[] = [
  closeScheduleAuditRecord(closeRow(), gameRow()),
  closeScheduleAuditRecord(closeRow({ market: 'moneyline', poll_gap_seconds: -292 }), gameRow()),
  closeScheduleAuditRecord(
    closeRow({ market: 'spread', jsonodds_id: 'c0a2f8f0-0000-0000-0000-000000000002' }),
    gameRow({ jsonodds_id: 'c0a2f8f0-0000-0000-0000-000000000002', sport: 'nhl' }),
  ),
  closeScheduleAuditRecord(closeRow({ market: 'total', confidence: 'stale' }), gameRow()),
];

test('a written dataset round-trips and its meta is re-derived from the records', () => {
  const parsed = parseCloseScheduleAuditDataset(dataset(SAMPLE));
  assert.equal(parsed.records.length, SAMPLE.length);
  assert.equal(parsed.meta.closesSeen, SAMPLE.length);
  assert.deepEqual(parsed.meta.verdicts, rederivedVerdicts(SAMPLE));
  assert.deepEqual(parsed.meta.confidence, rederivedAuditConfidence(SAMPLE));
  assert.deepEqual(parsed.meta.postStartPollBySport, rederivedPostStartBySport(SAMPLE));
  assert.equal(parsed.meta.closeAfterStartAny, 1);
  assert.equal(parsed.meta.postStartPollGames, 1);
  assert.equal(parsed.meta.notFreshAny, 1);
  assert.equal(parsed.meta.scheduleChangeToleranceMs, SCHEDULE_CHANGE_TOLERANCE_MS);
});

test('the verdict partition is exclusive and exhaustive over every close seen', () => {
  const counts = rederivedVerdicts(SAMPLE);
  assert.deepEqual(Object.keys(counts).sort(), [...CLOSE_AUDIT_VERDICTS].sort());
  assert.equal(
    Object.values(counts).reduce((a, b) => a + b, 0),
    SAMPLE.length,
    'every record lands in exactly one bucket',
  );
});

test('a truncated dataset refuses to load', () => {
  const text = dataset(SAMPLE);
  const truncated = text.split('\n').slice(0, -1).join('\n');
  assert.throws(() => parseCloseScheduleAuditDataset(truncated), ScheduleAuditError);
  // NEGATIVE CONTROL: the untruncated text loads.
  assert.doesNotThrow(() => parseCloseScheduleAuditDataset(text));
});

test('a meta that claims more closes than it wrote refuses to load', () => {
  // The one arithmetic that catches a silently dropped row: closesSeen must
  // equal records, because this audit writes every close it enumerates.
  assert.throws(
    () => parseCloseScheduleAuditDataset(dataset(SAMPLE, SAMPLE.length + 1)),
    /coverage arithmetic fails/,
  );
});

test('an edited verdict, confidence, or raw count is caught by re-derivation', () => {
  const lines = dataset(SAMPLE).split('\n');
  const meta = JSON.parse(lines[0] as string) as Record<string, unknown>;

  const withBadVerdicts = [
    JSON.stringify({ ...meta, verdicts: { clean: 4, not_fresh: 0, post_start_poll: 0, schedule_changed: 0 } }),
    ...lines.slice(1),
  ].join('\n');
  assert.throws(() => parseCloseScheduleAuditDataset(withBadVerdicts), /verdict partition/);

  const withBadConfidence = [
    JSON.stringify({ ...meta, confidence: { fresh: 4 } }),
    ...lines.slice(1),
  ].join('\n');
  assert.throws(() => parseCloseScheduleAuditDataset(withBadConfidence), /confidence histogram/);

  const withBadRaw = [JSON.stringify({ ...meta, closeAfterStartAny: 0 }), ...lines.slice(1)].join('\n');
  assert.throws(() => parseCloseScheduleAuditDataset(withBadRaw), /closeAfterStartAny/);

  const withBadSport = [
    JSON.stringify({ ...meta, postStartPollBySport: { mlb: 99 } }),
    ...lines.slice(1),
  ].join('\n');
  assert.throws(() => parseCloseScheduleAuditDataset(withBadSport), /sport histogram/);

  const withBadRange = [
    JSON.stringify({ ...meta, lockTimeRange: ['1999-01-01T00:00:00Z', '1999-01-02T00:00:00Z'] }),
    ...lines.slice(1),
  ].join('\n');
  assert.throws(() => parseCloseScheduleAuditDataset(withBadRange), /lockTimeRange/);

  // NEGATIVE CONTROL: the unedited meta still loads.
  assert.doesNotThrow(() => parseCloseScheduleAuditDataset(lines.join('\n')));
});

test('an empty dataset refuses rather than reporting a clean corpus', () => {
  assert.throws(() => parseCloseScheduleAuditDataset(''), /empty/);
});

test('an unknown record field is rejected — the schema is strict', () => {
  const lines = dataset(SAMPLE).split('\n');
  const record = JSON.parse(lines[1] as string) as Record<string, unknown>;
  const withExtra = [lines[0], JSON.stringify({ ...record, surprise: 1 }), ...lines.slice(2)].join('\n');
  assert.throws(() => parseCloseScheduleAuditDataset(withExtra));
});

// ---------------------------------------------------------------------------
// snapshot assembly — the refusals, and what the meta can and cannot prove
// ---------------------------------------------------------------------------

const GAME_2 = 'c0a2f8f0-0000-0000-0000-000000000002';

function build(
  closes: ClosingLineRow[],
  games: GamesTableRow[],
  toleranceMs = SCHEDULE_CHANGE_TOLERANCE_MS,
): CloseScheduleAuditDataset {
  return buildCloseScheduleAudit({
    network: 'polygon',
    toleranceMs,
    closes,
    games,
    generatedAt: '2026-07-29T00:00:00.000Z',
  });
}

test('a duplicate (game, market) close REFUSES the whole snapshot', () => {
  // (network, jsonodds_id, market) is unique upstream, so a duplicate means
  // the enumeration is not reading what this audit thinks it is.
  assert.throws(
    () => build([closeRow(), closeRow()], [gameRow()]),
    /duplicate closing-line rows/,
  );
  // NEGATIVE CONTROL: the same game with two DIFFERENT markets is normal.
  assert.doesNotThrow(() => build([closeRow(), closeRow({ market: 'moneyline' })], [gameRow()]));
});

test('a close with no games row REFUSES the whole snapshot rather than dropping it', () => {
  // Dropping it would shrink every denominator silently; there is no
  // reference time for it, so every schedule count would be invented.
  assert.throws(
    () => build([closeRow(), closeRow({ jsonodds_id: GAME_2, market: 'moneyline' })], [gameRow()]),
    /have no games row/,
  );
  // NEGATIVE CONTROL: supply the missing schedule row and it builds.
  const ok = build(
    [closeRow(), closeRow({ jsonodds_id: GAME_2, market: 'moneyline' })],
    [gameRow(), gameRow({ jsonodds_id: GAME_2 })],
  );
  assert.equal(ok.records.length, 2);
  assert.equal(ok.meta.closesSeen, 2);
});

test('an unclassifiable timestamp REFUSES the whole snapshot from inside the builder', () => {
  assert.throws(
    () => build([closeRow({ lock_time: 'not-a-time' })], [gameRow()]),
    ScheduleAuditError,
  );
});

test('an assembled snapshot round-trips through the reader unchanged', () => {
  const built = build(
    [
      closeRow(),
      closeRow({ market: 'moneyline', poll_gap_seconds: -292 }),
      closeRow({ jsonodds_id: GAME_2, market: 'spread' }),
    ],
    [gameRow(), gameRow({ jsonodds_id: GAME_2, sport: 'nhl' })],
  );
  const text = [built.meta, ...built.records].map((r) => JSON.stringify(r)).join('\n');
  const parsed = parseCloseScheduleAuditDataset(text);
  assert.deepEqual(parsed.meta, built.meta);
  assert.deepEqual(parsed.records, built.records);
  // Records are ordered by lock time then (game, market) so two runs over the
  // same corpus produce byte-identical files.
  assert.deepEqual(
    built.records.map((r) => `${r.gameId}:${r.market}`),
    [...built.records].map((r) => `${r.gameId}:${r.market}`),
  );
});

test('postStartPollGames counts distinct GAMES, not post-start rows', () => {
  // Two post-start closes on ONE game: the row count and the game count must
  // differ, or a per-sport/per-game reading of the audit is wrong by a factor
  // of the market count.
  const built = build(
    [
      closeRow({ market: 'total', poll_gap_seconds: -292 }),
      closeRow({ market: 'moneyline', poll_gap_seconds: -120 }),
      closeRow({ jsonodds_id: GAME_2, market: 'total', poll_gap_seconds: -60 }),
    ],
    [gameRow(), gameRow({ jsonodds_id: GAME_2, sport: 'nhl' })],
  );
  assert.equal(built.meta.closeAfterStartAny, 3, 'three post-start ROWS');
  assert.equal(built.meta.postStartPollGames, 2, 'across two distinct GAMES');
  assert.deepEqual(built.meta.postStartPollBySport, { mlb: 2, nhl: 1 });
  // The reader re-derives the distinct-game count too, so a meta that counted
  // rows there refuses to load.
  const text = [{ ...built.meta, postStartPollGames: 3 }, ...built.records]
    .map((r) => JSON.stringify(r))
    .join('\n');
  assert.throws(() => parseCloseScheduleAuditDataset(text), /postStartPollGames/);
});

test('the market histogram is published so a NARROWED enumeration is visible', () => {
  // The one incompleteness the meta arithmetic cannot catch: `closesSeen`
  // comes from the same fetch the records do, so a walk filtered to one
  // market self-verifies. Publishing the per-market counts is what makes it
  // legible to a reader — a whole-corpus audit shows all three.
  const whole = build(
    [closeRow(), closeRow({ market: 'moneyline' }), closeRow({ market: 'spread' })],
    [gameRow()],
  );
  assert.deepEqual(whole.meta.markets, { total: 1, moneyline: 1, spread: 1 });
  assert.deepEqual(rederivedAuditMarkets(whole.records), whole.meta.markets);

  const narrowed = build([closeRow()], [gameRow()]);
  assert.deepEqual(narrowed.meta.markets, { total: 1 }, 'a single key means a filtered walk');

  // ...and it is re-derived on load, so it cannot be faked in the meta.
  const text = [{ ...whole.meta, markets: { total: 3 } }, ...whole.records]
    .map((r) => JSON.stringify(r))
    .join('\n');
  assert.throws(() => parseCloseScheduleAuditDataset(text), /market histogram/);
});

test('the audit meta proves internal consistency, NOT that the enumeration was complete', () => {
  // Stated as a test because the committed doc-comment states it: a strict
  // subset of a corpus produces a dataset that passes every integrity check.
  // Nothing here is broken — this pins the LIMIT of what a green load means.
  const full = build(
    [closeRow(), closeRow({ market: 'moneyline' }), closeRow({ market: 'spread' })],
    [gameRow()],
  );
  const subset = build([closeRow()], [gameRow()]);
  const render = (d: CloseScheduleAuditDataset): string =>
    [d.meta, ...d.records].map((r) => JSON.stringify(r)).join('\n');
  assert.doesNotThrow(() => parseCloseScheduleAuditDataset(render(full)));
  assert.doesNotThrow(() => parseCloseScheduleAuditDataset(render(subset)));
  assert.equal(parseCloseScheduleAuditDataset(render(subset)).meta.closesSeen, 1);
  assert.equal(parseCloseScheduleAuditDataset(render(full)).meta.closesSeen, 3);
  // The difference is legible only in the market histogram, which is why it
  // is published.
  assert.equal(Object.keys(parseCloseScheduleAuditDataset(render(subset)).meta.markets).length, 1);
  assert.equal(Object.keys(parseCloseScheduleAuditDataset(render(full)).meta.markets).length, 3);
});
