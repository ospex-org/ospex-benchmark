import { deepFreeze } from './freeze.js';
import { CROSSING_PROFILE } from './crossingProfile.js';
import { SPEND_GUARD_PRICE_TABLE_VERSION, modelPriceTableDigest } from './modelPriceTable.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';
import { PROVIDER_ATTEMPT_RESERVATION_USD_MICROS } from './spendReservationPolicy.js';
import type { CohortManifestV1 } from './manifest.js';

/**
 * What a scheduled CAMPAIGN cohort may look like — the bounds the gated billable producer
 * enforces for a campaign, as distinct from the single-fire crossing profile.
 *
 * The crossing pinned every value exactly, because it authorized exactly one fire. A
 * campaign cannot: its size is the operator's decision. So the terms split in two.
 *
 * **Pinned exactly** — everything the committed spend accounting depends on. These are not
 * the operator's to choose, because changing them changes what the $100/attempt reservation
 * and its priced detection mean: the roster, the repair cap, the per-attempt reservation,
 * the conservative guard price table + digest, the output-token cap, and the provider
 * timeout. They are read from the crossing profile so there is ONE definition of the priced
 * attempt shape.
 *
 * **Bounded** — the campaign's own levers, each with a code-owned maximum so an operator
 * cannot arm an unbounded campaign by typing a large number into a manifest: the provider
 * call cap, the reservation spend cap, the concurrency limit, and dispatches per tick.
 *
 * ### Why the CALL cap is the real money lever
 *
 * `cohortSpendCapUsdMicros` bounds RESERVATIONS, not invoices. Each fire reserves
 * `roster × (1 + repairs) × $100 = $800` and — by the frozen decision that settlement never
 * reconciles an actual — that reservation is consumed in full even when the fire really cost
 * $0.19. A 100-fire campaign therefore needs an $80,000 reservation cap to admit its fires
 * while spending about $19. Reading the spend cap as a budget would be badly wrong.
 *
 * The quantity that tracks real money is the CALL cap: every provider call is one billable
 * attempt, and the observed cost of an attempt on the 2026-08-03 crossing was ~$0.046. So a
 * campaign is sized by calls, the spend cap is derived to be non-binding, and the arming
 * screen states both the observed-rate expectation and the committed conservative bound.
 */

/** Observed mean cost per real provider attempt on the 2026-08-03 attended crossing
 *  ($0.185434 over four attempts). An OBSERVATION for operator projection only — never an
 *  input to any guard, cap, or refusal. */
export const OBSERVED_USD_MICROS_PER_ATTEMPT = 46_359;

/** The committed conservative TOKEN worst case per attempt, from
 *  `docs/SPEND-BOUND-PROOF.md` ($252.836640 for a full 8-attempt fire, at the `prices-v4`
 *  guard rates). Search fees sit on top and are not all bounded before dispatch (see the
 *  proof doc). Also projection only. Re-derived from the pinned price table by
 *  `campaignProfile.test.ts`, so a guard-table change that does not reach this line is a
 *  failing test rather than a quietly stale projection — which is how it last drifted. */
export const CONSERVATIVE_USD_MICROS_PER_ATTEMPT = 31_604_580;

export const CAMPAIGN_BOUNDS = deepFreeze({
  /** Exactly pinned, from the single definition of the priced attempt shape. */
  rosterSize: CROSSING_PROFILE.rosterSize,
  maxRepairAttemptsPerArm: CROSSING_PROFILE.maxRepairAttemptsPerArm,
  providerAttemptReservationUsdMicros: CROSSING_PROFILE.providerAttemptReservationUsdMicros,
  maxOutputTokens: CROSSING_PROFILE.maxOutputTokens,
  providerCallTimeoutMs: CROSSING_PROFILE.providerCallTimeoutMs,

  /** Bounded levers. A campaign must reach at least one whole fire, and no more than these. */
  minCohortCallCap: CROSSING_PROFILE.maxAttemptsPerFire, // 8 = one fire's worth
  /** 4000 calls = 500 fires ≈ $185 at the observed per-attempt rate. Deliberately the
   *  tightest bound that still covers a full MLB month; raising it is a conscious,
   *  reviewable edit. */
  maxCohortCallCap: 4_000,
  /** The reservation cap must cover the call cap's fires and may not exceed this. */
  maxCohortSpendCapUsdMicros: 400_000_000_000, // 500 fires × $800 reservation
  /** At most two fires' worth of concurrent provider requests. */
  maxConcurrentProviderRequests: 2 * CROSSING_PROFILE.rosterSize,
  /** At most four admissions per tick; the store still arbitrates true concurrency. */
  maxDispatchesPerTick: 4,
} as const);

