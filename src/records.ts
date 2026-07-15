import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactSecrets } from './config.js';
import { FUTURE_QUOTE_SKEW_MS, MAX_QUOTE_AGE_MS } from './bundle.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { bundleMarketKeys } from './markets.js';
import { PROMPT_SCAFFOLD_VERSION, promptScaffoldSha256 } from './prompt.js';
import { SMOKE_LABEL } from './types.js';
import type { BuildResult } from './bundle.js';
import type { CollisionCheckResult } from './providers/family.js';
import type { ArmGameResult, AttemptRecord, BaselineDecision, MarketKey } from './types.js';

/**
 * Per-speculation gate provenance: for ONE market on the fired game, its first
 * board appearance and the resulting opener age at detection. Each dispatched
 * market carries its own — a stale market can never ride in on a fresh one, so
 * the scorer verifies every market's age independently against the committed
 * late threshold.
 */
export interface MarketGateProvenance {
  firstAppearanceAt: string;
  openerAgeSeconds: number;
}

/**
 * Watch-mode gate provenance, recorded in run_meta so the entry-timing claim
 * is verifiable from the artifact itself (the scorer fail-closes on it for
 * watch runs): when detection happened, the committed late threshold, and the
 * per-market first-appearance + opener age for each market this fire entered.
 */
export interface WatchProvenance {
  detectedAt: string;
  lateThresholdSeconds: number;
  markets: Partial<Record<MarketKey, MarketGateProvenance>>;
}

/**
 * The disposition of ONE speculation (game, market) as the runner saw it — the
 * published denominator. `entered` speculations correspond to decisions in this
 * run; `not_entered` ones carry a machine-readable reason and their
 * first-appearance evidence. Recording the negative space closes the
 * cherry-pick surface per-market firing would otherwise create: a market that
 * was dropped is a detectable `not_entered` fact next to the entered ones, not
 * an invisible gap.
 */
export interface SpeculationDisposition {
  gameId: string;
  slug: string;
  league: string;
  market: string;
  decision: 'entered' | 'not_entered';
  reason: string;
  firstAppearanceAt: string | null;
  openerAgeSeconds: number | null;
  scheduledStartUtc: string;
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

/**
 * Per arm: how many SUCCESSFUL responses (a body came back) carried no
 * reported model ID. Feeds the fail-closed identity check — transport
 * failures with no response body are exempt.
 */
export function unidentifiedResponsesByArm(results: ArmGameResult[]): Map<string, number> {
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
  ctx: RunContext,
  build: BuildResult,
  armGameResults: ArmGameResult[],
  baselineDecisions: BaselineDecision[],
  collision: CollisionCheckResult,
  /** Per-market dispositions for the fired game(s) — the published denominator
   *  (watch runs only; empty for the smoke). */
  dispositions: SpeculationDisposition[] = [],
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
    dispatch: 'per-speculation-at-detection',
    // The preregistered market allow-list this run dispatched under: version +
    // content digest, so the scorer can pin the run to the committed policy and
    // refuse a tampered version string or a tampered allow-list.
    marketPolicyVersion: MARKET_POLICY_VERSION,
    marketPolicyDigest: MARKET_POLICY_DIGEST,
    slateSha256,
    fetchStartedAt: ctx.fetchStartedAt,
    fetchCompletedAt: ctx.fetchCompletedAt,
    bundleTimestamp: slateBundle.bundleTimestamp,
    slateCutoffAt: slateBundle.cutoffAt,
    // The scaffold VERSION is a run-level constant; its per-request hash is a
    // function of that request's market set, so it rides on each bundle_game.
    promptScaffoldVersion: PROMPT_SCAFFOLD_VERSION,
    timeoutMs: ctx.timeoutMs,
    maxOutputTokens: ctx.maxOutputTokens,
    clockMode: ctx.clockMode,
    quoteFreshnessPolicy: {
      maxQuoteAgeMs: MAX_QUOTE_AGE_MS,
      futureQuoteSkewMs: FUTURE_QUOTE_SKEW_MS,
    },
    eligibleGames: slateBundle.games.length,
    excludedGames: excluded.length,
    armGameResults: armGameResults.length,
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

  for (const request of requests) {
    const markets = bundleMarketKeys(request.game);
    records.push({
      recordType: 'bundle_game',
      label: SMOKE_LABEL,
      runId: ctx.runId,
      gameId: request.gameId,
      gameSha256: gameHashes[request.gameId] ?? null,
      requestSha256: request.requestSha256,
      cutoffAt: request.requestBundle.cutoffAt,
      slug: request.slug,
      // The markets this request actually dispatched, and the scaffold hash
      // for exactly that set — a scoped fire and a full board differ here.
      markets,
      promptScaffoldSha256: promptScaffoldSha256(markets),
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

  // The published denominator: every market of the fired game, entered or not.
  for (const disposition of dispositions) {
    records.push({
      recordType: 'speculation_status',
      label: SMOKE_LABEL,
      runId: ctx.runId,
      ...disposition,
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

/**
 * Exclusive-create write (O_EXCL): returns false if the file already exists,
 * true if this call created it. This is the at-most-once primitive the
 * line-open ledger claim uses — on a shared filesystem, two watcher instances
 * cannot both create the same speculation's claim file, so they cannot both
 * dispatch (and double-bill) it. Redaction still precedes the write.
 */
export function writeTextExclusive(filePath: string, content: string): boolean {
  mkdirSync(dirname(filePath), { recursive: true });
  try {
    writeFileSync(filePath, redactSecrets(content), { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Append records to an NDJSON log through the same redaction chokepoint. Used
 * for the append-only coverage log — the published denominator for every
 * (game, market) the runner sees, including games that never fire any market
 * (those produce no run file, so their negative space would otherwise be
 * invisible).
 */
export function appendNdjson(filePath: string, records: JsonRecord[]): void {
  if (records.length === 0) return;
  mkdirSync(dirname(filePath), { recursive: true });
  const lines = records.map((record) => redactSecrets(JSON.stringify(record))).join('\n');
  appendFileSync(filePath, `${lines}\n`, 'utf8');
}
