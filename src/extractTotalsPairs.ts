import { describeErrorWithStack, envValue } from './config.js';
import { printError, printLine } from './console.js';
import { loadDotEnv } from './env.js';
import { fetchGamesRowsByIds, fetchTotalsClosingLines } from './fetchers.js';
import {
  closingTotalRecord,
  rederivedConfidence,
  rederivedLockTimeRange,
} from './inhouseTotals.js';
import { writeNdjson } from './records.js';
import type { ClosingTotalRecord, InhouseTotalsMetaRecord } from './inhouseTotals.js';

/**
 * ospex-benchmark totals extraction — snapshots the production-captured MLB
 * closing totals (+ latched finals where they exist) into the committed
 * in-house dataset the dispersion fit reads (docs/TOTALS_DISPERSION.md).
 * Read-only over the public anon key: closing_lines + games via PostgREST,
 * the same rows any outside reproducer can fetch.
 *
 * Completeness posture: the CLAIMED source table (closing_lines totals) is
 * enumerated directly with keyset pagination on its identity key — never via
 * a pre-enumerated game list, which would silently hide closes whose games
 * row is missing or unexpected. Games are then looked up by pinned ids.
 * Every close seen is accounted for in the meta (written / non-MLB /
 * null-line), a close without a games row refuses the whole snapshot, and
 * the dataset reader re-checks that arithmetic on every load.
 */

class UsageError extends Error {}

const NETWORK = 'polygon';
const SPORT = 'mlb';

const USAGE = `Usage: yarn extract:totals [options]

Options:
  --out PATH   Output dataset path.
               Default: data/inhouse-totals-<utc-date>.ndjson
  -h, --help   Show this help.

Requires SUPABASE_URL and SUPABASE_ANON_KEY (public read-only anon key);
a local gitignored .env is loaded automatically.`;

function parseArgs(argv: string[]): { outPath: string | null } {
  let outPath: string | null = null;
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
      case '-h':
      case '--help':
        printLine(USAGE);
        process.exit(0);
        break;
      default:
        throw new UsageError(`unknown argument: ${arg ?? ''}`);
    }
  }
  return { outPath };
}

async function main(): Promise<number> {
  const loaded = loadDotEnv();
  const options = parseArgs(process.argv.slice(2));
  printLine(`ospex-benchmark totals extraction — ${SPORT} closing totals + finals (${NETWORK})`);
  if (loaded.length > 0) {
    printLine(`loaded ${loaded.length} env var(s) from .env: ${loaded.join(', ')}`);
  }

  const supabaseUrl = envValue('SUPABASE_URL');
  const supabaseAnonKey = envValue('SUPABASE_ANON_KEY');
  if (supabaseUrl === undefined || supabaseAnonKey === undefined) {
    throw new UsageError(
      'extraction needs the public read path configured — missing env: ' +
        [
          ...(supabaseUrl === undefined ? ['SUPABASE_URL'] : []),
          ...(supabaseAnonKey === undefined ? ['SUPABASE_ANON_KEY'] : []),
        ].join(', '),
    );
  }

  const closes = await fetchTotalsClosingLines(supabaseUrl, supabaseAnonKey, NETWORK);
  printLine(`closing lines: ${closes.length} totals rows (all sports, keyset-complete)`);
  const gameIds = [...new Set(closes.map((close) => close.jsonodds_id))];
  if (gameIds.length !== closes.length) {
    // One materialized totals row per (network, game) is the upstream
    // invariant; a duplicate means the source is not what we think it is.
    throw new Error('duplicate totals closing-line rows for one game — refusing the snapshot');
  }

  const games = await fetchGamesRowsByIds(supabaseUrl, supabaseAnonKey, NETWORK, gameIds);
  const gameById = new Map(games.map((game) => [game.jsonodds_id, game]));
  const orphans = closes.filter((close) => !gameById.has(close.jsonodds_id));
  if (orphans.length > 0) {
    // A close we cannot classify by sport would make every count below a
    // guess; refuse the whole snapshot rather than publish one.
    throw new Error(
      `${orphans.length} totals closing line(s) have no games row ` +
        `(first: ${orphans[0]?.jsonodds_id ?? ''}) — refusing an unclassifiable snapshot`,
    );
  }
  printLine(`games rows joined: ${games.length}`);

  const records: ClosingTotalRecord[] = [];
  let droppedNonMlb = 0;
  let droppedNullLine = 0;
  let finalsWithheldNotFinished = 0;
  for (const close of closes) {
    const game = gameById.get(close.jsonodds_id);
    if (game === undefined) throw new Error('unreachable: orphan closes were refused above');
    if (game.sport !== SPORT) {
      droppedNonMlb += 1;
      continue;
    }
    const record = closingTotalRecord(close, game);
    if (record === null) {
      droppedNullLine += 1;
      continue;
    }
    if (
      record.final === null &&
      game.home_score !== null &&
      game.away_score !== null &&
      game.final_type !== 'Finished'
    ) {
      finalsWithheldNotFinished += 1;
    }
    records.push(record);
  }
  records.sort((a, b) =>
    a.lockTime === b.lockTime
      ? a.gameId.localeCompare(b.gameId)
      : a.lockTime.localeCompare(b.lockTime),
  );

  const pairs = records.filter((record) => record.final !== null).length;

  // The record-derivable meta fields come from the SAME helpers the dataset
  // reader re-derives with, so writer and integrity check cannot drift.
  const meta: InhouseTotalsMetaRecord = {
    recordType: 'inhouse_totals_meta',
    network: NETWORK,
    sport: SPORT,
    totalsClosesSeen: closes.length,
    droppedNonMlb,
    records: records.length,
    pairs,
    droppedNullLine,
    finalsWithheldNotFinished,
    confidence: rederivedConfidence(records),
    lockTimeRange: rederivedLockTimeRange(records),
    generatedAt: new Date().toISOString(),
  };

  const outPath =
    options.outPath ??
    `data/inhouse-totals-${new Date().toISOString().slice(0, 10)}.ndjson`;
  writeNdjson(outPath, [meta, ...records]);

  printLine('');
  printLine(
    `records: ${records.length} ${SPORT} closing totals of ${closes.length} seen ` +
      `(${pairs} with finals; dropped ${droppedNonMlb} non-${SPORT}, ${droppedNullLine} null-line` +
      `${finalsWithheldNotFinished > 0 ? `; ${finalsWithheldNotFinished} scored-but-not-Finished kept without final` : ''})`,
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
    printError(describeErrorWithStack(error));
    process.exitCode = 1;
  });
