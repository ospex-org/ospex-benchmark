import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import { cohortBoot } from './cohortBoot.js';
import { evaluateCandidate } from './detection.js';
import { armDigest } from './fireArtifact.js';
import {
  assertFireArtifact,
  buildFireArtifact,
  fireArtifactV1Schema,
} from './fireArtifactProducer.js';
import type { FireContext, MarketFireContextV1 } from './fireArtifactProducer.js';
import { checkPublication } from './manifestPublication.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { MODEL_PRICE_TABLE_DIGEST, MODEL_PRICE_TABLE_VERSION } from './modelPriceTable.js';
import { promptScaffoldSha256 } from './prompt.js';
import { ProviderTimeoutError } from './providers/errors.js';
import { runSlate } from './runner.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import type { BootedCohort } from './cohortBoot.js';
import type { CandidateInput } from './detection.js';
import type { PublicationVerified } from './manifestPublication.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { RunEnvelope } from './runner.js';
import type { GameRequest } from './bundle.js';
import { SMOKE_LABEL } from './types.js';
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
 * The fire-artifact producer (SPEC §4/§5). Every test drives real code: the
 * envelope comes through `runSlate` (branded), the booted cohort through the
 * canonical `cohortBoot` (a code-consistent manifest), the publication through
 * `checkPublication` (branded, cohort-bound), the detection context re-evaluates
 * through the real `evaluateCandidate`, and the opener/as-of/baselines are
 * re-derived — so each gate is exercised against the actual guard.
 *
 * MLB's market policy enables moneyline + total only (the run line is off), so a
 * fire's scope is a subset of {moneyline, total}; fixtures respect that and use the
 * scoped baseline policy (v0.3).
 */

const GAME_ID = '00000000-0000-4000-8000-0000000000f1';
const GAME_ID_2 = '00000000-0000-4000-8000-0000000000f2';
const CUTOFF = '2026-07-18T20:00:00+00:00';
const WINDOW_START = '2026-07-18T00:00:00.000Z';
const WINDOW_END = '2026-07-19T00:00:00.000Z';
const BUNDLE_TS = '2026-07-18T12:00:00.000Z';
const DETECTED_AT = '2026-07-18T12:00:30.000Z'; // 60 s after opener, in window
const OPENER_AT = '2026-07-18T11:59:30.000Z';
const OBSERVED_AT = '2026-07-18T11:58:00+00:00'; // market quote, before the bundle
const BUNDLE_BUILT_AT = '2026-07-18T12:00:31.000Z';
const COMMITTER_TS = '2026-07-17T23:00:00+00:00'; // strictly before windowStart
const NOW_MS = Date.parse('2026-07-18T12:00:40.000Z'); // after detection, before cutoff
const W = 120_000;
const SKEW = 5_000;

// The real code roster (the manifest must equal it to pass cohortBoot).
const CODE_ARMS = defaultExpectedArms();
const ARMS: ArmSpec[] = CODE_ARMS.map((a) => ({
  participantId: a.participantId,
  provider: a.provider as ProviderName,
  requestedModelId: a.requestedModelId,
  credentialEnvVar: `${a.participantId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_KEY`,
}));

// --- game / request / response fixtures (scoped to a market subset) ---------

function scopedGame(markets: readonly MarketKey[], gameId = GAME_ID): GameBundle {
  const m: GameBundle['markets'] = {};
  if (markets.includes('moneyline')) {
    m.moneyline = { awayDecimal: 1.74627, homeDecimal: 2.17, observedAt: OBSERVED_AT, evidenceRef: `ev:${gameId}:moneyline` };
  }
  if (markets.includes('total')) {
    m.total = { line: 8.5, overDecimal: 1.90909, underDecimal: 1.90909, observedAt: OBSERVED_AT, evidenceRef: `ev:${gameId}:total` };
  }
  return {
    gameId,
    league: 'mlb',
    scheduledStartUtc: CUTOFF,
    awayTeam: 'Milwaukee Brewers',
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: m,
    evidenceRefs: [`ev:${gameId}:identity`, `ev:${gameId}:schedule`, `ev:${gameId}:moneyline`, `ev:${gameId}:total`],
  };
}

