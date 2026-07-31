import { instantMs } from './time.js';

/**
 * Timing evidence for one captured close, parsed ONCE from the raw row and
 * shared by every consumer that judges it: the scorer (`clv.ts`), the
 * close-schedule audit builder, and the audit artifact READER.
 *
 * Why a shared primitive rather than a comparison at each site: before this,
 * three call sites judged the same four fields three different ways — the
 * scorer read a supplied `pollGapSeconds`, the audit builder re-derived with
 * bare `Date.parse`, and the reader trusted the serialized verdict. A row could
 * therefore be `close_after_start` to one and clean to another. One parse, one
 * verdict, every consumer.
 *
 * Two rules this module exists to enforce:
 *
 * 1. **Every compared instant is parsed strictly.** `instantMs` rejects a
 *    timestamp with no explicit offset; bare `Date.parse` reads one as LOCAL
 *    time, so the same row scored on a UTC host and a US-Eastern host produced
 *    drifts four hours apart and flipped `scheduleChanged`. The live corpus is
 *    uniformly offset-qualified, so that was a latent fail-open riding on
 *    upstream formatting — not a firing bug, and not one to leave armed.
 *
 * 2. **A verdict is never read off unvalidated evidence.** `pollGapSeconds` is
 *    a stored derived value; a row whose gap contradicts its own `lock_time`
 *    and `last_polled_at` is not evidence of anything. Such a row becomes
 *    `unusable` — a typed, counted, published refusal — never a `false` that a
 *    caller reads as "fine". Consistent with the bounded-helper rule used
 *    across this project: a check that cannot reach a definitive answer returns
 *    a typed UNKNOWN, never a sentinel.
 */

/**
 * Slack allowed when corroborating the stored `poll_gap_seconds` against the
 * raw instants, and when classifying a POST-LOCK POLL from them.
 *
 * Scope note: this tolerance applies ONLY to the two quantities derived from
 * `poll_gap_seconds`. It deliberately does NOT apply to `value_captured_at`,
 * which is a direct timestamp with no integer-second quantisation — see
 * {@link closeValueAfterLock}, which is strict.
 *
 * Sized from the corpus, not guessed. `poll_gap_seconds` is stored at
 * INTEGER-SECOND granularity, so a poll a few hundred milliseconds after lock
 * rounds to `0` and the legacy `gap < 0` test calls it clean. Measured over all
 * 3609 captured closes (2026-07-30):
 *
 * - max coherence residual `|gap*1000 - (lock - lastPolled)|` is exactly 500 ms
 *   (p99 494 ms); no row exceeds 1000 ms.
 * - rows the legacy test refuses sit at `lastPolled - lock >= 260896 ms`; rows
 *   it calls clean sit at `<= 467 ms`. Any threshold in [467, 260896) leaves
 *   the published verdict partition byte-identical.
 *
 * 1000 ms is 2x the observed clean maximum and 260x below the refused minimum,
 * so it absorbs second-granularity rounding without reclassifying a single row.
 * Widening it past ~260 s would start excusing genuinely post-lock polls.
 */
export const POLL_GAP_COHERENCE_TOLERANCE_MS = 1000;

/**
 * The raw timing fields as they arrive from `closing_lines`, plus the row's
 * freshness class.
 *
 * `confidence` is here rather than in a wrapper because what counts as
 * COMPLETE timing evidence depends on it, and the scorer and the audit must
 * agree on that. A `fresh` row is one the capture claims to have observed at a
 * known instant, so it must actually carry those instants; a `stale` or
 * `missing` row is already refused upstream on its own reason and is not
 * required to.
 */
export interface RawCloseTiming {
  lockTime: string;
  valueCapturedAt: string | null;
  lastPolledAt: string | null;
  pollGapSeconds: number | null;
  confidence: 'fresh' | 'stale' | 'missing';
}

/**
 * Parsed timing, or a typed refusal carrying every reason at once.
 *
 * `unusable` is deliberately NOT a boolean flag on a usable shape: making it a
 * separate variant means a consumer cannot reach `lockMs` without first
 * handling the refusal, so "judged an unparseable row" becomes a type error
 * rather than a silent `NaN` comparison that evaluates false.
 */
export type CloseTiming =
  | {
      kind: 'usable';
      lockMs: number;
      /** null when the field was null upstream — absent, not unreadable. */
      valueCapturedMs: number | null;
      lastPolledMs: number | null;
    }
  | { kind: 'unusable'; violations: readonly string[] };

/** Parse one instant, accumulating a violation instead of throwing — mirrors
 *  `attemptProvenance.safeMs` so the two integrity checks read alike. */
function parseField(
  label: string,
  iso: string | null,
  violations: string[],
): number | null | undefined {
  if (iso === null) return null;
  try {
    return instantMs(iso);
  } catch {
    violations.push(`${label} is not a valid offset-qualified instant: "${iso}"`);
    return undefined;
  }
}

/**
 * Validate and parse a close's timing evidence.
 *
 * Violations, all accumulated (a row reports every problem at once rather than
 * the first):
 * - `lockTime` unparseable — the cutoff every other comparison is relative to;
 * - `valueCapturedAt` / `lastPolledAt` present but unparseable;
 * - `pollGapSeconds` present but not finite;
 * - `pollGapSeconds` present while `lastPolledAt` is null — a gap with nothing
 *   to corroborate it against;
 * - `pollGapSeconds` disagrees with `lockTime - lastPolledAt` by more than
 *   {@link POLL_GAP_COHERENCE_TOLERANCE_MS}.
 *
 * A `fresh` row must additionally carry ALL THREE of `valueCapturedAt`,
 * `lastPolledAt` and `pollGapSeconds`. `fresh` is a claim that the capture
 * observed this market at a known instant, so a fresh row missing the instants
 * that claim rests on is not evidence of anything.
 *
 * This used to be permitted, on the reasoning that a row with no timing would
 * be downgraded upstream to `close_stale` anyway. Nothing verified that
 * assumption, and a fresh row with null poll timing scored a full CLV with
 * `unscoredReason: null` — fail-open on exactly the evidence these gates exist
 * to judge. A `stale` or `missing` row is still NOT required to carry them:
 * it is already refused on its own reason, which runs first, and demanding
 * them here would double-count one refusal under a second name.
 */
