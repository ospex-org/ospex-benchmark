import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import { redactSecrets } from './config.js';
import { cohortBoot } from './cohortBoot.js';
import { evaluateCandidate } from './detection.js';
import { armDigest } from './fireArtifact.js';
import { buildFireArtifact } from './fireArtifactProducer.js';
import type { FireContext, MarketFireContextV1 } from './fireArtifactProducer.js';
import {
  parseFireArtifactV1,
  recomputeFireArtifactDigests,
  serializeFireArtifactV1,
  verifyFireArtifactReplay,
  verifyFireArtifactRelations,
  writeFireArtifactV1,
} from './fireArtifactWriter.js';
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
 * The fire-artifact write path (SPEC §4/§5): serialize / parse / replay / write. Each
 * test drives a REAL produced artifact through `buildFireArtifact`, then either
 * round-trips it or mutates the PARSED (unbranded) value to prove one persisted
 * invariant fails closed. In-armDigest-domain tampers recompute the arm digest so the
 * targeted check is proven load-bearing, never masked by a stale downstream digest.
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

const CODE_ARMS = defaultExpectedArms();
const ARMS: ArmSpec[] = CODE_ARMS.map((a) => ({
  participantId: a.participantId,
  provider: a.provider as ProviderName,
  requestedModelId: a.requestedModelId,
  credentialEnvVar: `${a.participantId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_KEY`,
}));

// --- fixtures (a real produced fire) ----------------------------------------

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
  opts: { markets?: readonly MarketKey[]; awayTeam?: string } = {},
): Promise<FireArtifactV1> {
  const markets = opts.markets ?? (['moneyline', 'total'] as const);
  const awayTeam = opts.awayTeam ?? AWAY_TEAM;
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
    fireId: 'fire-1',
    runId: 'run-1',
    publication,
    bundleBuiltAt: BUNDLE_BUILT_AT,
    perMarket: markets.map((m) => marketCtx(m, cohortId, 'fire-1')),
  };
  return buildFireArtifact(env, ctx);
}

/** Parse a produced artifact into a mutable, unbranded value (a persisted read-back). */
async function parsedFire(opts?: { markets?: readonly MarketKey[]; awayTeam?: string }): Promise<FireArtifactV1> {
  const artifact = await producedFire(opts);
  return parseFireArtifactV1(serializeFireArtifactV1(artifact));
}

/** Apply a patch to arm `index` and RECOMPUTE its armDigest, so a targeted in-domain
 *  tamper leaves the arm digest coherent (the specific check must catch it alone). */
function patchArmCoherent(artifact: FireArtifactV1, index: number, patch: Partial<FireArtifactV1['arms'][number]>): FireArtifactV1 {
  const arm = { ...artifact.arms[index]!, ...patch };
  arm.armDigest = armDigest({
    cohortId: artifact.cohortId,
    fireId: artifact.fireId,
    runId: artifact.runId,
    participantId: arm.expectedArmIdentity.participantId,
    requestSha256: artifact.requestSha256,
    expectedArmIdentity: arm.expectedArmIdentity,
    orderedAttempts: arm.orderedAttempts,
    terminalOutcome: arm.terminalOutcome,
    acceptedResponseDigestOrNull: arm.acceptedResponseDigest,
    acceptedDecisionFingerprintOrNull: arm.acceptedDecisionFingerprint,
  });
  return { ...artifact, arms: artifact.arms.map((a, i) => (i === index ? arm : a)) };
}

