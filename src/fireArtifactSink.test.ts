import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import { cohortBoot } from './cohortBoot.js';
import { evaluateCandidate } from './detection.js';
import { MARKET_ORDINAL } from './fireArtifact.js';
import { buildFireArtifact } from './fireArtifactProducer.js';
import type { FireContext, MarketFireContextV1 } from './fireArtifactProducer.js';
import { FireArtifactSink, nodeArtifactFs } from './fireArtifactSink.js';
import type { ArtifactFs, SinkOwners } from './fireArtifactSink.js';
import { parseFireArtifactV1, serializeFireArtifactV1, verifyFireArtifactReplay } from './fireArtifactWriter.js';
import { checkPublication } from './manifestPublication.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { promptScaffoldSha256 } from './prompt.js';
import { runSlate } from './runner.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import { SMOKE_LABEL } from './types.js';
import type { BootedCohort } from './cohortBoot.js';
import type { CandidateInput } from './detection.js';
import type { FireArtifactV1 } from './fireArtifactProducer.js';
import type { PublicationVerified } from './manifestPublication.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { RunEnvelope } from './runner.js';
import type { GameRequest } from './bundle.js';
import type {
  ArmSpec,
  BenchmarkResponse,
  ForecastOutput,
  GameBundle,
  MarketKey,
  ProviderAdapter,
  ProviderName,
  ProviderResponse,
  SlateBundle,
} from './types.js';

/**
 * The durable fire-artifact sink. Every test drives a REAL produced `FireArtifactV1`
 * through `buildFireArtifact` (unless a row explicitly probes a structural forgery), a
 * recording/stateful fake `ArtifactFs` for deterministic order/failure witnesses, and a real
 * temporary directory for the production-adapter integration. The sink requires a sha256
 * `fireId` (the producer only requires nonEmpty), so the fixtures build the fire with one.
 */

const GAME_ID = '00000000-0000-4000-8000-0000000000f1';
const CUTOFF = '2026-07-18T20:00:00+00:00';
const WINDOW_START = '2026-07-18T00:00:00.000Z';
const WINDOW_END = '2026-07-19T00:00:00.000Z';
const BUNDLE_TS = '2026-07-18T12:00:00.000Z';
const DETECTED_AT = '2026-07-18T12:00:30.000Z';
const OPENER_AT = '2026-07-18T11:59:30.000Z';
const OBSERVED_AT = '2026-07-18T11:58:00+00:00';
const BUNDLE_BUILT_AT = '2026-07-18T12:00:31.000Z';
const COMMITTER_TS = '2026-07-17T23:00:00+00:00';
const NOW_MS = Date.parse('2026-07-18T12:00:40.000Z');
const W = 120_000;
const SKEW = 5_000;
const AWAY_TEAM = 'Milwaukee Brewers';
const FIRE_ID = sha256Hex('fire-artifact-sink-fixture'); // a genuine 64-hex path-forming id
const RUN_ID = sha256Hex('run-artifact-sink-fixture');

const CODE_ARMS = defaultExpectedArms();
const ARMS: ArmSpec[] = CODE_ARMS.map((a) => ({
  participantId: a.participantId,
  provider: a.provider as ProviderName,
  requestedModelId: a.requestedModelId,
  credentialEnvVar: `${a.participantId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_KEY`,
}));

// --- fixtures (a real produced fire, adapted to a sha256 fireId) -------------

function scopedGame(markets: readonly MarketKey[], awayTeam = AWAY_TEAM): GameBundle {
  const m: GameBundle['markets'] = {};
  if (markets.includes('moneyline')) {
    m.moneyline = { awayDecimal: 1.74627, homeDecimal: 2.17, observedAt: OBSERVED_AT, evidenceRef: `ev:${GAME_ID}:moneyline` };
  }
  if (markets.includes('total')) {
    m.total = { line: 8.5, overDecimal: 1.90909, underDecimal: 1.90909, observedAt: OBSERVED_AT, evidenceRef: `ev:${GAME_ID}:total` };
  }
  return {
    gameId: GAME_ID,
    league: 'mlb',
    scheduledStartUtc: CUTOFF,
    awayTeam,
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: m,
    evidenceRefs: [`ev:${GAME_ID}:identity`, `ev:${GAME_ID}:schedule`, `ev:${GAME_ID}:moneyline`, `ev:${GAME_ID}:total`],
  };
}

