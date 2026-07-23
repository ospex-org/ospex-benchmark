import { instantMs } from './time.js';
import type { ArmOutcome } from './types.js';

/**
 * Per-attempt timing provenance and its integrity checks
 * (SPEC-line-open-evidence-model.md §5). Pure and I/O-free: the scorer recomputes
 * these from the recorded attempt timestamps, so a fire whose attempts are
 * mis-ordered, mis-numbered, dispatched late, or that crosses a cutoff cannot pass
 * as clean.
 *
 * This is the TIMING/ORDERING half of §5 (cases 26 and 48): the attempt causal
 * order, the initial-only V-lag (`dispatch_lag_exceeded`), and the windowEnd /
 * first-pitch cutoff race. The richer arm provenance the digest binds — reported
 * model IDs, request/response digests, transport/usage — is assembled by the
 * fire-artifact slice; `AttemptTiming` is the subset these verifiers read.
 */

export type AttemptKind = 'initial' | 'repair';

/**
 * The timing an attempt carries for ordering / cutoff verification. Every instant
 * is an offset-qualified ISO-8601 string (benchmark-host clock); `acceptedAt` is
 * null when no response was accepted for that attempt.
 */
export interface AttemptTiming {
  attemptNumber: number;
  kind: AttemptKind;
  requestStartedAt: string;
  /**
   * When a provider response was RECEIVED — `null` for a timeout / transport
   * failure that settled without an HTTP response. Distinct from the attempt's
   * settled instant: the mapper derives receipt only when a response body or
   * HTTP status is present, else `null`.
   */
  requestReceivedAt: string | null;
  acceptedAt: string | null;
}

/** Parse an instant to ms, pushing a violation (and returning undefined) instead
 *  of throwing, so an integrity check can accumulate every problem at once. */
function safeMs(label: string, iso: string, violations: string[]): number | undefined {
  try {
    return instantMs(iso);
  } catch {
    violations.push(`${label} is not a valid offset-qualified instant: "${iso}"`);
    return undefined;
  }
}

/**
 * Verify per-attempt and cross-attempt ordering integrity (§5, case 48). Returns a
 * violations array (empty = clean):
 * - every `kind` is exactly `initial` or `repair` (not trusted from the TS union —
 *   the persisted sequence is re-validated at runtime);
 * - the FIRST (lowest-ordered) attempt is the sole `initial`; every later attempt is
 *   a repair;
 * - at most `maxRepairAttemptsPerArm` repairs (Tier-0 pins 1) — an explicit,
 *   validated cap the scorer sources from the frozen manifest so it cannot drift;
 * - attempt numbers are safe positive integers, unique and strictly increasing;
 * - per attempt `requestStartedAt <= requestReceivedAt <= acceptedAt` (the
 *   `acceptedAt` bound only when present);
 * - the fire's `initialRequestStartedAt` equals the initial attempt's own
 *   `requestStartedAt` (so the scorer never applies the initial V-lag to a repair);
 * - each repair's `requestStartedAt >= the initial's requestReceivedAt`.
 */
