import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import { PreparedRequestError, prepareGameRequest } from './preparedRequest.js';
import { buildUserMessage } from './prompt.js';
import type { PromptInputs } from './prompt.js';
import { buildRecords } from './records.js';
import type { RunContext } from './records.js';
import { runOneArmGame, runSlate, sealDispatch } from './runner.js';
import type { RunEnvelope, SlateRunOptions } from './runner.js';
import { parseRunRecords, verifyRunIntegrity } from './scoring.js';
import { buildSummaryMarkdown } from './summary.js';
import { makeRequest, makeValidResponse } from './testFactories.js';
import type { BuildResult, GameRequest } from './bundle.js';
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
    executionPolicy: 'fixed-moneyline-total',
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
  const env = await runSlate(ARMS, adapters, [validRaw], options());
  assert.equal(env.results.length, ARMS.length);
  for (const result of env.results) assert.equal(result.outcome, 'valid');
  assert.equal(totalCalls(), ARMS.length); // exactly one call per arm
  // runSlate surfaces the frozen snapshot it dispatched (for records/baselines).
  assert.equal(env.snapshot.prepared.length, 1);
  assert.equal(env.snapshot.prepared[0]?.requestSha256, validRaw.requestSha256);
  assert.equal(env.snapshot.slate.games.length, 1);
  assert.ok(Object.isFrozen(env.snapshot.prepared)); // the snapshot array is sealed
  // The envelope carries the dispatched roster manifest and the four dispatch fields.
  assert.deepEqual([...env.expectedArms], ARMS.map((a) => a.participantId));
  assert.equal(env.dispatch.executionPolicy, 'fixed-moneyline-total');
  assert.ok(Object.isFrozen(env)); // A2: the whole envelope is deep-frozen
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

test('runSlate rejects a duplicate-game batch before any provider call', async () => {
  // sealDispatch runs before dispatch, so a batch-level rejection makes zero calls.
  const validRaw = makeRequest(CUTOFF);
  const { adapters, totalCalls } = makeAdapters(false, validRaw);
  await assert.rejects(
    runSlate(ARMS, adapters, [validRaw, validRaw], options()),
    /duplicate game ID/,
  );
  assert.equal(totalCalls(), 0);
});

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

test('buildUserMessage cannot be check/use-swapped by a request getter', () => {
  // The exploit: a getter that returns a genuine branded request to the guard
  // and a hostile one to the serializer. buildUserMessage must read the request
  // exactly once, so the hostile object is never reachable.
  const prepared = prepareGameRequest(makeRequest(CUTOFF));
  const hostile = {
    requestSha256: 'b'.repeat(64),
    cutoffAt: 'hijacked-cutoff',
    requestBundle: { hijacked: true },
  } as unknown as PreparedGameRequest;
  let reads = 0;
  const inputs: PromptInputs = {
    cohortId: COHORT,
    participantId: ARM_A.participantId,
    requestedModelId: ARM_A.requestedModelId,
    executionPolicy: 'fixed-moneyline-total',
    get request(): PreparedGameRequest {
      reads += 1;
      return reads === 1 ? prepared : hostile;
    },
  };

  const message = buildUserMessage(inputs);

  // The request was read exactly once — the swapped-in hostile value never runs.
  assert.equal(reads, 1);
  // And the serialized bundle is the genuine prepared one, never the hostile one.
  const marker = '\nRequest:\n';
  const payload = JSON.parse(message.slice(message.indexOf(marker) + marker.length)) as {
    bundle: unknown;
    bundleSha256: unknown;
  };
  assert.equal(payload.bundleSha256, prepared.requestSha256);
  assert.equal(canonicalize(payload.bundle), canonicalize(prepared.requestBundle));
  assert.ok(!message.includes('hijacked'));
});

const NO_COLLISION = { failures: [], warnings: [] };

function runContext(): RunContext {
  return {
    runId: 'smoke-v0-2026-07-12-abcdef',
    cohortId: COHORT,
    mode: 'dry-run',
    slateDate: '2026-07-12',
    createdAt: '2026-07-12T14:07:00.000Z',
    executionPolicy: 'fixed-moneyline-total',
    timeoutMs: 600_000,
    maxOutputTokens: 16000,
    fetchStartedAt: '2026-07-12T14:04:00+00:00',
    fetchCompletedAt: '2026-07-12T14:05:00+00:00',
    clockMode: 'synthetic-fixture',
  };
}

/** A build whose slate game IS the request's game object (the mutation vector). */
function sharedBuild(request: GameRequest): BuildResult {
  return {
    slateBundle: request.requestBundle,
    slateSha256: request.requestSha256,
    requests: [request],
    gameHashes: { [request.gameId]: sha256Hex(canonicalize(request.game)) },
    excluded: [],
    provenance: { [request.gameId]: { slug: request.slug, oddsRows: [] } },
  };
}