function scopedRequest(markets: readonly MarketKey[], gameId = GAME_ID): GameRequest {
  const game = scopedGame(markets, gameId);
  const requestBundle: SlateBundle = {
    schemaVersion: 1,
    label: SMOKE_LABEL,
    league: 'mlb',
    slateDate: '2026-07-18',
    bundleTimestamp: BUNDLE_TS,
    cutoffAt: CUTOFF,
    games: [game],
  };
  return { gameId, slug: 'mil-pit-2026-07-18', game, requestBundle, requestSha256: sha256Hex(canonicalize(requestBundle)) };
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

function stubAdapter(arm: ArmSpec, handlers: Array<() => ProviderResponse>): ProviderAdapter {
  let index = 0;
  return {
    provider: arm.provider,
    requestedModelId: arm.requestedModelId,
    credentialEnvVar: arm.credentialEnvVar,
    hasCredential: () => true,
    async chat(): Promise<ProviderResponse> {
      const handler = handlers[index];
      index += 1;
      if (!handler) throw new Error(`stub adapter for ${arm.participantId}: no handler`);
      return handler();
    },
  };
}

// --- manifest / boot / publication fixtures ---------------------------------

function manifestObject(over: { baselinePolicyVersion?: string; network?: string } = {}): Record<string, unknown> {
  return {
    artifactSchemaVersion: 1,
    network: over.network ?? 'polygon',
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
    baselinePolicyVersion: over.baselinePolicyVersion ?? 'baselines-v0.3.0',
    repairPolicyVersion: 'repair-v1',
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: MODEL_PRICE_TABLE_VERSION,
    modelPriceTableDigest: MODEL_PRICE_TABLE_DIGEST,
    spendReservationPolicyVersion: 'fixed-attempt-v1',
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
      providerAttemptReservationUsdMicros: 100_000_000,
      ingestionGraceMs: 900_000,
      scheduleChangeToleranceMs: 60_000,
      maxConcurrentProviderRequests: Math.max(8, CODE_ARMS.length),
      maxDispatchesPerTick: 8,
    },
    cohortCallCap: 1_000,
    cohortSpendCapUsdMicros: 1_000_000,
  };
}

function manifestJson(over?: { baselinePolicyVersion?: string; network?: string }): string {
  return JSON.stringify(manifestObject(over));
}

function bootFrom(json: string): BootedCohort {
  return cohortBoot({ live: false, manifestBytes: json });
}

function publicationFor(json: string): PublicationVerified {
  const bytes = new TextEncoder().encode(json);
  return checkPublication({
    localManifestBytes: bytes,
    publication: { repositoryOwner: 'ospex-org', repositoryName: 'ospex-benchmark', path: 'manifests/cohort.json', commitSha: 'a'.repeat(40) },
    resolved: { blobBytes: bytes, committerTimestamp: COMMITTER_TS },
  });
}

// --- detection context fixtures ---------------------------------------------

function historyRow(market: MarketKey, over: Partial<TwoSidedHistoryRow> = {}): TwoSidedHistoryRow {
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
    ...over,
  };
}

function candidateInput(market: MarketKey, over: Partial<CandidateInput> = {}): CandidateInput {
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
    ...over,
  };
}

function marketCtx(
  market: MarketKey,
  cohortId: string,
  fireId: string,
  over: { watermark?: number | null; detectedAt?: string } = {},
): MarketFireContextV1 {
  const ci = candidateInput(market, over.detectedAt !== undefined ? { detectedAt: over.detectedAt } : {});
  return {
    candidateInput: ci,
    verdict: evaluateCandidate(ci),
    historyRows: [historyRow(market)],
    historyWatermark: over.watermark === undefined ? null : over.watermark,
    claim: { cohortId, fireId, gameId: GAME_ID, market },
  };
}

function makeCtx(
  cohortId: string,
  booted: BootedCohort,
  publication: PublicationVerified,
  markets: readonly MarketKey[],
  fireId = 'fire-1',
): FireContext {
  return {
    booted,
    fireId,
    runId: 'run-1',
    publication,
    bundleBuiltAt: BUNDLE_BUILT_AT,
    perMarket: markets.map((m) => marketCtx(m, cohortId, fireId)),
  };
}

