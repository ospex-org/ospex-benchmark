import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PreparedRequestError, prepareGameRequest } from './preparedRequest.js';
import { buildRecords } from './records.js';
import type { RunContext } from './records.js';
import { runSlate, sealDispatch } from './runner.js';
import type { RunEnvelope } from './runner.js';
import { parseRunRecords, verifyRunIntegrity } from './scoring.js';
import { buildSummaryMarkdown } from './summary.js';
import { makeRequest, makeValidResponse } from './testFactories.js';
import type { BuildResult, GameRequest } from './bundle.js';
import type { PreparedGameRequest } from './preparedRequest.js';
import type { ArmSpec, ProviderAdapter, ProviderResponse } from './types.js';

/**
 * SPEC-artifact-producer.md A1–A6: the sealed, branded run envelope. runSlate is
 * the single producer; the artifact builders authenticate it and derive the five
 * load-bearing context fields from it. Every test drives real code — a forged or
 * mutated envelope is exercised against the actual guards.
 */

const CUTOFF = '2026-07-12T16:15:00+00:00';
const CUTOFF_MS = Date.parse(CUTOFF);
const COHORT = 'run-envelope-cohort';
const ID_A = '00000000-0000-4000-8000-00000000t001';
const ID_B = '00000000-0000-4000-8000-00000000t088';
const NO_COLLISION = { failures: [], warnings: [] };

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

