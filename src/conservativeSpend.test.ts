import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConservativeSpendUnknownError,
  PROVIDER_BY_MODEL,
  ceilDivUsdMicros,
  deriveConservativeActualUsdMicros,
} from './conservativeSpend.js';
import { MODEL_PRICE_TABLE_VERSION, SPEND_GUARD_PRICE_TABLE_VERSION } from './modelPriceTable.js';
import { ARMS } from './providers/index.js';
import type { ProviderName } from './types.js';

/**
 * Conservative derived-actual arithmetic tests. The helper is the money guard's core: it
 * must count EVERY billable token (an undercount silently defeats the hard-stop), price
 * per-provider semantics correctly (OpenAI subset vs xAI/Google additive vs Anthropic cache),
 * round UP, and fail closed to a typed UNKNOWN on any ambiguity — never a sentinel 0.
 */

const V2 = SPEND_GUARD_PRICE_TABLE_VERSION; // 'prices-v2' — the conservative guard table ($10/$45, $10/$50, $4/$18, $4/$12)
const V1 = MODEL_PRICE_TABLE_VERSION; // 'prices-v1' — the cheaper base table

// ── Exact per-provider correctness at prices-v2 ────────────────────────────────

test('openai: prices prompt·$12.50 + completion·$60; reasoning is a SUBSET, never added again', () => {
  // 1490·12.5 + 512·60 = 18,625 + 30,720 = 49,345 micros. Adding reasoning (768·60) would give 64,705.
  const cost = deriveConservativeActualUsdMicros({
    provider: 'openai',
    requestedModelId: 'gpt-5.6-sol',
    priceVersion: V2,
    usageRaw: {
      prompt_tokens: 1490,
      completion_tokens: 512,
      total_tokens: 2002,
      completion_tokens_details: { reasoning_tokens: 256 },
    },
  });
  assert.equal(cost, 49_345);
  assert.notEqual(cost, 64_705); // double-counting reasoning would land here
});

test('xai: reasoning is ADDITIVE — prompt·$4 + (completion + reasoning)·$12', () => {
  // 1000·4 + (200+100)·12 = 4,000 + 3,600 = 7,600 micros. Treating reasoning as a subset gives 6,400.
  const cost = deriveConservativeActualUsdMicros({
    provider: 'xai',
    requestedModelId: 'grok-4.5',
    priceVersion: V2,
    usageRaw: {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1300,
      completion_tokens_details: { reasoning_tokens: 100 },
    },
  });
  assert.equal(cost, 7_600);
  assert.notEqual(cost, 6_400); // dropping xAI reasoning would land here (the undercount Hermes flagged)
});

test('anthropic: input·$10 + output·$50; cache_creation at the OUTPUT rate, cache_read at the INPUT rate (both additive)', () => {
  // No cache: 1512·10 + 498·50 = 15,120 + 24,900 = 40,020.
  assert.equal(
    deriveConservativeActualUsdMicros({
      provider: 'anthropic',
      requestedModelId: 'claude-fable-5',
      priceVersion: V2,
      usageRaw: { input_tokens: 1512, output_tokens: 498 },
    }),
    40_020,
  );
  // With cache: input-rate=(1000+300 read)=1300·10; output-rate=(500+200 creation)=700·50 => 13,000 + 35,000 = 48,000.
  // Pricing cache_creation at the INPUT rate instead would give 40,000 (an undercount).
  const cost = deriveConservativeActualUsdMicros({
    provider: 'anthropic',
    requestedModelId: 'claude-fable-5',
    priceVersion: V2,
    usageRaw: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 300,
    },
  });
  assert.equal(cost, 48_000);
  assert.notEqual(cost, 40_000); // cache_creation at input rate would land here
});

