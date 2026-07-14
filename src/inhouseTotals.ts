import { z } from 'zod';
import type { ClosingLineRow, GamesTableRow } from './types.js';

/**
 * In-house totals dataset contract (data/inhouse-totals-*.ndjson): the
 * production-captured MLB closing totals, each carrying the final score when
 * one has latched. Two jobs, one snapshot:
 *
 * 1. Every record's closing line feeds the closing-total spread used by the
 *    provisional dispersion fit's variance decomposition.
 * 2. Records with a `final` are the accruing (closing total, prices, final)
 *    pairs that the TOTALS_V1 MLE refit will be fit on once n is workable.
 *
 * Built exclusively from the public anon read path (closing_lines + games
 * over PostgREST) — the same rows any outside reproducer can fetch.
 */

export class InhouseTotalsError extends Error {}

export const closingTotalRecordSchema = z
  .object({
    recordType: z.literal('closing_total'),
    gameId: z.string().min(1),
    matchTime: z.string().min(1),
    line: z.number(),
    awayOddsDecimal: z.union([z.number(), z.null()]),
    homeOddsDecimal: z.union([z.number(), z.null()]),
    awayPNovig: z.union([z.number(), z.null()]),
    homePNovig: z.union([z.number(), z.null()]),
    lockTime: z.string().min(1),
    confidence: z.enum(['fresh', 'stale', 'missing']),
    final: z.union([
      z
        .object({
          awayScore: z.number().int().nonnegative(),
          homeScore: z.number().int().nonnegative(),
          total: z.number().int().nonnegative(),
          finalType: z.string().min(1),
        })
        .strict(),
      z.null(),
    ]),
  })
  .strict();

export const inhouseTotalsMetaRecordSchema = z
  .object({
    recordType: z.literal('inhouse_totals_meta'),
    network: z.string().min(1),
    sport: z.string().min(1),
    /** Every totals closing line seen on the network, any sport. */
    totalsClosesSeen: z.number().int().nonnegative(),
    /** Closes whose game is not the snapshot's sport (visible, not hidden). */
    droppedNonMlb: z.number().int().nonnegative(),
    records: z.number().int().nonnegative(),
    pairs: z.number().int().nonnegative(),
    droppedNullLine: z.number().int().nonnegative(),
    finalsWithheldNotFinished: z.number().int().nonnegative(),
    confidence: z.record(z.string(), z.number().int().nonnegative()),
    lockTimeRange: z.union([z.tuple([z.string(), z.string()]), z.null()]),
    generatedAt: z.string().min(1),
  })
  .strict();

export type ClosingTotalRecord = z.infer<typeof closingTotalRecordSchema>;
export type InhouseTotalsMetaRecord = z.infer<typeof inhouseTotalsMetaRecordSchema>;

/**
 * A final is attached only when both scores have latched AND the upstream
 * final type is 'Finished' — the score-capture path stamps postponed games
 * without scores, and the live probe confirmed finals keep status 'upcoming',
 * so scores + final_type are the only trustworthy completion signal here.
 */
export function closingTotalRecord(
  close: ClosingLineRow,
  game: GamesTableRow,
): ClosingTotalRecord | null {
  if (close.line === null) return null;
  const hasScores = game.home_score !== null && game.away_score !== null;
  const finished = hasScores && game.final_type === 'Finished';
  return {
    recordType: 'closing_total',
    gameId: close.jsonodds_id,
    matchTime: game.match_time,
    line: close.line,
    awayOddsDecimal: close.away_odds_decimal,
    homeOddsDecimal: close.home_odds_decimal,
    awayPNovig: close.away_p_novig,
    homePNovig: close.home_p_novig,
    lockTime: close.lock_time,
    confidence: close.confidence,
    final:
      finished && game.home_score !== null && game.away_score !== null
        ? {
            awayScore: game.away_score,
            homeScore: game.home_score,
            total: game.away_score + game.home_score,
            finalType: 'Finished',
          }
        : null,
  };
}

export interface InhouseTotalsDataset {
  meta: InhouseTotalsMetaRecord;
  records: ClosingTotalRecord[];
}

/**
 * Parse + integrity-check a committed in-house totals dataset: exactly one
 * leading meta record, and every record-derivable meta field re-derived from
 * the records and compared — record count, pair count, the confidence
 * histogram, and the lock-time range (all of which flow verbatim into the
 * published artifact). A truncated or edited file refuses to load.
 */
export function parseInhouseTotalsDataset(text: string): InhouseTotalsDataset {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new InhouseTotalsError('dataset is empty');
  const meta = inhouseTotalsMetaRecordSchema.parse(JSON.parse(lines[0] ?? ''));
  const records = lines.slice(1).map((line) => closingTotalRecordSchema.parse(JSON.parse(line)));
  if (records.length !== meta.records) {
    throw new InhouseTotalsError(
      `meta says ${meta.records} records but the dataset holds ${records.length} — truncated or edited?`,
    );
  }
  const pairs = records.filter((record) => record.final !== null).length;
  if (pairs !== meta.pairs) {
    throw new InhouseTotalsError(
      `meta says ${meta.pairs} pairs but the dataset holds ${pairs} — truncated or edited?`,
    );
  }
  // Every totals close seen must be accounted for: written, dropped as
  // another sport, or dropped for a null line. The meta cannot claim a
  // coverage arithmetic the records do not support.
  if (meta.totalsClosesSeen !== meta.records + meta.droppedNonMlb + meta.droppedNullLine) {
    throw new InhouseTotalsError(
      `meta coverage arithmetic fails: ${meta.totalsClosesSeen} closes seen != ` +
        `${meta.records} records + ${meta.droppedNonMlb} non-mlb + ${meta.droppedNullLine} null-line`,
    );
  }
  const confidence = rederivedConfidence(records);
  for (const key of new Set([...Object.keys(confidence), ...Object.keys(meta.confidence)])) {
    if ((confidence[key] ?? 0) !== (meta.confidence[key] ?? 0)) {
      throw new InhouseTotalsError(
        `meta confidence histogram disagrees with the records at "${key}" — truncated or edited?`,
      );
    }
  }
  const range = rederivedLockTimeRange(records);
  if (JSON.stringify(range) !== JSON.stringify(meta.lockTimeRange)) {
    throw new InhouseTotalsError(
      'meta lockTimeRange disagrees with the records — truncated or edited?',
    );
  }
  return { meta, records };
}

/** Confidence histogram re-derived from the records themselves. */
export function rederivedConfidence(records: readonly ClosingTotalRecord[]): Record<string, number> {
  const confidence: Record<string, number> = {};
  for (const record of records) {
    confidence[record.confidence] = (confidence[record.confidence] ?? 0) + 1;
  }
  return confidence;
}

/** [min, max] lock time re-derived from the records themselves; null when empty. */
export function rederivedLockTimeRange(
  records: readonly ClosingTotalRecord[],
): [string, string] | null {
  let min: string | null = null;
  let max: string | null = null;
  for (const record of records) {
    if (min === null || record.lockTime < min) min = record.lockTime;
    if (max === null || record.lockTime > max) max = record.lockTime;
  }
  return min !== null && max !== null ? [min, max] : null;
}
