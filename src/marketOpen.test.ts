import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGameBundle } from './bundle.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { buildGameRequest } from './scopedRequest.js';
import { prepareGameRequest } from './preparedRequest.js';
import { MARKET_POLICY_DIGEST } from './marketPolicy.js';
import { createMockAdapters } from './mock.js';
import { buildRecords } from './records.js';
import { authenticateRun, runSlate } from './runner.js';
import {
  createMarketOpenCohort,
  MARKET_OPEN_POLICY,
  prepareMarketOpenRun,
} from './marketOpen.js';
import { runMarketOpenFixture } from './marketOpenFixture.js';
import type { CurrentOddsRow, GamesEndpointRow, MarketKey } from './types.js';

const OBSERVED = '2026-09-10T14:05:00.000Z';
const OPENED = '2026-09-10T14:02:00+00:00';
const GAME = '00000000-0000-4000-8000-0000000000aa';
const cohort = () => createMarketOpenCohort({ name: 'b1-fixture', slateDate: '2026-09-10' });
const game = (id = GAME): GamesEndpointRow => ({
  gameId: id, slug: 'mil-pit', sport: 'mlb', matchTime: '2026-09-10T20:00:00Z',
  status: 'upcoming', homeTeam: { name: 'Pirates', abbreviation: 'PIT' },
  awayTeam: { name: 'Brewers', abbreviation: 'MIL' }, hasOdds: true,
  contestCreated: false, contestId: null, canCreateContest: true,
  externalIds: { jsonodds: id, sportspage: null, rundown: null },
});
const quote = (market: MarketKey = 'moneyline', id = GAME): CurrentOddsRow => ({
  network: 'polygon', jsonodds_id: id, market, line: market === 'moneyline' ? null : 8.5,
  away_odds_american: -110, home_odds_american: -110,
  upstream_last_updated: '2026-09-10T14:04:00Z',
  poll_captured_at: '2026-09-10T14:04:10Z', changed_at: '2026-09-10T14:04:00Z',
});
const opener = (market: MarketKey = 'moneyline', id = GAME) => ({
  id: 11, jsonodds_id: id, market, source: 'jsonodds',
  line: market === 'moneyline' ? null : 8.5,
  away_odds_american: -110, home_odds_american: -110,
  away_odds_decimal: 1 + 100 / 110, home_odds_decimal: 1 + 100 / 110,
  captured_at: OPENED,
});
const input = (market: MarketKey = 'moneyline') => ({
  cohort: cohort(), game: game(), market,
  historyRows: [opener(market)], observedAt: OBSERVED,
});
function prepared(market: MarketKey = 'moneyline') {
  const result = prepareMarketOpenRun(input(market));
  if (result.state !== 'prepared') throw new Error(result.reason);
  return result.run;
}

test('market-open policy has a distinct frozen namespace and shared scoped policies', () => {
  assert.equal(MARKET_OPEN_POLICY.namespace, 'market-open-v1');
  assert.equal(MARKET_OPEN_POLICY.marketPolicyDigest, MARKET_POLICY_DIGEST);
  assert.equal(MARKET_OPEN_POLICY.baselinePolicyVersion, 'baselines-v0.3.0');
  assert.equal(MARKET_OPEN_POLICY.forecastScope, 'event-market-only');
  assert.equal(MARKET_OPEN_POLICY.paidDispatch, 'blocked-until-b2');
  assert.ok(Object.isFrozen(MARKET_OPEN_POLICY));
  assert.ok(Object.isFrozen(MARKET_OPEN_POLICY.roster));
  assert.match(cohort().cohortId, /^market-open-v1-/);
  assert.equal(cohort().cohortId, cohort().cohortId);
  assert.notEqual(cohort().cohortId, createMarketOpenCohort({ name: 'other', slateDate: '2026-09-10' }).cohortId);
});

test('rejects handmade cohorts even with a valid policy digest or a legacy-watch ID', () => {
  const legitimate = cohort();
  for (const cohortId of [legitimate.cohortId, 'watch-v0-2026-09-10']) {
    const forged = { name: legitimate.name, slateDate: legitimate.slateDate,
      policySha256: legitimate.policySha256, cohortId };
    assert.throws(() => prepareMarketOpenRun({ ...input(), cohort: forged }), /market-open cohort was not created by this policy/);
  }
});