function scopedRequest(markets: readonly MarketKey[], awayTeam = AWAY_TEAM): GameRequest {
  const game = scopedGame(markets, awayTeam);
  const requestBundle: SlateBundle = {
    schemaVersion: 1,
    label: SMOKE_LABEL,
    league: 'mlb',
    slateDate: '2026-07-18',
    bundleTimestamp: BUNDLE_TS,
    cutoffAt: CUTOFF,
    games: [game],
  };
  return { gameId: GAME_ID, slug: 'mil-pit-2026-07-18', game, requestBundle, requestSha256: sha256Hex(canonicalize(requestBundle)) };
}

function scopedResponse(req: GameRequest, arm: ArmSpec, cohortId: string): BenchmarkResponse {
  const game = req.game;
  const forecasts: ForecastOutput[] = [];
  if (game.markets.moneyline) {
    const ml = game.markets.moneyline;
    forecasts.push({
      market: 'moneyline',
      selection: game.awayTeam,
      line: null,
      observedDecimal: ml.awayDecimal,
      probabilities: { win: 0.55, push: 0, loss: 0.45 },
      confidence: 0.6,
      wouldAbstain: false,
      selectedForExecution: true,
      rationale: 'Reference prices favor the away side.',
      evidenceRefs: [ml.evidenceRef],
      reasonCode: null,
    });
  }
  if (game.markets.total) {
    const total = game.markets.total;
    forecasts.push({
      market: 'total',
      selection: 'over',
      line: total.line,
      observedDecimal: total.overDecimal,
      probabilities: { win: 0.5, push: 0, loss: 0.5 },
      confidence: 0.5,
      wouldAbstain: false,
      selectedForExecution: true,
      rationale: 'Total priced evenly at the designated line.',
      evidenceRefs: [total.evidenceRef],
      reasonCode: null,
    });
  }
  return {
    schemaVersion: 1,
    cohortId,
    participantId: arm.participantId,
    requestedModelId: arm.requestedModelId,
    bundleSha256: req.requestSha256,
    executionPolicy: 'fixed-moneyline-total',
    games: [{ gameId: game.gameId, forecasts }],
  };
}

function stubResponse(rawText: string, reportedModelId: string): ProviderResponse {
  return {
    rawText,
    reportedModelId,
    providerResponseId: 'stub-response',
    httpStatus: 200,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    usageRaw: { prompt_tokens: 100, completion_tokens: 50 },
    requestParams: { stub: true },
  };
}

function stubAdapter(arm: ArmSpec, handler: () => ProviderResponse): ProviderAdapter {
  return {
    provider: arm.provider,
    requestedModelId: arm.requestedModelId,
    credentialEnvVar: arm.credentialEnvVar,
    hasCredential: () => true,
    async chat(): Promise<ProviderResponse> {
      return handler();
    },
  };
}

function manifestJson(): string {
  return JSON.stringify({
    artifactSchemaVersion: 1,
    network: 'polygon',
    sportAllowList: ['mlb'],
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    source: 'jsonodds',
    sourceQueryVersion: 'source-query-v1',
    marketPolicyVersion: MARKET_POLICY_VERSION,
    marketPolicyDigest: MARKET_POLICY_DIGEST,
    promptScaffoldSha256: promptScaffoldSha256(),
    expectedArmRoster: CODE_ARMS.map((a) => ({
      participantId: a.participantId,
      provider: a.provider,
      requestedModelId: a.requestedModelId,
      approvedReportedModelIds: [...a.approvedReportedModelIds],
    })),
    toolInferenceConfigSha256: 'c'.repeat(64),
    baselinePolicyVersion: 'baselines-v0.3.0',
    repairPolicyVersion: 'repair-v1',
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: 'prices-v1',
    modelPriceTableDigest: 'd'.repeat(64),
    runnerCommitSha: 'e'.repeat(40),
    constants: {
      pollIntervalMs: 30_000,
      cleanEntryWindowMs: W,
      gameDiscoveryWindowHours: 168,
      maxClockSkewMs: SKEW,
      freshFireMs: 30_000,
      maxDispatchLagMs: 10_000,
      historyReadTimeoutMs: 30_000,
      providerCallTimeoutMs: 300_000,
      maxOutputTokens: 16_000,
      maxRepairAttemptsPerArm: 1,
      ingestionGraceMs: 900_000,
      scheduleChangeToleranceMs: 60_000,
      maxConcurrentProviderRequests: Math.max(8, CODE_ARMS.length),
      maxDispatchesPerTick: 8,
    },
    cohortCallCap: 1_000,
    cohortSpendCapUsdMicros: 1_000_000,
  });
}

