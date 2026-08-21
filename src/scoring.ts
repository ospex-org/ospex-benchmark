import { z } from 'zod';
import { BASELINE_POLICY_VERSION, isBaselinePolicyVersion, runBaselines } from './baselines.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { PROPORTIONAL_DEVIG_METHOD, scoreDecision, SHIN_DEVIG_METHOD } from './clv.js';
import { favorableLineMovement } from './clv.js';
import { LADDER_VERSION, scoreTotalsLadder } from './ladder.js';
import { instantMs, isParseableInstant } from './time.js';
import { checkProviderCollision } from './providers/family.js';
import { approvedReportedModelIds, ARMS } from './providers/index.js';
import {
  CONFIGURATION_DIGEST_VERSION,
  configurationEvidenceViolations,
  configurationSha256,
} from './participantConfiguration.js';
import type { ParticipantConfiguration } from './participantConfiguration.js';
import {
  benchmarkResponseSchema,
  compareFingerprints,
  CURRENT_RESPONSE_SCHEMA_VERSION,
  extractDecisionFingerprint,
  extractJson,
  fingerprintFromParsed,
  validateResponseText,
} from './schema.js';
import { AXIS_NAMES } from './types.js';
import type { ResponseSchemaVersion } from './schema.js';
import type { BaselinePolicyVersion } from './baselines.js';
import type { ClvResult, CloseQuote, SelectedSide } from './clv.js';
import type { LadderParams, TotalsLadderResult } from './ladder.js';
import type { ArmSpec, AxisName, ClosingLineRow, MarketKey, ProviderName, SlateBundle } from './types.js';

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
 * v0.5.0 makes the scorer scope-aware (S3c): it accepts 1-3-market artifacts,
 * rejects unknown/zero market blocks, and derives per-scope denominators
 * (eligibleMarkets = sum of supplied markets, not responses * 3). Full-board
 * numeric/structural output is unchanged apart from this stamp — the new engine
 * accepts a wider artifact domain and emits different scoped aggregates, so it
 * must not share a methodology identity with the fixed-three-only v0.4.0.
 * v0.6.0 makes close TIMING evidence-bearing rather than assumed. The capture
 * timestamps stop being dropped on the way into the metric; a close still being
 * quoted by the feed after its own recorded lock is refused (`close_after_start`,
 * shared with the ladder); and a close whose lock disagrees with the frozen
 * bundle's scheduled start by at least the schedule-change tolerance is TAGGED
 * `scheduleChanged` and held out of the primary same-schedule estimate as a
 * disclosed stratum (its CLV is still computed, recorded, and counted — nothing
 * is discarded). Reason vocabulary, aggregation membership, and the
 * scored-record/scorecard shape all change, so this must not share a
 * methodology identity with v0.5.0.
 * v0.6.1 makes the scored artifact SELF-DESCRIBING about completeness:
 * `scored_run_meta` now declares `participantScorecards` beside `picks`, so a
 * reader can hold the file to its own declared record counts — a truncated
 * artifact is caught disagreeing with itself instead of publishing a partial
 * pass that looks complete. No scoring math, membership, or per-record shape
 * changes; the bump exists because the meta record's shape is part of the
 * artifact contract and readers key strictness off this identity.
 */
export const SCORING_POLICY_VERSION = 'scoring-v0.6.1';

/**
 * Schedule-change tolerance for the `yarn score` path, in milliseconds.
 *
 * The cohort runner takes its tolerance from its hashed manifest
 * (`constants.scheduleChangeToleranceMs`); the scoring CLI has no manifest,
 * so the value is a code constant here. The generated rehearsal manifest
 * IMPORTS this constant rather than restating the literal, so both paths tag
 * at one threshold by construction, and a test asserts that equality (a
 * literal in the manifest generator would let the two drift silently under
 * one policy version and one knob name). Any change to the number is a
 * scoring-policy change that bumps the version above.
 */
export const SCHEDULE_CHANGE_TOLERANCE_MS = 60_000;

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

/**
 * One entry of the run's arm-roster stamp: who competed and under what.
 *
 * `.strict()`, unlike almost everything else parsed here, because this is the
 * record that says who a decision belongs to. A key nobody planned for is a
 * dimension of identity nothing verified, and the whole value of the digest is
 * that it can be recomputed from the fields beside it.
 */
const armRosterEntrySchema = z
  .object({
    participantId: z.string().min(1),
    provider: z.string().min(1),
    requestedModelId: z.string().min(1),
    configuration: z.record(z.unknown()),
    configurationSha256: z.string().regex(/^[0-9a-f]{64}$/),
    configurationDigestVersion: z.number().int().positive(),
  })
  .strict();

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
    promptScaffoldVersion: z.string().min(1).optional(),
    watch: watchProvenanceSchema.optional(),
    // The run's own account of who competed and under what. OPTIONAL because
    // every artifact written before this stamp existed is still scoreable —
    // those runs were all-defaults by construction, since no configuration
    // could be declared. When present it is VERIFIED, never trusted: see
    // verifyRunIntegrity.
    armRoster: z.array(armRosterEntrySchema).min(1).optional(),
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
        // The REFERENCE the scorer's schedule-drift comparison is taken
        // against. Validated as an offset-qualified instant at parse, so an
        // undeterminable drift can never originate here: a bare `Date.parse`
        // would read an offset-less value as host-local time, and refusing it
        // downstream instead would leave the pick in the primary stratum with
        // `scheduleChanged === null` — fail-closed parsing followed by
        // fail-open aggregation.
        scheduledStartUtc: z
          .string()
          .min(1)
          .refine(isParseableInstant, {
            message:
              'scheduledStartUtc must be an ISO-8601 instant with an explicit offset (Z or +/-hh:mm)',
          }),
        markets: z
          .object({
            // A recorded bundle supplies 1-3 of the KNOWN markets (moneyline,
            // runLine, total); an absent market is an omitted key. `.strict()`
            // rejects any unknown market key, and the refinement rejects a
            // zero-market bundle with a direct cardinality error — the scorer
            // enforces the exact known-market scope on the archived artifact, so
            // a zero-market game is INVALID, not scored as zero coverage. (The
            // at-least-one guarantee at production time is separately the
            // prepared boundary's job, S3e, spec §2.2.) Every PRESENT block's
            // prices must be valid decimal quotes (>1), exactly like decision
            // observedDecimal: BOTH sides feed the margin-adjusted entry de-vig,
            // so an invalid opposite side refuses the file at parse time rather
            // than silently dropping margin-adjusted values while economic ones
            // still score.
            moneyline: z
              .object({ awayDecimal: z.number().gt(1), homeDecimal: z.number().gt(1) })
              .passthrough()
              .optional(),
            runLine: z
              .object({ line: z.number(), awayDecimal: z.number().gt(1), homeDecimal: z.number().gt(1) })
              .passthrough()
              .optional(),
            total: z
              .object({ line: z.number(), overDecimal: z.number().gt(1), underDecimal: z.number().gt(1) })
              .passthrough()
              .optional(),
          })
          .strict()
          .refine((m) => m.moneyline != null || m.runLine != null || m.total != null, {
            message:
              'bundle game must supply at least one known market block (moneyline, runLine, or total)',
          }),
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
    // Structured provider completion state (absent on archives that predate
    // it): the non-final terminal string, and whether the provider declared
    // the turn finished. Optional-when-absent so old evidence keeps parsing.
    providerStopReason: z.string().nullable().optional(),
    turnCompleted: z.boolean().nullable().optional(),
    // What the adapter recorded SENDING, derived from the body it built. This
    // is the evidence side of a participant's declared configuration. Nullable
    // when no request reached the provider; optional because the field has
    // always been written but has never before been READ, and an archive that
    // predates the reader should not become unscoreable for it.
    requestParams: z.record(z.unknown()).nullable().optional(),
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
    // Binds this row to an entry of the run's arm-roster stamp. Optional on an
    // archive written before the stamp existed.
    configurationSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    reportedModelId: z.string().nullable(),
    gameId: z.string().min(1),
    requestSha256: z.string().min(1),
    cutoffAt: z.string().min(1),
    outcome: z.string().min(1),
    repairUsed: z.boolean(),
    // Absent on archives that predate the per-record repair-transport stamp.
    repairTransport: z.string().nullable().optional(),
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
    // Which entrant made this decision. Optional on an archive predating the
    // stamp; verified against the run's roster when present, because this is
    // the field a publisher keys a participant row on and it was previously
    // written by the producer and read by nobody.
    configurationSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
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
    // Response schema v2 analysis fields; absent on v1-era archives, null on
    // records replayed from v1-shaped parses.
    axes: z
      .object({
        valuation: z.number(),
        trend: z.number(),
        consensus: z.number(),
        news: z.number(),
        softness: z.number(),
      })
      .passthrough()
      .nullable()
      .optional(),
    primaryAxis: z.enum(AXIS_NAMES).nullable().optional(),
    primaryExpectation: z.string().nullable().optional(),
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
  /**
   * The prices for each market the game SUPPLIES (1-3, S3 dynamic cardinality).
   * An absent market is an omitted key; on a full board all three are present.
   */
  prices: {
    moneyline?: { away: number; home: number };
    runLine?: { line: number; away: number; home: number };
    total?: { line: number; over: number; under: number };
  };
}

