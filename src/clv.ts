import {
  PROPORTIONAL_DEVIG_METHOD,
  proportionalTwoWay,
  SHIN_DEVIG_METHOD,
  shinTwoWay,
} from './devig.js';

/**
 * Reference-closing CLV — pure math and classification, no I/O.
 *
 * Implements the methodology in docs/AGENT_BENCHMARK.md ("CLV methodology").
 * TWO metrics are computed side by side on every scoreable pick — one
 * formula, two entry prices:
 *
 * - ECONOMIC CLV (primary, the industry-standard reading): the frozen
 *   VIG-IN entry price against the no-vig reference close of the same
 *   contract — `100 * (D_e * q_s - 1)`. The entry price is never de-vigged
 *   for THIS metric: it is the price actually offered, so a flat market
 *   reads at about minus the vig by construction.
 * - MARGIN-ADJUSTED CLV (companion, always reported alongside — never a
 *   replacement): the same formula with the FAIR entry price derived from
 *   the proportionally de-vigged two-sided entry quote, which reduces to
 *   `100 * (q_close / q_entry - 1)` on push-free contracts. Zero means the
 *   forecast exactly matched the market; the bookmaker's margin is removed
 *   from BOTH ends, so it answers "was the forecast better than the
 *   market's?" rather than "would this ticket have made money?".
 * - De-vig methods are named and versioned (`proportional-v1` primary); a
 *   `shin-v1` SENSITIVITY variant of both metrics is recomputed from the
 *   raw two-sided quotes at entry and close and separately labeled — the
 *   proportional-vs-Shin choice is published, never hidden, and never
 *   primary.
 * - Price-only CLV is valid only at the same line. A moved spread/total
 *   makes both metrics unavailable (never zero); favorable signed line
 *   movement is reported separately.
 * - Integer (push-capable) lines do not identify a push probability from
 *   two-sided prices: both metrics are unavailable as primary, and
 *   separately labeled push-excluded conditional variants are reported —
 *   never pooled with primary.
 * - Only `fresh`-confidence closes feed the metrics (the market was still
 *   being polled at lock); stale or missing closes are unscored with
 *   stable reason codes.
 *
 * This is a SINGLE-source reference close, so the metrics are always
 * labeled reference-closing CLV, not a universal market consensus.
 */

export type SelectedSide = 'away' | 'home';

export type UnscoredReason =
  | 'close_missing'
  | 'close_not_captured'
  | 'close_stale'
  | 'close_inconsistent'
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

/**
 * Shin-de-vigged (`shin-v1`) sensitivity variants of both metrics,
 * recomputed from the raw two-sided quotes at entry and close. Separately
 * labeled; never pooled with the proportional-v1 primaries.
 */
export interface ShinSensitivity {
  devigMethod: typeof SHIN_DEVIG_METHOD;
  economicClvPct: number | null;
  economicConditionalClvPct: number | null;
  marginAdjustedClvPct: number | null;
  marginAdjustedConditionalClvPct: number | null;
  entryPShinSelected: number | null;
  closingPShinSelected: number | null;
}

export interface ClvResult {
  /** Primary ECONOMIC reference-closing CLV (vig-in entry), or null. */
  primaryClvPct: number | null;
  unscoredReason: UnscoredReason | null;
  /**
   * Push-excluded conditional ECONOMIC CLV for integer lines — separately
   * labeled, never pooled with primary.
   */
  conditionalClvPct: number | null;
  /** MARGIN-ADJUSTED CLV (proportionally de-vigged entry), or null. */
  marginAdjustedClvPct: number | null;
  /** Push-excluded conditional MARGIN-ADJUSTED CLV for integer lines. */
  marginAdjustedConditionalClvPct: number | null;
  /** Favorable signed line movement (spread/total, when the line moved). */
  lineMovementFavorable: number | null;
  /** q_s actually used (or that would have been used), when derivable. */
  closingPNovigSelected: number | null;
  /** Proportionally de-vigged ENTRY probability of the selected side. */
  entryPNovigSelected: number | null;
  /** shin-v1 sensitivity variants (null when nothing was scoreable). */
  sensitivity: ShinSensitivity | null;
  aux: AuxDiagnostics | null;
}

