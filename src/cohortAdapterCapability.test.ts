import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertCohortAdapterCapability,
  CanaryAuthorizationError,
  CohortAdapterCapabilityError,
  createCohortMockAdapterCapability,
  gateRealCohortAdapterCapability,
  mintInjectedAdapterCapability,
} from './cohortAdapterCapability.js';
import type { CanaryAuthorization } from './cohortAdapterCapability.js';
import { cohortBoot } from './cohortBoot.js';
import type { BootedCohort } from './cohortBoot.js';
import { SPEND_GUARD_PRICE_TABLE_VERSION, modelPriceTableDigest } from './modelPriceTable.js';
import { CROSSING_PROFILE, buildCrossingManifest } from './crossingProfile.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';
import type { RehearsalManifestOptions } from './rehearsalManifest.js';
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

test('entries and facades are captured at mint: source-map and source-method replacement are ineffective', async () => {
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

// ===========================================================================
// The GATED real producer: strict authorization capture, exact-cohort binding,
// pinned-crossing-profile conformance, and INDEPENDENT credential observation.
// Everything runs over synthetic env credentials (never real keys) and a
// throwing fetch (minting must make no network call).
// ===========================================================================

const FIXED_NOW = Date.parse('2026-07-18T12:00:00.000Z');
const ROSTER = defaultExpectedArms().map((a) => a.participantId);

/** Synthetic provider credentials (never real keys); Google exercises its primary var. */
const SYNTHETIC_PROVIDER_ENV: Record<string, string | undefined> = {
  OPENAI_API_KEY: 'synthetic-test-credential',
  ANTHROPIC_API_KEY: 'synthetic-test-credential',
  GEMINI_API_KEY: 'synthetic-test-credential',
  GOOGLE_API_KEY: undefined,
  XAI_API_KEY: 'synthetic-test-credential',
};

/** Apply `vars` to the environment (undefined = deleted) for the duration of `fn`. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Run `fn` under a THROWING `globalThis.fetch` — a mint that touches the network fails here. */
function withThrowingFetch<T>(fn: () => T): T {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('network reached during a capability mint');
  }) as typeof fetch;
  try {
    return fn();
  } finally {
    globalThis.fetch = original;
  }
}

function bootedCrossing(now: number = FIXED_NOW): BootedCohort {
  return cohortBoot({ manifestBytes: buildCrossingManifest(now).bytes });
}

/** A BOOTABLE off-pin cohort: the crossing levers with `over` applied (collusion fixtures). */
function bootedOffPin(over: Partial<RehearsalManifestOptions>): BootedCohort {
  const { bytes } = buildRehearsalManifest(FIXED_NOW, {
    maxConcurrentProviderRequests: CROSSING_PROFILE.maxConcurrentProviderRequests,
    maxDispatchesPerTick: CROSSING_PROFILE.maxDispatchesPerTick,
    cohortCallCap: CROSSING_PROFILE.cohortCallCap,
    cohortSpendCapUsdMicros: CROSSING_PROFILE.cohortSpendCapUsdMicros,
    modelPriceTableVersion: SPEND_GUARD_PRICE_TABLE_VERSION,
    ...over,
  });
  return cohortBoot({ manifestBytes: bytes });
}

/** The exact authorization MATCHING `booted` (identity + caps mirrored from its manifest),
 *  with `over` applied — so a single field can be driven off-binding per tooth. */
