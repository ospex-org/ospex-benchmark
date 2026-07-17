import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import { runSlate } from './runner.js';
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
import type { RunEnvelope } from './runner.js';
import type {
  ArmGameResult,
  AttemptRecord,
  BenchmarkResponse,
  ChatTurn,
  ProviderAdapter,
  ProviderResponse,
} from './types.js';

const CUTOFF_MS = Date.parse('2026-07-12T16:15:00+00:00');

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

// ---------------------------------------------------------------------------
// Envelope fixtures: buildRecords now consumes a BRANDED RunEnvelope, produced
// ONLY by runSlate (SPEC-artifact-producer.md A5). These tests drive runSlate
// with a stub adapter so every buildRecords input is a genuine sealed envelope.
// ---------------------------------------------------------------------------

type ChatHandler = () => ProviderResponse;

function stubAdapter(handlers: ChatHandler[]): ProviderAdapter {
  let index = 0;
  return {
    provider: TEST_ARM.provider,
    requestedModelId: TEST_ARM.requestedModelId,
    credentialEnvVar: TEST_ARM.credentialEnvVar,
    hasCredential: () => true,
    async chat(_turns: ChatTurn[]): Promise<ProviderResponse> {
      const handler = handlers[index];
      index += 1;
      if (!handler) throw new Error('stub adapter: no handler for this call');
      return handler();
    },
  };
}

function stubResponse(
  rawText: string,
  ids: { reportedModelId?: string; providerResponseId?: string } = {},
): ProviderResponse {
  return {
    rawText,
    reportedModelId: ids.reportedModelId ?? 'stub-model-1',
    providerResponseId: ids.providerResponseId ?? 'stub-response',
    httpStatus: 200,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    usageRaw: { prompt_tokens: 100, completion_tokens: 50 },
    requestParams: { stub: true },
  };
}

/** An initial response whose echoed cohortId is wrong — validation fails, but the
 *  decision fingerprint is intact, so a fingerprint-preserving repair is accepted. */
function wrongEcho(response: BenchmarkResponse): string {
  return JSON.stringify({ ...response, cohortId: 'wrong-cohort-echo' });
}

async function envFrom(
  build: BuildResult,
  ctx: RunContext,
  handlers: ChatHandler[],
  nowMs: () => number = () => CUTOFF_MS - 60_000,
): Promise<RunEnvelope> {
  // The options' five load-bearing fields must equal ctx's, or authenticateRun
  // fails closed (A4). slateDate is derived from the request bundle inside the
  // envelope, and makeCtx().slateDate matches makeRequest()'s bundle date.
  return runSlate([TEST_ARM], new Map([[TEST_ARM.participantId, stubAdapter(handlers)]]), build.requests, {
    cohortId: ctx.cohortId,
    timeoutMs: ctx.timeoutMs,
    maxOutputTokens: ctx.maxOutputTokens,
    executionPolicy: ctx.executionPolicy,
    nowMs,
  });
}

test('repaired decisions carry the ACCEPTED repair attempt provenance', async () => {
  const build = makeBuild();
  const ctx = makeCtx();
  const request = build.requests[0];
  assert.ok(request);
  const env = await envFrom(build, ctx, [
    () =>
      stubResponse(wrongEcho(makeValidResponse(request)), {
        reportedModelId: 'stub-model-initial',
        providerResponseId: 'resp-initial',
      }),
    () =>
      stubResponse(JSON.stringify(makeValidResponse(request)), {
        reportedModelId: 'stub-model-repair',
        providerResponseId: 'resp-repair',
      }),
  ]);
  assert.equal(env.results[0]?.repairUsed, true);

  const records = buildRecords(env, ctx, build, { failures: [], warnings: [] });
  const decisions = records.filter((r) => r['recordType'] === 'decision');
  assert.equal(decisions.length, 3);
  for (const decision of decisions) {
    // Decision provenance is the ACCEPTED (repair) attempt, not the initial one.
    assert.equal(decision['reportedModelId'], 'stub-model-repair');
    assert.equal(decision['providerResponseId'], 'resp-repair');
    assert.equal(decision['attemptUsed'], 'repair');
  }

  const armResponse = records.find((r) => r['recordType'] === 'arm_game_response');
  assert.ok(armResponse);
  const initial = armResponse['attempt'] as Record<string, unknown>;
  const repair = armResponse['repair'] as Record<string, unknown>;
  assert.equal(initial['reportedModelId'], 'stub-model-initial');
  assert.equal(repair['reportedModelId'], 'stub-model-repair');
});

