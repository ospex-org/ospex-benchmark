import { createHash } from 'node:crypto';
import { classifyAttemptSpend } from './spendGuard.js';
import type { AttemptSpendClass, BillingClass, FireSpendVerdict } from './spendGuard.js';
import type { FireArtifactV1 } from './fireArtifactProducer.js';
import type { ArmGameResult, MarketKey, ProviderName } from './types.js';

/**
 * The REDACTED, token-count-only spend SIDECAR: the durable spend-evidence record EVERY
 * BILLABLE fire leaves beside its artifact — on a spend-guard escalation AND on a clean
 * pass (`reason: null`). The installed `FireArtifactV1` deliberately redacts `usageRaw`
 * and persists only normalized token counts, so without this record the raw provider
 * token buckets the guard priced — and the price identity it judged under — would exist
 * nowhere durable after process loss. A clean pass needs that evidence too: the first
 * paid crossing's acceptance recomputes each attempt's conservative cost and checks for
 * a real nonzero reasoning-token observation, both of which live only in these buckets.
 * Known-zero (mock/fake) fires install no sidecar. (The symbol names retain the module's
 * escalation origin; the semantics are billable spend evidence generally.)
 *
 * Redaction contract: per-provider WHITELIST of token-count fields, copied ONLY when the
 * value is a finite number. No string, object, or unlisted field ever survives into the
 * sidecar, so no prompt/response content can leak through a hostile or malformed
 * `usageRaw`. A malformed token field is therefore ABSENT here; the attempt's
 * `spendClass`/`status` records that it could not be priced.
 *
 * The record binds to the exact installed artifact (cohort/fire/run/game identity +
 * `requestSha256`), carries every attempt's sent/received facts and redacted token
 * buckets (passing attempts included — recomputing the whole-fire verdict needs them),
 * and pins the guard's price version + digest and the per-attempt reservation it compared
 * against. It is a SEPARATE file — no artifact schema change.
 */

export const SPEND_SIDECAR_SCHEMA_VERSION = 1;

/** One attempt's spend evidence: identity, sent/received facts, redacted tokens, verdict. */
export interface SidecarAttemptRecord {
  readonly participantId: string;
  readonly provider: ProviderName;
  readonly requestedModelId: string;
  readonly role: 'initial' | 'repair';
  /** Sent fact: the request-start instant, `null` when the attempt was never sent. */
  readonly requestAt: string | null;
  /** Received/settled fact: the attempt-settled instant, `null` when nothing settled. */
  readonly responseAt: string | null;
  /** Token-count-only projection of the verbatim `usageRaw` (whitelisted finite numbers,
   *  dotted keys for nested buckets); `null` when no usage object was present. */
  readonly usageTokens: Readonly<Record<string, number>> | null;
  readonly spendClass: AttemptSpendClass;
  readonly status: 'pass' | 'breach' | 'unknown';
  /** The conservative derived-actual for a breach; `null` otherwise. */
  readonly derivedActualUsdMicros: number | null;
}

export interface SpendEscalationSidecarV1 {
  readonly sidecarSchemaVersion: number;
  readonly cohortId: string;
  readonly fireId: string;
  readonly runId: string;
  readonly gameId: string;
  readonly scopedMarkets: readonly MarketKey[];
  readonly requestSha256: string;
  /** The escalation reason, or `null` for a CLEAN billable pass (evidence, no escalation). */
  readonly reason: 'spend_attempt_over_reservation' | 'spend_evidence_unknown' | null;
  /** The price identity the guard judged under — version + recomputed table digest. */
  readonly priceVersion: string;
  readonly priceTableDigest: string;
  readonly perAttemptReservationUsdMicros: number;
  readonly attempts: readonly SidecarAttemptRecord[];
}

/** The exact per-provider token-count fields the conservative arithmetic reads (dotted =
 *  nested). Nothing outside this list is ever copied into a sidecar — and the offline
 *  pair verifier rejects any persisted key outside it (the same single source). */
export const TOKEN_FIELD_WHITELIST: Readonly<Record<ProviderName, readonly string[]>> = Object.freeze({
  // openai/xai carry BOTH the legacy chat-completions field names (old
  // evidence keeps verifying) and the Responses-API names the live adapters
  // report since provider web search moved them to /v1/responses.
  openai: Object.freeze([
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'completion_tokens_details.reasoning_tokens',
    'prompt_tokens_details.cached_tokens',
    'input_tokens',
    'output_tokens',
    'output_tokens_details.reasoning_tokens',
    'input_tokens_details.cached_tokens',
  ]),
  xai: Object.freeze([
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'completion_tokens_details.reasoning_tokens',
    'input_tokens',
    'output_tokens',
    'output_tokens_details.reasoning_tokens',
    // Search-billing evidence: successful web-search invocations (billed
    // per call) and the provider's own integer cost counter (10^10 ticks = $1).
    'server_side_tool_usage_details.web_search_calls',
    'cost_in_usd_ticks',
  ]),
  anthropic: Object.freeze([
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'output_tokens_details.thinking_tokens',
    // Search-billing evidence: executed searches (billed per search).
    'server_tool_use.web_search_requests',
  ]),
  google: Object.freeze([
    'promptTokenCount',
    'candidatesTokenCount',
    'thoughtsTokenCount',
    'totalTokenCount',
    'cachedContentTokenCount',
    // Search-result tokens injected as tool-use prompt input (grounding).
    'toolUsePromptTokenCount',
  ]),
});

