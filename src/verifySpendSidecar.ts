import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { printError, printLine } from './console.js';
import { ConservativeSpendUnknownError, deriveConservativeActualUsdMicros } from './conservativeSpend.js';
import { CROSSING_PROFILE } from './crossingProfile.js';
import { MARKET_ORDINAL } from './fireArtifact.js';
import { parseFireArtifactV1, verifyFireArtifactReplay } from './fireArtifactWriter.js';
import { SPEND_GUARD_PRICE_TABLE_VERSION, modelPriceTableDigest } from './modelPriceTable.js';
import { SPEND_SIDECAR_SCHEMA_VERSION, TOKEN_FIELD_WHITELIST } from './spendEscalationSidecar.js';
import { classifyAttemptSpend, computeFireSpendGuard } from './spendGuard.js';
import type { GuardArmInput } from './spendGuard.js';
import { PROVIDER_ATTEMPT_RESERVATION_USD_MICROS } from './spendReservationPolicy.js';
import { ARMS } from './providers/index.js';
import { isParseableInstant } from './time.js';
import type { FireArtifactV1 } from './fireArtifactProducer.js';
import type { SidecarAttemptRecord, SpendEscalationSidecarV1 } from './spendEscalationSidecar.js';
import type { MarketKey, ProviderName } from './types.js';

/**
 * The DETERMINISTIC OFFLINE spend-evidence verifier — the tool the attended-crossing
 * runbook's acceptance names (`yarn verify:sidecar <fire-artifact.json> <fire-spend.json>`).
 * It verifies the durable ARTIFACT–SIDECAR PAIR, never a sidecar in isolation: the
 * artifact is strict-parsed and REPLAY-VERIFIED with its existing owners
 * (`parseFireArtifactV1` + `verifyFireArtifactReplay`) and then serves as the relational
 * witness the sidecar must bind to — a truncated, duplicated, fabricated, or foreign
 * sidecar row cannot survive, because the artifact says exactly which attempts were sent.
 * Every cost is recomputed with the SAME arithmetic and classification the runtime guard
 * runs (`deriveConservativeActualUsdMicros`, `classifyAttemptSpend`,
 * `computeFireSpendGuard` — shared code, not a re-derivation) at the CODE-pinned
 * conservative table; nothing the sidecar claims about itself is trusted.
 *
 * Named checks (ALL must pass):
 *   - `artifact-integrity`   — the artifact strict-parses AND its digest/relation replay
 *                              is clean (the witness itself must be sound first).
 *   - `shape`                — strict sidecar shape: exact keys, types, schema version 1,
 *                              and PROVIDER-STRICT token buckets — only the producer's
 *                              exact whitelisted paths, nonnegative safe-integer values;
 *                              dangerous path segments (`__proto__`/`constructor`/
 *                              `prototype`) fail shape and are never traversed.
 *   - `artifact-binding`     — cohort/fire/run/game identity, `requestSha256`, and the
 *                              canonical `scopedMarkets` equal the artifact's exactly.
 *   - `roster`               — the artifact's expected arms are the frozen code roster
 *                              (participant/provider/model tuples, in order).
 *   - `attempt-completeness` — exactly one initial sidecar row per roster arm, at most
 *                              one repair; every SENT artifact attempt has exactly one
 *                              matching sidecar row (role + request/response evidence +
 *                              arm identity) and vice versa — no missing, duplicate, or
 *                              foreign rows; a never-sent initial must be fully coherent
 *                              (`requestAt`/`responseAt`/buckets all null, spendClass
 *                              `zero`) and cannot stand in for a sent attempt.
 *   - `attempts-priceable`   — every sent attempt's cost recomputes (UNKNOWN fails).
 *   - `attempts-within-reservation` — every recomputed cost ≤ the reservation (exact
 *                              equality passes; one micro over fails).
 *   - `aggregate-within-crossing-cap` — the summed cost ≤ the pinned crossing cap.
 *   - `record-consistency`   — every row's stored `spendClass`, `status`, AND
 *                              `derivedActualUsdMicros` equal the recomputation exactly
 *                              (pass/unknown/never-sent rows carry null derived; a breach
 *                              carries the exact recomputed amount).
 *   - `reason-recomputed`    — the record's top-level `reason` equals the whole-fire
 *                              verdict recomputed by the runtime guard: null IFF pass,
 *                              else the exact breach/unknown reason.
 *   - `reservation-pin` / `price-identity` — the record's pins equal the code policy
 *                              amount and the code's conservative table (recomputed
 *                              digest), respectively.
 *   - `reasoning-observed`   — ≥1 attempt with a real NONZERO reasoning-token field.
 *
 * Pure core (`verifySpendEvidence`) + a thin CLI. Post-hoc evidence verification only:
 * it gates nothing at runtime; the crossing acceptance requires its PASS.
 */

