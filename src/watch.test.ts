import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildBundle } from './bundle.js';
import { enabledMarkets, isMarketEnabled } from './marketPolicy.js';
import { parseRunRecords, verifyRunIntegrity, verifyWatchEntryTiming } from './scoring.js';
import { makeValidResponse, TEST_ARM } from './testFactories.js';
import {
  fireEligibleGame,
  LATE_THRESHOLD_MS,
  loadLedger,
  parseWatchArgs,
  persistLedgerEntry,
  watchTick,
  WatchUsageError,
} from './watch.js';
import type { FireOutcome, SpecLedgerEntry, WatchDeps, WatchGateProvenance } from './watch.js';
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
// Synthetic live-shaped inputs.
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
const OPENED_AT = '2026-07-20T11:50:00.000Z'; // first appearance, ~10 min before now
const NOW_MS = Date.parse('2026-07-20T12:00:30.000Z');

/** MLB enables moneyline + total; the run line is detected but not dispatched. */
const MLB_ENABLED: MarketKey[] = ['moneyline', 'total'];
const ALL_ENABLED: MarketKey[] = ['moneyline', 'spread', 'total'];

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

function inputsWith(oddsRows: CurrentOddsRow[], overrides: Partial<SlateInputs> = {}): SlateInputs {
  return {
    gamesRows: [gamesRow()],
    oddsRows,
    fetchStartedAt: '2026-07-20T11:59:58.000Z',
    fetchCompletedAt: FETCH_COMPLETED_AT,
    ...overrides,
  };
}

/** A full three-market board (moneyline, run line, total). */
function fullBoard(): CurrentOddsRow[] {
  return [oddsRow('moneyline', null), oddsRow('spread', 1.5), oddsRow('total', 8.5)];
}

interface FakeFire {
  calls: Array<{
    gameId: string;
    markets: MarketKey[];
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
        markets: request ? (Object.keys(provenance.markets) as MarketKey[]) : [],
        slateDate,
        provenance,
        fetchCompletedAt: inputs.fetchCompletedAt,
      });
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
  const ledgerDir = tempDir('line-open-ledger-');
  return {
    fetchInputs: () => Promise.resolve(inputsWith(fullBoard())),
    fetchFirstBoardAppearance: () => Promise.resolve(OPENED_AT),
    fireGame: fakeFire().fire,
    ledgerDir,
    ledger: new Map<string, SpecLedgerEntry>(),
    boardFirstSeen: new Map<string, string>(),
    deferredSince: new Map<string, number>(),
    deferralWarned: new Set<string>(),
    enabledMarketsFor: () => MLB_ENABLED,
    nowMs: () => NOW_MS,
    lateMs: LATE_THRESHOLD_MS,
    maxDispatchesPerTick: 20,
    maxInputAgeMs: 10 * 60_000,
    rehearse: false,
    log: (line) => logged.push(line),
    logError: (line) => errors.push(line),
    logged,
    errors,
    ...overrides,
  };
}

function key(gameId: string, market: MarketKey): string {
  return `${gameId}:${market}`;
}

// ---------------------------------------------------------------------------
// The core behaviour change: take what we have, when we have it.
// ---------------------------------------------------------------------------

test('a moneyline-only board FIRES the moneyline alone — it never waits for the rest', async () => {
  const fire = fakeFire();
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchInputs: () => Promise.resolve(inputsWith([oddsRow('moneyline', null)])),
  });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 1);
  assert.equal(summary.dispatches, 1);
  assert.deepEqual(fire.calls[0]?.markets, ['moneyline']);
  // The moneyline is claimed; the total is blocked (not yet opened), the run
  // line is policy-disabled. Neither blocks the moneyline.
  assert.equal(deps.ledger.get(key(GAME_ID, 'moneyline'))?.decision, 'fired');
  assert.equal(deps.ledger.has(key(GAME_ID, 'total')), false);
  assert.equal(summary.disabled, 1); // run line
  assert.equal(summary.blocked, 1); // total not yet opened
});

test('an MLB full board fires moneyline + total in ONE dispatch; the run line is detected, disabled, never dispatched', async () => {
  const fire = fakeFire();
  const deps = makeDeps({ fireGame: fire.fire });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 2); // two speculations
  assert.equal(summary.dispatches, 1); // one billing event
  assert.deepEqual(fire.calls.length, 1);
  assert.deepEqual(fire.calls[0]?.markets.sort(), ['moneyline', 'total']);
  // Each speculation is claimed independently with its own ledger file.
  assert.equal(deps.ledger.get(key(GAME_ID, 'moneyline'))?.decision, 'fired');
  assert.equal(deps.ledger.get(key(GAME_ID, 'total'))?.decision, 'fired');
  // The run line was seen and recorded disabled — never dispatched.
  assert.equal(summary.disabled, 1);
  assert.equal(deps.ledger.has(key(GAME_ID, 'spread')), false);
  // The dispatched bundle carries only the two enabled markets.
  assert.equal(fire.calls[0]?.markets.includes('spread'), false);
});

