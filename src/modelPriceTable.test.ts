import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import {
  MODEL_PRICE_TABLE_DIGEST,
  MODEL_PRICE_TABLE_VERSION,
  MODEL_PRICE_TABLE_VERSIONS,
  SPEND_GUARD_PRICE_TABLE_VERSION,
  isModelPriceTableVersion,
  modelPriceTableDigest,
  modelPriceTableForVersion,
  priceForModel,
} from './modelPriceTable.js';
import type { ModelPrice } from './modelPriceTable.js';
import { APPROVED_REPORTED_MODEL_IDS, ARMS } from './providers/index.js';

/**
 * Model price-table tests. The table is a deep-frozen, versioned baseline whose
 * digest fails closed on a tampered or unknown table; every billable model id
 * (each arm's requested id plus every approved reported id) must be priced, and
 * an unknown version or unpriced model throws rather than returning a default.
 */

/** Canonical digest of prices-v1's rate table, pinned as a golden. */
const PINNED_DIGEST = 'bbd49df2721e6cf654fc9dd9760d4cc45f53d4d25cb8c81e5f6e08128ceaf39e';

/**
 * Canonical digest of prices-v2's rate table, pinned as an INDEPENDENT golden: a silent rate edit
 * that ALSO moves the EXPECTED_TABLE_V2 literal in the same change still breaks this. Re-pin
 * consciously whenever a v2 rate changes (a manifest that pins prices-v2 binds this digest).
 */
const PINNED_DIGEST_V2 = '3d6d47a2427d21429e59094fd9cb9235473206a07b19b62b3292cde605e118c5';

/**
 * Canonical digest of prices-v3 — the retained replay table: v2 token rates plus search fees.
 */
const PINNED_DIGEST_V3 = '3b6860a5b2c8dfd0df81f4c2ee4b4436dc962402cd1753ed421f6a502a322b35';

/** Canonical digest of prices-v4 — 2026-08-10 conservative Fast long-context reconciliation. */
const PINNED_DIGEST_V4 = '5a438d718664527135b39780528e21e7046f0420adb361d10ddb5f9dfe37248b';

/** The exact prices-v1 rates, as a literal, to re-derive the digest independently. */
const EXPECTED_TABLE = {
  'gpt-5.6-sol': { inputUsdMicrosPerMillionTokens: 5_000_000, outputUsdMicrosPerMillionTokens: 30_000_000 },
  'claude-fable-5': { inputUsdMicrosPerMillionTokens: 10_000_000, outputUsdMicrosPerMillionTokens: 50_000_000 },
  'gemini-3.1-pro-preview': { inputUsdMicrosPerMillionTokens: 2_000_000, outputUsdMicrosPerMillionTokens: 12_000_000 },
  'grok-4.5': { inputUsdMicrosPerMillionTokens: 2_000_000, outputUsdMicrosPerMillionTokens: 6_000_000 },
} as const;

/** The exact retained prices-v3 rates, as a literal, to re-derive independently. */
const EXPECTED_TABLE_V3 = {
  'gpt-5.6-sol': {
    inputUsdMicrosPerMillionTokens: 12_500_000,
    outputUsdMicrosPerMillionTokens: 60_000_000,
    searchUsdMicrosPerSearch: 10_000,
  },
  'claude-fable-5': {
    inputUsdMicrosPerMillionTokens: 10_000_000,
    outputUsdMicrosPerMillionTokens: 50_000_000,
    searchUsdMicrosPerSearch: 10_000,
  },
  'gemini-3.1-pro-preview': {
    inputUsdMicrosPerMillionTokens: 4_000_000,
    outputUsdMicrosPerMillionTokens: 18_000_000,
    searchUsdMicrosPerSearch: 14_000,
  },
  'grok-4.5': {
    inputUsdMicrosPerMillionTokens: 4_000_000,
    outputUsdMicrosPerMillionTokens: 12_000_000,
    searchUsdMicrosPerSearch: 5_000,
  },
} as const;

/**
 * The exact prices-v4 (guard) rates, as a literal, to re-derive the digest
 * independently. Spelled out rather than spread from `EXPECTED_TABLE_V3` for the same
 * reason the production table is: an expectation derived the same way the code derives
 * it can only prove the derivation ran, not that it produced these numbers.
 */
