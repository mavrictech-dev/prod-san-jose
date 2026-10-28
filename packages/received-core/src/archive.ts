import AdmZip from 'adm-zip';
import { inflateRawSync } from 'node:zlib';
import { MiB, ensure, utf8, safeReceivedXml, ReceivedCoreError } from './safety';

export type ReceivedUploadFile = { fileName: string; bytes: Uint8Array };
export type ReceivedFile = { fileName: string; bytes: Buffer; kind: 'XML' | 'PROVIDER_PDF' | 'CDR' };
const APP_RESPONSE = 'urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2';
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0;
}
function safeName(name: string) {
  ensure(typeof name === 'string' && name.length > 0 && name.length <= 255 && name === name.trim() &&
    !/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*%]/.test(name) && !name.includes('..') && !/[. ]$/.test(name) &&
    name !== '.' && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name), 'Nombre/ruta de archivo no permitido');
}
const isZip = (bytes: Uint8Array) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
  [[3, 4], [5, 6], [7, 8]].some(([a, b]) => bytes[2] === a && bytes[3] === b);
function entryLimit(name: string) {
  if (/\.xml$/i.test(name)) return 2 * MiB;
  if (/\.pdf$/i.test(name)) return 4 * MiB;
  throw new ReceivedCoreError('Solo XML/PDF dentro del ZIP; ZIP anidado no permitido');
}
function classify(fileName: string, bytes: Buffer, inZip: boolean): ReceivedFile {
  ensure(!isZip(bytes), 'ZIP anidado no permitido');
  if (/\.pdf$/i.test(fileName)) {
    ensure(inZip && bytes.length > 0 && bytes.length <= 4 * MiB && bytes.subarray(0, 5).toString('ascii') === '%PDF-', 'PDF solo permitido como adjunto dentro de ZIP');
    return { fileName, bytes, kind: 'PROVIDER_PDF' };
  }
  ensure(/\.xml$/i.test(fileName), 'Archivo recibido no soportado');
  const root = safeReceivedXml(bytes), cdrName = /^R-.+\.xml$/i.test(fileName), response = root.localName === 'ApplicationResponse';
  ensure(!response || root.namespaceURI === APP_RESPONSE, 'Namespace CDR no soportado');
  ensure(cdrName === response, 'Nombre y contenido CDR no coinciden');
  return { fileName, bytes, kind: response ? 'CDR' : 'XML' };
}
type Entry = { name: string; crc: number; size: number; compressed: number; method: number; flags: number; offset: number; data: number; end: number };

/** Preflight every central AND local record before an inflater or AdmZip sees an
 * entry. Only single disk, non-ZIP64 stored/deflate regular flat files supported.
 * Bounded zlib is used for expansion: AdmZip.getData() has no output allocation cap. */