test('PRIMARY: three markets with three distinct arrival times produce three independent fires at three honest ages', async () => {
  // A league that enables all three markets, injected via the policy seam.
  const fire = fakeFire();
  // Each market opens on a different tick; the odds snapshot reveals them one
  // at a time, and each first appearance is its own honest opener instant.
  let now = NOW_MS;
  const openedAt: Record<string, string> = {
    moneyline: new Date(now - 2 * 60_000).toISOString(),
    spread: '',
    total: '',
  };
  let visible: MarketKey[] = ['moneyline'];
  const deps = makeDeps({
    fireGame: fire.fire,
    enabledMarketsFor: () => ALL_ENABLED,
    nowMs: () => now,
    fetchFirstBoardAppearance: (_g, market) =>
      Promise.resolve(openedAt[market] === '' ? null : (openedAt[market] ?? null)),
    fetchInputs: () =>
      Promise.resolve(
        inputsWith(
          visible.map((m) => ({
            ...oddsRow(m, m === 'moneyline' ? null : m === 'spread' ? 1.5 : 8.5),
            upstream_last_updated: new Date(now - 60_000).toISOString(),
          })),
          {
            fetchStartedAt: new Date(now - 2_000).toISOString(),
            fetchCompletedAt: new Date(now).toISOString(),
          },
        ),
      ),
  });

  // Tick 1: only the moneyline is open → it fires alone.
  const t1 = await watchTick(deps);
  assert.equal(t1.fired, 1);
  assert.deepEqual(fire.calls.at(-1)?.markets, ['moneyline']);

  // Tick 2 (30 min later): the total opens.
  now += 30 * 60_000;
  openedAt.total = new Date(now - 60_000).toISOString();
  visible = ['moneyline', 'total'];
  const t2 = await watchTick(deps);
  assert.equal(t2.fired, 1);
  assert.deepEqual(fire.calls.at(-1)?.markets, ['total']); // moneyline already handled

  // Tick 3 (another 30 min): the run line finally opens.
  now += 30 * 60_000;
  openedAt.spread = new Date(now - 60_000).toISOString();
  visible = ['moneyline', 'spread', 'total'];
  const t3 = await watchTick(deps);
  assert.equal(t3.fired, 1);
  assert.deepEqual(fire.calls.at(-1)?.markets, ['spread']);

  // Three independent dispatches, three ledger entries, each with its OWN age.
  assert.equal(fire.calls.length, 3);
  for (const market of ALL_ENABLED) {
    const entry = deps.ledger.get(key(GAME_ID, market));
    assert.equal(entry?.decision, 'fired', `${market} fired`);
    assert.ok((entry?.openerAgeSeconds ?? -1) >= 0);
    // Each fired within ~1 minute of its own opener — none rode in on another.
    assert.ok((entry?.openerAgeSeconds ?? 1e9) < 5 * 60);
  }
});

test('co-arrival is batched but claimed and recorded independently — one dispatch, two ledger files, two gate provenances', async () => {
  const fire = fakeFire();
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchInputs: () => Promise.resolve(inputsWith([oddsRow('moneyline', null), oddsRow('total', 8.5)])),
  });
  await watchTick(deps);
  assert.equal(fire.calls.length, 1);
  const prov = fire.calls[0]?.provenance;
  assert.ok(prov);
  assert.deepEqual(Object.keys(prov.markets).sort(), ['moneyline', 'total']);
  // Two independent ledger files on disk, one per speculation.
  const reloaded = loadLedger(deps.ledgerDir, () => undefined);
  assert.equal(reloaded.get(key(GAME_ID, 'moneyline'))?.decision, 'fired');
  assert.equal(reloaded.get(key(GAME_ID, 'total'))?.decision, 'fired');
});

test('a stale moneyline never rides in on a fresh total — per-market late gate', async () => {
  const fire = fakeFire();
  const staleFirst = new Date(NOW_MS - 3 * 3_600_000).toISOString(); // 3h old
  const freshFirst = new Date(NOW_MS - 2 * 60_000).toISOString(); // 2m old
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchInputs: () => Promise.resolve(inputsWith([oddsRow('moneyline', null), oddsRow('total', 8.5)])),
    fetchFirstBoardAppearance: (_g, market) =>
      Promise.resolve(market === 'moneyline' ? staleFirst : freshFirst),
  });
  const summary = await watchTick(deps);
  // The total fires; the moneyline is excluded late. Nothing lets the stale
  // moneyline ride in on the total's freshness.
  assert.equal(summary.fired, 1);
  assert.equal(summary.late, 1);
  assert.deepEqual(fire.calls[0]?.markets, ['total']);
  assert.equal(deps.ledger.get(key(GAME_ID, 'total'))?.decision, 'fired');
  assert.equal(deps.ledger.get(key(GAME_ID, 'moneyline'))?.decision, 'late_detection');
});