test('google: thoughtsTokenCount is a SEPARATE additive bucket — prompt·$4 + (candidates + thoughts)·$18', () => {
  // 1465·4 + (471+305)·18 = 5,860 + 13,968 = 19,828. Dropping thoughts gives 14,338.
  const withThoughts = deriveConservativeActualUsdMicros({
    provider: 'google',
    requestedModelId: 'gemini-3.1-pro-preview',
    priceVersion: V2,
    usageRaw: { promptTokenCount: 1465, candidatesTokenCount: 471, thoughtsTokenCount: 305, totalTokenCount: 2241 },
  });
  assert.equal(withThoughts, 19_828);
  assert.notEqual(withThoughts, 14_338); // dropping thoughtsTokenCount would land here

  // Strictly-higher: the same shape with thoughts zeroed prices strictly less.
  const withoutThoughts = deriveConservativeActualUsdMicros({
    provider: 'google',
    requestedModelId: 'gemini-3.1-pro-preview',
    priceVersion: V2,
    usageRaw: { promptTokenCount: 1465, candidatesTokenCount: 471, thoughtsTokenCount: 0, totalTokenCount: 1936 },
  });
  assert.equal(withoutThoughts, 14_338);
  assert.ok(withThoughts > withoutThoughts, 'nonzero thoughts must price strictly higher');
});

// ── Total-consistency: an inconsistent reported total is UNKNOWN ────────────────

test('total-consistency: a reported total that disagrees with the reconstructed sum is UNKNOWN', () => {
  // openai total must equal prompt + completion.
  assert.throws(
    () =>
      deriveConservativeActualUsdMicros({
        provider: 'openai',
        requestedModelId: 'gpt-5.6-sol',
        priceVersion: V2,
        usageRaw: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 999 },
      }),
    ConservativeSpendUnknownError,
  );
  // xai total must equal prompt + completion + reasoning (a hidden reasoning bucket must not slip through as consistent).
  assert.throws(
    () =>
      deriveConservativeActualUsdMicros({
        provider: 'xai',
        requestedModelId: 'grok-4.5',
        priceVersion: V2,
        usageRaw: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1300, completion_tokens_details: { reasoning_tokens: 50 } },
      }),
    ConservativeSpendUnknownError, // 1000+200+50 = 1250 != 1300
  );
  // google total must equal prompt + candidates + thoughts.
  assert.throws(
    () =>
      deriveConservativeActualUsdMicros({
        provider: 'google',
        requestedModelId: 'gemini-3.1-pro-preview',
        priceVersion: V2,
        usageRaw: { promptTokenCount: 1465, candidatesTokenCount: 471, thoughtsTokenCount: 305, totalTokenCount: 2000 },
      }),
    ConservativeSpendUnknownError,
  );
  // An ABSENT total is fine (not an inconsistency).
  assert.equal(
    deriveConservativeActualUsdMicros({
      provider: 'openai',
      requestedModelId: 'gpt-5.6-sol',
      priceVersion: V2,
      usageRaw: { prompt_tokens: 1490, completion_tokens: 512 },
    }),
    49_345,
  );
});

// ── Ceiling division rounds UP (conservative) ──────────────────────────────────

test('ceilDivUsdMicros rounds a non-divisible numerator UP (floor would under-report)', () => {
  assert.equal(ceilDivUsdMicros(0n), 0n);
  assert.equal(ceilDivUsdMicros(1n), 1n); // 1 micro of numerator rounds up to 1
  assert.equal(ceilDivUsdMicros(1_000_000n), 1n);
  assert.equal(ceilDivUsdMicros(1_000_001n), 2n); // floor division would give 1n
  assert.equal(ceilDivUsdMicros(2_500_001n), 3n); // floor would give 2n
});

// ── Price identity: the passed version actually drives the rate ─────────────────

