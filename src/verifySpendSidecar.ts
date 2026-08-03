import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { printError, printLine } from './console.js';
import { ConservativeSpendUnknownError, deriveConservativeActualUsdMicros } from './conservativeSpend.js';
import { CROSSING_PROFILE } from './crossingProfile.js';
import { SPEND_GUARD_PRICE_TABLE_VERSION, modelPriceTableDigest } from './modelPriceTable.js';
import { SPEND_SIDECAR_SCHEMA_VERSION } from './spendEscalationSidecar.js';
import { PROVIDER_ATTEMPT_RESERVATION_USD_MICROS } from './spendReservationPolicy.js';
import type { SpendEscalationSidecarV1 } from './spendEscalationSidecar.js';
import type { ProviderName } from './types.js';

/**
 * The DETERMINISTIC OFFLINE spend-sidecar verifier — the tool the attended-crossing
 * runbook's acceptance names for its spend recomputation (`yarn verify:sidecar <path>`).
 * It reads an installed `*-spend.json` sidecar and INDEPENDENTLY recomputes every
 * attempt's conservative cost with the exact integer ceiling arithmetic the runtime
 * guard uses (`deriveConservativeActualUsdMicros` — the same code, not a re-derivation),
 * at the CODE-pinned conservative price table. It never trusts the record's own claims:
 * the price identity is recomputed from the running code, the reservation is compared to
 * the code-owned policy amount, and each attempt's recorded status/derived value must
 * agree with the recomputation.
 *
 * Named checks (ALL must pass for the verifier to pass):
 *   - `shape`                — strict record shape (exact keys, types, schema version 1).
 *   - `price-identity`       — the record prices at the code's conservative guard table
 *                              (version AND recomputed digest).
 *   - `reservation-pin`      — the record's per-attempt reservation equals the code policy.
 *   - `attempts-priceable`   — every SENT attempt's cost recomputes (an UNKNOWN fails —
 *                              a coherent never-sent attempt, `spendClass 'zero'` with no
 *                              request instant and no usage, is exempt: nothing billed).
 *   - `attempts-within-reservation` — every recomputed cost ≤ the reservation (strictly
 *                              greater fails; exact equality passes).
 *   - `aggregate-within-crossing-cap` — the summed cost ≤ the pinned crossing spend cap.
 *   - `record-consistency`   — the record's own per-attempt status/derived agree with the
 *                              recomputation (a tampered or incoherent record fails).
 *   - `reasoning-observed`   — at least one attempt shows a real nonzero reasoning-token
 *                              field (OpenAI/xAI `completion_tokens_details.reasoning_tokens`
 *                              or Google `thoughtsTokenCount`).
 *
 * Pure core (`verifySpendSidecar`) + a thin CLI. This is a post-hoc EVIDENCE verifier: it
 * gates nothing at runtime; the crossing operator runs it against the durable record and
 * the acceptance requires its PASS.
 */

const RECORD_KEYS = [
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

/** The raw-bucket fields that count as a REASONING observation (dotted = nested). */
const REASONING_FIELDS: readonly string[] = ['completion_tokens_details.reasoning_tokens', 'thoughtsTokenCount'];

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
function isTokenMap(v: unknown): v is Record<string, number> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n));
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): string | null {
  const keys = Object.keys(value).sort();
  const want = [...expected].sort();
  if (keys.length === want.length && keys.every((k, i) => k === want[i])) return null;
  return `keys [${keys.join(', ')}] != expected [${want.join(', ')}]`;
}

/** Strict structural parse; throws a descriptive Error on ANY violation. */
function parseSidecarRecord(raw: unknown): SpendEscalationSidecarV1 {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('sidecar is not a plain object');
  }
  const record = raw as Record<string, unknown>;
  const keyIssue = exactKeys(record, RECORD_KEYS);
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
      if (v !== null && !isNonEmptyString(v)) throw new Error(`attempts[${index}].${field} must be a string or null`);
    }
    if (attempt['usageTokens'] !== null && !isTokenMap(attempt['usageTokens'])) {
      throw new Error(`attempts[${index}].usageTokens must be a finite-number map or null`);
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

/** Rebuild a nested usageRaw-shaped object from the sidecar's dotted token paths. */
export function rebuildUsageRaw(tokens: Readonly<Record<string, number>>): Record<string, unknown> {
  const usage: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(tokens)) {
    const segments = path.split('.');
    let current = usage;
    for (const segment of segments.slice(0, -1)) {
      const next = current[segment];
      if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
        current = next as Record<string, unknown>;
      } else {
        const created: Record<string, unknown> = {};
        current[segment] = created;
        current = created;
      }
    }
    current[segments[segments.length - 1]!] = value;
  }
  return usage;
}