function has(violations: string[], needle: string): boolean {
  return violations.some((v) => v.includes(needle));
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

// --- happy path -------------------------------------------------------------

test('serialize is canonical, deterministic, valid JSON, and requires the producer brand', async () => {
  const a = await producedFire();
  const sa = serializeFireArtifactV1(a);
  assert.equal(sa, serializeFireArtifactV1(a));
  assert.equal(sa, canonicalize(a));
  assert.doesNotThrow(() => JSON.parse(sa));
});

test('serialize and write reject an unbranded structural copy', async () => {
  const a = await producedFire();
  const copy = JSON.parse(JSON.stringify(a)) as FireArtifactV1;
  assert.throws(() => serializeFireArtifactV1(copy), /not produced by buildFireArtifact/);
  const dir = mkdtempSync(join(tmpdir(), 'ospex-fire-'));
  try {
    const filePath = join(dir, 'copy.json');
    assert.throws(() => writeFireArtifactV1(filePath, copy), /not produced by buildFireArtifact/);
    assert.ok(!existsSync(filePath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serialize → parse round-trips unchanged for one-market and co-arrival fires', async () => {
  for (const markets of [['moneyline'], ['total'], ['moneyline', 'total']] as MarketKey[][]) {
    const a = await producedFire({ markets });
    assert.deepEqual(parseFireArtifactV1(serializeFireArtifactV1(a)), JSON.parse(JSON.stringify(a)));
  }
});

test('parse fails closed on malformed JSON and on a nested unknown field', async () => {
  assert.throws(() => parseFireArtifactV1('{ not json'));
  const a = await producedFire();
  const obj = JSON.parse(serializeFireArtifactV1(a));
  obj.arms[0].sneaky = 1; // nested unknown
  assert.throws(() => parseFireArtifactV1(JSON.stringify(obj)));
});

test('verifyFireArtifactReplay is empty on produced fires and a write→read→parse replay stays clean', async () => {
  assert.deepEqual(verifyFireArtifactReplay(await parsedFire({ markets: ['moneyline'] })), []);
  const artifact = await producedFire();
  assert.deepEqual(verifyFireArtifactReplay(parseFireArtifactV1(serializeFireArtifactV1(artifact))), []);
  const dir = mkdtempSync(join(tmpdir(), 'ospex-fire-'));
  try {
    const filePath = join(dir, 'fire-1.json');
    writeFireArtifactV1(filePath, artifact);
    const bytes = readFileSync(filePath, 'utf8');
    assert.equal(bytes, serializeFireArtifactV1(artifact));
    assert.deepEqual(verifyFireArtifactReplay(parseFireArtifactV1(bytes)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- redaction chokepoint ---------------------------------------------------

test('a configured credential in a retained field refuses serialize and write (no file)', async () => {
  const artifact = await producedFire(); // clean: away team present, no credential configured
  withEnv('OPENAI_API_KEY', AWAY_TEAM, () => {
    assert.throws(() => serializeFireArtifactV1(artifact), /unredacted configured credential/);
    const dir = mkdtempSync(join(tmpdir(), 'ospex-fire-'));
    try {
      const filePath = join(dir, 'leak.json');
      assert.throws(() => writeFireArtifactV1(filePath, artifact), /unredacted configured credential/);
      assert.ok(!existsSync(filePath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('a JSON-escaped configured credential is caught field-level (a serialized-string sweep misses it)', async () => {
  const secret = 'Brewers"Quote-Secret'; // a schema-valid team name containing a quote
  const artifact = await producedFire({ awayTeam: secret });
  withEnv('OPENAI_API_KEY', secret, () => {
    // A string sweep over the SERIALIZED bytes misses it: canonical JSON escapes the
    // quote, so the raw credential substring is absent from the serialized form.
    const serializedEscaped = canonicalize(artifact);
    assert.ok(serializedEscaped.includes('Brewers\\"Quote-Secret'));
    assert.equal(redactSecrets(serializedEscaped), serializedEscaped); // sweep leaves it in
    // The field-level check catches it and refuses.
    assert.throws(() => serializeFireArtifactV1(artifact), /unredacted configured credential/);
  });
});

// --- digest / accepted-body replay teeth (each asserts its specific violation) ---

test('replay catches a tampered requestSha256', async () => {
  const t = { ...(await parsedFire()), requestSha256: 'b'.repeat(64) };
  assert.ok(has(verifyFireArtifactReplay(t), 'requestSha256 does not recompute'));
});

test('replay catches a tampered gameSha256', async () => {
  const t = { ...(await parsedFire()), gameSha256: 'b'.repeat(64) };
  assert.ok(has(verifyFireArtifactReplay(t), 'gameSha256 does not recompute'));
});

test('replay catches a tampered slateSha256 (previously outside replay)', async () => {
  const t = { ...(await parsedFire()), slateSha256: 'b'.repeat(64) };
  assert.ok(has(verifyFireArtifactReplay(t), 'slateSha256 does not recompute'));
});

test('replay catches a tampered attempt responseSha256', async () => {
  const parsed = await parsedFire();
  const arm0 = { ...parsed.arms[0]!, orderedAttempts: parsed.arms[0]!.orderedAttempts.map((a, i) => (i === 0 ? { ...a, responseSha256: 'b'.repeat(64) } : a)) };
  const t = { ...parsed, arms: [arm0, ...parsed.arms.slice(1)] };
  assert.ok(has(verifyFireArtifactReplay(t), 'responseSha256 does not match'));
});

test('replay catches an acceptedResponseDigest not linked to the accepted attempt (armDigest recomputed)', async () => {
  const parsed = await parsedFire();
  const t = patchArmCoherent(parsed, 0, { acceptedResponseDigest: 'f'.repeat(64) });
  const violations = verifyFireArtifactReplay(t);
  assert.ok(has(violations, 'acceptedResponseDigest is not the accepted attempt'));
  assert.ok(!has(violations, 'armDigest does not recompute')); // isolated: digest stays coherent
});

test('replay catches an accepted fingerprint that disagrees with the retained body (armDigest recomputed)', async () => {
  const parsed = await parsedFire();
  const fp = parsed.arms[0]!.acceptedDecisionFingerprint!;
  const mutatedFp = fp.map((e, i) => (i === 0 ? { ...e, confidence: e.confidence + 0.1 } : e));
  const t = patchArmCoherent(parsed, 0, { acceptedDecisionFingerprint: mutatedFp });
  const violations = verifyFireArtifactReplay(t);
  assert.ok(has(violations, 'does not re-derive from the retained accepted body'));
  assert.ok(!has(violations, 'armDigest does not recompute'));
});

test('replay catches a tampered armDigest', async () => {
  const parsed = await parsedFire();
  const arm0 = { ...parsed.arms[0]!, armDigest: 'c'.repeat(64) };
  const t = { ...parsed, arms: [arm0, ...parsed.arms.slice(1)] };
  assert.ok(has(verifyFireArtifactReplay(t), 'armDigest does not recompute'));
});

// --- relational replay teeth ------------------------------------------------

test('replay catches a non-canonical attempt number (armDigest recomputed)', async () => {
  const parsed = await parsedFire();
  const renumbered = parsed.arms[0]!.orderedAttempts.map((a, i) => (i === 0 ? { ...a, attemptNumber: 2 } : a));
  const t = patchArmCoherent(parsed, 0, { orderedAttempts: renumbered });
  const violations = verifyFireArtifactReplay(t);
  assert.ok(has(violations, 'not canonically numbered'));
  assert.ok(!has(violations, 'armDigest does not recompute'));
});

test('replay catches non-causal attempt timing (armDigest recomputed)', async () => {
  const parsed = await parsedFire();
  const badTiming = parsed.arms[0]!.orderedAttempts.map((a, i) => (i === 0 ? { ...a, requestReceivedAt: '2020-01-01T00:00:00.000Z' } : a));
  const t = patchArmCoherent(parsed, 0, { orderedAttempts: badTiming });
  const violations = verifyFireArtifactReplay(t);
  assert.ok(has(violations, 'requestStartedAt is after requestReceivedAt'));
  assert.ok(!has(violations, 'armDigest does not recompute'));
});

test('replay catches a foreign top-level game identity', async () => {
  const t = { ...(await parsedFire()), gameId: 'foreign-game' };
  assert.ok(has(verifyFireArtifactReplay(t), 'gameId does not equal the retained request game id'));
});

test('replay catches tampered top-level identity aliases (sport, preparedSnapshotTs, scheduledAtAtFire)', async () => {
  const base = await parsedFire();
  assert.ok(has(verifyFireArtifactRelations({ ...base, sport: 'nfl' }), 'sport does not equal'));
  assert.ok(has(verifyFireArtifactRelations({ ...base, preparedSnapshotTs: '2026-07-18T13:00:00.000Z' }), 'preparedSnapshotTs does not equal'));
  assert.ok(has(verifyFireArtifactRelations({ ...base, scheduledAtAtFire: '2026-07-18T21:00:00+00:00' }), 'scheduledAtAtFire does not equal'));
});

test('replay catches a scope reduction not matched by the request markets', async () => {
  const parsed = await parsedFire({ markets: ['moneyline', 'total'] });
  const t = { ...parsed, scopedMarkets: ['moneyline'] as MarketKey[] };
  assert.ok(has(verifyFireArtifactReplay(t), 'scopedMarkets do not equal the present retained-request markets'));
});

test('replay catches a foreign market-evidence opener identity', async () => {
  const parsed = await parsedFire();
  const me0 = { ...parsed.marketEvidence[0]!, opener: { ...parsed.marketEvidence[0]!.opener, jsonodds_id: 'foreign-game' } };
  const t = { ...parsed, marketEvidence: [me0, ...parsed.marketEvidence.slice(1)] };
  assert.ok(has(verifyFireArtifactReplay(t), 'opener identity does not bind'));
});

test('replay catches a per-market claim not bound to the fire identity', async () => {
  // marketEvidence[].claim is the SOLE authoritative claim carrier; a claim whose
  // fire identity is substituted must fail replay (no top-level claims[] to disagree).
  const parsed = await parsedFire();
  const me0 = { ...parsed.marketEvidence[0]!, claim: { ...parsed.marketEvidence[0]!.claim, fireId: 'foreign-fire' } };
  const t = { ...parsed, marketEvidence: [me0, ...parsed.marketEvidence.slice(1)] };
  assert.ok(has(verifyFireArtifactReplay(t), 'claim does not bind'));
});

test('replay catches a publication verified for a different cohort identity', async () => {
  const parsed = await parsedFire();
  const t = { ...parsed, publication: { ...parsed.publication, cohortId: 'a'.repeat(64) } };
  assert.ok(has(verifyFireArtifactReplay(t), 'publication cohortId does not equal'));
});

test('replay catches baseline decisions that do not rederive from the retained request', async () => {
  const parsed = await parsedFire();
  const bad = parsed.baselineDecisions.map((d, i) => (i === 0 ? { ...d, selection: 'tampered-selection' } : d));
  const t = { ...parsed, baselineDecisions: bad };
  assert.ok(has(verifyFireArtifactReplay(t), 'baseline decisions do not rederive'));
});

test('replay is empty for a produced non-scope-covering check across all legal scopes', async () => {
  for (const markets of [['moneyline'], ['total'], ['moneyline', 'total']] as MarketKey[][]) {
    assert.deepEqual(recomputeFireArtifactDigests(await parsedFire({ markets })), []);
  }
});
