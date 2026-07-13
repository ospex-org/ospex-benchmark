import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildBundle } from './bundle.js';
import { parseRunRecords, verifyRunIntegrity } from './scoring.js';
import { makeValidResponse, TEST_ARM } from './testFactories.js';
import {
  fireEligibleGame,
  loadLedger,
  parseWatchArgs,
  persistLedgerEntry,
  watchTick,
  WatchUsageError,
} from './watch.js';
import type { FireOutcome, LedgerEntry, WatchDeps } from './watch.js';
import type { BuildResult } from './bundle.js';
import type {
  CurrentOddsRow,
  GamesEndpointRow,
  MarketKey,
  ProviderAdapter,
  ProviderResponse,
  SlateInputs,
} from './types.js';

// ---------------------------------------------------------------------------
// Synthetic live-shaped inputs: one future game whose full board is fresh
// relative to the cycle's fetch-completion instant.
// ---------------------------------------------------------------------------

const GAME_ID = '00000000-0000-4000-8000-0000000wat01';
const FETCH_COMPLETED_AT = '2026-07-20T12:00:00.000Z';
const MATCH_TIME = '2026-07-20T23:10:00+00:00';
const QUOTE_AT = '2026-07-20T11:55:00.000Z'; // 5 minutes before assembly — fresh
const BOARD_FIRST_SEEN = '2026-07-20T11:50:00.000Z';
const NOW_MS = Date.parse('2026-07-20T12:00:30.000Z'); // opener age ≈ 10.5 min

function gamesRow(overrides: Partial<GamesEndpointRow> = {}): GamesEndpointRow {
  return {
    gameId: GAME_ID,
    slug: 'mil-pit-2026-07-20',
    sport: 'mlb',
    matchTime: MATCH_TIME,
    status: 'upcoming',
    homeTeam: { name: 'Pittsburgh Pirates', abbreviation: 'PIT' },
    awayTeam: { name: 'Milwaukee Brewers', abbreviation: 'MIL' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: false,
    externalIds: { jsonodds: GAME_ID, sportspage: null, rundown: null },
    ...overrides,
  };
}

function oddsRow(market: MarketKey, line: number | null): CurrentOddsRow {
  return {
    network: 'polygon',
    jsonodds_id: GAME_ID,
    market,
    line,
    away_odds_american: market === 'moneyline' ? -135 : 122,
    home_odds_american: market === 'moneyline' ? 122 : -152,
    upstream_last_updated: QUOTE_AT,
    poll_captured_at: QUOTE_AT,
    changed_at: QUOTE_AT,
  };
}

function fullBoardInputs(overrides: Partial<SlateInputs> = {}): SlateInputs {
  return {
    gamesRows: [gamesRow()],
    oddsRows: [oddsRow('moneyline', null), oddsRow('spread', 1.5), oddsRow('total', 8.5)],
    fetchStartedAt: '2026-07-20T11:59:58.000Z',
    fetchCompletedAt: FETCH_COMPLETED_AT,
    ...overrides,
  };
}

interface FakeFire {
  calls: Array<{ gameId: string; slateDate: string }>;
  fire: WatchDeps['fireGame'];
}

function fakeFire(outcome?: Partial<FireOutcome>, fail = false): FakeFire {
  const calls: FakeFire['calls'] = [];
  return {
    calls,
    fire: (build: BuildResult, _inputs: SlateInputs, slateDate: string): Promise<FireOutcome> => {
      const request = build.requests[0];
      calls.push({ gameId: request?.gameId ?? 'missing', slateDate });
      if (fail) return Promise.reject(new Error('synthetic fire failure'));
      return Promise.resolve({
        runId: 'watch-v0-2026-07-20-abc123',
        runFile: 'out/watch-v0-2026-07-20-abc123.ndjson',
        armOutcomes: { [TEST_ARM.participantId]: 'valid' },
        baselineDecisions: 6,
        collisionFailed: false,
        ...outcome,
      });
    },
  };
}

function makeDeps(overrides: Partial<WatchDeps> = {}): WatchDeps & { logged: string[]; errors: string[] } {
  const logged: string[] = [];
  const errors: string[] = [];
  const ledgerDir = mkdtempSync(join(tmpdir(), 'watch-ledger-'));
  return {
    fetchInputs: () => Promise.resolve(fullBoardInputs()),
    fetchFirstBoardAppearance: () => Promise.resolve(BOARD_FIRST_SEEN),
    fireGame: fakeFire().fire,
    ledgerDir,
    ledger: new Map<string, LedgerEntry>(),
    boardFirstSeen: new Map<string, string>(),
    nowMs: () => NOW_MS,
    lateMs: 60 * 60_000,
    log: (line) => logged.push(line),
    logError: (line) => errors.push(line),
    logged,
    errors,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Detection + gate behavior
// ---------------------------------------------------------------------------

test('an incomplete board is watched, not fired and not ledgered', async () => {
  const fire = fakeFire();
  const deps = makeDeps({
    fetchInputs: () =>
      Promise.resolve(fullBoardInputs({ oddsRows: [oddsRow('moneyline', null)] })),
    fireGame: fire.fire,
  });
  const summary = await watchTick(deps);
  assert.equal(summary.watched, 1);
  assert.equal(summary.fired, 0);
  assert.equal(fire.calls.length, 0);
  assert.equal(deps.ledger.size, 0);
  assert.equal(loadLedger(deps.ledgerDir, () => undefined).size, 0);
});

test('a fresh full board fires immediately and is ledgered as fired', async () => {
  const fire = fakeFire();
  const deps = makeDeps({ fireGame: fire.fire });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 1);
  assert.deepEqual(fire.calls, [{ gameId: GAME_ID, slateDate: '2026-07-20' }]);
  const entry = deps.ledger.get(GAME_ID);
  assert.ok(entry);
  assert.equal(entry.decision, 'fired');
  assert.equal(entry.boardCompletedAt, BOARD_FIRST_SEEN);
  assert.equal(entry.openerAgeMinutes, 11); // 10.5 min rounded
  assert.equal(entry.runId, 'watch-v0-2026-07-20-abc123');
  assert.equal(entry.collisionFailed, false);
  // Persisted to disk with the same content.
  const onDisk = loadLedger(deps.ledgerDir, () => undefined).get(GAME_ID);
  assert.deepEqual(onDisk, entry);
});

test('a board that completed beyond the late threshold is excluded, never fired', async () => {
  const fire = fakeFire();
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchFirstBoardAppearance: () => Promise.resolve('2026-07-20T09:00:00.000Z'), // 3h old
  });
  const summary = await watchTick(deps);
  assert.equal(summary.late, 1);
  assert.equal(summary.fired, 0);
  assert.equal(fire.calls.length, 0);
  const entry = deps.ledger.get(GAME_ID);
  assert.ok(entry);
  assert.equal(entry.decision, 'late_detection');
  assert.equal(entry.runId, undefined);
  // Excluded means excluded: the next tick never revisits it.
  const second = await watchTick(deps);
  assert.equal(second.late, 0);
  assert.equal(second.fired, 0);
  assert.equal(fire.calls.length, 0);
});

