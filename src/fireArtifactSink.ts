import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { MARKET_ORDINAL } from './fireArtifact.js';
import { parseFireArtifactV1, serializeFireArtifactV1, verifyFireArtifactReplay } from './fireArtifactWriter.js';
import { serializeSpendEscalationSidecar } from './spendEscalationSidecar.js';
import type { SpendEscalationSidecarV1 } from './spendEscalationSidecar.js';
import type { FireArtifactV1 } from './fireArtifactProducer.js';
import type { MarketKey } from './types.js';

/**
 * The durable fire-artifact SINK (SPEC-line-open-evidence-model.md §4/§5): install one
 * produced, brand-authenticated `FireArtifactV1` to a stable, collision-free path as an
 * ATOMIC, NO-CLOBBER, fsync-DURABLE file.
 *
 * It reuses the merged write-path owners — `serializeFireArtifactV1` (the producer-brand +
 * field-level redaction owner), `parseFireArtifactV1` (the strict persisted-schema owner),
 * and `verifyFireArtifactReplay` (the full artifact-local replay owner) — to turn the
 * artifact into its exact canonical bytes and re-verify them, then installs those exact
 * bytes: it derives the durable NAME from the same parsed exact-byte value the durable
 * BYTES come from, encodes an arbitrary `gameId` into ONE base64url path segment (no
 * separator / traversal escape), writes + fsyncs a same-directory exclusive temp, installs
 * via a hard link that FAILS rather than replaces an existing final path, then fsyncs the
 * containing directory before reporting success. A pre-existing final path is accepted only
 * for EXACT RAW-BYTE identity (an idempotent completion retry); a byte-different collision
 * fails loud, never overwriting. Every filesystem primitive goes through an injectable
 * `ArtifactFs` port — the sink, NOT the port, owns the complete-write loop — so the durable
 * install ORDER and partial/zero-write behavior are deterministically testable.
 *
 * It accepts only durable records: a fire artifact or its token-only spend-escalation sidecar —
 * never a permit, claim, admission, lease, lifecycle, store, or prepared-fire snapshot. The
 * composition spine owns permit reconciliation before delegating here. This remains pure
 * serialization plus a thin `node:fs` install, with no producer, store, watcher, provider,
 * close, CLV, scoring, or coverage logic.
 */

/** Lowercase 64-hex sha256, required for every path-forming identifier. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The RAW filesystem primitives the sink drives, in the order it drives them. The sink —
 * not the port — owns the complete-write loop over `write`, so a fake port proves the
 * production loop's partial/zero-write behavior. Injectable so the durable install ORDER is
 * a deterministic, platform-independent witness.
 */
export interface ArtifactFs {
  mkdirp(dir: string): void;
  /** Exclusive create (fails if the path exists); returns a descriptor. */
  openExclusive(path: string): number;
  /** Write up to `length` bytes of `data` from `offset`; returns the count actually written
   *  (may be short). The SINK loops to completion and rejects non-advancing progress. */
  write(fd: number, data: Buffer, offset: number, length: number): number;
  fsync(fd: number): void;
  close(fd: number): void;
  /** Hard-link install: throws `EEXIST` rather than replacing an existing final path. */
  link(existingPath: string, newPath: string): void;
  /** fsync the containing directory entry after install (best-effort where unsupported). */
  syncDir(dir: string): void;
  /** The RAW bytes of an existing file (a `Buffer`, never a lossy decoded string). */
  readFile(path: string): Buffer;
  unlink(path: string): void;
}

