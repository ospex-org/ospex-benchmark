import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { crc32, readZipEntries, ZipError } from './zip.js';

// ---------------------------------------------------------------------------
// Test-side ZIP writer: assembles archives byte-by-byte from the PKZIP spec
// so the reader is exercised against independently constructed input, not
// against its own inverse.
// ---------------------------------------------------------------------------

interface TestEntry {
  name: string;
  content: Buffer;
  method: 0 | 8;
  /** Overrides for corruption tests. */
  crcOverride?: number;
  uncompressedSizeOverride?: number;
}

function localHeader(entry: TestEntry, compressed: Buffer, crc: number): Buffer {
  const name = Buffer.from(entry.name, 'latin1');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(0, 10); // mod time
  header.writeUInt16LE(0, 12); // mod date
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(entry.uncompressedSizeOverride ?? entry.content.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28); // extra length
  return Buffer.concat([header, name]);
}

function centralEntry(entry: TestEntry, compressed: Buffer, crc: number, offset: number): Buffer {
  const name = Buffer.from(entry.name, 'latin1');
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4); // version made by
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(0, 8); // flags
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(0, 12); // mod time
  header.writeUInt16LE(0, 14); // mod date
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressed.length, 20);
  header.writeUInt32LE(entry.uncompressedSizeOverride ?? entry.content.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30); // extra length
  header.writeUInt16LE(0, 32); // comment length
  header.writeUInt32LE(offset, 42); // local header offset
  return Buffer.concat([header, name]);
}

function endOfCentralDirectory(
  count: number,
  cdSize: number,
  cdOffset: number,
  comment: Buffer = Buffer.alloc(0),
): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(0x06054b50, 0);
  header.writeUInt16LE(0, 4); // disk number
  header.writeUInt16LE(0, 6); // central directory disk
  header.writeUInt16LE(count, 8); // entries on this disk
  header.writeUInt16LE(count, 10); // entries total
  header.writeUInt32LE(cdSize, 12);
  header.writeUInt32LE(cdOffset, 16);
  header.writeUInt16LE(comment.length, 20);
  return Buffer.concat([header, comment]);
}

function buildZip(entries: TestEntry[], comment: Buffer = Buffer.alloc(0)): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const compressed = entry.method === 8 ? deflateRawSync(entry.content) : entry.content;
    const crc = entry.crcOverride ?? crc32(entry.content);
    const local = localHeader(entry, compressed, crc);
    centralParts.push(centralEntry(entry, compressed, crc, offset));
    localParts.push(local, compressed);
    offset += local.length + compressed.length;
  }
  const central = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    central,
    endOfCentralDirectory(entries.length, central.length, offset, comment),
  ]);
}

// ---------------------------------------------------------------------------
// crc32
// ---------------------------------------------------------------------------

test('crc32 matches the standard check value for "123456789"', () => {
  // 0xCBF43926 is the published CRC-32/IEEE check value — pins the
  // polynomial and bit order independently of the reader's round trip.
  assert.equal(crc32(Buffer.from('123456789', 'latin1')), 0xcbf43926);
});

test('crc32 of the empty buffer is 0', () => {
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

// ---------------------------------------------------------------------------
// readZipEntries
// ---------------------------------------------------------------------------

test('reads a stored entry back byte-identical', () => {
  const content = Buffer.from('stored payload \x00\x01\x02', 'latin1');
  const entries = readZipEntries(buildZip([{ name: 'a.txt', content, method: 0 }]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.name, 'a.txt');
  assert.deepEqual(entries[0]?.data, content);
});

test('reads a deflated entry back byte-identical', () => {
  const content = Buffer.from('deflate me '.repeat(500), 'latin1');
  const entries = readZipEntries(buildZip([{ name: 'gl2023.txt', content, method: 8 }]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.name, 'gl2023.txt');
  assert.deepEqual(entries[0]?.data, content);
});

test('reads multiple entries in central-directory order', () => {
  const first = Buffer.from('first', 'latin1');
  const second = Buffer.from('second '.repeat(100), 'latin1');
  const entries = readZipEntries(
    buildZip([
      { name: 'one.txt', content: first, method: 0 },
      { name: 'two.txt', content: second, method: 8 },
    ]),
  );
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['one.txt', 'two.txt'],
  );
  assert.deepEqual(entries[0]?.data, first);
  assert.deepEqual(entries[1]?.data, second);
});

test('archive comment is tolerated, including one embedding a fake EOCD signature', () => {
  const content = Buffer.from('payload', 'latin1');
  // A forged EOCD block inside the comment whose own comment-length field is
  // inconsistent with its position — the backwards scan must reject it and
  // keep looking for the real record.
  const fake = Buffer.alloc(22);
  fake.writeUInt32LE(0x06054b50, 0);
  fake.writeUInt16LE(9999, 20);
  const entries = readZipEntries(buildZip([{ name: 'a.txt', content, method: 0 }], fake));
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]?.data, content);
});

test('rejects a non-ZIP buffer', () => {
  assert.throws(
    () => readZipEntries(Buffer.from('this is not a zip archive at all', 'latin1')),
    ZipError,
  );
});

test('rejects a truncated archive', () => {
  const archive = buildZip([{ name: 'a.txt', content: Buffer.from('payload'), method: 8 }]);
  assert.throws(() => readZipEntries(archive.subarray(0, archive.length - 4)), ZipError);
});

test('rejects a flipped payload byte via CRC-32', () => {
  const archive = buildZip([{ name: 'a.txt', content: Buffer.from('payload-x'), method: 0 }]);
  // The stored payload begins right after the 30-byte local header + name.
  const dataStart = 30 + 'a.txt'.length;
  const corrupted = Buffer.from(archive);
  corrupted[dataStart] = corrupted[dataStart]! ^ 0xff;
  assert.throws(() => readZipEntries(corrupted), /CRC-32 mismatch/);
});

test('rejects a central-directory CRC that disagrees with the data', () => {
  const archive = buildZip([
    { name: 'a.txt', content: Buffer.from('payload'), method: 0, crcOverride: 0xdeadbeef },
  ]);
  assert.throws(() => readZipEntries(archive), /CRC-32 mismatch/);
});

test('rejects an uncompressed-size mismatch', () => {
  const archive = buildZip([
    {
      name: 'a.txt',
      content: Buffer.from('payload'),
      method: 0,
      uncompressedSizeOverride: 99,
    },
  ]);
  assert.throws(() => readZipEntries(archive), /size mismatch/);
});

test('rejects unsupported compression methods', () => {
  // Method 12 (bzip2) — hand-mark a stored entry as such.
  const archive = buildZip([{ name: 'a.txt', content: Buffer.from('payload'), method: 0 }]);
  const patched = Buffer.from(archive);
  patched.writeUInt16LE(12, 8); // local header method
  const cdStart = archive.length - 22 - 46 - 'a.txt'.length;
  patched.writeUInt16LE(12, cdStart + 10); // central directory method
  assert.throws(() => readZipEntries(patched), /unsupported compression method/);
});
