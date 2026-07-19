import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBundle } from './bundle.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { buildGameRequest } from './scopedRequest.js';
import { SMOKE_LABEL } from './types.js';
import type { CurrentOddsRow, GamesEndpointRow, SlateInputs } from './types.js';

/**
 * The shared per-game request wrapper. The load-bearing property is that the batch
 * slate builder and any per-game caller produce byte-identical request bytes for the
 * same game — the wrap lives in exactly one place, so no second inline copy can drift
 * the request hashes.
 */

const SLATE_DATE = '2026-07-12';
const FETCH_COMPLETED = '2026-07-12T14:05:00.000Z';

function gameRow(gameId: string, matchTime: string, slug: string): GamesEndpointRow {
  return {
    gameId,
    slug,
    sport: 'mlb',
    matchTime,
    status: 'upcoming',
    homeTeam: { name: 'Pittsburgh Pirates', abbreviation: 'PIT' },
    awayTeam: { name: 'Milwaukee Brewers', abbreviation: 'MIL' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: true,
    externalIds: { jsonodds: gameId, sportspage: '900001', rundown: null },
  };
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

function twoGameInputs(): SlateInputs {
  const a = gameRow('00000000-0000-4000-8000-0000000000a1', '2026-07-12T18:15:00+00:00', 'mil-pit-2026-07-12');
  const b = gameRow('00000000-0000-4000-8000-0000000000b2', '2026-07-12T16:15:00+00:00', 'lad-sfg-2026-07-12');
  return {
    gamesRows: [a, b],
    oddsRows: [...oddsRows(a.gameId), ...oddsRows(b.gameId)],
    fetchStartedAt: '2026-07-12T14:04:00.000Z',
    fetchCompletedAt: FETCH_COMPLETED,
  };
}

test('buildBundle delegates every per-game request to the shared buildGameRequest (byte-identical)', () => {
  const inputs = twoGameInputs();
  const build = buildBundle(inputs, SLATE_DATE, { requireFuture: false });
  assert.equal(build.requests.length, 2);
  for (const req of build.requests) {
    const viaHelper = buildGameRequest(req.game, req.slug, SLATE_DATE, inputs.fetchCompletedAt);
    // Whole-request canonical equality — not just the hash — so a drift in any field
    // (bundle timestamp, cutoff, slug, game bytes) is caught.
    assert.equal(canonicalize(viaHelper), canonicalize(req));
    assert.equal(viaHelper.requestSha256, req.requestSha256);
  }
});

test('buildGameRequest wraps a game into a single-game request bundle with cutoff = first pitch', () => {
  const inputs = twoGameInputs();
  const build = buildBundle(inputs, SLATE_DATE, { requireFuture: false });
  const game = build.requests[0]!.game;
  const req = buildGameRequest(game, 'the-slug', SLATE_DATE, FETCH_COMPLETED);
  assert.equal(req.gameId, game.gameId);
  assert.equal(req.slug, 'the-slug');
  assert.equal(req.game, game);
  assert.equal(req.requestBundle.games.length, 1);
  assert.equal(req.requestBundle.games[0], game);
  assert.equal(req.requestBundle.cutoffAt, game.scheduledStartUtc);
  assert.equal(req.requestBundle.label, SMOKE_LABEL);
  assert.equal(req.requestBundle.bundleTimestamp, FETCH_COMPLETED);
  assert.equal(req.requestSha256, sha256Hex(canonicalize(req.requestBundle)));
});
