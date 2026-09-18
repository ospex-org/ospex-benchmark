import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { withMarketOpenEvidenceAdmission } from './marketOpenEvidence.js';
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalize } from './canonical.js';
import { createMarketOpenEvidenceFixture, MARKET_OPEN_FIXTURE_GAME_ID } from './testFixtures/marketOpenEvidenceFixture.js';
import { discoverScoreableMarketOpenRuns, runMarketOpenDiscoveryCli } from './discoverMarketOpenMain.js';
import { readRunArtifactFile } from './runArtifactInput.js';
import { MARKET_OPEN_DAILY_BUDGET_POLICY, MARKET_OPEN_DAILY_BUDGET_POLICY_SHA256 } from './marketOpenDailyBudget.js';
import { readMarketOpenStore } from './marketOpenStore.js';
import { spendReservationPolicyForVersion } from './spendReservationPolicy.js';
import { MARKET_OPEN_POLICY } from './marketOpen.js';
import { aggregateByParticipant, isMarketOpenSourceRun, parseRunRecords, scoredRecords, scoreRun, verifyRunIntegrity } from './scoring.js';
import type { SourceRun } from './scoring.js';
import { runScoreCli } from './scoreRun.js';
import { publishableRun } from './servingProjection.js';
import { publishableScoredRun } from './scoredProjection.js';
import { publishRunArtifact, publishScoredArtifact } from './servingPublisher.js';
import type { BenchmarkServingPort } from './servingStore.js';
import { hasMarketOpenProvenance, MARKET_OPEN_SQL_PUBLICATION_BLOCKED } from './marketOpenPublication.js';
import { marketOpenTimingForPick } from './marketOpenScoreTiming.js';
import type { ClosingLineRow, MarketKey } from './types.js';

const posix = process.platform === 'win32' ? { skip: 'real B2 fixture requires POSIX durable store' } : {};
const ladder = { k: 8.101061957791782, parameterVersion: 'TOTALS_V1_PROVISIONAL' };
const scoredAt = '2026-09-11T01:00:00.000Z';
for (const daily of [false, true]) test(`one root replay and artifact read across every phase (${daily ? 'daily' : 'cohort'})`, posix, async (t) => {
  const fixture = await createMarketOpenEvidenceFixture({ markets: ['moneyline', 'total'],
    ...(daily ? { dailyBudgetCapUsdMicros: 60_000_000 } : {}) });
  const build = () => {
    const descriptors = discoverScoreableMarketOpenRuns(fixture.root);
    assert.equal(descriptors.length, 2);
    return descriptors.map(d => {
      const run = load(d.artifactPath, fixture.root);
      assert.deepEqual(verifyRunIntegrity(run), []);
      const picks = scoreRun(run, [marketOpenScoringClose(d.market)], ladder);
      return scoredRecords(run, picks, aggregateByParticipant(picks, run, ladder), scoredAt, ladder).map(canonicalize).join('\n');
    });
  };
  try {
    const expected = build();
    const originalRead = fs.readFileSync, originalOpen = fs.openSync;
    let admissions = 0;
    const artifactReads = new Map<string, number>();
    const readSpy = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === join(fixture.root, 'config.json')) admissions++;
      return originalRead(...args);
    });
    const openSpy = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      const path = String(args[0]);
      if (fixture.artifactPaths.includes(path)) artifactReads.set(path, (artifactReads.get(path) ?? 0) + 1);
      return originalOpen(...args);
    });
    syncBuiltinESMExports();
    try {
      for (let pass = 1; pass <= 2; pass++) {
        await withMarketOpenEvidenceAdmission(async () => {
          assert.equal(discoverScoreableMarketOpenRuns(fixture.root).length, 2);
          await Promise.resolve(); // Scope survives real async separation of phases.
          assert.deepEqual(withMarketOpenEvidenceAdmission(build), expected);
          assert.equal(admissions, pass, 'exactly one root admission per invocation, including nested discovery');
          assert.deepEqual([...artifactReads.values()], [pass, pass], 'every installed artifact verified once');
        });
      }
    } finally { readSpy.mock.restore(); openSpy.mock.restore(); syncBuiltinESMExports(); }
  } finally { await fixture.cleanup(); }
});

