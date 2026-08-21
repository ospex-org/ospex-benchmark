import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BASELINE_POLICY_VERSION, type BaselinePolicyVersion } from './baselines.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { DEPLOYMENT_ROUND, NETWORK } from './config.js';
import { CURRENT_RESPONSE_SCHEMA_VERSION } from './schema.js';
import { isParseableInstant } from './time.js';
import {
  CONFIGURATION_DIGEST_VERSION,
  configurationSha256,
  EMPTY_CONFIGURATION_SHA256,
} from './participantConfiguration.js';
import type { ParticipantConfiguration } from './participantConfiguration.js';
import { runSlate } from './runner.js';
import {
  buildRecords,
  failuresByCode,
  unidentifiedResponsesByArm,
  writeNdjson,
  writeText,
} from './records.js';
import { buildSummaryMarkdown } from './summary.js';
import { fixtureEnvelope, makeRequest, makeValidResponse, TEST_ARM, TEST_COHORT } from './testFactories.js';
import type { BuildResult, GameRequest } from './bundle.js';
import type { RunContext } from './records.js';
import type { RunEnvelope } from './runner.js';
import type {
  ArmGameResult,
  ArmSpec,
  AttemptRecord,
  BenchmarkResponse,
  ChatTurn,
  GameBundle,
  ProviderAdapter,
  ProviderCallOptions,
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
    responseEnvelope: fixtureEnvelope('{}'),
    reportedModelId: null,
    providerResponseId: null,
    httpStatus: 200,
    usage: null,
    usageRaw: null,
    searchAudit: null,
    requestParams: null,
    providerStopReason: null,
    turnCompleted: true,
    requestAt: null,
    responseAt: null,
    acceptedAt: null,
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
    responseEnvelope: fixtureEnvelope(rawText),
    reportedModelId: ids.reportedModelId ?? 'stub-model-1',
    providerResponseId: ids.providerResponseId ?? 'stub-response',
    httpStatus: 200,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    usageRaw: { prompt_tokens: 100, completion_tokens: 50 },
    requestParams: { stub: true },
    searchAudit: null,
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
  baselinePolicyVersion?: BaselinePolicyVersion,
): Promise<RunEnvelope> {
  // The options' five load-bearing fields must equal ctx's, or authenticateRun
  // fails closed (A4). slateDate is derived from the request bundle inside the
  // envelope, and makeCtx().slateDate matches makeRequest()'s bundle date.
  // baselinePolicyVersion is omitted by default → runSlate stamps v0.2.
  return runSlate([TEST_ARM], new Map([[TEST_ARM.participantId, stubAdapter(handlers)]]), build.requests, {
    cohortId: ctx.cohortId,
    timeoutMs: ctx.timeoutMs,
    maxOutputTokens: ctx.maxOutputTokens,
    executionPolicy: ctx.executionPolicy,
    nowMs,
    ...(baselinePolicyVersion !== undefined ? { baselinePolicyVersion } : {}),
  });
}

/**
 * A scoped GameRequest carrying only the named markets (S3), built by re-scoping
 * the full-board factory and RECOMPUTING the request hash so the prepared boundary
 * accepts it. The absent market is an omitted own property. (A shared scope-aware
 * factory is a deferred follow-up; this local helper covers the producer path.)
 */
function scopeRequestTo(present: ReadonlyArray<'moneyline' | 'runLine' | 'total'>): GameRequest {
  const base = makeRequest();
  const full = base.game.markets as Record<string, unknown>;
  const scoped: Record<string, unknown> = {};
  for (const key of present) scoped[key] = full[key];
  const game = { ...base.game, markets: scoped } as unknown as GameBundle;
  const requestBundle = { ...base.requestBundle, games: [game] };
  return { ...base, game, requestBundle, requestSha256: sha256Hex(canonicalize(requestBundle)) };
}

