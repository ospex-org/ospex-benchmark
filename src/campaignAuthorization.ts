import { isAbsolute } from 'node:path';
import { assertBootedCohort } from './cohortBoot.js';
import type { BootedCohort } from './cohortBoot.js';
import { SPEND_GUARD_PRICE_TABLE_VERSION, modelPriceTableDigest } from './modelPriceTable.js';
import { instantMs, isParseableInstant } from './time.js';
import type { CanaryAuthorization } from './cohortAdapterCapability.js';

/**
 * The CAMPAIGN authorization — the durable record that moves the attended act from
 * per-FIRE to per-CAMPAIGN.
 *
 * The attended crossing authorized exactly one fire: an operator read the terms and
 * answered a prompt, and the resulting authorization minted billable adapters once. That
 * is right for a canary and wrong for a season: a scheduled benchmark cannot answer a
 * prompt, and by design an unanswered prompt REFUSES.
 *
 * So the confirmation moves rather than disappearing. An operator arms ONE campaign — a
 * cohort whose manifest already pins the sport, the markets, the observation window, the
 * roster, the price table, and the total call/spend caps — and from then on scheduled ticks
 * resolve their live intent by READING this record instead of prompting. Nothing here lets a
 * campaign begin without a human confirming its exact terms; it lets the ticks that follow
 * run without one.
 *
 * Three independent bounds hold an armed campaign, deliberately layered so no single defect
 * in this module can matter on its own:
 *
 *  1. **The store's cohort budget** — the HARD bound. `admit_dispatch` checks the call and
 *     spend caps inside a row lock, so no number of ticks, no runaway scheduler, and no two
 *     boxes ticking at once can spend past the amount fixed at arming. This holds even if
 *     everything below is wrong.
 *  2. **This authorization** — the SOFT, revocable bound: it expires on its own (`expiresAt`)
 *     and can be revoked at any moment (`disarmedAt`), which is the operator's stop lever.
 *  3. **The manifest's window** — `windowEnd` ends eligibility regardless of either.
 *
 * The record is deliberately NOT the thing that mints adapters. A resolved campaign
 * authorization is projected down to the momentary {@link CanaryAuthorization} the existing
 * gated producer already consumes, and that producer re-derives the cohort binding, the
 * crossing pins, and the credential observations for itself. The validation here is
 * therefore the FIRST of two independent passes, never the only one.
 */

/** The record version; a stored record of any other version is refused, never migrated. */
export const CAMPAIGN_AUTHORIZATION_VERSION = 1;

export interface CampaignAuthorization {
  readonly campaignAuthorizationVersion: number;
  /** The exact booted cohort this campaign authorizes — the canonical manifest's own hash,
   *  so a manifest edit after arming changes the identity and invalidates the record. */
  readonly cohortId: string;
  /** The selected roster participants, in manifest order. */
  readonly participantIds: readonly string[];
  /** The conservative guard price identity the cohort's manifest must pin. */
  readonly modelPriceTableVersion: string;
  readonly modelPriceTableDigest: string;
  /** The explicit live opt-in; anything but the literal `true` is refused. */
  readonly liveOptIn: true;
  /** The participants observed to hold a usable credential AT ARMING. Never trusted on its
   *  own: every tick re-observes credentials and reconciles against this claim. */
  readonly observedCredentialedParticipantIds: readonly string[];
  readonly cohortSpendCapUsdMicros: number;
  readonly cohortCallCap: number;
  readonly maxConcurrentProviderRequests: number;
  readonly maxDispatchesPerTick: number;
  readonly maxRepairAttemptsPerArm: number;
  /** The durable evidence destination bound AT ARMING — the absolute root every tick's
   *  artifact sink writes under AND its escalation-evidence scan reads. Immutable for the
   *  campaign's lifetime: the tick derives the root from here and refuses any attempt to
   *  supply a different one. */
  readonly evidenceRoot: string;
  /** The identity of that root — the id of the durable marker the arm installed at the
   *  root. A tick verifies the marker before reading any evidence, so a lost mount or a
   *  recreated empty directory at the same pathname can never read as a clear latch. */
  readonly evidenceRootId: string;
  /** When the operator armed it (offset-qualified instant). */
  readonly armedAt: string;
  /** The HARD time bound. An authorization that outlives its campaign is a standing
   *  permission to spend, so it expires on its own rather than by anyone remembering. */
  readonly expiresAt: string;
  /** Set when revoked; a disarmed campaign never resolves again. `null` while live. */
  readonly disarmedAt: string | null;
}