function inspectZip(bytes: Buffer): Entry[] {
  ensure(bytes.length >= 22 && bytes.readUInt32LE(0) === 0x04034b50, 'ZIP inválido o vacío');
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { eocd = i; break; }
  }
  ensure(eocd >= 0, 'Directorio ZIP inválido');
  const count = bytes.readUInt16LE(eocd + 10), centralSize = bytes.readUInt32LE(eocd + 12), central = bytes.readUInt32LE(eocd + 16);
  ensure(bytes.readUInt16LE(eocd + 4) === 0 && bytes.readUInt16LE(eocd + 6) === 0 && bytes.readUInt16LE(eocd + 8) === count &&
    count > 0 && count <= 100 && central !== 0xffffffff && centralSize !== 0xffffffff && central + centralSize === eocd, 'ZIP multidisco/ZIP64 o límite de entradas no permitido');
  const entries: Entry[] = [], names = new Set<string>(); let cursor = central, declared = 0;
  function extra(start: number, length: number) {
    const end = start + length;
    ensure(end <= bytes.length, 'Campo extra ZIP inválido');
    while (start < end) {
      ensure(start + 4 <= end, 'Campo extra ZIP inválido');
      const id = bytes.readUInt16LE(start), size = bytes.readUInt16LE(start + 2); start += 4;
      ensure(start + size <= end && ![0x0001, 0x000d, 0x5855, 0x756e, 0x7075, 0x6375, 0x9901].includes(id), 'ZIP64, enlace, nombre alternativo o cifrado ZIP no permitido');
      start += size;
    }
  }
  for (let i = 0; i < count; i++) {
    ensure(cursor + 46 <= eocd && bytes.readUInt32LE(cursor) === 0x02014b50, 'Entrada central ZIP inválida');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16),
      compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28),
      extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), external = bytes.readUInt32LE(cursor + 38),
      offset = bytes.readUInt32LE(cursor + 42), end = cursor + 46 + nameLength + extraLength + commentLength;
    ensure(end <= eocd && nameLength > 0 && nameLength <= 1024 && bytes.readUInt16LE(cursor + 34) === 0 &&
      [0, 8].includes(method) && (flags & ~0x080e) === 0 && (method === 8 || !(flags & 6)), 'ZIP cifrado o método no soportado');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    ensure(flags & 0x800 || rawName.every(byte => byte < 128), 'Nombre ZIP requiere UTF-8 explícito');
    const name = utf8(rawName); safeName(name);
    const nameKey = name.normalize('NFC').toLowerCase(); ensure(!names.has(nameKey), 'Nombre ZIP duplicado'); names.add(nameKey);
    const mode = external >>> 16, fileType = mode & 0xf000;
    ensure((fileType === 0 || fileType === 0x8000) && !(external & 0x18), 'Enlace/directorio ZIP no permitido');
    ensure(size > 0 && size <= entryLimit(name) && compressed > 0 && compressed !== 0xffffffff &&
      offset !== 0xffffffff && size / compressed <= 200, 'Tamaño o compresión ZIP excede límite');
    declared += size; ensure(declared <= 16 * MiB, 'ZIP expandido excede 16 MiB');
    extra(cursor + 46 + nameLength, extraLength);
    ensure(offset + 30 <= central && bytes.readUInt32LE(offset) === 0x04034b50, 'Cabecera local ZIP inválida');
    const localFlags = bytes.readUInt16LE(offset + 6), localMethod = bytes.readUInt16LE(offset + 8), localCrc = bytes.readUInt32LE(offset + 14),
      localCompressed = bytes.readUInt32LE(offset + 18), localSize = bytes.readUInt32LE(offset + 22),
      localNameLength = bytes.readUInt16LE(offset + 26), localExtraLength = bytes.readUInt16LE(offset + 28), data = offset + 30 + localNameLength + localExtraLength;
    ensure(localFlags === flags && localMethod === method && data + compressed <= central &&
      localNameLength === nameLength && bytes.subarray(offset + 30, offset + 30 + localNameLength).equals(rawName), 'Cabecera local/central ZIP no coincide');
    if (flags & 8) ensure((localCrc === 0 || localCrc === crc) && (localCompressed === 0 || localCompressed === compressed) && (localSize === 0 || localSize === size), 'Tamaños locales ZIP no coinciden');
    else ensure(localCrc === crc && localCompressed === compressed && localSize === size, 'Tamaños/CRC locales ZIP no coinciden');
    extra(offset + 30 + localNameLength, localExtraLength);
    let localEnd = data + compressed;
    if (flags & 8) {
      ensure(localEnd + 12 <= central, 'Descriptor ZIP ausente');
      const signature = bytes.readUInt32LE(localEnd) === 0x08074b50; if (signature) localEnd += 4;
      ensure(localEnd + 12 <= central && bytes.readUInt32LE(localEnd) === crc && bytes.readUInt32LE(localEnd + 4) === compressed && bytes.readUInt32LE(localEnd + 8) === size, 'Descriptor ZIP no coincide');
      localEnd += 12;
    }
    entries.push({ name, flags, method, crc, compressed, size, offset, data, end: localEnd }); cursor = end;
  }
  ensure(cursor === eocd, 'Directorio ZIP con datos adicionales');
  const ordered = [...entries].sort((a, b) => a.offset - b.offset); let localEnd = 0;
  for (const entry of ordered) { ensure(entry.offset === localEnd, 'Entradas ZIP superpuestas o datos ocultos'); localEnd = entry.end; }
  ensure(localEnd === central, 'Datos ocultos antes del directorio ZIP');
  // Cross-check the reviewed dependency's directory view without using its inflater.
  try {
    const library = new AdmZip(bytes).getEntries();
    ensure(library.length === entries.length && library.every((entry, i) => entry.entryName === entries[i].name &&
      entry.header.size === entries[i].size && entry.header.compressedSize === entries[i].compressed && entry.header.crc === entries[i].crc && !entry.isDirectory), 'Directorio ZIP ambiguo');
  } catch (error) { if (error instanceof ReceivedCoreError) throw error; throw new ReceivedCoreError('ZIP mal formado'); }
  return entries;
}

