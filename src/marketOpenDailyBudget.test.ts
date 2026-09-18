import assert from 'node:assert/strict';
import { estimateMarketOpenDailyAttempts, computeDailyBudgetStatus } from './marketOpenDailyBudget.js';
import { readMarketOpenStore } from './marketOpenStore.js';
import { priceForModel } from './modelPriceTable.js';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarketOpenProducer, MARKET_OPEN_MONITORING_DEFAULTS } from './marketOpenProducer.js';
import { MARKET_OPEN_POLICY, createMarketOpenCohort } from './marketOpen.js';
import { parseRequestPayload, buildValidResponse } from './mock.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { deriveConservativeActualUsdMicros } from './conservativeSpend.js';
import { deriveFireSpendReservationUsdMicros } from './spendReservationPolicy.js';
import { nodeArtifactFs } from './fireArtifactSink.js';
import { sealResponseEnvelope } from './providers/responseEnvelope.js';
import type { MarketOpenObservation } from './marketOpenProducer.js';
import type { ProviderAdapter, ProviderResponse, ProviderCallOptions } from './types.js';

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX durability required' : false };
const OBSERVED = '2026-09-10T14:05:00.000Z';
const NOW = Date.parse(OBSERVED);
const GAME = '00000000-0000-4000-8000-000000000004';
const COHORT = createMarketOpenCohort({ name: 'producer-test', slateDate: '2026-09-10' });
const RESERVATION = deriveFireSpendReservationUsdMicros({ rosterSize: MARKET_OPEN_POLICY.roster.length, maxRepairsPerArm: 1, version: MARKET_OPEN_POLICY.spendReservationPolicyVersion });
const usage: Record<string, unknown> = {
  openai: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  anthropic: { input_tokens: 10, output_tokens: 10, server_tool_use: { web_search_requests: 1 } },
  google: { promptTokenCount: 10, candidatesTokenCount: 10, thoughtsTokenCount: 0, totalTokenCount: 20 },
  xai: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, completion_tokens_details: { reasoning_tokens: 0 } },
};
function observation(market: 'moneyline' | 'total' = 'moneyline', gameId = GAME): MarketOpenObservation {
  return { observedAt: OBSERVED, market,
    game: { gameId, slug: 'mil-pit', sport: 'mlb', matchTime: '2026-09-10T20:00:00.000Z', status: 'upcoming',
      homeTeam: { name: 'Pirates', abbreviation: 'PIT' }, awayTeam: { name: 'Brewers', abbreviation: 'MIL' },
      hasOdds: true, contestCreated: false, contestId: null, canCreateContest: true,
      externalIds: { jsonodds: gameId, sportspage: null, rundown: null } },
    historyRows: [{ id: market === 'moneyline' ? 10 : 11, jsonodds_id: gameId, source: 'jsonodds',
      market, line: market === 'total' ? 8.5 : null,
      away_odds_decimal: 1 + 100 / 110, home_odds_decimal: 1 + 100 / 105,
      away_odds_american: -110, home_odds_american: -105, captured_at: '2026-09-10T11:00:00.000Z' }] };
}
interface Call { armId: string; gameId: string; market: string; role: 'initial' | 'repair'; options: ProviderCallOptions | undefined; timeoutMs: number }
type Transform = (response: ProviderResponse, call: Call) => Promise<ProviderResponse> | ProviderResponse;
function fixture(transform?: Transform, cap = 60_000_000, observationToSendWarningMs?: number) {
  const root = mkdtempSync(join(tmpdir(), 'market-open-producer-'));
  let clock = NOW;
  const calls: Call[] = [];
  let producer: MarketOpenProducer;
  const adapters = new Map<string, ProviderAdapter>();
  for (const arm of MARKET_OPEN_POLICY.roster) adapters.set(arm.participantId, {
    provider: arm.provider, requestedModelId: arm.requestedModelId, credentialEnvVar: 'SYNTHETIC_UNUSED', hasCredential: () => true,
    async chat(turns, timeoutMs, options) {
      const { payload, gameId } = parseRequestPayload(turns);
      const market = payload.bundle.games[0]!.markets.total !== undefined ? 'total' : 'moneyline';
      const role = turns.length > 2 ? 'repair' : 'initial';
      const call: Call = { armId: arm.participantId, gameId, market, role, options, timeoutMs };
      const fire = producer.snapshot().fires.find((f) => f.claim.preparation.game.gameId === gameId && f.claim.preparation.market === market)!;
      assert.ok(fire, 'durable per-market claim precedes chat');
      assert.equal(fire.status, 'running');
      assert.ok(fire.attempts.some((a) => a.slot.armId === arm.participantId && a.slot.role === role && a.finishedAt === null), 'durable slot precedes EVERY chat');
      assert.ok(producer.snapshot().reservedUsdMicros >= fire.claim.reservationUsdMicros);
      const journal = readdirSync(join(root, 'journal')).filter((n) => n.endsWith('.json')).sort();
      assert.ok(journal.map((n) => readFileSync(join(root, 'journal', n), 'utf8')).some((s) => s.includes('"type":"begin"')));
      calls.push(call);
      const response: ProviderResponse = { rawText: JSON.stringify(buildValidResponse(payload)),
        reportedModelId: arm.requestedModelId, providerResponseId: `synthetic-${arm.participantId}-${gameId}-${market}-${role}`,
        responseEnvelope: sealResponseEnvelope(JSON.stringify({ synthetic: true, usage: usage[arm.provider] })), httpStatus: 200,
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20, reasoningTokens: 0, billableOutputTokens: 10 },
        usageRaw: structuredClone(usage[arm.provider]), requestParams: { ...(options?.configuration ?? {}), tools: options?.tools },
        searchAudit: { queries: [{ query: `${role} synthetic query` }], results: [{ url: 'https://example.invalid/synthetic', title: 'synthetic evidence' }],
          searchCount: 1, incomplete: [] } };
      return transform ? transform(response, call) : response;
    },
  });
  const options = { root, name: COHORT.name, slateDate: COHORT.slateDate, capUsdMicros: null, dailyBudget: { capUsdMicros: cap, ledgerRoot: root }, adapters, nowMs: () => clock, ...(observationToSendWarningMs === undefined ? {} : { observationToSendWarningMs }) };
  producer = new MarketOpenProducer(options);
  return { root, calls, options, get producer() { return producer; }, setClock: (value: number) => { clock = value; },
    reopen: () => { producer = new MarketOpenProducer(options); },
    cleanup: async () => { try { await producer.close(); } catch { /* intentional poisoned state preserved until fixture deletion */ }
      rmSync(root, { recursive: true, force: true }); } };
}
function artifact(path: string | null | undefined) { assert.ok(path); return JSON.parse(readFileSync(path, 'utf8')); }



