import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ZodError } from 'zod';
import { describeErrorWithStack, envValue } from './config.js';
import { printError, printLine } from './console.js';
import { loadDotEnv } from './env.js';
import { fetchClosingLines, fetchFirstBoardAppearance } from './fetchers.js';
import { LADDER_VERSION, loadLadderParams } from './ladder.js';
import { writeNdjson, writeText } from './records.js';
import { buildScorecardMarkdown } from './scorecard.js';
import {
  aggregateByParticipant,
  parseCoverageLog,
  parseRunRecords,
  SCORING_POLICY_VERSION,
  scoredRecords,
  scoreRun,
  verifyCoverageBinding,
  verifyRunIntegrity,
  verifyWatchEntryTiming,
} from './scoring.js';

/** The slate-wide published coverage denominator lives beside the run files. */
const COVERAGE_LOG_BASENAME = 'line-open-coverage.ndjson';

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
  --run PATH       The harness run file to score (required).
  --out DIR        Output directory. Default: the run file's directory.
  --coverage PATH  Line-open coverage log to bind a watch run against. Default:
                   ${COVERAGE_LOG_BASENAME} beside the run file. Required for a
                   watch run — the published denominator is bound at scoring.
  -h, --help       Show this help.

Requires SUPABASE_URL and SUPABASE_ANON_KEY (public read-only anon key);
a local gitignored .env is loaded automatically.`;

interface CliOptions {
  runPath: string;
  outDir: string | null;
  coveragePath: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  let runPath: string | null = null;
  let outDir: string | null = null;
  let coveragePath: string | null = null;
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
      case '--coverage':
        coveragePath = next();
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
  return { runPath, outDir, coveragePath };
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

  // Independent entry-timing verification: for a watch run, re-derive each
  // entered market's first board appearance from the append-only odds_history
  // and reconcile the self-reported opener age against it. This is what turns
  // the fire-at-detection claim from self-attested into independently checked;
  // a claimed opener the source log refutes refuses the score.
  if (run.runId.startsWith('watch-v0-')) {
    const timing = await verifyWatchEntryTiming(run, (gameId, market) =>
      fetchFirstBoardAppearance(supabaseUrl, supabaseAnonKey, gameId, market),
    );
    if (timing.violations.length > 0) {
      printError('');
      printError('!!! ENTRY-TIMING VERIFICATION FAILURE — refusing to score !!!');
      for (const violation of timing.violations) printError(`  ${violation}`);
      return 1;
    }
    if (timing.unknown.length > 0) {
      // A market whose opener could not be re-derived is a typed UNKNOWN, never
      // a silent pass: the entry-honesty claim for it is unverifiable, so the
      // run is not scoreable until odds_history is readable for it.
      printError('');
      printError('!!! ENTRY-TIMING UNVERIFIABLE — odds_history did not resolve every entered market !!!');
      for (const u of timing.unknown) printError(`  ${u.market}: ${u.detail}`);
      return 1;
    }
    printLine('entry timing: each entered market\'s opener reconciled against odds_history');

    // Bind the run to the slate-wide published coverage denominator. A silently
    // dropped market produces no run file, so its absence is only detectable
    // against the coverage log — which the scorer must therefore INGEST, not
    // ignore. The log is required for a watch run (it is written beside the run
    // files); a missing log means the denominator was never published.
    const coveragePath = options.coveragePath ?? join(dirname(options.runPath), COVERAGE_LOG_BASENAME);
    if (!existsSync(coveragePath)) {
      printError('');
      printError('!!! COVERAGE DENOMINATOR MISSING — refusing to score !!!');
      printError(
        `  no coverage log at ${coveragePath} — a watch run must be scored alongside its published ` +
          `denominator (${COVERAGE_LOG_BASENAME}); pass --coverage to point at it`,
      );
      return 1;
    }
    const coverage = parseCoverageLog(readFileSync(coveragePath, 'utf8').split(/\r?\n/));
    const coverageViolations = verifyCoverageBinding(run, coverage);
    if (coverageViolations.length > 0) {
      printError('');
      printError('!!! COVERAGE BINDING FAILURE — refusing to score !!!');
      for (const violation of coverageViolations) printError(`  ${violation}`);
      return 1;
    }
    printLine('coverage: scored game bound to the published denominator (fired set consistent)');
  }

  // The published dispersion parameter the totals ladder runs on — loaded
  // from the committed artifact and stamped on every scored record.
  const ladderParams = loadLadderParams();
  printLine(
    `totals ladder: ${LADDER_VERSION} (parameter ${ladderParams.parameterVersion}, ` +
      `k = ${ladderParams.k})`,
  );

  const gameIds = [...run.games.keys()];
  printLine(`fetching captured closes for ${gameIds.length} games ...`);
  const closes = await fetchClosingLines(supabaseUrl, supabaseAnonKey, 'polygon', gameIds);
  printLine(`closes: ${closes.length} market rows found`);

  const scored = scoreRun(run, closes, ladderParams);
  const stats = aggregateByParticipant(scored, run, ladderParams);
  const scoredAt = new Date().toISOString();

  const outDir = options.outDir ?? dirname(options.runPath);
  const base = basename(options.runPath).replace(/\.ndjson$/, '');
  const ndjsonPath = join(outDir, `${base}-scored.ndjson`);
  const scorecardPath = join(outDir, `${base}-scorecard.md`);
  writeNdjson(ndjsonPath, scoredRecords(run, scored, stats, scoredAt, ladderParams));
  writeText(scorecardPath, buildScorecardMarkdown(run, scored, stats, scoredAt, ladderParams));

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
        `${stat.gameLevel.meanClvPct !== null ? ` · econ CLV ${stat.gameLevel.meanClvPct}%` : ''}` +
        `${stat.gameLevelMarginAdjusted.meanClvPct !== null ? ` · margin-adj ${stat.gameLevelMarginAdjusted.meanClvPct}%` : ''}` +
        `${stat.gameLevel.beatClosePct !== null ? ` · econ beat close ${stat.gameLevel.beatClosePct}%` : ''}`,
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
