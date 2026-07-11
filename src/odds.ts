/**
 * American → decimal odds conversion.
 *
 * The upstream reference-odds snapshot stores American prices; the bundle and
 * the closing-line capture use decimal. Rounded to 5 decimal places to match
 * the closing capture's numeric(10,5) storage, so entry and close compare on
 * equal precision.
 */
export function americanToDecimal(american: number): number {
  if (!Number.isInteger(american) || Math.abs(american) < 100) {
    throw new Error(`not a valid American price: ${american}`);
  }
  const decimal = american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
  return Math.round(decimal * 1e5) / 1e5;
}
