import { describeErrorWithStack, envValue } from './config.js';
import { printError, printLine } from './console.js';
import { loadDotEnv } from './env.js';
import { fetchClosingLinesByMarket, fetchGamesRowsByIds } from './fetchers.js';
import { writeNdjson } from './records.js';
import {
  assertNonEmptyCorpus,
  AUDIT_COMPLETENESS_DISCLOSURE,
  buildCloseScheduleAudit,
  ScheduleAuditError,
} from './scheduleAudit.js';
import { SCHEDULE_CHANGE_TOLERANCE_MS } from './scoring.js';

/**
 * ospex-benchmark close-schedule audit — measures the captured closing-line
 * corpus, as observed by ONE keyset walk, against the scorer's close-timing
 * checks, so the checks' real cost and yield are published numbers rather
 * than estimates. The observation is a LOWER BOUND on the table, never a
 * census — see the `enumerationSemantics` field stamped into every artifact.
 *
 * Read-only over the public anon key: closing_lines + games via PostgREST,
 * the same rows any outside reproducer can fetch. Nothing is written back.
 *
 * Enumeration posture: the CLAIMED source table (closing_lines on the
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
 * audit has no run file, so it cannot use the scorer's reference (the FROZEN
 * bundle start the model saw). It compares a close's `lock_time` against the
 * two references that ARE reachable from the public read path, and publishes
 * both because neither subsumes the other:
 *
 * - `games.match_time` — mutable in both directions. Asks whether the close
 *   still agrees with the schedule row as it stands NOW, so a row that moved
 *   after capture reads as a mismatch even when the close was captured
 *   correctly against the value of the moment.
 * - `games.earliest_match_time` — the MONOTONE FLOOR, which never rises. Asks
 *   whether the close was anchored to a start we ever actually believed, so a
 *   ROLLBACK cannot turn a correctly-captured close into an apparent mismatch.
 *   Nullable; a null propagates as null, never as zero drift.
 *
 * Same classifier and tolerance as the scorer, different references — none of
 * these numbers are interchangeable with each other or with the scorer's.
 *
 * What NEITHER reference can see: `lock_time` is copied from
 * `games.match_time` at capture, so a start that moved earlier without the
 * upstream capture noticing leaves the lock, the schedule row and the floor on
 * the same wrong instant, and both drifts read as zero. The post-start-poll
 * count is the only signal here sourced from feed behaviour rather than from
 * the schedule record itself.
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
    `ospex-benchmark close-schedule audit — captured closes observed by one keyset walk on ${options.network} ` +
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
  // FAIL CLOSED on an empty corpus. "0 closes, 0 problems" is the most
  // dangerous possible clean bill of health: a zero-row walk is
  // indistinguishable from one whose filter silently narrowed to nothing. The
  // reader refuses a records-less dataset for the same reason, so the CLI can
  // no longer emit an artifact its own verifier rejects.
  assertNonEmptyCorpus(closes.length, options.network);
  // NOT "keyset-complete". The walk enumerates by identity key, which rules
  // out the offset-pagination failure (a concurrent insert shifting page
  // boundaries) but does NOT prove the enumeration saw every committed row —
  // see the completeness note printed at the end of this run.
  printLine(`closing lines: ${closes.length} rows (all markets, one keyset walk over the id)`);

  const gameIds = [...new Set(closes.map((close) => close.jsonodds_id))];
  const games = await fetchGamesRowsByIds(
    supabaseUrl,
    supabaseAnonKey,
    options.network,
    gameIds,
  );
  printLine(`games rows joined: ${games.length} for ${gameIds.length} distinct games`);

  // Every refusal (duplicate keys, orphan closes, unclassifiable timestamps)
  // lives in the pure builder, so the CLI is I/O plus rendering only.
  const { meta, records } = buildCloseScheduleAudit({
    network: options.network,
    toleranceMs: options.toleranceMs,
    closes,
    games,
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
  printLine(
    `  schedule_changed vs games.earliest_match_time (monotone floor): ` +
      `${meta.scheduleChangedVsEarliestMatchTimeAny}` +
      `${meta.earliestMatchTimeNull > 0 ? ` (${meta.earliestMatchTimeNull} rows have no floor — not established, not counted either way)` : ''}`,
  );
  printLine(
    `  the two references DISAGREE on: ${meta.scheduleVerdictsDisagree} rows`,
  );
  printLine(`  confidence: ${JSON.stringify(meta.confidence)}`);
  // An unnarrowed walk reports all three markets. One key here means the
  // enumeration was narrowed — the one incompleteness the meta arithmetic
  // cannot catch, since every count derives from the same fetch.
  printLine(`  markets (all three = an unfiltered walk): ${JSON.stringify(meta.markets)}`);
  printLine(`  poll_gap_seconds null: ${meta.pollGapNull}`);
  printLine(
    `  value_captured_at after lock_time: ${meta.valueCapturedAfterLockAny}; ` +
      `after games.match_time: ${meta.valueCapturedAfterMatchTimeAny}`,
  );
  printLine(`  lock_time range: ${JSON.stringify(meta.lockTimeRange)}`);
  printLine('');
  printLine(
    'NOTE: neither schedule comparison is against the frozen bundle start the model saw — ' +
      'that reference only exists inside a run file. The games.match_time comparison asks ' +
      'whether a close still agrees with the schedule row AS IT STANDS NOW, so a row that ' +
      'moved after capture reads as a mismatch even when the close was captured correctly. ' +
      'The games.earliest_match_time comparison asks whether it was anchored to a start we ' +
      'ever believed; that floor never rises, so a rollback cannot manufacture a mismatch. ' +
      'Both are published because neither subsumes the other. What NEITHER can see: ' +
      'lock_time is copied from games.match_time at capture, so a start that moved earlier ' +
      'unnoticed leaves the lock, the row AND the floor on the same wrong instant and both ' +
      'drifts read as ZERO. Only the close_after_start count is sourced from feed behaviour ' +
      'rather than the schedule record.',
  );
  printLine('');
  printLine(AUDIT_COMPLETENESS_DISCLOSURE);
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
