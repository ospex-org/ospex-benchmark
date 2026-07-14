import { PROPORTIONAL_DEVIG_METHOD, SHIN_DEVIG_METHOD } from './clv.js';
import { LADDER_VERSION } from './ladder.js';
import { MARKETS, SCORING_POLICY_VERSION } from './scoring.js';
import type { LadderParams } from './ladder.js';
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
    `${fmt(stat.gameLevelMarginAdjusted.meanClvPct)} | ${fmt(stat.gameLevelMarginAdjusted.medianClvPct)} | ` +
    `${fmt(stat.gameLevelMarginAdjusted.beatClosePct, '%')} | ` +
    `${stat.primaryScoreable}/${stat.eligibleMarkets} | ${fmt(stat.perPick.meanClvPct)} | ` +
    `${fmt(stat.perPickMarginAdjusted.meanClvPct)} |`
  );
}

function marketRow(stat: ParticipantStats, market: MarketStats): string {
  return (
    `| ${stat.participantId} | ${market.picks} | ${market.scoreable}/${market.eligible} | ${market.gamesScoreable} | ` +
    `${fmt(market.gameLevel.meanClvPct)} | ${fmt(market.gameLevel.medianClvPct)} | ` +
    `${fmt(market.gameLevel.beatClosePct, '%')} | ${fmt(market.gameLevelMarginAdjusted.meanClvPct)} | ` +
    `${fmt(market.gameLevelMarginAdjusted.medianClvPct)} | ${fmt(market.gameLevelMarginAdjusted.beatClosePct, '%')} | ` +
    `${reasons(market.unscoredByReason)} |`
  );
}

function ladderRow(stat: ParticipantStats): string {
  const ladder = stat.totalsLadder;
  if (ladder === null) return '';
  const exact = stat.byMarket['total'];
  return (
    `| ${stat.participantId} | ${ladder.totalsPicks} | ${ladder.ladderScoreable} | ` +
    `${fmt(ladder.gameLevel.meanClvPct)} | ${fmt(ladder.gameLevel.medianClvPct)} | ` +
    `${fmt(ladder.gameLevelMarginAdjusted.meanClvPct)} | ${fmt(ladder.gameLevelMarginAdjusted.medianClvPct)} | ` +
    `${exact === undefined ? '—' : `${fmt(exact.gameLevel.meanClvPct)} (${exact.scoreable})`} | ` +
    `${fmt(ladder.meanSignedMovement)} | ${reasons(ladder.unscoredByReason)} |`
  );
}

function sensitivityRow(stat: ParticipantStats): string {
  const delta = (a: number | null, b: number | null): string =>
    a === null || b === null ? '—' : `${Math.round((b - a) * 1e4) / 1e4}`;
  const s = stat.sensitivity;
  return (
    `| ${stat.participantId} | ${s.pairedPicksEconomic}/${stat.primaryScoreable} · ${s.pairedPicksMarginAdjusted}/${stat.marginAdjustedScoreable} | ` +
    `${fmt(s.economic.proportional.meanClvPct)} | ${fmt(s.economic.shin.meanClvPct)} | ` +
    `${delta(s.economic.proportional.meanClvPct, s.economic.shin.meanClvPct)} | ` +
    `${fmt(s.marginAdjusted.proportional.meanClvPct)} | ${fmt(s.marginAdjusted.shin.meanClvPct)} | ` +
    `${delta(s.marginAdjusted.proportional.meanClvPct, s.marginAdjusted.shin.meanClvPct)} |`
  );
}