async function makeEnv(opts: {
  markets: readonly MarketKey[];
  arms: readonly ArmSpec[];
  cohortId: string;
  baselinePolicyVersion?: string;
  outcomeFor?: (arm: ArmSpec) => 'valid' | 'timeout';
}): Promise<RunEnvelope> {
  const request = scopedRequest(opts.markets);
  const adapters = new Map<string, ProviderAdapter>();
  for (const arm of opts.arms) {
    const outcome = opts.outcomeFor?.(arm) ?? 'valid';
    const handler =
      outcome === 'timeout'
        ? () => {
            throw new ProviderTimeoutError(arm.provider, 600_000);
          }
        : () => stubResponse(JSON.stringify(scopedResponse(request, arm, opts.cohortId)), arm.requestedModelId);
    adapters.set(arm.participantId, stubAdapter(arm, [handler]));
  }
  return runSlate([...opts.arms], adapters, [request], {
    cohortId: opts.cohortId,
    timeoutMs: 600_000,
    maxOutputTokens: 16_000,
    executionPolicy: 'fixed-moneyline-total',
    baselinePolicyVersion: (opts.baselinePolicyVersion ?? 'baselines-v0.3.0') as never,
    nowMs: () => NOW_MS,
  });
}

/** A complete, valid fire: authenticated booted cohort + publication + branded env. */
async function buildFire(
  opts: {
    markets?: readonly MarketKey[];
    arms?: readonly ArmSpec[];
    outcomeFor?: (arm: ArmSpec) => 'valid' | 'timeout';
  } = {},
): Promise<{ env: RunEnvelope; ctx: FireContext; booted: BootedCohort; publication: PublicationVerified; cohortId: string; markets: readonly MarketKey[] }> {
  const markets = opts.markets ?? (['moneyline', 'total'] as const);
  const arms = opts.arms ?? ARMS;
  const json = manifestJson();
  const booted = bootFrom(json);
  const publication = publicationFor(json);
  const cohortId = booted.cohortId;
  const env = await makeEnv({ markets, arms, cohortId, ...(opts.outcomeFor ? { outcomeFor: opts.outcomeFor } : {}) });
  const ctx = makeCtx(cohortId, booted, publication, markets);
  return { env, ctx, booted, publication, cohortId, markets };
}

// --- happy path -------------------------------------------------------------

test('builds a valid 2-market fire artifact with the expected shape', async () => {
  const { env, ctx, cohortId } = await buildFire();
  const artifact = buildFireArtifact(env, ctx);

  assert.equal(artifact.artifactSchemaVersion, 1);
  assert.equal(artifact.cohortId, cohortId);
  assert.equal(artifact.publication.cohortId, cohortId);
  assert.equal(artifact.fireId, 'fire-1');
  assert.equal(artifact.gameId, GAME_ID);
  assert.equal(artifact.sport, 'mlb');
  assert.deepEqual(artifact.scopedMarkets, ['moneyline', 'total']);
  assert.equal(artifact.scheduledAtAtFire, CUTOFF);
  assert.equal(artifact.detectedAt, DETECTED_AT);
  assert.equal(artifact.preparedSnapshotTs, BUNDLE_TS);

  assert.equal(artifact.marketEvidence.length, 2);
  assert.deepEqual(artifact.marketEvidence.map((m) => m.market), ['moneyline', 'total']);
  assert.equal(artifact.marketEvidence[0]?.openerAgeMs, 60_000);
  assert.deepEqual(artifact.marketEvidence[0]?.historyReadMode, { mode: 'live-unbounded' });
  // The claim linkage is the sole per-market carrier, bound to (cohort, fire, game, market).
  assert.deepEqual(artifact.marketEvidence[0]?.claim, { cohortId: artifact.cohortId, fireId: 'fire-1', gameId: GAME_ID, market: 'moneyline' });
  assert.deepEqual(artifact.marketEvidence[1]?.claim, { cohortId: artifact.cohortId, fireId: 'fire-1', gameId: GAME_ID, market: 'total' });

  assert.equal(artifact.arms.length, ARMS.length);
  assert.equal(artifact.expectedArmIdentities.length, ARMS.length);
  const anyArm = artifact.arms[0]!;
  assert.match(anyArm.armDigest, /^[0-9a-f]{64}$/);
  assert.ok(artifact.arms.every((a) => a.terminalOutcome === 'valid'));
  assert.deepEqual(anyArm.acceptedDecisionFingerprint?.map((d) => d.market), ['moneyline', 'total']);

  const baselineMarkets = [...new Set(artifact.baselineDecisions.map((d) => d.market))].sort();
  assert.deepEqual(baselineMarkets, ['moneyline', 'total']);
  assert.ok(artifact.baselineDecisions.every((d) => d.gameId === GAME_ID));
});

