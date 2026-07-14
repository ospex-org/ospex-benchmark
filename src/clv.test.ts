import assert from 'node:assert/strict';
import { test } from 'node:test';
import { favorableLineMovement, scoreDecision } from './clv.js';
import { proportionalTwoWay, shinTwoWay } from './devig.js';
import type { CloseQuote } from './clv.js';

function close(overrides: Partial<CloseQuote> = {}): CloseQuote {
  return {
    line: null,
    awayDecimal: 2.0,
    homeDecimal: 2.0,
    awayPNovig: 0.5,
    homePNovig: 0.5,
    confidence: 'fresh',
    ...overrides,
  };
}

test('moneyline primary CLV: 100 * (D_e * q_s - 1), entry never de-vigged for the ECONOMIC metric', () => {
  // Entry 2.10 on the away side; the close is a coin flip (q_s = 0.5):
  // 100 * (2.10 * 0.5 - 1) = +5.0 — the entry price beat the no-vig close.
  const result = scoreDecision('moneyline', 'away', 'away', 2.1, 1.8, null, close());
  assert.equal(result.primaryClvPct, 5.0);
  assert.equal(result.unscoredReason, null);
  assert.equal(result.closingPNovigSelected, 0.5);
  // aux: probability movement 100 * (0.5 - 1/2.1) = 2.381; price ratio 2.1/2.0.
  assert.ok(result.aux);
  assert.equal(result.aux.probMovementPct, 2.381);
  assert.equal(result.aux.priceRatio, 1.05);
});

test('moneyline negative CLV when the close moved against the entry', () => {
  const result = scoreDecision('moneyline', 'home', 'home', 1.8, 2.1, null, close());
  assert.equal(result.primaryClvPct, -10.0);
});

test('margin-adjusted CLV is exactly ZERO when the market did not move — economic is minus the vig', () => {
  // Entry and close are the SAME two-sided quote (1.9 / 1.9, ~5.3% vig).
  // Economic reads the vig: 100 * (1.9 * 0.5 - 1) = -5. Margin-adjusted
  // de-vigs the entry too: q_entry = q_close = 0.5 → exactly 0 — "you
  // matched the market" finally reads as zero, not minus the vig.
  const result = scoreDecision('moneyline', 'away', 'away', 1.9, 1.9, null, close({ awayDecimal: 1.9, homeDecimal: 1.9 }));
  assert.equal(result.primaryClvPct, -5.0);
  assert.equal(result.marginAdjustedClvPct, 0);
  assert.equal(result.entryPNovigSelected, 0.5);
});

test('margin-adjusted CLV moves with the de-vigged entry, not the vig-in entry', () => {
  // Entry 2.0/1.9: q_entry = (1/2)/(1/2 + 1/1.9) = 0.4872. Close no-vig 0.5.
  // Economic: 100 * (2.0 * 0.5 - 1) = 0 (the vig-in price happens to match).
  // Margin-adjusted: 100 * (0.5/0.4872 - 1) = +2.6316 — the de-vigged
  // forecast beat the market. A wrong implementation that reuses the vig-in
  // entry (or de-vigs the close twice) lands at 0 here and fails.
  const result = scoreDecision('moneyline', 'away', 'away', 2.0, 1.9, null, close());
  assert.equal(result.primaryClvPct, 0);
  assert.equal(result.marginAdjustedClvPct, 2.6316);
  assert.equal(result.entryPNovigSelected, 0.4872);
});

test('missing/uncaptured/stale closes are unscored with distinct reasons; entry de-vig still recorded', () => {
  const missing = scoreDecision('moneyline', 'away', 'away', 2.0, 1.9, null, null);
  assert.equal(missing.unscoredReason, 'close_missing');
  assert.equal(missing.marginAdjustedClvPct, null);
  assert.equal(missing.entryPNovigSelected, 0.4872);
  assert.equal(
    scoreDecision('moneyline', 'away', 'away', 2.0, 1.9, null, close({ confidence: 'missing', awayPNovig: null, homePNovig: null })).unscoredReason,
    'close_not_captured',
  );
  const stale = scoreDecision('moneyline', 'away', 'away', 2.0, 1.9, null, close({ confidence: 'stale' }));
  assert.equal(stale.unscoredReason, 'close_stale');
  assert.equal(stale.primaryClvPct, null);
  assert.equal(stale.sensitivity, null);
});