test('market-open v1 policy and cohort identity have explicit golden pins', () => {
  // A policy/roster/prompt/price change requires an intentional identity review,
  // not automatic regeneration of this pin to make a failing test pass.
  const digest = '063596c704c034036d727e93f356436995639608aae8575fa36ab9f5c4a9ce51';
  assert.equal(cohort().policySha256, digest);
  assert.equal(prepared().provenance.policySha256, digest);
  assert.equal(cohort().cohortId, `market-open-v1-b1-fixture-2026-09-10-${digest}`);
});

test('market-open v1 reservation pins the shared four-arm initial-plus-repair budget', () => {
  // Four arms, one initial plus one repair, fixed-attempt-v1 USD-micros.
  // This is a conservative reservation, not measured usage or provider invoices.
  assert.equal(prepared().provenance.reservationUsdMicros, 800_000_000);
});

for (const market of ['moneyline', 'total'] as const) {
  test(`${market} keeps an immutable opener older than two hours as its reference`, () => {
    const capturedAt = '2026-09-10T11:00:00+00:00';
    assert.ok(Date.parse(OBSERVED) - Date.parse(capturedAt) > 2 * 60 * 60 * 1_000);
    const result = prepareMarketOpenRun({ ...input(market), historyRows: [{ ...opener(market), captured_at: capturedAt }] });
    assert.equal(result.state, 'prepared');
    if (result.state !== 'prepared') return;
    assert.equal(result.run.provenance.source.openedAt, capturedAt);
    assert.equal(result.run.provenance.observedAt, OBSERVED);
    assert.equal(result.run.provenance.source.row.captured_at, capturedAt);
    assert.deepEqual(Object.keys(result.run.request.game.markets), [market]);
  });

  test(`${market} opens independently with exactly its own forecast scope`, () => {
    const run = prepared(market);
    assert.deepEqual(Object.keys(run.request.game.markets), [market]);
    assert.equal(run.provenance.event.market, market);
    assert.equal(run.build.provenance[GAME]?.oddsRows.length, 0);
  });
}

test('identity is cohort/game/market, not observation time or opener payload', () => {
  const first = prepared();
  const later = prepareMarketOpenRun({ ...input(), observedAt: '2026-09-10T14:06:00Z',
    historyRows: [{ ...opener(), id: 12, captured_at: '2026-09-10T14:03:00Z', home_odds_american: -120 }],
  });
  assert.equal(later.state, 'prepared');
  if (later.state !== 'prepared') return;
  assert.equal(first.provenance.event.eventId, later.run.provenance.event.eventId);
  assert.equal(first.provenance.runId, later.run.provenance.runId);
  assert.notEqual(first.provenance.source.sha256, later.run.provenance.source.sha256);
  assert.notEqual(first.request.requestSha256, later.run.request.requestSha256);
  assert.notEqual(first.provenance.event.eventId, prepared('total').provenance.event.eventId);
  const otherId = '00000000-0000-4000-8000-0000000000bb';
  const other = prepareMarketOpenRun({ ...input(), game: game(otherId), historyRows: [opener('moneyline', otherId)] });
  assert.equal(other.state, 'prepared');
  if (other.state === 'prepared') assert.notEqual(first.provenance.event.eventId, other.run.provenance.event.eventId);
  const otherCohort = prepareMarketOpenRun({ ...input(), cohort: createMarketOpenCohort({ name: 'another', slateDate: '2026-09-10' }) });
  assert.equal(otherCohort.state, 'prepared');
  if (otherCohort.state === 'prepared') assert.notEqual(first.provenance.event.eventId, otherCohort.run.provenance.event.eventId);
});

test('first history opener retains source id, exact time and canonical row hash independently of observation', () => {
  const raw = input();
  // Earliest is in the middle: neither first nor last input position is correct.
  raw.historyRows = [
    { ...opener(), id: 20, captured_at: '2026-09-10T14:03:00Z' },
    opener(),
    { ...opener(), id: 30, captured_at: '2026-09-10T14:04:00Z' },
  ];
  const result = prepareMarketOpenRun(raw);
  assert.equal(result.state, 'prepared');
  if (result.state !== 'prepared') return;
  const p = result.run.provenance;
  assert.equal(p.source.openerId, 11);
  assert.equal(p.source.openedAt, OPENED);
  assert.equal(p.observedAt, OBSERVED);
  assert.notEqual(p.source.openedAt, p.observedAt);
  assert.equal(p.source.sha256, sha256Hex(canonicalize(p.source.row)));
  raw.historyRows[1]!.id = 99;
  assert.equal(p.source.openerId, 11);
  assert.ok(Object.isFrozen(p.source.row));
  assert.ok(!('boardCompletedAt' in p));
});