function publicationFor(json: string): PublicationVerified {
  const bytes = new TextEncoder().encode(json);
  return checkPublication({
    localManifestBytes: bytes,
    publication: { repositoryOwner: 'ospex-org', repositoryName: 'ospex-benchmark', path: 'manifests/cohort.json', commitSha: 'a'.repeat(40) },
    resolved: { blobBytes: bytes, committerTimestamp: COMMITTER_TS },
  });
}

function historyRow(market: MarketKey): TwoSidedHistoryRow {
  const quote =
    market === 'moneyline'
      ? { line: null, away_odds_american: -134, away_odds_decimal: 1.74627, home_odds_american: 117, home_odds_decimal: 2.17 }
      : { line: 8.5, away_odds_american: -110, away_odds_decimal: 1.90909, home_odds_american: -110, home_odds_decimal: 1.90909 };
  return { id: 1, jsonodds_id: GAME_ID, market, source: 'jsonodds', ...quote, captured_at: OPENER_AT, captured_at_ms: Date.parse(OPENER_AT) };
}

function candidateInput(market: MarketKey): CandidateInput {
  return {
    gameId: GAME_ID,
    sport: 'mlb',
    market,
    sportAllowList: ['mlb'],
    marketPolicyVersion: MARKET_POLICY_VERSION,
    opener: historyRow(market),
    detectedAt: DETECTED_AT,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    cleanEntryWindowMs: W,
    maxClockSkewMs: SKEW,
  };
}

function marketCtx(market: MarketKey, cohortId: string, fireId: string): MarketFireContextV1 {
  const ci = candidateInput(market);
  return {
    candidateInput: ci,
    verdict: evaluateCandidate(ci),
    historyRows: [historyRow(market)],
    historyWatermark: null,
    claim: { cohortId, fireId, gameId: GAME_ID, market },
  };
}

async function producedFire(
  opts: { markets?: readonly MarketKey[]; awayTeam?: string; fireId?: string } = {},
): Promise<FireArtifactV1> {
  const markets = opts.markets ?? (['moneyline', 'total'] as const);
  const awayTeam = opts.awayTeam ?? AWAY_TEAM;
  const fireId = opts.fireId ?? FIRE_ID;
  const json = manifestJson();
  const booted: BootedCohort = cohortBoot({ live: false, manifestBytes: json });
  const publication = publicationFor(json);
  const cohortId = booted.cohortId;
  const request = scopedRequest(markets, awayTeam);
  const adapters = new Map<string, ProviderAdapter>();
  for (const arm of ARMS) {
    adapters.set(arm.participantId, stubAdapter(arm, () => stubResponse(JSON.stringify(scopedResponse(request, arm, cohortId)), arm.requestedModelId)));
  }
  const env: RunEnvelope = await runSlate([...ARMS], adapters, [request], {
    cohortId,
    timeoutMs: 600_000,
    maxOutputTokens: 16_000,
    executionPolicy: 'fixed-moneyline-total',
    baselinePolicyVersion: 'baselines-v0.3.0',
    nowMs: () => NOW_MS,
  });
  const ctx: FireContext = {
    booted,
    fireId,
    runId: RUN_ID,
    publication,
    bundleBuiltAt: BUNDLE_BUILT_AT,
    perMarket: markets.map((m) => marketCtx(m, cohortId, fireId)),
  };
  return buildFireArtifact(env, ctx);
}