test('board-completion is the NEWEST of the three markets\' first appearances', async () => {
  const fire = fakeFire();
  const perMarket: Record<string, string> = {
    moneyline: '2026-07-20T08:00:00.000Z', // opened hours ago
    spread: '2026-07-20T08:05:00.000Z',
    total: BOARD_FIRST_SEEN, // totals hung 10 minutes ago — board just completed
  };
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchFirstBoardAppearance: (_gameId, market) => Promise.resolve(perMarket[market] ?? null),
  });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 1);
  assert.equal(deps.ledger.get(GAME_ID)?.boardCompletedAt, BOARD_FIRST_SEEN);
});

test('a missing first-appearance row defers the game (transient), then fires once visible — and caches immutable reads', async () => {
  const fire = fakeFire();
  let totalVisible = false;
  let reads = 0;
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchFirstBoardAppearance: (_gameId, market) => {
      reads += 1;
      if (market === 'total' && !totalVisible) return Promise.resolve(null);
      return Promise.resolve(BOARD_FIRST_SEEN);
    },
  });
  const first = await watchTick(deps);
  assert.equal(first.deferred, 1);
  assert.equal(fire.calls.length, 0);
  assert.equal(deps.ledger.size, 0);
  const readsAfterFirst = reads;

  totalVisible = true;
  const second = await watchTick(deps);
  assert.equal(second.fired, 1);
  // moneyline + spread were cached from the first tick; only total re-read.
  assert.equal(reads - readsAfterFirst, 1);
});

test('handled games are skipped forever, including across a restart (ledger re-derived from disk)', async () => {
  const fire = fakeFire();
  const deps = makeDeps({ fireGame: fire.fire });
  await watchTick(deps);
  assert.equal(fire.calls.length, 1);
  await watchTick(deps);
  assert.equal(fire.calls.length, 1);

  // "Restart": fresh in-memory state, same ledger directory.
  const reloaded = makeDeps({ fireGame: fire.fire, ledgerDir: deps.ledgerDir });
  reloaded.ledger = loadLedger(deps.ledgerDir, () => undefined);
  await watchTick(reloaded);
  assert.equal(fire.calls.length, 1);
});

test('a fire crash still claims the ledger — the game is never double-fired', async () => {
  const fire = fakeFire(undefined, true);
  const deps = makeDeps({ fireGame: fire.fire });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 0);
  assert.equal(fire.calls.length, 1);
  const entry = deps.ledger.get(GAME_ID);
  assert.ok(entry);
  assert.equal(entry.decision, 'fired');
  assert.match(entry.fireError ?? '', /synthetic fire failure/);
  assert.equal(deps.errors.length, 1);

  const again = await watchTick(deps);
  assert.equal(again.fired, 0);
  assert.equal(fire.calls.length, 1); // no second (double-billed) dispatch
});

test('an unreadable ledger file is treated as handled (never risk a double-fire)', async () => {
  const deps = makeDeps({});
  writeFileSync(join(deps.ledgerDir, `${GAME_ID}.json`), 'not json at all', 'utf8');
  const errors: string[] = [];
  const ledger = loadLedger(deps.ledgerDir, (line) => errors.push(line));
  assert.equal(ledger.get(GAME_ID)?.decision, 'fired');
  assert.equal(errors.length, 1);
});

