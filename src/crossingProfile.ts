import { deepFreeze } from './freeze.js';
import { SPEND_GUARD_PRICE_TABLE_VERSION, modelPriceTableDigest } from './modelPriceTable.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';
import type { RehearsalManifest } from './rehearsalManifest.js';
import { PROVIDER_ATTEMPT_RESERVATION_USD_MICROS } from './spendReservationPolicy.js';
import type { CohortManifestV1 } from './manifest.js';

/**
 * The PINNED one-fire crossing profile — the exact cohort shape the attended,
 * fixture-backed paid provider/store canary is authorized to run, and the ONLY
 * shape the gated billable capability producer will mint for. The rehearsal /
 * demo fixture's caps ($1000 spend cap, call cap 1000, 8 dispatches per tick) do
 * NOT represent a canary; the crossing runs one fire under these values:
 *
 *   roster 4 arms × (1 initial + 1 repair) = 8 max attempts = the call cap;
 *   $100 per-attempt reservation × 8 attempts = the $800 full-fire reservation
 *   = the cohort spend cap = the canary ceiling; one dispatch per tick.
 *
 * `$800` is the code-side full-fire RESERVATION ceiling, not an expected invoice —
 * the committed per-model worst-case proof bounds each real attempt well under
 * $100, and the runtime spend guard escalates (refusing settlement) on any
 * attempt that prices over the reservation. That worst-case is a function of the
 * per-attempt output-token cap, so the profile pins the cost DRIVERS too
 * (`maxOutputTokens`, `providerCallTimeoutMs`) — a cohort with the right caps but
 * an inflated output-token budget is not the profile the proof priced, and the
 * producer refuses it. The values are frozen literals, and
 * `buildCrossingManifest` refuses to build if the running code's roster, repair
 * capability, or reservation policy ever drifts from them — the pin fails loudly
 * at construction rather than producing a manifest that no longer means what the
 * profile says.
 */
export const CROSSING_PROFILE = deepFreeze({
  rosterSize: 4,
  maxRepairAttemptsPerArm: 1,
  /** rosterSize × (1 + maxRepairAttemptsPerArm) — every attempt the fire can send. */
  maxAttemptsPerFire: 8,
  providerAttemptReservationUsdMicros: 100_000_000,
  cohortSpendCapUsdMicros: 800_000_000,
  /**
   * The hard ceiling on ANY cohort spend cap the gated billable producer will
   * mint for. Equal to the one-fire reservation here; a cohort pinning a larger
   * spend cap cannot obtain billable adapter authority at all.
   */
  canaryCeilingUsdMicros: 800_000_000,
  cohortCallCap: 8,
  maxConcurrentProviderRequests: 4,
  maxDispatchesPerTick: 1,
  /** The per-attempt output-token cap the worst-case spend proof priced. */
  maxOutputTokens: 16_000,
  /** The production per-attempt provider timeout (real model calls take minutes). */
  providerCallTimeoutMs: 300_000,
} as const);

/**
 * The crossing-profile conformance check, shared by the tri-state live-intent
 * resolver (refuse BEFORE the attended confirmation) and the gated billable
 * capability producer (refuse at mint, trusting no upstream check). Returns a
 * violations array (empty = conformant), mirroring `validateManifestAgainstCode`.
 * Every comparison is an exact equality against the pinned profile — including
 * the conservative guard price-table identity (`SPEND_GUARD_PRICE_TABLE_VERSION`
 * + its recomputed digest), which the billable pre-claim gate in `runOneFire`
 * independently re-checks per fire.
 */
export function crossingPinViolations(manifest: CohortManifestV1): string[] {
  const violations: string[] = [];
  const check = (label: string, actual: number | string, pinned: number | string): void => {
    if (actual !== pinned) violations.push(`${label} (${actual}) != crossing pin (${pinned})`);
  };
  check('expectedArmRoster.length', manifest.expectedArmRoster.length, CROSSING_PROFILE.rosterSize);
  check(
    'constants.maxRepairAttemptsPerArm',
    manifest.constants.maxRepairAttemptsPerArm,
    CROSSING_PROFILE.maxRepairAttemptsPerArm,
  );
  check(
    'constants.providerAttemptReservationUsdMicros',
    manifest.constants.providerAttemptReservationUsdMicros,
    CROSSING_PROFILE.providerAttemptReservationUsdMicros,
  );
  check('cohortSpendCapUsdMicros', manifest.cohortSpendCapUsdMicros, CROSSING_PROFILE.cohortSpendCapUsdMicros);
  check('cohortCallCap', manifest.cohortCallCap, CROSSING_PROFILE.cohortCallCap);
  check(
    'constants.maxConcurrentProviderRequests',
    manifest.constants.maxConcurrentProviderRequests,
    CROSSING_PROFILE.maxConcurrentProviderRequests,
  );
  check(
    'constants.maxDispatchesPerTick',
    manifest.constants.maxDispatchesPerTick,
    CROSSING_PROFILE.maxDispatchesPerTick,
  );
  check('constants.maxOutputTokens', manifest.constants.maxOutputTokens, CROSSING_PROFILE.maxOutputTokens);
  check(
    'constants.providerCallTimeoutMs',
    manifest.constants.providerCallTimeoutMs,
    CROSSING_PROFILE.providerCallTimeoutMs,
  );
  check('modelPriceTableVersion', manifest.modelPriceTableVersion, SPEND_GUARD_PRICE_TABLE_VERSION);
  check(
    'modelPriceTableDigest',
    manifest.modelPriceTableDigest,
    modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION),
  );
  return violations;
}

