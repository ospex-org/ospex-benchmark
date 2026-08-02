import { createMockAdapters } from './mock.js';
import type { BillingClass } from './spendGuard.js';
import type { ProviderAdapter } from './types.js';

/**
 * The opaque cohort adapter CAPABILITY: the single value that carries BOTH who may be
 * dispatched (the adapter facades) and the billing PROVENANCE of those adapters
 * (`billingClass`), minted together so a caller can never pair an adapter set with a
 * billing label of its own choosing. The cohort fire path (`runOneFire` / `runCohortTick`)
 * accepts ONLY a minted capability — a raw `Map<string, ProviderAdapter>`, a structural
 * lookalike, or a spread/copy of a genuine capability all fail the runtime brand.
 *
 * Unforgeability boundary, stated exactly:
 *  - The adapter entries and their exact `hasCredential`/`chat` function references are
 *    captured ONCE at mint (methods bound, entries copied), so replacing source-map entries
 *    or replacing either source method AFTER minting cannot change the captured facade.
 *    The bound methods still run with the original adapter as their receiver; the producer
 *    remains responsible for trusting that adapter implementation and its internal state.
 *  - `billingClass` is fixed at mint on a frozen object; there is no setter, no exposed
 *    map, and no mutable view.
 *  - Relabeling therefore requires MINTING a different capability — an auditable producer
 *    act — never flipping a field on an input.
 *  - The only production producer in this build is the mock one, which constructs its own
 *    adapters and is always `known-zero`. A capability whose class is `billable` can only
 *    come from the injected-fixture producer below (billable-SHAPED fakes for escalation
 *    tests); REAL billable authority additionally requires a gated producer bound to an
 *    exact booted cohort + operator authorization, which does not exist in this build —
 *    no real adapter is reachable from the cohort path at all.
 */

const CAPABILITY_BRAND = new WeakSet<object>();

export interface CohortAdapterCapability {
  /** Whether these adapters can incur REAL provider spend — the spend guard's provenance
   *  input. Fixed at mint; the object is frozen. */
  readonly billingClass: BillingClass;
  /** A FRESH read-only snapshot of the facades captured at mint. Mutating the returned
   *  map affects nothing; the internal capture is inaccessible. */
  adapters(): ReadonlyMap<string, ProviderAdapter>;
}

/** A value that is not a minted capability reached a seam that requires one. */
export class CohortAdapterCapabilityError extends Error {
  constructor() {
    super(
      'not a minted cohort adapter capability — raw adapter maps, structural lookalikes, and ' +
        'copies are rejected; mint one via a capability producer',
    );
    this.name = 'CohortAdapterCapabilityError';
  }
}

/** Runtime brand assertion — the fail-closed gate every consumer runs before reading a field. */
export function assertCohortAdapterCapability(value: unknown): asserts value is CohortAdapterCapability {
  if (typeof value !== 'object' || value === null || !CAPABILITY_BRAND.has(value)) {
    throw new CohortAdapterCapabilityError();
  }
}

/** Capture-and-freeze mint. Module-private: every exported producer states its own provenance. */
function mint(adapters: ReadonlyMap<string, ProviderAdapter>, billingClass: BillingClass): CohortAdapterCapability {
  // Capture each adapter's identity and method references EXACTLY ONCE. Binding here is what
  // makes a post-mint `adapter.chat = ...` swap, or a source-map set/delete, ineffective;
  // producer trust still covers state consulted by the original bound method.
  const captured = new Map<string, ProviderAdapter>();
  for (const [participantId, adapter] of adapters) {
    captured.set(
      participantId,
      Object.freeze({
        provider: adapter.provider,
        requestedModelId: adapter.requestedModelId,
        credentialEnvVar: adapter.credentialEnvVar,
        hasCredential: adapter.hasCredential.bind(adapter),
        chat: adapter.chat.bind(adapter),
      }),
    );
  }
  const capability: CohortAdapterCapability = Object.freeze({
    billingClass,
    adapters(): ReadonlyMap<string, ProviderAdapter> {
      return new Map(captured);
    },
  });
  CAPABILITY_BRAND.add(capability);
  return capability;
}

/**
 * The production producer: constructs its OWN mock adapters (a caller supplies none, so
 * there is nothing to mislabel) and mints them `known-zero` — mock adapters make no
 * network call and can never bill.
 */
export function createCohortMockAdapterCapability(options: { simulateCollision: boolean }): CohortAdapterCapability {
  return mint(createMockAdapters(options), 'known-zero');
}

/**
 * The injected-fixture producer, for tests that drive the spine with scripted/synthetic
 * adapters. `'billable'` here labels billable-SHAPED fakes so the escalation path can be
 * proven with zero real spend — it does NOT mint real billing authority (no real adapter
 * exists on the cohort path in this build, and real billable authority will additionally
 * require a gated producer bound to an exact booted cohort + operator authorization).
 * Production code paths mint only via {@link createCohortMockAdapterCapability}.
 */
export function mintInjectedAdapterCapability(input: {
  adapters: ReadonlyMap<string, ProviderAdapter>;
  billingClass: BillingClass;
}): CohortAdapterCapability {
  return mint(input.adapters, input.billingClass);
}