/**
 * The durable home for campaign authorizations. Deliberately its own port rather than a
 * method on `AtomicStore`: the money-critical store contract (and its conformance suite)
 * stays untouched, and a local-file implementation remains a drop-in for a single-box phase.
 */
export interface CampaignAuthorizationPort {
  /** The stored record for `cohortId`, RAW and unvalidated, or `null` when none exists. */
  read(cohortId: string): Promise<unknown | null>;
  /** Durably record a new authorization. Refuses when ANY record already exists for the
   *  cohort — even a disarmed one. A cohort is armed at most once, ever: its record is
   *  immutable history, and running another campaign means building a NEW manifest (a new
   *  window gives a new cohortId) and arming that. */
  arm(record: CampaignAuthorization): Promise<'armed' | 'already_armed'>;
  /** Revoke; idempotent. The stop lever. */
  disarm(cohortId: string, at: string): Promise<'disarmed' | 'not_found'>;
}

/** The resolution a scheduled tick acts on. There is no prompt and no mock fallback: a tick
 *  either holds a validated authorization or fires nothing and exits loudly. `Authorized`
 *  carries BOTH the momentary canary credential the gated producer consumes AND the strict
 *  captured record — the tick reads the campaign-only terms (the bound evidence root and
 *  its identity) from the record, which the canary's narrow key set deliberately omits. */
export type CampaignIntentResolution =
  | { readonly kind: 'Authorized'; readonly authorization: CanaryAuthorization; readonly record: CampaignAuthorization }
  | { readonly kind: 'Refused'; readonly violations: readonly string[] };

/** The exact enumerable own-key set a stored record must carry — no more, no fewer. */
const RECORD_KEYS = [
  'campaignAuthorizationVersion',
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
  'evidenceRoot',
  'evidenceRootId',
  'armedAt',
  'expiresAt',
  'disarmedAt',
] as const;

function orderedEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function refused(violations: readonly string[]): CampaignIntentResolution {
  return Object.freeze({ kind: 'Refused' as const, violations: Object.freeze([...violations]) });
}

/**
 * Strictly validate and defensively CAPTURE a stored record: exact key set, every field read
 * EXACTLY ONCE into a local (a getter cannot show the validator one value and the comparisons
 * another), arrays copied element by element, counts required to be non-negative safe
 * integers, instants required to be offset-qualified. Returns the frozen capture, or the
 * accumulated violations.
 */
function captureRecord(value: unknown): { captured: CampaignAuthorization } | { violations: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { violations: ['stored campaign authorization must be a plain object'] };
  }
  const violations: string[] = [];
  const keys = Object.keys(value).sort();
  const expected = [...RECORD_KEYS].sort();
  if (!orderedEqual(keys, expected)) {
    violations.push(`stored keys [${keys.join(', ')}] do not equal the expected set [${expected.join(', ')}]`);
  }
  const raw = value as Record<string, unknown>;

  // ONE read per property, before any validation branches on the values.
  const version = raw['campaignAuthorizationVersion'];
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
  const evidenceRoot = raw['evidenceRoot'];
  const evidenceRootId = raw['evidenceRootId'];
  const armedAt = raw['armedAt'];
  const expiresAt = raw['expiresAt'];
  const disarmedAt = raw['disarmedAt'];

  const requireString = (label: string, v: unknown): string => {
    if (typeof v !== 'string' || v.length === 0) {
      violations.push(`${label} must be a non-empty string`);
      return '';
    }
    return v;
  };
  const requireInstant = (label: string, v: unknown): string => {
    const s = requireString(label, v);
    if (s !== '' && !isParseableInstant(s)) {
      violations.push(`${label} must be an offset-qualified ISO-8601 instant`);
      return '';
    }
    return s;
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

  if (version !== CAMPAIGN_AUTHORIZATION_VERSION) {
    violations.push(
      `campaignAuthorizationVersion ${String(version)} is not the supported version ${CAMPAIGN_AUTHORIZATION_VERSION}`,
    );
  }
  if (liveOptIn !== true) {
    violations.push('liveOptIn must be the literal true (the explicit live opt-in)');
  }
  if (disarmedAt !== null && (typeof disarmedAt !== 'string' || !isParseableInstant(disarmedAt))) {
    violations.push('disarmedAt must be null or an offset-qualified ISO-8601 instant');
  }
  // The bound root must be ABSOLUTE: a relative recorded root would re-anchor on whatever
  // working directory cron happens to use — exactly the mutable-root class the binding
  // exists to kill.
  if (typeof evidenceRoot === 'string' && evidenceRoot.length > 0 && !isAbsolute(evidenceRoot)) {
    violations.push(`evidenceRoot ${JSON.stringify(evidenceRoot)} must be an absolute path`);
  }

  const captured: CampaignAuthorization = Object.freeze({
    campaignAuthorizationVersion: CAMPAIGN_AUTHORIZATION_VERSION,
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
    evidenceRoot: requireString('evidenceRoot', evidenceRoot),
    evidenceRootId: requireString('evidenceRootId', evidenceRootId),
    armedAt: requireInstant('armedAt', armedAt),
    expiresAt: requireInstant('expiresAt', expiresAt),
    disarmedAt: typeof disarmedAt === 'string' ? disarmedAt : null,
  });

  if (violations.length > 0) return { violations };
  return { captured };
}

