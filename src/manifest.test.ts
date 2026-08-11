import assert from 'node:assert/strict';
import { toolInferenceConfigSha256 } from './toolInferenceConfig.js';
import { test } from 'node:test';
import { cohortId, parseManifest } from './manifest.js';
import { MAX_CONFIGURATION_CANONICAL_BYTES } from './participantConfiguration.js';

/**
 * CohortManifestV1 structural-parse tests: a valid fixture round-trips, cohortId
 * is canonical-bytes identity (order-independent, deterministic, not a field),
 * and the strict schema rejects unknown fields (so no secret can ride along),
 * missing/mistyped fields, and broken window/poll invariants.
 */

function validManifest(): Record<string, unknown> {
  return {
    artifactSchemaVersion: 1,
    network: 'polygon',
    sportAllowList: ['mlb'],
    windowStart: '2026-07-16T00:00:00.000Z',
    windowEnd: '2026-07-16T02:00:00.000Z',
    source: 'jsonodds',
    sourceQueryVersion: 'source-query-v1',
    marketPolicyVersion: 'market-policy-v1',
    marketPolicyDigest: 'aa6f24ddc0758d8366449b0ae4803898079cee1cfdfa36575a67da9751509dcd',
    promptScaffoldSha256: 'a'.repeat(64),
    expectedArmRoster: [
      { participantId: 'openai-gpt', provider: 'openai', requestedModelId: 'gpt-x', approvedReportedModelIds: ['gpt-x'], configuration: {} },
      { participantId: 'anthropic-claude', provider: 'anthropic', requestedModelId: 'claude-x', approvedReportedModelIds: ['claude-x'], configuration: {} },
    ],
    toolInferenceConfigSha256: toolInferenceConfigSha256(),
    baselinePolicyVersion: 'baselines-v0.2.0',
    repairPolicyVersion: 'repair-v1',
    scoringPolicyVersion: 'scoring-v0.5.0',
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: 'prices-v1',
    modelPriceTableDigest: 'c'.repeat(64),
    spendReservationPolicyVersion: 'fixed-attempt-v1',
    runnerCommitSha: 'd'.repeat(40),
    constants: {
      pollIntervalMs: 30000,
      cleanEntryWindowMs: 120000,
      gameDiscoveryWindowHours: 168,
      maxClockSkewMs: 5000,
      freshFireMs: 30000,
      maxDispatchLagMs: 10000,
      historyReadTimeoutMs: 30000,
      providerCallTimeoutMs: 300000,
      maxOutputTokens: 16000,
      maxRepairAttemptsPerArm: 1,
      providerAttemptReservationUsdMicros: 100_000_000,
      ingestionGraceMs: 900000,
      scheduleChangeToleranceMs: 60000,
      maxConcurrentProviderRequests: 4,
      maxDispatchesPerTick: 10,
    },
    cohortCallCap: 1000,
    cohortSpendCapUsdMicros: 5000000,
  };
}

test('a valid manifest parses and yields a 64-hex cohortId', () => {
  const m = parseManifest(validManifest());
  assert.equal(m.network, 'polygon');
  assert.deepEqual(m.sportAllowList, ['mlb']);
  assert.equal(m.constants.cleanEntryWindowMs, 120000);
  assert.equal(m.expectedArmRoster.length, 2);
  assert.match(cohortId(m), /^[0-9a-f]{64}$/);
});

test('cohortId is deterministic and independent of source key order', () => {
  const c1 = cohortId(parseManifest(validManifest()));
  const c2 = cohortId(parseManifest(validManifest()));
  assert.equal(c1, c2); // deterministic
  // Same logical manifest, keys inserted in reverse order → same cohortId,
  // because it hashes the canonical (key-sorted) serialization, not raw input.
  const reversed = Object.fromEntries(Object.entries(validManifest()).reverse());
  assert.equal(cohortId(parseManifest(reversed)), c1);
});

test('cohortId changes when any precommitted value changes', () => {
  const base = cohortId(parseManifest(validManifest()));
  const wider = validManifest();
  (wider.sportAllowList as string[]).push('nfl');
  assert.notEqual(cohortId(parseManifest(wider)), base);
});

test('strict schema rejects an unknown top-level field (no secret can ride along)', () => {
  const withSecret = { ...validManifest(), apiKey: 'sk-should-never-be-here' };
  assert.throws(() => parseManifest(withSecret), /invalid cohort manifest/);
});