function canonicalBytes(artifact: FireArtifactV1): Buffer {
  return Buffer.from(serializeFireArtifactV1(artifact), 'utf8');
}

/** The path the sink derives (mirrors the sink path derivation), for independent assertion. */
function expectedPath(baseDir: string, artifact: FireArtifactV1): string {
  const scope = [...artifact.scopedMarkets].sort((a, b) => MARKET_ORDINAL[a] - MARKET_ORDINAL[b]).join('+');
  const seg = Buffer.from(artifact.gameId, 'utf8').toString('base64url');
  return join(baseDir, artifact.cohortId, `fire-${seg}-${scope}-${artifact.fireId}.json`);
}

function withEnv(name: string, value: string, fn: () => void): void {
  const original = process.env[name];
  process.env[name] = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

function eexist(): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error('EEXIST: file already exists');
  e.code = 'EEXIST';
  return e;
}

// --- recording, stateful fake filesystem port -------------------------------

type FakeOp = 'mkdirp' | 'openExclusive' | 'write' | 'fsync' | 'close' | 'link' | 'syncDir' | 'readFile' | 'unlink';

class FakeFs implements ArtifactFs {
  readonly log: FakeOp[] = [];
  readonly files = new Map<string, Buffer>();
  readonly opened: string[] = [];
  readonly linked: Array<{ existing: string; newPath: string }> = [];
  readonly writeArgs: Array<{ offset: number; length: number }> = [];
  private readonly temps = new Map<number, { path: string; chunks: Buffer[] }>();
  private nextFd = 100;
  private writeCall = 0;
  private syncDirCall = 0;

  /** Bytes "written" per call; default writes the whole remaining length. */
  onWrite?: (remaining: number, call: number) => number;
  throwOn: Partial<Record<FakeOp, Error>> = {};
  /** Fail only the FIRST syncDir (the fresh-link one); a later retry syncDir succeeds. */
  syncDirFailFirstOnly?: Error;

  mkdirp(_dir: string): void {
    this.log.push('mkdirp');
    if (this.throwOn.mkdirp) throw this.throwOn.mkdirp;
  }

  openExclusive(path: string): number {
    this.log.push('openExclusive');
    this.opened.push(path);
    if (this.throwOn.openExclusive) throw this.throwOn.openExclusive;
    if (this.files.has(path)) throw eexist();
    const fd = this.nextFd;
    this.nextFd += 1;
    this.temps.set(fd, { path, chunks: [] });
    return fd;
  }

  write(fd: number, data: Buffer, offset: number, length: number): number {
    this.log.push('write');
    this.writeArgs.push({ offset, length });
    if (this.throwOn.write) throw this.throwOn.write;
    const call = this.writeCall;
    this.writeCall += 1;
    const n = this.onWrite ? this.onWrite(length, call) : length;
    if (Number.isInteger(n) && n >= 1 && n <= length) {
      this.temps.get(fd)?.chunks.push(Buffer.from(data.subarray(offset, offset + n)));
    }
    return n;
  }

  fsync(_fd: number): void {
    this.log.push('fsync');
    if (this.throwOn.fsync) throw this.throwOn.fsync;
  }

  close(fd: number): void {
    this.log.push('close');
    const t = this.temps.get(fd);
    if (t) this.files.set(t.path, Buffer.concat(t.chunks)); // the temp is durable after close
    if (this.throwOn.close) throw this.throwOn.close;
  }

  link(existingPath: string, newPath: string): void {
    this.log.push('link');
    this.linked.push({ existing: existingPath, newPath });
    if (this.throwOn.link) throw this.throwOn.link;
    if (this.files.has(newPath)) throw eexist();
    const bytes = this.files.get(existingPath);
    if (bytes === undefined) throw new Error(`fake link: missing source ${existingPath}`);
    this.files.set(newPath, bytes); // a hard link shares the same bytes
  }

