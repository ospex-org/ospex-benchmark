import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactSecrets } from './config.js';
import { FUTURE_QUOTE_SKEW_MS, MAX_QUOTE_AGE_MS } from './bundle.js';
import { PROMPT_SCAFFOLD_VERSION, promptScaffoldSha256 } from './prompt.js';
import { SMOKE_LABEL } from './types.js';
import type { BuildResult } from './bundle.js';
import type { CollisionCheckResult } from './providers/family.js';
import type { ArmGameResult, AttemptRecord, BaselineDecision } from './types.js';

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
}

type JsonRecord = Record<string, unknown>;

function attemptFields(attempt: AttemptRecord | null): JsonRecord {
  return {
    requestAt: attempt?.requestAt ?? null,
    responseAt: attempt?.responseAt ?? null,
    latencyMs: attempt?.latencyMs ?? null,
    httpStatus: attempt?.httpStatus ?? null,
    reportedModelId: attempt?.reportedModelId ?? null,
    tokens: attempt?.usage ?? null,
    usageRaw: attempt?.usageRaw ?? null,
    providerResponseId: attempt?.providerResponseId ?? null,
    requestParams: attempt?.requestParams ?? null,
    rawResponse: attempt?.rawText ?? null,
    errorDetail: attempt?.errorDetail ?? null,
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
export function reportedModelIdsByArm(results: ArmGameResult[]): Map<string, string[]> {
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

export function buildRecords(
  ctx: RunContext,
  build: BuildResult,
  armGameResults: ArmGameResult[],
  baselineDecisions: BaselineDecision[],
  collision: CollisionCheckResult,
): JsonRecord[] {
  const records: JsonRecord[] = [];
  const { slateBundle, slateSha256, requests, gameHashes, excluded, provenance } = build;
  const requestShaByGame = new Map(requests.map((r) => [r.gameId, r.requestSha256]));
  const cutoffByGame = new Map(requests.map((r) => [r.gameId, r.requestBundle.cutoffAt]));

  records.push({
    recordType: 'run_meta',
    label: SMOKE_LABEL,
    runId: ctx.runId,
    cohortId: ctx.cohortId,
    mode: ctx.mode,
    slateDate: ctx.slateDate,
    createdAt: ctx.createdAt,
    executionPolicy: ctx.executionPolicy,
    dispatch: 'per-game-by-cutoff',
    slateSha256,
    fetchStartedAt: ctx.fetchStartedAt,
    fetchCompletedAt: ctx.fetchCompletedAt,
    bundleTimestamp: slateBundle.bundleTimestamp,
    slateCutoffAt: slateBundle.cutoffAt,
    promptScaffoldVersion: PROMPT_SCAFFOLD_VERSION,
    promptScaffoldSha256: promptScaffoldSha256(),
    timeoutMs: ctx.timeoutMs,
    maxOutputTokens: ctx.maxOutputTokens,
    quoteFreshnessPolicy: {
      maxQuoteAgeMs: MAX_QUOTE_AGE_MS,
      futureQuoteSkewMs: FUTURE_QUOTE_SKEW_MS,
    },
    eligibleGames: slateBundle.games.length,
    excludedGames: excluded.length,
    armGameResults: armGameResults.length,
    baselineDecisionCount: baselineDecisions.length,
  });

  for (const request of requests) {
    records.push({
      recordType: 'bundle_game',
      label: SMOKE_LABEL,
      runId: ctx.runId,
      gameId: request.gameId,
      gameSha256: gameHashes[request.gameId] ?? null,
      requestSha256: request.requestSha256,
      cutoffAt: request.requestBundle.cutoffAt,
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
      cohortId: ctx.cohortId,
      slateSha256,
      gameSha256: gameHashes[decision.gameId] ?? null,
      requestSha256: requestShaByGame.get(decision.gameId) ?? null,
      cutoffAt: cutoffByGame.get(decision.gameId) ?? null,
      ...decision,
    });
  }

  for (const result of armGameResults) {
    records.push({
      recordType: 'arm_game_response',
      label: SMOKE_LABEL,
      runId: ctx.runId,
      cohortId: ctx.cohortId,
      participantId: result.arm.participantId,
      provider: result.arm.provider,
      requestedModelId: result.arm.requestedModelId,
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
          cohortId: ctx.cohortId,
          participantId: result.arm.participantId,
          slateSha256,
          gameSha256: gameHashes[game.gameId] ?? null,
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
          provider: result.arm.provider,
          requestedModelId: result.arm.requestedModelId,
          // Provenance of the ACCEPTED attempt: for repaired decisions this
          // is the repair's model ID, usage, response ID, and timestamps.
          reportedModelId: accepted.reportedModelId,
          providerResponseId: accepted.providerResponseId,
          attemptUsed: result.repairUsed ? 'repair' : 'initial',
          requestAt: accepted.requestAt,
          responseAt: accepted.responseAt,
          latencyMs: accepted.latencyMs,
          tokens: accepted.usage,
          usageRaw: accepted.usageRaw,
          costUsd: null,
          outcome: 'valid',
        });
      }
    }
  }

  if (collision.failures.length > 0) {
    records.push({
      recordType: 'run_failure',
      label: SMOKE_LABEL,
      runId: ctx.runId,
      code: 'PROVIDER_COLLISION',
      failures: collision.failures,
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
