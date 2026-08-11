import assert from 'node:assert/strict';
import { toolInferenceConfigSha256 } from './toolInferenceConfig.js';
import { test } from 'node:test';
import { BASELINE_POLICY_VERSION, BASELINE_POLICY_VERSIONS, isBaselinePolicyVersion } from './baselines.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { REPAIR_POLICY_VERSION, REPAIR_POLICY_VERSIONS, isRepairPolicyVersion } from './repairPolicy.js';
import { MODEL_PRICE_TABLE_DIGEST, MODEL_PRICE_TABLE_VERSION } from './modelPriceTable.js';
import { cohortId, parseManifest } from './manifest.js';
import { validateManifestAgainstCode } from './manifestValidate.js';
import { APPROVED_REPORTED_MODEL_IDS, ARMS, approvedReportedModelIds } from './providers/index.js';
import { promptScaffoldSha256 } from './prompt.js';
import { MARKETS, SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import type { MarketKey } from './types.js';

/**
 * Semantic manifest↔code validation. The valid fixture is built FROM the running
 * code (real market-policy digest, prompt-scaffold hash, scoring version, and
 * expected arm roster), so a green result proves the checks accept a
 * code-consistent manifest; each mutation proves a specific mismatch is caught.
 */

function codeConsistentRaw(): Record<string, unknown> {
  const arms = defaultExpectedArms();
  return {
    artifactSchemaVersion: 1,
    network: 'polygon',
    sportAllowList: ['mlb'],
    windowStart: '2026-07-16T00:00:00.000Z',
    windowEnd: '2026-07-16T02:00:00.000Z',
    source: 'jsonodds',
    sourceQueryVersion: 'source-query-v1',
    marketPolicyVersion: MARKET_POLICY_VERSION,
    marketPolicyDigest: MARKET_POLICY_DIGEST,
    promptScaffoldSha256: promptScaffoldSha256(),
    expectedArmRoster: arms.map((a) => ({
      participantId: a.participantId,
      provider: a.provider,
      requestedModelId: a.requestedModelId,
      approvedReportedModelIds: a.approvedReportedModelIds,
      configuration: a.configuration,
    })),
    toolInferenceConfigSha256: toolInferenceConfigSha256(),
    // A line-open cohort fires markets independently, so any dispatch may be a
    // single-market fire — every such cohort needs a scoped-capable baseline
    // policy. The full-board default (BASELINE_POLICY_VERSION = v0.2) is refused
    // by the dynamic-cohort gate below.
    baselinePolicyVersion: 'baselines-v0.3.0',
    repairPolicyVersion: REPAIR_POLICY_VERSION,
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: MODEL_PRICE_TABLE_VERSION,
    modelPriceTableDigest: MODEL_PRICE_TABLE_DIGEST,
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
      maxConcurrentProviderRequests: arms.length,
      maxDispatchesPerTick: 10,
    },
    cohortCallCap: 1000,
    cohortSpendCapUsdMicros: 5000000,
  };
}

/** Parse a raw manifest that is structurally valid but may be code-inconsistent. */
function parse(raw: Record<string, unknown>): ReturnType<typeof parseManifest> {
  return parseManifest(raw);
}

test('a code-consistent manifest has no violations', () => {
  assert.deepEqual(validateManifestAgainstCode(parse(codeConsistentRaw())), []);
});

test('unknown marketPolicyVersion is flagged', () => {
  const v = validateManifestAgainstCode(parse({ ...codeConsistentRaw(), marketPolicyVersion: 'market-policy-v2' }));
  assert.ok(v.some((s) => /unknown marketPolicyVersion/.test(s)), v.join('; '));
});

test('marketPolicyDigest mismatch is flagged (wires to the recomputed digest)', () => {
  const v = validateManifestAgainstCode(parse({ ...codeConsistentRaw(), marketPolicyDigest: 'c'.repeat(64) }));
  assert.ok(v.some((s) => /marketPolicyDigest mismatch/.test(s)), v.join('; '));
});

test('a code-consistent manifest has no modelPriceTable violation', () => {
  const v = validateManifestAgainstCode(parse(codeConsistentRaw()));
  assert.ok(!v.some((s) => /modelPriceTable/.test(s)), v.join('; '));
});