const SIDECAR_KEYS = [
  'sidecarSchemaVersion',
  'cohortId',
  'fireId',
  'runId',
  'gameId',
  'scopedMarkets',
  'requestSha256',
  'reason',
  'priceVersion',
  'priceTableDigest',
  'perAttemptReservationUsdMicros',
  'attempts',
] as const;

const ATTEMPT_KEYS = [
  'participantId',
  'provider',
  'requestedModelId',
  'role',
  'requestAt',
  'responseAt',
  'usageTokens',
  'spendClass',
  'status',
  'derivedActualUsdMicros',
] as const;

const PROVIDERS: readonly string[] = ['openai', 'anthropic', 'google', 'xai'];
const SPEND_CLASSES: readonly string[] = ['known_zero', 'zero', 'price', 'unknown'];
const STATUSES: readonly string[] = ['pass', 'breach', 'unknown'];
const REASONS: readonly (string | null)[] = [null, 'spend_attempt_over_reservation', 'spend_evidence_unknown'];
const DANGEROUS_SEGMENTS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** The raw-bucket fields that count as a REASONING observation (dotted = nested).
 *  Covers both the legacy chat-completions names (old evidence) and the
 *  Responses-API / anthropic breakdown names the live adapters report. */
const REASONING_FIELDS: readonly string[] = [
  'completion_tokens_details.reasoning_tokens',
  'thoughtsTokenCount',
  'output_tokens_details.reasoning_tokens',
  'output_tokens_details.thinking_tokens',
];

export interface VerifiedAttempt {
  readonly participantId: string;
  readonly provider: ProviderName;
  readonly requestedModelId: string;
  readonly role: 'initial' | 'repair';
  /** The independently recomputed conservative cost; `null` when unpriceable or exempt. */
  readonly derivedActualUsdMicros: number | null;
  /** Why pricing did not produce a number: 'never-sent' (exempt) or the UNKNOWN detail. */
  readonly unpriced: 'never-sent' | string | null;
  /** recomputed ≤ reservation; `null` when unpriced. */
  readonly withinReservation: boolean | null;
  /** The nonzero reasoning-token observation on this attempt, if any (field + value). */
  readonly reasoningObservation: { readonly field: string; readonly tokens: number } | null;
}

export interface SidecarCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SidecarVerification {
  readonly checks: readonly SidecarCheck[];
  readonly attempts: readonly VerifiedAttempt[];
  /** Sum of recomputed costs; `null` unless every non-exempt attempt priced. */
  readonly aggregateUsdMicros: number | null;
  readonly ok: boolean;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): string | null {
  const keys = Object.keys(value).sort();
  const want = [...expected].sort();
  if (keys.length === want.length && keys.every((k, i) => k === want[i])) return null;
  return `keys [${keys.join(', ')}] != expected [${want.join(', ')}]`;
}
function orderedEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Provider-strict token-bucket validation: EVERY key must be one of the producer's exact
 * whitelisted paths for this provider, and every value a nonnegative safe integer. A
 * dangerous path segment fails regardless (defense in depth — the whitelist already
 * excludes them, and they are rejected before any traversal could occur).
 */
function tokenBucketIssue(provider: ProviderName, value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not a plain object';
  const allowed = TOKEN_FIELD_WHITELIST[provider];
  for (const [key, tokens] of Object.entries(value)) {
    if (key.split('.').some((segment) => DANGEROUS_SEGMENTS.includes(segment))) {
      return `dangerous path segment in token key "${key}"`;
    }
    if (!allowed.includes(key)) {
      return `token key "${key}" is not in the ${provider} whitelist [${allowed.join(', ')}]`;
    }
    if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) {
      return `token key "${key}" must be a nonnegative safe integer`;
    }
  }
  return null;
}

