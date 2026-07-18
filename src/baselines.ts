import type { BaselineDecision, GameBundle, SlateBundle } from './types.js';

/**
 * The deterministic baseline participants (docs/AGENT_BENCHMARK.md,
 * "Deterministic baselines and paired design"). Pure versioned code: no
 * model call, no randomness, byte-stable output for identical input.
 * Every version records the common-cutoff decision track only.
 *
 * - `baselines-v0.1.0` — six policies: favorite/underdog/home/away
 *   moneyline, over/under at the designated total.
 * - `baselines-v0.2.0` — adds the mirrored run-line pair:
 *   `baseline-favorite-rl` takes the side LAYING the runs (the
 *   negative-handicap side) and `baseline-underdog-rl` takes the other
 *   side. The side is determined by the line sign alone — price plays no
 *   part — and a zero handicap (pick'em; not seen on MLB run lines) breaks
 *   to home as the laying side.
 * - `baselines-v0.3.0` — the SCOPED policy: it derives the same per-market
 *   baselines but only for the markets PRESENT on each game (1–3 markets), so
 *   a dynamic cohort with partial boards produces exactly the baselines its
 *   games carry. On a full three-market board its output is identical to v0.2
 *   apart from the required `policyVersion` stamp (§4).
 *
 * v0.1 and v0.2 are full-board-era policies: they are defined over the fixed
 * three-market board (moneyline + run line + total), so a scoped (1–2-market)
 * input is not a valid input for either and fails closed rather than emitting a
 * partial set (SPEC-prepared-request.md §3). v0.3 is the only version that
 * derives from a present-market subset. Version dispatch is likewise
 * fail-closed: an unrecognized version throws instead of falling through to a
 * default policy.
 *
 * The default stamped on NEW runs stays v0.2 (the current fixed three-market
 * smoke/watch path); a dynamic cohort requires v0.3 — its boot/runtime gate is
 * a separate S3 slice.
 *
 * The scorer re-derives baselines under the RECORDED policy version, so
 * archived runs keep verifying byte-for-byte as newer versions ship.
 */
export const BASELINE_POLICY_VERSIONS = Object.freeze([
  'baselines-v0.1.0',
  'baselines-v0.2.0',
  'baselines-v0.3.0',
] as const);
export type BaselinePolicyVersion = (typeof BASELINE_POLICY_VERSIONS)[number];

/** The policy version the harness stamps on NEW runs (the fixed-board path). */
export const BASELINE_POLICY_VERSION: BaselinePolicyVersion = 'baselines-v0.2.0';

export function isBaselinePolicyVersion(value: string): value is BaselinePolicyVersion {
  return (BASELINE_POLICY_VERSIONS as readonly string[]).includes(value);
}

/** The market blocks a full-board policy (v0.1/v0.2) requires on every game. */
const FULL_BOARD_MARKETS = ['moneyline', 'runLine', 'total'] as const;

/** Policies defined over the fixed three-market board; they reject scoped input. */
const FULL_BOARD_POLICIES = new Set<BaselinePolicyVersion>([
  'baselines-v0.1.0',
  'baselines-v0.2.0',
]);

/**
 * Whether a baseline policy version is a FULL-BOARD policy — one defined over the
 * fixed three-market board that fails closed on a scoped (1–2-market) input
 * (v0.1/v0.2). The scoped policy v0.3 is NOT full-board. The dynamic-cohort boot
 * gate uses this to refuse a scoped cohort that declares a full-board baseline
 * policy (SPEC-prepared-request.md §3): such a cohort's games carry 1–2 markets,
 * on which a full-board policy would throw. Any future scoped-capable version is
 * accepted by returning false, so the gate stays version-agnostic.
 */
export function isFullBoardBaselinePolicy(version: BaselinePolicyVersion): boolean {
  return FULL_BOARD_POLICIES.has(version);
}

/**
 * Which markets a policy emits baselines for on a given game. v0.1 = moneyline
 * + total (never the run line); v0.2 = all three; v0.3 = the PRESENT markets
 * (1–3). Only WHICH markets are emitted differs across versions — the per-market
 * derivation itself is shared, so v0.3 on a full board equals v0.2's set apart
 * from the version stamp.
 */
function emittedMarkets(
  policyVersion: BaselinePolicyVersion,
  game: GameBundle,
): { moneyline: boolean; total: boolean; runLine: boolean } {
  if (policyVersion === 'baselines-v0.1.0') return { moneyline: true, total: true, runLine: false };
  if (policyVersion === 'baselines-v0.2.0') return { moneyline: true, total: true, runLine: true };
  // v0.3.0 (scoped): emit each market only where it is present on this game.
  const markets = game.markets as Partial<GameBundle['markets']>;
  return {
    moneyline: markets.moneyline != null,
    total: markets.total != null,
    runLine: markets.runLine != null,
  };
}

/**
 * Fail closed on a scoped input (SPEC-prepared-request.md §3). v0.1/v0.2 are
 * full-board policies and must never emit a partial baseline set for a game
 * that is missing any of the three market blocks. The static type marks all
 * three present; this enforces it at runtime against a scoped value that
 * reached here through a cast (e.g. the scorer reconstructs slates with
 * `as unknown as SlateBundle`). It throws before any decision is emitted.
 *
 * Scope: this detects an ABSENT (null/undefined) block — the scoped-input
 * concern. Structural validity of a PRESENT block (that it is a well-formed
 * object with valid prices/lines) is the prepared-request boundary's job
 * (§2.2), through which every real input to runBaselines has already passed;
 * it is not re-checked here.
 */
