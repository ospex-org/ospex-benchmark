import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import { redactSecrets } from './config.js';
import { cohortBoot } from './cohortBoot.js';
import { evaluateCandidate } from './detection.js';
import { buildFireArtifact } from './fireArtifactProducer.js';
import type { FireContext, MarketFireContextV1 } from './fireArtifactProducer.js';
import {
  parseFireArtifactV1,
  recomputeFireArtifactDigests,
  serializeFireArtifactV1,
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
 * The fire-artifact write path (SPEC §4/§5): serialize / parse / digest-recompute /
 * write. Each test drives a REAL produced artifact through `buildFireArtifact` (via
 * the same authenticated fixtures the producer suite uses — cohortBoot + real roster
 * + checkPublication), so the "golden replay" (write → re-parse → recompute) exercises
 * genuine evidence.
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

const CODE_ARMS = defaultExpectedArms();
const ARMS: ArmSpec[] = CODE_ARMS.map((a) => ({
  participantId: a.participantId,
  provider: a.provider as ProviderName,
  requestedModelId: a.requestedModelId,
  credentialEnvVar: `${a.participantId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_KEY`,
}));

// --- fixtures (a real produced fire) ----------------------------------------

function scopedGame(markets: readonly MarketKey[]): GameBundle {
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
    awayTeam: 'Milwaukee Brewers',
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: m,
    evidenceRefs: [`ev:${GAME_ID}:identity`, `ev:${GAME_ID}:schedule`, `ev:${GAME_ID}:moneyline`, `ev:${GAME_ID}:total`],
  };
}

function scopedRequest(markets: readonly MarketKey[]): GameRequest {
  const game = scopedGame(markets);
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
  return {
    id: 1,
    jsonodds_id: GAME_ID,
    market,
    source: 'jsonodds',
    ...quote,
    captured_at: OPENER_AT,
    captured_at_ms: Date.parse(OPENER_AT),
  };
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

async function producedFire(markets: readonly MarketKey[] = ['moneyline', 'total']): Promise<FireArtifactV1> {
  const json = manifestJson();
  const booted: BootedCohort = cohortBoot({ live: false, manifestBytes: json });
  const publication = publicationFor(json);
  const cohortId = booted.cohortId;
  const request = scopedRequest(markets);
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

// --- serialization ----------------------------------------------------------

test('serialize is canonical, deterministic, and valid JSON', async () => {
  const a = await producedFire();
  const b = await producedFire();
  const sa = serializeFireArtifactV1(a);
  assert.equal(sa, serializeFireArtifactV1(a)); // stable for one artifact
  assert.equal(sa, serializeFireArtifactV1(b)); // two independent produced fires agree
  assert.equal(sa, canonicalize(a)); // canonical (clean artifact ⇒ redaction is a no-op)
  assert.doesNotThrow(() => JSON.parse(sa));
});

test('serialize is redaction-safe (a final sweep leaves clean bytes unchanged)', async () => {
  const bytes = serializeFireArtifactV1(await producedFire());
  assert.equal(redactSecrets(bytes), bytes);
});

// --- round-trip -------------------------------------------------------------

test('serialize → parse round-trips unchanged for a 2-market fire', async () => {
  const a = await producedFire(['moneyline', 'total']);
  assert.deepEqual(parseFireArtifactV1(serializeFireArtifactV1(a)), JSON.parse(JSON.stringify(a)));
});

test('serialize → parse round-trips unchanged for a 1-market fire', async () => {
  const a = await producedFire(['moneyline']);
  assert.deepEqual(parseFireArtifactV1(serializeFireArtifactV1(a)), JSON.parse(JSON.stringify(a)));
});

test('parse fails closed on malformed JSON and on an unknown field', async () => {
  assert.throws(() => parseFireArtifactV1('{ not json'));
  const a = await producedFire();
  const withExtra = { ...JSON.parse(serializeFireArtifactV1(a)), sneaky: 1 };
  assert.throws(() => parseFireArtifactV1(JSON.stringify(withExtra)));
});

// --- digest recomputation (the golden replay) -------------------------------

test('recompute finds no digest violations on a produced fire (1- and 2-market)', async () => {
  assert.deepEqual(recomputeFireArtifactDigests(await producedFire(['moneyline', 'total'])), []);
  assert.deepEqual(recomputeFireArtifactDigests(await producedFire(['moneyline'])), []);
});

test('a write → read → parse replay stays digest-consistent', async () => {
  const artifact = await producedFire();
  const dir = mkdtempSync(join(tmpdir(), 'ospex-fire-artifact-'));
  try {
    const filePath = join(dir, 'fire-1.json');
    writeFireArtifactV1(filePath, artifact);
    const bytes = readFileSync(filePath, 'utf8');
    assert.equal(bytes, serializeFireArtifactV1(artifact)); // on-disk == canonical serialization
    const parsed = parseFireArtifactV1(bytes);
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(artifact)));
    assert.deepEqual(recomputeFireArtifactDigests(parsed), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recompute detects a tampered hash, arm digest, and response body', async () => {
  const parsed = parseFireArtifactV1(serializeFireArtifactV1(await producedFire()));
  assert.deepEqual(recomputeFireArtifactDigests(parsed), []);

  // A tampered request hash no longer recomputes from the retained preimage.
  assert.ok(recomputeFireArtifactDigests({ ...parsed, requestSha256: 'b'.repeat(64) }).length > 0);

  // A tampered arm digest no longer recomputes from its persisted domain.
  const digestTampered = parsed.arms.map((a, i) => (i === 0 ? { ...a, armDigest: 'c'.repeat(64) } : a));
  assert.ok(recomputeFireArtifactDigests({ ...parsed, arms: digestTampered }).length > 0);

  // A tampered persisted body breaks both its responseSha256 and the arm digest.
  const bodyTampered = parsed.arms.map((a, i) =>
    i === 0
      ? { ...a, orderedAttempts: a.orderedAttempts.map((att, j) => (j === 0 ? { ...att, persistedResponseBody: 'tampered' } : att)) }
      : a,
  );
  assert.ok(recomputeFireArtifactDigests({ ...parsed, arms: bodyTampered }).length >= 2);
});
