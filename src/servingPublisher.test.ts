import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, test } from 'node:test';
import { sha256Hex } from './canonical.js';
import { writeNdjson } from './records.js';
import {
  mirrorRunArtifact,
  publicationNowMs,
  publishPlan,
  publishRunArtifact,
  publishScoredArtifact,
  publishScores,
} from './servingPublisher.js';
import {
  parseScoredArtifact,
  projectScoredRun,
  publishableScoredRun,
} from './scoredProjection.js';
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

test('a self-consistent artifact claiming the WRONG MODEL for a real arm is refused', async () => {
  // FIRED with the forgery rather than patched into it. Patching the file only
  // ever produced a file that disagreed with ITSELF, which is refused by the
  // body check — so the case passed while proving nothing about registry
  // anchoring, and a mutant that went back to deriving identity from the
  // artifact survived it. Dispatching the wrong model makes the records and the
  // archived body agree, so the ONLY thing left to disagree with is the
  // registry.
  const run = await firedRun({
    outDir: tempDir('serving-forge-'),
    enrolled: true,
    contradictModel: true,
  });

  const port = new RecordingPort();
  const summary = await publishRunArtifact(port, run.runFile, collector().log);
  assert.deepEqual(port.calls, [], 'nothing may be sent');
  assert.notEqual(summary.gateRefusal, null);
});

test('an artifact naming an arm the registry never enrolled is refused outright', async () => {
  // Not skipped-per-participant: refused. The registry is append-only, so an
  // arm it has never seen is not an old arm — it is one nobody enrolled, and a
  // file asserting otherwise has no claim on being partly published.
  const run = await firedRun({ outDir: tempDir('serving-unknown-'), enrolled: true });
  const text = readFileSync(run.runFile, 'utf8');
  writeFileSync(
    run.runFile,
    text.replace(/"participantId":"openai-gpt-5\.6-sol"/g, '"participantId":"nobody-enrolled-this"'),
    'utf8',
  );

  const port = new RecordingPort();
  const summary = await publishRunArtifact(port, run.runFile, collector().log);
  assert.deepEqual(port.calls, []);
  assert.ok(summary.gateRefusal?.includes('never enrolled'));
});

test('an honest enrolled artifact still publishes — the control for both refusals', async () => {
  const run = await firedRun({ outDir: tempDir('serving-honest-'), enrolled: true });
  const port = new RecordingPort();
  const summary = await publishRunArtifact(port, run.runFile, collector().log);
  assert.equal(summary.gateRefusal, null);
  assert.ok(summary.published > 0);
  assert.ok(port.calls.some((call) => call.kind === 'attempt'));
});

// ---------------------------------------------------------------------------
// The whole-publication deadline binds every write, not every group of them
// ---------------------------------------------------------------------------

test('the deadline binds a decision\'s reveal and rationale, not just its seal', async () => {
  const { plan } = await planFromFire();
  const one: ProjectionPlan = { ...plan, attempts: [], decisions: plan.decisions.slice(0, 1) };

  // Checked only before each decision, a seal admitted one millisecond inside
  // the budget still gets its own full timeout — and so do the reveal and the
  // rationale behind it. Measured at twelve times the configured deadline with
  // nothing reported as abandoned.
  let now = 0;
  const slow = (): Promise<PublishOutcome> =>
    new Promise((resolve) => {
      now += 20;
      setTimeout(() => resolve({ outcome: 'published' }), 1);
    });
  const port: BenchmarkServingPort = {
    publishAttempt: slow,
    sealDecision: slow,
    revealDecision: slow,
    publishRationale: slow,
    publishScore: slow,
    publishScoringRun: slow,
  };

  const summary = await publishPlan(port, one, collector().log, {
    nowMs: () => now,
    deadlineMs: 5,
    perWriteTimeoutMs: 1_000,
  });

  // The seal is admitted; the reveal and rationale are past the line.
  assert.ok(summary.published <= 1, `expected at most the seal, got ${summary.published}`);
  assert.ok(summary.skipped.some((reason) => reason.includes('abandoned')));
});