test('strict schema rejects unknown nested fields (constants, roster arm)', () => {
  const badConstants = validManifest();
  (badConstants.constants as Record<string, unknown>).extra = 1;
  assert.throws(() => parseManifest(badConstants), /invalid cohort manifest/);

  const badArm = validManifest();
  (badArm.expectedArmRoster as Array<Record<string, unknown>>)[0]!.temperature = 0.7;
  assert.throws(() => parseManifest(badArm), /invalid cohort manifest/);
});

test('missing or mistyped required fields are rejected', () => {
  const noNetwork = validManifest();
  delete noNetwork.network;
  assert.throws(() => parseManifest(noNetwork), /invalid cohort manifest/);

  const emptyRoster = { ...validManifest(), expectedArmRoster: [] };
  assert.throws(() => parseManifest(emptyRoster), /invalid cohort manifest/);

  const badDigest = { ...validManifest(), marketPolicyDigest: 'not-hex' };
  assert.throws(() => parseManifest(badDigest), /invalid cohort manifest/);

  const negCap = { ...validManifest(), cohortCallCap: -1 };
  assert.throws(() => parseManifest(negCap), /invalid cohort manifest/);

  const fractionalConst = validManifest();
  (fractionalConst.constants as Record<string, unknown>).maxDispatchesPerTick = 1.5;
  assert.throws(() => parseManifest(fractionalConst), /invalid cohort manifest/);

  const badSource = { ...validManifest(), source: 'rundown' };
  assert.throws(() => parseManifest(badSource), /invalid cohort manifest/);

  const badWindow = { ...validManifest(), windowStart: 'not-a-datetime' };
  assert.throws(() => parseManifest(badWindow), /invalid cohort manifest/);
});

test('broken window/poll invariants are rejected', () => {
  const backwardsWindow = {
    ...validManifest(),
    windowStart: '2026-07-16T02:00:00.000Z',
    windowEnd: '2026-07-16T00:00:00.000Z',
  };
  assert.throws(() => parseManifest(backwardsWindow), /windowStart must be strictly before windowEnd/);

  const equalWindow = {
    ...validManifest(),
    windowStart: '2026-07-16T00:00:00.000Z',
    windowEnd: '2026-07-16T00:00:00.000Z',
  };
  assert.throws(() => parseManifest(equalWindow), /windowStart must be strictly before windowEnd/);

  const slowPoll = validManifest();
  (slowPoll.constants as Record<string, unknown>).pollIntervalMs = 120000; // == window, not <
  assert.throws(() => parseManifest(slowPoll), /pollIntervalMs must be < cleanEntryWindowMs/);
});

test('the spend-reservation fields are strictly validated (version + per-attempt amount domain)', () => {
  // Both new fields are REQUIRED.
  const noVersion = validManifest();
  delete noVersion.spendReservationPolicyVersion;
  assert.throws(() => parseManifest(noVersion), /invalid cohort manifest/);
  const noAmount = validManifest();
  delete (noAmount.constants as Record<string, unknown>).providerAttemptReservationUsdMicros;
  assert.throws(() => parseManifest(noAmount), /invalid cohort manifest/);

  // spendReservationPolicyVersion must be a NON-EMPTY string (guards a z.string().min(1) -> z.string() weaken).
  for (const badVersion of ['', 123, null, true]) {
    assert.throws(
      () => parseManifest({ ...validManifest(), spendReservationPolicyVersion: badVersion }),
      /invalid cohort manifest/,
      `version ${String(badVersion)} must reject`,
    );
  }

  // providerAttemptReservationUsdMicros must be a POSITIVE SAFE INTEGER (guards a
  // positiveSafeInteger -> z.number() weaken): reject zero, negative, fractional, unsafe
  // magnitude, NaN, infinities, and non-number shapes.
  const badAmounts: unknown[] = [
    0,
    -1,
    -100_000_000,
    1.5,
    100_000_000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    '100000000',
    true,
    false,
    null,
  ];
  for (const bad of badAmounts) {
    const raw = validManifest();
    (raw.constants as Record<string, unknown>).providerAttemptReservationUsdMicros = bad;
    assert.throws(() => parseManifest(raw), /invalid cohort manifest/, `amount ${String(bad)} must reject`);
  }

  // Number.MAX_SAFE_INTEGER is accepted STRUCTURALLY (the code-amount cross-check is a separate
  // boot gate, not this structural parse).
  const maxSafe = validManifest();
  (maxSafe.constants as Record<string, unknown>).providerAttemptReservationUsdMicros = Number.MAX_SAFE_INTEGER;
  assert.doesNotThrow(() => parseManifest(maxSafe));

  // Two ADJACENT unsafe JSON integer literals round to the same double; neither may be accepted,
  // so a per-attempt amount above the safe range can never form an ambiguous cohortId.
  for (const literal of ['9007199254740992', '9007199254740993']) {
    const bytes = JSON.stringify(validManifest()).replace(
      /"providerAttemptReservationUsdMicros":100000000/,
      `"providerAttemptReservationUsdMicros":${literal}`,
    );
    assert.notEqual(bytes, JSON.stringify(validManifest()), 'the JSON amount substitution must apply');
    assert.throws(
      () => parseManifest(JSON.parse(bytes)),
      /invalid cohort manifest/,
      `JSON literal ${literal} must reject`,
    );
  }
});

