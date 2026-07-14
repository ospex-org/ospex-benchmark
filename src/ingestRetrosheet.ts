import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeErrorWithStack } from './config.js';
import { printError, printLine } from './console.js';
import { writeNdjson } from './records.js';
import {
  classifyOuts,
  parseGameLogLine,
  RETROSHEET_ATTRIBUTION,
  retrosheetGameRecord,
} from './retrosheet.js';
import { readZipEntries } from './zip.js';
import type { RetrosheetGame, RetrosheetMetaRecord } from './retrosheet.js';

/**
 * ospex-benchmark Retrosheet ingest — one-off script producing the committed
 * historical-finals dataset the totals dispersion fit runs on
 * (docs/TOTALS_DISPERSION.md). Downloads (or reads pre-downloaded copies of)
 * the Retrosheet game-log archives, parses them, and writes one NDJSON
 * dataset with a provenance meta record up front. No credentials involved —
 * retrosheet.org is a public archive.
 *
 * The information used here was obtained free of charge from and is
 * copyrighted by Retrosheet. Interested parties may contact Retrosheet at
 * "www.retrosheet.org".
 */

class UsageError extends Error {}

/**
 * The fit window. Part of the published method, not a tunable: 2023 is the
 * first season of the current rules era (pitch clock, shift limits, larger
 * bases), and all three seasons play extra innings under the placed-runner
 * rule — the same regime 2026 games settle under.
 */
const SEASONS = [2023, 2024, 2025] as const;

const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;

const USAGE = `Usage: yarn ingest:retrosheet (--download | --from-dir DIR) [options]

Modes:
  --download     Fetch gl2023.zip/gl2024.zip/gl2025.zip from retrosheet.org.
  --from-dir DIR Read the same three archives from a local directory.

Options:
  --out PATH     Output dataset path.
                 Default: data/retrosheet-mlb-totals-2023-2025.ndjson
  -h, --help     Show this help.`;

interface CliOptions {
  mode: 'download' | 'from-dir';
  fromDir: string | null;
  outPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  let mode: 'download' | 'from-dir' | null = null;
  let fromDir: string | null = null;
  let outPath = 'data/retrosheet-mlb-totals-2023-2025.ndjson';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--download':
        mode = 'download';
        break;
      case '--from-dir':
        mode = 'from-dir';
        fromDir = next();
        break;
      case '--out':
        outPath = next();
        break;
      case '-h':
      case '--help':
        printLine(USAGE);
        process.exit(0);
        break;
      default:
        throw new UsageError(`unknown argument: ${arg ?? ''}`);
    }
  }
  if (mode === null) throw new UsageError('one of --download or --from-dir is required');
  return { mode, fromDir, outPath };
}

function archiveUrl(season: number): string {
  return `https://www.retrosheet.org/gamelogs/gl${season}.zip`;
}

async function downloadArchive(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`GET ${url} failed with HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_ARCHIVE_BYTES) {
      throw new Error(`${url} is ${bytes.length} bytes — larger than any plausible game log`);
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

async function loadArchive(options: CliOptions, season: number): Promise<Buffer> {
  if (options.mode === 'download') return downloadArchive(archiveUrl(season));
  if (options.fromDir === null) throw new UsageError('--from-dir requires a directory');
  return readFileSync(join(options.fromDir, `gl${season}.zip`));
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  printLine(`ospex-benchmark Retrosheet ingest — seasons ${SEASONS.join(', ')}`);
  printLine(RETROSHEET_ATTRIBUTION);

  const games: RetrosheetGame[] = [];
  const sources: RetrosheetMetaRecord['sources'] = [];
  for (const season of SEASONS) {
    const archive = await loadArchive(options, season);
    const sha256 = createHash('sha256').update(archive).digest('hex');
    sources.push({ url: archiveUrl(season), sha256 });
    const entries = readZipEntries(archive).filter((entry) =>
      /^gl\d{4}\.txt$/i.test(entry.name),
    );
    if (entries.length !== 1) {
      throw new Error(
        `gl${season}.zip: expected exactly one game-log entry, found ` +
          `${entries.length} — archive layout drift?`,
      );
    }
    const entry = entries[0];
    if (entry === undefined) throw new Error('unreachable: single entry vanished');
    const lines = entry.data
      .toString('latin1')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
    const seasonGames = lines.map((line) => parseGameLogLine(line, season));
    const byClass = new Map<string, number>();
    for (const game of seasonGames) {
      const key = classifyOuts(game.outs);
      byClass.set(key, (byClass.get(key) ?? 0) + 1);
    }
    printLine(
      `  ${season}: ${seasonGames.length} games from ${entry.name} (sha256 ${sha256.slice(0, 12)}…) — ` +
        [...byClass.entries()].map(([k, v]) => `${k} ${v}`).join(', ') +
        `, completed-later ${seasonGames.filter((g) => g.completedLater).length}` +
        `, forfeits ${seasonGames.filter((g) => g.forfeit !== null).length}`,
    );
    games.push(...seasonGames);
  }

  const meta: RetrosheetMetaRecord = {
    recordType: 'retrosheet_meta',
    seasons: [...SEASONS],
    sources,
    games: games.length,
    attribution: RETROSHEET_ATTRIBUTION,
    generatedAt: new Date().toISOString(),
  };
  writeNdjson(options.outPath, [meta, ...games.map(retrosheetGameRecord)]);
  printLine('');
  printLine(`dataset: ${options.outPath} (${games.length} games + meta)`);
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
