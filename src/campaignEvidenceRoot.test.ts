import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  EVIDENCE_ROOT_MARKER,
  evidenceRootMarkerBytes,
  installEvidenceRootMarker,
  parseEvidenceRootMarker,
  readEvidenceRootMarker,
  verifyEvidenceRoot,
} from './campaignEvidenceRoot.js';

/**
 * The evidence root's durable identity, over the REAL filesystem: the strict marker
 * grammar; absence vs unreadability; the durable no-clobber install (fresh, reconciled,
 * conflicting); and the tick-side verification that refuses everything except the exact
 * armed identity at the exact armed root. These are the primitives the latch-bypass
 * tripwires in campaignMain.test.ts compose.
 */

const ID = 'root-id-under-test';

function freshRoot(): string {
  return join(mkdtempSync(join(tmpdir(), 'evidence-root-')), 'root');
}

test('parseEvidenceRootMarker: the exact grammar and nothing else', () => {
  assert.deepEqual(parseEvidenceRootMarker(evidenceRootMarkerBytes(ID)), {
    evidenceRootVersion: 1,
    evidenceRootId: ID,
  });
  const bad: Array<[string, Buffer, RegExp]> = [
    ['not JSON', Buffer.from('{nope', 'utf8'), /not valid JSON/],
    ['not an object', Buffer.from('[1]', 'utf8'), /not a JSON object/],
    ['missing keys', Buffer.from('{"evidenceRootId":"x"}', 'utf8'), /keys \[evidenceRootId\]/],
    ['extra key', Buffer.from('{"evidenceRootVersion":1,"evidenceRootId":"x","extra":1}', 'utf8'), /keys \[/],
    ['wrong version', Buffer.from('{"evidenceRootVersion":2,"evidenceRootId":"x"}', 'utf8'), /version 2 is not the supported 1/],
    ['empty id', Buffer.from('{"evidenceRootVersion":1,"evidenceRootId":""}', 'utf8'), /no evidenceRootId/],
  ];
  for (const [label, bytes, expectation] of bad) {
    assert.throws(() => parseEvidenceRootMarker(bytes), expectation, label);
  }
});

test('readEvidenceRootMarker: absent for a missing root, a marker-less root, and a FILE at the root path; unreadable for garbage', () => {
  const missing = freshRoot(); // never created
  assert.deepEqual(readEvidenceRootMarker(missing), { kind: 'absent' });

  const empty = mkdtempSync(join(tmpdir(), 'evidence-root-empty-'));
  assert.deepEqual(readEvidenceRootMarker(empty), { kind: 'absent' });

  const filePath = join(mkdtempSync(join(tmpdir(), 'evidence-root-file-')), 'occupied');
  writeFileSync(filePath, 'a file, not a directory');
  assert.deepEqual(readEvidenceRootMarker(filePath), { kind: 'absent' }, 'ENOTDIR reads as absent — the marker is just as gone');

  const garbage = mkdtempSync(join(tmpdir(), 'evidence-root-garbage-'));
  writeFileSync(join(garbage, EVIDENCE_ROOT_MARKER), '{nope');
  const read = readEvidenceRootMarker(garbage);
  assert.equal(read.kind, 'unreadable');

  const present = mkdtempSync(join(tmpdir(), 'evidence-root-present-'));
  writeFileSync(join(present, EVIDENCE_ROOT_MARKER), evidenceRootMarkerBytes(ID));
  assert.deepEqual(readEvidenceRootMarker(present), { kind: 'present', marker: { evidenceRootVersion: 1, evidenceRootId: ID } });
});

test('installEvidenceRootMarker: fresh install creates root + durable marker; identical re-install reconciles; a different id conflicts', () => {
  const root = freshRoot();
  const first = installEvidenceRootMarker(root, ID);
  assert.deepEqual(first, { kind: 'installed', evidenceRootId: ID });
  assert.equal(readFileSync(join(root, EVIDENCE_ROOT_MARKER), 'utf8'), evidenceRootMarkerBytes(ID).toString('utf8'));

  assert.deepEqual(installEvidenceRootMarker(root, ID), { kind: 'already_installed', evidenceRootId: ID }, 'the re-run of an interrupted arm reconciles');

  const conflict = installEvidenceRootMarker(root, 'a-different-identity');
  assert.equal(conflict.kind, 'conflict');
  assert.match((conflict as { message: string }).message, /DIFFERENT identity marker/);
  assert.equal(
    readFileSync(join(root, EVIDENCE_ROOT_MARKER), 'utf8'),
    evidenceRootMarkerBytes(ID).toString('utf8'),
    'the existing identity is NEVER overwritten',
  );
});

test('installEvidenceRootMarker: a relative root and a FILE at the root path both fail with nothing durable created', () => {
  const relative = installEvidenceRootMarker('relative/evidence-root', ID);
  assert.equal(relative.kind, 'failed');
  assert.match((relative as { message: string }).message, /must be an absolute path/);

  const filePath = join(mkdtempSync(join(tmpdir(), 'evidence-root-installfile-')), 'occupied');
  writeFileSync(filePath, 'a file, not a directory');
  assert.equal(installEvidenceRootMarker(filePath, ID).kind, 'failed');
});

test('verifyEvidenceRoot: only the exact armed identity at the exact root is ok — absence, recreation, foreign markers, and garbage all refuse', () => {
  const root = freshRoot();
  assert.equal(installEvidenceRootMarker(root, ID).kind, 'installed');
  assert.deepEqual(verifyEvidenceRoot(root, ID), { ok: true });

  const mismatch = verifyEvidenceRoot(root, 'the-armed-id-of-another-root');
  assert.equal(mismatch.ok, false);
  assert.match((mismatch as { reason: string }).reason, /not the armed\s+id/);

  const missing = verifyEvidenceRoot(freshRoot(), ID);
  assert.equal(missing.ok, false);
  assert.match((missing as { reason: string }).reason, /missing or carries no identity marker/);

  const recreated = mkdtempSync(join(tmpdir(), 'evidence-root-recreated-')); // exists, no marker
  const empty = verifyEvidenceRoot(recreated, ID);
  assert.equal(empty.ok, false, 'an empty directory at the right pathname is NOT the armed root');

  const garbage = mkdtempSync(join(tmpdir(), 'evidence-root-vgarbage-'));
  writeFileSync(join(garbage, EVIDENCE_ROOT_MARKER), 'not json at all');
  const unreadable = verifyEvidenceRoot(garbage, ID);
  assert.equal(unreadable.ok, false);
  assert.match((unreadable as { reason: string }).reason, /could not be read/);
});
