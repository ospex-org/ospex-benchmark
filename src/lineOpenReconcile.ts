import { asOfQuote, normalizeQuote, quotesEqual } from './oddsHistory.js';
import type { NormalizedQuote, TwoSidedHistoryRow } from './oddsHistory.js';
import type { CurrentOddsRow, MarketKey } from './types.js';

/**
 * As-of reconciliation (SPEC-line-open-evidence-model.md §1 as-of quote; §5-V1
 * entry verification). Pure and I/O-free: decide whether the independent
 * `odds_history` as-of quote at the detection instant still matches the retained
 * `current_odds` reference quote for one `(gameId, market)` pair.
 *
 * This is the transient-reprice guard between opener evaluation and the fire seal:
 * a market may open cleanly, but if the price has since moved by the time it is
 * detected, the retained current-odds row no longer equals the history as-of quote
 * and the candidate must re-evaluate on a later tick rather than fire on drift.
 *
 * Both tables carry the SAME quote orientation (they are written from one source
 * tuple), so a direct `quotesEqual` over `(line, away_odds_american,
 * home_odds_american)` is the valid comparison. Timestamps (`captured_at`,
 * `changed_at`, `captured_at_ms`) are NEVER equality fields — only the quote
 * identity is. The empirical live cross-orientation query stays a pre-activation
 * gate; unit fixtures are self-consistent and cannot falsify a real divergence.
 */

/** Refuse a `current_odds` row that is missing an American price rather than
 *  coercing a null to `0` — a one-sided price is not a valid two-sided quote, and
 *  a coerced `0` would silently reconcile against a real quote. Fail closed. */
function normalizeCurrentRow(row: CurrentOddsRow): NormalizedQuote {
  if (row.away_odds_american === null || row.home_odds_american === null) {
    throw new Error(
      `current_odds row for (${row.jsonodds_id}, ${row.market}) is missing an american price`,
    );
  }
  return {
    // The `line` is carried through unchanged (null for moneyline, finite otherwise).
    line: row.line,
    away_odds_american: row.away_odds_american,
    home_odds_american: row.home_odds_american,
  };
}

/**
 * True iff the `odds_history` as-of quote at `detectedAt` equals the retained
 * `current_odds` reference quote for the expected `(gameId, market)` pair.
 *
 * THROWS (fail-closed integrity, never a data condition):
 *   - the current row does not bind to the expected `(gameId, market)` — a caller
 *     wiring bug that a same-valued quote from a crossed pair would otherwise let
 *     reconcile as a false positive;
 *   - the history rows are a MIXED pair (via `asOfQuote`'s `assertSinglePair`, run
 *     over the FULL array so the canonical guard stays load-bearing), or a
 *     homogeneous but FOREIGN pair (the expected-pair carrier bind below);
 *   - the current row is missing an American price (the private normalizer).
 *
 * Returns `false` (a data condition — re-evaluate later) when no history row is
 * at or before `detectedAt`, or when the as-of quote differs from the current
 * quote in any of `(line, away_odds_american, home_odds_american)`.
 */
export function reconcileAsOfVsCurrent(input: {
  readonly gameId: string;
  readonly market: MarketKey;
  readonly historyRows: readonly TwoSidedHistoryRow[];
  readonly historyWatermark: number | null;
  readonly detectedAt: string;
  readonly current: CurrentOddsRow;
}): boolean {
  const { gameId, market, historyRows, historyWatermark, detectedAt, current } = input;

  // Identity — the retained current row MUST be this exact candidate's own. A
  // same-valued quote from a different (gameId, market) would otherwise reconcile
  // as a false positive; this throw is the guard that makes that impossible.
  if (current.jsonodds_id !== gameId || current.market !== market) {
    throw new Error(
      `current_odds row (${current.jsonodds_id}, ${current.market}) does not bind to the expected candidate pair (${gameId}, ${market})`,
    );
  }

  // Run the as-of derivation over the FULL history array so `assertSinglePair`
  // (inside `asOfQuote`) stays load-bearing: a MIXED-pair history faults through
  // the canonical owner, and any selected as-of row therefore belongs to one pair.
  const asOf = asOfQuote(historyRows, detectedAt, historyWatermark ?? undefined);

  // Bind the homogeneous carrier to the expected pair EVEN WHEN no row qualifies
  // as-of. `assertSinglePair` proves the rows agree with each other, not that
  // their one pair equals the expected (gameId, market); without this, a
  // homogeneous FOREIGN-pair history with an identical quote could reconcile true.
  const historyPair = historyRows[0];
  if (
    historyPair !== undefined &&
    (historyPair.jsonodds_id !== gameId || historyPair.market !== market)
  ) {
    throw new Error(
      `history evidence (${historyPair.jsonodds_id}, ${historyPair.market}) does not bind to the expected candidate pair (${gameId}, ${market})`,
    );
  }

  if (asOf === undefined) return false;

  return quotesEqual(normalizeQuote(asOf), normalizeCurrentRow(current));
}
