import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { PROJECT_EXIT, runProjectMain } from './projectRunMain.js';
import type { ProjectMainDeps } from './projectRunMain.js';
import type { ServingStatus } from './benchmarkServingClient.js';
import type { PublishSummary } from './servingPublisher.js';
import type { BenchmarkServingPort } from './servingStore.js';

/**
 * `yarn project`'s exit-code contract, one case per terminal state.
 *
 * It is a contract worth testing exhaustively because it is the only thing an
 * operator's shell can see. The defect it replaced was invisible in every other
 * way: a configured publisher held back by the schema printed a clear line
 * saying so and then exited 0, so `yarn project run.ndjson && ...` ran the
 * second half having published nothing.
 *
 * The enumeration below is exhaustive over `ServingStatus['reason']`, and a
 * test asserts that it stays exhaustive rather than trusting this comment.
 */

const OK_SUMMARY: PublishSummary = {
  published: 12, duplicate: 0, rejected: {}, skipped: [], disabled: false, gateRefusal: null,
};

const PORT = {} as BenchmarkServingPort;

function deps(over: Partial<ProjectMainDeps> & { status?: ServingStatus } = {}): {
  deps: ProjectMainDeps;
  closes: number;
  lines: string[];
} {
  const state = { closes: 0, lines: [] as string[] };
  const status: ServingStatus = over.status ?? { enabled: true };
  const built: ProjectMainDeps = {
    argv: ['run.ndjson'],
    exists: () => true,
    open: async () => ({
      port: PORT,
      status,
      close: async () => { state.closes += 1; },
    }),
    publish: async () => OK_SUMMARY,
    log: {
      line: (message) => state.lines.push(message),
      error: (message) => state.lines.push(`ERROR ${message}`),
    },
    ...over,
  };
  return { deps: built, get closes() { return state.closes; }, lines: state.lines };
}

test('everything published is the only success', async () => {
  const harness = deps();
  assert.equal(await runProjectMain(harness.deps), PROJECT_EXIT.ok);
});

test('rows already present are a success too — that is what recovery looks like', async () => {
  // A republished artifact is expected to be almost entirely duplicates. If
  // that read as failure, the recovery path would report failure every time it
  // worked.
  const harness = deps({
    publish: async () => ({ ...OK_SUMMARY, published: 0, duplicate: 12 }),
  });
  assert.equal(await runProjectMain(harness.deps), PROJECT_EXIT.ok);
});

test('no files, a missing file, and --help are told apart', async () => {
  assert.equal(await runProjectMain(deps({ argv: [] }).deps), PROJECT_EXIT.usage);
  assert.equal(
    await runProjectMain(deps({ argv: ['gone.ndjson'], exists: () => false }).deps),
    PROJECT_EXIT.usage,
  );
  assert.equal(
    await runProjectMain(deps({ argv: ['--help', 'run.ndjson'] }).deps),
    PROJECT_EXIT.ok,
    'asking for help and getting it is not a failure',
  );
});

test('UNCONFIGURED is not success, and is distinct from refused', async () => {
  // The command exists only to publish. `yarn project f.ndjson && deploy` must
  // not deploy when nothing was written — but an automation that genuinely
  // treats "publication was never set up on this host" as benign can still say
  // so, because the code is its own.
  const harness = deps({ status: { enabled: false, reason: 'no_credential' } });
  assert.equal(await runProjectMain(harness.deps), PROJECT_EXIT.unconfigured);
  assert.equal(harness.closes, 1, 'the handle is closed even when nothing was opened');
});

type DisabledReason = Extract<ServingStatus, { enabled: false }>['reason'];

/**
 * Every reason the publisher can decline, and which exit code it earns.
 *
 * A `Record` rather than a list, so ADDING A REASON IS A COMPILE ERROR until
 * someone decides what it means. A list would have let a new reason default to
 * whichever branch it happened to fall through, which is how the schema latch
 * came to return 0 in the first place.
 */
const DISABLED_EXIT: Record<DisabledReason, number> = {
  no_credential: PROJECT_EXIT.unconfigured,
  no_project_url: PROJECT_EXIT.refused,
  malformed_project_url: PROJECT_EXIT.refused,
  malformed_port: PROJECT_EXIT.refused,
  plaintext_dsn: PROJECT_EXIT.refused,
  schema_not_ready: PROJECT_EXIT.refused,
  // The credential was configured and the driver is not installed. Refused, not
  // unconfigured: the operator asked for publication and did not get it.
  driver_unavailable: PROJECT_EXIT.refused,
  // This command never asks for a dry-run handle — publishing is the whole job,
  // so it always opens for real. The entry is here because the table is
  // exhaustive by type rather than by intent, and it is non-zero because every
  // state in it means nothing was written. If it ever appeared in the wild it
  // would be a wiring bug, and exiting 4 is the direction that surfaces one.
  dry_run: PROJECT_EXIT.refused,
};

