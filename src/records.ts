import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEPLOYMENT_ROUND, NETWORK, redactSecrets } from './config.js';
import { resolveBenchmarkCommit } from './benchmarkCommit.js';
import { CURRENT_RESPONSE_SCHEMA_VERSION } from './schema.js';
import { FUTURE_QUOTE_SKEW_MS, MAX_QUOTE_AGE_MS } from './bundle.js';
import { runBaselines } from './baselines.js';
import { PROMPT_SCAFFOLD_VERSION, promptScaffoldSha256 } from './prompt.js';
import { authenticateRun } from './runner.js';
import { EVIDENCE_ERA } from './providers/responseEnvelope.js';
import { SMOKE_LABEL } from './types.js';
import type { BuildResult } from './bundle.js';
import type { RunEnvelope } from './runner.js';
import {
  CONFIGURATION_DIGEST_VERSION,
  configurationSha256,
} from './participantConfiguration.js';
import type { CollisionCheckResult } from './providers/family.js';
import type { ArmGameResult, ArmSpec, AttemptRecord } from './types.js';

/**
 * Watch-mode gate provenance, recorded in run_meta so the entry-timing claim
 * is verifiable from the artifact itself (the scorer fail-closes on it for
 * watch runs): when detection happened, when the full board had completed,
 * the resulting opener age, and the configured late threshold it passed.
 */
export interface WatchProvenance {
  detectedAt: string;
  boardCompletedAt: string;
  openerAgeMinutes: number;
  lateThresholdMinutes: number;
}

export interface RunContext {
  runId: string;
  cohortId: string;
  mode: 'dry-run' | 'live';
  slateDate: string;
  createdAt: string;
  executionPolicy: 'fixed-moneyline-total';
  timeoutMs: number;
  maxOutputTokens: number;
  fetchStartedAt: string;
  fetchCompletedAt: string;
  /**
   * 'wall' in live mode; 'synthetic-fixture' in dry runs, where ONE injected
   * clock anchored at the fixture capture instant drives both cutoff
   * enforcement and every recorded timestamp, keeping artifacts temporally
   * consistent.
   */
  clockMode: 'wall' | 'synthetic-fixture';
  /** Present on watch-mode runs only. */
  watch?: WatchProvenance | undefined;
}

type JsonRecord = Record<string, unknown>;

function attemptFields(attempt: AttemptRecord | null): JsonRecord {
  return {
    requestAt: attempt?.requestAt ?? null,
    responseAt: attempt?.responseAt ?? null,
    // The truthful ACCEPTED instant, distinct from responseAt — which is also
    // stamped on a timeout or a transport failure and so is not a receipt on
    // its own. This is the one instant meaning "the forecast became a
    // commitment", and the serving projection seals on it; without it in the
    // artifact, a run republished from disk would have to substitute a
    // plausible timestamp for a real one.
    acceptedAt: attempt?.acceptedAt ?? null,
    latencyMs: attempt?.latencyMs ?? null,
    httpStatus: attempt?.httpStatus ?? null,
    reportedModelId: attempt?.reportedModelId ?? null,
    tokens: attempt?.usage ?? null,
    usageRaw: attempt?.usageRaw ?? null,
    searchAudit: attempt?.searchAudit ?? null,
    providerResponseId: attempt?.providerResponseId ?? null,
    requestParams: attempt?.requestParams ?? null,
    // The EXTRACTED answer text — the model's own words, and nothing else.
    //
    // Named `answerText` rather than the historical `rawResponse`, which said
    // "raw" while carrying the adapter's extraction: the whole provider body
    // was thrown away at the adapter, so a search audit that came back empty
    // could never be re-read (#92). With an envelope beside it, one field
    // called "raw response" and another called "response envelope" describing
    // different things is the confusion that produced the defect. Readers of
    // archived files (the scorer, the serving projection) accept either name.
    answerText: attempt?.rawText ?? null,
    // The COMPLETE provider response body this answer was extracted from, with
    // its own digest. Private evidence: it lives in the run file under `out/`
    // and no serving column carries it.
    responseEnvelope: attempt?.responseEnvelope ?? null,
    errorDetail: attempt?.errorDetail ?? null,
    // The structured provider completion state (never prose): the non-final
    // terminal string for an unfinished turn, and whether the provider
    // declared the turn finished. Verification reads THESE, not errorDetail.
    providerStopReason: attempt?.providerStopReason ?? null,
    turnCompleted: attempt?.turnCompleted ?? null,
  };
}