test('a 1-market (moneyline-only) fire scopes everything to that market', async () => {
  const { env, ctx } = await buildFire({ markets: ['moneyline'] });
  const artifact = buildFireArtifact(env, ctx);
  assert.deepEqual(artifact.scopedMarkets, ['moneyline']);
  assert.equal(artifact.marketEvidence.length, 1);
  assert.deepEqual(artifact.marketEvidence[0]?.claim, { cohortId: artifact.cohortId, fireId: 'fire-1', gameId: GAME_ID, market: 'moneyline' });
  assert.deepEqual([...new Set(artifact.baselineDecisions.map((d) => d.market))], ['moneyline']);
  assert.deepEqual(artifact.arms[0]?.acceptedDecisionFingerprint?.map((d) => d.market), ['moneyline']);
});

test('retains the exact scoped request bundle as the digest preimage', async () => {
  const { env, ctx } = await buildFire();
  const artifact = buildFireArtifact(env, ctx);
  const sealed = env.snapshot.prepared[0]!.requestBundle;
  // The retained request graph is the exact sealed bundle, detached + plain JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(artifact.requestBundle)), JSON.parse(JSON.stringify(sealed)));
  // All three digests recompute from the retained value.
  assert.equal(sha256Hex(canonicalize(artifact.requestBundle)), artifact.requestSha256);
  assert.equal(sha256Hex(canonicalize(artifact.requestBundle.games[0])), artifact.gameSha256);
  assert.equal(artifact.slateSha256, artifact.requestSha256); // single-game slate == request
  // The scope is the present markets in the retained request game.
  const g = artifact.requestBundle.games[0]!;
  assert.ok(g.markets.moneyline && g.markets.total && !g.markets.runLine);
});

test('the produced artifact is deterministic (byte-identical canonicalization)', async () => {
  const a = await buildFire();
  const b = await buildFire();
  assert.equal(canonicalize(buildFireArtifact(a.env, a.ctx)), canonicalize(buildFireArtifact(b.env, b.ctx)));
});

test('the output is deeply frozen and branded, rejecting any copy', async () => {
  const { env, ctx } = await buildFire();
  const artifact = buildFireArtifact(env, ctx);
  assert.ok(Object.isFrozen(artifact));
  assert.ok(Object.isFrozen(artifact.arms));
  assert.ok(Object.isFrozen(artifact.requestBundle));
  assert.ok(Object.isFrozen(artifact.marketEvidence[0]?.opener));
  assert.throws(() => {
    (artifact as { fireId: string }).fireId = 'tampered';
  });
  assert.doesNotThrow(() => assertFireArtifact(artifact));
  assert.throws(() => assertFireArtifact({ ...artifact }), /not produced by buildFireArtifact/);
  assert.throws(() => assertFireArtifact(JSON.parse(JSON.stringify(artifact))), /not produced by buildFireArtifact/);
});

test('the output round-trips through its own strict schema unchanged', async () => {
  const { env, ctx } = await buildFire();
  const artifact = buildFireArtifact(env, ctx);
  const reparsed = fireArtifactV1Schema.parse(JSON.parse(JSON.stringify(artifact)));
  assert.deepEqual(reparsed, JSON.parse(JSON.stringify(artifact)));
});

test('a frozen-watermark read mode is persisted on the market evidence', async () => {
  const { env, cohortId, booted, publication } = await buildFire();
  const ctx: FireContext = {
    booted,
    fireId: 'fire-1',
    runId: 'run-1',
    publication,
    bundleBuiltAt: BUNDLE_BUILT_AT,
    perMarket: (['moneyline', 'total'] as const).map((m) => marketCtx(m, cohortId, 'fire-1', { watermark: 500 })),
  };
  const artifact = buildFireArtifact(env, ctx);
  assert.deepEqual(artifact.marketEvidence[0]?.historyReadMode, { mode: 'frozen-watermark', watermark: 500 });
});