const EXPECTED_TABLE_V4 = {
  'gpt-5.6-sol': {
    inputUsdMicrosPerMillionTokens: 25_000_000,
    outputUsdMicrosPerMillionTokens: 90_000_000,
    searchUsdMicrosPerSearch: 10_000,
  },
  'claude-fable-5': {
    inputUsdMicrosPerMillionTokens: 10_000_000,
    outputUsdMicrosPerMillionTokens: 50_000_000,
    searchUsdMicrosPerSearch: 10_000,
  },
  'gemini-3.1-pro-preview': {
    inputUsdMicrosPerMillionTokens: 4_000_000,
    outputUsdMicrosPerMillionTokens: 18_000_000,
    searchUsdMicrosPerSearch: 14_000,
  },
  'grok-4.5': {
    inputUsdMicrosPerMillionTokens: 4_000_000,
    outputUsdMicrosPerMillionTokens: 12_000_000,
    searchUsdMicrosPerSearch: 5_000,
  },
} as const;

/** The exact prices-v2 (conservative upper-tier) rates, as a literal, to re-derive independently. */
const EXPECTED_TABLE_V2 = {
  'gpt-5.6-sol': { inputUsdMicrosPerMillionTokens: 12_500_000, outputUsdMicrosPerMillionTokens: 60_000_000 },
  'claude-fable-5': { inputUsdMicrosPerMillionTokens: 10_000_000, outputUsdMicrosPerMillionTokens: 50_000_000 },
  'gemini-3.1-pro-preview': { inputUsdMicrosPerMillionTokens: 4_000_000, outputUsdMicrosPerMillionTokens: 18_000_000 },
  'grok-4.5': { inputUsdMicrosPerMillionTokens: 4_000_000, outputUsdMicrosPerMillionTokens: 12_000_000 },
} as const;

test('content: every row read through the accessor equals the exact prices-v1 rates', () => {
  const table = modelPriceTableForVersion(MODEL_PRICE_TABLE_VERSION);
  for (const [id, expected] of Object.entries(EXPECTED_TABLE)) {
    assert.deepEqual(table[id], expected, id);
  }
  // No unexpected rows: exactly the four keys.
  assert.deepEqual(Object.keys(table).sort(), Object.keys(EXPECTED_TABLE).sort());
});

test('coverage: table keys equal the requested+approved billable universe (no missing, no extra)', () => {
  const universe = new Set([
    ...ARMS.map((arm) => arm.requestedModelId),
    ...Object.values(APPROVED_REPORTED_MODEL_IDS).flat(),
  ]);
  const table = modelPriceTableForVersion(MODEL_PRICE_TABLE_VERSION);

  // Completeness: every billable id has an own-key price (a deleted row fails here).
  for (const id of universe) {
    assert.ok(Object.hasOwn(table, id), `missing price for billable model id "${id}"`);
  }
  // No extras: every priced key is a billable id (a non-roster key fails here).
  for (const key of Object.keys(table)) {
    assert.ok(universe.has(key), `priced key "${key}" is not in the billable universe`);
  }
  // Exact set equality — reddens on either a missing or an extra key.
  assert.deepEqual(Object.keys(table).sort(), [...universe].sort());
});

test('numeric domain: every rate is a positive safe integer', () => {
  const table = modelPriceTableForVersion(MODEL_PRICE_TABLE_VERSION);
  for (const [id, price] of Object.entries(table)) {
    for (const [field, rate] of Object.entries(price)) {
      assert.ok(Number.isSafeInteger(rate), `${id}.${field} = ${rate} is not a safe integer`);
      assert.ok(rate > 0, `${id}.${field} = ${rate} is not positive`);
    }
  }
});

test('fail-closed API: unknown model / version / prototype-name throw distinct errors', () => {
  // Ordinary missing model id.
  assert.throws(() => priceForModel('definitely-not-a-model'), /unknown model price: definitely-not-a-model/);
  // Prototype-looking names must NOT resolve via the prototype chain.
  assert.throws(() => priceForModel('toString'), /unknown model price: toString/);
  assert.throws(() => priceForModel('__proto__'), /unknown model price: __proto__/);
  assert.throws(() => priceForModel('hasOwnProperty'), /unknown model price: hasOwnProperty/);
  assert.throws(() => priceForModel('constructor'), /unknown model price: constructor/);
  // Unknown version at every version-taking entry point (prices-v99 is genuinely unregistered).
  assert.throws(() => modelPriceTableForVersion('prices-v99'), /unknown model price table version: prices-v99/);
  assert.throws(() => modelPriceTableDigest('prices-v99'), /unknown model price table version: prices-v99/);
  // Unknown version dominates model lookup (version resolves first).
  assert.throws(() => priceForModel('gpt-5.6-sol', 'prices-v99'), /unknown model price table version: prices-v99/);
});

