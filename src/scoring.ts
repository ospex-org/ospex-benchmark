import { z } from 'zod';
import { BASELINE_POLICY_VERSION, isBaselinePolicyVersion, runBaselines } from './baselines.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { PROPORTIONAL_DEVIG_METHOD, scoreDecision, SHIN_DEVIG_METHOD } from './clv.js';
import { favorableLineMovement } from './clv.js';
import { LADDER_VERSION, scoreTotalsLadder } from './ladder.js';
import { checkProviderCollision } from './providers/family.js';
import { approvedReportedModelIds, ARMS } from './providers/index.js';
import {
  benchmarkResponseSchema,
  compareFingerprints,
  extractDecisionFingerprint,
  extractJson,
  fingerprintFromParsed,
  validateResponseText,
} from './schema.js';
import { SMOKE_LABEL } from './types.js';
import type { BaselinePolicyVersion } from './baselines.js';
import type { ClvResult, CloseQuote, SelectedSide } from './clv.js';
import type { LadderParams, TotalsLadderResult } from './ladder.js';
import type { ArmSpec, ClosingLineRow, MarketKey, ProviderName, SlateBundle } from './types.js';

/**
 * Pure scoring assembly, no I/O: parse a run's records, VERIFY THE RUN'S
 * INTEGRITY (recomputed hashes, decision echoes, decision-to-response
 * linkage, absence of recorded run failures), join picks to the captured
 * closes, score each through the CLV module, and aggregate with full
 * coverage accounting — the equal-weight game-level aggregate is the primary
 * summary per the methodology, and arms that produced no valid decision
 * still appear in the denominators. The CLI wraps this with file reading and
 * the close fetch.
 */

/**
 * Scoring-policy version, stamped on every scored record (scored_run_meta,
 * scored_decision, participant_scorecard). Bump on ANY change to scoring
 * math, aggregation, or the scored-record/scorecard shape, so two scored
 * artifacts are never silently compared across engine behaviors. Scored
 * output produced before stamping existed is `scoring-v0.1.0` by definition.
 * v0.3.0 adds margin-adjusted CLV (+ conditional mirror) and the shin-v1
 * de-vig sensitivity block alongside the unchanged economic primary.
 * v0.4.0 adds the TOTALS_V1 candidate ladder: every totals pick carries a
 * ladder block (generalized push-aware CLV at the entry line, moved lines
 * included) — sensitivity output, separately labeled, never pooled into the
 * primary columns while the method's independent alternate-ladder
 * validation is pending. All previously scored values are unchanged.
 */
export const SCORING_POLICY_VERSION = 'scoring-v0.4.0';

/** The scored markets, anchored to MarketKey so drift is a compile error. */
export const MARKETS: ReadonlyArray<MarketKey> = ['moneyline', 'spread', 'total'];
// Frozen: SCORING_POLICY_VERSION is validated at preflight, but MARKETS drives
// scoring under that version — it must not drift after a clean validation.
Object.freeze(MARKETS);

// ---------------------------------------------------------------------------
// Source-run parsing (the harness's own NDJSON records)
// ---------------------------------------------------------------------------

const watchProvenanceSchema = z
  .object({
    detectedAt: z.string().min(1),
    boardCompletedAt: z.string().min(1),
    openerAgeMinutes: z.number().int(),
    lateThresholdMinutes: z.number().int().positive(),
  })
  .passthrough();

const runMetaSchema = z
  .object({
    recordType: z.literal('run_meta'),
    runId: z.string().min(1),
    cohortId: z.string().min(1),
    label: z.string().min(1),
    mode: z.string().min(1),
    slateDate: z.string().min(1),
    slateSha256: z.string().min(1),
    bundleTimestamp: z.string().min(1),
    slateCutoffAt: z.string().min(1),
    eligibleGames: z.number().int().nonnegative(),
    armGameResults: z.number().int().nonnegative(),
    baselineDecisionCount: z.number().int().nonnegative(),
    baselinePolicyVersion: z.string().min(1).optional(),
    watch: watchProvenanceSchema.optional(),
  })
  .passthrough();

export type WatchProvenanceMeta = z.infer<typeof watchProvenanceSchema>;