/**
 * Verify one parsed sidecar record. See the module header for the named checks; every
 * check must pass for `ok`. Pure — no filesystem, no clock.
 */
export function verifySpendSidecar(raw: unknown): SidecarVerification {
  let record: SpendEscalationSidecarV1;
  try {
    record = parseSidecarRecord(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { checks: [{ name: 'shape', ok: false, detail }], attempts: [], aggregateUsdMicros: null, ok: false };
  }
  const checks: SidecarCheck[] = [{ name: 'shape', ok: true, detail: 'strict record shape holds' }];

  // Price identity: recomputed from the RUNNING CODE, never trusted from the record.
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

  // Per-attempt recomputation with the SAME arithmetic the runtime guard uses, at the
  // CODE-pinned conservative version (fail-closed even if the record lied about its own).
  const attempts: VerifiedAttempt[] = [];
  const consistencyIssues: string[] = [];
  for (const attempt of record.attempts) {
    const neverSent = attempt.requestAt === null && attempt.usageTokens === null && attempt.spendClass === 'zero';
    let derived: number | null = null;
    let unpriced: VerifiedAttempt['unpriced'] = null;
    if (neverSent) {
      unpriced = 'never-sent';
    } else if (attempt.usageTokens === null) {
      unpriced = 'sent with no usage buckets — UNKNOWN';
    } else {
      try {
        derived = deriveConservativeActualUsdMicros({
          provider: attempt.provider,
          requestedModelId: attempt.requestedModelId,
          priceVersion: SPEND_GUARD_PRICE_TABLE_VERSION,
          usageRaw: rebuildUsageRaw(attempt.usageTokens),
        });
      } catch (error) {
        if (!(error instanceof ConservativeSpendUnknownError)) throw error;
        unpriced = error.message;
      }
    }
    const withinReservation = derived === null ? null : derived <= record.perAttemptReservationUsdMicros;

    let reasoningObservation: VerifiedAttempt['reasoningObservation'] = null;
    if (attempt.usageTokens !== null) {
      for (const field of REASONING_FIELDS) {
        const tokens = attempt.usageTokens[field];
        if (typeof tokens === 'number' && tokens > 0) {
          reasoningObservation = { field, tokens };
          break;
        }
      }
    }

    // Record consistency: the durable record's own claims must agree with the recomputation.
    const who = `${attempt.participantId}/${attempt.role}`;
    if (derived !== null) {
      const recomputedStatus = derived > record.perAttemptReservationUsdMicros ? 'breach' : 'pass';
      if (attempt.status !== recomputedStatus) {
        consistencyIssues.push(`${who}: recorded status ${attempt.status} != recomputed ${recomputedStatus}`);
      }
      if (recomputedStatus === 'breach' && attempt.derivedActualUsdMicros !== derived) {
        consistencyIssues.push(
          `${who}: recorded derivedActualUsdMicros ${String(attempt.derivedActualUsdMicros)} != recomputed ${derived}`,
        );
      }
    } else if (unpriced !== 'never-sent' && attempt.status === 'pass') {
      consistencyIssues.push(`${who}: recorded status pass but the attempt does not recompute (${String(unpriced)})`);
    }
    if (attempt.spendClass === 'known_zero') {
      consistencyIssues.push(`${who}: spendClass known_zero inside a billable spend sidecar is incoherent`);
    }

    attempts.push(
      Object.freeze({
        participantId: attempt.participantId,
        provider: attempt.provider,
        requestedModelId: attempt.requestedModelId,
        role: attempt.role,
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
    detail: consistencyIssues.length === 0 ? 'recorded statuses agree with the recomputation' : consistencyIssues.join('; '),
  });

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

const USAGE = `Usage: yarn verify:sidecar <path-to-fire-...-spend.json>

Reads an installed spend sidecar and independently recomputes every attempt's
conservative cost with the exact runtime arithmetic at the code-pinned
conservative price table. Exit 0 IFF every named check passes.`;

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(6)}`;
}

function main(argv: string[]): number {
  if (argv.length !== 1 || argv[0] === '-h' || argv[0] === '--help') {
    printLine(USAGE);
    return argv.length === 1 ? 0 : 2;
  }
  const path = argv[0]!;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    printError(`could not read/parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const verification = verifySpendSidecar(raw);

  printLine(`spend sidecar verification — ${path}`);
  const record = raw as Partial<SpendEscalationSidecarV1>;
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
