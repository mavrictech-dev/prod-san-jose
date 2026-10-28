import { inflateRawSync } from 'node:zlib';
import { SIRE_LIMITS, SireError, sireEnsure, validateSireFileName } from './sire-safety';

type Entry = { name: string; size: number; compressed: number; crc: number; method: number; offset: number; data: number; end: number };
export type SireTextFile = { fileName: string; bytes: Buffer };
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** received-core only accepts XML/PDF. Same preflight strategy, scoped to TXT/CSV:
 * flat regular files, single disk, stored/deflate, no encryption, ZIP64 or nesting.
 * Inspect ALL local/central headers before expansion; no filesystem extraction. */
export function unpackSireZip(input: Uint8Array, budget?: { maxEntries: number; maxExpandedBytes: number }): SireTextFile[] {
  sireEnsure(input instanceof Uint8Array && input.byteLength >= 22 && input.byteLength <= SIRE_LIMITS.downloadBytes, 'SIZE');
  const bytes = Buffer.from(input);
  try {
    sireEnsure(bytes.readUInt32LE(0) === 0x04034b50, 'ARCHIVE');
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
      if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { eocd = i; break; }
    }
    sireEnsure(eocd >= 0, 'ARCHIVE');
    const count = bytes.readUInt16LE(eocd + 10), centralSize = bytes.readUInt32LE(eocd + 12), central = bytes.readUInt32LE(eocd + 16);
    sireEnsure(bytes.readUInt16LE(eocd + 4) === 0 && bytes.readUInt16LE(eocd + 6) === 0 &&
      bytes.readUInt16LE(eocd + 8) === count && count > 0 && count <= Math.min(SIRE_LIMITS.zipEntries, budget?.maxEntries ?? SIRE_LIMITS.zipEntries) &&
      central !== 0xffffffff && centralSize !== 0xffffffff && central + centralSize === eocd, 'ARCHIVE');
    const entries: Entry[] = [], names = new Set<string>(); let cursor = central, expanded = 0;
    const extra = (start: number, length: number) => {
      const end = start + length; sireEnsure(end <= bytes.length, 'ARCHIVE');
      while (start < end) {
        sireEnsure(start + 4 <= end, 'ARCHIVE');
        const id = bytes.readUInt16LE(start), size = bytes.readUInt16LE(start + 2); start += 4;
        sireEnsure(start + size <= end && ![1, 0x000d, 0x5855, 0x756e, 0x7075, 0x6375, 0x9901].includes(id), 'ARCHIVE');
        start += size;
      }
    };
    for (let i = 0; i < count; i++) {
      sireEnsure(cursor + 46 <= eocd && bytes.readUInt32LE(cursor) === 0x02014b50, 'ARCHIVE');
      const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16),
        compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24),
        nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30),
        commentLength = bytes.readUInt16LE(cursor + 32), external = bytes.readUInt32LE(cursor + 38),
        offset = bytes.readUInt32LE(cursor + 42), end = cursor + 46 + nameLength + extraLength + commentLength;
      sireEnsure(end <= eocd && nameLength > 0 && nameLength <= 255 && bytes.readUInt16LE(cursor + 34) === 0 &&
        [0, 8].includes(method) && (flags & ~0x080e) === 0 && (method === 8 || !(flags & 6)), 'ARCHIVE');
      const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
      sireEnsure(rawName.every(byte => byte < 128), 'ARCHIVE');
      const name = rawName.toString('ascii'); validateSireFileName(name, /\.(?:txt|csv)$/i);
      sireEnsure(!names.has(name.toLowerCase()), 'ARCHIVE'); names.add(name.toLowerCase());
      const type = (external >>> 16) & 0xf000;
      sireEnsure((type === 0 || type === 0x8000) && !(external & 0x18), 'ARCHIVE');
      sireEnsure(size > 0 && size <= SIRE_LIMITS.entryBytes && compressed > 0 && compressed !== 0xffffffff &&
        offset !== 0xffffffff && size / compressed <= SIRE_LIMITS.compressionRatio && (method !== 0 || size === compressed), 'SIZE');
      expanded += size; sireEnsure(expanded <= Math.min(SIRE_LIMITS.expandedBytes, budget?.maxExpandedBytes ?? SIRE_LIMITS.expandedBytes), 'SIZE'); extra(cursor + 46 + nameLength, extraLength);
      sireEnsure(offset + 30 <= central && bytes.readUInt32LE(offset) === 0x04034b50, 'ARCHIVE');
      const localFlags = bytes.readUInt16LE(offset + 6), localMethod = bytes.readUInt16LE(offset + 8),
        localCrc = bytes.readUInt32LE(offset + 14), localCompressed = bytes.readUInt32LE(offset + 18),
        localSize = bytes.readUInt32LE(offset + 22), localNameLength = bytes.readUInt16LE(offset + 26),
        localExtraLength = bytes.readUInt16LE(offset + 28), data = offset + 30 + localNameLength + localExtraLength;
      sireEnsure(localFlags === flags && localMethod === method && data + compressed <= central &&
        localNameLength === nameLength && bytes.subarray(offset + 30, offset + 30 + localNameLength).equals(rawName), 'ARCHIVE');
      if (flags & 8) sireEnsure((localCrc === 0 || localCrc === crc) &&
        (localCompressed === 0 || localCompressed === compressed) && (localSize === 0 || localSize === size), 'ARCHIVE');
      else sireEnsure(localCrc === crc && localCompressed === compressed && localSize === size, 'ARCHIVE');
      extra(offset + 30 + localNameLength, localExtraLength);
      let localEnd = data + compressed;
      if (flags & 8) {
        sireEnsure(localEnd + 12 <= central, 'ARCHIVE');
        if (bytes.readUInt32LE(localEnd) === 0x08074b50) localEnd += 4;
        sireEnsure(localEnd + 12 <= central && bytes.readUInt32LE(localEnd) === crc &&
          bytes.readUInt32LE(localEnd + 4) === compressed && bytes.readUInt32LE(localEnd + 8) === size, 'ARCHIVE');
        localEnd += 12;
      }
      entries.push({ name, size, compressed, crc, method, offset, data, end: localEnd }); cursor = end;
    }
    sireEnsure(cursor === eocd, 'ARCHIVE');
    let localEnd = 0;
    for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
      sireEnsure(entry.offset === localEnd, 'ARCHIVE'); localEnd = entry.end;
    }
    sireEnsure(localEnd === central, 'ARCHIVE');
    return entries.map(entry => {
      const compressed = bytes.subarray(entry.data, entry.data + entry.compressed);
      let expanded: Buffer;
      if (entry.method === 0) expanded = Buffer.from(compressed);
      else {
        const inflated = inflateRawSync(compressed, { maxOutputLength: entry.size, info: true }) as unknown as {
          buffer: Buffer; engine: { bytesWritten: number };
        };
        sireEnsure(inflated.engine.bytesWritten === compressed.length, 'ARCHIVE'); expanded = inflated.buffer;
      }
      sireEnsure(expanded.length === entry.size && crc32(expanded) === entry.crc &&
        !(expanded[0] === 0x50 && expanded[1] === 0x4b), 'ARCHIVE');
      return { fileName: entry.name, bytes: expanded };
    });
  } catch (error) {
    if (error instanceof SireError) throw error;
    throw new SireError('ARCHIVE');
  }
}
