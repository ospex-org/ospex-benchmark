import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  openBenchmarkServing,
  SCORES_SERVING_CAPABILITY,
} from './benchmarkServingClient.js';
import { describeErrorWithStack } from './config.js';
import { loadDotEnv } from './env.js';
import { printError, printLine } from './console.js';
import { PROJECT_EXIT, runProjectionCli } from './projectRunMain.js';
import { RANKING_WITHHELD } from './scoredProjection.js';
import type { RankingDecision } from './scoredProjection.js';
import { publishScoredArtifact, scoredPublication } from './servingPublisher.js';
import type { ProjectMainDeps } from './projectRunMain.js';
import type { PublishLog } from './servingPublisher.js';
import type { BenchmarkServingPort } from './servingStore.js';

/**
 * Publish a scored artifact that is already on disk.
 *
 * The scored sibling of `yarn project`, sharing its exit-code contract through
 * `runProjectionCli` — one implementation, so a case cannot be lost in a
 * second hand-written copy. Like `yarn project` it is not a one-off import
 * tool: `publishScore` is fail-soft, so a score lost to a network blip is lost
 * quietly, and this command is what gets it back. Every write is idempotent —
 * a row already present reports `duplicate` — so re-running it, or running it
 * over every scored file in a directory, is safe.
 *
 * It takes the SCORED file (`<runId>-scored.ndjson`), not the run file: the
 * projection is a view of the scorer's artifact, and republishing must be the
 * same call on the same bytes as the first publish. Scores land against
 * decisions the run publisher already sealed — a score whose decision was
 * never published reports `parent_missing`, and the recovery is `yarn project
 * <run file>` first.
 */

const USAGE = `usage: yarn project:scores [--scoring-run] <run-scored.ndjson> [more ...]

Publish written scored artifacts (the output of \`yarn score\`) onto the
benchmark serving projection as benchmark_scores rows.

Every write is idempotent, so re-running is safe: rows already present are
reported as duplicates and nothing is changed. Scored files from dry runs,
from cohorts outside the published namespace, or in a format older than the
current scorer are skipped with a reason — re-score the run file with the
current scorer to regenerate them.

A score lands against the decision row \`yarn project\` published for the same
run; publish the run artifact first or every row reports parent_missing.

  --scoring-run
      Additionally publish the cohort's benchmark_scoring_runs row: its
      coverage counts and its ranking brake, one row per cohort found among
      the files given. OPT-IN, because that row is keyed by COHORT while a
      scored artifact is per run file — a watch cohort is a date with one
      artifact per fired game — so only the caller knows whether the files
      it named are the whole cohort. Pass every one of that cohort's scored
      artifacts. The row is insert-once, so it is all-or-nothing: nothing is
      written unless every named artifact passes the gate and every one of
      them publishes its scores in full. The counts are printed before the
      write so they can be checked.

  --ranking-allowed
      Publish that row with ranking_allowed = true. The default is FALSE —
      the gate stays closed until the operator opens it deliberately — and
      the value cannot be changed afterwards by republishing, because the row
      has no UPDATE grant behind it.

  --ranking-reason=<text>
      The reason stored beside it. Defaults to the withheld wording. Spelled
      with an equals sign because a bare value would be read as another file.

Exit codes:
  0  every row in every file is published or already present
  1  publication was attempted and something did not land
  2  usage — no files given, or a named file does not exist
  3  no serving credential is configured, so nothing was attempted
  4  configured, but the publisher was refused (bad connection settings, or a
     schema that cannot yet record the score label)
  5  the command itself failed`;

/**
 * The ranking brake an invocation carries, read off the command line.
 *
 * Exported for its own test: `ranking_allowed` is the field a public read path
 * uses to decide whether a leaderboard may be ordered at all, the row it lands
 * on is insert-once, and the default has to be the closed one whatever the
 * argument parsing does.
 */
export function rankingDecisionFrom(argv: readonly string[]): RankingDecision {
  const supplied = argv.find((argument) => argument.startsWith('--ranking-reason='));
  const reason =
    supplied === undefined ? RANKING_WITHHELD.reason : supplied.slice('--ranking-reason='.length);
  return {
    allowed: argv.includes('--ranking-allowed'),
    // An empty --ranking-reason= would land as '' in a NOT NULL column that
    // exists to explain the brake. Falls back rather than refusing: the value
    // that matters is `allowed`, and losing the whole publication over a typo
    // in prose would be the tail wagging the dog.
    reason: reason === '' ? RANKING_WITHHELD.reason : reason,
  };
}

export async function runProjectScoresMain(deps: ProjectMainDeps): Promise<number> {
  return runProjectionCli(deps, { usage: USAGE, missingNoun: 'scored artifact' });
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
  // ONE reading of the arguments, shared by the deps and by the flags below.
  // Two `process.argv` reads would differ by the interpreter and script paths,
  // which is a way for a flag to be seen in one place and not the other.
  const argv = process.argv.slice(2);
  const session = scoredPublication(rankingDecisionFrom(argv));
  runProjectScoresMain({
    argv,
    exists: existsSync,
    // The scores statement names the label column, which only capability 3
    // schemas hold. Asking for it here turns "every write refuses with a
    // SQLSTATE" into one HELD line naming the migration state.
    open: () =>
      openBenchmarkServing({
        onError: printError,
        requiredCapability: SCORES_SERVING_CAPABILITY,
      }),
    // Only when asked. Absent, this command behaves exactly as it did: the
    // cohort row is a wider-grained, operator-decided write and it does not
    // ride along with publishing one artifact's scores.
    //
    // When it IS asked for, both phases run off ONE session so they share a
    // single parse of each artifact — the per-file scores and the cohort row
    // then describe the same bytes by construction rather than by two reads
    // agreeing. Spread rather than `: undefined`, because
    // `exactOptionalPropertyTypes` distinguishes an absent optional property
    // from one explicitly set to undefined, and the run path's contract is
    // that the key is ABSENT.
    ...(argv.includes('--scoring-run')
      ? { publish: session.publishFile, finish: session.publishCohorts }
      : { publish: publishScoredArtifact }),
    log: { line: printLine, error: printError },
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      printError(describeErrorWithStack(error));
      process.exitCode = PROJECT_EXIT.crashed;
    });
}