test('unknown modelPriceTableVersion is flagged, and does not also produce a digest mismatch', () => {
  // prices-v99 is genuinely unregistered (v1/v2/v3 are the known versions).
  const v = validateManifestAgainstCode(parse({ ...codeConsistentRaw(), modelPriceTableVersion: 'prices-v99' }));
  assert.ok(v.some((s) => /unknown modelPriceTableVersion/.test(s)), v.join('; '));
  assert.ok(!v.some((s) => /modelPriceTableDigest mismatch/.test(s)), v.join('; '));
});

test('modelPriceTableDigest mismatch is flagged (wires to the recomputed digest)', () => {
  const v = validateManifestAgainstCode(parse({ ...codeConsistentRaw(), modelPriceTableDigest: 'c'.repeat(64) }));
  assert.ok(v.some((s) => /modelPriceTableDigest mismatch/.test(s)), v.join('; '));
});

test('a code-consistent manifest has no repair-policy violation', () => {
  const v = validateManifestAgainstCode(parse(codeConsistentRaw()));
  assert.ok(!v.some((s) => /repairPolicyVersion|does not match code repair capability/.test(s)), v.join('; '));
});

test('unknown repairPolicyVersion is flagged', () => {
  const v = validateManifestAgainstCode(parse({ ...codeConsistentRaw(), repairPolicyVersion: 'repair-v2' }));
  assert.ok(v.some((s) => s === 'unknown repairPolicyVersion "repair-v2"'), v.join('; '));
});

test('maxRepairAttemptsPerArm must equal the code repair capability (1)', () => {
  for (const cap of [0, 2]) {
    const raw = codeConsistentRaw();
    (raw.constants as Record<string, unknown>).maxRepairAttemptsPerArm = cap;
    const v = validateManifestAgainstCode(parse(raw));
    assert.ok(
      v.some((s) => s === `maxRepairAttemptsPerArm (${cap}) does not match code repair capability (1)`),
      `cap ${cap}: ${v.join('; ')}`,
    );
  }
  // The code-consistent cap of 1 produces no mismatch.
  const ok = validateManifestAgainstCode(parse(codeConsistentRaw()));
  assert.ok(!ok.some((s) => /does not match code repair capability/.test(s)), ok.join('; '));
});

test('an unknown repair version AND a wrong cap are BOTH reported (independent checks)', () => {
  const raw = codeConsistentRaw();
  raw.repairPolicyVersion = 'repair-v2';
  (raw.constants as Record<string, unknown>).maxRepairAttemptsPerArm = 2;
  const v = validateManifestAgainstCode(parse(raw));
  assert.ok(v.some((s) => s === 'unknown repairPolicyVersion "repair-v2"'), v.join('; '));
  assert.ok(
    v.some((s) => s === 'maxRepairAttemptsPerArm (2) does not match code repair capability (1)'),
    v.join('; '),
  );
});

test('a code-consistent manifest has no spend-reservation violation', () => {
  const v = validateManifestAgainstCode(parse(codeConsistentRaw()));
  assert.ok(
    !v.some((s) => /spendReservationPolicyVersion|does not match code spend-reservation policy/.test(s)),
    v.join('; '),
  );
});

test('unknown spendReservationPolicyVersion is flagged, and does not also produce an amount mismatch', () => {
  const v = validateManifestAgainstCode(
    parse({ ...codeConsistentRaw(), spendReservationPolicyVersion: 'fixed-attempt-v2' }),
  );
  assert.ok(v.some((s) => s === 'unknown spendReservationPolicyVersion "fixed-attempt-v2"'), v.join('; '));
  assert.ok(!v.some((s) => /does not match code spend-reservation policy/.test(s)), v.join('; '));
});

test('providerAttemptReservationUsdMicros must equal the code policy amount (100000000)', () => {
  for (const amount of [99_999_999, 100_000_001]) {
    const raw = codeConsistentRaw();
    (raw.constants as Record<string, unknown>).providerAttemptReservationUsdMicros = amount;
    const v = validateManifestAgainstCode(parse(raw));
    assert.ok(
      v.some(
        (s) =>
          s ===
          `providerAttemptReservationUsdMicros (${amount}) does not match code spend-reservation policy (100000000)`,
      ),
      `amount ${amount}: ${v.join('; ')}`,
    );
  }
  // The code-consistent amount produces no mismatch.
  const ok = validateManifestAgainstCode(parse(codeConsistentRaw()));
  assert.ok(!ok.some((s) => /does not match code spend-reservation policy/.test(s)), ok.join('; '));
});

