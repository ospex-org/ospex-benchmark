import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkProviderCollision } from './providers/family.js';
import { configurationSha256, EMPTY_CONFIGURATION_SHA256 } from './participantConfiguration.js';
import type { CollisionCheckInput } from './providers/family.js';

const LOW = configurationSha256({ reasoning: { effort: 'low' } });
const HIGH = configurationSha256({ reasoning: { effort: 'high' } });

function arm(overrides: Partial<CollisionCheckInput>): CollisionCheckInput {
  return {
    participantId: 'openai-arm',
    provider: 'openai',
    requestedModelId: 'gpt-5.6-sol',
    approvedReportedModelIds: ['gpt-5.6-sol'],
    configurationSha256: EMPTY_CONFIGURATION_SHA256,
    reportedModelIds: ['gpt-5.6-sol'],
    unidentifiedResponses: 0,
    ...overrides,
  };
}

test('exact approved reported ID passes with no failures', () => {
  const result = checkProviderCollision([arm({})]);
  assert.deepEqual(result.failures, []);
});

test('same-family substitution fails closed (gpt-5.6-sol requested, gpt-4o reported)', () => {
  const result = checkProviderCollision([arm({ reportedModelIds: ['gpt-4o-2026-01-01'] })]);
  assert.ok(result.failures.some((f) => f.includes('unapproved model ID "gpt-4o-2026-01-01"')));
});

test('model drift across games fails even when every ID is approved', () => {
  const result = checkProviderCollision([
    arm({
      approvedReportedModelIds: ['gpt-5.6-sol', 'gpt-5.6-sol-2026-05-01'],
      reportedModelIds: ['gpt-5.6-sol', 'gpt-5.6-sol-2026-05-01'],
    }),
  ]);
  assert.ok(result.failures.some((f) => f.includes('model drift')));
});

test('a cross-lab substitution is caught twice over', () => {
  const result = checkProviderCollision([
    arm({}),
    arm({
      participantId: 'google-arm',
      provider: 'google',
      requestedModelId: 'gemini-3.1-pro-preview',
      approvedReportedModelIds: ['gemini-3.1-pro-preview'],
      reportedModelIds: ['gpt-5.6-sol'],
    }),
  ]);
  // Once because the reported family contradicts the provider it was asked of,
  // and once because the two arms are now indistinguishable as entrants: same
  // reported model, same (empty) configuration.
  assert.ok(
    result.failures.some((f) => f.includes('requested from google') && f.includes('openai family')),
  );
  assert.ok(
    result.failures.some(
      (f) => f.includes('identical model ID') && f.includes('identical configuration'),
    ),
  );
  // And a third time by the approved-ID allowlist, which is what makes the
  // retired "multiple arms resolve to one family" rule redundant rather than
  // merely inconvenient.
  assert.ok(result.failures.some((f) => f.includes('unapproved model ID "gpt-5.6-sol"')));
});

test('two arms of ONE model at different configurations are two entrants, not a collision', () => {
  const result = checkProviderCollision([
    arm({ participantId: 'openai-low', configurationSha256: LOW }),
    arm({ participantId: 'openai-high', configurationSha256: HIGH }),
  ]);
  assert.deepEqual(result.failures, []);
});

test('two arms of one model at the SAME configuration are one entrant entered twice', () => {
  // The negative control for the test above: the rule still refuses a roster
  // that runs fewer distinct competitors than its operator believes.
  const result = checkProviderCollision([
    arm({ participantId: 'openai-low', configurationSha256: LOW }),
    arm({ participantId: 'openai-also-low', configurationSha256: LOW }),
  ]);
  assert.ok(
    result.failures.some(
      (f) =>
        f.startsWith('PROVIDER_COLLISION') &&
        f.includes('openai-low') &&
        f.includes('openai-also-low') &&
        f.includes(LOW),
    ),
    `expected an entrant collision naming both arms and the shared digest, got ${JSON.stringify(result.failures)}`,
  );
});

test('two DIFFERENT models from one lab are not a collision', () => {
  // Refused outright by the retired family rule; the point of the cohort now.
  const result = checkProviderCollision([
    arm({}),
    arm({
      participantId: 'openai-terra',
      requestedModelId: 'gpt-5.6-terra',
      approvedReportedModelIds: ['gpt-5.6-terra'],
      reportedModelIds: ['gpt-5.6-terra'],
    }),
  ]);
  assert.deepEqual(result.failures, []);
});

test('a SUCCESSFUL response without a reported model ID fails the run', () => {
  const result = checkProviderCollision([
    arm({ reportedModelIds: [], unidentifiedResponses: 2 }),
  ]);
  assert.ok(
    result.failures.some(
      (f) => f.startsWith('MODEL_IDENTITY') && f.includes('without a reported model ID'),
    ),
  );
});

test('a mix of identified and unidentified successful responses still fails', () => {
  const result = checkProviderCollision([
    arm({ reportedModelIds: ['gpt-5.6-sol'], unidentifiedResponses: 1 }),
  ]);
  assert.ok(result.failures.some((f) => f.includes('without a reported model ID')));
});

test('an arm with no successful response at all is a loud warning, not a failure', () => {
  const result = checkProviderCollision([
    arm({ reportedModelIds: [], unidentifiedResponses: 0 }),
  ]);
  assert.deepEqual(result.failures, []);
  assert.ok(result.warnings.some((w) => w.includes('provider identity unverified')));
});