export interface SourcePick {
  kind: 'model' | 'baseline';
  participantId: string;
  /** The entrant this decision is attributed to; `null` on a baseline and on
   *  an archive written before the arm-roster stamp existed. */
  configurationSha256: string | null;
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
  /** Response schema v2 analysis fields; null on v1-era records and baselines. */
  axes: Record<AxisName, number> | null;
  primaryAxis: AxisName | null;
  primaryExpectation: string | null;
}

export interface ArchivedAttempt {
  reportedModelId: string | null;
  providerResponseId: string | null;
  rawResponse: string | null;
  requestAt: string | null;
  responseAt: string | null;
  latencyMs: number | null;
  /** The provider's own non-final terminal string; `null` on a finished turn,
   *  no response, or an archive that predates the field. */
  providerStopReason: string | null;
  /** Whether the provider declared the turn finished; `null` when no response
   *  was received or the archive predates the field. */
  turnCompleted: boolean | null;
  /** What the adapter recorded sending; `null` when the request never reached
   *  the provider, and `null` on an archive that predates the field. */
  requestParams: Record<string, unknown> | null;
}

export interface ArmResponseRef {
  participantId: string;
  provider: string;
  /** The archived repair transport outcome; `null` when absent (old archives). */
  repairTransport: string | null;
  requestedModelId: string;
  /** Binds this row to the run's arm-roster stamp; `null` on an old archive. */
  configurationSha256: string | null;
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

export type ArmRosterEntry = z.infer<typeof armRosterEntrySchema>;

/**
 * Whether this attempt shows a provider response came back at all.
 *
 * Any one of these three is only ever written from a received response, so a
 * leg carrying one but no `requestParams` is a record that has lost evidence
 * rather than one that never had any. A timeout or transport failure has all
 * three null.
 */
function reachedProvider(attempt: ArchivedAttempt): boolean {
  return (
    attempt.rawResponse !== null ||
    attempt.reportedModelId !== null ||
    attempt.providerResponseId !== null
  );
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
  /** Prompt scaffold version stamped at write time; null on legacy archives.
   *  Selects the response-schema era the integrity checks re-validate under. */
  promptScaffoldVersion: string | null;
  /** Watch-mode gate provenance; required (and verified) for watch runs. */
  watch: WatchProvenanceMeta | null;
  /**
   * The run's arm-roster stamp: who competed and under what. `null` on an
   * archive written before the stamp existed — those runs were all-defaults by
   * construction, because no configuration could be declared.
   */
  armRoster: ArmRosterEntry[] | null;
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
          // Reconstruct only the market blocks the recorded bundle supplies
          // (1-3, S3 dynamic cardinality); on a full board all three are present.
          prices: {
            ...(game.bundle.markets.moneyline
              ? {
                  moneyline: {
                    away: game.bundle.markets.moneyline.awayDecimal,
                    home: game.bundle.markets.moneyline.homeDecimal,
                  },
                }
              : {}),
            ...(game.bundle.markets.runLine
              ? {
                  runLine: {
                    line: game.bundle.markets.runLine.line,
                    away: game.bundle.markets.runLine.awayDecimal,
                    home: game.bundle.markets.runLine.homeDecimal,
                  },
                }
              : {}),
            ...(game.bundle.markets.total
              ? {
                  total: {
                    line: game.bundle.markets.total.line,
                    over: game.bundle.markets.total.overDecimal,
                    under: game.bundle.markets.total.underDecimal,
                  },
                }
              : {}),
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
          repairTransport: response.repairTransport ?? null,
          requestedModelId: response.requestedModelId,
          configurationSha256: response.configurationSha256 ?? null,
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
            providerStopReason: response.attempt.providerStopReason ?? null,
            turnCompleted: response.attempt.turnCompleted ?? null,
            requestParams: response.attempt.requestParams ?? null,
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
                  providerStopReason: response.repair.providerStopReason ?? null,
                  turnCompleted: response.repair.turnCompleted ?? null,
                  requestParams: response.repair.requestParams ?? null,
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
          configurationSha256: decision.configurationSha256 ?? null,
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
          axes: decision.axes ?? null,
          primaryAxis: decision.primaryAxis ?? null,
          primaryExpectation: decision.primaryExpectation ?? null,
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
          configurationSha256: null,
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
          axes: null,
          primaryAxis: null,
          primaryExpectation: null,
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
    promptScaffoldVersion: meta.promptScaffoldVersion ?? null,
    watch: meta.watch ?? null,
    armRoster: meta.armRoster ?? null,
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

/**
 * The response-schema era a run's archived bodies were produced under, keyed
 * by the run_meta prompt-scaffold stamp: pre-v0.4 scaffolds prompted the v1
 * response shape, v0.4 prompts v2. An absent stamp is a legacy pre-stamp
 * archive (v1); an unknown (future) scaffold validates as the current
 * version. Re-validating each run under ITS OWN era keeps both directions
 * exact — an old valid body neither fails the new schema, nor does a new
 * v1-shaped body (correctly refused by the runner) read as "validates".
 */
function responseSchemaVersionForRun(promptScaffoldVersion: string | null): ResponseSchemaVersion {
  if (promptScaffoldVersion === null) return 1;
  const byScaffold: Record<string, ResponseSchemaVersion> = {
    'shadow-smoke-v0.1': 1,
    'shadow-smoke-v0.2': 1,
    'shadow-smoke-v0.3': 1,
    'shadow-smoke-v0.4': 2,
    'shadow-smoke-v0.5': 2,
  };
  return byScaffold[promptScaffoldVersion] ?? CURRENT_RESPONSE_SCHEMA_VERSION;
}

/**
 * The response-side markets a recorded game SUPPLIES (1-3, S3 dynamic
 * cardinality), from its reconstructed prices; applies the `spread`<->`runLine`
 * key mapping. On a full board this is {moneyline, spread, total}.
 */
function suppliedMarketsOf(game: SourceGame): Set<MarketKey> {
  const supplied = new Set<MarketKey>();
  if (game.prices.moneyline) supplied.add('moneyline');
  if (game.prices.runLine) supplied.add('spread');
  if (game.prices.total) supplied.add('total');
  return supplied;
}

function expectedEntry(
  game: SourceGame,
  market: MarketKey,
  side: SelectedSide,
): { price: number; line: number | null } {
  if (market === 'moneyline') {
    const ml = game.prices.moneyline;
    if (!ml) throw new Error('game supplies no moneyline market');
    return { price: side === 'away' ? ml.away : ml.home, line: null };
  }
  if (market === 'spread') {
    const rl = game.prices.runLine;
    if (!rl) throw new Error('game supplies no spread (run line) market');
    return { price: side === 'away' ? rl.away : rl.home, line: rl.line };
  }
  const total = game.prices.total;
  if (!total) throw new Error('game supplies no total market');
  return { price: side === 'away' ? total.over : total.under, line: total.line };
}

/**
 * Verify the run file is internally consistent before trusting a single
 * number in it. Returns violations (empty = verified):
 *
 * - a recorded run_failure (identity/collision) makes the run unscoreable;
 * - every recorded game/request/slate hash must match a recomputation from
 *   the embedded bundles (a tampered price or bundle cannot hide);
 * - every model decision must be backed by a VALID arm response for the same
 *   participant/game/request hash, exactly one decision per SUPPLIED market
 *   (1-3; the three fixed markets on a full board) per valid response and none
 *   for non-valid ones (no fabricated decisions);
 * - every decision's echoed selection/line/price must re-verify against the
 *   hash-verified bundle, and its echoed hashes must match.
 */
export interface ExpectedArm {
  participantId: string;
  provider: string;
  requestedModelId: string;
  /** Exact approved response-reported model IDs for this arm. */
  approvedReportedModelIds: string[];
  /** The settings this arm competes under — the other half of what it IS. */
  configuration: ParticipantConfiguration;
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
    // BY REFERENCE, deliberately. `ARMS` is deep-frozen, so a caller that tries
    // to write through this throws. A shallow `{ ...arm.configuration }` would
    // be worse than no copy at all: a mutable top level over frozen members,
    // where a top-level write succeeds SILENTLY and moves the roster one call
    // site computes `cohortId` from while another still sees the original.
    configuration: arm.configuration,
  }));
}

