import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * Process-level integration assertions: the real CLI is spawned and its
 * captured stdout/stderr must never contain a planted credential — covering
 * the live API-URL line and the UsageError path, which bypass unit-level
 * seams. No network endpoint is reachable (reserved .invalid hosts), so no
 * real request is ever made.
 */

const SECRET = 'integration-secret-abcdefgh12345678';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function runCli(
  args: string[],
  extraEnv: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/shadowSmoke.ts', ...args],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, ...extraEnv },
    },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('UsageError path: a credential passed as an unknown argument prints redacted', () => {
  const { status, stdout, stderr } = runCli([SECRET], { OPENAI_API_KEY: SECRET });
  assert.equal(status, 2);
  const all = `${stdout}\n${stderr}`;
  assert.ok(!all.includes(SECRET));
  assert.ok(stderr.includes('[REDACTED]'));
  assert.ok(stderr.includes('unknown argument'));
});

test('live API-URL line: a credential embedded in OSPEX_API_URL prints redacted', () => {
  const { status, stdout, stderr } = runCli(['--date', '2026-07-12'], {
    OPENAI_API_KEY: SECRET,
    OSPEX_API_URL: `https://nonexistent-host.invalid/?key=${SECRET}`,
    SUPABASE_URL: 'https://also-nonexistent.invalid',
    SUPABASE_ANON_KEY: 'dummy-anon-key-1234567890',
  });
  const all = `${stdout}\n${stderr}`;
  assert.ok(!all.includes(SECRET));
  assert.ok(stdout.includes('fetching MLB slate'));
  assert.ok(stdout.includes('[REDACTED]'));
  // The unreachable host then fails the fetch: a non-zero, redacted exit.
  assert.notEqual(status, 0);
});

// ---------------------------------------------------------------------------
// B3: the `score` entrypoint must actually self-execute
// ---------------------------------------------------------------------------

/**
 * The script `yarn score` really runs, read from package.json so this test
 * cannot drift from the published entrypoint. If the script is repointed or
 * renamed, this fails rather than silently testing a file nobody invokes.
 */
function scoreEntrypoint(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const script = pkg.scripts?.['score'];
  assert.ok(script !== undefined, 'package.json must define a `score` script');
  const match = /^tsx\s+(\S+\.ts)$/.exec(script);
  assert.ok(match !== null, `expected \`score\` to be "tsx <file>.ts", got: ${script}`);
  return match[1] as string;
}

/**
 * WHY THIS HAS TO BE A CHILD PROCESS, and cannot be an in-process assertion.
 *
 * `scoreRun.ts` self-executes behind an entry-point guard so that importing it
 * (which `scoring.test.ts` does, to drive `runScoreCli`) does not launch a
 * scoring pass. That guard has TWO failure directions and they need different
 * instruments:
 *
 *   always TRUE  — importing the module runs a pass. Caught in-process by
 *                  `scoring.test.ts`, which asserts the import set no exit code.
 *   always FALSE — `yarn score` silently does nothing: exit 0, zero bytes out.
 *                  INVISIBLE to every in-process test, because they call the
 *                  exported `runScoreCli` directly and never go through the
 *                  guard at all. typecheck and the full suite stay green.
 *
 * Only running the file AS A PROCESS ENTRY POINT can see the second one, which
 * is why this exists. Reviewer-reported as B3 after mutating the guard to
 * `if (false)` and watching 1142/1142 still pass.
 */
test('B3: the `score` entrypoint self-executes — a permanently-false entry guard is caught', () => {
  const script = scoreEntrypoint();
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const shown = `status=${String(result.status)}\nstdout=${stdout}\nstderr=${stderr}`;

  // With no --run the CLI must REFUSE, loudly. A disabled guard exits 0 and
  // prints nothing, so each of these three assertions fails on the mutation.
  assert.equal(result.status, 2, `the entrypoint must run and refuse. ${shown}`);
  assert.match(stderr, /error: --run is required/, shown);
  assert.match(stderr, /Usage: yarn score --run/, shown);
});
