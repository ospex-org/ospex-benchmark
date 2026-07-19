import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderHttpError, ProviderTimeoutError } from './providers/errors.js';
import { prepareGameRequest } from './preparedRequest.js';
import { runOneArmGame } from './runner.js';
import { makeRequest, makeValidResponse, TEST_ARM, TEST_COHORT } from './testFactories.js';
import type {
  BenchmarkResponse,
  ChatTurn,
  ProviderAdapter,
  ProviderResponse,
} from './types.js';

const CUTOFF = '2026-07-12T16:15:00+00:00';
const CUTOFF_MS = Date.parse(CUTOFF);

type ChatHandler = (turns: ChatTurn[], timeoutMs: number) => Promise<ProviderResponse>;

function stubAdapter(handlers: ChatHandler[]): ProviderAdapter & { calls: number[] } {
  const calls: number[] = [];
  let index = 0;
  return {
    provider: TEST_ARM.provider,
    requestedModelId: TEST_ARM.requestedModelId,
    credentialEnvVar: TEST_ARM.credentialEnvVar,
    calls,
    hasCredential: () => true,
    async chat(turns, timeoutMs): Promise<ProviderResponse> {
      calls.push(timeoutMs);
      const handler = handlers[index];
      index += 1;
      if (!handler) throw new Error('stub adapter: no handler for this call');
      return handler(turns, timeoutMs);
    },
  };
}

function stubResponse(rawText: string, reportedModelId = 'stub-model-1'): ProviderResponse {
  return {
    rawText,
    reportedModelId,
    providerResponseId: 'stub-response',
    httpStatus: 200,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    usageRaw: { prompt_tokens: 100, completion_tokens: 50 },
    requestParams: { stub: true },
  };
}

function wrongEcho(response: BenchmarkResponse): string {
  return JSON.stringify({ ...response, cohortId: 'wrong-cohort-echo' });
}

function baseOptions(nowMs: () => number) {
  return {
    cohortId: TEST_COHORT,
    timeoutMs: 600_000,
    maxOutputTokens: 16000,
    executionPolicy: 'fixed-moneyline-total' as const,
    nowMs,
  };
}

test('already past cutoff at dispatch: cutoff_missed, no provider call', async () => {
  const request = prepareGameRequest(makeRequest(CUTOFF));
  const adapter = stubAdapter([]);
  const result = await runOneArmGame(TEST_ARM, adapter, request, baseOptions(() => CUTOFF_MS + 1));
  assert.equal(result.outcome, 'cutoff_missed');
  assert.equal(adapter.calls.length, 0);
});

test('valid response crossing the cutoff: cutoff_missed, no decisions', async () => {
  const request = prepareGameRequest(makeRequest(CUTOFF));
  let now = CUTOFF_MS - 60_000;
  const adapter = stubAdapter([
    async () => {
      now = CUTOFF_MS + 1_000; // the response streams in after first pitch
      return stubResponse(JSON.stringify(makeValidResponse(request)));
    },
  ]);
  const result = await runOneArmGame(TEST_ARM, adapter, request, baseOptions(() => now));
  assert.equal(result.outcome, 'cutoff_missed');
  assert.equal(result.parsed, null);
  assert.ok(result.validationErrors.some((e) => e.includes('after the decision cutoff')));
});

test('a valid initial response stamps a truthful acceptedAt; the (absent) repair is untouched', async () => {
  const request = prepareGameRequest(makeRequest(CUTOFF));
  const adapter = stubAdapter([async () => stubResponse(JSON.stringify(makeValidResponse(request)))]);
  const result = await runOneArmGame(
    TEST_ARM,
    adapter,
    request,
    baseOptions(() => CUTOFF_MS - 60_000),
  );
  assert.equal(result.outcome, 'valid');
  assert.equal(result.repair, null);
  assert.equal(result.attempt.acceptedAt, new Date(CUTOFF_MS - 60_000).toISOString());
});

test('a valid repair stamps acceptedAt on the repair; the un-accepted initial stays null', async () => {
  const request = prepareGameRequest(makeRequest(CUTOFF));
  const adapter = stubAdapter([
    async () => stubResponse(wrongEcho(makeValidResponse(request))),
    async () => stubResponse(JSON.stringify(makeValidResponse(request))),
  ]);
  const result = await runOneArmGame(
    TEST_ARM,
    adapter,
    request,
    baseOptions(() => CUTOFF_MS - 60_000),
  );
  assert.equal(result.outcome, 'valid');
  assert.equal(result.repairUsed, true);
  assert.equal(result.attempt.acceptedAt, null);
  assert.equal(result.repair?.acceptedAt, new Date(CUTOFF_MS - 60_000).toISOString());
});

