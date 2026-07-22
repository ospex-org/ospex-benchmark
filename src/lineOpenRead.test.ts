import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cohortBoot } from './cohortBoot.js';
import { fetchFullHistoryRows, fetchGamesForSport, fetchGamesForWindow, fetchLiveInputs } from './fetchers.js';
import {
  assertDiscoverySnapshot,
  collectGames,
  createDiscoverFn,
  createReadMarketEvidenceFn,
  discover,
  LineOpenReadError,
  readMarketEvidence,
} from './lineOpenRead.js';
import { parseManifest } from './manifest.js';
import { SUPPORTED_SPORTS, validateManifestAgainstCode } from './manifestValidate.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { MODEL_PRICE_TABLE_DIGEST, MODEL_PRICE_TABLE_VERSION } from './modelPriceTable.js';
import { SOURCE_QUERY_VERSION, firstTwoSided } from './oddsHistory.js';
import { assertPreparedFireSnapshot } from './preparedFire.js';
import { promptScaffoldSha256 } from './prompt.js';
import { REPAIR_POLICY_VERSION } from './repairPolicy.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import type { BootedCohort } from './cohortBoot.js';
import type { HttpGet } from './fetchers.js';
import type {
  DiscoverFn,
  DiscoveryReads,
  DiscoverySnapshot,
  HistoryReadDeps,
  ReadMarketEvidenceFn,
} from './lineOpenRead.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { CurrentOddsRow, GamesEndpointRow, MarketKey } from './types.js';

/**
 * Line-open discovery + per-market opener-read seams. The discovery/read logic is
 * exercised against in-memory fakes (no real network); the fetcher query-shape /
 * echo-validation / pagination / aggregate-deadline behavior is driven through an
 * injected HTTP primitive. A genuine `cohortBoot` output authenticates every seam.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse('2026-07-12T14:07:00.000Z');
const FRESH_AT = '2026-07-12T14:02:00+00:00'; // 5 min before now — within the quote-age window
const STALE_AT = '2026-07-12T13:20:00+00:00'; // 47 min before now — stale
const FUTURE_AT = '2026-07-12T14:12:00+00:00'; // 5 min after now — future beyond skew

function manifestRaw(
  overrides: Record<string, unknown> = {},
  constantsOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const arms = defaultExpectedArms();
  return {
    artifactSchemaVersion: 1,
    network: 'polygon',
    sportAllowList: ['mlb'],
    windowStart: '2026-07-16T00:00:00.000Z',
    windowEnd: '2026-07-16T02:00:00.000Z',
    source: 'jsonodds',
    sourceQueryVersion: 'source-query-v1',
    marketPolicyVersion: MARKET_POLICY_VERSION,
    marketPolicyDigest: MARKET_POLICY_DIGEST,
    promptScaffoldSha256: promptScaffoldSha256(),
    expectedArmRoster: arms.map((a) => ({
      participantId: a.participantId,
      provider: a.provider,
      requestedModelId: a.requestedModelId,
      approvedReportedModelIds: a.approvedReportedModelIds,
    })),
    toolInferenceConfigSha256: 'b'.repeat(64),
    baselinePolicyVersion: 'baselines-v0.3.0',
    repairPolicyVersion: REPAIR_POLICY_VERSION,
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: MODEL_PRICE_TABLE_VERSION,
    modelPriceTableDigest: MODEL_PRICE_TABLE_DIGEST,
    spendReservationPolicyVersion: 'fixed-attempt-v1',
    runnerCommitSha: 'd'.repeat(40),
    constants: {
      pollIntervalMs: 30000,
      cleanEntryWindowMs: 120000,
      gameDiscoveryWindowHours: 168,
      maxClockSkewMs: 5000,
      freshFireMs: 30000,
      maxDispatchLagMs: 10000,
      historyReadTimeoutMs: 30000,
      providerCallTimeoutMs: 300000,
      maxOutputTokens: 16000,
      maxRepairAttemptsPerArm: 1,
      providerAttemptReservationUsdMicros: 100_000_000,
      ingestionGraceMs: 900000,
      scheduleChangeToleranceMs: 60000,
      maxConcurrentProviderRequests: arms.length,
      maxDispatchesPerTick: 10,
      ...constantsOverrides,
    },
    cohortCallCap: 1000,
    cohortSpendCapUsdMicros: 5000000,
    ...overrides,
  };
}

function bootMlbCohort(constantsOverrides: Record<string, unknown> = {}): BootedCohort {
  return cohortBoot({ live: false, manifestBytes: JSON.stringify(manifestRaw({}, constantsOverrides)) });
}

function makeGame(overrides: Partial<GamesEndpointRow> = {}): GamesEndpointRow {
  const gameId = overrides.gameId ?? 'g-0001';
  return {
    gameId,
    slug: `slug-${gameId}`,
    sport: 'mlb',
    matchTime: '2026-07-12T18:00:00+00:00',
    status: 'upcoming',
    homeTeam: { name: 'Home Nine', abbreviation: 'HOM' },
    awayTeam: { name: 'Away Nine', abbreviation: 'AWY' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: true,
    externalIds: { jsonodds: gameId, sportspage: null, rundown: null },
    ...overrides,
  };
}

function makeOdds(overrides: Partial<CurrentOddsRow> = {}): CurrentOddsRow {
  return {
    network: 'polygon',
    jsonodds_id: 'g-0001',
    market: 'moneyline',
    line: null,
    away_odds_american: -120,
    home_odds_american: 110,
    upstream_last_updated: FRESH_AT,
    poll_captured_at: FRESH_AT,
    changed_at: FRESH_AT,
    ...overrides,
  };
}

/** A discovery deps bag whose reads return canned rows and record their calls. */
function fakeDiscoveryReads(games: GamesEndpointRow[], odds: CurrentOddsRow[]): {
  deps: DiscoveryReads;
  gamesCalls: Array<{ sport: string; windowHours: number }>;
  oddsCalls: Array<{ network: string; gameIds: string[] }>;
} {
  const gamesCalls: Array<{ sport: string; windowHours: number }> = [];
  const oddsCalls: Array<{ network: string; gameIds: string[] }> = [];
  const deps: DiscoveryReads = {
    readGames: async (sport, windowHours) => {
      gamesCalls.push({ sport, windowHours });
      return games.filter((g) => g.sport === sport);
    },
    readCurrentOdds: async (network, gameIds) => {
      oddsCalls.push({ network, gameIds });
      return odds;
    },
    now: () => NOW_MS,
  };
  return { deps, gamesCalls, oddsCalls };
}

