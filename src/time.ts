import { z } from 'zod';

/**
 * The canonical instant handling shared across the harness. Every timestamp that
 * feeds a comparison or sort key flows through here, so the whole codebase agrees
 * on "when" and applies the same fail-closed rules.
 */

// An ISO-8601 instant with an explicit offset (`Z` or `+/-hh:mm`). An offset-less
// string would be read by Date.parse in the host's LOCAL zone — a host-timezone
// hazard — so a naive value is rejected.
export const offsetInstant = z.string().datetime({ offset: true });

// zod's datetime regex validates offset SYNTAX but not its RANGE — it accepts e.g.
// `+99:99`, which Date.parse then turns into NaN. Require the instant to be
// genuinely parseable so a NaN can never poison a comparison or sort key.
export const parseableOffsetInstant = offsetInstant.refine((s) => Number.isFinite(Date.parse(s)), {
  message: 'must be a parseable ISO-8601 instant',
});

/**
 * Parse an offset-qualified ISO-8601 instant to epoch ms, FAIL-CLOSED on a naive,
 * out-of-range-offset, or otherwise unparseable value. The single instant→ms
 * conversion used across the codebase, so every comparison shares one definition
 * of "when".
 */
export function instantMs(iso: string): number {
  if (!offsetInstant.safeParse(iso).success) {
    throw new Error(`timestamp "${iso}" must be an ISO-8601 instant with an explicit offset (Z or +/-hh:mm)`);
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new Error(`timestamp "${iso}" is not a parseable instant`);
  }
  return ms;
}
