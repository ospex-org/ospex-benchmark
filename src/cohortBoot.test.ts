import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASELINE_POLICY_VERSION } from './baselines.js';
import { CohortBootError, cohortBoot } from './cohortBoot.js';
import type { CanonicalOverrides } from './cohortBoot.js';
import { cohortId, parseManifest } from './manifest.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { promptScaffoldSha256 } from './prompt.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';

/**
 * The canonical boot gate. The valid fixture is built FROM the running code (real
 * market-policy digest, prompt-scaffold hash, scoring version, and expected arm
 * roster), so a clean boot proves the gate accepts a code-consistent manifest;
 * each mutation proves a specific refusal — `--live`, a bad manifest, a code
 * mismatch, or a canonical override that diverges from the manifest.
 */

const LOCKED_CONSTANTS = {
  pollIntervalMs: 30000,
  providerCallTimeoutMs: 300000,
  maxOutputTokens: 16000,
  gameDiscoveryWindowHours: 168,
  maxDispatchesPerTick: 10,
} as const;

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
    // MLB under market-policy-v1 is scoped (moneyline + total, run line OFF), so a
    // code-consistent manifest must declare the scoped baseline policy; the
    // full-board default (BASELINE_POLICY_VERSION = v0.2) is refused by the
    // dynamic-cohort gate (see the boot-refusal test below).
    baselinePolicyVersion: 'baselines-v0.3.0',
    repairPolicyVersion: 'repair-v1',
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: 'prices-v1',
    modelPriceTableDigest: 'c'.repeat(64),
    runnerCommitSha: 'd'.repeat(40),
    constants: {
      pollIntervalMs: LOCKED_CONSTANTS.pollIntervalMs,
      cleanEntryWindowMs: 120000,
      gameDiscoveryWindowHours: LOCKED_CONSTANTS.gameDiscoveryWindowHours,
      maxClockSkewMs: 5000,
      freshFireMs: 30000,
      maxDispatchLagMs: 10000,
      historyReadTimeoutMs: 30000,
      providerCallTimeoutMs: LOCKED_CONSTANTS.providerCallTimeoutMs,
      maxOutputTokens: LOCKED_CONSTANTS.maxOutputTokens,
      maxRepairAttemptsPerArm: 1,
      ingestionGraceMs: 900000,
      scheduleChangeToleranceMs: 60000,
      maxConcurrentProviderRequests: arms.length,
      maxDispatchesPerTick: LOCKED_CONSTANTS.maxDispatchesPerTick,
    },
    cohortCallCap: 1000,
    cohortSpendCapUsdMicros: 5000000,
  };
}

/** A booting request from a raw manifest object (JSON-serialized to bytes). */
function req(raw: Record<string, unknown>, extra: Partial<Omit<CohortBootRequest, 'manifestBytes'>> = {}) {
  return { live: false, manifestBytes: JSON.stringify(raw), ...extra };
}
type CohortBootRequest = Parameters<typeof cohortBoot>[0];

test('a code-consistent manifest boots and returns the derived cohortId + manifest', () => {
  const raw = codeConsistentRaw();
  const booted = cohortBoot(req(raw));
  assert.equal(booted.cohortId, cohortId(parseManifest(raw)));
  assert.deepEqual(booted.manifest, parseManifest(raw));
});

test('--live is hard-disabled — refused BEFORE the manifest is even parsed', () => {
  // Garbage bytes: if `--live` were not checked first, this would surface a JSON
  // error instead of the live refusal.
  const err = assertBootError(() => cohortBoot({ live: true, manifestBytes: 'not json at all' }));
  assert.deepEqual(err.violations, ['--live is hard-disabled']);
  assert.match(err.message, /remove --live/);
  // Also refused with an otherwise-valid manifest.
  const err2 = assertBootError(() => cohortBoot(req(codeConsistentRaw(), { live: true })));
  assert.deepEqual(err2.violations, ['--live is hard-disabled']);
});

test('invalid JSON fails boot', () => {
  const err = assertBootError(() => cohortBoot({ live: false, manifestBytes: '{ not json' }));
  assert.match(err.message, /not valid JSON/);
});

test('a structurally invalid manifest (unknown field) fails boot', () => {
  const err = assertBootError(() => cohortBoot(req({ ...codeConsistentRaw(), sneaky: 'secret' })));
  assert.match(err.message, /invalid cohort manifest/);
});

test('a code-inconsistent manifest (wrong scoringPolicyVersion) fails boot', () => {
  const err = assertBootError(() =>
    cohortBoot(req({ ...codeConsistentRaw(), scoringPolicyVersion: 'scoring-v0.0.1' })),
  );
  assert.ok(err.violations.some((v) => /scoringPolicyVersion/.test(v)), err.violations.join('; '));
});

