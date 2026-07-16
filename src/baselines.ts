import type { BaselineDecision, SlateBundle } from './types.js';

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

export function runBaselines(
  bundle: SlateBundle,
  policyVersion: BaselinePolicyVersion = BASELINE_POLICY_VERSION,
): BaselineDecision[] {
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

    if (policyVersion !== 'baselines-v0.1.0') {
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