test('the pinned price VERSION drives the rate — prices-v1 is cheaper than the prices-v2 guard table', () => {
  const shape = { prompt_tokens: 1490, completion_tokens: 512, total_tokens: 2002 } as const;
  const v1 = deriveConservativeActualUsdMicros({ provider: 'openai', requestedModelId: 'gpt-5.6-sol', priceVersion: V1, usageRaw: { ...shape } });
  const v2 = deriveConservativeActualUsdMicros({ provider: 'openai', requestedModelId: 'gpt-5.6-sol', priceVersion: V2, usageRaw: { ...shape } });
  assert.equal(v1, 22_810); // 1490·5 + 512·30
  assert.equal(v2, 49_345); // 1490·12.5 + 512·60
  assert.ok(v2 > v1, 'the guard version (prices-v2) must never price below prices-v1');
});

// ── Fail-closed edges: every ambiguity throws a typed UNKNOWN (never a sentinel 0) ──

test('fail-closed: unknown provider / unpriced model / unknown version all throw a typed UNKNOWN', () => {
  const validOpenai = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  assert.throws(
    () => deriveConservativeActualUsdMicros({ provider: 'bedrock' as ProviderName, requestedModelId: 'gpt-5.6-sol', priceVersion: V2, usageRaw: validOpenai }),
    ConservativeSpendUnknownError,
  );
  assert.throws(
    () => deriveConservativeActualUsdMicros({ provider: 'openai', requestedModelId: 'not-a-real-model', priceVersion: V2, usageRaw: validOpenai }),
    ConservativeSpendUnknownError,
  );
  assert.throws(
    () => deriveConservativeActualUsdMicros({ provider: 'openai', requestedModelId: 'gpt-5.6-sol', priceVersion: 'prices-v3', usageRaw: validOpenai }),
    ConservativeSpendUnknownError,
  );
});

test('fail-closed: a non-object usageRaw (null, array, number) throws', () => {
  for (const bad of [null, undefined, 42, 'x', [1, 2, 3], [], true]) {
    assert.throws(
      () => deriveConservativeActualUsdMicros({ provider: 'openai', requestedModelId: 'gpt-5.6-sol', priceVersion: V2, usageRaw: bad }),
      ConservativeSpendUnknownError,
      `usageRaw=${String(bad)} should throw`,
    );
  }
});

test('fail-closed: a missing required per-provider field throws (an inherited key does NOT satisfy it)', () => {
  // Missing prompt_tokens entirely.
  assert.throws(
    () => deriveConservativeActualUsdMicros({ provider: 'openai', requestedModelId: 'gpt-5.6-sol', priceVersion: V2, usageRaw: { completion_tokens: 5 } }),
    ConservativeSpendUnknownError,
  );
  // prompt_tokens present only on the PROTOTYPE — own-key check must reject it.
  const inherited = Object.create({ prompt_tokens: 100 }) as Record<string, unknown>;
  inherited['completion_tokens'] = 5;
  assert.throws(
    () => deriveConservativeActualUsdMicros({ provider: 'openai', requestedModelId: 'gpt-5.6-sol', priceVersion: V2, usageRaw: inherited }),
    ConservativeSpendUnknownError,
  );
});

test('fail-closed: out-of-domain token counts (negative, non-integer, NaN, Infinity) throw', () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '10']) {
    assert.throws(
      () =>
        deriveConservativeActualUsdMicros({
          provider: 'openai',
          requestedModelId: 'gpt-5.6-sol',
          priceVersion: V2,
          usageRaw: { prompt_tokens: bad as unknown as number, completion_tokens: 0 },
        }),
      ConservativeSpendUnknownError,
      `prompt_tokens=${String(bad)} should throw`,
    );
  }
});

test('fail-closed: a present-but-non-object nested details field throws', () => {
  assert.throws(
    () =>
      deriveConservativeActualUsdMicros({
        provider: 'xai',
        requestedModelId: 'grok-4.5',
        priceVersion: V2,
        usageRaw: { prompt_tokens: 100, completion_tokens: 10, completion_tokens_details: 'oops' },
      }),
    ConservativeSpendUnknownError,
  );
});

