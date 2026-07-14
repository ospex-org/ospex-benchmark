import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
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
import type { FireOutcome, LedgerEntry, WatchDeps, WatchGateProvenance } from './watch.js';
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

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

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

function oddsRow(market: MarketKey, line: number | null, gameId: string = GAME_ID): CurrentOddsRow {
  return {
    network: 'polygon',
    jsonodds_id: gameId,
    market,
    line,
    away_odds_american: market === 'moneyline' ? -135 : 122,
    home_odds_american: market === 'moneyline' ? 122 : -152,
    upstream_last_updated: QUOTE_AT,
    poll_captured_at: QUOTE_AT,
    changed_at: QUOTE_AT,
  };
}

function fullBoardFor(gameId: string, matchTime: string = MATCH_TIME): {
  row: GamesEndpointRow;
  odds: CurrentOddsRow[];
} {
  return {
    row: gamesRow({ gameId, matchTime, externalIds: { jsonodds: gameId, sportspage: null, rundown: null } }),
    odds: [oddsRow('moneyline', null, gameId), oddsRow('spread', 1.5, gameId), oddsRow('total', 8.5, gameId)],
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
  calls: Array<{
    gameId: string;
    slateDate: string;
    provenance: WatchGateProvenance;
    fetchCompletedAt: string;
  }>;
  fire: WatchDeps['fireGame'];
}

function fakeFire(outcome?: Partial<FireOutcome>, fail = false): FakeFire {
  const calls: FakeFire['calls'] = [];
  return {
    calls,
    fire: (
      build: BuildResult,
      inputs: SlateInputs,
      slateDate: string,
      provenance: WatchGateProvenance,
    ): Promise<FireOutcome> => {
      const request = build.requests[0];
      calls.push({
        gameId: request?.gameId ?? 'missing',
        slateDate,
        provenance,
        fetchCompletedAt: inputs.fetchCompletedAt,
      });
      if (fail) return Promise.reject(new Error('synthetic fire failure'));
      return Promise.resolve({
        runId: 'watch-v0-2026-07-20-abc123',
        runFile: 'out/watch-v0-2026-07-20-abc123.ndjson',
        armOutcomes: { [TEST_ARM.participantId]: 'valid' },
        baselineDecisions: 8,
        collisionFailed: false,
        ...outcome,
      });
    },
  };
}

function makeDeps(overrides: Partial<WatchDeps> = {}): WatchDeps & { logged: string[]; errors: string[] } {
  const logged: string[] = [];
  const errors: string[] = [];
  const ledgerDir = tempDir('watch-ledger-');
  return {
    fetchInputs: () => Promise.resolve(fullBoardInputs()),
    fetchFirstBoardAppearance: () => Promise.resolve(BOARD_FIRST_SEEN),
    fireGame: fakeFire().fire,
    ledgerDir,
    ledger: new Map<string, LedgerEntry>(),
    boardFirstSeen: new Map<string, string>(),
    deferredSince: new Map<string, number>(),
    deferralWarned: new Set<string>(),
    nowMs: () => NOW_MS,
    lateMs: 60 * 60_000,
    maxFiresPerTick: 10,
    maxInputAgeMs: 10 * 60_000,
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
  assert.deepEqual(
    fire.calls.map((c) => ({ gameId: c.gameId, slateDate: c.slateDate })),
    [{ gameId: GAME_ID, slateDate: '2026-07-20' }],
  );
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
    const dir = tempDir('watch-redact-');
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

  const outDir = tempDir('watch-fire-');
  const provenance: WatchGateProvenance = {
    detectedAt: new Date(NOW_MS).toISOString(),
    boardCompletedAt: BOARD_FIRST_SEEN,
    openerAgeMinutes: Math.round((NOW_MS - Date.parse(BOARD_FIRST_SEEN)) / 60_000),
    lateThresholdMinutes: 60,
  };
  const outcome = await fireEligibleGame(build, inputs, slateDate, provenance, {
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
  assert.equal(outcome.baselineDecisions, 8);
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

  // The human artifact must describe watch entry semantics truthfully — not
  // the smoke's late-capture caveat — and cite the recorded provenance.
  const summaryMd = readFileSync(join(outDir, `${outcome.runId}-summary.md`), 'utf8');
  assert.ok(summaryMd.includes('line-open watch run'));
  assert.ok(summaryMd.includes('fired at detection'));
  assert.ok(summaryMd.includes(BOARD_FIRST_SEEN));
  assert.ok(!summaryMd.includes('captured late'));

  // The scorer FAIL-CLOSES on watch provenance: stripping it, or recording a
  // gate-violating age, makes the file unscoreable.
  const metaIndex = lines.findIndex((l) => l.includes('"recordType":"run_meta"'));
  assert.ok(metaIndex >= 0);
  const meta = JSON.parse(lines[metaIndex] ?? '') as Record<string, unknown>;

  const stripped = [...lines];
  const { watch: _watch, ...withoutWatch } = meta;
  stripped[metaIndex] = JSON.stringify(withoutWatch);
  const strippedViolations = verifyRunIntegrity(parseRunRecords(stripped), {
    expectedArms: [
      {
        participantId: TEST_ARM.participantId,
        provider: TEST_ARM.provider,
        requestedModelId: TEST_ARM.requestedModelId,
        approvedReportedModelIds: ['stub-model-1'],
      },
    ],
  });
  assert.ok(strippedViolations.some((v) => v.includes('no watch provenance')));

  const lateFired = [...lines];
  lateFired[metaIndex] = JSON.stringify({
    ...meta,
    watch: { ...provenance, openerAgeMinutes: 999, lateThresholdMinutes: 60 },
  });
  const lateViolations = verifyRunIntegrity(parseRunRecords(lateFired), {
    expectedArms: [
      {
        participantId: TEST_ARM.participantId,
        provider: TEST_ARM.provider,
        requestedModelId: TEST_ARM.requestedModelId,
        approvedReportedModelIds: ['stub-model-1'],
      },
    ],
  });
  assert.ok(lateViolations.some((v) => v.includes('exceeds the recorded late threshold')));

  const expected = [
    {
      participantId: TEST_ARM.participantId,
      provider: TEST_ARM.provider,
      requestedModelId: TEST_ARM.requestedModelId,
      approvedReportedModelIds: ['stub-model-1'],
    },
  ];

  // Shifting detection forward past the recorded dispatch instants breaks
  // the bundle → detection → request chain.
  const shifted = [...lines];
  const shiftedWatch = {
    ...provenance,
    detectedAt: new Date(NOW_MS + 5 * 60_000).toISOString(),
    boardCompletedAt: new Date(Date.parse(BOARD_FIRST_SEEN) + 5 * 60_000).toISOString(),
  };
  shifted[metaIndex] = JSON.stringify({ ...meta, watch: shiftedWatch });
  const shiftedViolations = verifyRunIntegrity(parseRunRecords(shifted), { expectedArms: expected });
  assert.ok(shiftedViolations.some((v) => v.includes('dispatched before the recorded detection instant')));

  // Detection cannot predate the inputs it was evaluated on.
  const predated = [...lines];
  predated[metaIndex] = JSON.stringify({
    ...meta,
    watch: { ...provenance, detectedAt: '2026-07-20T11:00:00.000Z', boardCompletedAt: '2026-07-20T10:30:00.000Z' },
  });
  const predatedViolations = verifyRunIntegrity(parseRunRecords(predated), { expectedArms: expected });
  assert.ok(predatedViolations.some((v) => v.includes('precedes bundle assembly')));

  // Bidirectional identity: watch metadata on a non-watch run is a violation.
  const relabeled = lines.map((l) => l.replaceAll(outcome.runId, `smoke-v0-${slateDate}-abcdef`));
  const relabeledViolations = verifyRunIntegrity(parseRunRecords(relabeled), { expectedArms: expected });
  assert.ok(relabeledViolations.some((v) => v.includes('non-watch run carries watch provenance')));
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
    outDirExplicit: false,
    pollSeconds: 300,
    windowHours: 168,
    lateMinutes: 60,
    maxFiresPerTick: 10,
    timeoutSeconds: null,
    maxOutputTokens: 16000,
  });
  assert.equal(parseWatchArgs(['--dry-run'], () => undefined).once, true);
  assert.equal(parseWatchArgs(['--late-minutes', '15'], () => undefined).lateMinutes, 15);
  assert.equal(parseWatchArgs(['--out', 'elsewhere'], () => undefined).outDirExplicit, true);
  assert.equal(parseWatchArgs(['--max-fires-per-tick', '3'], () => undefined).maxFiresPerTick, 3);
  assert.throws(() => parseWatchArgs(['--poll-seconds', '5'], () => undefined), WatchUsageError);
  assert.throws(() => parseWatchArgs(['--window-hours', '9999'], () => undefined), WatchUsageError);
  assert.throws(() => parseWatchArgs(['--late-minutes', '2000'], () => undefined), WatchUsageError);
  assert.throws(() => parseWatchArgs(['--max-fires-per-tick', '0'], () => undefined), WatchUsageError);
  assert.throws(() => parseWatchArgs(['--bogus'], () => undefined), WatchUsageError);
});

// ---------------------------------------------------------------------------
// Hardening added in review: duplicate rows, spend caps, aged inputs,
// mid-tick first pitch, poisoned timestamps, per-game isolation, deferral
// escalation.
// ---------------------------------------------------------------------------

test('duplicate rows for one game in a single fetch fire exactly once', async () => {
  const fire = fakeFire();
  const board = fullBoardInputs();
  const dupRow = board.gamesRows[0];
  assert.ok(dupRow);
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchInputs: () =>
      Promise.resolve({ ...board, gamesRows: [dupRow, { ...dupRow }] }),
  });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 1);
  assert.equal(fire.calls.length, 1);
  // The completed entry survives — never overwritten by a duplicate claim.
  assert.equal(deps.ledger.get(GAME_ID)?.runId, 'watch-v0-2026-07-20-abc123');
});

