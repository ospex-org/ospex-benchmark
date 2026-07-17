import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MARKET_ORDER,
  ScopedBundleError,
  presentMarkets,
  requireScopedMarkets,
  scopedMarkets,
} from './scopedMarkets.js';
import { makeGameBundle } from './testFactories.js';
import type { GameBundle } from './types.js';

/** A bundle whose moneyline own-property holds an arbitrary (untyped) value. */
function withMoneylineValue(value: unknown): GameBundle {
  const game = makeGameBundle();
  (game.markets as Record<string, unknown>).moneyline = value;
  return game;
}

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

// ---------------------------------------------------------------------------
// Fail-closed boundary — the scope must reject malformed/empty/unknown input,
// not fall open (Hermes PR#21). "Present" is an OWN property holding a valid
// block; every consumer reads this one validated set.
// ---------------------------------------------------------------------------

test('an empty scope is rejected (a bundle must carry at least one present market)', () => {
  const empty = makeGameBundle({}, []);
  const r = scopedMarkets(empty);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.violations.some((v) => /empty scope/.test(v)));
  assert.throws(() => requireScopedMarkets(empty), ScopedBundleError);
  assert.throws(() => presentMarkets(empty), ScopedBundleError);
});

test('a present-but-falsy or non-object market block is rejected, never counted present', () => {
  // The exact fail-open surface: null/false/0/"" plus other non-block values.
  for (const bad of [null, false, 0, '', NaN, Infinity, 'x', 123, []] as unknown[]) {
    const game = withMoneylineValue(bad);
    const r = scopedMarkets(game);
    assert.equal(r.ok, false, `value ${String(bad)} must be rejected`);
    assert.ok(!r.ok && r.violations.some((v) => /malformed moneyline block/.test(v)));
    assert.throws(() => presentMarkets(game));
  }
});

test('a structurally malformed block object (wrong type / missing field) is rejected', () => {
  assert.equal(scopedMarkets(withMoneylineValue({ awayDecimal: 'x', homeDecimal: 2 })).ok, false);
  assert.equal(scopedMarkets(withMoneylineValue({ awayDecimal: 1.9 })).ok, false); // missing fields
  assert.equal(scopedMarkets(withMoneylineValue({ awayDecimal: 0.5, homeDecimal: 2, observedAt: 'a', evidenceRef: 'b' })).ok, false); // decimal <= 1
});

test('an unknown market key is rejected', () => {
  const game = makeGameBundle();
  (game.markets as Record<string, unknown>).parlay = { foo: 1 };
  const r = scopedMarkets(game);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.violations.some((v) => /unknown market key/.test(v)));
});

test('an inherited market key is not counted present (own enumerable properties only)', () => {
  const proto = { moneyline: makeGameBundle().markets.moneyline };
  const game = makeGameBundle({}, []);
  (game as unknown as Record<string, unknown>).markets = Object.create(proto); // moneyline only via prototype
  assert.equal(scopedMarkets(game).ok, false); // inherited => empty own scope => rejected
  assert.throws(() => presentMarkets(game));
});

test('a valid scoped subset returns the validated present set and blocks', () => {
  const r = scopedMarkets(makeGameBundle({}, ['moneyline', 'total']));
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.scoped.markets, ['moneyline', 'total']);
    assert.ok(r.scoped.moneyline && r.scoped.total);
    assert.equal(r.scoped.runLine, undefined);
  }
});
