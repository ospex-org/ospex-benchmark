import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { resetBenchmarkCommitForTests, resolveBenchmarkCommit } from './benchmarkCommit.js';

/**
 * `resolveBenchmarkCommit` is on the ARTIFACT path — buildRecords stamps its
 * return value into run_meta, and the serving projection freezes that value on
 * an insert-once run row that carries no UPDATE grant. So the two properties
 * these cases exist for are (1) a value that is not a commit never gets
 * stamped, because a wrong one is permanent where a null is merely honest, and
 * (2) no failure of git can cost a run its artifact.
 */

// Fixtures with digits AND letters throughout, so a build that truncated,
// re-cased, or re-encoded the value cannot land on one of them by accident.
const SHA_ONE = '0f1e2d3c4b5a69788796a5b4c3d2e1f009182736';
const SHA_TWO = '9a8b7c6d5e4f03122334455667788990aabbccdd';

/** How long the fake `git` blocks: comfortably past the 2s bound under test. */
const HANG_MS = 20_000;

function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = saved;
  }
}

/** The repo's real HEAD, or null where this is not a git checkout with git on PATH. */
function realGitHead(): string | null {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

/**
 * Puts a `git` on PATH that blocks for `HANG_MS` instead of answering, and
 * returns the directory holding it. This is what makes the timeout bound
 * OBSERVABLE: without it the only way to exercise "git never returns" would be
 * to assert on the source text of the option, which proves nothing about what
 * the call does.
 *
 * POSIX gets a shell script. Windows has no portable hanging executable, so it
 * gets a copy of the running node binary named `git.exe` plus a preload that
 * blocks the main thread — NODE_OPTIONS is inherited by the child, and the
 * preload runs before node discovers there is no script called `rev-parse`.
 */
function installFakeHangingGit(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ospex-benchmark-fakegit-'));
  if (process.platform === 'win32') {
    const preload = join(dir, 'hang.cjs');
    writeFileSync(
      preload,
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${HANG_MS});\n`,
    );
    copyFileSync(process.execPath, join(dir, 'git.exe'));
    // Unquoted deliberately: NODE_OPTIONS' quote handling strips the backslashes
    // out of a quoted Windows path, which turns the preload into "cannot find
    // module" and the fake into a FAST FAILURE rather than a hang. A directory
    // containing a space cannot be expressed here at all — which is what the
    // liveness probe below is for; the case skips rather than measuring a fake
    // that does not hang.
    process.env['NODE_OPTIONS'] = `--require ${preload}`;
  } else {
    writeFileSync(join(dir, 'git'), `#!/bin/sh\nsleep ${Math.ceil(HANG_MS / 1000)}\n`, {
      mode: 0o755,
    });
  }
  process.env['PATH'] = `${dir}${delimiter}${process.env['PATH'] ?? ''}`;
  return dir;
}

/** Liveness proof for the fake: measured, never assumed. */
function fakeGitHangs(): boolean {
  const started = Date.now();
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 750,
    });
  } catch {
    // Expected — the probe's own bound fires. The elapsed time is the verdict.
  }
  return Date.now() - started >= 600;
}

test('a supplied 40-hex commit is stamped verbatim, and beats whatever git would say', () => {
  const saved = process.env['BENCHMARK_COMMIT'];
  resetBenchmarkCommitForTests();
  try {
    // A synthetic sha that is not this checkout's HEAD, so equality here also
    // proves the environment won rather than the git read happening to agree.
    process.env['BENCHMARK_COMMIT'] = SHA_ONE;
    const resolved = resolveBenchmarkCommit();
    // Exact equality is also the "no `-dirty` appended" assertion: the suffix
    // describes a working copy, and a supplied value is an assertion about a
    // commit, so it is never decorated even when this tree is dirty.
    assert.equal(resolved, SHA_ONE);
    assert.notEqual(resolved, realGitHead());

    // A value exported with surrounding whitespace (a trailing newline out of
    // a shell substitution) is trimmed, not refused for its padding.
    resetBenchmarkCommitForTests();
    process.env['BENCHMARK_COMMIT'] = `  ${SHA_TWO}\n`;
    assert.equal(resolveBenchmarkCommit(), SHA_TWO);
  } finally {
    restoreEnv('BENCHMARK_COMMIT', saved);
    resetBenchmarkCommitForTests();
  }
});

test('a supplied value that cannot be a commit resolves to null, never to itself', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['main', 'a branch name — the motivating case: it would be frozen on an insert-once row'],
    ['HEAD', 'a symbolic ref'],
    [SHA_ONE.slice(0, 39), '39 hex characters — one short, and a boundary rather than an extreme'],
    [`${SHA_ONE}0`, '41 hex characters — one long'],
    [SHA_ONE.toUpperCase(), 'the right sha in the wrong case; the git path never emits uppercase'],
    [`${SHA_ONE.slice(0, 39)}g`, '40 characters, one of them not hex'],
    // `-dirty` is MINTED by the git path, which can see the tree; the
    // environment cannot, so a supplied one is not evidence of anything. The
    // cost of refusing it is a null provenance pointer, which is advisory.
    [`${SHA_ONE}-dirty`, 'a git-path suffix supplied from outside'],
    ['0x' + SHA_ONE.slice(2), 'hex-prefixed'],
  ];
  const saved = process.env['BENCHMARK_COMMIT'];
  try {
    for (const [value, why] of cases) {
      resetBenchmarkCommitForTests();
      process.env['BENCHMARK_COMMIT'] = value;
      assert.equal(resolveBenchmarkCommit(), null, `${JSON.stringify(value)}: ${why}`);
    }
  } finally {
    restoreEnv('BENCHMARK_COMMIT', saved);
    resetBenchmarkCommitForTests();
  }
});