test('a non-valid arm is retained with one terminal outcome and no accepted decision', async () => {
  const timeoutArm = ARMS[ARMS.length - 1]!;
  const { env, ctx } = await buildFire({
    outcomeFor: (arm) => (arm.participantId === timeoutArm.participantId ? 'timeout' : 'valid'),
  });
  const artifact = buildFireArtifact(env, ctx);
  assert.equal(artifact.arms.length, ARMS.length);
  const armT = artifact.arms.find((a) => a.expectedArmIdentity.participantId === timeoutArm.participantId)!;
  assert.equal(armT.terminalOutcome, 'timeout');
  assert.equal(armT.acceptedResponseDigest, null);
  assert.equal(armT.acceptedDecisionFingerprint, null);
  assert.equal(armT.orderedAttempts.length, 1);
  assert.equal(armT.orderedAttempts[0]?.transport, 'timeout');
  assert.match(armT.armDigest, /^[0-9a-f]{64}$/);
});

test('B3-R1 (producer): a never-sent (legacy-cutoff) fire persists the refused start with zero attempts and the never-sent digest', async () => {
  const json = manifestJson();
  const booted = bootFrom(json);
  const publication = publicationFor(json);
  const cohortId = booted.cohortId;
  const request = scopedRequest(['moneyline', 'total']);
  // A clock past first pitch (CUTOFF = 20:00) → every arm hits the legacy pre-dispatch cutoff and is
  // never sent. Detection (12:00:30, in window) is independent of the dispatch clock, so the fire is
  // still produced. The eight arms read the ONE constant clock, so each carries the same reading.
  const LATE = Date.parse('2026-07-18T20:00:01.000Z');
  const REFUSED = new Date(LATE).toISOString();
  const adapters = new Map<string, ProviderAdapter>();
  for (const arm of ARMS) {
    // chat throws if reached — a legacy-cutoff initial must never send.
    adapters.set(
      arm.participantId,
      stubAdapter(arm, [
        () => {
          throw new Error('a legacy-cutoff initial must not send');
        },
      ]),
    );
  }
  const env = await runSlate([...ARMS], adapters, [request], {
    cohortId,
    timeoutMs: 600_000,
    maxOutputTokens: 16_000,
    executionPolicy: 'fixed-moneyline-total',
    baselinePolicyVersion: 'baselines-v0.3.0',
    nowMs: () => LATE,
  });
  assert.ok(env.results.every((r) => r.outcome === 'cutoff_missed'), 'every arm hit the legacy pre-dispatch cutoff');
  assert.ok(env.results.every((r) => r.attempt.requestAt === null), 'no phantom attempt on the result');
  assert.ok(env.results.every((r) => r.refusedInitialStartAt === REFUSED), 'the runner carries the ONE reading');

  const ctx = makeCtx(cohortId, booted, publication, ['moneyline', 'total']);
  const artifact = buildFireArtifact(env, ctx);
  for (const arm of artifact.arms) {
    assert.equal(arm.terminalOutcome, 'cutoff_missed');
    assert.equal(arm.initialRequestStartedAt, REFUSED, 'the producer re-sources the refused start as initialRequestStartedAt');
    assert.equal(arm.orderedAttempts.length, 0, 'zero attempts — no phantom sent attempt');
    // armDigest equals the current never-sent digest: its ten-field domain excludes
    // initialRequestStartedAt and orderedAttempts is empty, so the carrier does not touch the digest.
    const neverSentDigest = armDigest({
      cohortId: artifact.cohortId,
      fireId: artifact.fireId,
      runId: artifact.runId,
      participantId: arm.expectedArmIdentity.participantId,
      requestSha256: artifact.requestSha256,
      expectedArmIdentity: arm.expectedArmIdentity,
      orderedAttempts: [],
      terminalOutcome: 'cutoff_missed',
      acceptedResponseDigestOrNull: null,
      acceptedDecisionFingerprintOrNull: null,
    });
    assert.equal(arm.armDigest, neverSentDigest, 'armDigest is the never-sent digest (the carrier is excluded from its domain)');
  }
});

