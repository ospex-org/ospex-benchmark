import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nbPmf, totalsDispersionArtifactSchema } from './dispersion.js';
import { proportionalTwoWay } from './devig.js';
import type { CloseQuote, UnscoredReason } from './clv.js';
import type { ClvResult } from './clv.js';

/**
 * TOTALS_V1 totals ladder — pure math, no I/O except the artifact loader.
 *
 * The ladder prices win/push probabilities for ANY totals line from one
 * closing quote, so no totals pick is ever discarded: a pick whose line
 * moved gets a ladder CLV instead of silence, and an integer same-line pick
 * gets the push probability that two-sided prices alone cannot identify.
 *
 * Model: the final combined total T is negative binomial with dispersion k
 * (the published, versioned parameter — docs/TOTALS_DISPERSION.md) and a
 * per-game mean mu SOLVED from the close:
 *
 *   half-line close L:     P(T > L) = q_over
 *   integer-line close L:  P(T > L) / (1 - P(T = L)) = q_over
 *
 * where q_over is the proportionally de-vigged closing probability of the
 * over (integer-line quotes are push-refund by market convention, so their
 * de-vig IS the conditional-on-no-push split — the solve conditions the
 * model the same way). Both targets are strictly increasing in mu, so the
 * bisection is exact up to tolerance; a target outside the mu bounds is a
 * typed refusal, never a clamp.
 *
 * Scoring uses the methodology's generalized push-aware formula at the
 * ENTRY line (docs/AGENT_BENCHMARK.md "Push-capable lines"):
 *
 *   economic:        100 * (q_W * D_e    + q_P - 1)
 *   margin-adjusted: 100 * (q_W / q_e    + q_P - 1)   [D_fair = 1/q_e]
 *
 * with q_W and q_P from the ladder at the entry line and q_e the
 * proportionally de-vigged entry probability of the selected side (the
 * fair push-refund price is D_fair = (1 - q_P)/q_W_fair = 1/q_cond). At an
 * unchanged half-line this reduces EXACTLY to the exact-line metrics; at an
 * unchanged integer line it equals the push-excluded conditional CLV shrunk
 * by the push mass: clv_conditional * (1 - q_P).
 *
 * Known approximation, published rather than smoothed over: the smooth NB
 * cannot reproduce the odd/even parity oscillation of MLB totals, so q_P
 * runs roughly one to two percentage points HIGH at even integer lines and
 * LOW at odd ones (see the dispersion artifact's marginalPmfCheck).
 */

export const LADDER_VERSION = 'TOTALS_V1';

export class LadderError extends Error {}

/**
 * Solver bounds for the close-implied mean. MLB totals live in roughly
 * [6.5, 15]; the bounds are generous, and a close whose implied mean falls
 * outside them is refused (`ladder_unsolvable`), never clamped.
 */
export const MU_MIN = 0.5;
export const MU_MAX = 40;

export interface LadderParams {
  /** Negative-binomial dispersion (Var = mu + mu^2/k). */
  k: number;
  /** The published dispersion-parameter version the k came from. */
  parameterVersion: string;
}

export interface TailProbabilities {
  /** P(T > line). */
  above: number;
  /** P(T = line) — 0 for half-lines. */
  at: number;
  /** P(T < line). */
  below: number;
}

function assertHalfStepLine(line: number, label: string): void {
  if (!Number.isFinite(line) || line < 0 || !Number.isInteger(line * 2)) {
    throw new LadderError(`${label} must be a non-negative multiple of 0.5, got ${line}`);
  }
}

/** Win/push/loss mass around a (half-integer or integer) totals line. */
export function tailProbabilities(mu: number, k: number, line: number): TailProbabilities {
  assertHalfStepLine(line, 'line');
  const floor = Math.floor(line);
  let cdf = 0;
  let at = 0;
  for (let t = 0; t <= floor; t += 1) {
    const p = nbPmf(t, mu, k);
    cdf += p;
    if (t === line) at = p;
  }
  return { above: 1 - cdf, at, below: cdf - at };
}

/**
 * Solve the close-implied mean from one de-vigged closing quote,
 * push-conditioned at integer lines. Strictly monotone target + bisection;
 * refuses (never clamps) when the target is not bracketed by the mu bounds.
 */