// ----- raw history rows (fetcher-level fakes) -----

function rawValid(id: number, gameId = 'hg', market: MarketKey = 'moneyline'): Record<string, unknown> {
  return {
    id,
    jsonodds_id: gameId,
    market,
    source: 'jsonodds',
    line: market === 'moneyline' ? null : 8.5,
    away_odds_american: -110,
    away_odds_decimal: 1.90909,
    home_odds_american: -110,
    home_odds_decimal: 1.90909,
    captured_at: '2026-07-12T14:00:00+00:00',
  };
}

/** Numeric id (so the raw walk advances) but fails full two-sided validation. */
function rawMalformed(id: number): Record<string, unknown> {
  return {
    id,
    jsonodds_id: 'hg',
    market: 'moneyline',
    source: 'jsonodds',
    line: null,
    away_odds_american: -110,
    away_odds_decimal: 1.90909,
    // home side missing → dropped by parseTwoSidedHistoryRows
    captured_at: '2026-07-12T14:00:00+00:00',
  };
}

/** A PostgREST-like `odds_history` server: serves rows with `id > cursor`, capped
 *  at `serverCap` per page, so a keyset walk pages through them. */
function historyTableHttp(rows: Array<Record<string, unknown>>, serverCap: number): {
  http: HttpGet;
  urls: string[];
} {
  const urls: string[] = [];
  const http: HttpGet = async (url) => {
    urls.push(url);
    const m = /id=gt\.(\d+)/.exec(url);
    const after = m ? Number(m[1]) : 0;
    return rows
      .filter((r) => (r.id as number) > after)
      .sort((a, b) => (a.id as number) - (b.id as number))
      .slice(0, serverCap);
  };
  return { http, urls };
}

/** A parsed two-sided row (post-validation shape) for the read-seam fakes. */
function parsedRow(id: number, gameId: string, market: MarketKey): TwoSidedHistoryRow {
  const captured_at = '2026-07-12T14:00:00+00:00';
  return {
    id,
    jsonodds_id: gameId,
    market,
    source: 'jsonodds',
    line: market === 'moneyline' ? null : 8.5,
    away_odds_american: -110,
    away_odds_decimal: 1.90909,
    home_odds_american: -110,
    home_odds_decimal: 1.90909,
    captured_at,
    captured_at_ms: Date.parse(captured_at),
  };
}

function historyDeps(fetchHistory: HistoryReadDeps['fetchHistory']): HistoryReadDeps {
  return { fetchHistory, now: () => NOW_MS };
}

/** A `/v1/games` echo body (the shape `parseGamesEndpointEchoBody` reads). */
function gamesEcho(opts: {
  sport?: string | null;
  windowHours?: number;
  availableOnly?: boolean;
  games?: GamesEndpointRow[];
  limit?: number;
  offset?: number;
  total?: number;
  hasMore?: boolean;
}): Record<string, unknown> {
  const games = opts.games ?? [];
  return {
    sport: opts.sport ?? 'mlb',
    windowHours: opts.windowHours ?? 168,
    availableOnly: opts.availableOnly ?? false,
    games,
    pagination: {
      limit: opts.limit ?? 200,
      offset: opts.offset ?? 0,
      total: opts.total ?? games.length,
      hasMore: opts.hasMore ?? false,
    },
  };
}

function pagedGamesHttp(pages: Array<Record<string, unknown>>): { http: HttpGet; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const http: HttpGet = async (url) => {
    urls.push(url);
    const page = pages[i] ?? pages[pages.length - 1];
    i += 1;
    return page;
  };
  return { http, urls };
}

// ===========================================================================
// candidate enumeration + exact row retention
// ===========================================================================