test('a market excluded late is terminal — never revisited', async () => {
  const fire = fakeFire();
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchInputs: () => Promise.resolve(inputsWith([oddsRow('moneyline', null)])),
    fetchFirstBoardAppearance: () => Promise.resolve(new Date(NOW_MS - 3 * 3_600_000).toISOString()),
  });
  const first = await watchTick(deps);
  assert.equal(first.late, 1);
  assert.equal(first.fired, 0);
  const second = await watchTick(deps);
  assert.equal(second.late, 0);
  assert.equal(second.handled, 1); // now census-only
  assert.equal(fire.calls.length, 0);
});

test('a buildable market whose first-appearance row is not visible yet defers (transient), while a ready sibling fires', async () => {
  const fire = fakeFire();
  let totalVisible = false;
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchInputs: () => Promise.resolve(inputsWith([oddsRow('moneyline', null), oddsRow('total', 8.5)])),
    fetchFirstBoardAppearance: (_g, market) => {
      if (market === 'total' && !totalVisible) return Promise.resolve(null);
      return Promise.resolve(OPENED_AT);
    },
  });
  const first = await watchTick(deps);
  assert.equal(first.deferred, 1); // total
  assert.equal(first.fired, 1); // moneyline fired regardless
  assert.deepEqual(fire.calls[0]?.markets, ['moneyline']);

  totalVisible = true;
  const second = await watchTick(deps);
  assert.equal(second.fired, 1); // total now fires
  assert.deepEqual(fire.calls[1]?.markets, ['total']);
});

test('handled speculations are skipped forever, including across a restart (ledger re-derived from disk)', async () => {
  const fire = fakeFire();
  const deps = makeDeps({ fireGame: fire.fire });
  await watchTick(deps);
  assert.equal(fire.calls.length, 1);
  await watchTick(deps);
  assert.equal(fire.calls.length, 1);

  const reloaded = makeDeps({ fireGame: fire.fire, ledgerDir: deps.ledgerDir });
  reloaded.ledger = loadLedger(deps.ledgerDir, () => undefined);
  assert.equal(reloaded.ledger.get(key(GAME_ID, 'moneyline'))?.decision, 'fired');
  await watchTick(reloaded);
  assert.equal(fire.calls.length, 1);
});

test('a fire crash claims every ready speculation — never double-fired', async () => {
  const fire = fakeFire(undefined, true);
  const deps = makeDeps({ fireGame: fire.fire });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 0);
  assert.equal(summary.failed, 1);
  assert.equal(fire.calls.length, 1);
  for (const market of MLB_ENABLED) {
    const entry = deps.ledger.get(key(GAME_ID, market));
    assert.equal(entry?.decision, 'fired');
    assert.match(entry?.fireError ?? '', /synthetic fire failure/);
  }
  const again = await watchTick(deps);
  assert.equal(again.fired, 0);
  assert.equal(fire.calls.length, 1); // no second (double-billed) dispatch
});

test('an unreadable ledger file is treated as handled (never risk a double-fire)', async () => {
  const deps = makeDeps({});
  const gameDir = join(deps.ledgerDir, GAME_ID);
  writeFileSync(join(tempDir('scratch-'), 'x'), ''); // ensure fs available
  // Write a corrupt per-speculation file.
  const { mkdirSync } = await import('node:fs');
  mkdirSync(gameDir, { recursive: true });
  writeFileSync(join(gameDir, 'moneyline.json'), 'not json at all', 'utf8');
  const errors: string[] = [];
  const ledger = loadLedger(deps.ledgerDir, (line) => errors.push(line));
  assert.equal(ledger.get(key(GAME_ID, 'moneyline'))?.decision, 'fired');
  assert.equal(errors.length, 1);
});

