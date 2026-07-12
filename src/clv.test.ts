import assert from 'node:assert/strict';
import { test } from 'node:test';
import { favorableLineMovement, scoreDecision } from './clv.js';
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

test('moneyline primary CLV: 100 * (D_e * q_s - 1), entry never de-vigged', () => {
  // Entry 2.10 on the away side; the close is a coin flip (q_s = 0.5):
  // 100 * (2.10 * 0.5 - 1) = +5.0 — the entry price beat the no-vig close.
  const result = scoreDecision('moneyline', 'away', 'away', 2.1, null, close());
  assert.equal(result.primaryClvPct, 5.0);
  assert.equal(result.unscoredReason, null);
  assert.equal(result.closingPNovigSelected, 0.5);
  // aux: probability movement 100 * (0.5 - 1/2.1) = 2.381; price ratio 2.1/2.0.
  assert.ok(result.aux);
  assert.equal(result.aux.probMovementPct, 2.381);
  assert.equal(result.aux.priceRatio, 1.05);
});

test('moneyline negative CLV when the close moved against the entry', () => {
  const result = scoreDecision('moneyline', 'home', 'home', 1.8, null, close());
  assert.equal(result.primaryClvPct, -10.0);
});

test('missing/uncaptured/stale closes are unscored with distinct reasons', () => {
  assert.equal(scoreDecision('moneyline', 'away', 'away', 2.0, null, null).unscoredReason, 'close_missing');
  assert.equal(
    scoreDecision('moneyline', 'away', 'away', 2.0, null, close({ confidence: 'missing', awayPNovig: null, homePNovig: null })).unscoredReason,
    'close_not_captured',
  );
  const stale = scoreDecision('moneyline', 'away', 'away', 2.0, null, close({ confidence: 'stale' }));
  assert.equal(stale.unscoredReason, 'close_stale');
  assert.equal(stale.primaryClvPct, null);
});

test('half-run line at the unchanged line scores as binary', () => {
  const result = scoreDecision(
    'spread',
    'home',
    'home',
    2.0,
    -1.5,
    close({ line: -1.5, homePNovig: 0.55, awayPNovig: 0.45 }),
  );
  assert.equal(result.primaryClvPct, 10.0);
});

test('moved spread: primary unavailable (never zero), favorable movement from the selected side', () => {
  // Selected HOME at -1.5; it closed -2.5: home laid fewer runs than the
  // close demanded — favorable +1.0.
  const home = scoreDecision('spread', 'home', 'home', 2.0, -1.5, close({ line: -2.5 }));
  assert.equal(home.primaryClvPct, null);
  assert.equal(home.unscoredReason, 'line_moved');
  assert.equal(home.lineMovementFavorable, 1.0);
  // Selected AWAY at +1.5 (line -1.5); it closed +2.5 (line -2.5): away got
  // fewer points than the close gives — unfavorable -1.0.
  const away = scoreDecision('spread', 'away', 'away', 2.0, -1.5, close({ line: -2.5 }));
  assert.equal(away.lineMovementFavorable, -1.0);
});

test('moved total: over favorable when the total closed higher, under mirrored', () => {
  const over = scoreDecision('total', 'away', 'over', 1.9, 8.5, close({ line: 9 }));
  assert.equal(over.unscoredReason, 'line_moved');
  assert.equal(over.lineMovementFavorable, 0.5);
  const under = scoreDecision('total', 'home', 'under', 1.9, 8.5, close({ line: 9 }));
  assert.equal(under.lineMovementFavorable, -0.5);
});

test('integer (push-capable) line: primary unavailable, conditional CLV separately labeled', () => {
  const result = scoreDecision('total', 'away', 'over', 1.9, 8, close({ line: 8 }));
  assert.equal(result.primaryClvPct, null);
  assert.equal(result.unscoredReason, 'push_capable_line');
  // Push-excluded conditional: 100 * (1.9 * 0.5 - 1) = -5.
  assert.equal(result.conditionalClvPct, -5.0);
  assert.ok(result.aux);
});

test('favorableLineMovement unit cases', () => {
  assert.equal(favorableLineMovement('spread', 'home', -1.5, -2.5), 1.0);
  assert.equal(favorableLineMovement('spread', 'away', -1.5, -2.5), -1.0);
  assert.equal(favorableLineMovement('spread', 'away', 1.5, 2.5), 1.0);
  assert.equal(favorableLineMovement('total', 'over', 8.5, 9.5), 1.0);
  assert.equal(favorableLineMovement('total', 'under', 8.5, 9.5), -1.0);
});