  syncDir(_dir: string): void {
    this.log.push('syncDir');
    this.syncDirCall += 1;
    if (this.syncDirFailFirstOnly && this.syncDirCall === 1) throw this.syncDirFailFirstOnly;
    if (this.throwOn.syncDir) throw this.throwOn.syncDir;
  }

  readFile(path: string): Buffer {
    this.log.push('readFile');
    if (this.throwOn.readFile) throw this.throwOn.readFile;
    const b = this.files.get(path);
    if (b === undefined) throw new Error(`fake readFile: missing ${path}`);
    return b;
  }

  unlink(path: string): void {
    this.log.push('unlink');
    this.files.delete(path);
    if (this.throwOn.unlink) throw this.throwOn.unlink;
  }
}

// ===========================================================================
// fresh create and exact durable bytes
// ===========================================================================

test('fresh create writes the exact durable bytes at the canonical path', async () => {
  const artifact = await producedFire();
  const fs = new FakeFs();
  const r = new FireArtifactSink('/base', fs).install(artifact);
  assert.equal(r.created, true);
  assert.equal(r.path, expectedPath('/base', artifact));
  const bytes = canonicalBytes(artifact);
  assert.ok(fs.files.get(r.path)!.equals(bytes)); // final bytes untransformed
  const reloaded = fs.files.get(r.path)!.toString('utf8');
  assert.deepEqual(verifyFireArtifactReplay(parseFireArtifactV1(reloaded)), []);
});

// ===========================================================================
// path encoding and canonical scope
// ===========================================================================

test('encodes an arbitrary game id into one safe segment and canonicalizes scope', async () => {
  for (const gid of ['a/b', 'a\\b', '..', '.hidden', 'has space', 'ünîcödé', '../../etc/passwd']) {
    const seg = Buffer.from(gid, 'utf8').toString('base64url');
    assert.equal(Buffer.from(seg, 'base64url').toString('utf8'), gid); // round-trips exactly
    assert.ok(seg.length > 0);
    assert.ok(!/[/\\.]/.test(seg), `segment "${seg}" must contain no separator/traversal`); // base64url alphabet is [A-Za-z0-9_-]
  }
  const artifact = await producedFire();
  const r = new FireArtifactSink('/b', new FakeFs()).install(artifact);
  assert.equal(r.path, expectedPath('/b', artifact));
  assert.ok(r.path.includes(`fire-${Buffer.from(GAME_ID, 'utf8').toString('base64url')}-`));
  // The producer canonicalizes scope order, so a reordered request maps to one path; a
  // distinct scope maps to a distinct segment.
  const both = await producedFire({ markets: ['total', 'moneyline'] });
  assert.equal(expectedPath('/b', both), expectedPath('/b', artifact));
  const mlOnly = await producedFire({ markets: ['moneyline'] });
  assert.notEqual(expectedPath('/b', mlOnly), expectedPath('/b', artifact));
});

// ===========================================================================
// verify-first and zero filesystem effects
// ===========================================================================

test('verifies before any filesystem effect — forged/credential/non-sha256/replay each make zero fs calls', async () => {
  // (a) unbranded structural copy → serialize (brand) refuses; no fs.
  {
    const copy = JSON.parse(JSON.stringify(await producedFire())) as FireArtifactV1;
    const fs = new FakeFs();
    assert.throws(() => new FireArtifactSink('/b', fs).install(copy), /not produced by buildFireArtifact/);
    assert.deepEqual(fs.log, []);
  }
  // (b) a configured credential in a retained field (incl. a JSON-escaped character) → redaction refuses; no fs.
  for (const team of [AWAY_TEAM, 'Team "Q" \\ Z']) {
    const artifact = await producedFire({ awayTeam: team });
    const fs = new FakeFs();
    withEnv('OPENAI_API_KEY', team, () => {
      assert.throws(() => new FireArtifactSink('/b', fs).install(artifact), /unredacted configured credential/);
    });
    assert.deepEqual(fs.log, []);
  }
  // (c) a genuine producer output whose fireId is not sha256 → path grammar refuses; no fs.
  {
    const artifact = await producedFire({ fireId: 'fire-1' });
    const fs = new FakeFs();
    assert.throws(() => new FireArtifactSink('/b', fs).install(artifact), /fireId is not a lowercase sha256/);
    assert.deepEqual(fs.log, []);
  }
  // (d) replay refusal is CHECKED before mkdirp — via a seam that still uses the production
  //     owners by default (a genuine artifact is always replay-consistent, so a stub replay
  //     is the only way to reach the refusal branch).
  {
    const artifact = await producedFire();
    const fs = new FakeFs();
    const owners: SinkOwners = {
      serialize: serializeFireArtifactV1,
      parse: parseFireArtifactV1,
      replay: () => ['injected replay violation'],
    };
    assert.throws(() => new FireArtifactSink('/b', fs, owners).install(artifact), /fails replay/);
    assert.deepEqual(fs.log, []);
  }
});

