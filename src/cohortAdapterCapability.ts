import { assertBootedCohort } from './cohortBoot.js';
import type { BootedCohort } from './cohortBoot.js';
import { campaignBoundsViolations } from './campaignProfile.js';
import { CROSSING_PROFILE, crossingPinViolations } from './crossingProfile.js';
import { createMockAdapters } from './mock.js';
import { createRealAdapters } from './providers/index.js';
import { createRealShapedFakeAdapters } from './realShapedFake.js';
import type { RealShapedFakeOptions } from './realShapedFake.js';
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
 *  - Every DEFAULT producer mints `known-zero` and constructs its OWN adapters: the mock
 *    producer (the cohort runner's default path) and the real-shaped fake producer
 *    (zero-network provider-shaped envelopes for parity/classification proofs). A
 *    `billable` class can come from exactly two places: the injected-fixture producer
 *    below (billable-SHAPED fakes for escalation tests — it mints no real billing
 *    authority), and the GATED real producer `gateRealCohortAdapterCapability`, which
 *    mints REAL billable authority only for a genuine booted cohort conforming to the
 *    pinned one-fire crossing profile, under a strictly-validated canary authorization
 *    whose credential observations it re-derives itself. No default path reaches the
 *    gated producer — minting requires the attended tri-state live resolution upstream —
 *    so absent an explicit, confirmed live authorization no real adapter is reachable
 *    from the cohort path.
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
 * The REAL-SHAPED fake producer: constructs its OWN zero-network provider-shaped fake
 * adapters (same decisions and scenario map as the mock, realistic provider envelope —
 * verbatim per-provider `usageRaw` shapes, provider-formatted ids, fenced/prose text) and
 * mints them `known-zero` — the fake never touches the network, and a sentinel test proves
 * a whole fire under a throwing `globalThis.fetch` never reaches the seam. A caller
 * supplies no adapters, so there is nothing to mislabel.
 */
export function createCohortRealShapedFakeCapability(options: RealShapedFakeOptions): CohortAdapterCapability {
  return mint(createRealShapedFakeAdapters(options), 'known-zero');
}

/**
 * The injected-fixture producer, for tests that drive the spine with scripted/synthetic
 * adapters. It is deliberately UNGUARDED and label-trusting — `mint(input.adapters,
 * input.billingClass)` with no cohort binding, no authorization, no adapter validation —
 * so "no real billing authority comes from here" is a usage convention enforced by
 * review (no non-test caller exists), not a runtime property: handed real adapters it
 * would mint them under whatever label the caller chose. `'billable'` in tests labels
 * billable-SHAPED fakes so the escalation path can be proven with zero real spend. The
 * GUARDED route to real billable authority is {@link gateRealCohortAdapterCapability}
 * (exact booted cohort + strictly-validated canary authorization + independent credential
 * observation); production default paths mint only via
 * {@link createCohortMockAdapterCapability}.
 */
export function mintInjectedAdapterCapability(input: {
  adapters: ReadonlyMap<string, ProviderAdapter>;
  billingClass: BillingClass;
}): CohortAdapterCapability {
  return mint(input.adapters, input.billingClass);
}

// ---------------------------------------------------------------------------
// The GATED real producer (billable) — the attended-canary authorization gate
// ---------------------------------------------------------------------------

/**
 * The operator authorization a REAL (billable) capability mint requires. It is produced by
 * the attended tri-state live resolution (after the [Y/n] confirmation) and consumed by
 * {@link gateRealCohortAdapterCapability}, which re-validates every field at runtime and
 * binds it to the EXACT booted cohort — a stale authorization for another cohort fails even
 * with equal caps, and any manifest change after authorization changes `cohortId` (the hash
 * of the manifest's canonical bytes) and so invalidates it.
 */
export interface CanaryAuthorization {
  /** The exact booted cohort this authorization covers (the manifest-bytes hash). */
  readonly cohortId: string;
  /** The selected roster participants, in manifest order. */
  readonly participantIds: readonly string[];
  /** The conservative guard price identity the cohort's manifest must pin. */
  readonly modelPriceTableVersion: string;
  readonly modelPriceTableDigest: string;
  /** The explicit live opt-in; anything but the literal `true` is refused. */
  readonly liveOptIn: true;
  /**
   * The participants the operator-side resolution observed to hold a usable credential.
   * The producer does NOT trust this claim — it independently constructs the real adapters,
   * probes each credential itself, and refuses on any disagreement.
   */
  readonly observedCredentialedParticipantIds: readonly string[];
  readonly cohortSpendCapUsdMicros: number;
  readonly cohortCallCap: number;
  readonly maxConcurrentProviderRequests: number;
  readonly maxDispatchesPerTick: number;
  readonly maxRepairAttemptsPerArm: number;
}

/** A billable mint was refused; carries every reason (mirrors `CohortBootError`). */
export class CanaryAuthorizationError extends Error {
  readonly violations: readonly string[];
  constructor(violations: readonly string[]) {
    super(`billable capability refused: ${violations.join('; ')}`);
    this.name = 'CanaryAuthorizationError';
    this.violations = Object.freeze([...violations]);
  }
}

/** The exact enumerable own-key set a canary authorization must carry — no more, no fewer. */
const CANARY_AUTHORIZATION_KEYS = [
  'cohortId',
  'participantIds',
  'modelPriceTableVersion',
  'modelPriceTableDigest',
  'liveOptIn',
  'observedCredentialedParticipantIds',
  'cohortSpendCapUsdMicros',
  'cohortCallCap',
  'maxConcurrentProviderRequests',
  'maxDispatchesPerTick',
  'maxRepairAttemptsPerArm',
] as const;

/** Exact ordered-sequence equality (length + element-by-element). */
function orderedEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Strictly validate and defensively CAPTURE a canary authorization: exact key set, every
 * field read EXACTLY ONCE into a local (a getter cannot return a compliant value to the
 * validator and a different one to the comparisons — the comparisons run on this frozen
 * capture, never on the caller's object), arrays copied element-by-element, numbers
 * required to be safe non-negative integers (`NaN`/`±Infinity`/fractions/negatives and
 * unsafe magnitudes all refuse). Throws `CanaryAuthorizationError` on any shape violation.
 */
function captureCanaryAuthorization(value: unknown): CanaryAuthorization {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CanaryAuthorizationError(['canaryAuthorization must be a plain object']);
  }
  const violations: string[] = [];
  const keys = Object.keys(value).sort();
  const expected = [...CANARY_AUTHORIZATION_KEYS].sort();
  if (!orderedEqual(keys, expected)) {
    violations.push(
      `canaryAuthorization keys [${keys.join(', ')}] do not equal the expected set [${expected.join(', ')}]`,
    );
  }
  const raw = value as Record<string, unknown>;

  // ONE read per property, before any validation branches on the values.
  const cohortId = raw['cohortId'];
  const participantIds = raw['participantIds'];
  const modelPriceTableVersion = raw['modelPriceTableVersion'];
  const modelPriceTableDigest = raw['modelPriceTableDigest'];
  const liveOptIn = raw['liveOptIn'];
  const observedCredentialedParticipantIds = raw['observedCredentialedParticipantIds'];
  const cohortSpendCapUsdMicros = raw['cohortSpendCapUsdMicros'];
  const cohortCallCap = raw['cohortCallCap'];
  const maxConcurrentProviderRequests = raw['maxConcurrentProviderRequests'];
  const maxDispatchesPerTick = raw['maxDispatchesPerTick'];
  const maxRepairAttemptsPerArm = raw['maxRepairAttemptsPerArm'];

  const requireString = (label: string, v: unknown): string => {
    if (typeof v !== 'string' || v.length === 0) {
      violations.push(`${label} must be a non-empty string`);
      return '';
    }
    return v;
  };
  const requireStringArray = (label: string, v: unknown): readonly string[] => {
    if (!Array.isArray(v)) {
      violations.push(`${label} must be an array of non-empty strings`);
      return Object.freeze([]);
    }
    const copy = [...v];
    if (!copy.every((item) => typeof item === 'string' && item.length > 0)) {
      violations.push(`${label} must contain only non-empty strings`);
      return Object.freeze([]);
    }
    return Object.freeze(copy as string[]);
  };
  const requireCount = (label: string, v: unknown): number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
      violations.push(`${label} must be a non-negative safe integer`);
      return -1;
    }
    return v;
  };

  const captured: CanaryAuthorization = Object.freeze({
    cohortId: requireString('cohortId', cohortId),
    participantIds: requireStringArray('participantIds', participantIds),
    modelPriceTableVersion: requireString('modelPriceTableVersion', modelPriceTableVersion),
    modelPriceTableDigest: requireString('modelPriceTableDigest', modelPriceTableDigest),
    liveOptIn: true,
    observedCredentialedParticipantIds: requireStringArray(
      'observedCredentialedParticipantIds',
      observedCredentialedParticipantIds,
    ),
    cohortSpendCapUsdMicros: requireCount('cohortSpendCapUsdMicros', cohortSpendCapUsdMicros),
    cohortCallCap: requireCount('cohortCallCap', cohortCallCap),
    maxConcurrentProviderRequests: requireCount('maxConcurrentProviderRequests', maxConcurrentProviderRequests),
    maxDispatchesPerTick: requireCount('maxDispatchesPerTick', maxDispatchesPerTick),
    maxRepairAttemptsPerArm: requireCount('maxRepairAttemptsPerArm', maxRepairAttemptsPerArm),
  });
  if (liveOptIn !== true) {
    violations.push('liveOptIn must be the literal true (the explicit live opt-in)');
  }
  if (violations.length > 0) {
    throw new CanaryAuthorizationError(violations);
  }
  return captured;
}