/**
 * The read-only CLASSIFICATION of a stored record, for the monitoring/status surface. This
 * reuses the exact same strict capture as {@link resolveCampaignIntent} — one validator,
 * never a second lighter one that could drift — but classifies instead of refusing, because
 * a status read must truthfully DESCRIBE a dead campaign (disarmed, expired, malformed)
 * rather than merely refuse it. Precedence: a malformed record is `malformed` (nothing else
 * about it can be trusted); an explicit stop wins over expiry (`disarmed` names the operator
 * action, the more informative fact); then `expired`; else `live`. `live` says only that the
 * RECORD is live — whether the next tick would actually authorize (binding, credentials) is
 * {@link resolveCampaignIntent}'s answer, which the tick pairs with its own publication and
 * escalation-latch checks before dispatching (see docs/CAMPAIGN-ACTIVATION.md).
 *
 * `nowMs` must be finite — a non-finite clock is a broken caller, not a record state, and
 * throws rather than mislabeling the record.
 */
export type CampaignAuthorizationClassification =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed'; readonly violations: readonly string[] }
  | { readonly kind: 'live'; readonly record: CampaignAuthorization }
  | { readonly kind: 'disarmed'; readonly record: CampaignAuthorization }
  | { readonly kind: 'expired'; readonly record: CampaignAuthorization };

export function classifyCampaignAuthorization(
  stored: unknown | null,
  nowMs: number,
): CampaignAuthorizationClassification {
  if (!Number.isFinite(nowMs)) {
    throw new Error('classifyCampaignAuthorization requires a finite clock reading');
  }
  if (stored === null || stored === undefined) return Object.freeze({ kind: 'absent' as const });
  const capture = captureRecord(stored);
  if ('violations' in capture) {
    return Object.freeze({ kind: 'malformed' as const, violations: Object.freeze([...capture.violations]) });
  }
  const record = capture.captured;
  if (record.disarmedAt !== null) return Object.freeze({ kind: 'disarmed' as const, record });
  if (nowMs >= instantMs(record.expiresAt)) return Object.freeze({ kind: 'expired' as const, record });
  return Object.freeze({ kind: 'live' as const, record });
}

/**
 * Resolve a scheduled tick's live intent from a stored campaign authorization. NO prompt, and
 * NO mock fallback: the caller either receives a momentary {@link CanaryAuthorization} to hand
 * the gated producer, or a typed refusal it must surface loudly while firing nothing.
 *
 * In order: the cohort must be genuine; the record must strictly capture; it must be live at
 * this tick's clock (armed, not expired, not disarmed); it must bind to the EXACT booted
 * cohort (identity, roster, price identity, every cap); and every roster credential must be
 * INDEPENDENTLY observed now and reconcile with the claim recorded at arming — a key revoked
 * mid-campaign refuses the tick rather than dispatching a doomed arm.
 *
 * `now` is the ONE tick clock, passed in like every other clock in this codebase; a
 * non-finite reading fails closed.
 */
