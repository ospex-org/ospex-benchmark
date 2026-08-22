import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256Hex } from './canonical.js';
import { createRealAdapters } from './providers/index.js';
import { EVIDENCE_ERA } from './providers/responseEnvelope.js';
import { defaultExpectedArms, parseRunRecords, verifyRunIntegrity } from './scoring.js';
import { replaySearchAudits } from './searchAuditReplay.js';
import { projectRun, publishableRun } from './servingProjection.js';
import { firedRun, UNPARSEABLE_2XX_BODY } from './servingTestRun.js';
import { damageEnvelope, ENVELOPE_DAMAGE } from './testFactories.js';
import type { EnvelopeDamage } from './testFactories.js';
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
 *   - PRESENCE is required by DEFAULT, and waived only for a file that reads as
 *     a coherent pre-retention archive as a whole, so an archive is reported as
 *     envelope-unavailable rather than failed for a field that did not exist
 *     when it was written — and no single edit to a modern artifact buys that
 *     waiver;
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

async function firedRecords(
  behaviour: 'ok' | 'repaired' | 'transport-failure' | 'unparseable-2xx',
): Promise<JsonRecord[]> {
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

/** Bytes a proxy in front of a provider really sends, written non-canonically
 *  so "the exact bytes survived the chain" is a checkable claim. */
const PROXY_HTML = '<!doctype html>\n  <html><body>upstream timeout</body></html>';

/**
 * Fire the enrolled arm through the PRODUCTION adapter — the real request
 * builder, the real `postJson`, the real error types — against `respond`, and
 * return the records the runner wrote.
 *
 * No socket is opened: `globalThis.fetch` is replaced for the duration and
 * restored in a `finally`. The credential is synthetic and is never in the
 * response, so nothing about redaction changes.
 */
async function firedThroughRealAdapter(respond: () => Response): Promise<JsonRecord[]> {
  const adapter = createRealAdapters().get(FIRED_PARTICIPANT);
  assert.ok(adapter !== undefined, `the production registry has no adapter for ${FIRED_PARTICIPANT}`);
  const originalFetch = globalThis.fetch;
  const priorKey = process.env[adapter.credentialEnvVar];
  process.env[adapter.credentialEnvVar] = 'synthetic-test-credential';
  globalThis.fetch = (async () => respond()) as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), 'envelope-real-adapter-'));
  try {
    const run = await firedRun({ outDir: dir, enrolled: true, adapter, gameId: nextGameId() });
    const records = run.records.map((record) => JSON.parse(JSON.stringify(record)) as JsonRecord);
    assert.ok(
      records.some((record) => record['recordType'] === 'arm_game_response'),
      'the fire produced an arm response, so the case is not vacuous',
    );
    return records;
  } finally {
    globalThis.fetch = originalFetch;
    if (priorKey === undefined) delete process.env[adapter.credentialEnvVar];
    else process.env[adapter.credentialEnvVar] = priorKey;
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
// the presence rule, and the one file shape that is exempt from it
// ---------------------------------------------------------------------------

test('an era-stamped run whose INITIAL envelope was dropped fails closed', async () => {
  const records = await firedRecords('ok');
  leg(records, 'attempt')['responseEnvelope'] = null;
  const violations = violationsFor(records);
  assert.equal(violations.filter((v) => v.includes(ENVELOPE_MISSING)).length, 1);
  assert.ok(violations.some((v) => v.includes(':attempt:') && v.includes(ENVELOPE_MISSING)));
  // The stamp keeps its declarative job: it NAMES the era in the message. It
  // no longer decides whether the rule runs, which is the whole of B1.
  assert.ok(
    violations.some((v) => v.includes(`evidence era ${EVIDENCE_ERA}`)),
    JSON.stringify(violations),
  );
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

test('ANY single sign that a response came back requires a retained envelope', async () => {
  // Rule 3k, the half the cases above do not reach: SWEEP THE PREDICATE.
  // `reachedProvider` is three OR'd signals, and every other fixture in this
  // file carries all three at once — so no one of them is load-bearing, and a
  // build consulting only `answerText` would exempt a leg whose answer text was
  // stripped alongside its envelope. That is not a hypothetical shape: it is
  // exactly the hand-edited artifact this rule exists to refuse, and a mutant
  // reading one disjunct passed the whole suite before this case existed.
  //
  // Each case leaves ONE signal standing, so that disjunct is the only thing
  // that can produce the refusal.
  const signals = ['answerText', 'reportedModelId', 'providerResponseId'] as const;
  for (const kept of signals) {
    const records = await firedRecords('ok');
    const attempt = leg(records, 'attempt');
    attempt['responseEnvelope'] = null;
    for (const signal of signals) {
      if (signal !== kept) attempt[signal] = null;
    }
    assert.notEqual(attempt[kept], null, `${kept} is the one signal left standing`);
    assert.equal(attempt['rawResponse'], undefined, 'and no archived alias revives the answer');
    const violations = violationsFor(records);
    assert.equal(
      violations.filter((v) => v.includes(ENVELOPE_MISSING)).length,
      1,
      `${kept} alone must still require an envelope: ${JSON.stringify(violations)}`,
    );
  }
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

test('a retained REPAIR envelope that does not reproduce its digest fails closed', async () => {
  // The sibling of the case above, and not a duplicate of it. Verification runs
  // per leg, so it can be disabled for one leg alone — and on a repaired
  // decision the repair IS the accepted attempt, so its body is the one backing
  // the published forecast. Every digest case tampered the initial leg, and a
  // mutant exempting `repair` passed the whole suite.
  const records = await firedRecords('repaired');
  const envelope = leg(records, 'repair')['responseEnvelope'] as { body: string; bytes: number };
  const before = envelope.body;
  envelope.body = `${before.slice(0, -1)}X`;
  // Same length, so the byte-count binding still holds and the DIGEST is the
  // only thing that can catch it.
  assert.equal(envelope.bytes, Buffer.byteLength(envelope.body, 'utf8'));
  const violations = violationsFor(records);
  assert.equal(violations.filter((v) => v.includes(ENVELOPE_DIGEST)).length, 1);
  assert.ok(
    violations.some((v) => v.includes(':repair:') && v.includes(ENVELOPE_DIGEST)),
    `the violation names the repair leg: ${JSON.stringify(violations)}`,
  );
});

test('integrity is checked even with no era stamp — a present envelope is always verified', async () => {
  // The MECHANISM this test has always measured, and it is still true: a
  // present envelope that does not reproduce its digest is a violation
  // whatever the run's era. Kept, because the measurement is worth having.
  //
  // What it used to assert BESIDE that was the hole. It pinned, as correct,
  // that deleting the run's era stamp also switched the presence requirement
  // off — factually right about the code and wrong about what the code bought,
  // which is rule 3j exactly. The adversarial question:
  // deleting one optional field from a modern artifact stripped every
  // retention guarantee from the run while it still verified clean. So the
  // consequence is asserted here now, next to the mechanism, and the probe
  // that demonstrates it is the test immediately below.
  const records = await firedRecords('ok');
  const meta = records.find((record) => record['recordType'] === 'run_meta');
  delete meta?.['evidenceEra'];
  const envelope = leg(records, 'attempt')['responseEnvelope'] as { body: string };
  envelope.body = `${envelope.body} tampered`;
  const violations = violationsFor(records);
  assert.equal(violations.filter((v) => v.includes(ENVELOPE_DIGEST)).length, 1);
  assert.equal(
    violations.filter((v) => v.includes(ENVELOPE_MISSING)).length,
    0,
    'and no presence violation, because this envelope is PRESENT — it is only damaged',
  );
});

test("THE REVIEWER'S PROBE: deleting the era stamp no longer switches presence off", async () => {
  // One field deleted from run_meta, one envelope nulled. Under the rule this
  // replaces, that verified clean. The file still says `answerText` and still
  // carries `responseEnvelope` keys, so it is not an archive and the
  // requirement stands.
  const records = await firedRecords('ok');
  const meta = records.find((record) => record['recordType'] === 'run_meta');
  assert.equal(meta?.['evidenceEra'], EVIDENCE_ERA, 'the stamp is there to begin with');
  delete meta?.['evidenceEra'];
  leg(records, 'attempt')['responseEnvelope'] = null;

  const violations = violationsFor(records);
  assert.equal(violations.filter((v) => v.includes(ENVELOPE_MISSING)).length, 1);
  assert.ok(
    violations.some((v) => v.includes(':attempt:') && v.includes(ENVELOPE_MISSING)),
    JSON.stringify(violations),
  );
  // The message says WHY the file was not exempt, so an operator reading it
  // does not conclude the stamp is missing by accident.
  assert.ok(
    violations.some((v) => v.includes('not a coherent pre-retention archive')),
    JSON.stringify(violations),
  );
});

test('a GENUINE archive with no envelopes anywhere is still exempt — the rival control', async () => {
  // The other half of the pair, and it is a RIVAL rather than a duplicate: a
  // build that reverted to the era gate reddens the probe above and leaves
  // this green, and a build that enforced unconditionally does the opposite.
  // Neither mutation can satisfy both.
  const archived = asArchived(await firedRecords('repaired'));
  for (const name of ['attempt', 'repair'] as const) {
    const archivedLeg = armResponse(archived)[name] as JsonRecord;
    assert.equal(archivedLeg['responseEnvelope'], undefined, 'no envelope key at all');
    assert.equal(archivedLeg['answerText'], undefined, 'and the old answer name');
    assert.equal(typeof archivedLeg['rawResponse'], 'string', 'which really carries an answer');
  }
  assert.equal(violationsFor(archived).filter((v) => v.includes(ENVELOPE_MISSING)).length, 0);
});

// ---------------------------------------------------------------------------
// THE DELETION TABLE — each row is what one edit to a modern artifact buys
// ---------------------------------------------------------------------------

/** Run_meta, for the rows that edit it. */
function runMeta(records: JsonRecord[]): JsonRecord {
  const found = records.find((record) => record['recordType'] === 'run_meta');
  assert.ok(found !== undefined, 'the fired run wrote a run_meta');
  return found;
}

/** Apply `edit` to every leg of every arm response. */
function everyLeg(records: JsonRecord[], edit: (leg: JsonRecord) => void): void {
  for (const record of records) {
    if (record['recordType'] !== 'arm_game_response') continue;
    for (const name of ['attempt', 'repair'] as const) {
      const value = record[name];
      if (value !== null && typeof value === 'object') edit(value as JsonRecord);
    }
  }
}

test('THE DELETION TABLE: every era carrier can only RAISE enforcement', async () => {
  // The specification, as a table with LITERAL expectations. The fixture is
  // the repaired run, so it has TWO legs and both received a response —
  // which is what makes "one violation per reached leg" distinguishable from
  // "one violation".
  const table: Array<{
    name: string;
    edit: (records: JsonRecord[]) => void;
    expected: number | 'parse-refused';
  }> = [
    {
      name: 'nothing edited: the file the harness wrote',
      edit: () => {},
      expected: 0,
    },
    {
      name: 'delete evidenceEra only, and null ONE envelope',
      edit: (records) => {
        delete runMeta(records)['evidenceEra'];
        leg(records, 'attempt')['responseEnvelope'] = null;
      },
      expected: 1,
    },
    {
      name: 'delete evidenceEra and DELETE every envelope key',
      edit: (records) => {
        delete runMeta(records)['evidenceEra'];
        everyLeg(records, (value) => {
          delete value['responseEnvelope'];
        });
      },
      expected: 2,
    },
    {
      name: 'delete evidenceEra and NULL every envelope (a key is still a key)',
      edit: (records) => {
        delete runMeta(records)['evidenceEra'];
        everyLeg(records, (value) => {
          value['responseEnvelope'] = null;
        });
      },
      expected: 2,
    },
    {
      name: 'delete evidenceEra, every envelope AND every answerText',
      edit: (records) => {
        delete runMeta(records)['evidenceEra'];
        everyLeg(records, (value) => {
          delete value['responseEnvelope'];
          delete value['answerText'];
        });
      },
      expected: 'parse-refused',
    },
    {
      // THE STAMP'S OWN ROW, and it is the one the scorer was missing. Every
      // other row here deletes the stamp, so a build that ignored it entirely
      // — reading the legs alone — answered all of them correctly. This is the
      // row above with the stamp LEFT IN: the legs are rewritten into the
      // archive shape, so the leg clauses are satisfied and the stamp is the
      // only thing that can withdraw the exemption. A mutant hardcoding the
      // scorer's `evidenceEraStamped` to false survived the whole suite until
      // this row existed.
      name: 'KEEP evidenceEra and rewrite every leg into the archive shape',
      edit: (records) => {
        assert.equal(runMeta(records)['evidenceEra'], EVIDENCE_ERA, 'the stamp stays');
        everyLeg(records, (value) => {
          value['rawResponse'] = value['answerText'];
          delete value['answerText'];
          delete value['responseEnvelope'];
        });
      },
      expected: 2,
    },
    {
      name: 'a genuine pre-#92 archive',
      edit: () => {},
      expected: 0,
    },
  ];

  for (const row of table) {
    const records = row.name.includes('genuine pre-#92')
      ? asArchived(await firedRecords('repaired'))
      : await firedRecords('repaired');
    row.edit(records);
    if (row.expected === 'parse-refused') {
      assert.throws(() => parseRunRecords(lines(records)), /answerText/, row.name);
      continue;
    }
    const missing = violationsFor(records).filter((v) => v.includes(ENVELOPE_MISSING));
    assert.equal(missing.length, row.expected, `${row.name}: ${JSON.stringify(missing)}`);
  }
});

test('the archive exemption is whole-FILE: one modern leg withdraws it from every leg', async () => {
  // A hand-edit that downgrades MOST of a file does not buy the exemption. The
  // control is the row above ('a genuine pre-#92 archive'), which is the same
  // transformation applied to every leg and scores clean.
  const records = asArchived(await firedRecords('repaired'));
  const repair = armResponse(records)['repair'] as JsonRecord;
  // One leg put back into the modern shape, with no envelope beside it.
  repair['answerText'] = repair['rawResponse'];
  delete repair['rawResponse'];

  const missing = violationsFor(records).filter((v) => v.includes(ENVELOPE_MISSING));
  assert.equal(missing.length, 2, `both legs are enforced, not just the giveaway: ${JSON.stringify(missing)}`);
});

// ---------------------------------------------------------------------------
// a 2xx is a receipt, even when nothing survived it
// ---------------------------------------------------------------------------

test('a 200 whose body did not parse retains that body in the artifact', async () => {
  // B2, at the layer that matters: the file. The adapter extracted nothing, so
  // every content field is null — and the bytes are still there.
  const records = await firedRecords('unparseable-2xx');
  const attempt = leg(records, 'attempt');
  assert.equal(attempt['httpStatus'], 200);
  assert.equal(attempt['answerText'], null);
  assert.equal(attempt['reportedModelId'], null);
  assert.equal(attempt['providerResponseId'], null);
  const envelope = attempt['responseEnvelope'] as { body: string; sha256: string; bytes: number };
  assert.ok(envelope !== null && typeof envelope === 'object', 'the received bytes were retained');
  assert.equal(envelope.body, UNPARSEABLE_2XX_BODY, 'exactly as received');
  assert.equal(envelope.sha256, sha256Hex(UNPARSEABLE_2XX_BODY));
  assert.equal(envelope.bytes, Buffer.byteLength(UNPARSEABLE_2XX_BODY, 'utf8'));
  assert.equal(violationsFor(records).filter((v) => v.includes(ENVELOPE_MISSING)).length, 0);
});

test('a 2xx status ALONE requires an envelope — with every other signal null', async () => {
  // Rule 3b, and the reason this fixture exists rather than a reuse of the
  // 'ok' one: `answerText`, `reportedModelId` and `providerResponseId` are all
  // null here, so the three older disjuncts cannot produce this refusal and
  // the status is the only thing that can. On the 'ok' fixture all four are
  // present and a build consulting any one of them passes.
  const records = await firedRecords('unparseable-2xx');
  const attempt = leg(records, 'attempt');
  assert.deepEqual(
    ['answerText', 'reportedModelId', 'providerResponseId'].map((field) => attempt[field]),
    [null, null, null],
    'no content signal is left standing',
  );
  assert.equal(attempt['rawResponse'], undefined, 'and no archived alias revives one');
  attempt['responseEnvelope'] = null;

  const violations = violationsFor(records);
  assert.equal(
    violations.filter((v) => v.includes(ENVELOPE_MISSING)).length,
    1,
    `the status alone must require an envelope: ${JSON.stringify(violations)}`,
  );
});

test('a leg with NO status and no content is still exempt — the receipt has a negative side', async () => {
  // The negative control for the widening. A transport failure never got a
  // status, so nothing says a body arrived and requiring one would make every
  // dropped connection unscoreable. Measured on the same rule, one field over.
  const records = await firedRecords('transport-failure');
  const attempt = leg(records, 'attempt');
  assert.equal(attempt['httpStatus'], null, 'the fixture really never settled on a status');
  assert.equal(attempt['responseEnvelope'], null);
  assert.equal(violationsFor(records).filter((v) => v.includes(ENVELOPE_MISSING)).length, 0);
});

test('THE RECEIPT TABLE: erasing an errored leg takes three consistent edits, not one', async () => {
  // The hole a reviewer found after the era redesign, at the artifact layer.
  // The era stamp stopped being a one-field exemption; `httpStatus` had become
  // one instead, on exactly the leg class the 2xx receipt was added to
  // protect — a 200 whose body no parser understood, where the status is the
  // only content-free sign a body arrived.
  //
  // The fixture is the unparseable 2xx, so `answerText`, `reportedModelId` and
  // `providerResponseId` are all null: nothing but a status carrier can produce
  // a refusal here, which is what makes each row discriminate (rule 3b).
  const carriers: Array<{ name: string; edit: (leg: JsonRecord) => void; expected: number }> = [
    { name: 'nothing edited: the file the harness wrote', edit: () => {}, expected: 0 },
    {
      name: 'delete the envelope only',
      edit: (value) => {
        delete value['responseEnvelope'];
      },
      expected: 1,
    },
    {
      name: 'delete the envelope and NULL httpStatus — the reviewer\'s one-field edit',
      edit: (value) => {
        delete value['responseEnvelope'];
        value['httpStatus'] = null;
      },
      expected: 1,
    },
    {
      name: 'delete the envelope and DELETE the httpStatus key',
      edit: (value) => {
        delete value['responseEnvelope'];
        delete value['httpStatus'];
      },
      expected: 1,
    },
    {
      name: 'delete the envelope and put httpStatus just under the 2xx window',
      edit: (value) => {
        delete value['responseEnvelope'];
        value['httpStatus'] = 199;
      },
      expected: 1,
    },
    {
      name: 'delete the envelope and NULL errorDetail, leaving the status',
      edit: (value) => {
        delete value['responseEnvelope'];
        value['errorDetail'] = null;
      },
      expected: 1,
    },
    {
      name: 'delete the envelope, delete the httpStatus key AND null errorDetail',
      edit: (value) => {
        delete value['responseEnvelope'];
        delete value['httpStatus'];
        value['errorDetail'] = null;
      },
      expected: 1,
    },
    {
      // THE BOUND, pinned so the prose cannot drift from it. This is not a
      // behaviour being blessed as fine: it is the residual named in
      // `receivedProviderResponse`, in the README and in the PR body, and the
      // point of the row is that reaching it costs three mutually consistent
      // edits to one leg rather than one. A leg with no content, no status and
      // no error text is genuinely indistinguishable from a call that never
      // landed, in a file that is bound to nothing outside itself.
      name: 'THE BOUND: envelope gone, httpStatus null, errorDetail silent',
      edit: (value) => {
        delete value['responseEnvelope'];
        value['httpStatus'] = null;
        value['errorDetail'] = null;
      },
      expected: 0,
    },
  ];

  for (const row of carriers) {
    const records = await firedRecords('unparseable-2xx');
    const attempt = leg(records, 'attempt');
    assert.deepEqual(
      ['answerText', 'reportedModelId', 'providerResponseId'].map((field) => attempt[field]),
      [null, null, null],
      'no content signal is left standing, so only a status carrier can decide',
    );
    assert.match(
      String(attempt['errorDetail']),
      /^\S+ returned HTTP 200:/,
      'and the leg really does state its status in prose too',
    );
    row.edit(attempt);
    const missing = violationsFor(records).filter((v) => v.includes(ENVELOPE_MISSING));
    assert.equal(missing.length, row.expected, `${row.name}: ${JSON.stringify(missing)}`);
  }
});

// ---------------------------------------------------------------------------
// the PRODUCTION http layer, the runner and the file, in one chain
// ---------------------------------------------------------------------------

test('a 200 an adapter could not parse is retained END TO END, and stripping it fails closed', async () => {
  // The two halves joined. Everything below the assertion is production: the
  // real registry adapter builds the request, the real `postJson` reads the
  // canned response, the real runner persists it and the file is read back off
  // disk. The stub-driven cases above and the adapter cases in
  // `providers/responseEnvelope.test.ts` each cover one side of that seam.
  const records = await firedThroughRealAdapter(() => new Response(PROXY_HTML, { status: 200 }));
  const attempt = leg(records, 'attempt');
  assert.equal(attempt['httpStatus'], 200);
  const envelope = attempt['responseEnvelope'] as { body: string; sha256: string; bytes: number };
  assert.ok(envelope !== null && typeof envelope === 'object', 'the received bytes survived the chain');
  assert.equal(envelope.body, PROXY_HTML, 'byte-identical to what fetch returned');
  assert.equal(envelope.sha256, sha256Hex(PROXY_HTML));
  assert.equal(violationsFor(records).filter((v) => v.includes(ENVELOPE_MISSING)).length, 0);

  // And the same file with the envelope taken out is refused — so the chain is
  // load-bearing rather than incidental.
  delete attempt['responseEnvelope'];
  assert.equal(violationsFor(records).filter((v) => v.includes(ENVELOPE_MISSING)).length, 1);
});

test('a connection that DROPS mid-body leaves an untampered file that still scores', async () => {
  // The regression this pairs with: reporting the header status here made an
  // ordinary dropped connection a 2xx receipt owing an envelope that cannot
  // exist, and `scoreRun` and `servingProjection` both refuse a run with any
  // integrity violation — so one dropped connection on one leg made the whole
  // file unscoreable and unpublishable, with no operator remedy.
  const records = await firedThroughRealAdapter(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"partial":'));
            controller.error(new Error('ECONNRESET'));
          },
        }),
        { status: 200 },
      ),
  );
  const attempt = leg(records, 'attempt');
  assert.equal(attempt['httpStatus'], 0, 'no HTTP exchange completed, so no status is claimed');
  assert.equal(attempt['responseEnvelope'], null, 'and nothing was retained, because nothing was read');
  assert.match(String(attempt['errorDetail']), /response body read failed/);
  assert.deepEqual(
    ['answerText', 'reportedModelId', 'providerResponseId'].map((field) => attempt[field]),
    [null, null, null],
    'every content signal is null, so the status is the only thing that could refuse this file',
  );
  assert.deepEqual(
    violationsFor(records).filter((v) => v.includes(ENVELOPE_MISSING)),
    [],
    'an untampered artifact from a dropped connection is still scoreable',
  );
});

// ---------------------------------------------------------------------------
// exactly one answer name
// ---------------------------------------------------------------------------

test('an attempt carrying BOTH answer names is refused at the parse', async () => {
  // Two fixtures, because two DIFFERENT rules both refuse the obvious one
  // (rule 3g-both). A rule written "refuse when the two names DISAGREE" and a
  // rule written "refuse when both are PRESENT" agree about the differing
  // case and disagree about the byte-equal one — so only the second fixture
  // says which rule shipped, and the first is here to show the pair is not
  // vacuous.
  const differing = await firedRecords('ok');
  const differingLeg = leg(differing, 'attempt');
  const answer = differingLeg['answerText'];
  assert.equal(typeof answer, 'string', 'the leg starts with exactly one name');
  differingLeg['rawResponse'] = 'a different answer entirely';
  assert.notEqual(differingLeg['rawResponse'], answer, 'the two names DISAGREE here');
  assert.throws(() => parseRunRecords(lines(differing)), /exactly one name/);

  // The discriminating case: byte-identical values. Nothing is contradicted,
  // and it is still refused — the rule is about the file stating its answer
  // twice, not about the two statements differing.
  const identical = await firedRecords('ok');
  const identicalLeg = leg(identical, 'attempt');
  identicalLeg['rawResponse'] = identicalLeg['answerText'];
  assert.equal(identicalLeg['rawResponse'], identicalLeg['answerText'], 'byte-equal, so only "both present" can refuse it');
  assert.throws(() => parseRunRecords(lines(identical)), /exactly one name/);

  // And the negative control: one name alone still parses, under either name.
  const modern = await firedRecords('ok');
  assert.doesNotThrow(() => parseRunRecords(lines(modern)));
  assert.doesNotThrow(() => parseRunRecords(lines(asArchived(modern))));
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

test('an attempt carrying NEITHER answer name is refused at the parse', async () => {
  // The rename's fail-open edge. Before it, the answer was ONE required key, so
  // a record missing it never parsed. Making both names optional — so a file of
  // either era can be read — would on its own also accept a record carrying
  // NEITHER, and read it as a null answer: a value the file never stated.
  //
  // The harness cannot write this shape, which is the point. It is what a
  // hand-edited artifact looks like, and the parse gate exists for nothing else.
  const records = await firedRecords('ok');
  // Negative control FIRST, on the untouched file: whatever the refusal below
  // is about, it is not about this fixture being malformed to begin with.
  assert.doesNotThrow(() => parseRunRecords(lines(records)));

  const attempt = leg(records, 'attempt');
  assert.equal(typeof attempt['answerText'], 'string', 'the leg really carries the modern name');
  delete attempt['answerText'];
  assert.equal(attempt['rawResponse'], undefined, 'and no archived alias is left behind');
  assert.throws(() => parseRunRecords(lines(records)), /answerText/);

  // The archived name ALONE is still accepted, or every pre-#92 file becomes
  // unparseable — which is the other half of the same rule, not a separate one.
  attempt['rawResponse'] = 'an archived answer';
  assert.doesNotThrow(() => parseRunRecords(lines(records)));
});

test('BOTH readers refuse the same damaged envelope shapes, on the same bytes', async () => {
  // B1-b. The two readers had separate definitions of an envelope and they
  // disagreed: an envelope carrying an extra key made the scorer refuse the
  // whole file, while the replay read the same bytes, reported the leg as
  // fully replayed and exited 0. They now import ONE schema, and this is the
  // measurement of that over a real fired artifact.
  //
  // The table is swept rather than sampled because the four damages used to
  // produce three DIFFERENT replay answers between them, so any single one
  // would have measured only its own corner.
  const clean = await firedRecords('ok');
  // Negative control FIRST, on the untouched file, so every refusal below is
  // about the damage rather than about the fixture.
  assert.doesNotThrow(() => parseRunRecords(lines(clean)));
  assert.equal(replaySearchAudits(lines(clean)).legs[0]!.envelope, 'retained');

  for (const damage of Object.keys(ENVELOPE_DAMAGE) as EnvelopeDamage[]) {
    const records = await firedRecords('ok');
    const attempt = leg(records, 'attempt');
    const sealed = attempt['responseEnvelope'] as { body: string; sha256: string; bytes: number };
    assert.equal(typeof sealed.sha256, 'string', 'the fixture starts well formed');
    attempt['responseEnvelope'] = damageEnvelope(sealed, damage);

    assert.throws(
      () => parseRunRecords(lines(records)),
      /responseEnvelope/,
      `the scorer refuses ${damage}`,
    );
    assert.equal(
      replaySearchAudits(lines(records)).legs[0]!.envelope,
      'malformed',
      `the replay refuses ${damage}`,
    );
  }
});

// ---------------------------------------------------------------------------
// the serving projection: unavailable is reported, never backfilled
// ---------------------------------------------------------------------------

const NO_SOURCE = { sourcePath: null, sourceSha256: null };
const FIXED_CLOCK = { now: (): string => '2026-07-20T18:00:00.000Z' };

function projection(records: readonly JsonRecord[]): ReturnType<typeof projectRun> {
  const gate = publishableRun(records);
  assert.ok(gate.publishable, `expected publishable, got ${JSON.stringify(gate)}`);
  return projectRun(records, gate.header, NO_SOURCE, FIXED_CLOCK);
}

function attemptFacts(records: readonly JsonRecord[]): Array<Record<string, unknown>> {
  return projection(records).attempts.map(
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

test('a retained body that no parser accepts publishes unknown, not a provable negative', async () => {
  // The half that came apart when retention widened to every 2xx. A 200 whose
  // body is an HTML error page now HAS an envelope, so a rule reading presence
  // alone would publish `no_search_evidence` — a provable negative — about
  // bytes nothing can re-derive an audit from, while `replay:search-audit`
  // calls the same leg `unparseable` and exits 1. The control is the case
  // above, which is the same absent audit with a parseable body beside it.
  const records = await firedRecords('unparseable-2xx');
  const attempt = leg(records, 'attempt');
  assert.equal(attempt['searchAudit'], null, 'the archived audit is absent in both cases');
  const envelope = attempt['responseEnvelope'] as { body: string };
  assert.ok(envelope !== null && typeof envelope === 'object', 'and an envelope IS retained');
  assert.throws(() => JSON.parse(envelope.body), 'which is exactly what cannot be re-parsed');

  const facts = attemptFacts(records);
  assert.ok(facts.length > 0, 'the run projects at least one attempt row');
  assert.deepEqual(
    facts.map((f) => f['searchEvidenceStatus']),
    facts.map(() => 'unknown_unproven'),
  );
  // And the replay agrees on the same bytes, which is the point of the pair.
  const report = replaySearchAudits(lines(records));
  assert.equal(report.legs[0]!.envelope, 'unparseable');
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
  // The WHOLE plan, not just the attempt facts: a plan also carries `run` and
  // `decisions`, and scanning only the rows the envelope is nearest to would
  // leave the other two publishable surfaces unmeasured.
  const plan = projection(records);
  assert.ok(plan.attempts.length > 0 && plan.decisions.length > 0, 'the plan has rows of both kinds to scan');
  assert.ok(
    !JSON.stringify(plan).includes(marker),
    'no published row of any kind carries the envelope body',
  );
});
