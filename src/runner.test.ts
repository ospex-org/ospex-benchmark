import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ProviderHttpError, ProviderTimeoutError } from './providers/errors.js';
import { prepareGameRequest } from './preparedRequest.js';
import { runOneArmGame, runSlate } from './runner.js';
import { makeRequest, makeValidResponse, TEST_ARM, TEST_COHORT } from './testFactories.js';
import { CODE_MAX_REPAIRS_PER_ARM } from './repairPolicy.js';
import type { ArmSpec,
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

test('legacy pre-dispatch cutoff is inclusive at the EXACT first pitch (remaining=0): cutoff_missed, no call, carries the reading', async () => {
  // runOneArmGame is the legacy path (gate=null). A dispatch reading landing EXACTLY on first pitch
  // leaves zero remaining, which the `<= 0` boundary must refuse BEFORE any send — a `< 0` boundary
  // would let this doomed request through. The discarded reading is carried on refusedInitialStartAt
  // (B3), and no provider call is made.
  const request = prepareGameRequest(makeRequest(CUTOFF));
  const adapter = stubAdapter([]);
  const result = await runOneArmGame(TEST_ARM, adapter, request, baseOptions(() => CUTOFF_MS));
  assert.equal(result.outcome, 'cutoff_missed');
  assert.equal(adapter.calls.length, 0);
  assert.equal(result.refusedInitialStartAt, new Date(CUTOFF_MS).toISOString());
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
  // after validation — has crossed first pitch. nowMs read order (ONE dispatch
  // reading feeds both the pre-dispatch cutoff and the request start): request
  // start, response stamp, receipt check (in time), acceptance recheck (crossed).
  const request = prepareGameRequest(makeRequest(CUTOFF));
  const reads = [CUTOFF_MS - 60_000, CUTOFF_MS - 2, CUTOFF_MS - 1, CUTOFF_MS + 1];
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

test('the runner exhausts exactly CODE_MAX_REPAIRS_PER_ARM repair(s) on a fingerprintable-invalid arm', async () => {
  const request = prepareGameRequest(makeRequest(CUTOFF));
  // The initial response is schema-invalid but yields a complete decision fingerprint,
  // so a repair IS dispatched; the repair response stays invalid, so the permitted
  // repair budget is exhausted and the outcome remains a truthful invalid.
  const adapter = stubAdapter([
    async () => stubResponse(wrongEcho(makeValidResponse(request))),
    async () => stubResponse(wrongEcho(makeValidResponse(request))),
  ]);
  const result = await runOneArmGame(TEST_ARM, adapter, request, baseOptions(() => CUTOFF_MS - 60_000));
  assert.equal(result.outcome, 'invalid_schema');
  assert.equal(result.repairUsed, true);
  const repairCalls = adapter.calls.length - 1; // total adapter calls minus the one initial call
  assert.equal(repairCalls, CODE_MAX_REPAIRS_PER_ARM);
  assert.equal(repairCalls, 1);
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

test('a missing adapter is refused before ANY arm launches — arm 0 never starts', async () => {
  // The legacy grid is resolved completely before launch, so a gap at a LATER roster
  // position cannot let an earlier arm's request go out first (a partial dispatch).
  const request = makeRequest(CUTOFF);
  const armA: ArmSpec = { ...TEST_ARM, participantId: 'arm-a' };
  const armB: ArmSpec = { ...TEST_ARM, participantId: 'arm-b' };
  let armACalls = 0;
  const adapterA = stubAdapter([
    async () => {
      armACalls += 1;
      return stubResponse(JSON.stringify(makeValidResponse(request, armA)));
    },
  ]);
  await assert.rejects(
    () =>
      runSlate([armA, armB], new Map([[armA.participantId, adapterA]]), [request], {
        ...baseOptions(() => CUTOFF_MS - 60_000),
        cohortId: TEST_COHORT,
      }),
    /no adapter registered for arm-b/,
  );
  assert.equal(armACalls, 0, 'arm 0 must not start when a later arm has no adapter');
});

test('the legacy path keeps its rejection timing: a fast failure never waits for a slow sibling', async () => {
  // No lease lifecycle exists here, so there is no durable slot a sibling could still be
  // holding — the legacy contract is the pre-existing rejection identity AND timing. Routing
  // this path through the authorized path's all-settled policy to share a helper would
  // silently make every legacy caller wait for its slowest arm.
  const request = makeRequest(CUTOFF);
  const armA: ArmSpec = { ...TEST_ARM, participantId: 'arm-a' };
  const armB: ArmSpec = { ...TEST_ARM, participantId: 'arm-b' };
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let slowFinished = false;
  const adapterA = {
    ...stubAdapter([]),
    hasCredential: (): boolean => {
      throw new Error('legacy credential probe exploded');
    },
  };
  const adapterB = stubAdapter([
    async () => {
      await gate; // arm B is held in flight
      slowFinished = true;
      return stubResponse(JSON.stringify(makeValidResponse(request, armB)));
    },
  ]);

  const run = runSlate(
    [armA, armB],
    new Map([
      [armA.participantId, adapterA],
      [armB.participantId, adapterB],
    ]),
    [request],
    { ...baseOptions(() => CUTOFF_MS - 60_000), cohortId: TEST_COHORT },
  );
  const settled = await Promise.race([
    run.then(() => 'resolved' as const, (error: unknown) => ({ error })),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
  ]);
  const finishedBeforeRejection = slowFinished;
  openGate(); // never strand arm B, whatever the assertions below decide

  assert.notEqual(settled, 'pending', 'the legacy run must reject while the slow sibling is still in flight');
  assert.ok(
    typeof settled === 'object' &&
      settled.error instanceof Error &&
      /legacy credential probe exploded/.test(settled.error.message),
    'the base rejection identity is unchanged',
  );
  assert.equal(finishedBeforeRejection, false, 'the slow sibling had not settled when the run rejected');
});

test('the legacy path passes gate=null — ungated for V-lag/windowEnd, first-pitch retained', async () => {
  const request = prepareGameRequest(makeRequest(CUTOFF));
  // The legacy runOneArmGame has no detectedAt/windowEnd in scope: it is structurally ungated for
  // the new V-lag/windowEnd capability, so a well-before-cutoff dispatch sends and validates.
  const okAdapter = stubAdapter([async () => stubResponse(JSON.stringify(makeValidResponse(request)))]);
  const sent = await runOneArmGame(TEST_ARM, okAdapter, request, baseOptions(() => CUTOFF_MS - 60_000));
  assert.equal(sent.outcome, 'valid', 'ungated for the new capability');
  // The existing first-pitch cutoff check remains in force on the legacy path.
  const late = await runOneArmGame(TEST_ARM, stubAdapter([]), request, baseOptions(() => CUTOFF_MS + 1));
  assert.equal(late.outcome, 'cutoff_missed', 'first-pitch check retained');
  // Source: the legacy dispatch entries pass an explicit null gate (sibling of the null lifecycle).
  const runnerSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'runner.ts'), 'utf8');
  assert.ok(runnerSrc.includes('dispatchArm(target, request, options, null, null, 0)'), 'runSlate passes gate=null');
  assert.ok(/options,\s*\n\s*null,\s*\n\s*null,\s*\n\s*0,/.test(runnerSrc), 'runOneArmGame passes gate=null');
});

test('B3-R1 (legacy): a pre-dispatch cutoff carries the ONE reading on refusedInitialStartAt; credential_missing keeps it null', async () => {
  const request = prepareGameRequest(makeRequest(CUTOFF));
  // A SPARSE SEQUENCED clock — a constant clock would hide a second/extra read. The FIRST reading is
  // AT/after first pitch, so the (single, collapsed) dispatch reading trips the pre-dispatch cutoff.
  const reads = [CUTOFF_MS + 5, CUTOFF_MS + 999];
  let calls = 0;
  const nowMs = (): number => reads[Math.min(calls++, reads.length - 1)]!;
  const adapter = stubAdapter([]); // no chat handler → throws if (wrongly) sent
  const result = await runOneArmGame(TEST_ARM, adapter, request, baseOptions(nowMs));
  assert.equal(result.outcome, 'cutoff_missed');
  assert.equal(result.attempt.requestAt, null, 'never-sent: the discarded start is NOT written onto attempt.requestAt (no phantom attempt)');
  assert.equal(
    result.refusedInitialStartAt,
    new Date(CUTOFF_MS + 5).toISOString(),
    'the EXACT ONE reading is carried on the never-sent refusedInitialStartAt carrier',
  );
  assert.equal(calls, 1, 'exactly ONE clock reading was taken (the collapsed dispatch+start read)');
  assert.equal(adapter.calls.length, 0, 'no provider call');

  // credential_missing is a PRE-CLOCK refusal — no reading is taken, so the carrier stays null.
  let credCalls = 0;
  const credClock = (): number => {
    credCalls += 1;
    return CUTOFF_MS - 60_000;
  };
  const noCred: ProviderAdapter = { ...stubAdapter([]), hasCredential: () => false };
  const credResult = await runOneArmGame(TEST_ARM, noCred, request, baseOptions(credClock));
  assert.equal(credResult.outcome, 'credential_missing');
  assert.equal(credResult.refusedInitialStartAt, null, 'credential_missing took no reading — carrier null');
  assert.equal(credCalls, 0, 'the clock was never read before the pre-clock credential refusal');
});
