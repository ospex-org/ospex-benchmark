import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  armDigest,
  armEvidenceSchemaV1,
  decisionFingerprint,
  decisionFingerprintEntrySchemaV1,
  expectedArmIdentity,
  expectedArmIdentitySchemaV1,
  persistedAttemptSchemaV1,
  toPersistedAttempts,
} from './fireArtifact.js';
import type { ArmDigestInputV1 } from './fireArtifact.js';
import { forecastFingerprint } from './schema.js';
import type { ArmGameResult, AttemptRecord, BenchmarkResponse, ForecastOutput, MarketKey } from './types.js';

/**
 * The fire artifact's arm integrity core (SPEC §5). These fixtures are the
 * minimal structural shapes the pure functions read; they need not pass the
 * harness validator (decisionFingerprint reads a parsed response as given).
 */

const SHA = 'a'.repeat(64);

function first<T>(arr: readonly T[]): T {
  const x = arr[0];
  if (x === undefined) throw new Error('expected a non-empty array');
  return x;
}

function forecast(over: Partial<ForecastOutput> = {}): ForecastOutput {
  return {
    market: 'moneyline',
    selection: 'Away',
    line: null,
    observedDecimal: 2.1,
    probabilities: { win: 0.5, push: 0, loss: 0.5 },
    confidence: 0.6,
    wouldAbstain: false,
    selectedForExecution: true,
    rationale: 'because',
    evidenceRefs: ['ev1'],
    reasonCode: null,
    ...over,
  };
}

function response(forecasts: ForecastOutput[], gameId = 'game-1'): BenchmarkResponse {
  return {
    schemaVersion: 1,
    cohortId: 'cohort',
    participantId: 'p1',
    requestedModelId: 'model-1',
    bundleSha256: SHA,
    executionPolicy: 'fixed-moneyline-total',
    games: [{ gameId, forecasts }],
  };
}

function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    rawText: '{"ok":true}',
    reportedModelId: 'model-x',
    providerResponseId: 'resp-1',
    httpStatus: 200,
    usage: null,
    usageRaw: null,
    requestParams: null,
    requestAt: '2026-07-16T00:00:05.000Z',
    responseAt: '2026-07-16T00:00:06.000Z',
    acceptedAt: '2026-07-16T00:00:07.000Z',
    latencyMs: 1000,
    errorDetail: null,
    ...over,
  };
}

function armResult(over: Partial<ArmGameResult> = {}): ArmGameResult {
  return {
    arm: { participantId: 'p1', provider: 'openai', requestedModelId: 'model-1', credentialEnvVar: 'OPENAI_API_KEY' },
    gameId: 'game-1',
    requestSha256: SHA,
    cutoffAt: '2026-07-16T01:00:00.000Z',
    outcome: 'valid',
    attempt: attempt(),
    repair: null,
    repairUsed: false,
    repairTransport: null,
    parsed: null,
    validationErrors: [],
    ...over,
  };
}

const ROSTER_ENTRY = {
  participantId: 'p1',
  provider: 'openai',
  requestedModelId: 'model-1',
  approvedReportedModelIds: ['model-x', 'model-y'],
};

function digestInput(over: Partial<ArmDigestInputV1> = {}): ArmDigestInputV1 {
  return {
    cohortId: 'cohort',
    fireId: 'fire-1',
    runId: 'run-1',
    participantId: 'p1',
    requestSha256: SHA,
    expectedArmIdentity: expectedArmIdentity(ROSTER_ENTRY),
    orderedAttempts: toPersistedAttempts(armResult()),
    terminalOutcome: 'valid',
    acceptedResponseDigestOrNull: 'b'.repeat(64),
    acceptedDecisionFingerprintOrNull: decisionFingerprint(response([forecast()])),
    ...over,
  };
}

// --- decisionFingerprint ---

test('decisionFingerprint entries bind exactly the decision fields, excluding the three prose fields', () => {
  const entry = first(decisionFingerprint(response([forecast()])));
  assert.deepEqual(
    Object.keys(entry).sort(),
    ['confidence', 'gameId', 'line', 'market', 'observedDecimal', 'probabilities', 'selectedForExecution', 'selection', 'wouldAbstain'],
  );
  assert.ok(!('rationale' in entry));
  assert.ok(!('evidenceRefs' in entry));
  assert.ok(!('reasonCode' in entry));
});