test('an unknown spend version does not cascade an amount mismatch (unknown-version only)', () => {
  const raw = codeConsistentRaw();
  raw.spendReservationPolicyVersion = 'fixed-attempt-v2';
  (raw.constants as Record<string, unknown>).providerAttemptReservationUsdMicros = 99_999_999;
  const v = validateManifestAgainstCode(parse(raw));
  assert.ok(v.some((s) => s === 'unknown spendReservationPolicyVersion "fixed-attempt-v2"'), v.join('; '));
  assert.ok(!v.some((s) => /does not match code spend-reservation policy/.test(s)), v.join('; '));
});

test('unknown baselinePolicyVersion is flagged', () => {
  const v = validateManifestAgainstCode(parse({ ...codeConsistentRaw(), baselinePolicyVersion: 'baselines-v9.9.9' }));
  assert.ok(v.some((s) => /unknown baselinePolicyVersion/.test(s)), v.join('; '));
});

test('a cohort declaring a non-scoped-capable baseline policy is flagged (dynamic-cohort gate)', () => {
  // A line-open cohort fires markets independently, so BOTH full-board policies are
  // refused — a single-market dispatch fails closed under them. This holds
  // regardless of the market policy's enabled set.
  for (const version of [BASELINE_POLICY_VERSION, 'baselines-v0.1.0'] as const) {
    const v = validateManifestAgainstCode(parse({ ...codeConsistentRaw(), baselinePolicyVersion: version }));
    assert.ok(
      v.some((s) => /not scoped-capable.*requires a scoped-capable baseline policy \(baselines-v0\.3\.0\)/.test(s)),
      `${version}: ${v.join('; ')}`,
    );
  }
});

test('the dynamic-cohort gate reads baseline capability only — the market policy cannot relax or require it', () => {
  // Correction-matrix row 3: baseline scoped-capability is the SOLE basis. The
  // market policy's enabled set never gates this — an all-three-enabled policy
  // could not relax it, and even an UNKNOWN market policy does not suppress it
  // (the gate does not consult the policy, so it never throws on the lookup).
  const v = validateManifestAgainstCode(
    parse({ ...codeConsistentRaw(), marketPolicyVersion: 'market-policy-v2', baselinePolicyVersion: BASELINE_POLICY_VERSION }),
  );
  assert.ok(v.some((s) => /unknown marketPolicyVersion/.test(s)), v.join('; ')); // its own typed refusal
  assert.ok(v.some((s) => /not scoped-capable/.test(s)), v.join('; ')); // capability gate fires independently
});

test('the dynamic-cohort gate does not double-flag an already-unknown baseline version', () => {
  // An unknown baseline version is flagged once (as unknown), not also as a
  // capability mismatch — capability is checked only for a known version.
  const v = validateManifestAgainstCode(parse({ ...codeConsistentRaw(), baselinePolicyVersion: 'baselines-v9.9.9' }));
  assert.ok(v.some((s) => /unknown baselinePolicyVersion/.test(s)), v.join('; '));
  assert.ok(!v.some((s) => /not scoped-capable/.test(s)), v.join('; '));
});

test('promptScaffoldSha256 mismatch is flagged', () => {
  const v = validateManifestAgainstCode(parse({ ...codeConsistentRaw(), promptScaffoldSha256: 'a'.repeat(64) }));
  assert.ok(v.some((s) => /promptScaffoldSha256 mismatch/.test(s)), v.join('; '));
});

test('scoringPolicyVersion mismatch is flagged', () => {
  const v = validateManifestAgainstCode(parse({ ...codeConsistentRaw(), scoringPolicyVersion: 'scoring-v0.0.1' }));
  assert.ok(v.some((s) => /scoringPolicyVersion/.test(s)), v.join('; '));
});

test('an unknown roster participant is flagged', () => {
  const raw = codeConsistentRaw();
  const roster = raw.expectedArmRoster as Array<Record<string, unknown>>;
  roster.push({ participantId: 'ghost', provider: 'openai', requestedModelId: 'x', approvedReportedModelIds: ['x'], configuration: {} });
  (raw.constants as Record<string, unknown>).maxConcurrentProviderRequests = roster.length; // keep capacity valid
  const v = validateManifestAgainstCode(parse(raw));
  assert.ok(v.some((s) => /"ghost" is not a code-supported participant/.test(s)), v.join('; '));
});