test('ledger writes pass the redaction chokepoint', () => {
  const secret = 'sk-watch-ledger-secret-000000000000';
  const original = process.env['OPENAI_API_KEY'];
  process.env['OPENAI_API_KEY'] = secret;
  try {
    const dir = tempDir('watch-redact-');
    const entry: SpecLedgerEntry = {
      gameId: GAME_ID,
      slug: 'mil-pit-2026-07-20',
      market: 'moneyline',
      decision: 'fired',
      decidedAt: FETCH_COMPLETED_AT,
      slateDate: '2026-07-20',
      scheduledStartUtc: MATCH_TIME,
      firstAppearanceAt: OPENED_AT,
      openerAgeSeconds: 630,
      gameSha256: 'x',
      requestSha256: 'y',
      fireError: `provider said: ${secret}`,
    };
    persistLedgerEntry(dir, entry);
    const written = readFileSync(join(dir, GAME_ID, 'moneyline.json'), 'utf8');
    assert.ok(!written.includes(secret));
    assert.ok(written.includes('[REDACTED]'));
  } finally {
    if (original === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = original;
  }
});

// ---------------------------------------------------------------------------
// Rehearsal mode
// ---------------------------------------------------------------------------

test('rehearsal mode evaluates and reports what WOULD fire, writing no ledger and dispatching nothing', async () => {
  const fire = fakeFire();
  const deps = makeDeps({ fireGame: fire.fire, rehearse: true });
  const summary = await watchTick(deps);
  assert.equal(summary.rehearsal, true);
  assert.equal(summary.fired, 2); // it REPORTS the two it would fire
  assert.equal(fire.calls.length, 0); // but dispatches nothing
  assert.equal(deps.ledger.size, 0); // and writes no ledger
  assert.equal(existsSync(join(deps.ledgerDir, GAME_ID)), false);
  assert.ok(deps.logged.some((l) => l.includes('[rehearsal] would fire')));
});

test('rehearsal reports late exclusions without ledgering them', async () => {
  const deps = makeDeps({
    rehearse: true,
    fetchInputs: () => Promise.resolve(inputsWith([oddsRow('moneyline', null)])),
    fetchFirstBoardAppearance: () => Promise.resolve(new Date(NOW_MS - 3 * 3_600_000).toISOString()),
  });
  const summary = await watchTick(deps);
  assert.equal(summary.late, 1);
  assert.equal(deps.ledger.size, 0);
  assert.ok(deps.logged.some((l) => l.includes('[rehearsal] would exclude')));
});

// ---------------------------------------------------------------------------
// The fire path end to end: a scoped watch run file passes the scorer.
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

test('a scoped watch fire (moneyline + total) produces a run file that passes full scorer integrity verification', async () => {
  const inputs = inputsWith([oddsRow('moneyline', null), oddsRow('total', 8.5)]);
  const slateDate = '2026-07-20';
  // The scoped bundle the watcher would assemble: moneyline + total only.
  const build = buildBundle(inputs, slateDate, { requireFuture: false });
  const request = build.requests[0];
  assert.ok(request);
  // Sanity: the run line is NOT in the scoped bundle.
  assert.equal(request.game.markets.runLine, undefined);

  const cohortId = `watch-v0-${slateDate}`;
  const adapter = stubAdapter(() => JSON.stringify(makeValidResponse(request, TEST_ARM, cohortId)));

  let t = NOW_MS;
  const nowMs = (): number => {
    t += 5;
    return t;
  };
  const detectedAt = new Date(NOW_MS).toISOString();
  const openedAt = new Date(NOW_MS - 10 * 60_000).toISOString();
  const provenance: WatchGateProvenance = {
    detectedAt,
    lateThresholdSeconds: LATE_THRESHOLD_MS / 1000,
    markets: {
      moneyline: { firstAppearanceAt: openedAt, openerAgeSeconds: 600 },
      total: { firstAppearanceAt: openedAt, openerAgeSeconds: 600 },
    },
  };
  const outDir = tempDir('watch-fire-');
  // The published denominator: moneyline + total entered, the run line seen but
  // policy-disabled (not entered).
  const dispositions = [
    { gameId: request.gameId, slug: 'x', league: 'mlb', market: 'moneyline', decision: 'entered' as const, reason: 'entered', firstAppearanceAt: openedAt, openerAgeSeconds: 600, scheduledStartUtc: MATCH_TIME },
    { gameId: request.gameId, slug: 'x', league: 'mlb', market: 'total', decision: 'entered' as const, reason: 'entered', firstAppearanceAt: openedAt, openerAgeSeconds: 600, scheduledStartUtc: MATCH_TIME },
    { gameId: request.gameId, slug: 'x', league: 'mlb', market: 'spread', decision: 'not_entered' as const, reason: 'policy_disabled', firstAppearanceAt: null, openerAgeSeconds: null, scheduledStartUtc: MATCH_TIME },
  ];
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
  }, dispositions);

  assert.equal(outcome.collisionFailed, false);
  assert.match(outcome.runId, /^watch-v0-2026-07-20-[0-9a-f]{6}$/);

  const lines = readFileSync(outcome.runFile, 'utf8').split(/\r?\n/);
  const expectedArms = [
    {
      participantId: TEST_ARM.participantId,
      provider: TEST_ARM.provider,
      requestedModelId: TEST_ARM.requestedModelId,
      approvedReportedModelIds: ['stub-model-1'],
    },
  ];
  const violations = verifyRunIntegrity(parseRunRecords(lines), { expectedArms });
  assert.deepEqual(violations, []);

  // The published denominator is in the corpus: the run line's not-entered
  // disposition sits next to the two entered markets — a dropped market would
  // be a detectable contradiction, not an invisible gap.
  const statusRecords = lines
    .filter((l) => l.includes('"recordType":"speculation_status"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(statusRecords.length, 3);
  assert.equal(statusRecords.filter((r) => r['decision'] === 'entered').length, 2);
  const spread = statusRecords.find((r) => r['market'] === 'spread');
  assert.equal(spread?.['decision'], 'not_entered');
  assert.equal(spread?.['reason'], 'policy_disabled');

  // Tamper: drop the total's decision but keep its "entered" denominator →
  // the coverage cross-check catches the missing entry.
  const droppedTotal = lines.filter(
    (l) => !(l.includes('"recordType":"decision"') && l.includes('"market":"total"')),
  );
  // Also drop the total from the bundle-derived markets by removing its
  // bundle_game price? Simpler: the denominator says total entered, but with no
  // total decision the arm cross-product check and coverage both fire.
  const droppedViolations = verifyRunIntegrity(parseRunRecords(droppedTotal), { expectedArms });
  assert.ok(droppedViolations.length > 0);

  const metaIndex = lines.findIndex((l) => l.includes('"recordType":"run_meta"'));
  assert.ok(metaIndex >= 0);
  const meta = JSON.parse(lines[metaIndex] ?? '') as Record<string, unknown>;

  // Fail-closed: stripping watch provenance makes it unscoreable.
  const { watch: _watch, ...withoutWatch } = meta;
  const stripped = [...lines];
  stripped[metaIndex] = JSON.stringify(withoutWatch);
  assert.ok(
    verifyRunIntegrity(parseRunRecords(stripped), { expectedArms }).some((v) =>
      v.includes('no watch provenance'),
    ),
  );

  // Fail-closed: a single market's opener age above the threshold is refused.
  const lateFired = [...lines];
  lateFired[metaIndex] = JSON.stringify({
    ...meta,
    watch: {
      ...provenance,
      markets: {
        ...provenance.markets,
        total: { firstAppearanceAt: openedAt, openerAgeSeconds: 999_999 },
      },
    },
  });
  assert.ok(
    verifyRunIntegrity(parseRunRecords(lateFired), { expectedArms }).some((v) =>
      v.includes('opener age exceeds the recorded late threshold'),
    ),
  );

  // Fail-closed: a market gated but not entered (or vice versa) is a violation.
  const gateMismatch = [...lines];
  gateMismatch[metaIndex] = JSON.stringify({
    ...meta,
    watch: {
      ...provenance,
      markets: {
        moneyline: { firstAppearanceAt: openedAt, openerAgeSeconds: 600 },
        spread: { firstAppearanceAt: openedAt, openerAgeSeconds: 600 },
      },
    },
  });
  const mismatch = verifyRunIntegrity(parseRunRecords(gateMismatch), { expectedArms });
  assert.ok(mismatch.some((v) => v.includes('gates spread but the bundle did not enter it')));
  assert.ok(mismatch.some((v) => v.includes('entered total but recorded no gate provenance')));
});

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

test('parseWatchArgs defaults and validation — no --late-minutes, no --markets', () => {
  const defaults = parseWatchArgs([], () => undefined);
  assert.deepEqual(defaults, {
    dryRun: false,
    once: false,
    rehearse: false,
    outDir: 'out',
    outDirExplicit: false,
    pollSeconds: 60,
    windowHours: 168,
    maxDispatchesPerTick: 20,
    timeoutSeconds: null,
    maxOutputTokens: 16000,
  });
  assert.equal(parseWatchArgs(['--dry-run'], () => undefined).once, true);
  assert.equal(parseWatchArgs(['--rehearse'], () => undefined).rehearse, true);
  assert.equal(parseWatchArgs(['--rehearse'], () => undefined).once, true);
  assert.equal(parseWatchArgs(['--max-dispatches-per-tick', '3'], () => undefined).maxDispatchesPerTick, 3);
  assert.throws(() => parseWatchArgs(['--poll-seconds', '5'], () => undefined), WatchUsageError);
  assert.throws(() => parseWatchArgs(['--window-hours', '9999'], () => undefined), WatchUsageError);
  // The entry-honesty threshold and market policy are committed, not flags.
  assert.throws(() => parseWatchArgs(['--late-minutes', '15'], () => undefined), WatchUsageError);
  assert.throws(() => parseWatchArgs(['--markets', 'moneyline'], () => undefined), WatchUsageError);
  assert.throws(() => parseWatchArgs(['--max-dispatches-per-tick', '0'], () => undefined), WatchUsageError);
  assert.throws(() => parseWatchArgs(['--bogus'], () => undefined), WatchUsageError);
});

// ---------------------------------------------------------------------------
// Policy isolation (the market allow-list itself)
// ---------------------------------------------------------------------------

test('market policy is a per-(league, market) allow-list; unlisted defaults to disabled', () => {
  // The real committed policy: MLB acts on moneyline + total, not the run line.
  assert.deepEqual(enabledMarkets('mlb'), ['moneyline', 'total']);
  assert.equal(isMarketEnabled('mlb', 'moneyline'), true);
  assert.equal(isMarketEnabled('mlb', 'total'), true);
  assert.equal(isMarketEnabled('mlb', 'spread'), false);
  // A league absent from the policy fires nothing until explicitly listed —
  // introducing a league can never silently start dispatching markets.
  assert.deepEqual(enabledMarkets('nfl'), []);
  assert.equal(isMarketEnabled('nfl', 'spread'), false);
  assert.equal(isMarketEnabled('ncaaf', 'moneyline'), false);
});

test('policy isolation: disabling the MLB run line says nothing about another league (via the watcher seam)', async () => {
  // Two games, two leagues, one custom policy: MLB run line OFF, "xfl" spread ON.
  const fire = fakeFire();
  const mlbGame = gamesRow({ gameId: '00000000-0000-4000-8000-0000000mlb01', sport: 'mlb' });
  const xflGame = gamesRow({
    gameId: '00000000-0000-4000-8000-0000000xfl01',
    sport: 'xfl',
    matchTime: '2026-07-20T23:40:00+00:00',
  });
  const policy: Record<string, MarketKey[]> = { mlb: ['moneyline', 'total'], xfl: ['spread'] };
  const deps = makeDeps({
    fireGame: fire.fire,
    enabledMarketsFor: (league) => policy[league] ?? [],
    fetchInputs: () =>
      Promise.resolve({
        gamesRows: [mlbGame, xflGame],
        oddsRows: [
          oddsRow('moneyline', null, mlbGame.gameId),
          oddsRow('spread', 1.5, mlbGame.gameId),
          oddsRow('total', 8.5, mlbGame.gameId),
          oddsRow('spread', 3.5, xflGame.gameId),
        ],
        fetchStartedAt: '2026-07-20T11:59:58.000Z',
        fetchCompletedAt: FETCH_COMPLETED_AT,
      }),
  });
  await watchTick(deps);
  // MLB dispatched moneyline + total; its run line stayed disabled.
  assert.equal(deps.ledger.get(key(mlbGame.gameId, 'moneyline'))?.decision, 'fired');
  assert.equal(deps.ledger.get(key(mlbGame.gameId, 'total'))?.decision, 'fired');
  assert.equal(deps.ledger.has(key(mlbGame.gameId, 'spread')), false);
  // The xfl spread DID dispatch — the same market, enabled for a different league.
  assert.equal(deps.ledger.get(key(xflGame.gameId, 'spread'))?.decision, 'fired');
});

// ---------------------------------------------------------------------------
// Hardening carried forward: dupes, caps, aged inputs, isolation, ordering.
// ---------------------------------------------------------------------------

test('duplicate rows for one game in a single fetch fire each speculation exactly once', async () => {
  const fire = fakeFire();
  const board = inputsWith(fullBoard());
  const dupRow = board.gamesRows[0];
  assert.ok(dupRow);
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchInputs: () => Promise.resolve({ ...board, gamesRows: [dupRow, { ...dupRow }] }),
  });
  const summary = await watchTick(deps);
  assert.equal(summary.dispatches, 1);
  assert.equal(fire.calls.length, 1);
});

