import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import { PreparedRequestError, prepareGameRequest } from './preparedRequest.js';
import { buildUserMessage } from './prompt.js';
import { runOneArmGame, runSlate } from './runner.js';
import type { SlateRunOptions } from './runner.js';
import { makeRequest, makeValidResponse } from './testFactories.js';
import type { GameRequest } from './bundle.js';
import type { PreparedGameRequest } from './preparedRequest.js';
import type { ArmSpec, ProviderAdapter, ProviderResponse } from './types.js';

/**
 * Integration proof for the dispatch boundary (SPEC-prepared-request.md §2.3,
 * §5 "S1"): the runner prepares and verifies EVERY request through
 * `prepareGameRequest` before any provider call, so a request that fails
 * preparation makes ZERO adapter calls, and the bytes the model is prompted
 * with canonicalize back to the exact bytes behind `requestSha256`.
 *
 * `prepareGameRequest`'s rejection of malformed input is exhaustively covered
 * in preparedRequest.test.ts. These tests do not re-test that surface; they
 * prove the WIRING — that `runSlate` gates dispatch on preparation — using a
 * counting adapter that records every `chat` call.
 */

const COHORT = 'prepared-dispatch-cohort';
const CUTOFF = '2026-07-12T16:15:00+00:00';
const CUTOFF_MS = Date.parse(CUTOFF);

const ARM_A: ArmSpec = {
  participantId: 'arm-a',
  provider: 'openai',
  requestedModelId: 'model-a',
  credentialEnvVar: 'STUB_A_KEY',
};
const ARM_B: ArmSpec = {
  participantId: 'arm-b',
  provider: 'anthropic',
  requestedModelId: 'model-b',
  credentialEnvVar: 'STUB_B_KEY',
};
const ARMS: ArmSpec[] = [ARM_A, ARM_B];

function stubResponse(rawText: string, reportedModelId: string): ProviderResponse {
  return {
    rawText,
    reportedModelId,
    providerResponseId: 'counting-response',
    httpStatus: 200,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    usageRaw: { prompt_tokens: 100, completion_tokens: 50 },
    requestParams: { stub: true },
  };
}

/**
 * An adapter that counts its `chat` calls. `respond === null` means the arm
 * must never be dispatched — a call throws loudly so a leaked dispatch cannot
 * masquerade as zero calls.
 */
function countingAdapter(
  arm: ArmSpec,
  respond: (() => ProviderResponse) | null,
): { adapter: ProviderAdapter; calls: () => number } {
  let calls = 0;
  const adapter: ProviderAdapter = {
    provider: arm.provider,
    requestedModelId: arm.requestedModelId,
    credentialEnvVar: arm.credentialEnvVar,
    hasCredential: () => true,
    async chat(): Promise<ProviderResponse> {
      calls += 1;
      if (respond === null) {
        throw new Error(`counting adapter for ${arm.participantId} must not be dispatched`);
      }
      return respond();
    },
  };
  return { adapter, calls: () => calls };
}

function makeAdapters(
  dispatchable: boolean,
  validRaw: GameRequest,
): { adapters: Map<string, ProviderAdapter>; totalCalls: () => number } {
  const counters: Array<() => number> = [];
  const adapters = new Map<string, ProviderAdapter>();
  for (const arm of ARMS) {
    const respond = dispatchable
      ? (): ProviderResponse =>
          stubResponse(JSON.stringify(makeValidResponse(validRaw, arm, COHORT)), arm.requestedModelId)
      : null;
    const { adapter, calls } = countingAdapter(arm, respond);
    adapters.set(arm.participantId, adapter);
    counters.push(calls);
  }
  return { adapters, totalCalls: () => counters.reduce((sum, c) => sum + c(), 0) };
}

function options(): SlateRunOptions {
  return {
    cohortId: COHORT,
    timeoutMs: 600_000,
    maxOutputTokens: 16000,
    nowMs: () => CUTOFF_MS - 60_000,
  };
}

function reSha(request: GameRequest): GameRequest {
  return { ...request, requestSha256: sha256Hex(canonicalize(request.requestBundle)) };
}

/** A three-market request with the total market removed from the bundle game. */
function dropTotal(valid: GameRequest): GameRequest {
  const clone = structuredClone(valid);
  delete (clone.requestBundle.games[0]!.markets as unknown as Record<string, unknown>)['total'];
  delete (clone.game.markets as unknown as Record<string, unknown>)['total'];
  return reSha(clone);
}

