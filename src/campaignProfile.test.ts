import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CAMPAIGN_BOUNDS,
  CONSERVATIVE_USD_MICROS_PER_ATTEMPT,
  buildCampaignManifest,
  campaignBoundsViolations,
  projectCampaignCost,
} from './campaignProfile.js';
import { SPEND_GUARD_PRICE_TABLE_VERSION, modelPriceTableForVersion } from './modelPriceTable.js';
import { CanaryAuthorizationError, assertCohortAdapterCapability, gateRealCampaignAdapterCapability } from './cohortAdapterCapability.js';
import type { CanaryAuthorization } from './cohortAdapterCapability.js';
import { cohortBoot } from './cohortBoot.js';
import type { BootedCohort } from './cohortBoot.js';
import { CROSSING_PROFILE, buildCrossingManifest } from './crossingProfile.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';
import type { CohortManifestV1 } from './manifest.js';
import { defaultExpectedArms } from './scoring.js';

/**
 * The campaign cohort SHAPE: the priced-attempt terms pinned exactly (they are what the
 * committed spend proof depends on), the campaign's own size levers bounded by code-owned
 * maxima, and the coherence rule that a stated size cannot be a fiction. Plus the gated
 * campaign producer, which shares every other check with the crossing producer.
 */

const NOW = Date.parse('2026-08-05T00:00:00.000Z');
const WEEK_MS = 7 * 24 * 3_600_000;
const ROSTER = defaultExpectedArms().map((a) => a.participantId);

const SYNTHETIC_PROVIDER_ENV: Record<string, string | undefined> = {
  OPENAI_API_KEY: 'synthetic-test-credential',
  ANTHROPIC_API_KEY: 'synthetic-test-credential',
  GEMINI_API_KEY: 'synthetic-test-credential',
  GOOGLE_API_KEY: undefined,
  XAI_API_KEY: 'synthetic-test-credential',
};

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A conformant campaign: 800 calls = 100 fires, reservation cap derived. */
function campaignManifest(over: Parameters<typeof buildCampaignManifest>[1] = { callCap: 800, windowForwardMs: WEEK_MS }): {
  manifest: CohortManifestV1;
  bytes: string;
} {
  return buildCampaignManifest(NOW, over);
}

function bootedCampaign(): BootedCohort {
  return cohortBoot({ manifestBytes: campaignManifest().bytes });
}

function authorizationFor(booted: BootedCohort, over: Partial<Record<keyof CanaryAuthorization, unknown>> = {}): CanaryAuthorization {
  const roster = booted.manifest.expectedArmRoster.map((a) => a.participantId);
  return {
    cohortId: booted.cohortId,
    participantIds: roster,
    modelPriceTableVersion: booted.manifest.modelPriceTableVersion,
    modelPriceTableDigest: booted.manifest.modelPriceTableDigest,
    liveOptIn: true,
    observedCredentialedParticipantIds: roster,
    cohortSpendCapUsdMicros: booted.manifest.cohortSpendCapUsdMicros,
    cohortCallCap: booted.manifest.cohortCallCap,
    maxConcurrentProviderRequests: booted.manifest.constants.maxConcurrentProviderRequests,
    maxDispatchesPerTick: booted.manifest.constants.maxDispatchesPerTick,
    maxRepairAttemptsPerArm: booted.manifest.constants.maxRepairAttemptsPerArm,
    ...over,
  } as CanaryAuthorization;
}

// ===========================================================================

test('a built campaign manifest boots, conforms, and derives its reservation cap from the CALL cap', () => {
  const { manifest, bytes } = campaignManifest();
  assert.doesNotThrow(() => cohortBoot({ manifestBytes: bytes }));
  assert.deepEqual(campaignBoundsViolations(manifest), []);
  assert.equal(manifest.cohortCallCap, 800);
  // 800 calls / 8 per fire = 100 fires; each reserves $800.
  assert.equal(manifest.cohortSpendCapUsdMicros, 100 * 800_000_000);
  // The priced-attempt shape is pinned, not the operator's to choose.
  assert.equal(manifest.constants.providerAttemptReservationUsdMicros, 100_000_000);
  assert.equal(manifest.constants.maxOutputTokens, 16_000);
  assert.equal(manifest.constants.providerCallTimeoutMs, 300_000);
  assert.equal(manifest.modelPriceTableVersion, 'prices-v4');
});

test('cost projection is stated in CALLS, both at the observed rate and the committed conservative bound', () => {
  const projection = projectCampaignCost(campaignManifest().manifest);
  assert.deepEqual(
    { ...projection },
    {
      maxCalls: 800,
      maxFires: 100,
      // 800 × the crossing's observed $0.046359/attempt ≈ $37; 800 × $31.60 conservative.
      observedUsdMicros: 800 * 46_359,
      conservativeUsdMicros: 800 * 31_604_580,
    },
  );
  // The reservation cap is NOT the budget: it is ~2000x the observed expectation.
  assert.ok(campaignManifest().manifest.cohortSpendCapUsdMicros > projection.observedUsdMicros * 1_000);
});

