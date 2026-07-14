import { MARKETS, SCORING_POLICY_VERSION } from './scoring.js';
import type { MarketStats, ParticipantStats, ScoredPick, SourceRun } from './scoring.js';
import type { MarketKey } from './types.js';

/**
 * Human-readable scorecard. Never starts with raw JSON; leads with the
 * honest-labeling banner and states the metric precisely: single-source
 * reference-closing CLV on decisions (no execution), late entries. The
 * primary summary is the equal-weight game-level aggregate; per-pick numbers
 * are secondary. Cross-participant comparison lives in the per-market
 * section — vig differs by market, so pooled numbers are context, never the
 * comparison surface for participants with different market exposure.
 * Coverage comes first — arm failures never leave the denominators.
 */

/** Exhaustive by construction: adding a MarketKey without a label is a compile error. */
const MARKET_LABEL: Record<MarketKey, string> = {
  moneyline: 'Moneyline',
  spread: 'Spread (run line)',
  total: 'Total',
};

function fmt(value: number | null, suffix = ''): string {
  return value === null ? '—' : `${value}${suffix}`;
}

function outcomes(stat: ParticipantStats): string {
  const entries = Object.entries(stat.armOutcomes);
  if (entries.length === 0) return '—';
  return entries.map(([outcome, count]) => `${outcome} ${count}`).join(' · ');
}

function reasons(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return '—';
  return entries.map(([reason, count]) => `${reason} ${count}`).join(', ');
}

function coverageRow(stat: ParticipantStats): string {
  return (
    `| ${stat.participantId} | ${stat.games} | ${outcomes(stat)} | ${stat.eligibleMarkets} | ` +
    `${stat.validDecisions} | ${stat.primaryScoreable} | ${stat.conditionalOnly} | ${reasons(stat.unscoredByReason)} |`
  );
}

function clvRow(stat: ParticipantStats): string {
  return (
    `| ${stat.participantId} | ${stat.gamesScoreable} | ${fmt(stat.gameLevel.meanClvPct)} | ` +
    `${fmt(stat.gameLevel.medianClvPct)} | ${fmt(stat.gameLevel.beatClosePct, '%')} | ` +
    `${stat.primaryScoreable}/${stat.eligibleMarkets} | ${fmt(stat.perPick.meanClvPct)} | ` +
    `${fmt(stat.perPick.medianClvPct)} | ${fmt(stat.perPick.beatClosePct, '%')} |`
  );
}

function marketRow(stat: ParticipantStats, market: MarketStats): string {
  return (
    `| ${stat.participantId} | ${market.picks} | ${market.scoreable}/${market.eligible} | ${market.gamesScoreable} | ` +
    `${fmt(market.gameLevel.meanClvPct)} | ${fmt(market.gameLevel.medianClvPct)} | ` +
    `${fmt(market.gameLevel.beatClosePct, '%')} | ${reasons(market.unscoredByReason)} |`
  );
}