test('candidateKeySetEqualsRetainedBuildableRows', async () => {
  const games = [makeGame({ gameId: 'k1' }), makeGame({ gameId: 'k2' }), makeGame({ gameId: 'k3' })];
  const odds = [
    makeOdds({ jsonodds_id: 'k1', market: 'moneyline' }), // buildable
    makeOdds({ jsonodds_id: 'k2', market: 'total', line: 8.5, away_odds_american: -110, home_odds_american: -110 }), // buildable
    makeOdds({ jsonodds_id: 'k3', market: 'moneyline', away_odds_american: null }), // NOT buildable (one-sided)
  ];
  const { deps } = fakeDiscoveryReads(games, odds);
  const snap = await discover(bootMlbCohort(), deps);

  const candidateKeys = snap.candidates.map((c) => `${c.gameId}|${c.market}`).sort();
  const retainedKeys = snap.oddsRows.map((r) => `${r.jsonodds_id}|${r.market}`).sort();
  assert.deepEqual(candidateKeys, ['k1|moneyline', 'k2|total']);
  assert.deepEqual(candidateKeys, retainedKeys, 'candidate key set == retained buildable rows');
  // One-to-one: every candidate maps to exactly one retained row and vice versa.
  assert.equal(snap.candidates.length, snap.oddsRows.length);
  for (const c of snap.candidates) {
    const matches = snap.oddsRows.filter((r) => r.jsonodds_id === c.gameId && r.market === c.market);
    assert.equal(matches.length, 1, `exactly one retained row for (${c.gameId}, ${c.market})`);
  }
});

test('discoveryReadsCurrentOddsOnceNoSecondRead', async () => {
  const games = [makeGame({ gameId: 'r1' }), makeGame({ gameId: 'r2' })];
  const odds = [
    makeOdds({ jsonodds_id: 'r1', market: 'moneyline' }),
    makeOdds({ jsonodds_id: 'r2', market: 'moneyline' }),
  ];
  const { deps, oddsCalls } = fakeDiscoveryReads(games, odds);
  const snap = await discover(bootMlbCohort(), deps);
  // Exactly ONE current-odds read; enumeration is from that snapshot, and the exact
  // retained rows (a subset of the read) cross the boundary — no superset/refetch.
  assert.equal(oddsCalls.length, 1, 'current_odds read exactly once');
  assert.deepEqual(
    snap.candidates.map((c) => c.gameId).sort(),
    ['r1', 'r2'],
  );
  assert.equal(snap.oddsRows.length, 2);
});

// ===========================================================================
// complete shared singleton buildability
// ===========================================================================

test('sharedBuildabilityFilterRejectsEveryClass', async () => {
  const cases: Array<{ id: string; odds: CurrentOddsRow; buildable: boolean }> = [
    { id: 'bc01', odds: makeOdds({ jsonodds_id: 'bc01', market: 'moneyline', away_odds_american: null }), buildable: false }, // missing side
    { id: 'bc02', odds: makeOdds({ jsonodds_id: 'bc02', market: 'moneyline', away_odds_american: 50 }), buildable: false }, // abs<100
    { id: 'bc03', odds: makeOdds({ jsonodds_id: 'bc03', market: 'moneyline', away_odds_american: 150.5 }), buildable: false }, // fractional
    { id: 'bc04', odds: makeOdds({ jsonodds_id: 'bc04', market: 'spread', line: null, away_odds_american: -110, home_odds_american: -110 }), buildable: false }, // null spread line
    { id: 'bc05', odds: makeOdds({ jsonodds_id: 'bc05', market: 'moneyline', upstream_last_updated: 'not-a-timestamp' }), buildable: false }, // invalid ts
    { id: 'bc06', odds: makeOdds({ jsonodds_id: 'bc06', market: 'moneyline', upstream_last_updated: STALE_AT }), buildable: false }, // stale
    { id: 'bc07', odds: makeOdds({ jsonodds_id: 'bc07', market: 'moneyline', upstream_last_updated: FUTURE_AT }), buildable: false }, // future
    { id: 'bc08', odds: makeOdds({ jsonodds_id: 'bc08', market: 'moneyline' }), buildable: true }, // valid moneyline
    { id: 'bc09', odds: makeOdds({ jsonodds_id: 'bc09', market: 'spread', line: -1.5, away_odds_american: -110, home_odds_american: -110 }), buildable: true }, // valid spread
    { id: 'bc10', odds: makeOdds({ jsonodds_id: 'bc10', market: 'total', line: 8.5, away_odds_american: -110, home_odds_american: -110 }), buildable: true }, // valid total
  ];
  const games = cases.map((c) => makeGame({ gameId: c.id }));
  const odds = cases.map((c) => c.odds);
  const { deps } = fakeDiscoveryReads(games, odds);
  const snap = await discover(bootMlbCohort(), deps);

  const expected = cases.filter((c) => c.buildable).map((c) => c.id).sort();
  assert.deepEqual(snap.candidates.map((c) => c.gameId).sort(), expected);
  assert.deepEqual(snap.oddsRows.map((r) => r.jsonodds_id).sort(), expected);
});