/** A per-game bundle carrying two games instead of one. */
function twoGames(valid: GameRequest): GameRequest {
  const clone = structuredClone(valid);
  const game = clone.requestBundle.games[0]!;
  clone.requestBundle.games = [game, structuredClone(game)];
  return reSha(clone);
}

test('the three-market request prepares and dispatches to every arm', async () => {
  const validRaw = makeRequest(CUTOFF);
  const { adapters, totalCalls } = makeAdapters(true, validRaw);
  const results = await runSlate(ARMS, adapters, [validRaw], options());
  assert.equal(results.length, ARMS.length);
  for (const result of results) assert.equal(result.outcome, 'valid');
  assert.equal(totalCalls(), ARMS.length); // exactly one call per arm
});

// Each failure rejects at a DIFFERENT stage of preparation (alias check,
// own-market gate, cardinality check), proving the dispatch gate covers the
// whole boundary — not just one check — and never calls an adapter.
const malformed: Array<{ name: string; make: (valid: GameRequest) => GameRequest }> = [
  {
    name: 'a supplied requestSha256 that does not match',
    make: (valid) => ({ ...valid, requestSha256: 'b'.repeat(64) }),
  },
  { name: 'a market block missing from the bundle', make: dropTotal },
  { name: 'a per-game bundle carrying two games', make: twoGames },
];

for (const { name, make } of malformed) {
  test(`runSlate makes zero adapter calls when preparation rejects ${name}`, async () => {
    const validRaw = makeRequest(CUTOFF);
    const { adapters, totalCalls } = makeAdapters(false, validRaw);
    await assert.rejects(
      runSlate(ARMS, adapters, [make(validRaw)], options()),
      PreparedRequestError,
    );
    assert.equal(totalCalls(), 0);
  });
}

test('the prompted bundle canonicalizes back to the exact bytes behind requestSha256', () => {
  const prepared = prepareGameRequest(makeRequest(CUTOFF));
  const message = buildUserMessage({
    cohortId: COHORT,
    participantId: ARM_A.participantId,
    requestedModelId: ARM_A.requestedModelId,
    executionPolicy: 'fixed-moneyline-total',
    request: prepared,
  });

  // The bundle is embedded in a larger, pretty-printed payload; parse it back.
  const marker = '\nRequest:\n';
  const at = message.indexOf(marker);
  assert.ok(at !== -1, 'prompt must contain the request payload');
  const payload = JSON.parse(message.slice(at + marker.length)) as {
    bundle: unknown;
    bundleSha256: unknown;
    decisionCutoffUtc: unknown;
  };

  // Formatting aside, the prompted bundle reproduces exactly the hashed bytes.
  const promptedCanonical = canonicalize(payload.bundle);
  assert.equal(promptedCanonical, canonicalize(prepared.requestBundle));
  assert.equal(sha256Hex(promptedCanonical), prepared.requestSha256);

  // The guard stamps the prepared request's DERIVED fields, never a value a
  // caller supplied alongside an unrelated bundle.
  assert.equal(payload.bundleSha256, prepared.requestSha256);
  assert.equal(payload.decisionCutoffUtc, prepared.cutoffAt);
});

// The compile-time PreparedGameRequest type is erased at runtime, so a direct
// caller could forge the shape. Both exported entry points must reject a forged
// request at runtime — before serializing it or dispatching it to a model. Each
// forgery throws on ANY property read, so a passing test proves the origin
// guard fired FIRST: were the guard absent, buildUserMessage/runOneArmGame would
// read a field and surface this Error instead of the clean PreparedRequestError.
function forgedRequest(): PreparedGameRequest {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('a field was read before the origin guard rejected the request');
      },
    },
  ) as unknown as PreparedGameRequest;
}

test('buildUserMessage rejects a forged request before serializing anything', () => {
  assert.throws(
    () =>
      buildUserMessage({
        cohortId: COHORT,
        participantId: ARM_A.participantId,
        requestedModelId: ARM_A.requestedModelId,
        executionPolicy: 'fixed-moneyline-total',
        request: forgedRequest(),
      }),
    PreparedRequestError,
  );
});

test('runOneArmGame rejects a forged request before any field read, with zero adapter calls', async () => {
  const { adapter, calls } = countingAdapter(ARM_A, () =>
    stubResponse('{}', ARM_A.requestedModelId),
  );
  await assert.rejects(
    runOneArmGame(ARM_A, adapter, forgedRequest(), options()),
    PreparedRequestError,
  );
  assert.equal(calls(), 0);
});