/**
 * The GATED real producer: mint REAL billable adapter authority for `booted` under
 * `canaryAuthorization`. This is the ONLY producer of real billing authority the cohort
 * path accepts, and it is deliberately maximal fail-closed — every check below must pass
 * or the mint refuses with every violation listed:
 *
 *   1. `booted` must be GENUINE (`assertBootedCohort`) — a hand-built or structurally-
 *      copied cohort fails the boot brand before any field is read.
 *   2. The authorization is strictly runtime-validated and defensively captured
 *      (exact key set, one read per field, frozen copy) — see
 *      {@link captureCanaryAuthorization}.
 *   3. The CAPTURED authorization must bind to the EXACT booted cohort: `cohortId`
 *      (the manifest hash — a post-authorization manifest change invalidates it),
 *      the selected participant ids (ordered equality with the booted roster), the
 *      pinned price-table version + digest, and every cap
 *      (`cohortSpendCapUsdMicros`, `cohortCallCap`, `maxConcurrentProviderRequests`,
 *      `maxDispatchesPerTick`, `maxRepairAttemptsPerArm`) by exact equality. A stale
 *      authorization for another cohort fails even with equal caps.
 *   4. The booted manifest must CONFORM to the pinned one-fire crossing profile
 *      (`crossingPinViolations` — including the conservative guard price table
 *      `SPEND_GUARD_PRICE_TABLE_VERSION` + recomputed digest, which the pre-claim
 *      billable price-identity gate in `runOneFire` re-checks per fire), and its
 *      spend cap must not exceed
 *      the canary ceiling. This producer mints for the attended one-fire canary
 *      ONLY; any other cohort shape is refused regardless of what an authorization
 *      claims.
 *   5. The producer INDEPENDENTLY constructs the real adapters and probes each
 *      roster credential itself (`hasCredential()` — for the Google arm this
 *      credits the adapter's supported credential alias, never a literal env-var
 *      name equality). Every roster participant must be credentialed, and the
 *      observed sequence must equal the authorization's claimed observation by
 *      ORDERED identity (like every other roster-shaped binding) — the claim is
 *      reconciled, never trusted.
 *
 * Minting performs NO network I/O and dispatches nothing: it captures the adapters'
 * method facades exactly like every other producer. What it changes is provenance —
 * the resulting capability is `billable`, so the runtime spend guard prices its
 * fires for real.
 */
