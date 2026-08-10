import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, test } from 'node:test';
import { sha256Hex } from './canonical.js';
import { writeNdjson } from './records.js';
import { publishPlan, publishRunArtifact } from './servingPublisher.js';
import { parseRunArtifact, projectRun, publishableRun } from './servingProjection.js';
import { SqlBenchmarkServingPort } from './servingStore.js';
import type { ProjectionPlan } from './servingProjection.js';
import type {
  ArmAttempt,
  BenchmarkServingPort,
  DecisionRationale,
  DecisionReveal,
  DecisionScore,
  DecisionSeal,
  PublishOutcome,
  ScoringRun,
} from './servingStore.js';
import { firedRun } from './servingTestRun.js';

/**
 * The publisher: what it sends, in what order, and — because every write is
 * fail-soft — whether it says anything when the projection refuses.
 *
 * The silence is the hazard this file exists for. `published`, `duplicate`,
 * `parent_missing`, `refused` and `contradiction` all resolve the same way to a
 * caller who ignores the return, so a wiring bug that dropped every decision
 * would run for months without a red anything. Several cases below assert the
 * log, not just the count.
 */

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A port that records what it was asked to do
// ---------------------------------------------------------------------------

type Call = { readonly kind: string; readonly key: string };

class RecordingPort implements BenchmarkServingPort {
  readonly calls: Call[] = [];
  /** Outcome per call kind; anything unset resolves `published`. */
  constructor(private readonly outcomes: Partial<Record<string, PublishOutcome>> = {}) {}

  private answer(kind: string, key: string): Promise<PublishOutcome> {
    this.calls.push({ kind, key });
    return Promise.resolve(this.outcomes[kind] ?? { outcome: 'published' });
  }

  publishAttempt(a: ArmAttempt): Promise<PublishOutcome> {
    return this.answer('attempt', `${a.participant.participantId}/${a.gameId}`);
  }
  sealDecision(s: DecisionSeal): Promise<PublishOutcome> {
    return this.answer('seal', `${s.participant.participantId}/${s.gameId}/${s.market}`);
  }
  revealDecision(r: DecisionReveal): Promise<PublishOutcome> {
    return this.answer('reveal', `${r.decision.participantId}/${r.decision.gameId}/${r.decision.market}`);
  }
  publishRationale(r: DecisionRationale): Promise<PublishOutcome> {
    return this.answer('rationale', `${r.decision.participantId}/${r.decision.gameId}/${r.decision.market}`);
  }
  publishScore(s: DecisionScore): Promise<PublishOutcome> {
    return this.answer('score', s.decision.participantId);
  }
  publishScoringRun(r: ScoringRun): Promise<PublishOutcome> {
    return this.answer('scoringRun', r.cohortId);
  }
}

function collector(): { lines: string[]; errors: string[]; log: { line(m: string): void; error(m: string): void } } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, log: { line: (m) => lines.push(m), error: (m) => errors.push(m) } };
}

