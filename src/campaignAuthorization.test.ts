import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CAMPAIGN_AUTHORIZATION_VERSION,
  buildCampaignAuthorization,
  resolveCampaignIntent,
} from './campaignAuthorization.js';
import type { CampaignAuthorization } from './campaignAuthorization.js';
import { cohortBoot } from './cohortBoot.js';
import type { BootedCohort } from './cohortBoot.js';
import { buildCrossingManifest } from './crossingProfile.js';
import { modelPriceTableDigest } from './modelPriceTable.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';
import { defaultExpectedArms } from './scoring.js';

/**
 * The campaign authorization: the record that lets SCHEDULED ticks run without a prompt.
 * Its whole job is to refuse — so every test here drives a refusal path except the two
 * that pin the authorized shape. A tick never prompts and never falls back to mock: it
 * either holds a validated authorization or fires nothing.
 */

const ARMED_MS = Date.parse('2026-08-05T00:00:00.000Z');
const EXPIRES_MS = Date.parse('2026-08-12T00:00:00.000Z');
const DURING_MS = Date.parse('2026-08-06T12:00:00.000Z');
const ROSTER = defaultExpectedArms().map((a) => a.participantId);

function bootedCrossing(now = Date.parse('2026-08-05T00:00:00.000Z')): BootedCohort {
  return cohortBoot({ manifestBytes: buildCrossingManifest(now).bytes });
}

/** Every roster arm credentialed — the normal observation. */
const allCredentialed = (ids: readonly string[]): ReadonlyMap<string, boolean> =>
  new Map(ids.map((id) => [id, true]));

/** A genuine armed record for `booted`, with `over` applied for the refusal cases. */
function armedRecord(booted: BootedCohort, over: Partial<Record<keyof CampaignAuthorization, unknown>> = {}): unknown {
  const base = buildCampaignAuthorization({
    booted,
    observedCredentialedParticipantIds: ROSTER,
    armedAtMs: ARMED_MS,
    expiresAtMs: EXPIRES_MS,
  });
  return { ...base, ...over };
}

function resolve(booted: BootedCohort, stored: unknown, over: { now?: number; credentialed?: (id: string) => boolean } = {}) {
  return resolveCampaignIntent({
    booted,
    stored,
    now: over.now ?? DURING_MS,
    observeCredentials: (ids) =>
      over.credentialed === undefined ? allCredentialed(ids) : new Map(ids.map((id) => [id, over.credentialed!(id)])),
  });
}

function violationsOf(resolution: ReturnType<typeof resolveCampaignIntent>): string[] {
  return resolution.kind === 'Refused' ? [...resolution.violations] : [];
}

// ===========================================================================
// The authorized shape
// ===========================================================================

test('a live armed record resolves to the EXACT momentary canary authorization the gated producer expects', () => {
  const booted = bootedCrossing();
  const resolution = resolve(booted, armedRecord(booted));
  assert.equal(resolution.kind, 'Authorized', JSON.stringify(violationsOf(resolution)));
  if (resolution.kind !== 'Authorized') return;

  // COMPLETE object equality — an undeclared field or a drifted value fails here. Note it
  // carries NO campaign-only terms (armedAt/expiresAt/disarmedAt/version): the producer's
  // strict key check would reject those, and the momentary credential is deliberately narrow.
  assert.deepEqual(resolution.authorization, {
    cohortId: booted.cohortId,
    participantIds: ROSTER,
    modelPriceTableVersion: 'prices-v2',
    modelPriceTableDigest: modelPriceTableDigest('prices-v2'),
    liveOptIn: true,
    observedCredentialedParticipantIds: ROSTER,
    cohortSpendCapUsdMicros: 800_000_000,
    cohortCallCap: 8,
    maxConcurrentProviderRequests: 4,
    maxDispatchesPerTick: 1,
    maxRepairAttemptsPerArm: 1,
  });
  assert.ok(Object.isFrozen(resolution));
  assert.ok(Object.isFrozen(resolution.authorization));
});

