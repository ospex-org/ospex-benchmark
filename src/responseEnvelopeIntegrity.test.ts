import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256Hex } from './canonical.js';
import { EVIDENCE_ERA } from './providers/responseEnvelope.js';
import { defaultExpectedArms, parseRunRecords, verifyRunIntegrity } from './scoring.js';
import { projectRun, publishableRun } from './servingProjection.js';
import { firedRun } from './servingTestRun.js';
import type { JsonRecord } from './servingProjection.js';

/**
 * The SCORER's fail-closed check on retained provider response envelopes, and
 * the reporting rule for files that predate them (#92).
 *
 * Every case here runs against a REAL artifact: `firedRun` drives the harness
 * end to end and the assertions read the NDJSON it wrote, so what is verified
 * is the file an operator would actually score — not a hand-built record that
 * agrees with the serializer by construction.
 *
 * The two rules under test are deliberately separate:
 *   - PRESENCE is gated on the run's evidence-era stamp, so an archived file is
 *     reported as envelope-unavailable rather than failed for a field that did
 *     not exist when it was written;
 *   - INTEGRITY is unconditional, so an envelope that is present and wrong is a
 *     violation in any era.
 */

const ENVELOPE_MISSING = 'no response envelope was retained';
const ENVELOPE_DIGEST = 'does not match its recorded sha256';

/** A distinct game per fire. Two fires over one game share a decision key and
 *  the second is refused as a contradiction rather than written, which reads
 *  here as "the run produced no arm_game_response". */
let gameCounter = 0;
function nextGameId(): string {
  gameCounter += 1;
  return `00000000-0000-4000-8000-0000000env${String(gameCounter).padStart(2, '0')}`;
}

