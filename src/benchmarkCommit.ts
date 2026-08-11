import { execFileSync } from 'node:child_process';
import { envValue } from './config.js';

/**
 * Which build produced a run, stamped into the artifact.
 *
 * ── WHY IT IS STAMPED RATHER THAN RESOLVED WHEN PUBLISHING ───────────────────
 * The serving projection compares this value against the stored run row on
 * every later write, and a disagreement drops the whole write — the child row
 * included — rather than correcting anything. Resolving it at publish time
 * would therefore mean that re-publishing a run from its artifact after a
 * commit, or from a working tree with one edit in it, silently loses every
 * decision it was trying to recover. Reading it back out of the artifact makes
 * the recovery path identical to the original write by construction.
 *
 * ── ADVISORY BY CONSTRUCTION ─────────────────────────────────────────────────
 * A benchmark night must not be lost because `git` is absent, the run is from a
 * tarball, or the process has no permission to spawn. Every failure path
 * returns null, and a null costs nothing but a provenance pointer.
 */

/** Resolved once: `yarn watch` is a long-lived loop and this shells out. */
let memo: string | null | undefined;

const SHA = /^[0-9a-f]{40}$/;

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], {
    encoding: 'utf8',
    // BOUNDED, because this now runs on the artifact path: buildRecords calls
    // it while assembling run_meta, so a `git` that never returns holds the
    // whole run open instead of costing it a provenance pointer — and the
    // things that make `git` never return are ordinary (a working copy on a
    // network filesystem, an index.lock left by a killed process, a credential
    // helper prompting on a stdin nobody will answer). Two seconds is far past
    // any local rev-parse and far below what a benchmark night can wait. The
    // bound raises, which the caller already treats as "cannot be established",
    // so a timeout lands on the documented advisory outcome: null.
    timeout: 2_000,
    // The child's stderr is discarded rather than inherited: outside a
    // repository `git` writes a fatal to it, which would otherwise land in the
    // middle of a run's console output looking like a benchmark failure.
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * The commit this build came from, or null when it cannot be established.
 *
 * `BENCHMARK_COMMIT` wins, so a container or CI job that has the sha but no
 * `.git` can supply it — held to the same 40-hex shape as the git-read value,
 * and resolving to null when it is anything else. Otherwise it is read from
 * git, with a `-dirty` suffix when the tree carries uncommitted changes: a bare
 * sha claims the run is reproducible from that commit, and an edited tree has
 * not earned the claim.
 */
export function resolveBenchmarkCommit(): string | null {
  if (memo !== undefined) return memo;
  const supplied = envValue('BENCHMARK_COMMIT');
  if (supplied !== undefined) {
    // Refused rather than corrected. A value that cannot be a commit is worse
    // than no value at all: the run row it lands on is insert-once with no
    // UPDATE grant, so `BENCHMARK_COMMIT=main` would be frozen — on every
    // artifact stamped while it was set — where a null is merely honest.
    //
    // No `-dirty` suffix is ever appended to a supplied value: the caller is
    // asserting a specific commit, and the environment cannot see whether the
    // tree beside it (if there is one) has been edited.
    return (memo = SHA.test(supplied) ? supplied : null);
  }
  try {
    const head = git(['rev-parse', 'HEAD']);
    if (!SHA.test(head)) return (memo = null);
    return (memo = git(['status', '--porcelain']) === '' ? head : `${head}-dirty`);
  } catch {
    return (memo = null);
  }
}

/** Test seam: forget the memo so a case can vary the environment. */
export function resetBenchmarkCommitForTests(): void {
  memo = undefined;
}
