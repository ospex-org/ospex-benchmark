import type { ParticipantStats, ScoredPick, SourceRun } from './scoring.js';

/**
 * Human-readable scorecard. Never starts with raw JSON; leads with the
 * honest-labeling banner and states the metric precisely: single-source
 * reference-closing CLV on decisions (no execution), late entries.
 */

function fmt(value: number | null, suffix = ''): string {
  return value === null ? '—' : `${value}${suffix}`;
}

function statsRow(stat: ParticipantStats): string {
  const unscored = Object.entries(stat.unscoredByReason)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ');
  return (
    `| ${stat.participantId} | ${stat.picks} | ${stat.primaryScoreable} | ` +
    `${fmt(stat.meanClvPct)} | ${fmt(stat.medianClvPct)} | ${fmt(stat.beatClosePct, '%')} | ` +
    `${stat.conditionalOnly} | ${unscored || '—'} |`
  );
}

export function buildScorecardMarkdown(
  run: SourceRun,
  scored: ScoredPick[],
  stats: ParticipantStats[],
  scoredAt: string,
): string {
  const lines: string[] = [];
  lines.push(`# Reference-closing CLV scorecard — ${run.slateDate}`);
  lines.push('');
  lines.push('**Label: `SMOKE_V0_NOT_A_COHORT`** — pipeline shakedown, not a scored cohort.');
  lines.push(
    'Entry prices were captured LATE (lines opened days earlier), so this CLV does not reflect a real early-entry policy. This data must never appear on a leaderboard.',
  );
  lines.push('');
  lines.push(`- Source run: \`${run.runId}\` (slate sha \`${run.slateSha256.slice(0, 16)}…\`)`);
  lines.push(`- Scored: ${scoredAt}`);
  lines.push(
    '- Metric: **reference-closing CLV** in expected-ROI percentage points — the frozen entry price against the proportional no-vig close of the same contract from a single reference source. Decision CLV only; nothing was executed.',
  );
  lines.push(
    '- Policy: `fresh`-confidence closes only; price CLV only at the unchanged line (moved lines report signed favorable movement instead); integer push-capable lines report separately-labeled conditional CLV, never pooled into primary.',
  );
  lines.push('');

  lines.push('## Participants');
  lines.push('');
  lines.push(
    '| Participant | Picks | Primary-scoreable | Mean CLV % | Median CLV % | Beat close | Conditional-only | Unscored (reason) |',
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const stat of stats.filter((s) => s.kind === 'model')) lines.push(statsRow(stat));
  lines.push('');
  lines.push('### Deterministic baselines');
  lines.push('');
  lines.push(
    '| Participant | Picks | Primary-scoreable | Mean CLV % | Median CLV % | Beat close | Conditional-only | Unscored (reason) |',
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const stat of stats.filter((s) => s.kind === 'baseline')) lines.push(statsRow(stat));
  lines.push('');

  lines.push('## By market (models)');
  lines.push('');
  lines.push('| Participant | Market | Picks | Scoreable | Mean CLV % |');
  lines.push('|---|---|---|---|---|');
  for (const stat of stats.filter((s) => s.kind === 'model')) {
    for (const [market, m] of Object.entries(stat.byMarket)) {
      lines.push(
        `| ${stat.participantId} | ${market} | ${m.picks} | ${m.scoreable} | ${fmt(m.meanClvPct)} |`,
      );
    }
  }
  lines.push('');

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
    '- Per-pick aggregates, unclustered: the four models saw the same games, so rows are not independent samples.',
  );
  lines.push('- No execution layer existed: decision CLV only, no fills, no execution CLV.');
  lines.push('');
  return lines.join('\n');
}