test('the per-tick dispatch cap stops loudly; uncapped games stay unclaimed', async () => {
  const fire = fakeFire();
  const a = gamesRow({ gameId: '00000000-0000-4000-8000-0000000cap01', matchTime: '2026-07-20T22:10:00+00:00' });
  const b = gamesRow({ gameId: '00000000-0000-4000-8000-0000000cap02', matchTime: '2026-07-20T23:10:00+00:00' });
  const deps = makeDeps({
    fireGame: fire.fire,
    maxDispatchesPerTick: 1,
    fetchInputs: () =>
      Promise.resolve({
        gamesRows: [a, b],
        oddsRows: [
          oddsRow('moneyline', null, a.gameId),
          oddsRow('total', 8.5, a.gameId),
          oddsRow('moneyline', null, b.gameId),
          oddsRow('total', 8.5, b.gameId),
        ],
        fetchStartedAt: '2026-07-20T11:59:58.000Z',
        fetchCompletedAt: FETCH_COMPLETED_AT,
      }),
  });
  const summary = await watchTick(deps);
  assert.equal(summary.dispatches, 1);
  assert.equal(summary.capHit, true);
  assert.equal(fire.calls.length, 1);
  assert.ok(deps.errors.some((line) => line.includes('dispatch cap reached')));
  // The uncapped game was never claimed.
  assert.equal(deps.ledger.has(key(b.gameId, 'moneyline')), false);
});