test('invocation retains verified bytes, not later disk contents; next invocation rejects corruption', posix, async () => {
  const fixture = await createMarketOpenEvidenceFixture({ markets: ['moneyline', 'total'] });
  try {
    await withMarketOpenEvidenceAdmission(async () => {
      const [target, sibling] = discoverScoreableMarketOpenRuns(fixture.root);
      const run = load(target!.artifactPath, fixture.root);
      const before = readRunArtifactFile(target!.artifactPath, { marketOpenEvidenceRoot: fixture.root });
      writeFileSync(target!.artifactPath, 'corrupt');
      writeFileSync(sibling!.artifactPath, 'also corrupt');
      await Promise.resolve();
      assert.equal(readRunArtifactFile(target!.artifactPath, { marketOpenEvidenceRoot: fixture.root }).text, before.text);
      assert.deepEqual(verifyRunIntegrity(run), []);
      run.sourceRecords = [{ ...run.sourceRecords![0], runId: 'forged' }, ...run.sourceRecords!.slice(1)];
      assert.notDeepEqual(verifyRunIntegrity(run), [], 'caller records remain bound to verified bytes');
    });
    assert.throws(() => withMarketOpenEvidenceAdmission(() => discoverScoreableMarketOpenRuns(fixture.root)), /SHA|shape/);
  } finally { await fixture.cleanup(); }
});

test('reading one artifact still verifies a corrupt sibling; no capability persists after settlement', posix, async () => {
  const fixture = await createMarketOpenEvidenceFixture({ markets: ['moneyline', 'total'] });
  try {
    const run = withMarketOpenEvidenceAdmission(() => load(fixture.artifactPaths[0]!, fixture.root));
    writeFileSync(fixture.artifactPaths[1]!, 'corrupt sibling');
    assert.notDeepEqual(verifyRunIntegrity(run), []);
    assert.throws(() => withMarketOpenEvidenceAdmission(() => load(fixture.artifactPaths[0]!, fixture.root)), /SHA|shape/);
  } finally { await fixture.cleanup(); }
});

test('independent overlapping async invocations and failed invocations never share admissions', posix, async (t) => {
  const fixture = await createMarketOpenEvidenceFixture({ markets: ['moneyline', 'total'] });
  const original = fs.readFileSync;
  let admissions = 0;
  const spy = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === join(fixture.root, 'config.json')) admissions++;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const first = withMarketOpenEvidenceAdmission(async () => {
      discoverScoreableMarketOpenRuns(fixture.root);
      await blocked;
      discoverScoreableMarketOpenRuns(fixture.root);
    });
    await withMarketOpenEvidenceAdmission(async () => {
      discoverScoreableMarketOpenRuns(fixture.root);
      await Promise.resolve();
      discoverScoreableMarketOpenRuns(fixture.root);
    });
    release(); await first;
    assert.equal(admissions, 2);
    assert.throws(() => withMarketOpenEvidenceAdmission(() => {
      discoverScoreableMarketOpenRuns(fixture.root); throw new Error('sync failure');
    }), /sync failure/);
    await assert.rejects(withMarketOpenEvidenceAdmission(async () => {
      discoverScoreableMarketOpenRuns(fixture.root); await Promise.resolve(); throw new Error('async failure');
    }), /async failure/);
    withMarketOpenEvidenceAdmission(() => discoverScoreableMarketOpenRuns(fixture.root));
    assert.equal(admissions, 5);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); await fixture.cleanup(); }
});