test('a roster arm with a wrong provider / model / approved set is flagged', () => {
  const raw = codeConsistentRaw();
  const roster = raw.expectedArmRoster as Array<Record<string, unknown>>;
  const arm = roster[0]!;
  const wrongProvider = { ...raw, expectedArmRoster: [{ ...arm, provider: arm.provider === 'openai' ? 'xai' : 'openai' }, ...roster.slice(1)] };
  assert.ok(validateManifestAgainstCode(parse(wrongProvider)).some((s) => /provider/.test(s)));

  const wrongModel = { ...raw, expectedArmRoster: [{ ...arm, requestedModelId: 'totally-different' }, ...roster.slice(1)] };
  assert.ok(validateManifestAgainstCode(parse(wrongModel)).some((s) => /requestedModelId/.test(s)));

  const wrongApproved = { ...raw, expectedArmRoster: [{ ...arm, approvedReportedModelIds: ['not-a-real-alias'] }, ...roster.slice(1)] };
  assert.ok(validateManifestAgainstCode(parse(wrongApproved)).some((s) => /approvedReportedModelIds do not match/.test(s)));
});

test('a duplicate roster participantId is flagged', () => {
  const raw = codeConsistentRaw();
  const roster = raw.expectedArmRoster as Array<Record<string, unknown>>;
  roster.push({ ...roster[0]! }); // duplicate the first arm
  (raw.constants as Record<string, unknown>).maxConcurrentProviderRequests = roster.length;
  const v = validateManifestAgainstCode(parse(raw));
  assert.ok(v.some((s) => /duplicate roster participantId/.test(s)), v.join('; '));
});

test('a roster missing a code arm (subset) is flagged', () => {
  const raw = codeConsistentRaw();
  const roster = raw.expectedArmRoster as unknown[];
  roster.pop(); // drop a code arm → roster no longer equals the full code set
  (raw.constants as Record<string, unknown>).maxConcurrentProviderRequests = roster.length;
  const v = validateManifestAgainstCode(parse(raw));
  assert.ok(v.some((s) => /is missing from the roster/.test(s)), v.join('; '));
});

test('insufficient concurrency for the full roster is flagged', () => {
  const raw = codeConsistentRaw();
  const roster = raw.expectedArmRoster as unknown[];
  (raw.constants as Record<string, unknown>).maxConcurrentProviderRequests = roster.length - 1;
  const v = validateManifestAgainstCode(parse(raw));
  assert.ok(v.some((s) => /maxConcurrentProviderRequests .* < expectedArmRoster.length/.test(s)), v.join('; '));
});

test('canonical registries are frozen — no post-preflight mutation drifts behavior or cohortId', () => {
  const m = parse(codeConsistentRaw());
  assert.deepEqual(validateManifestAgainstCode(m), []); // clean preflight
  const id0 = cohortId(m);
  const firstId = ARMS[0]!.participantId;
  const armModelBefore = ARMS[0]!.requestedModelId;
  const approvedBefore = [...approvedReportedModelIds(firstId)];
  const baselineKnownBefore = isBaselinePolicyVersion('baselines-v9.9.9'); // false
  const marketsBefore = [...MARKETS];

  // (a) replace an arm's requested model — frozen registry → throws.
  assert.throws(() => {
    (ARMS[0] as unknown as { requestedModelId: string }).requestedModelId = 'evil';
  });
  // (b) push an approved reported-model ID, via the accessor and directly → throws.
  assert.throws(() => approvedReportedModelIds(firstId).push('evil-alias'));
  assert.throws(() => (APPROVED_REPORTED_MODEL_IDS[firstId] as string[]).push('evil-alias'));
  // (c) mutate the array returned by defaultExpectedArms() — a caller-owned copy,
  //     so it affects ONLY the copy, never the canonical registry (no `any` cast).
  const roster = defaultExpectedArms();
  roster[0]!.approvedReportedModelIds.push('local-only');
  assert.ok(!approvedReportedModelIds(firstId).includes('local-only'));
  // (d) append a fake baseline version — frozen → throws; membership unchanged.
  assert.throws(() => (BASELINE_POLICY_VERSIONS as unknown as string[]).push('baselines-v9.9.9'));
  // (e) remove/replace scoring markets — frozen → throws.
  assert.throws(() => (MARKETS as unknown as MarketKey[]).push('total'));
  assert.throws(() => {
    (MARKETS as unknown as { length: number }).length = 1;
  });
  // (f) append a fake repair-policy version — frozen → throws; membership unchanged.
  assert.throws(() => (REPAIR_POLICY_VERSIONS as unknown as string[]).push('repair-v2'));
  assert.equal(isRepairPolicyVersion('repair-v2'), false);

  // Nothing drifted: registries, known-version membership, cohortId, re-preflight.
  assert.equal(ARMS[0]!.requestedModelId, armModelBefore);
  assert.deepEqual(approvedReportedModelIds(firstId), approvedBefore);
  assert.equal(isBaselinePolicyVersion('baselines-v9.9.9'), baselineKnownBefore);
  assert.deepEqual([...MARKETS], marketsBefore);
  assert.equal(cohortId(m), id0);
  assert.deepEqual(validateManifestAgainstCode(m), []);
});