test('inputs still aged after a refresh stop the tick (backstop)', async () => {
  const fire = fakeFire();
  const deps = makeDeps({
    fireGame: fire.fire,
    nowMs: () => Date.parse(FETCH_COMPLETED_AT) + 11 * 60_000,
    maxInputAgeMs: 10 * 60_000,
  });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 0);
  assert.equal(fire.calls.length, 0);
  assert.ok(deps.errors.some((line) => line.includes('still aged after refresh')));
});

test('a game whose first pitch passed is blocked, never claimed', async () => {
  const fire = fakeFire();
  const g = gamesRow({ matchTime: '2026-07-20T12:00:15+00:00' }); // ~ now
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchInputs: () =>
      Promise.resolve(inputsWith([oddsRow('moneyline', null, g.gameId), oddsRow('total', 8.5, g.gameId)], { gamesRows: [g] })),
  });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 0);
  assert.equal(summary.blocked, 2); // both enabled markets blocked: first_pitch_passed
  assert.equal(fire.calls.length, 0);
  assert.equal(deps.ledger.size, 0);
});

test('one malformed row is isolated — later candidates still fire', async () => {
  const fire = fakeFire();
  const bad = gamesRow({ gameId: '00000000-0000-4000-8000-0000000badd1', matchTime: 'garbage' });
  const good = gamesRow();
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchInputs: () =>
      Promise.resolve({
        gamesRows: [bad, good],
        oddsRows: [
          oddsRow('moneyline', null, bad.gameId),
          oddsRow('total', 8.5, bad.gameId),
          oddsRow('moneyline', null, good.gameId),
          oddsRow('total', 8.5, good.gameId),
        ],
        fetchStartedAt: '2026-07-20T11:59:58.000Z',
        fetchCompletedAt: FETCH_COMPLETED_AT,
      }),
  });
  const summary = await watchTick(deps);
  assert.equal(summary.dispatches, 1);
  assert.equal(summary.failed, 1);
  assert.ok(deps.errors.some((line) => line.includes('failed this tick')));
});

