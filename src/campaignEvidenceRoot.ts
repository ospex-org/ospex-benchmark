import { isAbsolute, join } from 'node:path';
import { ByteDifferentCollisionError, installBytesNoClobber, nodeArtifactFs } from './fireArtifactSink.js';
import type { ArtifactFs } from './fireArtifactSink.js';

/**
 * The campaign evidence root's durable IDENTITY (docs/CAMPAIGN-ACTIVATION.md §"The
 * durable escalation latch"). The evidence half of the escalation latch is a filesystem
 * scan, and a filesystem scan is only as trustworthy as the root it is pointed at: after
 * a reviewed recovery settles the store-side shadow, the installed sidecar under the
 * artifact root is the ONLY signal keeping the latch tripped — so a root that can be
 * switched per-tick, or silently recreated empty after a lost mount, is a latch bypass.
 *
 * The defense is an identity, not a pathname. Arming installs a small marker file
 * (`evidence-root.json`, a minted random id) at the root through the fire-artifact
 * sink's durable no-clobber loop, and binds BOTH the resolved absolute path and the
 * marker id into the durable campaign authorization record. Every tick then verifies the
 * marker at the recorded root before reading any evidence: a missing root, a missing
 * marker, an unreadable marker, or a different id all REFUSE the tick — a recreated
 * empty directory at the same pathname carries no marker and can never read as clear.
 * The tick never creates the root; the attended arm is the only initializer.
 *
 * A root has ONE identity for its lifetime: a second campaign armed at the same root
 * reads the existing marker and binds the same id (the no-clobber install reconciles
 * byte-identical bytes), while a byte-different marker at the root refuses the arm.
 */

/** The marker's file name at the evidence root. Root-level, so the cohort-directory scan
 *  (`<root>/<cohortId>/`) never sees it. */
export const EVIDENCE_ROOT_MARKER = 'evidence-root.json';

export const EVIDENCE_ROOT_VERSION = 1;

export interface EvidenceRootMarker {
  readonly evidenceRootVersion: number;
  readonly evidenceRootId: string;
}

/** The exact bytes an id serializes to — deterministic, so the no-clobber install
 *  reconciles a re-arm at the same root as byte-identical. */
export function evidenceRootMarkerBytes(evidenceRootId: string): Buffer {
  return Buffer.from(
    `${JSON.stringify({ evidenceRootVersion: EVIDENCE_ROOT_VERSION, evidenceRootId })}\n`,
    'utf8',
  );
}

function isEnoentLike(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  // ENOTDIR: a path COMPONENT is a file (the "root" is not a directory) — the marker is
  // just as absent as under a missing directory, and the arm/tick classifies from there.
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Strictly parse marker bytes: exact keys, supported version, non-empty id. Throws with
 *  the violation — the caller decides whether that refuses an arm or a tick. */
export function parseEvidenceRootMarker(bytes: Buffer): EvidenceRootMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('evidence-root marker is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('evidence-root marker is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'evidenceRootId' || keys[1] !== 'evidenceRootVersion') {
    throw new Error(`evidence-root marker keys [${keys.join(', ')}] are not [evidenceRootId, evidenceRootVersion]`);
  }
  const version = record['evidenceRootVersion'];
  const id = record['evidenceRootId'];
  if (version !== EVIDENCE_ROOT_VERSION) {
    throw new Error(`evidence-root marker version ${String(version)} is not the supported ${EVIDENCE_ROOT_VERSION}`);
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('evidence-root marker carries no evidenceRootId');
  }
  return Object.freeze({ evidenceRootVersion: EVIDENCE_ROOT_VERSION, evidenceRootId: id });
}

export type EvidenceRootRead =
  | { readonly kind: 'present'; readonly marker: EvidenceRootMarker }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly detail: string };

/** Read the marker at `root` without creating anything. `absent` covers a missing root
 *  and a missing marker alike — the CALLER knows whether absence is initializable (an
 *  attended arm) or a refusal (an unattended tick). Any other failure is `unreadable`. */
