import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBundle, extractProbablePitchers } from './bundle.js';
import type { CurrentOddsRow, GamesEndpointRow, SlateInputs } from './types.js';

const CAPTURED_AT = '2026-07-12T14:05:00.000Z';

function gameRow(overrides: Partial<GamesEndpointRow> & Record<string, unknown> = {}): GamesEndpointRow {
  return {
    gameId: '00000000-0000-4000-8000-0000000000aa',
    slug: 'mil-pit-2026-07-12',
    sport: 'mlb',
    matchTime: '2026-07-12T16:15:00+00:00',
    status: 'upcoming',
    homeTeam: { name: 'Pittsburgh Pirates', abbreviation: 'PIT' },
    awayTeam: { name: 'Milwaukee Brewers', abbreviation: 'MIL' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: true,
    externalIds: {
      jsonodds: '00000000-0000-4000-8000-0000000000aa',
      sportspage: '900001',
      rundown: 'f00000000000000000000000000000aa',
    },
    ...overrides,
  } as GamesEndpointRow;
}

function oddsRows(gameId: string, observedAt = '2026-07-12T14:02:11+00:00'): CurrentOddsRow[] {
  const stamp = {
    upstream_last_updated: observedAt,
    poll_captured_at: '2026-07-12T14:02:41+00:00',
    changed_at: '2026-07-12T13:44:02+00:00',
  };
  return [
    { network: 'polygon', jsonodds_id: gameId, market: 'moneyline', line: null, away_odds_american: -134, home_odds_american: 117, ...stamp },
    { network: 'polygon', jsonodds_id: gameId, market: 'spread', line: 1.5, away_odds_american: 130, home_odds_american: -150, ...stamp },
    { network: 'polygon', jsonodds_id: gameId, market: 'total', line: 8.5, away_odds_american: -110, home_odds_american: -110, ...stamp },
  ];
}

function inputsFor(row: GamesEndpointRow, observedAt?: string): SlateInputs {
  return {
    gamesRows: [row],
    oddsRows: observedAt === undefined ? oddsRows(row.gameId) : oddsRows(row.gameId, observedAt),
    fetchStartedAt: '2026-07-12T14:04:00.000Z',
    fetchCompletedAt: CAPTURED_AT,
  };
}

test('pitchers absent today → probableStartingPitchers is null, no pitchers evidenceRef', () => {
  const build = buildBundle(inputsFor(gameRow()), '2026-07-12', { requireFuture: false });
  const game = build.requests[0]?.game;
  assert.ok(game);
  assert.equal(game.probableStartingPitchers, null);
  assert.equal(game.evidenceRefs.some((ref) => ref.endsWith(':pitchers')), false);
});

test('camelCase pitcher fields populate automatically when the read path gains them', () => {
  const row = gameRow({ awayPitcher: 'F. Peralta', homePitcher: 'P. Skenes' });
  const build = buildBundle(inputsFor(row), '2026-07-12', { requireFuture: false });
  const game = build.requests[0]?.game;
  assert.ok(game);
  assert.deepEqual(game.probableStartingPitchers, { away: 'F. Peralta', home: 'P. Skenes' });
  assert.equal(game.evidenceRefs.some((ref) => ref.endsWith(':pitchers')), true);
});

test('nested probablePitchers object is read, one side may be null', () => {
  const row = gameRow({ probablePitchers: { away: 'F. Peralta', home: null } });
  assert.deepEqual(extractProbablePitchers(row), { away: 'F. Peralta', home: null });
});

test('snake_case pitcher fields are read', () => {
  const row = gameRow({ away_pitcher: 'F. Peralta', home_pitcher: 'P. Skenes' });
  assert.deepEqual(extractProbablePitchers(row), { away: 'F. Peralta', home: 'P. Skenes' });
});

test('empty-string pitcher fields count as absent', () => {
  const row = gameRow({ awayPitcher: '', homePitcher: '   ' });
  assert.equal(extractProbablePitchers(row), null);
});

test('bundleTimestamp is the fetch COMPLETION time, so no observation postdates it', () => {
  const build = buildBundle(inputsFor(gameRow()), '2026-07-12', { requireFuture: false });
  assert.equal(build.slateBundle.bundleTimestamp, CAPTURED_AT);
  for (const game of build.slateBundle.games) {
    for (const market of Object.values(game.markets)) {
      assert.ok(Date.parse(market.observedAt) <= Date.parse(build.slateBundle.bundleTimestamp));
    }
  }
});

/** A sick game (bad quote timestamps) alongside a healthy control game. */
function inputsWithSickGame(observedAt: string): { inputs: SlateInputs; sickId: string } {
  const sick = gameRow({
    gameId: '00000000-0000-4000-8000-0000000000dd',
    slug: 'kc-bal-2026-07-12',
    matchTime: '2026-07-12T17:35:00+00:00',
    externalIds: { jsonodds: '00000000-0000-4000-8000-0000000000dd', sportspage: '900004', rundown: 'f00000000000000000000000000000dd' },
  });
  const healthy = gameRow();
  return {
    inputs: {
      gamesRows: [sick, healthy],
      oddsRows: [...oddsRows(sick.gameId, observedAt), ...oddsRows(healthy.gameId)],
      fetchStartedAt: '2026-07-12T14:04:00.000Z',
      fetchCompletedAt: CAPTURED_AT,
    },
    sickId: sick.gameId,
  };
}

test('stale reference quotes are excluded with a stable reason code', () => {
  const { inputs, sickId } = inputsWithSickGame('2020-07-12T14:02:11+00:00');
  const build = buildBundle(inputs, '2026-07-12', { requireFuture: false });
  assert.equal(build.requests.length, 1);
  const exclusion = build.excluded.find((e) => e.gameId === sickId);
  assert.ok(exclusion);
  assert.ok(exclusion.reason.startsWith('stale_quote:'));
});

test('future reference quotes beyond the skew allowance are excluded', () => {
  const { inputs, sickId } = inputsWithSickGame('2026-07-12T14:20:00+00:00');
  const build = buildBundle(inputs, '2026-07-12', { requireFuture: false });
  assert.equal(build.requests.length, 1);
  const exclusion = build.excluded.find((e) => e.gameId === sickId);
  assert.ok(exclusion);
  assert.ok(exclusion.reason.startsWith('future_quote:'));
});

test('unparseable quote timestamps are excluded', () => {
  const { inputs, sickId } = inputsWithSickGame('not-a-timestamp');
  const build = buildBundle(inputs, '2026-07-12', { requireFuture: false });
  assert.equal(build.requests.length, 1);
  const exclusion = build.excluded.find((e) => e.gameId === sickId);
  assert.ok(exclusion);
  assert.ok(exclusion.reason.startsWith('invalid_quote_timestamp:'));
});

function twoGameInputs(): SlateInputs {
  // The LATER-starting game gets the LEXICOGRAPHICALLY SMALLER gameId, so
  // UUID order and start-time order disagree.
  const lateSmallId = gameRow({
    gameId: '00000000-0000-4000-8000-0000000000aa',
    slug: 'ari-lad-2026-07-12',
    matchTime: '2026-07-12T20:10:00+00:00',
    externalIds: { jsonodds: '00000000-0000-4000-8000-0000000000aa', sportspage: '900002', rundown: 'f00000000000000000000000000000aa' },
  });
  const earlyBigId = gameRow({
    gameId: '00000000-0000-4000-8000-0000000000bb',
    slug: 'mil-pit-2026-07-12',
    matchTime: '2026-07-12T16:15:00+00:00',
    externalIds: { jsonodds: '00000000-0000-4000-8000-0000000000bb', sportspage: '900001', rundown: 'f00000000000000000000000000000bb' },
  });
  return {
    gamesRows: [lateSmallId, earlyBigId],
    oddsRows: [...oddsRows(lateSmallId.gameId), ...oddsRows(earlyBigId.gameId)],
    fetchStartedAt: '2026-07-12T14:04:00.000Z',
    fetchCompletedAt: CAPTURED_AT,
  };
}

test('dispatch order is by cutoff (earliest first pitch first), canonical hash order stays by gameId', () => {
  const build = buildBundle(twoGameInputs(), '2026-07-12', { requireFuture: false });
  // dispatch: the earliest-starting game first, despite its larger UUID
  assert.equal(build.requests[0]?.gameId, '00000000-0000-4000-8000-0000000000bb');
  assert.equal(build.requests[1]?.gameId, '00000000-0000-4000-8000-0000000000aa');
  // canonical: slate games sorted by gameId for a stable content hash
  assert.equal(build.slateBundle.games[0]?.gameId, '00000000-0000-4000-8000-0000000000aa');
  assert.equal(build.slateBundle.games[1]?.gameId, '00000000-0000-4000-8000-0000000000bb');
});

test('per-game request bundles carry the game own cutoff and hash', () => {
  const build = buildBundle(twoGameInputs(), '2026-07-12', { requireFuture: false });
  assert.equal(build.requests.length, 2);
  for (const request of build.requests) {
    assert.equal(request.requestBundle.games.length, 1);
    assert.equal(request.requestBundle.cutoffAt, request.game.scheduledStartUtc);
    assert.match(request.requestSha256, /^[0-9a-f]{64}$/);
  }
  // slate-level cutoff is the earliest first pitch
  assert.equal(build.slateBundle.cutoffAt, '2026-07-12T16:15:00+00:00');
});

test('a late-night ET game on the next UTC day belongs to this slate', () => {
  const nightcap = gameRow({
    gameId: '00000000-0000-4000-8000-0000000000cc',
    slug: 'tor-sd-2026-07-12',
    matchTime: '2026-07-13T01:40:00+00:00',
    externalIds: { jsonodds: '00000000-0000-4000-8000-0000000000cc', sportspage: '900003', rundown: 'f00000000000000000000000000000cc' },
  });
  const build = buildBundle(inputsFor(nightcap), '2026-07-12', { requireFuture: false });
  assert.equal(build.requests.length, 1);
});