/**
 * The campaign conformance check the gated producer runs before minting billable adapters
 * for a scheduled campaign, and the arming CLI runs before writing an authorization. Returns
 * a violations array (empty = conformant), mirroring `validateManifestAgainstCode`.
 */
export function campaignBoundsViolations(manifest: CohortManifestV1): string[] {
  const violations: string[] = [];
  const exact = (label: string, actual: number | string, pinned: number | string): void => {
    if (actual !== pinned) violations.push(`${label} (${actual}) != campaign pin (${pinned})`);
  };
  const between = (label: string, actual: number, min: number, max: number): void => {
    if (actual < min || actual > max) {
      violations.push(`${label} (${actual}) is outside the campaign bound [${min}, ${max}]`);
    }
  };

  // Pinned — the priced attempt shape the spend proof depends on.
  exact('expectedArmRoster.length', manifest.expectedArmRoster.length, CAMPAIGN_BOUNDS.rosterSize);
  exact(
    'constants.maxRepairAttemptsPerArm',
    manifest.constants.maxRepairAttemptsPerArm,
    CAMPAIGN_BOUNDS.maxRepairAttemptsPerArm,
  );
  exact(
    'constants.providerAttemptReservationUsdMicros',
    manifest.constants.providerAttemptReservationUsdMicros,
    CAMPAIGN_BOUNDS.providerAttemptReservationUsdMicros,
  );
  exact('constants.maxOutputTokens', manifest.constants.maxOutputTokens, CAMPAIGN_BOUNDS.maxOutputTokens);
  exact(
    'constants.providerCallTimeoutMs',
    manifest.constants.providerCallTimeoutMs,
    CAMPAIGN_BOUNDS.providerCallTimeoutMs,
  );
  exact('modelPriceTableVersion', manifest.modelPriceTableVersion, SPEND_GUARD_PRICE_TABLE_VERSION);
  exact(
    'modelPriceTableDigest',
    manifest.modelPriceTableDigest,
    modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION),
  );
  // Re-assert the code-owned reservation amount independently of the crossing profile, so a
  // drift in either owner is caught rather than cancelling out.
  exact(
    'code per-attempt reservation',
    PROVIDER_ATTEMPT_RESERVATION_USD_MICROS,
    CAMPAIGN_BOUNDS.providerAttemptReservationUsdMicros,
  );

  // Bounded — the campaign's own levers.
  between('cohortCallCap', manifest.cohortCallCap, CAMPAIGN_BOUNDS.minCohortCallCap, CAMPAIGN_BOUNDS.maxCohortCallCap);
  between('cohortSpendCapUsdMicros', manifest.cohortSpendCapUsdMicros, 0, CAMPAIGN_BOUNDS.maxCohortSpendCapUsdMicros);
  between(
    'constants.maxConcurrentProviderRequests',
    manifest.constants.maxConcurrentProviderRequests,
    CAMPAIGN_BOUNDS.rosterSize,
    CAMPAIGN_BOUNDS.maxConcurrentProviderRequests,
  );
  between('constants.maxDispatchesPerTick', manifest.constants.maxDispatchesPerTick, 1, CAMPAIGN_BOUNDS.maxDispatchesPerTick);

  // Coherence: the reservation cap must actually cover the fires the call cap allows, or the
  // campaign stops on `spend_cap` long before its calls are used and the operator's stated
  // size is a fiction.
  const attemptsPerFire = CAMPAIGN_BOUNDS.rosterSize * (1 + CAMPAIGN_BOUNDS.maxRepairAttemptsPerArm);
  const firesAllowed = Math.floor(manifest.cohortCallCap / attemptsPerFire);
  const reservationNeeded = firesAllowed * attemptsPerFire * CAMPAIGN_BOUNDS.providerAttemptReservationUsdMicros;
  if (manifest.cohortSpendCapUsdMicros < reservationNeeded) {
    violations.push(
      `cohortSpendCapUsdMicros (${manifest.cohortSpendCapUsdMicros}) does not cover the ${firesAllowed} fire(s) ` +
        `the call cap allows (needs ${reservationNeeded} in reservations)`,
    );
  }
  return violations;
}

