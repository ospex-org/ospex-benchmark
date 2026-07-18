import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBundle, buildGameBundle, extractProbablePitchers, FULL_BOARD_MARKETS } from './bundle.js';
import type { GameBundleResult } from './bundle.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { prepareGameRequest } from './preparedRequest.js';
import { SMOKE_LABEL } from './types.js';
import type {
  CurrentOddsRow,
  GameBundle,
  GamesEndpointRow,
  MarketKey,
  SlateBundle,
  SlateInputs,
} from './types.js';

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

// ---------------------------------------------------------------------------
// Scoped single-game builder (buildGameBundle): the per-market runtime asks for
// a SUBSET of the board (upstream vocabulary: moneyline/spread/total), and the
// builder emits a 1-3 market bundle for exactly that set, feeding
// prepareGameRequest. The full board stays byte-identical (the batch builder
// above and the existing hash/requestSha256 assertions pin that path).
// ---------------------------------------------------------------------------

const ASSEMBLED_AT_MS = Date.parse(CAPTURED_AT);

/** The odds rows keyed by upstream market, as buildGameBundle consumes them. */
function oddsMapFor(gameId: string, observedAt?: string): Map<string, CurrentOddsRow> {
  const rows = observedAt === undefined ? oddsRows(gameId) : oddsRows(gameId, observedAt);
  return new Map(rows.map((r) => [r.market, r]));
}

/** Narrow a build result to its bundle, failing loudly with the reason otherwise. */
function expectBundle(result: GameBundleResult): GameBundle {
  assert.ok('bundle' in result, `expected a bundle, got ${JSON.stringify(result)}`);
  return result.bundle;
}

/** Wrap a scoped bundle into the request envelope prepareGameRequest ingests. */
function envelopeFor(game: GameBundle): unknown {
  const requestBundle: SlateBundle = {
    schemaVersion: 1,
    label: SMOKE_LABEL,
    league: 'mlb',
    slateDate: '2026-07-12',
    bundleTimestamp: CAPTURED_AT,
    cutoffAt: game.scheduledStartUtc,
    games: [game],
  };
  return {
    gameId: game.gameId,
    slug: 'mil-pit-2026-07-12',
    game,
    requestBundle,
    requestSha256: sha256Hex(canonicalize(requestBundle)),
  };
}

test('full board via buildGameBundle equals the batch builder game (byte-identical)', () => {
  const row = gameRow();
  const batch = buildBundle(inputsFor(row), '2026-07-12', { requireFuture: false });
  const scoped = expectBundle(
    buildGameBundle(row, oddsMapFor(row.gameId), ASSEMBLED_AT_MS, FULL_BOARD_MARKETS),
  );
  assert.deepEqual(Object.keys(scoped.markets), ['moneyline', 'runLine', 'total']);
  assert.deepEqual(scoped.evidenceRefs, [
    `ev:${row.gameId}:identity`,
    `ev:${row.gameId}:schedule`,
    `ev:${row.gameId}:moneyline`,
    `ev:${row.gameId}:runline`,
    `ev:${row.gameId}:total`,
  ]);
  // Same content hash as the batch path's game — the scoped builder reproduces
  // the pre-scoped full-board bundle exactly.
  assert.equal(sha256Hex(canonicalize(scoped)), batch.gameHashes[row.gameId]);
  assert.deepEqual(scoped, batch.slateBundle.games[0]);
});

test('scoped {moneyline, total} emits a two-market bundle (no run line) prepareGameRequest accepts', () => {
  const row = gameRow();
  const bundle = expectBundle(
    buildGameBundle(row, oddsMapFor(row.gameId), ASSEMBLED_AT_MS, new Set<MarketKey>(['moneyline', 'total'])),
  );
  assert.ok(bundle.markets.moneyline);
  assert.ok(bundle.markets.total);
  // Absent market is an OMITTED key, not an undefined-valued one.
  assert.equal(Object.prototype.hasOwnProperty.call(bundle.markets, 'runLine'), false);
  assert.deepEqual(Object.keys(bundle.markets), ['moneyline', 'total']);
  assert.deepEqual(bundle.evidenceRefs, [
    `ev:${row.gameId}:identity`,
    `ev:${row.gameId}:schedule`,
    `ev:${row.gameId}:moneyline`,
    `ev:${row.gameId}:total`,
  ]);
  const prepared = prepareGameRequest(envelopeFor(bundle));
  assert.ok(prepared.game.markets.moneyline);
  assert.ok(prepared.game.markets.total);
  assert.equal(prepared.game.markets.runLine, undefined);
});

