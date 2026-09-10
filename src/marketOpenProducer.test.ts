import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarketOpenProducer, MARKET_OPEN_ADMISSION_POLICY } from './marketOpenProducer.js';
import { MARKET_OPEN_POLICY, createMarketOpenCohort } from './marketOpen.js';
import { parseRequestPayload, buildValidResponse } from './mock.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { deriveConservativeActualUsdMicros } from './conservativeSpend.js';
import { deriveFireSpendReservationUsdMicros } from './spendReservationPolicy.js';
import { nodeArtifactFs } from './fireArtifactSink.js';
import { sealResponseEnvelope } from './providers/responseEnvelope.js';
import type { MarketOpenObservation } from './marketOpenProducer.js';
import type { ProviderAdapter, ProviderResponse, ProviderCallOptions } from './types.js';

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
interface Call { armId: string; gameId: string; market: string; role: 'initial' | 'repair'; options: ProviderCallOptions | undefined }
type Transform = (response: ProviderResponse, call: Call) => Promise<ProviderResponse> | ProviderResponse;
function fixture(transform?: Transform, cap = RESERVATION * 8) {
  const root = mkdtempSync(join(tmpdir(), 'market-open-producer-'));
  let clock = NOW;
  const calls: Call[] = [];
  let producer: MarketOpenProducer;
  const adapters = new Map<string, ProviderAdapter>();
  for (const arm of MARKET_OPEN_POLICY.roster) adapters.set(arm.participantId, {
    provider: arm.provider, requestedModelId: arm.requestedModelId, credentialEnvVar: 'SYNTHETIC_UNUSED', hasCredential: () => true,
    async chat(turns, _timeout, options) {
      const { payload, gameId } = parseRequestPayload(turns);
      const market = payload.bundle.games[0]!.markets.total !== undefined ? 'total' : 'moneyline';
      const role = turns.length > 2 ? 'repair' : 'initial';
      const call: Call = { armId: arm.participantId, gameId, market, role, options };
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
  const options = { root, name: COHORT.name, slateDate: COHORT.slateDate, capUsdMicros: cap, adapters, nowMs: () => clock };
  producer = new MarketOpenProducer(options);
  return { root, calls, get producer() { return producer; }, setClock: (value: number) => { clock = value; },
    reopen: () => { producer = new MarketOpenProducer(options); },
    cleanup: async () => { try { await producer.close(); } catch { /* intentional poisoned state preserved until fixture deletion */ }
      rmSync(root, { recursive: true, force: true }); } };
}
function artifact(path: string | null | undefined) { assert.ok(path); return JSON.parse(readFileSync(path, 'utf8')); }

// These are synthetic adapters on the actual admission, runner, accounting, record and sink path.
test('D4 billable initial and repair evidence, immutable artifact, exact replay and cumulative reservation', async () => {
  const target = MARKET_OPEN_POLICY.roster[0]!.participantId;
  const f = fixture((response, call) => call.armId === target && call.role === 'initial'
    ? { ...response, rawText: response.rawText.replace(/"cohortId":"[^"]*"/, '"cohortId":"wrong"') } : response);
  try {
    const result = await f.producer.observe(observation());
    assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.equal(f.calls.length, MARKET_OPEN_POLICY.roster.length + 1);
    assert.equal(f.calls.find((c) => c.role === 'repair')?.options?.tools, 'none');
    const snapshot = f.producer.snapshot(); const fire = snapshot.fires[0]!;
    assert.equal(snapshot.reservedUsdMicros, RESERVATION);
    assert.ok(snapshot.knownCostUsdMicros > 0, 'not known-zero fixture classification');
    assert.equal(fire.attempts.length, f.calls.length);
    const doc = artifact(result.artifactPath);
    assert.equal(doc.spend.kind, 'pass');
    assert.equal(doc.admission.attempts.reduce((sum: number, a: { costUsdMicros: number }) => sum + a.costUsdMicros, 0), snapshot.knownCostUsdMicros);
    const expected = f.calls.reduce((sum, call) => {
      const arm = MARKET_OPEN_POLICY.roster.find((a) => a.participantId === call.armId)!;
      return sum + deriveConservativeActualUsdMicros({ provider: arm.provider, requestedModelId: arm.requestedModelId,
        priceVersion: MARKET_OPEN_POLICY.priceVersion, usageRaw: usage[arm.provider], searchCount: 1 });
    }, 0);
    assert.equal(snapshot.knownCostUsdMicros, expected);
    assert.ok(fire.attempts.every((a) => a.costUsdMicros! > 0 && JSON.stringify(a.evidence).includes('synthetic query')));
    const game = doc.records.find((r: { recordType: string }) => r.recordType === 'bundle_game');
    const provenance = doc.records.find((r: { recordType: string }) => r.recordType === 'run_meta').marketOpen;
    assert.equal(game.sourceOddsReference.sourceSha256, provenance.source.sha256);
    assert.deepEqual(game.sourceOddsRows, []);
    assert.equal(provenance.observedAt, OBSERVED);
    const journal = readdirSync(join(f.root, 'journal')).filter((n) => n.endsWith('.json')).sort();
    assert.equal(JSON.parse(readFileSync(join(f.root, 'journal', journal.at(-1)!), 'utf8')).operation.type, 'complete');
    await f.producer.close(); f.reopen();
    const replay = await f.producer.observe({ ...observation(), observedAt: '2026-09-10T15:00:00Z', historyRows: [] });
    assert.deepEqual(replay, result); assert.equal(f.calls.length, MARKET_OPEN_POLICY.roster.length + 1);
    assert.equal(f.producer.snapshot().reservedUsdMicros, RESERVATION);
  } finally { await f.cleanup(); }
});

test('two independent bounded workers start sibling markets while a slow market is held; third queues', async () => {
  let release!: () => void;
  let releaseTotal!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const heldTotal = new Promise<void>((resolve) => { releaseTotal = resolve; });
  const f = fixture(async (response, call) => {
    if (call.market === 'moneyline' && call.gameId === GAME) await held;
    if (call.market === 'total') await heldTotal;
    return response;
  });
  try {
    const first = f.producer.observe(observation());
    const second = f.producer.observe(observation('total'));
    const thirdId = '00000000-0000-4000-8000-000000000005';
    const third = f.producer.observe(observation('moneyline', thirdId));
    await new Promise((r) => setImmediate(r));
    assert.ok(f.calls.some((c) => c.market === 'total'), 'no wait for moneyline');
    assert.ok(!f.calls.some((c) => c.gameId === thirdId), 'third market cannot start while both workers are occupied');
    releaseTotal();
    assert.equal((await second).state, 'completed');
    // The second worker becoming idle is allowed to drain the third without waiting for first.
    assert.equal((await third).state, 'completed');
    assert.equal(f.producer.snapshot().reservedUsdMicros, RESERVATION * 3);
    release(); assert.equal((await first).state, 'completed');
  } finally { release(); releaseTotal(); await f.cleanup(); }
});

test('cap refusal is durable and never sends; replay cannot evade cumulative reservations', async () => {
  const f = fixture(undefined, RESERVATION);
  try {
    assert.equal((await f.producer.observe(observation())).state, 'completed');
    const refused = await f.producer.observe(observation('total'));
    assert.equal(refused.state, 'refused');
    assert.equal(f.calls.length, MARKET_OPEN_POLICY.roster.length);
    await f.producer.close(); f.reopen();
    assert.deepEqual(await f.producer.observe(observation('total')), refused);
    assert.equal(f.producer.snapshot().reservedUsdMicros, RESERVATION);
  } finally { await f.cleanup(); }
});

test('unknown usage retains evidence, halts repairs and subsequent markets through actual producer', async () => {
  const f = fixture((response) => ({ ...response, rawText: '{}', usageRaw: null }));
  try {
    const result = await f.producer.observe(observation());
    assert.equal(result.state, 'unknown');
    assert.ok(f.producer.snapshot().halted);
    assert.ok(f.calls.every((c) => c.role === 'initial'));
    assert.ok(f.producer.snapshot().fires[0]!.attempts.every((a) => a.evidence !== null));
    const doc = artifact(result.artifactPath); assert.equal(doc.spend.kind, 'unknown');
    assert.equal((await f.producer.observe(observation('total'))).state, 'refused');
    await f.producer.close(); f.reopen();
    assert.equal((await f.producer.recover())[0]?.state, 'unknown');
    assert.equal(f.calls.length, MARKET_OPEN_POLICY.roster.length);
  } finally { await f.cleanup(); }
});

test('missing search count is unknown even with usable token evidence', async () => {
  const f = fixture((response) => ({ ...response, searchAudit: null }));
  try {
    assert.equal((await f.producer.observe(observation())).state, 'unknown');
    assert.ok(f.producer.snapshot().halted);
  } finally { await f.cleanup(); }
});

test('known over-reservation actual is recorded without clamping and halts later admission', async () => {
  const first = MARKET_OPEN_POLICY.roster[0]!;
  const f = fixture((response, call) => call.armId === first.participantId
    ? { ...response, usageRaw: { input_tokens: 100_000_000, output_tokens: 10, total_tokens: 100_000_010 } } : response);
  try {
    const result = await f.producer.observe(observation());
    assert.equal(result.state, 'unknown');
    assert.ok(f.producer.snapshot().knownCostUsdMicros > RESERVATION);
    assert.equal(artifact(result.artifactPath).spend.kind, 'breach');
    assert.equal((await f.producer.observe(observation('total'))).state, 'refused');
  } finally { await f.cleanup(); }
});

test('P2 120000ms inclusive bound; 120001ms refuses with zero sends and no observation refresh', async () => {
  for (const delta of [120_000, 120_001]) {
    const f = fixture();
    try {
      f.setClock(NOW + delta);
      const result = await f.producer.observe(observation());
      assert.equal(result.state, delta === 120_000 ? 'completed' : 'refused');
      assert.equal(f.calls.length, delta === 120_000 ? MARKET_OPEN_POLICY.roster.length : 0);
      assert.equal(f.producer.snapshot().fires[0]?.claim.preparation.observedAt, OBSERVED);
    } finally { await f.cleanup(); }
  }
  assert.equal(MARKET_OPEN_ADMISSION_POLICY.maxObservationToSendLagMs, 120_000);
});

test('P2 expired repair is refused without a second send; first observation is unchanged', async () => {
  const f = fixture((response, call) => { if (call.role === 'initial') f.setClock(NOW + 120_001); return { ...response, rawText: '{}' }; });
  try {
    assert.equal((await f.producer.observe(observation())).state, 'failed');
    assert.ok(f.calls.length > 0); assert.ok(f.calls.every((c) => c.role === 'initial'));
    assert.equal(f.producer.snapshot().fires[0]?.claim.preparation.observedAt, OBSERVED);
  } finally { await f.cleanup(); }
});

test('P2 recovery dispatches only original unsent claims and does not restart their lag clock', async () => {
  for (const delta of [60_000, 120_001]) {
    const f = fixture();
    try {
      const admission = f.producer.admit(observation()); assert.equal(admission.state, 'admitted');
      await f.producer.close(); f.reopen(); f.setClock(NOW + delta);
      const [result] = await f.producer.recover();
      assert.equal(result?.state, delta <= 120_000 ? 'completed' : 'refused');
      assert.equal(f.calls.length, delta <= 120_000 ? MARKET_OPEN_POLICY.roster.length : 0);
      assert.equal(f.producer.snapshot().fires[0]?.claim.preparation.observedAt, OBSERVED);
    } finally { await f.cleanup(); }
  }
});

test('fsync crossing lag bound is rechecked at actual send: never sent evidence has zero known cost', async () => {
  const f = fixture();
  const original = nodeArtifactFs.syncDir;
  try {
    const admission = f.producer.admit(observation()); assert.equal(admission.state, 'admitted');
    let crossed = false;
    nodeArtifactFs.syncDir = (dir) => { original(dir); if (dir.endsWith('/journal') && !crossed) { crossed = true; f.setClock(NOW + 120_001); } };
    const [result] = await f.producer.recover();
    assert.equal(result?.state, 'failed'); assert.equal(f.calls.length, 0);
    const snapshot = f.producer.snapshot(); assert.equal(snapshot.knownCostUsdMicros, 0); assert.equal(snapshot.halted, null);
    assert.equal(snapshot.fires[0]?.attempts[0]?.costUsdMicros, 0);
  } finally { nodeArtifactFs.syncDir = original; await f.cleanup(); }
});

test('repair-intent fsync crossing the lag bound retains a zero-cost refusal, not an unknown send', async () => {
  const target = MARKET_OPEN_POLICY.roster[0]!.participantId;
  const f = fixture((response, call) => call.armId === target && call.role === 'initial'
    ? { ...response, rawText: response.rawText.replace(/"cohortId":"[^"]*"/, '"cohortId":"wrong"') } : response);
  const original = nodeArtifactFs.syncDir;
  try {
    nodeArtifactFs.syncDir = (dir) => {
      original(dir);
      if (dir.endsWith('/journal')) {
        const names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
        const operation = JSON.parse(readFileSync(join(dir, names.at(-1)!), 'utf8')).operation;
        if (operation.type === 'begin' && operation.input.slot.role === 'repair') f.setClock(NOW + 120_001);
      }
    };
    const result = await f.producer.observe(observation());
    assert.equal(result.state, 'failed');
    assert.equal(f.calls.filter((c) => c.role === 'repair').length, 0);
    const snapshot = f.producer.snapshot();
    assert.equal(snapshot.halted, null);
    const repair = snapshot.fires[0]!.attempts.find((a) => a.slot.role === 'repair')!;
    assert.equal(repair.costUsdMicros, 0);
    assert.equal((repair.evidence as { attempt: { requestAt: null } }).attempt.requestAt, null);
    assert.equal(artifact(result.artifactPath).spend.kind, 'pass');
  } finally { nodeArtifactFs.syncDir = original; await f.cleanup(); }
});

test('artifact install fault cannot mark completed; restart preserves reservation and never resends', async () => {
  const f = fixture();
  const original = nodeArtifactFs.link;
  try {
    nodeArtifactFs.link = (from, to) => { if (to.includes('/artifacts/')) throw new Error('synthetic artifact link fault'); original(from, to); };
    await assert.rejects(f.producer.observe(observation()), /synthetic artifact link fault/);
    assert.equal(f.producer.snapshot().fires[0]?.status, 'unknown');
    assert.equal(f.producer.snapshot().fires[0]?.terminalArtifact, null);
    assert.equal(f.producer.snapshot().reservedUsdMicros, RESERVATION);
    nodeArtifactFs.link = original;
    await assert.rejects(f.producer.close(), /synthetic artifact link fault/); f.reopen();
    assert.equal((await f.producer.recover())[0]?.state, 'unknown');
    assert.equal(f.calls.length, MARKET_OPEN_POLICY.roster.length);
  } finally { nodeArtifactFs.link = original; await f.cleanup(); }
});

test('single writer is enforced through producer constructor, not caller convention', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.reopen(), /writer lock/);
    assert.equal((await f.producer.observe(observation())).state, 'completed');
  } finally { await f.cleanup(); }
});

test('unknown repair retains separate billable evidence and halts subsequent admission', async () => {
  const target = MARKET_OPEN_POLICY.roster[0]!.participantId;
  const f = fixture((response, call) => call.armId !== target ? response : call.role === 'initial'
    ? { ...response, rawText: response.rawText.replace(/"cohortId":"[^"]*"/, '"cohortId":"wrong"') }
    : { ...response, usageRaw: null });
  try {
    assert.equal((await f.producer.observe(observation())).state, 'unknown');
    const attempts = f.producer.snapshot().fires[0]!.attempts.filter((a) => a.slot.armId === target);
    assert.equal(attempts.length, 2);
    assert.ok(attempts[0]!.costUsdMicros! > 0);
    assert.equal(attempts[1]!.costUsdMicros, null);
    assert.equal(attempts[1]!.slot.role, 'repair');
    const before = f.calls.length;
    assert.equal((await f.producer.observe(observation('total'))).state, 'refused');
    assert.equal(f.calls.length, before);
  } finally { await f.cleanup(); }
});

for (const point of ['claim', 'send'] as const) {
  test(`SIGKILL at ${point}: lock is not stolen; offline restart preserves claim and never repeats an uncertain send`, async () => {
    const f = fixture();
    try {
      await f.producer.close();
      const code = `
        import { MarketOpenProducer } from ${JSON.stringify(new URL('./marketOpenProducer.ts', import.meta.url).href)};
        import { MARKET_OPEN_POLICY } from ${JSON.stringify(new URL('./marketOpen.ts', import.meta.url).href)};
        const adapters = new Map(MARKET_OPEN_POLICY.roster.map(a => [a.participantId, {
          provider:a.provider, requestedModelId:a.requestedModelId, credentialEnvVar:'SYNTHETIC_UNUSED',
          hasCredential:()=>true, chat:async()=>{process.kill(process.pid,'SIGKILL'); throw Error('unreachable');}
        }]));
        const producer = new MarketOpenProducer({root:${JSON.stringify(f.root)}, name:${JSON.stringify(COHORT.name)}, slateDate:${JSON.stringify(COHORT.slateDate)},
          capUsdMicros:${RESERVATION * 8}, adapters, nowMs:()=>${NOW}});
        const observation = ${JSON.stringify(observation())};
        if (${JSON.stringify(point)} === 'claim') { producer.admit(observation); process.kill(process.pid,'SIGKILL'); }
        else await producer.observe(observation);
      `;
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
        env: { PATH: process.env['PATH'], LANG: 'C', NODE_NO_WARNINGS: '1' },
      });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      assert.throws(() => f.reopen(), /writer lock/);
      // Test-only offline clearance AFTER waitpid proved this child dead.
      // Runtime never steals a lock based on PID, mtime or elapsed time.
      rmSync(join(f.root, '.writer-lock'), { recursive: true });
      f.reopen(); f.setClock(NOW + 60_000);
      const result = (await f.producer.recover())[0]!;
      assert.equal(result.state, point === 'claim' ? 'completed' : 'unknown');
      assert.equal(f.calls.length, point === 'claim' ? MARKET_OPEN_POLICY.roster.length : 0);
      const snapshot = f.producer.snapshot();
      assert.equal(snapshot.reservedUsdMicros, RESERVATION);
      assert.equal(snapshot.fires[0]!.claim.preparation.observedAt, OBSERVED);
      if (point === 'send') {
        assert.equal(snapshot.fires[0]!.attempts[0]!.finishedAt, null);
        assert.equal(snapshot.fires[0]!.attempts[0]!.costUsdMicros, null);
        assert.ok(snapshot.halted);
        assert.equal((await f.producer.observe(observation())).state, 'unknown');
        assert.equal((await f.producer.observe(observation('total'))).state, 'refused');
        assert.equal(f.calls.length, 0);
      }
    } finally { await f.cleanup(); }
  });
}
