import type { ParticipantStats, ScoredPick, SourceRun } from './scoring.js';

/**
 * Human-readable scorecard. Never starts with raw JSON; leads with the
 * honest-labeling banner and states the metric precisely: single-source
 * reference-closing CLV on decisions (no execution), late entries. The
 * primary summary is the equal-weight game-level aggregate; per-pick numbers
 * are secondary. Coverage comes first — arm failures never leave the
 * denominators.
 */

function fmt(value: number | null, suffix = ''): string {
  return value === null ? '—' : `${value}${suffix}`;
}

function outcomes(stat: ParticipantStats): string {
  const entries = Object.entries(stat.armOutcomes);
  if (entries.length === 0) return '—';
  return entries.map(([outcome, count]) => `${outcome} ${count}`).join(' · ');
}

function unscored(stat: ParticipantStats): string {
  const entries = Object.entries(stat.unscoredByReason);
  if (entries.length === 0) return '—';
  return entries.map(([reason, count]) => `${reason} ${count}`).join(', ');
}

function coverageRow(stat: ParticipantStats): string {
  return (
    `| ${stat.participantId} | ${stat.games} | ${outcomes(stat)} | ${stat.eligibleMarkets} | ` +
    `${stat.validDecisions} | ${stat.primaryScoreable} | ${stat.conditionalOnly} | ${unscored(stat)} |`
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
    run.watch !== null
      ? `Entry prices are the first-eligible board, fired at detection under the late-detection gate ` +
          `(board completed ${run.watch.boardCompletedAt}, detected ${run.watch.detectedAt}, ` +
          `opener age ${run.watch.openerAgeMinutes}m ≤ threshold ${run.watch.lateThresholdMinutes}m — ` +
          'verified from run_meta by the integrity gate). Still plumbing validation — this data must never appear on a leaderboard.'
      : 'Entry prices were captured LATE (lines opened days earlier), so this CLV does not reflect a real early-entry policy. This data must never appear on a leaderboard.',
  );
  lines.push('');
  lines.push(`- Source run: \`${run.runId}\` (slate sha \`${run.slateSha256.slice(0, 16)}…\`, integrity verified)`);
  lines.push(`- Scored: ${scoredAt}`);
  lines.push(
    '- Metric: **reference-closing CLV** in expected-ROI percentage points — the frozen entry price against the proportional no-vig close of the same contract from a single reference source. Decision CLV only; nothing was executed.',
  );
  lines.push(
    '- Primary summary: **equal-weight game-level aggregate** (per-game mean CLV, averaged across games). Per-pick numbers are secondary.',
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

  lines.push('## Reference-closing CLV');
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

  lines.push('## By market (models, per-pick)');
  lines.push('');
  lines.push('| Participant | Market | Picks | Scoreable | Mean CLV % |');
  lines.push('|---|---|---|---|---|');
  for (const stat of models) {
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
    '- The four models saw the same games, so participant rows are not independent samples; uncertainty intervals are out of scope for the smoke.',
  );
  lines.push('- No execution layer existed: decision CLV only, no fills, no execution CLV.');
  lines.push('');
  return lines.join('\n');
}
