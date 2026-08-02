import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertCohortAdapterCapability,
  CohortAdapterCapabilityError,
  createCohortMockAdapterCapability,
  mintInjectedAdapterCapability,
} from './cohortAdapterCapability.js';
import { defaultExpectedArms } from './scoring.js';
import type { ChatTurn, ProviderAdapter, ProviderResponse } from './types.js';

/**
 * The opaque adapter capability's brand, capture, and immutability contract: raw maps and
 * lookalikes fail; entries and method facades are captured once at mint; nothing mutable
 * is exposed. The SEAM-level rejections (runOneFire / runCohortTick) are proven in the
 * spine and cohort-runner suites; this file owns the capability object itself.
 */

function adapterFixture(marker: string): ProviderAdapter & { swapped?: boolean } {
  return {
    provider: 'anthropic',
    requestedModelId: 'claude-fable-5',
    credentialEnvVar: 'FIXTURE_KEY',
    hasCredential: () => true,
    async chat(_t: ChatTurn[], _ms: number): Promise<ProviderResponse> {
      return {
        rawText: marker,
        reportedModelId: 'claude-fable-5',
        providerResponseId: 'x',
        httpStatus: 200,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        usageRaw: {},
        requestParams: {},
      };
    },
  };
}

test('the brand rejects a raw map, a structural lookalike, and a spread copy of a genuine capability', () => {
  const genuine = mintInjectedAdapterCapability({ adapters: new Map(), billingClass: 'known-zero' });
  assert.doesNotThrow(() => assertCohortAdapterCapability(genuine));
  const impostors: unknown[] = [
    new Map<string, ProviderAdapter>(),
    { billingClass: 'known-zero', adapters: () => new Map() },
    { ...genuine },
    null,
    'known-zero',
  ];
  for (const impostor of impostors) {
    assert.throws(
      () => assertCohortAdapterCapability(impostor),
      (e: unknown) => e instanceof CohortAdapterCapabilityError,
    );
  }
});

test('the capability is frozen: billingClass cannot be flipped after minting', () => {
  const cap = mintInjectedAdapterCapability({ adapters: new Map(), billingClass: 'billable' });
  assert.ok(Object.isFrozen(cap));
  assert.throws(() => {
    (cap as { billingClass: string }).billingClass = 'known-zero';
  }, TypeError);
  assert.equal(cap.billingClass, 'billable', 'the minted class is unchanged');
});

test('entries and facades are captured at mint: source-map and source-adapter mutation are ineffective', async () => {
  const original = adapterFixture('original-response');
  const source = new Map<string, ProviderAdapter>([['arm-1', original]]);
  const cap = mintInjectedAdapterCapability({ adapters: source, billingClass: 'known-zero' });

  // Mutate the SOURCE map after minting: delete the entry, add a hostile one.
  source.delete('arm-1');
  source.set('arm-2', adapterFixture('hostile'));
  const snapshot = cap.adapters();
  assert.deepEqual([...snapshot.keys()], ['arm-1'], 'the capture is the mint-time entry set');

  // Swap the SOURCE adapter's method after minting: the captured facade was bound at mint.
  (original as { chat: unknown }).chat = () => {
    throw new Error('swapped chat must never run through the capability');
  };
  const viaCapability = await snapshot.get('arm-1')!.chat([], 1_000);
  assert.equal(viaCapability.rawText, 'original-response', 'the mint-time facade still runs');
});

test('mutating a returned adapters() map cannot affect the capability', () => {
  const source = new Map<string, ProviderAdapter>([['arm-1', adapterFixture('a')]]);
  const cap = mintInjectedAdapterCapability({ adapters: source, billingClass: 'known-zero' });
  const first = cap.adapters() as Map<string, ProviderAdapter>;
  first.delete('arm-1');
  first.set('arm-x', adapterFixture('x'));
  assert.deepEqual([...cap.adapters().keys()], ['arm-1'], 'each call returns a fresh capture snapshot');
});

test('the production mock producer mints known-zero over its OWN full roster — no caller map', () => {
  const cap = createCohortMockAdapterCapability({ simulateCollision: false });
  assert.doesNotThrow(() => assertCohortAdapterCapability(cap));
  assert.equal(cap.billingClass, 'known-zero');
  const adapters = cap.adapters();
  for (const arm of defaultExpectedArms()) {
    assert.ok(adapters.has(arm.participantId), `mock adapter present for ${arm.participantId}`);
  }
});