test('candidates order chronologically across mixed UTC offsets, not lexically', async () => {
  const fire = fakeFire();
  const earlier = gamesRow({ gameId: '00000000-0000-4000-8000-0000000ord01', matchTime: '2026-07-20T23:10:00+04:00' });
  const later = gamesRow({ gameId: '00000000-0000-4000-8000-0000000ord02', matchTime: '2026-07-20T20:10:00+00:00' });
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchInputs: () =>
      Promise.resolve({
        gamesRows: [later, earlier],
        oddsRows: [
          oddsRow('moneyline', null, later.gameId),
          oddsRow('moneyline', null, earlier.gameId),
        ],
        fetchStartedAt: '2026-07-20T11:59:58.000Z',
        fetchCompletedAt: FETCH_COMPLETED_AT,
      }),
  });
  await watchTick(deps);
  assert.deepEqual(
    fire.calls.map((c) => c.gameId),
    [earlier.gameId, later.gameId],
  );
});

test('a collision-failed fire is a FAILED pass, not a fired one', async () => {
  const fire = fakeFire({ collisionFailed: true });
  const deps = makeDeps({ fireGame: fire.fire });
  const summary = await watchTick(deps);
  assert.equal(summary.fired, 0);
  assert.equal(summary.failed, 1);
  assert.equal(deps.ledger.get(key(GAME_ID, 'moneyline'))?.collisionFailed, true);
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

test('a future-dated first appearance fails closed: logged, never cached, never fired', async () => {
  const fire = fakeFire();
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchInputs: () => Promise.resolve(inputsWith([oddsRow('moneyline', null)])),
    fetchFirstBoardAppearance: () => Promise.resolve('2026-07-21T12:00:00.000Z'),
  });
  const summary = await watchTick(deps);
  assert.equal(summary.deferred, 1);
  assert.equal(summary.fired, 0);
  assert.equal(deps.boardFirstSeen.size, 0);
  assert.ok(deps.errors.some((line) => line.includes('future first-appearance')));
});

test('the fired provenance carries each market\'s own first appearance and age', async () => {
  const fire = fakeFire();
  const deps = makeDeps({ fireGame: fire.fire });
  await watchTick(deps);
  const prov = fire.calls[0]?.provenance;
  assert.ok(prov);
  assert.equal(prov.lateThresholdSeconds, LATE_THRESHOLD_MS / 1000);
  assert.equal(prov.detectedAt, new Date(NOW_MS).toISOString());
  assert.equal(prov.markets.moneyline?.firstAppearanceAt, OPENED_AT);
  assert.ok((prov.markets.moneyline?.openerAgeSeconds ?? -1) >= 600);
  assert.ok((prov.markets.total?.openerAgeSeconds ?? -1) >= 600);
});

// ---------------------------------------------------------------------------
// PR B: the published denominator + independent first-appearance verification
// ---------------------------------------------------------------------------

/** Fire a real scoped moneyline+total watch run and return its parsed records. */
async function fireScopedRun(dispositions: Parameters<typeof fireEligibleGame>[5]): Promise<{
  lines: string[];
  openedAt: string;
  gameId: string;
}> {
  const inputs = inputsWith([oddsRow('moneyline', null), oddsRow('total', 8.5)]);
  const slateDate = '2026-07-20';
  const build = buildBundle(inputs, slateDate, { requireFuture: false });
  const request = build.requests[0];
  assert.ok(request);
  const cohortId = `watch-v0-${slateDate}`;
  const adapter = stubAdapter(() => JSON.stringify(makeValidResponse(request, TEST_ARM, cohortId)));
  let t = NOW_MS;
  const nowMs = (): number => (t += 5);
  const openedAt = new Date(NOW_MS - 10 * 60_000).toISOString();
  const provenance: WatchGateProvenance = {
    detectedAt: new Date(NOW_MS).toISOString(),
    lateThresholdSeconds: LATE_THRESHOLD_MS / 1000,
    markets: {
      moneyline: { firstAppearanceAt: openedAt, openerAgeSeconds: 600 },
      total: { firstAppearanceAt: openedAt, openerAgeSeconds: 600 },
    },
  };
  const outDir = tempDir('watch-prb-');
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
  }, dispositions);
  const lines = readFileSync(outcome.runFile, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  return { lines, openedAt, gameId: request.gameId };
}

const EXPECTED_ARMS = [
  { participantId: TEST_ARM.participantId, provider: TEST_ARM.provider, requestedModelId: TEST_ARM.requestedModelId, approvedReportedModelIds: ['stub-model-1'] },
];

