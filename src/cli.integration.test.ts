import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