test('daily budget uses actual costs, keeps roster and permits one event beyond estimates', posixOnly, async () => {
  const f = fixture((response) => ({ ...response, usageRaw: { ...response.usageRaw as object,
    input_tokens: 100000, output_tokens: 100000, promptTokenCount: 100000, candidatesTokenCount: 100000,
    thoughtsTokenCount: 0, totalTokenCount: 200000, prompt_tokens: 100000, completion_tokens: 100000,
    total_tokens: 200000, completion_tokens_details: { reasoning_tokens: 0 } } }));
  try {
    assert.equal((await f.producer.observe(observation())).state, 'completed');
    const status = f.producer.dailyBudgetStatus()!;
    assert.equal(status.integrityHalt, null); assert.ok(status.aboveEstimateAttempts > 0);
    assert.ok(status.actualUsdMicros > 0); assert.equal(status.estimatedUsdMicros, 0);
    assert.equal(status.gamesSent, 1); assert.equal(f.calls.length, MARKET_OPEN_POLICY.roster.length);
    for (const arm of MARKET_OPEN_POLICY.roster) assert.ok(priceForModel(arm.requestedModelId, MARKET_OPEN_POLICY.priceVersion));
    assert.equal((await f.producer.observe(observation('total'))).state, 'completed');
  } finally { await f.cleanup(); }
});

