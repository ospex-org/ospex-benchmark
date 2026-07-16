import { canonicalize, sha256Hex } from './canonical.js';
import type { MarketKey } from './types.js';

/**
 * Market policy: a per-`(sport, market)` ALLOW-LIST in code, keyed on the stable
 * `games.sport` slug (e.g. `"mlb"`) — NOT the nullable `games.league` column
 * (which the writer persists as null). A market is enterable only if its sport
 * explicitly lists it; every unlisted `(sport, market)` pair defaults to
 * DISABLED, so adding a sport enters nothing until its markets are enumerated in
 * a policy-version bump. There is no per-invocation `--markets` lever — the
 * entered market set must never be a per-run cherry-pick surface.
 *
 * MLB scores moneyline and total; the run line (stored as the `'spread'`
 * `MarketKey`) is supported but deliberately OFF. Spread stays fully supported
 * for other sports and is simply not enabled for MLB.
 *
 * The runner and scorer load the policy named by the recorded version and
 * RECOMPUTE its digest (`marketPolicyDigest`), so an unknown version or a
 * tampered allow-list fails closed rather than silently changing which markets
 * enter. See SPEC-line-open-speculation-runner.md §3.1 and
 * SPEC-line-open-evidence-model.md §2/§3.
 */
export const MARKET_POLICY_VERSIONS = ['market-policy-v1'] as const;
export type MarketPolicyVersion = (typeof MARKET_POLICY_VERSIONS)[number];

/** The policy version the harness stamps on NEW runs. */
export const MARKET_POLICY_VERSION: MarketPolicyVersion = 'market-policy-v1';

export function isMarketPolicyVersion(value: string): value is MarketPolicyVersion {
  return (MARKET_POLICY_VERSIONS as readonly string[]).includes(value);
}

/** One policy: for each `games.sport` slug, the markets that are enabled. */
type MarketPolicy = Readonly<Record<string, readonly MarketKey[]>>;

const MARKET_POLICY_V1: MarketPolicy = {
  // MLB: moneyline + total. Run line (the 'spread' MarketKey) deliberately OFF.
  mlb: ['moneyline', 'total'],
  // nfl: ['moneyline', 'spread', 'total'],  // example — when NFL is enabled
};

const POLICIES: Readonly<Record<MarketPolicyVersion, MarketPolicy>> = {
  'market-policy-v1': MARKET_POLICY_V1,
};

/** The policy object for a KNOWN version; throws on an unknown version. */
export function marketPolicyForVersion(version: string): MarketPolicy {
  if (!isMarketPolicyVersion(version)) {
    throw new Error(`unknown market policy version: ${version}`);
  }
  return POLICIES[version];
}

/**
 * Whether the policy allow-list alone enables `(sport, market)`. An unlisted
 * sport, or a listed sport that does not list the market, is DISABLED (default
 * deny). This is the market-policy half only; membership also requires the sport
 * to be in the cohort's `sportAllowList` — see `effectiveEnabled`.
 */
export function marketPolicyEnabled(
  sport: string,
  market: MarketKey,
  version: MarketPolicyVersion = MARKET_POLICY_VERSION,
): boolean {
  const enabled = POLICIES[version][sport];
  return enabled !== undefined && enabled.includes(market);
}

/**
 * The effective per-`(sport, market)` eligibility used identically by runtime
 * dispatch and finalization (evidence spec §3): the sport must be in the
 * cohort's `sportAllowList` AND the market policy must enable `(sport, market)`.
 * `sportAllowList` is supplied by the manifest (§2) and passed in here, so this
 * module carries no manifest dependency.
 */
export function effectiveEnabled(
  sportAllowList: readonly string[],
  sport: string,
  market: MarketKey,
  version: MarketPolicyVersion = MARKET_POLICY_VERSION,
): boolean {
  return sportAllowList.includes(sport) && marketPolicyEnabled(sport, market, version);
}

/**
 * The recomputed digest of a KNOWN policy version — the SHA-256 of the canonical
 * serialization of its allow-list. The manifest pins `marketPolicyDigest`; the
 * runner and scorer recompute this and reject a mismatch (spec §2), so a silent
 * edit to the allow-list cannot pass as the pinned policy.
 */
export function marketPolicyDigest(version: string): string {
  return sha256Hex(canonicalize(marketPolicyForVersion(version)));
}

/** Digest of the current policy version, for convenience. */
export const MARKET_POLICY_DIGEST: string = marketPolicyDigest(MARKET_POLICY_VERSION);
