import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHA256_HEX } from './fireArtifactSink.js';
import { verifySpendEvidence } from './verifySpendSidecar.js';
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
 *   - a sidecar with a known escalation reason is an `escalation_evidence` cause (latching
 *     needs no proof — a record that even CLAIMS an escalation refuses dispatch);
 *   - a sidecar claiming a clean pass (`reason: null`) must EARN the clear reading: it must
 *     name the scanned cohort, and the offline pair verifier ({@link verifySpendEvidence} —
 *     the same strict shape/binding/recomputation owner the crossing acceptance runs, with
 *     `reason-recomputed` authoritative) must pass EVERY named check against the paired
 *     installed artifact (the canonical sibling: the same file name without `-spend`).
 *     A missing, unreadable, foreign, or contradicted pair is an `unverified_evidence`
 *     cause — nothing a record says about itself is trusted. Running the whole verifier
 *     deliberately includes its acceptance-grade checks: on an unattended paid path an
 *     anomalous "clean" record refuses rather than clears, and the recovery is
 *     campaign:stop + investigation, never a silent clear;
 *   - a `-spend.json` file that cannot be read or decoded, or whose `reason` is anything
 *     else, is an `unreadable_evidence` cause — a file that MIGHT be escalation evidence
 *     latches until a human resolves it, never reads as clear;
 *   - a missing COHORT directory under a readable root is CLEAR: this cohort installed no
 *     evidence under this root — the one absence a filesystem source can positively read;
 *   - a missing or unreadable ROOT rejects: a misconfigured or unmounted evidence root
 *     must refuse dispatch loudly, never degrade the source to a silent no-op.
 *
 * Any other filesystem failure (permissions, I/O) rejects — fail closed. The scan still
 * answers only for the root it was given — the honest bound of a filesystem source — so
 * it composes with the store-derived unresolved-fire source, whose view of an escalation
 * does not depend on any root.
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

/** One `-spend.json` file's disposition: a latch cause, or a CLEAN CLAIM that still has to
 *  be verified against its paired artifact before it may read as no-cause. */
type SidecarDisposition =
  | { readonly kind: 'cause'; readonly cause: EscalationLatchCause }
  | { readonly kind: 'clean_claim'; readonly record: Record<string, unknown> };

function causeOf(cause: EscalationLatchCause): SidecarDisposition {
  return { kind: 'cause', cause };
}

/** Classify one `-spend.json` file's bytes. Never returns "clear": a clean claim is only a
 *  CLAIM here — {@link cleanClaimCause} decides whether it verifies. */
function classifySidecarBytes(path: string, bytes: Buffer): SidecarDisposition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return causeOf(Object.freeze({ kind: 'unreadable_evidence' as const, path, detail: 'not valid JSON' }));
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return causeOf(Object.freeze({ kind: 'unreadable_evidence' as const, path, detail: 'not a JSON object' }));
  }
  const record = parsed as Record<string, unknown>;
  if (!Object.hasOwn(record, 'reason')) {
    return causeOf(Object.freeze({ kind: 'unreadable_evidence' as const, path, detail: 'missing reason field' }));
  }
  const reason = record['reason'];
  if (reason === null) return { kind: 'clean_claim', record };
  if (reason === 'spend_attempt_over_reservation' || reason === 'spend_evidence_unknown') {
    return causeOf(Object.freeze({ kind: 'escalation_evidence' as const, path, reason }));
  }
  return causeOf(
    Object.freeze({
      kind: 'unreadable_evidence' as const,
      path,
      detail: `unrecognized reason ${JSON.stringify(reason)}`,
    }),
  );
}

/**
 * Decide whether a clean-pass claim EARNS the clear reading. The claim must name the
 * scanned cohort; its canonical sibling artifact (the same name without `-spend`) must be
 * readable; and {@link verifySpendEvidence} — the exact offline pair verifier, reused
 * wholesale so there is ONE strict shape/binding/recomputation owner — must pass every
 * named check, `reason-recomputed` included: the whole-fire verdict recomputed from the
 * record's own attempt evidence must actually be a clean pass. Anything less latches. A
 * non-money throw out of the verifier propagates (the source rejects — still fail closed).
 */
function cleanClaimCause(input: {
  dir: string;
  name: string;
  path: string;
  cohortId: string;
  record: Record<string, unknown>;
  readFile: (path: string) => Buffer;
}): EscalationLatchCause | null {
  const { dir, name, path, cohortId, record, readFile } = input;
  const recordCohort = record['cohortId'];
  if (recordCohort !== cohortId) {
    return Object.freeze({
      kind: 'unverified_evidence' as const,
      path,
      detail: `sidecar cohortId ${JSON.stringify(recordCohort)} is not the scanned cohort ${cohortId}`,
    });
  }
  const artifactName = `${name.slice(0, -SPEND_SIDECAR_SUFFIX.length)}.json`;
  let artifactBytes: Buffer;
  try {
    artifactBytes = readFile(join(dir, artifactName));
  } catch (error) {
    return Object.freeze({
      kind: 'unverified_evidence' as const,
      path,
      detail: `paired fire artifact ${artifactName} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const verification = verifySpendEvidence({ artifactBytes: artifactBytes.toString('utf8'), sidecar: record });
  if (verification.ok) return null; // the clean claim VERIFIED — evidence, not a cause
  const failed = verification.checks
    .filter((check) => !check.ok)
    .map((check) => `${check.name}: ${check.detail}`)
    .join('; ');
  return Object.freeze({
    kind: 'unverified_evidence' as const,
    path,
    detail: `clean-pass claim did not verify against ${artifactName} — ${failed}`,
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
        if (!isEnoent(error)) {
          throw error; // any non-absence failure refuses dispatch, never reads as clear
        }
        // The cohort directory is absent. That is CLEAR only under a readable root — a
        // missing root cannot distinguish "no evidence installed" from "wrong or
        // unmounted evidence root", so probe the root itself and reject loudly when it
        // is not there (its own failure, ENOENT included, propagates).
        try {
          readdir(baseDir);
        } catch (rootError) {
          throw new Error(
            `escalation evidence scan: the evidence root ${baseDir} is missing or unreadable — ` +
              `refusing to read an absent root as "no evidence": ${rootError instanceof Error ? rootError.message : String(rootError)}`,
          );
        }
        return []; // no evidence directory for this cohort under a readable root
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
        const disposition = classifySidecarBytes(path, bytes);
        if (disposition.kind === 'cause') {
          causes.push(disposition.cause);
          continue;
        }
        const claimCause = cleanClaimCause({ dir, name, path, cohortId, record: disposition.record, readFile });
        if (claimCause !== null) causes.push(claimCause);
      }
      return causes;
    },
  };
}