for (const costEvidence of [undefined, 'unknown', 'above-estimate'] as const) {
  test(`daily producer artifact discovers, scores and projects ${costEvidence ?? 'known'} spend without legacy admission`, posix, async () => {
    const fixture = await createMarketOpenEvidenceFixture({ dailyBudgetCapUsdMicros: 60_000_000,
      repair: true, ...(costEvidence === undefined ? {} : { costEvidence }) });
    try {
      assert.equal(fixture.results[0]!.state, 'completed');
      const [descriptor] = discoverScoreableMarketOpenRuns(fixture.root);
      assert.ok(descriptor);
      assert.throws(() => readRunArtifactFile(descriptor.artifactPath), /evidence-root/);
      const run = load(descriptor.artifactPath, fixture.root), evidence = run.marketOpenEvidence!;
      assert.deepEqual(verifyRunIntegrity(run), []);
      const artifact = JSON.parse(readFileSync(descriptor.artifactPath, 'utf8'));
      assert.equal(artifact.version, 'market-open-daily-produced-v1');
      assert.deepEqual(artifact.admissionPolicy, MARKET_OPEN_DAILY_BUDGET_POLICY);
      assert.equal(artifact.admissionPolicySha256, MARKET_OPEN_DAILY_BUDGET_POLICY_SHA256);
      assert.equal(evidence.fire.claim.reservationUsdMicros, evidence.prepared.provenance.reservationUsdMicros,
        'historical preparation reserve remains provenance, not daily spend authority');
      const picks = scoreRun(run, [marketOpenScoringClose('moneyline')], ladder);
      const stats = aggregateByParticipant(picks, run, ladder);
      const rows = scoredRecords(run, picks, stats, scoredAt, ladder);
      assert.equal(rows.filter((r) => r.recordType === 'scored_decision' && r.kind === 'model').length, MARKET_OPEN_POLICY.roster.length);
      const projected = rows[0]!.marketOpen as Record<string, any>;
      assert.equal(projected.admissionPolicySha256, MARKET_OPEN_DAILY_BUDGET_POLICY_SHA256);
      assert.deepEqual(projected.admissionPolicy, MARKET_OPEN_DAILY_BUDGET_POLICY);
      assert.equal(projected.cost.knownCostUsdMicros, evidence.fire.knownCostUsdMicros);
      assert.equal(projected.cost.attempts.length, evidence.fire.attempts.length);
      for (const [i, attempt] of evidence.fire.attempts.entries()) {
        assert.equal(projected.cost.attempts[i].costUsdMicros, attempt.costUsdMicros);
        assert.deepEqual(projected.cost.attempts[i].spend, (attempt.evidence as { spend: unknown }).spend);
      }
      const target = projected.cost.attempts.filter((a: Record<string, any>) => a.armId === MARKET_OPEN_POLICY.roster[0]!.participantId);
      assert.equal(target.length, 2, 'daily repair evidence is retained');
      if (costEvidence === 'unknown') assert(target.every((a: Record<string, any>) => a.costUsdMicros === null && a.spend.unknownCost === true));
      if (costEvidence === 'above-estimate') {
        const legacyCap = spendReservationPolicyForVersion(MARKET_OPEN_POLICY.spendReservationPolicyVersion).providerAttemptReservationUsdMicros;
        assert(target.every((a: Record<string, any>) => a.costUsdMicros > legacyCap && a.spend.aboveEstimate === true));
      }
      assert.deepEqual(scoredRecords(load(descriptor.artifactPath, fixture.root), picks, stats, scoredAt, ladder), rows);
      assert.deepEqual(publishableScoredRun(rows), { publishable: false, reason: MARKET_OPEN_SQL_PUBLICATION_BLOCKED });
    } finally { await fixture.cleanup(); }
  });
}

