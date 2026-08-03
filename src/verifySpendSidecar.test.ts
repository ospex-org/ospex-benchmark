import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rebuildUsageRaw } from './verifySpendSidecar.js';

/**
 * The prototype-safe token-path rebuild, owned directly. The pair-level verifier tests —
 * the real produced artifact+sidecar round trips, the witnessed adversarial mutations
 * (truncation, duplication, fabrication, tampering, pollution), the exact arithmetic
 * pins, and the CLI exit codes — live in `lineOpenSpine.test.ts`, where the REAL durable
 * pairs are produced by the actual fire spine.
 */

test('rebuildUsageRaw nests dotted paths exactly, into NULL-PROTOTYPE objects', () => {
  const rebuilt = rebuildUsageRaw({
    prompt_tokens: 1500,
    'completion_tokens_details.reasoning_tokens': 5,
    total_tokens: 2000,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), {
    prompt_tokens: 1500,
    completion_tokens_details: { reasoning_tokens: 5 },
    total_tokens: 2000,
  });
  // Null prototypes at every level: nothing a persisted key writes can reach a global.
  assert.equal(Object.getPrototypeOf(rebuilt), null);
  assert.equal(Object.getPrototypeOf(rebuilt['completion_tokens_details']), null);
});

test('rebuildUsageRaw REFUSES dangerous and empty path segments — and never touches Object.prototype', () => {
  const before = ({} as Record<string, unknown>)['ospexPolluted'];
  for (const path of ['__proto__.ospexPolluted', 'constructor.prototype.ospexPolluted', 'prototype.x', 'a..b', '.leading']) {
    assert.throws(() => rebuildUsageRaw({ [path]: 1337 }), /dangerous or empty path segment/, path);
  }
  assert.equal(({} as Record<string, unknown>)['ospexPolluted'], before, 'Object.prototype is untouched');
  assert.equal(before, undefined);
});
