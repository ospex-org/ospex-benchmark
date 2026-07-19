import { z } from 'zod';
import { canonicalize, sha256Hex } from './canonical.js';
import { redactSecrets } from './config.js';
import { deepFreeze } from './freeze.js';
import { forecastFingerprint } from './schema.js';
import type { CohortManifestV1 } from './manifest.js';
import type { ArmGameResult, ArmOutcome, AttemptRecord, BenchmarkResponse, MarketKey, ProviderUsage } from './types.js';

/**
 * The fire artifact's ARM INTEGRITY CORE (SPEC-line-open-evidence-model.md
 * §5): the per-arm evidence subgraph (expected-arm identity, decision fingerprint,
 * persisted-attempt mapping) and its recomputable `armDigest`. Pure and I/O-free —
 * NO RunEnvelope authentication, detection/opener composition, publication,
 * baselines, claim linkage, writer, or top-level artifact; those are the producer
 * slices. Every output is a detached, deeply-frozen, plain-JSON value the scorer
 * can re-parse and recompute byte-for-byte. Nullable persisted fields use explicit
 * `null` (never `undefined`, which `canonicalize` drops).
 */

/** Canonical market order (SPEC §3): moneyline < spread < total. Exported so the
 *  producer slice orders its scoped market set / evidence by the SAME order. */
export const MARKET_ORDINAL: Readonly<Record<MarketKey, number>> = { moneyline: 0, spread: 1, total: 2 };

const armOutcomeSchemaV1 = z.enum([
  'valid',
  'invalid_schema',
  'timeout',
  'credential_missing',
  'rate_limited',
  'provider_error',
  'cutoff_missed',
  'dispatch_lag_exceeded',
]);

// Compile-time parity: the runtime outcome enum must equal the ArmOutcome union,
// so a new outcome cannot drift the persisted schema out of sync with the type.
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _armOutcomeParity: AssertEqual<z.infer<typeof armOutcomeSchemaV1>, ArmOutcome> = true;
void _armOutcomeParity;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** The transport outcome of a SENT attempt (a received body is `ok`; the rest are
 *  the failure classifications). Never `null` — an unsent attempt is not persisted. */
const attemptTransportSchemaV1 = z.enum(['ok', 'timeout', 'rate_limited', 'provider_error']);
export type AttemptTransportV1 = z.infer<typeof attemptTransportSchemaV1>;

// Token counts are hash-bound (usage folds into armDigest via orderedAttempts), so
// they must be SAFE non-negative integers: two distinct raw upstream integers above
// Number.MAX_SAFE_INTEGER collapse to the same JS value and would collide pre-hash.
const tokenCountSchemaV1 = z.number().int().safe().nonnegative().nullable();
const providerUsageSchemaV1 = z
  .object({
    inputTokens: tokenCountSchemaV1,
    outputTokens: tokenCountSchemaV1,
    totalTokens: tokenCountSchemaV1,
  })
  .strict();
// Compile-time parity: the persisted usage shape must equal the normalized ProviderUsage.
const _usageParity: AssertEqual<z.infer<typeof providerUsageSchemaV1>, ProviderUsage> = true;
void _usageParity;

// ---------------------------------------------------------------------------
// Expected-arm identity: the authenticated manifest roster-entry projection
// ---------------------------------------------------------------------------

export interface ExpectedArmIdentityV1 {
  participantId: string;
  provider: string;
  requestedModelId: string;
  approvedReportedModelIds: readonly string[];
}

