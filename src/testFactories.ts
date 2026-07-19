import { canonicalize, sha256Hex } from './canonical.js';
import { cohortBoot } from './cohortBoot.js';
import { evaluateCandidate } from './detection.js';
import { checkPublication } from './manifestPublication.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { promptScaffoldSha256 } from './prompt.js';
import { buildGameRequest } from './scopedRequest.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import { SMOKE_LABEL } from './types.js';
import type { BootedCohort } from './cohortBoot.js';
import type { PreparedFire, PreparedScopedMarket } from './cohortRunner.js';
import type { CandidateInput } from './detection.js';
import type { PublicationVerified } from './manifestPublication.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
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
 * Shared deterministic factories for unit tests: one synthetic game request
 * and a schema-conformant response for it. Test-only; not part of the runtime
 * path (nothing under src/ imports this except *.test.ts).
 */

export const TEST_ARM: ArmSpec = {
  participantId: 'stub-openai',
  provider: 'openai',
  requestedModelId: 'stub-model-1',
  credentialEnvVar: 'STUB_PROVIDER_KEY',
};

export const TEST_COHORT = 'test-cohort';

export function makeGameBundle(overrides: Partial<GameBundle> = {}): GameBundle {
  const gameId = overrides.gameId ?? '00000000-0000-4000-8000-00000000t001';
  return {
    gameId,
    league: 'mlb',
    scheduledStartUtc: '2026-07-12T16:15:00+00:00',
    awayTeam: 'Milwaukee Brewers',
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: {
      moneyline: {
        awayDecimal: 1.74627,
        homeDecimal: 2.17,
        observedAt: '2026-07-12T14:02:11+00:00',
        evidenceRef: `ev:${gameId}:moneyline`,
      },
      runLine: {
        line: 1.5,
        awayHandicap: -1.5,
        homeHandicap: 1.5,
        awayDecimal: 2.3,
        homeDecimal: 1.66667,
        observedAt: '2026-07-12T14:02:11+00:00',
        evidenceRef: `ev:${gameId}:runline`,
      },
      total: {
        line: 8.5,
        overDecimal: 1.90909,
        underDecimal: 1.90909,
        observedAt: '2026-07-12T14:02:11+00:00',
        evidenceRef: `ev:${gameId}:total`,
      },
    },
    evidenceRefs: [
      `ev:${gameId}:identity`,
      `ev:${gameId}:schedule`,
      `ev:${gameId}:moneyline`,
      `ev:${gameId}:runline`,
      `ev:${gameId}:total`,
    ],
    ...overrides,
  };
}

export function makeRequest(
  cutoffAt = '2026-07-12T16:15:00+00:00',
  overrides: Partial<GameBundle> = {},
): GameRequest {
  const game = makeGameBundle({ scheduledStartUtc: cutoffAt, ...overrides });
  const requestBundle: SlateBundle = {
    schemaVersion: 1,
    label: SMOKE_LABEL,
    league: 'mlb',
    slateDate: '2026-07-12',
    bundleTimestamp: '2026-07-12T14:05:00+00:00',
    cutoffAt,
    games: [game],
  };
  return {
    gameId: game.gameId,
    slug: 'mil-pit-2026-07-12',
    game,
    requestBundle,
    requestSha256: sha256Hex(canonicalize(requestBundle)),
  };
}

