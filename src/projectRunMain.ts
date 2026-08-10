import { existsSync } from 'node:fs';
import { describeServingStatus, openBenchmarkServing } from './benchmarkServingClient.js';
import { describeErrorWithStack } from './config.js';
import { loadDotEnv } from './env.js';
import { printError, printLine } from './console.js';
import { publishRunArtifact } from './servingPublisher.js';

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

With no serving credential configured the publisher is disabled and this
command reports that and writes nothing.`;

async function main(): Promise<number> {
  loadDotEnv();
  const files = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
  if (process.argv.includes('--help') || process.argv.includes('-h') || files.length === 0) {
    printLine(USAGE);
    return files.length === 0 ? 2 : 0;
  }

  const missing = files.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    printError(`no such run file: ${missing.join(', ')}`);
    return 2;
  }

  const serving = await openBenchmarkServing();
  printLine(describeServingStatus(serving.status));
  if (!serving.status.enabled) {
    await serving.close();
    // Not an error: unconfigured is the publisher's normal state, and an
    // operator who has not set a credential has not failed at anything.
    return 0;
  }

  let failed = 0;
  try {
    for (const file of files) {
      printLine(`— ${file}`);
      const summary = await publishRunArtifact(serving.port, file, {
        line: printLine,
        error: printError,
      });
      // Two ways this command fails, and BOTH have to reach the exit code.
      //
      // A row the projection refused is the obvious one. The other is a file
      // the gate turned away — a dry run, a failed identity check, an artifact
      // that does not pass its own integrity check. That path writes nothing
      // and previously reported nothing, so an operator recovering a night's
      // runs from a script saw `exit 0` over a batch that published not one
      // row. Silence on the second is worse than on the first, because a
      // refusal at least printed a SQLSTATE.
      failed += Object.values(summary.rejected).reduce((total, count) => total + count, 0);
      if (summary.gateRefusal !== null) {
        printError(`${file}: nothing was published — ${summary.gateRefusal}`);
        failed += 1;
      }
    }
  } finally {
    await serving.close();
  }

  // Unlike a benchmark run, this command exists only to publish — so failing to
  // publish IS its failure. Nothing else in the repo treats a projection
  // problem this way, and nothing else should.
  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    printError(describeErrorWithStack(error));
    process.exitCode = 1;
  });
