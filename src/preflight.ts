import { loadDotEnv } from './env.js';
import { describeErrorWithStack } from './config.js';
import { printError, printLine } from './console.js';
import { ProviderHttpError, ProviderTimeoutError } from './providers/errors.js';
import { approvedReportedModelIds, ARMS, createRealAdapters } from './providers/index.js';
import type { ChatTurn } from './types.js';

/**
 * Provider preflight — one trivial request per provider through THE REAL
 * ADAPTER CODE PATH (the same chat() the smoke run uses; nothing mocked).
 * It exists to turn "we think the model IDs and response shapes are right"
 * into "we watched them be right":
 *
 * - prints per arm: HTTP status, response-reported model ID, the verbatim
 *   usage object (the actual token field names), and latency;
 * - ASSERTS every metadata field the harness depends on is present —
 *   a missing field is a loud failure, not a shrug;
 * - an arm with no credential reports credential_missing and does not fail
 *   the preflight;
 * - exits non-zero if any credentialed arm fails, naming which and why.
 *
 * Every line prints through the redacted console chokepoint.
 */

const PREFLIGHT_SYSTEM = 'You are a connectivity preflight for a benchmark harness. Follow the user instruction exactly.';
const PREFLIGHT_USER = 'Reply with exactly this JSON and nothing else: {"ok":true}';

interface PreflightArgs {
  timeoutSeconds: number;
  maxOutputTokens: number;
}

function parseArgs(argv: string[]): PreflightArgs {
  const args: PreflightArgs = { timeoutSeconds: 120, maxOutputTokens: 1024 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--timeout-seconds':
        args.timeoutSeconds = Number.parseInt(next(), 10);
        break;
      case '--max-output-tokens':
        args.maxOutputTokens = Number.parseInt(next(), 10);
        break;
      default:
        throw new Error(`unknown argument: ${arg ?? ''}`);
    }
  }
  if (!Number.isInteger(args.timeoutSeconds) || args.timeoutSeconds <= 0) {
    throw new Error('--timeout-seconds must be a positive integer');
  }
  if (!Number.isInteger(args.maxOutputTokens) || args.maxOutputTokens <= 0) {
    throw new Error('--max-output-tokens must be a positive integer');
  }
  return args;
}

async function main(): Promise<number> {
  const loaded = loadDotEnv();
  if (loaded.length > 0) {
    printLine(`loaded ${loaded.length} env var(s) from .env: ${loaded.join(', ')}`);
  }
  const args = parseArgs(process.argv.slice(2));
  const adapters = createRealAdapters();
  const turns: ChatTurn[] = [
    { role: 'system', content: PREFLIGHT_SYSTEM },
    { role: 'user', content: PREFLIGHT_USER },
  ];

  let anyFailure = false;
  const rollup: string[] = [];

  for (const arm of ARMS) {
    const adapter = adapters.get(arm.participantId);
    printLine('');
    printLine(`== ${arm.participantId} (requested: ${arm.requestedModelId}) ==`);
    if (!adapter) {
      printLine('  FAIL — no adapter registered');
      anyFailure = true;
      rollup.push(`${arm.participantId}: FAIL (no adapter)`);
      continue;
    }
    if (!adapter.hasCredential()) {
      printLine(
        `  credential_missing (${arm.credentialEnvVar} not set) — arm skipped, not a failure`,
      );
      rollup.push(`${arm.participantId}: credential_missing`);
      continue;
    }

    const startedAt = Date.now();
    try {
      const response = await adapter.chat(turns, args.timeoutSeconds * 1000, {
        maxOutputTokens: args.maxOutputTokens,
      });
      const latency = Date.now() - startedAt;
      const failures: string[] = [];
      const warnings: string[] = [];

      if (response.reportedModelId === null) {
        failures.push('response did not report a model ID — the model-identity check cannot run');
      } else {
        const approved = approvedReportedModelIds(arm.participantId);
        if (!approved.includes(response.reportedModelId)) {
          failures.push(
            `reported model "${response.reportedModelId}" is not an approved ID for this arm ` +
              `(approved: ${approved.join(', ')}) — review it and, if legitimate, add it to APPROVED_REPORTED_MODEL_IDS`,
          );
        }
      }
      if (response.usageRaw === null || response.usageRaw === undefined) {
        failures.push('no usage object in the response — token accounting would be lost');
      }
      if (response.usage.inputTokens === null) failures.push('input-token count missing from usage');
      if (response.usage.outputTokens === null) failures.push('output-token count missing from usage');
      if (response.rawText.trim() === '') {
        failures.push(
          'empty response text (a reasoning-heavy default may have consumed the output cap — retry with --max-output-tokens 4096)',
        );
      }
      if (response.providerResponseId === null) {
        warnings.push('no provider response ID (recorded as null; not fatal)');
      }

      printLine(`  http: ${response.httpStatus} in ${latency}ms`);
      printLine(`  reported model: ${response.reportedModelId ?? '(none)'}`);
      printLine(`  response id: ${response.providerResponseId ?? '(none)'}`);
      printLine(`  text: ${response.rawText.trim().slice(0, 120) || '(empty)'}`);
      printLine(`  usage (verbatim): ${JSON.stringify(response.usageRaw)}`);
      for (const warning of warnings) printLine(`  warn: ${warning}`);
      if (failures.length > 0) {
        anyFailure = true;
        for (const failure of failures) printLine(`  FAIL: ${failure}`);
        rollup.push(`${arm.participantId}: FAIL (${failures.length} check(s))`);
      } else {
        printLine('  checks: PASS');
        rollup.push(
          `${arm.participantId}: PASS (reported ${response.reportedModelId ?? '?'} in ${latency}ms)`,
        );
      }
    } catch (error) {
      const latency = Date.now() - startedAt;
      anyFailure = true;
      const kind =
        error instanceof ProviderTimeoutError
          ? 'timeout'
          : error instanceof ProviderHttpError && error.status === 429
            ? 'rate_limited'
            : 'provider_error';
      const message = error instanceof Error ? error.message : String(error);
      printLine(`  FAIL (${kind}) after ${latency}ms: ${message}`);
      rollup.push(`${arm.participantId}: FAIL (${kind})`);
    }
  }

  printLine('');
  printLine('== preflight summary ==');
  for (const line of rollup) printLine(`  ${line}`);
  printLine(anyFailure ? 'PREFLIGHT FAILED' : 'PREFLIGHT PASSED');
  return anyFailure ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    printError(describeErrorWithStack(error));
    process.exitCode = 1;
  });