export function gateRealCohortAdapterCapability(
  booted: BootedCohort,
  canaryAuthorization: CanaryAuthorization,
): CohortAdapterCapability {
  return gateRealAdapterCapability(booted, canaryAuthorization, (manifest) => {
    // The pinned crossing profile + the explicit canary money ceiling. The ceiling is
    // redundant with the exact spend-cap pin today; it stays explicit so a future pin edit
    // that raises the spend cap without a deliberate ceiling decision still refuses.
    const violations = [...crossingPinViolations(manifest)];
    if (manifest.cohortSpendCapUsdMicros > CROSSING_PROFILE.canaryCeilingUsdMicros) {
      violations.push(
        `cohortSpendCapUsdMicros (${manifest.cohortSpendCapUsdMicros}) exceeds the canary ceiling ` +
          `(${CROSSING_PROFILE.canaryCeilingUsdMicros})`,
      );
    }
    return violations;
  });
}

/**
 * The GATED real producer for a scheduled CAMPAIGN. Identical authority in every respect
 * except which cohort SHAPE it accepts: a campaign's size is the operator's decision, so
 * instead of the crossing's exact one-fire pins it enforces {@link campaignBoundsViolations}
 * — the priced-attempt shape pinned exactly (roster, repairs, per-attempt reservation,
 * conservative price table, output-token cap, provider timeout), and the campaign's own
 * levers bounded by code-owned maxima so an operator cannot arm an unbounded campaign by
 * typing a large number into a manifest.
 *
 * Everything else is the same shared gate: genuine boot brand, strict one-read authorization
 * capture, exact cohort/roster/price/cap binding, and an INDEPENDENT credential observation
 * reconciled against the authorization's claim. A campaign authorization reaches this
 * producer only after `resolveCampaignIntent` has separately validated the durable record's
 * liveness and binding, so this is the second of two independent passes.
 */