test('received in time but accepted after cutoff: cutoff_missed, acceptedAt unset', async () => {
  // The receipt cutoff check passes, but the acceptance instant — rechecked
  // after validation — has crossed first pitch. nowMs read order: dispatch
  // check, request start, response stamp, receipt check (in time), acceptance
  // recheck (crossed).
  const request = prepareGameRequest(makeRequest(CUTOFF));
  const reads = [CUTOFF_MS - 60_000, CUTOFF_MS - 60_000, CUTOFF_MS - 2, CUTOFF_MS - 1, CUTOFF_MS + 1];
  let index = 0;
  const nowMs = (): number => reads[Math.min(index++, reads.length - 1)] as number;
  const adapter = stubAdapter([async () => stubResponse(JSON.stringify(makeValidResponse(request)))]);
  const result = await runOneArmGame(TEST_ARM, adapter, request, baseOptions(nowMs));
  assert.equal(result.outcome, 'cutoff_missed');
  assert.equal(result.attempt.acceptedAt, null);
  assert.ok(result.validationErrors.some((e) => e.includes('accepted after the decision cutoff')));
});

test('an invalid_schema outcome leaves acceptedAt null on every attempt', async () => {
  const request = prepareGameRequest(makeRequest(CUTOFF));
  const adapter = stubAdapter([
    async () => stubResponse(wrongEcho(makeValidResponse(request))),
    async () => stubResponse(wrongEcho(makeValidResponse(request))),
  ]);
  const result = await runOneArmGame(
    TEST_ARM,
    adapter,
    request,
    baseOptions(() => CUTOFF_MS - 60_000),
  );
  assert.equal(result.outcome, 'invalid_schema');
  assert.equal(result.attempt.acceptedAt, null);
  assert.equal(result.repair?.acceptedAt, null);
});

test('repair crossing the cutoff: cutoff_missed even though the repaired content is valid', async () => {
  const request = prepareGameRequest(makeRequest(CUTOFF));
  let now = CUTOFF_MS - 60_000;
  const adapter = stubAdapter([
    async () => stubResponse(wrongEcho(makeValidResponse(request))),
    async () => {
      now = CUTOFF_MS + 1_000;
      return stubResponse(JSON.stringify(makeValidResponse(request)));
    },
  ]);
  const result = await runOneArmGame(TEST_ARM, adapter, request, baseOptions(() => now));
  assert.equal(result.outcome, 'cutoff_missed');
  assert.equal(result.repairUsed, true);
  assert.equal(result.parsed, null);
});

test('repair window closing after acceptance yields cutoff_missed, not invalid_schema', async () => {
  // Reproduction clock sequence from the review: the initial response is
  // accepted at 16:14:59.999Z, but by the repair-window check the clock has
  // crossed 16:15:00Z. The decision window closed before an acceptable
  // response existed → cutoff_missed. The queue mirrors the runner's exact
  // nowMs read order: dispatch check, request start, response stamp,
  // acceptance check, repair-window check.
  const request = prepareGameRequest(makeRequest(CUTOFF));
  const reads = [
    CUTOFF_MS - 61_000, // dispatch check
    CUTOFF_MS - 60_000, // timedChat request start
    CUTOFF_MS - 2, // timedChat response stamp
    CUTOFF_MS - 1, // acceptance check: 16:14:59.999 < cutoff → accepted in time
    CUTOFF_MS + 1, // repair-window check: 16:15:00.001 → window closed
  ];
  let index = 0;
  const nowMs = (): number => reads[Math.min(index++, reads.length - 1)] as number;
  const adapter = stubAdapter([
    async () => stubResponse(wrongEcho(makeValidResponse(request))),
  ]);
  const result = await runOneArmGame(TEST_ARM, adapter, request, {
    cohortId: TEST_COHORT,
    timeoutMs: 600_000,
    maxOutputTokens: 16000,
    executionPolicy: 'fixed-moneyline-total',
    nowMs,
  });
  assert.equal(result.outcome, 'cutoff_missed');
  assert.equal(result.repair, null);
  assert.equal(adapter.calls.length, 1);
  assert.ok(result.validationErrors.some((e) => e.includes('repair not dispatched')));
});

