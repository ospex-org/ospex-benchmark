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
 *
 * Both current versions are full-board-era policies: they are defined over
 * the fixed three-market board (moneyline + run line + total), so a scoped
 * (1–2-market) input is not a valid input for either and fails closed rather
 * than emitting a partial set (SPEC-prepared-request.md §3). Version dispatch
 * is likewise fail-closed: an unrecognized version throws instead of falling
 * through to a default policy. The forthcoming scoped `v0.3` (S3) is the only
 * version that derives from a present-market subset; it relaxes the full-board
 * requirement for that version alone.
 *
 * The scorer re-derives baselines under the RECORDED policy version, so
 * archived runs keep verifying byte-for-byte as newer versions ship.
 */
export const BASELINE_POLICY_VERSIONS = Object.freeze(['baselines-v0.1.0', 'baselines-v0.2.0'] as const);
export type BaselinePolicyVersion = (typeof BASELINE_POLICY_VERSIONS)[number];

/** The policy version the harness stamps on NEW runs. */
export const BASELINE_POLICY_VERSION: BaselinePolicyVersion = 'baselines-v0.2.0';

export function isBaselinePolicyVersion(value: string): value is BaselinePolicyVersion {
  return (BASELINE_POLICY_VERSIONS as readonly string[]).includes(value);
}

/** The market blocks a full-board policy (v0.1/v0.2) requires on every game. */
const FULL_BOARD_MARKETS = ['moneyline', 'runLine', 'total'] as const;

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
  // Full-board input guard: reject a scoped input before emitting anything.
  assertFullBoard(bundle, policyVersion);

  const includeRunLine = policyVersion === 'baselines-v0.2.0';
  const decisions: BaselineDecision[] = [];

  for (const game of bundle.games) {
    const ml = game.markets.moneyline;
    const total = game.markets.total;

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

    if (includeRunLine) {
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