test('decisionFingerprint decision fields correspond exactly to schema.ts forecastFingerprint (drift guard)', () => {
  const ffKeys = Object.keys(forecastFingerprint(forecast())).sort();
  const entry = first(decisionFingerprint(response([forecast()])));
  const entryDecisionKeys = [
    ...Object.keys(entry).filter((k) => k !== 'gameId' && k !== 'market' && k !== 'probabilities'),
    ...Object.keys(entry.probabilities),
  ].sort();
  assert.deepEqual(entryDecisionKeys, ffKeys);
});

test('decisionFingerprint sorts entries into canonical market order regardless of input order', () => {
  const fp = decisionFingerprint(
    response([forecast({ market: 'total', selection: 'over' }), forecast({ market: 'moneyline' }), forecast({ market: 'spread' })]),
  );
  assert.deepEqual(fp.map((e) => e.market), ['moneyline', 'spread', 'total']);
});

test('decisionFingerprint yields canonical order for every nonempty 1-3-market scope', () => {
  const ALL: MarketKey[] = ['moneyline', 'spread', 'total'];
  const subsets: MarketKey[][] = [
    ['moneyline'],
    ['spread'],
    ['total'],
    ['moneyline', 'spread'],
    ['moneyline', 'total'],
    ['spread', 'total'],
    ['moneyline', 'spread', 'total'],
  ];
  for (const scope of subsets) {
    const reversed = [...scope].reverse().map((m) => forecast({ market: m, selection: m === 'total' ? 'over' : 'Away' }));
    const fp = decisionFingerprint(response(reversed));
    assert.deepEqual(fp.map((e) => e.market), ALL.filter((m) => scope.includes(m)), `scope ${scope.join('+')}`);
  }
});

test('decisionFingerprint output is frozen, detached, and plain JSON', () => {
  const fp = decisionFingerprint(response([forecast()]));
  assert.ok(Object.isFrozen(fp));
  assert.ok(Object.isFrozen(first(fp)));
  assert.deepEqual(JSON.parse(JSON.stringify(fp)), fp);
});

// --- expectedArmIdentity ---

test('expectedArmIdentity is exactly the manifest roster-entry projection, order-preserving, frozen, detached', () => {
  const approved = ['model-x', 'model-y', 'model-z'];
  const id = expectedArmIdentity({ ...ROSTER_ENTRY, approvedReportedModelIds: approved });
  assert.deepEqual(Object.keys(id).sort(), ['approvedReportedModelIds', 'participantId', 'provider', 'requestedModelId']);
  assert.deepEqual(id.approvedReportedModelIds, ['model-x', 'model-y', 'model-z']);
  assert.ok(Object.isFrozen(id));
  assert.ok(Object.isFrozen(id.approvedReportedModelIds));
  approved.push('mutated'); // detached: mutating the source array must not leak in
  assert.equal(id.approvedReportedModelIds.length, 3);
});

// --- toPersistedAttempts (attempt mapping, §5) ---

test('sent initial + repair map to ordered attempts 1=initial, 2=repair', () => {
  const attempts = toPersistedAttempts(
    armResult({ repairUsed: true, repair: attempt({ requestAt: '2026-07-16T00:00:10.000Z', responseAt: '2026-07-16T00:00:11.000Z', acceptedAt: '2026-07-16T00:00:12.000Z' }) }),
  );
  assert.deepEqual(attempts.map((a) => [a.attemptNumber, a.kind]), [[1, 'initial'], [2, 'repair']]);
});

test('an unsent attempt (requestAt null) is omitted, never a fake attempt', () => {
  const attempts = toPersistedAttempts(
    armResult({ outcome: 'credential_missing', attempt: attempt({ requestAt: null, responseAt: null, rawText: null, httpStatus: null, acceptedAt: null, reportedModelId: null }) }),
  );
  assert.equal(attempts.length, 0);
});

test('a timeout attempt claims no receipt; a transport error WITH an HTTP status does', () => {
  const timeout = first(toPersistedAttempts(armResult({ outcome: 'timeout', attempt: attempt({ rawText: null, httpStatus: null, acceptedAt: null, reportedModelId: null }) })));
  assert.equal(timeout.requestReceivedAt, null);
  assert.equal(timeout.persistedResponseBody, null);
  assert.equal(timeout.responseSha256, null);
  const http429 = first(toPersistedAttempts(armResult({ outcome: 'rate_limited', attempt: attempt({ rawText: null, httpStatus: 429, acceptedAt: null, reportedModelId: null }) })));
  assert.equal(http429.requestReceivedAt, '2026-07-16T00:00:06.000Z');
  assert.equal(http429.responseSha256, null); // no body → no digest
});