/**
 * The attempt whose content was accepted for a valid result (the repair when
 * a repair was used). Decision provenance — model ID, usage, response ID,
 * timestamps — must come from THIS attempt.
 */
export function acceptedAttempt(result: ArmGameResult): AttemptRecord {
  return result.repairUsed && result.repair !== null ? result.repair : result.attempt;
}

/** Informational reported ID for an arm-game, from whichever attempt reported one. */
export function reportedModelId(result: ArmGameResult): string | null {
  return result.attempt.reportedModelId ?? result.repair?.reportedModelId ?? null;
}

/** Distinct non-null reported model IDs per arm across all its games. */
export function reportedModelIdsByArm(results: readonly ArmGameResult[]): Map<string, string[]> {
  const byArm = new Map<string, Set<string>>();
  for (const result of results) {
    const set = byArm.get(result.arm.participantId) ?? new Set<string>();
    for (const id of [result.attempt.reportedModelId, result.repair?.reportedModelId ?? null]) {
      if (id !== null) set.add(id);
    }
    byArm.set(result.arm.participantId, set);
  }
  return new Map([...byArm].map(([participantId, set]) => [participantId, [...set]]));
}

/**
 * Per arm: how many SUCCESSFUL responses (a body came back) carried no
 * reported model ID. Feeds the fail-closed identity check — transport
 * failures with no response body are exempt.
 */
export function unidentifiedResponsesByArm(results: readonly ArmGameResult[]): Map<string, number> {
  const byArm = new Map<string, number>();
  for (const result of results) {
    let count = byArm.get(result.arm.participantId) ?? 0;
    if (result.attempt.rawText !== null && result.attempt.reportedModelId === null) count += 1;
    if (
      result.repair !== null &&
      result.repair.rawText !== null &&
      result.repair.reportedModelId === null
    ) {
      count += 1;
    }
    byArm.set(result.arm.participantId, count);
  }
  return byArm;
}

/** Group identity/collision failure strings by their machine code prefix. */
export function failuresByCode(failures: string[]): Map<string, string[]> {
  const byCode = new Map<string, string[]>();
  for (const failure of failures) {
    const code = failure.startsWith('MODEL_IDENTITY') ? 'MODEL_IDENTITY' : 'PROVIDER_COLLISION';
    const list = byCode.get(code) ?? [];
    list.push(failure);
    byCode.set(code, list);
  }
  return byCode;
}

