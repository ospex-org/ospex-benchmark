import { readFileSync } from 'node:fs';
import { hasMarketOpenProvenance } from './marketOpenPublication.js';
import { canonicalize } from './canonical.js';
import { assertMarketOpenRecords, discoverMarketOpenRuns, readMarketOpenRun } from './marketOpenEvidence.js';
import type { MarketOpenRunEvidence } from './marketOpenEvidence.js';

export interface RunArtifactInput { text: string; marketOpenEvidence?: MarketOpenRunEvidence }

/** Resolve the installed wrapper (or its exact extracted records) against an explicit trusted root. */
export function readRunArtifactFile(path: string, options?: { marketOpenEvidenceRoot?: string | undefined }): RunArtifactInput {
  const text = readFileSync(path, 'utf8');
  let envelope: { version?: unknown; records?: unknown } | null = null;
  try { envelope = JSON.parse(text) as { version?: unknown; records?: unknown } | null; } catch { /* ordinary NDJSON */ }
  const root = options?.marketOpenEvidenceRoot;
  if (envelope?.version === 'market-open-produced-v1') {
    if (root === undefined) throw new Error('market-open input requires --evidence-root');
    const evidence = readMarketOpenRun(root, path);
    return { text: evidence.records.map((r) => canonicalize(r)).join('\n') + '\n', marketOpenEvidence: evidence };
  }
  const records = text.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
  const marketOpen = records.some(hasMarketOpenProvenance);
  if (!marketOpen) return { text };
  if (root === undefined) throw new Error('market-open input requires --evidence-root');
  const runId = records.find((r) => r.recordType === 'run_meta')?.runId;
  const matches = discoverMarketOpenRuns(root).filter((e) => e.prepared.provenance.runId === runId);
  if (matches.length !== 1) throw new Error('market-open input is not one completed journal artifact');
  const evidence = matches[0]!;
  assertMarketOpenRecords(records, evidence);
  return { text, marketOpenEvidence: evidence };
}