test('equal-instant opener ties use the lowest row ID regardless of input ordering', () => {
  const winner = opener();
  const tied = { ...opener(), id: 12 };
  const later = { ...opener(), id: 1, captured_at: '2026-09-10T14:03:00Z' };
  for (const historyRows of [[winner, tied, later], [tied, winner, later], [later, tied, winner]]) {
    const result = prepareMarketOpenRun({ ...input(), historyRows });
    assert.equal(result.state, 'prepared');
    if (result.state !== 'prepared') continue;
    assert.equal(result.run.provenance.source.openerId, 11);
    assert.equal(result.run.provenance.source.openedAt, OPENED);
  }
});

test('opener captured exactly at observation is eligible', () => {
  const result = prepareMarketOpenRun({ ...input(), historyRows: [{ ...opener(), captured_at: OBSERVED }] });
  assert.equal(result.state, 'prepared');
  if (result.state !== 'prepared') return;
  assert.equal(result.run.provenance.source.openedAt, OBSERVED);
  assert.equal(result.run.provenance.observedAt, OBSERVED);
});

const refusals = [
  ['disabled spread', () => input('spread'), 'market_disabled'],
  ['wrong slate date', () => ({ ...input(), cohort: createMarketOpenCohort({ name: 'b1-fixture', slateDate: '2026-09-11' }) }), 'wrong_slate_date'],
  ['missing opener', () => ({ ...input(), historyRows: [] }), 'opener_missing'],
  ['unready opener', () => ({ ...input(), historyRows: [{ ...opener(), home_odds_american: null }] }), 'opener_missing'],
  ['future opener', () => ({ ...input(), historyRows: [{ ...opener(), captured_at: '2026-09-10T14:05:00.001Z' }] }), 'opener_future'],
  ['at first pitch', () => ({ ...input(), game: { ...game(), matchTime: OBSERVED } }), 'at_or_after_first_pitch'],
  ['after first pitch', () => ({ ...input(), game: { ...game(), matchTime: '2026-09-10T14:04:59Z' } }), 'at_or_after_first_pitch'],
  ['already live', () => ({ ...input(), game: { ...game(), status: 'live' } }), 'game_not_upcoming'],
] as const;
for (const [name, make, reason] of refusals) {
  test(`refuses ${name} without a prepared event`, () => {
    assert.deepEqual(prepareMarketOpenRun(make()), { state: 'refused', reason });
  });
}

test('foreign or conflicting source evidence fails closed', () => {
  assert.throws(() => prepareMarketOpenRun({ ...input(), historyRows: [opener('total')] }), /identity/);
  assert.throws(() => prepareMarketOpenRun({ ...input(), historyRows: [opener(), { ...opener(), home_odds_american: -120 }] }), /conflicting/);
});

test('claim contract binds event, immutable source and exact request before any send; it is not a permit', () => {
  const run = prepared();
  assert.deepEqual(run.provenance.claim, {
    state: 'required-before-send', key: run.provenance.event.eventId,
    requestSha256: run.request.requestSha256, sourceSha256: run.provenance.source.sha256,
    atomicWith: ['budget-reservation', 'attempt-slots'],
    paidDispatch: 'blocked-until-b2',
  });
  assert.equal(run.provenance.policy.paidDispatch, 'blocked-until-b2');
});

test('shared builders and preparation produce identical request/game hashes and scoped bytes', () => {
  const run = prepared('total');
  const built = buildGameBundle(game(), new Map([['total', { ...quote('total'), upstream_last_updated: OPENED }]]), Date.parse(OPENED), ['total']);
  assert.ok('bundle' in built);
  const expected = prepareGameRequest(buildGameRequest(built.bundle, game().slug, '2026-09-10', OBSERVED));
  assert.deepEqual(run.request, expected);
  assert.equal(run.build.slateSha256, expected.requestSha256);
  assert.equal(run.provenance.requestSha256, expected.requestSha256);
  assert.equal(run.provenance.gameSha256, expected.gameSha256);
});

