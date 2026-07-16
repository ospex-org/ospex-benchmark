import type { GameBundle, MarketKey } from './types.js';

/**
 * The scoped-bundle market set (evidence spec §3.4). A scoped bundle carries
 * exactly the speculations firing in its dispatch, so the prompt's required
 * forecast set, the validator's cardinality, the deterministic baselines, and
 * the records all derive from ONE source — the bundle's own present markets —
 * never a hard-coded three.
 *
 * Note the run line is the MarketKey `spread`, stored under the bundle field
 * `runLine` (the field name is retained so archived-corpus replay still works).
 * This module is the single bridge between the two.
 */

/**
 * Canonical market order. The present-market set is always reported in this
 * order so records, prompts, and validation stay deterministic regardless of
 * object key order.
 */
export const MARKET_ORDER: readonly MarketKey[] = Object.freeze([
  'moneyline',
  'spread',
  'total',
] as const);

/**
 * The markets actually present in a scoped bundle, in MARKET_ORDER. Maps the
 * bundle field `runLine` to its MarketKey `spread`. A three-market bundle
 * returns all three (archived-corpus behavior); a split fire returns fewer.
 */
export function presentMarkets(game: GameBundle): MarketKey[] {
  const present: MarketKey[] = [];
  if (game.markets.moneyline !== undefined) present.push('moneyline');
  if (game.markets.runLine !== undefined) present.push('spread');
  if (game.markets.total !== undefined) present.push('total');
  return present;
}
