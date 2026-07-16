import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASELINE_POLICY_VERSION } from './baselines.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { parseManifest } from './manifest.js';
import { validateManifestAgainstCode } from './manifestValidate.js';
import { promptScaffoldSha256 } from './prompt.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';

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
    baselinePolicyVersion: BASELINE_POLICY_VERSION,
    repairPolicyVersion: 'repair-v1',
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: 'prices-v1',
    modelPriceTableDigest: 'c'.repeat(64),
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

test('unknown baselinePolicyVersion is flagged', () => {
  const v = validateManifestAgainstCode(parse({ ...codeConsistentRaw(), baselinePolicyVersion: 'baselines-v9.9.9' }));
  assert.ok(v.some((s) => /unknown baselinePolicyVersion/.test(s)), v.join('; '));
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
