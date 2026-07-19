import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalize, sha256Hex } from './canonical.js';
import { redactSecrets } from './config.js';
import { armDigest } from './fireArtifact.js';
import { fireArtifactV1Schema } from './fireArtifactProducer.js';
import type { FireArtifactV1 } from './fireArtifactProducer.js';

/**
 * The fire-artifact WRITE path (SPEC-line-open-evidence-model.md §4/§5): serialize a
 * produced `FireArtifactV1` to its durable, redaction-safe, byte-reproducible
 * on-disk form; parse persisted bytes back through the strict schema; and RECOMPUTE
 * the artifact's self-consistency digests from its own persisted fields (the "golden
 * replay": what was written re-parses and its digests still recompute).
 *
 * The serialization is the repo's canonical serializer with a FINAL secret-redaction
 * sweep over the whole string (the same defense-in-depth `records.ts` applies to
 * every NDJSON line): the arm response bodies are already redacted at capture, so on
 * a clean artifact the sweep is an idempotent no-op, but it guarantees no field ever
 * carries an unredacted secret to disk.
 *
 * `recomputeFireArtifactDigests` re-derives only the artifact's OWN digest
 * self-consistency (request/game hashes from the retained preimage, each attempt's
 * `responseSha256` from its persisted body, each arm's `armDigest` from its ten-field
 * domain). It is NOT the entry/model/fire integrity verifier — the V1/V2/V-lag entry
 * checks, approved-model / family-collision checks, and global coverage
 * classification are a later phase; a digest-consistent artifact may still be marked
 * entry-invalid there.
 *
 * Pure serialization + a thin `node:fs` write. No store, watcher, provider, close,
 * CLV, scoring, coverage, or runtime wiring; the path/naming convention and the call
 * site are the runtime slice's.
 */

/**
 * The durable on-disk bytes of a fire artifact: the canonical serialization with a
 * final secret-redaction sweep. Deterministic — canonical key order, no volatile
 * field — so the same artifact always yields the same bytes.
 */
export function serializeFireArtifactV1(artifact: FireArtifactV1): string {
  return redactSecrets(canonicalize(artifact));
}

/**
 * Parse persisted bytes back into a strictly-validated fire artifact. Fails closed
 * on malformed JSON (`JSON.parse` throws) or any schema violation (an unknown field,
 * a malformed instant/digest). This does NOT register the value in the producer
 * brand — a persisted artifact is authenticated by strict schema + digest
 * recomputation (below), never by in-process producer identity.
 */
export function parseFireArtifactV1(bytes: string): FireArtifactV1 {
  return fireArtifactV1Schema.parse(JSON.parse(bytes));
}

/**
 * Recompute the artifact's digest self-consistency and return every disagreement
 * (empty = consistent):
 * - `requestSha256` / `gameSha256` recompute from the retained request preimage;
 * - each persisted attempt's `responseSha256` equals `sha256Hex(persistedResponseBody)`
 *   (or both are `null`);
 * - each arm's `armDigest` recomputes from its exact ten-field domain.
 *
 * A scorer performs the same recomputation; the write path uses it as the replay
 * check. It does not perform entry/model/fire integrity classification.
 */
export function recomputeFireArtifactDigests(artifact: FireArtifactV1): string[] {
  const violations: string[] = [];

  if (sha256Hex(canonicalize(artifact.requestBundle)) !== artifact.requestSha256) {
    violations.push('requestSha256 does not recompute from the retained request bundle');
  }
  const game = artifact.requestBundle.games[0];
  if (game === undefined || sha256Hex(canonicalize(game)) !== artifact.gameSha256) {
    violations.push('gameSha256 does not recompute from the retained request game');
  }

  for (const arm of artifact.arms) {
    const who = arm.expectedArmIdentity.participantId;
    for (const attempt of arm.orderedAttempts) {
      if (attempt.persistedResponseBody === null) {
        if (attempt.responseSha256 !== null) {
          violations.push(`arm ${who} attempt ${attempt.attemptNumber} has a responseSha256 with no body`);
        }
      } else if (attempt.responseSha256 !== sha256Hex(attempt.persistedResponseBody)) {
        violations.push(`arm ${who} attempt ${attempt.attemptNumber} responseSha256 does not match its persisted body`);
      }
    }
    const recomputed = armDigest({
      cohortId: artifact.cohortId,
      fireId: artifact.fireId,
      runId: artifact.runId,
      participantId: who,
      requestSha256: artifact.requestSha256,
      expectedArmIdentity: arm.expectedArmIdentity,
      orderedAttempts: arm.orderedAttempts,
      terminalOutcome: arm.terminalOutcome,
      acceptedResponseDigestOrNull: arm.acceptedResponseDigest,
      acceptedDecisionFingerprintOrNull: arm.acceptedDecisionFingerprint,
    });
    if (recomputed !== arm.armDigest) {
      violations.push(`arm ${who} armDigest does not recompute from its persisted domain`);
    }
  }

  return violations;
}

/**
 * Write a fire artifact to disk as one canonical, redaction-safe JSON file (creating
 * parent directories). The caller chooses `filePath` — the path/naming convention is
 * a runtime concern, kept out of this slice.
 */
export function writeFireArtifactV1(filePath: string, artifact: FireArtifactV1): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, serializeFireArtifactV1(artifact), 'utf8');
}
