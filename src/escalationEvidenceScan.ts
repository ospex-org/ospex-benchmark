import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHA256_HEX } from './fireArtifactSink.js';
import type { EscalationLatchCause, EscalationLatchSource } from './escalationLatch.js';

/**
 * The evidence-derived escalation-latch source: scan the fire-artifact sink's cohort
 * directory for installed spend sidecars whose `reason` is non-null — the installed
 * escalation evidence itself (docs/CAMPAIGN-ACTIVATION.md). The sink names every sidecar
 * `fire-<gameSegment>-<scope>-<fireId>-spend.json` inside `<baseDir>/<cohortId>/`, and no
 * fire artifact can share that suffix (an artifact's name ends in its 64-hex fireId), so
 * the `-spend.json` suffix selects exactly the spend evidence.
 *
 * Dispositions, fail-closed on ambiguity:
 *   - a sidecar with `reason: null` is a clean billable pass — evidence, not a cause;
 *   - a sidecar with a known escalation reason is an `escalation_evidence` cause;
 *   - a `-spend.json` file that cannot be read or decoded, or whose `reason` is anything
 *     else, is an `unreadable_evidence` cause — a file that MIGHT be escalation evidence
 *     latches until a human resolves it, never reads as clear;
 *   - a missing cohort directory is CLEAR: this cohort installed no evidence under this
 *     root. The scan answers only for the root it was given — the honest bound of a
 *     filesystem source — which is why it always composes with the store-derived
 *     unresolved-fire source, whose view of an escalation does not depend on any root.
 *
 * Any other filesystem failure (permissions, I/O) rejects — fail closed.
 */

/** Exactly the filesystem the scan needs; injectable as a test seam. `readdir` must throw
 *  the platform `ENOENT` error when the directory does not exist. */
export interface EvidenceDirFs {
  readdir(dir: string): readonly string[];
  readFile(path: string): Buffer;
}

export const nodeEvidenceDirFs: EvidenceDirFs = {
  readdir: (dir) => readdirSync(dir),
  readFile: (path) => readFileSync(path),
};

const SPEND_SIDECAR_SUFFIX = '-spend.json';

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** Classify one `-spend.json` file's bytes into zero or one latch cause. */
function classifySidecarBytes(path: string, bytes: Buffer): EscalationLatchCause | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return Object.freeze({ kind: 'unreadable_evidence' as const, path, detail: 'not valid JSON' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return Object.freeze({ kind: 'unreadable_evidence' as const, path, detail: 'not a JSON object' });
  }
  const record = parsed as Record<string, unknown>;
  if (!Object.hasOwn(record, 'reason')) {
    return Object.freeze({ kind: 'unreadable_evidence' as const, path, detail: 'missing reason field' });
  }
  const reason = record['reason'];
  if (reason === null) return null; // a clean billable pass — evidence, not an escalation
  if (reason === 'spend_attempt_over_reservation' || reason === 'spend_evidence_unknown') {
    return Object.freeze({ kind: 'escalation_evidence' as const, path, reason });
  }
  return Object.freeze({
    kind: 'unreadable_evidence' as const,
    path,
    detail: `unrecognized reason ${JSON.stringify(reason)}`,
  });
}

/**
 * Build the latch source over the sink root the dispatching process writes to. The
 * cohortId is grammar-checked with the sink's own path-forming rule BEFORE it becomes a
 * path component, so no caller-shaped identifier can traverse out of `baseDir`. Entries
 * are scanned in sorted name order, so the cause list is deterministic.
 */
export function escalationEvidenceLatchSource(
  baseDir: string,
  fsx: EvidenceDirFs = nodeEvidenceDirFs,
): EscalationLatchSource {
  const readdir = fsx.readdir.bind(fsx);
  const readFile = fsx.readFile.bind(fsx);
  return {
    async causes(cohortId: string): Promise<readonly EscalationLatchCause[]> {
      if (!SHA256_HEX.test(cohortId)) {
        throw new Error('escalation evidence scan: cohortId is not a lowercase sha256 digest');
      }
      const dir = join(baseDir, cohortId);
      let names: readonly string[];
      try {
        names = readdir(dir);
      } catch (error) {
        if (isEnoent(error)) return []; // no evidence directory for this cohort under this root
        throw error; // any other filesystem failure refuses dispatch, never reads as clear
      }
      const causes: EscalationLatchCause[] = [];
      for (const name of [...names].sort()) {
        if (!name.endsWith(SPEND_SIDECAR_SUFFIX)) continue;
        const path = join(dir, name);
        let bytes: Buffer;
        try {
          bytes = readFile(path);
        } catch (error) {
          causes.push(
            Object.freeze({
              kind: 'unreadable_evidence' as const,
              path,
              detail: `read failed: ${error instanceof Error ? error.message : String(error)}`,
            }),
          );
          continue;
        }
        const cause = classifySidecarBytes(path, bytes);
        if (cause !== null) causes.push(cause);
      }
      return causes;
    },
  };
}
