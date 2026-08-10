/**
 * The decimal scales the serving projection stores forecast numerics at, and
 * the quantiser that binds the pregame commitment to them.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * `benchmark_decisions.forecast_digest` is a commitment that a later reveal is
 * checked against, and the reveal lands in `benchmark_decision_reveals`, whose
 * numeric columns have FIXED SCALE. The response schema constrains those same
 * fields only by range — `z.number().min(0).max(1)` for a probability — so a
 * model may legitimately return more decimals than the column can hold. A model
 * that computes one chance in three returns 0.3333333333333333; that is an
 * ordinary output, not an exotic one.
 *
 * Hashing the unrounded value and storing the rounded one makes the commitment
 * unverifiable. Measured against PostgreSQL 16 with the projection's exact
 * column types, on a forecast the response validator accepts:
 *
 *   line             1.50004      -> 1.5000       numeric(10,4)
 *   observedDecimal  2.0537127    -> 2.053713     numeric(12,6)
 *   probability      0.523123456  -> 0.52312346   numeric(9,8)
 *   confidence       0.613712345  -> 0.61371235   numeric(9,8)
 *
 * The digest sealed before the game and the digest recomputed from the revealed
 * row did not match, and nothing anywhere reported a problem.
 *
 * ── WHAT IS DONE ABOUT IT ────────────────────────────────────────────────────
 *
 * The commitment is taken over the values AS THE PROJECTION WILL PUBLISH THEM.
 * Everything that reaches those columns is quantised here first, so PostgreSQL
 * never has to round anything and the round trip is exact by construction. Two
 * callers, and they must stay the same two: `projectionFingerprint()` in
 * `schema.ts`, which the digest hashes, and the reveal payload in
 * `servingStore.ts`, which is what gets stored. Both go through this module so
 * they cannot drift apart.
 *
 * This does not lose anything the commitment could have protected. A digest
 * over more precision than the reveal can carry commits to a value no reader
 * can ever check. The exact response body remains bound in full by
 * `responseSha256`, which is where full precision lives.
 *
 * ⚠ The rounding rule below is NOT required to agree with PostgreSQL's, and
 *   deliberately so: because the value handed to the driver is already at
 *   scale, PostgreSQL performs no rounding of its own and there is no second
 *   rule to match. What matters is only that this one is deterministic.
 */

/**
 * Scales copied from the projection's DDL. If a column's scale changes, this is
 * the one place to change — and every digest already published becomes
 * unverifiable, so it is a migration decision, not an edit.
 */
export const PROJECTION_SCALES = {
  /** `benchmark_decision_reveals.line numeric(10,4)` */
  line: 4,
  /** `benchmark_decision_reveals.observed_decimal numeric(12,6)` */
  observedDecimal: 6,
  /** `prob_win` / `prob_push` / `prob_loss`, all `numeric(9,8)` */
  probability: 8,
  /** `benchmark_decision_reveals.confidence numeric(9,8)` */
  confidence: 8,
} as const;

/**
 * A finite number rounded to `scale` decimal places, as the value that will be
 * both hashed and stored.
 *
 * Non-finite input is returned untouched rather than coerced: the response
 * schema already rejects NaN and Infinity, and if one ever arrives here the
 * canonical serialiser refuses it with a clearer message than a silent 0 would
 * ever produce.
 *
 * The result is round-trip safe. At these scales a value carries at most twelve
 * significant digits, well inside what a double represents exactly enough for
 * `String()` to return the same decimal — so hashing it, storing it, reading it
 * back and hashing it again gives the same bytes.
 */
export function quantizeForProjection(value: number, scale: number): number {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(scale));
}
