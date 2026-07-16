import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as time from './time.js';
import { instantMs, isParseableInstant } from './time.js';

/**
 * The shared instant handling. The canonical Zod schema is MODULE-PRIVATE, so the
 * offset requirement cannot be stripped through an exported handle (which would
 * reintroduce host-timezone ambiguity). The offset/finite rules themselves are
 * covered here and (via oddsHistory/attemptProvenance) at every consumer.
 */

test('instantMs / isParseableInstant accept offset-qualified instants and reject naive / out-of-range', () => {
  assert.equal(instantMs('2026-07-16T00:00:00.000Z'), Date.parse('2026-07-16T00:00:00.000Z'));
  assert.equal(instantMs('2026-07-16T05:00:00.000+05:00'), Date.parse('2026-07-16T00:00:00.000Z')); // honors offset
  assert.throws(() => instantMs('2026-07-16T00:00:00')); // naive (no offset)
  assert.throws(() => instantMs('2026-07-16T00:00:00+99:99')); // out-of-range offset -> Date.parse NaN
  assert.equal(isParseableInstant('2026-07-16T00:00:00.000Z'), true);
  assert.equal(isParseableInstant('2026-07-16T00:00:00'), false);
  assert.equal(isParseableInstant('2026-07-16T00:00:00+99:99'), false);
});

test('no mutable Zod schema is exported — instantMs cannot be defeated by tampering exports', () => {
  // The canonical schema is module-private: the old exported schema handles are gone.
  assert.equal((time as Record<string, unknown>).offsetInstant, undefined);
  assert.equal((time as Record<string, unknown>).parseableOffsetInstant, undefined);
  // Every export is a function (no mutable schema object whose _def.checks could be stripped).
  for (const key of Object.keys(time)) {
    const value = (time as Record<string, unknown>)[key];
    assert.equal(typeof value, 'function', `export ${key} must be a function, not a mutable schema`);
    try {
      (value as unknown as { _def?: unknown })._def = undefined; // attempt to tamper
    } catch {
      /* a frozen function property assignment may throw; ignore */
    }
  }
  // After the tamper attempt the offset requirement still holds (canonical state is inaccessible).
  assert.throws(() => instantMs('2026-07-16T00:00:00'));
  assert.throws(() => instantMs('2026-07-16T00:00:00+99:99'));
  assert.equal(isParseableInstant('2026-07-16T00:00:00'), false);
});
