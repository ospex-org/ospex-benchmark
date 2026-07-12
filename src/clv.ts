/**
 * Reference-closing CLV — pure math and classification, no I/O.
 *
 * Implements the methodology in docs/AGENT_BENCHMARK.md ("CLV methodology"):
 *
 * - Decision CLV compares the frozen entry price with the no-vig reference
 *   close of the exact same contract: `q_s` is the proportional no-vig
 *   closing probability of the selected side, and the primary metric is
 *   `reference_clv_pct = 100 * (D_e * q_s - 1)`. The entry price is NEVER
 *   de-vigged — it is the price actually offered.
 * - Price-only CLV is valid only at the same line. A moved spread/total
 *   makes primary CLV unavailable (never zero); favorable signed line
 *   movement is reported separately.
 * - Integer (push-capable) lines do not identify a push probability from
 *   two-sided prices: primary CLV is unavailable, and a separately labeled
 *   push-excluded conditional CLV is reported — never pooled with primary.
 * - Only `fresh`-confidence closes feed the primary metric (the market was
 *   still being polled at lock); stale or missing closes are unscored with
 *   stable reason codes.
 *
 * This is a SINGLE-source reference close, so the metric is always labeled
 * reference-closing CLV, not a universal market consensus.
 */

export type SelectedSide = 'away' | 'home';

export type UnscoredReason =
  | 'close_missing'
  | 'close_not_captured'
  | 'close_stale'
  | 'line_moved'
  | 'push_capable_line';

export interface CloseQuote {
  /** Closing line value (home handicap for spreads, total for totals; null for moneyline). */
  line: number | null;
  awayDecimal: number | null;
  homeDecimal: number | null;
  /** Proportional no-vig closing probabilities (sum to 1). */
  awayPNovig: number | null;
  homePNovig: number | null;
  confidence: 'fresh' | 'stale' | 'missing';
}

export interface AuxDiagnostics {
  /** Probability-scale movement: 100 * (q_s - 1/D_e). */
  probMovementPct: number;
  /** Raw same-side decimal-price ratio D_e / C_s (vig-in, diagnostic only). */
  priceRatio: number | null;
  logPriceRatio: number | null;
}

export interface ClvResult {
  /** Primary reference-closing CLV in expected-ROI percentage points, or null. */
  primaryClvPct: number | null;
  unscoredReason: UnscoredReason | null;
  /**
   * Push-excluded conditional CLV for integer lines — separately labeled,
   * never pooled with primary.
   */
  conditionalClvPct: number | null;
  /** Favorable signed line movement (spread/total, when the line moved). */
  lineMovementFavorable: number | null;
  /** q_s actually used (or that would have been used), when derivable. */
  closingPNovigSelected: number | null;
  aux: AuxDiagnostics | null;
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function selectedValues(
  close: CloseQuote,
  side: SelectedSide,
): { pNovig: number; decimal: number | null } | null {
  const pNovig = side === 'away' ? close.awayPNovig : close.homePNovig;
  if (pNovig === null) return null;
  const decimal = side === 'away' ? close.awayDecimal : close.homeDecimal;
  return { pNovig, decimal };
}

function auxDiagnostics(
  entryDecimal: number,
  pNovig: number,
  closeDecimal: number | null,
): AuxDiagnostics {
  return {
    probMovementPct: round4(100 * (pNovig - 1 / entryDecimal)),
    priceRatio: closeDecimal !== null && closeDecimal > 1 ? round4(entryDecimal / closeDecimal) : null,
    logPriceRatio:
      closeDecimal !== null && closeDecimal > 1 ? round4(Math.log(entryDecimal / closeDecimal)) : null,
  };
}

function unscored(
  reason: UnscoredReason,
  extras: Partial<ClvResult> = {},
): ClvResult {
  return {
    primaryClvPct: null,
    unscoredReason: reason,
    conditionalClvPct: null,
    lineMovementFavorable: null,
    closingPNovigSelected: null,
    aux: null,
    ...extras,
  };
}

/**
 * Favorable signed line movement from the selected side's perspective
 * (docs/AGENT_BENCHMARK.md "Spread and total line movement"):
 * - spread: entry_handicap - closing_handicap for the selected team
 *   (lines are stored as the HOME handicap; the away handicap is its negation);
 * - over: closing_total - entry_total; under: entry_total - closing_total.
 */
export function favorableLineMovement(
  market: 'spread' | 'total',
  selection: SelectedSide | 'over' | 'under',
  entryLine: number,
  closingLine: number,
): number {
  if (market === 'spread') {
    const entryHandicap = selection === 'home' ? entryLine : -entryLine;
    const closingHandicap = selection === 'home' ? closingLine : -closingLine;
    return round4(entryHandicap - closingHandicap);
  }
  return selection === 'over'
    ? round4(closingLine - entryLine)
    : round4(entryLine - closingLine);
}

/**
 * Score one decision against its close.
 *
 * @param market       decision market
 * @param side         selected side mapped onto the close's away/home columns
 *                     (totals: over = away column, under = home column)
 * @param entryDecimal frozen entry price D_e (vig-in, as offered)
 * @param entryLine    decision line (home-handicap spread / total; null for moneyline)
 * @param close        the captured reference close, or null if no row exists
 */
export function scoreDecision(
  market: 'moneyline' | 'spread' | 'total',
  side: SelectedSide,
  movementSelection: SelectedSide | 'over' | 'under',
  entryDecimal: number,
  entryLine: number | null,
  close: CloseQuote | null,
): ClvResult {
  if (close === null) return unscored('close_missing');
  if (close.confidence === 'missing') return unscored('close_not_captured');
  if (close.confidence === 'stale') return unscored('close_stale');

  const selected = selectedValues(close, side);
  if (selected === null) return unscored('close_not_captured');

  if (market !== 'moneyline') {
    if (entryLine === null || close.line === null) return unscored('close_not_captured');
    if (entryLine !== close.line) {
      // Price-only CLV is valid only at the same line: primary unavailable
      // (never zero), favorable movement reported separately.
      return unscored('line_moved', {
        lineMovementFavorable: favorableLineMovement(
          market,
          movementSelection,
          entryLine,
          close.line,
        ),
        closingPNovigSelected: round4(selected.pNovig),
      });
    }
    if (Number.isInteger(entryLine)) {
      // Push-capable contract: two-sided prices do not identify the push
      // probability. Conditional (push-excluded) CLV is separately labeled.
      return unscored('push_capable_line', {
        conditionalClvPct: round4(100 * (entryDecimal * selected.pNovig - 1)),
        closingPNovigSelected: round4(selected.pNovig),
        aux: auxDiagnostics(entryDecimal, selected.pNovig, selected.decimal),
      });
    }
  }

  const clv = 100 * (entryDecimal * selected.pNovig - 1);
  return {
    primaryClvPct: round4(clv),
    unscoredReason: null,
    conditionalClvPct: null,
    lineMovementFavorable: null,
    closingPNovigSelected: round4(selected.pNovig),
    aux: auxDiagnostics(entryDecimal, selected.pNovig, selected.decimal),
  };
}
