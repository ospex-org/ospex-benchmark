import assert from 'node:assert/strict';
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
    })),
    toolInferenceConfigSha256: 'b'.repeat(64),
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
  const v = validateManifestAgainstCode(parse({ ...codeConsistentRaw(), modelPriceTableVersion: 'prices-v2' }));
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
  roster.push({ participantId: 'ghost', provider: 'openai', requestedModelId: 'x', approvedReportedModelIds: ['x'] });
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
