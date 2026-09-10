import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGameBundle } from './bundle.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { buildGameRequest } from './scopedRequest.js';
import { prepareGameRequest } from './preparedRequest.js';
import { MARKET_POLICY_DIGEST } from './marketPolicy.js';
import { buildRecords } from './records.js';
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

for (const market of ['moneyline', 'total'] as const) {
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
  raw.historyRows = [{ ...opener(), id: 20, captured_at: '2026-09-10T14:03:00Z' }, opener()];
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

const refusals = [
  ['disabled spread', () => input('spread'), 'market_disabled'],
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
      assert.equal(result.spend.kind, 'pass');
      const types = new Set(result.records.map((r) => r['recordType']));
      for (const type of ['run_meta', 'bundle_game', 'arm_game_response', 'decision', 'baseline_decision']) assert.ok(types.has(type), type);
      const meta = result.records.find((r) => r['recordType'] === 'run_meta')!;
      assert.deepEqual(meta['marketOpen'], run.provenance);
      assert.equal(meta['baselinePolicyVersion'], 'baselines-v0.3.0');
      assert.equal(meta['cohortId'], run.cohort.cohortId);
      assert.ok(!('watch' in meta));
      const bundle = result.records.find((r) => r['recordType'] === 'bundle_game')!;
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
    } finally { globalThis.fetch = previousFetch; }
  });
}
