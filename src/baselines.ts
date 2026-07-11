import type { BaselineDecision, SlateBundle } from './types.js';

/**
 * The six deterministic baseline participants (docs/AGENT_BENCHMARK.md,
 * "Deterministic baselines and paired design"). Pure versioned code: no
 * model call, no randomness, byte-stable output for identical input.
 * v0 records the common-cutoff decision track only.
 */
export const BASELINE_POLICY_VERSION = 'baselines-v0.1.0';

export function runBaselines(bundle: SlateBundle): BaselineDecision[] {
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
        policyVersion: BASELINE_POLICY_VERSION,
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
        policyVersion: BASELINE_POLICY_VERSION,
        gameId: game.gameId,
        market: 'total',
        selection: 'over',
        line: total.line,
        observedDecimal: total.overDecimal,
        track: 'common-cutoff',
      },
      {
        participantId: 'baseline-under-total',
        policyVersion: BASELINE_POLICY_VERSION,
        gameId: game.gameId,
        market: 'total',
        selection: 'under',
        line: total.line,
        observedDecimal: total.underDecimal,
        track: 'common-cutoff',
      },
    );
  }

  return decisions;
}