test('a write is bounded by what is LEFT, not by the per-write timeout', async () => {
  const { plan } = await planFromFire();
  const one: ProjectionPlan = { ...plan, attempts: plan.attempts.slice(0, 1), decisions: [] };

  // The per-write timeout is far larger than the budget, so a write that took
  // its own full allowance would run long past the deadline it started before.
  // Only the clamp stops that, and nothing else in the suite exercises it.
  const started = Date.now();
  const summary = await publishPlan(
    {
      publishAttempt: () => new Promise<never>(() => undefined),
      sealDecision: () => new Promise<never>(() => undefined),
      revealDecision: () => new Promise<never>(() => undefined),
      publishRationale: () => new Promise<never>(() => undefined),
      publishScore: () => new Promise<never>(() => undefined),
      publishScoringRun: () => new Promise<never>(() => undefined),
    },
    one,
    collector().log,
    { deadlineMs: 40, perWriteTimeoutMs: 60_000 },
  );
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5_000, `the clamp did not bind: took ${elapsed}ms`);
  assert.ok((summary.rejected['unavailable'] ?? 0) > 0);
});

// ---------------------------------------------------------------------------
// Totality: what happens when the publisher itself breaks
// ---------------------------------------------------------------------------
//
// TWO LAYERS, and the cases below are chosen so each one can only be satisfied
// by the layer it names. Both were added after a reviewer measured that
// `publishRunArtifact` throws on artifacts a file can actually hold:
//
//   publishRunArtifact  refuses a corrupt artifact instead of crashing, so
//                       `yarn project` reports a bad FILE rather than a broken
//                       command.
//   mirrorRunArtifact   catches whatever is left, so a run path cannot lose a
//                       game to a projection defect.
//
// A case that exercised both would pin neither — with the first fix in place a
// corrupt artifact never reaches the wrapper at all.

