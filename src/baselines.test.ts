import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BASELINE_POLICY_VERSION,
  BASELINE_POLICY_VERSIONS,
  isBaselinePolicyVersion,
  runBaselines,
} from './baselines.js';
import { makeRequest } from './testFactories.js';
import type { GameBundle, SlateBundle } from './types.js';

/**
 * Deterministic-baseline policy tests. The run-line fixtures deliberately
 * use REAL-shaped prices where the laying side carries the HIGHER decimal
 * (e.g. -1.5 @ 2.64 vs +1.5 @ 1.54), so the correct sign-based rule and a
 * wrong price-based rule produce DIFFERENT selections — a comparator test
 * only has teeth when the two disagree on its fixture.
 */

function slateWithRunLine(overrides: {
  line: number;
  awayDecimal: number;
  homeDecimal: number;
}): SlateBundle {
  const game = makeRequest('2026-07-12T16:15:00+00:00').game as GameBundle & {
    markets: { runLine: { line: number; awayHandicap: number; homeHandicap: number; awayDecimal: number; homeDecimal: number } };
  };
  game.markets.runLine.line = overrides.line;
  game.markets.runLine.homeHandicap = overrides.line;
  game.markets.runLine.awayHandicap = -overrides.line;
  game.markets.runLine.awayDecimal = overrides.awayDecimal;
  game.markets.runLine.homeDecimal = overrides.homeDecimal;
  return {
    schemaVersion: 1,
    label: 'SMOKE_V0_NOT_A_COHORT',
    league: 'mlb',
    slateDate: '2026-07-12',
    bundleTimestamp: '2026-07-12T14:05:00+00:00',
    cutoffAt: '2026-07-12T16:15:00+00:00',
    games: [game],
  } as SlateBundle;
}

function rlPair(slate: SlateBundle): { favorite: { selection: string; observedDecimal: number; line: number | null }; underdog: { selection: string; observedDecimal: number; line: number | null } } {
  const decisions = runBaselines(slate);
  const favorite = decisions.find((d) => d.participantId === 'baseline-favorite-rl');
  const underdog = decisions.find((d) => d.participantId === 'baseline-underdog-rl');
  assert.ok(favorite && underdog);
  return { favorite, underdog };
}

test('baselines-v0.1.0 derives exactly the six legacy policies', () => {
  const slate = slateWithRunLine({ line: -1.5, awayDecimal: 1.54054, homeDecimal: 2.64 });
  const decisions = runBaselines(slate, 'baselines-v0.1.0');
  assert.equal(decisions.length, 6);
  assert.deepEqual(
    decisions.map((d) => d.participantId).sort(),
    [
      'baseline-away-ml',
      'baseline-favorite-ml',
      'baseline-home-ml',
      'baseline-over-total',
      'baseline-under-total',
      'baseline-underdog-ml',
    ],
  );
  assert.ok(decisions.every((d) => d.policyVersion === 'baselines-v0.1.0'));
  assert.ok(decisions.every((d) => d.market !== 'spread'));
});

test('the current version appends the run-line pair and leaves the legacy six byte-identical', () => {
  const slate = slateWithRunLine({ line: -1.5, awayDecimal: 1.54054, homeDecimal: 2.64 });
  const v1 = runBaselines(slate, 'baselines-v0.1.0');
  const v2 = runBaselines(slate);
  assert.equal(BASELINE_POLICY_VERSION, 'baselines-v0.2.0');
  assert.equal(v2.length, 8);
  assert.ok(v2.every((d) => d.policyVersion === 'baselines-v0.2.0'));
  // The six legacy decisions are unchanged apart from the version stamp.
  const stripVersion = (d: (typeof v1)[number]): Omit<(typeof v1)[number], 'policyVersion'> => {
    const { policyVersion: _policyVersion, ...rest } = d;
    return rest;
  };
  assert.deepEqual(v2.slice(0, 6).map(stripVersion), v1.map(stripVersion));
});

test('run-line favorite is the LAYING side by handicap sign, never by price', () => {
  // Home lays (-1.5) at the HIGHER decimal — a price-based favorite rule
  // would pick the away side; the sign-based rule must pick home.
  const homeLays = rlPair(slateWithRunLine({ line: -1.5, awayDecimal: 1.54054, homeDecimal: 2.64 }));
  assert.equal(homeLays.favorite.selection, 'Pittsburgh Pirates');
  assert.equal(homeLays.favorite.observedDecimal, 2.64);
  assert.equal(homeLays.underdog.selection, 'Milwaukee Brewers');
  assert.equal(homeLays.underdog.observedDecimal, 1.54054);
  // Both rows carry the designated line (the home handicap).
  assert.equal(homeLays.favorite.line, -1.5);
  assert.equal(homeLays.underdog.line, -1.5);

  // Away lays (+1.5 home handicap) at the HIGHER decimal — same disagreement.
  const awayLays = rlPair(slateWithRunLine({ line: 1.5, awayDecimal: 2.6, homeDecimal: 1.55 }));
  assert.equal(awayLays.favorite.selection, 'Milwaukee Brewers');
  assert.equal(awayLays.favorite.observedDecimal, 2.6);
  assert.equal(awayLays.underdog.selection, 'Pittsburgh Pirates');

  // Price independence, directly: swap the prices and the selections hold.
  const swapped = rlPair(slateWithRunLine({ line: -1.5, awayDecimal: 2.64, homeDecimal: 1.54054 }));
  assert.equal(swapped.favorite.selection, 'Pittsburgh Pirates');
  assert.equal(swapped.favorite.observedDecimal, 1.54054);
});

test('a zero handicap (pick’em) breaks to home as the laying side', () => {
  const pickEm = rlPair(slateWithRunLine({ line: 0, awayDecimal: 1.9, homeDecimal: 1.9 }));
  assert.equal(pickEm.favorite.selection, 'Pittsburgh Pirates');
  assert.equal(pickEm.underdog.selection, 'Milwaukee Brewers');
});

test('version registry: known versions dispatch, unknown strings do not', () => {
  assert.deepEqual([...BASELINE_POLICY_VERSIONS], ['baselines-v0.1.0', 'baselines-v0.2.0']);
  assert.ok(isBaselinePolicyVersion('baselines-v0.1.0'));
  assert.ok(isBaselinePolicyVersion('baselines-v0.2.0'));
  assert.ok(!isBaselinePolicyVersion('baselines-v9.9.9'));
  assert.ok(!isBaselinePolicyVersion(''));
});
