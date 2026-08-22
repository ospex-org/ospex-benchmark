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
import type { ArmDigestInputV1, PersistedAttemptV1 } from './fireArtifact.js';
import { sealResponseEnvelope } from './providers/responseEnvelope.js';
import { forecastFingerprint } from './schema.js';
import type { ArmGameResult, AttemptRecord, BenchmarkResponse, ForecastOutput, MarketKey } from './types.js';
import { damageEnvelope, fixtureEnvelope } from './testFactories.js';

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
    responseEnvelope: fixtureEnvelope('{"ok":true}'),
    reportedModelId: 'model-x',
    providerResponseId: 'resp-1',
    httpStatus: 200,
    usage: null,
    usageRaw: null,
    searchAudit: null,
    requestParams: null,
    providerStopReason: null,
    turnCompleted: true,
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
    arm: { participantId: 'p1', provider: 'openai', requestedModelId: 'model-1', credentialEnvVar: 'OPENAI_API_KEY', configuration: {} },
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
    refusedInitialStartAt: null,
    ...over,
  };
}

const ROSTER_ENTRY = {
  participantId: 'p1',
  provider: 'openai',
  requestedModelId: 'model-1',
  approvedReportedModelIds: ['model-x', 'model-y'],
  configuration: {},
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

/** A v2 forecast: the analysis fields the fingerprint now binds. */
function analyzedForecast(over: Partial<ForecastOutput> = {}): ForecastOutput {
  return forecast({
    axes: { valuation: 4, trend: 2, consensus: 3, news: 1, softness: 5 },
    primaryAxis: 'valuation',
    primaryExpectation: 'The price reads rich against the implied probabilities.',
    ...over,
  });
}

test('decisionFingerprint decision fields correspond exactly to schema.ts forecastFingerprint (drift guard)', () => {
  // Compared on a v2 forecast, so BOTH sides carry the analysis fields: a field
  // added to one owner and not the other fails here.
  const ffKeys = Object.keys(forecastFingerprint(analyzedForecast())).sort();
  const entry = first(decisionFingerprint(response([analyzedForecast()])));
  const entryDecisionKeys = [
    ...Object.keys(entry).filter((k) => k !== 'gameId' && k !== 'market' && k !== 'probabilities'),
    ...Object.keys(entry.probabilities),
  ].sort();
  assert.deepEqual(entryDecisionKeys, ffKeys);
});

test('the analysis fields are decision-bearing: a v2 entry binds all three, a v1 entry omits all three', () => {
  const v2 = first(decisionFingerprint(response([analyzedForecast()])));
  assert.deepEqual(v2.axes, { valuation: 4, trend: 2, consensus: 3, news: 1, softness: 5 });
  assert.equal(v2.primaryAxis, 'valuation');
  assert.equal(v2.primaryExpectation, 'The price reads rich against the implied probabilities.');
  // A v2 forecast with no dominant axis still binds all three keys (primaryAxis
  // null is a real v2 value, not the v1 "no analysis" state).
  const allOnes = first(
    decisionFingerprint(
      response([
        analyzedForecast({
          axes: { valuation: 1, trend: 1, consensus: 1, news: 1, softness: 1 },
          primaryAxis: null,
          primaryExpectation: null,
        }),
      ]),
    ),
  );
  assert.ok(Object.hasOwn(allOnes, 'axes'));
  assert.equal(allOnes.primaryAxis, null);
  assert.equal(allOnes.primaryExpectation, null);
  // A pre-axes body omits the keys entirely, so its entry canonicalizes — and
  // therefore digests — exactly as it did before the fields existed.
  const v1 = first(decisionFingerprint(response([forecast()])));
  for (const key of ['axes', 'primaryAxis', 'primaryExpectation']) {
    assert.ok(!Object.hasOwn(v1, key), `a v1 entry must not carry ${key}`);
  }
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
  // The v1 identity carries NO configuration — see the refusal below for why
  // that is a refusal rather than an omission.
  assert.ok(!('configuration' in id));
});

test('expectedArmIdentity REFUSES a roster entry that declares a configuration', () => {
  // Dropping it silently would publish a decision under the wrong entrant: two
  // arms running one model at two settings project to the byte-identical
  // identity and hash to the same armDigest, and nothing downstream could tell
  // — the two are supposed to look alike everywhere except there.
  assert.throws(
    () => expectedArmIdentity({ ...ROSTER_ENTRY, configuration: { reasoning: { effort: 'high' } } }),
    /has no field for a participant configuration, and p1 declares one/,
  );
});

test('expectedArmIdentity accepts the empty configuration', () => {
  // The negative control: a build that refused EVERY roster entry would also
  // satisfy the test above, and would take the line-open path down with it.
  assert.doesNotThrow(() => expectedArmIdentity({ ...ROSTER_ENTRY, configuration: {} }));
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

function validEvidence() {
  return {
    expectedArmIdentity: expectedArmIdentity(ROSTER_ENTRY),
    terminalOutcome: 'valid' as const,
    initialRequestStartedAt: '2026-07-16T00:00:05.000Z',
    orderedAttempts: toPersistedAttempts(armResult()),
    acceptedResponseDigest: 'b'.repeat(64),
    acceptedDecisionFingerprint: decisionFingerprint(response([forecast()])),
    armDigest: armDigest(digestInput()),
  };
}

test('armEvidenceSchemaV1 round-trips a valid arm evidence and rejects an unknown outcome', () => {
  const evidence = validEvidence();
  assert.deepEqual(armEvidenceSchemaV1.parse(evidence), evidence);
  assert.throws(() => armEvidenceSchemaV1.parse({ ...evidence, terminalOutcome: 'bogus_outcome' }));
});

test('armEvidenceSchemaV1 requires the distinct initialRequestStartedAt (nullable, not absent)', () => {
  const { initialRequestStartedAt: _drop, ...missing } = validEvidence();
  void _drop;
  assert.throws(() => armEvidenceSchemaV1.parse(missing));
  assert.doesNotThrow(() => armEvidenceSchemaV1.parse({ ...validEvidence(), initialRequestStartedAt: null }));
});

// --- armDigest fails closed on its exact domain ---

test('armDigest rejects an unknown 11th field, a missing/undefined field, and a malformed field', () => {
  assert.throws(() => armDigest({ ...digestInput(), sneaky: 1 } as unknown as ArmDigestInputV1));
  assert.throws(() => armDigest({ ...digestInput(), fireId: undefined } as unknown as ArmDigestInputV1));
  assert.throws(() => armDigest({ ...digestInput(), requestSha256: 'not-a-sha' } as unknown as ArmDigestInputV1));
});

// --- per-attempt transport + usage (integrity truth) ---

test('a repair timeout and a repair provider_error persist distinctly (transport retained)', () => {
  const mk = (t: 'timeout' | 'provider_error') =>
    toPersistedAttempts(
      armResult({
        outcome: 'invalid_schema',
        repairUsed: true,
        repairTransport: t,
        repair: attempt({ rawText: null, httpStatus: null, acceptedAt: null, reportedModelId: null, requestAt: '2026-07-16T00:00:10.000Z', responseAt: '2026-07-16T00:00:11.000Z' }),
      }),
    );
  const a = mk('timeout');
  const b = mk('provider_error');
  assert.equal(a[1]?.transport, 'timeout');
  assert.equal(b[1]?.transport, 'provider_error');
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
});

test('a received attempt has transport ok and detached, normalized usage', () => {
  const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
  const a = first(toPersistedAttempts(armResult({ attempt: attempt({ usage }) })));
  assert.equal(a.transport, 'ok');
  assert.deepEqual(a.usage, usage);
  usage.inputTokens = 999; // detached: mutating the source must not leak in
  assert.equal(a.usage?.inputTokens, 100);
});

test('transport and usage are bound into armDigest via orderedAttempts', () => {
  const base = armDigest(digestInput());
  const attempts = toPersistedAttempts(armResult());
  const diffUsage = attempts.map((a) => ({ ...a, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }));
  assert.notEqual(armDigest(digestInput({ orderedAttempts: diffUsage })), base);
  const diffTransport = attempts.map((a) => ({ ...a, transport: 'timeout' as const }));
  assert.notEqual(armDigest(digestInput({ orderedAttempts: diffTransport })), base);
});

test('persisted usage token counts must be null or safe non-negative integers', () => {
  const baseAttempt = first(toPersistedAttempts(armResult()));
  const withToken = (inputTokens: unknown): unknown =>
    persistedAttemptSchemaV1.parse({ ...baseAttempt, usage: { inputTokens, outputTokens: 0, totalTokens: 0 } });
  for (const ok of [null, 0, 42, Number.MAX_SAFE_INTEGER]) {
    assert.doesNotThrow(() => withToken(ok), `token count ${String(ok)} must be accepted`);
  }
  for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => withToken(bad), `token count ${String(bad)} must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// searchAudit + comparable-usage fields: backward-verifiable digest binding
// ---------------------------------------------------------------------------

test('pre-search attempts (no searchAudit, no comparable-usage keys) recompute their ORIGINAL armDigest — old artifacts stay verifiable', () => {
  // An attempt list shaped exactly like a pre-search persisted artifact:
  // no searchAudit key, usage without the two derived fields.
  const legacyAttempts = [
    {
      attemptNumber: 1,
      kind: 'initial' as const,
      requestStartedAt: '2026-07-16T00:00:05.000Z',
      requestReceivedAt: '2026-07-16T00:00:07.000Z',
      acceptedAt: null,
      reportedModelId: 'model-x',
      httpStatus: 200,
      persistedResponseBody: '{"ok":true}',
      responseSha256: 'a'.repeat(64),
      transport: 'ok' as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
  ];
  const legacyDigest = armDigest(digestInput({ orderedAttempts: legacyAttempts }));
  // The same attempt with the NEW fields present digests DIFFERENTLY (they are
  // bound), while re-parsing the legacy shape leaves the digest unchanged.
  const enriched = [
    {
      ...legacyAttempts[0]!,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 2, billableOutputTokens: 5 },
      searchAudit: { queries: [{ query: 'q' }], results: [], searchCount: null, incomplete: [] },
    },
  ];
  const enrichedDigest = armDigest(digestInput({ orderedAttempts: enriched }));
  assert.notEqual(enrichedDigest, legacyDigest, 'present new fields must be digest-bound');
  assert.equal(
    armDigest(digestInput({ orderedAttempts: legacyAttempts })),
    legacyDigest,
    'legacy attempts recompute byte-identically',
  );
});

test('a PRESENT searchAudit is digest-bound: tampering a query, a result, or deleting the audit changes the armDigest', () => {
  const base = [
    {
      attemptNumber: 1,
      kind: 'initial' as const,
      requestStartedAt: '2026-07-16T00:00:05.000Z',
      requestReceivedAt: '2026-07-16T00:00:07.000Z',
      acceptedAt: null,
      reportedModelId: 'model-x',
      httpStatus: 200,
      persistedResponseBody: '{"ok":true}',
      responseSha256: 'a'.repeat(64),
      transport: 'ok' as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 2, billableOutputTokens: 5 },
      searchAudit: {
        queries: [{ query: 'injury report' }],
        results: [{ url: 'https://news.example/a', title: 'A' }],
        searchCount: 1,
        incomplete: [],
      },
    },
  ];
  const baseline = armDigest(digestInput({ orderedAttempts: base }));
  const tamperedQuery = structuredClone(base);
  tamperedQuery[0]!.searchAudit.queries[0]!.query = 'different query';
  assert.notEqual(armDigest(digestInput({ orderedAttempts: tamperedQuery })), baseline);
  const tamperedResult = structuredClone(base);
  tamperedResult[0]!.searchAudit.results[0]!.url = 'https://elsewhere.example/b';
  assert.notEqual(armDigest(digestInput({ orderedAttempts: tamperedResult })), baseline);
  const deleted = structuredClone(base) as Array<Record<string, unknown>>;
  delete deleted[0]!['searchAudit'];
  assert.notEqual(
    armDigest(digestInput({ orderedAttempts: deleted as unknown as typeof base })),
    baseline,
    'stripping the audit off a new attempt is digest-detected',
  );
});

test('toPersistedAttempts carries the searchAudit through detached (explicit null when the attempt ran no search)', () => {
  const audited = armResult({
    attempt: attempt({
      searchAudit: { queries: [{ query: 'q1' }], results: [{ url: 'https://u.example', title: null }], searchCount: 1, incomplete: [] },
    }),
  });
  const [persisted] = toPersistedAttempts(audited);
  assert.deepEqual(persisted!.searchAudit, {
    queries: [{ query: 'q1' }],
    results: [{ url: 'https://u.example', title: null }],
    searchCount: 1,
    incomplete: [],
  });
  assert.notEqual(
    persisted!.searchAudit,
    audited.attempt.searchAudit,
    'the persisted audit is a detached copy, never an alias of runner state',
  );
  const noSearch = armResult({ attempt: attempt({ searchAudit: null }) });
  const [plain] = toPersistedAttempts(noSearch);
  assert.equal(plain!.searchAudit, null, 'no search activity persists an explicit null, not an absent key');
  assert.ok(Object.hasOwn(plain!, 'searchAudit'));
});

// --- the retained provider response envelope (#92 / #111) --------------------

/**
 * The answer text and the complete response body it was extracted from, as two
 * DELIBERATELY different strings.
 *
 * The mapper writes both onto the same persisted attempt, from the same record, as
 * strings — so a fixture where they are equal cannot tell a build that copies the
 * envelope from one that copies the answer text twice (rule 3d). Only the envelope
 * carries `ENVELOPE-BODY-ONLY-9c7`, and only the answer is the string the response
 * digest is taken over.
 *
 * The body is multibyte on purpose: 107 characters and 110 UTF-8 bytes, so the
 * `bytes` literal below is refused by a build that measures the body's character
 * count (rule 3g-both — the two measures have to disagree or the case discriminates
 * nothing).
 */
const ANSWER_ONLY = '{"answer":"ANSWER-TEXT-ONLY-4d2"}';
const ENVELOPE_BODY = JSON.stringify({
  envelope: 'ENVELOPE-BODY-ONLY-9c7 — señal',
  wrapping: { answer: ANSWER_ONLY },
});
// Frozen literals, never derived from the helpers under test (rule 4b): a digest
// computed here with the same function the mapper uses would move with a broken one.
const ANSWER_SHA = '2ab19fe219c60a4ea4be32f8012a5959a388d093922cbf9c1f3419cc500a5232';
const ENVELOPE_SHA = '2cbb927663c9e17885136f2a587eacb0369ab5df6048a9372c464a8a39bf84b4';
const ENVELOPE_BYTES = 110;

test('toPersistedAttempts maps the WHOLE attempt, envelope included — a marker in the body only survives', () => {
  const persisted = first(
    toPersistedAttempts(
      armResult({
        attempt: attempt({
          rawText: ANSWER_ONLY,
          responseEnvelope: sealResponseEnvelope(ENVELOPE_BODY),
          reportedModelId: 'REPORTED-MODEL-ONLY',
          httpStatus: 207,
          usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
          searchAudit: { queries: [{ query: 'SEARCH-QUERY-ONLY' }], results: [], searchCount: 1, incomplete: [] },
          providerStopReason: 'STOP-REASON-ONLY',
          turnCompleted: false,
          requestAt: '2026-07-16T00:00:01.000Z',
          responseAt: '2026-07-16T00:00:02.000Z',
          acceptedAt: '2026-07-16T00:00:03.000Z',
        }),
      }),
    ),
  );
  // The reproduction in #111, inverted: the marker lives ONLY in the envelope body,
  // and the artifact used to keep the extracted answer and drop the body.
  assert.ok(
    JSON.stringify(persisted).includes('ENVELOPE-BODY-ONLY-9c7'),
    'the complete response body survives the mapping',
  );
  assert.ok(
    !persisted.persistedResponseBody!.includes('ENVELOPE-BODY-ONLY-9c7'),
    'and the answer text does not carry it, so the fixture discriminates the two fields',
  );
  // ONE assertion over the entire map, every field carrying a value unique to it, so a
  // positional swap between any two same-typed fields — `persistedResponseBody` and
  // `responseEnvelope.body` above all — reddens here (rule 3d).
  assert.deepEqual(persisted, {
    attemptNumber: 1,
    kind: 'initial',
    requestStartedAt: '2026-07-16T00:00:01.000Z',
    requestReceivedAt: '2026-07-16T00:00:02.000Z',
    acceptedAt: '2026-07-16T00:00:03.000Z',
    reportedModelId: 'REPORTED-MODEL-ONLY',
    httpStatus: 207,
    persistedResponseBody: ANSWER_ONLY,
    responseSha256: ANSWER_SHA,
    transport: 'ok',
    usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
    searchAudit: { queries: [{ query: 'SEARCH-QUERY-ONLY' }], results: [], searchCount: 1, incomplete: [] },
    providerStopReason: 'STOP-REASON-ONLY',
    turnCompleted: false,
    responseEnvelope: { body: ENVELOPE_BODY, sha256: ENVELOPE_SHA, bytes: ENVELOPE_BYTES },
  });
});

test('the persisted envelope is detached from the record it was mapped from', () => {
  const live = armResult();
  const persisted = first(toPersistedAttempts(live));
  assert.notEqual(
    persisted.responseEnvelope,
    live.attempt.responseEnvelope,
    'never an alias of live runner state — the same detachment rule usage and searchAudit follow',
  );
  assert.deepEqual(persisted.responseEnvelope, live.attempt.responseEnvelope, 'but the same value');
});

test('toPersistedAttempts persists an explicit null envelope when nothing came back — the negative control', () => {
  // A timeout: no body was retained because none arrived. The KEY is still written, so
  // "this build retains" stays readable off the attempt, and nothing is flagged.
  const [persisted] = toPersistedAttempts(
    armResult({
      outcome: 'timeout',
      attempt: attempt({ rawText: null, responseEnvelope: null, httpStatus: null, acceptedAt: null, reportedModelId: null }),
    }),
  );
  assert.equal(persisted!.responseEnvelope, null, 'an explicit null, not an absent key');
  assert.ok(Object.hasOwn(persisted!, 'responseEnvelope'), 'the key is written on every new attempt');
  assert.equal(persisted!.transport, 'timeout');
  // The positive half of the same contract (rule 5): a received response DOES carry one.
  assert.notEqual(first(toPersistedAttempts(armResult())).responseEnvelope, null);
});

test('toPersistedAttempts retains the REPAIR attempt envelope too, not only the initial', () => {
  // #92 covers every initial AND repair attempt. The two legs carry different bodies so
  // a build that maps the initial's envelope onto both is not mistaken for a correct one.
  const initialBody = JSON.stringify({ leg: 'INITIAL-LEG-BODY-a1' });
  const repairBody = JSON.stringify({ leg: 'REPAIR-LEG-BODY-b2' });
  const attempts = toPersistedAttempts(
    armResult({
      outcome: 'valid',
      attempt: attempt({ acceptedAt: null, responseEnvelope: sealResponseEnvelope(initialBody) }),
      repair: attempt({ responseEnvelope: sealResponseEnvelope(repairBody) }),
      repairUsed: true,
      repairTransport: 'ok',
    }),
  );
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.kind, 'initial');
  assert.equal(attempts[1]!.kind, 'repair');
  assert.equal(attempts[0]!.responseEnvelope?.body, initialBody);
  assert.equal(attempts[1]!.responseEnvelope?.body, repairBody);
});

test('the envelope is inside the armDigest domain: a body-only difference moves the digest', () => {
  const withEnvelope = (body: string): readonly PersistedAttemptV1[] =>
    toPersistedAttempts(armResult({ attempt: attempt({ responseEnvelope: sealResponseEnvelope(body) }) }));
  const a = armDigest(digestInput({ orderedAttempts: withEnvelope('{"body":"A"}') }));
  const b = armDigest(digestInput({ orderedAttempts: withEnvelope('{"body":"B"}') }));
  assert.notEqual(a, b, 'two different response bodies cannot share an arm digest');

  // Deleting the key off a new attempt is digest-DETECTED — the property the run file
  // could not offer, and the reason this artifact needs no separate era stamp.
  const base = structuredClone(withEnvelope('{"body":"A"}')) as unknown as Array<Record<string, unknown>>;
  const stripped = structuredClone(base);
  delete stripped[0]!['responseEnvelope'];
  assert.notEqual(
    armDigest(digestInput({ orderedAttempts: stripped as never })),
    a,
    'stripping the envelope off a new attempt is digest-detected',
  );

  // An absent key and an explicit null are different evidence and must not collapse.
  const nulled = structuredClone(base);
  nulled[0]!['responseEnvelope'] = null;
  assert.notEqual(armDigest(digestInput({ orderedAttempts: nulled as never })), a);
  assert.notEqual(
    armDigest(digestInput({ orderedAttempts: stripped as never })),
    armDigest(digestInput({ orderedAttempts: nulled as never })),
  );
});

test('persistedAttemptSchemaV1 accepts a legacy attempt with no envelope key and refuses a malformed one', () => {
  const modern = first(toPersistedAttempts(armResult()));
  const legacy = { ...(modern as unknown as Record<string, unknown>) };
  delete legacy['responseEnvelope'];
  assert.ok(!Object.hasOwn(legacy, 'responseEnvelope'), 'the legacy fixture genuinely lacks the key');
  assert.doesNotThrow(() => persistedAttemptSchemaV1.parse(legacy), 'a pre-field attempt still parses');
  assert.doesNotThrow(() => persistedAttemptSchemaV1.parse({ ...legacy, responseEnvelope: null }));
  // The imported strict envelope schema is doing the work: an extra key, an upper-case
  // digest, a fractional byte count and a missing digest are each refused by exactly one
  // of its rules, so accepting any of them would mean this field got its own looser shape.
  for (const damage of ['extra-key', 'upper-case-sha256', 'fractional-bytes', 'missing-sha256'] as const) {
    assert.throws(
      () => persistedAttemptSchemaV1.parse({ ...legacy, responseEnvelope: damageEnvelope(modern.responseEnvelope!, damage) }),
      `${damage} must be refused`,
    );
  }
});
