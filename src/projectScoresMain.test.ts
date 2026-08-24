import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { PROJECT_EXIT } from './projectRunMain.js';
import { rankingDecisionFrom, runProjectScoresMain } from './projectScoresMain.js';
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
  assert.match(result.stdout, /^ {2}5 {2}the command itself failed/m);
  assert.match(result.stdout, /parent_missing/);
  assert.match(result.stdout, /re-score the run file/);
});

// ---------------------------------------------------------------------------
// The cohort scoring run, which is opt-in
// ---------------------------------------------------------------------------

test('the ranking brake defaults to CLOSED, whatever the argument parsing does', () => {
  // `ranking_allowed` decides whether a public read path may order a
  // leaderboard at all, and the row it lands on is insert-once. The default has
  // to be the closed one — an argv this parser does not understand must leave
  // the gate shut rather than open it.
  assert.deepEqual(rankingDecisionFrom([]), {
    allowed: false,
    reason: 'label: watch-v0 pending operator publication decision',
  });
  assert.deepEqual(rankingDecisionFrom(['a-scored.ndjson', '--scoring-run', '--nonsense']), {
    allowed: false,
    reason: 'label: watch-v0 pending operator publication decision',
  });
  // Opened only by the exact flag, and the reason travels with it.
  assert.deepEqual(
    rankingDecisionFrom(['--ranking-allowed', '--ranking-reason=n is adequate at 240 picks']),
    { allowed: true, reason: 'n is adequate at 240 picks' },
  );
  // The reason overrides on its own, with the gate still shut.
  assert.deepEqual(rankingDecisionFrom(['--ranking-reason=awaiting the operator']), {
    allowed: false,
    reason: 'awaiting the operator',
  });
  // An empty value would land as '' in a NOT NULL column that exists to
  // explain the brake, so it falls back rather than storing nothing.
  assert.equal(rankingDecisionFrom(['--ranking-reason=']).reason, rankingDecisionFrom([]).reason);
  // ...and a value that merely CONTAINS the flag name is not the flag. This is
  // what stops a reason mentioning `--ranking-allowed` from opening the gate.
  assert.equal(rankingDecisionFrom(['--ranking-reason=see --ranking-allowed below']).allowed, false);
});

test('the cohort pass runs after the per-file loop and its failures reach the exit code', async () => {
  // `finish` is how the wider-grained write reaches the shared CLI, and both
  // halves need pinning: it must run with EVERY file the command was given
  // (the row is a sum across them), and a failure there must fail the command
  // exactly like a per-file failure — this command exists only to publish.
  const seen: string[][] = [];
  assert.equal(
    await runProjectScoresMain(
      deps({
        argv: ['a-scored.ndjson', 'b-scored.ndjson', '--scoring-run'],
        finish: async (_port, files) => {
          seen.push([...files]);
          return 0;
        },
      }),
    ),
    PROJECT_EXIT.ok,
  );
  assert.deepEqual(seen, [['a-scored.ndjson', 'b-scored.ndjson']], 'every file, once, together');

  assert.equal(
    await runProjectScoresMain(
      deps({ argv: ['a-scored.ndjson'], finish: async () => 1 }),
    ),
    PROJECT_EXIT.publishFailed,
    'a cohort row that did not land must fail the command',
  );
  // NEGATIVE CONTROL: without the hook the command behaves exactly as before,
  // so the opt-in is real rather than a flag that changes nothing.
  assert.equal(await runProjectScoresMain(deps({ argv: ['a-scored.ndjson'] })), PROJECT_EXIT.ok);
});

test('the cohort pass is skipped entirely when the publisher was never enabled', async () => {
  // It runs inside the same guard as the per-file loop: an unconfigured host
  // must not reach a write, and the exit code stays the one that says so.
  let ran = false;
  assert.equal(
    await runProjectScoresMain(
      deps({
        argv: ['a-scored.ndjson', '--scoring-run'],
        status: { enabled: false, reason: 'no_credential' },
        finish: async () => {
          ran = true;
          return 0;
        },
      }),
    ),
    PROJECT_EXIT.unconfigured,
  );
  assert.equal(ran, false, 'nothing may be attempted against a publisher that was never opened');
});

test('a file that did not publish in full STOPS the cohort row being written at all', async () => {
  // The row is insert-once, so a non-zero exit does not undo it: whatever a
  // partial pass wrote is what a read path serves, permanently, and the correct
  // set is then refused as a contradiction against it. The guard therefore has
  // to sit BEFORE the write rather than in the exit code after it.
  //
  // Every shape `unpublishedCount` counts as short of full publication, one at
  // a time — a gate refusal, a rejected row, a skipped row, and a publisher
  // that wrote nothing at all — because each reaches the guard through a
  // different field of the summary and one case would leave the rest free.
  const partials: ReadonlyArray<readonly [string, PublishSummary]> = [
    ['gate refusal', { ...OK_SUMMARY, published: 0, gateRefusal: 'not a live run' }],
    ['a rejected row', { ...OK_SUMMARY, rejected: { contradiction: 1 } }],
    ['a skipped row', { ...OK_SUMMARY, skipped: ['abandoned at the deadline'] }],
    ['nothing written', { ...OK_SUMMARY, published: 0, duplicate: 0 }],
  ];
  for (const [label, summary] of partials) {
    let ran = false;
    const code = await runProjectScoresMain(
      deps({
        argv: ['a-scored.ndjson', '--scoring-run'],
        publish: async () => summary,
        finish: async () => {
          ran = true;
          return 0;
        },
      }),
    );
    assert.equal(ran, false, `${label}: the cohort row must not be attempted`);
    assert.equal(code, PROJECT_EXIT.publishFailed, `${label}: and the command still fails`);
  }

  // NEGATIVE CONTROL: with every file fully published the hook DOES run, so the
  // guard is a condition and not a way of never writing the row at all.
  let ranClean = false;
  assert.equal(
    await runProjectScoresMain(
      deps({
        argv: ['a-scored.ndjson', '--scoring-run'],
        finish: async () => {
          ranClean = true;
          return 0;
        },
      }),
    ),
    PROJECT_EXIT.ok,
  );
  assert.equal(ranClean, true);
});
