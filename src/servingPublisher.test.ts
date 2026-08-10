import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  SourceRef,
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

/** The payload as well as the key: a case that re-derives what it expected
 *  instead of reading what was SENT proves nothing about the sender. */
type Call = { readonly kind: string; readonly key: string; readonly payload: { source: SourceRef } };

class RecordingPort implements BenchmarkServingPort {
  readonly calls: Call[] = [];
  /** Outcome per call kind; anything unset resolves `published`. */
  constructor(private readonly outcomes: Partial<Record<string, PublishOutcome>> = {}) {}

  private answer(kind: string, key: string, payload: { source: SourceRef }): Promise<PublishOutcome> {
    this.calls.push({ kind, key, payload });
    return Promise.resolve(this.outcomes[kind] ?? { outcome: 'published' });
  }

  publishAttempt(a: ArmAttempt): Promise<PublishOutcome> {
    return this.answer('attempt', `${a.participant.participantId}/${a.gameId}`, a);
  }
  sealDecision(s: DecisionSeal): Promise<PublishOutcome> {
    return this.answer('seal', `${s.participant.participantId}/${s.gameId}/${s.market}`, s);
  }
  revealDecision(r: DecisionReveal): Promise<PublishOutcome> {
    return this.answer('reveal', `${r.decision.participantId}/${r.decision.gameId}/${r.decision.market}`, r);
  }
  publishRationale(r: DecisionRationale): Promise<PublishOutcome> {
    return this.answer('rationale', `${r.decision.participantId}/${r.decision.gameId}/${r.decision.market}`, r);
  }
  publishScore(s: DecisionScore): Promise<PublishOutcome> {
    return this.answer('score', s.decision.participantId, s);
  }
  publishScoringRun(r: ScoringRun): Promise<PublishOutcome> {
    return this.answer('scoringRun', r.cohortId, r);
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
  const onDisk = readFileSync(run.runFile, 'utf8');

  const port = new RecordingPort();
  await publishRunArtifact(port, run.runFile, collector().log);
  assert.ok(port.calls.length > 0, 'the run must have published something');

  // Read what was SENT. An earlier version of this case re-derived the expected
  // source and handed it to `projectRun`, which asserted only that the projector
  // copies what it is given — a publisher stamping the absolute path passed it.
  for (const call of port.calls) {
    const { sourcePath, sourceSha256 } = call.payload.source;
    assert.equal(sourceSha256, sha256Hex(onDisk), `${call.kind} hashed something other than the file`);
    assert.equal(sourcePath, basename(run.runFile));
    // An absolute path here is an operator's home directory, written into a
    // database whose rows are destined for a public page, and redaction knows
    // nothing about usernames.
    assert.match(sourcePath ?? '', /^[A-Za-z0-9._-]+\.ndjson$/);
    assert.equal(sourcePath?.includes('/'), false);
    assert.equal(sourcePath?.includes('\\'), false);
  }

  // Stated bound: this pins the hash to the FILE rather than to the in-memory
  // records, and the two differ here only by the writer's trailing newline. It
  // does NOT exercise the case that motivates reading the file back — that the
  // writer redacts on the way out, so an artifact containing a configured
  // credential is not byte-equal to the array it came from. Constructing that
  // faithfully means redacting the archived body and every parsed field
  // together, and anything less is refused by the integrity check above, which
  // is the check working rather than a gap to route around.
  assert.notEqual(
    sha256Hex(run.records.map((record) => JSON.stringify(record)).join('\n')),
    sha256Hex(onDisk),
  );
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

// ---------------------------------------------------------------------------
// Liveness: the projection may not fail a run, and may not stall one either
// ---------------------------------------------------------------------------

test('a port that REJECTS is reported, not propagated', async () => {
  const { plan } = await planFromFire();
  const boom = (): Promise<never> => Promise.reject(new Error('boom'));
  const exploding: BenchmarkServingPort = {
    publishAttempt: boom,
    sealDecision: boom,
    revealDecision: boom,
    publishRationale: boom,
    publishScore: boom,
    publishScoringRun: boom,
  };

  // The documented port never rejects. Relying on that is what makes a
  // projection able to kill a benchmark night, so the publisher answers for the
  // port rather than trusting it — an earlier version of this case asserted the
  // opposite and pinned the defect in place.
  const sink = collector();
  const summary = await publishPlan(exploding, plan, sink.log);
  assert.ok((summary.rejected['unavailable'] ?? 0) > 0, 'the failure must be counted');
  assert.equal(summary.published, 0);
  assert.ok(sink.errors.some((line) => line.includes('unavailable')));
});

test('a port that NEVER SETTLES cannot hold the run open', async () => {
  const { plan } = await planFromFire();
  const silent = (): Promise<never> => new Promise<never>(() => undefined);
  const hanging: BenchmarkServingPort = {
    publishAttempt: silent,
    sealDecision: silent,
    revealDecision: silent,
    publishRationale: silent,
    publishScore: silent,
    publishScoringRun: silent,
  };

  // A rejection and a silence are different failures and only one of them was
  // handled: a typed outcome answers a database that says no, and does nothing
  // about one that says nothing at all. `yarn watch` awaits this inside the
  // fire, so an unbounded wait is a stalled tick and a night that stops.
  //
  // Deliberately ONE attempt and ONE decision, and no deadline. An earlier
  // version ran the whole plan and leaned on the publication budget to bring it
  // back, which made the case's own termination depend on a guard other cases
  // mutate — three unrelated mutants hung here and scored as findings they were
  // not. What is under test is the PER-WRITE bound, so nothing else may be load
  // bearing in getting this function to return.
  const single: ProjectionPlan = {
    ...plan,
    attempts: plan.attempts.slice(0, 1),
    decisions: plan.decisions.slice(0, 1),
  };
  const started = Date.now();
  const summary = await publishPlan(hanging, single, collector().log, {
    perWriteTimeoutMs: 20,
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5_000, `publication must be bounded, took ${elapsed}ms`);
  assert.equal(summary.published, 0);
  assert.ok((summary.rejected['unavailable'] ?? 0) > 0, 'each silent write is unavailable');
});

test('the whole-publication deadline stops sending, and says how to finish', async () => {
  const { plan } = await planFromFire();
  assert.ok(plan.decisions.length > 4, 'need more work than one batch');

  // A clock that jumps past the budget after the first check: forty writes that
  // each answer just inside the per-write timeout would otherwise still stall
  // the fire for minutes, which is why the budget is checked per write and not
  // only per call.
  let ticks = 0;
  const port = new RecordingPort();
  const sink = collector();
  const summary = await publishPlan(port, plan, sink.log, {
    nowMs: () => (ticks++ < 2 ? 0 : 10_000),
    deadlineMs: 1_000,
  });

  assert.ok(summary.skipped.some((reason) => reason.includes('abandoned')));
  assert.ok(sink.errors.some((line) => line.includes('Republish')), 'must say how to recover');
  assert.ok(
    port.calls.length < plan.attempts.length + plan.decisions.length,
    'it must actually stop sending',
  );

  // Negative control: the same plan on the same kind of port with a real clock
  // publishes everything, so the deadline is what stopped it rather than the
  // port or the plan.
  const complete = await publishPlan(new RecordingPort(), plan, collector().log);
  assert.deepEqual(complete.skipped, []);
  assert.ok(complete.published > 0);
});

// ---------------------------------------------------------------------------
// Artifact integrity, answered by the scorer's own reader
// ---------------------------------------------------------------------------

test('an artifact carrying TWO runs is refused, not silently attributed to the first', async () => {
  const run = await firedRun({ outDir: tempDir('serving-twin-'), enrolled: true });
  const text = readFileSync(run.runFile, 'utf8');
  const meta = text.split(/\r?\n/).find((line) => line.includes('"run_meta"'));
  assert.ok(meta);

  // Two run_meta records in one file. Read record-by-record this looks like a
  // run with a spare header; the file actually has no single identity, and
  // publishing it stamped every decision — including the other run's — under
  // whichever header came first.
  const second = meta.replace(/"runId":"[^"]+"/, '"runId":"watch-v0-2026-07-20-ffffff"');
  writeFileSync(run.runFile, `${text.trimEnd()}\n${second}\n`, 'utf8');

  const port = new RecordingPort();
  const summary = await publishRunArtifact(port, run.runFile, collector().log);
  assert.deepEqual(port.calls, [], 'nothing may be sent');
  assert.notEqual(summary.gateRefusal, null);
});

test('a TRUNCATED artifact is refused, so cutting records cannot open the gate', async () => {
  const run = await firedRun({ outDir: tempDir('serving-trunc-'), enrolled: true });
  const lines = readFileSync(run.runFile, 'utf8').trimEnd().split(/\r?\n/);
  assert.ok(lines.length > 3);

  // Every remaining line is still well-formed JSON and the header is intact —
  // only the tail is gone. The gate can only reason about records that are
  // PRESENT, so on its own it reads a shorter run rather than a damaged one;
  // cutting a trailing failure record that way turned a refusal into an
  // acceptance. The artifact's own declared counts are what catch it.
  writeFileSync(run.runFile, `${lines.slice(0, -2).join('\n')}\n`, 'utf8');

  const port = new RecordingPort();
  const summary = await publishRunArtifact(port, run.runFile, collector().log);
  assert.deepEqual(port.calls, [], 'nothing may be sent');
  assert.notEqual(summary.gateRefusal, null);
});

test('a refused artifact is a REFUSAL, distinct from having nothing to publish', async () => {
  const run = await firedRun({
    outDir: tempDir('serving-refusal-'),
    enrolled: true,
    mode: 'dry-run',
  });
  const summary = await publishRunArtifact(new RecordingPort(), run.runFile, collector().log);

  // The recovery command exits on this. Reported as an empty `rejected` it read
  // as success, so an operator republishing a night's runs from a script saw
  // exit 0 over a batch that published nothing at all.
  assert.notEqual(summary.gateRefusal, null);
  assert.ok(summary.gateRefusal?.includes('not a live run'));
  assert.equal(summary.published, 0);

  // Negative control: a clean run publishes and reports NO gate refusal, so the
  // field distinguishes the two cases rather than always being set.
  const clean = await firedRun({ outDir: tempDir('serving-clean-'), enrolled: true });
  const ok = await publishRunArtifact(new RecordingPort(), clean.runFile, collector().log);
  assert.equal(ok.gateRefusal, null);
  assert.ok(ok.published > 0);
});
