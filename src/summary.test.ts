import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPickSections, describeFavorite, slateRow, suppliedMarketKeys } from './summary.js';
import { makeGameBundle, makeRequest, makeValidResponse, TEST_ARM } from './testFactories.js';
import { SMOKE_LABEL } from './types.js';
import type {
  ArmGameResult,
  ArmSpec,
  AttemptRecord,
  BenchmarkResponse,
  GameBundle,
  MarketKey,
  SlateBundle,
} from './types.js';

/**
 * S3d — dynamic summary rendering (SPEC-prepared-request.md §6). The render
 * helpers must be scope-safe (1-3 present markets, no crash on an absent block)
 * and render picks from the PRESENT market set, while a full board is
 * byte-identical to the historical output.
 */

const CUTOFF = '2026-07-12T16:15:00+00:00';
const MARKET_BLOCK: Record<MarketKey, 'moneyline' | 'runLine' | 'total'> = {
  moneyline: 'moneyline',
  spread: 'runLine',
  total: 'total',
};

const STUB_ATTEMPT: AttemptRecord = {
  rawText: null,
  reportedModelId: null,
  providerResponseId: null,
  httpStatus: null,
  usage: null,
  usageRaw: null,
  requestParams: null,
  requestAt: null,
  responseAt: null,
  latencyMs: null,
  errorDetail: null,
};

function armResult(arm: ArmSpec, gameId: string, parsed: BenchmarkResponse): ArmGameResult {
  return {
    arm,
    gameId,
    requestSha256: 'x',
    cutoffAt: CUTOFF,
    outcome: 'valid',
    attempt: STUB_ATTEMPT,
    repair: null,
    repairUsed: false,
    repairTransport: null,
    parsed,
    validationErrors: [],
  };
}

/** A game supplying only `present` market blocks (absent = omitted own key). */
function scopedGame(
  present: ReadonlyArray<MarketKey>,
  gameId = '00000000-0000-4000-8000-00000000t001',
): GameBundle {
  const game = makeGameBundle({ gameId });
  const keep = new Set(present.map((m) => MARKET_BLOCK[m]));
  const scoped: Record<string, unknown> = {};
  for (const key of ['moneyline', 'runLine', 'total'] as const) {
    if (keep.has(key)) scoped[key] = game.markets[key];
  }
  (game as { markets: unknown }).markets = scoped;
  return game;
}

function slateOf(games: GameBundle[]): SlateBundle {
  return {
    schemaVersion: 1,
    label: SMOKE_LABEL,
    league: 'mlb',
    slateDate: '2026-07-12',
    bundleTimestamp: '2026-07-12T14:05:00+00:00',
    cutoffAt: CUTOFF,
    games,
  };
}

test('slateRow: a full board renders every market column (byte-identical)', () => {
  assert.equal(
    slateRow(makeGameBundle()),
    '| Milwaukee Brewers at Pittsburgh Pirates | 2026-07-12T16:15:00+00:00 | 1.74627 / 2.17 | ' +
      'Milwaukee Brewers -1.5 @ 2.3 · Pittsburgh Pirates +1.5 @ 1.66667 | 8.5 (o 1.90909 / u 1.90909) | ' +
      '— | Milwaukee Brewers (away) |',
  );
});

test('slateRow: a scoped (total-only) game renders — for the absent columns, no crash', () => {
  assert.equal(
    slateRow(scopedGame(['total'])),
    '| Milwaukee Brewers at Pittsburgh Pirates | 2026-07-12T16:15:00+00:00 | — | — | ' +
      '8.5 (o 1.90909 / u 1.90909) | — | — |',
  );
});

test('describeFavorite: full board picks by price; an absent moneyline renders —', () => {
  assert.equal(describeFavorite(makeGameBundle()), 'Milwaukee Brewers (away)');
  assert.equal(describeFavorite(scopedGame(['total'])), '—');
  const pickEm = makeGameBundle();
  pickEm.markets.moneyline.awayDecimal = 1.9;
  pickEm.markets.moneyline.homeDecimal = 1.9;
  assert.equal(describeFavorite(pickEm), 'pick-em');
});