test('a missing opposite-side entry price disables margin-adjusted output but never the economic metric', () => {
  const result = scoreDecision('moneyline', 'away', 'away', 2.1, null, null, close());
  assert.equal(result.primaryClvPct, 5.0);
  assert.equal(result.marginAdjustedClvPct, null);
  assert.equal(result.entryPNovigSelected, null);
});

test('half-run line at the unchanged line scores both metrics as binary', () => {
  const result = scoreDecision(
    'spread',
    'home',
    'home',
    2.0,
    1.9,
    -1.5,
    close({ line: -1.5, homePNovig: 0.55, awayPNovig: 0.45 }),
  );
  assert.equal(result.primaryClvPct, 10.0);
  // q_entry(home) = (1/2)/(1/2 + 1/1.9) = 0.4872 → 100*(0.55/0.4872 - 1).
  assert.equal(result.marginAdjustedClvPct, 12.8947);
});

test('moved spread: both metrics unavailable (never zero), favorable movement from the selected side', () => {
  // Selected HOME at -1.5; it closed -2.5: home laid fewer runs than the
  // close demanded — favorable +1.0.
  const home = scoreDecision('spread', 'home', 'home', 2.0, 1.9, -1.5, close({ line: -2.5 }));
  assert.equal(home.primaryClvPct, null);
  assert.equal(home.marginAdjustedClvPct, null);
  assert.equal(home.unscoredReason, 'line_moved');
  assert.equal(home.lineMovementFavorable, 1.0);
  assert.equal(home.entryPNovigSelected, 0.4872);
  // Selected AWAY at +1.5 (line -1.5); it closed +2.5 (line -2.5): away got
  // fewer points than the close gives — unfavorable -1.0.
  const away = scoreDecision('spread', 'away', 'away', 2.0, 1.9, -1.5, close({ line: -2.5 }));
  assert.equal(away.lineMovementFavorable, -1.0);
});

test('moved total: over favorable when the total closed higher, under mirrored', () => {
  const over = scoreDecision('total', 'away', 'over', 1.9, 1.9, 8.5, close({ line: 9 }));
  assert.equal(over.unscoredReason, 'line_moved');
  assert.equal(over.lineMovementFavorable, 0.5);
  const under = scoreDecision('total', 'home', 'under', 1.9, 1.9, 8.5, close({ line: 9 }));
  assert.equal(under.lineMovementFavorable, -0.5);
});

test('integer (push-capable) line: both metrics unavailable as primary, conditional variants separately labeled', () => {
  // ASYMMETRIC at the close on purpose: with q_cond_entry = 0.5 and
  // q_cond_close = 0.55 the conditional ratio's ORIENTATION is pinned —
  // swapping entry and close yields −9.0909, not +10 (a symmetric fixture
  // cannot tell the published formula from its inverse). The shin mirrors
  // are pinned from bisection goldens: shin(1.8, 2.2) selected = 0.5505.
  const result = scoreDecision(
    'total',
    'away',
    'over',
    1.9,
    1.9,
    8,
    close({ line: 8, awayDecimal: 1.8, homeDecimal: 2.2, awayPNovig: 0.55, homePNovig: 0.45 }),
  );
  assert.equal(result.primaryClvPct, null);
  assert.equal(result.marginAdjustedClvPct, null);
  assert.equal(result.unscoredReason, 'push_capable_line');
  // Push-excluded conditional, economic: 100 * (1.9 * 0.55 - 1) = 4.5.
  assert.equal(result.conditionalClvPct, 4.5);
  // Push-excluded conditional, margin-adjusted: 100 * (0.55/0.5 - 1) = 10.
  assert.equal(result.marginAdjustedConditionalClvPct, 10);
  assert.ok(result.sensitivity);
  assert.equal(result.sensitivity.economicClvPct, null);
  assert.equal(result.sensitivity.economicConditionalClvPct, 4.596);
  assert.equal(result.sensitivity.marginAdjustedConditionalClvPct, 10.101);
  assert.ok(result.aux);
});