test('PR B: denominator contradiction (fired market marked not_entered) fails integrity', async () => {
  // Build the run first to learn the gameId, then assert on a doctored copy.
  const { lines, gameId } = await fireScopedRun([]);
  // Inject a denominator that marks the entered total as not_entered.
  const doctored = [
    ...lines,
    JSON.stringify({
      recordType: 'speculation_status', label: 'SMOKE_V0_NOT_A_COHORT', runId: JSON.parse(lines[0] ?? '{}').runId,
      gameId, slug: 'x', league: 'mlb', market: 'moneyline', decision: 'entered', reason: 'entered',
      firstAppearanceAt: '2026-07-20T11:50:00.000Z', openerAgeSeconds: 600, scheduledStartUtc: MATCH_TIME,
    }),
    JSON.stringify({
      recordType: 'speculation_status', label: 'SMOKE_V0_NOT_A_COHORT', runId: JSON.parse(lines[0] ?? '{}').runId,
      gameId, slug: 'x', league: 'mlb', market: 'total', decision: 'not_entered', reason: 'market_never_opened',
      firstAppearanceAt: null, openerAgeSeconds: null, scheduledStartUtc: MATCH_TIME,
    }),
  ];
  const violations = verifyRunIntegrity(parseRunRecords(doctored), { expectedArms: EXPECTED_ARMS });
  assert.ok(violations.some((v) => v.includes('not_entered but the bundle DID enter it')));
});

test('PR B: a watch run with NO denominator is unscoreable (coverage unverifiable)', async () => {
  const { lines } = await fireScopedRun([]); // no speculation_status records
  const violations = verifyRunIntegrity(parseRunRecords(lines), { expectedArms: EXPECTED_ARMS });
  assert.ok(violations.some((v) => v.includes('no speculation_status denominator')));
});

test('PR B: verifyWatchEntryTiming reconciles the opener against odds_history — agree, disagree, and UNKNOWN', async () => {
  const openedAt = new Date(NOW_MS - 10 * 60_000).toISOString();
  const { lines, gameId } = await fireScopedRun([
    { gameId: 'ignored', slug: 'x', league: 'mlb', market: 'moneyline', decision: 'entered' as const, reason: 'entered', firstAppearanceAt: openedAt, openerAgeSeconds: 600, scheduledStartUtc: MATCH_TIME },
    { gameId: 'ignored', slug: 'x', league: 'mlb', market: 'total', decision: 'entered' as const, reason: 'entered', firstAppearanceAt: openedAt, openerAgeSeconds: 600, scheduledStartUtc: MATCH_TIME },
  ]);
  const run = parseRunRecords(lines);
  void gameId;

  // Oracle AGREES with the recorded first appearance → no violations.
  const agree = await verifyWatchEntryTiming(run, () => Promise.resolve(openedAt));
  assert.deepEqual(agree.violations, []);
  assert.deepEqual(agree.unknown, []);

  // Oracle DISAGREES (the market actually opened hours earlier) → the claimed
  // opener age is refuted by the independent log.
  const earlier = new Date(NOW_MS - 5 * 3_600_000).toISOString();
  const disagree = await verifyWatchEntryTiming(run, () => Promise.resolve(earlier));
  assert.ok(disagree.violations.some((v) => v.includes('does not reconcile with odds_history')));

  // Oracle cannot resolve → typed UNKNOWN, never a silent pass or a hard fail.
  const unknown = await verifyWatchEntryTiming(run, () => Promise.resolve(null));
  assert.deepEqual(unknown.violations, []);
  assert.equal(unknown.unknown.length, 2);

  // A non-watch run yields nothing to verify.
  const nonWatch = { ...run, watch: null };
  const none = await verifyWatchEntryTiming(nonWatch, () => Promise.resolve(openedAt));
  assert.deepEqual(none.violations, []);
});

test('prolonged deferral escalates exactly once, per speculation', async () => {
  const fire = fakeFire();
  let now = NOW_MS;
  const deps = makeDeps({
    fireGame: fire.fire,
    fetchFirstBoardAppearance: () => Promise.resolve(null),
    fetchInputs: () => {
      const g = gamesRow({ matchTime: new Date(now + 11 * 3_600_000).toISOString() });
      return Promise.resolve({
        gamesRows: [g],
        oddsRows: [
          { ...oddsRow('moneyline', null), upstream_last_updated: new Date(now - 5 * 60_000).toISOString() },
          { ...oddsRow('total', 8.5), upstream_last_updated: new Date(now - 5 * 60_000).toISOString() },
        ],
        fetchStartedAt: new Date(now - 2_000).toISOString(),
        fetchCompletedAt: new Date(now).toISOString(),
      });
    },
    nowMs: () => now,
  });
  await watchTick(deps);
  assert.equal(deps.errors.filter((l) => l.includes('deferred longer')).length, 0);
  now += 2 * 60 * 60_000; // two hours later, still deferring
  await watchTick(deps);
  // Once per speculation (moneyline + total) — each is its own entity.
  assert.equal(deps.errors.filter((l) => l.includes('deferred longer')).length, 2);
  await watchTick(deps);
  assert.equal(deps.errors.filter((l) => l.includes('deferred longer')).length, 2);
});