test('a scoped cohort declaring a full-board baseline policy is refused (dynamic-cohort gate)', () => {
  // The MLB fixture is scoped (market-policy-v1: moneyline + total), so the
  // full-board default v0.2 must fail boot — the canonical gate refuses a manifest
  // that would fail closed at the producers on a 2-market game.
  const err = assertBootError(() =>
    cohortBoot(req({ ...codeConsistentRaw(), baselinePolicyVersion: BASELINE_POLICY_VERSION })),
  );
  assert.ok(
    err.violations.some((v) => /requires a full three-market board.*is scoped.*requires baselines-v0\.3\.0/.test(v)),
    err.violations.join('; '),
  );
});

test('capacity below the roster fails boot (case 38)', () => {
  const raw = codeConsistentRaw();
  const roster = raw.expectedArmRoster as unknown[];
  // A capacity strictly below the roster is only expressible as a positive integer
  // when the roster has >= 2 arms; guard so a future 1-arm roster fails here
  // clearly rather than tripping the schema's positive-integer floor first and
  // refusing for the wrong reason.
  assert.ok(roster.length >= 2, 'case-38 needs a roster of >= 2 arms');
  (raw.constants as Record<string, unknown>).maxConcurrentProviderRequests = roster.length - 1;
  const err = assertBootError(() => cohortBoot(req(raw)));
  assert.ok(
    err.violations.some((v) => /maxConcurrentProviderRequests .* < expectedArmRoster\.length/.test(v)),
    err.violations.join('; '),
  );
});

test('a canonical override byte-equal to the manifest is allowed', () => {
  const raw = codeConsistentRaw();
  const overrides: CanonicalOverrides = { ...LOCKED_CONSTANTS };
  const booted = cohortBoot(req(raw, { overrides }));
  assert.equal(booted.cohortId, cohortId(parseManifest(raw)));
});

test('every locked canonical override that diverges from the manifest fails boot (case 18)', () => {
  for (const [key, value] of Object.entries(LOCKED_CONSTANTS)) {
    const overrides = { [key]: value + 1 } as CanonicalOverrides;
    const err = assertBootError(() => cohortBoot(req(codeConsistentRaw(), { overrides })));
    assert.ok(
      err.violations.some((v) => v.includes(`canonical override ${key}`)),
      `${key}: ${err.violations.join('; ')}`,
    );
  }
});

test('a supplied non-canonical lever fails boot', () => {
  const overrides: CanonicalOverrides = { nonCanonical: ['late-minutes'] };
  const err = assertBootError(() => cohortBoot(req(codeConsistentRaw(), { overrides })));
  assert.ok(
    err.violations.some((v) => /late-minutes is not a canonical lever/.test(v)),
    err.violations.join('; '),
  );
});

test('code and config-lock violations accumulate into one refusal', () => {
  const raw = { ...codeConsistentRaw(), scoringPolicyVersion: 'scoring-v0.0.1' };
  const overrides: CanonicalOverrides = { maxOutputTokens: LOCKED_CONSTANTS.maxOutputTokens + 1 };
  const err = assertBootError(() => cohortBoot(req(raw, { overrides })));
  assert.ok(err.violations.some((v) => /scoringPolicyVersion/.test(v)), err.violations.join('; '));
  assert.ok(err.violations.some((v) => /canonical override maxOutputTokens/.test(v)), err.violations.join('; '));
});

test('the booted manifest is deep-frozen — no post-boot cast can drift the config or cohortId', () => {
  const raw = codeConsistentRaw();
  const booted = cohortBoot(req(raw));
  const before = booted.cohortId;

  // (a) mutate a locked constant.
  assert.throws(() => {
    (booted.manifest as unknown as { constants: { maxOutputTokens: number } }).constants.maxOutputTokens = 1;
  });
  // (b) grow an eligibility array (sportAllowList) and a nested roster array.
  assert.throws(() => (booted.manifest.sportAllowList as string[]).push('nfl'));
  assert.throws(() =>
    (booted.manifest.expectedArmRoster[0]!.approvedReportedModelIds as string[]).push('evil-alias'),
  );
  // (c) reassign a field on the returned result.
  assert.throws(() => {
    (booted as unknown as { cohortId: string }).cohortId = 'forged';
  });

  // Nothing drifted.
  assert.equal(booted.cohortId, before);
  assert.equal(booted.cohortId, cohortId(parseManifest(raw)));
});

test('cohortId is independent of manifest byte formatting (whitespace / key order)', () => {
  const raw = codeConsistentRaw();
  const compact = cohortBoot({ live: false, manifestBytes: JSON.stringify(raw) });
  const pretty = cohortBoot({ live: false, manifestBytes: JSON.stringify(raw, null, 2) });
  // Reversed top-level key order — same semantic object, different bytes.
  const reordered = Object.fromEntries(Object.entries(raw).reverse());
  const shuffled = cohortBoot({ live: false, manifestBytes: JSON.stringify(reordered) });
  assert.equal(compact.cohortId, pretty.cohortId);
  assert.equal(compact.cohortId, shuffled.cohortId);
});

/** Assert the thunk throws a `CohortBootError` and return it for inspection. */
function assertBootError(fn: () => unknown): CohortBootError {
  let caught: unknown;
  assert.throws(fn, (error: unknown) => {
    caught = error;
    return error instanceof CohortBootError;
  });
  return caught as CohortBootError;
}