test('known-version guard: every registered version accepted; unrelated versions rejected', () => {
  assert.equal(isModelPriceTableVersion(MODEL_PRICE_TABLE_VERSION), true);
  assert.equal(isModelPriceTableVersion(SPEND_GUARD_PRICE_TABLE_VERSION), true);
  assert.equal(isModelPriceTableVersion('prices-v2'), true); // retained for replay of evidence priced under it
  assert.equal(isModelPriceTableVersion('prices-v99'), false);
  assert.equal(isModelPriceTableVersion('market-policy-v1'), false);
  assert.ok((MODEL_PRICE_TABLE_VERSIONS as readonly string[]).includes(MODEL_PRICE_TABLE_VERSION));
  assert.ok((MODEL_PRICE_TABLE_VERSIONS as readonly string[]).includes(SPEND_GUARD_PRICE_TABLE_VERSION));
});

test('digest: deterministic, lowercase 64-hex, pinned golden, and content-sensitive', () => {
  const d1 = modelPriceTableDigest(MODEL_PRICE_TABLE_VERSION);
  const d2 = modelPriceTableDigest(MODEL_PRICE_TABLE_VERSION);
  assert.equal(d1, d2); // deterministic
  assert.equal(d1, MODEL_PRICE_TABLE_DIGEST);
  assert.match(d1, /^[0-9a-f]{64}$/); // lowercase sha-256 hex
  assert.equal(d1, PINNED_DIGEST); // pinned golden — a silent rate edit breaks this
  assert.equal(d1, sha256Hex(canonicalize(EXPECTED_TABLE)));
  // A different content produces a different digest.
  assert.notEqual(
    d1,
    sha256Hex(canonicalize({ 'gpt-5.6-sol': { inputUsdMicrosPerMillionTokens: 1, outputUsdMicrosPerMillionTokens: 1 } })),
  );
});

test('runtime immutability: an adversarial cast cannot mutate, replace, or add a row', () => {
  const table = modelPriceTableForVersion(MODEL_PRICE_TABLE_VERSION);
  const row = table['gpt-5.6-sol']!;
  assert.throws(() => {
    (row as { inputUsdMicrosPerMillionTokens: number }).inputUsdMicrosPerMillionTokens = 1;
  }); // frozen row → throws
  assert.throws(() => {
    (table as Record<string, ModelPrice>)['gpt-5.6-sol'] = {
      inputUsdMicrosPerMillionTokens: 1,
      outputUsdMicrosPerMillionTokens: 1,
    };
  }); // frozen table → cannot reassign a key
  assert.throws(() => {
    (table as Record<string, ModelPrice>)['injected-model'] = {
      inputUsdMicrosPerMillionTokens: 1,
      outputUsdMicrosPerMillionTokens: 1,
    };
  }); // frozen table → cannot add a key

  // Values unchanged and the digest never split.
  assert.equal(table['gpt-5.6-sol']!.inputUsdMicrosPerMillionTokens, 5_000_000);
  assert.ok(!Object.hasOwn(table, 'injected-model'));
  assert.equal(MODEL_PRICE_TABLE_DIGEST, modelPriceTableDigest(MODEL_PRICE_TABLE_VERSION));
  assert.equal(MODEL_PRICE_TABLE_DIGEST, PINNED_DIGEST);
});

test('the exported version tuple is frozen — a casted push cannot forge a known version', () => {
  assert.throws(() => (MODEL_PRICE_TABLE_VERSIONS as unknown as string[]).push('prices-v99'));
  assert.equal(isModelPriceTableVersion('prices-v99'), false);
  assert.deepEqual([...MODEL_PRICE_TABLE_VERSIONS], ['prices-v1', 'prices-v2', 'prices-v3', 'prices-v4']); // unchanged state
});

