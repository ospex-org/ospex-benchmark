import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describeServingStatus, openBenchmarkServing } from './benchmarkServingClient.js';
import { describeErrorWithStack } from './config.js';
import { loadDotEnv } from './env.js';
import { printError, printLine } from './console.js';
import { publishRunArtifact, unpublishedCount } from './servingPublisher.js';
import type { BenchmarkServingHandle } from './benchmarkServingClient.js';
import type { PublishLog, PublishSummary } from './servingPublisher.js';
import type { BenchmarkServingPort } from './servingStore.js';

/**
 * Publish a run artifact that is already on disk.
 *
 * ── WHY THIS IS NOT A ONE-OFF IMPORT TOOL ────────────────────────────────────
 * The publisher cannot fail a run, which means a projection write lost to a
 * network blip is lost quietly. This command is the only thing that gets it
 * back, and it is therefore part of the design rather than a migration aid: the
 * projection is a view of the artifacts, and this is what re-derives the view.
 *
 * It runs the same code the runner does, over the same bytes, so republishing
 * is not a second implementation that has to be kept in step. Every write is
 * idempotent — a row that already landed reports `duplicate` and nothing is
 * altered — so running it twice, or over a whole directory, is safe.
 *
 * It is also how runs that predate the wiring reach the projection, subject to
 * the same gate as a live fire: a run that was a dry run, or that failed its
 * identity check, is refused here too.
 */

const USAGE = `usage: yarn project <run-file.ndjson> [more.ndjson ...]

Publish written run artifacts onto the benchmark serving projection.

Every write is idempotent, so re-running is safe: rows already present are
reported as duplicates and nothing is changed. Runs that were dry runs, used a
synthetic clock, recorded an identity or collision failure, or predate the
projection stamp are skipped with a reason.

Exit codes:
  0  every row in every file is published or already present
  1  publication was attempted and something did not land
  2  usage — no files given, or a named file does not exist
  3  no serving credential is configured, so nothing was attempted
  4  configured, but the publisher was refused (bad connection settings, or a
     schema that cannot yet record what an entrant is)
  5  the command itself failed`;

/**
 * Every way this command can end, named so a test asserts a meaning rather than
 * a number.
 *
 * ⚠ NOT ENABLED IS NOT SUCCESS HERE. This command exists only to publish, so
 *   being unable to publish IS its failure — `yarn project run.ndjson && ...`
 *   must not run the second half when nothing was written. An earlier build
 *   returned 0 for every disabled reason, including a configured publisher held
 *   back by the schema: an operator asked for publication, was refused, and the
 *   shell said it worked.
 *
 * ⚠ THE OPPOSITE IS CORRECT FOR `watch` AND `smoke`. There the projection is a
 *   side effect of a benchmark run, unconfigured is the shipped default, and a
 *   missing credential must never fail a night. Do not carry this rule across.
 *
 * `unconfigured` is kept distinct from `refused` so an automation that treats
 * "publication was never set up on this host" as benign can say so explicitly,
 * without also swallowing "I tried and could not".
 */
export const PROJECT_EXIT = Object.freeze({
  ok: 0,
  publishFailed: 1,
  usage: 2,
  unconfigured: 3,
  refused: 4,
  crashed: 5,
});

/**
 * Everything the command reaches for, injected so every state this function
 * RETURNS is reachable from a unit test. `crashed` is not one of them: it is
 * set by the entry point's own catch, and is pinned as a value instead.
 *
 * An exit-code contract that can only be exercised by spawning a process
 * against a real database is an exit-code contract with one case tested and
 * the rest asserted in prose — and the case that shipped wrong was one of the
 * ones that needed a database to reach.
 */
export interface ProjectMainDeps {
  readonly argv: readonly string[];
  readonly exists: (file: string) => boolean;
  readonly open: () => Promise<BenchmarkServingHandle>;
  readonly publish: (
    port: BenchmarkServingPort,
    runFile: string,
    log: PublishLog,
  ) => Promise<PublishSummary>;
  /**
   * One more publication, ACROSS the files, after every file has been published
   * on its own. Optional and absent on the run path: only the scored path has a
   * write whose grain is wider than one artifact, because
   * `benchmark_scoring_runs` is keyed by cohort while a scored artifact is per
   * run file. Returns the same failure count `unpublishedCount` does, so a
   * cohort row that did not land fails the command exactly like a row that did
   * not — this command exists only to publish.
   *
   * It runs INSIDE the try, so the handle is closed either way, and only after
   * the per-file loop: the coverage row summarises a pass whose rows have just
   * been written, and ordering it first would put the summary before the thing
   * it summarises for no gain.
   */
  readonly finish?: (
    port: BenchmarkServingPort,
    files: readonly string[],
    log: PublishLog,
  ) => Promise<number>;
  readonly log: PublishLog;
}