test('empty required arrays and an out-of-range discovery horizon are rejected', () => {
  const emptyAllow = { ...validManifest(), sportAllowList: [] };
  assert.throws(() => parseManifest(emptyAllow), /invalid cohort manifest/);

  const emptyApproved = validManifest();
  (emptyApproved.expectedArmRoster as Array<Record<string, unknown>>)[0]!.approvedReportedModelIds = [];
  assert.throws(() => parseManifest(emptyApproved), /invalid cohort manifest/);

  const wideHorizon = validManifest();
  (wideHorizon.constants as Record<string, unknown>).gameDiscoveryWindowHours = 721; // > core-api max
  assert.throws(() => parseManifest(wideHorizon), /invalid cohort manifest/);
});

test('offset (non-Z) datetimes parse; cohortId rejects a smuggled extra field', () => {
  const offset = {
    ...validManifest(),
    windowStart: '2026-07-16T00:00:00.000+02:00',
    windowEnd: '2026-07-16T02:00:00.000+02:00',
  };
  assert.match(cohortId(parseManifest(offset)), /^[0-9a-f]{64}$/); // +HH:MM offset accepted

  // A valid manifest with an extra field cast onto it cannot enter the identity:
  // cohortId re-parses and rejects it rather than hashing the smuggled bytes.
  const smuggled = { ...parseManifest(validManifest()), evilFlag: true };
  assert.throws(
    () => cohortId(smuggled as unknown as ReturnType<typeof parseManifest>),
    /invalid cohort manifest/,
  );
});

test('manifest integers must be JS-safe — unsafe magnitudes are rejected (closes the cohortId collision)', () => {
  // (1) MAX_SAFE_INTEGER is accepted where the field's sign permits.
  const atMax = { ...validManifest(), cohortCallCap: Number.MAX_SAFE_INTEGER };
  assert.match(cohortId(parseManifest(atMax)), /^[0-9a-f]{64}$/);

  // (2) MAX_SAFE_INTEGER + 1 rejected for a representative positive constant.
  const bigConst = validManifest();
  (bigConst.constants as Record<string, unknown>).maxDispatchesPerTick = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => parseManifest(bigConst), /invalid cohort manifest/);

  // (3) MAX_SAFE_INTEGER + 1 rejected for both cohort caps.
  assert.throws(
    () => parseManifest({ ...validManifest(), cohortCallCap: Number.MAX_SAFE_INTEGER + 1 }),
    /invalid cohort manifest/,
  );
  assert.throws(
    () => parseManifest({ ...validManifest(), cohortSpendCapUsdMicros: Number.MAX_SAFE_INTEGER + 1 }),
    /invalid cohort manifest/,
  );

  // (4) The two raw JSON literals round to the SAME double, so neither may parse
  // into a valid manifest — they cannot collapse to one shared cohortId.
  const lo = JSON.parse('{"v": 9007199254740992}') as { v: number };
  const hi = JSON.parse('{"v": 9007199254740993}') as { v: number };
  assert.equal(lo.v, hi.v); // same IEEE-754 double — the collision source
  for (const cap of [lo.v, hi.v]) {
    assert.throws(
      () => parseManifest({ ...validManifest(), cohortCallCap: cap }),
      /invalid cohort manifest/,
    );
  }
});