for (const market of ['moneyline', 'total'] as const) {
  test(`no-network ${market} fixture retains authentic shared records and rejects crossed provenance`, async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network is forbidden in B1'); };
    try {
      const run = prepared(market);
      const result = await runMarketOpenFixture(run);
      assert.equal(result.context.mode, 'dry-run');
      assert.equal(result.context.clockMode, 'synthetic-fixture');
      // Known-zero mocks prove wiring only, not billable cost/over-cap enforcement.
      assert.equal(result.spend.kind, 'pass');
      const types = new Set(result.records.map((r) => r['recordType']));
      for (const type of ['run_meta', 'bundle_game', 'arm_game_response', 'decision', 'baseline_decision']) assert.ok(types.has(type), type);
      const meta = result.records.find((r) => r['recordType'] === 'run_meta')!;
      assert.deepEqual(meta['marketOpen'], run.provenance);
      assert.equal(meta['baselinePolicyVersion'], 'baselines-v0.3.0');
      assert.equal(meta['cohortId'], run.cohort.cohortId);
      assert.ok(!('watch' in meta));
      const bundle = result.records.find((r) => r['recordType'] === 'bundle_game')!;
      // History evidence is in run_meta.marketOpen.source, not current_odds rows.
      assert.deepEqual(bundle['sourceOddsRows'], []);
      assert.equal(bundle['runId'], meta['runId']);
      assert.equal(bundle['requestSha256'], run.request.requestSha256);
      assert.equal(bundle['gameSha256'], run.request.gameSha256);
      for (const r of result.records.filter((r) => r['recordType'] === 'baseline_decision' || r['recordType'] === 'decision')) assert.equal(r['market'], market);
      const responses = result.records.filter((r) => r['recordType'] === 'arm_game_response');
      assert.equal(responses.length, MARKET_OPEN_POLICY.roster.length);
      // Shared mock deliberately times out one arm: retain it, do not invent a pick.
      const validResponses = responses.filter((r) => r['outcome'] === 'valid');
      assert.ok(validResponses.length > 0);
      assert.ok(responses.some((r) => r['outcome'] === 'timeout'));
      assert.equal(result.records.filter((r) => r['recordType'] === 'decision').length, validResponses.length);
      assert.ok(responses.some((r) => {
        const attempt = r['attempt'] as Record<string, unknown>;
        return typeof attempt['responseAt'] === 'string' && attempt['responseAt'] !== OPENED;
      }));
      const collision = { failures: [], warnings: [] };
      assert.throws(() => buildRecords(result.envelope, { ...result.context, marketOpen: prepared(market === 'total' ? 'moneyline' : 'total').provenance }, run.build, collision), /market.open/);
      assert.throws(() => buildRecords(result.envelope, { ...result.context, marketOpen: { ...run.provenance, source: { ...run.provenance.source, openerId: 999 } } }, run.build, collision), /market.open/);
      assert.throws(() => buildRecords(result.envelope, { ...result.context, mode: 'live' }, run.build, collision), /market.open/);
      assert.throws(() => buildRecords(result.envelope, { ...result.context, runId: 'wrong' }, run.build, collision), /market.open/);
      assert.throws(() => buildRecords(result.envelope, result.context, prepared(market === 'total' ? 'moneyline' : 'total').build, collision), /market.open/);
      // Isolate each observation pin; changing one must not hide behind the other.
      for (const field of ['fetchStartedAt', 'fetchCompletedAt'] as const) {
        for (const timestamp of [OPENED, '2026-09-10T14:06:00Z']) {
          assert.throws(() => buildRecords(result.envelope, { ...result.context, [field]: timestamp }, run.build, collision), /market-open record context/);
        }
      }
      // A genuinely branded subset envelope passes shared authentication, but is
      // not this policy's roster. A forged envelope would test the wrong guard.
      let clock = Date.parse(OBSERVED);
      const subset = await runSlate(
        MARKET_OPEN_POLICY.roster.slice(0, 1), createMockAdapters({ simulateCollision: false }),
        run.build.requests, { ...result.context, nowMs: () => clock++ },
      );
      assert.equal(subset.results.length, 1);
      assert.doesNotThrow(() => authenticateRun(subset, result.context));
      assert.throws(() => buildRecords(subset, result.context, run.build, collision), /market-open record context/);
    } finally { globalThis.fetch = previousFetch; }
  });
}
