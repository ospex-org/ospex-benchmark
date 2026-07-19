import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import { evaluateCandidate } from './detection.js';
import {
  assertFireArtifact,
  buildFireArtifact,
  fireArtifactV1Schema,
} from './fireArtifactProducer.js';
import type { FireContext, MarketFireContextV1 } from './fireArtifactProducer.js';
import { cohortId as deriveCohortId, parseManifest } from './manifest.js';
import { ProviderTimeoutError } from './providers/errors.js';
import { runSlate } from './runner.js';
import { SMOKE_LABEL } from './types.js';
import type { BootedCohort } from './cohortBoot.js';
import type { CandidateInput } from './detection.js';
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
  ProviderResponse,
  SlateBundle,
} from './types.js';

/**
 * The fire-artifact producer (SPEC §4/§5/§6). Every test drives real code: the
 * envelope comes through `runSlate` (branded), the detection context re-evaluates
 * through the real `evaluateCandidate`, and the opener/as-of/baselines are
 * re-derived — so each gate is exercised against the actual guard.
 *
 * MLB's market policy enables moneyline + total only (the run line is off), so a
 * fire's scope is a subset of {moneyline, total}; fixtures respect that and use
 * the scoped baseline policy (v0.3).
 */

const GAME_ID = '00000000-0000-4000-8000-0000000000f1';
const CUTOFF = '2026-07-18T20:00:00+00:00';
const WINDOW_START = '2026-07-18T00:00:00.000Z';
const WINDOW_END = '2026-07-19T00:00:00.000Z';
const BUNDLE_TS = '2026-07-18T12:00:00.000Z';
const DETECTED_AT = '2026-07-18T12:00:30.000Z';
const OPENER_AT = '2026-07-18T11:59:30.000Z'; // 60 s before detection, in window
const OBSERVED_AT = '2026-07-18T11:58:00+00:00'; // market quote, before the bundle
const NOW_MS = Date.parse('2026-07-18T12:00:40.000Z'); // after detection, before cutoff
const W = 120_000;
const SKEW = 5_000;

const ARM_A: ArmSpec = {
  participantId: 'arm-a',
  provider: 'openai',
  requestedModelId: 'model-a',
  credentialEnvVar: 'STUB_A_KEY',
};
const ARM_B: ArmSpec = {
  participantId: 'arm-b',
  provider: 'anthropic',
  requestedModelId: 'model-b',
  credentialEnvVar: 'STUB_B_KEY',
};

// --- game / request / response fixtures (scoped to a market subset) ---------

