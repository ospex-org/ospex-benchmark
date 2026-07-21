import { deepFreeze } from './freeze.js';

/**
 * Spend-reservation policy: a deliberately conservative, fixed per-attempt monetary
 * reservation whose only job is to protect the brokered cohort spend boundary. It is NOT
 * a fairness score and makes no claim of cross-provider token or cost equivalence — a
 * provider's token accounting, hidden templates, and billing differ and are disclosed,
 * never normalized. Each possible provider HTTP attempt reserves a flat
 * `providerAttemptReservationUsdMicros`; a fire reserves one such amount per attempt, and
 * the attempt count is `roster × (1 + maxRepairsPerArm)` — market count does not change it.
 *
 * The cohort manifest pins `spendReservationPolicyVersion` and the per-attempt amount
 * (directly under `constants`, so it is plainly visible in the hashed/public manifest);
 * canonical boot cross-checks the manifest amount against this code-owned value for the
 * recorded version. There is no separate digest — the single material scalar already rides
 * in the hashed manifest and `runnerCommitSha` pins the algorithm and public source, so a
 * digest of one visible number would add ceremony without new authentication.
 *
 * `$100` per attempt is intentionally far above any realistic single-call cost at the
 * current pinned rates (a `maxOutputTokens`-capped output bills well under $1; the
 * remainder covers millions of input tokens). It is an ADMINISTRATIVE reservation, not a
 * proof that a provider cannot invoice more; a reported or conservatively-derived actual
 * above the reservation is an invariant breach that hard-stops the cohort rather than being
 * clamped. Lowering the value is a later, versioned optimization once real cohorts are
 * observed — never a prerequisite to begin benchmarking.
 */
export const SPEND_RESERVATION_POLICY_VERSIONS = Object.freeze(['fixed-attempt-v1'] as const);
export type SpendReservationPolicyVersion = (typeof SPEND_RESERVATION_POLICY_VERSIONS)[number];

/** The spend-reservation policy version the harness stamps on NEW cohorts. */
export const SPEND_RESERVATION_POLICY_VERSION: SpendReservationPolicyVersion = 'fixed-attempt-v1';

/** The fixed reservation per possible provider HTTP attempt, in integer USD-micros ($100). */
export const PROVIDER_ATTEMPT_RESERVATION_USD_MICROS = 100_000_000;

export function isSpendReservationPolicyVersion(value: string): value is SpendReservationPolicyVersion {
  return (SPEND_RESERVATION_POLICY_VERSIONS as readonly string[]).includes(value);
}

/** One spend-reservation policy: the per-attempt reservation amount. Module-private shape. */
interface SpendReservationPolicy {
  readonly providerAttemptReservationUsdMicros: number;
}

const SPEND_RESERVATION_POLICY_V1: SpendReservationPolicy = {
  providerAttemptReservationUsdMicros: PROVIDER_ATTEMPT_RESERVATION_USD_MICROS,
};

/**
 * The version→policy registry, **deep-frozen** so neither the registry nor a policy's
 * amount can be mutated at runtime — `fixed-attempt-v1` denotes exactly one immutable value,
 * and the boot cross-check can never read a value that drifted after load.
 */
const SPEND_RESERVATION_POLICIES: Readonly<Record<SpendReservationPolicyVersion, SpendReservationPolicy>> =
  deepFreeze({ 'fixed-attempt-v1': SPEND_RESERVATION_POLICY_V1 });

/** The policy for a KNOWN version; throws on an unknown version (never a default). */
export function spendReservationPolicyForVersion(version: string): Readonly<SpendReservationPolicy> {
  if (!isSpendReservationPolicyVersion(version)) {
    throw new Error(`unknown spend reservation policy version: ${version}`);
  }
  return SPEND_RESERVATION_POLICIES[version];
}

/**
 * The fixed spend reservation for one fire, in USD-micros:
 * `roster × (1 + maxRepairsPerArm) × providerAttemptReservationUsdMicros`.
 *
 * Fail-closed on any out-of-domain operand: `rosterSize` must be a positive safe integer,
 * `maxRepairsPerArm` a nonnegative safe integer, and `version` a known policy. The product
 * is computed in `bigint`, range-checked against `Number.MAX_SAFE_INTEGER`, and converted
 * to `number` exactly once — so a value that could lose integer precision throws rather
 * than silently rounding. (The operand types are `number`/`string`, but the guards also
 * reject booleans, strings, coercible objects, `NaN`, and infinities smuggled through an
 * `as` cast, so a wrong runtime shape never coerces into a reservation.)
 */
export function deriveFireSpendReservationUsdMicros(input: {
  rosterSize: number;
  maxRepairsPerArm: number;
  version: string;
}): number {
  const { rosterSize, maxRepairsPerArm, version } = input;
  if (!isPositiveSafeInteger(rosterSize)) {
    throw new Error(`rosterSize must be a positive safe integer, got ${describe(rosterSize)}`);
  }
  if (!isNonnegativeSafeInteger(maxRepairsPerArm)) {
    throw new Error(`maxRepairsPerArm must be a nonnegative safe integer, got ${describe(maxRepairsPerArm)}`);
  }
  const policy = spendReservationPolicyForVersion(version); // unknown version throws
  const product =
    BigInt(rosterSize) *
    (1n + BigInt(maxRepairsPerArm)) *
    BigInt(policy.providerAttemptReservationUsdMicros);
  if (product > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`fire spend reservation ${product} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(product);
}

function isPositiveSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Describe a rejected operand for an error message WITHOUT coercing a hostile object. */
function describe(value: unknown): string {
  return typeof value === 'number' ? String(value) : typeof value;
}