test('dedupAndBindingRunBeforeBuildabilityFilter', async () => {
  // Two rows for the SAME (gameId, market): one buildable, one malformed. Dedup runs
  // BEFORE the buildability filter, so the duplicate is caught even though a buildable
  // copy exists — the filter can't hide the malformed one by dropping it.
  const games = [makeGame({ gameId: 'd1' })];
  const odds = [
    makeOdds({ jsonodds_id: 'd1', market: 'moneyline' }), // buildable
    makeOdds({ jsonodds_id: 'd1', market: 'moneyline', away_odds_american: null }), // malformed dup
  ];
  const { deps } = fakeDiscoveryReads(games, odds);
  await assert.rejects(discover(bootMlbCohort(), deps), /duplicate current_odds/);
});

// ===========================================================================
// per-sport games reads + echo validation + pagination
// ===========================================================================

test('gamesFetchIteratesAllowListWithSportAndWindow', async () => {
  // (a) fetcher level: the passed sport + window are used verbatim; availableOnly=false;
  //     no `network` query param (a regression hard-coding sport=mlb / a fixed window would slip past this).
  const nflGame = makeGame({ gameId: 'nf1', sport: 'nfl' });
  const { http, urls } = pagedGamesHttp([gamesEcho({ sport: 'nfl', windowHours: 168, games: [nflGame] })]);
  const rows = await fetchGamesForSport('http://api', 'nfl', 168, http);
  assert.equal(rows.length, 1);
  assert.match(urls[0]!, /sport=nfl/);
  assert.match(urls[0]!, /windowHours=168/);
  assert.match(urls[0]!, /availableOnly=false/);
  assert.ok(!/[?&]network=/.test(urls[0]!), 'no network query param on /v1/games');

  // (b) discovery level: ONE read per allow-list member, each with the window.
  const collectCalls: Array<{ sport: string; windowHours: number }> = [];
  await collectGames(['mlb', 'nfl'], 168, async (sport, windowHours) => {
    collectCalls.push({ sport, windowHours });
    return [];
  });
  assert.deepEqual(collectCalls, [
    { sport: 'mlb', windowHours: 168 },
    { sport: 'nfl', windowHours: 168 },
  ]);
});

test('gamesResponseEchoIsValidated', async () => {
  const g = makeGame({ gameId: 'e1' });
  // Wrong echoed sport.
  await assert.rejects(
    fetchGamesForSport('http://api', 'mlb', 168, pagedGamesHttp([gamesEcho({ sport: 'nba', games: [g] })]).http),
    /echoed sport/,
  );
  // Wrong echoed windowHours.
  await assert.rejects(
    fetchGamesForSport('http://api', 'mlb', 168, pagedGamesHttp([gamesEcho({ windowHours: 720, games: [g] })]).http),
    /echoed windowHours/,
  );
  // Wrong echoed availableOnly.
  await assert.rejects(
    fetchGamesForSport('http://api', 'mlb', 168, pagedGamesHttp([gamesEcho({ availableOnly: true, games: [g] })]).http),
    /echoed availableOnly/,
  );
  // Wrong echoed pagination.limit.
  await assert.rejects(
    fetchGamesForSport('http://api', 'mlb', 168, pagedGamesHttp([gamesEcho({ limit: 50, games: [g] })]).http),
    /echoed pagination\.limit/,
  );
  // Wrong echoed pagination.offset.
  await assert.rejects(
    fetchGamesForSport('http://api', 'mlb', 168, pagedGamesHttp([gamesEcho({ offset: 999, games: [g] })]).http),
    /echoed pagination\.offset/,
  );
  // A returned row carrying the wrong sport.
  await assert.rejects(
    fetchGamesForSport(
      'http://api',
      'mlb',
      168,
      pagedGamesHttp([gamesEcho({ sport: 'mlb', games: [makeGame({ gameId: 'e2', sport: 'nfl' })] })]).http,
    ),
    /with sport nfl/,
  );
});

test('gamesPaginationHonorsHasMoreWithCeiling', async () => {
  // A short first page with hasMore:true continues; termination is hasMore:false only.
  const p1 = gamesEcho({ games: [makeGame({ gameId: 'p1' }), makeGame({ gameId: 'p2' })], offset: 0, total: 3, hasMore: true });
  const p2 = gamesEcho({ games: [makeGame({ gameId: 'p3' })], offset: 200, total: 3, hasMore: false });
  const { http, urls } = pagedGamesHttp([p1, p2]);
  const rows = await fetchGamesForSport('http://api', 'mlb', 168, http);
  assert.deepEqual(rows.map((r) => r.gameId), ['p1', 'p2', 'p3']);
  assert.equal(urls.length, 2, 'a short first page did not terminate');
  assert.match(urls[1]!, /offset=200/);

  // A server that never stops (hasMore always true) must fault on the ceiling, not loop.
  const ceilingHttp: HttpGet = async (url) => {
    const m = /offset=(\d+)/.exec(url);
    const offset = m ? Number(m[1]) : 0;
    return gamesEcho({ offset, total: 10_000_000, hasMore: true, games: [] });
  };
  await assert.rejects(fetchGamesForSport('http://api', 'mlb', 168, ceilingHttp), /offset ceiling/);
});