test('prices-v2 content: the RETAINED table still equals the exact conservative upper-tier rates', () => {
  const table = modelPriceTableForVersion('prices-v2');
  for (const [id, expected] of Object.entries(EXPECTED_TABLE_V2)) {
    assert.deepEqual(table[id], expected, id);
  }
  assert.deepEqual(Object.keys(table).sort(), Object.keys(EXPECTED_TABLE_V2).sort());
});

test('prices-v2 coverage: prices the same billable universe as v1 (no missing, no extra)', () => {
  const universe = new Set([
    ...ARMS.map((arm) => arm.requestedModelId),
    ...Object.values(APPROVED_REPORTED_MODEL_IDS).flat(),
  ]);
  const table = modelPriceTableForVersion(SPEND_GUARD_PRICE_TABLE_VERSION);
  for (const id of universe) {
    assert.ok(Object.hasOwn(table, id), `missing prices-v2 price for billable model id "${id}"`);
  }
  assert.deepEqual(Object.keys(table).sort(), [...universe].sort());
});

test('prices-v2 numeric domain: every rate is a positive safe integer', () => {
  const table = modelPriceTableForVersion(SPEND_GUARD_PRICE_TABLE_VERSION);
  for (const [id, price] of Object.entries(table)) {
    for (const [field, rate] of Object.entries(price)) {
      assert.ok(Number.isSafeInteger(rate), `${id}.${field} = ${rate} is not a safe integer`);
      assert.ok(rate > 0, `${id}.${field} = ${rate} is not positive`);
    }
  }
});

test('prices-v2 is conservative: every rate >= the prices-v1 rate for the same model (never underprices)', () => {
  const v1 = modelPriceTableForVersion(MODEL_PRICE_TABLE_VERSION);
  const v2 = modelPriceTableForVersion(SPEND_GUARD_PRICE_TABLE_VERSION);
  assert.deepEqual(Object.keys(v2).sort(), Object.keys(v1).sort()); // same model universe
  for (const id of Object.keys(v2)) {
    assert.ok(
      v2[id]!.inputUsdMicrosPerMillionTokens >= v1[id]!.inputUsdMicrosPerMillionTokens,
      `${id} input: v2 ${v2[id]!.inputUsdMicrosPerMillionTokens} < v1 ${v1[id]!.inputUsdMicrosPerMillionTokens}`,
    );
    assert.ok(
      v2[id]!.outputUsdMicrosPerMillionTokens >= v1[id]!.outputUsdMicrosPerMillionTokens,
      `${id} output: v2 ${v2[id]!.outputUsdMicrosPerMillionTokens} < v1 ${v1[id]!.outputUsdMicrosPerMillionTokens}`,
    );
  }
});

test('prices-v2 digest: UNCHANGED by the v3 addition — evidence priced under it still re-verifies', () => {
  const d = modelPriceTableDigest('prices-v2');
  assert.equal(d, modelPriceTableDigest('prices-v2')); // deterministic
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(d, PINNED_DIGEST_V2); // INDEPENDENT golden — a silent rate edit breaks this even if EXPECTED_TABLE_V2 moves too
  assert.equal(d, sha256Hex(canonicalize(EXPECTED_TABLE_V2))); // and re-derives from the rate literal
  assert.notEqual(d, modelPriceTableDigest(MODEL_PRICE_TABLE_VERSION)); // v2 digest != v1 digest
});

test('prices-v3 replay table: token rates equal v2, every row carries a positive search fee, digest is its own golden', () => {
  const guard = modelPriceTableForVersion('prices-v3');
  const v2 = modelPriceTableForVersion('prices-v2');
  for (const [id, row] of Object.entries(guard)) {
    // The search fee is the ONLY difference from v2 — a token-rate change would
    // be a separate, conscious decision, not a side effect of enabling search.
    assert.equal(row.inputUsdMicrosPerMillionTokens, v2[id]!.inputUsdMicrosPerMillionTokens, id);
    assert.equal(row.outputUsdMicrosPerMillionTokens, v2[id]!.outputUsdMicrosPerMillionTokens, id);
    assert.ok(
      Number.isSafeInteger(row.searchUsdMicrosPerSearch) && (row.searchUsdMicrosPerSearch ?? 0) > 0,
      `${id} must carry a positive integer per-search fee`,
    );
  }
  // ...and v2 itself carries NO search rate, which is what makes it fail closed
  // when a nonzero search count is recorded against it.
  for (const row of Object.values(v2)) assert.equal(row.searchUsdMicrosPerSearch, undefined);

  const d = modelPriceTableDigest('prices-v3');
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(d, PINNED_DIGEST_V3); // INDEPENDENT golden
  assert.equal(d, sha256Hex(canonicalize(EXPECTED_TABLE_V3))); // re-derives from the rate literal
  assert.notEqual(d, PINNED_DIGEST_V2);
  assert.notEqual(d, PINNED_DIGEST);
});