export function resolveCampaignIntent(input: {
  booted: BootedCohort;
  stored: unknown | null;
  now: number;
  observeCredentials: (participantIds: readonly string[]) => ReadonlyMap<string, boolean>;
}): CampaignIntentResolution {
  const booted = input.booted;
  const stored = input.stored;
  const now = input.now;
  const observeCredentials = input.observeCredentials;

  // A forged cohort is not a refusal decision — it is a broken caller. Fail loudly.
  assertBootedCohort(booted);

  if (!Number.isFinite(now)) {
    return refused(['the tick clock reading is not finite — refusing (fail closed)']);
  }
  if (stored === null || stored === undefined) {
    return refused([`no campaign authorization is armed for cohort ${booted.cohortId}`]);
  }

  const capture = captureRecord(stored);
  if ('violations' in capture) return refused(capture.violations);
  const record = capture.captured;

  const violations: string[] = [];
  const manifest = booted.manifest;
  const rosterIds = manifest.expectedArmRoster.map((arm) => arm.participantId);

  // Liveness at THIS tick's clock.
  if (record.disarmedAt !== null) {
    violations.push(`campaign was disarmed at ${record.disarmedAt}`);
  }
  const armedAtMs = instantMs(record.armedAt);
  const expiresAtMs = instantMs(record.expiresAt);
  if (armedAtMs >= expiresAtMs) {
    violations.push(`armedAt ${record.armedAt} is not before expiresAt ${record.expiresAt}`);
  }
  if (now < armedAtMs) {
    violations.push(`tick clock is before armedAt ${record.armedAt}`);
  }
  if (now >= expiresAtMs) {
    violations.push(`campaign authorization expired at ${record.expiresAt}`);
  }

  // Exact binding to the booted cohort.
  if (record.cohortId !== booted.cohortId) {
    violations.push(`authorization cohortId "${record.cohortId}" != booted cohortId "${booted.cohortId}"`);
  }
  if (!orderedEqual(record.participantIds, rosterIds)) {
    violations.push(
      `authorization participantIds [${record.participantIds.join(', ')}] != booted roster [${rosterIds.join(', ')}]`,
    );
  }
  if (record.modelPriceTableVersion !== manifest.modelPriceTableVersion) {
    violations.push(
      `authorization modelPriceTableVersion "${record.modelPriceTableVersion}" != manifest "${manifest.modelPriceTableVersion}"`,
    );
  }
  if (record.modelPriceTableDigest !== manifest.modelPriceTableDigest) {
    violations.push(
      `authorization modelPriceTableDigest "${record.modelPriceTableDigest}" != manifest "${manifest.modelPriceTableDigest}"`,
    );
  }
  const capBindings: readonly [string, number, number][] = [
    ['cohortSpendCapUsdMicros', record.cohortSpendCapUsdMicros, manifest.cohortSpendCapUsdMicros],
    ['cohortCallCap', record.cohortCallCap, manifest.cohortCallCap],
    [
      'maxConcurrentProviderRequests',
      record.maxConcurrentProviderRequests,
      manifest.constants.maxConcurrentProviderRequests,
    ],
    ['maxDispatchesPerTick', record.maxDispatchesPerTick, manifest.constants.maxDispatchesPerTick],
    ['maxRepairAttemptsPerArm', record.maxRepairAttemptsPerArm, manifest.constants.maxRepairAttemptsPerArm],
  ];
  for (const [label, authorized, actual] of capBindings) {
    if (authorized !== actual) {
      violations.push(`authorization ${label} (${authorized}) != booted manifest ${label} (${actual})`);
    }
  }

  // Independent credential observation NOW — never the arming-time claim alone. A key
  // revoked or rotated mid-campaign refuses the tick instead of dispatching a doomed arm.
  const observedMap = observeCredentials(rosterIds);
  const observedNow: string[] = [];
  for (const participantId of rosterIds) {
    if (observedMap.get(participantId) === true) {
      observedNow.push(participantId);
    } else {
      violations.push(
        `participant "${participantId}" has no usable credential (its adapter's credential probe returned false)`,
      );
    }
  }
  if (!orderedEqual(observedNow, record.observedCredentialedParticipantIds)) {
    violations.push(
      `credentials observed now [${observedNow.join(', ')}] != the set recorded at arming ` +
        `[${record.observedCredentialedParticipantIds.join(', ')}] (ordered identity)`,
    );
  }

  if (violations.length > 0) return refused(violations);

  // Project down to the MOMENTARY credential the gated producer consumes. The producer
  // independently re-derives the cohort binding, the pinned profile, and the credential
  // observations, so this is the first of two passes — never the only one.
  const authorization: CanaryAuthorization = Object.freeze({
    cohortId: booted.cohortId,
    participantIds: Object.freeze([...rosterIds]),
    modelPriceTableVersion: record.modelPriceTableVersion,
    modelPriceTableDigest: record.modelPriceTableDigest,
    liveOptIn: true,
    observedCredentialedParticipantIds: Object.freeze(observedNow),
    cohortSpendCapUsdMicros: record.cohortSpendCapUsdMicros,
    cohortCallCap: record.cohortCallCap,
    maxConcurrentProviderRequests: record.maxConcurrentProviderRequests,
    maxDispatchesPerTick: record.maxDispatchesPerTick,
    maxRepairAttemptsPerArm: record.maxRepairAttemptsPerArm,
  });
  return Object.freeze({ kind: 'Authorized' as const, authorization, record });
}

