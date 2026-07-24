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

/** The exact prices-v1 rates, as a literal, to re-derive the digest independently. */
const EXPECTED_TABLE = {
  'gpt-5.6-sol': { inputUsdMicrosPerMillionTokens: 5_000_000, outputUsdMicrosPerMillionTokens: 30_000_000 },
  'claude-fable-5': { inputUsdMicrosPerMillionTokens: 10_000_000, outputUsdMicrosPerMillionTokens: 50_000_000 },
  'gemini-3.1-pro-preview': { inputUsdMicrosPerMillionTokens: 2_000_000, outputUsdMicrosPerMillionTokens: 12_000_000 },
  'grok-4.5': { inputUsdMicrosPerMillionTokens: 2_000_000, outputUsdMicrosPerMillionTokens: 6_000_000 },
} as const;

/** The exact prices-v2 (conservative upper-tier) rates, as a literal, to re-derive independently. */
const EXPECTED_TABLE_V2 = {
  'gpt-5.6-sol': { inputUsdMicrosPerMillionTokens: 10_000_000, outputUsdMicrosPerMillionTokens: 45_000_000 },
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
  // Unknown version at every version-taking entry point (prices-v3 is genuinely unregistered).
  assert.throws(() => modelPriceTableForVersion('prices-v3'), /unknown model price table version: prices-v3/);
  assert.throws(() => modelPriceTableDigest('prices-v3'), /unknown model price table version: prices-v3/);
  // Unknown version dominates model lookup (version resolves first).
  assert.throws(() => priceForModel('gpt-5.6-sol', 'prices-v3'), /unknown model price table version: prices-v3/);
});

test('known-version guard: both registered versions accepted; unrelated versions rejected', () => {
  assert.equal(isModelPriceTableVersion(MODEL_PRICE_TABLE_VERSION), true);
  assert.equal(isModelPriceTableVersion(SPEND_GUARD_PRICE_TABLE_VERSION), true); // prices-v2 is now registered
  assert.equal(isModelPriceTableVersion('prices-v3'), false);
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
  assert.throws(() => (MODEL_PRICE_TABLE_VERSIONS as unknown as string[]).push('prices-v3'));
  assert.equal(isModelPriceTableVersion('prices-v3'), false);
  assert.deepEqual([...MODEL_PRICE_TABLE_VERSIONS], ['prices-v1', 'prices-v2']); // unchanged state
});

test('prices-v2 content: every row equals the exact conservative upper-tier rates', () => {
  const table = modelPriceTableForVersion(SPEND_GUARD_PRICE_TABLE_VERSION);
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

test('prices-v2 digest: deterministic, 64-hex, re-derivable from the literal, distinct from v1', () => {
  const d = modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION);
  assert.equal(d, modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION)); // deterministic
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(d, sha256Hex(canonicalize(EXPECTED_TABLE_V2))); // re-derived from the literal — a silent module edit breaks this
  assert.notEqual(d, modelPriceTableDigest(MODEL_PRICE_TABLE_VERSION)); // v2 digest != v1 digest
});

test('SPEND_GUARD_PRICE_TABLE_VERSION is prices-v2, registered, and distinct from the default stamped version', () => {
  assert.equal(SPEND_GUARD_PRICE_TABLE_VERSION, 'prices-v2');
  assert.equal(isModelPriceTableVersion(SPEND_GUARD_PRICE_TABLE_VERSION), true);
  assert.notEqual(SPEND_GUARD_PRICE_TABLE_VERSION, MODEL_PRICE_TABLE_VERSION); // guard table != default (prices-v1)
});

test('prices-v2 rows are runtime-immutable (deep-frozen registry)', () => {
  const table = modelPriceTableForVersion(SPEND_GUARD_PRICE_TABLE_VERSION);
  const row = table['gpt-5.6-sol']!;
  assert.throws(() => {
    (row as { inputUsdMicrosPerMillionTokens: number }).inputUsdMicrosPerMillionTokens = 1;
  });
  assert.equal(table['gpt-5.6-sol']!.outputUsdMicrosPerMillionTokens, 45_000_000);
});
