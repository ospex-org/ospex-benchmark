import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildRecords, writeNdjson, writeText } from './records.js';
import { makeRequest, makeValidResponse, TEST_ARM, TEST_COHORT } from './testFactories.js';
import type { BuildResult } from './bundle.js';
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

  const records = buildRecords(makeCtx(), build, [result], [], { failures: [], warnings: [] });
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
  const records = buildRecords(makeCtx(), build, [result], [], { failures: [], warnings: [] });
  assert.equal(records.filter((r) => r['recordType'] === 'decision').length, 0);
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
