import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { MARKET_ORDINAL } from './fireArtifact.js';
import { parseFireArtifactV1, serializeFireArtifactV1, verifyFireArtifactReplay } from './fireArtifactWriter.js';
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
 * It accepts ONLY the artifact: no permit, claim, admission, lease, lifecycle, store, or
 * prepared-fire snapshot. The permit reconciliation (binding the artifact to the admission)
 * is a later slice's thin authorized wrapper, which authenticates the permit and then
 * delegates to this sink. Pure serialization + a thin `node:fs` install; no producer, store,
 * watcher, provider, close, CLV, scoring, coverage, or runtime wiring.
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

function byOrdinal(a: MarketKey, b: MarketKey): number {
  return MARKET_ORDINAL[a] - MARKET_ORDINAL[b];
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
    const gameSegment = Buffer.from(parsed.gameId, 'utf8').toString('base64url');
    const dir = join(this.baseDir, parsed.cohortId);
    const finalPath = join(dir, `fire-${gameSegment}-${scope}-${parsed.fireId}.json`);

    this.fs.mkdirp(dir);

    // A same-directory exclusive temp with an opaque collision-resistant suffix; the `wx`
    // open is the authority that two calls never own the same temp.
    const tmpPath = join(dir, `.${parsed.fireId}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    let tempCreated = false;
    const cleanupTemp = (): void => {
      // Best-effort, after the result/durability decision is known: never masks the primary
      // result or exception, only unlinks a temp THIS call created, never the final path.
      if (!tempCreated) return;
      try {
        this.fs.unlink(tmpPath);
      } catch {
        /* best-effort */
      }
    };

    try {
      const fd = this.fs.openExclusive(tmpPath);
      tempCreated = true;

      // Complete write + temp fsync, then close EXACTLY ONCE (even on a write/fsync
      // failure), with a fixed error precedence.
      let writeError: unknown;
      try {
        let offset = 0;
        while (offset < buffer.length) {
          const remaining = buffer.length - offset;
          const n = this.fs.write(fd, buffer, offset, remaining);
          if (!Number.isInteger(n) || n < 1 || n > remaining) {
            throw new Error(`fire artifact temp write made invalid progress (${String(n)} of ${remaining} remaining)`);
          }
          offset += n;
        }
        this.fs.fsync(fd);
      } catch (error) {
        writeError = error;
      }
      let closeError: unknown;
      try {
        this.fs.close(fd);
      } catch (error) {
        closeError = error;
      }
      // A write/fsync failure wins over a close failure; a close failure surfaces only when
      // the write/fsync succeeded. No link occurs unless write, fsync, and close all pass.
      if (writeError !== undefined) throw writeError;
      if (closeError !== undefined) throw closeError;

      // Atomic no-clobber install → directory fsync; a pre-existing final path is an
      // idempotent retry ONLY for exact raw-byte identity, else a fail-loud collision.
      let result: { path: string; created: boolean };
      try {
        this.fs.link(tmpPath, finalPath);
        this.fs.syncDir(dir);
        result = { path: finalPath, created: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = this.fs.readFile(finalPath);
        if (!existing.equals(buffer)) {
          throw new Error(`refusing to overwrite a byte-different fire artifact already installed at ${finalPath}`);
        }
        // Re-establish directory durability: a prior call may have linked the final entry and
        // then failed its own directory fsync, so the idempotent path must sync too.
        this.fs.syncDir(dir);
        result = { path: finalPath, created: false };
      }
      cleanupTemp();
      return result;
    } catch (error) {
      cleanupTemp();
      throw error;
    }
  }
}