test('shared daily ledger discovers and builds each artifact with its preparation cohort, not genesis metadata', posix, async () => {
  const fixture = await createMarketOpenEvidenceFixture({ dailyBudgetCapUsdMicros: 60_000_000,
    name: 'daily-first', additionalCohortNames: ['daily-second'], markets: ['moneyline', 'total'], failedArm: true });
  try {
    const genesis = readMarketOpenStore(fixture.root).config;
    assert.equal(genesis.name, 'daily-first');
    const descriptors = discoverScoreableMarketOpenRuns(fixture.root);
    assert.equal(descriptors.length, 4);
    assert.equal(new Set(descriptors.map((d) => d.cohortId)).size, 2);
    for (const descriptor of descriptors) {
      const run = load(descriptor.artifactPath, fixture.root), evidence = run.marketOpenEvidence!;
      assert.equal(descriptor.cohortId, evidence.prepared.cohort.cohortId);
      assert.equal(run.cohortId, evidence.prepared.provenance.event.cohortId);
      assert.equal(descriptor.status, 'failed');
      const picks = scoreRun(run, [marketOpenScoringClose(descriptor.market)], ladder);
      const stats = aggregateByParticipant(picks, run, ladder);
      assert.equal(stats.filter((s) => s.kind === 'model').length, MARKET_OPEN_POLICY.roster.length);
      assert.equal(stats.find((s) => s.kind === 'model' && s.validDecisions === 0)!.eligibleMarkets, 1);
      const rows = scoredRecords(run, picks, stats, scoredAt, ladder);
      assert.equal(rows[0]!.cohortId, descriptor.cohortId);
      if (evidence.prepared.cohort.name === 'daily-second') assert.notEqual(descriptor.cohortId, genesis.cohortId);
    }
    assert.deepEqual(discoverScoreableMarketOpenRuns(fixture.root), descriptors, 'no changes on replay');
  } finally { await fixture.cleanup(); }
});
export function marketOpenScoringClose(market: MarketKey): ClosingLineRow {
  return { network: 'polygon', jsonodds_id: MARKET_OPEN_FIXTURE_GAME_ID, market,
    line: market === 'moneyline' ? null : 8.5, away_odds_decimal: 2, home_odds_decimal: 2,
    away_p_novig: 0.5, home_p_novig: 0.5, value_captured_at: '2026-09-10T19:59:40.000Z',
    lock_time: '2026-09-10T20:00:00.000Z', last_polled_at: '2026-09-10T19:59:45.000Z',
    poll_gap_seconds: 15, confidence: 'fresh', source: 'reference' };
}
function load(path: string, root: string) {
  const input = readRunArtifactFile(path, { marketOpenEvidenceRoot: root });
  return parseRunRecords(input.text.split(/\r?\n/), { marketOpenEvidence: input.marketOpenEvidence });
}

for (const market of ['moneyline', 'total'] as const) {
  test(`market-open ${market}: exact singleton denominators, old opener and lag label every scored row`, posix, async () => {
    const fixture = await createMarketOpenEvidenceFixture({ market,
      openerCapturedAt: '2026-09-05T11:00:00.000Z', sendAt: '2026-09-10T18:05:00.000Z' });
    try {
      assert.equal(fixture.artifactPaths.length, 1);
      const run = load(fixture.artifactPaths[0]!, fixture.root);
      assert.deepEqual(verifyRunIntegrity(run), []);
      assert.equal(run.picks.filter((p) => p.kind === 'model').length, 4);
      const picks = scoreRun(run, [marketOpenScoringClose(market)], ladder);
      const stats = aggregateByParticipant(picks, run, ladder);
      for (const arm of stats.filter((s) => s.kind === 'model')) {
        assert.equal(arm.games, 1); assert.equal(arm.eligibleMarkets, 1);
        assert.equal(arm.validDecisions, 1); assert.equal(arm.primaryScoreable, 1);
        assert.equal(arm.byMarket[market]!.eligible, 1);
        for (const sibling of ['moneyline', 'spread', 'total'].filter((m) => m !== market)) assert.equal(arm.byMarket[sibling]?.eligible ?? 0, 0);
      }
      const rows = scoredRecords(run, picks, stats, scoredAt, ladder);
      const decisions = rows.filter((r) => r.recordType === 'scored_decision');
      assert.equal(decisions.length, run.picks.length, 'no age or lag exclusion');
      assert.equal(rows[0]!.sourceClockMode, 'wall');
      assert.equal((rows[0]!.marketOpen as Record<string, unknown>).artifactSha256, run.marketOpenEvidence!.artifactSha256);
      for (const row of decisions) {
        const timing = row.marketOpenTiming as Record<string, unknown>;
        assert.equal(timing.version, 'market-open-score-timing-v1');
        assert.equal(timing.market, market);
        assert.equal(timing.eventId, run.marketOpenEvidence!.prepared.provenance.event.eventId);
        assert.equal(timing.openerAgeAtFirstObservationMs, Date.parse('2026-09-10T14:05:00.000Z') - Date.parse('2026-09-05T11:00:00.000Z'));
        assert.equal(timing.observationToSendLagMs, row.kind === 'model' ? 4 * 60 * 60 * 1000 : null);
        assert.equal(timing.sendAt, row.kind === 'model' ? '2026-09-10T18:05:00.000Z' : null);
      }
      assert.deepEqual(scoredRecords(run, scoreRun(run, [marketOpenScoringClose(market)], ladder), stats, scoredAt, ladder), rows, 'replay preserves source timing and scoring bytes');
    } finally { await fixture.cleanup(); }
  });
}