export function verifyRunIntegrity(
  run: SourceRun,
  options?: { expectedArms?: ExpectedArm[] },
): string[] {
  const violations: string[] = [];
  // Archived bodies re-validate under the response-schema era THIS run was
  // produced in (see responseSchemaVersionForRun) — never the current-only
  // default, which is the new-run gate.
  const acceptedVersions: readonly ResponseSchemaVersion[] = [
    responseSchemaVersionForRun(run.promptScaffoldVersion),
  ];

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
  // Re-derive under the RECORDED policy version. A full-board policy (v0.1/v0.2)
  // re-run against a SCOPED artifact fails closed inside runBaselines
  // (assertFullBoard) — that is the "refuses an old-version/scoped artifact" rule
  // (spec §3): convert the throw into a clean violation rather than crash the
  // verifier, and skip the per-pick matching (there is nothing to match against).
  let expectedBaselines = new Map<string, ReturnType<typeof runBaselines>[number]>();
  let baselineDerivationOk = true;
  try {
    expectedBaselines = new Map(
      runBaselines(reconstructedSlate, baselinePolicyVersion).map((d) => [
        `${d.participantId}:${d.gameId}`,
        d,
      ]),
    );
  } catch (error) {
    baselineDerivationOk = false;
    violations.push(
      `baseline re-derivation failed under policy ${baselinePolicyVersion}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (baselineDerivationOk) {
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
    // Exactly one decision per SUPPLIED market (1-3, S3 dynamic cardinality). On
    // a full board the supplied set is all three, so this reduces to the
    // historical `!== 3` check; a scoped game requires exactly its own markets.
    const decisionGame = run.games.get(list[0]?.gameId ?? '');
    const supplied = decisionGame ? suppliedMarketsOf(decisionGame) : new Set<MarketKey>(MARKETS);
    const inScope = [...markets].every((m) => supplied.has(m));
    if (list.length !== supplied.size || markets.size !== supplied.size || !inScope) {
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
    // Annotated, not `as ArmSpec`: a blanket assertion silently accepted an
    // object missing whatever ArmSpec gained next, and the one thing actually
    // needing a cast is `provider`, which the record carries as a plain string.
    const armSpecForValidation: ArmSpec = {
      participantId: response.participantId,
      provider: response.provider as ArmSpec['provider'],
      requestedModelId: response.requestedModelId,
      credentialEnvVar: '',
      // Echo validation reads the response's own participant/model/bundle, and
      // no response carries a configuration, so none is needed to check one.
      configuration: {},
    };
    const revalidation = validateResponseText(
      response.accepted.rawResponse,
      requestBundle,
      game.requestSha256,
      armSpecForValidation,
      run.cohortId,
      acceptedVersions,
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
          acceptedVersions,
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
      // Response schema v2: the recorded decision must carry the SAME analysis
      // fields as the accepted forecast. v1-era forecasts have none, so the
      // check is conditional on the forecast (never on the pick, which a
      // tampered record controls).
      if (forecast.axes !== undefined) {
        const axesMatch =
          pick.axes !== null &&
          AXIS_NAMES.every((axis: AxisName) => forecast.axes?.[axis] === pick.axes?.[axis]);
        if (
          !axesMatch ||
          (forecast.primaryAxis ?? null) !== pick.primaryAxis ||
          (forecast.primaryExpectation ?? null) !== pick.primaryExpectation
        ) {
          violations.push(
            `${key} ${pick.market}: analysis fields (axes/primaryAxis/primaryExpectation) do not match the accepted provider response`,
          );
        }
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
    // Annotated, not `as ArmSpec`: a blanket assertion silently accepted an
    // object missing whatever ArmSpec gained next, and the one thing actually
    // needing a cast is `provider`, which the record carries as a plain string.
    const armSpecForValidation: ArmSpec = {
      participantId: response.participantId,
      provider: response.provider as ArmSpec['provider'],
      requestedModelId: response.requestedModelId,
      credentialEnvVar: '',
      // Echo validation reads the response's own participant/model/bundle, and
      // no response carries a configuration, so none is needed to check one.
      configuration: {},
    };
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
        acceptedVersions,
      );
      if (initialValidation.errors.length === 0) {
        violations.push(
          `${key}: recorded invalid_schema but the archived initial response validates — a valid response cannot be demoted`,
        );
        continue;
      }
      const repairRaw = response.repair?.rawResponse ?? null;
      // The claim "this repair should have been valid" holds only for a repair
      // whose transport settled ok AND whose archived provider state does not
      // show a NON-FINAL turn: an unfinished repair turn (the provider said
      // incomplete/paused) archives its body with turnCompleted: false, and
      // provider completion status is authoritative over body shape — a
      // validating body from a non-final turn is correctly refused. An absent
      // state (a legacy archive, or an unexplained demotion) keeps the claim.
      const repairTurnNonFinal =
        response.repair?.turnCompleted === false && (response.repair?.providerStopReason ?? null) !== null;
      const repairSettledOk = (response.repairTransport ?? 'ok') === 'ok';
      if (response.repairUsed && repairRaw !== null && repairSettledOk && !repairTurnNonFinal) {
        const repairValidation = validateResponseText(
          repairRaw,
          requestBundle,
          game.requestSha256,
          armSpecForValidation,
          run.cohortId,
          acceptedVersions,
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
      if (!response.repairUsed) {
        const initialFingerprint = extractDecisionFingerprint(initialRaw, requestBundle);
        // Mirror the runner's era-specific repair rules: no era repairs an
        // unfingerprintable initial, and the v2-era runner ALSO skips a
        // fingerprint that omits the decision-bearing analysis (a pre-axes
        // shape a repair may not invent — the fingerprints could never match).
        // A v1-era archive keeps the original rule: that era's runner repaired
        // any fingerprintable initial.
        const analysisAbsent =
          initialFingerprint !== null &&
          [...initialFingerprint.values()].some((fp) => fp.axes === null);
        if (initialFingerprint !== null && !(analysisAbsent && acceptedVersions.includes(2))) {
          violations.push(
            `${key}: invalid_schema without a repair, but the initial response has a complete fingerprint — the harness would have attempted a repair`,
          );
        }
      }
    } else if (
      response.outcome === 'timeout' ||
      response.outcome === 'rate_limited' ||
      response.outcome === 'credential_missing'
    ) {
      if (response.attempt.rawResponse !== null || (response.repair?.rawResponse ?? null) !== null) {
        violations.push(`${key}: transport outcome ${response.outcome} cannot carry a response body`);
      }
    } else if (response.outcome === 'provider_error') {
      // A provider_error initial MAY carry an archived body: an unfinished
      // turn (paused server-tool loop, refusal, output-cap stop, or any other
      // non-final provider state) is a RECEIVED response — HTTP 200 with
      // empty or partial content — whose evidence the runner records. What it
      // can never be is a VALIDATING body (a valid response cannot be demoted
      // to a provider failure), and no repair is ever dispatched after a
      // failed initial, so a repair body under this outcome is fabricated.
      if ((response.repair?.rawResponse ?? null) !== null) {
        violations.push(
          `${key}: provider_error cannot carry a repair body — no repair is dispatched after a failed initial`,
        );
      }
      const initialRaw = response.attempt.rawResponse;
      if (initialRaw !== null) {
        // Provider completion status is AUTHORITATIVE over body shape: a
        // provider can declare a turn non-final (root status "incomplete",
        // stop_reason "max_tokens", …) even when the extracted text happens to
        // form complete, schema-valid JSON, and the runner correctly refuses
        // that body. The archived structured state — turnCompleted: false with
        // the provider's own stop reason — is what proves the demotion is the
        // provider's verdict, not the operator's. Without that proof (an
        // absent state, or a turn recorded as finished), a validating body
        // under provider_error stays a violation.
        const turnRecordedNonFinal =
          response.attempt.turnCompleted === false && response.attempt.providerStopReason !== null;
        if (!turnRecordedNonFinal) {
          const initialValidation = validateResponseText(
            initialRaw,
            requestBundle,
            game.requestSha256,
            armSpecForValidation,
            run.cohortId,
            acceptedVersions,
          );
          if (initialValidation.errors.length === 0) {
            violations.push(
              `${key}: recorded provider_error but the archived initial response validates and the archived provider state does not show a non-final turn — a completed valid response cannot be demoted`,
            );
          }
        }
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
        const armSpecForTiming: ArmSpec = {
          participantId: response.participantId,
          provider: response.provider as ArmSpec['provider'],
          requestedModelId: response.requestedModelId,
          credentialEnvVar: '',
          configuration: {},
        };
        const initialValidation = validateResponseText(
          initialRaw,
          requestBundle,
          game.requestSha256,
          armSpecForTiming,
          run.cohortId,
          acceptedVersions,
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
      // From the EXPECTED roster, not the artifact: two arms of one model are
      // distinguished only by this, so taking it from the run being checked
      // would let the run vouch for its own distinctness.
      configurationSha256: configurationSha256(arm.configuration),
      reportedModelIds: [...(reportedByArm.get(arm.participantId) ?? new Set<string>())],
      unidentifiedResponses: unidentifiedByArm.get(arm.participantId) ?? 0,
    })),
  );
  for (const failure of recomputedIdentity.failures) {
    violations.push(`recomputed identity gate: ${failure}`);
  }

  // The run's ARM-ROSTER STAMP, verified rather than read.
  //
  // Three separate things, because a stamp is only evidence to the extent that
  // it can disagree with something:
  //   1. each entry's digest RECOMPUTES from the configuration beside it, so an
  //      artifact edited after the fact does not describe itself;
  //   2. the stamp matches the PRECOMMITTED roster, participant for participant
  //      and digest for digest — the run's own account of what it ran is not
  //      evidence about itself;
  //   3. every arm response's digest names the entry for its own participant,
  //      so a row cannot be attributed to a setting the arm did not compete at.
  //
  // Absent on an archive that predates the stamp, which is not a violation:
  // those runs were all-defaults by construction. What IS a violation is a
  // stamp that is present and wrong.
  if (run.armRoster !== null) {
    const stamped = new Map<string, ArmRosterEntry>();
    for (const entry of run.armRoster) {
      if (stamped.has(entry.participantId)) {
        violations.push(`arm roster stamps ${entry.participantId} more than once`);
        continue;
      }
      stamped.set(entry.participantId, entry);
      if (entry.configurationDigestVersion !== CONFIGURATION_DIGEST_VERSION) {
        violations.push(
          `arm roster ${entry.participantId}: configuration digest version ${entry.configurationDigestVersion} is not ${CONFIGURATION_DIGEST_VERSION}`,
        );
        // A digest under a rule this build does not implement cannot be
        // recomputed, so do not report a mismatch it could not avoid.
        continue;
      }
      const recomputed = configurationSha256(entry.configuration as ParticipantConfiguration);
      if (recomputed !== entry.configurationSha256) {
        violations.push(
          `arm roster ${entry.participantId}: stamped configuration digest ${entry.configurationSha256} does not recompute (${recomputed})`,
        );
      }
    }
    for (const arm of expectedArms) {
      const entry = stamped.get(arm.participantId);
      if (entry === undefined) {
        violations.push(`arm roster omits expected arm ${arm.participantId}`);
        continue;
      }
      const expectedDigest = configurationSha256(arm.configuration);
      if (entry.configurationSha256 !== expectedDigest) {
        violations.push(
          `arm roster ${arm.participantId}: ran configuration ${entry.configurationSha256}, precommitted ${expectedDigest}`,
        );
      }
      // The other two thirds of the entrant key. The serving table identifies a
      // participant by `(lab_id, model_id, configuration)`, and a stamp is what
      // says who a decision belongs to — so checking only the configuration
      // left the lab and the model write-only, free to disagree with every
      // response in the file and with the precommitment.
      if (entry.provider !== arm.provider) {
        violations.push(
          `arm roster ${arm.participantId}: stamped provider "${entry.provider}", precommitted "${arm.provider}"`,
        );
      }
      if (entry.requestedModelId !== arm.requestedModelId) {
        violations.push(
          `arm roster ${arm.participantId}: stamped requestedModelId "${entry.requestedModelId}", precommitted "${arm.requestedModelId}"`,
        );
      }
    }
    for (const participantId of stamped.keys()) {
      if (!expectedArms.some((arm) => arm.participantId === participantId)) {
        violations.push(`arm roster stamps ${participantId}, which is not an expected arm`);
      }
    }
    for (const response of run.armResponses) {
      const entry = stamped.get(response.participantId);
      if (entry === undefined) continue; // already reported above
      if (response.configurationSha256 === null) {
        violations.push(
          `${response.participantId}:${response.gameId}: the run stamps an arm roster but this response carries no configuration digest`,
        );
        continue;
      }
      if (response.configurationSha256 !== entry.configurationSha256) {
        violations.push(
          `${response.participantId}:${response.gameId}: response configuration ${response.configurationSha256} is not this arm's ${entry.configurationSha256}`,
        );
      }
    }
    // And the decisions themselves. This is the field a publisher keys a
    // participant row on, so it is the one place where getting it wrong
    // attributes a published pick to a competitor that did not make it.
    for (const pick of run.picks) {
      if (pick.kind !== 'model') continue;
      const entry = stamped.get(pick.participantId);
      if (entry === undefined) continue; // already reported above
      if (pick.configurationSha256 === null) {
        violations.push(
          `${pick.participantId}:${pick.gameId}:${pick.market}: the run stamps an arm roster but this decision carries no configuration digest`,
        );
        continue;
      }
      if (pick.configurationSha256 !== entry.configurationSha256) {
        violations.push(
          `${pick.participantId}:${pick.gameId}:${pick.market}: decision configuration ${pick.configurationSha256} is not this arm's ${entry.configurationSha256}`,
        );
      }
    }
  }

  // DECLARED configuration versus what each attempt recorded sending.
  //
  // This is the only check in the run that can catch an adapter which dropped
  // a knob. Without it a configuration is a label: an arm entered as
  // "high reasoning" that was called at the provider default would produce a
  // cheaper, worse answer and publish it under the setting it never used, and
  // every other gate would pass, because the model id, the family, the echo
  // and the digests are all identical between the two.
  //
  // The declared side comes from `expectedArms` — the precommitted roster —
  // for the same reason as the gate above. The bound is worth restating: this
  // proves what was SENT, not what the provider DID with it.
  const declaredByArm = new Map(expectedArms.map((arm) => [arm.participantId, arm.configuration]));
  for (const response of run.armResponses) {
    const declared = declaredByArm.get(response.participantId);
    // An arm not in the expected roster is already a violation above; do not
    // report it twice under a second heading.
    if (declared === undefined) continue;
    const legs = [
      ['attempt', response.attempt],
      ['repair', response.repair],
    ] as const;
    for (const [leg, attempt] of legs) {
      if (attempt === null) continue;
      if (attempt.requestParams === null) {
        // A leg that never reached the provider (timeout, transport failure,
        // no credential) records no parameters and is evidence of nothing
        // either way. One that DID reach it and records none has had its
        // evidence ERASED, and skipping it was an opt-out: deleting one field
        // from an accepted response removed every configuration guarantee from
        // the run while it still verified clean.
        //
        // Only enforced on a run that stamps a roster. An archive written
        // before the stamp existed cannot be held to a field nothing wrote,
        // and its arms were all-defaults by construction anyway.
        if (run.armRoster !== null && reachedProvider(attempt)) {
          violations.push(
            `${response.participantId}:${response.gameId}:${leg}: a response was received but no request parameters were recorded`,
          );
        }
        continue;
      }
      for (const violation of configurationEvidenceViolations(declared, attempt.requestParams)) {
        violations.push(`${response.participantId}:${response.gameId}:${leg}: ${violation}`);
      }
    }
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
    // A pick for a market the game does not supply (a scoped-artifact mismatch)
    // is a clean violation, never a crash on an absent price block. On a full
    // board every market is supplied, so this never fires.
    if (!suppliedMarketsOf(game).has(pick.market)) {
      violations.push(
        `${pick.participantId}:${pick.gameId}:${pick.market}: decision for a market the game does not supply`,
      );
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

/**
 * Narrow a fetched close row to the quote the metric consumes. The four
 * capture timestamps ride along: the CLV module gates on close TIMING as
 * well as price representation, and the row is the only place that evidence
 * exists. Dropping them here (as this function once did) is what made
 * timing unjudgeable downstream.
 */
export function closeQuoteFromRow(row: ClosingLineRow): CloseQuote {
  return {
    line: row.line,
    awayDecimal: row.away_odds_decimal,
    homeDecimal: row.home_odds_decimal,
    awayPNovig: row.away_p_novig,
    homePNovig: row.home_p_novig,
    confidence: row.confidence,
    lockTime: row.lock_time,
    valueCapturedAt: row.value_captured_at,
    lastPolledAt: row.last_polled_at,
    pollGapSeconds: row.poll_gap_seconds,
  };
}

/**
 * Signed drift between the close's own recorded lock and a reference
 * scheduled start, in milliseconds: NEGATIVE means the lock is EARLIER than
 * the reference (the schedule moved up between the reference being frozen
 * and the close being captured), POSITIVE means later.
 *
 * `null` when either instant is unparseable — "not determinable" is a
 * distinct answer from "no drift" and must never be collapsed into it.
 */
export function scheduleDriftMs(lockTime: string, referenceStartUtc: string): number | null {
  // STRICT parsing on both sides. `Date.parse` reads an ISO string carrying no
  // explicit offset as HOST-LOCAL time, so the identical pair of timestamps
  // produced a drift of 0 on a UTC host and 14400000 on a US-Eastern one, and
  // `isScheduleChanged` flipped false -> true with it. A verdict that depends
  // on the scoring machine's timezone is not a measurement. `instantMs`
  // rejects an offset-less instant outright, which lands here as `null` —
  // "not determinable", the answer both callers already refuse on.
  let lock: number;
  let reference: number;
  try {
    lock = instantMs(lockTime);
    reference = instantMs(referenceStartUtc);
  } catch {
    return null;
  }
  return lock - reference;
}

/**
 * Whether a drift is a SCHEDULE CHANGE at the given tolerance:
 * `abs(drift) >= toleranceMs`, inclusive at the boundary. `null` drift
 * propagates as `null` — an undeterminable comparison is never reported as
 * "unchanged".
 *
 * This is a stratum classifier, NOT a refusal: a tagged pick is still
 * scored, still recorded with both CLV variants, and still counted in every
 * coverage denominator. What it loses is membership in the primary
 * same-schedule estimate (see `inPrimaryStratum`).
 */
export function isScheduleChanged(
  driftMs: number | null,
  toleranceMs: number = SCHEDULE_CHANGE_TOLERANCE_MS,
): boolean | null {
  if (driftMs === null) return null;
  return Math.abs(driftMs) >= toleranceMs;
}

/**
 * Primary-estimate membership — the same-schedule stratum.
 *
 * Only an affirmative `scheduleChanged === true` is held out. An
 * undeterminable comparison (`null`) stays IN the primary estimate: it is
 * the status quo for every close whose reference start cannot be parsed,
 * and silently dropping those rows would be a coverage change disguised as
 * a timing check.
 */
export function inPrimaryStratum(pick: ScoredPick): boolean {
  if (pick.scheduleChanged === true) return false;
  // A pick carrying a SCORE whose schedule comparison is undeterminable is
  // held out too. `null` still means "no determinable comparison", and for a
  // pick with no close that is the honest status quo — it contributes no value
  // to the estimate either way, and counting it as tagged would misreport
  // coverage. But a pick that produced a CLV while its schedule verdict is
  // unknown would enter the same-schedule estimate on a comparison nobody
  // established: fail-closed parsing followed by fail-open aggregation.
  //
  // With `scheduledStartUtc` validated at parse and an unparseable `lock_time`
  // refused as `close_timing_unusable`, this state is unreachable — the guard
  // exists so that reachability is enforced rather than assumed.
  if (pick.scheduleChanged === null && pick.result.primaryClvPct !== null) return false;
  return true;
}

/**
 * How many picks the `scheduleChanged` tag actually REMOVED from the primary
 * estimate: tagged AND carrying a primary CLV value.
 *
 * The two conjuncts are both load-bearing. Counting every tagged pick would
 * include rows an earlier close-quality gate had already refused — rows with
 * nothing to withhold, already disclosed under that gate's reason — and the
 * coverage columns would then sum past the pick count while the published
 * claim "these were scored and only held out" would be false for them.
 */
export function heldOutOfPrimary(picks: readonly ScoredPick[]): number {
  return picks.filter((p) => !inPrimaryStratum(p) && p.result.primaryClvPct !== null).length;
}

/**
 * How many picks are PRIMARY-SCOREABLE: in the primary stratum AND carrying a
 * primary CLV value.
 *
 * ONE definition, deliberately. Both conjuncts are load-bearing and the pair
 * had been written out by hand at each site, which is how they drifted: the
 * scorer CLI counted only "carries a value" while `run_meta` and every
 * per-participant `scoreable N/M` line counted the conjunction, so two readouts
 * in the same output disagreed about what the word meant. Call this rather than
 * re-inlining the filter.
 *
 * Note `ParticipantStat.primaryScoreable` reaches the same number by a
 * different route (the length of the primary economic values, which are already
 * stratum-filtered when collected) — that is a per-participant slice, not a
 * second definition of the predicate.
 */
export function primaryScoreableCount(picks: readonly ScoredPick[]): number {
  return picks.filter((p) => inPrimaryStratum(p) && p.result.primaryClvPct !== null).length;
}

/**
 * EXHAUSTIVE partition of a zero-primary-scoreable run, by WHY each pick is not
 * in the estimate. `heldOut + unscored + unexplained === picks`, always.
 */
export interface EmptyPrimaryEstimate {
  picks: number;
  /** Scored, carries a CLV, but held out of the primary stratum by the schedule tag. */
  heldOut: number;
  /** Refused by a typed close-quality or selection gate; carries no CLV. */
  unscored: number;
  /** Per-reason counts behind `unscored`, so the note never generalises them. */
  unscoredByReason: Record<string, number>;
  /** In no stratum-or-refusal bucket: no value and no recorded reason. */
  unexplained: number;
}

/**
 * Partition the picks of a zero-primary-scoreable run by cause.
 *
 * Exhaustive by construction — every pick lands in exactly one bucket, which is
 * what lets the note report subsets instead of asserting a single run-level
 * cause.
 */
export function summariseEmptyPrimaryEstimate(
  picks: readonly ScoredPick[],
): EmptyPrimaryEstimate {
  const unscoredByReason: Record<string, number> = {};
  let heldOut = 0;
  let unscored = 0;
  let unexplained = 0;
  for (const pick of picks) {
    const tagged = !inPrimaryStratum(pick);
    if (tagged && pick.result.primaryClvPct !== null) {
      heldOut += 1;
    } else if (pick.result.unscoredReason !== null) {
      unscored += 1;
      unscoredByReason[pick.result.unscoredReason] =
        (unscoredByReason[pick.result.unscoredReason] ?? 0) + 1;
    } else {
      unexplained += 1;
    }
  }
  return { picks: picks.length, heldOut, unscored, unscoredByReason, unexplained };
}

/**
 * The operator note explaining a zero primary-scoreable count — or null when
 * there is nothing to explain.
 *
 * A pure function rather than an inline branch in the CLI so that "the note
 * does NOT fire" is testable too, which is the half a positive-only test would
 * miss. (The CLI's use of it is pinned separately, through `runScoreCli`.)
 *
 * ⚠ NEVER GIVE RUN-LEVEL ADVICE FOR A SUBSET CAUSE. A zero does not have one
 * cause, and it does not have two — the scorer carries NINE typed unscored
 * reasons (`CLOSE_QUALITY_REASONS` + `SELECTION_REASONS`) and a run can mix
 * them freely with schedule-tagged picks. An earlier version of this note said
 * "N pick(s) WERE scored … Re-running will not change this" whenever any pick
 * was held out, which is correct for those picks and WRONG for a `close_missing`
 * pick sitting beside them, where a later re-run may well fill the close.
 *
 * So the note reports the PARTITION and attaches each remedy to the subset it
 * actually applies to. Held-out picks are already fully scored and re-running
 * changes nothing for them; refusals are per-pick and want their reason
 * inspected; the two must never be collapsed into one instruction.
 */
export function emptyPrimaryEstimateNote(picks: readonly ScoredPick[]): string | null {
  if (primaryScoreableCount(picks) > 0) return null;
  const s = summariseEmptyPrimaryEstimate(picks);
  const lines = [`note: nothing was primary-scoreable (0 of ${String(s.picks)} pick(s)).`];

  if (s.heldOut > 0) {
    lines.push(
      `  · ${String(s.heldOut)} scored but HELD OUT of the primary same-schedule estimate — ` +
        'their start times moved beyond the tolerance. Re-running will NOT change those; their ' +
        "CLV is in the scored NDJSON and in the scorecard's reschedule-sensitivity stratum.",
    );
  }
  if (s.unscored > 0) {
    const byReason = Object.entries(s.unscoredByReason)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([reason, n]) => `${reason} ${String(n)}`)
      .join(', ');
    lines.push(
      `  · ${String(s.unscored)} not scored at all: ${byReason}. These are PER-PICK refusals — ` +
        'inspect each reason separately. If the slate has not locked yet the closes do not exist ' +
        'and a re-run after it locks may fill them.',
    );
  }
  if (s.unexplained > 0) {
    lines.push(
      `  · ${String(s.unexplained)} produced no primary value and recorded no refusal reason.`,
    );
  }
  return lines.join('\n');
}

/**
 * Index captured closes by `(game, market)` for the scorer's join.
 *
 * A duplicate key now REFUSES. `new Map(rows.map(...))` silently kept the LAST
 * row seen, so two rows sharing a game and market — differing only by network
 * or by feed — collapsed into one and the scorer priced against whichever
 * happened to arrive last, with nothing published to say a choice was made.
 *
 * The key deliberately does not carry network or source: the lookup site has a
 * pick, not a row, and cannot supply them. The identity is constrained one
 * level up instead — `fetchClosingLines` filters network and source
 * server-side and asserts the rows that come back honour both — so within one
 * scoring run every row already shares an identity and a collision here means
 * a genuine duplicate. Refusing is what makes that an upstream invariant
 * whose violation is observable rather than one silently relied upon.
 */
export function closesByKey(rows: ClosingLineRow[]): Map<string, ClosingLineRow> {
  const map = new Map<string, ClosingLineRow>();
  for (const row of rows) {
    const key = `${row.jsonodds_id}:${row.market}`;
    if (map.has(key)) {
      const kept = map.get(key);
      throw new Error(
        `duplicate closing line for ${key}: rows from ` +
          `${kept?.network ?? '?'}/${kept?.source ?? '?'} and ${row.network}/${row.source} — ` +
          'refusing to score against an ambiguous close',
      );
    }
    map.set(key, row);
  }
  return map;
}

export interface ScoredPick extends SourcePick {
  side: SelectedSide;
  /** The opposite side's frozen bundle price — the margin-adjusted entry de-vig input. */
  entryOppositeDecimal: number;
  result: ClvResult;
  /** TOTALS_V1 ladder block — non-null on every totals pick, null elsewhere. */
  ladder: TotalsLadderResult | null;
  close: ClosingLineRow | null;
  /**
   * Signed `close.lock_time - game.startUtc` in ms; null when there is no
   * close or either instant is unparseable. Recorded whether or not it
   * crosses the tolerance — the magnitude and direction are the evidence.
   */
  scheduleDriftMs: number | null;
  /**
   * Schedule-change stratum tag (`abs(drift) >= SCHEDULE_CHANGE_TOLERANCE_MS`).
   * `null` = not determinable. A `true` pick is scored and recorded in full
   * but held out of the primary same-schedule estimate.
   */
  scheduleChanged: boolean | null;
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
    // Schedule drift is measured against the FROZEN bundle start the model
    // actually saw, not against any later reading — the question is whether
    // the schedule moved between the decision and the close capture.
    const drift = close === null ? null : scheduleDriftMs(close.lock_time, game.startUtc);
    // An undeterminable drift on a pick that still SCORED would enter the
    // same-schedule estimate on a comparison nothing established. Two inputs
    // can make it undeterminable and both are already closed: the reference
    // (`game.startUtc`) is validated as an offset-qualified instant at parse,
    // and an unparseable `close.lock_time` is refused per-pick as
    // `close_timing_unusable` — which is the graceful path, so it must NOT be
    // escalated to a whole-run rejection here. What remains is the impossible
    // combination, and it is asserted rather than assumed away.
    if (drift === null && close !== null && exactLine.primaryClvPct !== null) {
      throw new Error(
        `pick ${pick.gameId}:${pick.market} scored with an undeterminable schedule comparison ` +
          `(lock_time "${close.lock_time}" vs bundle start "${game.startUtc}") — refusing the run`,
      );
    }
    return {
      ...pick,
      side,
      entryOppositeDecimal,
      result: exactLine,
      ladder,
      close,
      scheduleDriftMs: drift,
      scheduleChanged: close === null ? null : isScheduleChanged(drift),
    };
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
  /** Picks in this market carrying the `scheduleChanged` tag, scoreable or not. */
  scheduleChangedTagged: number;
  /**
   * The TAGGED picks in this market that carried a primary CLV value — i.e.
   * the ones whose sample membership the tag actually withheld. They remain
   * in `picks` and `eligible`; this is the line item that explains the gap
   * to `scoreable`.
   *
   * A tagged pick that some earlier gate had ALREADY refused is deliberately
   * NOT counted here: it contributed nothing to withhold, and it is already
   * disclosed under that gate's reason in `unscoredByReason`. Counting it in
   * both places would make the coverage columns sum past `picks`.
   */
  scheduleChangedExcluded: number;
}

export interface ParticipantStats {
  participantId: string;
  kind: 'model' | 'baseline';
  /** Games this arm was dispatched (models) or picked in (baselines). */
  games: number;
  /** Market-decision opportunities: models sum the supplied-market count over
   * dispatched games (3 each on a full board); baselines 1 per pick. */
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
  /** Picks carrying the `scheduleChanged` tag, scoreable or not — the raw stratum size. */
  scheduleChangedTagged: number;
  /**
   * The TAGGED picks that carried a primary CLV value — CLV computed and
   * recorded, sample membership withheld. They stay in `validDecisions` /
   * `eligibleMarkets`, so this count (not a silent shrink) is what explains
   * a `primaryScoreable` below the number of otherwise-scoreable picks.
   *
   * A tagged pick that some earlier gate had ALREADY refused is deliberately
   * NOT counted here — it had no value to withhold and is disclosed under
   * that gate's reason instead. `scheduleChangedTagged` above is the count
   * that includes it.
   */
  scheduleChangedExcluded: number;
  /**
   * The reschedule-sensitivity stratum (SPEC-line-open-evidence-model.md §7:
   * "compute CLV but tag the row, exclude it from the primary same-schedule
   * estimate, and show it only in a separate reschedule-sensitivity
   * stratum"). These are the SAME aggregates as the primary ones, computed
   * over the COMPLEMENT set — the tagged picks — so what the tag withheld is
   * published rather than merely counted. Never pooled with primary.
   */
  scheduleChangedStratum: {
    picks: number;
    scoreable: number;
    gamesScoreable: number;
    gameLevel: ClvSummary;
    perPick: ClvSummary;
    gameLevelMarginAdjusted: ClvSummary;
    perPickMarginAdjusted: ClvSummary;
  };
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
    /**
     * Totals picks whose LADDER value the `scheduleChanged` tag withheld
     * from `ladderScoreable`. Without it the ladder table would show a
     * scoreable count below `totalsPicks` with no reason given: a tagged
     * pick carries no `ladder.unscoredReason`, so it appears in neither the
     * scored count nor the refusal histogram.
     */
    scheduleChangedExcluded: number;
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
 * Every metric (economic, margin-adjusted, shin variants, ladder, per-market)
 * aggregates through this one path so the clustering can never diverge
 * between metrics.
 *
 * `member` is the stratum this aggregate is computed over, defaulting to the
 * primary same-schedule stratum — so a `scheduleChanged` pick contributes no
 * VALUE to any aggregate computed with the default. It keeps its place in
 * every denominator, because those are counted from the raw pick lists
 * outside this function: a reschedule must shrink the estimate's sample,
 * never hide the pick.
 *
 * This is the enforcement point for every aggregate computed THROUGH it, and
 * it is not the only one in the file: the paired de-vig sensitivity SETS and
 * the ladder's mean-signed-movement average filter the stratum at their own
 * call sites, because their disclosed counts have to describe exactly the
 * rows their numbers came from. Each of those sites has its own test — grep
 * `inPrimaryStratum` before assuming a new aggregate inherits the filter.
 * The one caller that passes the COMPLEMENT is the reschedule-sensitivity
 * stratum readout, which exists to publish what the tag withheld.
 */
function clusterByGame(
  picks: ScoredPick[],
  value: (pick: ScoredPick) => number | null,
  member: (pick: ScoredPick) => boolean = inPrimaryStratum,
): { values: number[]; gameMeans: number[] } {
  const values: number[] = [];
  const byGame = new Map<string, number[]>();
  for (const pick of picks) {
    if (!member(pick)) continue;
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

  // Supplied-market set per game (1-3, S3 dynamic cardinality), reused for the
  // per-scope model denominators. On a full board every set is {ml, spread,
  // total}, so the denominators below equal the historical responses.length[*3].
  const suppliedByGameId = new Map<string, Set<MarketKey>>(
    [...run.games].map(([gameId, game]) => [gameId, suppliedMarketsOf(game)]),
  );

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

    // The reschedule-sensitivity stratum (SPEC §7): the SAME aggregates over
    // the COMPLEMENT set. Computing them is the difference between "held out"
    // and "held out and shown" — the tag withholds sample membership, not
    // publication.
    const taggedPicks = picks.filter((p) => !inPrimaryStratum(p));
    const taggedEconomic = clusterByGame(
      taggedPicks,
      (p) => p.result.primaryClvPct,
      () => true,
    );
    const taggedMarginAdjusted = clusterByGame(
      taggedPicks,
      (p) => p.result.marginAdjustedClvPct,
      () => true,
    );

    // The sensitivity comparison is PAIRED: restrict to picks where the
    // shin value exists, then aggregate BOTH methods over exactly that
    // subset — a delta can only ever reflect the method, never coverage.
    // The stratum filter is applied to the paired SETS as well, not only
    // inside clusterByGame, so the disclosed paired-pick counts describe
    // exactly the rows the paired summaries were computed from.
    const pairedEconomic = picks.filter(
      (p) => inPrimaryStratum(p) && p.result.sensitivity?.economicClvPct != null,
    );
    const pairedMarginAdjusted = picks.filter(
      (p) => inPrimaryStratum(p) && p.result.sensitivity?.marginAdjustedClvPct != null,
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

    // Per-market aggregates use the same game-first clustering as the pooled
    // primary, scoped to one market — never pooled across markets. A model arm is
    // eligible in a market for the dispatched games that SUPPLY it (every
    // dispatched game on a full board), so it keeps a (possibly 0/N) entry even
    // when it produced no decisions; a market no dispatched game supplies is
    // omitted (eligible 0, no picks).
    const byMarket: ParticipantStats['byMarket'] = {};
    for (const market of MARKETS) {
      const marketPicks = picks.filter((p) => p.market === market);
      // A model arm is eligible in this market only for the dispatched games that
      // SUPPLY it (all of them on a full board, so this stays responses.length).
      const eligible =
        kind === 'model'
          ? responses.filter((r) => suppliedByGameId.get(r.gameId)?.has(market) ?? false).length
          : marketPicks.length;
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
        scheduleChangedTagged: marketPicks.filter((p) => !inPrimaryStratum(p)).length,
        scheduleChangedExcluded: heldOutOfPrimary(marketPicks),
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
        // Mean signed movement is documented as an average over the
        // LADDER-SCORED picks, and ladderScoreable comes from clusterByGame
        // — so a rescheduled pick must leave this average too, or the two
        // numbers would describe different sets.
      } else if (
        inPrimaryStratum(pick) &&
        pick.line !== null &&
        pick.close !== null &&
        pick.close.line !== null
      ) {
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
    // Scope-aware, mirroring byMarket['total']: a model arm is totals-eligible
    // only for the dispatched games that supply a total (all of them on a full
    // board, so this stays responses.length) — a total-less board emits no ladder.
    const totalsEligible =
      kind === 'model'
        ? responses.filter((r) => suppliedByGameId.get(r.gameId)?.has('total') ?? false).length
        : totalsPicks.length;
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
            scheduleChangedExcluded: totalsPicks.filter(
              (p) => !inPrimaryStratum(p) && p.ladder?.economicClvPct != null,
            ).length,
          };

    stats.push({
      participantId,
      kind,
      games: kind === 'model' ? responses.length : new Set(picks.map((p) => p.gameId)).size,
      // Per-scope: sum the supplied-market count over the arm's dispatched games
      // (3 each on a full board, so this equals the historical responses.length * 3).
      eligibleMarkets:
        kind === 'model'
          ? responses.reduce((sum, r) => sum + (suppliedByGameId.get(r.gameId)?.size ?? 0), 0)
          : picks.length,
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
      scheduleChangedTagged: taggedPicks.length,
      scheduleChangedExcluded: heldOutOfPrimary(picks),
      scheduleChangedStratum: {
        picks: taggedPicks.length,
        scoreable: taggedEconomic.values.length,
        gamesScoreable: taggedEconomic.gameMeans.length,
        gameLevel: summary(taggedEconomic.gameMeans),
        perPick: summary(taggedEconomic.values),
        gameLevelMarginAdjusted: summary(taggedMarginAdjusted.gameMeans),
        perPickMarginAdjusted: summary(taggedMarginAdjusted.values),
      },
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
    // The RUN's own label, never the constant: the label is the read-path
    // eligibility handle the serving projection carries on every row, so a
    // scored record claiming a label its source run does not have would
    // misfile the whole pass the day the operator mints a non-smoke label.
    // Today every run file carries SMOKE_LABEL, which is why hardcoding it
    // here survived — a latent misbinding, caught in review.
    label: run.label,
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
      // Every close-quality reason the scorer can emit is named somewhere in
      // this block — a reader should never meet a refusal code in the records
      // that the preregistered policy did not declare. A test asserts it.
      availabilityRequired:
        'a pick with no captured close row is unscored (close_missing); a row carrying no usable stored no-vig probability is unscored (close_not_captured). Both refuse BOTH metrics together and are shared with the totals ladder',
      freshnessRequired:
        'only a `fresh`-confidence close feeds the metrics; a stale one is unscored (close_stale). A close whose stored no-vig probabilities disagree with its raw two-sided quotes is refused outright (close_inconsistent), before side selection, for every participant and side alike',
      integerLinePrimary:
        'unavailable (push-excluded conditional CLV separately labeled, both metrics); the TOTALS_V1 candidate ladder reports the generalized push-aware value as separately labeled sensitivity output, pending validation',
      timingEvidenceRequired:
        'refused (close_timing_unusable): every timing verdict below is derived from the row’s own instants, parsed strictly — a timestamp carrying no explicit UTC offset is REJECTED rather than read as host-local time. A row whose stored poll_gap_seconds contradicts its own lock_time and last_polled_at by more than the second-granularity tolerance, whose instants cannot be parsed, or which claims fresh confidence while missing any of value_captured_at / last_polled_at / poll_gap_seconds, establishes nothing and is refused as a named, counted close-quality reason rather than being scored on a verdict nothing supports. Shared with the totals ladder',
      closeAfterStart:
        'refused (close_after_start): a close whose market the feed was still quoting at least 1000ms AFTER the row’s own recorded lock (the tolerance absorbs the integer-second granularity of the stored gap and nothing more) has an unestablished pre-game status and is not evidence for any metric, on either side, for any participant. Derived from last_polled_at vs lock_time — NOT from the stored gap, which is a derived value a corrupt row can contradict. Shared with the totals ladder. This is a CONSERVATIVE refusal on ambiguous evidence, not a proof of contamination: at least three readings fit a post-lock poll (the recorded start was early and the value is a genuine pre-game price; the feed quotes in-play; or the feed had simply not yet dropped the finished/started game from its live snapshot), and the row alone cannot separate them',
      closeValueAfterLock:
        'refused (close_value_after_lock): the quoted VALUE was recorded past the row’s own cutoff. STRICT, with NO tolerance — value_captured_at is a direct timestamp, not an integer-second derived value, so exactly at the lock passes and one millisecond past it refuses. Distinct from close_after_start, which asks whether the feed was still LISTING the market. Measured at 0 of 3609 rows on the captured corpus, so this gate is expected to be inert — it exists so the claim stays measured rather than assumed',
      scheduleChangeToleranceMs: SCHEDULE_CHANGE_TOLERANCE_MS,
      scheduleChanged:
        'STRATUM TAG, not a refusal: abs(close lock_time − frozen bundle scheduledStartUtc) >= scheduleChangeToleranceMs. CLV is computed and recorded in full, and the pick stays in every coverage denominator, but it is held out of the primary same-schedule estimate, republished as its own reschedule-sensitivity stratum, and counted as scheduleChangedTagged (every tagged pick) and scheduleChangedExcluded (the tagged picks that carried a value, i.e. what the tag actually removed from the estimate)',
      startTimeLimitation:
        'The recorded lock is the scheduled start as known at capture — a PREDICTION of first pitch, never ground truth. These gates do NOT detect a start that moved EARLIER without the upstream capture noticing: in that case the lock, the schedule row it was copied from, and the frozen bundle start are the SAME wrong instant, and no comparison available to this scorer can separate them. Detecting that needs an independent start-time source (the on-chain contest start served by the public API, or a league schedule feed)',
    },
    picks: scored.length,
    // Beside `picks`, the OTHER record count this file carries. Together they
    // are what lets a reader hold the artifact to its own declared contents:
    // every published score row binds this file whole via source_sha256, so a
    // trailing truncation has to be detectable from the file alone — the same
    // count-vs-records cross-check the run artifact's canonical reader does.
    participantScorecards: stats.length,
    // Stratum-aware, to agree with the per-participant aggregates: a
    // rescheduled pick is not a member of the primary estimate even though
    // its CLV is present on its own record.
    primaryScoreable: primaryScoreableCount(scored),
    marginAdjustedScoreable: scored.filter(
      (p) => inPrimaryStratum(p) && p.result.marginAdjustedClvPct !== null,
    ).length,
    totalsLadderScoreable: scored.filter((p) => inPrimaryStratum(p) && p.ladder?.economicClvPct != null)
      .length,
    // Two different questions, both published: how many rows the tag TOUCHED,
    // and how many it actually removed from the estimate. They differ exactly
    // by the tagged rows some earlier gate had already refused.
    scheduleChangedTagged: scored.filter((p) => !inPrimaryStratum(p)).length,
    scheduleChangedExcluded: heldOutOfPrimary(scored),
    scheduleUndetermined: scored.filter((p) => p.scheduleChanged === null).length,
    closeAfterStartRefused: scored.filter((p) => p.result.unscoredReason === 'close_after_start')
      .length,
    armGameResponses: run.armResponses.length,
  });
  for (const pick of scored) {
    const game = run.games.get(pick.gameId);
    records.push({
      recordType: 'scored_decision',
      label: run.label,
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
              lastPolledAt: pick.close.last_polled_at,
              pollGapSeconds: pick.close.poll_gap_seconds,
            },
      /** Frozen bundle start this pick's drift was measured against. */
      scheduledStartUtc: game?.startUtc ?? null,
      scheduleDriftMs: pick.scheduleDriftMs,
      scheduleChanged: pick.scheduleChanged,
      inPrimaryStratum: inPrimaryStratum(pick),
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
      label: run.label,
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