test('legacyWatchStillCompiles', () => {
  // The legacy fetchers remain exported with their original signatures (a changed
  // signature would fail to type-check here) and are still callable functions.
  const legacyGames: (apiUrl: string, windowHours: number) => Promise<GamesEndpointRow[]> = fetchGamesForWindow;
  const legacyInputs: typeof fetchLiveInputs = fetchLiveInputs;
  assert.equal(typeof legacyGames, 'function');
  assert.equal(typeof legacyInputs, 'function');
});

// ===========================================================================
// history read + raw-id keyset walk + timeout + fault vs empty
// ===========================================================================

test('historyQueryIsFullColumnOrderedKeyset', async () => {
  const { http, urls } = historyTableHttp([rawValid(1)], 1000);
  await fetchFullHistoryRows({ supabaseUrl: 'http://db', anonKey: 'k', gameId: 'hg', market: 'moneyline', deadlineMs: 30000, now: () => 0, http });
  const first = urls[0]!;
  assert.match(first, /select=id,jsonodds_id,market,source,line,away_odds_american,away_odds_decimal,home_odds_american,home_odds_decimal,captured_at/);
  assert.match(first, /source=eq\.jsonodds/);
  assert.match(first, /order=id\.asc/);
  assert.match(first, /id=gt\.0/);
  assert.match(first, /jsonodds_id=eq\.hg/);
  assert.match(first, /market=eq\.moneyline/);
});

test('historyFetcherDelegatesToKeysetWalk', async () => {
  // Five rows behind a server that caps pages at 2 → pages [1,2] [3,4] [5] [] :
  // the short page {5} is not end-of-data; the walk terminates on the empty page.
  const rows = [rawValid(1), rawValid(2), rawValid(3), rawValid(4), rawValid(5)];
  const { http, urls } = historyTableHttp(rows, 2);
  const result = await fetchFullHistoryRows({ supabaseUrl: 'http://db', anonKey: 'k', gameId: 'hg', market: 'moneyline', deadlineMs: 30000, now: () => 0, http });
  assert.equal(result.rows.length, 5);
  assert.equal(result.dropped, 0);
  assert.equal(urls.length, 4, 'walked to the empty terminating page (short page not EOF)');
});

test('historyWalkParsesAfterRawCursorProgression', async () => {
  // Page 1 is entirely malformed but has valid raw ids; the walk must NOT stop there —
  // the valid higher-id rows on page 2 are still fetched, then parsed after the walk.
  const rows = [rawMalformed(1), rawMalformed(2), rawMalformed(3), rawValid(4), rawValid(5)];
  const { http, urls } = historyTableHttp(rows, 3);
  const result = await fetchFullHistoryRows({ supabaseUrl: 'http://db', anonKey: 'k', gameId: 'hg', market: 'moneyline', deadlineMs: 30000, now: () => 0, http });
  assert.equal(result.dropped, 3);
  assert.deepEqual(result.rows.map((r) => r.id), [4, 5]);
  assert.equal(urls.length, 3, 'page 2 was fetched despite an all-malformed page 1');
});

test('historyReadHonorsAggregateDeadline', async () => {
  // Two pages, each individually faster than the timeout but cumulatively slower:
  // the read aborts at the AGGREGATE deadline (1000ms), never 2×700ms.
  const deadlineMs = 1000;
  const pageLatency = 700;
  let clock = 0;
  const timeouts: Array<number | undefined> = [];
  let pageIndex = 0;
  const http: HttpGet = async (_url, _headers, timeoutMs) => {
    timeouts.push(timeoutMs);
    if (pageLatency > (timeoutMs ?? Number.POSITIVE_INFINITY)) {
      clock += timeoutMs!; // the fetch aborts after consuming the remaining budget
      throw new Error('simulated fetch abort (per-page timeout)');
    }
    clock += pageLatency;
    pageIndex += 1;
    return [{ id: pageIndex }]; // a non-empty page so the walk continues
  };
  await assert.rejects(
    fetchFullHistoryRows({ supabaseUrl: 'http://db', anonKey: 'k', gameId: 'hg', market: 'moneyline', deadlineMs, now: () => clock, http }),
    /abort|timeout|deadline/i,
  );
  assert.deepEqual(timeouts, [1000, 300], 'each page received only the remaining budget');
  assert.equal(clock, deadlineMs, 'aborted at the aggregate deadline, not N × per-page latency');
});

test('emptyHistoryIsCompletedNotFault', async () => {
  const booted = bootMlbCohort();
  const deps = historyDeps(async () => ({ rows: [], dropped: 0 }));
  const result = await readMarketEvidence(booted, 'hg', 'moneyline', deps);
  assert.deepEqual(result.historyRows, []);
  assert.equal(result.historyWatermark, null);
  assert.equal(typeof result.readCompletedAt, 'string');
});