export function readEvidenceRootMarker(root: string, fsx: ArtifactFs = nodeArtifactFs): EvidenceRootRead {
  let bytes: Buffer;
  try {
    bytes = fsx.readFile(join(root, EVIDENCE_ROOT_MARKER));
  } catch (error) {
    if (isEnoentLike(error)) return { kind: 'absent' };
    return { kind: 'unreadable', detail: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { kind: 'present', marker: parseEvidenceRootMarker(bytes) };
  } catch (error) {
    return { kind: 'unreadable', detail: error instanceof Error ? error.message : String(error) };
  }
}

export type EvidenceRootInstall =
  | { readonly kind: 'installed'; readonly evidenceRootId: string }
  | { readonly kind: 'already_installed'; readonly evidenceRootId: string }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * The ARM-side initializer: create the root and durably install the marker for
 * `evidenceRootId` through the sink's no-clobber loop (same-directory fsynced temp,
 * atomic hard-link publication, directory sync, temp cleanup), then read the marker back
 * and return the id that actually governs the root. An existing byte-identical marker
 * reconciles (`already_installed` — the re-run of an interrupted arm, or a second
 * campaign sharing the root); an existing byte-DIFFERENT marker is a conflict and the
 * arm must refuse; any other failure reports `failed` and the caller must not create
 * authority bound to this root.
 */
export function installEvidenceRootMarker(
  root: string,
  evidenceRootId: string,
  fsx: ArtifactFs = nodeArtifactFs,
): EvidenceRootInstall {
  if (!isAbsolute(root)) {
    return { kind: 'failed', message: `evidence root ${JSON.stringify(root)} must be an absolute path` };
  }
  let created: boolean;
  try {
    created = installBytesNoClobber(fsx, {
      dir: root,
      finalPath: join(root, EVIDENCE_ROOT_MARKER),
      tmpStem: EVIDENCE_ROOT_MARKER,
      buffer: evidenceRootMarkerBytes(evidenceRootId),
      label: 'evidence-root marker',
    }).created;
  } catch (error) {
    // A byte-different collision is the conflict the arm refuses on: another id already
    // governs this root.
    if (error instanceof ByteDifferentCollisionError) {
      return {
        kind: 'conflict',
        message:
          `the evidence root ${root} already carries a DIFFERENT identity marker — another identity ` +
          `governs it; choose a different --artifacts path or restore the original root`,
      };
    }
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  const readBack = readEvidenceRootMarker(root, fsx);
  if (readBack.kind !== 'present') {
    return {
      kind: 'failed',
      message: `evidence-root marker read-back failed after install: ${readBack.kind === 'unreadable' ? readBack.detail : 'marker absent'}`,
    };
  }
  if (readBack.marker.evidenceRootId !== evidenceRootId) {
    return {
      kind: 'failed',
      message: 'evidence-root marker read-back returned a different id than was installed',
    };
  }
  return created
    ? { kind: 'installed', evidenceRootId }
    : { kind: 'already_installed', evidenceRootId };
}

export type EvidenceRootVerification = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The TICK-side verification: the recorded root must exist and carry the marker with the
 * EXACT recorded id. Everything else refuses — a missing root or marker is a lost or
 * recreated mount (an empty directory at the right pathname is NOT the armed root), an
 * unreadable marker is fail-closed, and a different id is a different root's identity at
 * the recorded path. Never creates anything.
 */
export function verifyEvidenceRoot(
  root: string,
  expectedEvidenceRootId: string,
  fsx: ArtifactFs = nodeArtifactFs,
): EvidenceRootVerification {
  const read = readEvidenceRootMarker(root, fsx);
  switch (read.kind) {
    case 'present':
      if (read.marker.evidenceRootId === expectedEvidenceRootId) return { ok: true };
      return {
        ok: false,
        reason:
          `the marker at ${root} carries id ${JSON.stringify(read.marker.evidenceRootId)}, not the armed ` +
          `id ${JSON.stringify(expectedEvidenceRootId)} — this is not the root the campaign was armed with`,
      };
    case 'absent':
      return {
        ok: false,
        reason:
          `the armed evidence root ${root} is missing or carries no identity marker — a lost mount or a ` +
          'recreated empty directory is NOT the armed root; restore it before ticking',
      };
    case 'unreadable':
      return { ok: false, reason: `the identity marker at ${root} could not be read: ${read.detail}` };
    default: {
      const _exhaustive: never = read;
      return _exhaustive;
    }
  }
}