/**
 * Build the pinned one-fire crossing manifest, now-relative like the rehearsal
 * manifest (the attended crossing anchors it immediately before its single
 * invocation). It flows through the same code-consistent builder — every
 * code-owned digest/version/roster field is imported from the running code — with
 * ALL crossing levers set from the pinned profile, and the conservative guard
 * price table (`SPEND_GUARD_PRICE_TABLE_VERSION`) pinned so a billable fire
 * passes the pre-claim price-identity gate. The provider timeout stays the production 300s value (real model
 * calls take minutes; the demo's 1s fast-timeout is a mock-only convenience).
 *
 * Construction is self-checking: the internal-consistency identities above
 * (attempts = roster × (1 + repairs) = call cap; reservation × attempts = spend
 * cap ≤ ceiling) and the built manifest's conformance to the pins are re-verified
 * here, so code drift (a roster or policy change) fails THIS builder loudly
 * instead of minting a manifest the crossing profile no longer describes.
 */
export function buildCrossingManifest(now: number): RehearsalManifest {
  const attempts = CROSSING_PROFILE.rosterSize * (1 + CROSSING_PROFILE.maxRepairAttemptsPerArm);
  const reserved = attempts * CROSSING_PROFILE.providerAttemptReservationUsdMicros;
  const consistency: string[] = [];
  if (attempts !== CROSSING_PROFILE.maxAttemptsPerFire) {
    consistency.push(
      `maxAttemptsPerFire (${CROSSING_PROFILE.maxAttemptsPerFire}) != roster × (1 + repairs) (${attempts})`,
    );
  }
  if (CROSSING_PROFILE.cohortCallCap !== CROSSING_PROFILE.maxAttemptsPerFire) {
    consistency.push(
      `cohortCallCap (${CROSSING_PROFILE.cohortCallCap}) != maxAttemptsPerFire (${CROSSING_PROFILE.maxAttemptsPerFire})`,
    );
  }
  if (reserved !== CROSSING_PROFILE.cohortSpendCapUsdMicros) {
    consistency.push(
      `cohortSpendCapUsdMicros (${CROSSING_PROFILE.cohortSpendCapUsdMicros}) != full-fire reservation (${reserved})`,
    );
  }
  if (CROSSING_PROFILE.cohortSpendCapUsdMicros > CROSSING_PROFILE.canaryCeilingUsdMicros) {
    consistency.push(
      `cohortSpendCapUsdMicros (${CROSSING_PROFILE.cohortSpendCapUsdMicros}) exceeds the canary ceiling ` +
        `(${CROSSING_PROFILE.canaryCeilingUsdMicros})`,
    );
  }
  if (PROVIDER_ATTEMPT_RESERVATION_USD_MICROS !== CROSSING_PROFILE.providerAttemptReservationUsdMicros) {
    consistency.push(
      `code per-attempt reservation (${PROVIDER_ATTEMPT_RESERVATION_USD_MICROS}) != crossing pin ` +
        `(${CROSSING_PROFILE.providerAttemptReservationUsdMicros})`,
    );
  }
  if (consistency.length > 0) {
    throw new Error(`crossing profile is internally inconsistent: ${consistency.join('; ')}`);
  }

  const built = buildRehearsalManifest(now, {
    maxConcurrentProviderRequests: CROSSING_PROFILE.maxConcurrentProviderRequests,
    maxDispatchesPerTick: CROSSING_PROFILE.maxDispatchesPerTick,
    cohortCallCap: CROSSING_PROFILE.cohortCallCap,
    cohortSpendCapUsdMicros: CROSSING_PROFILE.cohortSpendCapUsdMicros,
    modelPriceTableVersion: SPEND_GUARD_PRICE_TABLE_VERSION,
    providerCallTimeoutMs: CROSSING_PROFILE.providerCallTimeoutMs,
  });

  // Re-verify the BUILT manifest against the pins (roster size, repair cap, and the
  // per-attempt reservation come from running code, not from the levers above): if any
  // code-owned value drifted from the frozen profile, refuse to return the manifest.
  const violations = crossingPinViolations(built.manifest);
  if (violations.length > 0) {
    throw new Error(`built crossing manifest does not conform to the pinned profile: ${violations.join('; ')}`);
  }
  return built;
}