test('scoped {moneyline} emits a single-market bundle prepareGameRequest accepts', () => {
  const row = gameRow();
  const bundle = expectBundle(
    buildGameBundle(row, oddsMapFor(row.gameId), ASSEMBLED_AT_MS, new Set<MarketKey>(['moneyline'])),
  );
  assert.deepEqual(Object.keys(bundle.markets), ['moneyline']);
  assert.deepEqual(bundle.evidenceRefs, [
    `ev:${row.gameId}:identity`,
    `ev:${row.gameId}:schedule`,
    `ev:${row.gameId}:moneyline`,
  ]);
  const prepared = prepareGameRequest(envelopeFor(bundle));
  assert.ok(prepared.game.markets.moneyline);
  assert.equal(prepared.game.markets.total, undefined);
});

test('scoped {spread, total} emits run line + total (upstream spread → bundle runLine)', () => {
  const row = gameRow();
  const bundle = expectBundle(
    buildGameBundle(row, oddsMapFor(row.gameId), ASSEMBLED_AT_MS, new Set<MarketKey>(['spread', 'total'])),
  );
  assert.ok(bundle.markets.runLine);
  assert.ok(bundle.markets.total);
  assert.equal(Object.prototype.hasOwnProperty.call(bundle.markets, 'moneyline'), false);
  assert.deepEqual(bundle.evidenceRefs, [
    `ev:${row.gameId}:identity`,
    `ev:${row.gameId}:schedule`,
    `ev:${row.gameId}:runline`,
    `ev:${row.gameId}:total`,
  ]);
  const prepared = prepareGameRequest(envelopeFor(bundle));
  assert.ok(prepared.game.markets.runLine);
});

test('an absent NON-requested market never rejects the game', () => {
  const row = gameRow();
  // Only moneyline + total present; spread absent — the pre-scoped builder would
  // have rejected the whole game with missing_market:spread.
  const odds = new Map(
    oddsRows(row.gameId).filter((r) => r.market !== 'spread').map((r) => [r.market, r]),
  );
  const bundle = expectBundle(
    buildGameBundle(row, odds, ASSEMBLED_AT_MS, new Set<MarketKey>(['moneyline', 'total'])),
  );
  assert.deepEqual(Object.keys(bundle.markets), ['moneyline', 'total']);
});

test('an absent REQUESTED market rejects with missing_market:<market>', () => {
  const row = gameRow();
  const odds = new Map(
    oddsRows(row.gameId).filter((r) => r.market !== 'total').map((r) => [r.market, r]),
  );
  const result = buildGameBundle(row, odds, ASSEMBLED_AT_MS, new Set<MarketKey>(['moneyline', 'total']));
  assert.deepEqual(result, { reason: 'missing_market:total' });
});

test('a present but NON-requested market is excluded from the bundle', () => {
  const row = gameRow();
  const bundle = expectBundle(
    buildGameBundle(row, oddsMapFor(row.gameId), ASSEMBLED_AT_MS, new Set<MarketKey>(['moneyline'])),
  );
  assert.deepEqual(Object.keys(bundle.markets), ['moneyline']);
});