test('prices-v4 guard updates only reachable OpenAI Fast long-context rates and pins its own digest', () => {
  const guard = modelPriceTableForVersion(SPEND_GUARD_PRICE_TABLE_VERSION);
  const v3 = modelPriceTableForVersion('prices-v3');
  assert.deepEqual(guard, EXPECTED_TABLE_V4);
  assert.equal(guard['gpt-5.6-sol']!.inputUsdMicrosPerMillionTokens, 25_000_000);
  assert.equal(guard['gpt-5.6-sol']!.outputUsdMicrosPerMillionTokens, 90_000_000);
  for (const id of Object.keys(EXPECTED_TABLE_V4) as Array<keyof typeof EXPECTED_TABLE_V4>) {
    assert.equal(guard[id]!.searchUsdMicrosPerSearch, v3[id]!.searchUsdMicrosPerSearch, id);
    if (id !== 'gpt-5.6-sol') assert.deepEqual(guard[id], v3[id], id);
  }
  const digest = modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION);
  assert.equal(digest, PINNED_DIGEST_V4);
  assert.equal(digest, sha256Hex(canonicalize(EXPECTED_TABLE_V4)));
  assert.notEqual(digest, PINNED_DIGEST_V3);
});

test('the guard table is nowhere cheaper than the one it replaces, and is strictly dearer where the tiers compose', () => {
  // The property this version exists for. A guard rate that moves DOWN can only
  // underbound, so it is asserted over every model and every rate field rather than
  // over the one row that changed — a later version that lowers a different row is red
  // here too, without anyone having to remember this reasoning.
  const guard = modelPriceTableForVersion(SPEND_GUARD_PRICE_TABLE_VERSION);
  const prior = modelPriceTableForVersion('prices-v3');
  for (const [id, row] of Object.entries(guard)) {
    const was = prior[id]!;
    assert.ok(row.inputUsdMicrosPerMillionTokens >= was.inputUsdMicrosPerMillionTokens, `${id} input`);
    assert.ok(row.outputUsdMicrosPerMillionTokens >= was.outputUsdMicrosPerMillionTokens, `${id} output`);
    assert.ok((row.searchUsdMicrosPerSearch ?? 0) >= (was.searchUsdMicrosPerSearch ?? 0), `${id} search`);
  }
  // STRICTLY dearer on the composed row, so restoring v3's OpenAI rates — the exact
  // defect this fixes — fails here rather than passing as "not cheaper than itself".
  const openai = guard['gpt-5.6-sol']!;
  const openaiWas = prior['gpt-5.6-sol']!;
  assert.ok(openai.inputUsdMicrosPerMillionTokens > openaiWas.inputUsdMicrosPerMillionTokens);
  assert.ok(openai.outputUsdMicrosPerMillionTokens > openaiWas.outputUsdMicrosPerMillionTokens);
});

test('SPEND_GUARD_PRICE_TABLE_VERSION is prices-v4, registered, and distinct from the default stamped version', () => {
  assert.equal(SPEND_GUARD_PRICE_TABLE_VERSION, 'prices-v4');
  assert.equal(isModelPriceTableVersion(SPEND_GUARD_PRICE_TABLE_VERSION), true);
  assert.notEqual(SPEND_GUARD_PRICE_TABLE_VERSION, MODEL_PRICE_TABLE_VERSION); // guard table != default (prices-v1)
});

test('guard rows are runtime-immutable (deep-frozen registry)', () => {
  const table = modelPriceTableForVersion(SPEND_GUARD_PRICE_TABLE_VERSION);
  const row = table['gpt-5.6-sol']!;
  assert.throws(() => {
    (row as { inputUsdMicrosPerMillionTokens: number }).inputUsdMicrosPerMillionTokens = 1;
  });
  assert.equal(table['gpt-5.6-sol']!.outputUsdMicrosPerMillionTokens, 90_000_000);
});