test('repair blocked by HTTP 429: transport recorded separately, never schema failure alone', async () => {
  const request = prepareGameRequest(makeRequest(CUTOFF));
  const adapter = stubAdapter([
    async () => stubResponse(wrongEcho(makeValidResponse(request))),
    async () => {
      throw new ProviderHttpError('stub', 429, 'simulated throttle');
    },
  ]);
  const result = await runOneArmGame(
    TEST_ARM,
    adapter,
    request,
    baseOptions(() => CUTOFF_MS - 60_000),
  );
  assert.equal(result.outcome, 'invalid_schema');
  assert.equal(result.repairTransport, 'rate_limited');
  assert.ok(result.validationErrors.some((e) => e.includes('repair not received (rate_limited)')));
});

test('unparseable initial response is unrepairable: no repair call, stays invalid', async () => {
  const request = prepareGameRequest(makeRequest(CUTOFF));
  const adapter = stubAdapter([
    async () => stubResponse('Milwaukee looks good tonight {{{ not json'),
  ]);
  const result = await runOneArmGame(
    TEST_ARM,
    adapter,
    request,
    baseOptions(() => CUTOFF_MS - 60_000),
  );
  assert.equal(result.outcome, 'invalid_schema');
  assert.equal(result.repair, null);
  assert.equal(adapter.calls.length, 1);
  assert.ok(
    result.validationErrors.some((e) => e.includes('no complete decision fingerprint')),
  );
});

test('repair that changes a decision is rejected even when schema-valid', async () => {
  const request = prepareGameRequest(makeRequest(CUTOFF));
  const mutated = makeValidResponse(request);
  const forecast = mutated.games[0]?.forecasts[0];
  assert.ok(forecast);
  forecast.selection = request.game.homeTeam; // Milwaukee -> Pittsburgh
  forecast.observedDecimal = request.game.markets.moneyline!.homeDecimal;
  const adapter = stubAdapter([
    async () => stubResponse(wrongEcho(makeValidResponse(request))),
    async () => stubResponse(JSON.stringify(mutated)),
  ]);
  const result = await runOneArmGame(
    TEST_ARM,
    adapter,
    request,
    baseOptions(() => CUTOFF_MS - 60_000),
  );
  assert.equal(result.outcome, 'invalid_schema');
  assert.ok(result.validationErrors.some((e) => e.includes('changed_decision_after_repair')));
});

test('fingerprint-preserving repair is accepted as valid', async () => {
  const request = prepareGameRequest(makeRequest(CUTOFF));
  const adapter = stubAdapter([
    async () => stubResponse(wrongEcho(makeValidResponse(request))),
    async () => stubResponse(JSON.stringify(makeValidResponse(request))),
  ]);
  const result = await runOneArmGame(
    TEST_ARM,
    adapter,
    request,
    baseOptions(() => CUTOFF_MS - 60_000),
  );
  assert.equal(result.outcome, 'valid');
  assert.equal(result.repairUsed, true);
  assert.equal(result.repairTransport, 'ok');
  assert.ok(result.parsed);
});

test('each call is bounded by the remaining time to cutoff', async () => {
  const request = prepareGameRequest(makeRequest(CUTOFF));
  const adapter = stubAdapter([
    async () => stubResponse(JSON.stringify(makeValidResponse(request))),
  ]);
  const result = await runOneArmGame(
    TEST_ARM,
    adapter,
    request,
    baseOptions(() => CUTOFF_MS - 5_000),
  );
  assert.equal(result.outcome, 'valid');
  const timeoutArg = adapter.calls[0];
  assert.ok(timeoutArg !== undefined && timeoutArg <= 5_000);
});

test('initial timeout classifies as timeout', async () => {
  const request = prepareGameRequest(makeRequest(CUTOFF));
  const adapter = stubAdapter([
    async (_turns, timeoutMs) => {
      throw new ProviderTimeoutError('stub', timeoutMs);
    },
  ]);
  const result = await runOneArmGame(
    TEST_ARM,
    adapter,
    request,
    baseOptions(() => CUTOFF_MS - 60_000),
  );
  assert.equal(result.outcome, 'timeout');
});