export { PROPORTIONAL_DEVIG_METHOD, SHIN_DEVIG_METHOD };

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

/**
 * Whole-close consistency validation — SELECTION-INDEPENDENT by design: the
 * same corrupt close must be refused for every participant and side, or
 * coverage itself becomes selection-dependent. Checks, in order:
 *
 * - the stored no-vig pair is complete (one side without the other is
 *   corruption; both absent falls through to close_not_captured);
 * - both probabilities are finite, within [0, 1], and sum to 1 within 1e-9
 *   (a p-only row with no raw quotes gets exactly this validation — a
 *   malformed stored pair must never enter any metric);
 * - raw closing quotes are present as a pair or not at all;
 * - when the raw pair exists, the canonical away/home proportional
 *   recompute must match BOTH stored probabilities within 1e-9 — the two
 *   representations describe the same close or the row is refused.
 */
function closeQuoteInconsistent(close: CloseQuote): boolean {
  const { awayPNovig: away, homePNovig: home, awayDecimal, homeDecimal } = close;
  if (away === null || home === null) {
    // One stored probability without the other is corruption; both absent
    // falls through to close_not_captured.
    return away !== home;
  }
  if (!Number.isFinite(away) || !Number.isFinite(home)) return true;
  if (away < 0 || away > 1 || home < 0 || home > 1) return true;
  if (Math.abs(away + home - 1) > 1e-9) return true;
  if ((awayDecimal === null) !== (homeDecimal === null)) return true;
  if (awayDecimal !== null && homeDecimal !== null) {
    const recomputed = proportionalTwoWay(awayDecimal, homeDecimal);
    if (recomputed === null) return true;
    if (
      Math.abs(recomputed.pSelected - away) > 1e-9 ||
      Math.abs(recomputed.pOpposite - home) > 1e-9
    ) {
      return true;
    }
  }
  return false;
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
    marginAdjustedClvPct: null,
    marginAdjustedConditionalClvPct: null,
    lineMovementFavorable: null,
    closingPNovigSelected: null,
    entryPNovigSelected: null,
    sensitivity: null,
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
 * @param market               decision market
 * @param side                 selected side mapped onto the close's away/home
 *                             columns (totals: over = away column, under =
 *                             home column)
 * @param movementSelection    selection label used for favorable-movement
 *                             signing
 * @param entryDecimal         frozen entry price D_e of the SELECTED side
 *                             (vig-in, as offered)
 * @param entryOppositeDecimal frozen entry price of the OPPOSITE side of the
 *                             same contract, from the same hash-verified
 *                             bundle — what the margin-adjusted entry de-vig
 *                             needs; null disables the margin-adjusted and
 *                             sensitivity outputs (never the economic ones)
 * @param entryLine            decision line (home-handicap spread / total;
 *                             null for moneyline)
 * @param close                the captured reference close, or null if no
 *                             row exists
 */
export function scoreDecision(
  market: 'moneyline' | 'spread' | 'total',
  side: SelectedSide,
  movementSelection: SelectedSide | 'over' | 'under',
  entryDecimal: number,
  entryOppositeDecimal: number | null,
  entryLine: number | null,
  close: CloseQuote | null,
): ClvResult {
  // The entry de-vig depends only on the frozen bundle, so it is recorded
  // even on unscored rows (exact-line and ladder methods reuse it later).
  const entryNovig = proportionalTwoWay(entryDecimal, entryOppositeDecimal);
  const entryExtras: Partial<ClvResult> =
    entryNovig === null ? {} : { entryPNovigSelected: round4(entryNovig.pSelected) };

  if (close === null) return unscored('close_missing', entryExtras);
  if (close.confidence === 'missing') return unscored('close_not_captured', entryExtras);
  if (close.confidence === 'stale') return unscored('close_stale', entryExtras);

  // Whole-close validation runs BEFORE side selection: a corrupt close is
  // not evidence for any metric, for any participant, on either side.
  // Scoring a disagreeing or malformed row would let the proportional
  // metrics (stored) and the shin sensitivity (raw) answer for different
  // closes — data corruption masquerading as scores.
  if (closeQuoteInconsistent(close)) return unscored('close_inconsistent', entryExtras);

  const selected = selectedValues(close, side);
  if (selected === null) return unscored('close_not_captured', entryExtras);

  const closeShin =
    side === 'away'
      ? shinTwoWay(close.awayDecimal, close.homeDecimal)
      : shinTwoWay(close.homeDecimal, close.awayDecimal);
  const entryShin = shinTwoWay(entryDecimal, entryOppositeDecimal);

  // One formula, two entry prices — and a shin-v1 recompute of both. The
  // margin-adjusted ratio form `q_close / q_entry - 1` is the push-free
  // specialization of `q_W * D_fair + q_P - 1` with D_fair = 1/q_entry.
  const economic = (qClose: number): number => round4(100 * (entryDecimal * qClose - 1));
  const marginAdjusted = (qClose: number, qEntry: number | null): number | null =>
    qEntry === null ? null : round4(100 * (qClose / qEntry - 1));
  const shinBlock = (conditional: boolean): ShinSensitivity => ({
    devigMethod: SHIN_DEVIG_METHOD,
    economicClvPct: conditional || closeShin === null ? null : economic(closeShin.pSelected),
    economicConditionalClvPct:
      conditional && closeShin !== null ? economic(closeShin.pSelected) : null,
    marginAdjustedClvPct:
      conditional || closeShin === null
        ? null
        : marginAdjusted(closeShin.pSelected, entryShin?.pSelected ?? null),
    marginAdjustedConditionalClvPct:
      conditional && closeShin !== null
        ? marginAdjusted(closeShin.pSelected, entryShin?.pSelected ?? null)
        : null,
    entryPShinSelected: entryShin === null ? null : round4(entryShin.pSelected),
    closingPShinSelected: closeShin === null ? null : round4(closeShin.pSelected),
  });

  if (market !== 'moneyline') {
    if (entryLine === null || close.line === null) return unscored('close_not_captured', entryExtras);
    if (entryLine !== close.line) {
      // Price-only CLV is valid only at the same line: both metrics
      // unavailable (never zero), favorable movement reported separately.
      return unscored('line_moved', {
        ...entryExtras,
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
      // probability. Both metrics report separately labeled push-excluded
      // conditional variants (the two-way de-vig of push-refund prices IS
      // the conditional-on-no-push split, at entry and at close alike).
      return unscored('push_capable_line', {
        ...entryExtras,
        conditionalClvPct: economic(selected.pNovig),
        marginAdjustedConditionalClvPct: marginAdjusted(
          selected.pNovig,
          entryNovig?.pSelected ?? null,
        ),
        closingPNovigSelected: round4(selected.pNovig),
        sensitivity: shinBlock(true),
        aux: auxDiagnostics(entryDecimal, selected.pNovig, selected.decimal),
      });
    }
  }

  return {
    primaryClvPct: economic(selected.pNovig),
    unscoredReason: null,
    conditionalClvPct: null,
    marginAdjustedClvPct: marginAdjusted(selected.pNovig, entryNovig?.pSelected ?? null),
    marginAdjustedConditionalClvPct: null,
    lineMovementFavorable: null,
    closingPNovigSelected: round4(selected.pNovig),
    entryPNovigSelected: entryNovig === null ? null : round4(entryNovig.pSelected),
    sensitivity: shinBlock(false),
    aux: auxDiagnostics(entryDecimal, selected.pNovig, selected.decimal),
  };
}
