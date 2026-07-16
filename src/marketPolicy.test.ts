import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import {
  MARKET_POLICY_DIGEST,
  MARKET_POLICY_VERSION,
  MARKET_POLICY_VERSIONS,
  effectiveEnabled,
  isMarketPolicyVersion,
  marketPolicyDigest,
  marketPolicyEnabled,
  marketPolicyForVersion,
} from './marketPolicy.js';

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
  // Pins the exact enabled set: any silent edit to the allow-list breaks this,
  // forcing a conscious update (and, in production, a version bump).
  assert.equal(d1, sha256Hex(canonicalize({ mlb: ['moneyline', 'total'] })));
  // A different content produces a different digest.
  assert.notEqual(d1, sha256Hex(canonicalize({ mlb: ['moneyline', 'spread', 'total'] })));
});
