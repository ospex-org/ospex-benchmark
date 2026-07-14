import { z } from 'zod';

/**
 * Retrosheet game-log parsing + the committed derived-dataset contract.
 *
 * Source format: retrosheet.org game logs (one CSV line per game, exactly 161
 * fields; layout per retrosheet.org/gamelogs/glfields.txt). Only the first 16
 * fields are consumed — date, doubleheader game number, teams, final scores,
 * length in outs, and the completion/forfeit flags. Everything is validated
 * and any deviation fails the ingest loudly: a field-count or format change
 * upstream means the layout moved and must be re-verified, not skated over.
 *
 * License: Retrosheet game logs are free for any use; the sole condition is
 * the attribution notice below, which is pinned verbatim into the dataset
 * meta record, the published parameter artifact, and the methodology doc.
 */

export const RETROSHEET_ATTRIBUTION =
  'The information used here was obtained free of charge from and is copyrighted by ' +
  'Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".';

/** Exact field count of the 2023–2025 game logs; a change = format drift. */
export const GAME_LOG_FIELD_COUNT = 161;

/**
 * Outs-based game classification. Both teams batting nine full innings is 54
 * outs; a home win without the bottom of the ninth is 51; a ninth-inning
 * walk-off ends mid-inning at 51–53. Anything under 51 outs is a shortened
 * (rain-curtailed) game — sportsbooks void unresolved totals on those, so
 * they are excluded from the fit. Anything past 54 required extra innings.
 */
export const REGULATION_MIN_OUTS = 51;
export const REGULATION_MAX_OUTS = 54;

export type GameClassification = 'shortened' | 'regulation' | 'extra-innings';

export function classifyOuts(outs: number): GameClassification {
  if (outs < REGULATION_MIN_OUTS) return 'shortened';
  if (outs <= REGULATION_MAX_OUTS) return 'regulation';
  return 'extra-innings';
}

export class RetrosheetParseError extends Error {}

export interface RetrosheetGame {
  /** ISO date (yyyy-mm-dd). */
  date: string;
  season: number;
  /** '0' single game; '1'/'2'/'3' doubleheader position; 'A'/'B' split ticket. */
  doubleheaderGame: string;
  awayTeam: string;
  homeTeam: string;
  awayScore: number;
  homeScore: number;
  /** Length of the game in outs (field 12). */
  outs: number;
  /** True when the game was suspended and completed on a later date. */
  completedLater: boolean;
  /** Forfeit code ('V'/'H'/'T') or null; forfeits are excluded from fits. */
  forfeit: string | null;
}

/** Quote-aware CSV field splitter ('""' inside a quoted field is a literal quote). */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (inQuotes) throw new RetrosheetParseError('unterminated quoted field');
  fields.push(current);
  return fields;
}

function requireField(fields: string[], index: number): string {
  const value = fields[index];
  if (value === undefined) {
    throw new RetrosheetParseError(`missing field ${index + 1}`);
  }
  return value;
}

function parseNonNegativeInt(raw: string, label: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new RetrosheetParseError(`${label} is not a non-negative integer: "${raw}"`);
  }
  return Number(raw);
}

/**
 * Parse one game-log line into the fields the dispersion fit consumes.
 * `season` is the log-file year and is cross-checked against the game date.
 */