export function verifyAttemptOrdering(
  attempts: readonly AttemptTiming[],
  initialRequestStartedAt: string,
  maxRepairAttemptsPerArm: number,
): string[] {
  if (!Number.isSafeInteger(maxRepairAttemptsPerArm) || maxRepairAttemptsPerArm < 0) {
    throw new Error(`maxRepairAttemptsPerArm must be a safe nonnegative integer, got ${String(maxRepairAttemptsPerArm)}`);
  }
  const violations: string[] = [];
  if (attempts.length === 0) {
    violations.push('no attempts recorded for the arm');
    return violations;
  }

  // Every kind must be a known value (do not trust the TS union at runtime).
  for (const attempt of attempts) {
    if (attempt.kind !== 'initial' && attempt.kind !== 'repair') {
      violations.push(`attempt ${String(attempt.attemptNumber)}: unknown kind ${JSON.stringify(attempt.kind)}`);
    }
  }

  const initials = attempts.filter((a) => a.kind === 'initial');
  if (initials.length !== 1) {
    violations.push(`expected exactly one initial attempt, found ${initials.length}`);
  }
  // The first (lowest-ordered) attempt must be the sole initial; every later attempt
  // a repair — a repair listed/numbered before the initial is not a valid history.
  const firstAttempt = attempts[0];
  if (firstAttempt !== undefined && firstAttempt.kind !== 'initial') {
    violations.push('the first attempt must be the initial');
  }
  for (const attempt of attempts.slice(1)) {
    if (attempt.kind === 'initial') {
      violations.push(`attempt ${String(attempt.attemptNumber)}: a second initial after the first attempt`);
    }
  }
  const repairCount = attempts.filter((a) => a.kind === 'repair').length;
  if (repairCount > maxRepairAttemptsPerArm) {
    violations.push(`too many repair attempts: ${repairCount} > maxRepairAttemptsPerArm ${maxRepairAttemptsPerArm}`);
  }

  // Parse every timestamp ONCE (a malformed field yields exactly one violation),
  // then run the ordering checks off the parsed values.
  const parsed = attempts.map((attempt) => ({
    attempt,
    startedMs: safeMs(`attempt ${attempt.attemptNumber} requestStartedAt`, attempt.requestStartedAt, violations),
    receivedMs:
      attempt.requestReceivedAt === null
        ? null
        : safeMs(`attempt ${attempt.attemptNumber} requestReceivedAt`, attempt.requestReceivedAt, violations),
    acceptedMs:
      attempt.acceptedAt === null
        ? null
        : safeMs(`attempt ${attempt.attemptNumber} acceptedAt`, attempt.acceptedAt, violations),
  }));

  // Attempt numbers: safe positive integers, strictly increasing in array order.
  let previousNumber: number | undefined;
  for (const { attempt } of parsed) {
    if (!Number.isSafeInteger(attempt.attemptNumber) || attempt.attemptNumber < 1) {
      violations.push(`attempt number must be a safe positive integer, got ${String(attempt.attemptNumber)}`);
    } else {
      if (previousNumber !== undefined && attempt.attemptNumber <= previousNumber) {
        violations.push(
          `attempt numbers must be strictly increasing (${attempt.attemptNumber} after ${previousNumber})`,
        );
      }
      previousNumber = attempt.attemptNumber;
    }
  }

  // Causal order within each attempt: started <= received <= accepted (each
  // bound only when present; a timeout/transport attempt has no receipt).
  for (const p of parsed) {
    if (p.startedMs !== undefined && p.receivedMs != null && p.startedMs > p.receivedMs) {
      violations.push(`attempt ${p.attempt.attemptNumber}: requestStartedAt is after requestReceivedAt`);
    }
    if (p.receivedMs != null && p.acceptedMs != null && p.receivedMs > p.acceptedMs) {
      violations.push(`attempt ${p.attempt.attemptNumber}: requestReceivedAt is after acceptedAt`);
    }
    // An accepted attempt must have received a response: acceptedAt without a
    // requestReceivedAt is an impossible provenance.
    if (p.attempt.acceptedAt !== null && p.attempt.requestReceivedAt === null) {
      violations.push(`attempt ${p.attempt.attemptNumber}: acceptedAt present without a requestReceivedAt`);
    }
  }

  const initial = initials[0];
  if (initial !== undefined) {
    if (initial.requestStartedAt !== initialRequestStartedAt) {
      violations.push("fire initialRequestStartedAt must equal the initial attempt's requestStartedAt");
    }
    // A repair is causally downstream of the initial's RESPONSE — it needs the
    // initial body to build the decision fingerprint it must preserve — so a
    // repair cannot legitimately exist when the initial never received a
    // response. That timeline is impossible; fail closed on it.
    if (repairCount > 0 && initial.requestReceivedAt === null) {
      violations.push('repair attempt present without an initial requestReceivedAt');
    }
    // Each repair must start no earlier than the initial's response was received
    // (checked only when the initial actually received one).
    const initialReceivedMs = parsed.find((p) => p.attempt === initial)?.receivedMs;
    for (const p of parsed) {
      if (p.attempt.kind !== 'repair') continue;
      if (initialReceivedMs != null && p.startedMs !== undefined && p.startedMs < initialReceivedMs) {
        violations.push(`repair ${p.attempt.attemptNumber}: requestStartedAt is before the initial's requestReceivedAt`);
      }
    }
  }

  return violations;
}

export type DispatchLagVerdict = 'ok' | 'dispatch_lag_exceeded';

/**
 * The initial-only dispatch V-lag (§5): `0 <= initialRequestStartedAt - detectedAt
 * <= maxDispatchLagMs` (both operands benchmark-host, no skew). A violation means
 * the initial request would start too late — it is NOT sent, and the arm outcome is
 * `dispatch_lag_exceeded`. Applies to the INITIAL request only; a repair is never
 * tested against it. Throws on a malformed instant or a non-safe-integer cap.
 */
