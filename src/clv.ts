import { closeAfterStart, closeTiming, closeValueAfterLock, type CloseTiming } from './closeTiming.js';
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
 * - Close TIMING is gated from the row's own capture evidence. The recorded
 *   lock is the game's scheduled start as the schedule was known when the
 *   close was captured — a PREDICTION of first pitch, never ground truth.
 *   `close_after_start` refuses a close whose market was still being quoted
 *   by the feed AFTER that lock (a negative poll gap): the feed's own
 *   behaviour contradicts the recorded cutoff, so the row's pre-game status
 *   is not established and it is not evidence for any metric. It is a
 *   conservative refusal on ambiguous evidence rather than a finding of
 *   contamination — see `closeAfterStart` for the readings it cannot
 *   separate and the corpus counter-evidence. This is the negative-side
 *   bound on the same poll-gap quantity whose positive side the upstream
 *   freshness classification already bounds (that classification is
 *   one-sided and stamps arbitrarily negative gaps `fresh`, so this gate is
 *   the only thing that sees them).
 *
 * KNOWN LIMITATION, published rather than smoothed over: none of these
 * gates detects a start that moved EARLIER without the upstream capture
 * noticing. In that case the recorded lock, the schedule row it was copied
 * from, and the frozen bundle's scheduled start are all the SAME wrong
 * instant, so no comparison available to this module can separate them —
 * there is no second opinion in the data it reads. Closing that gap needs
 * an independent start-time source (the on-chain contest start served by
 * the public API, or a league schedule feed). Until one is wired, a close
 * passing these gates is not evidence that the game had not started.
 *
 * This is a SINGLE-source reference close, so the metrics are always
 * labeled reference-closing CLV, not a universal market consensus.
 */

export type SelectedSide = 'away' | 'home';

/**
 * CLOSE-QUALITY refusals, in gate order: properties of the captured close
 * alone, independent of which side or participant is being scored. Every
 * one of these refuses the exact-line metrics AND the totals ladder with
 * the SAME reason — ladder coverage can never diverge from exact-line
 * coverage on close quality.
 *
 * This array is the SINGLE SOURCE for that family: `UnscoredReason` is
 * derived from it, and the ladder builds both its own reason union and its
 * shared-gate membership from it. Adding a close-quality reason here wires
 * every consumer in one edit, with no hand-maintained copy left to fall
 * behind. (Before this was derived, the membership was a hand-maintained
 * runtime Set laundered through an `as` cast — a missed entry meant the
 * ladder scored a close the exact-line scorer had just refused.)
 *
 * What the compiler does NOT check is CLASSIFICATION. Moving a reason
 * between this array and `SELECTION_REASONS` type-checks cleanly and
 * silently changes whether the ladder honors it, because `UnscoredReason`
 * is the union of both. That is covered behaviourally instead: the tests
 * sweep every member of both arrays through `scoreTotalsLadder` and assert
 * which side of the shared gate it lands on.
 */
export const CLOSE_QUALITY_REASONS = [
  'close_missing',
  'close_not_captured',
  'close_stale',
  'close_timing_unusable',
  'close_after_start',
  'close_value_after_lock',
  'close_inconsistent',
] as const;

/** Refusals that depend on the SELECTED contract, not on close quality. */
export const SELECTION_REASONS = ['line_moved', 'push_capable_line'] as const;

export type CloseQualityReason = (typeof CLOSE_QUALITY_REASONS)[number];

export type UnscoredReason = CloseQualityReason | (typeof SELECTION_REASONS)[number];

/** Runtime membership test for the shared close-quality family. */
export function isCloseQualityReason(reason: UnscoredReason): reason is CloseQualityReason {
  return (CLOSE_QUALITY_REASONS as readonly string[]).includes(reason);
}

