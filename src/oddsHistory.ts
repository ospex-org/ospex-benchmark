import { z } from 'zod';
import { instantMs, parseableOffsetInstant } from './time.js';
import type { MarketKey } from './types.js';

// Re-exported so existing consumers/tests that import `instantMs` from this module
// keep working; the canonical home is now `src/time.ts`.
export { instantMs } from './time.js';

/**
 * The independent `odds_history` read model (SPEC-line-open-evidence-model.md §1
 * ground truth; §5-V1 entry verification; §6 valid-history predicate). Pure and
 * I/O-free: it validates raw source rows FAIL-CLOSED and derives the two opening
 * quantities the runner and scorer need — the first two-sided appearance and the
 * as-of quote — off an independent read of `odds_history`, never trusting the
 * writer's intended behavior.
 *
 * `odds_history` is append-only (surrogate `id` PK, a GENERATED IDENTITY), the
 * writer appends only on a real change and only when a market is two-sided-valid,
 * and every detection/opener/as-of derivation filters `source = jsonodds`. It has
 * NO sport/network column — sport classification is a `games` identity join at
 * finalization (§6), not part of this read model.
 *
 * The concrete PostgREST fetch lands with its runtime caller (the detection
 * slice); this module is the fixture-testable core it applies to the fetched rows.
 */

/** The read-model version pinned in the manifest as `sourceQueryVersion` — it
 *  versions `validTwoSidedHistoryRowV1` (below) and the as-of query. */
export const SOURCE_QUERY_VERSION = 'source-query-v1';

// American odds: present, a safe non-zero integer (the DB column is an integer;
// null/absent, zero, or a fractional value is not a valid two-sided price).
const americanOddsSchema = z
  .number()
  .int()
  .safe()
  .refine((n) => n !== 0, { message: 'american odds must be a non-zero integer' });

// Decimal odds: a finite number strictly greater than 1 (a real payout multiple).
const decimalOddsSchema = z.number().finite().gt(1);

/**
 * `validTwoSidedHistoryRowV1` (§6), versioned by `SOURCE_QUERY_VERSION`. The
 * finalizer/runner re-parse every source row against this rather than trusting
 * the writer: `source === "jsonodds"`, a known market, a safe strictly-ordered
 * `id`, an offset-qualified `captured_at`, both American odds present/non-zero
 * integers, both decimal odds finite and > 1, and a `line` that is `null` for
 * moneyline and finite for spread/total.
 */
const validTwoSidedHistoryRowSchema = z
  .object({
    id: z.number().int().safe().positive(),
    jsonodds_id: z.string().min(1),
    market: z.enum(['moneyline', 'spread', 'total']),
    source: z.literal('jsonodds'),
    line: z.number().finite().nullable(),
    away_odds_american: americanOddsSchema,
    away_odds_decimal: decimalOddsSchema,
    home_odds_american: americanOddsSchema,
    home_odds_decimal: decimalOddsSchema,
    captured_at: parseableOffsetInstant,
  })
  .passthrough() // tolerate extra columns (sportspage_id, created_at, ...)
  .refine((r) => (r.market === 'moneyline' ? r.line === null : typeof r.line === 'number'), {
    message: 'line must be null for moneyline and a finite number for spread/total',
  });

/**
 * A validated two-sided `odds_history` row: DB fields (snake_case, mirroring the
 * columns) with the odds proven present, plus `captured_at_ms` — the derived
 * ms-precise sort key, computed once from the offset-validated `captured_at`.
 */
export interface TwoSidedHistoryRow {
  id: number;
  jsonodds_id: string;
  market: MarketKey;
  source: 'jsonodds';
  line: number | null;
  away_odds_american: number;
  away_odds_decimal: number;
  home_odds_american: number;
  home_odds_decimal: number;
  captured_at: string;
  captured_at_ms: number;
}

/** Fail-closed parse of ONE raw row: the validated two-sided row, or `null` if it
 *  is not a valid two-sided jsonodds quote. */
export function parseTwoSidedHistoryRow(raw: unknown): TwoSidedHistoryRow | null {
  const result = validTwoSidedHistoryRowSchema.safeParse(raw);
  if (!result.success) return null;
  const r = result.data;
  return {
    id: r.id,
    jsonodds_id: r.jsonodds_id,
    market: r.market,
    source: r.source,
    line: r.line,
    away_odds_american: r.away_odds_american,
    away_odds_decimal: r.away_odds_decimal,
    home_odds_american: r.home_odds_american,
    home_odds_decimal: r.home_odds_decimal,
    captured_at: r.captured_at,
    captured_at_ms: instantMs(r.captured_at), // schema guarantees a parseable instant -> never NaN
  };
}

/**
 * Fail-closed parse of a raw row array. Invalid rows are DROPPED (they are not
 * opportunities), and their count is reported so a caller can surface it rather
 * than silently truncating. Throws only if the body is not an array.
 */
export function parseTwoSidedHistoryRows(rawRows: unknown): { rows: TwoSidedHistoryRow[]; dropped: number } {
  const arr = z.array(z.unknown()).parse(rawRows);
  const rows: TwoSidedHistoryRow[] = [];
  let dropped = 0;
  for (const raw of arr) {
    const row = parseTwoSidedHistoryRow(raw);
    if (row === null) dropped += 1;
    else rows.push(row);
  }
  return { rows, dropped };
}