export function dispatchLagVerdict(input: {
  detectedAt: string;
  initialRequestStartedAt: string;
  maxDispatchLagMs: number;
}): DispatchLagVerdict {
  const { detectedAt, initialRequestStartedAt, maxDispatchLagMs } = input;
  if (!Number.isSafeInteger(maxDispatchLagMs) || maxDispatchLagMs < 0) {
    throw new Error(`maxDispatchLagMs must be a safe nonnegative integer, got ${String(maxDispatchLagMs)}`);
  }
  const lag = instantMs(initialRequestStartedAt) - instantMs(detectedAt);
  return lag < 0 || lag > maxDispatchLagMs ? 'dispatch_lag_exceeded' : 'ok';
}

export type InitialDispatchGateVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly outcome: 'cutoff_missed' | 'dispatch_lag_exceeded' };

/**
 * The SEND-TIME gate on the INITIAL request only (§5): given the reading captured immediately
 * before the initial send (`initialRequestStartedAt`), decide whether that request may be sent
 * or must be refused with a valid-negative outcome. It composes the three timing bounds a
 * doomed initial can violate, in the FROZEN precedence:
 *
 *   first-pitch  ≻  windowEnd  ≻  V-lag
 *
 * - first-pitch (§5): the request must start strictly before `scheduledAtAtFire`; at/after is
 *   `cutoff_missed` (this bound binds every request, so it is checked first);
 * - windowEnd (§5): the INITIAL request must start strictly before `windowEnd`; at/after is
 *   `cutoff_missed` (an already-claimed initial unsent at/after windowEnd is `cutoff_missed`, not
 *   `dispatch_lag_exceeded`, so windowEnd outranks V-lag);
 * - V-lag (§5): `0 <= initialRequestStartedAt - detectedAt <= maxDispatchLagMs`, two-sided
 *   (a backdated start `< detectedAt` MUST fail); a violation is `dispatch_lag_exceeded`.
 *
 * Every operand is parsed/validated UP FRONT — before any branch — so a malformed lower-precedence
 * field (or a non-safe/negative cap) throws rather than being hidden by a higher-precedence branch
 * short-circuiting. `instantMs`/`dispatchLagVerdict` fail closed on a malformed instant or cap.
 * Start-only: this gates the INITIAL request; a repair is never tested against it.
 */
export function initialDispatchGate(input: {
  detectedAt: string;
  windowEnd: string;
  scheduledAtAtFire: string;
  initialRequestStartedAt: string;
  maxDispatchLagMs: number;
}): InitialDispatchGateVerdict {
  // Parse/capture EVERY operand up front — a malformed lower-precedence field must NOT be hidden
  // by a higher-precedence branch short-circuiting (any throws here fail closed before branching).
  const startMs = instantMs(input.initialRequestStartedAt);
  const firstPitchMs = instantMs(input.scheduledAtAtFire);
  const windowEndMs = instantMs(input.windowEnd);
  const lagVerdict = dispatchLagVerdict({
    detectedAt: input.detectedAt,
    initialRequestStartedAt: input.initialRequestStartedAt,
    maxDispatchLagMs: input.maxDispatchLagMs,
  });
  // Frozen precedence: first-pitch > windowEnd > V-lag. The first two both yield cutoff_missed.
  if (startMs >= firstPitchMs) return { ok: false, outcome: 'cutoff_missed' };
  if (startMs >= windowEndMs) return { ok: false, outcome: 'cutoff_missed' };
  if (lagVerdict === 'dispatch_lag_exceeded') return { ok: false, outcome: 'dispatch_lag_exceeded' };
  return { ok: true };
}

/** The persisted operands a scorer independently re-derives the SEND-TIME initial-gate verdict from
 *  (B3): three from the fire artifact (`detectedAt`, `initialRequestStartedAt`, `scheduledAtAtFire`)
 *  and two from the cohortId-bound published manifest (`windowEnd`, `maxDispatchLagMs`). The record's
 *  claimed terminal is carried for CONTEXT only — it must never enter the re-derivation. */
export interface InitialGateRecomputeInput {
  readonly detectedAt: string;
  readonly initialRequestStartedAt: string;
  readonly scheduledAtAtFire: string;
  readonly windowEnd: string;
  readonly maxDispatchLagMs: number;
  /**
   * The record's CLAIMED terminal outcome — carried for context ONLY, so this stays a drop-in for
   * the scorer's recompute-and-compare. It is DELIBERATELY not read: a scorer that trusted it would
   * mis-read a SENT `cutoff_missed` (crossed at LATER acceptance timing, non-empty attempts) as an
   * initial-gate refusal. The verdict is re-derived PURELY from the timing operands above.
   */
  readonly recordedTerminalOutcome: ArmOutcome;
}