// ===========================================================================
// exact fresh operation order
// ===========================================================================

test('fresh install drives the exact durable operation order and cleans the temp', async () => {
  const artifact = await producedFire();
  const fs = new FakeFs();
  const r = new FireArtifactSink('/base', fs).install(artifact);
  assert.deepEqual(fs.log, ['mkdirp', 'openExclusive', 'write', 'fsync', 'close', 'link', 'syncDir', 'unlink']);
  const tempPath = fs.opened[0]!;
  const finalPath = fs.linked[0]!.newPath;
  assert.equal(dirname(tempPath), dirname(finalPath)); // same parent directory
  assert.notEqual(tempPath, finalPath);
  assert.equal(finalPath, r.path);
  assert.ok(!fs.files.has(tempPath)); // temp removed after successful cleanup
  assert.ok(fs.files.has(finalPath));
});

// ===========================================================================
// partial writes and zero progress
// ===========================================================================

test('loops over short writes to completion with advancing offsets', async () => {
  const artifact = await producedFire();
  const fs = new FakeFs();
  fs.onWrite = (remaining) => Math.min(7, remaining); // several positive short writes
  const r = new FireArtifactSink('/base', fs).install(artifact);
  assert.ok(fs.files.get(r.path)!.equals(canonicalBytes(artifact))); // concatenated == complete buffer
  assert.ok(fs.writeArgs.length > 1);
  // offsets advance and remaining lengths shrink, always within bounds.
  let expectedOffset = 0;
  const total = canonicalBytes(artifact).length;
  for (const a of fs.writeArgs) {
    assert.equal(a.offset, expectedOffset);
    assert.equal(a.length, total - expectedOffset);
    expectedOffset += Math.min(7, a.length);
  }
  assert.equal(expectedOffset, total);
});

test('zero or invalid write progress throws promptly without link/syncDir', async () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const artifact = await producedFire();
    const fs = new FakeFs();
    fs.onWrite = () => bad;
    assert.throws(() => new FireArtifactSink('/base', fs).install(artifact), /invalid progress/);
    assert.ok(fs.log.includes('write'));
    assert.ok(fs.log.includes('close')); // close is still attempted
    assert.ok(fs.log.includes('unlink')); // and cleanup
    assert.ok(!fs.log.includes('link'));
    assert.ok(!fs.log.includes('syncDir'));
  }
  // an over-remaining count is also refused.
  const artifact = await producedFire();
  const fs = new FakeFs();
  fs.onWrite = (remaining) => remaining + 1;
  assert.throws(() => new FireArtifactSink('/base', fs).install(artifact), /invalid progress/);
  assert.ok(!fs.log.includes('link'));
});

// ===========================================================================
// fd close and cleanup no-mask matrix (exact Error identity)
// ===========================================================================

