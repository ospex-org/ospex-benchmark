import { isInt4NonNeg } from './constants.js';

/**
 * Pure derivation of the two store lease bounds (ms) from already-parsed manifest
 * constants, feeding `InitCohortBudgetRequest.{initialLeaseBoundMs, repairLeaseBoundMs}`.
 * The store DERIVES its lease magnitudes from these boot-pinned bounds, which are written
 * to nonnegative int4 columns — so a bound outside the int4 domain must fail HERE, before a
 * future store call, rather than reaching an `(…)::int` cast as a raw driver exception.
 *
 * The manifest's summands are only safe-integer-bounded (≤ 2^53−1), NOT int4-bounded, so
 * their sums can exceed the store column ceiling; this function is the checked-integer guard.
 * It is pure — no boot, store, clock, network, provider, environment, or filesystem access —
 * and it is non-activating on its own: the boot/store-initialization path owns invoking it,
 * where a throw becomes an operational boot refusal.
 */

export interface LeaseBoundInputs {
  readonly providerCallTimeoutMs: number;
  readonly maxClockSkewMs: number;
  readonly maxDispatchLagMs: number;
}

export interface LeaseBounds {
  readonly initialLeaseBoundMs: number;
  readonly repairLeaseBoundMs: number;
}

export type LeaseBoundField = 'repairLeaseBoundMs' | 'initialLeaseBoundMs';

/** A derived lease bound fell outside the nonnegative PostgreSQL int4 domain. */
export class LeaseBoundOutOfRangeError extends Error {
  constructor(
    readonly bound: LeaseBoundField,
    readonly value: number,
  ) {
    super(`${bound} is outside the nonnegative PostgreSQL int4 domain: ${value}`);
    this.name = 'LeaseBoundOutOfRangeError';
  }
}

/**
 * Derive `{ repairLeaseBoundMs, initialLeaseBoundMs }` from the three manifest constants:
 *   repairLeaseBoundMs  = providerCallTimeoutMs + maxClockSkewMs
 *   initialLeaseBoundMs = maxDispatchLagMs + repairLeaseBoundMs
 *
 * Validates the repair bound FIRST, then the initial bound (which reuses the validated
 * repair sum), so the diagnostic precedence is deterministic: a repair bound outside the
 * store domain throws for `repairLeaseBoundMs`; a valid repair with an out-of-domain initial
 * throws for `initialLeaseBoundMs`. Never clamps, saturates, wraps, or returns a partial
 * result. Caller precondition: the inputs came from the strictly-parsed manifest (provider
 * timeout + dispatch lag positive, clock skew nonnegative — all safe integers).
 */
export function deriveLeaseBounds(inputs: LeaseBoundInputs): LeaseBounds {
  const { providerCallTimeoutMs, maxClockSkewMs, maxDispatchLagMs } = inputs;

  const repairLeaseBoundMs = providerCallTimeoutMs + maxClockSkewMs;
  if (!isInt4NonNeg(repairLeaseBoundMs)) {
    throw new LeaseBoundOutOfRangeError('repairLeaseBoundMs', repairLeaseBoundMs);
  }

  const initialLeaseBoundMs = maxDispatchLagMs + repairLeaseBoundMs;
  if (!isInt4NonNeg(initialLeaseBoundMs)) {
    throw new LeaseBoundOutOfRangeError('initialLeaseBoundMs', initialLeaseBoundMs);
  }

  return { initialLeaseBoundMs, repairLeaseBoundMs };
}
