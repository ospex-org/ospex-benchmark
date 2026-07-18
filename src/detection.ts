import { deepFreeze } from './freeze.js';
import { effectiveEnabled } from './marketPolicy.js';
import { instantMs } from './time.js';
import type { MarketPolicyVersion } from './marketPolicy.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { MarketKey } from './types.js';

/**
 * Per-market detection eligibility (SPEC-line-open-evidence-model.md §3 —
 * "Detection and firing" / "Canonical window gates"). Pure and I/O-free: given a
 * candidate `(gameId, market)`, its independent `firstTwoSided` opener (from
 * `odds_history`), and the cohort's observation window, decide whether the market
 * may be CLEANLY entered at `detectedAt`.
 *
 * This replaces the legacy game-level newest-of-N `boardCompletedAt` gate, which
 * measured opener age off the NEWEST of a game's three markets and so could
 * certify a stale market (e.g. a 3-hour-old moneyline) as fresh because a
 * late-arriving sibling (the run line) reset the board-completion instant. Here
 * each market is gated on ITS OWN opener, no-wait — so the evaluator BINDS the
 * opener to the exact candidate `(gameId, market)`: a mismatched opener (a
 * sibling market's, or another game's) is refused, never silently trusted. That
 * binding is the whole point; without it the substitution the newest-of-N bug
 * allowed would simply reappear at this boundary.
 *
 * Scope: the DETECTION-time (pre-claim) subset of the canonical window gates —
 * the gates evaluable before any provider request exists. The firing-time gates
 * (V-lag on the initial request, the first-pitch cutoff, `initialRequestStartedAt
 * < windowEnd`) are enforced at dispatch and by the scorer (`attemptProvenance`,
 * §5), NOT here. The current-quote two-sided check is the bundle builder's
 * (`buildGameBundle`); a market reaches here only as a discovered candidate.
 */

export type CandidateState =
  | 'eligible'
  | 'not_enabled'
  | 'opener_not_visible'
  | 'detected_before_window'
  | 'detected_after_window'
  | 'opener_before_window'
  | 'opener_after_window'
  | 'clock_skew_defer'
  | 'clock_skew_fault'
  | 'stale_entry';

/**
 * A per-candidate verdict. `eligible`/`stale_entry` carry the derived
 * `openerAgeMs` (= detectedAt − opener), the skew states carry `skewMs`
 * (= opener − detectedAt), and every opener-dependent verdict carries the
 * `opener` it was judged against — a DETACHED, FROZEN snapshot, so neither later
 * mutation of the caller's source row nor mutation through the returned verdict
 * can change the evidence the decision was actually made on.
 */
export type CandidateVerdict =
  | { state: 'eligible'; opener: TwoSidedHistoryRow; openerAgeMs: number }
  | { state: 'not_enabled' }
  | { state: 'opener_not_visible' }
  | { state: 'detected_before_window' }
  | { state: 'detected_after_window' }
  | { state: 'opener_before_window'; opener: TwoSidedHistoryRow }
  | { state: 'opener_after_window'; opener: TwoSidedHistoryRow }
  | { state: 'clock_skew_defer'; opener: TwoSidedHistoryRow; skewMs: number }
  | { state: 'clock_skew_fault'; opener: TwoSidedHistoryRow; skewMs: number }
  | { state: 'stale_entry'; opener: TwoSidedHistoryRow; openerAgeMs: number };

