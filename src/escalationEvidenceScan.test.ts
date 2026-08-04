import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { escalationEvidenceLatchSource } from './escalationEvidenceScan.js';
import type { EvidenceDirFs } from './escalationEvidenceScan.js';
import { serializeSpendEscalationSidecar } from './spendEscalationSidecar.js';
import type { SpendEscalationSidecarV1 } from './spendEscalationSidecar.js';

/**
 * The evidence-derived latch source over a REAL filesystem: only `-spend.json` files are
 * consulted; a non-null `reason` is a cause; a clean pass (`reason: null`) is not; any
 * file that cannot be read or decoded is an `unreadable_evidence` cause (fail closed); a
 * missing cohort directory is clear; every other filesystem failure rejects. The injected
 * seam drives the failure modes a real directory cannot produce deterministically.
 */

const COHORT = 'a1'.repeat(32);
const OTHER_COHORT = 'b2'.repeat(32);
const FIRE = 'f3'.repeat(32);

function sidecar(reason: SpendEscalationSidecarV1['reason'], fireId: string = FIRE): SpendEscalationSidecarV1 {
  return {
    sidecarSchemaVersion: 1,
    cohortId: COHORT,
    fireId,
    runId: 'r'.repeat(64),
    gameId: '00000000-0000-4000-8000-0000000000f1',
    scopedMarkets: ['moneyline'],
    requestSha256: 'd'.repeat(64),
    reason,
    priceVersion: 'model-price-table-v2-conservative',
    priceTableDigest: 'e'.repeat(64),
    perAttemptReservationUsdMicros: 100_000_000,
    attempts: [],
  };
}

function freshCohortDir(): { base: string; dir: string } {
  const base = mkdtempSync(join(tmpdir(), 'escalation-evidence-'));
  const dir = join(base, COHORT);
  mkdirSync(dir);
  return { base, dir };
}

test('a missing cohort directory under a READABLE root is CLEAR — this cohort installed no evidence under this root', async () => {
  const base = mkdtempSync(join(tmpdir(), 'escalation-evidence-'));
  assert.deepEqual(await escalationEvidenceLatchSource(base).causes(COHORT), []);
});

test('a missing evidence ROOT rejects — a wrong or unmounted root must never read as "no evidence"', async () => {
  const base = mkdtempSync(join(tmpdir(), 'escalation-evidence-'));
  const missingRoot = join(base, 'no-such-root');
  await assert.rejects(
    escalationEvidenceLatchSource(missingRoot).causes(COHORT),
    /evidence root .* is missing or unreadable/,
  );
});

test('seam: the root probe runs only on cohort-directory absence, and a readable root keeps that absence CLEAR', async () => {
  const ops: string[] = [];
  const rooted: EvidenceDirFs = {
    readdir(dir) {
      ops.push(`readdir:${dir}`);
      if (dir === '/base') return []; // the root itself is readable
      const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error; // the cohort directory is absent
    },
    readFile() {
      throw new Error('unreached');
    },
  };
  assert.deepEqual(await escalationEvidenceLatchSource('/base', rooted).causes(COHORT), []);
  assert.equal(ops.length, 2, 'exactly the cohort-directory read and the root probe');
  assert.equal(ops[1], 'readdir:/base', 'the probe reads the root verbatim');
});

test('a cohortId outside the sink path grammar throws BEFORE any filesystem operation', async () => {
  const ops: string[] = [];
  const spy: EvidenceDirFs = {
    readdir(dir) {
      ops.push(`readdir:${dir}`);
      return [];
    },
    readFile(path) {
      ops.push(`readFile:${path}`);
      return Buffer.alloc(0);
    },
  };
  const source = escalationEvidenceLatchSource('/base', spy);
  for (const bad of ['..', 'not-a-digest', 'A1'.repeat(32), `${'a'.repeat(63)}/`, '']) {
    await assert.rejects(source.causes(bad), /not a lowercase sha256 digest/);
  }
  assert.deepEqual(ops, [], 'no path was formed from an unvalidated identifier');
});

