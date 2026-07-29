import { describeErrorWithStack, envValue } from './config.js';
import { printError, printLine } from './console.js';
import { loadDotEnv } from './env.js';
import { fetchClosingLinesByMarket, fetchGamesRowsByIds } from './fetchers.js';
import { writeNdjson } from './records.js';
import {
  closeScheduleAuditMeta,
  closeScheduleAuditRecord,
  ScheduleAuditError,
} from './scheduleAudit.js';
import { SCHEDULE_CHANGE_TOLERANCE_MS } from './scoring.js';
import type { CloseScheduleAuditRecord } from './scheduleAudit.js';

/**
 * ospex-benchmark close-schedule audit — measures the WHOLE captured
 * closing-line corpus against the scorer's close-timing checks, so the
 * checks' real cost and yield are published numbers rather than estimates.
 *
 * Read-only over the public anon key: closing_lines + games via PostgREST,
 * the same rows any outside reproducer can fetch. Nothing is written back.
 *
 * Completeness posture: the CLAIMED source table (closing_lines on the
 * network, ALL markets) is enumerated directly with keyset pagination on
 * its identity key — never via a pre-enumerated game list, which would
 * silently hide closes whose games row is missing or unexpected. Games are
 * then looked up by pinned ids. Every close seen is written and accounted
 * for by an exclusive verdict, a close without a games row refuses the
 * whole snapshot, an unclassifiable timestamp refuses the whole snapshot,
 * and the dataset reader re-checks that arithmetic on every load.
 *
 * JOIN KEY: `(network, jsonodds_id)` only. `closing_lines.contest_id` is
 * deliberately never read — it carries residue from an earlier deployment
 * epoch, so filtering or grouping on it would silently mix two different
 * contest-id spaces. `games` is keyed on `(network, jsonodds_id)`, so this
 * join cannot fan out.
 *
 * REFERENCE-TIME CAVEAT, restated here because it is the whole point: this
 * audit compares a close's `lock_time` against the CURRENT schedule row
 * (`games.match_time`), which is the only reference reachable without a run
 * file. The scorer's own `scheduleChanged` compares against the FROZEN
 * bundle start the model saw. Same classifier and tolerance, different
 * reference — the two numbers are not interchangeable. And because
 * `lock_time` is copied from `games.match_time` at capture, a start that
 * moved earlier without the upstream capture noticing leaves BOTH sides
 * equal and reads as zero drift; the post-start-poll count is the only
 * signal here sourced from feed behaviour rather than from the schedule
 * record itself.
 */

class UsageError extends Error {}

const NETWORK = 'polygon';

const USAGE = `Usage: yarn audit:closes [options]

Options:
  --out PATH        Output dataset path.
                    Default: out/close-schedule-audit-<utc-date>.ndjson
  --network NAME    Network to audit (default: ${NETWORK}).
  --tolerance MS    Schedule-change tolerance in ms
                    (default: ${SCHEDULE_CHANGE_TOLERANCE_MS}, the scoring policy value).
  -h, --help        Show this help.

Requires SUPABASE_URL and SUPABASE_ANON_KEY (public read-only anon key);
a local gitignored .env is loaded automatically.`;

function parseArgs(argv: string[]): {
  outPath: string | null;
  network: string;
  toleranceMs: number;
} {
  let outPath: string | null = null;
  let network = NETWORK;
  let toleranceMs = SCHEDULE_CHANGE_TOLERANCE_MS;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--out': {
        const value = argv[i + 1];
        if (value === undefined) throw new UsageError('--out requires a value');
        outPath = value;
        i += 1;
        break;
      }
      case '--network': {
        const value = argv[i + 1];
        if (value === undefined) throw new UsageError('--network requires a value');
        network = value;
        i += 1;
        break;
      }
      case '--tolerance': {
        const value = argv[i + 1];
        if (value === undefined) throw new UsageError('--tolerance requires a value');
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 0) {
          throw new UsageError(`--tolerance must be a non-negative integer, got "${value}"`);
        }
        toleranceMs = parsed;
        i += 1;
        break;
      }
      case '-h':
      case '--help':
        printLine(USAGE);
        process.exit(0);
        break;
      default:
        throw new UsageError(`unknown argument: ${arg ?? ''}`);
    }
  }
  return { outPath, network, toleranceMs };
}