/** Resolve one (possibly dotted) whitelist path via own-key lookups; non-object hops end it. */
function resolveTokenField(usage: Record<string, unknown>, path: string): unknown {
  let current: unknown = usage;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Token-count-only projection of a verbatim `usageRaw`. Copies ONLY whitelisted fields
 * whose value is a finite number; everything else — strings, objects, unlisted keys,
 * non-finite numbers — is dropped, never carried. `null` when `usageRaw` is not an object.
 */
export function redactUsageTokens(provider: ProviderName, usageRaw: unknown): Readonly<Record<string, number>> | null {
  if (typeof usageRaw !== 'object' || usageRaw === null || Array.isArray(usageRaw)) return null;
  const usage = usageRaw as Record<string, unknown>;
  const tokens: Record<string, number> = {};
  for (const field of TOKEN_FIELD_WHITELIST[provider]) {
    const value = resolveTokenField(usage, field);
    if (typeof value === 'number' && Number.isFinite(value)) tokens[field] = value;
  }
  return Object.freeze(tokens);
}

/**
 * Build the sidecar record for one BILLABLE fire, from the STILL-LIVE envelope results
 * (the only place `usageRaw` exists) and the guard's verdict — escalated (`reason` set)
 * or clean pass (`reason: null`, every attempt `pass`). Every attempt of every arm is
 * recorded — passing attempts included — so the whole-fire verdict is recomputable from
 * the durable record alone.
 */
export function buildSpendEscalationSidecar(input: {
  artifact: FireArtifactV1;
  results: readonly ArmGameResult[];
  billingClass: BillingClass;
  verdict: FireSpendVerdict;
  reason: 'spend_attempt_over_reservation' | 'spend_evidence_unknown' | null;
  priceVersion: string;
  priceTableDigest: string;
  perAttemptReservationUsdMicros: number;
}): SpendEscalationSidecarV1 {
  const attempts: SidecarAttemptRecord[] = [];
  for (const result of input.results) {
    const legs: ReadonlyArray<readonly ['initial' | 'repair', ArmGameResult['attempt'] | null]> = [
      ['initial', result.attempt],
      ['repair', result.repair],
    ];
    for (const [role, attempt] of legs) {
      if (attempt === null) continue;
      const offender =
        input.verdict.kind === 'pass'
          ? undefined
          : input.verdict.offenders.find(
              (o) => o.participantId === result.arm.participantId && o.role === role,
            );
      attempts.push(
        Object.freeze({
          participantId: result.arm.participantId,
          provider: result.arm.provider,
          requestedModelId: result.arm.requestedModelId,
          role,
          requestAt: attempt.requestAt,
          responseAt: attempt.responseAt,
          usageTokens: redactUsageTokens(result.arm.provider, attempt.usageRaw),
          spendClass: classifyAttemptSpend({
            billingClass: input.billingClass,
            requestAt: attempt.requestAt,
            usageRaw: attempt.usageRaw,
          }),
          status: offender?.status ?? 'pass',
          derivedActualUsdMicros: offender?.derivedActualUsdMicros ?? null,
        }),
      );
    }
  }
  return Object.freeze({
    sidecarSchemaVersion: SPEND_SIDECAR_SCHEMA_VERSION,
    cohortId: input.artifact.cohortId,
    fireId: input.artifact.fireId,
    runId: input.artifact.runId,
    gameId: input.artifact.gameId,
    scopedMarkets: Object.freeze([...input.artifact.scopedMarkets]),
    requestSha256: input.artifact.requestSha256,
    reason: input.reason,
    priceVersion: input.priceVersion,
    priceTableDigest: input.priceTableDigest,
    perAttemptReservationUsdMicros: input.perAttemptReservationUsdMicros,
    attempts: Object.freeze(attempts),
  });
}

/** Deterministic canonical bytes: the record is constructed in fixed key order, so a plain
 *  pretty-print is byte-stable across identical inputs (the exact-byte idempotent-install
 *  contract the sink enforces). */
export function serializeSpendEscalationSidecar(sidecar: SpendEscalationSidecarV1): string {
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

/** Lowercase sha256 hex of the serialized sidecar — the operator-report hash. */
export function spendEscalationSidecarSha256(sidecar: SpendEscalationSidecarV1): string {
  return createHash('sha256').update(serializeSpendEscalationSidecar(sidecar), 'utf8').digest('hex');
}
