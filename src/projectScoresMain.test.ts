import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { PROJECT_EXIT } from './projectRunMain.js';
import { runProjectScoresMain } from './projectScoresMain.js';
import type { ProjectMainDeps } from './projectRunMain.js';
import type { ServingStatus } from './benchmarkServingClient.js';
import type { PublishSummary } from './servingPublisher.js';
import type { BenchmarkServingPort } from './servingStore.js';

/**
 * `yarn project:scores` shares `yarn project`'s exit-code contract through one
 * implementation (`runProjectionCli`), and `projectRunMain.test.ts` pins that
 * contract exhaustively — every disabled reason, every failure shape, the
 * distinctness of the codes. Re-pinning all of it here would be a second copy
 * of the table, which is the drift this design exists to avoid.
 *
 * What THIS file pins is what is genuinely this command's own: that it speaks
 * the shared contract at all (one case per terminal family), and its entry
 * point — the usage text, the exit code an operator's shell sees, and the
 * wording that tells scored artifacts apart from run files.
 */

const OK_SUMMARY: PublishSummary = {
  published: 9, duplicate: 0, rejected: {}, skipped: [], disabled: false, gateRefusal: null,
};

function deps(over: Partial<ProjectMainDeps> & { status?: ServingStatus } = {}): ProjectMainDeps {
  const status: ServingStatus = over.status ?? { enabled: true };
  return {
    argv: ['run-1-scored.ndjson'],
    exists: () => true,
    open: async () => ({ port: {} as BenchmarkServingPort, status, close: async () => {} }),
    publish: async () => OK_SUMMARY,
    log: { line: () => {}, error: () => {} },
    ...over,
  };
}

test('the shared contract holds: one case per terminal family', async () => {
  assert.equal(await runProjectScoresMain(deps()), PROJECT_EXIT.ok);
  assert.equal(
    await runProjectScoresMain(deps({ publish: async () => ({ ...OK_SUMMARY, published: 0, duplicate: 9 }) })),
    PROJECT_EXIT.ok,
    'a republished artifact is almost entirely duplicates, and that is recovery working',
  );
  assert.equal(await runProjectScoresMain(deps({ argv: [] })), PROJECT_EXIT.usage);
  assert.equal(
    await runProjectScoresMain(deps({ argv: ['gone.ndjson'], exists: () => false })),
    PROJECT_EXIT.usage,
  );
  assert.equal(
    await runProjectScoresMain(deps({ status: { enabled: false, reason: 'no_credential' } })),
    PROJECT_EXIT.unconfigured,
  );
  // The reason this command exists to distinguish: a configured publisher held
  // back by a pre-label schema must not read as "publication was never set up".
  assert.equal(
    await runProjectScoresMain(deps({ status: { enabled: false, reason: 'schema_not_ready', requiredCapability: 3 } })),
    PROJECT_EXIT.refused,
  );
  assert.equal(
    await runProjectScoresMain(deps({ publish: async () => ({ ...OK_SUMMARY, published: 0, gateRefusal: 'not a live run' }) })),
    PROJECT_EXIT.publishFailed,
  );
  assert.equal(
    await runProjectScoresMain(deps({ publish: async () => ({ ...OK_SUMMARY, skipped: ['abandoned at the deadline'] }) })),
    PROJECT_EXIT.publishFailed,
    'a PARTIAL publication is the dangerous one — it looks like success to a script',
  );
});

test('the missing-file wording names a scored artifact, not a run file', async () => {
  const lines: string[] = [];
  await runProjectScoresMain(deps({
    argv: ['gone-scored.ndjson'],
    exists: () => false,
    log: { line: (m) => lines.push(m), error: (m) => lines.push(m) },
  }));
  assert.match(lines.join('\n'), /no such scored artifact: gone-scored\.ndjson/);
});

test('the REAL command still runs — the entry guard did not silence it', () => {
  // The guard is what makes this file importable; a wrong guard turns
  // `yarn project:scores` into a command that exits 0 having done nothing.
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/projectScoresMain.ts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    // No credential and no file argument: the usage branch, which needs no
    // database and no network.
    env: { ...process.env, BENCHMARK_WRITER: '', BENCHMARK_DB_URL: '' },
  });
  assert.equal(result.status, PROJECT_EXIT.usage,
    `expected the usage exit; stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(result.stdout, /usage: yarn project:scores/);
  // The contract it documents is the contract it uses, and the parts of the
  // usage that carry operator-load-bearing facts are present: the codes, the
  // publish-run-first ordering, and the re-score recovery.
  assert.match(result.stdout, /^ {2}3 {2}no serving credential is configured/m);
  assert.match(result.stdout, /^ {2}4 {2}configured, but the publisher was refused/m);
  assert.match(result.stdout, /parent_missing/);
  assert.match(result.stdout, /re-score the run file/);
});