export function buildScorecardMarkdown(
  run: SourceRun,
  scored: ScoredPick[],
  stats: ParticipantStats[],
  scoredAt: string,
  ladderParams: LadderParams,
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
    '- Metrics: **reference-closing CLV** in expected-ROI percentage points, computed BOTH ways from the same formula and always shown side by side — **economic** (the vig-in entry price against the proportional no-vig close: the industry-standard reading, which sits at about minus the vig when nothing moves) and **margin-adjusted** (the proportionally de-vigged entry against the same close: 0 means the forecast exactly matched the market). Neither replaces the other. Decision CLV only; nothing was executed.',
  );
  lines.push(
    `- De-vig method: \`${PROPORTIONAL_DEVIG_METHOD}\` (primary, both metrics; identical to the production closing-line capture). A \`${SHIN_DEVIG_METHOD}\` sensitivity recompute of both metrics is reported separately below — the proportional-vs-Shin choice is published, not hidden.`,
  );
  lines.push(
    '- Primary summary: **equal-weight game-level aggregate** (per-game mean CLV, averaged across games). Per-pick numbers are secondary.',
  );
  lines.push(
    '- Comparison rule: **never pool CLV across markets when comparing participants with different market exposure** — vig differs by market (a moneyline-only baseline and a three-market model are not on the same footing). Pooled tables are context; cross-participant comparison belongs in the per-market section.',
  );
  lines.push(
    '- Policy: `fresh`-confidence closes only; a close whose stored no-vig probabilities disagree with its raw two-sided quotes is refused outright (`close_inconsistent`); exact-line price CLV only at the unchanged line (moved lines report signed favorable movement instead); integer push-capable totals score as primary via the ladder q_P below, with the push-excluded conditional variants of BOTH metrics still separately labeled.',
  );
  lines.push(
    `- Totals ladder: \`${LADDER_VERSION}\` (dispersion parameter \`${ladderParams.parameterVersion}\`, k = ${ladderParams.k}) prices EVERY totals pick at its entry line from the close — moved lines included, nothing discarded. Ladder columns are separately labeled and never replace the exact-line columns. Known approximation: the smooth model's push probability runs roughly 1-2 percentage points HIGH at even integer lines and LOW at odd ones (parity oscillation; see docs/TOTALS_DISPERSION.md).`,
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
  const CLV_HEADER =
    '| Participant | Games scoreable | Econ game-mean | Econ median | Econ beat close | Margin-adj game-mean | Margin-adj median | Margin-adj beat close | Scoreable/eligible | Per-pick econ mean | Per-pick margin-adj mean |';
  const CLV_DIVIDER = '|---|---|---|---|---|---|---|---|---|---|---|';
  lines.push(CLV_HEADER);
  lines.push(CLV_DIVIDER);
  for (const stat of models) lines.push(clvRow(stat));
  lines.push('');
  lines.push('### Deterministic baselines');
  lines.push('');
  lines.push(CLV_HEADER);
  lines.push(CLV_DIVIDER);
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
      '| Participant | Picks | Scoreable/eligible | Games scoreable | Econ mean | Econ median | Econ beat close | Margin-adj mean | Margin-adj median | Margin-adj beat close | Unscored (reason) |',
    );
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const { stat, market } of active) lines.push(marketRow(stat, market));
    lines.push('');
  }

  const withLadder = stats.filter((stat) => stat.totalsLadder !== null);
  if (withLadder.length > 0) {
    // Ranked by the ladder's own game-level mean, nulls last — same
    // own-column ranking rule as the per-market tables.
    withLadder.sort((a, b) => {
      const aMean = a.totalsLadder?.gameLevel.meanClvPct ?? null;
      const bMean = b.totalsLadder?.gameLevel.meanClvPct ?? null;
      if (aMean === null && bMean === null) return 0;
      if (aMean === null) return 1;
      if (bMean === null) return -1;
      return bMean - aMean;
    });
    lines.push(`## Totals ladder (\`${LADDER_VERSION}\` — every totals pick priced at its entry line)`);
    lines.push('');
    lines.push(
      `Generalized push-aware CLV \`100·(q_W·D_e + q_P − 1)\` (economic) and \`100·(q_W/q_entry + q_P − 1)\` (margin-adjusted), with q_W/q_P from the \`${LADDER_VERSION}\` negative-binomial ladder — mean solved from the close (push-conditioned at integer lines), evaluated at the ENTRY line, so moved lines are priced instead of discarded. At an unchanged half-line the ladder value equals the exact-line value; at an unchanged integer line it equals the conditional CLV shrunk by the push mass. The exact-line column repeats the conservative same-line-only reading from the per-market table above; signed movement needs no model (0 = unmoved).`,
    );
    lines.push('');
    lines.push(
      '| Participant | Totals picks | Ladder-scored | Ladder econ mean | Ladder econ median | Ladder margin-adj mean | Ladder margin-adj median | Exact-line econ mean (n) | Mean signed movement | Unscored (reason) |',
    );
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const stat of withLadder) lines.push(ladderRow(stat));
    lines.push('');
  }

  lines.push(`## De-vig sensitivity (\`${SHIN_DEVIG_METHOD}\` vs \`${PROPORTIONAL_DEVIG_METHOD}\`)`);
  lines.push('');
  lines.push(
    'Both metrics recomputed under the Shin de-vig, from the raw two-sided quotes at entry and close. This is a within-participant method-sensitivity readout (pooled game-level means), not a comparison surface. It is a PAIRED comparison: a pick enters only when both methods produced a value, and the proportional columns are re-aggregated over that identical paired set — so a Δ can only ever reflect the method, never coverage (unpaired picks are disclosed in the paired-picks column; a close whose stored probabilities disagree with its raw quotes is refused outright as `close_inconsistent`). If the deltas are small, the conclusions do not depend on the de-vig choice.',
  );
  lines.push('');
  lines.push(
    '| Participant | Paired picks (econ · margin-adj) | Econ (proportional, paired) | Econ (shin) | Δ | Margin-adj (proportional, paired) | Margin-adj (shin) | Δ |',
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const stat of models) lines.push(sensitivityRow(stat));
  for (const stat of baselines) lines.push(sensitivityRow(stat));
  lines.push('');

  const moved = scored.filter((p) => p.result.unscoredReason === 'line_moved');
  if (moved.length > 0) {
    lines.push('## Moved lines (exact-line CLV unavailable; ladder CLV + favorable movement reported)');
    lines.push('');
    lines.push(
      '| Participant | Game | Market | Selection | Entry line | Closing line | Favorable movement | Ladder econ | Ladder margin-adj |',
    );
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const pick of moved) {
      lines.push(
        `| ${pick.participantId} | \`${pick.gameId}\` | ${pick.market} | ${pick.selection} | ${pick.line ?? '—'} | ${pick.close?.line ?? '—'} | ${fmt(pick.result.lineMovementFavorable)} | ${fmt(pick.ladder?.economicClvPct ?? null)} | ${fmt(pick.ladder?.marginAdjustedClvPct ?? null)} |`,
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