/**
 * Build the record an ARMING act stores, from the authenticated booted cohort plus the
 * operator's chosen expiry and evidence destination. Every identity/cap term is DERIVED
 * from the booted manifest — never accepted from a caller — so an armed campaign cannot
 * claim terms its cohort does not actually pin; the evidence root + its marker identity
 * are the operator's deliberate arming choices, bound here so no later tick can vary
 * them. The credential observation is the caller's (the arming CLI probes the real
 * adapters); every later tick re-observes and reconciles against it.
 *
 * Refuses (throws) when the guard price identity is not pinned: a billable campaign must be
 * judged under the conservative table, and `runOneFire` would refuse each fire pre-claim
 * anyway — better to refuse at arming than to arm something that can never fire.
 */
export function buildCampaignAuthorization(input: {
  booted: BootedCohort;
  observedCredentialedParticipantIds: readonly string[];
  armedAtMs: number;
  expiresAtMs: number;
  /** The durable evidence destination — resolved ABSOLUTE by the arming CLI, bound here
   *  for the campaign's lifetime. */
  evidenceRoot: string;
  /** The id of the identity marker the arm installs at that root. */
  evidenceRootId: string;
}): CampaignAuthorization {
  assertBootedCohort(input.booted);
  const manifest = input.booted.manifest;
  if (!Number.isFinite(input.armedAtMs) || !Number.isFinite(input.expiresAtMs)) {
    throw new Error('arming requires finite armedAt/expiresAt readings');
  }
  if (input.expiresAtMs <= input.armedAtMs) {
    throw new Error('campaign expiry must be strictly after the arming instant');
  }
  if (input.evidenceRoot.length === 0 || !isAbsolute(input.evidenceRoot)) {
    throw new Error(`arming requires an absolute evidence root, got ${JSON.stringify(input.evidenceRoot)}`);
  }
  if (input.evidenceRootId.length === 0) {
    throw new Error('arming requires the evidence root identity (the installed marker id)');
  }
  const guardDigest = modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION);
  if (
    manifest.modelPriceTableVersion !== SPEND_GUARD_PRICE_TABLE_VERSION ||
    manifest.modelPriceTableDigest !== guardDigest
  ) {
    throw new Error(
      `a billable campaign requires the manifest to pin the conservative guard price table ` +
        `("${SPEND_GUARD_PRICE_TABLE_VERSION}" + its digest); this manifest pins ` +
        `"${manifest.modelPriceTableVersion}" — refusing to arm`,
    );
  }
  return Object.freeze({
    campaignAuthorizationVersion: CAMPAIGN_AUTHORIZATION_VERSION,
    cohortId: input.booted.cohortId,
    participantIds: Object.freeze(manifest.expectedArmRoster.map((arm) => arm.participantId)),
    modelPriceTableVersion: manifest.modelPriceTableVersion,
    modelPriceTableDigest: manifest.modelPriceTableDigest,
    liveOptIn: true,
    observedCredentialedParticipantIds: Object.freeze([...input.observedCredentialedParticipantIds]),
    cohortSpendCapUsdMicros: manifest.cohortSpendCapUsdMicros,
    cohortCallCap: manifest.cohortCallCap,
    maxConcurrentProviderRequests: manifest.constants.maxConcurrentProviderRequests,
    maxDispatchesPerTick: manifest.constants.maxDispatchesPerTick,
    maxRepairAttemptsPerArm: manifest.constants.maxRepairAttemptsPerArm,
    evidenceRoot: input.evidenceRoot,
    evidenceRootId: input.evidenceRootId,
    armedAt: new Date(input.armedAtMs).toISOString(),
    expiresAt: new Date(input.expiresAtMs).toISOString(),
    disarmedAt: null,
  });
}