/** Pure in-memory unpacking. No disk extraction, dedupe, persistence or fiscal status.
 * Identical document bytes in differently named uploads are retained for the service
 * to deduplicate transactionally by original SHA-256. Unsafe/ambiguous names reject. */
export function unpackReceivedFiles(files: ReceivedUploadFile[]): ReceivedFile[] {
  ensure(Array.isArray(files) && files.length > 0 && files.length <= 10, 'Se permiten de 1 a 10 archivos');
  let uploaded = 0;
  for (const file of files) {
    ensure(file && file.bytes instanceof Uint8Array, 'Archivo recibido inválido'); safeName(file.fileName);
    ensure(file.bytes.byteLength > 0 && file.bytes.byteLength <= 4 * MiB, 'Archivo excede 4 MiB o está vacío');
    uploaded += file.bytes.byteLength; ensure(uploaded <= 12 * MiB, 'Carga total excede 12 MiB');
  }
  const plans = files.map(file => {
    const bytes = Buffer.from(file.bytes);
    if (/\.zip$/i.test(file.fileName)) return { fileName: file.fileName, bytes, entries: inspectZip(bytes) };
    ensure(/\.xml$/i.test(file.fileName) && !isZip(bytes), 'Carga raíz solo admite XML o ZIP');
    ensure(bytes.length <= 2 * MiB, 'XML excede 2 MiB');
    return { fileName: file.fileName, bytes, entries: null };
  });
  // Validate declarations for the ENTIRE upload before expanding any entry.
  let expanded = 0, count = 0; const names = new Set<string>();
  for (const plan of plans) {
    for (const entry of plan.entries ?? [{ name: plan.fileName, size: plan.bytes.length }]) {
      expanded += entry.size; count++; ensure(expanded <= 16 * MiB && count <= 100, 'Carga expandida excede límite');
      const key = entry.name.normalize('NFC').toLowerCase(); ensure(!names.has(key), 'Nombre de adjunto duplicado'); names.add(key);
    }
  }
  const result: ReceivedFile[] = [];
  for (const plan of plans) {
    if (!plan.entries) { result.push(classify(plan.fileName, plan.bytes, false)); continue; }
    for (const entry of plan.entries) {
      const compressed = plan.bytes.subarray(entry.data, entry.data + entry.compressed); let bytes: Buffer;
      try {
        if (entry.method === 0) bytes = Buffer.from(compressed);
        else {
          const inflated = inflateRawSync(compressed, { maxOutputLength: Math.min(entry.size, entryLimit(entry.name)), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
          ensure(inflated.engine.bytesWritten === compressed.length, 'Datos comprimidos ZIP adicionales'); bytes = inflated.buffer;
        }
      } catch (error) { if (error instanceof ReceivedCoreError) throw error; throw new ReceivedCoreError('Descompresión ZIP inválida o excede límite'); }
      ensure(bytes.length === entry.size && crc32(bytes) === entry.crc, 'Longitud/CRC ZIP no coincide');
      result.push(classify(entry.name, bytes, true));
    }
  }
  return result;
}
