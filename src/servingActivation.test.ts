import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

/**
 * What the ENTRY POINTS do about publication, measured at the process boundary.
 *
 * Both `yarn watch --dry-run` and `yarn smoke --dry-run` are documented as "no
 * credentials, no network". Publication is the easiest way to break that
 * quietly: `openBenchmarkServing` resolves a credential and dials the database
 * to read a capability row, so a host that happens to have a writer password
 * configured would reach out during a demo, and a broken credential could delay
 * one. Nothing inside the process can see that — a unit test on the entry
 * points would have to be the entry points — so this watches the socket.
 *
 * ⚠ THE NEGATIVE CONTROL IS THE LOAD-BEARING HALF. "Zero connections" is also
 *   what a misconfigured test produces: a DSN the resolver rejected, an
 *   environment the child never saw, a probe on the wrong port. So the same
 *   probe, the same environment and the same resolver are pointed at a command
 *   that publishes unconditionally, and that one MUST connect. Without it this
 *   file would pass with the feature deleted and the wiring removed.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A listener that counts connections and answers nothing. */
async function connectionProbe(): Promise<{ port: number; connections: () => number; stop: () => void }> {
  let count = 0;
  const server = createServer((socket) => {
    count += 1;
    // Destroyed rather than answered: this proves a TCP connection was
    // ATTEMPTED, which is the whole question. A driver that then fails is the
    // expected outcome and the command under control reports it as a refusal.
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'the probe did not bind');
  return {
    port: address.port,
    connections: () => count,
    stop: () => server.close(),
  };
}

/**
 * The child's environment.
 *
 * `BENCHMARK_DB_URL` is the highest-precedence setting the resolver reads, and
 * it points at the probe. The other two are blanked so that even if the DSN
 * were ignored, the derived path could not resolve — `envValue` reads an empty
 * string as unset, and `loadDotEnv` never overwrites a variable that is already
 * defined, so the repo's own .env cannot substitute a real target. Between
 * them, the only endpoint this child can reach is the probe.
 */
function childEnv(port: number): Record<string, string> {
  return {
    BENCHMARK_DB_URL: `postgres://u:p@127.0.0.1:${port}/d?sslmode=disable`,
    BENCHMARK_WRITER: '',
    SUPABASE_URL: '',
  };
}

async function run(
  script: string,
  args: string[],
  port: number,
): Promise<{ status: number | null; out: string }> {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ...childEnv(port) },
  });
  // ⚠ spawnSync BLOCKS THIS EVENT LOOP, so the probe's `connection` events are
  //   still queued when it returns. Reading the count here without yielding
  //   reports zero for every case — which is indistinguishable from the
  //   property under test, and is exactly what the first version of this file
  //   did: both cases "passed" and neither measured anything. The control is
  //   what surfaced it.
  await new Promise<void>((resolve) => { setTimeout(resolve, 250); });
  return { status: result.status, out: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

test('a dry run opens no socket, and the probe proves it would have seen one', async () => {
  const probe = await connectionProbe();
  try {
    // ── the control, first: a command that always publishes ──────────────────
    // Run before the subject so a failure here is unambiguous — it means the
    // harness is wrong, not that the dry run behaved.
    const artifact = join(tempDir('activation-control-'), 'run.ndjson');
    writeFileSync(artifact, '{"type":"run_meta"}\n');
    const control = await run('src/projectRunMain.ts', [artifact], probe.port);
    assert.ok(
      probe.connections() > 0,
      `the control connected ${probe.connections()} times — the probe or the environment is wrong, ` +
        `so a zero below would mean nothing. Output: ${control.out.slice(0, 400)}`,
    );
    const afterControl = probe.connections();

    // ── the subject ──────────────────────────────────────────────────────────
    const dry = await run('src/watchMain.ts', ['--dry-run', '--once'], probe.port);
    assert.equal(
      probe.connections(),
      afterControl,
      `a dry run opened ${probe.connections() - afterControl} connection(s). Output: ${dry.out.slice(0, 600)}`,
    );
    assert.match(dry.out, /serving projection: not opened/);
    // And it still did its job — otherwise "no connections" would be satisfied
    // by a watcher that fell over before reaching the projection at all.
    assert.match(dry.out, /tick .* in window/);
  } finally {
    probe.stop();
  }
});

test('a dry-run smoke opens no socket either', async () => {
  const probe = await connectionProbe();
  try {
    const out = await run('src/shadowSmoke.ts', ['--dry-run', '--out', tempDir('activation-smoke-')], probe.port);
    assert.equal(probe.connections(), 0, `the smoke dry run connected. Output: ${out.out.slice(0, 600)}`);
    assert.match(out.out, /serving projection: not opened/);
    // The control for THIS command: it reached the end and wrote an artifact,
    // so the absence of a connection is a decision rather than an early exit.
    assert.match(out.out, /records: .*\.ndjson/);
  } finally {
    probe.stop();
  }
});