test('malformedOrDroppedHistoryFaultsAfterFullWalk', async () => {
  const booted = bootMlbCohort();
  // (a) a dropped row faults the completed read.
  await assert.rejects(
    readMarketEvidence(booted, 'hg', 'moneyline', historyDeps(async () => ({ rows: [parsedRow(4, 'hg', 'moneyline')], dropped: 1 }))),
    /dropped 1 malformed/,
  );
  // (b) a non-array body is a source-integrity fault at the fetcher.
  await assert.rejects(
    fetchFullHistoryRows({ supabaseUrl: 'http://db', anonKey: 'k', gameId: 'hg', market: 'moneyline', deadlineMs: 30000, now: () => 0, http: async () => ({ not: 'an array' }) }),
    /Expected array|invalid/i,
  );
  // (c) a non-safe-integer raw id is a fault at the fetcher (keyset refusal).
  await assert.rejects(
    fetchFullHistoryRows({ supabaseUrl: 'http://db', anonKey: 'k', gameId: 'hg', market: 'moneyline', deadlineMs: 30000, now: () => 0, http: async () => [{ id: 1.5 }] }),
    /non-increasing id/,
  );
  // Later pages were fetched before the drop surfaced: page1 malformed, page2 valid,
  // both fetched, then the completed read faults on the drop.
  const { http, urls } = historyTableHttp([rawMalformed(1), rawValid(2)], 1);
  const walked = await fetchFullHistoryRows({ supabaseUrl: 'http://db', anonKey: 'k', gameId: 'hg', market: 'moneyline', deadlineMs: 30000, now: () => 0, http });
  assert.equal(walked.dropped, 1);
  assert.equal(urls.length, 3, 'both data pages + the terminating empty page were fetched');
  await assert.rejects(readMarketEvidence(booted, 'hg', 'moneyline', historyDeps(async () => walked)), /dropped 1 malformed/);
});

test('historyRowsBindToRequestedPair', async () => {
  const booted = bootMlbCohort();
  // A VALID row for the wrong game id faults (query params alone are not defensive).
  await assert.rejects(
    readMarketEvidence(booted, 'hg', 'moneyline', historyDeps(async () => ({ rows: [parsedRow(1, 'OTHER', 'moneyline')], dropped: 0 }))),
    /does not bind to requested/,
  );
  // A valid row for the wrong market faults.
  await assert.rejects(
    readMarketEvidence(booted, 'hg', 'moneyline', historyDeps(async () => ({ rows: [parsedRow(1, 'hg', 'total')], dropped: 0 }))),
    /does not bind to requested/,
  );
});

// ===========================================================================
// boot checks
// ===========================================================================

test('bootRejectsNonMlbSportAllowList', () => {
  const has = (raw: Record<string, unknown>): boolean =>
    validateManifestAgainstCode(parseManifest(raw)).some((v) => /sportAllowList/.test(v));
  assert.equal(has(manifestRaw({ sportAllowList: ['nfl'] })), true, "['nfl'] is rejected");
  assert.equal(has(manifestRaw({ sportAllowList: ['mlb', 'nfl'] })), true, "superset ['mlb','nfl'] is rejected");
  assert.equal(has(manifestRaw({ sportAllowList: ['mlb'] })), false, "['mlb'] passes");
});

test('duplicateSportAllowListEntryFailsBoot', () => {
  const v = validateManifestAgainstCode(parseManifest(manifestRaw({ sportAllowList: ['mlb', 'mlb'] })));
  assert.ok(v.some((s) => /sportAllowList/.test(s)), v.join('; '));
});

test('supportedSportsIsRuntimeFrozen', () => {
  assert.throws(() => (SUPPORTED_SPORTS as string[]).push('nfl'));
  assert.throws(() => {
    (SUPPORTED_SPORTS as string[])[0] = 'nfl';
  });
  assert.deepEqual([...SUPPORTED_SPORTS], ['mlb'], 'membership unchanged');
});

test('sourceQueryVersionViolationOnMismatch', () => {
  const mismatch = validateManifestAgainstCode(parseManifest(manifestRaw({ sourceQueryVersion: 'source-query-v2' })));
  assert.ok(mismatch.some((v) => /sourceQueryVersion/.test(v)), mismatch.join('; '));
  const ok = validateManifestAgainstCode(parseManifest(manifestRaw({ sourceQueryVersion: SOURCE_QUERY_VERSION })));
  assert.ok(!ok.some((v) => /sourceQueryVersion/.test(v)), 'the code version produces no violation');
});

// ===========================================================================
// duplicate / identity / source binding
// ===========================================================================

test('duplicateMarketRowFailsClosed', async () => {
  const games = [makeGame({ gameId: 'dm1' })];
  const odds = [
    makeOdds({ jsonodds_id: 'dm1', market: 'moneyline' }),
    makeOdds({ jsonodds_id: 'dm1', market: 'moneyline' }), // duplicate (gameId, market)
  ];
  const { deps } = fakeDiscoveryReads(games, odds);
  await assert.rejects(discover(bootMlbCohort(), deps), /duplicate current_odds/);
});