function assertFullBoard(bundle: SlateBundle, policyVersion: BaselinePolicyVersion): void {
  for (const game of bundle.games) {
    const markets = game.markets as Partial<GameBundle['markets']> | null | undefined;
    const missing = FULL_BOARD_MARKETS.filter((key) => markets?.[key] == null);
    if (missing.length > 0) {
      throw new Error(
        `baseline policy ${policyVersion} requires a full three-market board; ` +
          `game ${game.gameId} is missing market block(s): ${missing.join(', ')}`,
      );
    }
  }
}

export function runBaselines(
  bundle: SlateBundle,
  policyVersion: BaselinePolicyVersion = BASELINE_POLICY_VERSION,
): BaselineDecision[] {
  // Version isolation (spec §3). The typed parameter guards compile-time
  // callers, but the scorer re-derives baselines under a version string read
  // from an archived artifact. An unknown version reaching here — through that
  // path or any cast — must fail closed, never fall through to a default
  // policy that would stamp foreign output with the unrecognized version.
  if (!isBaselinePolicyVersion(policyVersion)) {
    throw new Error(`unknown baseline policy version "${policyVersion}"`);
  }
  // Full-board input guard: a full-board policy (v0.1/v0.2) rejects a scoped
  // input before emitting anything. v0.3 is scoped and skips this guard.
  if (FULL_BOARD_POLICIES.has(policyVersion)) {
    assertFullBoard(bundle, policyVersion);
  }

  const decisions: BaselineDecision[] = [];

  for (const game of bundle.games) {
    // Which markets this policy emits for this game (v0.1/v0.2 fixed by version
    // over a guaranteed full board; v0.3 the present-market subset).
    const emit = emittedMarkets(policyVersion, game);

    if (emit.moneyline) {
      const ml = game.markets.moneyline;

      // Favorite = lower decimal price; exact-price tie breaks to home.
      const favoriteSelection =
        ml.homeDecimal <= ml.awayDecimal ? game.homeTeam : game.awayTeam;
      // Underdog = higher decimal price; exact-price tie breaks to away.
      const underdogSelection =
        ml.awayDecimal >= ml.homeDecimal ? game.awayTeam : game.homeTeam;

      const mlDecimal = (team: string): number =>
        team === game.awayTeam ? ml.awayDecimal : ml.homeDecimal;

      const moneylineBaselines: Array<{ participantId: string; selection: string }> = [
        { participantId: 'baseline-favorite-ml', selection: favoriteSelection },
        { participantId: 'baseline-underdog-ml', selection: underdogSelection },
        { participantId: 'baseline-home-ml', selection: game.homeTeam },
        { participantId: 'baseline-away-ml', selection: game.awayTeam },
      ];
      for (const { participantId, selection } of moneylineBaselines) {
        decisions.push({
          participantId,
          policyVersion,
          gameId: game.gameId,
          market: 'moneyline',
          selection,
          line: null,
          observedDecimal: mlDecimal(selection),
          track: 'common-cutoff',
        });
      }
    }

    if (emit.total) {
      const total = game.markets.total;
      decisions.push(
        {
          participantId: 'baseline-over-total',
          policyVersion,
          gameId: game.gameId,
          market: 'total',
          selection: 'over',
          line: total.line,
          observedDecimal: total.overDecimal,
          track: 'common-cutoff',
        },
        {
          participantId: 'baseline-under-total',
          policyVersion,
          gameId: game.gameId,
          market: 'total',
          selection: 'under',
          line: total.line,
          observedDecimal: total.underDecimal,
          track: 'common-cutoff',
        },
      );
    }

    if (emit.runLine) {
      const runLine = game.markets.runLine;
      // Run-line favorite = the side LAYING the runs. The line is stored as
      // the HOME handicap: home lays when the line is negative, away lays
      // when it is positive, and a zero handicap breaks to home. The rule is
      // price-independent by design — on a run line the price does not
      // decide which side is the favorite, the handicap sign does.
      const homeLays = runLine.line <= 0;
      const rlFavoriteSelection = homeLays ? game.homeTeam : game.awayTeam;
      const rlUnderdogSelection = homeLays ? game.awayTeam : game.homeTeam;
      const rlDecimal = (team: string): number =>
        team === game.awayTeam ? runLine.awayDecimal : runLine.homeDecimal;

      decisions.push(
        {
          participantId: 'baseline-favorite-rl',
          policyVersion,
          gameId: game.gameId,
          market: 'spread',
          selection: rlFavoriteSelection,
          line: runLine.line,
          observedDecimal: rlDecimal(rlFavoriteSelection),
          track: 'common-cutoff',
        },
        {
          participantId: 'baseline-underdog-rl',
          policyVersion,
          gameId: game.gameId,
          market: 'spread',
          selection: rlUnderdogSelection,
          line: runLine.line,
          observedDecimal: rlDecimal(rlUnderdogSelection),
          track: 'common-cutoff',
        },
      );
    }
  }

  return decisions;
}