test('bundle_game serializes the exact prepared game, hash-consistent', async () => {
  const build = makeBuild();
  const ctx = makeCtx();
  const request = build.requests[0];
  assert.ok(request);
  const env = await envFrom(build, ctx, [
    () => stubResponse(JSON.stringify(makeValidResponse(request))),
  ]);
  const records = buildRecords(env, ctx, build, { failures: [], warnings: [] });
  const bundleGame = records.find((r) => r['recordType'] === 'bundle_game');
  assert.ok(bundleGame);
  const first = env.snapshot.prepared[0];
  assert.ok(first);
  // The recorded bundle IS the frozen prepared game object itself (reference
  // identity) — not a value-equal build alias.
  assert.strictEqual(bundleGame['bundle'], first.game);
  // Every hash/cutoff on the record is the prepared request's derived value, and
  // the recorded gameSha256 is self-consistent with the bytes it recorded.
  assert.equal(bundleGame['gameSha256'], first.gameSha256);
  assert.equal(bundleGame['gameSha256'], sha256Hex(canonicalize(bundleGame['bundle'])));
  assert.equal(bundleGame['requestSha256'], first.requestSha256);
  assert.equal(bundleGame['cutoffAt'], first.cutoffAt);
});

test('a mutation attempt after preparation does not change the recorded bundle', async () => {
  const build = makeBuild();
  const ctx = makeCtx();
  const request = build.requests[0];
  assert.ok(request);
  const env = await envFrom(build, ctx, [
    () => stubResponse(JSON.stringify(makeValidResponse(request))),
  ]);
  // The prepared game is deep-frozen: a write is a no-op (throws in strict mode).
  try {
    (env.snapshot.prepared[0]!.game as { awayTeam: string }).awayTeam = 'MUTATED';
  } catch {
    // strict-mode TypeError writing a frozen property — expected.
  }
  const records = buildRecords(env, ctx, build, { failures: [], warnings: [] });
  const bundleGame = records.find((r) => r['recordType'] === 'bundle_game');
  assert.ok(bundleGame);
  assert.equal((bundleGame['bundle'] as { awayTeam: string }).awayTeam, 'Milwaukee Brewers');
});

test('cutoff_missed results never emit decision records', async () => {
  const build = makeBuild();
  const ctx = makeCtx();
  // nowMs AT the cutoff → the decision window has closed at dispatch, so the arm
  // result is cutoff_missed with no provider call (parsed is null). The old
  // "cutoff_missed with a non-null parsed" angle is unreachable via runSlate;
  // the real invariant is that cutoff_missed emits zero decisions.
  const env = await envFrom(build, ctx, [], () => CUTOFF_MS);
  assert.equal(env.results[0]?.outcome, 'cutoff_missed');
  const records = buildRecords(env, ctx, build, { failures: [], warnings: [] });
  assert.equal(records.filter((r) => r['recordType'] === 'decision').length, 0);
});

test('identity-only failures get their own MODEL_IDENTITY run_failure record, never PROVIDER_COLLISION', async () => {
  const build = makeBuild();
  const ctx = makeCtx();
  const request = build.requests[0];
  assert.ok(request);
  const env = await envFrom(build, ctx, [
    () => stubResponse(JSON.stringify(makeValidResponse(request))),
  ]);
  const records = buildRecords(env, ctx, build, {
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
