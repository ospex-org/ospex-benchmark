import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SPEND_GUARD_PRICE_TABLE_VERSION, modelPriceTableDigest } from './modelPriceTable.js';
import { rebuildUsageRaw, verifySpendSidecar } from './verifySpendSidecar.js';

/**
 * The offline spend-sidecar verifier: exact conservative recomputation (the same integer
 * ceiling arithmetic as the runtime guard, at the CODE-pinned table), fail-closed on price
 * identity / reservation / unpriceable attempts / record tampering, exact `==` boundary at
 * the reservation, the crossing aggregate cap, and the reasoning-token observation.
 * Fixtures are hand-built plain objects — the verifier's real input is parsed JSON.
 */

const V2_DIGEST = modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION);

function attemptOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    participantId: 'anthropic-claude-fable-5',
    provider: 'anthropic',
    requestedModelId: 'claude-fable-5',
    role: 'initial',
    requestAt: '2026-07-18T12:00:31.000Z',
    responseAt: '2026-07-18T12:00:32.000Z',
    usageTokens: { input_tokens: 1512, output_tokens: 498 },
    spendClass: 'price',
    status: 'pass',
    derivedActualUsdMicros: null,
    ...over,
  };
}

/** A google attempt with a REAL nonzero thoughts bucket (satisfies reasoning-observed). */
function googleReasoningAttempt(): Record<string, unknown> {
  return attemptOf({
    participantId: 'google-gemini-3.1-pro-preview',
    provider: 'google',
    requestedModelId: 'gemini-3.1-pro-preview',
    usageTokens: { promptTokenCount: 1465, candidatesTokenCount: 471, thoughtsTokenCount: 305, totalTokenCount: 2241 },
  });
}

function recordOf(attempts: Record<string, unknown>[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sidecarSchemaVersion: 1,
    cohortId: 'c'.repeat(64),
    fireId: 'fire-1',
    runId: 'run-1',
    gameId: '00000000-0000-4000-8000-00000000ffff',
    scopedMarkets: ['moneyline'],
    requestSha256: 'a'.repeat(64),
    reason: null,
    priceVersion: SPEND_GUARD_PRICE_TABLE_VERSION,
    priceTableDigest: V2_DIGEST,
    perAttemptReservationUsdMicros: 100_000_000,
    attempts,
    ...over,
  };
}

function check(verification: ReturnType<typeof verifySpendSidecar>, name: string): { ok: boolean; detail: string } {
  const found = verification.checks.find((c) => c.name === name);
  assert.ok(found, `check ${name} present`);
  return found;
}

test('a clean 4-provider record recomputes to the EXACT conservative per-attempt costs and passes', () => {
  const verification = verifySpendSidecar(
    recordOf([
      attemptOf({
        participantId: 'openai-gpt-5.6-sol',
        provider: 'openai',
        requestedModelId: 'gpt-5.6-sol',
        usageTokens: {
          prompt_tokens: 1500,
          completion_tokens: 500,
          total_tokens: 2000,
          'completion_tokens_details.reasoning_tokens': 200,
        },
      }),
      attemptOf(), // anthropic 1512/498
      googleReasoningAttempt(),
      attemptOf({
        participantId: 'xai-grok-4.5',
        provider: 'xai',
        requestedModelId: 'grok-4.5',
        usageTokens: {
          prompt_tokens: 1500,
          completion_tokens: 400,
          total_tokens: 2000,
          'completion_tokens_details.reasoning_tokens': 100,
        },
      }),
    ]),
  );
  // Hand-computed at the pinned v2 rates (µUSD): openai 1500×12.5 + 500×60; anthropic
  // 1512×10 + 498×50; google 1465×4 + (471+305)×18; xai 1500×4 + (400+100)×12.
  assert.deepEqual(
    verification.attempts.map((a) => a.derivedActualUsdMicros),
    [48_750, 40_020, 19_828, 12_000],
  );
  assert.equal(verification.aggregateUsdMicros, 120_598);
  assert.deepEqual(verification.checks.filter((c) => !c.ok), [], JSON.stringify(verification.checks));
  assert.equal(verification.ok, true);
  // The reasoning observations name BOTH the openai subset field and the google thoughts.
  assert.match(check(verification, 'reasoning-observed').detail, /reasoning_tokens=200/);
  assert.match(check(verification, 'reasoning-observed').detail, /thoughtsTokenCount=305/);
});