test('duplicateGameRowCanonicalDedupOrFail', async () => {
  const base = makeGame({ gameId: 'cg1' });
  // A canonical-equal repeat deduplicates to one row. The repeat is KEY-REORDERED
  // (identical values, different key order), so only a key-sorting canonical compare
  // dedups it — a byte / JSON.stringify compare would see a different order and wrongly
  // fault it as a conflicting duplicate, which is what distinguishes the two.
  const keyReordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as GamesEndpointRow;
  const deduped = await collectGames(['mlb'], 168, async () => [base, keyReordered]);
  assert.equal(deduped.length, 1);
  // A conflicting repeat (same id, different content) faults.
  await assert.rejects(
    collectGames(['mlb'], 168, async () => [base, makeGame({ gameId: 'cg1', slug: 'a-different-slug' })]),
    /conflicting duplicate games row/,
  );
});

test('gameIdentityMustMatchJsonoddsExternalId', async () => {
  const bad = makeGame({ gameId: 'gi1', externalIds: { jsonodds: 'OTHER', sportspage: null, rundown: null } });
  await assert.rejects(collectGames(['mlb'], 168, async () => [bad]), /does not equal externalIds\.jsonodds/);
});

test('currentOddsRowsBindToNetworkAndGameSet', async () => {
  const games = [makeGame({ gameId: 'nb1' })];
  // Foreign network.
  await assert.rejects(
    discover(bootMlbCohort(), fakeDiscoveryReads(games, [makeOdds({ jsonodds_id: 'nb1', network: 'ethereum' })]).deps),
    /carries network ethereum/,
  );
  // An unrequested game id.
  await assert.rejects(
    discover(bootMlbCohort(), fakeDiscoveryReads(games, [makeOdds({ jsonodds_id: 'not-discovered' })]).deps),
    /not one of the discovered games/,
  );
});

// ===========================================================================
// branded discovery snapshot + real read seams
// ===========================================================================

test('discoverSeamReturnsFrozenBrandedBuildableSnapshot', async () => {
  const games = [makeGame({ gameId: 's1' }), makeGame({ gameId: 's2' })];
  const oddsInput = [
    makeOdds({ jsonodds_id: 's1', market: 'moneyline' }), // buildable
    makeOdds({ jsonodds_id: 's2', market: 'moneyline', away_odds_american: null }), // NOT buildable
  ];
  const { deps } = fakeDiscoveryReads(games, oddsInput);
  const snap = await discover(bootMlbCohort(), deps);

  // Branded — the genuine snapshot authenticates; a structural copy does not.
  assert.doesNotThrow(() => assertDiscoverySnapshot(snap));
  assert.throws(() => assertDiscoverySnapshot({ ...snap } as unknown as DiscoverySnapshot), /forged or substituted/);

  // Deep-frozen graph.
  assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.oddsRows) && Object.isFrozen(snap.games));
  assert.throws(() => (snap.oddsRows as CurrentOddsRow[]).push(makeOdds()));

  // Only buildable current-odds rows; the exact discovery completion instant.
  assert.deepEqual(snap.oddsRows.map((r) => r.jsonodds_id), ['s1']);
  assert.equal(snap.fetchCompletedAt, new Date(NOW_MS).toISOString());

  // Detached — mutating the caller's originals after the seal cannot change it.
  oddsInput[0]!.away_odds_american = 999;
  oddsInput.push(makeOdds({ jsonodds_id: 's1', market: 'total' }));
  assert.equal(snap.oddsRows.length, 1);
  assert.equal(snap.oddsRows[0]!.away_odds_american, -120);

  // NOT a PreparedFireSnapshot — it carries no sealed fire identity, and the
  // prepared-fire brand rejects it.
  assert.ok(!('fireId' in snap) && !('runId' in snap) && !('prepared' in snap));
  assert.throws(() => assertPreparedFireSnapshot(snap as never), /forged or substituted/);
});

test('readSeamReturnsFullRowsWatermarkAndCompletion', async () => {
  const booted = bootMlbCohort();
  const rows = [parsedRow(3, 'hg', 'moneyline'), parsedRow(1, 'hg', 'moneyline'), parsedRow(2, 'hg', 'moneyline')];
  const result = await readMarketEvidence(booted, 'hg', 'moneyline', historyDeps(async () => ({ rows, dropped: 0 })));
  assert.equal(result.historyRows.length, 3, 'the FULL rows are returned, not just the opener');
  assert.equal(result.historyWatermark, null, 'live mode → null watermark');
  assert.equal(result.readCompletedAt, new Date(NOW_MS).toISOString());
  // The full rows feed the existing opener derivation.
  const opener = firstTwoSided(result.historyRows);
  assert.equal(opener?.id, 1);
});

// Manifest value-source + completion-ordering teeth: the seams must read the discovery
// window / history timeout FROM the booted manifest (proven with NON-default values so a
// hard-coded default cannot pass), and stamp each completion instant AFTER its reads
// (proven with advancing clocks so a pre-read stamp cannot pass).

test('discoveryWindowComesFromManifest', async () => {
  // 417 is deliberately non-default (the fixture default is 168), so a hard-coded window
  // would satisfy the value-agnostic games-fetch tooth yet fail here.
  const { deps, gamesCalls } = fakeDiscoveryReads([makeGame({ gameId: 'wm1' })], [makeOdds({ jsonodds_id: 'wm1' })]);
  await discover(bootMlbCohort({ gameDiscoveryWindowHours: 417 }), deps);
  assert.ok(gamesCalls.length > 0, 'discovery read games');
  assert.ok(gamesCalls.every((c) => c.windowHours === 417), 'the manifest window (417) reached every readGames call');
});