function authorizationFor(booted: BootedCohort, over: Partial<Record<keyof CanaryAuthorization, unknown>> = {}): CanaryAuthorization {
  const roster = booted.manifest.expectedArmRoster.map((a) => a.participantId);
  return {
    cohortId: booted.cohortId,
    participantIds: roster,
    modelPriceTableVersion: booted.manifest.modelPriceTableVersion,
    modelPriceTableDigest: booted.manifest.modelPriceTableDigest,
    liveOptIn: true,
    observedCredentialedParticipantIds: roster,
    cohortSpendCapUsdMicros: booted.manifest.cohortSpendCapUsdMicros,
    cohortCallCap: booted.manifest.cohortCallCap,
    maxConcurrentProviderRequests: booted.manifest.constants.maxConcurrentProviderRequests,
    maxDispatchesPerTick: booted.manifest.constants.maxDispatchesPerTick,
    maxRepairAttemptsPerArm: booted.manifest.constants.maxRepairAttemptsPerArm,
    ...over,
  } as CanaryAuthorization;
}

/** Assert the mint refuses with a violation matching `expect`. */
function assertRefused(fn: () => unknown, expect: RegExp, label: string): void {
  assert.throws(
    fn,
    (e: unknown) => {
      if (!(e instanceof CanaryAuthorizationError)) return false;
      assert.ok(
        e.violations.some((v) => expect.test(v)),
        `${label}: expected ${expect} in [${e.violations.join('; ')}]`,
      );
      return true;
    },
    label,
  );
}

test('the gated producer mints a BILLABLE capability of the four real adapter identities — no network', () => {
  withEnv(SYNTHETIC_PROVIDER_ENV, () =>
    withThrowingFetch(() => {
      const booted = bootedCrossing();
      const cap = gateRealCohortAdapterCapability(booted, authorizationFor(booted));
      assert.doesNotThrow(() => assertCohortAdapterCapability(cap));
      assert.equal(cap.billingClass, 'billable');
      assert.ok(Object.isFrozen(cap));
      // The COMPLETE identity tuples, in roster order, each credentialed.
      assert.deepEqual(
        [...cap.adapters().entries()].map(([id, a]) => ({
          id,
          provider: a.provider,
          requestedModelId: a.requestedModelId,
          credentialEnvVar: a.credentialEnvVar,
          hasCredential: a.hasCredential(),
        })),
        [
          { id: 'openai-gpt-5.6-sol', provider: 'openai', requestedModelId: 'gpt-5.6-sol', credentialEnvVar: 'OPENAI_API_KEY', hasCredential: true },
          { id: 'anthropic-claude-fable-5', provider: 'anthropic', requestedModelId: 'claude-fable-5', credentialEnvVar: 'ANTHROPIC_API_KEY', hasCredential: true },
          { id: 'google-gemini-3.1-pro-preview', provider: 'google', requestedModelId: 'gemini-3.1-pro-preview', credentialEnvVar: 'GEMINI_API_KEY', hasCredential: true },
          { id: 'xai-grok-4.5', provider: 'xai', requestedModelId: 'grok-4.5', credentialEnvVar: 'XAI_API_KEY', hasCredential: true },
        ],
      );
    }),
  );
});

test('the captured facades are the REAL adapters, live-bound: a credential removed after mint reads false', () => {
  const cap = withEnv(SYNTHETIC_PROVIDER_ENV, () => {
    const booted = bootedCrossing();
    return gateRealCohortAdapterCapability(booted, authorizationFor(booted));
  });
  // Outside withEnv the synthetic credentials are restored/removed; the bound facade
  // consults the REAL adapter's env probe at call time, not a mint-time snapshot.
  withEnv({ OPENAI_API_KEY: undefined }, () => {
    assert.equal(cap.adapters().get('openai-gpt-5.6-sol')!.hasCredential(), false);
  });
});

test('a forged (structurally-copied) booted cohort fails the boot brand — before any authorization read', () => {
  withEnv(SYNTHETIC_PROVIDER_ENV, () => {
    const genuine = bootedCrossing();
    const forged = { cohortId: genuine.cohortId, manifest: genuine.manifest } as BootedCohort;
    let authorizationTouched = false;
    const trap = new Proxy(authorizationFor(genuine), {
      get: (target, prop, receiver) => {
        authorizationTouched = true;
        return Reflect.get(target, prop, receiver);
      },
      ownKeys: (target) => {
        authorizationTouched = true;
        return Reflect.ownKeys(target);
      },
    });
    assert.throws(() => gateRealCohortAdapterCapability(forged, trap), /not produced by cohortBoot/);
    assert.equal(authorizationTouched, false, 'the authorization was never read for a forged cohort');
  });
});