test('an accepted attempt carries acceptedAt and a body digest; non-accepted carries null', () => {
  const accepted = first(toPersistedAttempts(armResult()));
  assert.equal(accepted.acceptedAt, '2026-07-16T00:00:07.000Z');
  assert.equal(accepted.responseSha256?.length, 64);
  const rejected = first(toPersistedAttempts(armResult({ outcome: 'invalid_schema', attempt: attempt({ acceptedAt: null }) })));
  assert.equal(rejected.acceptedAt, null);
  assert.equal(rejected.responseSha256?.length, 64); // still has a body, just not accepted
});

test('toPersistedAttempts output is frozen and plain JSON', () => {
  const attempts = toPersistedAttempts(armResult());
  assert.ok(Object.isFrozen(attempts));
  assert.ok(Object.isFrozen(first(attempts)));
  assert.deepEqual(JSON.parse(JSON.stringify(attempts)), attempts);
});

// --- armDigest (§5) ---

test('armDigest is a 64-hex string and deterministic (byte-identical recompute)', () => {
  const input = digestInput();
  const d = armDigest(input);
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(armDigest(digestInput()), d);
  assert.equal(armDigest(JSON.parse(JSON.stringify(input)) as ArmDigestInputV1), d); // re-parsed recompute matches
});

test('armDigest changes when any of the ten domain fields changes', () => {
  const base = armDigest(digestInput());
  const variants: Array<Partial<ArmDigestInputV1>> = [
    { cohortId: 'other' },
    { fireId: 'other' },
    { runId: 'other' },
    { participantId: 'other' },
    { requestSha256: 'c'.repeat(64) },
    { expectedArmIdentity: expectedArmIdentity({ ...ROSTER_ENTRY, requestedModelId: 'model-2' }) },
    { terminalOutcome: 'invalid_schema' },
    { acceptedResponseDigestOrNull: null },
    { acceptedDecisionFingerprintOrNull: null },
  ];
  for (const v of variants) {
    assert.notEqual(armDigest(digestInput(v)), base, `mutation ${JSON.stringify(Object.keys(v))} must change the digest`);
  }
});

test('armDigest changes on attempt order, an attempt timestamp, and a retained body/digest change', () => {
  const two = toPersistedAttempts(
    armResult({ repairUsed: true, repair: attempt({ requestAt: '2026-07-16T00:00:10.000Z', responseAt: '2026-07-16T00:00:11.000Z', acceptedAt: '2026-07-16T00:00:12.000Z' }) }),
  );
  const base = armDigest(digestInput({ orderedAttempts: two }));
  assert.notEqual(armDigest(digestInput({ orderedAttempts: [...two].reverse() })), base); // order
  const tsMutated = two.map((a, i) => (i === 0 ? { ...a, requestStartedAt: '2026-07-16T00:00:99.000Z' } : a));
  assert.notEqual(armDigest(digestInput({ orderedAttempts: tsMutated })), base); // timestamp
  const bodyMutated = two.map((a, i) => (i === 0 ? { ...a, persistedResponseBody: 'tampered' } : a));
  assert.notEqual(armDigest(digestInput({ orderedAttempts: bodyMutated })), base); // retained body
});

test('armDigest changes when an accepted decision fingerprint field changes', () => {
  const base = armDigest(digestInput());
  const mutated = decisionFingerprint(response([forecast({ selectedForExecution: false })]));
  assert.notEqual(armDigest(digestInput({ acceptedDecisionFingerprintOrNull: mutated })), base);
});

// --- strict schemas (unknown fields fail parse) ---

test('the arm-level strict schemas reject unknown fields', () => {
  assert.throws(() => expectedArmIdentitySchemaV1.parse({ ...expectedArmIdentity(ROSTER_ENTRY), extra: 1 }));
  assert.throws(() => decisionFingerprintEntrySchemaV1.parse({ ...first(decisionFingerprint(response([forecast()]))), extra: 1 }));
  assert.throws(() => persistedAttemptSchemaV1.parse({ ...first(toPersistedAttempts(armResult())), extra: 1 }));
});

test('armEvidenceSchemaV1 round-trips a valid arm evidence and rejects an unknown outcome', () => {
  const evidence = {
    expectedArmIdentity: expectedArmIdentity(ROSTER_ENTRY),
    terminalOutcome: 'valid' as const,
    orderedAttempts: toPersistedAttempts(armResult()),
    acceptedResponseDigest: 'b'.repeat(64),
    acceptedDecisionFingerprint: decisionFingerprint(response([forecast()])),
    armDigest: armDigest(digestInput()),
  };
  assert.deepEqual(armEvidenceSchemaV1.parse(evidence), evidence);
  assert.throws(() => armEvidenceSchemaV1.parse({ ...evidence, terminalOutcome: 'bogus_outcome' }));
});
