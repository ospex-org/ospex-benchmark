import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { MARKET_ORDINAL } from './fireArtifact.js';
import { parseFireArtifactV1, serializeFireArtifactV1, verifyFireArtifactReplay } from './fireArtifactWriter.js';
import { assertDispatchPermit } from './lineOpenClaim.js';
import type { DispatchPermit } from './lineOpenClaim.js';
import type { FireArtifactV1 } from './fireArtifactProducer.js';
import type { MarketKey } from './types.js';

/**
 * The canonical fire-artifact sink (SPEC-line-open-evidence-model.md §4/§5): install one
 * produced `FireArtifactV1` to a stable, collision-free path as an ATOMIC, NO-CLOBBER,
 * DURABLE, self-verified file.
 *
 * It requires an unforgeable `DispatchPermit` and binds the artifact to it (cohort / fire /
 * game / scope / request digest — the last a backstop for the pre-dispatch authority check),
 * encodes an arbitrary `gameId` into ONE base64url path segment (a game id can never escape
 * into extra segments or a traversal), serialize + replay-verifies the EXACT final bytes
 * before any filesystem effect, writes the COMPLETE bytes and fsyncs a same-directory
 * exclusive temp, installs via a hard link that FAILS rather than replaces an existing final
 * path, then fsyncs the containing directory before reporting success. A pre-existing final
 * path is accepted only for exact byte identity (an idempotent completion retry); a
 * byte-different collision fails loud. All filesystem primitives go through an injectable
 * `ArtifactFs` port so the durable-install ORDER is deterministically testable.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The filesystem primitives the sink drives, in the order it drives them. Injectable so the
 *  install ORDER (complete write → temp fsync → no-clobber install → directory fsync) is a
 *  deterministic, platform-independent witness. */
export interface ArtifactFs {
  mkdirp(dir: string): void;
  /** Exclusive create (fails if the path exists); returns a descriptor. */
  openExclusive(path: string): number;
  /** Write the COMPLETE buffer (looping over short writes). */
  writeAll(fd: number, data: Buffer): void;
  fsync(fd: number): void;
  close(fd: number): void;
  /** Hard-link install: throws `EEXIST` rather than replacing an existing final path. */
  link(existingPath: string, newPath: string): void;
  /** fsync the containing directory entry after install (best-effort where unsupported). */
  syncDir(dir: string): void;
  readFileUtf8(path: string): string;
  unlink(path: string): void;
}

/** The production `node:fs`-backed port. */
export const nodeArtifactFs: ArtifactFs = {
  mkdirp: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  openExclusive: (path) => openSync(path, 'wx'),
  writeAll: (fd, data) => {
    let offset = 0;
    while (offset < data.length) {
      offset += writeSync(fd, data, offset, data.length - offset);
    }
  },
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
  readFileUtf8: (path) => readFileSync(path, 'utf8'),
  unlink: (path) => unlinkSync(path),
};

export interface ArtifactSink {
  /** Install a produced artifact; returns its path and whether this call created it. */
  write(permit: DispatchPermit, artifact: FireArtifactV1): { path: string; created: boolean };
}

function byOrdinal(a: MarketKey, b: MarketKey): number {
  return MARKET_ORDINAL[a] - MARKET_ORDINAL[b];
}