function stubResponse(rawText: string, reportedModelId: string): ProviderResponse {
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

function stubAdapter(
  arm: ArmSpec,
  handlers: Array<() => ProviderResponse>,
): { adapter: ProviderAdapter; calls: () => number } {
  let index = 0;
  let calls = 0;
  const adapter: ProviderAdapter = {
    provider: arm.provider,
    requestedModelId: arm.requestedModelId,
    credentialEnvVar: arm.credentialEnvVar,
    hasCredential: () => true,
    async chat(): Promise<ProviderResponse> {
      calls += 1;
      const handler = handlers[index];
      index += 1;
      if (!handler) throw new Error(`stub adapter for ${arm.participantId}: no handler`);
      return handler();
    },
  };
  return { adapter, calls: () => calls };
}

function baseOptions(nowMs: () => number = () => CUTOFF_MS - 60_000) {
  return {
    cohortId: COHORT,
    timeoutMs: 600_000,
    maxOutputTokens: 16000,
    executionPolicy: 'fixed-moneyline-total' as const,
    nowMs,
  };
}

function buildFor(requests: GameRequest[]): BuildResult {
  const first = requests[0]!;
  return {
    slateBundle: first.requestBundle,
    slateSha256: first.requestSha256,
    requests,
    gameHashes: Object.fromEntries(requests.map((r) => [r.gameId, 'a'.repeat(64)])),
    excluded: [],
    provenance: Object.fromEntries(requests.map((r) => [r.gameId, { slug: r.slug, oddsRows: [] }])),
  };
}

/** A valid one-arm, one-game run through the real dispatch path. */
async function validEnv(arm: ArmSpec = ARM_A, gameId: string = ID_A): Promise<{
  env: RunEnvelope;
  build: BuildResult;
}> {
  const request = makeRequest(CUTOFF, { gameId });
  const { adapter } = stubAdapter(arm, [
    () => stubResponse(JSON.stringify(makeValidResponse(request, arm, COHORT)), arm.requestedModelId),
  ]);
  const env = await runSlate([arm], new Map([[arm.participantId, adapter]]), [request], baseOptions());
  return { env, build: buildFor([request]) };
}

function ctxMatching(env: RunEnvelope): RunContext {
  return {
    runId: 'run-envelope-test',
    cohortId: env.dispatch.cohortId,
    mode: 'dry-run',
    slateDate: env.snapshot.slate.slateDate,
    createdAt: '2026-07-12T14:07:00.000Z',
    executionPolicy: env.dispatch.executionPolicy,
    timeoutMs: env.dispatch.timeoutMs,
    maxOutputTokens: env.dispatch.maxOutputTokens,
    fetchStartedAt: '2026-07-12T14:05:00+00:00',
    fetchCompletedAt: '2026-07-12T14:05:00+00:00',
    clockMode: 'synthetic-fixture',
  };
}

// --- A1: single-read batch capture -----------------------------------------

test('A1: sealDispatch seals from a single-read copy of an accessor-backed batch', () => {
  const pA = prepareGameRequest(makeRequest(CUTOFF, { gameId: ID_A }));
  const pB = prepareGameRequest(makeRequest(CUTOFF, { gameId: ID_B }));
  let reads = 0;
  const accessorBatch = new Array<PreparedGameRequest>(1);
  Object.defineProperty(accessorBatch, 0, {
    get() {
      reads += 1;
      return reads === 1 ? pA : pB; // genuine t001 first, a DIFFERENT game after
    },
    enumerable: true,
    configurable: true,
  });
  const snapshot = sealDispatch(accessorBatch);
  // The whole snapshot derives from the single captured value (t001): validation
  // and slate construction cannot disagree the way the accessor tried to force.
  assert.equal(reads, 1);
  assert.equal(snapshot.prepared[0]?.gameId, ID_A);
  assert.equal(snapshot.slate.games[0]?.gameId, ID_A);
  assert.equal(snapshot.prepared[0]?.gameId, snapshot.slate.games[0]?.gameId);
});

test('A1: sealDispatch rejects a forged element before reading any of its fields', () => {
  const forged = new Proxy(
    {},
    {
      get() {
        throw new Error('a field was read before the origin guard rejected the request');
      },
    },
  ) as unknown as PreparedGameRequest;
  assert.throws(
    () => sealDispatch([forged]),
    (err: unknown) => {
      // The prepared-origin guard (a WeakSet membership test) fires first — it
      // reads no property, so the proxy's "field was read" trap never triggers.
      assert.ok(err instanceof PreparedRequestError);
      assert.ok(!(err as Error).message.includes('a field was read'));
      return true;
    },
  );
});

// --- A2: deep immutability --------------------------------------------------

test('A2: runSlate returns a deeply-frozen envelope graph', async () => {
  const { env } = await validEnv();
  assert.ok(Object.isFrozen(env));
  assert.ok(Object.isFrozen(env.results));
  assert.ok(Object.isFrozen(env.results[0]));
  assert.ok(Object.isFrozen(env.results[0]?.attempt));
  assert.throws(() => {
    (env.results[0]!.attempt as { rawText: string | null }).rawText = 'tampered';
  });
  assert.throws(() => {
    (env.results[0] as { outcome: string }).outcome = 'valid';
  });
  // Deeper leaves the spec §6 A2 row names explicitly (a nested usage / parsed
  // field) are frozen too — deepFreeze reaches the whole graph, not just two levels.
  const attempt0 = env.results[0]!.attempt;
  assert.ok(attempt0.usage && Object.isFrozen(attempt0.usage));
  assert.throws(() => {
    (attempt0.usage as { inputTokens: number | null }).inputTokens = -1;
  });
  const parsed0 = env.results[0]!.parsed;
  assert.ok(parsed0 && Object.isFrozen(parsed0));
  assert.throws(() => {
    (parsed0 as unknown as { cohortId: string }).cohortId = 'tampered';
  });
});

// --- A3: unique, complete-by-construction grid ------------------------------

test('A3: a duplicate roster participantId is rejected before any provider call', async () => {
  const request = makeRequest(CUTOFF, { gameId: ID_A });
  const { adapter, calls } = stubAdapter(ARM_A, [
    () => stubResponse(JSON.stringify(makeValidResponse(request, ARM_A, COHORT)), ARM_A.requestedModelId),
  ]);
  await assert.rejects(
    runSlate([ARM_A, ARM_A], new Map([[ARM_A.participantId, adapter]]), [request], baseOptions()),
    /duplicate participantId in the dispatch roster/,
  );
  assert.equal(calls(), 0);
});

test('A3: a genuinely-configured subset run is honest (expectedArms = the dispatched roster)', async () => {
  const { env } = await validEnv();
  assert.deepEqual([...env.expectedArms], ['arm-a']);
  assert.equal(env.results.length, 1); // one arm x one game, complete by construction
});

// --- A4: bound load-bearing context -----------------------------------------

test('A4: a RunContext disagreeing on any of the five bound fields fails closed', async () => {
  const { env, build } = await validEnv();
  const base = ctxMatching(env);
  // The matching context produces the artifact.
  assert.ok(buildRecords(env, base, build, NO_COLLISION).length > 0);

  const mutations: Array<[string, RunContext]> = [
    ['slateDate', { ...base, slateDate: '2099-01-01' }],
    ['cohortId', { ...base, cohortId: 'substituted-cohort' }],
    ['executionPolicy', { ...base, executionPolicy: 'model-choice-side-total' as unknown as RunContext['executionPolicy'] }],
    ['timeoutMs', { ...base, timeoutMs: base.timeoutMs + 1 }],
    ['maxOutputTokens', { ...base, maxOutputTokens: base.maxOutputTokens + 1 }],
  ];
  for (const [field, ctx] of mutations) {
    assert.throws(
      () => buildRecords(env, ctx, build, NO_COLLISION),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /run context disagrees with the sealed run envelope on/);
        assert.ok(err.message.includes(field), `message should name ${field}`);
        return true;
      },
    );
  }
});

