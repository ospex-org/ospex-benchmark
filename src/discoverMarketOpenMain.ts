import { pathToFileURL } from 'node:url';
import { discoverMarketOpenRuns, withMarketOpenEvidenceAdmission } from './marketOpenEvidence.js';
import { canonicalize } from './canonical.js';
import { parseRunRecords, verifyRunIntegrity } from './scoring.js';

/** Source-only scheduler input: no providers, closes, credentials, writes, or freshness selector. */
export function discoverScoreableMarketOpenRuns(root: string) {
  return withMarketOpenEvidenceAdmission(() => discoverMarketOpenRuns(root).map((evidence) => {
    const run = parseRunRecords(evidence.records.map((r) => canonicalize(r)), { marketOpenEvidence: evidence });
    const violations = verifyRunIntegrity(run);
    if (violations.length) throw new Error(`market-open run integrity: ${violations.join('; ')}`);
    return { version: 'market-open-score-discovery-v1' as const, runId: run.runId, cohortId: run.cohortId,
      artifactPath: evidence.artifactPath, artifactSha256: evidence.artifactSha256,
      cohortKind: evidence.cohortKind,
      ...(evidence.cohortOrigin === undefined ? {} : { cohortOrigin: evidence.cohortOrigin }),
      eventId: evidence.prepared.provenance.event.eventId, market: evidence.prepared.provenance.event.market,
      mode: run.mode, clockMode: run.clockMode, status: evidence.fire.status, reason: evidence.fire.reason };
  }));
}

export function runMarketOpenDiscoveryCli(argv: string[], print = console.log): number {
  if (argv.length !== 2 || argv[0] !== '--evidence-root' || !argv[1]) {
    throw new Error('Usage: discover:market-open --evidence-root ROOT');
  }
  for (const row of discoverScoreableMarketOpenRuns(argv[1])) print(canonicalize(row));
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = runMarketOpenDiscoveryCli(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
