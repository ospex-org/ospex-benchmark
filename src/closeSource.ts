/**
 * The one feed a captured close may come from.
 *
 * The benchmark's comparability rests on every close in a corpus being priced
 * by the SAME book at the SAME cutoff semantics. A corpus silently mixing two
 * feeds is not a worse measurement, it is a different measurement wearing the
 * same name — so this is a binding identity, enforced, not a default.
 *
 * Deliberately NOT reused from `oddsHistory.ts`, which enumerates the source of
 * `odds_history` rows — a different table with its own vocabulary. One shared
 * constant would weld two enumerations that are free to diverge.
 *
 * Measured on the captured corpus (2026-07-30): all 3609 rows of
 * `closing_lines` are `polygon / jsonodds`, so enforcing this refuses nothing
 * that exists today. It exists to keep it that way, and to make a new feed an
 * explicit decision rather than a silent blend.
 */
export const CLOSE_SOURCE = 'jsonodds';
