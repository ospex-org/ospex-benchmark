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
 * `.git` can supply it. Otherwise it is read from git, with a `-dirty` suffix
 * when the tree carries uncommitted changes: a bare sha claims the run is
 * reproducible from that commit, and an edited tree has not earned the claim.
 */
export function resolveBenchmarkCommit(): string | null {
  if (memo !== undefined) return memo;
  const supplied = envValue('BENCHMARK_COMMIT');
  if (supplied !== undefined) return (memo = supplied);
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