test('a stale authorization for ANOTHER cohort fails even with equal caps; a manifest change invalidates it', () => {
  withEnv(SYNTHETIC_PROVIDER_ENV, () => {
    const bootedA = bootedCrossing(FIXED_NOW);
    const bootedB = bootedCrossing(FIXED_NOW + 60_000); // same pins, different window → different cohortId
    assert.notEqual(bootedA.cohortId, bootedB.cohortId);
    const authorizationForA = authorizationFor(bootedA);
    // The stale authorization carries EQUAL caps — only the identity differs.
    assertRefused(
      () => gateRealCohortAdapterCapability(bootedB, authorizationForA),
      /cohortId/,
      'stale authorization',
    );
    // And the un-drifted pair still mints (negative control).
    assert.doesNotThrow(() => gateRealCohortAdapterCapability(bootedA, authorizationForA));
  });
});

test('every cap binds by EXACT equality — one off in either direction refuses, named', () => {
  withEnv(SYNTHETIC_PROVIDER_ENV, () => {
    const booted = bootedCrossing();
    const cases: readonly [keyof CanaryAuthorization, unknown, RegExp][] = [
      ['cohortSpendCapUsdMicros', 800_000_001, /cohortSpendCapUsdMicros \(800000001\)/],
      ['cohortSpendCapUsdMicros', 799_999_999, /cohortSpendCapUsdMicros \(799999999\)/],
      ['cohortCallCap', 9, /cohortCallCap \(9\)/],
      ['cohortCallCap', 7, /cohortCallCap \(7\)/],
      ['maxConcurrentProviderRequests', 5, /maxConcurrentProviderRequests \(5\)/],
      ['maxDispatchesPerTick', 2, /maxDispatchesPerTick \(2\)/],
      ['maxRepairAttemptsPerArm', 2, /maxRepairAttemptsPerArm \(2\)/],
      ['maxRepairAttemptsPerArm', 0, /maxRepairAttemptsPerArm \(0\)/],
    ];
    for (const [key, value, expect] of cases) {
      assertRefused(
        () => gateRealCohortAdapterCapability(booted, authorizationFor(booted, { [key]: value })),
        expect,
        `${key}=${String(value)}`,
      );
    }
  });
});

test('a COLLUDING off-pin cohort (authorization matching its manifest) still refuses on the crossing pins', () => {
  withEnv(SYNTHETIC_PROVIDER_ENV, () => {
    // One micro OVER: refused by BOTH the pin equality and the explicit canary ceiling.
    const over = bootedOffPin({ cohortSpendCapUsdMicros: 800_000_001 });
    assert.throws(
      () => gateRealCohortAdapterCapability(over, authorizationFor(over)),
      (e: unknown) =>
        e instanceof CanaryAuthorizationError &&
        e.violations.some((v) => /cohortSpendCapUsdMicros \(800000001\) != crossing pin/.test(v)) &&
        e.violations.some((v) => /exceeds the canary ceiling/.test(v)),
      'over-cap collusion',
    );
    // One micro UNDER: under the ceiling, still refused by the pin equality alone.
    const under = bootedOffPin({ cohortSpendCapUsdMicros: 799_999_999 });
    assertRefused(
      () => gateRealCohortAdapterCapability(under, authorizationFor(under)),
      /cohortSpendCapUsdMicros \(799999999\) != crossing pin/,
      'under-cap collusion',
    );
    // A ninth call, colluding: refused on the pin.
    const calls = bootedOffPin({ cohortCallCap: 9 });
    assertRefused(
      () => gateRealCohortAdapterCapability(calls, authorizationFor(calls)),
      /cohortCallCap \(9\) != crossing pin/,
      'call-cap collusion',
    );
    // The replay price table, colluding (version AND digest match the manifest): refused on the pins.
    const replay = bootedOffPin({ modelPriceTableVersion: 'prices-v1' });
    assertRefused(
      () => gateRealCohortAdapterCapability(replay, authorizationFor(replay)),
      /modelPriceTableVersion \(prices-v1\) != crossing pin/,
      'price-table collusion',
    );
  });
});

