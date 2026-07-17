import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { buildBundle } from './bundle.js';
import { DEFAULT_OSPEX_API_URL, describeErrorWithStack, envValue } from './config.js';
import { printError, printLine } from './console.js';
import { loadDotEnv } from './env.js';
import { fetchLiveInputs } from './fetchers.js';
import {
  createFixtureClock,
  createMockAdapters,
  FIXTURE_SLATE_DATE,
  loadFixtureInputs,
} from './mock.js';
import { approvedReportedModelIds, ARMS, createRealAdapters } from './providers/index.js';
import { checkProviderCollision } from './providers/family.js';
import {
  buildRecords,
  failuresByCode,
  reportedModelIdsByArm,
  unidentifiedResponsesByArm,
  writeNdjson,
  writeText,
} from './records.js';
import { runSlate } from './runner.js';
import { isValidSlateDate, tomorrowEastern } from './slateDate.js';
import { buildSummaryMarkdown } from './summary.js';
import type { RunContext } from './records.js';
import type { ArmOutcome, SlateInputs } from './types.js';

/**
 * ospex-benchmark shadow smoke (v0) — SMOKE_V0_NOT_A_COHORT.
 *
 * Fetches an MLB slate with reference odds from the existing public read
 * path, freezes a content-hashed single-game bundle per game, dispatches the
 * four arms concurrently per game (games sequential, outputs sealed per
 * game), validates every forecast against the strict output schema, records
 * everything with provenance, and stops. No scoring, no wallets, no chain
 * access, no SSE.
 */

class UsageError extends Error {}

interface CliOptions {
  dryRun: boolean;
  simulateCollision: boolean;
  date: string | null;
  outDir: string;
  timeoutSeconds: number | null;
  windowHours: number;
  cohortId: string | null;
  maxOutputTokens: number;
}

const USAGE = `Usage: yarn smoke [options]

Options:
  --dry-run              Run against the fixture slate and mock providers (no credentials, no network).
  --simulate-collision   (dry run only) Make two mock arms report the same provider family,
                         demonstrating the PROVIDER_COLLISION hard failure.
  --date YYYY-MM-DD      Slate calendar day in US Eastern time. Default: tomorrow (live),
                         fixture date (dry run).
  --out DIR              Output directory. Default: out/
  --timeout-seconds N    Per-provider-call timeout. Default: 300 live, 2 dry run. Each call is
                         additionally bounded by the remaining time to its game's cutoff.
  --max-output-tokens N  Explicit output-token bound on every provider call. Default: 16000.
  --window-hours N       Games-endpoint lookahead window (live). Default: 72, max 720.
  --cohort ID            Cohort identifier. Default: smoke-v0-<date>.
  -h, --help             Show this help.`;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    simulateCollision: false,
    date: null,
    outDir: 'out',
    timeoutSeconds: null,
    windowHours: 72,
    cohortId: null,
    maxOutputTokens: 16000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--simulate-collision':
        options.simulateCollision = true;
        break;
      case '--date':
        options.date = next();
        break;
      case '--out':
        options.outDir = next();
        break;
      case '--timeout-seconds': {
        const value = Number.parseInt(next(), 10);
        if (!Number.isInteger(value) || value <= 0) {
          throw new UsageError('--timeout-seconds must be a positive integer');
        }
        options.timeoutSeconds = value;
        break;
      }
      case '--window-hours': {
        const value = Number.parseInt(next(), 10);
        if (!Number.isInteger(value) || value < 1 || value > 720) {
          throw new UsageError('--window-hours must be an integer between 1 and 720');
        }
        options.windowHours = value;
        break;
      }
      case '--max-output-tokens': {
        const value = Number.parseInt(next(), 10);
        if (!Number.isInteger(value) || value <= 0) {
          throw new UsageError('--max-output-tokens must be a positive integer');
        }
        options.maxOutputTokens = value;
        break;
      }
      case '--cohort':
        options.cohortId = next();
        break;
      case '-h':
      case '--help':
        printLine(USAGE);
        process.exit(0);
        break;
      default:
        throw new UsageError(`unknown argument: ${arg ?? ''}`);
    }
  }
  if (options.simulateCollision && !options.dryRun) {
    throw new UsageError('--simulate-collision is only valid with --dry-run');
  }
  if (options.date !== null && !isValidSlateDate(options.date)) {
    throw new UsageError('--date must be a valid YYYY-MM-DD calendar day');
  }
  return options;
}

async function loadInputs(options: CliOptions): Promise<{ inputs: SlateInputs; slateDate: string }> {
  if (options.dryRun) {
    return {
      inputs: loadFixtureInputs(),
      slateDate: options.date ?? FIXTURE_SLATE_DATE,
    };
  }
  const supabaseUrl = envValue('SUPABASE_URL');
  const supabaseAnonKey = envValue('SUPABASE_ANON_KEY');
  const missing = [
    ...(supabaseUrl === undefined ? ['SUPABASE_URL'] : []),
    ...(supabaseAnonKey === undefined ? ['SUPABASE_ANON_KEY'] : []),
  ];
  if (supabaseUrl === undefined || supabaseAnonKey === undefined) {
    throw new UsageError(
      `live mode needs the public read path configured — missing env: ${missing.join(', ')}`,
    );
  }
  const apiUrl = envValue('OSPEX_API_URL') ?? DEFAULT_OSPEX_API_URL;
  const slateDate = options.date ?? tomorrowEastern(new Date());
  printLine(`fetching MLB slate for ${slateDate} (ET) from ${apiUrl} ...`);
  const inputs = await fetchLiveInputs({
    apiUrl,
    supabaseUrl,
    supabaseAnonKey,
    windowHours: options.windowHours,
  });
  return { inputs, slateDate };
}

