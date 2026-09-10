import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import { createMarketOpenCohort, MARKET_OPEN_POLICY, prepareMarketOpenRun } from './marketOpen.js';
import { runMarketOpenFixture } from './marketOpenFixture.js';
import { assertMarketOpenRecordContext, authorizeMarketOpenProducerRecords } from './marketOpenRecordBoundary.js';
import { MarketOpenStore } from './marketOpenStore.js';
import { buildRecords } from './records.js';
import { createMockAdapters } from './mock.js';
import { runSlate } from './runner.js';
import type { RunContext } from './records.js';

const OBSERVED = '2026-09-10T14:05:00.000Z';
const OPENED = '2026-09-10T12:00:00+00:00';
const GAME = '00000000-0000-4000-8000-0000000000aa';
const collision = { failures: [], warnings: [] };
function prepared(market: 'moneyline' | 'total' = 'moneyline') {
  const result = prepareMarketOpenRun({
    cohort: createMarketOpenCohort({ name: 'boundary-fixture', slateDate: '2026-09-10' }),
    game: {
      gameId: GAME, slug: 'mil-pit', sport: 'mlb', matchTime: '2026-09-10T20:00:00Z',
      status: 'upcoming', homeTeam: { name: 'Pirates', abbreviation: 'PIT' },
      awayTeam: { name: 'Brewers', abbreviation: 'MIL' }, hasOdds: true,
      contestCreated: false, contestId: null, canCreateContest: true,
      externalIds: { jsonodds: GAME, sportspage: null, rundown: null },
    },
    market, observedAt: OBSERVED,
    historyRows: [{
      id: 11, jsonodds_id: GAME, market, source: 'jsonodds', line: market === 'moneyline' ? null : 8.5,
      away_odds_american: -110, home_odds_american: -110,
      away_odds_decimal: 1 + 100 / 110, home_odds_decimal: 1 + 100 / 110,
      captured_at: OPENED,
    }],
  });
  if (result.state !== 'prepared') throw new Error(result.reason);
  return result.run;
}

for (const market of ['moneyline', 'total'] as const) {
  test(`D1 ${market} history reference resolves to the same immutable run source`, async () => {
    const run = prepared(market);
    const fixture = await runMarketOpenFixture(run);
    const meta = fixture.records.find((r) => r['recordType'] === 'run_meta')!;
    const bundle = fixture.records.find((r) => r['recordType'] === 'bundle_game')!;
    const p = run.provenance;
    assert.equal(meta['marketOpen'], p);
    assert.deepEqual(bundle['sourceOddsRows'], []);
    assert.deepEqual(bundle['sourceOddsReference'], {
      kind: 'market-open-history-v1', relation: 'odds_history', recordType: 'run_meta', path: 'marketOpen.source',
      runId: meta['runId'], cohortId: meta['cohortId'], eventId: p.event.eventId,
      gameId: bundle['gameId'], market,
      requestSha256: bundle['requestSha256'], gameSha256: bundle['gameSha256'],
      sourceSha256: sha256Hex(canonicalize(p.source.row)), openerId: p.source.row.id,
      openedAt: OPENED,
    });
    assert.equal(p.source.row.market, market);
    assert.equal(p.source.row.jsonodds_id, bundle['gameId']);
  });
}

test('D2 permanent identity still refuses each context mutation separately', async () => {
  const run = prepared();
  const { envelope, context } = await runMarketOpenFixture(run);
  const mutations: Partial<RunContext>[] = [
    { marketOpen: undefined }, { marketOpen: { ...run.provenance } },
    { marketOpen: prepared('total').provenance }, { runId: 'foreign' },
    { watch: { detectedAt: OBSERVED, boardCompletedAt: OBSERVED, openerAgeMinutes: 0, lateThresholdMinutes: 1 } },
    { fetchStartedAt: '2026-09-10T14:05:00Z' }, { fetchCompletedAt: '2026-09-10T14:05:00Z' },
    { fetchStartedAt: OPENED }, { fetchCompletedAt: OPENED },
    { clockMode: 'wall' }, { mode: 'live' },
    { cohortId: 'legacy' }, { slateDate: '2026-09-11' }, { timeoutMs: context.timeoutMs + 1 },
    { maxOutputTokens: context.maxOutputTokens + 1 },
  ];
  for (const mutation of mutations) {
    assert.throws(() => buildRecords(envelope, { ...context, ...mutation }, run.build, collision), Error, JSON.stringify(mutation));
  }
  assert.throws(() => buildRecords(envelope, context, { ...run.build }, collision), /market-open/);
  assert.throws(() => buildRecords({ ...envelope }, context, run.build, collision), /envelope/);
});