/** The words that differ between the two publish-only commands. Nothing else
 *  may: they share one exit-code contract, and a shared implementation is what
 *  keeps a case from being lost in one of two hand-written copies. */
export interface ProjectCliWording {
  readonly usage: string;
  /** Names what a missing argument was supposed to be, e.g. `run file`. */
  readonly missingNoun: string;
}

export async function runProjectionCli(
  deps: ProjectMainDeps,
  wording: ProjectCliWording,
): Promise<number> {
  const files = deps.argv.filter((argument) => !argument.startsWith('-'));
  const { line: printLine, error: printError } = deps.log;
  // Asking for help and getting it is not a failure, with or without a file
  // argument beside it. Only an invocation that names no work is a usage error.
  if (deps.argv.includes('--help') || deps.argv.includes('-h')) {
    printLine(wording.usage);
    return PROJECT_EXIT.ok;
  }
  if (files.length === 0) {
    printLine(wording.usage);
    return PROJECT_EXIT.usage;
  }

  const missing = files.filter((file) => !deps.exists(file));
  if (missing.length > 0) {
    printError(`no such ${wording.missingNoun}: ${missing.join(', ')}`);
    return PROJECT_EXIT.usage;
  }

  const serving = await deps.open();
  printLine(describeServingStatus(serving.status));
  if (!serving.status.enabled) {
    await serving.close();
    // Whichever it is, nothing was published, so neither is a success. The two
    // are reported apart because they call for different responses: one is a
    // host that was never set up, the other is a setup that was rejected.
    return serving.status.reason === 'no_credential'
      ? PROJECT_EXIT.unconfigured
      : PROJECT_EXIT.refused;
  }

  let failed = 0;
  try {
    for (const file of files) {
      printLine(`— ${file}`);
      const summary = await deps.publish(serving.port, file, deps.log);
      // The failure taxonomy lives beside the summary type it reads — see
      // `unpublishedCount`. Everything short of full publication counts.
      failed += unpublishedCount(summary, file, deps.log);
    }
    // ONLY WHEN EVERY FILE LANDED IN FULL. The wider-grained write is
    // insert-once, so a row published from a partial pass is the row a read
    // path serves and the correct one can never replace it — a reviewer
    // reproduced exactly that: one refused artifact beside one good one still
    // published a cohort row, with the ranking brake open. A non-zero exit
    // does not undo a durable row, so the guard has to be BEFORE the write.
    if (deps.finish !== undefined) {
      if (failed === 0) {
        failed += await deps.finish(serving.port, files, deps.log);
      } else {
        printError(
          `${failed} file(s) did not publish in full, so nothing wider than a single artifact ` +
            'was written. Fix those and re-run the same command.',
        );
      }
    }
  } finally {
    await serving.close();
  }

  // Unlike a benchmark run, this command exists only to publish — so failing to
  // publish IS its failure. Nothing else in the repo treats a projection
  // problem this way, and nothing else should.
  return failed > 0 ? PROJECT_EXIT.publishFailed : PROJECT_EXIT.ok;
}

export async function runProjectMain(deps: ProjectMainDeps): Promise<number> {
  return runProjectionCli(deps, { usage: USAGE, missingNoun: 'run file' });
}

/** The same guard the other entry points use: importing this module for its
 *  exit-code contract must not run the command. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  loadDotEnv();
  runProjectMain({
    argv: process.argv.slice(2),
    exists: existsSync,
    // A pooled connection can fail with no write in flight; without a sink
    // that failure is absorbed silently, which looks exactly like a database
    // that is working.
    open: () => openBenchmarkServing({ onError: printError }),
    publish: publishRunArtifact,
    log: { line: printLine, error: printError },
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // Distinct from `publishFailed`: that one means rows did not land and
      // the answer is to republish; this one means the command broke and the
      // answer is to read the stack.
      printError(describeErrorWithStack(error));
      process.exitCode = PROJECT_EXIT.crashed;
    });
}