async function main(): Promise<number> {
  const loaded = loadDotEnv();
  const options = parseArgs(process.argv.slice(2));
  const mode = options.dryRun ? 'dry-run' : 'live';
  printLine(`ospex-benchmark shadow smoke v0 — ${mode} — label SMOKE_V0_NOT_A_COHORT`);
  if (loaded.length > 0) {
    printLine(`loaded ${loaded.length} env var(s) from .env: ${loaded.join(', ')}`);
  }

  const { inputs, slateDate } = await loadInputs(options);
  const build = buildBundle(inputs, slateDate, { requireFuture: !options.dryRun });
  printLine(
    `bundle: ${build.requests.length} eligible games, ${build.excluded.length} excluded, ` +
      `slate sha256 ${build.slateSha256.slice(0, 16)}…, earliest cutoff ${build.slateBundle.cutoffAt}`,
  );

  // ONE clock per run: the wall clock live, or a synthetic clock anchored to
  // the fixture capture instant in dry runs. It drives cutoff enforcement AND
  // every recorded timestamp, so dry artifacts stay temporally consistent.
  const nowMs = options.dryRun ? createFixtureClock() : (): number => Date.now();

  const ctx: RunContext = {
    runId: `smoke-v0-${slateDate}-${randomBytes(3).toString('hex')}`,
    cohortId: options.cohortId ?? `smoke-v0-${slateDate}`,
    mode,
    slateDate,
    createdAt: new Date(nowMs()).toISOString(),
    executionPolicy: 'fixed-moneyline-total',
    timeoutMs: (options.timeoutSeconds ?? (options.dryRun ? 2 : 300)) * 1000,
    maxOutputTokens: options.maxOutputTokens,
    fetchStartedAt: inputs.fetchStartedAt,
    fetchCompletedAt: inputs.fetchCompletedAt,
    clockMode: options.dryRun ? 'synthetic-fixture' : 'wall',
  };

  const adapters = options.dryRun
    ? createMockAdapters({ simulateCollision: options.simulateCollision })
    : createRealAdapters();

  printLine(
    `dispatching per game in cutoff order: ${build.requests.length} games sequential, ` +
      `${ARMS.length} arms concurrent per game (sealed per game) ...`,
  );
  const { results: armGameResults, snapshot } = await runSlate(ARMS, adapters, build.requests, {
    cohortId: ctx.cohortId,
    timeoutMs: ctx.timeoutMs,
    maxOutputTokens: ctx.maxOutputTokens,
    nowMs,
    onGameComplete: (line) => printLine(`  ${line}`),
  });

  // The artifact (records, baselines, summary) is built entirely from the sealed
  // dispatch snapshot inside buildRecords/buildSummaryMarkdown.
  const reportedByArm = reportedModelIdsByArm(armGameResults);
  const unidentifiedByArm = unidentifiedResponsesByArm(armGameResults);
  const collision = checkProviderCollision(
    ARMS.map((arm) => ({
      participantId: arm.participantId,
      provider: arm.provider,
      requestedModelId: arm.requestedModelId,
      approvedReportedModelIds: approvedReportedModelIds(arm.participantId),
      reportedModelIds: reportedByArm.get(arm.participantId) ?? [],
      unidentifiedResponses: unidentifiedByArm.get(arm.participantId) ?? 0,
    })),
  );

  const records = buildRecords(ctx, build, snapshot, armGameResults, collision);
  const ndjsonPath = join(options.outDir, `${ctx.runId}.ndjson`);
  const summaryPath = join(options.outDir, `${ctx.runId}-summary.md`);
  writeNdjson(ndjsonPath, records);
  writeText(
    summaryPath,
    buildSummaryMarkdown(ctx, build, snapshot, armGameResults, collision),
  );

  printLine('');
  const outcomes: ArmOutcome[] = [
    'valid',
    'invalid_schema',
    'timeout',
    'rate_limited',
    'cutoff_missed',
    'dispatch_lag_exceeded',
    'credential_missing',
    'provider_error',
  ];
  for (const arm of ARMS) {
    const results = armGameResults.filter((r) => r.arm.participantId === arm.participantId);
    const parts = outcomes
      .map((o) => [o, results.filter((r) => r.outcome === o).length] as const)
      .filter(([, count]) => count > 0)
      .map(([o, count]) => `${o} ${count}`)
      .join(' · ');
    const reported = reportedByArm.get(arm.participantId) ?? [];
    printLine(
      `  ${arm.participantId}: ${parts || 'no games'}` +
        `${reported.length > 0 ? ` [reported: ${reported.join(', ')}]` : ''}`,
    );
  }
  printLine('');
  printLine(`records: ${ndjsonPath} (${records.length} lines)`);
  printLine(`summary: ${summaryPath}`);

  if (collision.failures.length > 0) {
    const codes = [...failuresByCode(collision.failures).keys()];
    printError('');
    printError(`!!! RUN FAILED — ${codes.join(' + ')} !!!`);
    for (const failure of collision.failures) printError(`  ${failure}`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      printError(`error: ${error.message}`);
      printError('');
      printError(USAGE);
      process.exitCode = 2;
      return;
    }
    printError(describeErrorWithStack(error));
    process.exitCode = 1;
  });