/** A single-request BuildResult around any (full-board or scoped) request. */
function buildFrom(request: GameRequest): BuildResult {
  return {
    slateBundle: { ...request.requestBundle },
    slateSha256: request.requestSha256,
    requests: [request],
    gameHashes: { [request.gameId]: 'a'.repeat(64) },
    excluded: [],
    provenance: { [request.gameId]: { slug: request.slug, oddsRows: [] } },
  };
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

// ---------------------------------------------------------------------------
// S3e-2b: the run's baseline policy version threads from the envelope into the
// producers, so a dynamic cohort's v0.3 lets a SCOPED slate complete end-to-end.
// The default stays v0.2 (full-board byte-identical).
// ---------------------------------------------------------------------------

test('runSlate stamps the baseline policy version on the envelope (default v0.2; explicit v0.3)', async () => {
  const build = makeBuild();
  const ctx = makeCtx();
  const request = build.requests[0]!;
  const dflt = await envFrom(build, ctx, [() => stubResponse(JSON.stringify(makeValidResponse(request)))]);
  assert.equal(dflt.baselinePolicyVersion, BASELINE_POLICY_VERSION);
  assert.equal(dflt.baselinePolicyVersion, 'baselines-v0.2.0');
  const v3 = await envFrom(
    build,
    ctx,
    [() => stubResponse(JSON.stringify(makeValidResponse(request)))],
    undefined,
    'baselines-v0.3.0',
  );
  assert.equal(v3.baselinePolicyVersion, 'baselines-v0.3.0');
});

test('a full-board run under v0.3 derives v0.3-stamped baselines (same set, only the stamp differs)', async () => {
  const build = makeBuild();
  const ctx = makeCtx();
  const request = build.requests[0]!;
  const env = await envFrom(
    build,
    ctx,
    [() => stubResponse(JSON.stringify(makeValidResponse(request)))],
    undefined,
    'baselines-v0.3.0',
  );
  const records = buildRecords(env, ctx, build, { failures: [], warnings: [] });
  const baselines = records.filter((r) => r['recordType'] === 'baseline_decision');
  assert.equal(baselines.length, 8); // full board: 4 moneyline + 2 total + 2 run line
  assert.ok(baselines.every((b) => b['policyVersion'] === 'baselines-v0.3.0'), 'every baseline stamped v0.3');
  const runMeta = records.find((r) => r['recordType'] === 'run_meta')!;
  assert.equal(runMeta['baselinePolicyVersion'], 'baselines-v0.3.0');
});

test('a scoped run completes end-to-end under v0.3 (records + summary), deriving present-market baselines', async () => {
  const request = scopeRequestTo(['moneyline', 'total']); // run line omitted → a 2-market slate
  const build = buildFrom(request);
  const ctx = makeCtx();
  // The stub returns an empty body → invalid_schema (a scope-aware mock that emits
  // a VALID scoped forecast is a deferred follow-up); the point is that the
  // PRODUCERS + deterministic baselines complete on a scoped slate under v0.3.
  const env = await envFrom(build, ctx, [() => stubResponse('{}')], undefined, 'baselines-v0.3.0');
  assert.equal(env.baselinePolicyVersion, 'baselines-v0.3.0');

  const records = buildRecords(env, ctx, build, { failures: [], warnings: [] });
  const baselines = records.filter((r) => r['recordType'] === 'baseline_decision');
  assert.equal(baselines.length, 6); // scoped: 4 moneyline + 2 total, NO run-line pair
  assert.ok(baselines.every((b) => b['policyVersion'] === 'baselines-v0.3.0'));
  assert.ok(!baselines.some((b) => b['market'] === 'spread'), 'no run-line baseline for a scoped board');
  const runMeta = records.find((r) => r['recordType'] === 'run_meta')!;
  assert.equal(runMeta['baselinePolicyVersion'], 'baselines-v0.3.0');

  // buildSummaryMarkdown renders without dereferencing the absent market.
  const summary = buildSummaryMarkdown(env, ctx, build, { failures: [], warnings: [] });
  assert.match(summary, /## Deterministic baselines/);
});

test('a scoped run under the default v0.2 fails closed at the producer (why v0.3 must be threaded)', async () => {
  const request = scopeRequestTo(['moneyline', 'total']);
  const build = buildFrom(request);
  const ctx = makeCtx();
  const env = await envFrom(build, ctx, [() => stubResponse('{}')]); // default → v0.2
  assert.equal(env.baselinePolicyVersion, 'baselines-v0.2.0');
  // v0.2 is full-board-only: deriving baselines on a scoped slate fails closed,
  // which is exactly why a dynamic cohort must thread v0.3.
  assert.throws(
    () => buildRecords(env, ctx, build, { failures: [], warnings: [] }),
    /requires a full three-market board/,
  );
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
    refusedInitialStartAt: null,
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

test('decision records carry the v2 analysis fields and the accepted attempt search audit', async () => {
  const build = makeBuild();
  const ctx = makeCtx();
  const request = build.requests[0];
  assert.ok(request);
  const audit = {
    queries: [{ query: 'brewers pirates injury report' }],
    results: [{ url: 'https://news.example/one', title: 'Injury notes' }],
    searchCount: 1,
    incomplete: [],
  };
  const env = await envFrom(build, ctx, [
    () => ({ ...stubResponse(JSON.stringify(makeValidResponse(request))), searchAudit: audit }),
  ]);
  const records = buildRecords(env, ctx, build, { failures: [], warnings: [] });
  const decisions = records.filter((r) => r['recordType'] === 'decision');
  assert.equal(decisions.length, 3);
  const expected = makeValidResponse(request).games[0]!.forecasts;
  for (const decision of decisions) {
    const forecast = expected.find((f) => f.market === decision['market']);
    assert.ok(forecast);
    // The analysis fields ride the decision record verbatim...
    assert.deepEqual(decision['axes'], forecast.axes);
    assert.equal(decision['primaryAxis'], forecast.primaryAxis);
    assert.equal(decision['primaryExpectation'], forecast.primaryExpectation);
    // ...and the audit trail of what the accepted attempt looked at rides too.
    assert.deepEqual(decision['searchAudit'], audit);
  }
  // The arm_game_response attempt block carries the same audit.
  const armResponse = records.find((r) => r['recordType'] === 'arm_game_response');
  assert.ok(armResponse);
  assert.deepEqual((armResponse['attempt'] as Record<string, unknown>)['searchAudit'], audit);
});

// ---------------------------------------------------------------------------
// The projection stamp and the acceptance instant
//
// Both are what a REPUBLISHED artifact re-derives its identity from, and the
// serving run row is insert-once — a value that is wrong here is permanent, and
// one that is missing drops the write it was supposed to complete. So they are
// asserted against the constants the code reads, not against a re-derivation.
// ---------------------------------------------------------------------------

test('run_meta stamps the projection facts the serving run row freezes', async () => {
  const build = makeBuild();
  const ctx = makeCtx();
  const request = build.requests[0];
  assert.ok(request);
  const env = await envFrom(build, ctx, [
    () => stubResponse(JSON.stringify(makeValidResponse(request))),
  ]);
  const records = buildRecords(env, ctx, build, { failures: [], warnings: [] });
  const runMeta = records.find((r) => r['recordType'] === 'run_meta');
  assert.ok(runMeta);
  const projection = runMeta['projection'] as Record<string, unknown>;
  assert.ok(projection, 'run_meta carries the projection stamp');

  // The frozen literals from config, not a value derived at write time: the
  // whole reason they are stamped is that re-deriving them when republishing
  // (a bumped round, a newer commit) would disagree with the stored row.
  assert.equal(projection['network'], NETWORK);
  assert.equal(projection['deploymentRound'], DEPLOYMENT_ROUND);
  assert.equal(projection['responseSchemaVersion'], CURRENT_RESPONSE_SCHEMA_VERSION);

  // Advisory by construction — null when git cannot be reached — so the shape
  // is asserted rather than a value. `in` rather than a truthiness check: the
  // key must be PRESENT even when the value is null, because the projection
  // reads it off the stamp.
  assert.ok('benchmarkCommit' in projection);
  const commit = projection['benchmarkCommit'];
  assert.ok(
    commit === null || (typeof commit === 'string' && /^[0-9a-f]{40}(-dirty)?$/.test(commit)),
    `benchmarkCommit is a sha or null, got ${JSON.stringify(commit)}`,
  );

  // Enumerated, because adding a field to a stamp that a later write is
  // COMPARED against is a decision someone makes, not one that drifts in.
  assert.deepEqual(Object.keys(projection).sort(), [
    'benchmarkCommit',
    'deploymentRound',
    'network',
    'responseSchemaVersion',
  ]);
});

test('the accepted attempt and every decision it produced carry the same acceptedAt', async () => {
  const build = makeBuild();
  const ctx = makeCtx();
  const request = build.requests[0];
  assert.ok(request);
  const env = await envFrom(build, ctx, [
    () => stubResponse(JSON.stringify(makeValidResponse(request))),
  ]);
  const records = buildRecords(env, ctx, build, { failures: [], warnings: [] });

  const armResponse = records.find((r) => r['recordType'] === 'arm_game_response');
  assert.ok(armResponse);
  const acceptedAt = (armResponse['attempt'] as Record<string, unknown>)['acceptedAt'];
  assert.equal(typeof acceptedAt, 'string');
  assert.ok(isParseableInstant(acceptedAt as string), `${String(acceptedAt)} is an instant`);
  // The INJECTED clock's reading, frozen as a literal: a dry run's timestamps
  // all come from the one synthetic clock (clockMode: 'synthetic-fixture'), so
  // a stamp taken from the wall clock instead would not land here.
  assert.equal(acceptedAt, '2026-07-12T16:14:00.000Z');

  const decisions = records.filter((r) => r['recordType'] === 'decision');
  assert.equal(decisions.length, 3);
  for (const decision of decisions) {
    assert.equal(decision['acceptedAt'], acceptedAt, 'no join needed to know when it committed');
  }
});

test("a repaired decision's acceptedAt is the REPAIR's accept instant, and the initial attempt has none", async () => {
  // The discriminating case: on a first-try success every attempt timestamp on
  // the record is the same instant, so a build reading acceptedAt off the
  // INITIAL attempt would pass the test above. Here the initial attempt was
  // never accepted, so only the repair carries an instant at all.
  const build = makeBuild();
  const ctx = makeCtx();
  const request = build.requests[0];
  assert.ok(request);
  const env = await envFrom(build, ctx, [
    () => stubResponse(wrongEcho(makeValidResponse(request))),
    () => stubResponse(JSON.stringify(makeValidResponse(request))),
  ]);
  assert.equal(env.results[0]?.repairUsed, true);
  const records = buildRecords(env, ctx, build, { failures: [], warnings: [] });

  const armResponse = records.find((r) => r['recordType'] === 'arm_game_response');
  assert.ok(armResponse);
  const initial = armResponse['attempt'] as Record<string, unknown>;
  const repair = armResponse['repair'] as Record<string, unknown>;
  assert.equal(initial['acceptedAt'], null, 'a response that failed validation was not accepted');
  assert.equal(repair['acceptedAt'], '2026-07-12T16:14:00.000Z');
  assert.ok(isParseableInstant(repair['acceptedAt'] as string));

  const decisions = records.filter((r) => r['recordType'] === 'decision');
  assert.equal(decisions.length, 3);
  for (const decision of decisions) {
    assert.equal(decision['acceptedAt'], repair['acceptedAt']);
    assert.notEqual(decision['acceptedAt'], initial['acceptedAt']);
  }
});

// ---------------------------------------------------------------------------
// The arm-roster stamp
// ---------------------------------------------------------------------------

const CONFIGURED_ARM: ArmSpec = { ...TEST_ARM, configuration: { reasoning: { effort: 'high' } } };

/**
 * Dispatches an arm that declares a real configuration, and CAPTURES the call
 * options the runner passed. Capturing is the point: asserting against a value
 * the test itself handed in would only prove the code copies.
 */
async function envFromConfigured(
  build: BuildResult,
  ctx: RunContext,
  handlers: ChatHandler[],
): Promise<{ env: RunEnvelope; sent: Array<ProviderCallOptions | undefined> }> {
  const sent: Array<ProviderCallOptions | undefined> = [];
  let index = 0;
  const adapter: ProviderAdapter = {
    provider: CONFIGURED_ARM.provider,
    requestedModelId: CONFIGURED_ARM.requestedModelId,
    credentialEnvVar: CONFIGURED_ARM.credentialEnvVar,
    hasCredential: () => true,
    async chat(_turns: ChatTurn[], _timeoutMs: number, options?: ProviderCallOptions) {
      sent.push(options);
      const handler = handlers[index];
      index += 1;
      if (!handler) throw new Error('stub adapter: no handler for this call');
      return handler();
    },
  };
  const env = await runSlate(
    [CONFIGURED_ARM],
    new Map([[CONFIGURED_ARM.participantId, adapter]]),
    build.requests,
    {
      cohortId: ctx.cohortId,
      timeoutMs: ctx.timeoutMs,
      maxOutputTokens: ctx.maxOutputTokens,
      executionPolicy: ctx.executionPolicy,
      nowMs: () => CUTOFF_MS - 60_000,
    },
  );
  return { env, sent };
}

test('run_meta stamps the arm roster, and every arm row carries its digest', async () => {
  const request = makeRequest();
  const build = buildFrom(request);
  const ctx = makeCtx();
  const env = await envFrom(build, ctx, [
    () => stubResponse(JSON.stringify(makeValidResponse(request))),
  ]);
  const records = buildRecords(env, ctx, build, { failures: [], warnings: [] });

  const runMeta = records.find((r) => r['recordType'] === 'run_meta')!;
  const roster = runMeta['armRoster'] as Array<Record<string, unknown>>;
  assert.deepEqual(
    roster.map((entry) => entry['participantId']),
    [...env.expectedArms],
    'the stamp is the dispatched roster, in its order',
  );

  for (const entry of roster) {
    // The digest must RECOMPUTE from the configuration beside it — the exact
    // property the scorer re-checks. Asserting a literal would also pass on a
    // build that stamped a constant.
    assert.equal(
      entry['configurationSha256'],
      configurationSha256(entry['configuration'] as ParticipantConfiguration),
    );
    assert.equal(entry['configurationDigestVersion'], CONFIGURATION_DIGEST_VERSION);
    assert.deepEqual(Object.keys(entry).sort(), [
      'configuration',
      'configurationDigestVersion',
      'configurationSha256',
      'participantId',
      'provider',
      'requestedModelId',
    ]);
  }

  const digestByArm = new Map(roster.map((e) => [e['participantId'], e['configurationSha256']]));
  const armRows = records.filter((r) => r['recordType'] === 'arm_game_response');
  assert.ok(armRows.length > 0);
  for (const row of armRows) {
    assert.equal(row['configurationSha256'], digestByArm.get(row['participantId']));
  }
  const decisions = records.filter((r) => r['recordType'] === 'decision');
  assert.ok(decisions.length > 0);
  for (const decision of decisions) {
    assert.equal(decision['configurationSha256'], digestByArm.get(decision['participantId']));
  }
});

test('the stamp carries the configuration the arm ran, and the runner sent it', async () => {
  // The discriminating case. The default fixture arm declares `{}`, so a build
  // that stamped a hardcoded empty configuration — or dropped the field
  // entirely — would pass the test above. This one declares a real setting,
  // so only the true value satisfies it.
  const request = makeRequest();
  const build = buildFrom(request);
  const ctx = makeCtx();
  const { env, sent } = await envFromConfigured(build, ctx, [
    () => stubResponse(JSON.stringify(makeValidResponse(request, CONFIGURED_ARM))),
  ]);
  const records = buildRecords(env, ctx, build, { failures: [], warnings: [] });
  const runMeta = records.find((r) => r['recordType'] === 'run_meta')!;
  const entry = (runMeta['armRoster'] as Array<Record<string, unknown>>)[0]!;

  assert.deepEqual(entry['configuration'], { reasoning: { effort: 'high' } });
  assert.equal(entry['configurationSha256'], configurationSha256({ reasoning: { effort: 'high' } }));
  assert.notEqual(entry['configurationSha256'], EMPTY_CONFIGURATION_SHA256);

  // And it reached the adapter. Captured from the call the runner made, not
  // read back from the value this test supplied.
  assert.ok(sent.length > 0, 'the arm was dispatched');
  for (const options of sent) {
    assert.deepEqual(
      options?.configuration,
      { reasoning: { effort: 'high' } },
      'every leg carries the entrant configuration',
    );
  }
});