test('fd-close/cleanup error precedence matrix', async () => {
  const artifact = await producedFire();
  const writeErr = new Error('write-boom');
  const fsyncErr = new Error('fsync-boom');
  const closeErr = new Error('close-boom');
  const linkErr = new Error('link-boom');
  const unlinkErr = new Error('unlink-boom');
  const openErr = new Error('open-boom');

  // 1. write + close + unlink all fail → original WRITE error; close/unlink attempted; no link.
  {
    const fs = new FakeFs();
    fs.throwOn = { write: writeErr, close: closeErr, unlink: unlinkErr };
    assert.throws(() => new FireArtifactSink('/b', fs).install(artifact), (e) => e === writeErr);
    assert.ok(fs.log.includes('close') && fs.log.includes('unlink') && !fs.log.includes('link'));
  }
  // 2. fsync + close fail → original FSYNC error.
  {
    const fs = new FakeFs();
    fs.throwOn = { fsync: fsyncErr, close: closeErr };
    assert.throws(() => new FireArtifactSink('/b', fs).install(artifact), (e) => e === fsyncErr);
  }
  // 3. close-only fails → close error; no link.
  {
    const fs = new FakeFs();
    fs.throwOn = { close: closeErr };
    assert.throws(() => new FireArtifactSink('/b', fs).install(artifact), (e) => e === closeErr);
    assert.ok(!fs.log.includes('link'));
  }
  // 4. non-EEXIST link + unlink fail → original LINK error.
  {
    const fs = new FakeFs();
    fs.throwOn = { link: linkErr, unlink: unlinkErr };
    assert.throws(() => new FireArtifactSink('/b', fs).install(artifact), (e) => e === linkErr);
  }
  // 5. fresh success + unlink error → the successful created result survives.
  {
    const fs = new FakeFs();
    fs.throwOn = { unlink: unlinkErr };
    const r = new FireArtifactSink('/b', fs).install(artifact);
    assert.deepEqual(r, { path: expectedPath('/b', artifact), created: true });
  }
  // 6. openExclusive failure → no close/unlink (no temp ownership).
  {
    const fs = new FakeFs();
    fs.throwOn = { openExclusive: openErr };
    assert.throws(() => new FireArtifactSink('/b', fs).install(artifact), (e) => e === openErr);
    assert.ok(!fs.log.includes('close') && !fs.log.includes('unlink'));
  }
});

// ===========================================================================
// identical retry and directory-sync recovery
// ===========================================================================

test('identical retry returns created:false and re-syncs the directory', async () => {
  const artifact = await producedFire();
  const fs = new FakeFs();
  const sink = new FireArtifactSink('/base', fs);
  const first = sink.install(artifact);
  assert.equal(first.created, true);
  const before = Buffer.from(fs.files.get(first.path)!);
  fs.log.length = 0;
  const second = sink.install(artifact);
  assert.deepEqual(second, { path: first.path, created: false });
  assert.ok(fs.files.get(first.path)!.equals(before)); // unchanged
  // The EEXIST path reads raw, re-syncs, then cleans up.
  assert.deepEqual(fs.log, ['mkdirp', 'openExclusive', 'write', 'fsync', 'close', 'link', 'readFile', 'syncDir', 'unlink']);
});

test('a fresh directory-sync failure is recoverable by the identical retry', async () => {
  const artifact = await producedFire();
  const fs = new FakeFs();
  const syncErr = new Error('dir-sync-boom');
  fs.syncDirFailFirstOnly = syncErr;
  const sink = new FireArtifactSink('/base', fs);
  // First call: the link succeeds (final now exists) but the fresh syncDir fails → the call throws.
  assert.throws(() => sink.install(artifact), (e) => e === syncErr);
  const finalPath = expectedPath('/base', artifact);
  assert.ok(fs.files.has(finalPath)); // the linked entry remains
  // Retry: EEXIST + identical bytes → re-sync (now succeeds) → created:false.
  const retry = sink.install(artifact);
  assert.deepEqual(retry, { path: finalPath, created: false });
});

// ===========================================================================
// collision, no overwrite, and lossy-decoder witness
// ===========================================================================

test('a byte-different artifact at the same path fails loud and never overwrites', async () => {
  const a = await producedFire({ awayTeam: 'Aardvarks' });
  const b = await producedFire({ awayTeam: 'Buffaloes' }); // same game/scope/fire → same path, different bytes
  assert.equal(expectedPath('/base', a), expectedPath('/base', b));
  assert.ok(!canonicalBytes(a).equals(canonicalBytes(b)));
  const fs = new FakeFs();
  const sink = new FireArtifactSink('/base', fs);
  const first = sink.install(a);
  const preserved = Buffer.from(fs.files.get(first.path)!);
  assert.throws(() => sink.install(b), /byte-different fire artifact/);
  assert.ok(fs.files.get(first.path)!.equals(preserved)); // first file unchanged, never unlinked
});