/**
 * The single total order over rows: `(captured_at_ms ASC, id ASC)`. Comparisons
 * are at MILLISECOND precision — the writer stamps ms and the column, though
 * µs-capable, is never exercised sub-ms (§1) — with `id` breaking equal-ms ties
 * that would otherwise resolve server-arbitrarily.
 */
function compareOrder(a: TwoSidedHistoryRow, b: TwoSidedHistoryRow): number {
  if (a.captured_at_ms !== b.captured_at_ms) return a.captured_at_ms < b.captured_at_ms ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Whether a row is within the frozen scoring watermark (`id <= watermark`); an
 *  `undefined` watermark imposes no upper bound (live runtime detection). Assumes
 *  the watermark was already validated by `requireValidWatermark`. */
function withinWatermark(row: TwoSidedHistoryRow, watermark: number | undefined): boolean {
  return watermark === undefined || row.id <= watermark;
}

/**
 * Validate a supplied scoring watermark BEFORE any row is evaluated. `undefined`
 * is the intentional unbounded live-runtime mode; a supplied value must be a safe
 * NONNEGATIVE integer — it is `MAX(odds_history.id)`, and ids start at 1, so a real
 * frozen watermark is `>= 1` while `0` is the coherent empty bound. A malformed
 * watermark FAILS CLOSED rather than flowing into `<=`: `NaN`/negative would
 * silently exclude every row (shrinking the denominator), `Infinity` would admit
 * post-watermark rows (defeating the case-40 frozen-watermark stability), and an
 * untyped `null`/string/object would coerce. Shared by both derivations so their
 * watermark semantics cannot drift. (Same fail-closed class as the `Date.parse`
 * NaN guard above — a load-bearing numeric boundary must never reach a comparator.)
 */
function requireValidWatermark(watermark: number | undefined): void {
  if (watermark === undefined) return;
  if (!Number.isSafeInteger(watermark) || watermark < 0) {
    throw new Error(`watermark must be undefined or a safe nonnegative integer, got ${String(watermark)}`);
  }
}

/** Fail-closed: the derivations operate on ONE `(jsonodds_id, market)` pair's
 *  history (the fetch filters by both). A mixed-pair array is a caller bug that
 *  would silently yield a cross-pair opener / as-of quote, so refuse it rather
 *  than return a wrong row. */
function assertSinglePair(rows: readonly TwoSidedHistoryRow[]): void {
  const pairs = new Set(rows.map((r) => `${r.jsonodds_id} ${r.market}`));
  if (pairs.size > 1) {
    throw new Error('odds_history derivation requires a single (jsonodds_id, market) pair');
  }
}

/**
 * The FIRST two-sided appearance of a pair (§1): the earliest row by
 * `(captured_at ASC, id ASC)` under the frozen scoring watermark. Rows must be a
 * single `(jsonodds_id, market)` pair's `source=jsonodds` history (the fetch
 * filters); returns `undefined` if none qualify.
 */
export function firstTwoSided(
  rows: readonly TwoSidedHistoryRow[],
  watermark?: number,
): TwoSidedHistoryRow | undefined {
  requireValidWatermark(watermark);
  assertSinglePair(rows);
  let best: TwoSidedHistoryRow | undefined;
  for (const row of rows) {
    if (!withinWatermark(row, watermark)) continue;
    if (best === undefined || compareOrder(row, best) < 0) best = row;
  }
  return best;
}

/**
 * The AS-OF quote at instant `t` (§1, §5-V1): the greatest `captured_at <= t` by
 * `(captured_at DESC, id DESC)`, under the frozen scoring watermark. `t` is an
 * offset-qualified instant; the `<= t` bound is inclusive at ms precision. The
 * exact live two-sided price at `t` (change-based ⇒ exact). Returns `undefined`
 * if no row is at or before `t`.
 */
export function asOfQuote(
  rows: readonly TwoSidedHistoryRow[],
  t: string,
  watermark?: number,
): TwoSidedHistoryRow | undefined {
  requireValidWatermark(watermark);
  assertSinglePair(rows);
  const tMs = instantMs(t);
  let best: TwoSidedHistoryRow | undefined;
  for (const row of rows) {
    if (!withinWatermark(row, watermark)) continue;
    if (row.captured_at_ms > tMs) continue; // captured_at <= t, inclusive
    if (best === undefined || compareOrder(row, best) > 0) best = row;
  }
  return best;
}

/** The V1 quote identity: `line` + both American odds (home-side spread
 *  convention, carried through from the source row unchanged). Decimal odds are
 *  validated but not part of the quote identity. */
export interface NormalizedQuote {
  line: number | null;
  away_odds_american: number;
  home_odds_american: number;
}

export function normalizeQuote(row: TwoSidedHistoryRow): NormalizedQuote {
  return {
    line: row.line,
    away_odds_american: row.away_odds_american,
    home_odds_american: row.home_odds_american,
  };
}

/** Exact equality of two normalized quotes (the V1 comparison). `null === null`
 *  handles a moneyline line. */
export function quotesEqual(a: NormalizedQuote, b: NormalizedQuote): boolean {
  return (
    a.line === b.line &&
    a.away_odds_american === b.away_odds_american &&
    a.home_odds_american === b.home_odds_american
  );
}