/** A real fired artifact, corrupted one specific way. */
async function corruptedRun(mutate: (line: string) => string): Promise<string> {
  const dir = tempDir('serving-corrupt-');
  const run = await firedRun({ outDir: dir, enrolled: true });
  const lines = readFileSync(run.runFile, 'utf8').trimEnd().split('\n');
  const index = lines.findIndex((line) => line.includes('"bundle_game"'));
  assert.ok(index >= 0, 'the fixture has no bundle_game record to corrupt');
  const mutated = mutate(lines[index]!);
  assert.notEqual(mutated, lines[index], 'the corruption did not apply — this case proves nothing');
  lines[index] = mutated;
  const file = join(dir, 'corrupt.ndjson');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

test('a corrupt artifact is REFUSED, by two different throwing mechanisms', async () => {
  // Both are shapes an NDJSON file can hold and the schema validators accept.
  // `1e400` parses to Infinity; the bundle is a passthrough object, so deep
  // nesting survives zod untouched. Each reaches the canonicaliser inside the
  // integrity check, which throws rather than returning — one an Error, the
  // other a RangeError, so a catch narrowed to Error would still fail one.
  const cases = [
    {
      what: 'a number that overflows a double',
      mutate: (line: string) => line.replace(/"awayDecimal":\s*[0-9.]+/, '"awayDecimal": 1e400'),
      expect: /non-finite/,
    },
    {
      what: 'JSON nested twenty thousand deep',
      mutate: (line: string) =>
        line.replace(/"bundle":\{/, `"bundle":{"deep":${'['.repeat(20_000)}1${']'.repeat(20_000)},`),
      expect: /call stack|RangeError/i,
    },
  ];

  for (const { what, mutate, expect } of cases) {
    const file = await corruptedRun(mutate);
    const port = new RecordingPort();
    const log = collector();
    const summary = await publishRunArtifact(port, file, log.log);

    assert.equal(port.calls.length, 0, `${what}: nothing may be sent from an unverifiable artifact`);
    assert.notEqual(summary.gateRefusal, null, `${what}: must be refused`);
    // Naming the mechanism is what distinguishes "the verifier threw and was
    // caught" from "the verifier returned a mismatch" — the second would also
    // produce a refusal, and would pass a test that only checked for one.
    assert.match(summary.gateRefusal ?? '', /could not be verified/, what);
    assert.match(summary.gateRefusal ?? '', expect, what);
  }
});

test('an artifact that is merely INTACT still publishes — the control for the above', async () => {
  // Without this, deleting the whole read-and-verify phase would satisfy every
  // assertion in the previous case.
  const dir = tempDir('serving-intact-');
  const run = await firedRun({ outDir: dir, enrolled: true });
  const port = new RecordingPort();
  const summary = await publishRunArtifact(port, run.runFile, collector().log);
  assert.equal(summary.gateRefusal, null);
  assert.ok(port.calls.length > 0, 'the intact artifact sent nothing, so the refusals above prove nothing');
});

test('mirrorRunArtifact absorbs a throw that publishRunArtifact cannot', async () => {
  // A log sink that throws is the residue the first fix does not cover, and it
  // is not hypothetical: printLine writes to stdout, and stdout raises EPIPE
  // when a run is piped into something that exits first. The throw lands AFTER
  // the rows are written, which is why the wrapper cannot report counts.
  const dir = tempDir('serving-epipe-');
  const run = await firedRun({ outDir: dir, enrolled: true });
  const errors: string[] = [];
  const throwingLog = {
    line: (): void => { throw new Error('EPIPE: stdout closed'); },
    error: (message: string): void => { errors.push(message); },
  };

  const port = new RecordingPort();
  await assert.rejects(
    publishRunArtifact(port, run.runFile, throwingLog),
    /EPIPE/,
    'if this stops throwing, the case below no longer discriminates the wrapper',
  );

  const wrapped = new RecordingPort();
  const result = await mirrorRunArtifact(wrapped, run.runFile, throwingLog);
  assert.equal(result, null, 'a crash cannot claim counts it did not measure');
  assert.ok(wrapped.calls.length > 0, 'the wrapper returned before reaching the publisher at all');
  assert.ok(
    errors.some((message) => message.includes('yarn project')),
    `the operator must be told how to recover; got ${JSON.stringify(errors)}`,
  );
});

test('mirrorRunArtifact is otherwise transparent', async () => {
  // The negative control for the wrapper: a catch-all that returned null for
  // everything would pass the case above and silently disable publication.
  const dir = tempDir('serving-mirror-');
  const run = await firedRun({ outDir: dir, enrolled: true });
  const port = new RecordingPort();
  const summary = await mirrorRunArtifact(port, run.runFile, collector().log);
  assert.notEqual(summary, null);
  assert.ok((summary?.published ?? 0) > 0, 'the same call must still publish');
  assert.equal(summary?.gateRefusal, null);
});

test('the publication deadline is measured on a clock that cannot step backwards', async () => {
  // `Date.now` moves backwards on an NTP correction or a host resume, and a
  // backward step pushes the budget's expiry away — leaving only the per-write
  // cap, which for a full slate is tens of minutes rather than 45 seconds.
  assert.notEqual(publicationNowMs as unknown, Date.now as unknown);
  const realNow = Date.now;
  try {
    // A wall clock running backwards. A default of `Date.now` reads it.
    let fake = 1_000_000;
    Date.now = (): number => (fake -= 1_000);
    const first = publicationNowMs();
    const second = publicationNowMs();
    assert.ok(second >= first, `the clock went backwards: ${first} then ${second}`);
  } finally {
    Date.now = realNow;
  }
});

test('the DEFAULT deadline still binds when the wall clock runs backwards', async () => {
  // The helper being monotonic is one thing; publishPlan actually USING it is
  // the behavioural line, and nothing pinned that. `nowMs` is omitted here so
  // the default is what runs, and Date.now is driven backwards underneath it.
  const { plan } = await planFromFire();
  const hanging = {
    publishAttempt: () => new Promise<never>(() => undefined),
    sealDecision: () => new Promise<never>(() => undefined),
    revealDecision: () => new Promise<never>(() => undefined),
    publishRationale: () => new Promise<never>(() => undefined),
    publishScore: () => new Promise<never>(() => undefined),
    publishScoringRun: () => new Promise<never>(() => undefined),
  };
  const realNow = Date.now;
  const started = performance.now();
  try {
    let fake = 1_000_000_000_000;
    Date.now = (): number => (fake -= 60_000);
    const summary = await publishPlan(hanging, plan, collector().log, {
      deadlineMs: 150,
      perWriteTimeoutMs: 80,
    });
    const elapsed = performance.now() - started;
    // BOUNDED AWAY FROM THE RIVAL. The per-write cap alone would also finish
    // eventually — 80ms for each batch of writes. The deadline is what stops it
    // after ~150ms, so the assertion has to exclude the slower mechanism rather
    // than merely observe an ending.
    const rival = 80 * (Math.ceil(plan.attempts.length / 4) + plan.decisions.length);
    assert.ok(rival > 600, `the plan is too small to discriminate: rival bound ${rival}ms`);
    assert.ok(elapsed < rival / 2, `took ${Math.round(elapsed)}ms; the per-write cap alone allows ${rival}ms`);
    assert.ok(summary.skipped.some((reason) => reason.includes('abandoned')));
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------
// The scored-artifact path
// ---------------------------------------------------------------------------

/** A minimal scored artifact whose every value is distinct, so what the port
 *  RECEIVES can be checked against what the file SAYS rather than against a
 *  reconstruction. */
function scoredArtifactLines(
  over: { meta?: Record<string, unknown>; extraGames?: readonly string[] } = {},
): string[] {
  const meta = {
    recordType: 'scored_run_meta', label: 'SMOKE_V0_NOT_A_COHORT', runId: 'run-77',
    cohortId: 'smoke-v0-2026-08-19', slateDate: '2026-08-19', sourceMode: 'live',
    scoredAt: '2026-08-20T04:00:00.000Z', scoringPolicyVersion: 'scoring-v0.6.0',
    integrityVerified: true,
    ladder: { version: 'TOTALS_V1_PROVISIONAL', parameterVersion: 'retrosheet-2023-25-v1' },
    ...over.meta,
  };
  const shared = {
    recordType: 'scored_decision', label: 'SMOKE_V0_NOT_A_COHORT', runId: 'run-77',
    scoredAt: '2026-08-20T04:00:00.000Z', scoringPolicyVersion: 'scoring-v0.6.0',
    kind: 'model', participantId: 'lab-alpha', market: 'moneyline', side: 'away',
    devigMethod: 'proportional-v1', scheduleChanged: false, inPrimaryStratum: true,
    unscoredReason: null, lineMovementFavorable: null,
  };
  return [
    JSON.stringify(meta),
    JSON.stringify({
      ...shared, gameId: 'game-1', selection: 'Away Team',
      closing: { line: null, awayDecimal: 2.05, homeDecimal: 1.87 },
      primaryClvPct: 3.21, marginAdjustedClvPct: 1.25,
    }),
    JSON.stringify({
      ...shared, gameId: 'game-2', selection: 'Road Team', closing: null,
      primaryClvPct: null, marginAdjustedClvPct: null, unscoredReason: 'close_missing',
    }),
    ...(over.extraGames ?? []).map((gameId) =>
      JSON.stringify({
        ...shared, gameId, selection: 'Away Team', closing: null,
        primaryClvPct: null, marginAdjustedClvPct: null, unscoredReason: 'close_missing',
      }),
    ),
  ];
}

function writeScoredArtifact(lines: string[]): string {
  const file = join(tempDir('serving-scored-'), 'run-77-scored.ndjson');
  writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

test('a scored artifact publishes one score per pick, from the bytes on disk', async () => {
  const lines = scoredArtifactLines();
  const file = writeScoredArtifact(lines);
  const port = new RecordingPort();
  const { log, lines: printed } = collector();

  const summary = await publishScoredArtifact(port, file, log);
  assert.deepEqual(
    { published: summary.published, duplicate: summary.duplicate, gateRefusal: summary.gateRefusal },
    { published: 2, duplicate: 0, gateRefusal: null },
  );

  // What was SENT, not what this test would have sent: the assertion sits
  // downstream of the code that decides the values.
  assert.deepEqual(port.calls.map((call) => call.kind), ['score', 'score']);
  const payloads = port.calls.map((call) => call.payload as unknown as DecisionScore);
  const scored = payloads.find((p) => p.decision.gameId === 'game-1');
  const refused = payloads.find((p) => p.decision.gameId === 'game-2');
  assert.equal(scored?.economicClvPct, 3.21);
  assert.equal(scored?.closeDecimalSelected, 2.05);
  assert.equal(scored?.closeDecimalOpposing, 1.87);
  assert.equal(scored?.runId, 'run-77');
  assert.equal(scored?.label, 'SMOKE_V0_NOT_A_COHORT');
  assert.equal(refused?.refused, true);
  assert.equal(refused?.refusalReason, 'close_missing');

  // The provenance is the FILE: its basename, and the hash of its bytes.
  const bytes = readFileSync(file, 'utf8');
  for (const payload of payloads) {
    assert.deepEqual(payload.source, { sourcePath: basename(file), sourceSha256: sha256Hex(bytes) });
  }
  assert.ok(printed.some((line) => line.includes('2 written')), `summary printed: ${printed.join(' | ')}`);
});

test('a scored artifact the gate refuses reaches the port not at all', async () => {
  const file = writeScoredArtifact(scoredArtifactLines({ meta: { sourceMode: 'dry-run' } }));
  const port = new RecordingPort();
  const { log } = collector();
  const summary = await publishScoredArtifact(port, file, log);
  assert.match(summary.gateRefusal ?? '', /not a live run/);
  assert.equal(port.calls.length, 0, 'nothing may be sent from a refused artifact');
});

test('an unreadable scored artifact is a refusal, not a crash', async () => {
  const port = new RecordingPort();
  const summary = await publishScoredArtifact(port, join(tempDir('serving-scored-'), 'gone.ndjson'), collector().log);
  assert.match(summary.gateRefusal ?? '', /could not be read/);
  assert.equal(port.calls.length, 0);
});

test('a refused score is counted and logged; a duplicate counts as recovery', async () => {
  const file = writeScoredArtifact(scoredArtifactLines());
  const port = new RecordingPort({ score: { outcome: 'contradiction', field: 'score.economicClvPct' } });
  const { log, errors } = collector();
  const summary = await publishScoredArtifact(port, file, log);
  assert.deepEqual(summary.rejected, { contradiction: 2 });
  assert.ok(errors.some((line) => line.includes('score.economicClvPct')), errors.join(' | '));

  const replay = new RecordingPort({ score: { outcome: 'duplicate' } });
  const replayed = await publishScoredArtifact(replay, file, collector().log);
  assert.deepEqual(
    { published: replayed.published, duplicate: replayed.duplicate },
    { published: 0, duplicate: 2 },
  );
});

test('a score port that never settles cannot hold the command open, and says how to finish', async () => {
  // Six picks: one batch of four that burns the whole deadline against a port
  // that never answers, and a second batch the spent budget must TURN AWAY —
  // the abandonment is only observable when there is work left to abandon.
  const file = writeScoredArtifact(scoredArtifactLines({
    extraGames: ['game-3', 'game-4', 'game-5', 'game-6'],
  }));
  const gate = publishableScoredRun(parseScoredArtifact(readFileSync(file, 'utf8')));
  assert.ok(gate.publishable);
  if (!gate.publishable) return;
  const hanging = { publishScore: () => new Promise<never>(() => undefined) } as unknown as BenchmarkServingPort;
  const { log, errors } = collector();
  const started = performance.now();
  const summary = await publishScores(
    hanging,
    projectScoredRun(gate.header, gate.decisions, { sourcePath: basename(file), sourceSha256: null }),
    log,
    { deadlineMs: 100, perWriteTimeoutMs: 400 },
  );
  const elapsed = performance.now() - started;
  // Bounded away from the rival: the per-write cap alone would take ~800ms
  // (two batches at 400ms); the deadline ends it at ~100ms.
  assert.ok(elapsed < 400, `took ${Math.round(elapsed)}ms; the per-write cap alone allows 800ms`);
  assert.equal(summary.rejected['unavailable'], 4, JSON.stringify(summary));
  assert.ok(
    [...summary.skipped, ...errors].some((line) => line.includes('Republish this scored artifact')),
    `the recovery instruction names the scored artifact: ${errors.join(' | ')}`,
  );
});

test('the scores DEFAULT deadline still binds when the wall clock runs backwards', async () => {
  // The publishScores sibling of the case above: `nowMs` omitted so the
  // default is what runs, with Date.now driven backwards underneath it. A
  // default of Date.now never expires the budget, and the only remaining
  // bound is the per-write cap — the rival this test excludes by margin.
  const lines = scoredArtifactLines({
    extraGames: Array.from({ length: 30 }, (_, index) => `game-${index + 3}`),
  });
  const gate = publishableScoredRun(parseScoredArtifact(lines.join('\n')));
  assert.ok(gate.publishable);
  if (!gate.publishable) return;
  const scores = projectScoredRun(gate.header, gate.decisions, { sourcePath: 'x.ndjson', sourceSha256: null });
  const hanging = { publishScore: () => new Promise<never>(() => undefined) } as unknown as BenchmarkServingPort;
  const realNow = Date.now;
  const started = performance.now();
  try {
    let fake = 1_000_000_000_000;
    Date.now = (): number => (fake -= 60_000);
    const summary = await publishScores(hanging, scores, collector().log, {
      deadlineMs: 150,
      perWriteTimeoutMs: 80,
    });
    const elapsed = performance.now() - started;
    // The same margin discipline as the run-path sibling: a correct build ends
    // at ~150ms plus timer jitter, so the exclusion bound must sit far enough
    // above that a slow scheduler cannot flip the verdict — rival/2 with a
    // rival of at least 600ms, not a bound a healthy run brushes against.
    const rival = 80 * Math.ceil(scores.length / 4);
    assert.ok(rival >= 600, `the artifact is too small to discriminate: rival bound ${rival}ms`);
    assert.ok(elapsed < rival / 2, `took ${Math.round(elapsed)}ms; the per-write cap alone allows ${rival}ms`);
    assert.ok(summary.skipped.some((reason) => reason.includes('abandoned')));
  } finally {
    Date.now = realNow;
  }
});
