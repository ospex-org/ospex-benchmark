/**
 * Two-way de-vig methods — pure math, no I/O.
 *
 * The de-vig method is part of the published metric, so each method carries
 * a versioned name that is stamped on scored output:
 *
 * - `proportional-v1` (PRIMARY): divide each implied probability by the
 *   two-way booksum. Identical to the formula behind the production
 *   `closing_lines.away/home_p_novig` columns, so entry and close are
 *   de-vigged the same way.
 * - `shin-v1` (SENSITIVITY): Shin's insider-trading model — the bookmaker's
 *   margin defends against informed money, which is worth more on the
 *   longshot, so Shin removes MORE vig from the longshot side than
 *   proportional does. Published as a separately-labeled sensitivity variant
 *   so the proportional-vs-Shin methodology debate is inspectable in the
 *   output, never a hidden choice.
 *
 *   shin-v1 uses the exact two-outcome closed form for the insider fraction
 *   (Jullien–Salanié): with `s = (π₁² + π₂²)/B` and `d = π₁ − π₂`,
 *   `z = 1 + 2(s − 1)/(1 − d²)`, then
 *   `pᵢ = (√(z² + 4(1−z)πᵢ²/B) − z) / (2(1−z))`. Both `1 − d² > 0` and
 *   `z ∈ [0, 1)` hold for every overround pair of decimal quotes (> 1),
 *   because `s < max(πᵢ) < 1`.
 *
 *   DOMAIN — fail closed, never mislabel: shin-v1 is defined only for
 *   quotes with `booksum ≥ 1`. An underround (booksum < 1) has no insider
 *   fraction to attribute margin to, so shinTwoWay returns null rather than
 *   silently substituting another method under the shin-v1 label. A fair
 *   quote (booksum = 1) is in-domain with z = 0, where Shin coincides with
 *   proportional exactly. Outputs are validated (finite, within [0, 1],
 *   summing to 1 within 1e-9) and the pair is refused otherwise.
 *
 * Whether closing-line value should account for the bookmaker's margin at
 * all is a live, documented debate among bettors — the scorer publishes the
 * economic (vig-in entry) and margin-adjusted (de-vigged entry) metrics
 * side by side under the primary method, plus this sensitivity variant.
 */

export const PROPORTIONAL_DEVIG_METHOD = 'proportional-v1';
export const SHIN_DEVIG_METHOD = 'shin-v1';

export interface TwoWayProbabilities {
  pSelected: number;
  pOpposite: number;
}

/** Proportional (multiplicative) two-way de-vig; null on invalid quotes. */
export function proportionalTwoWay(
  selectedDecimal: number | null,
  oppositeDecimal: number | null,
): TwoWayProbabilities | null {
  if (selectedDecimal === null || oppositeDecimal === null) return null;
  if (!(selectedDecimal > 1) || !(oppositeDecimal > 1)) return null;
  const piSelected = 1 / selectedDecimal;
  const piOpposite = 1 / oppositeDecimal;
  const booksum = piSelected + piOpposite;
  if (!(booksum > 0)) return null;
  return { pSelected: piSelected / booksum, pOpposite: piOpposite / booksum };
}

/** Shin two-way de-vig; null on invalid quotes or out-of-domain booksums. */
export function shinTwoWay(
  selectedDecimal: number | null,
  oppositeDecimal: number | null,
): TwoWayProbabilities | null {
  if (selectedDecimal === null || oppositeDecimal === null) return null;
  if (!(selectedDecimal > 1) || !(oppositeDecimal > 1)) return null;
  const piSelected = 1 / selectedDecimal;
  const piOpposite = 1 / oppositeDecimal;
  const booksum = piSelected + piOpposite;
  // Underround: Shin's insider model is undefined (no margin to attribute).
  // Refuse rather than mislabel another method as shin-v1.
  if (booksum < 1) return null;
  const s = (piSelected * piSelected + piOpposite * piOpposite) / booksum;
  const d = piSelected - piOpposite;
  const z = Math.max(0, 1 + (2 * (s - 1)) / (1 - d * d));
  const shinP = (pi: number): number =>
    z >= 1
      ? Number.NaN
      : (Math.sqrt(z * z + 4 * (1 - z) * ((pi * pi) / booksum)) - z) / (2 * (1 - z));
  const pSelected = shinP(piSelected);
  const pOpposite = shinP(piOpposite);
  const valid =
    Number.isFinite(pSelected) &&
    Number.isFinite(pOpposite) &&
    pSelected >= 0 &&
    pSelected <= 1 &&
    pOpposite >= 0 &&
    pOpposite <= 1 &&
    Math.abs(pSelected + pOpposite - 1) <= 1e-9;
  if (!valid) return null;
  return { pSelected, pOpposite };
}
