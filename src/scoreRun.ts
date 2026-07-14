import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ZodError } from 'zod';
import { describeErrorWithStack, envValue } from './config.js';
import { printError, printLine } from './console.js';
import { loadDotEnv } from './env.js';
import { fetchClosingLines } from './fetchers.js';
import { writeNdjson, writeText } from './records.js';
import { buildScorecardMarkdown } from './scorecard.js';
import {
  aggregateByParticipant,
  parseRunRecords,
  SCORING_POLICY_VERSION,
  scoredRecords,
  scoreRun,
  verifyRunIntegrity,
} from './scoring.js';

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
  printLine(
    `ospex-benchmark scorer — reference-closing CLV — ${SCORING_POLICY_VERSION} — label SMOKE_V0_NOT_A_COHORT`,
  );
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

  let run: ReturnType<typeof parseRunRecords>;
  try {
    run = parseRunRecords(readFileSync(options.runPath, 'utf8').split(/\r?\n/));
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      throw new UsageError(
        `run file does not match the current harness record format` +
          `${issue !== undefined ? ` (${issue.path.join('.')}: ${issue.message})` : ''} — re-generate it with the current harness`,
      );
    }
    throw error;
  }
  printLine(
    `run ${run.runId}: ${run.games.size} games, ${run.armResponses.length} arm-game responses, ` +
      `${run.picks.length} picks (${run.picks.filter((p) => p.kind === 'model').length} model, ` +
      `${run.picks.filter((p) => p.kind === 'baseline').length} baseline)`,
  );

  // A scorecard is only as trustworthy as its input: recomputed hashes,
  // decision echoes, and decision-to-response linkage must all verify, and a
  // run that recorded a hard failure is not scoreable.
  const violations = verifyRunIntegrity(run);
  if (violations.length > 0) {
    printError('');
    printError('!!! RUN INTEGRITY FAILURE — refusing to score !!!');
    for (const violation of violations.slice(0, 20)) printError(`  ${violation}`);
    if (violations.length > 20) printError(`  … ${violations.length - 20} more`);
    return 1;
  }
  printLine('integrity: hashes, decision echoes, and response linkage verified');

  const gameIds = [...run.games.keys()];
  printLine(`fetching captured closes for ${gameIds.length} games ...`);
  const closes = await fetchClosingLines(supabaseUrl, supabaseAnonKey, 'polygon', gameIds);
  printLine(`closes: ${closes.length} market rows found`);

  const scored = scoreRun(run, closes);
  const stats = aggregateByParticipant(scored, run);
  const scoredAt = new Date().toISOString();

  const outDir = options.outDir ?? dirname(options.runPath);
  const base = basename(options.runPath).replace(/\.ndjson$/, '');
  const ndjsonPath = join(outDir, `${base}-scored.ndjson`);
  const scorecardPath = join(outDir, `${base}-scorecard.md`);
  writeNdjson(ndjsonPath, scoredRecords(run, scored, stats, scoredAt));
  writeText(scorecardPath, buildScorecardMarkdown(run, scored, stats, scoredAt));

  printLine('');
  printLine(
    'participant summaries (CLV pooled across each participant\'s markets — context only; cross-participant comparison lives in the scorecard\'s per-market tables):',
  );
  for (const stat of stats) {
    const outcomes = Object.entries(stat.armOutcomes)
      .map(([outcome, count]) => `${outcome} ${count}`)
      .join(' · ');
    printLine(
      `  ${stat.participantId} (${stat.kind}): scoreable ${stat.primaryScoreable}/${stat.eligibleMarkets}` +
        `${outcomes !== '' ? ` [${outcomes}]` : ''}` +
        `${stat.gameLevel.meanClvPct !== null ? ` · game-level mean CLV ${stat.gameLevel.meanClvPct}%` : ''}` +
        `${stat.gameLevel.beatClosePct !== null ? ` · beat close ${stat.gameLevel.beatClosePct}%` : ''}`,
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