/** A fully schema- and semantics-conformant response for makeRequest(). */
export function makeValidResponse(
  request: GameRequest,
  arm: ArmSpec = TEST_ARM,
  cohortId: string = TEST_COHORT,
): BenchmarkResponse {
  const game = request.game;
  // makeRequest/makeGameBundle always build a full three-market board.
  const ml = game.markets.moneyline!;
  const rl = game.markets.runLine!;
  const total = game.markets.total!;
  return {
    schemaVersion: 1,
    cohortId,
    participantId: arm.participantId,
    requestedModelId: arm.requestedModelId,
    bundleSha256: request.requestSha256,
    executionPolicy: 'fixed-moneyline-total',
    games: [
      {
        gameId: game.gameId,
        forecasts: [
          {
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
          },
          {
            market: 'spread',
            selection: game.homeTeam,
            line: rl.line,
            observedDecimal: rl.homeDecimal,
            probabilities: { win: 0.5, push: 0, loss: 0.5 },
            confidence: 0.5,
            wouldAbstain: false,
            selectedForExecution: false,
            rationale: 'Half-run line at even implied odds.',
            evidenceRefs: [rl.evidenceRef],
            reasonCode: null,
          },
          {
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
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Line-open fire fixture (SPEC-line-open-evidence-model.md §3/§4/§5)
// ---------------------------------------------------------------------------

/**
 * A complete, internally-consistent SCOPED line-open fire: a boot-accepted manifest, a
 * resolved publication, a scoped request (through the shared `buildGameRequest` wrapper),
 * per-market opener/candidate context, and a stub-adapter roster whose responses re-validate.
 * It mirrors the fire-artifact producer's proven fixture, so a produced artifact is
 * replay-clean; the runner-loop tests reuse it. MLB policy enables moneyline + total (the
 * run line is off), so a fixture fire scopes a subset of {moneyline, total} and uses the
 * scoped baseline policy (v0.3).
 */
export const LINE_OPEN_GAME_ID = '00000000-0000-4000-8000-0000000000f1';
const LO_CUTOFF = '2026-07-18T20:00:00+00:00';
const LO_WINDOW_START = '2026-07-18T00:00:00.000Z';
const LO_WINDOW_END = '2026-07-19T00:00:00.000Z';
const LO_BUNDLE_TS = '2026-07-18T12:00:00.000Z';
const LO_DETECTED_AT = '2026-07-18T12:00:30.000Z'; // 60 s after opener, in window
const LO_OPENER_AT = '2026-07-18T11:59:30.000Z';
const LO_OBSERVED_AT = '2026-07-18T11:58:00+00:00';
const LO_BUNDLE_BUILT_AT = '2026-07-18T12:00:31.000Z';
const LO_COMMITTER_TS = '2026-07-17T23:00:00+00:00'; // strictly before windowStart
/** The dry-run clock instant: after detection, before the cutoff. */
export const LINE_OPEN_NOW_MS = Date.parse('2026-07-18T12:00:40.000Z');
const LO_W = 120_000;
const LO_SKEW = 5_000;

const LO_CODE_ARMS = defaultExpectedArms();
/** The frozen roster, in the manifest arm order (the manifest must equal it to boot). */
export const LINE_OPEN_ARMS: ArmSpec[] = LO_CODE_ARMS.map((a) => ({
  participantId: a.participantId,
  provider: a.provider as ProviderName,
  requestedModelId: a.requestedModelId,
  credentialEnvVar: `${a.participantId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_KEY`,
}));

function lineOpenManifestObject(over: { baselinePolicyVersion?: string; network?: string } = {}): Record<string, unknown> {
  return {
    artifactSchemaVersion: 1,
    network: over.network ?? 'polygon',
    sportAllowList: ['mlb'],
    windowStart: LO_WINDOW_START,
    windowEnd: LO_WINDOW_END,
    source: 'jsonodds',
    sourceQueryVersion: 'source-query-v1',
    marketPolicyVersion: MARKET_POLICY_VERSION,
    marketPolicyDigest: MARKET_POLICY_DIGEST,
    promptScaffoldSha256: promptScaffoldSha256(),
    expectedArmRoster: LO_CODE_ARMS.map((a) => ({
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
    modelPriceTableVersion: 'prices-v1',
    modelPriceTableDigest: 'd'.repeat(64),
    runnerCommitSha: 'e'.repeat(40),
    constants: {
      pollIntervalMs: 30_000,
      cleanEntryWindowMs: LO_W,
      gameDiscoveryWindowHours: 168,
      maxClockSkewMs: LO_SKEW,
      freshFireMs: 30_000,
      maxDispatchLagMs: 10_000,
      historyReadTimeoutMs: 30_000,
      providerCallTimeoutMs: 300_000,
      maxOutputTokens: 16_000,
      maxRepairAttemptsPerArm: 1,
      ingestionGraceMs: 900_000,
      scheduleChangeToleranceMs: 60_000,
      maxConcurrentProviderRequests: Math.max(8, LO_CODE_ARMS.length),
      maxDispatchesPerTick: 8,
    },
    cohortCallCap: 1_000,
    cohortSpendCapUsdMicros: 1_000_000,
  };
}

/** The canonical line-open manifest as bytes. */
export function lineOpenManifestJson(over?: { baselinePolicyVersion?: string; network?: string }): string {
  return JSON.stringify(lineOpenManifestObject(over));
}

/**
 * Boot the fixture manifest through the real `cohortBoot` (`--live` off) → a genuine,
 * brand-authenticated `BootedCohort`. Named for what it is: the manifest is BOOT-ACCEPTED,
 * not fully policy-validated (some manifest pins are still deferred in `manifestValidate`).
 */
export function bootAcceptedManifest(over?: { baselinePolicyVersion?: string; network?: string }): {
  json: string;
  booted: BootedCohort;
} {
  const json = lineOpenManifestJson(over);
  return { json, booted: cohortBoot({ live: false, manifestBytes: json }) };
}

/** Verify a publication for the fixture manifest bytes through the real `checkPublication`. */
export function resolvedPublication(json: string): PublicationVerified {
  const bytes = new TextEncoder().encode(json);
  return checkPublication({
    localManifestBytes: bytes,
    publication: { repositoryOwner: 'ospex-org', repositoryName: 'ospex-benchmark', path: 'manifests/cohort.json', commitSha: 'a'.repeat(40) },
    resolved: { blobBytes: bytes, committerTimestamp: LO_COMMITTER_TS },
  });
}

function lineOpenScopedGame(markets: readonly MarketKey[], gameId = LINE_OPEN_GAME_ID): GameBundle {
  const m: GameBundle['markets'] = {};
  if (markets.includes('moneyline')) {
    m.moneyline = { awayDecimal: 1.74627, homeDecimal: 2.17, observedAt: LO_OBSERVED_AT, evidenceRef: `ev:${gameId}:moneyline` };
  }
  if (markets.includes('total')) {
    m.total = { line: 8.5, overDecimal: 1.90909, underDecimal: 1.90909, observedAt: LO_OBSERVED_AT, evidenceRef: `ev:${gameId}:total` };
  }
  return {
    gameId,
    league: 'mlb',
    scheduledStartUtc: LO_CUTOFF,
    awayTeam: 'Milwaukee Brewers',
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: m,
    evidenceRefs: [`ev:${gameId}:identity`, `ev:${gameId}:schedule`, `ev:${gameId}:moneyline`, `ev:${gameId}:total`],
  };
}

function lineOpenHistoryRow(market: MarketKey, gameId = LINE_OPEN_GAME_ID): TwoSidedHistoryRow {
  const quote =
    market === 'moneyline'
      ? { line: null, away_odds_american: -134, away_odds_decimal: 1.74627, home_odds_american: 117, home_odds_decimal: 2.17 }
      : { line: 8.5, away_odds_american: -110, away_odds_decimal: 1.90909, home_odds_american: -110, home_odds_decimal: 1.90909 };
  return {
    id: 1,
    jsonodds_id: gameId,
    market,
    source: 'jsonodds',
    ...quote,
    captured_at: LO_OPENER_AT,
    captured_at_ms: Date.parse(LO_OPENER_AT),
  };
}

function lineOpenCandidateInput(market: MarketKey, gameId = LINE_OPEN_GAME_ID): CandidateInput {
  return {
    gameId,
    sport: 'mlb',
    market,
    sportAllowList: ['mlb'],
    marketPolicyVersion: MARKET_POLICY_VERSION,
    opener: lineOpenHistoryRow(market, gameId),
    detectedAt: LO_DETECTED_AT,
    windowStart: LO_WINDOW_START,
    windowEnd: LO_WINDOW_END,
    cleanEntryWindowMs: LO_W,
    maxClockSkewMs: LO_SKEW,
  };
}

/** A schema- and semantics-conformant scoped response for exactly `markets`. */
export function lineOpenScopedResponse(request: GameRequest, arm: ArmSpec, cohortId: string): BenchmarkResponse {
  const game = request.game;
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
    bundleSha256: request.requestSha256,
    executionPolicy: 'fixed-moneyline-total',
    games: [{ gameId: game.gameId, forecasts }],
  };
}

function lineOpenStubResponse(rawText: string, reportedModelId: string): ProviderResponse {
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

function lineOpenStubAdapter(arm: ArmSpec, handler: () => ProviderResponse): ProviderAdapter {
  return {
    provider: arm.provider,
    requestedModelId: arm.requestedModelId,
    credentialEnvVar: arm.credentialEnvVar,
    hasCredential: () => true,
    chat: () => Promise.resolve(handler()),
  };
}

/**
 * Assemble a complete `PreparedFire` for the scoped `markets` (subset of {moneyline,
 * total}), ready to drive `runOneFire`: a booted cohort, a resolved publication, the
 * scoped request through the shared wrapper, per-market detection context (each verdict
 * re-derived through the real `evaluateCandidate` → `eligible`), and a stub-adapter roster.
 * The caller receives the fire plus its `cohortId` and the raw booted/publication for
 * negative tests.
 */
export function prepareLineOpenFire(markets: readonly MarketKey[]): {
  fire: PreparedFire;
  cohortId: string;
  booted: BootedCohort;
  publication: PublicationVerified;
} {
  const { json, booted } = bootAcceptedManifest();
  const publication = resolvedPublication(json);
  const cohortId = booted.cohortId;

  const game = lineOpenScopedGame(markets);
  const request = buildGameRequest(game, 'mil-pit-2026-07-18', '2026-07-18', LO_BUNDLE_TS);

  const perMarket: PreparedScopedMarket[] = markets.map((market) => {
    const candidateInput = lineOpenCandidateInput(market);
    return {
      candidateInput,
      verdict: evaluateCandidate(candidateInput),
      historyRows: [lineOpenHistoryRow(market)],
      historyWatermark: null,
    };
  });

  const adapters = new Map<string, ProviderAdapter>();
  for (const arm of LINE_OPEN_ARMS) {
    adapters.set(
      arm.participantId,
      lineOpenStubAdapter(arm, () => lineOpenStubResponse(JSON.stringify(lineOpenScopedResponse(request, arm, cohortId)), arm.requestedModelId)),
    );
  }

  const fire: PreparedFire = {
    booted,
    publication,
    gameId: LINE_OPEN_GAME_ID,
    proposedMarkets: markets,
    detectedAt: LO_DETECTED_AT,
    preparedSnapshotDigest: request.requestSha256,
    bundleBuiltAt: LO_BUNDLE_BUILT_AT,
    request,
    perMarket,
    arms: [...LINE_OPEN_ARMS],
    adapters,
    runOptions: {
      cohortId,
      timeoutMs: 600_000,
      maxOutputTokens: 16_000,
      executionPolicy: 'fixed-moneyline-total',
      baselinePolicyVersion: 'baselines-v0.3.0',
      nowMs: () => LINE_OPEN_NOW_MS,
    },
  };

  return { fire, cohortId, booted, publication };
}