export function closeTiming(raw: RawCloseTiming): CloseTiming {
  const violations: string[] = [];

  if (raw.confidence === 'fresh') {
    const absent = (
      [
        ['value_captured_at', raw.valueCapturedAt],
        ['last_polled_at', raw.lastPolledAt],
        ['poll_gap_seconds', raw.pollGapSeconds],
      ] as const
    )
      .filter(([, value]) => value === null)
      .map(([name]) => name);
    if (absent.length > 0) {
      violations.push(
        `a fresh close must carry complete timing evidence, but ${absent.join(', ')} ` +
          `${absent.length === 1 ? 'is' : 'are'} null`,
      );
    }
  }

  const lockMs = parseField('lock_time', raw.lockTime, violations);
  const valueCapturedMs = parseField('value_captured_at', raw.valueCapturedAt, violations);
  const lastPolledMs = parseField('last_polled_at', raw.lastPolledAt, violations);

  if (raw.pollGapSeconds !== null) {
    if (!Number.isFinite(raw.pollGapSeconds)) {
      violations.push(`poll_gap_seconds is not a finite number: ${String(raw.pollGapSeconds)}`);
    } else if (raw.lastPolledAt === null) {
      violations.push(
        `poll_gap_seconds is ${raw.pollGapSeconds} but last_polled_at is null — ` +
          'the stored gap cannot be corroborated against any instant',
      );
    } else if (typeof lockMs === 'number' && typeof lastPolledMs === 'number') {
      const residual = Math.abs(raw.pollGapSeconds * 1000 - (lockMs - lastPolledMs));
      if (residual > POLL_GAP_COHERENCE_TOLERANCE_MS) {
        violations.push(
          `poll_gap_seconds (${raw.pollGapSeconds}s) disagrees with lock_time - last_polled_at ` +
            `by ${residual}ms, beyond the ${POLL_GAP_COHERENCE_TOLERANCE_MS}ms tolerance`,
        );
      }
    }
  }

  if (violations.length > 0) return { kind: 'unusable', violations };

  // Non-null by construction: `lockTime` is a non-nullable string, so
  // `parseField` returned either a number or pushed a violation and we
  // returned above.
  return {
    kind: 'usable',
    lockMs: lockMs as number,
    valueCapturedMs: valueCapturedMs as number | null,
    lastPolledMs: lastPolledMs as number | null,
  };
}

/** Guard shared by both verdicts: refuse to answer from unusable evidence.
 *  Throwing (rather than returning false) is the point — a call site that
 *  forgot to classify first fails loudly instead of publishing a clean verdict
 *  it never established. */
function requireUsable(
  timing: CloseTiming,
  caller: string,
): Extract<CloseTiming, { kind: 'usable' }> {
  if (timing.kind === 'unusable') {
    throw new Error(
      `${caller} called on unusable timing evidence — classify close_timing_unusable first ` +
        `(violations: ${timing.violations.join('; ')})`,
    );
  }
  return timing;
}

/**
 * Was the feed still quoting this market AFTER the row's own recorded lock?
 *
 * Derived from the raw instants, not from the stored gap: a forged or stale
 * `poll_gap_seconds` used to decide this on its own, so a row whose
 * `last_polled_at` sat hours past its lock scored clean if the gap said so.
 *
 * A null `lastPolledMs` is NOT a refusal — the market was never seen in the
 * snapshot at all, which `close_stale` already covers.
 */
export function closeAfterStart(timing: CloseTiming): boolean {
  const t = requireUsable(timing, 'closeAfterStart');
  if (t.lastPolledMs === null) return false;
  // `>=`, not `>`: a stored gap of -1s is a full second past lock and the
  // legacy `gap < 0` predicate refused it, so the boundary stays where it was.
  // The tolerance absorbs only SUB-second rounding — the 22 corpus rows whose
  // poll lands 5-467ms after lock and rounds to a stored gap of 0.
  return t.lastPolledMs - t.lockMs >= POLL_GAP_COHERENCE_TOLERANCE_MS;
}

/**
 * Was the quoted VALUE captured after the row's own lock? Distinct from
 * {@link closeAfterStart}: that one asks whether the feed was still listing the
 * market, this asks whether the price we scored was recorded past the cutoff.
 *
 * STRICTLY after, with no tolerance. The rounding allowance that
 * {@link closeAfterStart} carries exists because `poll_gap_seconds` is stored
 * at integer-second granularity; `value_captured_at` is a direct timestamp
 * with no such quantisation, so borrowing that allowance here would silently
 * accept a price captured up to 999ms past its own cutoff. The acceptance rule
 * is `value_captured_at <= lock_time`: exact equality is at the cutoff and
 * passes, one millisecond past it does not.
 *
 * Measured at 0 of 3609 rows on the captured corpus — this guard is expected to
 * be dead on arrival, and is here so the claim stays measured rather than
 * assumed.
 */
export function closeValueAfterLock(timing: CloseTiming): boolean {
  const t = requireUsable(timing, 'closeValueAfterLock');
  if (t.valueCapturedMs === null) return false;
  return t.valueCapturedMs > t.lockMs;
}