/** Strict structural parse of the sidecar; throws a descriptive Error on ANY violation. */
function parseSidecarRecord(raw: unknown): SpendEscalationSidecarV1 {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('sidecar is not a plain object');
  }
  const record = raw as Record<string, unknown>;
  const keyIssue = exactKeys(record, SIDECAR_KEYS);
  if (keyIssue !== null) throw new Error(`sidecar ${keyIssue}`);
  if (record['sidecarSchemaVersion'] !== SPEND_SIDECAR_SCHEMA_VERSION) {
    throw new Error(`unknown sidecarSchemaVersion ${String(record['sidecarSchemaVersion'])}`);
  }
  for (const field of ['cohortId', 'fireId', 'runId', 'gameId', 'requestSha256', 'priceVersion', 'priceTableDigest']) {
    if (!isNonEmptyString(record[field])) throw new Error(`${field} must be a non-empty string`);
  }
  if (!Array.isArray(record['scopedMarkets']) || !record['scopedMarkets'].every(isNonEmptyString)) {
    throw new Error('scopedMarkets must be an array of non-empty strings');
  }
  if (!REASONS.includes(record['reason'] as string | null)) {
    throw new Error(`reason must be null or an escalation reason, got ${JSON.stringify(record['reason'])}`);
  }
  const reservation = record['perAttemptReservationUsdMicros'];
  if (typeof reservation !== 'number' || !Number.isSafeInteger(reservation) || reservation <= 0) {
    throw new Error('perAttemptReservationUsdMicros must be a positive safe integer');
  }
  const attemptsRaw = record['attempts'];
  if (!Array.isArray(attemptsRaw) || attemptsRaw.length === 0) {
    throw new Error('attempts must be a non-empty array');
  }
  for (const [index, entry] of attemptsRaw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`attempts[${index}] is not a plain object`);
    }
    const attempt = entry as Record<string, unknown>;
    const attemptKeyIssue = exactKeys(attempt, ATTEMPT_KEYS);
    if (attemptKeyIssue !== null) throw new Error(`attempts[${index}] ${attemptKeyIssue}`);
    for (const field of ['participantId', 'requestedModelId']) {
      if (!isNonEmptyString(attempt[field])) throw new Error(`attempts[${index}].${field} must be a non-empty string`);
    }
    if (!PROVIDERS.includes(attempt['provider'] as string)) {
      throw new Error(`attempts[${index}].provider must be one of ${PROVIDERS.join('/')}`);
    }
    if (attempt['role'] !== 'initial' && attempt['role'] !== 'repair') {
      throw new Error(`attempts[${index}].role must be initial|repair`);
    }
    for (const field of ['requestAt', 'responseAt']) {
      const v = attempt[field];
      if (v !== null && (!isNonEmptyString(v) || !isParseableInstant(v))) {
        throw new Error(`attempts[${index}].${field} must be an offset-qualified instant or null`);
      }
    }
    if (attempt['usageTokens'] !== null) {
      const issue = tokenBucketIssue(attempt['provider'] as ProviderName, attempt['usageTokens']);
      if (issue !== null) throw new Error(`attempts[${index}].usageTokens: ${issue}`);
    }
    if (!SPEND_CLASSES.includes(attempt['spendClass'] as string)) {
      throw new Error(`attempts[${index}].spendClass must be one of ${SPEND_CLASSES.join('/')}`);
    }
    if (!STATUSES.includes(attempt['status'] as string)) {
      throw new Error(`attempts[${index}].status must be one of ${STATUSES.join('/')}`);
    }
    const derived = attempt['derivedActualUsdMicros'];
    if (derived !== null && (typeof derived !== 'number' || !Number.isSafeInteger(derived) || derived < 0)) {
      throw new Error(`attempts[${index}].derivedActualUsdMicros must be a nonnegative safe integer or null`);
    }
  }
  return record as unknown as SpendEscalationSidecarV1;
}

/**
 * Rebuild a nested usageRaw-shaped object from whitelisted dotted token paths, into
 * NULL-PROTOTYPE objects with dangerous segments rejected outright — a persisted key can
 * never traverse or mutate any prototype. (Shape validation already restricts keys to the
 * producer whitelist; this guard is defense in depth and is unit-tested directly.)
 */
export function rebuildUsageRaw(tokens: Readonly<Record<string, number>>): Record<string, unknown> {
  const usage: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [path, value] of Object.entries(tokens)) {
    const segments = path.split('.');
    if (segments.some((segment) => DANGEROUS_SEGMENTS.includes(segment) || segment.length === 0)) {
      throw new Error(`dangerous or empty path segment in token key "${path}"`);
    }
    let current = usage;
    for (const segment of segments.slice(0, -1)) {
      const next = current[segment];
      if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
        current = next as Record<string, unknown>;
      } else {
        const created: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        current[segment] = created;
        current = created;
      }
    }
    current[segments[segments.length - 1]!] = value;
  }
  return usage;
}

