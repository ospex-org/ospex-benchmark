import { instantMs } from './time.js';

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
  requestReceivedAt: string;
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
    receivedMs: safeMs(`attempt ${attempt.attemptNumber} requestReceivedAt`, attempt.requestReceivedAt, violations),
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

  // Causal order within each attempt: started <= received <= accepted (if present).
  for (const p of parsed) {
    if (p.startedMs !== undefined && p.receivedMs !== undefined && p.startedMs > p.receivedMs) {
      violations.push(`attempt ${p.attempt.attemptNumber}: requestStartedAt is after requestReceivedAt`);
    }
    if (p.receivedMs !== undefined && p.acceptedMs != null && p.receivedMs > p.acceptedMs) {
      violations.push(`attempt ${p.attempt.attemptNumber}: requestReceivedAt is after acceptedAt`);
    }
  }

  const initial = initials[0];
  if (initial !== undefined) {
    if (initial.requestStartedAt !== initialRequestStartedAt) {
      violations.push("fire initialRequestStartedAt must equal the initial attempt's requestStartedAt");
    }
    // Each repair must start no earlier than the initial's response was received.
    const initialReceivedMs = parsed.find((p) => p.attempt === initial)?.receivedMs;
    for (const p of parsed) {
      if (p.attempt.kind !== 'repair') continue;
      if (initialReceivedMs !== undefined && p.startedMs !== undefined && p.startedMs < initialReceivedMs) {
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
 * `initialRequestStartedAt` is null when the initial was never sent (its lateness is
 * a `dispatch_lag_exceeded`, handled by `dispatchLagVerdict`, not here).
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
    const receivedMs = safeMs(`attempt ${attempt.attemptNumber} requestReceivedAt`, attempt.requestReceivedAt, violations);
    if (receivedMs !== undefined && firstPitchMs !== undefined && receivedMs >= firstPitchMs) {
      violations.push(`${attempt.kind} response (attempt ${attempt.attemptNumber}) received at/after first pitch`);
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