test('the conservative projection is RE-DERIVED from the pinned guard table, so a rate change cannot leave it stale', () => {
  // This constant is a hand-carried figure from docs/SPEND-BOUND-PROOF.md, and it drifted
  // exactly that way once: the guard table moved to prices-v4 while the projection kept
  // quoting the prices-v3 bound, under-reporting an 800-call campaign by 13%. Recomputing
  // it from the table the guard actually pins turns the next such change into a red test.
  //
  // What this pins is the ARITHMETIC against the live rates, NOT the envelopes: the token
  // bounds and the per-model worst-case SHAPES below are the proof doc's, so an envelope
  // that is wrong there is wrong here too. It is the price-table half that moves.
  const table = modelPriceTableForVersion(SPEND_GUARD_PRICE_TABLE_VERSION);
  const cost = (tokens: number, ratePerMillion: number) => (tokens * ratePerMillion) / 1_000_000;
  const openai = table['gpt-5.6-sol']!;
  const anthropic = table['claude-fable-5']!;
  const google = table['gemini-3.1-pro-preview']!;
  const xai = table['grok-4.5']!;

  const worstCaseOneAttemptEachModel =
    // OpenAI: full context in, max output out.
    cost(1_050_000, openai.inputUsdMicrosPerMillionTokens) +
    cost(128_000, openai.outputUsdMicrosPerMillionTokens) +
    // Anthropic: the whole context treated as cache creation, which is priced at the
    // OUTPUT rate — so both terms carry the output rate, not the input one.
    cost(1_000_000, anthropic.outputUsdMicrosPerMillionTokens) +
    cost(128_000, anthropic.outputUsdMicrosPerMillionTokens) +
    // Google: thinking tokens are additive and bill at the output rate.
    cost(1_048_576, google.inputUsdMicrosPerMillionTokens) +
    cost(1_048_576 + 65_536, google.outputUsdMicrosPerMillionTokens) +
    // xAI: reasoning is additive within the model's own 500K envelope.
    cost(500_000, xai.inputUsdMicrosPerMillionTokens) +
    cost(500_000, xai.outputUsdMicrosPerMillionTokens);

  const perFire = worstCaseOneAttemptEachModel * (CROSSING_PROFILE.maxAttemptsPerFire / defaultExpectedArms().length);
  assert.equal(perFire, 252_836_640, 'the committed whole-fire bound in SPEND-BOUND-PROOF.md');
  assert.equal(CONSERVATIVE_USD_MICROS_PER_ATTEMPT, perFire / CROSSING_PROFILE.maxAttemptsPerFire);
  // And it is strictly dearer than the prices-v3 figure it replaced, so restoring the old
  // literal fails here rather than passing as "some number the table produces".
  assert.ok(CONSERVATIVE_USD_MICROS_PER_ATTEMPT > 27_363_330);
});

test('the priced-attempt terms are pinned EXACTLY — each drift is a named violation', () => {
  const base = campaignManifest().manifest;
  const cases: readonly [string, CohortManifestV1, RegExp][] = [
    ['a three-arm roster', { ...base, expectedArmRoster: base.expectedArmRoster.slice(0, 3) }, /expectedArmRoster\.length/],
    ['two repairs', { ...base, constants: { ...base.constants, maxRepairAttemptsPerArm: 2 } }, /maxRepairAttemptsPerArm/],
    ['a cheaper reservation', { ...base, constants: { ...base.constants, providerAttemptReservationUsdMicros: 50_000_000 } }, /providerAttemptReservationUsdMicros/],
    ['an inflated token cap', { ...base, constants: { ...base.constants, maxOutputTokens: 16_001 } }, /maxOutputTokens/],
    ['a short provider timeout', { ...base, constants: { ...base.constants, providerCallTimeoutMs: 1_000 } }, /providerCallTimeoutMs/],
    ['the replay price table', { ...base, modelPriceTableVersion: 'prices-v1' }, /modelPriceTableVersion/],
    ['a wrong price digest', { ...base, modelPriceTableDigest: 'f'.repeat(64) }, /modelPriceTableDigest/],
  ];
  for (const [label, manifest, expected] of cases) {
    const violations = campaignBoundsViolations(manifest);
    assert.ok(violations.length > 0, label);
    assert.ok(violations.some((v) => expected.test(v)), `${label}: ${violations.join('; ')}`);
  }
});