test('the roster binds by ORDERED identity: a reordering and a subset both refuse', () => {
  withEnv(SYNTHETIC_PROVIDER_ENV, () => {
    const booted = bootedCrossing();
    const reordered = [...ROSTER].reverse();
    assertRefused(
      () => gateRealCohortAdapterCapability(booted, authorizationFor(booted, { participantIds: reordered })),
      /participantIds/,
      'reordered roster',
    );
    assertRefused(
      () => gateRealCohortAdapterCapability(booted, authorizationFor(booted, { participantIds: ROSTER.slice(0, 3) })),
      /participantIds/,
      'subset roster',
    );
  });
});

test('the price identity binds both ways: an authorization pinning the replay table refuses', () => {
  withEnv(SYNTHETIC_PROVIDER_ENV, () => {
    const booted = bootedCrossing();
    assertRefused(
      () =>
        gateRealCohortAdapterCapability(
          booted,
          authorizationFor(booted, {
            modelPriceTableVersion: 'prices-v1',
            modelPriceTableDigest: modelPriceTableDigest('prices-v1'),
          }),
        ),
      /modelPriceTableVersion/,
      'authorization pinning the replay table',
    );
    // The DIGEST binds on its own: a correct version with a wrong digest refuses on the
    // digest violation specifically (the version check cannot be what catches this input).
    assertRefused(
      () =>
        gateRealCohortAdapterCapability(booted, authorizationFor(booted, { modelPriceTableDigest: 'f'.repeat(64) })),
      /modelPriceTableDigest/,
      'authorization with a mismatched digest only',
    );
  });
});

test('a missing roster credential refuses NAMING the participant, and the observed set is reconciled to the claim', () => {
  // One credential absent: the producer's OWN observation refuses (and the claim of 4 no longer matches 3).
  withEnv({ ...SYNTHETIC_PROVIDER_ENV, ANTHROPIC_API_KEY: undefined }, () => {
    const booted = bootedCrossing();
    assert.throws(
      () => gateRealCohortAdapterCapability(booted, authorizationFor(booted)),
      (e: unknown) =>
        e instanceof CanaryAuthorizationError &&
        e.violations.some((v) => /"anthropic-claude-fable-5" has no usable credential/.test(v)) &&
        e.violations.some((v) => /independently observed credentialed participants/.test(v)),
      'missing anthropic credential',
    );
  });
  // All credentials present but the authorization CLAIMS fewer: the reconcile refuses —
  // the claim is never trusted in either direction.
  withEnv(SYNTHETIC_PROVIDER_ENV, () => {
    const booted = bootedCrossing();
    assertRefused(
      () =>
        gateRealCohortAdapterCapability(
          booted,
          authorizationFor(booted, { observedCredentialedParticipantIds: ROSTER.slice(0, 3) }),
        ),
      /independently observed credentialed participants/,
      'under-claiming authorization',
    );
    // The reconcile is ORDERED identity, like every other roster-shaped binding: a claim
    // with the right membership in the wrong order refuses (a set-compare would admit it).
    assertRefused(
      () =>
        gateRealCohortAdapterCapability(
          booted,
          authorizationFor(booted, { observedCredentialedParticipantIds: [...ROSTER].reverse() }),
        ),
      /independently observed credentialed participants/,
      'reordered observed claim',
    );
  });
});

