import { failuresByCode, reportedModelIdsByArm } from './records.js';
import type { BuildResult } from './bundle.js';
import type { RunContext } from './records.js';
import type { CollisionCheckResult } from './providers/family.js';
import type { ArmGameResult, ArmOutcome, BaselineDecision, GameBundle } from './types.js';

const OUTCOME_ORDER: ArmOutcome[] = [
  'valid',
  'invalid_schema',
  'timeout',
  'rate_limited',
  'cutoff_missed',
  'credential_missing',
  'provider_error',
];

function formatHandicap(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function describeFavorite(game: GameBundle): string {
  const ml = game.markets.moneyline;
  if (ml.awayDecimal === ml.homeDecimal) return 'pick-em';
  return ml.awayDecimal < ml.homeDecimal
    ? `${game.awayTeam} (away)`
    : `${game.homeTeam} (home)`;
}

function slateRow(game: GameBundle): string {
  const ml = game.markets.moneyline;
  const rl = game.markets.runLine;
  const total = game.markets.total;
  const matchup = `${game.awayTeam} at ${game.homeTeam}`;
  const moneyline = `${ml.awayDecimal} / ${ml.homeDecimal}`;
  const runLine =
    `${game.awayTeam} ${formatHandicap(rl.awayHandicap)} @ ${rl.awayDecimal} · ` +
    `${game.homeTeam} ${formatHandicap(rl.homeHandicap)} @ ${rl.homeDecimal}`;
  const totals = `${total.line} (o ${total.overDecimal} / u ${total.underDecimal})`;
  const pitchers = game.probableStartingPitchers
    ? `${game.probableStartingPitchers.away ?? '—'} / ${game.probableStartingPitchers.home ?? '—'}`
    : '—';
  return `| ${matchup} | ${game.scheduledStartUtc} | ${moneyline} | ${runLine} | ${totals} | ${pitchers} | ${describeFavorite(game)} |`;
}

export function buildSummaryMarkdown(
  ctx: RunContext,
  build: BuildResult,
  armGameResults: ArmGameResult[],
  baselineDecisions: BaselineDecision[],
  collision: CollisionCheckResult,
): string {
  const { slateBundle, slateSha256, excluded } = build;
  const lines: string[] = [];
  const arms = [...new Map(armGameResults.map((r) => [r.arm.participantId, r.arm])).values()];
  const byArm = (participantId: string): ArmGameResult[] =>
    armGameResults.filter((r) => r.arm.participantId === participantId);
  const reportedByArm = reportedModelIdsByArm(armGameResults);

  const watch = ctx.watch;
  lines.push(
    watch !== undefined
      ? `# Ospex line-open watch run — ${ctx.slateDate}`
      : `# Ospex shadow smoke run — ${ctx.slateDate}`,
  );
  lines.push('');
  lines.push(`**Label: \`SMOKE_V0_NOT_A_COHORT\`** — pipeline shakedown, not a scored cohort.`);
  lines.push(
    watch !== undefined
      ? `Entry prices are the first-eligible board, fired at detection: board completed ${watch.boardCompletedAt}, ` +
          `detected ${watch.detectedAt} (opener age ${watch.openerAgeMinutes}m, threshold ${watch.lateThresholdMinutes}m). ` +
          'Still plumbing validation — nothing here may appear on a leaderboard.'
      : 'Entry prices were captured late (lines opened days earlier); nothing here may appear on a leaderboard.',
  );
  lines.push('');
  lines.push(
    `- Run: \`${ctx.runId}\` (${ctx.mode}${ctx.clockMode === 'synthetic-fixture' ? ', synthetic fixture clock' : ''})`,
  );
  lines.push(`- Generated: ${ctx.createdAt}`);
  lines.push(`- Slate SHA-256: \`${slateSha256}\``);
  lines.push(
    `- Dispatch: per game (sequential games, four arms concurrent per game; each game's cutoff is its own first pitch)`,
  );
  lines.push(`- Execution policy (declared, not executed): \`${ctx.executionPolicy}\``);
  lines.push('');

  if (collision.failures.length > 0) {
    const codes = [...failuresByCode(collision.failures).keys()];
    lines.push(`## ❌ RUN FAILED — ${codes.join(' + ')}`);
    lines.push('');
    for (const failure of collision.failures) lines.push(`- ${failure}`);
    lines.push('');
  }

  lines.push(`## Slate (${slateBundle.games.length} eligible games)`);
  lines.push('');
  lines.push(
    '| Game (away at home) | First pitch (UTC) | Moneyline (away/home) | Run line | Total | Probable pitchers (away/home) | ML favorite |',
  );
  lines.push('|---|---|---|---|---|---|---|');
  for (const game of slateBundle.games) lines.push(slateRow(game));
  lines.push('');
  if (excluded.length > 0) {
    lines.push(`Excluded games (${excluded.length}):`);
    lines.push('');
    for (const e of excluded) lines.push(`- \`${e.slug}\` (\`${e.gameId}\`): ${e.reason}`);
    lines.push('');
  }

  lines.push('## Arms (outcomes across the slate)');
  lines.push('');
  lines.push(`| Participant | ${OUTCOME_ORDER.join(' | ')} | Repairs | Reported model(s) |`);
  lines.push(`|---|${OUTCOME_ORDER.map(() => '---').join('|')}|---|---|`);
  for (const arm of arms) {
    const results = byArm(arm.participantId);
    const counts = OUTCOME_ORDER.map(
      (outcome) => results.filter((r) => r.outcome === outcome).length,
    );
    const repairs = results.filter((r) => r.repairUsed).length;
    const reported = reportedByArm.get(arm.participantId) ?? [];
    lines.push(
      `| ${arm.participantId} | ${counts.join(' | ')} | ${repairs} | ${reported.length > 0 ? reported.join(', ') : '—'} |`,
    );
  }
  lines.push('');

  lines.push('## Per-game outcomes');
  lines.push('');
  lines.push(`| Game | ${arms.map((a) => a.provider).join(' | ')} |`);
  lines.push(`|---|${arms.map(() => '---').join('|')}|`);
  for (const game of slateBundle.games) {
    const cells = arms.map((arm) => {
      const result = byArm(arm.participantId).find((r) => r.gameId === game.gameId);
      if (!result) return '—';
      return `${result.outcome}${result.repairUsed ? ' (r)' : ''}`;
    });
    lines.push(`| ${game.awayTeam} at ${game.homeTeam} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  const invalid = armGameResults.filter((r) => r.validationErrors.length > 0);
  if (invalid.length > 0) {
    lines.push('### Validation findings');
    lines.push('');
    for (const result of invalid) {
      const repairNote =
        result.repairTransport !== null && result.repairTransport !== 'ok'
          ? `; repair transport: ${result.repairTransport}`
          : '';
      lines.push(
        `- **${result.arm.participantId}** on \`${result.gameId}\` (${result.outcome}${repairNote}):`,
      );
      for (const error of result.validationErrors.slice(0, 6)) lines.push(`  - ${error}`);
      if (result.validationErrors.length > 6) {
        lines.push(`  - … ${result.validationErrors.length - 6} more (see NDJSON record)`);
      }
    }
    lines.push('');
  }

  const validResults = armGameResults.filter((r) => r.outcome === 'valid' && r.parsed !== null);
  if (validResults.length > 0) {
    lines.push('## Moneyline picks (valid arm-games)');
    lines.push('');
    lines.push(`| Game | ${arms.map((a) => a.participantId).join(' | ')} |`);
    lines.push(`|---|${arms.map(() => '---').join('|')}|`);
    for (const game of slateBundle.games) {
      const picks = arms.map((arm) => {
        const result = validResults.find(
          (r) => r.arm.participantId === arm.participantId && r.gameId === game.gameId,
        );
        const forecast = result?.parsed?.games
          .find((g) => g.gameId === game.gameId)
          ?.forecasts.find((f) => f.market === 'moneyline');
        return forecast ? `${forecast.selection} (${forecast.probabilities.win})` : '—';
      });
      lines.push(`| ${game.awayTeam} at ${game.homeTeam} | ${picks.join(' | ')} |`);
    }
    lines.push('');
  }

  const baselineParticipants = [...new Set(baselineDecisions.map((d) => d.participantId))];
  lines.push('## Deterministic baselines');
  lines.push('');
  lines.push(
    `${baselineParticipants.length} baseline participants produced ${baselineDecisions.length} common-cutoff decisions ` +
      `(${slateBundle.games.length} games): ${baselineParticipants.map((p) => `\`${p}\``).join(', ')}.`,
  );
  lines.push('');

  lines.push('## Findings and caveats');
  lines.push('');
  const withPitchers = slateBundle.games.filter((g) => g.probableStartingPitchers !== null).length;
  if (withPitchers === 0) {
    lines.push(
      '- Probable starting pitchers are not exposed by the existing public read path; the bundle ships without them (`probableStartingPitchers: null`). They populate automatically if the upstream read path gains the fields.',
    );
  } else {
    lines.push(
      `- Probable starting pitchers present for ${withPitchers}/${slateBundle.games.length} games (read from the games row).`,
    );
  }
  lines.push(
    '- Token accounting: the provider usage object is stored VERBATIM per response (`usageRaw`, including reasoning-token fields) alongside normalized counts; dollar cost is recorded as `null` rather than computed from a rate card that could go stale (never fabricated).',
  );
  for (const warning of collision.warnings) lines.push(`- ${warning}`);
  const cutoffMissed = armGameResults.filter((r) => r.outcome === 'cutoff_missed').length;
  if (cutoffMissed > 0) {
    lines.push(
      `- Cutoff enforcement: ${cutoffMissed} arm-game(s) recorded \`cutoff_missed\` — the decision window closed before an acceptable response existed; no decision records were emitted for them.`,
    );
  }
  lines.push('');

  lines.push('## Join key');
  lines.push('');
  lines.push(
    'Every decision is keyed by `gameId` — the upstream odds-feed event identifier. The production closing-line capture stores closes per game and market under the same identifier, so each pick joins to its closing line for scoring after the All-Star break.',
  );
  lines.push('');

  return lines.join('\n');
}