test('the per-tick fire cap stops dispatch loudly; uncapped games stay unclaimed', async () => {
  const fire = fakeFire();
  const a = fullBoardFor('00000000-0000-4000-8000-0000000wata1', '2026-07-20T22:10:00+00:00');
  const b = fullBoardFor('00000000-0000-4000-8000-0000000watb2', '2026-07-20T23:10:00+00:00');
  const deps = makeDeps({
    fireGame: fire.fire,
    maxFiresPerTick: 1,
    fetchInputs: () =>
      Promise.resolve(
        fullBoardInputs({ gamesRows: [a.row, b.row], oddsRows: [...a.odds, ...b.odds] }),
      ),
  });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 1);
  assert.equal(summary.capHit, true); // schedulers see the hit cap
  assert.equal(fire.calls.length, 1);
  assert.equal(deps.ledger.size, 1);
  assert.ok(deps.errors.some((line) => line.includes('fire cap reached')));
  // The uncapped game was never claimed — it re-evaluates next tick.
  assert.equal(deps.ledger.has(b.row.gameId), false);
});

test('stale working inputs are re-fetched before evaluating a candidate (fire-at-detection per game)', async () => {
  const fire = fakeFire();
  let fetches = 0;
  const freshCompletedAt = new Date(Date.parse(FETCH_COMPLETED_AT) + 5 * 60_000).toISOString();
  const deps = makeDeps({
    fireGame: fire.fire,
    // 5 minutes past the tick snapshot: older than FRESH_FIRE_MS, younger
    // than the backstop — the tick must refresh, then fire on fresh inputs.
    nowMs: () => Date.parse(FETCH_COMPLETED_AT) + 5 * 60_000 + 10_000,
    fetchInputs: () => {
      fetches += 1;
      return Promise.resolve(
        fetches === 1
          ? fullBoardInputs() // the stale tick snapshot
          : fullBoardInputs({
              fetchCompletedAt: freshCompletedAt,
              oddsRows: [
                { ...oddsRow('moneyline', null), upstream_last_updated: freshCompletedAt },
                { ...oddsRow('spread', 1.5), upstream_last_updated: freshCompletedAt },
                { ...oddsRow('total', 8.5), upstream_last_updated: freshCompletedAt },
              ],
            }),
      );
    },
  });
  const summary = await watchTick(deps);
  assert.equal(fetches, 2); // tick snapshot + per-fire refresh
  assert.equal(summary.fired, 1);
  assert.equal(fire.calls.length, 1);
});