// --- A5: whole-envelope authentication --------------------------------------

test('A5: both producers reject a forged (unbranded) envelope wrapper', async () => {
  const { env, build } = await validEnv();
  const ctx = ctxMatching(env);
  // A hand-built wrapper around the genuine nested pieces — never branded by runSlate.
  const forged = {
    snapshot: env.snapshot,
    results: env.results,
    expectedArms: env.expectedArms,
    dispatch: { ...env.dispatch },
  } as unknown as RunEnvelope;
  assert.throws(() => buildRecords(forged, ctx, build, NO_COLLISION), /not produced by runSlate/);
  assert.throws(() => buildSummaryMarkdown(forged, ctx, build, NO_COLLISION), /not produced by runSlate/);
});

// --- A6: byte-compatible output across both producers -----------------------

// The "byte-identical to pre-S1d main" half of A6 is proven by a main-vs-branch
// worktree diff of the full smoke:dry artifact at PR time. This in-suite test
// pins the other half: both producers are deterministic and internally valid.
async function produceA6(): Promise<{ recordsJson: string; summary: string }> {
  const requests = [
    makeRequest(CUTOFF, { gameId: ID_A }),
    makeRequest(CUTOFF, { gameId: ID_B }),
  ];
  const arms = [ARM_A, ARM_B];
  const adapters = new Map<string, ProviderAdapter>();
  for (const arm of arms) {
    // Dispatch order == requests order, so handler i answers game i.
    const handlers = requests.map(
      (req) => () => stubResponse(JSON.stringify(makeValidResponse(req, arm, COHORT)), arm.requestedModelId),
    );
    adapters.set(arm.participantId, stubAdapter(arm, handlers).adapter);
  }
  const env = await runSlate(arms, adapters, requests, baseOptions());
  const build = buildFor(requests);
  const ctx: RunContext = {
    runId: 'a6-fixed-run',
    cohortId: COHORT,
    mode: 'dry-run',
    slateDate: env.snapshot.slate.slateDate,
    createdAt: '2026-07-12T14:07:00.000Z',
    executionPolicy: 'fixed-moneyline-total',
    timeoutMs: 600_000,
    maxOutputTokens: 16000,
    fetchStartedAt: '2026-07-12T14:05:00+00:00',
    fetchCompletedAt: '2026-07-12T14:05:00+00:00',
    clockMode: 'synthetic-fixture',
  };
  const records = buildRecords(env, ctx, build, NO_COLLISION);
  const summary = buildSummaryMarkdown(env, ctx, build, NO_COLLISION);
  return { recordsJson: records.map((r) => JSON.stringify(r)).join('\n'), summary };
}

test('A6: the full artifact is deterministic and passes verifyRunIntegrity', async () => {
  const first = await produceA6();
  const second = await produceA6();
  // Both producers are byte-stable across independent runs (runId/createdAt are
  // fixed sentinels, so nothing volatile remains to normalize).
  assert.equal(first.recordsJson, second.recordsJson);
  assert.equal(first.summary, second.summary);

  // The record sequence carries every governed record type, and the summary is real.
  const parsed = first.recordsJson.split('\n').map((line) => JSON.parse(line) as { recordType: string });
  const types = new Set(parsed.map((r) => r.recordType));
  for (const t of ['run_meta', 'bundle_game', 'baseline_decision', 'arm_game_response', 'decision']) {
    assert.ok(types.has(t), `missing record type ${t}`);
  }
  assert.ok(first.summary.length > 0);

  // The produced artifact is internally consistent to the real integrity verifier.
  const violations = verifyRunIntegrity(parseRunRecords(first.recordsJson.split('\n')), {
    expectedArms: [ARM_A, ARM_B].map((arm) => ({
      participantId: arm.participantId,
      provider: arm.provider,
      requestedModelId: arm.requestedModelId,
      approvedReportedModelIds: [arm.requestedModelId],
    })),
  });
  assert.deepEqual(violations, []);
});
