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
 *   output, never a hidden choice. Two-outcome inverse solved by bisection
 *   on the insider fraction `z` (Σp(z) = 1; Σp(0) = √booksum > 1 and Σp is
 *   decreasing in z, so the root is bracketed).
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

/** Shin two-way de-vig; null on invalid quotes. */
export function shinTwoWay(
  selectedDecimal: number | null,
  oppositeDecimal: number | null,
): TwoWayProbabilities | null {
  if (selectedDecimal === null || oppositeDecimal === null) return null;
  if (!(selectedDecimal > 1) || !(oppositeDecimal > 1)) return null;
  const piSelected = 1 / selectedDecimal;
  const piOpposite = 1 / oppositeDecimal;
  const booksum = piSelected + piOpposite;
  // Without an overround there is no margin to attribute to insiders: z = 0
  // and Shin reduces to proportional normalization.
  if (!(booksum > 1)) {
    return { pSelected: piSelected / booksum, pOpposite: piOpposite / booksum };
  }
  const shinP = (pi: number, z: number): number =>
    (Math.sqrt(z * z + 4 * (1 - z) * ((pi * pi) / booksum)) - z) / (2 * (1 - z));
  const sum = (z: number): number => shinP(piSelected, z) + shinP(piOpposite, z);
  let lo = 0;
  let hi = 0.5;
  while (sum(hi) > 1 && hi < 0.999) hi = (1 + hi) / 2;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    if (sum(mid) > 1) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const z = (lo + hi) / 2;
  return { pSelected: shinP(piSelected, z), pOpposite: shinP(piOpposite, z) };
}