test('a game absent from the refreshed snapshot is skipped, never claimed', async () => {
  const fire = fakeFire();
  let fetches = 0;
  const deps = makeDeps({
    fireGame: fire.fire,
    nowMs: () => Date.parse(FETCH_COMPLETED_AT) + 5 * 60_000,
    fetchInputs: () => {
      fetches += 1;
      return Promise.resolve(
        fetches === 1
          ? fullBoardInputs()
          : fullBoardInputs({ gamesRows: [], oddsRows: [] }), // left the window
      );
    },
  });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 0);
  assert.equal(summary.watched, 1);
  assert.equal(fire.calls.length, 0);
  assert.equal(deps.ledger.size, 0);
});

test('inputs still aged after a refresh stop the tick (backstop)', async () => {
  const fire = fakeFire();
  const deps = makeDeps({
    fireGame: fire.fire,
    // Far beyond the backstop; the refresh returns equally stale stamps.
    nowMs: () => Date.parse(FETCH_COMPLETED_AT) + 11 * 60_000,
    maxInputAgeMs: 10 * 60_000,
  });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 0);
  assert.equal(fire.calls.length, 0);
  assert.equal(deps.ledger.size, 0);
  assert.ok(deps.errors.some((line) => line.includes('still aged after refresh')));
});

