import type { GameBundle, MarketKey } from './types.js';

/**
 * The three markets in their canonical order. This order is the single source
 * of truth for every place that iterates markets — the bundle, the prompt, the
 * validator's required set, the baselines, the scorer's denominator — so that
 * a market subset is always enumerated the same way regardless of arrival
 * order. Nothing may hard-code a market count; derive from the set present.
 */
export const MARKET_KEYS: readonly MarketKey[] = ['moneyline', 'spread', 'total'];

/**
 * The bundle stores the run line under the key `runLine` while the wire /
 * decision market is `spread`. This mapping is the ONE place that bridges the
 * two vocabularies; it is deliberately not a rename (`markets.runLine` is
 * load-bearing for replaying the archived corpus).
 */
const MARKET_TO_BUNDLE_KEY = {
  moneyline: 'moneyline',
  spread: 'runLine',
  total: 'total',
} as const satisfies Record<MarketKey, keyof GameBundle['markets']>;

/** The `game.markets` object key for a market (`spread` → `runLine`). */
export function bundleKeyFor(market: MarketKey): keyof GameBundle['markets'] {
  return MARKET_TO_BUNDLE_KEY[market];
}

/** Whether a bundle carries a block for this market. */
export function hasMarket(game: GameBundle, market: MarketKey): boolean {
  return game.markets[bundleKeyFor(market)] !== undefined;
}

/**
 * The markets a bundle actually carries, in canonical order. This is THE
 * denominator every downstream consumer must use instead of assuming all
 * three — a scoped fire carries a subset, an archived full bundle carries all
 * three, and both are handled by reading this.
 */
export function bundleMarketKeys(game: GameBundle): MarketKey[] {
  return MARKET_KEYS.filter((m) => hasMarket(game, m));
}