export interface CandidateInput {
  /**
   * The candidate game's identifier. The opener is bound to it: `opener.jsonodds_id`
   * MUST equal this. This repo keys a game's odds/history by its jsonodds id, so
   * `gameId` is that same identifier (see `buildBundle`).
   */
  gameId: string;
  /** `games.sport` — the stable NOT NULL slug the market policy is keyed on. */
  sport: string;
  market: MarketKey;
  /** Cohort sport allow-list (manifest §2), for `effectiveEnabled`. */
  sportAllowList: readonly string[];
  marketPolicyVersion: MarketPolicyVersion;
  /**
   * The market's independent first two-sided appearance from `odds_history`
   * (§1, `firstTwoSided`), or `undefined` when its history row is not yet
   * visible — a transient condition (the writer appends history around the
   * snapshot), so the caller re-evaluates on a later tick. When present it MUST
   * be this candidate's own opener (`jsonodds_id === gameId`, `market === market`).
   */
  opener: TwoSidedHistoryRow | undefined;
  /** Detection instant, stamped once the prepared snapshot is clean (offset ISO). */
  detectedAt: string;
  /** Cohort observation window [windowStart, windowEnd) (offset ISO). */
  windowStart: string;
  windowEnd: string;
  /** Clean-entry window W: the max tolerated detectedAt − opener age (ms). */
  cleanEntryWindowMs: number;
  /** Max tolerated skew for an opener stamped AHEAD of detection (ms). */
  maxClockSkewMs: number;
}

function requireNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a safe nonnegative integer, got ${String(value)}`);
  }
}

/**
 * Evaluate one candidate market's detection-time eligibility.
 *
 * THROWS (fail-closed) on a config/caller/evidence-integrity bug — never a data
 * condition:
 *   - a malformed instant or a non-integer/negative window constant;
 *   - an opener that is not THIS candidate's own (`jsonodds_id`/`market` mismatch)
 *     — the caller wired the wrong evidence;
 *   - an opener whose `captured_at_ms` is not the coherent finite derivation of
 *     its `captured_at` (NaN / infinity / unsafe / tampered) — a corrupt row.
 * Returns a typed verdict for every genuine data outcome.
 *
 * Precedence is fixed and documented:
 *   config validity → policy → detection-in-window → opener availability →
 *   opener↔candidate binding → coherent opener time → opener-in-window →
 *   clock skew → clean-entry staleness.
 *
 * The DETECTION-window gate precedes opener availability so a CLOSED window
 * (detectedAt ≥ windowEnd, terminal) is never masked by a merely-missing opener.
 * The opener-in-window gate precedes the age gate because the bare age gate alone
 * is insufficient (spec §3): an opener just outside the window but within W would
 * be a guaranteed `X = F − U` extra fire. `eligible` requires ALL gates to pass.
 */
export function evaluateCandidate(input: CandidateInput): CandidateVerdict {
  const {
    gameId,
    sport,
    market,
    sportAllowList,
    marketPolicyVersion,
    opener,
    detectedAt,
    windowStart,
    windowEnd,
    cleanEntryWindowMs,
    maxClockSkewMs,
  } = input;

  requireNonNegativeSafeInteger(cleanEntryWindowMs, 'cleanEntryWindowMs');
  requireNonNegativeSafeInteger(maxClockSkewMs, 'maxClockSkewMs');
  const detectedAtMs = instantMs(detectedAt);
  const windowStartMs = instantMs(windowStart);
  const windowEndMs = instantMs(windowEnd);
  if (windowStartMs >= windowEndMs) {
    throw new Error(
      `windowStart must be strictly before windowEnd (got ${windowStart} .. ${windowEnd})`,
    );
  }

  // 1. Policy — effective eligibility (sport in the allow-list AND the market
  //    enabled for that sport). One predicate shared with finalization (§3).
  if (!effectiveEnabled(sportAllowList, sport, market, marketPolicyVersion)) {
    return { state: 'not_enabled' };
  }
  // 2. Detection window — checked BEFORE opener availability so a CLOSED window is
  //    never masked by a missing opener. detectedAt ≥ windowEnd is TERMINAL (a
  //    later re-evaluation's fresh detectedAt is also past windowEnd); < windowStart
  //    means the cohort has not started (transient).
  if (detectedAtMs < windowStartMs) return { state: 'detected_before_window' };
  if (detectedAtMs >= windowEndMs) return { state: 'detected_after_window' };
  // 3. Opener availability — no independent opener yet (transient; defer).
  if (opener === undefined) return { state: 'opener_not_visible' };
  // 4. Identity binding — the opener MUST be this exact candidate's own. A
  //    mismatch is a caller wiring bug (a sibling market's opener, or another
  //    game's), never a data condition, so it throws. This binding IS the point
  //    of per-market detection: without it the newest-of-N substitution reappears.
  if (opener.jsonodds_id !== gameId || opener.market !== market) {
    throw new Error(
      `opener (${opener.jsonodds_id}, ${opener.market}) does not match candidate (${gameId}, ${market})`,
    );
  }
  // 5. Coherent, finite opener time — RE-DERIVE from the canonical `captured_at`
  //    (never trust the mutable derived `captured_at_ms`), fail-closed on a
  //    malformed instant, and refuse a row whose cached derivation disagrees
  //    (NaN / infinity / unsafe / tampered → not the coherent derivation).
  const openerMs = instantMs(opener.captured_at);
  if (opener.captured_at_ms !== openerMs) {
    throw new Error(
      `opener captured_at_ms (${String(opener.captured_at_ms)}) is not the coherent derivation of captured_at (${opener.captured_at})`,
    );
  }
  // 6. Detached, frozen evidence — the exact row the verdict was judged against,
  //    immune to later mutation of the caller's source row OR the returned value.
  const evidence = deepFreeze({ ...opener });

  // 7. Opener window — an opener outside [windowStart, windowEnd) can never be in
  //    the universe U (§6), so forbid the fire here rather than admitting a
  //    guaranteed X = F − U extra fire (the bare age gate would miss this).
  if (openerMs < windowStartMs) return { state: 'opener_before_window', opener: evidence };
  if (openerMs >= windowEndMs) return { state: 'opener_after_window', opener: evidence };
  // 8. Clock skew — an opener stamped AFTER detection never widens the window.
  //    Within tolerance: defer and re-evaluate next tick. Beyond: a source/clock
  //    fault — never claim.
  if (openerMs > detectedAtMs) {
    const skewMs = openerMs - detectedAtMs;
    return skewMs <= maxClockSkewMs
      ? { state: 'clock_skew_defer', opener: evidence, skewMs }
      : { state: 'clock_skew_fault', opener: evidence, skewMs };
  }
  // 9. Clean-entry window — 0 ≤ age ≤ W (age ≥ 0 is guaranteed by step 8).
  const openerAgeMs = detectedAtMs - openerMs;
  if (openerAgeMs > cleanEntryWindowMs) return { state: 'stale_entry', opener: evidence, openerAgeMs };

  return { state: 'eligible', opener: evidence, openerAgeMs };
}

/**
 * The operational disposition of a verdict for the detection loop (§3):
 * `eligible` → claim + fire; `defer` → re-evaluate on a later tick; `reject` →
 * never fire this candidate. Derived from an EXHAUSTIVE `Record<CandidateState,
 * …>` so a newly added state cannot compile without a conscious classification
 * (a missing key is a type error, not a silent default) — the same fail-closed
 * discipline the market/baseline policy tables use.
 */
export type CandidateDisposition = 'eligible' | 'defer' | 'reject';

const DISPOSITION_BY_STATE: Record<CandidateState, CandidateDisposition> = {
  eligible: 'eligible',
  // Transient — the condition can clear on a later tick.
  opener_not_visible: 'defer',
  detected_before_window: 'defer',
  clock_skew_defer: 'defer',
  // Terminal for this candidate — it can never cleanly enter.
  not_enabled: 'reject',
  detected_after_window: 'reject',
  opener_before_window: 'reject',
  opener_after_window: 'reject',
  clock_skew_fault: 'reject',
  stale_entry: 'reject',
};

export function candidateDisposition(verdict: CandidateVerdict): CandidateDisposition {
  return DISPOSITION_BY_STATE[verdict.state];
}