test('a game whose first pitch passed mid-tick is never claimed or burned', async () => {
  const fire = fakeFire();
  // First pitch after assembly but before "now": eligible to buildBundle,
  // caught by the pre-claim recheck.
  const g = fullBoardFor(GAME_ID, '2026-07-20T12:00:15+00:00');
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchInputs: () =>
      Promise.resolve(fullBoardInputs({ gamesRows: [g.row], oddsRows: g.odds })),
  });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 0);
  assert.equal(summary.watched, 1);
  assert.equal(fire.calls.length, 0);
  assert.equal(deps.ledger.size, 0);
});

test('an unparseable first-appearance timestamp defers with a log and is never cached', async () => {
  const fire = fakeFire();
  let reads = 0;
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchFirstBoardAppearance: () => {
      reads += 1;
      return Promise.resolve('not-a-timestamp');
    },
  });
  const first = await watchTick(deps);
  assert.equal(first.deferred, 1);
  assert.ok(deps.errors.some((line) => line.includes('unparseable first-appearance')));
  assert.equal(deps.boardFirstSeen.size, 0);
  const readsAfterFirst = reads;
  await watchTick(deps);
  // Not cached: the next tick re-reads instead of silently deferring forever.
  assert.ok(reads > readsAfterFirst);
});

test('one malformed row is isolated — later candidates still fire', async () => {
  const fire = fakeFire();
  const bad = fullBoardFor('00000000-0000-4000-8000-0000000badd1');
  bad.row.matchTime = 'garbage'; // easternCalendarDay throws
  const good = fullBoardFor(GAME_ID);
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchInputs: () =>
      Promise.resolve(
        fullBoardInputs({
          gamesRows: [bad.row, good.row],
          oddsRows: [...bad.odds, ...good.odds],
        }),
      ),
  });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 1);
  assert.equal(summary.failed, 1);
  assert.equal(fire.calls.length, 1);
  assert.ok(deps.errors.some((line) => line.includes('failed this tick')));
});

test('candidates order chronologically across mixed UTC offsets, not lexically', async () => {
  const fire = fakeFire();
  // Lexical order puts the +00:00 string first; chronologically the +04:00
  // game starts earlier (19:10Z vs 20:10Z).
  const earlier = fullBoardFor('00000000-0000-4000-8000-0000000ord01', '2026-07-20T23:10:00+04:00');
  const later = fullBoardFor('00000000-0000-4000-8000-0000000ord02', '2026-07-20T20:10:00+00:00');
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchInputs: () =>
      Promise.resolve(
        fullBoardInputs({
          gamesRows: [later.row, earlier.row],
          oddsRows: [...later.odds, ...earlier.odds],
        }),
      ),
  });
  await watchTick(deps);
  assert.deepEqual(
    fire.calls.map((c) => c.gameId),
    [earlier.row.gameId, later.row.gameId],
  );
});

