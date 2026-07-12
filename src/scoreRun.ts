import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describeErrorWithStack, envValue } from './config.js';
import { printError, printLine } from './console.js';
import { loadDotEnv } from './env.js';
import { fetchClosingLines } from './fetchers.js';
import { writeNdjson, writeText } from './records.js';
import { buildScorecardMarkdown } from './scorecard.js';
import { aggregateByParticipant, parseRunRecords, scoredRecords, scoreRun } from './scoring.js';

/**
 * ospex-benchmark scorer — joins a shadow run's frozen decisions to the
 * production-captured reference closes and computes reference-closing CLV
 * (docs/AGENT_BENCHMARK.md). Read-only: one NDJSON file in, the public
 * closing-line rows via the anon key, scored NDJSON + a scorecard out.
 * No providers, no chain, no SSE.
 */

class UsageError extends Error {}

const USAGE = `Usage: yarn score --run <path-to-run.ndjson> [options]

Options:
  --run PATH   The harness run file to score (required).
  --out DIR    Output directory. Default: the run file's directory.
  -h, --help   Show this help.

Requires SUPABASE_URL and SUPABASE_ANON_KEY (public read-only anon key);
a local gitignored .env is loaded automatically.`;

interface CliOptions {
  runPath: string;
  outDir: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  let runPath: string | null = null;
  let outDir: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--run':
        runPath = next();
        break;
      case '--out':
        outDir = next();
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
  if (runPath === null) throw new UsageError('--run is required');
  return { runPath, outDir };
}

async function main(): Promise<number> {
  const loaded = loadDotEnv();
  const options = parseArgs(process.argv.slice(2));
  printLine('ospex-benchmark scorer — reference-closing CLV — label SMOKE_V0_NOT_A_COHORT');
  if (loaded.length > 0) {
    printLine(`loaded ${loaded.length} env var(s) from .env: ${loaded.join(', ')}`);
  }

  const supabaseUrl = envValue('SUPABASE_URL');
  const supabaseAnonKey = envValue('SUPABASE_ANON_KEY');
  if (supabaseUrl === undefined || supabaseAnonKey === undefined) {
    throw new UsageError(
      'scoring needs the public read path configured — missing env: ' +
        [
          ...(supabaseUrl === undefined ? ['SUPABASE_URL'] : []),
          ...(supabaseAnonKey === undefined ? ['SUPABASE_ANON_KEY'] : []),
        ].join(', '),
    );
  }

  const run = parseRunRecords(readFileSync(options.runPath, 'utf8').split(/\r?\n/));
  printLine(
    `run ${run.runId}: ${run.games.size} games, ${run.picks.length} picks ` +
      `(${run.picks.filter((p) => p.kind === 'model').length} model, ` +
      `${run.picks.filter((p) => p.kind === 'baseline').length} baseline)`,
  );

  const gameIds = [...run.games.keys()];
  printLine(`fetching captured closes for ${gameIds.length} games ...`);
  const closes = await fetchClosingLines(supabaseUrl, supabaseAnonKey, 'polygon', gameIds);
  printLine(`closes: ${closes.length} market rows found`);

  const scored = scoreRun(run, closes);
  const stats = aggregateByParticipant(scored);
  const scoredAt = new Date().toISOString();

  const outDir = options.outDir ?? dirname(options.runPath);
  const base = basename(options.runPath).replace(/\.ndjson$/, '');
  const ndjsonPath = join(outDir, `${base}-scored.ndjson`);
  const scorecardPath = join(outDir, `${base}-scorecard.md`);
  writeNdjson(ndjsonPath, scoredRecords(run, scored, stats, scoredAt));
  writeText(scorecardPath, buildScorecardMarkdown(run, scored, stats, scoredAt));

  printLine('');
  for (const stat of stats) {
    printLine(
      `  ${stat.participantId} (${stat.kind}): scoreable ${stat.primaryScoreable}/${stat.picks}` +
        `${stat.meanClvPct !== null ? ` · mean CLV ${stat.meanClvPct}%` : ''}` +
        `${stat.beatClosePct !== null ? ` · beat close ${stat.beatClosePct}%` : ''}`,
    );
  }
  printLine('');
  printLine(`scored records: ${ndjsonPath}`);
  printLine(`scorecard: ${scorecardPath}`);

  const totalScoreable = scored.filter((p) => p.result.primaryClvPct !== null).length;
  if (totalScoreable === 0) {
    printLine('');
    printLine(
      'note: nothing was primary-scoreable — if the games have not locked yet, closes do not exist; re-run after the slate locks.',
    );
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