test('toolInferenceConfigSha256 mismatch is flagged — the declared tool config must recompute from code', () => {
  const v = validateManifestAgainstCode(parse({ ...codeConsistentRaw(), toolInferenceConfigSha256: 'd'.repeat(64) }));
  assert.ok(v.some((s) => /toolInferenceConfigSha256 mismatch/.test(s)), v.join('; '));
});

// ---------------------------------------------------------------------------
// Participant configuration
// ---------------------------------------------------------------------------

/** A manifest whose FIRST roster arm declares `configuration`, everything else intact. */
function withFirstArmConfiguration(configuration: Record<string, unknown>): ReturnType<typeof parseManifest> {
  const raw = codeConsistentRaw();
  const roster = [...(raw['expectedArmRoster'] as Array<Record<string, unknown>>)];
  roster[0] = { ...roster[0]!, configuration };
  return parse({ ...raw, expectedArmRoster: roster });
}

test('a roster configuration that disagrees with the code is flagged, by digest', () => {
  const violations = validateManifestAgainstCode(
    withFirstArmConfiguration({ reasoning: { effort: 'high' } }),
  );
  assert.ok(
    violations.some((v) => /configuration [0-9a-f]{64} != code [0-9a-f]{64}/.test(v)),
    JSON.stringify(violations),
  );
});

test('the code-consistent roster passes the configuration check', () => {
  // The negative control: without it, a build that flagged EVERY configuration
  // would satisfy the test above.
  assert.ok(!validateManifestAgainstCode(parse(codeConsistentRaw())).some((v) => /configuration/.test(v)));
});

test('a configuration that could not be merged into the request is flagged', () => {
  // `max_output_tokens` is the cohort's own output cap on the Responses API,
  // and the first code arm is an openai arm. A manifest declaring it would
  // move spend past what a fire reserved, so it is refused at boot rather than
  // thrown mid-fire with provider calls already committed.
  const violations = validateManifestAgainstCode(
    withFirstArmConfiguration({ max_output_tokens: 999_999 }),
  );
  assert.ok(
    violations.some((v) => /configuration cannot be merged into the initial leg/.test(v)),
    JSON.stringify(violations),
  );
});

test('a configuration colliding on ONE leg only is still flagged', () => {
  // The reason the legs are enumerated rather than sampled: a repair carries
  // no tool block, so this collides on the initial leg and not on the repair.
  // A check that looked only at the repair would pass it.
  const violations = validateManifestAgainstCode(withFirstArmConfiguration({ tools: [] }));
  assert.ok(
    violations.some((v) => /cannot be merged into the initial leg/.test(v)),
    JSON.stringify(violations),
  );
  assert.ok(!violations.some((v) => /cannot be merged into the repair leg/.test(v)));
});

test('an additive configuration is NOT flagged as unmergeable', () => {
  // The positive control for the two tests above. If adding were refused too,
  // both would still pass and the feature would be unusable.
  const violations = validateManifestAgainstCode(
    withFirstArmConfiguration({ reasoning: { effort: 'high' } }),
  );
  assert.ok(
    !violations.some((v) => /cannot be merged/.test(v)),
    `an added key must merge cleanly: ${JSON.stringify(violations)}`,
  );
});

