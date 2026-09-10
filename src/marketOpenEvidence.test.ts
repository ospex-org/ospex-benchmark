import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import { assertMarketOpenRecords, discoverMarketOpenRuns, readMarketOpenRun } from './marketOpenEvidence.js';
import { createMarketOpenEvidenceFixture } from './testFixtures/marketOpenEvidenceFixture.js';

// These adversarial mutations apply only to caller-owned synthetic fixtures.
// Rehash all journal entries when changing an artifact so digest rejection
// cannot stand in for a semantic history/identity/clock guard.
type Json = Record<string, any>;
function journal(root: string): Array<{ path: string; row: Json }> {
  return readdirSync(join(root, 'journal')).sort().map((name) => {
    const path = join(root, 'journal', name); return { path, row: JSON.parse(readFileSync(path, 'utf8')) as Json };
  });
}
function rechain(entries: ReturnType<typeof journal>): void {
  let previous: string | null = null;
  for (const { path, row } of entries) {
    const { sha256: _old, ...body } = row;
    body.previousSha256 = previous;
    const sha256 = sha256Hex(canonicalize(body));
    writeFileSync(path, canonicalize({ ...body, sha256 })); previous = sha256;
  }
}
function rewriteArtifact(root: string, path: string, edit: (doc: Json) => void): void {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as Json; edit(doc);
  const bytes = canonicalize(doc) + '\n'; writeFileSync(path, bytes);
  const entries = journal(root);
  for (const { row } of entries) if (row.operation.type === 'complete' && row.operation.artifact.path === path) {
    row.operation.artifact.sha256 = sha256Hex(bytes);
  }
  rechain(entries);
}
const record = (doc: Json, kind: string): Json => doc.records.find((r: Json) => r.recordType === kind);
const cases: Array<[string, (doc: Json) => void]> = [
  ['live mode', (d) => { record(d, 'run_meta').mode = 'dry-run'; }],
  ['wall clock', (d) => { record(d, 'run_meta').clockMode = 'fixture'; }],
  ['missing provenance', (d) => { delete record(d, 'run_meta').marketOpen; }],
  ['crossed history reference', (d) => { record(d, 'bundle_game').sourceOddsReference.eventId = 'f'.repeat(64); }],
  ['missing history reference', (d) => { delete record(d, 'bundle_game').sourceOddsReference; }],
  ['immutable opener timestamp', (d) => { record(d, 'run_meta').marketOpen.source.row.captured_at = '2026-09-10T10:00:00.000Z'; }],
  ['legacy odds substitution', (d) => { record(d, 'bundle_game').sourceOddsRows = [{ forged: true }]; }],
  ['run identity', (d) => { record(d, 'run_meta').runId = 'foreign'; }],
  ['cohort identity', (d) => { record(d, 'run_meta').cohortId = 'foreign'; }],
  ['request preimage', (d) => { record(d, 'bundle_game').requestSha256 = 'f'.repeat(64); }],
  ['game preimage', (d) => { record(d, 'bundle_game').bundle.gameId = 'foreign'; }],
  ['opener first observation', (d) => { record(d, 'run_meta').marketOpenTiming.firstObservedAt = '2026-09-10T14:00:00.000Z'; }],
  ['send lag label', (d) => { record(d, 'run_meta').marketOpenTiming.attempts[0].observationToSendLagMs += 1; }],
  ['accepted decision', (d) => { record(d, 'decision').selection = 'Foreign'; }],
  ['decision cardinality', (d) => { const i = d.records.findIndex((r: Json) => r.recordType === 'decision'); d.records.splice(i, 1); }],
];
for (const [name, edit] of cases) test(`market-open consumer rejects coherent artifact tamper: ${name}`, { skip: process.platform === 'win32' }, async () => {
  const fixture = await createMarketOpenEvidenceFixture();
  try {
    assert.equal(discoverMarketOpenRuns(fixture.root).length, 1);
    rewriteArtifact(fixture.root, fixture.artifactPaths[0]!, edit);
    assert.throws(() => discoverMarketOpenRuns(fixture.root), /market-open|mismatch|invalid/);
  } finally { await fixture.cleanup(); }
});

for (const link of ['self', 'predecessor'] as const) test(`market-open terminal journal ${link} digest is independently required`, { skip: process.platform === 'win32' }, async () => {
  const fixture = await createMarketOpenEvidenceFixture();
  try {
    const entries = journal(fixture.root), terminal = entries.at(-1)!;
    if (link === 'self') terminal.row.sha256 = 'f'.repeat(64);
    else { terminal.row.previousSha256 = 'f'.repeat(64); const { sha256: _old, ...body } = terminal.row; terminal.row.sha256 = sha256Hex(canonicalize(body)); }
    writeFileSync(terminal.path, canonicalize(terminal.row));
    assert.throws(() => discoverMarketOpenRuns(fixture.root), /journal/);
  } finally { await fixture.cleanup(); }
});

test('market-open installed artifact hash is required independently of journal links', { skip: process.platform === 'win32' }, async () => {
  const fixture = await createMarketOpenEvidenceFixture();
  try {
    const path = fixture.artifactPaths[0]!;
    const bytes = readFileSync(path, 'utf8');
    writeFileSync(path, bytes + '\n');
    assert.throws(() => readMarketOpenRun(fixture.root, path), /artifact|canonical/);
    // A canonical, otherwise valid artifact must still match its journal digest.
    writeFileSync(path, bytes);
    const entries = journal(fixture.root);
    entries.find((e) => e.row.operation.type === 'complete')!.row.operation.artifact.sha256 = '0'.repeat(64);
    rechain(entries);
    assert.throws(() => readMarketOpenRun(fixture.root, path), /artifact|SHA/);
  } finally { await fixture.cleanup(); }
});

test('market-open raw claim history must reconstruct the frozen opener', { skip: process.platform === 'win32' }, async () => {
  const fixture = await createMarketOpenEvidenceFixture();
  try {
    const entries = journal(fixture.root);
    const claim = entries.find((e) => e.row.operation.type === 'claim')!;
    claim.row.operation.input.preparation.historyRows[0].away_odds_decimal = 2.4;
    rechain(entries);
    assert.throws(() => discoverMarketOpenRuns(fixture.root), /market-open|prepar|mismatch/);
  } finally { await fixture.cleanup(); }
});

test('market-open evidence is read-only under the active writer and cannot be cached or structurally forged', { skip: process.platform === 'win32' }, async () => {
  const fixture = await createMarketOpenEvidenceFixture({ repair: true });
  const snapshot = (root: string): string[] => readdirSync(root).sort().flatMap((name) => {
    const path = join(root, name); return statSync(path).isDirectory() ? snapshot(path).map((row) => `${name}/${row}`) : [`${name}:${sha256Hex(readFileSync(path, 'utf8'))}`];
  });
  try {
    const before = snapshot(fixture.root), evidence = discoverMarketOpenRuns(fixture.root)[0]!;
    assertMarketOpenRecords(evidence.records, evidence);
    assert.deepEqual(snapshot(fixture.root), before, 'no lock replacement, journal append or artifact rewrite');
    assert.throws(() => assertMarketOpenRecords(evidence.records, { ...evidence }), /genuine/);
    assert.throws(() => assertMarketOpenRecords(evidence.records.slice(1), evidence), /records/);
    writeFileSync(fixture.artifactPaths[0]!, readFileSync(fixture.artifactPaths[0]!, 'utf8') + '\n');
    assert.throws(() => assertMarketOpenRecords(evidence.records, evidence), /artifact|canonical/);
  } finally { await fixture.cleanup(); }
});
