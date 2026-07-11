import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { runBaselines } from './baselines.js';
import { buildBundle } from './bundle.js';
import { DEFAULT_OSPEX_API_URL, describeErrorWithStack, envValue } from './config.js';
import { isValidSlateDate, tomorrowEastern } from './dates.js';
import { fetchLiveInputs } from './fetchers.js';
import { createMockAdapters, FIXTURE_SLATE_DATE, loadFixtureInputs } from './mock.js';
import { ARMS, createRealAdapters } from './providers/index.js';
import { checkProviderCollision } from './providers/family.js';
import { buildRecords, reportedModelId, writeNdjson, writeText } from './records.js';
import { runAllArms } from './runner.js';
import { buildSummaryMarkdown } from './summary.js';
import type { RunContext } from './records.js';
import type { SlateInputs } from './types.js';

/**
 * ospex-benchmark shadow smoke (v0) — SMOKE_V0_NOT_A_COHORT.
 *
 * Fetches an MLB slate with reference odds from the existing public read
 * path, freezes it into a content-hashed bundle, sends the identical bundle
 * to four frontier-model arms concurrently, validates their forecasts
 * against the strict output schema, records everything with provenance, and
 * stops. No scoring, no wallets, no chain access, no SSE.
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
}

const USAGE = `Usage: yarn smoke [options]

Options:
  --dry-run              Run against the fixture slate and mock providers (no credentials, no network).
  --simulate-collision   (dry run only) Make two mock arms report the same provider family,
                         demonstrating the PROVIDER_COLLISION hard failure.
  --date YYYY-MM-DD      Slate calendar day in US Eastern time. Default: tomorrow (live),
                         fixture date (dry run).
  --out DIR              Output directory. Default: out/
  --timeout-seconds N    Per-provider-call timeout. Default: 600 live, 2 dry run.
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
      case '--cohort':
        options.cohortId = next();
        break;
      case '-h':
      case '--help':
        console.log(USAGE);
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
  console.log(`fetching MLB slate for ${slateDate} (ET) from ${apiUrl} ...`);
  const inputs = await fetchLiveInputs({
    apiUrl,
    supabaseUrl,
    supabaseAnonKey,
    windowHours: options.windowHours,
  });
  return { inputs, slateDate };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const mode = options.dryRun ? 'dry-run' : 'live';
  console.log(`ospex-benchmark shadow smoke v0 — ${mode} — label SMOKE_V0_NOT_A_COHORT`);

  const { inputs, slateDate } = await loadInputs(options);
  const build = buildBundle(inputs, slateDate, { requireFuture: !options.dryRun });
  console.log(
    `bundle: ${build.bundle.games.length} eligible games, ${build.excluded.length} excluded, ` +
      `sha256 ${build.bundleSha256.slice(0, 16)}…, cutoff ${build.bundle.cutoffAt}`,
  );

  const ctx: RunContext = {
    runId: `smoke-v0-${slateDate}-${randomBytes(3).toString('hex')}`,
    cohortId: options.cohortId ?? `smoke-v0-${slateDate}`,
    mode,
    slateDate,
    createdAt: new Date().toISOString(),
    executionPolicy: 'fixed-moneyline-total',
    timeoutMs: (options.timeoutSeconds ?? (options.dryRun ? 2 : 600)) * 1000,
  };

  const adapters = options.dryRun
    ? createMockAdapters({ simulateCollision: options.simulateCollision })
    : createRealAdapters();

  console.log(
    `dispatching ${ARMS.length} arms concurrently (outputs sealed until all settle) ...`,
  );
  const armResults = await runAllArms(ARMS, adapters, {
    bundle: build.bundle,
    bundleSha256: build.bundleSha256,
    cohortId: ctx.cohortId,
    timeoutMs: ctx.timeoutMs,
  });

  const baselineDecisions = runBaselines(build.bundle);
  const collision = checkProviderCollision(
    armResults.map((result) => ({
      participantId: result.arm.participantId,
      provider: result.arm.provider,
      requestedModelId: result.arm.requestedModelId,
      reportedModelId: reportedModelId(result),
    })),
  );

  const records = buildRecords(ctx, build, armResults, baselineDecisions, collision);
  const ndjsonPath = join(options.outDir, `${ctx.runId}.ndjson`);
  const summaryPath = join(options.outDir, `${ctx.runId}-summary.md`);
  writeNdjson(ndjsonPath, records);
  writeText(
    summaryPath,
    buildSummaryMarkdown(ctx, build, armResults, baselineDecisions, collision),
  );

  console.log('');
  for (const result of armResults) {
    const reported = reportedModelId(result);
    console.log(
      `  ${result.arm.participantId}: ${result.outcome}` +
        `${result.repairUsed ? ' (repair used)' : ''}` +
        `${reported !== null ? ` [reported: ${reported}]` : ''}`,
    );
  }
  console.log('');
  console.log(`records: ${ndjsonPath} (${records.length} lines)`);
  console.log(`summary: ${summaryPath}`);

  if (collision.failures.length > 0) {
    console.error('');
    console.error('!!! RUN FAILED — PROVIDER_COLLISION !!!');
    for (const failure of collision.failures) console.error(`  ${failure}`);
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
      console.error(`error: ${error.message}`);
      console.error('');
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    console.error(describeErrorWithStack(error));
    process.exitCode = 1;
  });
