import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BASELINE_POLICY_VERSION,
  BASELINE_POLICY_VERSIONS,
  isBaselinePolicyVersion,
  runBaselines,
  type BaselinePolicyVersion,
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

type MarketBlockKey = 'moneyline' | 'runLine' | 'total';

/**
 * A slate whose single game carries only the named market blocks — the scoped
 * (1–2-market) shape S3 will make reachable, built by keeping just the present
 * blocks so the absent ones are omitted own properties (as a real scoped
 * request would carry them). Used to prove the full-board policies fail closed.
 */
function scopedSlate(present: ReadonlyArray<MarketBlockKey>): SlateBundle {
  const slate = slateWithRunLine({ line: -1.5, awayDecimal: 1.54054, homeDecimal: 2.64 });
  const game = slate.games[0]!;
  const fullBoard = game.markets;
  const scoped: Record<string, unknown> = {};
  for (const key of present) scoped[key] = fullBoard[key];
  (game as { markets: unknown }).markets = scoped;
  return slate;
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

// --- S2: baseline version isolation (SPEC-prepared-request.md §3, §5-S2) ---

// Every 1- and 2-market scoping (plus the zero-market degenerate) — none is a
// full board, so both full-board policies must fail closed on all of them.
const SCOPED_INPUTS: ReadonlyArray<ReadonlyArray<MarketBlockKey>> = [
  [],
  ['moneyline'],
  ['runLine'],
  ['total'],
  ['moneyline', 'runLine'],
  ['moneyline', 'total'],
  ['runLine', 'total'],
];

for (const present of SCOPED_INPUTS) {
  for (const version of ['baselines-v0.1.0', 'baselines-v0.2.0'] as const) {
    const label = present.length === 0 ? 'none' : present.join('+');
    test(`${version} fails closed on a scoped board [${label}] — never a partial set`, () => {
      assert.throws(
        () => runBaselines(scopedSlate(present), version),
        /requires a full three-market board/,
      );
    });
  }
}

test('runBaselines rejects an unknown policy version — fail closed, not a silent default', () => {
  const slate = slateWithRunLine({ line: -1.5, awayDecimal: 1.54054, homeDecimal: 2.64 });
  const asVersion = (v: string): BaselinePolicyVersion => v as unknown as BaselinePolicyVersion;
  assert.throws(() => runBaselines(slate, asVersion('baselines-v9.9.9')), /unknown baseline policy version/);
  assert.throws(() => runBaselines(slate, asVersion('')), /unknown baseline policy version/);
  // The registry-adjacent v0.3 string must NOT inherit v0.2 output through a
  // fall-through: it is unregistered at S2, so it is rejected. (S3 registers
  // v0.3 and gives it its own scoped branch; this row is re-homed there.)
  assert.throws(() => runBaselines(slate, asVersion('baselines-v0.3.0')), /unknown baseline policy version/);
});