test('D2 authenticated alternative arm models and IDs cannot replace the pinned roster', async () => {
  const run = prepared();
  const fixture = await runMarketOpenFixture(run);
  for (const changedIds of [false, true]) {
    const arms = MARKET_OPEN_POLICY.roster.map((arm, i) => i !== 0 ? arm : changedIds
      ? { ...arm, participantId: 'foreign-arm' }
      : { ...arm, requestedModelId: 'foreign-model' });
    const mocks = createMockAdapters({ simulateCollision: false });
    const adapters = new Map(arms.map((arm, i) => {
      const original = mocks.get(MARKET_OPEN_POLICY.roster[i]!.participantId)!;
      return [arm.participantId, { ...original, requestedModelId: arm.requestedModelId }];
    }));
    let clock = Date.parse(OBSERVED);
    const envelope = await runSlate(arms, adapters, run.build.requests, {
      ...fixture.context, baselinePolicyVersion: MARKET_OPEN_POLICY.baselinePolicyVersion, nowMs: () => clock++,
    });
    assert.throws(() => buildRecords(envelope, fixture.context, run.build, collision), /market-open record context does not match its prepared event/);
  }
});

test('D3 namespace cannot be squatted or concealed by dropping provenance', async () => {
  const run = prepared();
  const fixture = await runMarketOpenFixture(run);
  for (const cohortId of ['market-open-v1-squatted', 'market-open-future-squatted', 'legacy']) {
    let clock = Date.parse(OBSERVED);
    const envelope = await runSlate(MARKET_OPEN_POLICY.roster, createMockAdapters({ simulateCollision: false }), run.build.requests, {
      ...fixture.context, cohortId, baselinePolicyVersion: MARKET_OPEN_POLICY.baselinePolicyVersion, nowMs: () => clock++,
    });
    const context = { ...fixture.context, cohortId, marketOpen: undefined };
    assert.throws(() => buildRecords(envelope, context, run.build, collision), /market-open/);
  }
});

test('D3 legacy records retain exactly the pre-boundary game shape', async () => {
  const run = prepared();
  const fixture = await runMarketOpenFixture(run);
  const context = { ...fixture.context, cohortId: 'legacy-fixture', runId: 'legacy-run', marketOpen: undefined };
  let clock = Date.parse(OBSERVED);
  const envelope = await runSlate(MARKET_OPEN_POLICY.roster, createMockAdapters({ simulateCollision: false }), run.build.requests, {
    ...context, baselinePolicyVersion: MARKET_OPEN_POLICY.baselinePolicyVersion, nowMs: () => clock++,
  });
  assert.doesNotThrow(() => assertMarketOpenRecordContext(envelope, context, run.build));
  const records = buildRecords(envelope, context, run.build, collision);
  const bundle = records.find((r) => r['recordType'] === 'bundle_game')!;
  const request = envelope.snapshot.prepared[0]!;
  assert.equal(JSON.stringify(bundle), JSON.stringify({
    recordType: 'bundle_game', label: 'SMOKE_V0_NOT_A_COHORT', runId: context.runId,
    gameId: request.gameId, gameSha256: request.gameSha256, requestSha256: request.requestSha256,
    cutoffAt: request.cutoffAt, slug: request.slug, bundle: request.game, sourceOddsRows: [],
  }));
  assert.ok(!('marketOpen' in records[0]!));
  assert.ok(!('sourceOddsReference' in bundle));
});