test('every not-enabled reason has a decided, non-zero exit code', async () => {
  // ⚠ THE REGRESSION THIS FILE EXISTS FOR is `schema_not_ready`: the operator
  //   configured a credential, the publisher connected, and the database could
  //   not record what an entrant is. Nothing was written, and it returned 0.
  for (const [reason, expected] of Object.entries(DISABLED_EXIT) as Array<[DisabledReason, number]>) {
    const harness = deps({ status: { enabled: false, reason } });
    assert.equal(await runProjectMain(harness.deps), expected, `${reason} exits ${expected}`);
    assert.notEqual(expected, PROJECT_EXIT.ok, `${reason} must never read as success`);
    assert.equal(harness.closes, 1, 'the handle is closed even when nothing was opened');
  }
});

test('a gate refusal, an empty publication and a PARTIAL one all fail', async () => {
  // The partial is the dangerous one: it looks like a success to a script and
  // leaves a gap nobody goes looking for. Measured on a real run — 16 rows
  // written, one whole model silently omitted, exit 0.
  for (const [label, summary] of [
    ['gate refusal', { ...OK_SUMMARY, published: 0, gateRefusal: 'not a live run' }],
    ['wrote nothing, found nothing', { ...OK_SUMMARY, published: 0, duplicate: 0 }],
    ['a refused row', { ...OK_SUMMARY, rejected: { contradiction: 1 } }],
    ['a skipped row', { ...OK_SUMMARY, skipped: ['an unenrolled participant'] }],
  ] as const) {
    const harness = deps({ publish: async () => summary });
    assert.equal(
      await runProjectMain(harness.deps),
      PROJECT_EXIT.publishFailed,
      `${label} must reach the exit code`,
    );
    if (label === 'gate refusal') {
      // The MESSAGE, not just the code. A gate refusal that lost its own
      // branch would fall into "wrote nothing and found nothing" and exit 1
      // for the wrong reason with the reason discarded — the exit code alone
      // cannot tell the two apart, and the reason is what the operator acts on.
      assert.ok(
        harness.lines.some((line) => line.includes('nothing was published — not a live run')),
        `the refusal reason reaches the operator: ${harness.lines.join(' | ')}`,
      );
    }
  }
});

test('the handle is closed even when publishing throws', async () => {
  const harness = deps({
    publish: async () => { throw new Error('the publisher exploded'); },
  });
  await assert.rejects(runProjectMain(harness.deps), /exploded/);
  assert.equal(harness.closes, 1, 'the finally runs, so a pool is never left open');
});

test('one bad file among several still fails the whole command', async () => {
  // Every file is attempted — a bad one must not stop the rest from being
  // published — but the exit code reports the worst of them.
  let call = 0;
  const harness = deps({
    argv: ['a.ndjson', 'b.ndjson', 'c.ndjson'],
    publish: async () => {
      call += 1;
      return call === 2 ? { ...OK_SUMMARY, published: 0, gateRefusal: 'a dry run' } : OK_SUMMARY;
    },
  });
  assert.equal(await runProjectMain(harness.deps), PROJECT_EXIT.publishFailed);
  assert.equal(call, 3, 'the third file was still attempted');
});

test('the exit codes are distinct, so a wrapper can tell them apart', () => {
  // A table whose two entries collide reads as a contract and behaves as one
  // value. `crashed` is not reachable from `runProjectMain` — the entry point
  // sets it in its own catch — so it is pinned here as a value.
  const codes = Object.values(PROJECT_EXIT);
  assert.equal(new Set(codes).size, codes.length, `duplicate exit codes: ${codes.join(', ')}`);
  assert.deepEqual(PROJECT_EXIT, {
    ok: 0, publishFailed: 1, usage: 2, unconfigured: 3, refused: 4, crashed: 5,
  });
});

test('the REAL command still runs — the entry guard did not silence it', () => {
  // The guard above is what makes this file importable, and a guard that is
  // wrong turns `yarn project` into a command that exits 0 having done nothing.
  // Nothing in the unit tests above could see that, because they call the
  // function directly. So spawn the binary the way an operator does.
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/projectRunMain.ts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    // No credential, and no file argument: the usage branch, which needs no
    // database and no network.
    env: { ...process.env, BENCHMARK_WRITER: '', BENCHMARK_DB_URL: '' },
  });
  assert.equal(result.status, PROJECT_EXIT.usage,
    `expected the usage exit; stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(result.stdout, /usage: yarn project/);
  // And the codes it documents are the codes it uses.
  assert.match(result.stdout, /^ {2}3 {2}no serving credential is configured/m);
  assert.match(result.stdout, /^ {2}4 {2}configured, but the publisher was refused/m);
});