test('a non-divisible product rounds UP (ceiling, never floor)', () => {
  const verification = verifySpendSidecar(
    recordOf([
      attemptOf({
        participantId: 'openai-gpt-5.6-sol',
        provider: 'openai',
        requestedModelId: 'gpt-5.6-sol',
        // (1×12_500_000 + 1×60_000_000) / 1e6 = 72.5 → 73, the conservative direction.
        usageTokens: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      googleReasoningAttempt(),
    ]),
  );
  assert.equal(verification.attempts[0]!.derivedActualUsdMicros, 73);
  assert.equal(verification.ok, true);
});

test('the reservation boundary is exact: == passes, one token over breaches (and fails)', () => {
  // 2,000,000 output tokens at $50/Mtok = exactly the $100 reservation.
  const atCap = verifySpendSidecar(
    recordOf([attemptOf({ usageTokens: { input_tokens: 0, output_tokens: 2_000_000 } }), googleReasoningAttempt()]),
  );
  assert.equal(atCap.attempts[0]!.derivedActualUsdMicros, 100_000_000);
  assert.equal(atCap.attempts[0]!.withinReservation, true);
  assert.equal(atCap.ok, true);

  // One more token: 100,000,050 — the record HONESTLY says breach; the within-reservation
  // check is the sole failure (consistency agrees with the recomputation).
  const overCap = verifySpendSidecar(
    recordOf([
      attemptOf({
        usageTokens: { input_tokens: 0, output_tokens: 2_000_001 },
        status: 'breach',
        derivedActualUsdMicros: 100_000_050,
      }),
      googleReasoningAttempt(),
    ]),
  );
  assert.equal(overCap.attempts[0]!.derivedActualUsdMicros, 100_000_050);
  assert.equal(check(overCap, 'attempts-within-reservation').ok, false);
  assert.equal(check(overCap, 'record-consistency').ok, true);
  assert.equal(overCap.ok, false);
});

test('a TAMPERED record — over-cap buckets recorded as pass — fails record-consistency', () => {
  const verification = verifySpendSidecar(
    recordOf([
      attemptOf({ usageTokens: { input_tokens: 0, output_tokens: 2_000_001 } }), // status 'pass' (lie)
      googleReasoningAttempt(),
    ]),
  );
  assert.equal(check(verification, 'record-consistency').ok, false);
  assert.match(check(verification, 'record-consistency').detail, /recorded status pass != recomputed breach/);
  assert.equal(verification.ok, false);
});

test('an unpriceable sent attempt fails: no usage buckets, and an incoherent xai total', () => {
  const noUsage = verifySpendSidecar(
    recordOf([attemptOf({ usageTokens: null, spendClass: 'unknown', status: 'unknown' }), googleReasoningAttempt()]),
  );
  assert.equal(check(noUsage, 'attempts-priceable').ok, false);
  assert.equal(noUsage.aggregateUsdMicros, null, 'no aggregate when an attempt cannot be priced');
  assert.equal(noUsage.ok, false);

  const incoherent = verifySpendSidecar(
    recordOf([
      attemptOf({
        participantId: 'xai-grok-4.5',
        provider: 'xai',
        requestedModelId: 'grok-4.5',
        // total != prompt + completion + reasoning → the arithmetic refuses (UNKNOWN).
        usageTokens: {
          prompt_tokens: 1500,
          completion_tokens: 400,
          total_tokens: 1901,
          'completion_tokens_details.reasoning_tokens': 100,
        },
        status: 'unknown',
        spendClass: 'unknown',
      }),
      googleReasoningAttempt(),
    ]),
  );
  assert.equal(check(incoherent, 'attempts-priceable').ok, false);
  assert.equal(incoherent.ok, false);
});

test('a coherent never-sent attempt is EXEMPT — nothing was billed', () => {
  const verification = verifySpendSidecar(
    recordOf([
      attemptOf({
        participantId: 'xai-grok-4.5',
        provider: 'xai',
        requestedModelId: 'grok-4.5',
        requestAt: null,
        responseAt: null,
        usageTokens: null,
        spendClass: 'zero',
      }),
      googleReasoningAttempt(),
    ]),
  );
  assert.equal(verification.attempts[0]!.unpriced, 'never-sent');
  assert.deepEqual(verification.checks.filter((c) => !c.ok), []);
  assert.equal(verification.ok, true);
});

test('the price identity is recomputed from CODE: a replay-table record and a wrong digest both fail', () => {
  const wrongVersion = verifySpendSidecar(
    recordOf([googleReasoningAttempt()], { priceVersion: 'prices-v1', priceTableDigest: modelPriceTableDigest('prices-v1') }),
  );
  assert.equal(check(wrongVersion, 'price-identity').ok, false);
  assert.equal(wrongVersion.ok, false);

  const wrongDigest = verifySpendSidecar(recordOf([googleReasoningAttempt()], { priceTableDigest: 'f'.repeat(64) }));
  assert.equal(check(wrongDigest, 'price-identity').ok, false);
  assert.equal(wrongDigest.ok, false);
});

test('a reservation off the code policy fails the pin', () => {
  const verification = verifySpendSidecar(
    recordOf([googleReasoningAttempt()], { perAttemptReservationUsdMicros: 99_999_999 }),
  );
  assert.equal(check(verification, 'reservation-pin').ok, false);
  assert.equal(verification.ok, false);
});

test('an aggregate over the crossing cap fails even when every attempt is within the reservation', () => {
  // Nine at-cap attempts: each exactly $100 (within), summing to $900 — over the $800 cap.
  const nine = Array.from({ length: 9 }, (_v, i) =>
    attemptOf({ role: i % 2 === 0 ? 'initial' : 'repair', usageTokens: { input_tokens: 0, output_tokens: 2_000_000 } }),
  );
  const verification = verifySpendSidecar(recordOf([...nine, googleReasoningAttempt()]));
  assert.equal(check(verification, 'attempts-within-reservation').ok, true);
  assert.equal(check(verification, 'aggregate-within-crossing-cap').ok, false);
  assert.equal(verification.aggregateUsdMicros, 900_019_828);
  assert.equal(verification.ok, false);
});

test('a record with NO nonzero reasoning field fails reasoning-observed', () => {
  const verification = verifySpendSidecar(recordOf([attemptOf()]));
  assert.equal(check(verification, 'reasoning-observed').ok, false);
  assert.deepEqual(
    verification.checks.filter((c) => !c.ok).map((c) => c.name),
    ['reasoning-observed'],
    'the reasoning tooth is the sole failure on an otherwise-clean record',
  );
  assert.equal(verification.ok, false);
});

test('shape is STRICT: extra/missing keys, a wrong schema version, empty attempts, and non-objects fail', () => {
  const shapes: readonly [string, unknown][] = [
    ['extra top-level key', { ...recordOf([attemptOf()]), extra: 1 }],
    [
      'missing key',
      (() => {
        const { requestSha256: _dropped, ...rest } = recordOf([attemptOf()]);
        return rest;
      })(),
    ],
    ['wrong schema version', recordOf([attemptOf()], { sidecarSchemaVersion: 2 })],
    ['empty attempts', recordOf([])],
    ['attempt with an extra key', recordOf([{ ...attemptOf(), extra: 1 }])],
    ['null', null],
    ['an array', []],
  ];
  for (const [label, shape] of shapes) {
    const verification = verifySpendSidecar(shape);
    assert.equal(verification.ok, false, label);
    assert.equal(verification.checks[0]!.name, 'shape', label);
    assert.equal(verification.checks[0]!.ok, false, label);
  }
});

test('a known_zero spendClass inside a billable sidecar is incoherent — record-consistency fails', () => {
  const verification = verifySpendSidecar(
    recordOf([attemptOf({ spendClass: 'known_zero' }), googleReasoningAttempt()]),
  );
  assert.equal(check(verification, 'record-consistency').ok, false);
  assert.equal(verification.ok, false);
});

test('rebuildUsageRaw nests dotted paths exactly', () => {
  assert.deepEqual(
    rebuildUsageRaw({
      prompt_tokens: 1500,
      'completion_tokens_details.reasoning_tokens': 5,
      total_tokens: 2000,
    }),
    { prompt_tokens: 1500, completion_tokens_details: { reasoning_tokens: 5 }, total_tokens: 2000 },
  );
});

test('the CLI verifies a durable file: PASS exits 0, FAIL exits 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-sidecar-'));
  const passPath = join(dir, 'pass-spend.json');
  const failPath = join(dir, 'fail-spend.json');
  writeFileSync(passPath, JSON.stringify(recordOf([googleReasoningAttempt()]), null, 2));
  writeFileSync(failPath, JSON.stringify(recordOf([attemptOf()]), null, 2)); // no reasoning observation

  const scriptPath = fileURLToPath(new URL('./verifySpendSidecar.ts', import.meta.url));
  const repoRoot = dirname(dirname(scriptPath));
  const run = (target: string): { status: number | null; out: string } => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, target], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
      input: '',
    });
    return { status: result.status, out: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
  };

  const pass = run(passPath);
  assert.equal(pass.status, 0, pass.out);
  assert.match(pass.out, /VERDICT: PASS/);
  assert.match(pass.out, /thoughtsTokenCount=305/);

  const fail = run(failPath);
  assert.equal(fail.status, 1, fail.out);
  assert.match(fail.out, /VERDICT: FAIL/);
  assert.match(fail.out, /\[FAIL\] reasoning-observed/);
});