export function parseGameLogLine(line: string, season: number): RetrosheetGame {
  const fields = splitCsvLine(line);
  if (fields.length !== GAME_LOG_FIELD_COUNT) {
    throw new RetrosheetParseError(
      `expected ${GAME_LOG_FIELD_COUNT} fields, got ${fields.length} — game-log format drift?`,
    );
  }
  const rawDate = requireField(fields, 0);
  if (!/^\d{8}$/.test(rawDate)) {
    throw new RetrosheetParseError(`bad date field: "${rawDate}"`);
  }
  if (!rawDate.startsWith(String(season))) {
    throw new RetrosheetParseError(`game date ${rawDate} is outside season ${season}`);
  }
  const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;

  const doubleheaderGame = requireField(fields, 1);
  if (!/^[0-3AB]$/.test(doubleheaderGame)) {
    throw new RetrosheetParseError(`bad game-number field: "${doubleheaderGame}"`);
  }
  const awayTeam = requireField(fields, 3);
  const homeTeam = requireField(fields, 6);
  if (awayTeam === '' || homeTeam === '') {
    throw new RetrosheetParseError('empty team code');
  }
  const awayScore = parseNonNegativeInt(requireField(fields, 9), 'visiting score');
  const homeScore = parseNonNegativeInt(requireField(fields, 10), 'home score');
  const outs = parseNonNegativeInt(requireField(fields, 11), 'length in outs');
  if (outs < 1 || outs > 200) {
    throw new RetrosheetParseError(`implausible length in outs: ${outs}`);
  }
  const completedLater = requireField(fields, 13).trim() !== '';
  const forfeitRaw = requireField(fields, 14).trim();
  if (forfeitRaw !== '' && !/^[VHT]$/.test(forfeitRaw)) {
    throw new RetrosheetParseError(`unknown forfeit code: "${forfeitRaw}"`);
  }

  return {
    date,
    season,
    doubleheaderGame,
    awayTeam,
    homeTeam,
    awayScore,
    homeScore,
    outs,
    completedLater,
    forfeit: forfeitRaw === '' ? null : forfeitRaw,
  };
}

/**
 * Committed dataset contract (data/retrosheet-mlb-totals-*.ndjson): one meta
 * record, then one record per game. Writer and reader share these schemas so
 * the two can never drift apart, and the meta record's attribution field is
 * literal-pinned — a dataset without the exact Retrosheet notice is invalid.
 */
export const retrosheetMetaRecordSchema = z
  .object({
    recordType: z.literal('retrosheet_meta'),
    seasons: z.array(z.number().int()),
    sources: z.array(
      z.object({ url: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    ),
    games: z.number().int().nonnegative(),
    attribution: z.literal(RETROSHEET_ATTRIBUTION),
    generatedAt: z.string().min(1),
  })
  .strict();

export const retrosheetGameRecordSchema = z
  .object({
    recordType: z.literal('retrosheet_game'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    season: z.number().int(),
    doubleheaderGame: z.string().regex(/^[0-3AB]$/),
    awayTeam: z.string().min(1),
    homeTeam: z.string().min(1),
    awayScore: z.number().int().nonnegative(),
    homeScore: z.number().int().nonnegative(),
    outs: z.number().int().positive(),
    completedLater: z.boolean(),
    forfeit: z.union([z.string().regex(/^[VHT]$/), z.null()]),
  })
  .strict();

export type RetrosheetMetaRecord = z.infer<typeof retrosheetMetaRecordSchema>;
export type RetrosheetGameRecord = z.infer<typeof retrosheetGameRecordSchema>;

export function retrosheetGameRecord(game: RetrosheetGame): RetrosheetGameRecord {
  return { recordType: 'retrosheet_game', ...game };
}

export interface RetrosheetDataset {
  meta: RetrosheetMetaRecord;
  games: RetrosheetGameRecord[];
}

/**
 * Parse + integrity-check a committed Retrosheet dataset: exactly one leading
 * meta record, the meta's game count matching the records actually present,
 * and the meta's season list (which flows into the published artifact)
 * matching the distinct seasons of the records (a truncated or edited file
 * refuses to load).
 */
export function parseRetrosheetDataset(text: string): RetrosheetDataset {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new RetrosheetParseError('dataset is empty');
  const meta = retrosheetMetaRecordSchema.parse(JSON.parse(lines[0] ?? ''));
  const games = lines.slice(1).map((line) => retrosheetGameRecordSchema.parse(JSON.parse(line)));
  if (games.length !== meta.games) {
    throw new RetrosheetParseError(
      `meta says ${meta.games} games but the dataset holds ${games.length} — truncated or edited?`,
    );
  }
  const seasons = [...new Set(games.map((game) => game.season))].sort((a, b) => a - b);
  if (JSON.stringify(seasons) !== JSON.stringify(meta.seasons)) {
    throw new RetrosheetParseError(
      `meta seasons [${meta.seasons.join(', ')}] disagree with the records' seasons ` +
        `[${seasons.join(', ')}] — truncated or edited?`,
    );
  }
  return { meta, games };
}
