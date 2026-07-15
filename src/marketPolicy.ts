import type { MarketKey } from './types.js';

/**
 * Which markets the benchmark ACTS ON, per league.
 *
 * This is a preregistered allow-list keyed on `(league, market)` — never a
 * global per-market switch and never a deny-list. It decides only what is
 * DISPATCHED to participants; it says nothing about detection. Every market a
 * league sends is still detected, timestamped, and recorded (an unlisted one
 * with reason `policy_disabled`). Detection is universal; action is policy.
 *
 * The policy is versioned code, not a runtime flag: there is deliberately no
 * `--markets` CLI option. A per-invocation lever over which markets are
 * entered would be exactly the cherry-pick surface a preregistered benchmark
 * cannot have. Enabling a market is a reviewed change that bumps
 * MARKET_POLICY_VERSION, and that version is hashed into every run record.
 *
 * The version bumps whenever the allow-list changes, so archived runs keep
 * declaring the policy they actually ran under.
 */
export const MARKET_POLICY_VERSION = 'market-policy-v1';

/**
 * The committed entry-honesty threshold: a market fires only if its own first
 * board appearance is within this window of detection. Preregistration, not a
 * runtime lever — it is stamped into every run record AND the scorer pins its
 * checks to THIS constant rather than the run's self-reported copy, so a
 * doctored artifact cannot certify a stale opener as fresh by inflating its
 * own threshold. Lives here, beside the market allow-list, because both are
 * the frozen preregistration the runner and the scorer must agree on.
 */
export const LATE_THRESHOLD_MS = 30 * 60_000;

/**
 * The allow-list. A market dispatches only if its league is listed here AND
 * the market appears in that league's array. MLB scores the moneyline and the
 * total; the run line is supported everywhere (types, prompt, schema,
 * baselines, scorer) but deliberately NOT enabled here — it is detected and
 * recorded `policy_disabled`, never dispatched.
 *
 * A league absent from this map has an empty enabled set: adding a league
 * dispatches NOTHING until its markets are explicitly enumerated in a
 * version bump. There is no path by which introducing a league silently
 * starts firing markets nobody affirmatively chose.
 */
export const MARKET_POLICY: Readonly<Record<string, readonly MarketKey[]>> = {
  mlb: ['moneyline', 'total'],
  // nfl: ['moneyline', 'spread', 'total'],   // example — not enabled
};

/** The markets a league dispatches, in the canonical market order. */
export function enabledMarkets(league: string): MarketKey[] {
  const listed = MARKET_POLICY[league] ?? [];
  return (['moneyline', 'spread', 'total'] as const).filter((m) => listed.includes(m));
}

/**
 * Whether a specific (league, market) is dispatched. Default for any unlisted
 * pair is `false` — the allow-list must name it explicitly.
 */
export function isMarketEnabled(league: string, market: MarketKey): boolean {
  return (MARKET_POLICY[league] ?? []).includes(market);
}