test('raw-byte identity classifies a lossy-decode collision (U+FFFD vs invalid 0xff)', async () => {
  const artifact = await producedFire({ awayTeam: 'Milwaukee � Brewers' });
  const bytes = canonicalBytes(artifact);
  const marker = Buffer.from([0xef, 0xbf, 0xbd]); // U+FFFD in the canonical bytes
  const idx = bytes.indexOf(marker);
  assert.ok(idx >= 0);
  // An existing file that decodes to the SAME string (0xff → U+FFFD) but differs in raw bytes.
  const lossy = Buffer.concat([bytes.subarray(0, idx), Buffer.from([0xff]), bytes.subarray(idx + 3)]);
  assert.equal(lossy.toString('utf8'), bytes.toString('utf8')); // decoded strings are equal
  assert.ok(!lossy.equals(bytes)); // raw bytes differ
  const fs = new FakeFs();
  fs.files.set(expectedPath('/base', artifact), lossy); // pre-existing final at the path
  assert.throws(() => new FireArtifactSink('/base', fs).install(artifact), /byte-different fire artifact/);
  assert.ok(fs.files.get(expectedPath('/base', artifact))!.equals(lossy)); // never overwritten/unlinked
});

// ===========================================================================
// production nodeArtifactFs integration (real temp directory)
// ===========================================================================

test('the production node adapter installs, is idempotent, refuses collisions, and leaves no temp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ospex-sink-'));
  try {
    const artifact = await producedFire();
    const sink = new FireArtifactSink(dir); // default nodeArtifactFs
    const r = sink.install(artifact);
    assert.equal(r.created, true);
    assert.ok(readFileSync(r.path).equals(canonicalBytes(artifact))); // on-disk raw bytes == canonical
    assert.deepEqual(verifyFireArtifactReplay(parseFireArtifactV1(readFileSync(r.path, 'utf8'))), []);

    assert.equal(sink.install(artifact).created, false); // idempotent retry
    assert.ok(readFileSync(r.path).equals(canonicalBytes(artifact)));

    const different = await producedFire({ awayTeam: 'Different Team' });
    assert.equal(expectedPath(dir, different), r.path);
    assert.throws(() => sink.install(different), /byte-different fire artifact/);
    assert.ok(readFileSync(r.path).equals(canonicalBytes(artifact))); // first file preserved

    // no temp (dotfile) remains in the cohort directory — only the final artifact.
    const cohortDir = dirname(r.path);
    const leftover = readdirSync(cohortDir).filter((n) => n.startsWith('.'));
    assert.deepEqual(leftover, []);
    assert.ok(existsSync(r.path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// ownership and scope source gate
// ===========================================================================

test('the sink imports no permit/store/runtime authority, one owner, no legacy write', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fireArtifactSink.ts'), 'utf8');
  for (const forbidden of [
    'DispatchPermit',
    'assertDispatchPermit',
    'lineOpenClaim',
    'PreparedFireSnapshot',
    'preparedFire',
    'runSlate',
    'AttemptLifecycle',
    'writeFireArtifactV1',
    "from './store",
  ]) {
    assert.ok(!src.includes(forbidden), `sink must not reference ${forbidden}`);
  }
  // exactly one production serialize/parse/replay owner, imported from the writer.
  const writerImports = src.match(/from '\.\/fireArtifactWriter\.js'/g) ?? [];
  assert.equal(writerImports.length, 1);
  assert.ok(src.includes('serializeFireArtifactV1') && src.includes('parseFireArtifactV1') && src.includes('verifyFireArtifactReplay'));
  // exactly one base64url path encoder.
  assert.equal((src.match(/\.toString\('base64url'\)/g) ?? []).length, 1);
});
