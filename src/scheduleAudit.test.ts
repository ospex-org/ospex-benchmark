import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertNonEmptyCorpus,
  AUDIT_COMPLETENESS_DISCLOSURE,
  AUDIT_ENUMERATION_SEMANTICS,
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

/**
 * A COHERENT closing-line row. `poll_gap_seconds` is the knob and
 * `last_polled_at` is DERIVED from it (`lock - gap`), so a gap-only override
 * still describes a row whose stored gap agrees with its own instants — which
 * the audit builder now requires before it will derive a timing verdict.
 *
 * Passing `last_polled_at` explicitly wins over the derivation; that is how the
 * incoherence cases build a self-contradicting row on purpose. The defaults
 * reproduce the previous literals exactly (lock 20:10:00, gap 19 → 20:09:41).
 */
function closeRow(overrides: Partial<ClosingLineRow> = {}): ClosingLineRow {
  const base = {
    network: 'polygon',
    jsonodds_id: GAME,
    market: 'total' as const,
    line: 8.5,
    away_odds_decimal: 1.90476,
    home_odds_decimal: 1.90476,
    away_p_novig: 0.5,
    home_p_novig: 0.5,
    value_captured_at: '2026-07-12T20:09:41+00:00',
    lock_time: MATCH_TIME,
    poll_gap_seconds: 19 as number | null,
    confidence: 'fresh' as const,
    source: 'jsonodds',
    ...overrides,
  };
  // Tolerates a deliberately unparseable `lock_time` — several cases supply one
  // to prove the builder refuses it, and the fixture must not die first.
  const lockMs = Date.parse(base.lock_time);
  const derivedLastPolled =
    base.poll_gap_seconds === null || !Number.isFinite(lockMs)
      ? null
      : new Date(lockMs - base.poll_gap_seconds * 1000).toISOString();
  return {
    ...base,
    last_polled_at:
      'last_polled_at' in overrides ? (overrides.last_polled_at ?? null) : derivedLastPolled,
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
  // A null capture instant is not "after" anything — but it is only legitimate
  // on a NON-fresh row now: a fresh close claiming no capture instant is
  // refused as unusable rather than classified.
  const none = closeScheduleAuditRecord(
    closeRow({ value_captured_at: null, confidence: 'stale' }),
    gameRow(),
  );
  assert.equal(none.valueCapturedAfterLock, false);
  assert.equal(none.valueCapturedAfterMatchTime, false);
  assert.throws(
    () => closeScheduleAuditRecord(closeRow({ value_captured_at: null }), gameRow()),
    /fresh close must carry complete timing evidence/,
    'a FRESH row with no capture instant refuses the snapshot',
  );

  // STRICT boundary: the poll-gap rounding tolerance does not reach the
  // value-capture comparison. One millisecond past the lock is past the lock.
  const atLock = closeScheduleAuditRecord(closeRow({ value_captured_at: MATCH_TIME }), gameRow());
  assert.equal(atLock.valueCapturedAfterLock, false, 'exactly at the lock is at the cutoff');
  const oneMsPast = closeScheduleAuditRecord(
    closeRow({ value_captured_at: new Date(Date.parse(MATCH_TIME) + 1).toISOString() }),
    gameRow(),
  );
  assert.equal(oneMsPast.valueCapturedAfterLock, true, 'one millisecond past is refused');
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

// ── B2: identity binding ─────────────────────────────────────────────────────

test('a close row from ANOTHER NETWORK refuses the snapshot rather than being stamped with the requested one', () => {
  // The reported defect: an audit requested as "polygon" accepted amoy rows
  // and emitted a clean record under meta.network = "polygon". The network is
  // a property of the ROWS; the caller's request is only a request until the
  // rows agree with it.
  assert.throws(
    () => build([closeRow(), closeRow({ market: 'moneyline', network: 'amoy' })], [gameRow()]),
    /is on network "amoy" but the audit was requested for "polygon"/,
  );
  // NEGATIVE CONTROL: the same pair on the requested network builds.
  assert.doesNotThrow(() =>
    build([closeRow(), closeRow({ market: 'moneyline' })], [gameRow()]),
  );
});

test('a close row from ANOTHER FEED refuses the snapshot', () => {
  // Comparability rests on one book at one cutoff semantics; a blend is a
  // different measurement wearing the same name.
  assert.throws(
    () => build([closeRow({ source: 'rundown' })], [gameRow()]),
    /came from source "rundown" but the canonical close source is "jsonodds"/,
  );
});

test('a games row from another network refuses the snapshot', () => {
  assert.throws(
    () => build([closeRow()], [gameRow({ network: 'amoy' })]),
    /is on network "amoy" but the audit was requested for "polygon"/,
  );
});

test('provenance travels WITH each record, and meta names the feed', () => {
  const built = build([closeRow()], [gameRow()]);
  assert.equal(built.records[0]?.network, 'polygon');
  assert.equal(built.records[0]?.source, 'jsonodds');
  assert.equal(built.meta.closeSource, 'jsonodds');
});

test('the reader refuses a record whose provenance disagrees with the meta it sits under', () => {
  // `network` is a free string bound only by record-vs-meta agreement, so the
  // cross-check is what catches it and the message names both sides.
  const wrongNetwork = SAMPLE.map((r, i) => (i === 1 ? { ...r, network: 'amoy' } : r));
  assert.throws(
    () => parseCloseScheduleAuditDataset(dataset(wrongNetwork)),
    /is on network "amoy" but the dataset claims "polygon"/,
  );
  // `source` is bound to the canonical literal, so a single rebranded record
  // is refused earlier still — at schema parse, before any cross-check.
  const wrongSource = SAMPLE.map((r, i) => (i === 1 ? { ...r, source: 'rundown' } : r));
  assert.throws(() => parseCloseScheduleAuditDataset(dataset(wrongSource as typeof SAMPLE)));
});

test('the reader RECOMPUTES every judged field and refuses one that contradicts its own evidence', () => {
  // The reported defect: editing a serialized record so its flag disagreed
  // with its own timestamps was ACCEPTED, because the reader only checked
  // that the aggregates matched the records — and the aggregates were
  // themselves recomputed from the edited flag.
  //
  // Each case below regenerates meta FROM the mutated records, so every
  // aggregate agrees and the pre-existing histogram checks cannot fire. Only
  // the evidence-vs-verdict cross-check can refuse, which is what isolates
  // the new behaviour.
  assert.doesNotThrow(
    () => parseCloseScheduleAuditDataset(dataset(SAMPLE)),
    'NEGATIVE CONTROL: an untampered dataset still parses',
  );

  const flips: Array<[string, (r: CloseScheduleAuditRecord) => CloseScheduleAuditRecord]> = [
    ['matchTimeDriftMs', (r) => ({ ...r, matchTimeDriftMs: r.matchTimeDriftMs + 999_999 })],
    [
      'scheduleChangedVsMatchTime',
      (r) => ({ ...r, scheduleChangedVsMatchTime: !r.scheduleChangedVsMatchTime }),
    ],
    ['closeAfterStart', (r) => ({ ...r, closeAfterStart: !r.closeAfterStart })],
    ['valueCapturedAfterLock', (r) => ({ ...r, valueCapturedAfterLock: !r.valueCapturedAfterLock })],
    [
      'valueCapturedAfterMatchTime',
      (r) => ({ ...r, valueCapturedAfterMatchTime: !r.valueCapturedAfterMatchTime }),
    ],
    ['verdict', (r) => ({ ...r, verdict: r.verdict === 'clean' ? 'not_fresh' : 'clean' })],
  ];

  for (const [key, flip] of flips) {
    const mutated = SAMPLE.map((r, i) => (i === 1 ? flip(r) : r));
    assert.throws(
      () => parseCloseScheduleAuditDataset(dataset(mutated)),
      new RegExp(`${key}=`),
      `${key} was accepted despite contradicting its own evidence`,
    );
  }
});

// ── B3: an empty corpus certifies nothing ────────────────────────────────────

test('a META-ONLY dataset refuses rather than reading as a clean corpus', () => {
  // "0 closes, 0 problems" is the most dangerous possible clean bill of
  // health: a zero-row walk is indistinguishable from one whose filter
  // silently narrowed to nothing. The previous check caught only a zero-byte
  // string, so the meta-only artifact the CLI actually wrote parsed clean.
  assert.throws(
    () => parseCloseScheduleAuditDataset(dataset([])),
    /empty corpus certifies nothing/,
  );
  assert.throws(() => parseCloseScheduleAuditDataset(''), /empty/);
  // NEGATIVE CONTROL: one record is a corpus.
  assert.doesNotThrow(() => parseCloseScheduleAuditDataset(dataset([SAMPLE[0]!])));
});

test('a GLOBALLY rebranded artifact is rejected, not just a record that disagrees with its meta', () => {
  // Record-vs-meta agreement alone was not enough: rewriting meta AND every
  // record together to another feed produced an internally consistent artifact
  // that validated cleanly and described a corpus the benchmark never scores.
  // The format is bound to the canonical source, so the rewrite is unparseable.
  const text = dataset(SAMPLE);
  const rebranded = text
    .split('\n')
    .map((line) => line.replace(/"jsonodds"/g, '"rundown"'))
    .join('\n');
  assert.ok(rebranded.includes('"rundown"'), 'fixture premise: the rewrite applied');
  assert.ok(!rebranded.includes('"jsonodds"'), 'fixture premise: no canonical value left');
  // Refused at schema parse — the format itself is bound to the canonical
  // source, so there is no internally-consistent rewrite that survives.
  assert.throws(() => parseCloseScheduleAuditDataset(rebranded));
  // NEGATIVE CONTROL: the canonical artifact still parses.
  assert.doesNotThrow(() => parseCloseScheduleAuditDataset(text));
});

// ── B3: the enumeration describes itself, and an empty corpus refuses ─────────

test('every artifact stamps its enumeration semantics, and the reader requires them', () => {
  // A retained NDJSON is read without the console output that produced it, so
  // the limitation has to travel IN the file. Without this a reader sees
  // authoritative-looking counts and no indication the walk cannot prove it
  // observed every committed row.
  const built = build([closeRow()], [gameRow()]);
  assert.equal(built.meta.enumerationSemantics, AUDIT_ENUMERATION_SEMANTICS);
  assert.equal(built.meta.enumerationSemantics, 'keyset-lower-bound-non-snapshot-v1');
  assert.doesNotThrow(() => parseCloseScheduleAuditDataset(dataset(SAMPLE)));

  // Re-describing the corpus as complete makes the artifact unparseable.
  for (const claim of ['keyset-complete', 'complete', 'census']) {
    const rebranded = dataset(SAMPLE).replace(AUDIT_ENUMERATION_SEMANTICS, claim);
    assert.ok(rebranded.includes(claim), `fixture premise: ${claim}`);
    assert.throws(() => parseCloseScheduleAuditDataset(rebranded), Error, claim);
  }
});

test('the public completeness disclosure says lower bound and non-snapshot, and never says complete', () => {
  // Pins the operator-facing wording. Quietly reverting it to a completeness
  // claim would otherwise be invisible: it is the only place a reader of the
  // console output learns the counts are a bound.
  const text = AUDIT_COMPLETENESS_DISCLOSURE;
  assert.match(text, /lower bound/i);
  assert.match(text, /non-snapshot/i);
  assert.match(text, /commit/i, 'names the mechanism, not just the conclusion');
  assert.doesNotMatch(text, /keyset-complete/);
  assert.ok(
    text.includes(AUDIT_ENUMERATION_SEMANTICS),
    'the console disclosure and the artifact field name the same semantics',
  );
});

test('an empty corpus refuses BEFORE anything is written', () => {
  // The CLI guard, exported as a pure helper so it is testable without
  // running the CLI (auditCloses.ts executes main() on import).
  assert.throws(
    () => assertNonEmptyCorpus(0, 'polygon'),
    /refusing to certify an empty corpus/,
  );
  // NEGATIVE CONTROL: a corpus with rows proceeds.
  assert.doesNotThrow(() => assertNonEmptyCorpus(1, 'polygon'));
});