export function buildScorecardMarkdown(
  run: SourceRun,
  scored: ScoredPick[],
  stats: ParticipantStats[],
  scoredAt: string,
): string {
  const lines: string[] = [];
  const models = stats.filter((s) => s.kind === 'model');
  const baselines = stats.filter((s) => s.kind === 'baseline');

  lines.push(`# Reference-closing CLV scorecard — ${run.slateDate}`);
  lines.push('');
  lines.push('**Label: `SMOKE_V0_NOT_A_COHORT`** — pipeline shakedown, not a scored cohort.');
  lines.push(
    run.watch !== null && run.runId.startsWith('watch-v0-')
      ? `Entry prices are the first-eligible board, fired at detection under the late-detection gate ` +
          `(board completed ${run.watch.boardCompletedAt}, detected ${run.watch.detectedAt}, ` +
          `opener age ${run.watch.openerAgeMinutes}m ≤ threshold ${run.watch.lateThresholdMinutes}m — ` +
          'verified from run_meta by the integrity gate). Still plumbing validation — this data must never appear on a leaderboard.'
      : 'Entry prices were captured LATE (lines opened days earlier), so this CLV does not reflect a real early-entry policy. This data must never appear on a leaderboard.',
  );
  lines.push('');
  lines.push(`- Source run: \`${run.runId}\` (slate sha \`${run.slateSha256.slice(0, 16)}…\`, integrity verified)`);
  lines.push(`- Scored: ${scoredAt}`);
  lines.push(`- Scoring policy: \`${SCORING_POLICY_VERSION}\` (stamped on every scored record)`);
  lines.push(
    '- Metric: **reference-closing CLV** in expected-ROI percentage points — the frozen entry price against the proportional no-vig close of the same contract from a single reference source. Decision CLV only; nothing was executed.',
  );
  lines.push(
    '- Primary summary: **equal-weight game-level aggregate** (per-game mean CLV, averaged across games). Per-pick numbers are secondary.',
  );
  lines.push(
    '- Comparison rule: **never pool CLV across markets when comparing participants with different market exposure** — vig differs by market (a moneyline-only baseline and a three-market model are not on the same footing). Pooled tables are context; cross-participant comparison belongs in the per-market section.',
  );
  lines.push(
    '- Policy: `fresh`-confidence closes only; price CLV only at the unchanged line (moved lines report signed favorable movement instead); integer push-capable lines report separately-labeled conditional CLV, never pooled into primary.',
  );
  lines.push('');

  lines.push('## Coverage (failures stay in the denominators)');
  lines.push('');
  lines.push(
    '| Participant | Games | Arm outcomes | Eligible markets | Valid decisions | Primary-scoreable | Conditional-only | Unscored (reason) |',
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const stat of models) lines.push(coverageRow(stat));
  for (const stat of baselines) lines.push(coverageRow(stat));
  lines.push('');

  lines.push('## Reference-closing CLV (pooled across each participant’s markets — context only)');
  lines.push('');
  lines.push(
    'Model rows pool moneyline, spread, and total exposure; single-market baselines pool nothing. Compare participants in the per-market section below.',
  );
  lines.push('');
  lines.push(
    '| Participant | Games scoreable | Game-level mean | Game-level median | Game-level beat close | Scoreable/eligible | Per-pick mean | Per-pick median | Per-pick beat close |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const stat of models) lines.push(clvRow(stat));
  lines.push('');
  lines.push('### Deterministic baselines');
  lines.push('');
  lines.push(
    '| Participant | Games scoreable | Game-level mean | Game-level median | Game-level beat close | Scoreable/eligible | Per-pick mean | Per-pick median | Per-pick beat close |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const stat of baselines) lines.push(clvRow(stat));
  lines.push('');

  lines.push('## By market (game-level — the cross-participant comparison surface)');
  lines.push('');
  lines.push(
    'One table per market, every participant active in it — the only like-for-like comparison when market exposure differs. Rows are ordered by the market’s own game-level mean (not the pooled aggregate). Within a market each game contributes at most one pick per participant, so game-level and per-pick aggregates coincide today; the within-game clustering is applied regardless.',
  );
  lines.push('');
  for (const marketKey of MARKETS) {
    const active = stats
      .map((stat) => ({ stat, market: stat.byMarket[marketKey] }))
      .filter((entry): entry is { stat: ParticipantStats; market: MarketStats } => entry.market !== undefined);
    if (active.length === 0) continue;
    // Ranked by THIS market's result — the pooled ordering must not leak
    // into the per-market comparison surface. Nulls (nothing scoreable) last.
    active.sort((a, b) => {
      const aMean = a.market.gameLevel.meanClvPct;
      const bMean = b.market.gameLevel.meanClvPct;
      if (aMean === null && bMean === null) return 0;
      if (aMean === null) return 1;
      if (bMean === null) return -1;
      return bMean - aMean;
    });
    lines.push(`### ${MARKET_LABEL[marketKey]}`);
    lines.push('');
    lines.push(
      '| Participant | Picks | Scoreable/eligible | Games scoreable | Game-level mean | Game-level median | Game-level beat close | Unscored (reason) |',
    );
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const { stat, market } of active) lines.push(marketRow(stat, market));
    lines.push('');
  }

  const moved = scored.filter((p) => p.result.unscoredReason === 'line_moved');
  if (moved.length > 0) {
    lines.push('## Moved lines (primary CLV unavailable; favorable movement reported)');
    lines.push('');
    lines.push('| Participant | Game | Market | Selection | Entry line | Closing line | Favorable movement |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const pick of moved) {
      lines.push(
        `| ${pick.participantId} | \`${pick.gameId}\` | ${pick.market} | ${pick.selection} | ${pick.line ?? '—'} | ${pick.close?.line ?? '—'} | ${fmt(pick.result.lineMovementFavorable)} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Caveats');
  lines.push('');
  lines.push('- One reference source: this is reference-closing CLV, not a market consensus close.');
  lines.push(
    '- The four models saw the same games, so participant rows are not independent samples; uncertainty intervals are out of scope for the smoke.',
  );
  lines.push('- No execution layer existed: decision CLV only, no fills, no execution CLV.');
  lines.push('');
  return lines.join('\n');
}
