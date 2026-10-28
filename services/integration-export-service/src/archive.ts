import { Buffer } from 'node:buffer';
import { IntegrationReadError } from '@factuez/service-access/dist/integration';

const MAXIMUM_BYTES = 64 * 1024 * 1024;
const MAXIMUM_ENTRIES = 10001;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_HEADER_BYTES = 22;
// The final assertion also rejects trailing line breaks, unlike a bare `$`.
const SAFE_PATH = /^(?:documents\.jsonl|manifest\.json|artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:xml|zip|pdf))(?![\s\S])/;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** STORED ZIP with fixed metadata; source-evidence integrity belongs to the caller. */
export function buildExportArchive(files: { path: string; bytes: Buffer }[], maximum = MAXIMUM_BYTES): Buffer {
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > MAXIMUM_BYTES || !Array.isArray(files))
    throw new IntegrationReadError(400, 'INVALID_REQUEST');
  if (files.length > MAXIMUM_ENTRIES) throw new IntegrationReadError(422, 'EXPORT_TOO_LARGE');

  const paths = new Set<string>();
  const entries: { path: string; name: Buffer; bytes: Buffer }[] = [];
  let localBytes = 0;
  let centralBytes = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file) || typeof file.path !== 'string' ||
        !SAFE_PATH.test(file.path) || !Buffer.isBuffer(file.bytes) || paths.has(file.path))
      throw new IntegrationReadError(400, 'INVALID_REQUEST');
    paths.add(file.path);
    const name = Buffer.from(file.path, 'ascii');
    localBytes += LOCAL_HEADER_BYTES + name.length + file.bytes.length;
    centralBytes += CENTRAL_HEADER_BYTES + name.length;
    if (localBytes + centralBytes + END_HEADER_BYTES > maximum)
      throw new IntegrationReadError(422, 'EXPORT_TOO_LARGE');
    entries.push({ path: file.path, name, bytes: file.bytes });
  }
  const totalBytes = localBytes + centralBytes + END_HEADER_BYTES;
  if (totalBytes > maximum) throw new IntegrationReadError(422, 'EXPORT_TOO_LARGE');
  // These caps keep every count below 0xffff and every size/offset below 0xffffffff: no ZIP64.
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const archive = Buffer.alloc(totalBytes);
  let localOffset = 0;
  let centralOffset = localBytes;
  for (const entry of entries) {
    const crc = crc32(entry.bytes);
    archive.writeUInt32LE(0x04034b50, localOffset);
    archive.writeUInt16LE(20, localOffset + 4);
    // Flags, compression method (STORED), DOS time and extra lengths stay zero.
    archive.writeUInt16LE(0x0021, localOffset + 12); // 1980-01-01, independent of time zone.
    archive.writeUInt32LE(crc, localOffset + 14);
    archive.writeUInt32LE(entry.bytes.length, localOffset + 18);
    archive.writeUInt32LE(entry.bytes.length, localOffset + 22);
    archive.writeUInt16LE(entry.name.length, localOffset + 26);
    entry.name.copy(archive, localOffset + LOCAL_HEADER_BYTES);
    entry.bytes.copy(archive, localOffset + LOCAL_HEADER_BYTES + entry.name.length);

    archive.writeUInt32LE(0x02014b50, centralOffset);
    archive.writeUInt16LE(20, centralOffset + 4); // ZIP 2.0, DOS creator.
    archive.writeUInt16LE(20, centralOffset + 6);
    archive.writeUInt16LE(0x0021, centralOffset + 14);
    archive.writeUInt32LE(crc, centralOffset + 16);
    archive.writeUInt32LE(entry.bytes.length, centralOffset + 20);
    archive.writeUInt32LE(entry.bytes.length, centralOffset + 24);
    archive.writeUInt16LE(entry.name.length, centralOffset + 28);
    archive.writeUInt32LE(localOffset, centralOffset + 42);
    entry.name.copy(archive, centralOffset + CENTRAL_HEADER_BYTES);

    localOffset += LOCAL_HEADER_BYTES + entry.name.length + entry.bytes.length;
    centralOffset += CENTRAL_HEADER_BYTES + entry.name.length;
  }
  archive.writeUInt32LE(0x06054b50, centralOffset);
  archive.writeUInt16LE(entries.length, centralOffset + 8);
  archive.writeUInt16LE(entries.length, centralOffset + 10);
  archive.writeUInt32LE(centralBytes, centralOffset + 12);
  archive.writeUInt32LE(localBytes, centralOffset + 16);
  return archive;
}
