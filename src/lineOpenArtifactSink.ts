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
 * self-verified file.
 *
 * `writeFireArtifactV1` (fireArtifactWriter) already serializes + replay-verifies before
 * an ordinary overwriting `writeFileSync`; this sink adds the operational safety the
 * runtime needs: it requires an unforgeable `DispatchPermit` (so a rehearsal artifact can
 * never be installed), encodes an arbitrary `gameId` into ONE base64url path segment (a
 * game id can never escape into extra segments or a traversal), serialize +
 * replay-verifies the EXACT final bytes before touching disk, writes + fsyncs a
 * same-directory exclusive temp file, and installs it via a hard link that FAILS rather
 * than replaces an existing final path. A pre-existing final path is accepted only if its
 * bytes are exactly ours (an idempotent completion retry); a byte-different collision
 * fails loud. Unlike the status snapshot (which may replace its prior version), a fire
 * artifact is immutable evidence and is never overwritten.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

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
  constructor(private readonly baseDir: string) {}

  write(permit: DispatchPermit, artifact: FireArtifactV1): { path: string; created: boolean } {
    // 1. Authenticate the authorization, then bind the artifact to exactly this fire.
    assertDispatchPermit(permit);
    if (artifact.cohortId !== permit.cohortId) throw new Error('artifact cohortId does not match the dispatch permit');
    if (artifact.fireId !== permit.fireId) throw new Error('artifact fireId does not match the dispatch permit');
    if (artifact.gameId !== permit.gameId) throw new Error('artifact gameId does not match the dispatch permit');
    const claimedMarkets = permit.claimedKeys.map((k) => k.market);
    if (!sameMarketSet(artifact.scopedMarkets, claimedMarkets)) {
      throw new Error('artifact scoped markets do not equal the permit claimed markets');
    }

    // 2. Require the hashed identity grammar for every path-forming id (cohortId/fireId
    //    are sha256 digests; a non-hex value must never form a path segment).
    if (!SHA256_HEX.test(artifact.cohortId)) throw new Error('artifact cohortId is not a sha256 digest');
    if (!SHA256_HEX.test(artifact.fireId)) throw new Error('artifact fireId is not a sha256 digest');

    // 3. Serialize + strict-parse + full replay-verify the EXACT final bytes BEFORE any
    //    filesystem effect (no unverified evidence ever reaches disk).
    const bytes = serializeFireArtifactV1(artifact); // asserts producer brand + redaction-clean
    const violations = verifyFireArtifactReplay(parseFireArtifactV1(bytes));
    if (violations.length > 0) {
      throw new Error(`refusing to install a fire artifact that fails replay: ${violations[0]}`);
    }

    // 4. Compute the collision-free path. gameId → one base64url segment (no separators,
    //    no traversal); scope in canonical ScopeKey order.
    const scope = [...artifact.scopedMarkets].sort(byOrdinal).join('+');
    const gameSegment = Buffer.from(artifact.gameId, 'utf8').toString('base64url');
    const dir = join(this.baseDir, artifact.cohortId);
    const finalPath = join(dir, `fire-${gameSegment}-${scope}-${artifact.fireId}.json`);
    mkdirSync(dir, { recursive: true });

    // 5. Write + fsync a same-directory exclusive temp file, then install by hard link —
    //    which fails EEXIST rather than clobbering an existing final path. The temp is
    //    cleaned on EVERY exit path by a best-effort helper that swallows its own error, so
    //    cleanup can never mask the primary result (a durable install) or the primary
    //    exception (a loud collision / write failure), and only a temp WE created is removed.
    const tmpPath = join(dir, `.${artifact.fireId}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    let tempCreated = false;
    const cleanupTemp = (): void => {
      if (!tempCreated) return;
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort: never override the primary return or exception */
      }
    };
    try {
      const fd = openSync(tmpPath, 'wx'); // exclusive create; only now do we own the temp
      tempCreated = true;
      try {
        writeSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      let result: { path: string; created: boolean };
      try {
        linkSync(tmpPath, finalPath); // atomic no-clobber: EEXIST if the final path exists
        result = { path: finalPath, created: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A final path already exists: an idempotent completion retry iff its bytes are
        // EXACTLY ours; a byte-different artifact at the same path is a fire-identity
        // collision (a bug) and must fail loud, never overwrite.
        const existing = readFileSync(finalPath, 'utf8');
        if (existing !== bytes) {
          throw new Error(`refusing to overwrite a byte-different fire artifact already installed at ${finalPath}`);
        }
        result = { path: finalPath, created: false };
      }
      cleanupTemp();
      return result;
    } catch (error) {
      cleanupTemp(); // remove the orphan temp on any write / fsync / link failure
      throw error;
    }
  }
}