async function firedRecords(behaviour: 'ok' | 'repaired' | 'transport-failure'): Promise<JsonRecord[]> {
  const dir = mkdtempSync(join(tmpdir(), 'envelope-integrity-'));
  try {
    const run = await firedRun({ outDir: dir, enrolled: true, behaviour, gameId: nextGameId() });
    const records = run.records.map((record) => JSON.parse(JSON.stringify(record)) as JsonRecord);
    assert.ok(
      records.some((record) => record['recordType'] === 'arm_game_response'),
      'the fire produced an arm response, so the case is not vacuous',
    );
    return records;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function lines(records: readonly JsonRecord[]): string[] {
  return records.map((record) => JSON.stringify(record));
}

/** The fixture dispatches exactly one enrolled arm, so the expected roster is
 *  that arm alone — otherwise every case reports the other three registry arms
 *  as absent and buries the violation under test. */
const FIRED_PARTICIPANT = 'openai-gpt-5.6-sol';
function expectedArms(): ReturnType<typeof defaultExpectedArms> {
  const arms = defaultExpectedArms().filter((arm) => arm.participantId === FIRED_PARTICIPANT);
  assert.equal(arms.length, 1, `the fixture arm "${FIRED_PARTICIPANT}" is no longer in the registry`);
  return arms;
}

function violationsFor(records: readonly JsonRecord[]): string[] {
  return verifyRunIntegrity(parseRunRecords(lines(records)), { expectedArms: expectedArms() });
}

/** The `output_text` this envelope body carries, read back through JSON so the
 *  comparison is against the parsed value rather than against escaped bytes. */
function envelopeAnswer(envelope: { body: string }): string {
  const parsed = JSON.parse(envelope.body) as {
    output: Array<{ content: Array<{ text: string }> }>;
  };
  return parsed.output[0]!.content[0]!.text;
}

/** The arm_game_response record, which every case in this file mutates. */
function armResponse(records: JsonRecord[]): JsonRecord {
  const found = records.find((record) => record['recordType'] === 'arm_game_response');
  assert.ok(found !== undefined, 'the fired run produced an arm_game_response');
  return found;
}

function leg(records: JsonRecord[], name: 'attempt' | 'repair'): JsonRecord {
  const value = armResponse(records)[name];
  assert.ok(value !== null && typeof value === 'object', `the fired run has a ${name} leg`);
  return value as JsonRecord;
}

// ---------------------------------------------------------------------------
// what the harness actually writes
// ---------------------------------------------------------------------------

test('a fired run stamps the evidence era and retains an envelope on every received leg', async () => {
  const records = await firedRecords('repaired');
  const meta = records.find((record) => record['recordType'] === 'run_meta');
  assert.equal(meta?.['evidenceEra'], EVIDENCE_ERA);

  for (const name of ['attempt', 'repair'] as const) {
    const attempt = leg(records, name);
    // The two fields are DISTINCT values, which is the point of the rename:
    // one is the model's answer, the other is the whole provider body.
    assert.equal(typeof attempt['answerText'], 'string');
    const envelope = attempt['responseEnvelope'] as { body: string; sha256: string; bytes: number };
    assert.ok(envelope !== null && typeof envelope === 'object', `${name} retains an envelope`);
    assert.notEqual(envelope.body, attempt['answerText']);
    assert.equal(envelopeAnswer(envelope), attempt['answerText'], 'the answer came out of that body');
    assert.equal(envelope.sha256, sha256Hex(envelope.body));
    assert.equal(envelope.bytes, Buffer.byteLength(envelope.body, 'utf8'));
  }
  assert.deepEqual(violationsFor(records), []);
});

test('the serializer keeps the answer and the envelope in their own fields', async () => {
  // Rule 3d, the same-typed swap: `answerText` and `responseEnvelope.body` are
  // both provider-derived strings, and a serializer that fed each the other's
  // value would produce a file that still parses. The two legs carry DIFFERENT
  // answers (the repair fixes the initial's cohort echo), so the check cannot
  // pass by the two legs happening to agree either.
  const records = await firedRecords('repaired');
  const initial = leg(records, 'attempt');
  const repair = leg(records, 'repair');
  const initialEnvelope = initial['responseEnvelope'] as { body: string };
  const repairEnvelope = repair['responseEnvelope'] as { body: string };

  assert.notEqual(initial['answerText'], repair['answerText'], 'the legs differ, so the case discriminates');
  assert.notEqual(initialEnvelope.body, repairEnvelope.body);
  assert.equal(envelopeAnswer(initialEnvelope), initial['answerText']);
  assert.equal(envelopeAnswer(repairEnvelope), repair['answerText']);
  assert.notEqual(envelopeAnswer(initialEnvelope), repair['answerText'], 'no leg carries the other leg\'s answer');
  // And the legacy field name is gone from what the harness writes.
  assert.equal(initial['rawResponse'], undefined);
});

// ---------------------------------------------------------------------------
// the era-gated presence rule
// ---------------------------------------------------------------------------

test('an era-stamped run whose INITIAL envelope was dropped fails closed', async () => {
  const records = await firedRecords('ok');
  leg(records, 'attempt')['responseEnvelope'] = null;
  const violations = violationsFor(records);
  assert.equal(violations.filter((v) => v.includes(ENVELOPE_MISSING)).length, 1);
  assert.ok(violations.some((v) => v.includes(':attempt:') && v.includes(ENVELOPE_MISSING)));
});

test('an era-stamped run whose REPAIR envelope was dropped fails closed', async () => {
  // The repair is its own leg and its own property. A build that retained the
  // initial envelope and lost the repair's would keep an unverifiable body on
  // the attempt whose text was ACCEPTED.
  const records = await firedRecords('repaired');
  leg(records, 'repair')['responseEnvelope'] = null;
  const violations = violationsFor(records);
  assert.equal(violations.filter((v) => v.includes(ENVELOPE_MISSING)).length, 1);
  assert.ok(violations.some((v) => v.includes(':repair:') && v.includes(ENVELOPE_MISSING)));
});

test('a leg that received NOTHING is exempt — the skip is for that case and no other', async () => {
  // The negative control the presence rule needs. A transport failure has no
  // body to retain, so a null envelope there is evidence of nothing rather
  // than evidence destroyed, and requiring one would make every timeout
  // unscoreable.
  const records = await firedRecords('transport-failure');
  const attempt = leg(records, 'attempt');
  assert.equal(attempt['responseEnvelope'], null, 'the fixture really has no envelope');
  assert.equal(attempt['answerText'], null, 'and really received nothing');
  assert.equal(violationsFor(records).filter((v) => v.includes(ENVELOPE_MISSING)).length, 0);
});

// ---------------------------------------------------------------------------
// the unconditional integrity rule
// ---------------------------------------------------------------------------

test('a retained envelope that does not reproduce its digest fails closed', async () => {
  const records = await firedRecords('ok');
  const envelope = leg(records, 'attempt')['responseEnvelope'] as { body: string; bytes: number };
  // A SAME-LENGTH edit: the byte-count binding still holds, so the digest is
  // the only thing that can catch it.
  const before = envelope.body;
  envelope.body = `${before.slice(0, -1)}X`;
  assert.equal(envelope.body.length, before.length);
  assert.equal(envelope.bytes, Buffer.byteLength(envelope.body, 'utf8'));
  const violations = violationsFor(records);
  assert.equal(violations.filter((v) => v.includes(ENVELOPE_DIGEST)).length, 1);
});

test('integrity is checked even with no era stamp — a present envelope is always verified', async () => {
  const records = await firedRecords('ok');
  const meta = records.find((record) => record['recordType'] === 'run_meta');
  delete meta?.['evidenceEra'];
  const envelope = leg(records, 'attempt')['responseEnvelope'] as { body: string };
  envelope.body = `${envelope.body} tampered`;
  const violations = violationsFor(records);
  assert.equal(violations.filter((v) => v.includes(ENVELOPE_DIGEST)).length, 1);
  assert.equal(violations.filter((v) => v.includes(ENVELOPE_MISSING)).length, 0, 'presence stays era-gated');
});

// ---------------------------------------------------------------------------
// archived files stay readable
// ---------------------------------------------------------------------------

/** Rewrite a modern artifact into the shape a pre-#92 harness wrote: the
 *  legacy field name, no envelopes, and no era stamp. */
function asArchived(records: JsonRecord[]): JsonRecord[] {
  return records.map((record) => {
    if (record['recordType'] === 'run_meta') {
      const { evidenceEra, ...rest } = record;
      void evidenceEra;
      return rest;
    }
    if (record['recordType'] !== 'arm_game_response') return record;
    const downgrade = (value: unknown): unknown => {
      if (value === null || typeof value !== 'object') return value;
      const { answerText, responseEnvelope, ...rest } = value as JsonRecord;
      void responseEnvelope;
      return { ...rest, rawResponse: answerText ?? null };
    };
    return { ...record, attempt: downgrade(record['attempt']), repair: downgrade(record['repair']) };
  });
}

test('an archived run scores exactly as the modern one does, under the old field name', async () => {
  const records = await firedRecords('repaired');
  const archived = asArchived(records);
  const archivedLeg = archived.find((r) => r['recordType'] === 'arm_game_response')?.['attempt'] as JsonRecord;
  assert.equal(archivedLeg['responseEnvelope'], undefined, 'the fixture really is envelope-free');
  assert.equal(archivedLeg['answerText'], undefined, 'and really uses the old name');
  assert.equal(typeof archivedLeg['rawResponse'], 'string');

  // Parity, not "no violations": the accepted body still re-validates, the
  // repair fingerprint still recomputes, every check that reads the answer text
  // still reads it. Comparing the two verdicts is what proves the rename lost
  // nothing, and it does not restate the modern result as its own expectation.
  assert.deepEqual(violationsFor(archived), violationsFor(records));
  assert.deepEqual(violationsFor(archived), []);
  assert.equal(parseRunRecords(lines(archived)).evidenceEra, null);
});

// ---------------------------------------------------------------------------
// the serving projection: unavailable is reported, never backfilled
// ---------------------------------------------------------------------------

const NO_SOURCE = { sourcePath: null, sourceSha256: null };
const FIXED_CLOCK = { now: (): string => '2026-07-20T18:00:00.000Z' };

function attemptFacts(records: readonly JsonRecord[]): Array<Record<string, unknown>> {
  const gate = publishableRun(records);
  assert.ok(gate.publishable, `expected publishable, got ${JSON.stringify(gate)}`);
  return projectRun(records, gate.header, NO_SOURCE, FIXED_CLOCK).attempts.map(
    (attempt) => attempt.facts as unknown as Record<string, unknown>,
  );
}

test('an envelope-unavailable attempt is reported unknown, never as "no search ran"', async () => {
  const records = await firedRecords('ok');
  // The stub answers with no search activity at all, so the archived audit is
  // null in both cases. With the body retained, that claim can be re-derived
  // from it and stands; without the body it is unfalsifiable.
  assert.equal(leg(records, 'attempt')['searchAudit'], null);
  const withEnvelope = attemptFacts(records);
  assert.deepEqual(
    withEnvelope.map((f) => f['searchEvidenceStatus']),
    withEnvelope.map(() => 'no_search_evidence'),
  );

  const archived = attemptFacts(asArchived(records));
  assert.deepEqual(
    archived.map((f) => f['searchEvidenceStatus']),
    archived.map(() => 'unknown_unproven'),
  );
  assert.equal(archived.length, withEnvelope.length, 'the same attempts, differing only in retention');
});

test('the envelope body reaches no published field', async () => {
  const records = await firedRecords('repaired');
  const bodies = (['attempt', 'repair'] as const).map(
    (name) => (leg(records, name)['responseEnvelope'] as { body: string }).body,
  );
  // A marker unique to the envelope: it is inside the synthetic provider body
  // and appears in no answer text, so finding it in a published fact means the
  // body leaked rather than that some other field happens to match.
  const marker = 'serving-test-stub';
  assert.ok(bodies.every((body) => body.includes(marker)), 'the marker really is in the envelope');
  for (const facts of attemptFacts(records)) {
    assert.ok(!JSON.stringify(facts).includes(marker), 'no published attempt fact carries the envelope');
  }
});