test('durable receipt binds a producer envelope and exact context', { skip: process.platform === 'win32' ? 'POSIX durability required' : false }, async () => {
  const run = prepared();
  const root = mkdtempSync(join(tmpdir(), 'market-open-boundary-'));
  const store = new MarketOpenStore({ admissionPolicySha256: 'a'.repeat(64), root, name: run.cohort.name, slateDate: run.cohort.slateDate,
    cohortId: run.cohort.cohortId, policySha256: run.cohort.policySha256,
    capUsdMicros: run.provenance.reservationUsdMicros });
  try {
    const eventId = run.provenance.event.eventId;
    const slot = (armId: string, role: 'initial' | 'repair') => ({ armId, role, ordinal: role === 'initial' ? 0 : 1 });
    store.claim({ eventId, runId: run.provenance.runId, sourceSha256: run.provenance.source.sha256,
      requestSha256: run.provenance.requestSha256, gameSha256: run.provenance.gameSha256, policySha256: run.cohort.policySha256,
      reservationUsdMicros: run.provenance.reservationUsdMicros,
      slots: MARKET_OPEN_POLICY.roster.flatMap((arm) => [slot(arm.participantId, 'initial'), slot(arm.participantId, 'repair')]),
      preparation: { name: run.cohort.name, slateDate: run.cohort.slateDate,
        game: { gameId: GAME, slug: 'mil-pit', sport: 'mlb', matchTime: '2026-09-10T20:00:00Z',
          status: 'upcoming', homeTeam: { name: 'Pirates', abbreviation: 'PIT' },
          awayTeam: { name: 'Brewers', abbreviation: 'MIL' }, hasOdds: true, contestCreated: false,
          contestId: null, canCreateContest: true,
          externalIds: { jsonodds: GAME, sportspage: null, rundown: null } },
        market: 'moneyline', historyRows: [run.provenance.source.row], observedAt: OBSERVED },
    });
    let clock = Date.parse(OBSERVED);
    const options = { cohortId: run.cohort.cohortId, executionPolicy: MARKET_OPEN_POLICY.executionPolicy,
      baselinePolicyVersion: MARKET_OPEN_POLICY.baselinePolicyVersion, timeoutMs: 1_000,
      maxOutputTokens: 6_000, nowMs: () => clock++ };
    const unbound = await runSlate(MARKET_OPEN_POLICY.roster, createMockAdapters({ simulateCollision: false }), run.build.requests, options);
    assert.throws(() => store.recordReceipt(eventId, run, unbound), /durable send evidence/);
    const envelope = await runSlate(MARKET_OPEN_POLICY.roster, createMockAdapters({ simulateCollision: false }), run.build.requests, {
      ...options,
      attemptBoundary: {
        begin(arm, role, startedAt) { store.beginAttempt({ eventId, slot: slot(arm.participantId, role), startedAt }); return null; },
        confirm() { return null; },
        settled(arm, role, attempt) {
          store.finishAttempt({ eventId, slot: slot(arm.participantId, role),
            finishedAt: attempt.responseAt ?? OBSERVED, costUsdMicros: 1, evidence: { attempt } });
        },
      },
    });
    const context: RunContext = { ...options, runId: run.provenance.runId, slateDate: run.cohort.slateDate,
      mode: 'live', clockMode: 'wall', createdAt: new Date(clock++).toISOString(),
      fetchStartedAt: OBSERVED, fetchCompletedAt: OBSERVED, marketOpen: run.provenance };
    const mismatched = { ...envelope, results: envelope.results.map((r, i) => i !== 0 ? r :
      { ...r, attempt: { ...r.attempt, providerResponseId: 'present-but-forged' } }) };
    assert.throws(() => store.recordReceipt(eventId, run, mismatched), /attempt does not match durable send evidence/);
    const omitted = { ...envelope, results: envelope.results.slice(1) };
    assert.throws(() => store.recordReceipt(eventId, run, omitted), /omitted durable attempts/);
    const receipt = store.recordReceipt(eventId, run, envelope);
    assert.throws(() => buildRecords(envelope, context, run.build, collision), /permission/);
    assert.throws(() => authorizeMarketOpenProducerRecords(run, envelope, context, { ...receipt }), /receipt|claim/);
    authorizeMarketOpenProducerRecords(run, envelope, context, receipt);
    assert.equal(buildRecords(envelope, context, run.build, collision)[0]!['mode'], 'live');
    for (const mutation of [{ createdAt: OBSERVED }, { mode: 'dry-run' as const },
      { clockMode: 'synthetic-fixture' as const }, { fetchStartedAt: OPENED }, { marketOpen: { ...run.provenance } }]) {
      assert.throws(() => buildRecords(envelope, { ...context, ...mutation }, run.build, collision));
    }
    assert.throws(() => authorizeMarketOpenProducerRecords(run, envelope, { ...context, createdAt: OBSERVED }, receipt), /different/);
    const crossed = prepared('total');
    assert.throws(() => authorizeMarketOpenProducerRecords(crossed, envelope, context, receipt), /receipt|claim|identity/);
    assert.throws(() => buildRecords({ ...envelope }, context, run.build, collision), /envelope/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('D2 producer mode needs store-owned permission, never a copied preparation', async () => {
  const run = prepared();
  const fixture = await runMarketOpenFixture(run);
  const context: RunContext = { ...fixture.context, mode: 'live', clockMode: 'wall' };
  assert.throws(() => assertMarketOpenRecordContext(fixture.envelope, context, run.build), /market-open/);
  assert.throws(() => authorizeMarketOpenProducerRecords(run, fixture.envelope, context, {} as never), /receipt|claim/);
  assert.throws(() => buildRecords(fixture.envelope, context, run.build, collision), /market-open/);
});