test('fail-closed: a derived spend exceeding Number.MAX_SAFE_INTEGER throws rather than losing precision', () => {
  // 1e15 prompt tokens is a valid safe integer, but ×$10/M → 1e16 USD-micros > MAX_SAFE_INTEGER.
  assert.throws(
    () =>
      deriveConservativeActualUsdMicros({
        provider: 'openai',
        requestedModelId: 'gpt-5.6-sol',
        priceVersion: V2,
        usageRaw: { prompt_tokens: 1_000_000_000_000_000, completion_tokens: 0 },
      }),
    ConservativeSpendUnknownError,
  );
});

test('every provider path prices its own realistic shape without throwing', () => {
  const cases: Array<{ provider: ProviderName; requestedModelId: string; usageRaw: Record<string, unknown> }> = [
    { provider: 'openai', requestedModelId: 'gpt-5.6-sol', usageRaw: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
    { provider: 'anthropic', requestedModelId: 'claude-fable-5', usageRaw: { input_tokens: 100, output_tokens: 20 } },
    { provider: 'google', requestedModelId: 'gemini-3.1-pro-preview', usageRaw: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 125 } },
    { provider: 'xai', requestedModelId: 'grok-4.5', usageRaw: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 130, completion_tokens_details: { reasoning_tokens: 10 } } },
  ];
  for (const c of cases) {
    const cost = deriveConservativeActualUsdMicros({ provider: c.provider, requestedModelId: c.requestedModelId, priceVersion: V2, usageRaw: c.usageRaw });
    assert.ok(Number.isSafeInteger(cost) && cost > 0, `${c.provider} produced ${cost}`);
  }
});

test('fail-closed: EVERY provider throws when ITS required token field is absent (not just openai prompt_tokens)', () => {
  // A required→optional slip on ANY provider's field defaults it to 0 (an undercount); each must throw.
  const cases: Array<{ provider: ProviderName; requestedModelId: string; usageRaw: Record<string, unknown> }> = [
    { provider: 'anthropic', requestedModelId: 'claude-fable-5', usageRaw: { output_tokens: 498 } }, // input_tokens absent
    { provider: 'anthropic', requestedModelId: 'claude-fable-5', usageRaw: { input_tokens: 1512 } }, // output_tokens absent
    { provider: 'openai', requestedModelId: 'gpt-5.6-sol', usageRaw: { prompt_tokens: 100 } }, // completion_tokens absent
    { provider: 'google', requestedModelId: 'gemini-3.1-pro-preview', usageRaw: { promptTokenCount: 100 } }, // candidatesTokenCount absent
    { provider: 'xai', requestedModelId: 'grok-4.5', usageRaw: { prompt_tokens: 1000, completion_tokens_details: { reasoning_tokens: 100 } } }, // completion_tokens absent
  ];
  for (const c of cases) {
    assert.throws(
      () => deriveConservativeActualUsdMicros({ provider: c.provider, requestedModelId: c.requestedModelId, priceVersion: V2, usageRaw: c.usageRaw }),
      ConservativeSpendUnknownError,
      `${c.provider} with a missing required field should throw`,
    );
  }
});

test('additive bucket absent but a corroborating total proves it zero — prices successfully (not UNKNOWN)', () => {
  // A non-thinking response may omit the additive field IF a present total proves it was zero;
  // that case must still price (a required→optional flip that over-escalates it would red here).
  // google without thoughtsTokenCount but total 120 == 100 + 20 + 0: 100·$4 + 20·$18 = 760.
  assert.equal(
    deriveConservativeActualUsdMicros({
      provider: 'google',
      requestedModelId: 'gemini-3.1-pro-preview',
      priceVersion: V2,
      usageRaw: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
    }),
    760,
  );
  // xai without completion_tokens_details but total 120 == 100 + 20 + 0: 100·$4 + 20·$12 = 640.
  assert.equal(
    deriveConservativeActualUsdMicros({
      provider: 'xai',
      requestedModelId: 'grok-4.5',
      priceVersion: V2,
      usageRaw: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }),
    640,
  );
});

