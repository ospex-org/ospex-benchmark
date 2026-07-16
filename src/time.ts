import { z } from 'zod';

/**
 * The canonical instant handling shared across the harness. Every timestamp that
 * feeds a comparison or sort key flows through here, so the whole codebase agrees
 * on "when" and applies the same fail-closed rules.
 *
 * The Zod schema is MODULE-PRIVATE and reached only through the functions below —
 * it is never exported. A shared, exported schema object is runtime-mutable (a
 * caller can strip `_def.checks` through an `as any` path) and shallow-freezing it
 * does not protect the nested `_def`, so exposing it would let a consumer defeat
 * the offset requirement and reintroduce host-timezone ambiguity. Consumers that
 * need the rule inside their own schema call `isParseableInstant` from a `refine`.
 */

// PRIVATE — never exported. An offset-less ISO string would be read by Date.parse
// in the host's LOCAL zone, so an explicit offset (`Z` or `+/-hh:mm`) is required.
const offsetInstant = z.string().datetime({ offset: true });

/**
 * Whether `iso` is an offset-qualified ISO-8601 instant that is genuinely
 * parseable. Both checks are required: zod's datetime regex validates offset
 * SYNTAX but not RANGE (it accepts e.g. `+99:99`, which Date.parse turns into NaN),
 * so a NaN can never pass. Use this inside a consumer's `refine` instead of
 * importing a shared mutable schema.
 */
export function isParseableInstant(iso: string): boolean {
  return offsetInstant.safeParse(iso).success && Number.isFinite(Date.parse(iso));
}

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