test('real directory: escalation sidecars latch, a clean pass does not, fire artifacts and unrelated files are ignored — in sorted name order', async () => {
  const { base, dir } = freshCohortDir();
  // Real serialized sidecar bytes, exactly what the sink installs.
  writeFileSync(join(dir, 'fire-g1-moneyline-b-spend.json'), serializeSpendEscalationSidecar(sidecar('spend_evidence_unknown')));
  writeFileSync(join(dir, 'fire-g1-moneyline-a-spend.json'), serializeSpendEscalationSidecar(sidecar('spend_attempt_over_reservation')));
  writeFileSync(join(dir, 'fire-g1-moneyline-c-spend.json'), serializeSpendEscalationSidecar(sidecar(null)));
  writeFileSync(join(dir, `fire-g1-moneyline-${FIRE}.json`), '{"artifact":true}'); // a fire artifact, not spend evidence
  writeFileSync(join(dir, 'notes.txt'), 'unrelated');

  const causes = await escalationEvidenceLatchSource(base).causes(COHORT);
  assert.deepEqual(
    causes.map((c) => ({ ...c })),
    [
      { kind: 'escalation_evidence', path: join(dir, 'fire-g1-moneyline-a-spend.json'), reason: 'spend_attempt_over_reservation' },
      { kind: 'escalation_evidence', path: join(dir, 'fire-g1-moneyline-b-spend.json'), reason: 'spend_evidence_unknown' },
    ],
    'both escalations latch, sorted by name; the clean pass, the artifact, and the stray file do not',
  );
});

test('an escalated cohort does not latch a DIFFERENT cohort — the scan is per-cohort-directory', async () => {
  const { base, dir } = freshCohortDir();
  writeFileSync(join(dir, 'fire-g1-moneyline-a-spend.json'), serializeSpendEscalationSidecar(sidecar('spend_evidence_unknown')));
  assert.deepEqual(await escalationEvidenceLatchSource(base).causes(OTHER_COHORT), []);
});

test('fail closed on ambiguity: non-JSON, a non-object, a missing reason, and an unrecognized reason are all unreadable_evidence causes', async () => {
  const { base, dir } = freshCohortDir();
  writeFileSync(join(dir, 'a-spend.json'), 'not json at all');
  writeFileSync(join(dir, 'b-spend.json'), '[1,2,3]');
  writeFileSync(join(dir, 'c-spend.json'), '{"sidecarSchemaVersion":1}');
  writeFileSync(join(dir, 'd-spend.json'), '{"reason":"something_new"}');

  const causes = await escalationEvidenceLatchSource(base).causes(COHORT);
  assert.deepEqual(
    causes.map((c) => ({ ...c })),
    [
      { kind: 'unreadable_evidence', path: join(dir, 'a-spend.json'), detail: 'not valid JSON' },
      { kind: 'unreadable_evidence', path: join(dir, 'b-spend.json'), detail: 'not a JSON object' },
      { kind: 'unreadable_evidence', path: join(dir, 'c-spend.json'), detail: 'missing reason field' },
      { kind: 'unreadable_evidence', path: join(dir, 'd-spend.json'), detail: 'unrecognized reason "something_new"' },
    ],
  );
});

test('a directory-listing failure other than ENOENT REJECTS — never read as clear', async () => {
  const denied: EvidenceDirFs = {
    readdir() {
      const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    },
    readFile() {
      throw new Error('unreached');
    },
  };
  await assert.rejects(escalationEvidenceLatchSource('/base', denied).causes(COHORT), /EACCES/);
});

test('a file-read failure latches THAT file as unreadable_evidence, and causes come in sorted name order even when readdir does not', async () => {
  const flaky: EvidenceDirFs = {
    readdir() {
      // Deliberately UNSORTED: the deterministic-order guarantee must come from the
      // scan's own sort, not from whatever order the platform lists entries in.
      return ['y-spend.json', 'x-spend.json'];
    },
    readFile(path) {
      if (path.endsWith('x-spend.json')) {
        throw new Error('EIO: i/o error');
      }
      return Buffer.from(serializeSpendEscalationSidecar(sidecar('spend_evidence_unknown')), 'utf8');
    },
  };
  const causes = await escalationEvidenceLatchSource('/base', flaky).causes(COHORT);
  assert.equal(causes.length, 2);
  const first = causes[0]!;
  assert.equal(first.kind, 'unreadable_evidence');
  if (first.kind !== 'unreadable_evidence') return;
  assert.match(first.detail, /read failed: EIO/);
  assert.ok(first.path.endsWith('x-spend.json'), 'x sorts first despite readdir listing y first');
  const second = causes[1]!;
  assert.equal(second.kind, 'escalation_evidence');
  assert.ok(second.path.endsWith('y-spend.json'));
});