test('suppliedMarketKeys maps runLine->spread and reports only present markets', () => {
  assert.deepEqual(suppliedMarketKeys(makeGameBundle()), ['moneyline', 'spread', 'total']);
  assert.deepEqual(suppliedMarketKeys(scopedGame(['total'])), ['total']);
  assert.deepEqual(suppliedMarketKeys(scopedGame(['moneyline', 'total'])), ['moneyline', 'total']);
});

test('buildPickSections: a full board renders all three market sections; the moneyline table is unchanged', () => {
  const request = makeRequest();
  const md = buildPickSections(
    slateOf([request.game]),
    [TEST_ARM],
    [armResult(TEST_ARM, request.game.gameId, makeValidResponse(request))],
  ).join('\n');
  assert.ok(md.includes('## Moneyline picks (valid arm-games)'));
  assert.ok(md.includes('## Run line picks (valid arm-games)'));
  assert.ok(md.includes('## Total picks (valid arm-games)'));
  // The historical moneyline row: away side at its win probability.
  assert.ok(md.includes('| Milwaukee Brewers at Pittsburgh Pirates | Milwaukee Brewers (0.55) |'));
});

test('buildPickSections: a total-only slate shows the total forecast, not an empty moneyline table (§6)', () => {
  const request = makeRequest();
  const totalGame = scopedGame(['total']);
  const resp = makeValidResponse(request);
  const g0 = resp.games[0];
  assert.ok(g0);
  g0.forecasts = g0.forecasts.filter((f) => f.market === 'total');
  const md = buildPickSections(
    slateOf([totalGame]),
    [TEST_ARM],
    [armResult(TEST_ARM, totalGame.gameId, resp)],
  ).join('\n');
  assert.ok(md.includes('## Total picks (valid arm-games)'));
  assert.ok(md.includes('over (0.5)'));
  assert.ok(!md.includes('## Moneyline picks'), 'no moneyline section for a total-only slate');
  assert.ok(!md.includes('## Run line picks'), 'no run-line section for a total-only slate');
});

test('buildPickSections: a mixed-scope slate renders each present market, — where a game lacks it', () => {
  const GAME_FULL = '00000000-0000-4000-8000-00000000f002';
  // Distinct team names so each game's row is individually identifiable — the
  // assertions then prove WHICH game got a real pick vs '—', not just that some
  // row exists.
  const fullRequest = makeRequest(CUTOFF, {
    gameId: GAME_FULL,
    awayTeam: 'New York Yankees',
    homeTeam: 'Boston Red Sox',
  });
  const totalGame = scopedGame(['total']); // default gameId + Milwaukee/Pittsburgh
  const totalResp = makeValidResponse(makeRequest());
  const tg0 = totalResp.games[0];
  assert.ok(tg0);
  tg0.forecasts = tg0.forecasts.filter((f) => f.market === 'total');
  const md = buildPickSections(
    slateOf([fullRequest.game, totalGame]),
    [TEST_ARM],
    [
      armResult(TEST_ARM, GAME_FULL, makeValidResponse(fullRequest)),
      armResult(TEST_ARM, totalGame.gameId, totalResp),
    ],
  ).join('\n');
  // Present markets = union across the slate = all three.
  assert.ok(md.includes('## Moneyline picks (valid arm-games)'));
  assert.ok(md.includes('## Total picks (valid arm-games)'));
  const moneylineSection = md.slice(md.indexOf('## Moneyline picks'), md.indexOf('## Run line picks'));
  // The full game shows its real moneyline pick; the total-only game shows '—'.
  assert.ok(moneylineSection.includes('| New York Yankees at Boston Red Sox | New York Yankees (0.55) |'));
  assert.ok(moneylineSection.includes('| Milwaukee Brewers at Pittsburgh Pirates | — |'));
  // The total section shows the total-only game's real total pick.
  const totalSection = md.slice(md.indexOf('## Total picks'));
  assert.ok(totalSection.includes('| Milwaukee Brewers at Pittsburgh Pirates | over (0.5) |'));
});