test('validation applies only to requested markets', () => {
  const row = gameRow();
  const rows = oddsRows(row.gameId).map((r) =>
    r.market === 'spread' ? { ...r, away_odds_american: null } : r,
  );
  const odds = new Map(rows.map((r) => [r.market, r]));
  // spread is one-sided but NOT requested → the game still builds.
  const ok = buildGameBundle(row, odds, ASSEMBLED_AT_MS, new Set<MarketKey>(['moneyline', 'total']));
  assert.ok('bundle' in ok);
  // spread requested → its one-sided price now rejects the game.
  const bad = buildGameBundle(row, odds, ASSEMBLED_AT_MS, new Set<MarketKey>(['spread', 'total']));
  assert.deepEqual(bad, { reason: 'one_sided_price:spread' });
});

test('a requested set with none of its markets present → no_odds_rows', () => {
  const row = gameRow();
  const odds = new Map(
    oddsRows(row.gameId).filter((r) => r.market === 'moneyline').map((r) => [r.market, r]),
  );
  const result = buildGameBundle(row, odds, ASSEMBLED_AT_MS, new Set<MarketKey>(['spread', 'total']));
  assert.deepEqual(result, { reason: 'no_odds_rows' });
});

test('an empty requested-market set throws (caller-contract invariant)', () => {
  const row = gameRow();
  assert.throws(
    () => buildGameBundle(row, oddsMapFor(row.gameId), ASSEMBLED_AT_MS, new Set<MarketKey>()),
    /requestedMarkets must be non-empty/,
  );
});

test('scoped {spread} emits a run-line-only bundle prepareGameRequest accepts', () => {
  const row = gameRow();
  const bundle = expectBundle(
    buildGameBundle(row, oddsMapFor(row.gameId), ASSEMBLED_AT_MS, new Set<MarketKey>(['spread'])),
  );
  assert.deepEqual(Object.keys(bundle.markets), ['runLine']);
  assert.deepEqual(bundle.evidenceRefs, [
    `ev:${row.gameId}:identity`,
    `ev:${row.gameId}:schedule`,
    `ev:${row.gameId}:runline`,
  ]);
  // Exercises prepareGameRequest's run-line redundancy check on a run-line-only
  // bundle (homeHandicap === line, awayHandicap === -line).
  const prepared = prepareGameRequest(envelopeFor(bundle));
  assert.ok(prepared.game.markets.runLine);
  assert.equal(prepared.game.markets.moneyline, undefined);
  assert.equal(prepared.game.markets.total, undefined);
});

test('scoped {total} emits a total-only bundle prepareGameRequest accepts', () => {
  const row = gameRow();
  const bundle = expectBundle(
    buildGameBundle(row, oddsMapFor(row.gameId), ASSEMBLED_AT_MS, new Set<MarketKey>(['total'])),
  );
  assert.deepEqual(Object.keys(bundle.markets), ['total']);
  const prepared = prepareGameRequest(envelopeFor(bundle));
  assert.ok(prepared.game.markets.total);
  assert.equal(prepared.game.markets.moneyline, undefined);
  assert.equal(prepared.game.markets.runLine, undefined);
});

test('a requested market with a null line rejects with missing_line:<market>', () => {
  const row = gameRow();
  const rows = oddsRows(row.gameId).map((r) => (r.market === 'spread' ? { ...r, line: null } : r));
  const odds = new Map(rows.map((r) => [r.market, r]));
  const result = buildGameBundle(row, odds, ASSEMBLED_AT_MS, new Set<MarketKey>(['spread', 'total']));
  assert.deepEqual(result, { reason: 'missing_line:spread' });
});

test('FULL_BOARD_MARKETS is a frozen array (a runtime lock, not just a readonly type)', () => {
  assert.ok(Array.isArray(FULL_BOARD_MARKETS));
  assert.ok(Object.isFrozen(FULL_BOARD_MARKETS));
  assert.deepEqual([...FULL_BOARD_MARKETS], ['moneyline', 'spread', 'total']);
});

test('buildGameBundle accepts an array of markets (any Iterable), not only a Set', () => {
  const row = gameRow();
  const markets: MarketKey[] = ['moneyline', 'total'];
  const bundle = expectBundle(buildGameBundle(row, oddsMapFor(row.gameId), ASSEMBLED_AT_MS, markets));
  assert.deepEqual(Object.keys(bundle.markets), ['moneyline', 'total']);
});
