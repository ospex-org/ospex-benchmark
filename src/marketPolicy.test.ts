import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import {
  MARKET_POLICY_DIGEST,
  MARKET_POLICY_VERSION,
  MARKET_POLICY_VERSIONS,
  effectiveEnabled,
  isFullBoardCohort,
  isMarketPolicyVersion,
  marketPolicyDigest,
  marketPolicyEnabled,
  marketPolicyForVersion,
} from './marketPolicy.js';

/** Canonical digest of market-policy-v1's allow-list, pinned as a golden. */
const PINNED_DIGEST = 'aa6f24ddc0758d8366449b0ae4803898079cee1cfdfa36575a67da9751509dcd';

/**
 * Market-policy allow-list tests. The policy is default-DENY: a market enters
 * only if its sport explicitly lists it, and effective eligibility also requires
 * the sport to be in the cohort's sportAllowList. Turning off the MLB run line
 * says nothing about any other sport, and the recomputed digest fails closed on
 * a tampered or unknown policy.
 */

test('MLB policy enables moneyline + total; the run line (spread) is OFF', () => {
  assert.equal(marketPolicyEnabled('mlb', 'moneyline'), true);
  assert.equal(marketPolicyEnabled('mlb', 'total'), true);
  assert.equal(marketPolicyEnabled('mlb', 'spread'), false); // run line, deliberately off
});

test('default-deny: an unlisted sport, or an unlisted market on a listed sport, is disabled', () => {
  // Unlisted sport → every market disabled.
  for (const market of ['moneyline', 'spread', 'total'] as const) {
    assert.equal(marketPolicyEnabled('nfl', market), false);
    assert.equal(marketPolicyEnabled('nba', market), false);
    assert.equal(marketPolicyEnabled('', market), false);
  }
  // Listed sport, unlisted market → disabled.
  assert.equal(marketPolicyEnabled('mlb', 'spread'), false);
});

test('effectiveEnabled ANDs the sportAllowList with the market policy', () => {
  // In the allow-list and policy-enabled → true.
  assert.equal(effectiveEnabled(['mlb'], 'mlb', 'moneyline'), true);
  assert.equal(effectiveEnabled(['mlb'], 'mlb', 'total'), true);
  // In the allow-list but policy-disabled → false.
  assert.equal(effectiveEnabled(['mlb'], 'mlb', 'spread'), false);
  // Policy-enabled but NOT in the allow-list → false.
  assert.equal(effectiveEnabled([], 'mlb', 'moneyline'), false);
  assert.equal(effectiveEnabled(['nba'], 'mlb', 'moneyline'), false);
  // In the allow-list but the policy has no entry for that sport → false (default deny).
  assert.equal(effectiveEnabled(['nba'], 'nba', 'moneyline'), false);
});

test('isFullBoardCohort: an MLB cohort is scoped (run line off); a zero-market sport is scoped', () => {
  // MLB enables only moneyline + total under market-policy-v1, so no MLB cohort
  // is full-board — it needs the scoped baseline policy (v0.3).
  assert.equal(isFullBoardCohort(['mlb']), false);
  assert.equal(marketPolicyEnabled('mlb', 'spread'), false); // WHY it is scoped: run line off
  // A sport the policy does not know enables nothing → not full-board.
  assert.equal(isFullBoardCohort(['nba']), false);
  // A mixed allow-list where any sport falls short of the full board → not full-board.
  assert.equal(isFullBoardCohort(['mlb', 'nba']), false);
});

test('isFullBoardCohort: the vacuous full-board over zero sports is unreachable via a parsed manifest', () => {
  // `.every` over an empty allow-list is vacuously true. A real cohort can never
  // hit this: the manifest schema requires a non-empty sportAllowList, so the gate
  // never mistakes an empty cohort for a full board. Documented so the degenerate
  // case is a conscious property, not an accidental hole.
  assert.equal(isFullBoardCohort([]), true);
});

test('policy isolation: enabling another sport later would not change MLB', () => {
  // The current policy only knows MLB; MLB eligibility depends solely on the
  // MLB entry, so a future NFL entry cannot alter these answers.
  assert.equal(marketPolicyEnabled('mlb', 'moneyline'), true);
  assert.equal(marketPolicyEnabled('mlb', 'total'), true);
  assert.equal(marketPolicyEnabled('mlb', 'spread'), false);
});

test('known-version guard: current version is recognized; unknown versions are rejected', () => {
  assert.equal(isMarketPolicyVersion(MARKET_POLICY_VERSION), true);
  assert.equal(isMarketPolicyVersion('market-policy-v2'), false);
  assert.equal(isMarketPolicyVersion('baselines-v0.2.0'), false);
  assert.ok((MARKET_POLICY_VERSIONS as readonly string[]).includes(MARKET_POLICY_VERSION));
  assert.throws(() => marketPolicyForVersion('market-policy-v2'), /unknown market policy version/);
  assert.throws(() => marketPolicyDigest('nope'), /unknown market policy version/);
});

test('recomputed digest is deterministic and pinned to the exact allow-list content', () => {
  const d1 = marketPolicyDigest(MARKET_POLICY_VERSION);
  const d2 = marketPolicyDigest(MARKET_POLICY_VERSION);
  assert.equal(d1, d2); // deterministic
  assert.equal(d1, MARKET_POLICY_DIGEST);
  assert.match(d1, /^[0-9a-f]{64}$/); // sha-256 hex
  assert.equal(d1, PINNED_DIGEST); // pinned golden — the policy bytes must not drift silently
  // Pins the exact enabled set: any silent edit to the allow-list breaks this,
  // forcing a conscious update (and, in production, a version bump).
  assert.equal(d1, sha256Hex(canonicalize({ mlb: ['moneyline', 'total'] })));
  // A different content produces a different digest.
  assert.notEqual(d1, sha256Hex(canonicalize({ mlb: ['moneyline', 'spread', 'total'] })));
});

test('policy registry is frozen at runtime — an adversarial cast cannot change eligibility', () => {
  assert.equal(marketPolicyEnabled('mlb', 'spread'), false);

  // Strip readonly through a mutable structural cast and try to enable the run line.
  const policy = marketPolicyForVersion(MARKET_POLICY_VERSION) as { mlb: string[] };
  assert.throws(() => policy.mlb.push('spread')); // frozen array → throws, no effect
  assert.throws(() => {
    (policy as unknown as Record<string, string[]>)['mlb'] = ['moneyline', 'spread', 'total'];
  }); // frozen object → cannot reassign a key

  // Eligibility is unchanged and the digest never split.
  assert.equal(marketPolicyEnabled('mlb', 'spread'), false);
  assert.equal(marketPolicyEnabled('mlb', 'moneyline'), true);
  assert.equal(marketPolicyEnabled('mlb', 'total'), true);
  assert.equal(marketPolicyEnabled('nfl', 'moneyline'), false); // unlisted stays disabled
  assert.equal(MARKET_POLICY_DIGEST, marketPolicyDigest(MARKET_POLICY_VERSION));
  assert.equal(MARKET_POLICY_DIGEST, PINNED_DIGEST);
});

test('the exported version registry is frozen — a casted push cannot forge a known version', () => {
  assert.throws(() => (MARKET_POLICY_VERSIONS as unknown as string[]).push('market-policy-v2'));
  assert.equal(isMarketPolicyVersion('market-policy-v2'), false);
});