function scopedGame(markets: readonly MarketKey[]): GameBundle {
  const m: GameBundle['markets'] = {};
  if (markets.includes('moneyline')) {
    m.moneyline = {
      awayDecimal: 1.74627,
      homeDecimal: 2.17,
      observedAt: OBSERVED_AT,
      evidenceRef: `ev:${GAME_ID}:moneyline`,
    };
  }
  if (markets.includes('total')) {
    m.total = {
      line: 8.5,
      overDecimal: 1.90909,
      underDecimal: 1.90909,
      observedAt: OBSERVED_AT,
      evidenceRef: `ev:${GAME_ID}:total`,
    };
  }
  return {
    gameId: GAME_ID,
    league: 'mlb',
    scheduledStartUtc: CUTOFF,
    awayTeam: 'Milwaukee Brewers',
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: m,
    evidenceRefs: [
      `ev:${GAME_ID}:identity`,
      `ev:${GAME_ID}:schedule`,
      `ev:${GAME_ID}:moneyline`,
      `ev:${GAME_ID}:total`,
    ],
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
  return {
    gameId: GAME_ID,
    slug: 'mil-pit-2026-07-18',
    game,
    requestBundle,
    requestSha256: sha256Hex(canonicalize(requestBundle)),
  };
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

function rosterOf(arms: readonly ArmSpec[]): unknown[] {
  return arms.map((a) => ({
    participantId: a.participantId,
    provider: a.provider,
    requestedModelId: a.requestedModelId,
    approvedReportedModelIds: [a.requestedModelId],
  }));
}

function rawManifest(opts: {
  roster: unknown[];
  network?: string;
  baselinePolicyVersion?: string;
}): unknown {
  return {
    artifactSchemaVersion: 1,
    network: opts.network ?? 'polygon',
    sportAllowList: ['mlb'],
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    source: 'jsonodds',
    sourceQueryVersion: 'source-query-v1',
    marketPolicyVersion: 'market-policy-v1',
    marketPolicyDigest: 'a'.repeat(64),
    promptScaffoldSha256: 'b'.repeat(64),
    expectedArmRoster: opts.roster,
    toolInferenceConfigSha256: 'c'.repeat(64),
    baselinePolicyVersion: opts.baselinePolicyVersion ?? 'baselines-v0.3.0',
    repairPolicyVersion: 'repair-v1',
    scoringPolicyVersion: 'scoring-v1',
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: 'prices-v1',
    modelPriceTableDigest: 'd'.repeat(64),
    runnerCommitSha: 'e'.repeat(40),
    constants: {
      pollIntervalMs: 30_000,
      cleanEntryWindowMs: 120_000,
      gameDiscoveryWindowHours: 168,
      maxClockSkewMs: 5_000,
      freshFireMs: 30_000,
      maxDispatchLagMs: 10_000,
      historyReadTimeoutMs: 30_000,
      providerCallTimeoutMs: 300_000,
      maxOutputTokens: 16_000,
      maxRepairAttemptsPerArm: 1,
      ingestionGraceMs: 900_000,
      scheduleChangeToleranceMs: 60_000,
      maxConcurrentProviderRequests: 4,
      maxDispatchesPerTick: 8,
    },
    cohortCallCap: 1_000,
    cohortSpendCapUsdMicros: 1_000_000,
  };
}

function bootedFrom(opts: { roster: unknown[]; network?: string; baselinePolicyVersion?: string }): BootedCohort {
  const manifest = parseManifest(rawManifest(opts));
  return { cohortId: deriveCohortId(manifest), manifest };
}

function bootedFor(
  arms: readonly ArmSpec[],
  o: { network?: string; baselinePolicyVersion?: string } = {},
): BootedCohort {
  return bootedFrom({ roster: rosterOf(arms), ...o });
}

function publication(): PublicationVerified {
  return {
    publication: {
      repositoryOwner: 'ospex-org',
      repositoryName: 'ospex-benchmark',
      path: 'manifests/cohort.json',
      commitSha: 'a'.repeat(40),
    },
    committerTimestamp: '2026-07-17T23:00:00+00:00',
  };
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
    marketPolicyVersion: 'market-policy-v1',
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
  markets: readonly MarketKey[],
  fireId = 'fire-1',
): FireContext {
  return {
    booted,
    fireId,
    runId: 'run-1',
    publication: publication(),
    bundleBuiltAt: '2026-07-18T12:00:31.000Z',
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

/** A complete, valid fire: env + context sharing one booted cohort. */
async function buildFire(
  opts: {
    markets?: readonly MarketKey[];
    arms?: readonly ArmSpec[];
    outcomeFor?: (arm: ArmSpec) => 'valid' | 'timeout';
  } = {},
): Promise<{ env: RunEnvelope; ctx: FireContext; booted: BootedCohort; cohortId: string; markets: readonly MarketKey[] }> {
  const markets = opts.markets ?? (['moneyline', 'total'] as const);
  const arms = opts.arms ?? [ARM_A];
  const booted = bootedFor(arms);
  const cohortId = booted.cohortId;
  const env = await makeEnv({ markets, arms, cohortId, ...(opts.outcomeFor ? { outcomeFor: opts.outcomeFor } : {}) });
  const ctx = makeCtx(cohortId, booted, markets);
  return { env, ctx, booted, cohortId, markets };
}

// --- happy path -------------------------------------------------------------

test('builds a valid 2-market fire artifact with the expected shape', async () => {
  const { env, ctx, cohortId } = await buildFire();
  const artifact = buildFireArtifact(env, ctx);

  assert.equal(artifact.artifactSchemaVersion, 1);
  assert.equal(artifact.cohortId, cohortId);
  assert.equal(artifact.fireId, 'fire-1');
  assert.equal(artifact.runId, 'run-1');
  assert.equal(artifact.gameId, GAME_ID);
  assert.equal(artifact.sport, 'mlb');
  assert.deepEqual(artifact.scopedMarkets, ['moneyline', 'total']);
  assert.equal(artifact.scheduledAtAtFire, CUTOFF);
  assert.equal(artifact.detectedAt, DETECTED_AT);
  assert.equal(artifact.preparedSnapshotTs, BUNDLE_TS);
  assert.equal(artifact.requestSha256, env.snapshot.prepared[0]?.requestSha256);
  assert.equal(artifact.slateSha256, env.snapshot.slateSha256);

  assert.equal(artifact.marketEvidence.length, 2);
  assert.deepEqual(artifact.marketEvidence.map((m) => m.market), ['moneyline', 'total']);
  assert.equal(artifact.marketEvidence[0]?.openerAgeMs, 60_000);
  assert.deepEqual(artifact.marketEvidence[0]?.historyReadMode, { mode: 'live-unbounded' });
  assert.equal(artifact.claims.length, 2);

  assert.equal(artifact.arms.length, 1);
  const arm = artifact.arms[0]!;
  assert.equal(arm.terminalOutcome, 'valid');
  assert.match(arm.armDigest, /^[0-9a-f]{64}$/);
  assert.equal(arm.acceptedResponseDigest?.length, 64);
  assert.deepEqual(arm.acceptedDecisionFingerprint?.map((d) => d.market), ['moneyline', 'total']);
  assert.equal(arm.expectedArmIdentity.participantId, 'arm-a');

  // baselines cover exactly the scope, all on this game
  const baselineMarkets = [...new Set(artifact.baselineDecisions.map((d) => d.market))].sort();
  assert.deepEqual(baselineMarkets, ['moneyline', 'total']);
  assert.ok(artifact.baselineDecisions.every((d) => d.gameId === GAME_ID));
});

test('a 1-market (moneyline-only) fire scopes everything to that market', async () => {
  const { env, ctx } = await buildFire({ markets: ['moneyline'] });
  const artifact = buildFireArtifact(env, ctx);
  assert.deepEqual(artifact.scopedMarkets, ['moneyline']);
  assert.equal(artifact.marketEvidence.length, 1);
  assert.equal(artifact.claims.length, 1);
  assert.deepEqual([...new Set(artifact.baselineDecisions.map((d) => d.market))], ['moneyline']);
  assert.deepEqual(artifact.arms[0]?.acceptedDecisionFingerprint?.map((d) => d.market), ['moneyline']);
});

test('the produced artifact is deterministic (byte-identical canonicalization)', async () => {
  const a = await buildFire();
  const b = await buildFire();
  assert.equal(
    canonicalize(buildFireArtifact(a.env, a.ctx)),
    canonicalize(buildFireArtifact(b.env, b.ctx)),
  );
});

test('the output is deeply frozen and branded, rejecting any copy', async () => {
  const { env, ctx } = await buildFire();
  const artifact = buildFireArtifact(env, ctx);
  assert.ok(Object.isFrozen(artifact));
  assert.ok(Object.isFrozen(artifact.arms));
  assert.ok(Object.isFrozen(artifact.arms[0]));
  assert.ok(Object.isFrozen(artifact.marketEvidence[0]?.opener));
  assert.throws(() => {
    (artifact as { fireId: string }).fireId = 'tampered';
  });
  // The brand accepts the genuine artifact and rejects a structurally-identical copy.
  assert.doesNotThrow(() => assertFireArtifact(artifact));
  assert.throws(() => assertFireArtifact({ ...artifact }), /not produced by buildFireArtifact/);
  assert.throws(
    () => assertFireArtifact(JSON.parse(JSON.stringify(artifact))),
    /not produced by buildFireArtifact/,
  );
});

test('the output round-trips through its own strict schema unchanged', async () => {
  const { env, ctx } = await buildFire();
  const artifact = buildFireArtifact(env, ctx);
  const reparsed = fireArtifactV1Schema.parse(JSON.parse(JSON.stringify(artifact)));
  assert.deepEqual(reparsed, JSON.parse(JSON.stringify(artifact)));
});

test('a frozen-watermark read mode is persisted on the market evidence', async () => {
  const { env, cohortId, booted } = await buildFire();
  const ctx: FireContext = {
    booted,
    fireId: 'fire-1',
    runId: 'run-1',
    publication: publication(),
    bundleBuiltAt: '2026-07-18T12:00:31.000Z',
    perMarket: (['moneyline', 'total'] as const).map((m) => marketCtx(m, cohortId, 'fire-1', { watermark: 500 })),
  };
  const artifact = buildFireArtifact(env, ctx);
  assert.deepEqual(artifact.marketEvidence[0]?.historyReadMode, { mode: 'frozen-watermark', watermark: 500 });
});

test('a non-valid arm is retained with one terminal outcome and no accepted decision', async () => {
  const { env, cohortId, booted } = await buildFire({
    arms: [ARM_A, ARM_B],
    outcomeFor: (arm) => (arm.participantId === ARM_B.participantId ? 'timeout' : 'valid'),
  });
  const ctx = makeCtx(cohortId, booted, ['moneyline', 'total']);
  const artifact = buildFireArtifact(env, ctx);

  assert.equal(artifact.arms.length, 2);
  assert.deepEqual(artifact.expectedArmIdentities.map((i) => i.participantId), ['arm-a', 'arm-b']);
  const armB = artifact.arms.find((a) => a.expectedArmIdentity.participantId === 'arm-b')!;
  assert.equal(armB.terminalOutcome, 'timeout');
  assert.equal(armB.acceptedResponseDigest, null);
  assert.equal(armB.acceptedDecisionFingerprint, null);
  assert.equal(armB.orderedAttempts.length, 1); // the sent-but-timed-out initial attempt
  assert.equal(armB.orderedAttempts[0]?.transport, 'timeout');
  assert.match(armB.armDigest, /^[0-9a-f]{64}$/);
  const armA = artifact.arms.find((a) => a.expectedArmIdentity.participantId === 'arm-a')!;
  assert.equal(armA.terminalOutcome, 'valid');
});

// --- adversarial: fail-closed guards ----------------------------------------

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

test('rejects a multi-game envelope', async () => {
  const arms = [ARM_A];
  const booted = bootedFor(arms);
  const cohortId = booted.cohortId;
  const reqA = scopedRequest(['moneyline', 'total']);
  const reqB: GameRequest = (() => {
    const r = scopedRequest(['moneyline', 'total']);
    const game = { ...r.game, gameId: '00000000-0000-4000-8000-0000000000f2' };
    const requestBundle: SlateBundle = { ...r.requestBundle, games: [game] };
    return {
      gameId: game.gameId,
      slug: 'other',
      game,
      requestBundle,
      requestSha256: sha256Hex(canonicalize(requestBundle)),
    };
  })();
  const adapter = stubAdapter(ARM_A, [
    () => stubResponse(JSON.stringify(scopedResponse(reqA, ARM_A, cohortId)), ARM_A.requestedModelId),
    () => stubResponse(JSON.stringify(scopedResponse(reqB, ARM_A, cohortId)), ARM_A.requestedModelId),
  ]);
  const env = await runSlate([ARM_A], new Map([[ARM_A.participantId, adapter]]), [reqA, reqB], {
    cohortId,
    timeoutMs: 600_000,
    maxOutputTokens: 16_000,
    executionPolicy: 'fixed-moneyline-total',
    baselinePolicyVersion: 'baselines-v0.3.0',
    nowMs: () => NOW_MS,
  });
  const ctx = makeCtx(cohortId, booted, ['moneyline', 'total']);
  assert.throws(() => buildFireArtifact(env, ctx), /exactly one dispatched game/);
});

test('rejects a booted cohort whose identity disagrees with the envelope', async () => {
  const { env } = await buildFire();
  const otherBooted = bootedFor([ARM_A], { network: 'ethereum' }); // different cohortId
  const ctx = makeCtx(otherBooted.cohortId, otherBooted, ['moneyline', 'total']);
  assert.throws(() => buildFireArtifact(env, ctx), /!= booted cohortId/);
});

test('rejects a context whose markets differ from the dispatched scope', async () => {
  const { env, ctx } = await buildFire({ markets: ['moneyline', 'total'] });
  const short: FireContext = { ...ctx, perMarket: [ctx.perMarket[0]!] }; // moneyline only
  assert.throws(() => buildFireArtifact(env, short), /fire context markets .* != scope/);
});

test('rejects a candidate bound to a different game', async () => {
  const { env, ctx, cohortId } = await buildFire();
  const badMarket: MarketFireContextV1 = {
    ...ctx.perMarket[0]!,
    candidateInput: { ...ctx.perMarket[0]!.candidateInput, gameId: 'some-other-game' },
    claim: { cohortId, fireId: 'fire-1', gameId: GAME_ID, market: 'moneyline' },
  };
  const bad: FireContext = { ...ctx, perMarket: [badMarket, ctx.perMarket[1]!] };
  assert.throws(() => buildFireArtifact(env, bad), /candidate gameId some-other-game != fire gameId/);
});

test('rejects an ineligible re-evaluation', async () => {
  const { env, ctx, cohortId } = await buildFire();
  // detectedAt after windowEnd → detected_after_window, not eligible.
  const lateInput = candidateInput('moneyline', { detectedAt: '2026-07-20T00:00:00.000Z' });
  const badMarket: MarketFireContextV1 = {
    candidateInput: lateInput,
    verdict: evaluateCandidate(lateInput),
    historyRows: [historyRow('moneyline')],
    historyWatermark: null,
    claim: { cohortId, fireId: 'fire-1', gameId: GAME_ID, market: 'moneyline' },
  };
  const bad: FireContext = { ...ctx, perMarket: [badMarket, ctx.perMarket[1]!] };
  assert.throws(() => buildFireArtifact(env, bad), /re-evaluates to detected_after_window, not eligible/);
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
  const bad: FireContext = { ...ctx, perMarket: [tampered, ctx.perMarket[1]!] };
  assert.throws(() => buildFireArtifact(env, bad), /does not match its re-derivation/);
});

test('rejects an opener that is not the firstTwoSided of the supplied history', async () => {
  const { env, ctx } = await buildFire();
  const real = ctx.perMarket[0]!;
  // History whose earliest row is a DIFFERENT (earlier) row than the candidate's opener.
  const earlier = historyRow('moneyline', {
    id: 99,
    captured_at: '2026-07-18T11:00:00.000Z',
    captured_at_ms: Date.parse('2026-07-18T11:00:00.000Z'),
  });
  const bad: FireContext = {
    ...ctx,
    perMarket: [{ ...real, historyRows: [earlier] }, ctx.perMarket[1]!],
  };
  assert.throws(() => buildFireArtifact(env, bad), /is not the firstTwoSided of the supplied history/);
});

test('rejects a claim not bound to the fire', async () => {
  const { env, ctx, cohortId } = await buildFire();
  const real = ctx.perMarket[0]!;
  const bad: FireContext = {
    ...ctx,
    perMarket: [
      { ...real, claim: { cohortId, fireId: 'a-different-fire', gameId: GAME_ID, market: 'moneyline' } },
      ctx.perMarket[1]!,
    ],
  };
  assert.throws(() => buildFireArtifact(env, bad), /claim reference does not bind to fire/);
});

test('rejects scoped markets that disagree on the detection instant', async () => {
  const { env, cohortId, booted } = await buildFire();
  const ctx: FireContext = {
    booted,
    fireId: 'fire-1',
    runId: 'run-1',
    publication: publication(),
    bundleBuiltAt: '2026-07-18T12:00:31.000Z',
    perMarket: [
      marketCtx('moneyline', cohortId, 'fire-1'),
      marketCtx('total', cohortId, 'fire-1', { detectedAt: '2026-07-18T12:00:40.000Z' }), // different instant
    ],
  };
  assert.throws(() => buildFireArtifact(env, ctx), /share one detection instant/);
});

test('rejects a baseline policy that disagrees with the manifest', async () => {
  const arms = [ARM_A];
  // Manifest pins v0.2, but the dispatched envelope carries v0.3.
  const booted = bootedFor(arms, { baselinePolicyVersion: 'baselines-v0.2.0' });
  const cohortId = booted.cohortId;
  const env = await makeEnv({ markets: ['moneyline', 'total'], arms, cohortId, baselinePolicyVersion: 'baselines-v0.3.0' });
  const ctx = makeCtx(cohortId, booted, ['moneyline', 'total']);
  assert.throws(() => buildFireArtifact(env, ctx), /baselinePolicyVersion .* != manifest/);
});

test('rejects a dispatched roster that is not the manifest roster', async () => {
  const booted = bootedFor([ARM_A, ARM_B]); // manifest expects two arms
  const cohortId = booted.cohortId;
  const env = await makeEnv({ markets: ['moneyline', 'total'], arms: [ARM_A], cohortId }); // only one dispatched
  const ctx = makeCtx(cohortId, booted, ['moneyline', 'total']);
  assert.throws(() => buildFireArtifact(env, ctx), /dispatched roster does not equal the manifest/);
});

test('rejects an arm-family mismatch between the dispatch and the manifest', async () => {
  // Manifest says arm-a is a google arm; the dispatched arm-a is an openai arm.
  const booted = bootedFrom({
    roster: [
      { participantId: 'arm-a', provider: 'google', requestedModelId: 'model-a', approvedReportedModelIds: ['model-a'] },
    ],
  });
  const cohortId = booted.cohortId;
  const env = await makeEnv({ markets: ['moneyline', 'total'], arms: [ARM_A], cohortId });
  const ctx = makeCtx(cohortId, booted, ['moneyline', 'total']);
  assert.throws(() => buildFireArtifact(env, ctx), /manifest expects google/);
});