function sameMarketSet(a: readonly MarketKey[], b: readonly MarketKey[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort(byOrdinal);
  const sb = [...b].sort(byOrdinal);
  return sa.every((m, i) => m === sb[i]);
}

export class LineOpenArtifactSink implements ArtifactSink {
  constructor(
    private readonly baseDir: string,
    private readonly fs: ArtifactFs = nodeArtifactFs,
  ) {}

  write(permit: DispatchPermit, artifact: FireArtifactV1): { path: string; created: boolean } {
    // 1. Authenticate the authorization, then bind the artifact to exactly this fire — the
    //    request-digest check is the backstop to the pre-dispatch authority gate (a permit's
    //    preparedBytesDigest is what the durable admission authorized).
    assertDispatchPermit(permit);
    if (artifact.cohortId !== permit.cohortId) throw new Error('artifact cohortId does not match the dispatch permit');
    if (artifact.fireId !== permit.fireId) throw new Error('artifact fireId does not match the dispatch permit');
    if (artifact.gameId !== permit.gameId) throw new Error('artifact gameId does not match the dispatch permit');
    if (!sameMarketSet(artifact.scopedMarkets, permit.claimedKeys.map((k) => k.market))) {
      throw new Error('artifact scoped markets do not equal the permit claimed markets');
    }
    if (artifact.requestSha256 !== permit.preparedBytesDigest) {
      throw new Error('artifact requestSha256 does not equal the permit-authorized digest');
    }

    // 2. Require the hashed identity grammar for every path-forming id.
    if (!SHA256_HEX.test(artifact.cohortId)) throw new Error('artifact cohortId is not a sha256 digest');
    if (!SHA256_HEX.test(artifact.fireId)) throw new Error('artifact fireId is not a sha256 digest');

    // 3. Serialize + strict-parse + full replay-verify the EXACT final bytes BEFORE any
    //    filesystem effect (no unverified evidence ever reaches disk).
    const bytes = serializeFireArtifactV1(artifact); // asserts producer brand + redaction-clean
    const violations = verifyFireArtifactReplay(parseFireArtifactV1(bytes));
    if (violations.length > 0) {
      throw new Error(`refusing to install a fire artifact that fails replay: ${violations[0]}`);
    }
    const buffer = Buffer.from(bytes, 'utf8');

    // 4. Compute the collision-free path. gameId → one base64url segment (no separators, no
    //    traversal); scope in canonical ScopeKey order.
    const scope = [...artifact.scopedMarkets].sort(byOrdinal).join('+');
    const gameSegment = Buffer.from(artifact.gameId, 'utf8').toString('base64url');
    const dir = join(this.baseDir, artifact.cohortId);
    const finalPath = join(dir, `fire-${gameSegment}-${scope}-${artifact.fireId}.json`);
    this.fs.mkdirp(dir);

    // 5. Durable install: complete write → temp fsync → no-clobber hard-link install →
    //    directory fsync → success. The temp is cleaned on every exit path by a best-effort
    //    helper that swallows its own error (so cleanup never masks the primary result or
    //    exception) and only removes a temp we created.
    const tmpPath = join(dir, `.${artifact.fireId}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    let tempCreated = false;
    const cleanupTemp = (): void => {
      if (!tempCreated) return;
      try {
        this.fs.unlink(tmpPath);
      } catch {
        /* best-effort: never override the primary return or exception */
      }
    };
    try {
      const fd = this.fs.openExclusive(tmpPath);
      tempCreated = true;
      try {
        this.fs.writeAll(fd, buffer); // the COMPLETE bytes (loops over short writes)
        this.fs.fsync(fd);
      } finally {
        this.fs.close(fd);
      }
      let result: { path: string; created: boolean };
      try {
        this.fs.link(tmpPath, finalPath); // atomic no-clobber: EEXIST if the final path exists
        this.fs.syncDir(dir); // the new directory entry is durable before we report success
        result = { path: finalPath, created: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A final path already exists: an idempotent completion retry iff its bytes are
        // EXACTLY ours; a byte-different artifact at the same path is a fire-identity
        // collision (a bug) and must fail loud, never overwrite.
        const existing = this.fs.readFileUtf8(finalPath);
        if (existing !== bytes) {
          throw new Error(`refusing to overwrite a byte-different fire artifact already installed at ${finalPath}`);
        }
        result = { path: finalPath, created: false };
      }
      cleanupTemp();
      return result;
    } catch (error) {
      cleanupTemp(); // remove the orphan temp on any write / fsync / link / dir-sync failure
      throw error;
    }
  }
}