/** One artifact-side sent attempt: the authoritative fact a sidecar row must match. */
interface ArtifactSentAttempt {
  readonly participantId: string;
  readonly provider: string;
  readonly requestedModelId: string;
  readonly kind: 'initial' | 'repair';
  readonly requestStartedAt: string;
  readonly requestReceivedAt: string | null;
}

export interface SpendEvidenceInput {
  /** The durable fire artifact's EXACT bytes (as installed). */
  readonly artifactBytes: string;
  /** The parsed sidecar JSON. */
  readonly sidecar: unknown;
}

function failOnly(name: string, detail: string): SidecarVerification {
  return { checks: [{ name, ok: false, detail }], attempts: [], aggregateUsdMicros: null, ok: false };
}

/**
 * Verify one durable artifact–sidecar pair. See the module header for the named checks;
 * every check must pass for `ok`. Pure — no filesystem, no clock.
 */
export function verifySpendEvidence(input: SpendEvidenceInput): SidecarVerification {
  // (1) The witness first: the artifact must strict-parse and replay clean before any of
  //     its facts are trusted as the relational baseline.
  let artifact: FireArtifactV1;
  try {
    artifact = parseFireArtifactV1(input.artifactBytes);
  } catch (error) {
    return failOnly('artifact-integrity', `artifact does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
  const replay = verifyFireArtifactReplay(artifact);
  if (replay.length > 0) {
    return failOnly('artifact-integrity', `artifact replay violations: ${replay.join('; ')}`);
  }

  // (2) Strict sidecar shape (incl. provider-strict token buckets).
  let record: SpendEscalationSidecarV1;
  try {
    record = parseSidecarRecord(input.sidecar);
  } catch (error) {
    return {
      checks: [
        { name: 'artifact-integrity', ok: true, detail: 'artifact parses and replays clean' },
        { name: 'shape', ok: false, detail: error instanceof Error ? error.message : String(error) },
      ],
      attempts: [],
      aggregateUsdMicros: null,
      ok: false,
    };
  }
  const checks: SidecarCheck[] = [
    { name: 'artifact-integrity', ok: true, detail: 'artifact parses and replays clean' },
    { name: 'shape', ok: true, detail: 'strict sidecar shape holds (provider-strict token buckets)' },
  ];

  // (3) Identity binding to the artifact.
  const bindingIssues: string[] = [];
  const identityPairs: readonly [string, string, string][] = [
    ['cohortId', record.cohortId, artifact.cohortId],
    ['fireId', record.fireId, artifact.fireId],
    ['runId', record.runId, artifact.runId],
    ['gameId', record.gameId, artifact.gameId],
    ['requestSha256', record.requestSha256, artifact.requestSha256],
  ];
  for (const [label, sidecarValue, artifactValue] of identityPairs) {
    if (sidecarValue !== artifactValue) bindingIssues.push(`${label}: sidecar "${sidecarValue}" != artifact "${artifactValue}"`);
  }
  if (!orderedEqual(record.scopedMarkets, artifact.scopedMarkets)) {
    bindingIssues.push(
      `scopedMarkets [${record.scopedMarkets.join(', ')}] != artifact [${artifact.scopedMarkets.join(', ')}]`,
    );
  }
  const artifactMarkets = artifact.scopedMarkets as readonly MarketKey[];
  const canonicalArtifactMarkets = [...artifactMarkets].sort((a, b) => MARKET_ORDINAL[a] - MARKET_ORDINAL[b]);
  if (!orderedEqual(artifactMarkets, canonicalArtifactMarkets)) {
    bindingIssues.push(`artifact scopedMarkets [${artifact.scopedMarkets.join(', ')}] are not in canonical market order`);
  }
  checks.push({
    name: 'artifact-binding',
    ok: bindingIssues.length === 0,
    detail: bindingIssues.length === 0 ? 'sidecar identity equals the artifact exactly' : bindingIssues.join('; '),
  });

  // (4) The artifact roster must be the frozen code roster (tuple identity, in order).
  const rosterOk =
    artifact.expectedArmIdentities.length === ARMS.length &&
    artifact.expectedArmIdentities.every(
      (arm, i) =>
        arm.participantId === ARMS[i]!.participantId &&
        arm.provider === ARMS[i]!.provider &&
        arm.requestedModelId === ARMS[i]!.requestedModelId,
    );
  checks.push({
    name: 'roster',
    ok: rosterOk,
    detail: rosterOk
      ? `the artifact roster is the frozen ${ARMS.length}-arm code roster`
      : `artifact roster [${artifact.expectedArmIdentities.map((a) => a.participantId).join(', ')}] != code roster ` +
        `[${ARMS.map((a) => a.participantId).join(', ')}]`,
  });

  // (5) Attempt completeness against the artifact's authoritative sent-attempt set.
  const armById = new Map(artifact.arms.map((arm) => [arm.expectedArmIdentity.participantId, arm]));
  const sentByKey = new Map<string, ArtifactSentAttempt>();
  for (const arm of artifact.arms) {
    for (const attempt of arm.orderedAttempts) {
      const key = `${arm.expectedArmIdentity.participantId}::${attempt.kind}::${attempt.requestStartedAt}`;
      sentByKey.set(key, {
        participantId: arm.expectedArmIdentity.participantId,
        provider: arm.expectedArmIdentity.provider,
        requestedModelId: arm.expectedArmIdentity.requestedModelId,
        kind: attempt.kind,
        requestStartedAt: attempt.requestStartedAt,
        requestReceivedAt: attempt.requestReceivedAt,
      });
    }
  }
  const completenessIssues: string[] = [];
  const matchedKeys = new Set<string>();
  const rowCounts = new Map<string, { initial: number; repair: number }>();
  for (const [index, row] of record.attempts.entries()) {
    const who = `attempts[${index}] (${row.participantId}/${row.role})`;
    const arm = armById.get(row.participantId);
    if (arm === undefined) {
      completenessIssues.push(`${who}: participant is not in the artifact roster`);
      continue;
    }
    const identity = arm.expectedArmIdentity;
    if (row.provider !== identity.provider || row.requestedModelId !== identity.requestedModelId) {
      completenessIssues.push(
        `${who}: identity ${row.provider}/${row.requestedModelId} != artifact arm ${identity.provider}/${identity.requestedModelId}`,
      );
    }
    const counts = rowCounts.get(row.participantId) ?? { initial: 0, repair: 0 };
    counts[row.role] += 1;
    rowCounts.set(row.participantId, counts);

    if (row.requestAt === null) {
      // The producer persists one terminal initial per roster arm, but never fabricates an
      // unsent repair: pre-dispatch repair refusal is represented by `repair: null`.
      if (row.role === 'repair') {
        completenessIssues.push(`${who}: a never-sent repair has no artifact witness`);
      }
      // A never-sent initial must be fully coherent and must not shadow a sent artifact attempt.
      if (row.responseAt !== null || row.usageTokens !== null || row.spendClass !== 'zero') {
        completenessIssues.push(`${who}: never-sent row must have null responseAt, null buckets, and spendClass zero`);
      }
      const armSent = arm.orderedAttempts.some((a) => a.kind === row.role);
      if (armSent) {
        completenessIssues.push(`${who}: never-sent row but the artifact records a SENT ${row.role} for this arm`);
      }
      continue;
    }
    const key = `${row.participantId}::${row.role}::${row.requestAt}`;
    const sent = sentByKey.get(key);
    if (sent === undefined) {
      completenessIssues.push(`${who}: no artifact attempt matches (role + request instant) — foreign or fabricated row`);
      continue;
    }
    if (matchedKeys.has(key)) {
      completenessIssues.push(`${who}: duplicate row for one artifact attempt`);
      continue;
    }
    matchedKeys.add(key);
    if (sent.requestReceivedAt !== null && row.responseAt !== sent.requestReceivedAt) {
      completenessIssues.push(
        `${who}: responseAt ${String(row.responseAt)} != artifact requestReceivedAt ${sent.requestReceivedAt}`,
      );
    }
    if (sent.requestReceivedAt === null && row.usageTokens !== null) {
      completenessIssues.push(`${who}: sidecar has usage buckets but the artifact records no received response`);
    }
  }
  for (const key of sentByKey.keys()) {
    if (!matchedKeys.has(key)) {
      completenessIssues.push(`artifact attempt ${key.replaceAll('::', ' ')} has no matching sidecar row`);
    }
  }
  for (const arm of artifact.expectedArmIdentities) {
    const counts = rowCounts.get(arm.participantId) ?? { initial: 0, repair: 0 };
    if (counts.initial !== 1) {
      completenessIssues.push(`roster arm ${arm.participantId}: expected exactly one initial row, got ${counts.initial}`);
    }
    if (counts.repair > 1) {
      completenessIssues.push(`roster arm ${arm.participantId}: at most one repair row, got ${counts.repair}`);
    }
  }
  checks.push({
    name: 'attempt-completeness',
    ok: completenessIssues.length === 0,
    detail:
      completenessIssues.length === 0
        ? 'every artifact attempt has exactly one matching row; every roster arm has exactly one initial'
        : completenessIssues.join('; '),
  });

  // (6) Pins.
  const expectedDigest = modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION);
  const priceOk =
    record.priceVersion === SPEND_GUARD_PRICE_TABLE_VERSION && record.priceTableDigest === expectedDigest;
  checks.push({
    name: 'price-identity',
    ok: priceOk,
    detail: priceOk
      ? `record prices at ${SPEND_GUARD_PRICE_TABLE_VERSION} with the recomputed digest`
      : `record claims ${record.priceVersion} (digest ${record.priceTableDigest}); the code's conservative guard ` +
        `table is ${SPEND_GUARD_PRICE_TABLE_VERSION} (digest ${expectedDigest})`,
  });
  const reservationOk = record.perAttemptReservationUsdMicros === PROVIDER_ATTEMPT_RESERVATION_USD_MICROS;
  checks.push({
    name: 'reservation-pin',
    ok: reservationOk,
    detail: reservationOk
      ? `per-attempt reservation is the code policy amount (${PROVIDER_ATTEMPT_RESERVATION_USD_MICROS})`
      : `record reservation ${record.perAttemptReservationUsdMicros} != code policy ${PROVIDER_ATTEMPT_RESERVATION_USD_MICROS}`,
  });

  // (7) Per-attempt recomputation with the SAME arithmetic + classification the guard uses.
  const attempts: VerifiedAttempt[] = [];
  const consistencyIssues: string[] = [];
  for (const row of record.attempts) {
    const who = `${row.participantId}/${row.role}`;
    const rebuilt = row.usageTokens === null ? null : rebuildUsageRaw(row.usageTokens);
    const recomputedClass = classifyAttemptSpend({
      billingClass: 'billable',
      requestAt: row.requestAt,
      usageRaw: rebuilt,
    });
    if (row.spendClass !== recomputedClass) {
      consistencyIssues.push(`${who}: recorded spendClass ${row.spendClass} != recomputed ${recomputedClass}`);
    }

    const neverSent = row.requestAt === null && row.usageTokens === null;
    let derived: number | null = null;
    let unpriced: VerifiedAttempt['unpriced'] = null;
    if (neverSent) {
      unpriced = 'never-sent';
    } else if (rebuilt === null) {
      unpriced = 'sent with no usage buckets — UNKNOWN';
    } else {
      try {
        derived = deriveConservativeActualUsdMicros({
          provider: row.provider,
          requestedModelId: row.requestedModelId,
          priceVersion: SPEND_GUARD_PRICE_TABLE_VERSION,
          usageRaw: rebuilt,
        });
      } catch (error) {
        if (!(error instanceof ConservativeSpendUnknownError)) throw error;
        unpriced = error.message;
      }
    }
    const withinReservation = derived === null ? null : derived <= record.perAttemptReservationUsdMicros;

    // EXACT stored-verdict comparison: status AND derived amount, for every row kind.
    if (derived !== null) {
      const recomputedStatus = derived > record.perAttemptReservationUsdMicros ? 'breach' : 'pass';
      if (row.status !== recomputedStatus) {
        consistencyIssues.push(`${who}: recorded status ${row.status} != recomputed ${recomputedStatus}`);
      }
      const expectedDerived = recomputedStatus === 'breach' ? derived : null;
      if (row.derivedActualUsdMicros !== expectedDerived) {
        consistencyIssues.push(
          `${who}: recorded derivedActualUsdMicros ${String(row.derivedActualUsdMicros)} != expected ${String(expectedDerived)}`,
        );
      }
    } else {
      const expectedStatus = unpriced === 'never-sent' ? 'pass' : 'unknown';
      if (row.status !== expectedStatus) {
        consistencyIssues.push(`${who}: recorded status ${row.status} != recomputed ${expectedStatus}`);
      }
      if (row.derivedActualUsdMicros !== null) {
        consistencyIssues.push(`${who}: an unpriced row must carry null derivedActualUsdMicros`);
      }
    }
    if (row.spendClass === 'known_zero') {
      consistencyIssues.push(`${who}: spendClass known_zero inside a billable spend sidecar is incoherent`);
    }

    let reasoningObservation: VerifiedAttempt['reasoningObservation'] = null;
    if (row.usageTokens !== null) {
      for (const field of REASONING_FIELDS) {
        const tokens = row.usageTokens[field];
        if (typeof tokens === 'number' && tokens > 0) {
          reasoningObservation = { field, tokens };
          break;
        }
      }
    }
    attempts.push(
      Object.freeze({
        participantId: row.participantId,
        provider: row.provider,
        requestedModelId: row.requestedModelId,
        role: row.role,
        derivedActualUsdMicros: derived,
        unpriced,
        withinReservation,
        reasoningObservation,
      }),
    );
  }

  const unpriceable = attempts.filter((a) => a.unpriced !== null && a.unpriced !== 'never-sent');
  checks.push({
    name: 'attempts-priceable',
    ok: unpriceable.length === 0,
    detail:
      unpriceable.length === 0
        ? 'every sent attempt recomputes to a conservative cost'
        : unpriceable.map((a) => `${a.participantId}/${a.role}: ${String(a.unpriced)}`).join('; '),
  });

  const overReservation = attempts.filter((a) => a.withinReservation === false);
  checks.push({
    name: 'attempts-within-reservation',
    ok: overReservation.length === 0,
    detail:
      overReservation.length === 0
        ? `every recomputed attempt ≤ ${record.perAttemptReservationUsdMicros}`
        : overReservation
            .map((a) => `${a.participantId}/${a.role}: ${String(a.derivedActualUsdMicros)} over the reservation`)
            .join('; '),
  });

  const allPriced = unpriceable.length === 0;
  const aggregateUsdMicros = allPriced
    ? attempts.reduce((sum, a) => sum + (a.derivedActualUsdMicros ?? 0), 0)
    : null;
  const aggregateOk = aggregateUsdMicros !== null && aggregateUsdMicros <= CROSSING_PROFILE.cohortSpendCapUsdMicros;
  checks.push({
    name: 'aggregate-within-crossing-cap',
    ok: aggregateOk,
    detail:
      aggregateUsdMicros === null
        ? 'no aggregate — at least one attempt did not recompute'
        : `${aggregateUsdMicros} vs the crossing spend cap ${CROSSING_PROFILE.cohortSpendCapUsdMicros}`,
  });

  checks.push({
    name: 'record-consistency',
    ok: consistencyIssues.length === 0,
    detail: consistencyIssues.length === 0 ? 'stored spendClass/status/derived agree with the recomputation' : consistencyIssues.join('; '),
  });

  // (8) The whole-fire reason, recomputed by the RUNTIME guard over the sidecar's rows
  //     grouped per roster arm (arm identity from the ARTIFACT, never the row's claims).
  let reasonDetail: string;
  let reasonOk: boolean;
  try {
    const guardArms: GuardArmInput[] = artifact.expectedArmIdentities.map((identity) => {
      const initial = record.attempts.find((r) => r.participantId === identity.participantId && r.role === 'initial');
      const repair = record.attempts.find((r) => r.participantId === identity.participantId && r.role === 'repair');
      const leg = (row: SidecarAttemptRecord | undefined): { requestAt: string | null; usageRaw: unknown } => ({
        requestAt: row?.requestAt ?? null,
        usageRaw: row?.usageTokens == null ? null : rebuildUsageRaw(row.usageTokens),
      });
      return {
        participantId: identity.participantId,
        billingClass: 'billable',
        provider: identity.provider as ProviderName,
        requestedModelId: identity.requestedModelId,
        attempt: leg(initial),
        repair: repair === undefined ? null : leg(repair),
      };
    });
    const verdict = computeFireSpendGuard({
      arms: guardArms,
      priceVersion: SPEND_GUARD_PRICE_TABLE_VERSION,
      perAttemptReservationUsdMicros: PROVIDER_ATTEMPT_RESERVATION_USD_MICROS,
    });
    const expectedReason =
      verdict.kind === 'pass'
        ? null
        : verdict.kind === 'breach'
          ? 'spend_attempt_over_reservation'
          : 'spend_evidence_unknown';
    reasonOk = record.reason === expectedReason;
    reasonDetail = reasonOk
      ? `recorded reason ${record.reason === null ? 'null (clean pass)' : record.reason} matches the recomputed verdict`
      : `recorded reason ${String(record.reason)} != recomputed ${String(expectedReason)} (guard verdict ${verdict.kind})`;
  } catch (error) {
    reasonOk = false;
    reasonDetail = `whole-fire verdict could not be recomputed: ${error instanceof Error ? error.message : String(error)}`;
  }
  checks.push({ name: 'reason-recomputed', ok: reasonOk, detail: reasonDetail });

  const observations = attempts.filter((a) => a.reasoningObservation !== null);
  checks.push({
    name: 'reasoning-observed',
    ok: observations.length > 0,
    detail:
      observations.length > 0
        ? observations
            .map((a) => `${a.participantId}/${a.role}: ${a.reasoningObservation!.field}=${a.reasoningObservation!.tokens}`)
            .join('; ')
        : 'no attempt shows a nonzero reasoning-token field',
  });

  return Object.freeze({
    checks: Object.freeze(checks),
    attempts: Object.freeze(attempts),
    aggregateUsdMicros,
    ok: checks.every((c) => c.ok),
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: yarn verify:sidecar <path-to-fire-artifact.json> <path-to-fire-spend.json>

Verifies the durable ARTIFACT-SIDECAR PAIR: strict-parses and replay-verifies the
artifact with its existing owners, binds the sidecar to it (identity, roster,
attempt completeness), and independently recomputes every attempt's conservative
cost and the whole-fire verdict with the exact runtime arithmetic at the
code-pinned conservative price table. Exit 0 IFF every named check passes.`;

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(6)}`;
}

function main(argv: string[]): number {
  if (argv.length === 1 && (argv[0] === '-h' || argv[0] === '--help')) {
    printLine(USAGE);
    return 0;
  }
  if (argv.length !== 2) {
    printLine(USAGE);
    return 2;
  }
  const [artifactPath, sidecarPath] = argv as [string, string];
  let artifactBytes: string;
  try {
    artifactBytes = readFileSync(artifactPath, 'utf8');
  } catch (error) {
    printError(`could not read ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  let sidecar: unknown;
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as unknown;
  } catch (error) {
    printError(`could not read/parse ${sidecarPath}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const verification = verifySpendEvidence({ artifactBytes, sidecar });

  printLine(`spend evidence verification`);
  printLine(`  artifact ${artifactPath}`);
  printLine(`  sidecar  ${sidecarPath}`);
  const record = sidecar as Partial<SpendEscalationSidecarV1>;
  if (typeof record.cohortId === 'string') printLine(`  cohort ${record.cohortId}`);
  if (typeof record.fireId === 'string') {
    printLine(`  fire ${record.fireId} — reason ${record.reason === null ? 'none (clean pass)' : String(record.reason)}`);
  }
  printLine('  attempts:');
  for (const attempt of verification.attempts) {
    const cost =
      attempt.derivedActualUsdMicros === null
        ? `UNPRICED (${String(attempt.unpriced)})`
        : `${usd(attempt.derivedActualUsdMicros)} (µUSD ${attempt.derivedActualUsdMicros})` +
          (attempt.withinReservation === true ? ' within reservation' : ' OVER RESERVATION');
    printLine(`    ${attempt.participantId} ${attempt.role}: ${cost}`);
  }
  printLine('  checks:');
  for (const check of verification.checks) {
    printLine(`    [${check.ok ? 'ok' : 'FAIL'}] ${check.name} — ${check.detail}`);
  }
  if (verification.aggregateUsdMicros !== null) {
    printLine(
      `  aggregate: ${usd(verification.aggregateUsdMicros)} (µUSD ${verification.aggregateUsdMicros}) vs crossing cap ` +
        `${usd(CROSSING_PROFILE.cohortSpendCapUsdMicros)}`,
    );
  }
  printLine(`  VERDICT: ${verification.ok ? 'PASS' : 'FAIL'}`);
  return verification.ok ? 0 : 1;
}

/** True only when this module is the process entry point (importing it never runs the CLI). */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = main(process.argv.slice(2));
}