export const expectedArmIdentitySchemaV1 = z
  .object({
    participantId: z.string().min(1),
    provider: z.string().min(1),
    requestedModelId: z.string().min(1),
    approvedReportedModelIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

/**
 * Project one manifest roster entry to its expected-arm identity:
 * participantId, provider, requestedModelId, and the manifest's
 * `approvedReportedModelIds` IN ORDER. Excludes credential locations, observed
 * reported IDs, roster index, and the cohort/fire/run domain (separate `armDigest`
 * fields). The result is detached (defensive array copy) and deep-frozen.
 */
export function expectedArmIdentity(
  entry: CohortManifestV1['expectedArmRoster'][number],
): ExpectedArmIdentityV1 {
  return deepFreeze({
    participantId: entry.participantId,
    provider: entry.provider,
    requestedModelId: entry.requestedModelId,
    approvedReportedModelIds: [...entry.approvedReportedModelIds],
  });
}

// ---------------------------------------------------------------------------
// Decision fingerprint: the repair-preservation projection, as a canonical
// ordered ARRAY (never a Map, never a second per-market hash)
// ---------------------------------------------------------------------------

export interface DecisionFingerprintEntryV1 {
  gameId: string;
  market: MarketKey;
  selection: string;
  line: number | null;
  observedDecimal: number;
  probabilities: { win: number; push: number; loss: number };
  confidence: number;
  wouldAbstain: boolean;
  selectedForExecution: boolean;
}

export type AcceptedDecisionFingerprintV1 = readonly DecisionFingerprintEntryV1[];

export const decisionFingerprintEntrySchemaV1 = z
  .object({
    gameId: z.string().min(1),
    market: z.enum(['moneyline', 'spread', 'total']),
    selection: z.string().min(1),
    line: z.number().nullable(),
    observedDecimal: z.number(),
    probabilities: z.object({ win: z.number(), push: z.number(), loss: z.number() }).strict(),
    confidence: z.number(),
    wouldAbstain: z.boolean(),
    selectedForExecution: z.boolean(),
  })
  .strict();

export const acceptedDecisionFingerprintSchemaV1 = z.array(decisionFingerprintEntrySchemaV1);

/**
 * The decision fingerprint of a validated response: one entry per forecast,
 * carrying the SAME decision-bearing fields the repair-preservation check binds
 * (schema.ts `forecastFingerprint`) plus `(gameId, market)` identity, sorted in
 * canonical `(gameId, market)` order. Reuses `forecastFingerprint` so there is no
 * second semantic contract; excludes rationale/evidenceRefs/reasonCode (which a
 * format-only repair may change and which stay bound via the retained body +
 * `responseSha256`). The result is detached and deep-frozen.
 */
export function decisionFingerprint(parsed: BenchmarkResponse): AcceptedDecisionFingerprintV1 {
  const entries: DecisionFingerprintEntryV1[] = [];
  for (const game of parsed.games) {
    for (const forecast of game.forecasts) {
      const fp = forecastFingerprint(forecast);
      entries.push({
        gameId: game.gameId,
        market: forecast.market,
        selection: fp.selection,
        line: fp.line,
        observedDecimal: fp.observedDecimal,
        probabilities: { win: fp.win, push: fp.push, loss: fp.loss },
        confidence: fp.confidence,
        wouldAbstain: fp.wouldAbstain,
        selectedForExecution: fp.selectedForExecution,
      });
    }
  }
  entries.sort((a, b) => {
    if (a.gameId !== b.gameId) return a.gameId < b.gameId ? -1 : 1;
    return MARKET_ORDINAL[a.market] - MARKET_ORDINAL[b.market];
  });
  return deepFreeze(entries);
}

// ---------------------------------------------------------------------------
// Persisted attempts: the sent-attempt subgraph + the response digest
// ---------------------------------------------------------------------------

export interface PersistedAttemptV1 {
  /** 1 = initial, 2 = repair. */
  attemptNumber: number;
  kind: 'initial' | 'repair';
  requestStartedAt: string;
  /** `null` for a timeout/transport settle with no received response. */
  requestReceivedAt: string | null;
  /** `null` unless the response was accepted before the cutoff (the runner stamps
   *  it only after validation, never on a timeout/transport settle). */
  acceptedAt: string | null;
  reportedModelId: string | null;
  httpStatus: number | null;
  /** Redacted retained body, or `null` when no body was received. */
  persistedResponseBody: string | null;
  /** `sha256Hex(persistedResponseBody)`, or `null` with no body. */
  responseSha256: string | null;
  /** The typed transport outcome of this sent attempt (distinguishes a timeout
   *  from a provider error, which a body-less attempt otherwise cannot). */
  transport: AttemptTransportV1;
  /** Detached, normalized token usage for this attempt, or `null`. */
  usage: ProviderUsage | null;
}

export const persistedAttemptSchemaV1 = z
  .object({
    attemptNumber: z.number().int().positive(),
    kind: z.enum(['initial', 'repair']),
    requestStartedAt: z.string().min(1),
    requestReceivedAt: z.string().min(1).nullable(),
    acceptedAt: z.string().min(1).nullable(),
    reportedModelId: z.string().min(1).nullable(),
    httpStatus: z.number().int().nullable(),
    persistedResponseBody: z.string().nullable(),
    responseSha256: sha256Schema.nullable(),
    transport: attemptTransportSchemaV1,
    usage: providerUsageSchemaV1.nullable(),
  })
  .strict();

/**
 * Map an arm result's initial + optional repair `AttemptRecord`s to the ordered
 * persisted attempts (SPEC §5). An UNSENT attempt (`requestAt === null`:
 * credential_missing, pre-dispatch cutoff, or an unsent initial) is OMITTED — never
 * a fake attempt (so an expected arm may legitimately have zero sent attempts).
 * Receipt is derived truthfully: a response body OR an HTTP status means the
 * response was received (`requestReceivedAt = responseAt`); a timeout/transport
 * settle with neither means no receipt (`null`). The response digest follows the
 * response-digest byte rule: `sha256Hex(redactSecrets(rawText))` (idempotent — the runner
 * already redacts), or `null` with no body. Each sent attempt also retains its typed
 * transport (so a timeout is distinct from a provider error) and detached normalized
 * usage. The result is detached and deep-frozen.
 */
export function toPersistedAttempts(result: ArmGameResult): readonly PersistedAttemptV1[] {
  const attempts: PersistedAttemptV1[] = [];
  // The transport of a sent attempt: a received body is `ok`; otherwise the repair's
  // own `repairTransport`, or — for a body-less initial (a sole attempt, since a
  // repair needs the initial body) — the arm's terminal outcome, which carries the
  // exact failure classification.
  const transportOf = (record: AttemptRecord, kind: 'initial' | 'repair'): AttemptTransportV1 => {
    if (record.rawText !== null) return 'ok';
    if (kind === 'repair') return result.repairTransport ?? 'provider_error';
    return result.outcome === 'timeout' || result.outcome === 'rate_limited'
      ? result.outcome
      : 'provider_error';
  };
  const mapOne = (record: AttemptRecord, attemptNumber: number, kind: 'initial' | 'repair'): void => {
    const requestStartedAt = record.requestAt;
    if (requestStartedAt === null) return; // unsent — not a sent attempt
    const requestReceivedAt =
      record.rawText !== null || record.httpStatus !== null ? record.responseAt : null;
    const persistedResponseBody = record.rawText !== null ? redactSecrets(record.rawText) : null;
    const responseSha256 = persistedResponseBody !== null ? sha256Hex(persistedResponseBody) : null;
    attempts.push({
      attemptNumber,
      kind,
      requestStartedAt,
      requestReceivedAt,
      acceptedAt: record.acceptedAt,
      reportedModelId: record.reportedModelId,
      httpStatus: record.httpStatus,
      persistedResponseBody,
      responseSha256,
      transport: transportOf(record, kind),
      usage: record.usage === null ? null : { ...record.usage },
    });
  };
  mapOne(result.attempt, 1, 'initial');
  if (result.repair !== null) mapOne(result.repair, 2, 'repair');
  return deepFreeze(attempts);
}

// ---------------------------------------------------------------------------
// armDigest: the recomputable per-arm integrity digest (SPEC §5)
// ---------------------------------------------------------------------------

export interface ArmDigestInputV1 {
  cohortId: string;
  fireId: string;
  runId: string;
  participantId: string;
  requestSha256: string;
  expectedArmIdentity: ExpectedArmIdentityV1;
  orderedAttempts: readonly PersistedAttemptV1[];
  terminalOutcome: ArmOutcome;
  /** The accepted attempt's `responseSha256`, or `null` for a non-`valid` arm. */
  acceptedResponseDigestOrNull: string | null;
  /** The accepted decision fingerprint array, or `null` for a non-`valid` arm. */
  acceptedDecisionFingerprintOrNull: AcceptedDecisionFingerprintV1 | null;
}

/**
 * The exact ten-field digest domain, strict — an unknown, missing, own-`undefined`,
 * or malformed field fails parse, so the digest can bind ONLY these fields (a bare
 * `canonicalize` would silently hash an 11th field and silently drop an `undefined`
 * required one, yielding a digest a producer cannot recompute from the ten).
 */
export const armDigestInputSchemaV1 = z
  .object({
    cohortId: z.string().min(1),
    fireId: z.string().min(1),
    runId: z.string().min(1),
    participantId: z.string().min(1),
    requestSha256: sha256Schema,
    expectedArmIdentity: expectedArmIdentitySchemaV1,
    orderedAttempts: z.array(persistedAttemptSchemaV1),
    terminalOutcome: armOutcomeSchemaV1,
    acceptedResponseDigestOrNull: sha256Schema.nullable(),
    acceptedDecisionFingerprintOrNull: acceptedDecisionFingerprintSchemaV1.nullable(),
  })
  .strict();

/**
 * The recomputable per-arm digest (SPEC §5): `sha256Hex(canonicalize(...))` over
 * exactly the ten domain-bound fields — the input is strict-parsed first, so unknown,
 * missing, own-`undefined`, and malformed fields fail closed. `canonicalize`
 * key-sorts objects but PRESERVES array order (so `approvedReportedModelIds`,
 * `orderedAttempts`, and the decision fingerprint keep their canonical order).
 * Domain-bound to cohort/fire/run/participant so an arm record cannot be replayed
 * into another fire without changing the digest.
 */
export function armDigest(input: ArmDigestInputV1): string {
  return sha256Hex(canonicalize(armDigestInputSchemaV1.parse(input)));
}

// ---------------------------------------------------------------------------
// ArmEvidenceV1: the per-arm persisted subgraph (assembled by the producer slice)
// ---------------------------------------------------------------------------

export interface ArmEvidenceV1 {
  expectedArmIdentity: ExpectedArmIdentityV1;
  terminalOutcome: ArmOutcome;
  /** The initial attempt's request-start instant — the SOLE V-lag operand, kept
   *  distinct from `orderedAttempts` so the scorer never applies the initial V-lag
   *  to a repair; `null` when the initial was never sent. */
  initialRequestStartedAt: string | null;
  orderedAttempts: readonly PersistedAttemptV1[];
  acceptedResponseDigest: string | null;
  acceptedDecisionFingerprint: AcceptedDecisionFingerprintV1 | null;
  armDigest: string;
}

export const armEvidenceSchemaV1 = z
  .object({
    expectedArmIdentity: expectedArmIdentitySchemaV1,
    terminalOutcome: armOutcomeSchemaV1,
    initialRequestStartedAt: z.string().min(1).nullable(),
    orderedAttempts: z.array(persistedAttemptSchemaV1),
    acceptedResponseDigest: sha256Schema.nullable(),
    acceptedDecisionFingerprint: acceptedDecisionFingerprintSchemaV1.nullable(),
    armDigest: sha256Schema,
  })
  .strict();