test('market-open timing uses the selected repair send, not the initial send or a sibling arm', posix, async () => {
  const fixture = await createMarketOpenEvidenceFixture({ repair: true, attemptStepMs: 1000 });
  try {
    const run = load(fixture.artifactPaths[0]!, fixture.root), evidence = run.marketOpenEvidence!;
    const picks = scoreRun(run, [marketOpenScoringClose('moneyline')], ladder);
    const rows = scoredRecords(run, picks, aggregateByParticipant(picks, run, ladder), scoredAt, ladder);
    const repaired = rows.find((r) => r.recordType === 'scored_decision' && r.kind === 'model' && r.attemptUsed === 'repair');
    assert.ok(repaired);
    const send = (role: string) => (evidence.fire.attempts.find((a) => a.slot.armId === repaired.participantId && a.slot.role === role)!.evidence as { attempt: { requestAt: string } }).attempt.requestAt;
    assert(Date.parse(send('repair')) > Date.parse(send('initial')), 'fixture distinguishes actual legs');
    const timing = repaired.marketOpenTiming as Record<string, unknown>;
    assert.equal(timing.sendAt, send('repair'));
    assert.equal(timing.observationToSendLagMs, Date.parse(send('repair')) - Date.parse('2026-09-10T14:05:00.000Z'));
  } finally { await fixture.cleanup(); }
});

test('completed failed arm remains in discovery and per-market denominators', posix, async () => {
  const fixture = await createMarketOpenEvidenceFixture({ markets: ['moneyline', 'total'], failedArm: true });
  try {
    const discovered = discoverScoreableMarketOpenRuns(fixture.root);
    assert.equal(discovered.length, 2);
    assert.equal(new Set(discovered.map((r) => r.market)).size, 2);
    const printed: string[] = [];
    runMarketOpenDiscoveryCli(['--evidence-root', fixture.root], (line) => printed.push(line));
    assert.deepEqual(printed.map((line) => JSON.parse(line)), discovered);
    for (const item of discovered) {
      const run = load(item.artifactPath, fixture.root);
      assert.deepEqual(verifyRunIntegrity(run), []);
      const picks = scoreRun(run, [marketOpenScoringClose(item.market)], ladder);
      const stats = aggregateByParticipant(picks, run, ladder);
      const failed = stats.find((s) => s.kind === 'model' && s.validDecisions === 0);
      assert.ok(failed, 'failed model is not dropped');
      assert.equal(failed.eligibleMarkets, 1); assert.equal(failed.games, 1); assert.equal(failed.primaryScoreable, 0);
      assert.equal(failed.byMarket[item.market]!.eligible, 1);
      assert.equal(Object.values(failed.armOutcomes).reduce((a, b) => a + b, 0), 1);
      assert.equal(stats.filter((s) => s.kind === 'model').length, 4);
    }
  } finally { await fixture.cleanup(); }
});