test('buildCampaignAuthorization DERIVES every term from the booted manifest and starts un-disarmed', () => {
  const booted = bootedCrossing();
  const record = buildCampaignAuthorization({
    booted,
    observedCredentialedParticipantIds: ROSTER,
    armedAtMs: ARMED_MS,
    expiresAtMs: EXPIRES_MS,
  });
  assert.deepEqual(
    { ...record, participantIds: [...record.participantIds], observedCredentialedParticipantIds: [...record.observedCredentialedParticipantIds] },
    {
      campaignAuthorizationVersion: CAMPAIGN_AUTHORIZATION_VERSION,
      cohortId: booted.cohortId,
      participantIds: ROSTER,
      modelPriceTableVersion: 'prices-v2',
      modelPriceTableDigest: modelPriceTableDigest('prices-v2'),
      liveOptIn: true,
      observedCredentialedParticipantIds: ROSTER,
      cohortSpendCapUsdMicros: 800_000_000,
      cohortCallCap: 8,
      maxConcurrentProviderRequests: 4,
      maxDispatchesPerTick: 1,
      maxRepairAttemptsPerArm: 1,
      armedAt: '2026-08-05T00:00:00.000Z',
      expiresAt: '2026-08-12T00:00:00.000Z',
      disarmedAt: null,
    },
  );
  assert.ok(Object.isFrozen(record));
});

// ===========================================================================
// Liveness — the three time/revocation refusals
// ===========================================================================

test('NO armed authorization refuses — the default state of the world fires nothing', () => {
  const booted = bootedCrossing();
  for (const stored of [null, undefined]) {
    const resolution = resolve(booted, stored);
    assert.equal(resolution.kind, 'Refused');
    assert.ok(violationsOf(resolution).some((v) => /no campaign authorization is armed/.test(v)));
  }
});

test('an EXPIRED authorization refuses — the expiry boundary is exact', () => {
  const booted = bootedCrossing();
  // One millisecond before expiry still authorizes; exactly at expiry does not.
  const justBefore = resolve(booted, armedRecord(booted), { now: EXPIRES_MS - 1 });
  assert.equal(justBefore.kind, 'Authorized', JSON.stringify(violationsOf(justBefore)));

  const atExpiry = resolve(booted, armedRecord(booted), { now: EXPIRES_MS });
  assert.equal(atExpiry.kind, 'Refused');
  assert.ok(violationsOf(atExpiry).some((v) => /expired at/.test(v)));

  const after = resolve(booted, armedRecord(booted), { now: EXPIRES_MS + 86_400_000 });
  assert.equal(after.kind, 'Refused');
});

test('a DISARMED authorization refuses — the operator stop lever', () => {
  const booted = bootedCrossing();
  const resolution = resolve(booted, armedRecord(booted, { disarmedAt: '2026-08-06T00:00:00.000Z' }));
  assert.equal(resolution.kind, 'Refused');
  assert.ok(violationsOf(resolution).some((v) => /was disarmed at/.test(v)));
});

test('a tick clock BEFORE arming refuses, and a non-finite clock fails closed', () => {
  const booted = bootedCrossing();
  const early = resolve(booted, armedRecord(booted), { now: ARMED_MS - 1 });
  assert.equal(early.kind, 'Refused');
  assert.ok(violationsOf(early).some((v) => /before armedAt/.test(v)));

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const broken = resolve(booted, armedRecord(booted), { now: bad });
    assert.equal(broken.kind, 'Refused', `clock ${String(bad)}`);
    assert.ok(violationsOf(broken).some((v) => /not finite/.test(v)));
  }
});

// ===========================================================================
// Binding — a record for another cohort, or with drifted caps, never resolves
// ===========================================================================

test('an authorization for ANOTHER cohort refuses even with identical caps', () => {
  const bootedA = bootedCrossing(Date.parse('2026-08-05T00:00:00.000Z'));
  const bootedB = bootedCrossing(Date.parse('2026-08-05T00:01:00.000Z')); // same pins, different window → different id
  assert.notEqual(bootedA.cohortId, bootedB.cohortId);
  const resolution = resolve(bootedB, armedRecord(bootedA));
  assert.equal(resolution.kind, 'Refused');
  assert.ok(violationsOf(resolution).some((v) => /cohortId/.test(v)));
});