test('ledger writes pass the redaction chokepoint', () => {
  const secret = 'sk-watch-ledger-secret-000000000000';
  const original = process.env['OPENAI_API_KEY'];
  process.env['OPENAI_API_KEY'] = secret;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'watch-redact-'));
    const entry: LedgerEntry = {
      gameId: GAME_ID,
      slug: 'mil-pit-2026-07-20',
      decision: 'fired',
      decidedAt: FETCH_COMPLETED_AT,
      slateDate: '2026-07-20',
      scheduledStartUtc: MATCH_TIME,
      boardCompletedAt: BOARD_FIRST_SEEN,
      openerAgeMinutes: 11,
      gameSha256: 'x',
      requestSha256: 'y',
      fireError: `provider said: ${secret}`,
    };
    persistLedgerEntry(dir, entry);
    const written = readFileSync(join(dir, `${GAME_ID}.json`), 'utf8');
    assert.ok(!written.includes(secret));
    assert.ok(written.includes('[REDACTED]'));
  } finally {
    if (original === undefined) {
      delete process.env['OPENAI_API_KEY'];
    } else {
      process.env['OPENAI_API_KEY'] = original;
    }
  }
});

// ---------------------------------------------------------------------------
// The fire path end to end: a watch-fired single-game run file must satisfy
// the scorer's full integrity verification unchanged.
// ---------------------------------------------------------------------------

function stubAdapter(rawText: () => string): ProviderAdapter {
  return {
    provider: TEST_ARM.provider,
    requestedModelId: TEST_ARM.requestedModelId,
    credentialEnvVar: TEST_ARM.credentialEnvVar,
    hasCredential: () => true,
    chat(): Promise<ProviderResponse> {
      return Promise.resolve({
        rawText: rawText(),
        reportedModelId: 'stub-model-1',
        providerResponseId: 'stub-response',
        httpStatus: 200,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        usageRaw: { prompt_tokens: 100, completion_tokens: 50 },
        requestParams: { stub: true },
      });
    },
  };
}

test('a fired game produces a run file that passes full scorer integrity verification', async () => {
  const inputs = fullBoardInputs();
  const slateDate = '2026-07-20';
  const build = buildBundle(inputs, slateDate, { requireFuture: false });
  const request = build.requests[0];
  assert.ok(request);

  const cohortId = `watch-v0-${slateDate}`;
  const adapter = stubAdapter(() =>
    JSON.stringify(makeValidResponse(request, TEST_ARM, cohortId)),
  );

  // Monotonic fake clock well before the cutoff: every read advances 5ms so
  // recorded timestamps are ordered and latency is exact.
  let t = NOW_MS;
  const nowMs = (): number => {
    t += 5;
    return t;
  };

  const outDir = mkdtempSync(join(tmpdir(), 'watch-fire-'));
  const outcome = await fireEligibleGame(build, inputs, slateDate, {
    arms: [TEST_ARM],
    adapters: new Map([[TEST_ARM.participantId, adapter]]),
    approvedReportedModelIds: () => ['stub-model-1'],
    outDir,
    timeoutMs: 60_000,
    maxOutputTokens: 16000,
    mode: 'live',
    clockMode: 'wall',
    nowMs,
    log: () => undefined,
    logError: () => undefined,
  });

  assert.equal(outcome.collisionFailed, false);
  assert.equal(outcome.armOutcomes[TEST_ARM.participantId], 'valid');
  assert.equal(outcome.baselineDecisions, 6);
  assert.match(outcome.runId, /^watch-v0-2026-07-20-[0-9a-f]{6}$/);

  const lines = readFileSync(outcome.runFile, 'utf8').split(/\r?\n/);
  const run = parseRunRecords(lines);
  const violations = verifyRunIntegrity(run, {
    expectedArms: [
      {
        participantId: TEST_ARM.participantId,
        provider: TEST_ARM.provider,
        requestedModelId: TEST_ARM.requestedModelId,
        approvedReportedModelIds: ['stub-model-1'],
      },
    ],
  });
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

test('parseWatchArgs defaults and validation', () => {
  const defaults = parseWatchArgs([], () => undefined);
  assert.deepEqual(defaults, {
    dryRun: false,
    once: false,
    outDir: 'out',
    pollSeconds: 300,
    windowHours: 168,
    lateMinutes: 60,
    timeoutSeconds: null,
    maxOutputTokens: 16000,
  });
  assert.equal(parseWatchArgs(['--dry-run'], () => undefined).once, true);
  assert.equal(parseWatchArgs(['--late-minutes', '15'], () => undefined).lateMinutes, 15);
  assert.throws(() => parseWatchArgs(['--poll-seconds', '5'], () => undefined), WatchUsageError);
  assert.throws(() => parseWatchArgs(['--window-hours', '9999'], () => undefined), WatchUsageError);
  assert.throws(() => parseWatchArgs(['--bogus'], () => undefined), WatchUsageError);
});
