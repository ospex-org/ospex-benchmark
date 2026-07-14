import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nbPmf, totalsDispersionArtifactSchema } from './dispersion.js';
import { proportionalTwoWay } from './devig.js';
import type { CloseQuote, UnscoredReason } from './clv.js';

/**
 * TOTALS_V1 totals ladder — pure math, no I/O except the artifact loader.
 *
 * The ladder prices win/push probabilities for any totals line inside its
 * method domain from one closing quote, so LINE MOVEMENT ALONE never
 * disqualifies a totals pick: a pick whose line moved gets a ladder CLV
 * instead of silence. What still can refuse a pick, each with a typed
 * reason: the close-quality gates (SHARED with the exact-line metrics — a
 * missing/stale/inconsistent close refuses the ladder with the same reason
 * it refuses everything else with), the METHOD DOMAIN (MLB only — the
 * dispersion parameter is fit on MLB finals; half-step lines within the
 * finite rail below), and SOLVABILITY (a close whose implied mean falls
 * outside the solver bounds refuses rather than extrapolates).
 *
 * STATUS: TOTALS_V1 is the preregistered CANDIDATE line-value method. Its
 * independent validation — mean absolute error of ladder prices against a
 * real sportsbook alternate-totals ladder — is pending a one-time manual
 * capture, so ladder output is sensitivity/diagnostic: separately labeled,
 * never pooled into the primary columns, and integer same-line totals stay
 * conditional-only in the primary metrics until the validation artifact is
 * published.
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
 * The tail walk is a single pmf recurrence (O(line) total, never a fresh
 * pmf per term), and the finite line rail bounds the work — a schema-valid
 * but absurd line refuses fast instead of grinding.
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

/**
 * Method domain, runtime-bound (refusals are `outside_method_domain`):
 * - The dispersion parameter is fit on MLB finals; the ladder never prices
 *   another league's totals with it.
 * - Lines must sit on the half-step lattice (the model has no meaning at a
 *   quarter line) within a finite rail — generous next to real MLB totals
 *   (max captured close: 15) but a hard bound, both because the model is
 *   unvalidated out there and because the CDF walk cost grows with the line.
 */
export const LADDER_LEAGUE = 'mlb';
export const MAX_LADDER_LINE = 30;

/** On the half-step lattice, positive, and inside the finite rail. */
export function ladderLineInDomain(line: number): boolean {
  return Number.isFinite(line) && line > 0 && line <= MAX_LADDER_LINE && Number.isInteger(line * 2);
}

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
  if (line > MAX_LADDER_LINE) {
    throw new LadderError(
      `${label} ${line} exceeds the method's line rail (${MAX_LADDER_LINE}) — refusing unbounded work`,
    );
  }
}

/**
 * Win/push/loss mass around a (half-integer or integer) totals line. One
 * incremental pmf recurrence — P(t) = P(t-1) * ((t-1+k)/t) * (mu/(k+mu)) —
 * so the whole walk is O(line); the float sequence is identical to
 * evaluating nbPmf at each t.
 */
export function tailProbabilities(mu: number, k: number, line: number): TailProbabilities {
  assertHalfStepLine(line, 'line');
  const floor = Math.floor(line);
  // nbPmf(0) also validates mu and k — single source for both.
  let p = nbPmf(0, mu, k);
  const ratio = mu / (k + mu);
  let cdf = p;
  let at = line === 0 ? p : 0;
  for (let t = 1; t <= floor; t += 1) {
    p *= ((t - 1 + k) / t) * ratio;
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
  | 'outside_method_domain'
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
 * columns. The method domain (league, line lattice + rail) is checked
 * BEFORE any numeric work — a schema-valid but out-of-domain pick refuses
 * fast with `outside_method_domain`, never grinds or extrapolates.
 */
export function scoreTotalsLadder(options: {
  league: string;
  selection: 'over' | 'under';
  entryDecimal: number;
  entryOppositeDecimal: number | null;
  entryLine: number;
  close: CloseQuote | null;
  gateReason: UnscoredReason | null;
  params: LadderParams;
}): TotalsLadderResult {
  const {
    league,
    selection,
    entryDecimal,
    entryOppositeDecimal,
    entryLine,
    close,
    gateReason,
    params,
  } = options;
  if (gateReason !== null && SHARED_GATE_REASONS.has(gateReason)) {
    return ladderUnscored(params, gateReason as LadderUnscoredReason);
  }
  // Past the shared gates the close exists, is fresh, validated consistent,
  // and (for totals) carries a line — anything else here is a defect.
  if (close === null || close.line === null || close.awayPNovig === null) {
    return ladderUnscored(params, 'close_not_captured');
  }
  if (
    league !== LADDER_LEAGUE ||
    !ladderLineInDomain(entryLine) ||
    !ladderLineInDomain(close.line)
  ) {
    return ladderUnscored(params, 'outside_method_domain');
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