export interface CloseQuote {
  /** Closing line value (home handicap for spreads, total for totals; null for moneyline). */
  line: number | null;
  awayDecimal: number | null;
  homeDecimal: number | null;
  /** Proportional no-vig closing probabilities (sum to 1). */
  awayPNovig: number | null;
  homePNovig: number | null;
  confidence: 'fresh' | 'stale' | 'missing';
  /**
   * The capture cutoff this row represents — upstream, the game's scheduled
   * start as known at capture time. A prediction of first pitch, not ground
   * truth; carried so timing is judged from evidence rather than assumed.
   */
  lockTime: string;
  /** Instant of the quote the values came from (at or before `lockTime`). */
  valueCapturedAt: string | null;
  /** Last time the feed listed this market at all. */
  lastPolledAt: string | null;
  /**
   * `lockTime - lastPolledAt` in seconds. POSITIVE means the last sighting
   * preceded lock (the normal case; how far back is the upstream freshness
   * question). NEGATIVE means the feed was still quoting the market after
   * the recorded lock — see `closeAfterStart`.
   */
  pollGapSeconds: number | null;
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
 * THE `close_after_start` POLICY — the rationale behind the gate, which is
 * implemented in `closeTiming.ts` and re-exported at the bottom of this
 * module. Kept here because this is where the scorer applies it and where the
 * preregistered close policy points.
 *
 * The feed was still quoting this market AFTER the row's own recorded lock —
 * SELECTION-INDEPENDENT, like every other close-quality gate.
 *
 * The verdict is derived from the raw instants — `lastPolledAt` at or past
 * `lockTime` — and NOT from the stored `pollGapSeconds`, which is a derived
 * column a corrupt or forged row can contradict. A row whose gap disagrees
 * with its own instants is refused upstream as `close_timing_unusable`
 * rather than being judged on either.
 *
 * The threshold is a last poll at least 1000ms past the lock, not any
 * positive amount: `poll_gap_seconds` is stored at integer-second
 * granularity, so a poll a few hundred ms after lock rounds to a stored gap
 * of 0, and the tolerance absorbs exactly that quantisation. It does NOT
 * extend to `close_value_after_lock`, which compares direct timestamps and is
 * strict — one millisecond past the lock refuses.
 *
 * A last poll past the lock is a direct observation that the odds feed still
 * listed this market past its recorded cutoff.
 * At least three readings fit that observation, and the row does not
 * distinguish them: the game had not started (the recorded start is early
 * and the captured value is a genuine pre-game price); the feed quotes
 * in-play (so a value captured at that lock may be an in-play price); or the
 * feed simply had not yet dropped the game from its live snapshot (feed
 * hygiene, telling us nothing about the price at all).
 *
 * This is therefore a CONSERVATIVE refusal on ambiguous evidence, NOT a
 * finding that the row is contaminated — and the corpus carries real
 * counter-evidence: across every close `yarn audit:closes` enumerated, zero
 * rows have a `value_captured_at` post-dating their own lock, so on the rows
 * measured every refused row's price was recorded at or before its cutoff.
 * That audit's counts are a LOWER BOUND, not a census — it walks by identity
 * key, which cannot prove it observed every committed row. The refusal is
 * nonetheless the posture `closeQuoteInconsistent` already takes toward a
 * close whose two representations disagree: what is unestablished is not
 * scored, and the cost is published (`closeAfterStartRefused` on every run,
 * and the audit's rate over the closes it enumerated) rather than absorbed
 * silently.
 *
 * A null gap is NOT a refusal here: it means the market was never seen in
 * the snapshot at all, which the upstream freshness classification already
 * downgrades (`close_stale`).
 */
/**
 * Adapt a {@link CloseQuote} to the raw four-field shape the shared timing
 * validator takes. Exported so a caller can classify a close's timing
 * evidence once and pass the RESULT to the verdicts, rather than each verdict
 * re-parsing the same instants and possibly disagreeing.
 */
export function closeTimingOf(close: CloseQuote): CloseTiming {
  return closeTiming({
    lockTime: close.lockTime,
    valueCapturedAt: close.valueCapturedAt,
    lastPolledAt: close.lastPolledAt,
    pollGapSeconds: close.pollGapSeconds,
    confidence: close.confidence,
  });
}

export { closeAfterStart, closeValueAfterLock } from './closeTiming.js';

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
  // Adjacent to close_stale on purpose: both bound the SAME poll-gap
  // quantity, and the upstream classification bounds only its positive
  // side. Ordered ahead of the price-representation check because a row
  // whose cutoff semantics are unestablished is not a close whose prices
  // are worth cross-validating.
  // Timing evidence is VALIDATED before any timing verdict is read off it. A
  // row whose stored `poll_gap_seconds` contradicts its own instants, or whose
  // instants carry no explicit offset, establishes nothing — so it becomes a
  // typed, counted refusal rather than a `false` that reads as "fine". Both
  // verdicts below throw on unusable evidence, so this ordering is enforced by
  // the primitive and not merely by convention.
  const timing = closeTimingOf(close);
  if (timing.kind === 'unusable') return unscored('close_timing_unusable', entryExtras);
  if (closeAfterStart(timing)) return unscored('close_after_start', entryExtras);
  // The price we would score was recorded past the row's own cutoff. Distinct
  // from the gate above: that one asks whether the FEED was still listing the
  // market, this asks whether the VALUE post-dates the lock.
  if (closeValueAfterLock(timing)) return unscored('close_value_after_lock', entryExtras);

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