test('every cap binds by EXACT equality — one off in either direction refuses, named', () => {
  const booted = bootedCrossing();
  const cases: readonly [keyof CampaignAuthorization, unknown, RegExp][] = [
    ['cohortSpendCapUsdMicros', 800_000_001, /cohortSpendCapUsdMicros/],
    ['cohortSpendCapUsdMicros', 799_999_999, /cohortSpendCapUsdMicros/],
    ['cohortCallCap', 9, /cohortCallCap/],
    ['cohortCallCap', 7, /cohortCallCap/],
    ['maxConcurrentProviderRequests', 8, /maxConcurrentProviderRequests/],
    ['maxDispatchesPerTick', 2, /maxDispatchesPerTick/],
    ['maxRepairAttemptsPerArm', 2, /maxRepairAttemptsPerArm/],
  ];
  for (const [key, value, expected] of cases) {
    const resolution = resolve(booted, armedRecord(booted, { [key]: value }));
    assert.equal(resolution.kind, 'Refused', `${key}=${String(value)}`);
    assert.ok(violationsOf(resolution).some((v) => expected.test(v)), `${key}: ${violationsOf(resolution).join('; ')}`);
  }
});

test('the roster binds by ORDERED identity; the price identity binds both version and digest', () => {
  const booted = bootedCrossing();
  const reordered = resolve(booted, armedRecord(booted, { participantIds: [...ROSTER].reverse() }));
  assert.equal(reordered.kind, 'Refused');
  assert.ok(violationsOf(reordered).some((v) => /participantIds/.test(v)));

  const subset = resolve(booted, armedRecord(booted, { participantIds: ROSTER.slice(0, 3) }));
  assert.equal(subset.kind, 'Refused');

  const wrongVersion = resolve(booted, armedRecord(booted, { modelPriceTableVersion: 'prices-v1' }));
  assert.equal(wrongVersion.kind, 'Refused');
  assert.ok(violationsOf(wrongVersion).some((v) => /modelPriceTableVersion/.test(v)));

  const wrongDigest = resolve(booted, armedRecord(booted, { modelPriceTableDigest: 'f'.repeat(64) }));
  assert.equal(wrongDigest.kind, 'Refused');
  assert.ok(violationsOf(wrongDigest).some((v) => /modelPriceTableDigest/.test(v)));
});

// ===========================================================================
// Credentials — re-observed EVERY tick, never trusted from the record
// ===========================================================================

test('a credential revoked MID-CAMPAIGN refuses the tick — the arming-time claim is never enough', () => {
  const booted = bootedCrossing();
  const resolution = resolve(booted, armedRecord(booted), {
    credentialed: (id) => id !== 'google-gemini-3.1-pro-preview',
  });
  assert.equal(resolution.kind, 'Refused');
  const violations = violationsOf(resolution);
  assert.ok(violations.some((v) => /"google-gemini-3.1-pro-preview" has no usable credential/.test(v)));
  assert.ok(violations.some((v) => /observed now .* != the set recorded at arming/.test(v)));
});

test('an ABSENT observation (id missing from the returned map) reads as not credentialed — fail closed', () => {
  const booted = bootedCrossing();
  const resolution = resolveCampaignIntent({
    booted,
    stored: armedRecord(booted),
    now: DURING_MS,
    observeCredentials: () => new Map(), // observes NOTHING
  });
  assert.equal(resolution.kind, 'Refused');
  assert.equal(violationsOf(resolution).filter((v) => /no usable credential/.test(v)).length, ROSTER.length);
});

test('a record UNDER-CLAIMING its arming-time observation refuses — reconciled in both directions', () => {
  const booted = bootedCrossing();
  const resolution = resolve(
    booted,
    armedRecord(booted, { observedCredentialedParticipantIds: ROSTER.slice(0, 3) }),
  );
  assert.equal(resolution.kind, 'Refused');
  assert.ok(violationsOf(resolution).some((v) => /recorded at arming/.test(v)));
});

// ===========================================================================
// Record shape — strict, one-read capture
// ===========================================================================

