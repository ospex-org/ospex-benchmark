import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import { prepareGameRequest } from './preparedRequest.js';
import { sealDispatch } from './runner.js';
import {
  buildRecords,
  failuresByCode,
  unidentifiedResponsesByArm,
  writeNdjson,
  writeText,
} from './records.js';
import { makeRequest, makeValidResponse, TEST_ARM, TEST_COHORT } from './testFactories.js';
import type { BuildResult, GameRequest } from './bundle.js';
import type { RunContext } from './records.js';
import type { ArmGameResult, AttemptRecord } from './types.js';

function makeBuild(): BuildResult {
  const request = makeRequest();
  return {
    slateBundle: { ...request.requestBundle },
    slateSha256: request.requestSha256,
    requests: [request],
    gameHashes: { [request.gameId]: 'a'.repeat(64) },
    excluded: [],
    provenance: { [request.gameId]: { slug: request.slug, oddsRows: [] } },
  };
}

function makeCtx(): RunContext {
  return {
    runId: 'test-run',
    cohortId: TEST_COHORT,
    mode: 'dry-run',
    slateDate: '2026-07-12',
    createdAt: '2026-07-12T14:07:00.000Z',
    executionPolicy: 'fixed-moneyline-total',
    timeoutMs: 2000,
    maxOutputTokens: 16000,
    fetchStartedAt: '2026-07-12T14:05:00+00:00',
    fetchCompletedAt: '2026-07-12T14:05:00+00:00',
    clockMode: 'synthetic-fixture',
  };
}

function attempt(overrides: Partial<AttemptRecord>): AttemptRecord {
  return {
    rawText: '{}',
    reportedModelId: null,
    providerResponseId: null,
    httpStatus: 200,
    usage: null,
    usageRaw: null,
    requestParams: null,
    requestAt: null,
    responseAt: null,
    latencyMs: null,
    errorDetail: null,
    ...overrides,
  };
}

/** A minimal result matching a request — satisfies the (arm, game) completeness
 *  gate for tests that focus on non-result records. */
function minimalResult(request: GameRequest): ArmGameResult {
  return {
    arm: TEST_ARM,
    gameId: request.gameId,
    requestSha256: request.requestSha256,
    cutoffAt: request.requestBundle.cutoffAt,
    outcome: 'timeout',
    attempt: attempt({ rawText: null }),
    repair: null,
    repairUsed: false,
    repairTransport: null,
    parsed: null,
    validationErrors: [],
  };
}

