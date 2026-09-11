/** B4.1 can score, but cannot truthfully publish into the current serving schema.
 * Attempts collide across sibling markets and score timing has no SQL column.
 * Remove only with the separately reviewed indexer + consumer migration. */
export const MARKET_OPEN_SQL_PUBLICATION_BLOCKED =
  'market-open SQL publication is blocked pending the serving-schema migration (attempt grain and timing columns)';

export function hasMarketOpenProvenance(record: {
  runId?: unknown; cohortId?: unknown; marketOpen?: unknown;
  marketOpenTiming?: unknown; marketOpenEvidence?: unknown;
}): boolean {
  return record.marketOpen != null || record.marketOpenTiming != null || record.marketOpenEvidence !== undefined
    || (typeof record.runId === 'string' && record.runId.startsWith('market-open-'))
    || (typeof record.cohortId === 'string' && record.cohortId.startsWith('market-open-'));
}
