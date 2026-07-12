import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBundle, extractProbablePitchers } from './bundle.js';
import type { CurrentOddsRow, GamesEndpointRow, SlateInputs } from './types.js';

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

function oddsRows(gameId: string): CurrentOddsRow[] {
  const stamp = {
    upstream_last_updated: '2026-07-12T14:02:11+00:00',
    poll_captured_at: '2026-07-12T14:02:41+00:00',
    changed_at: '2026-07-12T13:44:02+00:00',
  };
  return [
    { network: 'polygon', jsonodds_id: gameId, market: 'moneyline', line: null, away_odds_american: -134, home_odds_american: 117, ...stamp },
    { network: 'polygon', jsonodds_id: gameId, market: 'spread', line: 1.5, away_odds_american: 130, home_odds_american: -150, ...stamp },
    { network: 'polygon', jsonodds_id: gameId, market: 'total', line: 8.5, away_odds_american: -110, home_odds_american: -110, ...stamp },
  ];
}

function inputsFor(row: GamesEndpointRow): SlateInputs {
  return { gamesRows: [row], oddsRows: oddsRows(row.gameId), fetchedAt: '2026-07-12T14:05:00.000Z' };
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

test('per-game request bundles carry the game own cutoff and hash', () => {
  const early = gameRow();
  const late = gameRow({
    gameId: '00000000-0000-4000-8000-0000000000bb',
    slug: 'ari-lad-2026-07-12',
    matchTime: '2026-07-12T20:10:00+00:00',
    externalIds: { jsonodds: '00000000-0000-4000-8000-0000000000bb', sportspage: '900002', rundown: 'f00000000000000000000000000000bb' },
  });
  const inputs: SlateInputs = {
    gamesRows: [early, late],
    oddsRows: [...oddsRows(early.gameId), ...oddsRows(late.gameId)],
    fetchedAt: '2026-07-12T14:05:00.000Z',
  };
  const build = buildBundle(inputs, '2026-07-12', { requireFuture: false });
  assert.equal(build.requests.length, 2);
  for (const request of build.requests) {
    assert.equal(request.requestBundle.games.length, 1);
    assert.equal(request.requestBundle.cutoffAt, request.game.scheduledStartUtc);
    assert.match(request.requestSha256, /^[0-9a-f]{64}$/);
  }
  // slate-level cutoff is the earliest first pitch
  assert.equal(build.slateBundle.cutoffAt, '2026-07-12T16:15:00+00:00');
  // a late-night ET game on the next UTC day belongs to this slate
  const nightcap = gameRow({
    gameId: '00000000-0000-4000-8000-0000000000cc',
    slug: 'tor-sd-2026-07-12',
    matchTime: '2026-07-13T01:40:00+00:00',
    externalIds: { jsonodds: '00000000-0000-4000-8000-0000000000cc', sportspage: '900003', rundown: 'f00000000000000000000000000000cc' },
  });
  const withNightcap = buildBundle(
    {
      gamesRows: [early, nightcap],
      oddsRows: [...oddsRows(early.gameId), ...oddsRows(nightcap.gameId)],
      fetchedAt: '2026-07-12T14:05:00.000Z',
    },
    '2026-07-12',
    { requireFuture: false },
  );
  assert.equal(withNightcap.requests.length, 2);
});