test("the Google arm's supported credential alias is credited (GOOGLE_API_KEY without GEMINI_API_KEY mints)", () => {
  withEnv({ ...SYNTHETIC_PROVIDER_ENV, GEMINI_API_KEY: undefined, GOOGLE_API_KEY: 'synthetic-test-credential' }, () => {
    const booted = bootedCrossing();
    const cap = gateRealCohortAdapterCapability(booted, authorizationFor(booted));
    assert.equal(cap.billingClass, 'billable');
    assert.equal(cap.adapters().get('google-gemini-3.1-pro-preview')!.hasCredential(), true);
  });
});

test('authorization shape is STRICT: wrong opt-in, missing/extra keys, and non-finite caps all refuse', () => {
  withEnv(SYNTHETIC_PROVIDER_ENV, () => {
    const booted = bootedCrossing();
    const shapes: readonly [string, unknown, RegExp][] = [
      ['liveOptIn false', authorizationFor(booted, { liveOptIn: false }), /liveOptIn must be the literal true/],
      ['liveOptIn 1 (truthy, not true)', authorizationFor(booted, { liveOptIn: 1 }), /liveOptIn must be the literal true/],
      [
        'a missing key',
        (() => {
          const { cohortCallCap: _dropped, ...rest } = authorizationFor(booted);
          return rest;
        })(),
        /keys .* do not equal the expected set/,
      ],
      [
        'an extra key',
        { ...authorizationFor(booted), extraLever: 1 },
        /keys .* do not equal the expected set/,
      ],
      ['a non-array roster', authorizationFor(booted, { participantIds: 'all' }), /participantIds must be an array/],
      ['NaN spend cap', authorizationFor(booted, { cohortSpendCapUsdMicros: Number.NaN }), /cohortSpendCapUsdMicros must be a non-negative safe integer/],
      ['Infinity spend cap', authorizationFor(booted, { cohortSpendCapUsdMicros: Number.POSITIVE_INFINITY }), /cohortSpendCapUsdMicros must be a non-negative safe integer/],
      ['-Infinity spend cap', authorizationFor(booted, { cohortSpendCapUsdMicros: Number.NEGATIVE_INFINITY }), /cohortSpendCapUsdMicros must be a non-negative safe integer/],
      ['a fractional spend cap', authorizationFor(booted, { cohortSpendCapUsdMicros: 800_000_000.5 }), /cohortSpendCapUsdMicros must be a non-negative safe integer/],
      ['a negative spend cap', authorizationFor(booted, { cohortSpendCapUsdMicros: -1 }), /cohortSpendCapUsdMicros must be a non-negative safe integer/],
      ['an unsafe-magnitude spend cap', authorizationFor(booted, { cohortSpendCapUsdMicros: 2 ** 53 }), /cohortSpendCapUsdMicros must be a non-negative safe integer/],
      ['a string spend cap', authorizationFor(booted, { cohortSpendCapUsdMicros: '800000000' }), /cohortSpendCapUsdMicros must be a non-negative safe integer/],
      ['null', null, /must be a plain object/],
      ['an array', [], /must be a plain object/],
    ];
    for (const [label, shape, expect] of shapes) {
      assertRefused(
        () => gateRealCohortAdapterCapability(booted, shape as CanaryAuthorization),
        expect,
        label,
      );
    }
  });
});

test('each authorization property is read EXACTLY ONCE — the comparisons run on the frozen capture', () => {
  withEnv(SYNTHETIC_PROVIDER_ENV, () => {
    const booted = bootedCrossing();
    const source = authorizationFor(booted);
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
    // A second read of ANY property throws inside the getter — a passing mint IS the proof.
    const cap = gateRealCohortAdapterCapability(booted, instrumented as unknown as CanaryAuthorization);
    assert.equal(cap.billingClass, 'billable');
    for (const key of Object.keys(source)) {
      assert.equal(reads.get(key), 1, `${key} read exactly once`);
    }
  });
});