test('installed or extracted market-open records require exact completed evidence before scoring', posix, async () => {
  const fixture = await createMarketOpenEvidenceFixture({ repair: true });
  const tmp = mkdtempSync(join(tmpdir(), 'market-open-score-input-'));
  try {
    const path = fixture.artifactPaths[0]!;
    assert.throws(() => readRunArtifactFile(path), /evidence-root/);
    const input = readRunArtifactFile(path, { marketOpenEvidenceRoot: fixture.root });
    const extracted = join(tmp, 'run.ndjson'); writeFileSync(extracted, input.text);
    assert.throws(() => readRunArtifactFile(extracted), /evidence-root/);
    assert.deepEqual(load(extracted, fixture.root).picks, load(path, fixture.root).picks);
    const detached = parseRunRecords(input.text.split(/\r?\n/));
    assert(verifyRunIntegrity(detached).some((v) => v.includes('market-open')));
    assert.throws(() => scoreRun(detached, [], ladder), /market-open/);
    assert.throws(() => scoredRecords(detached, [], [], scoredAt, ladder), /market-open/);
    const run = load(path, fixture.root);
    const model = run.picks.find((p) => p.kind === 'model'); assert.ok(model);
    model.selection = 'tampered-side';
    assert(verifyRunIntegrity(run).some((v) => v.includes('differs from its evidence')));
    const edited = input.text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    edited.find((r) => r.recordType === 'run_meta').clockMode = 'simulated';
    writeFileSync(extracted, edited.map((r) => canonicalize(r)).join('\n'));
    assert.throws(() => load(extracted, fixture.root), /market-open/);
  } finally { await fixture.cleanup(); rmSync(tmp, { recursive: true, force: true }); }
});

test('scorer CLI refuses detached market-open evidence before closes or publication', posix, async () => {
  const fixture = await createMarketOpenEvidenceFixture();
  const previous = { url: process.env['SUPABASE_URL'], key: process.env['SUPABASE_ANON_KEY'] };
  process.env['SUPABASE_URL'] = 'https://example.invalid'; process.env['SUPABASE_ANON_KEY'] = 'synthetic-public-config';
  let closeReads = 0; let writes = 0;
  try {
    await assert.rejects(runScoreCli(['--run', fixture.artifactPaths[0]!, '--publish'], {
      fetchCloses: async () => { closeReads++; throw new Error('must not read closes'); },
      openServing: async () => { writes++; throw new Error('must not open serving'); },
      publishScored: async () => { writes++; throw new Error('must not publish'); },
      printLine() {}, printError() {},
    }), /evidence-root/);
    assert.equal(closeReads, 0); assert.equal(writes, 0);
  } finally {
    if (previous.url === undefined) delete process.env['SUPABASE_URL']; else process.env['SUPABASE_URL'] = previous.url;
    if (previous.key === undefined) delete process.env['SUPABASE_ANON_KEY']; else process.env['SUPABASE_ANON_KEY'] = previous.key;
    await fixture.cleanup();
  }
});

