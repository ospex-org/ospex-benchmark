import { describeError, redactSecrets } from './config.js';
import { buildRepairInstruction, buildUserMessage, SYSTEM_PROMPT } from './prompt.js';
import { detectChangedDecisions, validateResponseText } from './schema.js';
import { ProviderHttpError, ProviderTimeoutError } from './providers/errors.js';
import type {
  ArmRunResult,
  ArmSpec,
  AttemptRecord,
  ChatTurn,
  ProviderAdapter,
  ProviderResponse,
  SlateBundle,
} from './types.js';

export interface RunArmsOptions {
  bundle: SlateBundle;
  bundleSha256: string;
  cohortId: string;
  timeoutMs: number;
}

function emptyAttempt(): AttemptRecord {
  return {
    rawText: null,
    reportedModelId: null,
    providerResponseId: null,
    usage: null,
    requestParams: null,
    requestAt: null,
    responseAt: null,
    latencyMs: null,
    errorDetail: null,
  };
}

async function timedChat(
  adapter: ProviderAdapter,
  turns: ChatTurn[],
  timeoutMs: number,
): Promise<AttemptRecord & { response: ProviderResponse | null; failure: 'timeout' | 'provider_error' | null }> {
  const requestAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const response = await adapter.chat(turns, timeoutMs);
    return {
      rawText: redactSecrets(response.rawText),
      reportedModelId: response.reportedModelId,
      providerResponseId: response.providerResponseId,
      usage: response.usage,
      requestParams: response.requestParams,
      requestAt,
      responseAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      errorDetail: null,
      response,
      failure: null,
    };
  } catch (error) {
    const failure = error instanceof ProviderTimeoutError ? 'timeout' : 'provider_error';
    const detail =
      error instanceof ProviderHttpError || error instanceof ProviderTimeoutError
        ? error.message
        : describeError(error);
    return {
      ...emptyAttempt(),
      requestAt,
      responseAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      errorDetail: redactSecrets(detail),
      response: null,
      failure,
    };
  }
}

async function runOneArm(
  arm: ArmSpec,
  adapter: ProviderAdapter,
  options: RunArmsOptions,
): Promise<ArmRunResult> {
  if (!adapter.hasCredential()) {
    return {
      arm,
      outcome: 'credential_missing',
      attempt: {
        ...emptyAttempt(),
        errorDetail: `${arm.credentialEnvVar} is not set`,
      },
      repair: null,
      repairUsed: false,
      parsed: null,
      validationErrors: [],
    };
  }

  const userMessage = buildUserMessage({
    cohortId: options.cohortId,
    participantId: arm.participantId,
    requestedModelId: arm.requestedModelId,
    executionPolicy: 'fixed-moneyline-total',
    bundleSha256: options.bundleSha256,
    bundle: options.bundle,
  });
  const baseTurns: ChatTurn[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  const attempt = await timedChat(adapter, baseTurns, options.timeoutMs);
  const { response: firstResponse, failure: firstFailure, ...attemptRecord } = attempt;
  if (firstFailure !== null || firstResponse === null) {
    return {
      arm,
      outcome: firstFailure ?? 'provider_error',
      attempt: attemptRecord,
      repair: null,
      repairUsed: false,
      parsed: null,
      validationErrors: [],
    };
  }

  const firstValidation = validateResponseText(
    firstResponse.rawText,
    options.bundle,
    options.bundleSha256,
    arm,
    options.cohortId,
  );
  if (firstValidation.errors.length === 0 && firstValidation.parsed !== null) {
    return {
      arm,
      outcome: 'valid',
      attempt: attemptRecord,
      repair: null,
      repairUsed: false,
      parsed: firstValidation.parsed,
      validationErrors: [],
    };
  }

  // One deterministic format-repair attempt: same frozen inputs, the prior
  // raw output, and a fixed instruction that may not invite a new decision.
  const repairTurns: ChatTurn[] = [
    ...baseTurns,
    { role: 'assistant', content: firstResponse.rawText },
    { role: 'user', content: buildRepairInstruction(firstValidation.errors) },
  ];
  const repair = await timedChat(adapter, repairTurns, options.timeoutMs);
  const { response: repairResponse, failure: repairFailure, ...repairRecord } = repair;
  if (repairFailure !== null || repairResponse === null) {
    return {
      arm,
      outcome: 'invalid_schema',
      attempt: attemptRecord,
      repair: repairRecord,
      repairUsed: true,
      parsed: null,
      validationErrors: [
        ...firstValidation.errors,
        `repair attempt failed: ${repairRecord.errorDetail ?? 'unknown error'}`,
      ],
    };
  }

  const repairValidation = validateResponseText(
    repairResponse.rawText,
    options.bundle,
    options.bundleSha256,
    arm,
    options.cohortId,
  );
  if (repairValidation.errors.length === 0 && repairValidation.parsed !== null) {
    const changed =
      firstValidation.parsed !== null
        ? detectChangedDecisions(firstValidation.parsed, repairValidation.parsed)
        : [];
    if (changed.length > 0) {
      return {
        arm,
        outcome: 'invalid_schema',
        attempt: attemptRecord,
        repair: repairRecord,
        repairUsed: true,
        parsed: null,
        validationErrors: changed,
      };
    }
    return {
      arm,
      outcome: 'valid',
      attempt: attemptRecord,
      repair: repairRecord,
      repairUsed: true,
      parsed: repairValidation.parsed,
      validationErrors: [],
    };
  }

  return {
    arm,
    outcome: 'invalid_schema',
    attempt: attemptRecord,
    repair: repairRecord,
    repairUsed: true,
    parsed: null,
    validationErrors: repairValidation.errors,
  };
}

/**
 * Launch all arms concurrently against the identical frozen bundle. Results
 * are collected in memory and returned together — nothing is recorded,
 * printed, or compared until every arm has settled, so no arm can be
 * conditioned on another's answer.
 */
export async function runAllArms(
  arms: ArmSpec[],
  adapters: Map<string, ProviderAdapter>,
  options: RunArmsOptions,
): Promise<ArmRunResult[]> {
  return Promise.all(
    arms.map((arm) => {
      const adapter = adapters.get(arm.participantId);
      if (!adapter) {
        throw new Error(`no adapter registered for ${arm.participantId}`);
      }
      return runOneArm(arm, adapter, options);
    }),
  );
}