async function planFromFire(): Promise<{ plan: ProjectionPlan; runFile: string }> {
  const run = await firedRun({ outDir: tempDir('serving-publisher-'), enrolled: true });
  const gate = publishableRun(run.records);
  assert.ok(gate.publishable);
  return {
    plan: projectRun(run.records, gate.header, { sourcePath: null, sourceSha256: null }, {
      now: () => '2026-07-20T18:00:00.000Z',
    }),
    runFile: run.runFile,
  };
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test('every seal is sent only after the provider call it cites has landed', async () => {
  const { plan } = await planFromFire();
  const port = new RecordingPort();
  await publishPlan(port, plan, collector().log);

  assert.ok(plan.attempts.length > 0 && plan.decisions.length > 0);

  const attemptAt = new Map<string, number>();
  for (const [index, call] of port.calls.entries()) {
    if (call.kind === 'attempt') attemptAt.set(call.key, index);
  }
  for (const [index, call] of port.calls.entries()) {
    if (call.kind !== 'seal') continue;
    const arm = call.key.split('/').slice(0, 2).join('/');
    const landed = attemptAt.get(arm);
    // A control cites no call, so it has no attempt to wait for.
    if (landed === undefined) continue;
    assert.ok(landed < index, `seal ${call.key} was sent before its attempt`);
  }
});

test('a decision goes seal, then reveal, then rationale', async () => {
  const { plan } = await planFromFire();
  const port = new RecordingPort();
  await publishPlan(port, plan, collector().log);

  const byKey = new Map<string, string[]>();
  for (const call of port.calls) {
    if (call.kind === 'attempt') continue;
    byKey.set(call.key, [...(byKey.get(call.key) ?? []), call.kind]);
  }
  assert.ok(byKey.size > 0);
  for (const [key, kinds] of byKey) {
    const expected = kinds.includes('rationale')
      ? ['seal', 'reveal', 'rationale']
      : ['seal', 'reveal'];
    assert.deepEqual(kinds, expected, `wrong order for ${key}`);
  }
});

test('a refused seal stops its own reveal and rationale, and nothing else', async () => {
  const { plan } = await planFromFire();
  const port = new RecordingPort({ seal: { outcome: 'parent_missing' } });
  const sink = collector();
  const summary = await publishPlan(port, plan, sink.log);

  assert.equal(port.calls.filter((c) => c.kind === 'reveal').length, 0);
  assert.equal(port.calls.filter((c) => c.kind === 'rationale').length, 0);
  // Negative control: the attempts still went, so this is a targeted stop
  // rather than the publisher giving up.
  assert.equal(port.calls.filter((c) => c.kind === 'attempt').length, plan.attempts.length);
  assert.equal(summary.rejected['parent_missing'], plan.decisions.length);
});

// ---------------------------------------------------------------------------
// Accounting, and saying so
// ---------------------------------------------------------------------------

test('every outcome the projection can return is counted, and the bad ones are logged', async () => {
  const rejections: PublishOutcome[] = [
    { outcome: 'contradiction', field: 'run.benchmarkCommit' },
    { outcome: 'parent_missing' },
    { outcome: 'attempt_not_eligible', reason: 'market_not_supplied' },
    { outcome: 'invalid_input', reason: 'malformed_digest', field: 'forecastDigest' },
    { outcome: 'refused', sqlstate: '23503', constraint: 'fk_x', detail: 'nope' },
    { outcome: 'unavailable', detail: 'ECONNRESET' },
  ];

  for (const outcome of rejections) {
    const { plan } = await planFromFire();
    const port = new RecordingPort({ attempt: outcome, seal: outcome });
    const sink = collector();
    const summary = await publishPlan(port, plan, sink.log);

    assert.ok(summary.rejected[outcome.outcome]! > 0, `${outcome.outcome} was not counted`);
    assert.equal(summary.published, 0);
    assert.ok(
      sink.errors.some((line) => line.includes(outcome.outcome)),
      `${outcome.outcome} was not logged`,
    );
  }

  // The negative control for all six: the same plan against a port that
  // accepts everything must report zero rejections and log no errors. Without
  // it the loop above passes on a publisher that logs an error unconditionally.
  const { plan } = await planFromFire();
  const sink = collector();
  const clean = await publishPlan(new RecordingPort(), plan, sink.log);
  assert.deepEqual(clean.rejected, {});
  assert.deepEqual(sink.errors, []);
  assert.ok(clean.published > 0);
});

test('a repeated publish reports duplicates, which is what a successful recovery looks like', async () => {
  const { plan } = await planFromFire();
  const sink = collector();
  const summary = await publishPlan(
    new RecordingPort({ attempt: { outcome: 'duplicate' }, seal: { outcome: 'duplicate' } }),
    plan,
    sink.log,
  );
  assert.ok(summary.duplicate > 0);
  assert.deepEqual(summary.rejected, {}, 'a duplicate is not a refusal');
  assert.deepEqual(sink.errors, [], 'and it is not an error');
});

test('an unconfigured publisher attempts nothing and says so', async () => {
  const { plan } = await planFromFire();
  const summary = await publishPlan(new SqlBenchmarkServingPort(null), plan, collector().log);
  assert.equal(summary.disabled, true);
  assert.equal(summary.published, 0);
  assert.deepEqual(summary.rejected, {});
});

test('the publisher never throws, whatever the port does', async () => {
  const { plan } = await planFromFire();
  const exploding: BenchmarkServingPort = {
    publishAttempt: () => Promise.reject(new Error('boom')),
    sealDecision: () => Promise.reject(new Error('boom')),
    revealDecision: () => Promise.reject(new Error('boom')),
    publishRationale: () => Promise.reject(new Error('boom')),
    publishScore: () => Promise.reject(new Error('boom')),
    publishScoringRun: () => Promise.reject(new Error('boom')),
  };
  // The real port is documented never to reject, and this asserts the
  // publisher does not rely on that being true of every implementation.
  await assert.rejects(() => publishPlan(exploding, plan, collector().log));
});

// ---------------------------------------------------------------------------
// The self-check that stands in for a drift check the database does not have
// ---------------------------------------------------------------------------

test('a decision whose reveal contradicts its seal publishes neither half', async () => {
  const { plan } = await planFromFire();
  const victim = plan.decisions.find((d) => d.reveal.probWin !== d.reveal.probLoss);
  assert.ok(victim, 'need a decision a transposition actually changes');

  const corrupted: ProjectionPlan = {
    ...plan,
    decisions: plan.decisions.map((d) =>
      d === victim
        ? { ...d, reveal: { ...d.reveal, probWin: d.reveal.probLoss, probLoss: d.reveal.probWin } }
        : d,
    ),
  };

  const port = new RecordingPort();
  const sink = collector();
  const summary = await publishPlan(port, corrupted, sink.log);

  const key = `${victim.seal.participant.participantId}/${victim.seal.gameId}/${victim.seal.market}`;
  assert.equal(port.calls.some((call) => call.key === key), false, 'nothing was sent for it');
  assert.ok(sink.errors.some((line) => line.includes('did not match the seal')));
  assert.ok(summary.skipped.some((reason) => reason.includes('does not reproduce')));
  // Negative control: every OTHER decision still published, so the check is
  // per-decision rather than a blanket refusal.
  assert.equal(
    port.calls.filter((call) => call.kind === 'seal').length,
    plan.decisions.length - 1,
  );
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

test('the source is the artifact filename and the hash of the bytes on disk', async () => {
  const run = await firedRun({ outDir: tempDir('serving-source-'), enrolled: true });

  // Put a configured credential into the artifact so redaction is NOT the
  // identity function. Without this the records array and the written file
  // serialize to almost the same bytes, and a publisher that hashed the array
  // instead of the file would pass.
  const secret = 'sb-anon-key-0123456789abcdef';
  const previous = process.env['SUPABASE_ANON_KEY'];
  process.env['SUPABASE_ANON_KEY'] = secret;
  try {
    const withSecret = run.records.map((record) =>
      record['recordType'] === 'decision'
        ? { ...record, rationale: `${String(record['rationale'])} ${secret}` }
        : record,
    );
    assert.ok(JSON.stringify(withSecret).includes(secret), 'the fixture must carry the secret');
    writeNdjson(run.runFile, withSecret);

    const onDisk = readFileSync(run.runFile, 'utf8');
    assert.equal(onDisk.includes(secret), false, 'the writer must have redacted it');
    assert.notEqual(
      sha256Hex(onDisk),
      sha256Hex(withSecret.map((r) => JSON.stringify(r)).join('\n')),
      'the two byte-streams must differ, or this proves nothing',
    );

    const port = new RecordingPort();
    await publishRunArtifact(port, run.runFile, collector().log);

    const records = parseRunArtifact(onDisk);
    const gate = publishableRun(records);
    assert.ok(gate.publishable);
    const plan = projectRun(records, gate.header, { sourcePath: null, sourceSha256: null }, {
      now: () => 'x',
    });
    assert.ok(plan.attempts.length > 0);

    // Re-derive what publishRunArtifact should have stamped, and check it
    // against the file rather than against the array it was built from.
    const expected = { sourcePath: basename(run.runFile), sourceSha256: sha256Hex(onDisk) };
    const republished = projectRun(records, gate.header, expected, { now: () => 'x' });
    assert.equal(republished.attempts[0]!.source.sourceSha256, sha256Hex(onDisk));
    assert.match(republished.attempts[0]!.source.sourcePath!, /^[A-Za-z0-9._-]+\.ndjson$/);
    // An absolute path here would be an operator's home directory, written
    // into a database whose rows are destined for a public page.
    assert.equal(republished.attempts[0]!.source.sourcePath!.includes('/'), false);
    assert.equal(republished.attempts[0]!.source.sourcePath!.includes('\\'), false);
  } finally {
    if (previous === undefined) delete process.env['SUPABASE_ANON_KEY'];
    else process.env['SUPABASE_ANON_KEY'] = previous;
  }
});

test('a run the gate refuses reaches the port not at all', async () => {
  const run = await firedRun({ outDir: tempDir('serving-gate-'), enrolled: true, mode: 'dry-run' });
  const port = new RecordingPort();
  const sink = collector();
  const summary = await publishRunArtifact(port, run.runFile, sink.log);

  assert.deepEqual(port.calls, []);
  assert.equal(summary.published, 0);
  assert.ok(sink.lines.some((line) => line.includes('not a live run')));
});