test('repaired decisions carry the ACCEPTED repair attempt provenance', () => {
  const build = makeBuild();
  const request = build.requests[0];
  assert.ok(request);
  const result: ArmGameResult = {
    arm: TEST_ARM,
    gameId: request.gameId,
    requestSha256: request.requestSha256,
    cutoffAt: request.requestBundle.cutoffAt,
    outcome: 'valid',
    attempt: attempt({
      reportedModelId: 'stub-model-initial',
      providerResponseId: 'resp-initial',
      latencyMs: 1000,
      requestAt: '2026-07-12T14:07:01.000Z',
      responseAt: '2026-07-12T14:07:02.000Z',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
    repair: attempt({
      reportedModelId: 'stub-model-repair',
      providerResponseId: 'resp-repair',
      latencyMs: 2000,
      requestAt: '2026-07-12T14:07:03.000Z',
      responseAt: '2026-07-12T14:07:05.000Z',
      usage: { inputTokens: 20, outputTokens: 9, totalTokens: 29 },
      usageRaw: { prompt_tokens: 20, completion_tokens: 9 },
    }),
    repairUsed: true,
    repairTransport: 'ok',
    parsed: makeValidResponse(request),
    validationErrors: [],
  };

  const records = buildRecords(makeCtx(), build, sealDispatch(build.requests.map(prepareGameRequest)), [result], { failures: [], warnings: [] });
  const decisions = records.filter((r) => r['recordType'] === 'decision');
  assert.equal(decisions.length, 3);
  for (const decision of decisions) {
    assert.equal(decision['reportedModelId'], 'stub-model-repair');
    assert.equal(decision['providerResponseId'], 'resp-repair');
    assert.equal(decision['latencyMs'], 2000);
    assert.equal(decision['responseAt'], '2026-07-12T14:07:05.000Z');
    assert.deepEqual(decision['tokens'], { inputTokens: 20, outputTokens: 9, totalTokens: 29 });
    assert.equal(decision['attemptUsed'], 'repair');
  }

  const armResponse = records.find((r) => r['recordType'] === 'arm_game_response');
  assert.ok(armResponse);
  const initial = armResponse['attempt'] as Record<string, unknown>;
  const repair = armResponse['repair'] as Record<string, unknown>;
  assert.equal(initial['reportedModelId'], 'stub-model-initial');
  assert.equal(repair['reportedModelId'], 'stub-model-repair');
});

test('bundle_game serializes the exact prepared game, hash-consistent', () => {
  const build = makeBuild();
  const snapshot = sealDispatch(build.requests.map(prepareGameRequest));
  const records = buildRecords(makeCtx(), build, snapshot, [minimalResult(build.requests[0]!)], { failures: [], warnings: [] });
  const bundleGame = records.find((r) => r['recordType'] === 'bundle_game');
  assert.ok(bundleGame);
  const first = snapshot.prepared[0];
  assert.ok(first);
  // The recorded bundle IS the frozen prepared game object itself (reference
  // identity) — not a value-equal build alias. deepEqual would pass against the
  // exact regression this guards (bundle: build.requests[i].game); strictEqual
  // pins the object provenance the test name claims.
  assert.strictEqual(bundleGame['bundle'], first.game);
  // Every hash/cutoff on the record is the prepared request's derived value, and
  // the recorded gameSha256 is self-consistent with the bytes it recorded.
  assert.equal(bundleGame['gameSha256'], first.gameSha256);
  assert.equal(bundleGame['gameSha256'], sha256Hex(canonicalize(bundleGame['bundle'])));
  assert.equal(bundleGame['requestSha256'], first.requestSha256);
  assert.equal(bundleGame['cutoffAt'], first.cutoffAt);
});

test('a mutation attempt after preparation does not change the recorded bundle', () => {
  const build = makeBuild();
  const snapshot = sealDispatch(build.requests.map(prepareGameRequest));
  // The prepared game is deep-frozen: a write is a no-op (throws in strict mode).
  // Records serialize that frozen snapshot regardless of any mutation attempt.
  try {
    (snapshot.prepared[0]!.game as { awayTeam: string }).awayTeam = 'MUTATED';
  } catch {
    // strict-mode TypeError writing a frozen property — expected.
  }
  const records = buildRecords(makeCtx(), build, snapshot, [minimalResult(build.requests[0]!)], { failures: [], warnings: [] });
  const bundleGame = records.find((r) => r['recordType'] === 'bundle_game');
  assert.ok(bundleGame);
  assert.equal((bundleGame['bundle'] as { awayTeam: string }).awayTeam, 'Milwaukee Brewers');
});

test('cutoff_missed results never emit decision records', () => {
  const build = makeBuild();
  const request = build.requests[0];
  assert.ok(request);
  const result: ArmGameResult = {
    arm: TEST_ARM,
    gameId: request.gameId,
    requestSha256: request.requestSha256,
    cutoffAt: request.requestBundle.cutoffAt,
    outcome: 'cutoff_missed',
    attempt: attempt({ rawText: JSON.stringify(makeValidResponse(request)) }),
    repair: null,
    repairUsed: false,
    repairTransport: null,
    // deliberately non-null parsed to prove the outcome gate, not the parse,
    // controls decision emission
    parsed: makeValidResponse(request),
    validationErrors: ['response received after the decision cutoff'],
  };
  const records = buildRecords(makeCtx(), build, sealDispatch(build.requests.map(prepareGameRequest)), [result], { failures: [], warnings: [] });
  assert.equal(records.filter((r) => r['recordType'] === 'decision').length, 0);
});

test('identity-only failures get their own MODEL_IDENTITY run_failure record, never PROVIDER_COLLISION', () => {
  const build = makeBuild();
  const records = buildRecords(makeCtx(), build, sealDispatch(build.requests.map(prepareGameRequest)), [minimalResult(build.requests[0]!)], {
    failures: [
      'MODEL_IDENTITY: some-arm returned 1 response(s) without a reported model ID — accepted decisions require verified identity',
      'PROVIDER_COLLISION: two arms resolve to the openai family',
    ],
    warnings: [],
  });
  const runFailures = records.filter((r) => r['recordType'] === 'run_failure');
  assert.equal(runFailures.length, 2);
  const codes = runFailures.map((r) => r['code']).sort();
  assert.deepEqual(codes, ['MODEL_IDENTITY', 'PROVIDER_COLLISION']);
  const identity = runFailures.find((r) => r['code'] === 'MODEL_IDENTITY');
  assert.ok(identity);
  const identityFailures = identity['failures'] as string[];
  assert.equal(identityFailures.length, 1);
  assert.ok(identityFailures[0]?.startsWith('MODEL_IDENTITY'));
});

test('failuresByCode classifies by machine-code prefix', () => {
  const grouped = failuresByCode(['MODEL_IDENTITY: a', 'PROVIDER_COLLISION: b', 'MODEL_IDENTITY: c']);
  assert.deepEqual(grouped.get('MODEL_IDENTITY'), ['MODEL_IDENTITY: a', 'MODEL_IDENTITY: c']);
  assert.deepEqual(grouped.get('PROVIDER_COLLISION'), ['PROVIDER_COLLISION: b']);
});

test('unidentifiedResponsesByArm counts successful responses lacking a model ID, not transport failures', () => {
  const build = makeBuild();
  const request = build.requests[0];
  assert.ok(request);
  const base = {
    arm: TEST_ARM,
    gameId: request.gameId,
    requestSha256: request.requestSha256,
    cutoffAt: request.requestBundle.cutoffAt,
    repair: null,
    repairUsed: false,
    repairTransport: null,
    parsed: null,
    validationErrors: [],
  };
  const results: ArmGameResult[] = [
    // successful response, no reported ID → counts
    { ...base, outcome: 'valid', attempt: attempt({ rawText: '{}', reportedModelId: null }) },
    // transport failure (no body) → exempt
    { ...base, outcome: 'timeout', attempt: attempt({ rawText: null, reportedModelId: null }) },
    // successful response with an ID → does not count
    {
      ...base,
      outcome: 'valid',
      attempt: attempt({ rawText: '{}', reportedModelId: 'stub-model-1' }),
    },
  ];
  assert.equal(unidentifiedResponsesByArm(results).get(TEST_ARM.participantId), 1);
});

test('every serialized byte passes secret redaction — rationale and validation errors included', () => {
  const secret = 'stub-secret-value-abcdef123456';
  const original = process.env['OPENAI_API_KEY'];
  process.env['OPENAI_API_KEY'] = secret;
  const dir = mkdtempSync(join(tmpdir(), 'ospex-benchmark-test-'));
  try {
    const ndjsonPath = join(dir, 'records.ndjson');
    writeNdjson(ndjsonPath, [
      {
        recordType: 'decision',
        rationale: `the key is ${secret} apparently`,
        validationErrors: [`echoed credential ${secret}`],
        usageRaw: { note: secret },
        reportedModelId: secret,
      },
    ]);
    const ndjson = readFileSync(ndjsonPath, 'utf8');
    assert.ok(!ndjson.includes(secret));
    assert.ok(ndjson.includes('[REDACTED]'));

    const summaryPath = join(dir, 'summary.md');
    writeText(summaryPath, `# Summary\n\nthe model said: ${secret}\n`);
    const summary = readFileSync(summaryPath, 'utf8');
    assert.ok(!summary.includes(secret));
    assert.ok(summary.includes('[REDACTED]'));
  } finally {
    if (original === undefined) {
      delete process.env['OPENAI_API_KEY'];
    } else {
      process.env['OPENAI_API_KEY'] = original;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