export function gateRealCampaignAdapterCapability(
  booted: BootedCohort,
  campaignAuthorization: CanaryAuthorization,
): CohortAdapterCapability {
  return gateRealAdapterCapability(booted, campaignAuthorization, campaignBoundsViolations);
}

/**
 * The shared body of every real-billable mint. `profileViolations` is the ONLY thing that
 * differs between the attended one-fire crossing and a scheduled campaign — every other
 * check here is common, so neither path can drift from the other's authority.
 */
function gateRealAdapterCapability(
  booted: BootedCohort,
  canaryAuthorization: CanaryAuthorization,
  profileViolations: (manifest: BootedCohort['manifest']) => string[],
): CohortAdapterCapability {
  assertBootedCohort(booted);
  const captured = captureCanaryAuthorization(canaryAuthorization);

  const violations: string[] = [];
  const manifest = booted.manifest;
  const rosterIds = manifest.expectedArmRoster.map((arm) => arm.participantId);

  // (3) Exact-cohort binding — every comparison runs against the frozen capture.
  if (captured.cohortId !== booted.cohortId) {
    violations.push(`authorization cohortId "${captured.cohortId}" != booted cohortId "${booted.cohortId}"`);
  }
  if (!orderedEqual(captured.participantIds, rosterIds)) {
    violations.push(
      `authorization participantIds [${captured.participantIds.join(', ')}] != booted roster [${rosterIds.join(', ')}]`,
    );
  }
  if (captured.modelPriceTableVersion !== manifest.modelPriceTableVersion) {
    violations.push(
      `authorization modelPriceTableVersion "${captured.modelPriceTableVersion}" != manifest ` +
        `"${manifest.modelPriceTableVersion}"`,
    );
  }
  if (captured.modelPriceTableDigest !== manifest.modelPriceTableDigest) {
    violations.push(
      `authorization modelPriceTableDigest "${captured.modelPriceTableDigest}" != manifest ` +
        `"${manifest.modelPriceTableDigest}"`,
    );
  }
  const capBindings: readonly [string, number, number][] = [
    ['cohortSpendCapUsdMicros', captured.cohortSpendCapUsdMicros, manifest.cohortSpendCapUsdMicros],
    ['cohortCallCap', captured.cohortCallCap, manifest.cohortCallCap],
    [
      'maxConcurrentProviderRequests',
      captured.maxConcurrentProviderRequests,
      manifest.constants.maxConcurrentProviderRequests,
    ],
    ['maxDispatchesPerTick', captured.maxDispatchesPerTick, manifest.constants.maxDispatchesPerTick],
    ['maxRepairAttemptsPerArm', captured.maxRepairAttemptsPerArm, manifest.constants.maxRepairAttemptsPerArm],
  ];
  for (const [label, authorized, actual] of capBindings) {
    if (authorized !== actual) {
      violations.push(`authorization ${label} (${authorized}) != booted manifest ${label} (${actual})`);
    }
  }

  // (4) The caller's cohort-SHAPE profile — the pinned one-fire crossing, or the bounded
  //     campaign shape. Everything else in this gate is common to both.
  violations.push(...profileViolations(manifest));

  // (5) Independent adapter construction + credential observation.
  const real = createRealAdapters();
  const selected = new Map<string, ProviderAdapter>();
  const observed: string[] = [];
  for (const participantId of rosterIds) {
    const adapter = real.get(participantId);
    if (adapter === undefined) {
      violations.push(`roster participant "${participantId}" has no real adapter`);
      continue;
    }
    selected.set(participantId, adapter);
    if (adapter.hasCredential()) {
      observed.push(participantId);
    } else {
      violations.push(
        `roster participant "${participantId}" has no usable credential (its adapter's credential probe returned false)`,
      );
    }
  }
  if (!orderedEqual(observed, captured.observedCredentialedParticipantIds)) {
    violations.push(
      `independently observed credentialed participants [${observed.join(', ')}] != authorization claim ` +
        `[${captured.observedCredentialedParticipantIds.join(', ')}] (ordered identity)`,
    );
  }

  if (violations.length > 0) {
    throw new CanaryAuthorizationError(violations);
  }
  return mint(selected, 'billable');
}
