import { reportedModelId } from './records.js';
import type { BuildResult } from './bundle.js';
import type { RunContext } from './records.js';
import type { CollisionCheckResult } from './providers/family.js';
import type { ArmRunResult, BaselineDecision, GameBundle } from './types.js';

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
  return `| ${matchup} | ${game.scheduledStartUtc} | ${moneyline} | ${runLine} | ${totals} | ${describeFavorite(game)} |`;
}

export function buildSummaryMarkdown(
  ctx: RunContext,
  build: BuildResult,
  armResults: ArmRunResult[],
  baselineDecisions: BaselineDecision[],
  collision: CollisionCheckResult,
): string {
  const { bundle, bundleSha256, excluded } = build;
  const lines: string[] = [];

  lines.push(`# Ospex shadow smoke run — ${ctx.slateDate}`);
  lines.push('');
  lines.push(`**Label: \`SMOKE_V0_NOT_A_COHORT\`** — pipeline shakedown, not a scored cohort.`);
  lines.push(
    'Entry prices were captured late (lines opened days earlier); nothing here may appear on a leaderboard.',
  );
  lines.push('');
  lines.push(`- Run: \`${ctx.runId}\` (${ctx.mode})`);
  lines.push(`- Generated: ${ctx.createdAt}`);
  lines.push(`- Bundle SHA-256: \`${bundleSha256}\``);
  lines.push(`- Decision cutoff: ${bundle.cutoffAt} (earliest first pitch)`);
  lines.push(`- Execution policy (declared, not executed): \`${ctx.executionPolicy}\``);
  lines.push('');

  if (collision.failures.length > 0) {
    lines.push('## ❌ RUN FAILED — PROVIDER_COLLISION');
    lines.push('');
    for (const failure of collision.failures) lines.push(`- ${failure}`);
    lines.push('');
  }

  lines.push(`## Slate (${bundle.games.length} eligible games)`);
  lines.push('');
  lines.push('| Game (away at home) | First pitch (UTC) | Moneyline (away/home) | Run line | Total | ML favorite |');
  lines.push('|---|---|---|---|---|---|');
  for (const game of bundle.games) lines.push(slateRow(game));
  lines.push('');
  if (excluded.length > 0) {
    lines.push(`Excluded games (${excluded.length}):`);
    lines.push('');
    for (const e of excluded) lines.push(`- \`${e.slug}\` (\`${e.gameId}\`): ${e.reason}`);
    lines.push('');
  }

  lines.push('## Arms');
  lines.push('');
  lines.push('| Participant | Outcome | Reported model | Repair used | Latency (ms) | Tokens (in/out) |');
  lines.push('|---|---|---|---|---|---|');
  for (const result of armResults) {
    const accepted = result.repairUsed && result.repair !== null ? result.repair : result.attempt;
    const tokens = accepted.usage
      ? `${accepted.usage.inputTokens ?? '?'} / ${accepted.usage.outputTokens ?? '?'}`
      : '—';
    lines.push(
      `| ${result.arm.participantId} | **${result.outcome}** | ${reportedModelId(result) ?? '—'} | ${result.repairUsed ? 'yes' : 'no'} | ${accepted.latencyMs ?? '—'} | ${tokens} |`,
    );
  }
  lines.push('');

  const invalidArms = armResults.filter((r) => r.validationErrors.length > 0);
  if (invalidArms.length > 0) {
    lines.push('### Validation findings');
    lines.push('');
    for (const result of invalidArms) {
      lines.push(`- **${result.arm.participantId}** (${result.outcome}):`);
      for (const error of result.validationErrors.slice(0, 8)) lines.push(`  - ${error}`);
      if (result.validationErrors.length > 8) {
        lines.push(`  - … ${result.validationErrors.length - 8} more (see NDJSON record)`);
      }
    }
    lines.push('');
  }

  const validArms = armResults.filter((r) => r.outcome === 'valid' && r.parsed !== null);
  if (validArms.length > 0) {
    lines.push('## Moneyline picks (valid arms)');
    lines.push('');
    const header = validArms.map((r) => r.arm.participantId).join(' | ');
    lines.push(`| Game | ${header} |`);
    lines.push(`|---|${validArms.map(() => '---').join('|')}|`);
    for (const game of bundle.games) {
      const picks = validArms.map((result) => {
        const forecast = result.parsed?.games
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
      `(${bundle.games.length} games): ${baselineParticipants.map((p) => `\`${p}\``).join(', ')}.`,
  );
  lines.push('');

  lines.push('## Findings and caveats');
  lines.push('');
  lines.push(
    '- Probable starting pitchers are not exposed by the existing public read path; the bundle ships without them (`probableStartingPitchers: null`).',
  );
  lines.push(
    '- Token/cost accounting: token counts are recorded verbatim from provider usage metadata; dollar cost is recorded as `null` rather than computed from a rate card that could go stale (never fabricated).',
  );
  for (const warning of collision.warnings) lines.push(`- ${warning}`);
  const cutoffMs = Date.parse(bundle.cutoffAt);
  const lateArms = armResults.filter((r) => {
    const accepted = r.repairUsed && r.repair !== null ? r.repair : r.attempt;
    return accepted.responseAt !== null && Date.parse(accepted.responseAt) > cutoffMs;
  });
  if (lateArms.length > 0) {
    const suffix =
      ctx.mode === 'dry-run'
        ? ' (expected in a dry run: the fixture slate is not date-relative)'
        : '';
    lines.push(
      `- Responses arriving after the decision cutoff: ${lateArms.map((r) => r.arm.participantId).join(', ')}${suffix}.`,
    );
  }
  lines.push('');

  lines.push('## Join key');
  lines.push('');
  lines.push(
    'Every decision is keyed by `gameId` — the upstream odds-feed event UUID. The production closing-line capture stores closes under the same identifier (`(network, jsonodds_id, market)`), so each pick joins to its closing line for scoring after the All-Star break.',
  );
  lines.push('');

  return lines.join('\n');
}
