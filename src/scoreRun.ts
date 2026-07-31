import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ZodError } from 'zod';
import { describeErrorWithStack, envValue } from './config.js';
import { printError as printErrorImpl, printLine as printLineImpl } from './console.js';
import { loadDotEnv } from './env.js';
import { fetchClosingLines } from './fetchers.js';
import { LADDER_VERSION, loadLadderParams } from './ladder.js';
import { writeNdjson, writeText } from './records.js';
import { buildScorecardMarkdown } from './scorecard.js';
import {
  aggregateByParticipant,
  emptyPrimaryEstimateNote,
  parseRunRecords,
  SCORING_POLICY_VERSION,
  scoredRecords,
  scoreRun,
  verifyRunIntegrity,
} from './scoring.js';
import type { ExpectedArm } from './scoring.js';

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

function parseArgs(argv: string[], printLine: (line: string) => void): CliOptions {
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

/**
 * The seams a test needs to drive this CLI without network. Deliberately
 * MINIMAL: only the network read and the two output sinks are injectable.
 *
 * Everything else — argument parsing, run-file read, integrity verification,
 * ladder load, scoring, aggregation, artifact writes AND the summary block —
 * stays real, because the point of the wiring test is to exercise THIS
 * function's code rather than a cooperating rehearsal of it. Injecting the
 * scorer or the summary helper would recreate exactly the gap the test exists
 * to close: a fake above the defect cannot go red when the defect returns.
 */
export interface ScoreCliDeps {
  fetchCloses: typeof fetchClosingLines;
  printLine: (line: string) => void;
  printError: (line: string) => void;
  /**
   * WHICH frozen arm manifest integrity verifies against — never WHETHER it
   * verifies. Undefined (production) means `defaultExpectedArms()`, exactly as
   * before. A test supplies its fixture's arms so the run reaches the summary
   * block; `verifyRunIntegrity` still runs in full, and a fixture that fails it
   * for any other reason still returns 1.
   */
  expectedArms?: ExpectedArm[];
}

const DEFAULT_DEPS: ScoreCliDeps = {
  fetchCloses: fetchClosingLines,
  printLine: printLineImpl,
  printError: printErrorImpl,
};

export async function runScoreCli(
  argv: string[],
  deps: ScoreCliDeps = DEFAULT_DEPS,
): Promise<number> {
  const { fetchCloses, printLine, printError } = deps;
  const loaded = loadDotEnv();
  const options = parseArgs(argv, printLine);
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
  const violations = verifyRunIntegrity(
    run,
    deps.expectedArms === undefined ? undefined : { expectedArms: deps.expectedArms },
  );
  if (violations.length > 0) {
    printError('');
    printError('!!! RUN INTEGRITY FAILURE — refusing to score !!!');
    for (const violation of violations.slice(0, 20)) printError(`  ${violation}`);
    if (violations.length > 20) printError(`  … ${violations.length - 20} more`);
    return 1;
  }
  printLine('integrity: hashes, decision echoes, and response linkage verified');

  // The published dispersion parameter the totals ladder runs on — loaded
  // from the committed artifact and stamped on every scored record.
  const ladderParams = loadLadderParams();
  printLine(
    `totals ladder: ${LADDER_VERSION} (parameter ${ladderParams.parameterVersion}, ` +
      `k = ${ladderParams.k})`,
  );

  const gameIds = [...run.games.keys()];
  printLine(`fetching captured closes for ${gameIds.length} games ...`);
  const closes = await fetchCloses(supabaseUrl, supabaseAnonKey, 'polygon', gameIds);
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

  // BOTH THE PREDICATE AND THE WORDING LIVE IN scoring.ts, next to the
  // definitions they depend on. Counting only "carries a value" here made this
  // note disagree with the per-participant lines printed a few rows earlier: in
  // a run where every scored pick is schedule-tagged, those lines read
  // `scoreable 0/N` while the note explaining a zero never fired, because the
  // tagged picks still carried values. null means there is nothing to explain.
  const note = emptyPrimaryEstimateNote(scored);
  if (note !== null) {
    printLine('');
    printLine(note);
  }
  return 0;
}

/**
 * Self-execute ONLY when this file is the process entry point.
 *
 * Without the guard, importing the module to test `runScoreCli` would also run
 * a real scoring pass on `process.argv` at import time. `yarn score` is
 * unaffected — it invokes this file directly, so the comparison holds and the
 * CLI still runs on import-as-entry exactly as before. `scoring.test.ts` pins
 * both halves: that importing the module does NOT run a pass, and that
 * `yarn score` still reaches the summary block.
 */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  runScoreCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof UsageError) {
        printErrorImpl(`error: ${error.message}`);
        printErrorImpl('');
        printErrorImpl(USAGE);
        process.exitCode = 2;
        return;
      }
      printErrorImpl(describeErrorWithStack(error));
      process.exitCode = 1;
    });
}