test('historyReadTimeoutComesFromManifest', async () => {
  // 1_234 is deliberately non-default (the fixture default is 30_000), so a hard-coded
  // deadline would satisfy the aggregate-deadline tooth yet fail here.
  let seenDeadline = -1;
  const deps: HistoryReadDeps = {
    fetchHistory: async (_gameId, _market, deadlineMs) => {
      seenDeadline = deadlineMs;
      return { rows: [], dropped: 0 };
    },
    now: () => NOW_MS,
  };
  await readMarketEvidence(bootMlbCohort({ historyReadTimeoutMs: 1_234 }), 'hg', 'moneyline', deps);
  assert.equal(seenDeadline, 1_234, 'the manifest timeout (1234) reached fetchHistory');
});

test('discoveryCompletionIsStampedAfterReads', async () => {
  // An advancing clock: fetchCompletedAt must be the post-read instant, not the start —
  // moving the stamp before the reads would capture `start` and fail here.
  const start = NOW_MS;
  const afterReads = NOW_MS + 2_000;
  let clock = start;
  const deps: DiscoveryReads = {
    readGames: async (sport) => {
      clock = NOW_MS + 1_000;
      return [makeGame({ gameId: 'ac1' })].filter((g) => g.sport === sport);
    },
    readCurrentOdds: async () => {
      clock = afterReads;
      return [makeOdds({ jsonodds_id: 'ac1' })];
    },
    now: () => clock,
  };
  const snap = await discover(bootMlbCohort(), deps);
  assert.equal(snap.fetchCompletedAt, new Date(afterReads).toISOString(), 'stamped after the reads, not at start');
  assert.notEqual(snap.fetchCompletedAt, new Date(start).toISOString());
});

test('historyCompletionIsStampedAfterRead', async () => {
  // An advancing clock: readCompletedAt must be the post-read instant, not before —
  // moving the stamp before the fetch would capture `start` and fail here.
  const start = NOW_MS;
  const afterRead = NOW_MS + 3_000;
  let clock = start;
  const deps: HistoryReadDeps = {
    fetchHistory: async () => {
      clock = afterRead;
      return { rows: [], dropped: 0 };
    },
    now: () => clock,
  };
  const result = await readMarketEvidence(bootMlbCohort(), 'hg', 'moneyline', deps);
  assert.equal(result.readCompletedAt, new Date(afterRead).toISOString(), 'stamped after the read, not before');
  assert.notEqual(result.readCompletedAt, new Date(start).toISOString());
});

test('discoveryRefusesUnbootedCohort', async () => {
  const forged: BootedCohort = { cohortId: 'forged', manifest: parseManifest(manifestRaw()) };
  const { deps, gamesCalls, oddsCalls } = fakeDiscoveryReads([makeGame()], [makeOdds()]);
  await assert.rejects(discover(forged, deps), /not produced by cohortBoot/);
  let historyCalled = 0;
  await assert.rejects(
    readMarketEvidence(forged, 'hg', 'moneyline', historyDeps(async () => {
      historyCalled += 1;
      return { rows: [], dropped: 0 };
    })),
    /not produced by cohortBoot/,
  );
  // Authentication runs BEFORE any read (no manifest field was touched).
  assert.equal(gamesCalls.length, 0);
  assert.equal(oddsCalls.length, 0);
  assert.equal(historyCalled, 0);
});

// ===========================================================================
// compatibility + non-activation
// ===========================================================================

test('discoveryAndReadSeamsRemainNonActivating', () => {
  // The discovery/read module must not import any activation surface — no store,
  // provider adapter, runner spine/loop, claim/dispatch/lifecycle, CLI, or watcher —
  // and must not compose the prepared-fire seal or candidate evaluation. A source
  // scan of the module's imports proves none is reachable from the seams.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lineOpenRead.ts'), 'utf8');
  const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
  const forbidden = [
    './store',
    './providers',
    './lineOpenSpine',
    './lineOpenClaim',
    './lineOpenDispatch',
    './lineOpenLifecycle',
    './fireArtifactProducer',
    './fireArtifactSink',
    './fireArtifactWriter',
    './fireSettlement',
    './fireRecovery',
    './runner',
    './watch',
    './watchMain',
    './shadowSmoke',
    './detection',
    './preparedFire',
    './preparedRequest',
    './scopedRequest',
  ];
  for (const line of importLines) {
    for (const mod of forbidden) {
      assert.ok(!line.includes(`'${mod}`), `must not import ${mod}: ${line.trim()}`);
    }
  }
  // Seam factories exist and are functions; they wire reads only.
  const discoverFn: DiscoverFn = createDiscoverFn({ apiUrl: 'http://a', supabaseUrl: 'http://d', anonKey: 'k' });
  const readFn: ReadMarketEvidenceFn = createReadMarketEvidenceFn({ apiUrl: 'http://a', supabaseUrl: 'http://d', anonKey: 'k' });
  assert.equal(typeof discoverFn, 'function');
  assert.equal(typeof readFn, 'function');
});