test('unknown cost is estimated and flagged without halt, permits sibling and repair work', posixOnly, async () => {
  const f = fixture((response, call) => ({ ...response, usageRaw: {},
    rawText: call.role === 'initial' ? response.rawText.replace(/"cohortId":"[^"]*"/, '"cohortId":"wrong"') : response.rawText }));
  try {
    assert.equal((await f.producer.observe(observation())).state, 'completed');
    assert.equal(f.calls.length, MARKET_OPEN_POLICY.roster.length * 2);
    const status = f.producer.dailyBudgetStatus()!;
    assert.equal(status.unknownCostAttempts, f.calls.length); assert.ok(status.estimatedUsdMicros > 0);
    assert.equal(status.integrityHalt, null);
    assert.equal((await f.producer.observe(observation('total'))).state, 'completed');
  } finally { await f.cleanup(); }
});

test('daily brake holds without claims; raising cap resumes the exact observation and replay sends nothing', posixOnly, async () => {
  const f = fixture(undefined, 1);
  try {
    assert.equal((await f.producer.observe(observation())).state, 'completed');
    const second = observation('total');
    assert.equal((await f.producer.observe(second)).state, 'held');
    assert.equal(f.producer.snapshot().fires.length, 1); assert.equal(f.calls.length, 4);
    const status = f.producer.dailyBudgetStatus()!;
    assert.equal(status.heldGames, 1); assert.equal(status.reachedAt, OBSERVED);
    assert.equal(status.gamesSent, 1);
    assert.equal(status.nextFirstPitch, second.game.matchTime);
    await f.producer.close(); f.reopen();
    assert.equal(f.producer.dailyBudgetStatus()!.heldGames, 1);
    assert.equal((await f.producer.observe({ ...second, observedAt: '2026-09-10T15:00:00Z', historyRows: [] })).state, 'held');
    await f.producer.refreshDailyBudget(60_000_000); await f.producer.drain();
    assert.equal(f.calls.length, 8); assert.equal(f.producer.snapshot().fires.length, 2);
    assert.ok(f.producer.snapshot().fires.every(fire => fire.claim.preparation.observedAt === OBSERVED));
    const replay = await f.producer.observe(second); assert.equal(replay.state, 'completed'); assert.equal(f.calls.length, 8);
    const bytes = readFileSync(join(f.root, 'config.json'));
    await f.producer.close(); f.options.name = 'next-name'; f.options.dailyBudget.capUsdMicros = 60_000_000; f.reopen();
    assert.deepEqual(readFileSync(join(f.root, 'config.json')), bytes);
    assert.ok(f.producer.dailyBudgetStatus()!.actualUsdMicros > 0, 'name change cannot reset daily cost');
  } finally { await f.cleanup(); }
});

test('ET midnight releases eligible next-day holds; expired holds never claim or send', posixOnly, async () => {
  const f = fixture(undefined, 1);
  try {
    await f.producer.observe(observation());
    const expired = observation('total');
    assert.equal((await f.producer.observe(expired)).state, 'held');
    const tomorrow = observation('moneyline', '00000000-0000-4000-8000-000000000005');
    tomorrow.game.matchTime = '2026-09-11T08:00:00.000Z';
    assert.equal((await f.producer.observe(tomorrow)).state, 'held');
    f.setClock(Date.parse('2026-09-11T04:00:00.000Z'));
    await f.producer.refreshDailyBudget(1); await f.producer.drain();
    assert.equal(f.producer.snapshot().fires.length, 2); assert.equal(f.calls.length, 8);
    const old = f.producer.snapshot().dailyBudget!.observations.find(o => o.input.preparation.market === 'total')!;
    assert.equal(old.state, 'expired'); assert.equal(old.reason, 'daily_budget_held_expired');
    const sent = f.producer.snapshot().fires.find(x => x.claim.preparation.game.gameId === tomorrow.game.gameId)!;
    assert.equal(sent.claim.preparation.observedAt, OBSERVED); assert.equal(sent.claim.preparation.slateDate, '2026-09-11');
    assert.equal(f.producer.dailyBudgetStatus()!.dayET, '2026-09-11');
  } finally { await f.cleanup(); }
});

test('concurrent in-flight estimates share one cap and exclusive ledger lock', posixOnly, async () => {
  let release!: () => void; const waiting = new Promise<void>(r => { release = r; });
  const f = fixture(async response => { await waiting; return response; }, 1);
  try {
    const first = f.producer.observe(observation());
    await new Promise(r => setImmediate(r));
    assert.ok(f.producer.dailyBudgetStatus()!.inflightEstimateUsdMicros > 0);
    assert.equal((await f.producer.observe(observation('total'))).state, 'held');
    assert.equal(f.producer.snapshot().fires.length, 1);
    assert.throws(() => new MarketOpenProducer(f.options), /market-open writer lock:.*kernel guard/);
    release(); assert.equal((await first).state, 'completed');
    assert.equal(f.producer.snapshot().halted, null);
  } finally { release(); await f.cleanup(); }
});

test('DST uses ET calendar and terminal unknown estimates reset without changing historical evidence', posixOnly, async () => {
  const f = fixture(response => ({ ...response, usageRaw: {} }));
  try {
    await f.producer.observe(observation()); const before = f.producer.snapshot();
    assert.ok(computeDailyBudgetStatus(before, OBSERVED, 60_000_000).unknownEstimateUsdMicros > 0);
    assert.equal(computeDailyBudgetStatus(before, '2026-09-11T04:00:00Z', 60_000_000).usedUsdMicros, 0);
    for (const [at,day] of [['2026-03-08T04:59:59Z','2026-03-07'],['2026-03-08T05:00:00Z','2026-03-08'],
      ['2026-11-01T03:59:59Z','2026-10-31'],['2026-11-01T04:00:00Z','2026-11-01']]) {
      const blank = { ...before, fires: [], dailyBudget: { ...before.dailyBudget!, observations: [] } };
      assert.equal(computeDailyBudgetStatus(blank, at!, 60_000_000).dayET, day);
    }
    assert.deepEqual(readMarketOpenStore(f.root).snapshot, before);
  } finally { await f.cleanup(); }
});