test('xAI/Google: an absent additive bucket WITHOUT a corroborating total is UNKNOWN (never assumed zero)', () => {
  // xAI: no reasoning_tokens AND no total_tokens → cannot rule out unreported (cost-dominant) reasoning.
  assert.throws(
    () => deriveConservativeActualUsdMicros({ provider: 'xai', requestedModelId: 'grok-4.5', priceVersion: V2, usageRaw: { prompt_tokens: 100, completion_tokens: 20 } }),
    ConservativeSpendUnknownError,
  );
  // Google: no thoughtsTokenCount AND no totalTokenCount → UNKNOWN.
  assert.throws(
    () => deriveConservativeActualUsdMicros({ provider: 'google', requestedModelId: 'gemini-3.1-pro-preview', priceVersion: V2, usageRaw: { promptTokenCount: 100, candidatesTokenCount: 20 } }),
    ConservativeSpendUnknownError,
  );
});

test('openai fractional input ($12.50/M) makes the ceiling reachable end-to-end: 1 prompt token → 13 micros (floor would be 12)', () => {
  assert.equal(
    deriveConservativeActualUsdMicros({ provider: 'openai', requestedModelId: 'gpt-5.6-sol', priceVersion: V2, usageRaw: { prompt_tokens: 1, completion_tokens: 0 } }),
    13, // 1 · 12,500,000 / 1,000,000 = 12.5 → ceil 13
  );
});

test('provider/model coherence: every roster pair prices; a mismatched cross-provider pair is UNKNOWN before pricing', () => {
  // Coherent roster pairs price without throwing.
  const coherent: Array<{ provider: ProviderName; requestedModelId: string; usageRaw: Record<string, unknown> }> = [
    { provider: 'openai', requestedModelId: 'gpt-5.6-sol', usageRaw: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
    { provider: 'anthropic', requestedModelId: 'claude-fable-5', usageRaw: { input_tokens: 100, output_tokens: 20 } },
    { provider: 'google', requestedModelId: 'gemini-3.1-pro-preview', usageRaw: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 125 } },
    { provider: 'xai', requestedModelId: 'grok-4.5', usageRaw: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 130, completion_tokens_details: { reasoning_tokens: 10 } } },
  ];
  for (const c of coherent) {
    assert.ok(deriveConservativeActualUsdMicros({ provider: c.provider, requestedModelId: c.requestedModelId, priceVersion: V2, usageRaw: c.usageRaw }) > 0);
  }
  // The review's exact probe: identical Anthropic usage priced against the cheaper xAI row is REJECTED.
  assert.throws(
    () => deriveConservativeActualUsdMicros({ provider: 'anthropic', requestedModelId: 'grok-4.5', priceVersion: V2, usageRaw: { input_tokens: 100, output_tokens: 20 } }),
    ConservativeSpendUnknownError,
  );
  // Every off-diagonal (provider, other-provider's model) pairing throws BEFORE pricing (usage never read).
  const modelOf: Record<ProviderName, string> = { openai: 'gpt-5.6-sol', anthropic: 'claude-fable-5', google: 'gemini-3.1-pro-preview', xai: 'grok-4.5' };
  const providers: ProviderName[] = ['openai', 'anthropic', 'google', 'xai'];
  for (const p of providers) {
    for (const m of providers) {
      if (p === m) continue;
      assert.throws(
        () => deriveConservativeActualUsdMicros({ provider: p, requestedModelId: modelOf[m], priceVersion: V2, usageRaw: {} }),
        ConservativeSpendUnknownError,
        `${p} + ${modelOf[m]} must be rejected`,
      );
    }
  }
});

test('PROVIDER_BY_MODEL matches the authenticated arm roster exactly (no drift)', () => {
  const fromArms: Record<string, string> = {};
  for (const arm of ARMS) fromArms[arm.requestedModelId] = arm.provider;
  assert.deepEqual({ ...PROVIDER_BY_MODEL }, fromArms);
});