test('the size levers are BOUNDED — outside the code-owned maxima is refused, at the boundary is allowed', () => {
  const base = campaignManifest().manifest;
  // Call cap: one fire's worth is the floor; 4000 is the ceiling. Both boundaries pass.
  assert.deepEqual(
    campaignBoundsViolations(buildCampaignManifest(NOW, { callCap: 8, windowForwardMs: WEEK_MS }).manifest),
    [],
  );
  assert.deepEqual(
    campaignBoundsViolations(buildCampaignManifest(NOW, { callCap: 4_000, windowForwardMs: WEEK_MS }).manifest),
    [],
  );
  // One below the floor and one above the ceiling are refused.
  assert.ok(campaignBoundsViolations({ ...base, cohortCallCap: 7 }).some((v) => /cohortCallCap \(7\)/.test(v)));
  assert.ok(campaignBoundsViolations({ ...base, cohortCallCap: 4_001 }).some((v) => /cohortCallCap \(4001\)/.test(v)));
  // Concurrency below the roster and above two fires' worth.
  assert.ok(
    campaignBoundsViolations({ ...base, constants: { ...base.constants, maxConcurrentProviderRequests: 3 } }).some((v) =>
      /maxConcurrentProviderRequests \(3\)/.test(v),
    ),
  );
  assert.ok(
    campaignBoundsViolations({ ...base, constants: { ...base.constants, maxConcurrentProviderRequests: 9 } }).some((v) =>
      /maxConcurrentProviderRequests \(9\)/.test(v),
    ),
  );
  // Dispatches per tick above the maximum.
  assert.ok(
    campaignBoundsViolations({ ...base, constants: { ...base.constants, maxDispatchesPerTick: 5 } }).some((v) =>
      /maxDispatchesPerTick \(5\)/.test(v),
    ),
  );
});

test('a stated size cannot be a fiction: a reservation cap that cannot cover the call cap is refused', () => {
  const base = campaignManifest().manifest;
  // 800 calls = 100 fires, which needs 100 × $800 in reservations. One fire short refuses.
  const short = { ...base, cohortSpendCapUsdMicros: 99 * 800_000_000 };
  assert.ok(
    campaignBoundsViolations(short).some((v) => /does not cover the 100 fire\(s\)/.test(v)),
    campaignBoundsViolations(short).join('; '),
  );
});

test('the CROSSING cohort is a valid one-fire campaign, but a campaign cohort is NOT a valid crossing', async () => {
  // Asymmetric by design: the crossing's exact pins are a special case of the campaign bounds.
  const crossing = buildCrossingManifest(NOW).manifest;
  assert.deepEqual(campaignBoundsViolations(crossing), []);
  const { crossingPinViolations } = await import('./crossingProfile.js');
  assert.ok(crossingPinViolations(campaignManifest().manifest).length > 0, 'a 100-fire campaign is not a canary');
});

test('a rehearsal cohort is refused as a campaign (replay price table, unbounded caps)', () => {
  const rehearsal = buildRehearsalManifest(NOW).manifest;
  const violations = campaignBoundsViolations(rehearsal);
  assert.ok(violations.some((v) => /modelPriceTableVersion/.test(v)));
  assert.ok(violations.some((v) => /cohortCallCap \(1000\)/.test(v)) || violations.some((v) => /maxDispatchesPerTick \(8\)/.test(v)));
});

// ===========================================================================
// The gated CAMPAIGN producer
// ===========================================================================

test('the campaign producer mints BILLABLE authority for a conformant campaign cohort', () => {
  withEnv(SYNTHETIC_PROVIDER_ENV, () => {
    const booted = bootedCampaign();
    const capability = gateRealCampaignAdapterCapability(booted, authorizationFor(booted));
    assert.doesNotThrow(() => assertCohortAdapterCapability(capability));
    assert.equal(capability.billingClass, 'billable');
    assert.deepEqual([...capability.adapters().keys()], ROSTER);
  });
});

test('the campaign producer REFUSES a cohort outside the campaign bounds, and a stale authorization', () => {
  withEnv(SYNTHETIC_PROVIDER_ENV, () => {
    // A rehearsal cohort: replay table + out-of-bound levers.
    const rehearsal = cohortBoot({ manifestBytes: buildRehearsalManifest(NOW).bytes });
    assert.throws(
      () => gateRealCampaignAdapterCapability(rehearsal, authorizationFor(rehearsal)),
      (e: unknown) => e instanceof CanaryAuthorizationError && /modelPriceTableVersion/.test(e.message),
    );
    // A stale authorization for another cohort, with otherwise-equal caps.
    const booted = bootedCampaign();
    const other = cohortBoot({ manifestBytes: buildCampaignManifest(NOW + 60_000, { callCap: 800, windowForwardMs: WEEK_MS }).bytes });
    assert.notEqual(booted.cohortId, other.cohortId);
    assert.throws(
      () => gateRealCampaignAdapterCapability(other, authorizationFor(booted)),
      (e: unknown) => e instanceof CanaryAuthorizationError && /cohortId/.test(e.message),
    );
  });
});

test('the campaign producer still requires every roster credential — the shared gate is not weakened', () => {
  withEnv({ ...SYNTHETIC_PROVIDER_ENV, ANTHROPIC_API_KEY: undefined }, () => {
    const booted = bootedCampaign();
    assert.throws(
      () => gateRealCampaignAdapterCapability(booted, authorizationFor(booted)),
      (e: unknown) => e instanceof CanaryAuthorizationError && /has no usable credential/.test(e.message),
    );
  });
});