export function buildRecords(
  env: RunEnvelope,
  ctx: RunContext,
  build: BuildResult,
  collision: CollisionCheckResult,
): JsonRecord[] {
  // A5: authenticate the branded run envelope (this subsumes assertSealed — the
  // envelope brand transitively guarantees the nested sealed snapshot) and
  // reconcile the five load-bearing context fields against it (A4) before
  // emitting anything. A context that disagrees on any of the five has already
  // failed closed; `bound` carries the authoritative values the records stamp.
  const bound = authenticateRun(env, ctx);
  const { snapshot, results } = env;
  const { prepared, slate, slateSha256 } = snapshot;
  const { excluded, provenance } = build;

  // Baselines are DERIVED from the sealed snapshot under the run's authenticated
  // baseline policy version, never accepted as a swappable array — so a missing/
  // foreign/duplicate baseline row cannot be smuggled in. The version comes from
  // the branded envelope (default v0.2, full-board); a dynamic cohort's v0.3
  // derives the present-market subset instead of failing closed on a scoped slate.
  const baselineDecisions = runBaselines(slate, env.baselinePolicyVersion);

  const requestShaByGame = new Map(prepared.map((r) => [r.gameId, r.requestSha256]));
  const cutoffByGame = new Map(prepared.map((r) => [r.gameId, r.cutoffAt]));
  const gameShaByGame = new Map(prepared.map((r) => [r.gameId, r.gameSha256]));

  // `results` is the authenticated, complete-by-construction arm × game grid
  // (A3): it lives INSIDE the branded, deep-frozen envelope — runSlate already
  // rejected a foreign arm, a duplicate (arm, game), and a missing cell before
  // sealing — so the producer trusts it rather than re-deriving completeness
  // from a caller-supplied array. Every per-game record still derives from the
  // frozen, hash-verified snapshot, so the recorded game, its hash, and its
  // cutoff are provably the bytes the provider saw, and so are the baselines,
  // the slate metadata, and the summary.
  const records: JsonRecord[] = [];

  // First result per arm; every dispatched arm has one, because the grid is
  // complete by construction (A3).
  const armById = new Map<string, ArmSpec>();
  for (const result of results) {
    if (!armById.has(result.arm.participantId)) armById.set(result.arm.participantId, result.arm);
  }

  records.push({
    recordType: 'run_meta',
    label: SMOKE_LABEL,
    runId: ctx.runId,
    cohortId: bound.cohortId,
    mode: ctx.mode,
    slateDate: bound.slateDate,
    createdAt: ctx.createdAt,
    executionPolicy: bound.executionPolicy,
    dispatch: 'per-game-by-cutoff',
    slateSha256,
    fetchStartedAt: ctx.fetchStartedAt,
    fetchCompletedAt: ctx.fetchCompletedAt,
    bundleTimestamp: slate.bundleTimestamp,
    slateCutoffAt: slate.cutoffAt,
    promptScaffoldVersion: PROMPT_SCAFFOLD_VERSION,
    promptScaffoldSha256: promptScaffoldSha256(),
    // The EVIDENCE ERA this run was produced under. It says one thing: this
    // build retains a complete provider response envelope on every attempt
    // that reached a provider, so the scorer may REQUIRE one and fail closed
    // when it is missing. A file without the stamp predates retention; its
    // attempts are envelope-unavailable, and the scorer says so rather than
    // reading absent evidence as "no search ran".
    evidenceEra: EVIDENCE_ERA,
    // Facts the SERVING PROJECTION freezes on its run row and then compares
    // against on every later write for that run. They are stamped here, into
    // the artifact, rather than read from constants when publishing, because
    // republishing a run from its file is the recovery path for a projection
    // write that was lost — and a value re-derived at that moment (a newer
    // commit, a bumped round) would disagree with the stored row and drop the
    // whole write instead of completing it. Reading them back out of the file
    // makes the recovery byte-identical to the original by construction.
    projection: {
      network: NETWORK,
      deploymentRound: DEPLOYMENT_ROUND,
      responseSchemaVersion: CURRENT_RESPONSE_SCHEMA_VERSION,
      benchmarkCommit: resolveBenchmarkCommit(),
    },
    timeoutMs: bound.timeoutMs,
    maxOutputTokens: bound.maxOutputTokens,
    clockMode: ctx.clockMode,
    quoteFreshnessPolicy: {
      maxQuoteAgeMs: MAX_QUOTE_AGE_MS,
      futureQuoteSkewMs: FUTURE_QUOTE_SKEW_MS,
    },
    // The ARM ROSTER STAMP: who competed, and under what.
    //
    // Stamped once per run rather than repeated on every arm x game row,
    // because a configuration is a property of the entrant and not of the
    // response. Each row carries only the digest, which is what binds it back
    // to this list.
    //
    // Stamped INTO the artifact rather than re-derived when the artifact is
    // read, for the same reason the projection stamp exists: republishing a
    // run from its file is the recovery path, and a roster re-read from the
    // code at that moment — a newer commit, an enrolled arm — would describe a
    // run that never happened. The file is the record of what ran.
    //
    // The order is the ENVELOPE's dispatched roster, which `runSlate` already
    // proved unique and complete before sealing.
    armRoster: env.expectedArms.map((participantId) => {
      const arm = armById.get(participantId);
      if (arm === undefined) {
        // Unreachable through the envelope (the arm x game grid is complete by
        // construction), and a throw rather than a skip because a roster
        // missing an arm would publish a cohort smaller than the one that ran.
        throw new Error(`dispatched arm "${participantId}" produced no results`);
      }
      return {
        participantId: arm.participantId,
        provider: arm.provider,
        requestedModelId: arm.requestedModelId,
        configuration: arm.configuration,
        configurationSha256: configurationSha256(arm.configuration),
        configurationDigestVersion: CONFIGURATION_DIGEST_VERSION,
      };
    }),
    eligibleGames: slate.games.length,
    excludedGames: excluded.length,
    armGameResults: results.length,
    baselineDecisionCount: baselineDecisions.length,
    // Redundant top-level stamp of the (single) baseline policy version,
    // mirroring baselineDecisionCount: the scorer cross-checks it against
    // the per-decision stamps, so a version-downgrade edit must now also
    // rewrite run_meta coherently. Derived from the decisions themselves so
    // it can never disagree with what was actually derived.
    ...(new Set(baselineDecisions.map((d) => d.policyVersion)).size === 1
      ? { baselinePolicyVersion: baselineDecisions[0]?.policyVersion }
      : {}),
    ...(ctx.watch !== undefined ? { watch: ctx.watch } : {}),
  });

  for (const request of prepared) {
    // `bundle` is the frozen prepared game itself. Its serialized byte layout
    // follows the prepared-request schema's key order, whereas `gameSha256` is
    // order-independent (canonicalize sorts keys) — so a future field reorder
    // would change these recorded bytes but never the hash, the joins, or scoring.
    records.push({
      recordType: 'bundle_game',
      label: SMOKE_LABEL,
      runId: ctx.runId,
      gameId: request.gameId,
      gameSha256: request.gameSha256,
      requestSha256: request.requestSha256,
      cutoffAt: request.cutoffAt,
      slug: request.slug,
      bundle: request.game,
      sourceOddsRows: provenance[request.gameId]?.oddsRows ?? [],
    });
  }

  for (const exclusion of excluded) {
    records.push({
      recordType: 'excluded_game',
      label: SMOKE_LABEL,
      runId: ctx.runId,
      ...exclusion,
    });
  }

  for (const decision of baselineDecisions) {
    records.push({
      recordType: 'baseline_decision',
      label: SMOKE_LABEL,
      runId: ctx.runId,
      cohortId: bound.cohortId,
      slateSha256,
      gameSha256: gameShaByGame.get(decision.gameId) ?? null,
      requestSha256: requestShaByGame.get(decision.gameId) ?? null,
      cutoffAt: cutoffByGame.get(decision.gameId) ?? null,
      ...decision,
    });
  }

  for (const result of results) {
    records.push({
      recordType: 'arm_game_response',
      label: SMOKE_LABEL,
      runId: ctx.runId,
      cohortId: bound.cohortId,
      participantId: result.arm.participantId,
      provider: result.arm.provider,
      requestedModelId: result.arm.requestedModelId,
      // The digest only: the configuration itself is stamped once on the run's
      // arm roster, and this binds the row to that entry. Two arms of one model
      // are byte-identical on every other field of this record.
      configurationSha256: configurationSha256(result.arm.configuration),
      reportedModelId: reportedModelId(result),
      gameId: result.gameId,
      requestSha256: result.requestSha256,
      cutoffAt: result.cutoffAt,
      outcome: result.outcome,
      repairUsed: result.repairUsed,
      repairTransport: result.repairTransport,
      validationErrors: result.validationErrors,
      costUsd: null,
      attempt: attemptFields(result.attempt),
      repair: result.repair === null ? null : attemptFields(result.repair),
    });

    // cutoff_missed and every other non-valid outcome never emits decisions.
    if (result.outcome !== 'valid' || result.parsed === null) continue;
    const accepted = acceptedAttempt(result);
    for (const game of result.parsed.games) {
      for (const forecast of game.forecasts) {
        records.push({
          recordType: 'decision',
          label: SMOKE_LABEL,
          runId: ctx.runId,
          cohortId: bound.cohortId,
          participantId: result.arm.participantId,
          // Which entrant made this decision. `participantId` already says so,
          // but this is the value the serving layer keys a participant row on,
          // and carrying it here means a decision can be attributed without
          // reading the run's roster stamp first.
          configurationSha256: configurationSha256(result.arm.configuration),
          slateSha256,
          gameSha256: gameShaByGame.get(game.gameId) ?? null,
          bundleSha256: result.requestSha256,
          cutoffAt: result.cutoffAt,
          gameId: game.gameId,
          market: forecast.market,
          selection: forecast.selection,
          line: forecast.line,
          observedDecimal: forecast.observedDecimal,
          probabilities: forecast.probabilities,
          confidence: forecast.confidence,
          wouldAbstain: forecast.wouldAbstain,
          selectedForExecution: forecast.selectedForExecution,
          rationale: forecast.rationale,
          evidenceRefs: forecast.evidenceRefs,
          reasonCode: forecast.reasonCode ?? null,
          // Response schema v2 analysis fields. New runs validate v2, so axes
          // is always present here; the ?? null fallbacks only guard replay of
          // v1-shaped parses, mirroring reasonCode above.
          axes: forecast.axes ?? null,
          primaryAxis: forecast.primaryAxis ?? null,
          primaryExpectation: forecast.primaryExpectation ?? null,
          provider: result.arm.provider,
          requestedModelId: result.arm.requestedModelId,
          // Provenance of the ACCEPTED attempt: for repaired decisions this
          // is the repair's model ID, usage, response ID, and timestamps.
          reportedModelId: accepted.reportedModelId,
          providerResponseId: accepted.providerResponseId,
          attemptUsed: result.repairUsed ? 'repair' : 'initial',
          requestAt: accepted.requestAt,
          responseAt: accepted.responseAt,
          // When this forecast became a commitment: stamped after validation
          // passed and before the decision cutoff. Carried on the decision as
          // well as on the attempt so a reader of one line needs no join.
          acceptedAt: accepted.acceptedAt,
          latencyMs: accepted.latencyMs,
          tokens: accepted.usage,
          usageRaw: accepted.usageRaw,
          // What the accepted attempt actually looked at: every executed
          // search query + result reference, for after-the-fact audit.
          searchAudit: accepted.searchAudit,
          costUsd: null,
          outcome: 'valid',
        });
      }
    }
  }

  // One run_failure record per accurate machine code: identity-only failures
  // are never mislabeled as provider collisions.
  for (const [code, failures] of failuresByCode(collision.failures)) {
    records.push({
      recordType: 'run_failure',
      label: SMOKE_LABEL,
      runId: ctx.runId,
      code,
      failures,
    });
  }

  return records;
}

/**
 * Serialization chokepoint: EVERY byte written to disk passes through secret
 * redaction — parsed fields, validation errors, reported IDs, and raw usage
 * objects included, not just raw response text.
 */
export function writeNdjson(filePath: string, records: JsonRecord[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const lines = records.map((record) => redactSecrets(JSON.stringify(record))).join('\n');
  writeFileSync(filePath, `${lines}\n`, 'utf8');
}

export function writeText(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, redactSecrets(content), 'utf8');
}
