import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  closeAfterStart,
  closeTimingOf,
  CLOSE_QUALITY_REASONS,
  favorableLineMovement,
  isCloseQualityReason,
  scoreDecision,
  SELECTION_REASONS,
} from './clv.js';
import { proportionalTwoWay, shinTwoWay } from './devig.js';
import type { CloseQuote } from './clv.js';

// A HEALTHY close by default: the last feed sighting precedes the recorded
// lock (positive poll gap), so timing gates pass and every pre-existing
// price assertion below is unaffected by them.
/**
 * A COHERENT close. `pollGapSeconds` is the knob and `lastPolledAt` is DERIVED
 * from it (`lock - gap`), so a gap-only override still describes a row whose
 * stored gap agrees with its own instants — which is what the scorer now
 * requires before it will read a timing verdict off either.
 *
 * Passing `lastPolledAt` explicitly wins over the derivation; that is how the
 * incoherence tests build a self-contradicting row on purpose. The defaults
 * reproduce the previous literals exactly (lock 16:15:00, gap 15 → 16:14:45).
 */
function close(overrides: Partial<CloseQuote> = {}): CloseQuote {
  const base = {
    line: null,
    awayDecimal: 2.0,
    homeDecimal: 2.0,
    awayPNovig: 0.5,
    homePNovig: 0.5,
    confidence: 'fresh' as const,
    lockTime: '2026-07-12T16:15:00+00:00',
    valueCapturedAt: '2026-07-12T16:14:40+00:00',
    pollGapSeconds: 15,
    ...overrides,
  };
  // Tolerates a deliberately unparseable `lockTime` — the timing-evidence cases
  // supply one to prove the scorer refuses it, and the fixture must not die first.
  const lockMs = Date.parse(base.lockTime);
  const derivedLastPolled =
    base.pollGapSeconds === null || !Number.isFinite(lockMs)
      ? null
      : new Date(lockMs - base.pollGapSeconds * 1000).toISOString();
  return {
    ...base,
    lastPolledAt: 'lastPolledAt' in overrides ? (overrides.lastPolledAt ?? null) : derivedLastPolled,
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

test('a corrupt close is refused for EVERY participant and side — validation is selection-independent', () => {
  const refusedBothSides = (corrupt: ReturnType<typeof close>, label: string): void => {
    for (const side of ['away', 'home'] as const) {
      const result = scoreDecision('moneyline', side, side, 2.0, 1.9, null, corrupt);
      assert.equal(result.unscoredReason, 'close_inconsistent', `${label} (${side})`);
      assert.equal(result.primaryClvPct, null, `${label} (${side})`);
      assert.equal(result.marginAdjustedClvPct, null, `${label} (${side})`);
      assert.equal(result.conditionalClvPct, null, `${label} (${side})`);
      assert.equal(result.sensitivity, null, `${label} (${side})`);
    }
  };
  // The review repro: raw 2.0/2.0 with stored away 0.5 / home 0.9 — the
  // AWAY-side stored value matches the raw recompute, so a selected-side-
  // only check would score away picks (at 0) while refusing home picks.
  // The whole close is corrupt; both selections must be refused.
  refusedBothSides(close({ awayPNovig: 0.5, homePNovig: 0.9 }), 'unselected-side corruption');
  // Sums to 1 and in range, but BOTH sides disagree with the raw recompute
  // (2.0/2.0 → 0.5/0.5) — only the raw comparison catches this class.
  refusedBothSides(close({ awayPNovig: 0.6, homePNovig: 0.4 }), 'raw-vs-stored mismatch');
  // p-only rows (no raw quotes) get the full stored-pair validation: a
  // malformed pair must never enter any metric (this row previously scored
  // economic AND margin-adjusted at +80).
  refusedBothSides(
    close({ awayDecimal: null, homeDecimal: null, awayPNovig: 0.9, homePNovig: 0.9 }),
    'p-only pair does not sum to 1',
  );
  refusedBothSides(
    close({ awayDecimal: null, homeDecimal: null, awayPNovig: 1.2, homePNovig: -0.2 }),
    'p-only pair out of range',
  );
  // One stored probability without the other is corruption too.
  refusedBothSides(close({ awayPNovig: 0.5, homePNovig: null }), 'half-missing stored pair');
  // A VALID p-only pair still scores economically (legacy/degraded rows) —
  // it simply cannot pair for the shin sensitivity.
  const pOnly = scoreDecision(
    'moneyline',
    'away',
    'away',
    2.0,
    1.9,
    null,
    close({ awayDecimal: null, homeDecimal: null, awayPNovig: 0.4, homePNovig: 0.6 }),
  );
  assert.equal(pOnly.primaryClvPct, -20);
  assert.ok(pOnly.marginAdjustedClvPct !== null);
  assert.equal(pOnly.sensitivity?.economicClvPct ?? null, null);
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

// ---------------------------------------------------------------------------
// close_after_start — the negative-side bound on the poll gap
// ---------------------------------------------------------------------------

test('a close the feed was still quoting AFTER its own lock is refused (close_after_start)', () => {
  const refused = scoreDecision(
    'moneyline',
    'away',
    'away',
    2.1,
    1.8,
    null,
    close({ pollGapSeconds: -292 }),
  );
  assert.equal(refused.unscoredReason, 'close_after_start');
  // BOTH metrics are withheld together — the two variants share every
  // availability gate and are never gated independently.
  assert.equal(refused.primaryClvPct, null);
  assert.equal(refused.marginAdjustedClvPct, null);
  assert.equal(refused.conditionalClvPct, null);
  assert.equal(refused.marginAdjustedConditionalClvPct, null);
  assert.equal(refused.sensitivity, null);
  assert.equal(refused.aux, null);
  // The entry de-vig depends only on the frozen bundle and is still recorded.
  assert.equal(refused.entryPNovigSelected, 0.4615);

  // NEGATIVE CONTROL: the identical close with the gap's SIGN flipped scores.
  const accepted = scoreDecision(
    'moneyline',
    'away',
    'away',
    2.1,
    1.8,
    null,
    close({ pollGapSeconds: 292 }),
  );
  assert.equal(accepted.unscoredReason, null);
  assert.equal(accepted.primaryClvPct, 5.0);
  assert.ok(accepted.marginAdjustedClvPct !== null);
});

test('close_after_start sweeps the sign boundary and leaves a null gap to the freshness gate', () => {
  // The predicate is the SIGN of the gap, so the whole boundary is -1/0/+1.
  const at = (pollGapSeconds: number | null): string | null =>
    scoreDecision('moneyline', 'away', 'away', 2.1, 1.8, null, close({ pollGapSeconds }))
      .unscoredReason;
  assert.equal(at(-1), 'close_after_start', 'one second past lock is past lock');
  assert.equal(at(0), null, 'a gap of exactly zero is not AFTER the lock');
  assert.equal(at(1), null);
  assert.equal(at(-9700), 'close_after_start', 'the largest negative gap in the live corpus');
  assert.equal(at(89416), null, 'a hugely POSITIVE gap is the freshness gate’s business, not this one');
  // A null gap on a FRESH close is now a refusal, not a pass. `fresh` claims
  // the capture observed this market at a known instant, so a fresh row with
  // no poll timing contradicts its own confidence — and this previously
  // scored a full CLV with `unscoredReason: null` on the unverified
  // assumption that upstream would have downgraded it to stale.
  assert.equal(at(null), 'close_timing_unusable');
  assert.equal(
    scoreDecision(
      'moneyline',
      'away',
      'away',
      2.1,
      1.8,
      null,
      close({ pollGapSeconds: null, confidence: 'stale' }),
    ).unscoredReason,
    'close_stale',
  );
});

test('close-quality gate precedence is pinned: stale > after_start > inconsistent', () => {
  // A row can trip several gates at once; which reason it reports must be
  // deterministic, or the unscored histograms shift under refactors.
  const staleAndPostStart = close({ confidence: 'stale', pollGapSeconds: -300 });
  assert.equal(
    scoreDecision('moneyline', 'away', 'away', 2.1, 1.8, null, staleAndPostStart).unscoredReason,
    'close_stale',
  );
  // Post-start AND price-inconsistent (stored pair does not sum to 1):
  // the timing verdict wins — a row whose cutoff semantics are unestablished
  // is not a close whose prices are worth cross-validating.
  const postStartAndInconsistent = close({
    pollGapSeconds: -300,
    awayPNovig: 0.4,
    homePNovig: 0.4,
    awayDecimal: null,
    homeDecimal: null,
  });
  assert.equal(
    scoreDecision('moneyline', 'away', 'away', 2.1, 1.8, null, postStartAndInconsistent)
      .unscoredReason,
    'close_after_start',
  );
  // NEGATIVE CONTROL: with the gap made healthy, the SAME row falls through
  // to the price check — so the assertion above is about precedence, not
  // about close_inconsistent having stopped working. Rebuilt through the
  // fixture rather than spread-and-overridden: moving the gap alone would
  // leave `lastPolledAt` describing the OLD gap, and that contradiction is now
  // itself a refusal (`close_timing_unusable`), which would make this control
  // pass for the wrong reason.
  assert.equal(
    scoreDecision(
      'moneyline',
      'away',
      'away',
      2.1,
      1.8,
      null,
      close({ pollGapSeconds: 15, awayPNovig: 0.4, homePNovig: 0.4, awayDecimal: null, homeDecimal: null }),
    ).unscoredReason,
    'close_inconsistent',
  );
});

test('close_after_start is selection-independent: the same close is refused on both sides', () => {
  const row = close({ pollGapSeconds: -600, awayPNovig: 0.6, homePNovig: 0.4, awayDecimal: null, homeDecimal: null });
  for (const side of ['away', 'home'] as const) {
    const result = scoreDecision('moneyline', side, side, 2.1, 1.8, null, row);
    assert.equal(result.unscoredReason, 'close_after_start', `side ${side}`);
  }
  // ...and it outranks the SELECTION-dependent refusals, so a moved line on
  // a post-start close still reports the close-quality reason.
  const movedAndPostStart = scoreDecision('total', 'away', 'over', 1.9, 1.9, 8.5, {
    ...row,
    line: 9.5,
    awayPNovig: 0.5,
    homePNovig: 0.5,
  });
  assert.equal(movedAndPostStart.unscoredReason, 'close_after_start');
  assert.equal(movedAndPostStart.lineMovementFavorable, null);
});

test('the close-quality family is the declared list, in gate order, and excludes selection reasons', () => {
  // A PIN, not a guard: it makes a change to the vocabulary a conscious
  // edit. What actually enforces the classification is behavioural and
  // lives next door — the gate-precedence test above (order) and
  // ladder.test.ts (membership: every close-quality reason refuses the
  // ladder, every selection reason is still scored by it). The compiler
  // checks neither: `UnscoredReason` is the union of both arrays, so moving
  // a member between them type-checks cleanly.
  assert.deepEqual(
    [...CLOSE_QUALITY_REASONS],
    [
      'close_missing',
      'close_not_captured',
      'close_stale',
      'close_timing_unusable',
      'close_after_start',
      'close_value_after_lock',
      'close_inconsistent',
    ],
  );
  assert.deepEqual([...SELECTION_REASONS], ['line_moved', 'push_capable_line']);
  for (const reason of CLOSE_QUALITY_REASONS) {
    assert.equal(isCloseQualityReason(reason), true, reason);
  }
  for (const reason of SELECTION_REASONS) {
    assert.equal(isCloseQualityReason(reason), false, reason);
  }
});

test('closeAfterStart is derived from the raw instants, exported so consumers cannot re-derive it', () => {
  const timing = (o: Partial<CloseQuote> = {}) => closeTimingOf(close(o));
  // The boundary is unchanged from the legacy `gap < 0` predicate: a full
  // second past lock is past lock.
  assert.equal(closeAfterStart(timing({ pollGapSeconds: -1 })), true);
  assert.equal(closeAfterStart(timing({ pollGapSeconds: 0 })), false);
  assert.equal(closeAfterStart(timing({ pollGapSeconds: 1 })), false);
  // A null gap is "market never seen" — legitimate only on a non-fresh row,
  // which its own reason already refuses. On a fresh row it is now unusable.
  assert.equal(
    closeAfterStart(timing({ pollGapSeconds: null, confidence: 'stale' })),
    false,
  );
  assert.equal(timing({ pollGapSeconds: null }).kind, 'unusable', 'fresh + null gap');

  // The point of the change: the verdict follows the INSTANTS, not the stored
  // gap. A row whose gap claims the poll preceded lock while `last_polled_at`
  // says otherwise is not evidence — it is refused as unusable, and asking for
  // a verdict anyway throws rather than answering `false`.
  const forged = timing({ pollGapSeconds: 3600, lastPolledAt: '2026-07-12T18:15:00+00:00' });
  assert.equal(forged.kind, 'unusable');
  assert.throws(() => closeAfterStart(forged), /classify close_timing_unusable first/);

  // NEGATIVE CONTROL: the same contradiction removed — gap agrees with the
  // instants — is usable and refused on its merits, not on its unreadability.
  const honest = timing({ pollGapSeconds: -7200, lastPolledAt: '2026-07-12T18:15:00+00:00' });
  assert.equal(honest.kind, 'usable');
  assert.equal(closeAfterStart(honest), true);
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
    close({ line: -1.5, awayDecimal: 2.2, homeDecimal: 1.8, homePNovig: 0.55, awayPNovig: 0.45 }),
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
  // Stored probabilities at full float precision — the scorer validates them
  // against the raw quotes and refuses the row on any disagreement.
  const skewed = close({
    awayDecimal: 2.6,
    homeDecimal: 1.55,
    awayPNovig: 0.3734939759036145,
    homePNovig: 0.6265060240963857,
  });
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
  // Symmetric quotes: both methods agree at one half (closed form exact).
  const even = shinTwoWay(1.9, 1.9);
  assert.ok(even);
  assert.ok(Math.abs(even.pSelected - 0.5) < 1e-12);
  // A fair quote (booksum = 1) is in-domain with z = 0 exactly: Shin
  // coincides with proportional.
  const fair = shinTwoWay(2.0, 2.0);
  assert.ok(fair);
  assert.equal(fair.pSelected, 0.5);
  // DOMAIN: an underround has no insider fraction — shin-v1 refuses rather
  // than mislabeling another method (1/1.9 + 1/2.2 ≈ 0.981 < 1).
  assert.equal(shinTwoWay(1.9, 2.2), null);
  // Extreme boundary (near-degenerate overround, z → 1): the closed form
  // stays exact — outputs finite, in [0,1], summing to 1.
  const extreme = shinTwoWay(1.0001, 1.0001);
  assert.ok(extreme);
  assert.ok(Math.abs(extreme.pSelected - 0.5) < 1e-9);
  assert.ok(Math.abs(extreme.pSelected + extreme.pOpposite - 1) < 1e-9);
  const extremeAsym = shinTwoWay(1.0001, 50);
  assert.ok(extremeAsym);
  assert.ok(Math.abs(extremeAsym.pSelected + extremeAsym.pOpposite - 1) < 1e-9);
  assert.ok(extremeAsym.pSelected > 0.9 && extremeAsym.pOpposite < 0.1);
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

test('a close whose timing evidence is unusable is REFUSED, never scored on a verdict nothing established', () => {
  // A row whose stored gap claims the poll preceded lock while its own
  // `lastPolledAt` says it came two hours after. Previously this scored: the
  // gate read the gap alone, saw a positive value, and passed the row through
  // to a full CLV.
  const forged = close({ pollGapSeconds: 3600, lastPolledAt: '2026-07-12T18:15:00+00:00' });
  const result = scoreDecision('moneyline', 'away', 'away', 2.1, 1.8, null, forged);
  assert.equal(result.unscoredReason, 'close_timing_unusable');
  assert.equal(result.primaryClvPct, null);
  assert.equal(result.marginAdjustedClvPct, null);

  // NEGATIVE CONTROL: remove the contradiction and the same row scores, so
  // the assertion above is about the contradiction and not about the gate
  // having broken scoring outright.
  const honest = close({ pollGapSeconds: 15 });
  assert.equal(scoreDecision('moneyline', 'away', 'away', 2.1, 1.8, null, honest).unscoredReason, null);
});

test('a close whose VALUE post-dates its own lock is refused under its own reason', () => {
  const late = close({ valueCapturedAt: '2026-07-12T16:16:00+00:00' }); // lock is 16:15
  const result = scoreDecision('moneyline', 'away', 'away', 2.1, 1.8, null, late);
  assert.equal(result.unscoredReason, 'close_value_after_lock');
  assert.equal(result.primaryClvPct, null);
  // NEGATIVE CONTROL: captured before the lock is the normal case.
  assert.equal(
    scoreDecision('moneyline', 'away', 'away', 2.1, 1.8, null, close()).unscoredReason,
    null,
  );
});