test('the resolved value is memoized, and the test seam is what re-reads it', () => {
  const saved = process.env['BENCHMARK_COMMIT'];
  resetBenchmarkCommitForTests();
  try {
    process.env['BENCHMARK_COMMIT'] = SHA_ONE;
    assert.equal(resolveBenchmarkCommit(), SHA_ONE);

    // The environment moves underneath it: a long-lived `yarn watch` loop must
    // not re-shell per run, so the first answer stands.
    process.env['BENCHMARK_COMMIT'] = SHA_TWO;
    assert.equal(resolveBenchmarkCommit(), SHA_ONE, 'memoized, not re-read');

    resetBenchmarkCommitForTests();
    assert.equal(resolveBenchmarkCommit(), SHA_TWO, 'the seam clears the memo');

    // A resolved NULL is memoized too. This is the discriminating half: a memo
    // guarded on truthiness rather than on `undefined` would re-shell out on
    // every call for the whole run after one failure, and would pass every
    // assertion above.
    resetBenchmarkCommitForTests();
    process.env['BENCHMARK_COMMIT'] = 'main';
    assert.equal(resolveBenchmarkCommit(), null);
    process.env['BENCHMARK_COMMIT'] = SHA_TWO;
    assert.equal(resolveBenchmarkCommit(), null, 'a null answer is an answer, and it is kept');
  } finally {
    restoreEnv('BENCHMARK_COMMIT', saved);
    resetBenchmarkCommitForTests();
  }
});

test('git being unavailable resolves to null instead of throwing out of buildRecords', () => {
  const savedPath = process.env['PATH'];
  const savedCommit = process.env['BENCHMARK_COMMIT'];
  resetBenchmarkCommitForTests();
  try {
    delete process.env['BENCHMARK_COMMIT'];
    // An empty PATH makes the spawn itself fail (ENOENT) — the "no git, or no
    // permission to spawn one" arm of the advisory contract.
    process.env['PATH'] = '';
    assert.equal(resolveBenchmarkCommit(), null);
  } finally {
    restoreEnv('PATH', savedPath);
    restoreEnv('BENCHMARK_COMMIT', savedCommit);
    resetBenchmarkCommitForTests();
  }
});

test('with git present it reads the real HEAD — the control that keeps the null cases honest', (t) => {
  const head = realGitHead();
  if (head === null) {
    t.skip('not a git checkout with git on PATH, so there is no real HEAD to read');
    return;
  }
  const saved = process.env['BENCHMARK_COMMIT'];
  resetBenchmarkCommitForTests();
  try {
    delete process.env['BENCHMARK_COMMIT'];
    const resolved = resolveBenchmarkCommit();
    assert.equal(typeof resolved, 'string');
    // The real sha, plus the suffix iff this working copy is dirty. Asserting
    // the sha (not just the shape) is what proves the value came from the
    // repository rather than from anywhere else.
    assert.match(resolved as string, /^[0-9a-f]{40}(-dirty)?$/);
    assert.equal((resolved as string).slice(0, 40), head);

    // An empty/whitespace-only setting is not a supplied value; it falls
    // through to git rather than freezing an empty string on the row.
    resetBenchmarkCommitForTests();
    process.env['BENCHMARK_COMMIT'] = '   ';
    assert.equal(resolveBenchmarkCommit(), resolved);
  } finally {
    restoreEnv('BENCHMARK_COMMIT', saved);
    resetBenchmarkCommitForTests();
  }
});

test('a git that never answers is bounded, so a benchmark night is not lost to it', (t) => {
  const savedPath = process.env['PATH'];
  const savedNodeOptions = process.env['NODE_OPTIONS'];
  const savedCommit = process.env['BENCHMARK_COMMIT'];
  resetBenchmarkCommitForTests();
  const dir = installFakeHangingGit();
  try {
    delete process.env['BENCHMARK_COMMIT'];
    if (!fakeGitHangs()) {
      t.skip('the fake `git` returned promptly on this host, so this case cannot measure the bound');
      return;
    }
    const started = Date.now();
    const resolved = resolveBenchmarkCommit();
    const elapsed = Date.now() - started;
    assert.equal(resolved, null, 'a git that never answers is the advisory outcome, not a throw');
    // The load-bearing half. Drop the timeout from the execFileSync options and
    // this waits out the fake's full hang instead, which is the production
    // failure being guarded: buildRecords held open for as long as git blocks.
    assert.ok(
      elapsed < 8_000,
      `bounded by the 2s timeout rather than the fake's ${HANG_MS}ms hang (took ${elapsed}ms)`,
    );
  } finally {
    restoreEnv('PATH', savedPath);
    restoreEnv('NODE_OPTIONS', savedNodeOptions);
    restoreEnv('BENCHMARK_COMMIT', savedCommit);
    resetBenchmarkCommitForTests();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A temp directory the just-killed child still holds open is harmless.
    }
  }
});
