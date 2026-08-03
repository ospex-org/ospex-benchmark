import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cohortBoot } from './cohortBoot.js';
import { CROSSING_PROFILE, buildCrossingManifest, crossingPinViolations } from './crossingProfile.js';
import { DEMO_GAME_ID, buildFixtureSeams } from './demoFixture.js';
import { deriveSpendReservationUsdMicros } from './lineOpenSpine.js';
import { SPEND_GUARD_PRICE_TABLE_VERSION, modelPriceTableDigest } from './modelPriceTable.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';
import type { CohortManifestV1 } from './manifest.js';

/**
 * The pinned one-fire crossing profile: the built manifest BOOTS, carries exactly
 * the pinned caps + the conservative guard price identity, and its $800 spend cap
 * IS the derived one-fire full reservation. The conformance check
 * (`crossingPinViolations`) is exact-equality on every pin — one micro / one call
 * / one dispatch off in EITHER direction fails with a named violation — and the
 * rehearsal/demo defaults remain distinct from the crossing (the closed-by-default
 * demo did not silently become the canary).
 */

const FIXED_NOW = Date.parse('2026-07-18T12:00:00.000Z');

test('the crossing manifest boots and pins the exact one-fire profile', () => {
  const { bytes, manifest } = buildCrossingManifest(FIXED_NOW);
  const booted = cohortBoot({ manifestBytes: bytes });
  assert.equal(booted.cohortId.length, 64, 'a real derived cohort identity');

  // The complete pin tuple, compared as one object against the frozen profile. Every
  // left-side entry is manifest-derived except the ceiling, which the manifest does not
  // carry — it is asserted against the $800 LITERAL so the profile's own value is pinned
  // here rather than compared to itself.
  assert.deepEqual(
    {
      rosterSize: manifest.expectedArmRoster.length,
      maxRepairAttemptsPerArm: manifest.constants.maxRepairAttemptsPerArm,
      maxAttemptsPerFire:
        manifest.expectedArmRoster.length * (1 + manifest.constants.maxRepairAttemptsPerArm),
      providerAttemptReservationUsdMicros: manifest.constants.providerAttemptReservationUsdMicros,
      cohortSpendCapUsdMicros: manifest.cohortSpendCapUsdMicros,
      canaryCeilingUsdMicros: 800_000_000,
      cohortCallCap: manifest.cohortCallCap,
      maxConcurrentProviderRequests: manifest.constants.maxConcurrentProviderRequests,
      maxDispatchesPerTick: manifest.constants.maxDispatchesPerTick,
      maxOutputTokens: manifest.constants.maxOutputTokens,
      providerCallTimeoutMs: manifest.constants.providerCallTimeoutMs,
    },
    { ...CROSSING_PROFILE },
  );
  // The conservative guard price identity — the EXACT predicate the billable
  // pre-claim price-identity gate in runOneFire checks per fire.
  assert.equal(manifest.modelPriceTableVersion, SPEND_GUARD_PRICE_TABLE_VERSION);
  assert.equal(manifest.modelPriceTableDigest, modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION));
  // The production provider timeout — real model calls take minutes, not the demo's 1s.
  assert.equal(manifest.constants.providerCallTimeoutMs, 300_000);
  // And the built manifest conforms to its own pins.
  assert.deepEqual(crossingPinViolations(manifest), []);
});

test('the $800 spend cap IS the derived one-fire full reservation (4 arms × 2 attempts × $100)', () => {
  const { manifest } = buildCrossingManifest(FIXED_NOW);
  const reservation = deriveSpendReservationUsdMicros(manifest);
  assert.equal(reservation, 800_000_000, 'the full-fire reservation is exactly $800');
  assert.equal(reservation, manifest.cohortSpendCapUsdMicros, 'cap == one-fire reservation: one fire fits, two never do');
  assert.equal(manifest.cohortCallCap, 8, 'call cap == max attempts per fire');
});