test('stored-record shape is STRICT: wrong version, missing/extra keys, bad opt-in, bad instants, bad counts', () => {
  const booted = bootedCrossing();
  const shapes: readonly [string, unknown, RegExp][] = [
    ['a future version', armedRecord(booted, { campaignAuthorizationVersion: 2 }), /not the supported version/],
    [
      'a missing key',
      (() => {
        const { expiresAt: _dropped, ...rest } = armedRecord(booted) as Record<string, unknown>;
        return rest;
      })(),
      /do not equal the expected set/,
    ],
    ['an extra key', { ...(armedRecord(booted) as Record<string, unknown>), extraLever: 1 }, /do not equal the expected set/],
    ['liveOptIn false', armedRecord(booted, { liveOptIn: false }), /liveOptIn must be the literal true/],
    ['liveOptIn truthy-not-true', armedRecord(booted, { liveOptIn: 1 }), /liveOptIn must be the literal true/],
    ['a naive armedAt', armedRecord(booted, { armedAt: '2026-08-05T00:00:00' }), /armedAt must be an offset-qualified/],
    ['a malformed expiresAt', armedRecord(booted, { expiresAt: 'not-an-instant' }), /expiresAt must be an offset-qualified/],
    ['a malformed disarmedAt', armedRecord(booted, { disarmedAt: 'nope' }), /disarmedAt must be null or an offset-qualified/],
    ['a NaN cap', armedRecord(booted, { cohortCallCap: Number.NaN }), /cohortCallCap must be a non-negative safe integer/],
    ['a fractional cap', armedRecord(booted, { cohortSpendCapUsdMicros: 1.5 }), /must be a non-negative safe integer/],
    ['a negative cap', armedRecord(booted, { maxDispatchesPerTick: -1 }), /must be a non-negative safe integer/],
    ['a string cap', armedRecord(booted, { cohortCallCap: '8' }), /must be a non-negative safe integer/],
    ['a non-array roster', armedRecord(booted, { participantIds: 'all' }), /participantIds must be an array/],
    ['null', null, /no campaign authorization is armed/],
    ['an array', [], /must be a plain object/],
    ['a string', 'armed', /must be a plain object/],
  ];
  for (const [label, stored, expected] of shapes) {
    const resolution = resolve(booted, stored);
    assert.equal(resolution.kind, 'Refused', label);
    assert.ok(violationsOf(resolution).some((v) => expected.test(v)), `${label}: ${violationsOf(resolution).join('; ')}`);
  }
});

test('each stored property is read EXACTLY ONCE — the comparisons run on the frozen capture', () => {
  const booted = bootedCrossing();
  const source = armedRecord(booted) as Record<string, unknown>;
  const reads = new Map<string, number>();
  const instrumented: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    Object.defineProperty(instrumented, key, {
      enumerable: true,
      get: () => {
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        if (count > 1) throw new Error(`property ${key} read ${count} times`);
        return value;
      },
    });
  }
  // A second read of ANY property throws inside the getter — a clean resolution IS the proof.
  const resolution = resolve(booted, instrumented);
  assert.equal(resolution.kind, 'Authorized', JSON.stringify(violationsOf(resolution)));
  for (const key of Object.keys(source)) {
    assert.equal(reads.get(key), 1, `${key} read exactly once`);
  }
});

// ===========================================================================
// Arming-time refusals
// ===========================================================================

test('arming REFUSES a cohort that does not pin the conservative guard price table', () => {
  // The rehearsal manifest pins the replay table; a billable campaign under it could never
  // fire (runOneFire refuses pre-claim), so arming must refuse rather than arm a dead campaign.
  const rehearsal = cohortBoot({ manifestBytes: buildRehearsalManifest(ARMED_MS).bytes });
  assert.throws(
    () =>
      buildCampaignAuthorization({
        booted: rehearsal,
        observedCredentialedParticipantIds: ROSTER,
        armedAtMs: ARMED_MS,
        expiresAtMs: EXPIRES_MS,
      }),
    /conservative guard price table/,
  );
});

test('arming REFUSES a non-positive or non-finite lifetime', () => {
  const booted = bootedCrossing();
  const bad: readonly [number, number][] = [
    [ARMED_MS, ARMED_MS],
    [ARMED_MS, ARMED_MS - 1],
    [Number.NaN, EXPIRES_MS],
    [ARMED_MS, Number.POSITIVE_INFINITY],
  ];
  for (const [armedAtMs, expiresAtMs] of bad) {
    assert.throws(
      () => buildCampaignAuthorization({ booted, observedCredentialedParticipantIds: ROSTER, armedAtMs, expiresAtMs }),
      `${armedAtMs} → ${expiresAtMs}`,
    );
  }
});

test('a forged (structurally-copied) booted cohort throws on BOTH the arm and resolve paths', () => {
  const genuine = bootedCrossing();
  const forged = { cohortId: genuine.cohortId, manifest: genuine.manifest } as BootedCohort;
  assert.throws(
    () =>
      buildCampaignAuthorization({
        booted: forged,
        observedCredentialedParticipantIds: ROSTER,
        armedAtMs: ARMED_MS,
        expiresAtMs: EXPIRES_MS,
      }),
    /not produced by cohortBoot/,
  );
  assert.throws(() => resolve(forged, armedRecord(genuine)), /not produced by cohortBoot/);
});