test('the fire cap bounds ATTEMPTS: failing fires count against it', async () => {
  const fire = fakeFire(undefined, true); // every fire fails (may still have billed)
  const a = fullBoardFor('00000000-0000-4000-8000-0000000cap01', '2026-07-20T22:10:00+00:00');
  const b = fullBoardFor('00000000-0000-4000-8000-0000000cap02', '2026-07-20T23:10:00+00:00');
  const deps = makeDeps({
    fireGame: fire.fire,
    maxFiresPerTick: 1,
    fetchInputs: () =>
      Promise.resolve(
        fullBoardInputs({ gamesRows: [a.row, b.row], oddsRows: [...a.odds, ...b.odds] }),
      ),
  });
  const summary = await watchTick(deps);
  assert.equal(fire.calls.length, 1); // exactly one dispatch attempt
  assert.equal(summary.fired, 0);
  assert.equal(summary.failed, 1);
  assert.equal(deps.ledger.size, 1); // only the attempted game is claimed
  assert.ok(deps.errors.some((line) => line.includes('fire cap reached')));
});

test('fire errors surface in the tick summary as failures', async () => {
  const fire = fakeFire(undefined, true);
  const deps = makeDeps({ fireGame: fire.fire });
  const summary = await watchTick(deps);
  assert.equal(summary.failed, 1);
  assert.equal(summary.fired, 0);
});

test('a future-dated first appearance fails closed: logged, never cached, never fired', async () => {
  const fire = fakeFire();
  const deps = makeDeps({
    fireGame: fire.fire,
    // "First appearance" a day AFTER detection — impossible; a bogus stamp
    // must not defeat the late gate by reading as a fresh opener.
    fetchFirstBoardAppearance: () => Promise.resolve('2026-07-21T12:00:00.000Z'),
  });
  const summary = await watchTick(deps);
  assert.equal(summary.deferred, 1);
  assert.equal(summary.fired, 0);
  assert.equal(fire.calls.length, 0);
  assert.equal(deps.boardFirstSeen.size, 0);
  assert.ok(deps.errors.some((line) => line.includes('future first-appearance')));
});

test('a future stamp within minutes still defers — the runtime accepts only what the scorer will', async () => {
  const fire = fakeFire();
  let now = NOW_MS;
  const futureStamp = new Date(NOW_MS + 60_000).toISOString(); // 60s after detection
  const deps = makeDeps({
    fireGame: fire.fire,
    nowMs: () => now,
    fetchFirstBoardAppearance: () => Promise.resolve(futureStamp),
    fetchInputs: () =>
      Promise.resolve(
        fullBoardInputs({
          fetchStartedAt: new Date(now - 2_000).toISOString(),
          fetchCompletedAt: new Date(now).toISOString(),
          oddsRows: [
            { ...oddsRow('moneyline', null), upstream_last_updated: new Date(now - 60_000).toISOString() },
            { ...oddsRow('spread', 1.5), upstream_last_updated: new Date(now - 60_000).toISOString() },
            { ...oddsRow('total', 8.5), upstream_last_updated: new Date(now - 60_000).toISOString() },
          ],
        }),
      ),
  });
  const first = await watchTick(deps);
  assert.equal(first.deferred, 1);
  assert.equal(fire.calls.length, 0);
  assert.equal(deps.boardFirstSeen.size, 0);
  assert.ok(deps.errors.some((line) => line.includes('future first-appearance')));

  // One tick later the stamp is in the past: fires with a non-negative age.
  now += 5 * 60_000;
  const second = await watchTick(deps);
  assert.equal(second.fired, 1);
  const prov = fire.calls[0]?.provenance;
  assert.ok(prov);
  assert.ok(prov.openerAgeMinutes >= 0);
});