async function main(): Promise<number> {
  const loaded = loadDotEnv();
  const options = parseArgs(process.argv.slice(2));
  printLine(
    `ospex-benchmark close-schedule audit — every captured close on ${options.network} ` +
      `(tolerance ${options.toleranceMs}ms)`,
  );
  if (loaded.length > 0) {
    printLine(`loaded ${loaded.length} env var(s) from .env: ${loaded.join(', ')}`);
  }

  const supabaseUrl = envValue('SUPABASE_URL');
  const supabaseAnonKey = envValue('SUPABASE_ANON_KEY');
  if (supabaseUrl === undefined || supabaseAnonKey === undefined) {
    throw new UsageError(
      'the audit needs the public read path configured — missing env: ' +
        [
          ...(supabaseUrl === undefined ? ['SUPABASE_URL'] : []),
          ...(supabaseAnonKey === undefined ? ['SUPABASE_ANON_KEY'] : []),
        ].join(', '),
    );
  }

  // market: null — all three markets in ONE keyset walk over the identity PK.
  const closes = await fetchClosingLinesByMarket(
    supabaseUrl,
    supabaseAnonKey,
    options.network,
    null,
  );
  printLine(`closing lines: ${closes.length} rows (all markets, keyset-complete)`);
  const keys = new Set(closes.map((close) => `${close.jsonodds_id}:${close.market}`));
  if (keys.size !== closes.length) {
    // (network, jsonodds_id, market) is unique upstream; a duplicate means
    // the source is not what we think it is.
    throw new Error(
      'duplicate closing-line rows for one (game, market) — refusing the snapshot',
    );
  }

  const gameIds = [...new Set(closes.map((close) => close.jsonodds_id))];
  const games = await fetchGamesRowsByIds(
    supabaseUrl,
    supabaseAnonKey,
    options.network,
    gameIds,
  );
  const gameById = new Map(games.map((game) => [game.jsonodds_id, game]));
  const orphans = closes.filter((close) => !gameById.has(close.jsonodds_id));
  if (orphans.length > 0) {
    // A close with no schedule row has no reference time at all; every
    // count below would be a guess.
    throw new Error(
      `${orphans.length} closing line(s) have no games row ` +
        `(first: ${orphans[0]?.jsonodds_id ?? ''}) — refusing an unclassifiable snapshot`,
    );
  }
  printLine(`games rows joined: ${games.length} for ${gameIds.length} distinct games`);

  const records: CloseScheduleAuditRecord[] = [];
  for (const close of closes) {
    const game = gameById.get(close.jsonodds_id);
    if (game === undefined) throw new Error('unreachable: orphan closes were refused above');
    records.push(closeScheduleAuditRecord(close, game, options.toleranceMs));
  }
  records.sort((a, b) =>
    a.lockTime === b.lockTime
      ? `${a.gameId}:${a.market}`.localeCompare(`${b.gameId}:${b.market}`)
      : a.lockTime.localeCompare(b.lockTime),
  );

  const meta = closeScheduleAuditMeta({
    network: options.network,
    toleranceMs: options.toleranceMs,
    closesSeen: closes.length,
    gamesJoined: games.length,
    records,
    generatedAt: new Date().toISOString(),
  });

  const outPath =
    options.outPath ??
    `out/close-schedule-audit-${new Date().toISOString().slice(0, 10)}.ndjson`;
  writeNdjson(outPath, [meta, ...records]);

  const pct = (n: number): string =>
    meta.closesSeen === 0 ? '0%' : `${((100 * n) / meta.closesSeen).toFixed(2)}%`;
  printLine('');
  printLine(`verdicts (exclusive, sums to ${meta.closesSeen}):`);
  for (const [verdict, count] of Object.entries(meta.verdicts)) {
    printLine(`  ${verdict.padEnd(18)} ${String(count).padStart(6)}  ${pct(count)}`);
  }
  printLine('');
  printLine('raw counts (non-exclusive):');
  printLine(
    `  close_after_start (feed still quoting past lock): ${meta.closeAfterStartAny} rows ` +
      `across ${meta.postStartPollGames} games — ${pct(meta.closeAfterStartAny)}`,
  );
  printLine(`    by sport: ${JSON.stringify(meta.postStartPollBySport)}`);
  printLine(
    `  schedule_changed vs games.match_time: ${meta.scheduleChangedVsMatchTimeAny} ` +
      `(${meta.lockEarlierThanMatchTime} lock-earlier, ${meta.lockLaterThanMatchTime} lock-later)`,
  );
  printLine(`  confidence: ${JSON.stringify(meta.confidence)}`);
  printLine(`  poll_gap_seconds null: ${meta.pollGapNull}`);
  printLine(
    `  value_captured_at after lock_time: ${meta.valueCapturedAfterLockAny}; ` +
      `after games.match_time: ${meta.valueCapturedAfterMatchTimeAny}`,
  );
  printLine(`  lock_time range: ${JSON.stringify(meta.lockTimeRange)}`);
  printLine('');
  printLine(
    'NOTE: this compares lock_time against the CURRENT games.match_time, not against a ' +
      'frozen bundle start, and lock_time is copied from games.match_time at capture — a ' +
      'start that moved earlier unnoticed reads as ZERO drift here. Only the ' +
      'close_after_start count is sourced from feed behaviour rather than the schedule record.',
  );
  printLine(`dataset: ${outPath}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      printError(`error: ${error.message}`);
      printError('');
      printError(USAGE);
      process.exitCode = 2;
      return;
    }
    if (error instanceof ScheduleAuditError) {
      printError(`audit refused the snapshot: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    printError(describeErrorWithStack(error));
    process.exitCode = 1;
  });