/**
 * Independently RE-DERIVE the send-time initial-dispatch gate verdict from the persisted operands
 * ALONE (B3), for the scorer's verification. It reuses `initialDispatchGate` on the timing operands
 * and NEVER reads `recordedTerminalOutcome`.
 *
 * The load-bearing semantics: for a SENT arm the persisted `initialRequestStartedAt` is the real
 * send time, so this returns `ok` EVEN when the arm's terminal outcome is `cutoff_missed` — that
 * terminal came from LATER response/accept timing, not an initial refusal. A never-sent gate refusal
 * (`cutoff_missed` via the initial gate, or `dispatch_lag_exceeded`) instead carries the refused
 * reading as `initialRequestStartedAt`, so this re-derives the same non-`ok` verdict. It therefore
 * never equates a terminal `cutoff_missed` with an initial gate refusal. Throws (fail-closed) on a
 * malformed operand or cap, exactly like `initialDispatchGate`.
 */
export function recomputeInitialDispatchGate(input: InitialGateRecomputeInput): InitialDispatchGateVerdict {
  return initialDispatchGate({
    detectedAt: input.detectedAt,
    windowEnd: input.windowEnd,
    scheduledAtAtFire: input.scheduledAtAtFire,
    initialRequestStartedAt: input.initialRequestStartedAt,
    maxDispatchLagMs: input.maxDispatchLagMs,
  });
}

/**
 * The cutoff race (§5, case 26). Returns violations (each => `cutoff_missed`):
 * - the INITIAL request must start strictly before `windowEnd` (a repair may cross
 *   windowEnd; only first pitch bounds a repair, so windowEnd is not checked against
 *   repairs);
 * - NO request — initial or repair — may start at/after first pitch
 *   (`scheduledAtAtFire`), NO response may be RECEIVED at/after first pitch, and NO
 *   response may be ACCEPTED at/after first pitch. First pitch (not windowEnd) is the
 *   hard cutoff for a response's receipt: a repair received after windowEnd but
 *   before first pitch is fine, but a receipt at/after first pitch is a crossing even
 *   when `acceptedAt` is null (the runtime correctly refused to accept it).
 *
 * `initialRequestStartedAt` is null only for a PRE-CLOCK refusal that never took a reading (e.g.
 * `credential_missing`). A never-sent SEND-TIME gate refusal instead carries the exact reading it
 * compared (B3), so its persisted `initialRequestStartedAt` is NON-null and — for a windowEnd
 * crossing — is legitimately flagged here (its V-lag lateness stays `dispatchLagVerdict`'s domain).
 */
export function cutoffViolations(input: {
  windowEnd: string;
  scheduledAtAtFire: string;
  initialRequestStartedAt: string | null;
  attempts: readonly AttemptTiming[];
}): string[] {
  const violations: string[] = [];
  const { windowEnd, scheduledAtAtFire, initialRequestStartedAt, attempts } = input;
  const windowEndMs = safeMs('windowEnd', windowEnd, violations);
  const firstPitchMs = safeMs('scheduledAtAtFire', scheduledAtAtFire, violations);

  if (initialRequestStartedAt !== null) {
    const initialMs = safeMs('initialRequestStartedAt', initialRequestStartedAt, violations);
    if (initialMs !== undefined && windowEndMs !== undefined && initialMs >= windowEndMs) {
      violations.push('initial request started at/after windowEnd');
    }
  }

  for (const attempt of attempts) {
    const startedMs = safeMs(`attempt ${attempt.attemptNumber} requestStartedAt`, attempt.requestStartedAt, violations);
    if (startedMs !== undefined && firstPitchMs !== undefined && startedMs >= firstPitchMs) {
      violations.push(`${attempt.kind} request (attempt ${attempt.attemptNumber}) started at/after first pitch`);
    }
    if (attempt.requestReceivedAt !== null) {
      const receivedMs = safeMs(`attempt ${attempt.attemptNumber} requestReceivedAt`, attempt.requestReceivedAt, violations);
      if (receivedMs !== undefined && firstPitchMs !== undefined && receivedMs >= firstPitchMs) {
        violations.push(`${attempt.kind} response (attempt ${attempt.attemptNumber}) received at/after first pitch`);
      }
    }
    if (attempt.acceptedAt !== null) {
      const acceptedMs = safeMs(`attempt ${attempt.attemptNumber} acceptedAt`, attempt.acceptedAt, violations);
      if (acceptedMs !== undefined && firstPitchMs !== undefined && acceptedMs >= firstPitchMs) {
        violations.push(`${attempt.kind} response (attempt ${attempt.attemptNumber}) accepted at/after first pitch`);
      }
    }
  }

  return violations;
}