const bundleGameSchema = z
  .object({
    recordType: z.literal('bundle_game'),
    label: z.string().min(1),
    runId: z.string().min(1),
    gameId: z.string().min(1),
    slug: z.string().min(1),
    cutoffAt: z.string().min(1),
    gameSha256: z.string().min(1),
    requestSha256: z.string().min(1),
    bundle: z
      .object({
        gameId: z.string().min(1),
        league: z.string().min(1),
        awayTeam: z.string().min(1),
        homeTeam: z.string().min(1),
        scheduledStartUtc: z.string().min(1),
        markets: z
          .object({
            // Every bundle price must be a valid decimal quote (>1), exactly
            // like decision observedDecimal: BOTH sides feed the
            // margin-adjusted entry de-vig, so an invalid opposite side must
            // refuse the file at parse time rather than silently dropping
            // margin-adjusted values while economic ones still score.
            moneyline: z
              .object({ awayDecimal: z.number().gt(1), homeDecimal: z.number().gt(1) })
              .passthrough(),
            runLine: z
              .object({ line: z.number(), awayDecimal: z.number().gt(1), homeDecimal: z.number().gt(1) })
              .passthrough(),
            total: z
              .object({ line: z.number(), overDecimal: z.number().gt(1), underDecimal: z.number().gt(1) })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const attemptFieldsSchema = z
  .object({
    reportedModelId: z.string().nullable(),
    providerResponseId: z.string().nullable(),
    rawResponse: z.string().nullable(),
    requestAt: z.string().nullable(),
    responseAt: z.string().nullable(),
    latencyMs: z.number().nullable(),
  })
  .passthrough();

const armResponseSchema = z
  .object({
    recordType: z.literal('arm_game_response'),
    label: z.string().min(1),
    runId: z.string().min(1),
    cohortId: z.string().min(1),
    participantId: z.string().min(1),
    provider: z.string().min(1),
    requestedModelId: z.string().min(1),
    reportedModelId: z.string().nullable(),
    gameId: z.string().min(1),
    requestSha256: z.string().min(1),
    cutoffAt: z.string().min(1),
    outcome: z.string().min(1),
    repairUsed: z.boolean(),
    attempt: attemptFieldsSchema,
    repair: attemptFieldsSchema.nullable(),
  })
  .passthrough();

const runFailureSchema = z
  .object({
    recordType: z.literal('run_failure'),
    label: z.string().min(1),
    runId: z.string().min(1),
    code: z.string().min(1),
    failures: z.array(z.string()),
  })
  .passthrough();

const decisionSchema = z
  .object({
    recordType: z.literal('decision'),
    label: z.string().min(1),
    runId: z.string().min(1),
    cohortId: z.string().min(1),
    participantId: z.string().min(1),
    gameId: z.string().min(1),
    market: z.enum(['moneyline', 'spread', 'total']),
    selection: z.string().min(1),
    line: z.number().nullable(),
    observedDecimal: z.number().gt(1),
    probabilities: z
      .object({ win: z.number(), push: z.number(), loss: z.number() })
      .passthrough(),
    confidence: z.number(),
    selectedForExecution: z.boolean(),
    wouldAbstain: z.boolean(),
    provider: z.string().min(1),
    requestedModelId: z.string().min(1),
    reportedModelId: z.string().nullable(),
    providerResponseId: z.string().nullable(),
    attemptUsed: z.enum(['initial', 'repair']),
    bundleSha256: z.string().min(1),
    gameSha256: z.string().nullable(),
    slateSha256: z.string().min(1),
  })
  .passthrough();

const baselineDecisionSchema = z
  .object({
    recordType: z.literal('baseline_decision'),
    label: z.string().min(1),
    runId: z.string().min(1),
    cohortId: z.string().min(1),
    participantId: z.string().min(1),
    gameId: z.string().min(1),
    market: z.enum(['moneyline', 'spread', 'total']),
    selection: z.string().min(1),
    line: z.number().nullable(),
    observedDecimal: z.number().gt(1),
    policyVersion: z.string().min(1),
    slateSha256: z.string().min(1),
    gameSha256: z.string().nullable(),
    requestSha256: z.string().nullable(),
  })
  .passthrough();

export interface SourceGame {
  awayTeam: string;
  homeTeam: string;
  /** Bundle league — the ladder's method domain is runtime-bound to MLB. */
  league: string;
  slug: string;
  startUtc: string;
  cutoffAt: string;
  gameSha256: string;
  requestSha256: string;
  /** The bundle exactly as recorded, for hash recomputation. */
  rawBundle: unknown;
  prices: {
    moneyline: { away: number; home: number };
    runLine: { line: number; away: number; home: number };
    total: { line: number; over: number; under: number };
  };
}

export interface SourcePick {
  kind: 'model' | 'baseline';
  participantId: string;
  gameId: string;
  market: MarketKey;
  selection: string;
  line: number | null;
  entryDecimal: number;
  probabilities: { win: number; push: number; loss: number } | null;
  confidenceValue: number | null;
  policyVersion: string | null;
  modelWinProbability: number | null;
  wouldAbstain: boolean | null;
  selectedForExecution: boolean | null;
  provider: string | null;
  requestedModelId: string | null;
  reportedModelId: string | null;
  providerResponseId: string | null;
  attemptUsed: 'initial' | 'repair' | null;
  echoedRequestSha256: string | null;
  echoedGameSha256: string | null;
  echoedSlateSha256: string | null;
}

export interface ArchivedAttempt {
  reportedModelId: string | null;
  providerResponseId: string | null;
  rawResponse: string | null;
  requestAt: string | null;
  responseAt: string | null;
  latencyMs: number | null;
}

export interface ArmResponseRef {
  participantId: string;
  provider: string;
  requestedModelId: string;
  reportedModelId: string | null;
  gameId: string;
  requestSha256: string;
  outcome: string;
  cutoffAt: string;
  repairUsed: boolean;
  /** Archived attempt evidence — the root of trust for recomputation. */
  attempt: ArchivedAttempt;
  repair: ArchivedAttempt | null;
  /** The ACCEPTED attempt (repair when a repair was used). */
  accepted: {
    reportedModelId: string | null;
    providerResponseId: string | null;
    rawResponse: string | null;
  };
}

export interface SourceRun {
  runId: string;
  cohortId: string;
  label: string;
  mode: string;
  slateDate: string;
  slateSha256: string;
  bundleTimestamp: string;
  slateCutoffAt: string;
  /** Manifest counts recorded by the harness at write time. */
  eligibleGames: number;
  armGameResults: number;
  baselineDecisionCount: number;
  /** Baseline policy version stamped at write time; null on legacy archives. */
  baselinePolicyVersion: string | null;
  /** Watch-mode gate provenance; required (and verified) for watch runs. */
  watch: WatchProvenanceMeta | null;
  games: Map<string, SourceGame>;
  picks: SourcePick[];
  armResponses: ArmResponseRef[];
  runFailures: Array<{ code: string; failures: string[] }>;
  /** Identity stamps of every parsed record, for run/cohort/label checks. */
  identities: Array<{ ref: string; runId: string; label: string; cohortId: string | null }>;
}

function parseRecordLine(trimmed: string, lineNumber: number): { recordType?: unknown } {
  try {
    return JSON.parse(trimmed) as { recordType?: unknown };
  } catch {
    throw new Error(`run file line ${lineNumber} is not valid JSON`);
  }
}

export function parseRunRecords(lines: string[]): SourceRun {
  let meta: z.infer<typeof runMetaSchema> | null = null;
  const games = new Map<string, SourceGame>();
  const picks: SourcePick[] = [];
  const armResponses: ArmResponseRef[] = [];
  const runFailures: Array<{ code: string; failures: string[] }> = [];
  const identities: SourceRun['identities'] = [];

  let lineNumber = 0;
  for (const line of lines) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const record = parseRecordLine(trimmed, lineNumber);
    switch (record.recordType) {
      case 'run_meta':
        if (meta !== null) {
          throw new Error('run file has more than one run_meta record — identity is ambiguous');
        }
        meta = runMetaSchema.parse(record);
        break;
      case 'bundle_game': {
        const game = bundleGameSchema.parse(record);
        if (games.has(game.gameId)) {
          throw new Error(`run file has more than one bundle_game record for ${game.gameId}`);
        }
        identities.push({ ref: `bundle_game:${game.gameId}`, runId: game.runId, label: game.label, cohortId: null });
        games.set(game.gameId, {
          awayTeam: game.bundle.awayTeam,
          homeTeam: game.bundle.homeTeam,
          league: game.bundle.league,
          slug: game.slug,
          startUtc: game.bundle.scheduledStartUtc,
          cutoffAt: game.cutoffAt,
          gameSha256: game.gameSha256,
          requestSha256: game.requestSha256,
          rawBundle: game.bundle,
          prices: {
            moneyline: {
              away: game.bundle.markets.moneyline.awayDecimal,
              home: game.bundle.markets.moneyline.homeDecimal,
            },
            runLine: {
              line: game.bundle.markets.runLine.line,
              away: game.bundle.markets.runLine.awayDecimal,
              home: game.bundle.markets.runLine.homeDecimal,
            },
            total: {
              line: game.bundle.markets.total.line,
              over: game.bundle.markets.total.overDecimal,
              under: game.bundle.markets.total.underDecimal,
            },
          },
        });
        break;
      }
      case 'arm_game_response': {
        const response = armResponseSchema.parse(record);
        const accepted = response.repairUsed && response.repair !== null ? response.repair : response.attempt;
        identities.push({
          ref: `arm_game_response:${response.participantId}:${response.gameId}`,
          runId: response.runId,
          label: response.label,
          cohortId: response.cohortId,
        });
        armResponses.push({
          participantId: response.participantId,
          provider: response.provider,
          requestedModelId: response.requestedModelId,
          reportedModelId: response.reportedModelId,
          gameId: response.gameId,
          requestSha256: response.requestSha256,
          outcome: response.outcome,
          cutoffAt: response.cutoffAt,
          repairUsed: response.repairUsed,
          attempt: {
            reportedModelId: response.attempt.reportedModelId,
            providerResponseId: response.attempt.providerResponseId,
            rawResponse: response.attempt.rawResponse,
            requestAt: response.attempt.requestAt,
            responseAt: response.attempt.responseAt,
            latencyMs: response.attempt.latencyMs,
          },
          repair:
            response.repair === null
              ? null
              : {
                  reportedModelId: response.repair.reportedModelId,
                  providerResponseId: response.repair.providerResponseId,
                  rawResponse: response.repair.rawResponse,
                  requestAt: response.repair.requestAt,
                  responseAt: response.repair.responseAt,
                  latencyMs: response.repair.latencyMs,
                },
          accepted: {
            reportedModelId: accepted.reportedModelId,
            providerResponseId: accepted.providerResponseId,
            rawResponse: accepted.rawResponse,
          },
        });
        break;
      }
      case 'run_failure': {
        const failure = runFailureSchema.parse(record);
        identities.push({ ref: `run_failure:${failure.code}`, runId: failure.runId, label: failure.label, cohortId: null });
        runFailures.push({ code: failure.code, failures: failure.failures });
        break;
      }
      case 'decision': {
        const decision = decisionSchema.parse(record);
        identities.push({
          ref: `decision:${decision.participantId}:${decision.gameId}:${decision.market}`,
          runId: decision.runId,
          label: decision.label,
          cohortId: decision.cohortId,
        });
        picks.push({
          kind: 'model',
          participantId: decision.participantId,
          gameId: decision.gameId,
          market: decision.market,
          selection: decision.selection,
          line: decision.line,
          entryDecimal: decision.observedDecimal,
          probabilities: decision.probabilities,
          confidenceValue: decision.confidence,
          policyVersion: null,
          modelWinProbability: decision.probabilities.win,
          wouldAbstain: decision.wouldAbstain,
          selectedForExecution: decision.selectedForExecution,
          provider: decision.provider,
          requestedModelId: decision.requestedModelId,
          reportedModelId: decision.reportedModelId,
          providerResponseId: decision.providerResponseId,
          attemptUsed: decision.attemptUsed,
          echoedRequestSha256: decision.bundleSha256,
          echoedGameSha256: decision.gameSha256,
          echoedSlateSha256: decision.slateSha256,
        });
        break;
      }
      case 'baseline_decision': {
        const baseline = baselineDecisionSchema.parse(record);
        identities.push({
          ref: `baseline_decision:${baseline.participantId}:${baseline.gameId}`,
          runId: baseline.runId,
          label: baseline.label,
          cohortId: baseline.cohortId,
        });
        picks.push({
          kind: 'baseline',
          participantId: baseline.participantId,
          gameId: baseline.gameId,
          market: baseline.market,
          selection: baseline.selection,
          line: baseline.line,
          entryDecimal: baseline.observedDecimal,
          probabilities: null,
          confidenceValue: null,
          policyVersion: baseline.policyVersion,
          modelWinProbability: null,
          wouldAbstain: null,
          selectedForExecution: null,
          provider: null,
          requestedModelId: null,
          reportedModelId: null,
          providerResponseId: null,
          attemptUsed: null,
          echoedRequestSha256: baseline.requestSha256,
          echoedGameSha256: baseline.gameSha256,
          echoedSlateSha256: baseline.slateSha256,
        });
        break;
      }
      default:
        break;
    }
  }

  if (meta === null) {
    throw new Error('run file has no run_meta record — is this a harness NDJSON file?');
  }
  if (games.size === 0) {
    throw new Error('run file has no bundle_game records — nothing to score against');
  }
  return {
    runId: meta.runId,
    cohortId: meta.cohortId,
    label: meta.label,
    mode: meta.mode,
    slateDate: meta.slateDate,
    slateSha256: meta.slateSha256,
    bundleTimestamp: meta.bundleTimestamp,
    slateCutoffAt: meta.slateCutoffAt,
    eligibleGames: meta.eligibleGames,
    armGameResults: meta.armGameResults,
    baselineDecisionCount: meta.baselineDecisionCount,
    baselinePolicyVersion: meta.baselinePolicyVersion ?? null,
    watch: meta.watch ?? null,
    games,
    picks,
    armResponses,
    runFailures,
    identities,
  };
}

// ---------------------------------------------------------------------------
// Run integrity — a scorecard is only as trustworthy as its input
// ---------------------------------------------------------------------------

function expectedEntry(
  game: SourceGame,
  market: MarketKey,
  side: SelectedSide,
): { price: number; line: number | null } {
  if (market === 'moneyline') {
    return { price: side === 'away' ? game.prices.moneyline.away : game.prices.moneyline.home, line: null };
  }
  if (market === 'spread') {
    return {
      price: side === 'away' ? game.prices.runLine.away : game.prices.runLine.home,
      line: game.prices.runLine.line,
    };
  }
  return {
    price: side === 'away' ? game.prices.total.over : game.prices.total.under,
    line: game.prices.total.line,
  };
}

/**
 * Verify the run file is internally consistent before trusting a single
 * number in it. Returns violations (empty = verified):
 *
 * - a recorded run_failure (identity/collision) makes the run unscoreable;
 * - every recorded game/request/slate hash must match a recomputation from
 *   the embedded bundles (a tampered price or bundle cannot hide);
 * - every model decision must be backed by a VALID arm response for the same
 *   participant/game/request hash, exactly three decisions per valid
 *   response and none for non-valid ones (no fabricated decisions);
 * - every decision's echoed selection/line/price must re-verify against the
 *   hash-verified bundle, and its echoed hashes must match.
 */
export interface ExpectedArm {
  participantId: string;
  provider: string;
  requestedModelId: string;
  /** Exact approved response-reported model IDs for this arm. */
  approvedReportedModelIds: string[];
}

/** The frozen smoke-v0 arm manifest, from the harness's own arm registry. */
export function defaultExpectedArms(): ExpectedArm[] {
  return ARMS.map((arm) => ({
    participantId: arm.participantId,
    provider: arm.provider,
    requestedModelId: arm.requestedModelId,
    // Defensive copy so a caller mutating the returned roster cannot reach the
    // canonical (frozen) approved-model registry.
    approvedReportedModelIds: [...approvedReportedModelIds(arm.participantId)],
  }));
}

export function verifyRunIntegrity(
  run: SourceRun,
  options?: { expectedArms?: ExpectedArm[] },
): string[] {
  const violations: string[] = [];

  // Watch runs must prove their entry-timing claim from the artifact itself:
  // a watch-v0 run without recorded, internally consistent gate provenance is
  // unscoreable. Fail-closed — the fire-at-detection property is the whole
  // point of watch mode, so it is verified, never assumed from the prefix.
  if (run.runId.startsWith('watch-v0-')) {
    if (run.watch === null) {
      violations.push('watch run has no watch provenance in run_meta — entry timing unverifiable');
    } else {
      const detectedMs = Date.parse(run.watch.detectedAt);
      const boardMs = Date.parse(run.watch.boardCompletedAt);
      if (!Number.isFinite(detectedMs)) {
        violations.push('watch provenance detectedAt is unparseable');
      }
      if (!Number.isFinite(boardMs)) {
        violations.push('watch provenance boardCompletedAt is unparseable');
      }
      if (Number.isFinite(detectedMs) && Number.isFinite(boardMs)) {
        if (boardMs > detectedMs) {
          violations.push('watch provenance boardCompletedAt is after detection — impossible ordering');
        }
        if (run.watch.openerAgeMinutes < 0) {
          violations.push('watch provenance openerAgeMinutes is negative — impossible gate result');
        }
        if (run.watch.openerAgeMinutes > run.watch.lateThresholdMinutes) {
          violations.push(
            'watch provenance opener age exceeds the recorded late threshold — this game should never have fired',
          );
        }
        const recomputedAgeMinutes = Math.round((detectedMs - boardMs) / 60_000);
        if (Math.abs(recomputedAgeMinutes - run.watch.openerAgeMinutes) > 1) {
          violations.push(
            'watch provenance openerAgeMinutes does not match detectedAt - boardCompletedAt',
          );
        }
      }
      // "Fired at detection" is verified as a timing CHAIN through the
      // artifact, not taken on faith: the bundle is assembled from fetched
      // inputs, detection is evaluated on that bundle, and dispatch follows
      // detection — so bundleTimestamp ≤ detectedAt ≤ every body-bearing
      // attempt's requestAt. A provenance shifted away from the run's own
      // recorded instants breaks one of these links.
      const bundleMs = Date.parse(run.bundleTimestamp);
      if (Number.isFinite(detectedMs) && Number.isFinite(bundleMs) && detectedMs < bundleMs) {
        violations.push(
          'watch provenance detectedAt precedes bundle assembly — detection cannot predate its inputs',
        );
      }
      if (Number.isFinite(detectedMs)) {
        for (const response of run.armResponses) {
          for (const [label, attempt] of [
            ['attempt', response.attempt],
            ['repair', response.repair],
          ] as const) {
            if (attempt === null || attempt.requestAt === null) continue;
            const requestMs = Date.parse(attempt.requestAt);
            if (Number.isFinite(requestMs) && requestMs < detectedMs) {
              violations.push(
                `${response.participantId}/${response.gameId}: ${label} was dispatched before the recorded detection instant`,
              );
            }
          }
        }
      }
      // Watch fires are one decision event per game, by construction.
      if (run.games.size !== 1) {
        violations.push(
          `watch run must contain exactly one game (found ${run.games.size})`,
        );
      }
    }
  } else if (run.watch !== null) {
    // Bidirectional: watch provenance on a non-watch run is as suspect as a
    // watch run without it — prose renderers key on this metadata.
    violations.push('non-watch run carries watch provenance in run_meta');
  }

  // Record identity: every record must carry this run's runId, label, and
  // (where applicable) cohortId — no record can belong to another run.
  for (const identity of run.identities) {
    if (identity.runId !== run.runId) violations.push(`${identity.ref}: runId does not match run_meta`);
    if (identity.label !== run.label) violations.push(`${identity.ref}: label does not match run_meta`);
    if (identity.cohortId !== null && identity.cohortId !== run.cohortId) {
      violations.push(`${identity.ref}: cohortId does not match run_meta`);
    }
  }

  // Frozen arm manifest: the arms are known ahead of time, never inferred
  // from surviving records — a relabeled or missing arm is a violation.
  const expectedArms = options?.expectedArms ?? defaultExpectedArms();
  const expectedById = new Map(expectedArms.map((arm) => [arm.participantId, arm]));
  const seenArmIds = new Set(run.armResponses.map((r) => r.participantId));
  for (const arm of expectedArms) {
    if (!seenArmIds.has(arm.participantId)) {
      violations.push(`expected arm ${arm.participantId} has no responses in this run`);
    }
  }
  for (const participantId of seenArmIds) {
    if (!expectedById.has(participantId)) {
      violations.push(`unexpected arm ${participantId} is not in the frozen arm manifest`);
    }
  }
  for (const response of run.armResponses) {
    const expected = expectedById.get(response.participantId);
    if (
      expected !== undefined &&
      (response.provider !== expected.provider || response.requestedModelId !== expected.requestedModelId)
    ) {
      violations.push(
        `arm ${response.participantId}: provider/requestedModelId does not match the frozen arm manifest`,
      );
    }
  }

  for (const failure of run.runFailures) {
    violations.push(
      `run recorded a hard failure (${failure.code}: ${failure.failures.length} finding(s)) — this run is not scoreable`,
    );
  }

  // Hash recomputation, bottom-up: game -> request -> slate.
  const sortedBundles: unknown[] = [...run.games.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, game]) => game.rawBundle);
  const requestBundleByGame = new Map<string, SlateBundle>();
  for (const [gameId, game] of run.games) {
    const recomputedGame = sha256Hex(canonicalize(game.rawBundle));
    if (recomputedGame !== game.gameSha256) {
      violations.push(`game ${gameId}: recorded gameSha256 does not match the recomputed bundle hash`);
    }
    const league = (game.rawBundle as { league?: unknown }).league;
    const requestBundle = {
      schemaVersion: 1,
      label: run.label,
      league,
      slateDate: run.slateDate,
      bundleTimestamp: run.bundleTimestamp,
      cutoffAt: game.cutoffAt,
      games: [game.rawBundle],
    };
    if (sha256Hex(canonicalize(requestBundle)) !== game.requestSha256) {
      violations.push(`game ${gameId}: recorded requestSha256 does not match the recomputed request bundle hash`);
    }
    // The hash-verified request bundle is what the arm actually received;
    // the full harness validator re-runs against it below.
    requestBundleByGame.set(gameId, requestBundle as unknown as SlateBundle);
  }
  const firstGame = [...run.games.values()][0];
  const slateBundle = {
    schemaVersion: 1,
    label: run.label,
    league: (firstGame?.rawBundle as { league?: unknown } | undefined)?.league,
    slateDate: run.slateDate,
    bundleTimestamp: run.bundleTimestamp,
    cutoffAt: run.slateCutoffAt,
    games: sortedBundles,
  };
  if (sha256Hex(canonicalize(slateBundle)) !== run.slateSha256) {
    violations.push('run_meta slateSha256 does not match the recomputed slate hash');
  }

  // Manifest counts: surviving records must match what the harness recorded
  // at write time, so deleted arms/baselines cannot silently vanish.
  if (run.games.size !== run.eligibleGames) {
    violations.push(
      `run_meta says ${run.eligibleGames} eligible games but ${run.games.size} bundle_game records survive`,
    );
  }
  if (run.armResponses.length !== run.armGameResults) {
    violations.push(
      `run_meta says ${run.armGameResults} arm-game responses but ${run.armResponses.length} survive`,
    );
  }
  const baselinePicks = run.picks.filter((p) => p.kind === 'baseline');
  if (baselinePicks.length !== run.baselineDecisionCount) {
    violations.push(
      `run_meta says ${run.baselineDecisionCount} baseline decisions but ${baselinePicks.length} survive`,
    );
  }

  // Response uniqueness and full arm×game cross-product: the harness
  // dispatches every arm on every game exactly once.
  const responseByKey = new Map<string, ArmResponseRef>();
  const responsesByArm = new Map<string, Set<string>>();
  for (const response of run.armResponses) {
    const key = `${response.participantId}:${response.gameId}`;
    if (responseByKey.has(key)) {
      violations.push(`duplicate arm_game_response for ${key}`);
      continue;
    }
    responseByKey.set(key, response);
    const games = responsesByArm.get(response.participantId) ?? new Set<string>();
    games.add(response.gameId);
    responsesByArm.set(response.participantId, games);
    const game = run.games.get(response.gameId);
    if (!game) {
      violations.push(`arm response ${key} references an unknown game`);
    } else if (response.requestSha256 !== game.requestSha256) {
      violations.push(`arm response ${key}: requestSha256 does not match the game's request hash`);
    }
  }
  for (const [participantId, games] of responsesByArm) {
    if (games.size !== run.games.size) {
      violations.push(
        `arm ${participantId} has responses for ${games.size} of ${run.games.size} games — the arm×game cross-product is incomplete`,
      );
    }
  }

  // Baselines are RE-DERIVED: the deterministic policies are re-run on the
  // hash-verified bundles and every recorded baseline decision must match
  // its re-derivation exactly — a tampered comparator cannot hide behind
  // bundle-valid sides and prices. Re-derivation runs under the RECORDED
  // policy version, so archived runs keep verifying byte-for-byte as newer
  // policy versions ship; the recorded version must be single-valued and
  // known. A run with no baselines at all falls back to the current
  // version's expectations (and fails on the missing decisions below).
  const sortedGames = [...run.games.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, game]) => game.rawBundle);
  const reconstructedSlate = {
    schemaVersion: 1,
    label: run.label,
    league: 'mlb',
    slateDate: run.slateDate,
    bundleTimestamp: run.bundleTimestamp,
    cutoffAt: run.slateCutoffAt,
    games: sortedGames,
  } as unknown as SlateBundle;
  const recordedBaselineVersions = [...new Set(baselinePicks.map((p) => p.policyVersion))];
  let baselinePolicyVersion: BaselinePolicyVersion = BASELINE_POLICY_VERSION;
  if (recordedBaselineVersions.length > 1) {
    violations.push(
      `baseline decisions carry mixed policy versions (${recordedBaselineVersions
        .map((v) => v ?? 'null')
        .sort()
        .join(', ')})`,
    );
  } else if (recordedBaselineVersions.length === 1) {
    const recorded = recordedBaselineVersions[0];
    if (typeof recorded === 'string' && isBaselinePolicyVersion(recorded)) {
      baselinePolicyVersion = recorded;
    } else {
      violations.push(`baseline decisions carry unknown policy version ${recorded ?? 'null'}`);
    }
  }
  // Cross-check the run_meta stamp against the per-decision stamps: a
  // version-downgrade edit (restamp rows + delete the newer policies' rows +
  // fix the count) must also rewrite run_meta coherently to pass. Absent
  // stamp = legacy pre-stamp archive; per-decision dispatch alone applies.
  if (run.baselinePolicyVersion !== null) {
    const consistent =
      recordedBaselineVersions.length === 1 &&
      recordedBaselineVersions[0] === run.baselinePolicyVersion;
    if (!consistent) {
      violations.push(
        `run_meta baselinePolicyVersion ${run.baselinePolicyVersion} does not match the recorded baseline decisions`,
      );
    }
  }
  const expectedBaselines = new Map(
    runBaselines(reconstructedSlate, baselinePolicyVersion).map((d) => [
      `${d.participantId}:${d.gameId}`,
      d,
    ]),
  );
  const seenBaselineKeys = new Set<string>();
  for (const pick of baselinePicks) {
    const key = `${pick.participantId}:${pick.gameId}`;
    if (seenBaselineKeys.has(key)) {
      violations.push(`duplicate baseline decision for ${key}`);
      continue;
    }
    seenBaselineKeys.add(key);
    const expected = expectedBaselines.get(key);
    if (!expected) {
      violations.push(`baseline decision ${key} is not produced by the deterministic policies`);
      continue;
    }
    if (pick.policyVersion !== baselinePolicyVersion) {
      violations.push(`baseline decision ${key}: unexpected policyVersion ${pick.policyVersion ?? 'null'}`);
    }
    if (
      pick.market !== expected.market ||
      pick.selection !== expected.selection ||
      pick.line !== expected.line ||
      pick.entryDecimal !== expected.observedDecimal
    ) {
      violations.push(`baseline decision ${key} does not match its deterministic re-derivation`);
    }
  }
  for (const key of expectedBaselines.keys()) {
    if (!seenBaselineKeys.has(key)) {
      violations.push(`expected deterministic baseline decision ${key} is missing`);
    }
  }

  // Decision-to-accepted-response correspondence: every decision must be
  // re-derivable from the ARCHIVED accepted provider response, and its
  // provenance metadata must match the accepted attempt — a decision cannot
  // say something the model did not.
  const modelPicksByKey = new Map<string, SourcePick[]>();
  for (const pick of run.picks.filter((p) => p.kind === 'model')) {
    const key = `${pick.participantId}:${pick.gameId}`;
    const list = modelPicksByKey.get(key) ?? [];
    list.push(pick);
    modelPicksByKey.set(key, list);
  }
  for (const [key, list] of modelPicksByKey) {
    const response = responseByKey.get(key);
    if (!response) {
      violations.push(`decisions for ${key} have no arm_game_response record backing them`);
      continue;
    }
    if (response.outcome !== 'valid') {
      violations.push(`decisions for ${key} are backed by a non-valid arm response (${response.outcome})`);
      continue;
    }
    const markets = new Set(list.map((p) => p.market));
    if (list.length !== 3 || markets.size !== 3) {
      violations.push(`${key}: expected exactly one decision per market, found ${list.length}`);
    }

    if (response.accepted.rawResponse === null) {
      violations.push(`${key}: accepted response retains no raw text — decisions cannot be re-derived`);
      continue;
    }
    // The FULL harness validator re-runs on the archived accepted response
    // against the hash-verified request bundle: a recorded 'valid' outcome
    // that the harness's own gate would reject is a violation, not a shrug.
    const requestBundle = requestBundleByGame.get(response.gameId);
    const game = run.games.get(response.gameId);
    if (requestBundle === undefined || game === undefined) {
      violations.push(`${key}: no verified request bundle for game ${response.gameId}`);
      continue;
    }
    const armSpecForValidation = {
      participantId: response.participantId,
      provider: response.provider,
      requestedModelId: response.requestedModelId,
      credentialEnvVar: '',
    } as ArmSpec;
    const revalidation = validateResponseText(
      response.accepted.rawResponse,
      requestBundle,
      game.requestSha256,
      armSpecForValidation,
      run.cohortId,
    );
    if (revalidation.errors.length > 0 || revalidation.parsed === null) {
      violations.push(
        `${key}: accepted response fails the harness validator (${revalidation.errors[0] ?? 'no parse'}) — recorded 'valid' outcome is not reproducible`,
      );
      continue;
    }
    if (response.repairUsed) {
      // The repair-acceptance rules re-run from the archived attempts: the
      // initial must have failed validation with a complete fingerprint the
      // accepted repair preserves exactly.
      const initialRaw = response.attempt.rawResponse;
      if (initialRaw === null) {
        violations.push(`${key}: repair was used but no initial raw response is archived`);
      } else {
        const initialValidation = validateResponseText(
          initialRaw,
          requestBundle,
          game.requestSha256,
          armSpecForValidation,
          run.cohortId,
        );
        if (initialValidation.errors.length === 0) {
          violations.push(`${key}: repair was used but the archived initial response already validates`);
        }
        const initialFingerprint = extractDecisionFingerprint(initialRaw, requestBundle);
        if (initialFingerprint === null) {
          violations.push(`${key}: repair was used but the initial response has no complete decision fingerprint`);
        } else if (
          compareFingerprints(initialFingerprint, fingerprintFromParsed(revalidation.parsed)).length > 0
        ) {
          violations.push(`${key}: the accepted repair changed decisions relative to the initial response`);
        }
      }
    }
    const shapeData = revalidation.parsed;
    const responseGame = shapeData.games.find((g) => g.gameId === response.gameId);
    if (!responseGame) {
      violations.push(`${key}: accepted raw response does not contain game ${response.gameId}`);
      continue;
    }
    const forecastByMarket = new Map(responseGame.forecasts.map((f) => [f.market, f]));
    for (const pick of list) {
      const forecast = forecastByMarket.get(pick.market);
      if (!forecast) {
        violations.push(`${key} ${pick.market}: no matching forecast in the accepted response`);
        continue;
      }
      const mismatch =
        forecast.selection !== pick.selection ||
        forecast.line !== pick.line ||
        forecast.observedDecimal !== pick.entryDecimal ||
        forecast.probabilities.win !== pick.probabilities?.win ||
        forecast.probabilities.push !== pick.probabilities?.push ||
        forecast.probabilities.loss !== pick.probabilities?.loss ||
        forecast.confidence !== pick.confidenceValue ||
        forecast.wouldAbstain !== pick.wouldAbstain ||
        forecast.selectedForExecution !== pick.selectedForExecution;
      if (mismatch) {
        violations.push(`${key} ${pick.market}: decision does not match the accepted provider response`);
      }
      if (
        pick.provider !== response.provider ||
        pick.requestedModelId !== response.requestedModelId ||
        pick.reportedModelId !== response.accepted.reportedModelId ||
        pick.providerResponseId !== response.accepted.providerResponseId ||
        pick.attemptUsed !== (response.repairUsed ? 'repair' : 'initial')
      ) {
        violations.push(`${key} ${pick.market}: decision provenance does not match the accepted attempt`);
      }
    }
  }
  for (const response of run.armResponses) {
    if (response.outcome === 'valid' && !modelPicksByKey.has(`${response.participantId}:${response.gameId}`)) {
      violations.push(
        `valid arm response ${response.participantId}:${response.gameId} has no decision records`,
      );
    }
  }

  // Timing evidence is archived and therefore verified: each response's
  // cutoff must equal the hash-verified game cutoff, and an attempt's
  // timestamps must be parseable, ordered, latency-consistent, and (for
  // accepted work) strictly before the cutoff.
  const timingCompleteness = (attempt: ArchivedAttempt, label: string): string | null => {
    if (attempt.requestAt === null || attempt.responseAt === null || attempt.latencyMs === null) {
      return `${label}: archived timing fields are missing`;
    }
    const requestMs = Date.parse(attempt.requestAt);
    const responseMs = Date.parse(attempt.responseAt);
    if (Number.isNaN(requestMs) || Number.isNaN(responseMs)) {
      return `${label}: archived timestamps do not parse`;
    }
    if (requestMs > responseMs) return `${label}: responseAt precedes requestAt`;
    if (attempt.latencyMs !== responseMs - requestMs) {
      return `${label}: latencyMs does not equal the archived timestamp difference`;
    }
    return null;
  };
  const attemptTimingViolation = (
    attempt: ArchivedAttempt,
    cutoffMs: number,
    label: string,
  ): string | null => {
    const completeness = timingCompleteness(attempt, label);
    if (completeness !== null) return completeness;
    if (Date.parse(attempt.responseAt as string) >= cutoffMs) {
      return `${label}: response arrived at or after the decision cutoff`;
    }
    return null;
  };

  // Outcome-class consistency for NON-valid outcomes, mirroring the runner's
  // own rules from the archived attempts — a valid response cannot be demoted
  // to invalid_schema (hiding it from scoring), and transport outcomes cannot
  // carry response bodies.
  for (const response of run.armResponses) {
    const key = `${response.participantId}:${response.gameId}`;
    const requestBundle = requestBundleByGame.get(response.gameId);
    const game = run.games.get(response.gameId);
    if (requestBundle === undefined || game === undefined) continue;
    if (response.cutoffAt !== game.cutoffAt) {
      violations.push(`${key}: response cutoffAt does not match the hash-verified game cutoff`);
      continue;
    }
    const cutoffMs = Date.parse(game.cutoffAt);
    // ANY attempt with an archived response body must carry complete,
    // ordered, latency-consistent timing — for every outcome. Blanking the
    // timing fields cannot exempt a body-bearing response from the rules.
    const bodyBearing: Array<[ArchivedAttempt, string]> = [
      [response.attempt, `${key} initial attempt`],
      ...(response.repair !== null ? ([[response.repair, `${key} repair attempt`]] as Array<[ArchivedAttempt, string]>) : []),
    ];
    for (const [attempt, label] of bodyBearing) {
      if (attempt.rawResponse !== null) {
        const completeness = timingCompleteness(attempt, label);
        if (completeness !== null) violations.push(completeness);
      }
    }
    if (response.outcome === 'valid') {
      const initialTiming = attemptTimingViolation(response.attempt, cutoffMs, `${key} initial attempt`);
      if (initialTiming !== null) violations.push(initialTiming);
      if (response.repairUsed && response.repair !== null) {
        const repairTiming = attemptTimingViolation(response.repair, cutoffMs, `${key} repair attempt`);
        if (repairTiming !== null) violations.push(repairTiming);
      }
    }
    const armSpecForValidation = {
      participantId: response.participantId,
      provider: response.provider,
      requestedModelId: response.requestedModelId,
      credentialEnvVar: '',
    } as ArmSpec;
    if (response.outcome === 'invalid_schema') {
      const initialRaw = response.attempt.rawResponse;
      if (initialRaw === null) {
        violations.push(`${key}: invalid_schema outcome with no archived initial response`);
        continue;
      }
      const initialValidation = validateResponseText(
        initialRaw,
        requestBundle,
        game.requestSha256,
        armSpecForValidation,
        run.cohortId,
      );
      if (initialValidation.errors.length === 0) {
        violations.push(
          `${key}: recorded invalid_schema but the archived initial response validates — a valid response cannot be demoted`,
        );
        continue;
      }
      const repairRaw = response.repair?.rawResponse ?? null;
      if (response.repairUsed && repairRaw !== null) {
        const repairValidation = validateResponseText(
          repairRaw,
          requestBundle,
          game.requestSha256,
          armSpecForValidation,
          run.cohortId,
        );
        if (repairValidation.errors.length === 0 && repairValidation.parsed !== null) {
          const initialFingerprint = extractDecisionFingerprint(initialRaw, requestBundle);
          if (
            initialFingerprint !== null &&
            compareFingerprints(initialFingerprint, fingerprintFromParsed(repairValidation.parsed)).length === 0
          ) {
            violations.push(
              `${key}: recorded invalid_schema but the archived repair validates and preserves the fingerprint — this response should be valid`,
            );
          }
        }
      }
      if (!response.repairUsed && extractDecisionFingerprint(initialRaw, requestBundle) !== null) {
        violations.push(
          `${key}: invalid_schema without a repair, but the initial response has a complete fingerprint — the harness would have attempted a repair`,
        );
      }
    } else if (
      response.outcome === 'timeout' ||
      response.outcome === 'rate_limited' ||
      response.outcome === 'provider_error' ||
      response.outcome === 'credential_missing'
    ) {
      if (response.attempt.rawResponse !== null || (response.repair?.rawResponse ?? null) !== null) {
        violations.push(`${key}: transport outcome ${response.outcome} cannot carry a response body`);
      }
    }
    else if (response.outcome === 'cutoff_missed') {
      // A cutoff_missed outcome is legitimate only when the archived
      // evidence supports it: an initial response that VALIDATES and
      // demonstrably arrived before the cutoff cannot be demoted to a
      // timing failure. (Legitimate cases pass: no response at dispatch,
      // response after cutoff, or an invalid-before-cutoff response whose
      // repair window closed or whose repair arrived late.)
      const initialRaw = response.attempt.rawResponse;
      const responseMs =
        response.attempt.responseAt === null ? Number.NaN : Date.parse(response.attempt.responseAt);
      if (initialRaw !== null && !Number.isNaN(responseMs) && responseMs < cutoffMs) {
        const armSpecForTiming = {
          participantId: response.participantId,
          provider: response.provider,
          requestedModelId: response.requestedModelId,
          credentialEnvVar: '',
        } as ArmSpec;
        const initialValidation = validateResponseText(
          initialRaw,
          requestBundle,
          game.requestSha256,
          armSpecForTiming,
          run.cohortId,
        );
        if (initialValidation.errors.length === 0) {
          violations.push(
            `${key}: recorded cutoff_missed but the archived initial response validates and arrived before the cutoff — a valid response cannot be demoted to a timing failure`,
          );
        }
      }
    }
  }

  // The identity/collision gate is RECOMPUTED from the archived reported
  // model IDs and the approved-ID registry — the recomputed failure set must
  // be empty regardless of whether run_failure records survived, and any
  // recorded failures must correspond to recomputed ones.
  const reportedByArm = new Map<string, Set<string>>();
  const unidentifiedByArm = new Map<string, number>();
  for (const response of run.armResponses) {
    const reported = reportedByArm.get(response.participantId) ?? new Set<string>();
    for (const attempt of [response.attempt, response.repair]) {
      if (attempt === null) continue;
      if (attempt.reportedModelId !== null) reported.add(attempt.reportedModelId);
      if (attempt.rawResponse !== null && attempt.reportedModelId === null) {
        unidentifiedByArm.set(response.participantId, (unidentifiedByArm.get(response.participantId) ?? 0) + 1);
      }
    }
    reportedByArm.set(response.participantId, reported);
  }
  const recomputedIdentity = checkProviderCollision(
    expectedArms.map((arm) => ({
      participantId: arm.participantId,
      provider: arm.provider as ProviderName,
      requestedModelId: arm.requestedModelId,
      approvedReportedModelIds: arm.approvedReportedModelIds,
      reportedModelIds: [...(reportedByArm.get(arm.participantId) ?? new Set<string>())],
      unidentifiedResponses: unidentifiedByArm.get(arm.participantId) ?? 0,
    })),
  );
  for (const failure of recomputedIdentity.failures) {
    violations.push(`recomputed identity gate: ${failure}`);
  }
  const recordedFailureTexts = new Set(run.runFailures.flatMap((f) => f.failures));
  for (const recorded of recordedFailureTexts) {
    if (!recomputedIdentity.failures.includes(recorded)) {
      violations.push(`recorded run_failure does not correspond to any recomputed failure: ${recorded}`);
    }
  }

  // Echo re-verification against the hash-verified bundles.
  for (const pick of run.picks) {
    const game = run.games.get(pick.gameId);
    if (!game) {
      violations.push(`pick ${pick.participantId}:${pick.gameId}:${pick.market} references an unknown game`);
      continue;
    }
    let side: SelectedSide;
    try {
      side = sideForSelection(pick.market, pick.selection, game);
    } catch (error) {
      violations.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const expected = expectedEntry(game, pick.market, side);
    if (pick.entryDecimal !== expected.price) {
      violations.push(
        `${pick.participantId}:${pick.gameId}:${pick.market}: entry price ${pick.entryDecimal} does not match the frozen bundle price ${expected.price}`,
      );
    }
    if (pick.line !== expected.line) {
      violations.push(
        `${pick.participantId}:${pick.gameId}:${pick.market}: line ${pick.line ?? 'null'} does not match the designated line ${expected.line ?? 'null'}`,
      );
    }
    if (pick.echoedRequestSha256 !== null && pick.echoedRequestSha256 !== game.requestSha256) {
      violations.push(`${pick.participantId}:${pick.gameId}:${pick.market}: echoed request hash mismatch`);
    }
    if (pick.echoedGameSha256 !== null && pick.echoedGameSha256 !== game.gameSha256) {
      violations.push(`${pick.participantId}:${pick.gameId}:${pick.market}: echoed game hash mismatch`);
    }
    if (pick.echoedSlateSha256 !== null && pick.echoedSlateSha256 !== run.slateSha256) {
      violations.push(`${pick.participantId}:${pick.gameId}:${pick.market}: echoed slate hash mismatch`);
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Join + score
// ---------------------------------------------------------------------------

export function closeQuoteFromRow(row: ClosingLineRow): CloseQuote {
  return {
    line: row.line,
    awayDecimal: row.away_odds_decimal,
    homeDecimal: row.home_odds_decimal,
    awayPNovig: row.away_p_novig,
    homePNovig: row.home_p_novig,
    confidence: row.confidence,
  };
}

export function closesByKey(rows: ClosingLineRow[]): Map<string, ClosingLineRow> {
  return new Map(rows.map((row) => [`${row.jsonodds_id}:${row.market}`, row]));
}

export interface ScoredPick extends SourcePick {
  side: SelectedSide;
  /** The opposite side's frozen bundle price — the margin-adjusted entry de-vig input. */
  entryOppositeDecimal: number;
  result: ClvResult;
  /** TOTALS_V1 ladder block — non-null on every totals pick, null elsewhere. */
  ladder: TotalsLadderResult | null;
  close: ClosingLineRow | null;
}

/**
 * Selection label → close-column side. Moneyline/spread selections are exact
 * team names; totals map over → away column, under → home column (the
 * upstream storage convention).
 */
export function sideForSelection(
  market: MarketKey,
  selection: string,
  game: { awayTeam: string; homeTeam: string },
): SelectedSide {
  if (market === 'total') {
    if (selection === 'over') return 'away';
    if (selection === 'under') return 'home';
    throw new Error(`total selection must be over/under, got "${selection}"`);
  }
  if (selection === game.awayTeam) return 'away';
  if (selection === game.homeTeam) return 'home';
  throw new Error(
    `selection "${selection}" matches neither "${game.awayTeam}" (away) nor "${game.homeTeam}" (home)`,
  );
}

export function scoreRun(
  run: SourceRun,
  closeRows: ClosingLineRow[],
  ladderParams: LadderParams,
): ScoredPick[] {
  const closes = closesByKey(closeRows);
  return run.picks.map((pick) => {
    const game = run.games.get(pick.gameId);
    if (!game) {
      throw new Error(`pick references game ${pick.gameId} with no bundle_game record`);
    }
    const side = sideForSelection(pick.market, pick.selection, game);
    const movementSelection =
      pick.market === 'total' ? (pick.selection as 'over' | 'under') : side;
    // The opposite side of the same contract, from the same hash-verified
    // bundle the entry price was verified against — the margin-adjusted
    // entry de-vig needs both sides.
    const entryOppositeDecimal = expectedEntry(
      game,
      pick.market,
      side === 'away' ? 'home' : 'away',
    ).price;
    const close = closes.get(`${pick.gameId}:${pick.market}`) ?? null;
    const closeQuote = close === null ? null : closeQuoteFromRow(close);
    const exactLine = scoreDecision(
      pick.market,
      side,
      movementSelection,
      pick.entryDecimal,
      entryOppositeDecimal,
      pick.line,
      closeQuote,
    );
    // Every totals pick additionally gets the TOTALS_V1 candidate ladder
    // block — sensitivity output, separately labeled, never entering the
    // primary columns while the method's validation is pending. The
    // close-quality gates are SHARED (taken from the exact-line verdict,
    // never re-derived) and the method domain is runtime-bound.
    let ladder: TotalsLadderResult | null = null;
    if (pick.market === 'total' && pick.line !== null) {
      ladder = scoreTotalsLadder({
        league: game.league,
        selection: pick.selection as 'over' | 'under',
        entryDecimal: pick.entryDecimal,
        entryOppositeDecimal,
        entryLine: pick.line,
        close: closeQuote,
        gateReason: exactLine.unscoredReason,
        params: ladderParams,
      });
    }
    return { ...pick, side, entryOppositeDecimal, result: exactLine, ladder, close };
  });
}

// ---------------------------------------------------------------------------
// Aggregation — equal-weight game-level primary, full coverage accounting
// ---------------------------------------------------------------------------

export interface ClvSummary {
  meanClvPct: number | null;
  medianClvPct: number | null;
  beatClosePct: number | null;
}

/**
 * Per-market aggregate for one participant. This is the cross-participant
 * comparison surface: vig differs by market, so CLV is never pooled across
 * markets when comparing participants with different market exposure.
 */
export interface MarketStats {
  /**
   * Decision opportunities in this market: dispatched games for a model arm
   * (so an arm that failed every game still shows 0/N here — failures never
   * leave the denominators), recorded picks for a baseline.
   */
  eligible: number;
  picks: number;
  scoreable: number;
  /** Games with at least one primary-scoreable pick in this market. */
  gamesScoreable: number;
  /**
   * Equal-weight game-level aggregate within this market. With one pick per
   * participant/game/market this equals perPick; the within-game clustering
   * is applied regardless so multi-pick runs aggregate correctly.
   */
  gameLevel: ClvSummary;
  perPick: ClvSummary;
  /** Margin-adjusted mirrors of gameLevel/perPick (same clustering). */
  gameLevelMarginAdjusted: ClvSummary;
  perPickMarginAdjusted: ClvSummary;
  unscoredByReason: Record<string, number>;
}

export interface ParticipantStats {
  participantId: string;
  kind: 'model' | 'baseline';
  /** Games this arm was dispatched (models) or picked in (baselines). */
  games: number;
  /** Market-decision opportunities: models 3 per dispatched game; baselines 1 per pick. */
  eligibleMarkets: number;
  /** Valid decisions present in the run file. */
  validDecisions: number;
  /** Arm-level outcome counts (models) — failures stay in the denominator. */
  armOutcomes: Record<string, number>;
  primaryScoreable: number;
  /**
   * Rows with a margin-adjusted value — equals primaryScoreable by
   * construction: the two metrics share every availability gate, and the
   * bundle schema refuses files whose opposite-side prices are not valid
   * quotes (>1), so the entry de-vig can never fail on a parsed run.
   */
  marginAdjustedScoreable: number;
  /** PRIMARY: equal-weight game-level aggregate (mean of per-game mean CLV). */
  gamesScoreable: number;
  gameLevel: ClvSummary;
  /** Secondary: per-pick aggregate. */
  perPick: ClvSummary;
  /** Margin-adjusted mirrors of gameLevel/perPick (same clustering). */
  gameLevelMarginAdjusted: ClvSummary;
  perPickMarginAdjusted: ClvSummary;
  /**
   * shin-v1 sensitivity — a PAIRED within-participant method readout, not a
   * comparison surface. A pick enters only when BOTH methods produced a
   * value (shin needs usable raw quotes at entry and close), and the
   * proportional side is re-aggregated over that identical paired set, so
   * the shin-vs-proportional deltas are method-only by construction — never
   * coverage artifacts. Unpaired picks are disclosed via the paired counts.
   */
  sensitivity: {
    devigMethod: typeof SHIN_DEVIG_METHOD;
    pairedPicksEconomic: number;
    pairedPicksMarginAdjusted: number;
    economic: { proportional: ClvSummary; shin: ClvSummary };
    marginAdjusted: { proportional: ClvSummary; shin: ClvSummary };
  };
  conditionalOnly: number;
  unscoredByReason: Record<string, number>;
  byMarket: Record<string, MarketStats>;
  /**
   * TOTALS_V1 candidate-ladder aggregates over this participant's totals
   * picks — sensitivity output pending the method's independent validation,
   * reported ALONGSIDE the exact-line totals numbers in byMarket.total and
   * never entering them. Line movement alone never disqualifies a pick; the
   * shared close-quality gates and the method domain still can. Null for
   * participants with no totals exposure.
   */
  totalsLadder: {
    ladderVersion: typeof LADDER_VERSION;
    /** The published dispersion-parameter version the ladder ran on. */
    parameterVersion: string;
    totalsPicks: number;
    ladderScoreable: number;
    gameLevel: ClvSummary;
    perPick: ClvSummary;
    gameLevelMarginAdjusted: ClvSummary;
    perPickMarginAdjusted: ClvSummary;
    /** Mean favorable signed line movement over ladder-scored picks (0 = unmoved). */
    meanSignedMovement: number | null;
    unscoredByReason: Record<string, number>;
  } | null;
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round4(values.reduce((a, b) => a + b, 0) / values.length);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return round4(value);
}

function summary(values: number[]): ClvSummary {
  return {
    meanClvPct: mean(values),
    medianClvPct: median(values),
    beatClosePct:
      values.length === 0
        ? null
        : round4((values.filter((v) => v > 0).length / values.length) * 100),
  };
}

/**
 * Equal-weight game-first clustering for one metric extractor: collect the
 * non-null values and the per-game means (average within each game first).
 * Every metric (economic, margin-adjusted, shin variants) aggregates through
 * this one path so the clustering can never diverge between metrics.
 */
function clusterByGame(
  picks: ScoredPick[],
  value: (pick: ScoredPick) => number | null,
): { values: number[]; gameMeans: number[] } {
  const values: number[] = [];
  const byGame = new Map<string, number[]>();
  for (const pick of picks) {
    const v = value(pick);
    if (v === null) continue;
    values.push(v);
    const list = byGame.get(pick.gameId) ?? [];
    list.push(v);
    byGame.set(pick.gameId, list);
  }
  const gameMeans = [...byGame.values()]
    .map((vs) => mean(vs))
    .filter((v): v is number => v !== null);
  return { values, gameMeans };
}

export function aggregateByParticipant(
  scored: ScoredPick[],
  run: SourceRun,
  ladderParams: LadderParams,
): ParticipantStats[] {
  const picksByParticipant = new Map<string, ScoredPick[]>();
  for (const pick of scored) {
    const list = picksByParticipant.get(pick.participantId) ?? [];
    list.push(pick);
    picksByParticipant.set(pick.participantId, list);
  }
  const responsesByParticipant = new Map<string, ArmResponseRef[]>();
  for (const response of run.armResponses) {
    const list = responsesByParticipant.get(response.participantId) ?? [];
    list.push(response);
    responsesByParticipant.set(response.participantId, list);
  }

  // Every arm that was dispatched appears, even with zero valid decisions —
  // failures must never vanish from the denominators.
  const participantIds = [
    ...new Set([...responsesByParticipant.keys(), ...picksByParticipant.keys()]),
  ];

  const stats: ParticipantStats[] = [];
  for (const participantId of participantIds) {
    const picks = picksByParticipant.get(participantId) ?? [];
    const responses = responsesByParticipant.get(participantId) ?? [];
    const kind: 'model' | 'baseline' =
      responses.length > 0 || picks[0]?.kind === 'model' ? 'model' : 'baseline';

    const armOutcomes: Record<string, number> = {};
    for (const response of responses) {
      armOutcomes[response.outcome] = (armOutcomes[response.outcome] ?? 0) + 1;
    }

    const unscoredByReason: Record<string, number> = {};
    for (const pick of picks) {
      if (pick.result.unscoredReason !== null) {
        unscoredByReason[pick.result.unscoredReason] =
          (unscoredByReason[pick.result.unscoredReason] ?? 0) + 1;
      }
    }

    // Equal-weight game level: average scoreable CLV within each game first
    // — identically for every metric.
    const economic = clusterByGame(picks, (p) => p.result.primaryClvPct);
    const marginAdjusted = clusterByGame(picks, (p) => p.result.marginAdjustedClvPct);

    // The sensitivity comparison is PAIRED: restrict to picks where the
    // shin value exists, then aggregate BOTH methods over exactly that
    // subset — a delta can only ever reflect the method, never coverage.
    const pairedEconomic = picks.filter((p) => p.result.sensitivity?.economicClvPct != null);
    const pairedMarginAdjusted = picks.filter(
      (p) => p.result.sensitivity?.marginAdjustedClvPct != null,
    );
    const pairedEconProportional = clusterByGame(pairedEconomic, (p) => p.result.primaryClvPct);
    const pairedEconShin = clusterByGame(
      pairedEconomic,
      (p) => p.result.sensitivity?.economicClvPct ?? null,
    );
    const pairedMaProportional = clusterByGame(
      pairedMarginAdjusted,
      (p) => p.result.marginAdjustedClvPct,
    );
    const pairedMaShin = clusterByGame(
      pairedMarginAdjusted,
      (p) => p.result.sensitivity?.marginAdjustedClvPct ?? null,
    );

    // Per-market aggregates use the same game-first clustering as the
    // pooled primary, scoped to one market — never pooled across markets.
    // A model arm is eligible in every market of every dispatched game, so
    // it keeps a (possibly 0/N) entry even when it produced no decisions.
    const byMarket: ParticipantStats['byMarket'] = {};
    for (const market of MARKETS) {
      const marketPicks = picks.filter((p) => p.market === market);
      const eligible = kind === 'model' ? responses.length : marketPicks.length;
      if (eligible === 0 && marketPicks.length === 0) continue;
      const marketEconomic = clusterByGame(marketPicks, (p) => p.result.primaryClvPct);
      const marketMarginAdjusted = clusterByGame(
        marketPicks,
        (p) => p.result.marginAdjustedClvPct,
      );
      const marketUnscored: Record<string, number> = {};
      for (const pick of marketPicks) {
        if (pick.result.unscoredReason !== null) {
          marketUnscored[pick.result.unscoredReason] =
            (marketUnscored[pick.result.unscoredReason] ?? 0) + 1;
        }
      }
      byMarket[market] = {
        eligible,
        picks: marketPicks.length,
        scoreable: marketEconomic.values.length,
        gamesScoreable: marketEconomic.gameMeans.length,
        gameLevel: summary(marketEconomic.gameMeans),
        perPick: summary(marketEconomic.values),
        gameLevelMarginAdjusted: summary(marketMarginAdjusted.gameMeans),
        perPickMarginAdjusted: summary(marketMarginAdjusted.values),
        unscoredByReason: marketUnscored,
      };
    }

    // Ladder aggregates over totals picks only. Same game-first clustering
    // as every other metric; with one totals pick per participant/game the
    // game-level and per-pick views coincide, and both are reported.
    const totalsPicks = picks.filter((p) => p.market === 'total');
    const ladderEconomic = clusterByGame(totalsPicks, (p) => p.ladder?.economicClvPct ?? null);
    const ladderMarginAdjusted = clusterByGame(
      totalsPicks,
      (p) => p.ladder?.marginAdjustedClvPct ?? null,
    );
    const ladderUnscored: Record<string, number> = {};
    const movements: number[] = [];
    for (const pick of totalsPicks) {
      if (pick.ladder === null) continue;
      if (pick.ladder.unscoredReason !== null) {
        ladderUnscored[pick.ladder.unscoredReason] =
          (ladderUnscored[pick.ladder.unscoredReason] ?? 0) + 1;
      } else if (pick.line !== null && pick.close !== null && pick.close.line !== null) {
        movements.push(
          favorableLineMovement(
            'total',
            pick.selection as 'over' | 'under',
            pick.line,
            pick.close.line,
          ),
        );
      }
    }
    const totalsEligible = kind === 'model' ? responses.length : totalsPicks.length;
    const totalsLadder: ParticipantStats['totalsLadder'] =
      totalsEligible === 0 && totalsPicks.length === 0
        ? null
        : {
            ladderVersion: LADDER_VERSION,
            parameterVersion: ladderParams.parameterVersion,
            totalsPicks: totalsPicks.length,
            ladderScoreable: ladderEconomic.values.length,
            gameLevel: summary(ladderEconomic.gameMeans),
            perPick: summary(ladderEconomic.values),
            gameLevelMarginAdjusted: summary(ladderMarginAdjusted.gameMeans),
            perPickMarginAdjusted: summary(ladderMarginAdjusted.values),
            meanSignedMovement: mean(movements),
            unscoredByReason: ladderUnscored,
          };

    stats.push({
      participantId,
      kind,
      games: kind === 'model' ? responses.length : new Set(picks.map((p) => p.gameId)).size,
      eligibleMarkets: kind === 'model' ? responses.length * 3 : picks.length,
      validDecisions: picks.length,
      armOutcomes,
      primaryScoreable: economic.values.length,
      marginAdjustedScoreable: marginAdjusted.values.length,
      gamesScoreable: economic.gameMeans.length,
      gameLevel: summary(economic.gameMeans),
      perPick: summary(economic.values),
      gameLevelMarginAdjusted: summary(marginAdjusted.gameMeans),
      perPickMarginAdjusted: summary(marginAdjusted.values),
      sensitivity: {
        devigMethod: SHIN_DEVIG_METHOD,
        pairedPicksEconomic: pairedEconomic.length,
        pairedPicksMarginAdjusted: pairedMarginAdjusted.length,
        economic: {
          proportional: summary(pairedEconProportional.gameMeans),
          shin: summary(pairedEconShin.gameMeans),
        },
        marginAdjusted: {
          proportional: summary(pairedMaProportional.gameMeans),
          shin: summary(pairedMaShin.gameMeans),
        },
      },
      // Conditional-ONLY means exactly that: a conditional value with NO
      // primary. Under the current candidate-status policy every integer
      // same-line pick satisfies this (its primary is never filled); the
      // two-sided predicate is kept so the count stays honest if a validated
      // method ever fills a conditional pick's primary.
      conditionalOnly: picks.filter(
        (p) => p.result.conditionalClvPct !== null && p.result.primaryClvPct === null,
      ).length,
      unscoredByReason,
      byMarket,
      totalsLadder,
    });
  }

  // Models first (by game-level mean CLV desc), then baselines.
  const rank = (s: ParticipantStats): number =>
    s.gameLevel.meanClvPct === null ? -1e9 : s.gameLevel.meanClvPct;
  return stats.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'model' ? -1 : 1;
    return rank(b) - rank(a);
  });
}

// ---------------------------------------------------------------------------
// Scored records (NDJSON shape)
// ---------------------------------------------------------------------------

export function scoredRecords(
  run: SourceRun,
  scored: ScoredPick[],
  stats: ParticipantStats[],
  scoredAt: string,
  ladderParams: LadderParams,
): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  records.push({
    recordType: 'scored_run_meta',
    label: SMOKE_LABEL,
    runId: run.runId,
    cohortId: run.cohortId,
    slateDate: run.slateDate,
    slateSha256: run.slateSha256,
    sourceMode: run.mode,
    scoredAt,
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    integrityVerified: true,
    metric:
      'reference-closing CLV, economic + margin-adjusted (single reference source, decision CLV only)',
    metrics: {
      economic:
        'vig-in entry vs no-vig close, 100*(D_e*q_close - 1) — the industry-standard reading; a flat market reads at about minus the vig (PRIMARY)',
      marginAdjusted:
        'de-vigged entry vs no-vig close, 100*(q_close/q_entry - 1) on push-free contracts — 0 means the forecast exactly matched the market (always reported alongside, never a replacement)',
      totalsLadder:
        'generalized push-aware CLV at the ENTRY line, 100*(q_W*D_e + q_P - 1) economic and 100*(q_W/q_entry + q_P - 1) margin-adjusted, with q_W/q_P from the TOTALS_V1 negative-binomial ladder solved at the close. CANDIDATE method pending independent alternate-ladder validation: sensitivity output, separately labeled, never pooled into the primary columns. Line movement alone never disqualifies a totals pick; the shared close-quality gates and the method domain (MLB, half-step lines within the rail, solvable closes) still can, each with a typed disclosed reason',
    },
    devigMethods: {
      primary: PROPORTIONAL_DEVIG_METHOD,
      sensitivity: [SHIN_DEVIG_METHOD],
    },
    ladder: {
      version: LADDER_VERSION,
      parameterVersion: ladderParams.parameterVersion,
      k: ladderParams.k,
    },
    primaryAggregate: 'equal-weight game-level mean (per-pick reported as secondary)',
    closePolicy: {
      confidenceRequired: 'fresh',
      lineMatchRequired: true,
      integerLinePrimary:
        'unavailable (push-excluded conditional CLV separately labeled, both metrics); the TOTALS_V1 candidate ladder reports the generalized push-aware value as separately labeled sensitivity output, pending validation',
    },
    picks: scored.length,
    primaryScoreable: scored.filter((p) => p.result.primaryClvPct !== null).length,
    marginAdjustedScoreable: scored.filter((p) => p.result.marginAdjustedClvPct !== null).length,
    totalsLadderScoreable: scored.filter((p) => p.ladder?.economicClvPct != null).length,
    armGameResponses: run.armResponses.length,
  });
  for (const pick of scored) {
    const game = run.games.get(pick.gameId);
    records.push({
      recordType: 'scored_decision',
      label: SMOKE_LABEL,
      runId: run.runId,
      scoredAt,
      scoringPolicyVersion: SCORING_POLICY_VERSION,
      kind: pick.kind,
      participantId: pick.participantId,
      provider: pick.provider,
      requestedModelId: pick.requestedModelId,
      reportedModelId: pick.reportedModelId,
      providerResponseId: pick.providerResponseId,
      attemptUsed: pick.attemptUsed,
      gameId: pick.gameId,
      slateSha256: run.slateSha256,
      gameSha256: game?.gameSha256 ?? null,
      requestSha256: game?.requestSha256 ?? null,
      market: pick.market,
      selection: pick.selection,
      side: pick.side,
      entryDecimal: pick.entryDecimal,
      entryOppositeDecimal: pick.entryOppositeDecimal,
      entryLine: pick.line,
      devigMethod: PROPORTIONAL_DEVIG_METHOD,
      modelWinProbability: pick.modelWinProbability,
      wouldAbstain: pick.wouldAbstain,
      selectedForExecution: pick.selectedForExecution,
      closing:
        pick.close === null
          ? null
          : {
              line: pick.close.line,
              awayDecimal: pick.close.away_odds_decimal,
              homeDecimal: pick.close.home_odds_decimal,
              awayPNovig: pick.close.away_p_novig,
              homePNovig: pick.close.home_p_novig,
              confidence: pick.close.confidence,
              valueCapturedAt: pick.close.value_captured_at,
              lockTime: pick.close.lock_time,
            },
      primaryClvPct: pick.result.primaryClvPct,
      unscoredReason: pick.result.unscoredReason,
      conditionalClvPct: pick.result.conditionalClvPct,
      marginAdjustedClvPct: pick.result.marginAdjustedClvPct,
      marginAdjustedConditionalClvPct: pick.result.marginAdjustedConditionalClvPct,
      lineMovementFavorable: pick.result.lineMovementFavorable,
      closingPNovigSelected: pick.result.closingPNovigSelected,
      entryPNovigSelected: pick.result.entryPNovigSelected,
      sensitivity: pick.result.sensitivity,
      ladder: pick.ladder,
      aux: pick.result.aux,
    });
  }
  for (const stat of stats) {
    records.push({
      recordType: 'participant_scorecard',
      label: SMOKE_LABEL,
      runId: run.runId,
      scoredAt,
      scoringPolicyVersion: SCORING_POLICY_VERSION,
      devigMethods: {
        primary: PROPORTIONAL_DEVIG_METHOD,
        sensitivity: [SHIN_DEVIG_METHOD],
      },
      ...stat,
    });
  }
  return records;
}
