import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkProviderCollision } from './providers/family.js';
import type { CollisionCheckInput } from './providers/family.js';

function arm(overrides: Partial<CollisionCheckInput>): CollisionCheckInput {
  return {
    participantId: 'openai-arm',
    provider: 'openai',
    requestedModelId: 'gpt-5.6-sol',
    approvedReportedModelIds: ['gpt-5.6-sol'],
    reportedModelIds: ['gpt-5.6-sol'],
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

test('two arms resolving to the same family is a collision', () => {
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
  assert.ok(result.failures.some((f) => f.includes('multiple arms resolve to the openai family')));
  assert.ok(result.failures.some((f) => f.includes('identical model ID')));
  assert.ok(
    result.failures.some((f) => f.includes('requested from google') && f.includes('openai family')),
  );
});

test('an arm reporting no model ID is a loud warning, not a silent pass', () => {
  const result = checkProviderCollision([arm({ reportedModelIds: [] })]);
  assert.deepEqual(result.failures, []);
  assert.ok(result.warnings.some((w) => w.includes('provider identity unverified')));
});
