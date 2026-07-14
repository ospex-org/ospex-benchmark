import { inflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP reader for the Retrosheet game-log archives. Dependency-free on
 * purpose: the only alternative was adding a zip package to a public repo for
 * a one-off ingest, and this reader keeps the supply-chain surface at zero.
 *
 * Scope is deliberately narrow — classic PKZIP archives with stored (0) or
 * deflate (8) entries, which is what Retrosheet publishes. Everything is
 * validated against the central directory (the authoritative record): entry
 * sizes, local-header signatures, and the CRC-32 of the decompressed bytes.
 * ZIP64 archives are rejected loudly rather than misread.
 */

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_LENGTH = 0xffff;

let crcTable: Uint32Array | null = null;

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

/** Standard CRC-32 (IEEE 802.3, the ZIP polynomial), returned unsigned. */
export function crc32(data: Buffer): number {
  if (crcTable === null) crcTable = buildCrcTable();
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The end-of-central-directory record sits at the end of the archive,
 * possibly followed by a comment. Scan backwards and accept only a candidate
 * whose recorded comment length lands exactly on the end of the buffer, so a
 * signature byte-pattern inside the comment can't be mistaken for the record.
 */
function findEndOfCentralDirectory(archive: Buffer): number {
  const floor = Math.max(0, archive.length - (MAX_COMMENT_LENGTH + EOCD_MIN_SIZE));
  for (let pos = archive.length - EOCD_MIN_SIZE; pos >= floor; pos -= 1) {
    if (archive.readUInt32LE(pos) !== EOCD_SIGNATURE) continue;
    const commentLength = archive.readUInt16LE(pos + 20);
    if (pos + EOCD_MIN_SIZE + commentLength === archive.length) return pos;
  }
  throw new ZipError('no end-of-central-directory record found — not a ZIP archive?');
}

/**
 * Read every entry of a ZIP archive into memory. Throws ZipError on any
 * structural inconsistency, unsupported feature, or integrity failure —
 * never returns partially-validated data.
 */
export function readZipEntries(archive: Buffer): ZipEntry[] {
  if (archive.length < EOCD_MIN_SIZE) {
    throw new ZipError(`archive is only ${archive.length} bytes — not a ZIP archive`);
  }
  const eocdPos = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(eocdPos + 10);
  const centralDirectoryOffset = archive.readUInt32LE(eocdPos + 16);
  if (entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported');
  }

  const entries: ZipEntry[] = [];
  let pos = centralDirectoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (pos + 46 > archive.length || archive.readUInt32LE(pos) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new ZipError(`central directory entry ${i} is malformed`);
    }
    const method = archive.readUInt16LE(pos + 10);
    const expectedCrc = archive.readUInt32LE(pos + 16);
    const compressedSize = archive.readUInt32LE(pos + 20);
    const uncompressedSize = archive.readUInt32LE(pos + 24);
    const nameLength = archive.readUInt16LE(pos + 28);
    const extraLength = archive.readUInt16LE(pos + 30);
    const commentLength = archive.readUInt16LE(pos + 32);
    const localHeaderOffset = archive.readUInt32LE(pos + 42);
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new ZipError('ZIP64 entry sizes are not supported');
    }
    const name = archive.subarray(pos + 46, pos + 46 + nameLength).toString('latin1');

    if (
      localHeaderOffset + 30 > archive.length ||
      archive.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE
    ) {
      throw new ZipError(`local file header for "${name}" is malformed`);
    }
    // The local header's own size fields may legitimately be zero (data
    // descriptors); the central directory sizes above are authoritative.
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > archive.length) {
      throw new ZipError(`compressed data for "${name}" runs past the end of the archive`);
    }
    const raw = archive.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw);
      } catch (error) {
        throw new ZipError(
          `deflate failure for "${name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      throw new ZipError(`unsupported compression method ${method} for "${name}"`);
    }
    if (data.length !== uncompressedSize) {
      throw new ZipError(
        `size mismatch for "${name}": central directory says ${uncompressedSize}, got ${data.length}`,
      );
    }
    if (crc32(data) !== expectedCrc) {
      throw new ZipError(`CRC-32 mismatch for "${name}" — corrupt archive?`);
    }
    entries.push({ name, data });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