// ---------------------------------------------------------------------------
// Participant configuration
// ---------------------------------------------------------------------------

function rosterArm(over: Record<string, unknown>): Record<string, unknown> {
  const raw = validManifest() as Record<string, unknown>;
  const roster = [...(raw['expectedArmRoster'] as Array<Record<string, unknown>>)];
  roster[0] = { ...roster[0]!, ...over };
  return { ...raw, expectedArmRoster: roster };
}

test('a roster arm that OMITS its configuration is rejected', () => {
  // This manifest exists to precommit, and an omission is not a precommitment.
  // Defaulting the field would read a forgotten line as "this arm sets no
  // knobs" — a claim nobody made, published to public Git and hashed into the
  // cohort identity.
  const omitted = validManifest() as Record<string, unknown>;
  const roster = [...(omitted['expectedArmRoster'] as Array<Record<string, unknown>>)];
  const { configuration: _dropped, ...withoutConfiguration } = roster[0]!;
  roster[0] = withoutConfiguration;
  assert.throws(
    () => parseManifest({ ...omitted, expectedArmRoster: roster }),
    /expectedArmRoster\.0\.configuration/,
  );
});

test('an explicit empty configuration is accepted, and IS the value', () => {
  // The negative control for the test above: `{}` is not an absence.
  const parsed = parseManifest(rosterArm({ configuration: {} }));
  assert.deepEqual(parsed.expectedArmRoster[0]?.configuration, {});
});

test('a configuration changes cohortId — a methodology change mints a new cohort', () => {
  const base = cohortId(parseManifest(rosterArm({ configuration: {} })));
  const tuned = cohortId(parseManifest(rosterArm({ configuration: { reasoning: { effort: 'high' } } })));
  assert.notEqual(base, tuned);
  // ...and nothing else about the manifest moved.
  assert.equal(base, cohortId(parseManifest(rosterArm({ configuration: {} }))));
});

test('the configuration value space is enforced at PARSE, before cohortId can hash it', () => {
  // `canonicalize` throws on a non-finite number, and `cohortId` re-parses
  // defensively before hashing — so a value that reached the hash would be a
  // crash at boot from a stack that does not name the field.
  assert.throws(() => parseManifest(rosterArm({ configuration: { a: Number.POSITIVE_INFINITY } })));
  assert.throws(() => parseManifest(rosterArm({ configuration: { a: Number.NaN } })));
  assert.throws(() => parseManifest(rosterArm({ configuration: 'not-an-object' })));
  assert.throws(() => parseManifest(rosterArm({ configuration: [] })));
});

test('an oversized configuration is refused at parse, in bytes', () => {
  // Refused here rather than at publication: a roster that cannot be written
  // is a night of provider spend producing an unpublishable artifact, and the
  // roster is known before the first call.
  const tooBig = { k: 'x'.repeat(MAX_CONFIGURATION_CANONICAL_BYTES) };
  assert.throws(() => parseManifest(rosterArm({ configuration: tooBig })), /canonical bytes, over the/);
});

test('a __proto__ key anywhere in the RAW manifest is refused', () => {
  // An earlier version of this test measured that zod SILENTLY DROPS such a
  // key and called it a curiosity. It is not: this document is a public
  // precommitment whose raw bytes are compared at publication, and `cohortId`
  // hashes the PARSED value. Dropping the key lets two different published
  // byte sequences boot as the SAME cohort while the run stamps a
  // configuration that is not the one published — and it skips the post-parse
  // configuration checks, because by then the key is gone.
  const hostile = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
  assert.throws(
    () => parseManifest(rosterArm({ configuration: hostile })),
    /uses the reserved key "__proto__"/,
  );
  // Anywhere, not just in a configuration — `.strict()` cannot catch it either,
  // because the key is gone before the unknown-key check runs.
  const topLevel = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
  assert.throws(() => parseManifest({ ...validManifest(), ...topLevel }), /__proto__/);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('the refusal names WHERE the key is, and an ordinary manifest still parses', () => {
  // The negative control: a build that refused every manifest would satisfy
  // the test above.
  assert.ok(parseManifest(validManifest()));
  const hostile = JSON.parse('{"__proto__": 1}') as Record<string, unknown>;
  assert.throws(
    () => parseManifest(rosterArm({ configuration: hostile })),
    /expectedArmRoster\[0\]\.configuration\.__proto__/,
  );
});