test('a post-preparation mutation of the build slate cannot split the artifact', async () => {
  const request = makeRequest(CUTOFF);
  const build = sharedBuild(request);
  const originalAway = request.game.markets.moneyline.awayDecimal;
  // A valid response captured BEFORE any mutation — it matches the frozen bundle.
  const validBody = JSON.stringify(makeValidResponse(request, ARM_A, COHORT));

  // A hostile/buggy adapter that mutates the shared build slate mid-dispatch,
  // AFTER preparation has already frozen a private clone.
  let calls = 0;
  const adapter: ProviderAdapter = {
    provider: ARM_A.provider,
    requestedModelId: ARM_A.requestedModelId,
    credentialEnvVar: ARM_A.credentialEnvVar,
    hasCredential: () => true,
    async chat(): Promise<ProviderResponse> {
      calls += 1;
      (build.slateBundle.games[0]!.markets.moneyline as { awayDecimal: number }).awayDecimal = 99;
      return stubResponse(validBody, ARM_A.requestedModelId);
    },
  };

  const env = await runSlate(
    [ARM_A],
    new Map([[ARM_A.participantId, adapter]]),
    build.requests,
    options(),
  );
  assert.equal(calls, 1);
  // The prompt/validation used the frozen bundle: the pre-mutation response validated.
  assert.equal(env.results[0]?.outcome, 'valid');

  // The mutation landed on the mutable build slate...
  assert.equal(build.slateBundle.games[0]?.markets.moneyline.awayDecimal, 99);
  // ...but the frozen dispatch snapshot is untouched.
  assert.equal(env.snapshot.slate.games[0]?.markets.moneyline.awayDecimal, originalAway);

  // Baselines, records, and summary ALL derive from the frozen, branded envelope.
  const ctx = runContext();
  const records = buildRecords(env, ctx, build, NO_COLLISION);
  const summary = buildSummaryMarkdown(env, ctx, build, NO_COLLISION);

  // The away-moneyline baseline and the bundle_game record carry the frozen
  // price, never the mutated 99.
  const awayBaseline = records.find(
    (r) => r['recordType'] === 'baseline_decision' && r['participantId'] === 'baseline-away-ml',
  );
  assert.ok(awayBaseline);
  assert.equal(awayBaseline['observedDecimal'], originalAway);
  const bundleGame = records.find((r) => r['recordType'] === 'bundle_game');
  assert.ok(bundleGame);
  assert.equal((bundleGame['bundle'] as { markets: { moneyline: { awayDecimal: number } } }).markets.moneyline.awayDecimal, originalAway);

  // The whole artifact — records and summary — is internally coherent: the real
  // integrity verifier finds no baseline/price contradictions.
  const violations = verifyRunIntegrity(parseRunRecords(records.map((r) => JSON.stringify(r))), {
    expectedArms: [
      {
        participantId: ARM_A.participantId,
        provider: ARM_A.provider,
        requestedModelId: ARM_A.requestedModelId,
        approvedReportedModelIds: [ARM_A.requestedModelId],
      },
    ],
  });
  assert.deepEqual(violations, []);
  assert.ok(summary.includes(String(originalAway)));
});

// A5: the producers authenticate the branded run envelope. A hand-built
// envelope-shaped object — even with genuine nested pieces or a filtered result
// graph — is rejected before anything is written. (The full A2–A5 producer
// matrix lives in runEnvelope.test.ts; this is the boundary sanity check.)
test('buildRecords rejects a forged (unbranded) run envelope', () => {
  const prepared = prepareGameRequest(makeRequest(CUTOFF));
  const forged = {
    snapshot: {
      prepared: [prepared],
      slate: { ...prepared.requestBundle, games: [{ ...prepared.game, awayTeam: 'HIJACK' }] },
      slateSha256: 'x'.repeat(64),
    },
    results: [],
    expectedArms: [ARM_A.participantId],
    dispatch: {
      cohortId: COHORT,
      executionPolicy: 'fixed-moneyline-total',
      timeoutMs: 600_000,
      maxOutputTokens: 16000,
    },
  } as unknown as RunEnvelope;
  assert.throws(
    () => buildRecords(forged, runContext(), sharedBuild(makeRequest(CUTOFF)), NO_COLLISION),
    /not produced by runSlate/,
  );
});

test('sealDispatch rejects a batch with duplicate game IDs', () => {
  const prepared = prepareGameRequest(makeRequest(CUTOFF));
  assert.throws(() => sealDispatch([prepared, prepared]), /duplicate game ID/);
});

test('sealDispatch rejects a batch that mixes slate metadata', () => {
  const p1 = prepareGameRequest(makeRequest(CUTOFF));
  // A second, individually-valid request carrying a different bundleTimestamp.
  const raw2 = makeRequest(CUTOFF, { gameId: '00000000-0000-4000-8000-00000000t099' });
  raw2.requestBundle.bundleTimestamp = '2026-07-12T14:06:00+00:00';
  raw2.requestSha256 = sha256Hex(canonicalize(raw2.requestBundle));
  const p2 = prepareGameRequest(raw2);
  assert.throws(() => sealDispatch([p1, p2]), /mixes slate metadata/);
});