// --- adversarial: authority-input authentication ----------------------------

test('rejects a forged (unbranded) envelope', async () => {
  const { env, ctx } = await buildFire();
  const forged = {
    snapshot: env.snapshot,
    results: env.results,
    expectedArms: env.expectedArms,
    dispatch: { ...env.dispatch },
    baselinePolicyVersion: env.baselinePolicyVersion,
  } as unknown as RunEnvelope;
  assert.throws(() => buildFireArtifact(forged, ctx), /not produced by runSlate/);
});

test('rejects a hand-built (unbranded) booted cohort', async () => {
  const { env, ctx, booted } = await buildFire();
  const fake: BootedCohort = { cohortId: booted.cohortId, manifest: booted.manifest };
  assert.throws(() => buildFireArtifact(env, { ...ctx, booted: fake }), /not produced by cohortBoot/);
});

test('rejects a structurally-identical copy of a genuine booted cohort', async () => {
  const { env, ctx, booted } = await buildFire();
  assert.throws(() => buildFireArtifact(env, { ...ctx, booted: { ...booted } }), /not produced by cohortBoot/);
});

test('rejects a hand-built (unbranded) publication record', async () => {
  const { env, ctx, booted } = await buildFire();
  const fake: PublicationVerified = {
    publication: { repositoryOwner: 'ospex-org', repositoryName: 'ospex-benchmark', path: 'm.json', commitSha: 'a'.repeat(40) },
    committerTimestamp: COMMITTER_TS,
    cohortId: booted.cohortId,
  };
  assert.throws(() => buildFireArtifact(env, { ...ctx, publication: fake }), /not produced by checkPublication/);
});

test('rejects a genuine publication verified for a different cohort', async () => {
  const { env, ctx } = await buildFire();
  const otherPub = publicationFor(manifestJson({ network: 'ethereum' })); // branded, but a different cohortId
  assert.throws(() => buildFireArtifact(env, { ...ctx, publication: otherPub }), /publication was verified for cohort/);
});

// --- adversarial: candidate authority reconciliation ------------------------

test('rejects a candidate whose clean-entry window is widened over the manifest', async () => {
  const { env, ctx } = await buildFire();
  const widened: MarketFireContextV1 = {
    ...ctx.perMarket[0]!,
    candidateInput: { ...ctx.perMarket[0]!.candidateInput, cleanEntryWindowMs: 600_000 },
  };
  assert.throws(
    () => buildFireArtifact(env, { ...ctx, perMarket: [widened, ctx.perMarket[1]!] }),
    /cleanEntryWindowMs 600000 != manifest 120000/,
  );
});

test('rejects a candidate window that disagrees with the manifest', async () => {
  const { env, ctx } = await buildFire();
  const shifted: MarketFireContextV1 = {
    ...ctx.perMarket[0]!,
    candidateInput: { ...ctx.perMarket[0]!.candidateInput, windowStart: '2026-07-17T00:00:00.000Z' },
  };
  assert.throws(() => buildFireArtifact(env, { ...ctx, perMarket: [shifted, ctx.perMarket[1]!] }), /windowStart .* != manifest/);
});

test('rejects a candidate whose sportAllowList disagrees with the manifest', async () => {
  const { env, ctx } = await buildFire();
  const bad: MarketFireContextV1 = {
    ...ctx.perMarket[0]!,
    candidateInput: { ...ctx.perMarket[0]!.candidateInput, sportAllowList: ['mlb', 'nfl'] },
  };
  assert.throws(() => buildFireArtifact(env, { ...ctx, perMarket: [bad, ctx.perMarket[1]!] }), /sportAllowList != manifest/);
});

// --- adversarial: history / timestamp grammar -------------------------------

test('rejects a history row whose captured_at is not a coherent instant', async () => {
  const { env, ctx } = await buildFire();
  const badRow = historyRow('moneyline', {
    id: 2,
    captured_at: 'not-an-instant',
    captured_at_ms: Date.parse('2026-07-18T11:59:45.000Z'),
  });
  const bad: MarketFireContextV1 = { ...ctx.perMarket[0]!, historyRows: [historyRow('moneyline'), badRow] };
  assert.throws(() => buildFireArtifact(env, { ...ctx, perMarket: [bad, ctx.perMarket[1]!] }), /invalid row/);
});

