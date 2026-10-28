import { inflateRawSync } from 'node:zlib';

const MAX_ZIP = 4 * 1024 * 1024, MAX_XML = 2 * 1024 * 1024;
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Classic ZIP only, bounded inflation, CRC and contiguous matching central/local entries.
 * CDRs may include SUNAT's empty dummy/ directory. No extraction to the filesystem. */
export function productionBatchesZipMembers(zip: Buffer): Record<string, Buffer> {
  const fail = (): never => { throw new Error('ZIP de producción inválido'); };
  try {
    if (!Buffer.isBuffer(zip) || zip.length < 22 || zip.length > MAX_ZIP) fail();
    const end = zip.length - 22;
    if (zip.readUInt32LE(end) !== 0x06054b50 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) || zip.readUInt16LE(end + 20)) fail();
    const count = zip.readUInt16LE(end + 10), central = zip.readUInt32LE(end + 16);
    if (count < 1 || count > 102 || count !== zip.readUInt16LE(end + 8) || central + zip.readUInt32LE(end + 12) !== end) fail();
    const names = new Set<string>(), ranges: { start: number; end: number }[] = [];
    let cursor = central; const result: Record<string, Buffer> = Object.create(null); let total = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) fail();
      const flags = zip.readUInt16LE(cursor + 8), method = zip.readUInt16LE(cursor + 10), crc = zip.readUInt32LE(cursor + 16);
      const compressed = zip.readUInt32LE(cursor + 20), size = zip.readUInt32LE(cursor + 24), nameLength = zip.readUInt16LE(cursor + 28);
      const extra = zip.readUInt16LE(cursor + 30), comment = zip.readUInt16LE(cursor + 32), offset = zip.readUInt32LE(cursor + 42);
      if (flags & ~0x0808 || ![0, 8].includes(method) || size > MAX_XML || compressed === 0xffffffff ||
          offset === 0xffffffff || zip.readUInt16LE(cursor + 34) || cursor + 46 + nameLength + extra + comment > end) fail();
      const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameLength), name = nameBytes.toString('utf8');
      const dummy = name === 'dummy/';
      if (!Buffer.from(name).equals(nameBytes) || names.has(name) ||
          (dummy ? size !== 0 || crc !== 0 : !/^[A-Za-z0-9_-]{1,110}\.xml$/.test(name) || size === 0 ||
            !/^R-/.test(name))) fail();
      names.add(name);
      if (offset + 30 > central || zip.readUInt32LE(offset) !== 0x04034b50 || zip.readUInt16LE(offset + 6) !== flags || zip.readUInt16LE(offset + 8) !== method) fail();
      const localLength = zip.readUInt16LE(offset + 26), start = offset + 30 + localLength + zip.readUInt16LE(offset + 28);
      if (start + compressed > central || !zip.subarray(offset + 30, offset + 30 + localLength).equals(nameBytes)) fail();
      const declared = [crc, compressed, size];
      if (declared.some((value, n) => {
        const local = zip.readUInt32LE(offset + 14 + n * 4);
        return flags & 8 ? local !== 0 && local !== value : local !== value;
      })) fail();
      let finish = start + compressed;
      // zlib enforces the output bound even if a malicious ZIP lies about its original size.
      const xml = method === 0 ? Buffer.from(zip.subarray(start, finish))
        : inflateRawSync(zip.subarray(start, finish), { maxOutputLength: MAX_XML });
      if (xml.length !== size || crc32(xml) !== crc) fail();
      if (flags & 8) {
        if (finish + 12 > central) fail();
        if (zip.readUInt32LE(finish) === 0x08074b50) finish += 4;
        if (finish + 12 > central || declared.some((value, n) => zip.readUInt32LE(finish + n * 4) !== value)) fail();
        finish += 12;
      }
      ranges.push({ start: offset, end: finish });
      if ((total += xml.length) > 16 * 1024 * 1024) fail(); if (!dummy) result[name] = xml;
      cursor += 46 + nameLength + extra + comment;
    }
    ranges.sort((a, b) => a.start - b.start);
    if (!Object.keys(result).length || cursor !== end || ranges[0].start !== 0 || ranges.some((range, i) => range.end !== (ranges[i + 1]?.start ?? central))) fail();
    return result;
  } catch { return fail(); }
}