test('market-open artifacts retain replay, cost, status and hashes while SQL publication stays blocked', posix, async () => {
  const fixture = await createMarketOpenEvidenceFixture({ markets: ['moneyline', 'total'], repair: true });
  const dir = mkdtempSync(join(tmpdir(), 'market-open-publication-'));
  let calls = 0;
  const port = new Proxy({}, { get() { calls++; throw new Error('SQL must not be reached'); } }) as BenchmarkServingPort;
  try {
    for (const path of fixture.artifactPaths) {
      const run = load(path, fixture.root), evidence = run.marketOpenEvidence!;
      const market = evidence.prepared.provenance.event.market as 'moneyline' | 'total';
      const picks = scoreRun(run, [marketOpenScoringClose(market)], ladder);
      const stats = aggregateByParticipant(picks, run, ladder);
      const records = scoredRecords(run, picks, stats, scoredAt, ladder);
      assert.deepEqual(scoredRecords(load(path, fixture.root), picks, stats, scoredAt, ladder), records, 'deterministic replay');
      const meta = records[0]!.marketOpen as { artifactSha256: string; status: string; cost: { version: string; priceVersion: string; knownCostUsdMicros: number; attempts: Array<{ armId: string; role: string; costUsdMicros: number }> } };
      assert.equal(meta.artifactSha256, evidence.artifactSha256);
      assert.equal(meta.status, evidence.fire.status);
      assert.equal(meta.cost.version, 'market-open-scored-cost-v1'); assert.ok(meta.cost.priceVersion);
      assert.equal(meta.cost.knownCostUsdMicros, evidence.fire.knownCostUsdMicros);
      assert.equal(meta.cost.knownCostUsdMicros, meta.cost.attempts.reduce((sum, a) => sum + a.costUsdMicros, 0));
      assert.equal(meta.cost.attempts.filter((a) => a.role === 'repair').length, 1);
      assert(meta.cost.attempts.some((a) => a.role === 'initial' && a.costUsdMicros > 0));
      assert(meta.cost.attempts.some((a) => a.role === 'repair' && a.costUsdMicros > 0));
      assert.deepEqual(publishableRun(fixture.artifacts.find((a) => a.records[0]!.runId === run.runId)!.records),
        { publishable: false, reason: MARKET_OPEN_SQL_PUBLICATION_BLOCKED });
      assert.deepEqual(publishableScoredRun(records), { publishable: false, reason: MARKET_OPEN_SQL_PUBLICATION_BLOCKED });
      const scoredFile = join(dir, `${market}.scored.ndjson`);
      writeFileSync(scoredFile, records.map((r) => canonicalize(r)).join('\n') + '\n');
      for (let replay = 0; replay < 2; replay++) {
        assert.equal((await publishScoredArtifact(port, scoredFile, { line() {}, error() {} })).gateRefusal, MARKET_OPEN_SQL_PUBLICATION_BLOCKED);
        assert.ok((await publishRunArtifact(port, path, { line() {}, error() {} })).gateRefusal);
      }
    }
    assert.equal(calls, 0);
  } finally { await fixture.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('market-open score CLI writes every completed score but never opens SQL when publication is requested', posix, async () => {
  const fixture = await createMarketOpenEvidenceFixture({ repair: true });
  const dir = mkdtempSync(join(tmpdir(), 'market-open-cli-'));
  const previous = { url: process.env['SUPABASE_URL'], key: process.env['SUPABASE_ANON_KEY'] };
  process.env['SUPABASE_URL'] = 'https://example.invalid'; process.env['SUPABASE_ANON_KEY'] = 'synthetic-public-config';
  let reads = 0, calls = 0; const errors: string[] = [];
  try {
    const code = await runScoreCli(['--run', fixture.artifactPaths[0]!, '--evidence-root', fixture.root, '--out', dir, '--publish'], {
      fetchCloses: async () => { reads++; return [marketOpenScoringClose('moneyline')]; },
      openServing: async () => { calls++; assert.fail('SQL must not be opened'); },
      publishScored: async () => { calls++; assert.fail('SQL must not be published'); },
      printLine() {}, printError: (s) => { errors.push(s); },
    });
    assert.equal(code, 1); assert.equal(reads, 1); assert.equal(calls, 0);
    assert(errors.includes(MARKET_OPEN_SQL_PUBLICATION_BLOCKED));
    const scoredFiles = readdirSync(dir).filter((f) => f.endsWith('-scored.ndjson'));
    assert.equal(scoredFiles.length, 1);
    const rows = readFileSync(join(dir, scoredFiles[0]!), 'utf8').trim().split('\n').map((s) => JSON.parse(s));
    assert.equal(rows.filter((r) => r.recordType === 'scored_decision' && r.kind === 'model').length, 4);
    assert.equal(rows[0].sourceMode, 'live'); assert.equal(rows[0].sourceClockMode, 'wall');
  } finally {
    if (previous.url === undefined) delete process.env['SUPABASE_URL']; else process.env['SUPABASE_URL'] = previous.url;
    if (previous.key === undefined) delete process.env['SUPABASE_ANON_KEY']; else process.env['SUPABASE_ANON_KEY'] = previous.key;
    await fixture.cleanup(); rmSync(dir, { recursive: true, force: true });
  }
});

test('market-open scorer refuses output within its immutable evidence root before close reads', posix, async () => {
  const fixture = await createMarketOpenEvidenceFixture();
  const aliases = mkdtempSync(join(tmpdir(), 'market-open-output-alias-'));
  const alias = join(aliases, 'root'); symlinkSync(fixture.root, alias, 'dir');
  const previous = { url: process.env['SUPABASE_URL'], key: process.env['SUPABASE_ANON_KEY'] };
  process.env['SUPABASE_URL'] = 'https://example.invalid'; process.env['SUPABASE_ANON_KEY'] = 'synthetic-public-config';
  let calls = 0;
  try {
    for (const args of [[], ['--out', fixture.root], ['--out', join(fixture.root, 'new', 'nested')], ['--out', join(alias, 'derived')]]) {
      await assert.rejects(runScoreCli(['--run', fixture.artifactPaths[0]!, '--evidence-root', fixture.root, ...args], {
        fetchCloses: async () => { calls++; throw new Error('must not read closes'); },
        openServing: async () => { calls++; throw new Error('must not open serving'); },
        publishScored: async () => { calls++; throw new Error('must not publish'); },
        printLine() {}, printError() {},
      }), /outside the evidence root/);
    }
    assert.equal(calls, 0);
  } finally {
    if (previous.url === undefined) delete process.env['SUPABASE_URL']; else process.env['SUPABASE_URL'] = previous.url;
    if (previous.key === undefined) delete process.env['SUPABASE_ANON_KEY']; else process.env['SUPABASE_ANON_KEY'] = previous.key;
    await fixture.cleanup(); rmSync(aliases, { recursive: true, force: true });
  }
});

test('legacy NDJSON loader preserves exact text without an evidence root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-score-input-'));
  try { const path = join(dir, 'run.ndjson'); const text = '{"recordType":"run_meta","runId":"legacy"}\r\n';
    writeFileSync(path, text); assert.deepEqual(readRunArtifactFile(path), { text });
    assert.equal(readFileSync(path, 'utf8'), text);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const field of ['gameId', 'market'] as const) test(`market-open scored timing requires pick ${field} identity`, posix, async () => {
  const fixture = await createMarketOpenEvidenceFixture();
  try {
    const run = load(fixture.artifactPaths[0]!, fixture.root), pick = run.picks.find((p) => p.kind === 'model')!;
    assert.throws(() => marketOpenTimingForPick(run.marketOpenEvidence!, { ...pick, [field]: field === 'market' ? 'total' : 'foreign' }), /timing pick identity mismatch/);
  } finally { await fixture.cleanup(); }
});

test('market-open detection shares every marker across loading scoring and publication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'market-open-markers-'));
  try {
    const path = join(dir, 'run.ndjson');
    for (const marker of [{ runId: 'market-open-v1-test' }, { cohortId: 'market-open-v1-test' },
      { marketOpen: {} }, { marketOpenTiming: {} }, { marketOpenEvidence: {} }]) {
      assert.equal(hasMarketOpenProvenance(marker), true, JSON.stringify(marker));
      // A marker-only object is not a valid run; these probes isolate detection.
      assert.equal(isMarketOpenSourceRun({ runId: 'legacy', cohortId: 'legacy', ...marker } as unknown as SourceRun), true);
      writeFileSync(path, JSON.stringify({ recordType: 'run_meta', ...marker }) + '\n');
      assert.throws(() => readRunArtifactFile(path), /market-open input requires --evidence-root/);
      assert.deepEqual(publishableScoredRun([{ recordType: 'scored_run_meta', ...marker }]),
        { publishable: false, reason: MARKET_OPEN_SQL_PUBLICATION_BLOCKED });
    }
    assert.equal(hasMarketOpenProvenance({ runId: 'legacy', marketOpenEvidence: undefined }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const [field, value] of [['mode', 'dry-run'], ['clockMode', 'fixture']] as const) test(`market-open parsed scorer independently requires ${field}`, posix, async () => {
  const fixture = await createMarketOpenEvidenceFixture();
  try {
    const run = load(fixture.artifactPaths[0]!, fixture.root);
    Object.assign(run, { [field]: value });
    const integrity = verifyRunIntegrity(run);
    assert.ok(integrity.length > 0);
    assert.match(integrity.join('\n'), /market-open scoring requires live mode and wall clock/);
  } finally { await fixture.cleanup(); }
});