test('rejects a malformed bundleBuiltAt instant', async () => {
  const { env, ctx } = await buildFire();
  assert.throws(() => buildFireArtifact(env, { ...ctx, bundleBuiltAt: 'not-an-instant' }), /instant/i);
});

// --- adversarial: structure / identity / bijection --------------------------

test('rejects a multi-game envelope', async () => {
  const json = manifestJson();
  const booted = bootFrom(json);
  const publication = publicationFor(json);
  const cohortId = booted.cohortId;
  const reqA = scopedRequest(['moneyline', 'total'], GAME_ID);
  const reqB = scopedRequest(['moneyline', 'total'], GAME_ID_2);
  const adapters = new Map<string, ProviderAdapter>();
  for (const arm of ARMS) {
    adapters.set(
      arm.participantId,
      stubAdapter(arm, [
        () => stubResponse(JSON.stringify(scopedResponse(reqA, arm, cohortId)), arm.requestedModelId),
        () => stubResponse(JSON.stringify(scopedResponse(reqB, arm, cohortId)), arm.requestedModelId),
      ]),
    );
  }
  const env = await runSlate([...ARMS], adapters, [reqA, reqB], {
    cohortId,
    timeoutMs: 600_000,
    maxOutputTokens: 16_000,
    executionPolicy: 'fixed-moneyline-total',
    baselinePolicyVersion: 'baselines-v0.3.0',
    nowMs: () => NOW_MS,
  });
  const ctx = makeCtx(cohortId, booted, publication, ['moneyline', 'total']);
  assert.throws(() => buildFireArtifact(env, ctx), /exactly one dispatched game/);
});

test('rejects a booted cohort whose identity disagrees with the envelope', async () => {
  const { env } = await buildFire(); // envelope on the default (polygon) cohort
  const otherJson = manifestJson({ network: 'ethereum' });
  const otherBooted = bootFrom(otherJson);
  const otherPub = publicationFor(otherJson);
  const ctx = makeCtx(otherBooted.cohortId, otherBooted, otherPub, ['moneyline', 'total']);
  assert.throws(() => buildFireArtifact(env, ctx), /!= booted cohortId/);
});

test('rejects a context whose markets differ from the dispatched scope', async () => {
  const { env, ctx } = await buildFire({ markets: ['moneyline', 'total'] });
  assert.throws(() => buildFireArtifact(env, { ...ctx, perMarket: [ctx.perMarket[0]!] }), /fire context markets .* != scope/);
});

test('rejects a candidate bound to a different game', async () => {
  const { env, ctx, cohortId } = await buildFire();
  const bad: MarketFireContextV1 = {
    ...ctx.perMarket[0]!,
    candidateInput: { ...ctx.perMarket[0]!.candidateInput, gameId: 'some-other-game' },
    claim: { cohortId, fireId: 'fire-1', gameId: GAME_ID, market: 'moneyline' },
  };
  assert.throws(() => buildFireArtifact(env, { ...ctx, perMarket: [bad, ctx.perMarket[1]!] }), /candidate gameId some-other-game != fire gameId/);
});

test('rejects an ineligible re-evaluation', async () => {
  const { env, ctx, cohortId } = await buildFire();
  const lateInput = candidateInput('moneyline', { detectedAt: '2026-07-20T00:00:00.000Z' });
  const bad: MarketFireContextV1 = {
    candidateInput: lateInput,
    verdict: evaluateCandidate(lateInput),
    historyRows: [historyRow('moneyline')],
    historyWatermark: null,
    claim: { cohortId, fireId: 'fire-1', gameId: GAME_ID, market: 'moneyline' },
  };
  assert.throws(() => buildFireArtifact(env, { ...ctx, perMarket: [bad, ctx.perMarket[1]!] }), /re-evaluates to detected_after_window, not eligible/);
});