/** The production `node:fs`-backed port. */
export const nodeArtifactFs: ArtifactFs = {
  mkdirp: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  openExclusive: (path) => openSync(path, 'wx'),
  write: (fd, data, offset, length) => writeSync(fd, data, offset, length),
  fsync: (fd) => fsyncSync(fd),
  close: (fd) => closeSync(fd),
  link: (existingPath, newPath) => linkSync(existingPath, newPath),
  syncDir: (dir) => {
    // Windows provides no directory-entry fsync (a directory handle cannot be fsync'd — the
    // syscall raises EPERM), so on that platform this is a no-op. On POSIX it fsyncs the
    // directory so the new hard-link entry is durable, and a genuine failure propagates.
    if (process.platform === 'win32') return;
    const dfd = openSync(dir, 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  },
  readFile: (path) => readFileSync(path),
  unlink: (path) => unlinkSync(path),
};

/** A byte-different file already occupies the final path — the no-clobber refusal, typed so
 *  a caller can distinguish a collision from an environmental install failure. */
export class ByteDifferentCollisionError extends Error {}

function byOrdinal(a: MarketKey, b: MarketKey): number {
  return MARKET_ORDINAL[a] - MARKET_ORDINAL[b];
}

/** The ONE path encoder: an arbitrary gameId becomes a single base64url segment (no
 *  separator / traversal escape), shared by the artifact and sidecar path derivations. */
function gameIdSegment(gameId: string): string {
  return Buffer.from(gameId, 'utf8').toString('base64url');
}

/**
 * The write-path owners the sink composes, injectable ONLY as a test seam. The default is
 * the single set of production owners imported from `fireArtifactWriter.ts` (S3 adds no
 * second serializer/parser/replay); a test may inject a stub `replay`/`parse` to exercise
 * the refusal branch that a genuine, always-replay-consistent produced artifact cannot reach.
 */
export interface SinkOwners {
  serialize(artifact: FireArtifactV1): string;
  parse(bytes: string): FireArtifactV1;
  replay(artifact: FireArtifactV1): string[];
}

const productionOwners: SinkOwners = {
  serialize: serializeFireArtifactV1,
  parse: parseFireArtifactV1,
  replay: verifyFireArtifactReplay,
};

export class FireArtifactSink {
  constructor(
    private readonly baseDir: string,
    private readonly fs: ArtifactFs = nodeArtifactFs,
    private readonly owners: SinkOwners = productionOwners,
  ) {}

  /**
   * Install a produced artifact durably. Returns its path and whether THIS call created it
   * (`false` = an idempotent completion retry over exact identical bytes). Throws — with ZERO
   * filesystem effect — on a forged / unredacted / replay-failing / non-sha256 artifact, and
   * fails loud on a byte-different collision at the same path.
   */
  install(artifact: FireArtifactV1): { path: string; created: boolean } {
    // Authenticate + serialize + strict-parse + full replay-verify the EXACT final bytes
    // BEFORE any filesystem effect. serializeFireArtifactV1 authenticates the producer brand
    // and asserts redaction-clean; nothing is read off the artifact before it. The path fields
    // come from the PARSED exact-byte value, so the durable name and durable bytes share one
    // authority.
    const bytes = this.owners.serialize(artifact);
    const buffer = Buffer.from(bytes, 'utf8');
    const parsed = this.owners.parse(bytes);
    const violations = this.owners.replay(parsed);
    if (violations.length > 0) {
      throw new Error(`refusing to install a fire artifact that fails replay: ${violations[0]}`);
    }
    // cohortId is already sha256 by the strict schema; fireId is only nonEmpty there. Require
    // the path grammar on both before either becomes a path component.
    if (!SHA256_HEX.test(parsed.cohortId)) throw new Error('artifact cohortId is not a lowercase sha256 digest');
    if (!SHA256_HEX.test(parsed.fireId)) throw new Error('artifact fireId is not a lowercase sha256 digest');

    // The collision-safe final path — gameId → ONE base64url segment (no separator /
    // traversal), scope in canonical MARKET_ORDINAL order.
    const scope = [...parsed.scopedMarkets].sort(byOrdinal).join('+');
    const gameSegment = gameIdSegment(parsed.gameId);
    const dir = join(this.baseDir, parsed.cohortId);
    const finalPath = join(dir, `fire-${gameSegment}-${scope}-${parsed.fireId}.json`);
    return this.installBytesNoClobber(dir, finalPath, parsed.fireId, buffer, 'fire artifact');
  }

  /**
   * Install a spend-escalation sidecar durably, beside its fire's artifact, under the SAME
   * atomic no-clobber fsync-durable loop: `fire-<gameSegment>-<scope>-<fireId>-spend.json`.
   * The bytes are the module serializer's canonical output, so a completion retry is
   * exact-byte idempotent and a byte-different pre-existing sidecar fails loud. Identity
   * fields are grammar-checked before they become path components, exactly like the
   * artifact's.
   */
  installSpendEscalationSidecar(sidecar: SpendEscalationSidecarV1): { path: string; created: boolean } {
    const bytes = serializeSpendEscalationSidecar(sidecar);
    const buffer = Buffer.from(bytes, 'utf8');
    if (!SHA256_HEX.test(sidecar.cohortId)) throw new Error('sidecar cohortId is not a lowercase sha256 digest');
    if (!SHA256_HEX.test(sidecar.fireId)) throw new Error('sidecar fireId is not a lowercase sha256 digest');
    const scope = [...sidecar.scopedMarkets].sort(byOrdinal).join('+');
    const gameSegment = gameIdSegment(sidecar.gameId);
    const dir = join(this.baseDir, sidecar.cohortId);
    const finalPath = join(dir, `fire-${gameSegment}-${scope}-${sidecar.fireId}-spend.json`);
    return this.installBytesNoClobber(dir, finalPath, `${sidecar.fireId}-spend`, buffer, 'spend escalation sidecar');
  }

  /** The shared atomic no-clobber byte-install loop. Delegates to the module-level
   *  {@link installBytesNoClobber} so both durable records — and the campaign manifest
   *  installer — ride ONE tested write path. */
  private installBytesNoClobber(
    dir: string,
    finalPath: string,
    tmpStem: string,
    buffer: Buffer,
    label: string,
  ): { path: string; created: boolean } {
    return installBytesNoClobber(this.fs, { dir, finalPath, tmpStem, buffer, label });
  }
}

/**
 * The atomic no-clobber byte-install loop (temp → complete write → fsync → close →
 * hard-link no-clobber → directory fsync; a pre-existing final path is accepted only for
 * exact raw-byte identity). Extracted verbatim from the sink so every durable file this
 * repo installs rides ONE tested write path; a byte-different pre-existing final throws the
 * typed {@link ByteDifferentCollisionError}, every other failure throws its own error.
 */
export function installBytesNoClobber(
  fs: ArtifactFs,
  params: { dir: string; finalPath: string; tmpStem: string; buffer: Buffer; label: string },
): { path: string; created: boolean } {
  const { dir, finalPath, tmpStem, buffer, label } = params;
  fs.mkdirp(dir);

  // A same-directory exclusive temp with an opaque collision-resistant suffix; the `wx`
  // open is the authority that two calls never own the same temp.
  const tmpPath = join(dir, `.${tmpStem}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let tempCreated = false;
  const cleanupTemp = (): void => {
    // Best-effort, after the result/durability decision is known: never masks the primary
    // result or exception, only unlinks a temp THIS call created, never the final path.
    if (!tempCreated) return;
    try {
      fs.unlink(tmpPath);
    } catch {
      /* best-effort */
    }
  };

  try {
    const fd = fs.openExclusive(tmpPath);
    tempCreated = true;

    // Complete write + temp fsync, then close EXACTLY ONCE (even on a write/fsync
    // failure), with a fixed error precedence.
    let writeError: unknown;
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const remaining = buffer.length - offset;
        const n = fs.write(fd, buffer, offset, remaining);
        if (!Number.isInteger(n) || n < 1 || n > remaining) {
          throw new Error(`${label} temp write made invalid progress (${String(n)} of ${remaining} remaining)`);
        }
        offset += n;
      }
      fs.fsync(fd);
    } catch (error) {
      writeError = error;
    }
    let closeError: unknown;
    try {
      fs.close(fd);
    } catch (error) {
      closeError = error;
    }
    // A write/fsync failure wins over a close failure; a close failure surfaces only when
    // the write/fsync succeeded. No link occurs unless write, fsync, and close all pass.
    if (writeError !== undefined) throw writeError;
    if (closeError !== undefined) throw closeError;

    // Atomic no-clobber install → directory fsync; a pre-existing final path is an
    // idempotent retry ONLY for exact raw-byte identity, else a fail-loud collision.
    //
    // The catch below wraps ONLY `link`, so reconciliation is entered solely by an EEXIST
    // that ORIGINATED THERE. Once the link has succeeded, this fire's durable entry exists
    // and every later failure — including one that merely happens to carry an EEXIST code,
    // e.g. from `syncDir` — must propagate as the primary error rather than be read as a
    // pre-existing-path collision. (An origin-blind `code === 'EEXIST'` test over both calls
    // would report a durably-unsynced install as an idempotent completion.)
    let linkFoundExisting = false;
    try {
      fs.link(tmpPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      linkFoundExisting = true;
    }

    let result: { path: string; created: boolean };
    if (!linkFoundExisting) {
      // The link installed this call's bytes; a directory-sync failure fails the call (the
      // entry may exist but is not durable — recoverable by the identical-byte retry below).
      fs.syncDir(dir);
      result = { path: finalPath, created: true };
    } else {
      const existing = fs.readFile(finalPath);
      if (!existing.equals(buffer)) {
        throw new ByteDifferentCollisionError(
          `refusing to overwrite a byte-different ${label} already installed at ${finalPath}`,
        );
      }
      // Re-establish directory durability: a prior call may have linked the final entry and
      // then failed its own directory fsync, so the idempotent path must sync too.
      fs.syncDir(dir);
      result = { path: finalPath, created: false };
    }
    cleanupTemp();
    return result;
  } catch (error) {
    cleanupTemp();
    throw error;
  }
}
