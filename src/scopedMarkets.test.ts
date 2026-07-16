import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKET_ORDER, presentMarkets } from './scopedMarkets.js';
import { makeGameBundle } from './testFactories.js';

/**
 * The scoped-market helper is the single source every consumer derives
 * cardinality from (§3.4). These pin the canonical order and the
 * spread⇔runLine bridge across one-, two-, and three-market scoped bundles.
 */

test('presentMarkets returns all three in canonical order for a full bundle', () => {
  assert.deepEqual(presentMarkets(makeGameBundle()), ['moneyline', 'spread', 'total']);
  assert.deepEqual([...MARKET_ORDER], ['moneyline', 'spread', 'total']);
});

test('presentMarkets reflects a scoped subset, mapping runLine to the MarketKey spread', () => {
  assert.deepEqual(presentMarkets(makeGameBundle({}, ['total'])), ['total']);
  assert.deepEqual(presentMarkets(makeGameBundle({}, ['spread'])), ['spread']);
  assert.deepEqual(presentMarkets(makeGameBundle({}, ['moneyline', 'total'])), [
    'moneyline',
    'total',
  ]);
  // The order is always canonical regardless of the requested order.
  assert.deepEqual(presentMarkets(makeGameBundle({}, ['total', 'moneyline'])), [
    'moneyline',
    'total',
  ]);
});

test('MARKET_ORDER is frozen (runtime immutability, not just readonly)', () => {
  assert.throws(() => (MARKET_ORDER as unknown as string[]).push('x'));
});
