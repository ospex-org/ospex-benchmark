import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MarketOpenStore, readMarketOpenStore } from './marketOpenStore.js';
import { MARKET_OPEN_POLICY } from './marketOpen.js';
import { deriveConservativeActualUsdMicros } from './conservativeSpend.js';
import { computeFireSpendGuard } from './spendGuard.js';
import { spendReservationPolicyForVersion } from './spendReservationPolicy.js';
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
function rewriteArtifact(root: string, path: string, edit: (doc: Json, entries: ReturnType<typeof journal>) => void): void {
  const entries = journal(root);
  const doc = JSON.parse(readFileSync(path, 'utf8')) as Json; edit(doc, entries);
  const bytes = canonicalize(doc) + '\n'; writeFileSync(path, bytes);
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

// Exercise the public store's dirty-terminal + artifact attachment contract using
// actual producer claim/attempt records, not a second hand-written reducer.
for (const status of ['unknown', 'refused', 'failed'] as const) test(`market-open discovery excludes installed ${status} terminal`, { skip: process.platform === 'win32' }, async () => {
  const source = await createMarketOpenEvidenceFixture({ failedArm: status === 'failed' });
  const root = mkdtempSync(join(tmpdir(), 'market-open-terminal-'));
  const { config, snapshot } = readMarketOpenStore(source.root);
  const original = snapshot.fires[0]!;
  const store = new MarketOpenStore({ ...config, root });
  try {
    for (const { row } of journal(source.root)) {
      const op = row.operation;
      if (op.type === 'claim') store.claim(op.input, op.claimedAt);
      if (status !== 'refused') {
        if (op.type === 'begin') store.beginAttempt(op.input);
        if (op.type === 'finish') store.finishAttempt(op.input);
      }
    }
    const eventId = original.claim.eventId;
    if (status === 'unknown') store.markUnknown(eventId, 'synthetic_durability_fault');
    if (status === 'refused') store.refuse(eventId, 'synthetic_first_pitch');
    if (status === 'failed') store.fail(eventId, 'synthetic_operational_failure');
    mkdirSync(join(root, 'artifacts'));
    const path = join(root, 'artifacts', `${eventId}.json`);
    const bytes = readFileSync(source.artifactPaths[0]!, 'utf8');
    writeFileSync(path, bytes);
    store.complete(eventId, { path, sha256: sha256Hex(bytes) }, original.artifactInstalledAt!);
    const fire = readMarketOpenStore(root).snapshot.fires[0]!;
    assert.equal(fire.status, status);
    assert.equal(fire.terminalArtifact?.path, path);
    assert.notEqual(fire.artifactInstalledAt, null);
    let discovered: unknown;
    assert.doesNotThrow(() => { discovered = discoverMarketOpenRuns(root); }, 'excluded terminals must not enter artifact admission');
    assert.deepEqual(discovered, [], 'an installed artifact never promotes a dirty terminal to scoreable');
    assert.throws(() => readMarketOpenRun(root, path), /target is not a completed journal-installed artifact/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); await source.cleanup(); }
});

test('market-open canonical artifact bytes are required independently of a matching installed digest', { skip: process.platform === 'win32' }, async () => {
  const fixture = await createMarketOpenEvidenceFixture();
  try {
    const path = fixture.artifactPaths[0]!;
    const bytes = JSON.stringify(JSON.parse(readFileSync(path, 'utf8')), null, 2) + '\n';
    writeFileSync(path, bytes);
    const entries = journal(fixture.root);
    entries.find((e) => e.row.operation.type === 'complete')!.row.operation.artifact.sha256 = sha256Hex(bytes);
    rechain(entries);
    assert.doesNotThrow(() => readMarketOpenStore(fixture.root), 'journal/hash validation still passes');
    assert.throws(() => discoverMarketOpenRuns(fixture.root), /noncanonical artifact bytes/);
  } finally { await fixture.cleanup(); }
});

test('market-open pre-install admission must match the replayed fire', { skip: process.platform === 'win32' }, async () => {
  const fixture = await createMarketOpenEvidenceFixture();
  try {
    rewriteArtifact(fixture.root, fixture.artifactPaths[0]!, (doc) => { doc.admission.reason = 'foreign'; });
    assert.throws(() => discoverMarketOpenRuns(fixture.root), /pre-install admission mismatch/);
  } finally { await fixture.cleanup(); }
});

for (const [field, value] of [['mode', 'dry-run'], ['clockMode', 'fixture']] as const) test(`market-open independently requires run metadata ${field}`, { skip: process.platform === 'win32' }, async () => {
  const fixture = await createMarketOpenEvidenceFixture();
  try {
    rewriteArtifact(fixture.root, fixture.artifactPaths[0]!, (doc) => { record(doc, 'run_meta')[field] = value; });
    assert.throws(() => discoverMarketOpenRuns(fixture.root), new RegExp(`run metadata\\.${field} mismatch`));
  } finally { await fixture.cleanup(); }
});

test('market-open independently recomputes durable billable cost', { skip: process.platform === 'win32' }, async () => {
  const fixture = await createMarketOpenEvidenceFixture();
  try {
    rewriteArtifact(fixture.root, fixture.artifactPaths[0]!, (doc, entries) => {
      entries.find((e) => e.row.operation.type === 'finish')!.row.operation.input.costUsdMicros += 1;
      doc.admission.attempts[0].costUsdMicros += 1;
      doc.admission.knownCostUsdMicros += 1;
    });
    assert.doesNotThrow(() => readMarketOpenStore(fixture.root));
    assert.throws(() => discoverMarketOpenRuns(fixture.root), /billable attempt cost mismatch/);
  } finally { await fixture.cleanup(); }
});

test('market-open independently recomputes aggregate spend', { skip: process.platform === 'win32' }, async () => {
  const fixture = await createMarketOpenEvidenceFixture({ repair: true });
  try {
    rewriteArtifact(fixture.root, fixture.artifactPaths[0]!, (doc) => { doc.spend = { kind: 'unknown', offenders: [] }; });
    assert.throws(() => discoverMarketOpenRuns(fixture.root), /aggregate spend mismatch/);
  } finally { await fixture.cleanup(); }
});

test('market-open rejects a coherent non-pass completed attempt spend', { skip: process.platform === 'win32' }, async () => {
  const fixture = await createMarketOpenEvidenceFixture();
  try {
    rewriteArtifact(fixture.root, fixture.artifactPaths[0]!, (doc, entries) => {
      const durable = doc.admission.attempts[0], evidence = durable.evidence, arm = evidence.arm;
      assert.equal(arm.provider, 'openai');
      const perAttempt = spendReservationPolicyForVersion(MARKET_OPEN_POLICY.spendReservationPolicyVersion).providerAttemptReservationUsdMicros;
      const previous = durable.costUsdMicros;
      // A single over-reservation attempt can fit inside the whole-fire reserve.
      // Bind usage and exact recomputation everywhere so only the pass guard rejects.
      do {
        evidence.attempt.usageRaw.input_tokens *= 2;
        evidence.attempt.usageRaw.total_tokens = evidence.attempt.usageRaw.input_tokens + evidence.attempt.usageRaw.output_tokens;
        durable.costUsdMicros = deriveConservativeActualUsdMicros({ ...arm, priceVersion: MARKET_OPEN_POLICY.priceVersion,
          usageRaw: evidence.attempt.usageRaw, searchCount: evidence.attempt.searchAudit.searchCount });
      } while (durable.costUsdMicros <= perAttempt);
      assert.ok(durable.costUsdMicros < doc.admission.claim.reservationUsdMicros);
      const guardInput = (a: Json) => ({ requestAt: a.requestAt, usageRaw: a.usageRaw, searchCount: a.searchAudit.searchCount });
      evidence.spend = computeFireSpendGuard({ arms: [{ ...arm, billingClass: 'billable', attempt: guardInput(evidence.attempt), repair: null }],
        priceVersion: MARKET_OPEN_POLICY.priceVersion, perAttemptReservationUsdMicros: perAttempt });
      assert.equal(evidence.spend.kind, 'breach');
      doc.admission.knownCostUsdMicros += durable.costUsdMicros - previous;
      const finish = entries.find((e) => e.row.operation.type === 'finish')!.row.operation.input;
      finish.costUsdMicros = durable.costUsdMicros; finish.evidence = structuredClone(evidence);
      const response = doc.records.find((r: Json) => r.recordType === 'arm_game_response' && r.participantId === arm.participantId);
      response.attempt.usageRaw = structuredClone(evidence.attempt.usageRaw);
      for (const decision of doc.records.filter((r: Json) => r.recordType === 'decision' && r.participantId === arm.participantId)) {
        decision.usageRaw = structuredClone(evidence.attempt.usageRaw);
      }
      const arms = doc.admission.attempts.map((a: Json) => ({ ...a.evidence.arm, billingClass: 'billable',
        attempt: guardInput(a.evidence.attempt), repair: null }));
      doc.spend = computeFireSpendGuard({ arms, priceVersion: MARKET_OPEN_POLICY.priceVersion, perAttemptReservationUsdMicros: perAttempt });
    });
    assert.doesNotThrow(() => readMarketOpenStore(fixture.root));
    assert.throws(() => discoverMarketOpenRuns(fixture.root), /non-pass completed attempt spend/);
  } finally { await fixture.cleanup(); }
});