test('a configuration carrying a live credential is refused - the manifest is published', () => {
  const priorKey = process.env['OPENAI_API_KEY'];
  process.env['OPENAI_API_KEY'] = 'sk-synthetic-value-generated-for-this-test-only';
  try {
    const violations = validateManifestAgainstCode(
      withFirstArmConfiguration({ note: process.env['OPENAI_API_KEY'] }),
    );
    assert.ok(
      violations.some((v) => /contains a value matching a credential in this environment/.test(v)),
      JSON.stringify(violations),
    );
    // And the refusal must not quote the value it is refusing.
    for (const violation of violations) {
      assert.ok(!violation.includes('sk-synthetic'), 'the refusal must not echo the credential');
    }
  } finally {
    if (priorKey === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = priorKey;
  }
});

test('an ordinary configuration is not mistaken for a credential', () => {
  // Negative control for the check above: it must key on the actual secret
  // VALUE, not on a key name that looks sensitive.
  const priorKey = process.env['OPENAI_API_KEY'];
  process.env['OPENAI_API_KEY'] = 'sk-synthetic-value-generated-for-this-test-only';
  try {
    const violations = validateManifestAgainstCode(
      withFirstArmConfiguration({ api_key_style: 'bearer', token_budget: 8192 }),
    );
    assert.ok(!violations.some((v) => /matching a credential/.test(v)), JSON.stringify(violations));
  } finally {
    if (priorKey === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = priorKey;
  }
});

test('two roster arms that are the same ENTRANT are refused at boot', () => {
  // The post-run identity gate already refuses this, but it runs on RESPONSES:
  // the refusal arrives after a full night of provider spend and arrives as a
  // permanently unscoreable artifact. It is decidable from the roster alone.
  const raw = codeConsistentRaw();
  const roster = [...(raw['expectedArmRoster'] as Array<Record<string, unknown>>)];
  roster.push({ ...roster[0]!, participantId: 'openai-gpt-5.6-sol-again' });
  const violations = validateManifestAgainstCode(parse({ ...raw, expectedArmRoster: roster }));
  assert.ok(
    violations.some((v) => /are the same entrant: model .* under the identical configuration/.test(v)),
    JSON.stringify(violations),
  );
});

test('two roster arms of one model at DIFFERENT configurations are not the same entrant', () => {
  // The negative control. Both entries also trip the code-comparison checks
  // (neither matches a code arm's configuration), so this asserts the ABSENCE
  // of the entrant violation specifically rather than an empty result.
  const raw = codeConsistentRaw();
  const roster = [...(raw['expectedArmRoster'] as Array<Record<string, unknown>>)];
  roster[0] = { ...roster[0]!, configuration: { reasoning: { effort: 'low' } } };
  roster.push({
    ...roster[0]!,
    participantId: 'openai-gpt-5.6-sol-high',
    configuration: { reasoning: { effort: 'high' } },
  });
  const violations = validateManifestAgainstCode(parse({ ...raw, expectedArmRoster: roster }));
  assert.ok(!violations.some((v) => /are the same entrant/.test(v)), JSON.stringify(violations));
});

test('the credential check runs on an entry the other roster guards would skip', () => {
  // Both the duplicate-id and unknown-participant guards `continue`, and the
  // configuration checks used to sit after them — so exactly the two entries a
  // hand-edited roster produces got a schema complaint and no word about what
  // was in the file. The diagnostic is the whole value of that check.
  const priorKey = process.env['OPENAI_API_KEY'];
  process.env['OPENAI_API_KEY'] = 'sk-synthetic-value-generated-for-this-test-only';
  try {
    const raw = codeConsistentRaw();
    const roster = [...(raw['expectedArmRoster'] as Array<Record<string, unknown>>)];
    roster.push({
      participantId: 'ghost',
      provider: 'openai',
      requestedModelId: 'x',
      approvedReportedModelIds: ['x'],
      configuration: { note: process.env['OPENAI_API_KEY'] },
    });
    const violations = validateManifestAgainstCode(parse({ ...raw, expectedArmRoster: roster }));
    assert.ok(
      violations.some((v) => /is not a code-supported participant/.test(v)),
      'the unknown-participant guard still fires',
    );
    assert.ok(
      violations.some((v) => /matching a credential in this environment/.test(v)),
      `and the credential is still reported: ${JSON.stringify(violations)}`,
    );
    for (const violation of violations) {
      assert.ok(!violation.includes('sk-synthetic'), 'the refusal must not echo the credential');
    }
  } finally {
    if (priorKey === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = priorKey;
  }
});