test('crossingPinViolations is exact on every pin — one off in EITHER direction fails, named', () => {
  const crossingLevers = {
    maxConcurrentProviderRequests: CROSSING_PROFILE.maxConcurrentProviderRequests,
    maxDispatchesPerTick: CROSSING_PROFILE.maxDispatchesPerTick,
    cohortCallCap: CROSSING_PROFILE.cohortCallCap,
    cohortSpendCapUsdMicros: CROSSING_PROFILE.cohortSpendCapUsdMicros,
    modelPriceTableVersion: SPEND_GUARD_PRICE_TABLE_VERSION,
  } as const;

  // The conformant build passes (the negative control for every case below).
  assert.deepEqual(
    crossingPinViolations(buildRehearsalManifest(FIXED_NOW, crossingLevers).manifest),
    [],
  );

  const cases: readonly {
    label: string;
    build: () => CohortManifestV1;
    expect: RegExp;
  }[] = [
    {
      label: 'spend cap one micro OVER',
      build: () =>
        buildRehearsalManifest(FIXED_NOW, { ...crossingLevers, cohortSpendCapUsdMicros: 800_000_001 }).manifest,
      expect: /cohortSpendCapUsdMicros \(800000001\)/,
    },
    {
      label: 'spend cap one micro UNDER',
      build: () =>
        buildRehearsalManifest(FIXED_NOW, { ...crossingLevers, cohortSpendCapUsdMicros: 799_999_999 }).manifest,
      expect: /cohortSpendCapUsdMicros \(799999999\)/,
    },
    {
      label: 'call cap 9',
      build: () => buildRehearsalManifest(FIXED_NOW, { ...crossingLevers, cohortCallCap: 9 }).manifest,
      expect: /cohortCallCap \(9\)/,
    },
    {
      label: 'call cap 7',
      build: () => buildRehearsalManifest(FIXED_NOW, { ...crossingLevers, cohortCallCap: 7 }).manifest,
      expect: /cohortCallCap \(7\)/,
    },
    {
      label: 'two dispatches per tick',
      build: () => buildRehearsalManifest(FIXED_NOW, { ...crossingLevers, maxDispatchesPerTick: 2 }).manifest,
      expect: /maxDispatchesPerTick \(2\)/,
    },
    {
      label: 'concurrency 5',
      build: () =>
        buildRehearsalManifest(FIXED_NOW, { ...crossingLevers, maxConcurrentProviderRequests: 5 }).manifest,
      expect: /maxConcurrentProviderRequests \(5\)/,
    },
    {
      label: 'the replay price table instead of the conservative guard table',
      build: () =>
        buildRehearsalManifest(FIXED_NOW, { ...crossingLevers, modelPriceTableVersion: 'prices-v1' }).manifest,
      expect: /modelPriceTableVersion \(prices-v1\)/,
    },
    {
      label: 'a three-arm roster',
      build: () => {
        const base = buildRehearsalManifest(FIXED_NOW, crossingLevers).manifest;
        return { ...base, expectedArmRoster: base.expectedArmRoster.slice(0, 3) };
      },
      expect: /expectedArmRoster\.length \(3\)/,
    },
    {
      label: 'a two-repair cap',
      build: () => {
        const base = buildRehearsalManifest(FIXED_NOW, crossingLevers).manifest;
        return { ...base, constants: { ...base.constants, maxRepairAttemptsPerArm: 2 } };
      },
      expect: /maxRepairAttemptsPerArm \(2\)/,
    },
    {
      // A per-attempt COST DRIVER: the right caps with an inflated output-token budget is
      // not the cohort the worst-case spend proof priced, so the pin refuses it.
      label: 'an inflated per-attempt output-token cap',
      build: () => {
        const base = buildRehearsalManifest(FIXED_NOW, crossingLevers).manifest;
        return { ...base, constants: { ...base.constants, maxOutputTokens: 16_001 } };
      },
      expect: /maxOutputTokens \(16001\)/,
    },
    {
      label: 'a non-production provider timeout',
      build: () =>
        buildRehearsalManifest(FIXED_NOW, { ...crossingLevers, providerCallTimeoutMs: 1_000 }).manifest,
      expect: /providerCallTimeoutMs \(1000\)/,
    },
    {
      // The digest pin ALONE: the version is correct, so only the digest check can refuse.
      label: 'a mismatched price-table digest under the correct version',
      build: () => {
        const base = buildRehearsalManifest(FIXED_NOW, crossingLevers).manifest;
        return { ...base, modelPriceTableDigest: 'f'.repeat(64) };
      },
      expect: /modelPriceTableDigest/,
    },
  ];
  for (const { label, build, expect } of cases) {
    const violations = crossingPinViolations(build());
    assert.ok(violations.length > 0, `${label}: must violate`);
    assert.ok(
      violations.some((v) => expect.test(v)),
      `${label}: expected ${expect} in [${violations.join('; ')}]`,
    );
  }
});

test('the rehearsal/demo defaults are NOT the crossing profile (the demo did not silently become the canary)', () => {
  const rehearsal = buildRehearsalManifest(FIXED_NOW).manifest;
  // Regression-pin the rehearsal defaults themselves — the option extension must not
  // have drifted them (the closed-by-default demo path depends on these exact values).
  assert.equal(rehearsal.cohortSpendCapUsdMicros, 1_000_000_000);
  assert.equal(rehearsal.cohortCallCap, 1_000);
  assert.equal(rehearsal.constants.maxDispatchesPerTick, 8);
  assert.equal(rehearsal.constants.maxConcurrentProviderRequests, 8);
  assert.equal(rehearsal.modelPriceTableVersion, 'prices-v1');
  // And those defaults do NOT conform to the crossing pins.
  const violations = crossingPinViolations(rehearsal);
  assert.ok(violations.length >= 5, `the rehearsal shape violates the pins broadly: [${violations.join('; ')}]`);
});

test('the crossing manifest + separately-anchored fixture seams serve the same synthetic candidate', async () => {
  // The live path composes these two directly (manifest early, seams after the attended
  // confirmation); this pins that the composition serves the demo candidate unchanged.
  const booted = cohortBoot({ manifestBytes: buildCrossingManifest(FIXED_NOW).bytes });
  assert.deepEqual(crossingPinViolations(booted.manifest), [], 'the booted manifest IS the crossing manifest');
  const seams = buildFixtureSeams(FIXED_NOW + 60_000); // anchored later, like a post-confirmation anchor
  const discovery = await seams.discover(booted);
  assert.equal(discovery.candidates.length, 1, 'exactly one synthetic candidate');
  assert.equal(discovery.candidates[0]!.gameId, DEMO_GAME_ID);
});