export function solveCloseImpliedMean(closeLine: number, qOver: number, k: number): number {
  assertHalfStepLine(closeLine, 'closing line');
  if (!Number.isFinite(qOver) || qOver <= 0 || qOver >= 1) {
    throw new LadderError(`de-vigged over probability must be inside (0, 1), got ${qOver}`);
  }
  if (!Number.isFinite(k) || !(k > 0)) {
    throw new LadderError(`dispersion k must be finite and positive, got ${k}`);
  }
  const conditional = Number.isInteger(closeLine);
  const f = (mu: number): number => {
    const { above, at } = tailProbabilities(mu, k, closeLine);
    return conditional ? above / (1 - at) : above;
  };
  let lo = MU_MIN;
  let hi = MU_MAX;
  if (!(f(lo) < qOver && qOver < f(hi))) {
    throw new LadderError(
      `close-implied mean for line ${closeLine} at q_over ${qOver} falls outside ` +
        `[${MU_MIN}, ${MU_MAX}] — refusing to extrapolate`,
    );
  }
  for (let i = 0; i < 200 && hi - lo > 1e-10; i += 1) {
    const mid = (lo + hi) / 2;
    if (f(mid) < qOver) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Ladder-scored totals result — non-null on EVERY totals pick (the version
 * stamps ride along even when unscored, with the reason saying why). The
 * availability gates are SHARED with the exact-line metrics: the gate
 * verdict is taken from the exact-line scorer's result, never re-derived.
 */
export type LadderUnscoredReason =
  | 'close_missing'
  | 'close_not_captured'
  | 'close_stale'
  | 'close_inconsistent'
  | 'ladder_unsolvable';

const SHARED_GATE_REASONS: ReadonlySet<UnscoredReason> = new Set([
  'close_missing',
  'close_not_captured',
  'close_stale',
  'close_inconsistent',
]);

export interface TotalsLadderResult {
  ladderVersion: typeof LADDER_VERSION;
  parameterVersion: string;
  unscoredReason: LadderUnscoredReason | null;
  /** The NB mean solved from the close (push-conditioned at integer lines). */
  closeImpliedMean: number | null;
  /** Ladder win probability of the SELECTED side at the entry line. */
  qWinEntry: number | null;
  /** Ladder push probability at the entry line (0 on half-lines). */
  qPushEntry: number | null;
  /** 100 * (q_W * D_e + q_P - 1). */
  economicClvPct: number | null;
  /** 100 * (q_W / q_e + q_P - 1); null when the entry de-vig is unavailable. */
  marginAdjustedClvPct: number | null;
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function ladderUnscored(
  params: LadderParams,
  reason: LadderUnscoredReason,
): TotalsLadderResult {
  return {
    ladderVersion: LADDER_VERSION,
    parameterVersion: params.parameterVersion,
    unscoredReason: reason,
    closeImpliedMean: null,
    qWinEntry: null,
    qPushEntry: null,
    economicClvPct: null,
    marginAdjustedClvPct: null,
  };
}

/**
 * Score one totals pick through the ladder. `gateReason` is the exact-line
 * scorer's verdict for the same pick — the shared availability gates
 * (missing/stale/inconsistent closes) are honored from it directly so ladder
 * coverage can never diverge from exact-line coverage on close quality;
 * `line_moved` and `push_capable_line` are precisely what the ladder exists
 * to price, and a null reason (scored half-line) is priced for the identity
 * columns.
 */
export function scoreTotalsLadder(options: {
  selection: 'over' | 'under';
  entryDecimal: number;
  entryOppositeDecimal: number | null;
  entryLine: number;
  close: CloseQuote | null;
  gateReason: UnscoredReason | null;
  params: LadderParams;
}): TotalsLadderResult {
  const { selection, entryDecimal, entryOppositeDecimal, entryLine, close, gateReason, params } =
    options;
  if (gateReason !== null && SHARED_GATE_REASONS.has(gateReason)) {
    return ladderUnscored(params, gateReason as LadderUnscoredReason);
  }
  // Past the shared gates the close exists, is fresh, validated consistent,
  // and (for totals) carries a line — anything else here is a defect.
  if (close === null || close.line === null || close.awayPNovig === null) {
    return ladderUnscored(params, 'close_not_captured');
  }
  let mu: number;
  let quantities: TailProbabilities;
  try {
    // Over occupies the away column upstream; its stored p_novig is the
    // de-vigged over probability the solve targets.
    mu = solveCloseImpliedMean(close.line, close.awayPNovig, params.k);
    quantities = tailProbabilities(mu, params.k, entryLine);
  } catch (error) {
    if (error instanceof LadderError) return ladderUnscored(params, 'ladder_unsolvable');
    throw error;
  }
  const qWin = selection === 'over' ? quantities.above : quantities.below;
  const qPush = quantities.at;
  const entryNovig = proportionalTwoWay(entryDecimal, entryOppositeDecimal);
  return {
    ladderVersion: LADDER_VERSION,
    parameterVersion: params.parameterVersion,
    unscoredReason: null,
    closeImpliedMean: round4(mu),
    qWinEntry: round4(qWin),
    qPushEntry: round4(qPush),
    economicClvPct: round4(100 * (qWin * entryDecimal + qPush - 1)),
    marginAdjustedClvPct:
      entryNovig === null
        ? null
        : round4(100 * (qWin / entryNovig.pSelected + qPush - 1)),
  };
}

/**
 * The integer same-line PRIMARY upgrade (docs/AGENT_BENCHMARK.md
 * "Push-capable lines"): with TOTALS_V1 as the preregistered independent
 * q_P source, an integer-line pick whose line did not move upgrades from
 * conditional-only to primary — both metrics take the ladder's generalized
 * value, which at the unchanged line equals the push-excluded conditional
 * CLV shrunk by the push mass (clv_cond * (1 - q_P)). The separately
 * labeled conditional columns are kept unchanged.
 */
export function applyLadderUpgrade(result: ClvResult, ladder: TotalsLadderResult): ClvResult {
  if (result.unscoredReason !== 'push_capable_line') return result;
  if (ladder.unscoredReason !== null || ladder.economicClvPct === null) return result;
  return {
    ...result,
    primaryClvPct: ladder.economicClvPct,
    marginAdjustedClvPct: ladder.marginAdjustedClvPct,
    unscoredReason: null,
  };
}

/**
 * Load the published dispersion parameter the ladder runs on. Path is
 * resolved relative to this module (repo-root data/), so the scorer works
 * from any working directory; the artifact is validated against the exact
 * schema it was written with.
 */
export function loadLadderParams(artifactPath?: string): LadderParams & { artifact: string } {
  const path =
    artifactPath ??
    fileURLToPath(new URL('../data/totals-dispersion-TOTALS_V1_PROVISIONAL.json', import.meta.url));
  const artifact = totalsDispersionArtifactSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  return { k: artifact.k, parameterVersion: artifact.parameterVersion, artifact: path };
}