/**
 * Build a campaign manifest sized in CALLS — the lever that tracks real money — with the
 * reservation cap DERIVED rather than typed. An operator who says "800 calls" gets a cohort
 * whose reservation cap is exactly the 100 fires those calls allow, so the spend cap can
 * never silently bind before the call cap and the stated size can never be a fiction.
 *
 * Every priced-attempt term is pinned from the campaign bounds, and the window is
 * now-relative like every other generated manifest: `windowStart = now` (arm today, and by
 * `detected_before_window` nothing fires until it opens — pass a future `now` to start on a
 * chosen date) through `now + windowForwardMs`.
 */
export function buildCampaignManifest(
  now: number,
  options: { callCap: number; windowForwardMs: number; maxDispatchesPerTick?: number; maxConcurrentProviderRequests?: number },
): ReturnType<typeof buildRehearsalManifest> {
  const attemptsPerFire = CAMPAIGN_BOUNDS.rosterSize * (1 + CAMPAIGN_BOUNDS.maxRepairAttemptsPerArm);
  const fires = Math.floor(options.callCap / attemptsPerFire);
  const built = buildRehearsalManifest(now, {
    gameDiscoveryWindowHours: 1, // windowStart = now - 1h; the campaign starts at its anchor
    windowForwardMs: options.windowForwardMs,
    cohortCallCap: options.callCap,
    cohortSpendCapUsdMicros: fires * attemptsPerFire * CAMPAIGN_BOUNDS.providerAttemptReservationUsdMicros,
    maxConcurrentProviderRequests: options.maxConcurrentProviderRequests ?? CAMPAIGN_BOUNDS.rosterSize,
    maxDispatchesPerTick: options.maxDispatchesPerTick ?? 1,
    modelPriceTableVersion: SPEND_GUARD_PRICE_TABLE_VERSION,
    providerCallTimeoutMs: CAMPAIGN_BOUNDS.providerCallTimeoutMs,
  });
  const violations = campaignBoundsViolations(built.manifest);
  if (violations.length > 0) {
    throw new Error(`built campaign manifest does not conform to the campaign bounds: ${violations.join('; ')}`);
  }
  return built;
}

/** What a campaign of this size means in money, for the arming screen. Projection only. */
export interface CampaignCostProjection {
  readonly maxCalls: number;
  readonly maxFires: number;
  readonly observedUsdMicros: number;
  readonly conservativeUsdMicros: number;
}

/**
 * Project a campaign's cost from its call cap: the expected invoice at the rate actually
 * observed on the attended crossing, and the committed conservative worst case. Both are
 * shown at arming so the operator confirms against a real number rather than the $800-per-fire
 * reservation, which is not a budget.
 */
export function projectCampaignCost(manifest: CohortManifestV1): CampaignCostProjection {
  const attemptsPerFire = CAMPAIGN_BOUNDS.rosterSize * (1 + CAMPAIGN_BOUNDS.maxRepairAttemptsPerArm);
  const maxCalls = manifest.cohortCallCap;
  return Object.freeze({
    maxCalls,
    maxFires: Math.floor(maxCalls / attemptsPerFire),
    observedUsdMicros: maxCalls * OBSERVED_USD_MICROS_PER_ATTEMPT,
    conservativeUsdMicros: maxCalls * CONSERVATIVE_USD_MICROS_PER_ATTEMPT,
  });
}