test('integer line with symmetric unmoved quotes: margin-adjusted conditional is exactly zero', () => {
  const result = scoreDecision('total', 'away', 'over', 1.9, 1.9, 8, close({ line: 8, awayDecimal: 1.9, homeDecimal: 1.9 }));
  assert.equal(result.conditionalClvPct, -5.0);
  assert.equal(result.marginAdjustedConditionalClvPct, 0);
});

test('shin-v1 sensitivity: recomputed from raw quotes, labeled, and distinct from proportional on skewed prices', () => {
  // Skewed close (favorite 1.55 / longshot 2.6): Shin shifts probability
  // toward the favorite relative to proportional, so the two methods must
  // disagree here — a sensitivity block that silently fell back to
  // proportional would match primaryClvPct and fail these assertions.
  const skewed = close({ awayDecimal: 2.6, homeDecimal: 1.55, awayPNovig: 0.373494, homePNovig: 0.626506 });
  const result = scoreDecision('moneyline', 'home', 'home', 1.6, 2.5, null, skewed);
  assert.ok(result.sensitivity);
  assert.equal(result.sensitivity.devigMethod, 'shin-v1');
  // Golden values (bisection at 1e-12): shin(1.55, 2.6) = 0.630273 for the
  // favorite vs 0.626506 proportional.
  assert.equal(result.sensitivity.closingPShinSelected, 0.6303);
  assert.ok(result.primaryClvPct !== null && result.sensitivity.economicClvPct !== null);
  assert.notEqual(result.sensitivity.economicClvPct, result.primaryClvPct);
  assert.ok(result.sensitivity.economicClvPct > result.primaryClvPct);
  // Entry-side pins (goldens: shin(1.6, 2.5) selected = 0.6125): the shin
  // margin-adjusted value 100*(0.6303/0.6125 - 1) = 2.9017 pins WHICH entry
  // probability feeds the ratio — using the opposite side yields 62.65.
  assert.equal(result.sensitivity.entryPShinSelected, 0.6125);
  assert.equal(result.sensitivity.marginAdjustedClvPct, 2.9017);
});

test('devig methods: proportional and shin two-way properties', () => {
  // Proportional: exact normalization.
  const prop = proportionalTwoWay(1.55, 2.6);
  assert.ok(prop);
  assert.equal(Math.round(prop.pSelected * 1e6) / 1e6, 0.626506);
  assert.ok(Math.abs(prop.pSelected + prop.pOpposite - 1) < 1e-12);
  // Shin: sums to 1, corrects toward the favorite on skewed quotes.
  const shin = shinTwoWay(1.55, 2.6);
  assert.ok(shin);
  assert.ok(Math.abs(shin.pSelected + shin.pOpposite - 1) < 1e-9);
  assert.equal(Math.round(shin.pSelected * 1e6) / 1e6, 0.630273);
  assert.ok(shin.pSelected > prop.pSelected, 'shin must move probability toward the favorite');
  assert.ok(shin.pOpposite < prop.pOpposite, 'shin must take probability from the longshot');
  // Symmetric quotes: both methods agree at one half (shin numerically).
  const even = shinTwoWay(1.9, 1.9);
  assert.ok(even);
  assert.ok(Math.abs(even.pSelected - 0.5) < 1e-12);
  // No overround: shin reduces to proportional (z = 0, exact — the
  // booksum <= 1 branch normalizes directly without the bisection).
  const fair = shinTwoWay(2.0, 2.0);
  assert.ok(fair);
  assert.equal(fair.pSelected, 0.5);
  // Invalid quotes are refused, not guessed.
  assert.equal(shinTwoWay(1.0, 2.0), null);
  assert.equal(shinTwoWay(null, 2.0), null);
  assert.equal(proportionalTwoWay(0.9, 2.0), null);
});

test('favorableLineMovement unit cases', () => {
  assert.equal(favorableLineMovement('spread', 'home', -1.5, -2.5), 1.0);
  assert.equal(favorableLineMovement('spread', 'away', -1.5, -2.5), -1.0);
  assert.equal(favorableLineMovement('spread', 'away', 1.5, 2.5), 1.0);
  assert.equal(favorableLineMovement('total', 'over', 8.5, 9.5), 1.0);
  assert.equal(favorableLineMovement('total', 'under', 8.5, 9.5), -1.0);
});
