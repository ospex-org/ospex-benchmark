import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PROMPT_SCAFFOLD_VERSION, promptScaffoldSha256 } from './prompt.js';
import { SMOKE_LABEL } from './types.js';
import type { BuildResult } from './bundle.js';
import type { CollisionCheckResult } from './providers/family.js';
import type { ArmRunResult, AttemptRecord, BaselineDecision } from './types.js';

export interface RunContext {
  runId: string;
  cohortId: string;
  mode: 'dry-run' | 'live';
  slateDate: string;
  createdAt: string;
  executionPolicy: 'fixed-moneyline-total';
  timeoutMs: number;
}

type JsonRecord = Record<string, unknown>;

function attemptFields(attempt: AttemptRecord | null): JsonRecord {
  return {
    requestAt: attempt?.requestAt ?? null,
    responseAt: attempt?.responseAt ?? null,
    latencyMs: attempt?.latencyMs ?? null,
    tokens: attempt?.usage ?? null,
    providerResponseId: attempt?.providerResponseId ?? null,
    requestParams: attempt?.requestParams ?? null,
    rawResponse: attempt?.rawText ?? null,
    errorDetail: attempt?.errorDetail ?? null,
  };
}

/** The response-reported model ID for an arm, from whichever attempt reported one. */
export function reportedModelId(result: ArmRunResult): string | null {
  return result.attempt.reportedModelId ?? result.repair?.reportedModelId ?? null;
}

export function buildRecords(
  ctx: RunContext,
  build: BuildResult,
  armResults: ArmRunResult[],
  baselineDecisions: BaselineDecision[],
  collision: CollisionCheckResult,
): JsonRecord[] {
  const records: JsonRecord[] = [];
  const { bundle, bundleSha256, gameHashes, excluded, provenance } = build;

  records.push({
    recordType: 'run_meta',
    label: SMOKE_LABEL,
    runId: ctx.runId,
    cohortId: ctx.cohortId,
    mode: ctx.mode,
    slateDate: ctx.slateDate,
    createdAt: ctx.createdAt,
    executionPolicy: ctx.executionPolicy,
    bundleSha256,
    bundleTimestamp: bundle.bundleTimestamp,
    cutoffAt: bundle.cutoffAt,
    promptScaffoldVersion: PROMPT_SCAFFOLD_VERSION,
    promptScaffoldSha256: promptScaffoldSha256(),
    timeoutMs: ctx.timeoutMs,
    eligibleGames: bundle.games.length,
    excludedGames: excluded.length,
    armCount: armResults.length,
    baselineDecisionCount: baselineDecisions.length,
  });

  for (const game of bundle.games) {
    records.push({
      recordType: 'bundle_game',
      label: SMOKE_LABEL,
      runId: ctx.runId,
      gameId: game.gameId,
      gameSha256: gameHashes[game.gameId] ?? null,
      slug: provenance[game.gameId]?.slug ?? null,
      bundle: game,
      sourceOddsRows: provenance[game.gameId]?.oddsRows ?? [],
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
      bundleSha256,
      gameSha256: gameHashes[decision.gameId] ?? null,
      cutoffAt: bundle.cutoffAt,
      ...decision,
    });
  }

  for (const result of armResults) {
    records.push({
      recordType: 'arm_response',
      label: SMOKE_LABEL,
      runId: ctx.runId,
      cohortId: ctx.cohortId,
      participantId: result.arm.participantId,
      provider: result.arm.provider,
      requestedModelId: result.arm.requestedModelId,
      reportedModelId: reportedModelId(result),
      outcome: result.outcome,
      repairUsed: result.repairUsed,
      validationErrors: result.validationErrors,
      costUsd: null,
      attempt: attemptFields(result.attempt),
      repair: result.repair === null ? null : attemptFields(result.repair),
    });

    if (result.outcome !== 'valid' || result.parsed === null) continue;
    const accepted = result.repairUsed && result.repair !== null ? result.repair : result.attempt;
    for (const game of result.parsed.games) {
      for (const forecast of game.forecasts) {
        records.push({
          recordType: 'decision',
          label: SMOKE_LABEL,
          runId: ctx.runId,
          cohortId: ctx.cohortId,
          participantId: result.arm.participantId,
          bundleSha256,
          gameSha256: gameHashes[game.gameId] ?? null,
          cutoffAt: bundle.cutoffAt,
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
          provider: result.arm.provider,
          requestedModelId: result.arm.requestedModelId,
          reportedModelId: reportedModelId(result),
          attemptUsed: result.repairUsed ? 'repair' : 'initial',
          requestAt: accepted.requestAt,
          responseAt: accepted.responseAt,
          latencyMs: accepted.latencyMs,
          tokens: accepted.usage,
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

export function writeNdjson(filePath: string, records: JsonRecord[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const lines = records.map((record) => JSON.stringify(record)).join('\n');
  writeFileSync(filePath, `${lines}\n`, 'utf8');
}

export function writeText(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}