test('rejects a recorded verdict that disagrees with its re-derivation', async () => {
  const { env, ctx } = await buildFire();
  const real = ctx.perMarket[0]!;
  const realVerdict = evaluateCandidate(real.candidateInput);
  assert.equal(realVerdict.state, 'eligible');
  const tampered: MarketFireContextV1 = {
    ...real,
    verdict: { ...realVerdict, openerAgeMs: (realVerdict as { openerAgeMs: number }).openerAgeMs + 1 },
  };
  assert.throws(() => buildFireArtifact(env, { ...ctx, perMarket: [tampered, ctx.perMarket[1]!] }), /does not match its re-derivation/);
});

test('rejects an opener that is not the firstTwoSided of the supplied history', async () => {
  const { env, ctx } = await buildFire();
  const earlier = historyRow('moneyline', {
    id: 99,
    captured_at: '2026-07-18T11:00:00.000Z',
    captured_at_ms: Date.parse('2026-07-18T11:00:00.000Z'),
  });
  const bad: MarketFireContextV1 = { ...ctx.perMarket[0]!, historyRows: [earlier] };
  assert.throws(() => buildFireArtifact(env, { ...ctx, perMarket: [bad, ctx.perMarket[1]!] }), /is not the firstTwoSided of the supplied history/);
});

test('rejects a claim not bound to the fire', async () => {
  const { env, ctx, cohortId } = await buildFire();
  const bad: MarketFireContextV1 = {
    ...ctx.perMarket[0]!,
    claim: { cohortId, fireId: 'a-different-fire', gameId: GAME_ID, market: 'moneyline' },
  };
  assert.throws(() => buildFireArtifact(env, { ...ctx, perMarket: [bad, ctx.perMarket[1]!] }), /claim reference does not bind to fire/);
});

test('rejects scoped markets that disagree on the detection instant', async () => {
  const { env, cohortId, booted, publication } = await buildFire();
  const ctx: FireContext = {
    booted,
    fireId: 'fire-1',
    runId: 'run-1',
    publication,
    bundleBuiltAt: BUNDLE_BUILT_AT,
    perMarket: [
      marketCtx('moneyline', cohortId, 'fire-1'),
      marketCtx('total', cohortId, 'fire-1', { detectedAt: '2026-07-18T12:00:45.000Z' }),
    ],
  };
  assert.throws(() => buildFireArtifact(env, ctx), /share one detection instant/);
});

test('rejects a baseline policy that disagrees with the manifest', async () => {
  const json = manifestJson(); // manifest pins v0.3
  const booted = bootFrom(json);
  const publication = publicationFor(json);
  const cohortId = booted.cohortId;
  const env = await makeEnv({ markets: ['moneyline', 'total'], arms: ARMS, cohortId, baselinePolicyVersion: 'baselines-v0.2.0' });
  const ctx = makeCtx(cohortId, booted, publication, ['moneyline', 'total']);
  assert.throws(() => buildFireArtifact(env, ctx), /baselinePolicyVersion .* != manifest/);
});

test('rejects a dispatched roster that is not the manifest roster', async () => {
  const json = manifestJson();
  const booted = bootFrom(json);
  const publication = publicationFor(json);
  const cohortId = booted.cohortId;
  const subset = ARMS.slice(0, ARMS.length - 1); // dispatch fewer than the manifest roster
  const env = await makeEnv({ markets: ['moneyline', 'total'], arms: subset, cohortId });
  const ctx = makeCtx(cohortId, booted, publication, ['moneyline', 'total']);
  assert.throws(() => buildFireArtifact(env, ctx), /dispatched roster does not equal the manifest/);
});

test('rejects an arm-family mismatch between the dispatch and the manifest', async () => {
  const json = manifestJson();
  const booted = bootFrom(json);
  const publication = publicationFor(json);
  const cohortId = booted.cohortId;
  // Dispatch the first arm under a deliberately-wrong provider.
  const wrongProvider: ProviderName = ARMS[0]!.provider === 'openai' ? 'anthropic' : 'openai';
  const arms = ARMS.map((a, i) => (i === 0 ? { ...a, provider: wrongProvider } : a));
  const env = await makeEnv({ markets: ['moneyline', 'total'], arms, cohortId });
  const ctx = makeCtx(cohortId, booted, publication, ['moneyline', 'total']);
  assert.throws(() => buildFireArtifact(env, ctx), /manifest expects/);
});