test('slow board-history reads trigger re-preparation — fires never use aged inputs', async () => {
  const fire = fakeFire();
  let now = NOW_MS;
  let fetches = 0;
  const deps = makeDeps({
    fireGame: fire.fire,
    nowMs: () => now,
    fetchInputs: () => {
      fetches += 1;
      return Promise.resolve(
        fullBoardInputs({
          fetchStartedAt: new Date(now - 2_000).toISOString(),
          fetchCompletedAt: new Date(now).toISOString(),
          oddsRows: [
            { ...oddsRow('moneyline', null), upstream_last_updated: new Date(now - 10_000).toISOString() },
            { ...oddsRow('spread', 1.5), upstream_last_updated: new Date(now - 10_000).toISOString() },
            { ...oddsRow('total', 8.5), upstream_last_updated: new Date(now - 10_000).toISOString() },
          ],
        }),
      );
    },
    // Each history read consumes 40 simulated seconds — three reads push the
    // snapshot far past FRESH_FIRE_MS before the claim.
    fetchFirstBoardAppearance: () => {
      now += 40_000;
      return Promise.resolve(new Date(now - 5 * 60_000).toISOString());
    },
  });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 1);
  assert.equal(fetches, 2); // tick snapshot + post-history-read re-preparation
  const call = fire.calls[0];
  assert.ok(call);
  // The fired inputs are the RE-FETCHED snapshot, seconds old at dispatch.
  assert.equal(call.fetchCompletedAt, new Date(now).toISOString());
  // And detection is stamped after that assembly (the chain the scorer checks).
  assert.ok(Date.parse(call.provenance.detectedAt) >= Date.parse(call.fetchCompletedAt));
});

test('a collision-failed fire is a FAILED pass, not a fired one', async () => {
  const fire = fakeFire({ collisionFailed: true });
  const deps = makeDeps({ fireGame: fire.fire });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 0);
  assert.equal(summary.failed, 1);
  assert.equal(deps.ledger.get(GAME_ID)?.collisionFailed, true);
});

test('a thrown board-history read is a failure, not a benign deferral', async () => {
  const fire = fakeFire();
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchFirstBoardAppearance: () => Promise.reject(new Error('read denied')),
  });
  const summary = await watchTick(deps);
  assert.equal(summary.failed, 1);
  assert.equal(summary.deferred, 0);
  assert.equal(fire.calls.length, 0);
});

test('the fired provenance matches the gate evaluation', async () => {
  const fire = fakeFire();
  const deps = makeDeps({ fireGame: fire.fire });
  await watchTick(deps);
  const call = fire.calls[0];
  assert.ok(call);
  assert.equal(call.provenance.boardCompletedAt, BOARD_FIRST_SEEN);
  assert.equal(call.provenance.openerAgeMinutes, 11);
  assert.equal(call.provenance.lateThresholdMinutes, 60);
  assert.equal(call.provenance.detectedAt, new Date(NOW_MS).toISOString());
});

test('prolonged deferral escalates exactly once', async () => {
  const fire = fakeFire();
  let now = NOW_MS;
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchFirstBoardAppearance: () => Promise.resolve(null),
    // Real ticks fetch fresh inputs; the fixture's assembly time and the
    // game's first pitch must track the advancing clock or the aged-inputs
    // and already-started guards (correctly) stop the tick first.
    fetchInputs: () => {
      const g = fullBoardFor(GAME_ID, new Date(now + 11 * 3_600_000).toISOString());
      g.odds = g.odds.map((o) => ({
        ...o,
        upstream_last_updated: new Date(now - 5 * 60_000).toISOString(),
        poll_captured_at: new Date(now - 5 * 60_000).toISOString(),
      }));
      return Promise.resolve(
        fullBoardInputs({
          gamesRows: [g.row],
          oddsRows: g.odds,
          fetchStartedAt: new Date(now - 2_000).toISOString(),
          fetchCompletedAt: new Date(now).toISOString(),
        }),
      );
    },
    nowMs: () => now,
    lateMs: 60 * 60_000,
  });
  await watchTick(deps);
  assert.equal(deps.errors.length, 0);
  now += 2 * 60 * 60_000; // two hours later, still deferring
  await watchTick(deps);
  const warns = deps.errors.filter((line) => line.includes('deferred longer'));
  assert.equal(warns.length, 1);
  await watchTick(deps);
  assert.equal(deps.errors.filter((line) => line.includes('deferred longer')).length, 1);
});
