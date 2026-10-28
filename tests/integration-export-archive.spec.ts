import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { IntegrationReadError } from '@factuez/service-access/dist/integration';
import { buildExportArchive } from '../services/integration-export-service/src/archive';

// Reuse the existing received-core dependency; the root needs no new dependency.
const require = createRequire(new URL('../packages/received-core/package.json', import.meta.url));
const AdmZip = require('adm-zip');
const MAXIMUM_BYTES = 64 * 1024 * 1024;
const artifactId = '12345678-1234-4123-8123-123456789abc';
type ArchiveFile = { path: string; bytes: Buffer };
const file = (path: string, text = ''): ArchiveFile => ({ path, bytes: Buffer.from(text) });
const archiveSize = (files: ArchiveFile[]) => 22 + files.reduce((size, entry) =>
  size + 30 + 46 + 2 * Buffer.byteLength(entry.path, 'ascii') + entry.bytes.length, 0);

// Independent bit-at-a-time CRC, with a known reference vector below.
function referenceCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function expectFailure(action: () => unknown, status: number, code: 'INVALID_REQUEST' | 'EXPORT_TOO_LARGE') {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(IntegrationReadError);
  expect(failure).toMatchObject({ status, code, message: code });
}

function readStoredArchive(archive: Buffer): ArchiveFile[] {
  const end = archive.length - 22;
  expect(end).toBeGreaterThanOrEqual(0);
  expect(archive.readUInt32LE(end)).toBe(0x06054b50);
  expect(archive.readUInt16LE(end + 4)).toBe(0);
  expect(archive.readUInt16LE(end + 6)).toBe(0);
  const count = archive.readUInt16LE(end + 8);
  expect(archive.readUInt16LE(end + 10)).toBe(count);
  expect(count).toBeLessThan(0xffff);
  const centralSize = archive.readUInt32LE(end + 12);
  const centralStart = archive.readUInt32LE(end + 16);
  expect(centralStart + centralSize).toBe(end);
  expect(archive.readUInt16LE(end + 20)).toBe(0);
  const result: ArchiveFile[] = [];
  let local = 0;
  let central = centralStart;
  for (let index = 0; index < count; index++) {
    expect(archive.readUInt32LE(central)).toBe(0x02014b50);
    expect(archive.readUInt16LE(central + 4)).toBe(20);
    expect(archive.readUInt16LE(central + 6)).toBe(20);
    expect(archive.readUInt16LE(central + 8)).toBe(0);
    expect(archive.readUInt16LE(central + 10)).toBe(0);
    expect(archive.readUInt16LE(central + 12)).toBe(0);
    expect(archive.readUInt16LE(central + 14)).toBe(0x0021);
    const crc = archive.readUInt32LE(central + 16);
    const size = archive.readUInt32LE(central + 20);
    expect(archive.readUInt32LE(central + 24)).toBe(size);
    const nameLength = archive.readUInt16LE(central + 28);
    expect(archive.readUInt16LE(central + 30)).toBe(0);
    expect(archive.readUInt16LE(central + 32)).toBe(0);
    expect(archive.readUInt16LE(central + 34)).toBe(0);
    expect(archive.readUInt16LE(central + 36)).toBe(0);
    expect(archive.readUInt32LE(central + 38)).toBe(0);
    expect(archive.readUInt32LE(central + 42)).toBe(local);
    const name = archive.subarray(central + 46, central + 46 + nameLength);
    expect([...name].every(byte => byte >= 0x20 && byte <= 0x7e)).toBe(true);

    expect(archive.readUInt32LE(local)).toBe(0x04034b50);
    expect(archive.readUInt16LE(local + 4)).toBe(20);
    expect(archive.readUInt16LE(local + 6)).toBe(0);
    expect(archive.readUInt16LE(local + 8)).toBe(0);
    expect(archive.readUInt16LE(local + 10)).toBe(0);
    expect(archive.readUInt16LE(local + 12)).toBe(0x0021);
    expect(archive.readUInt32LE(local + 14)).toBe(crc);
    expect(archive.readUInt32LE(local + 18)).toBe(size);
    expect(archive.readUInt32LE(local + 22)).toBe(size);
    expect(archive.readUInt16LE(local + 26)).toBe(nameLength);
    expect(archive.readUInt16LE(local + 28)).toBe(0);
    expect(archive.subarray(local + 30, local + 30 + nameLength)).toEqual(name);
    const bytes = archive.subarray(local + 30 + nameLength, local + 30 + nameLength + size);
    expect(bytes.length).toBe(size);
    expect(referenceCrc32(bytes)).toBe(crc);
    result.push({ path: name.toString('ascii'), bytes });
    local += 30 + nameLength + size;
    central += 46 + nameLength;
  }
  expect(local).toBe(centralStart);
  expect(central).toBe(end);
  return result;
}

describe('Bounded deterministic integration export archive', () => {
  it('interoperates with the existing adm-zip reader for every permitted name and arbitrary bytes', () => {
    const nested = new AdmZip();
    nested.addFile('synthetic.txt', Buffer.from('synthetic fixture'));
    const files = [file('documents.jsonl', '{"fixture":true}\n'), file('manifest.json', '{"synthetic":true}'),
      file(`artifacts/${artifactId}.xml`, '<fixture>á</fixture>'),
      { path: `artifacts/${artifactId}.zip`, bytes: nested.toBuffer() },
      { path: `artifacts/${artifactId}.pdf`, bytes: Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0xff, 0x0a]) }];
    const archive = buildExportArchive(files);
    expect(archive.length).toBe(archiveSize(files));
    const expected = [...files].sort((left, right) => left.path < right.path ? -1 : 1);
    expect(readStoredArchive(archive)).toEqual(expected);
    const reader = new AdmZip(archive);
    expect(reader.getEntries().map((entry: { entryName: string }) => entry.entryName)).toEqual(expected.map(entry => entry.path));
    for (const entry of expected) expect(reader.readFile(entry.path)).toEqual(entry.bytes);
    expect(new AdmZip(reader.readFile(`artifacts/${artifactId}.zip`)).readAsText('synthetic.txt')).toBe('synthetic fixture');
  });

  it('writes the standard CRC32 vector and zero CRC for empty entries into both directories', () => {
    expect(referenceCrc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const archive = buildExportArchive([file('documents.jsonl', '123456789'), file('manifest.json')]);
    expect(archive.readUInt32LE(14)).toBe(0xcbf43926);
    const central = archive.readUInt32LE(archive.length - 6);
    expect(archive.readUInt32LE(central + 16)).toBe(0xcbf43926);
    expect(archive.readUInt32LE(central + 46 + 'documents.jsonl'.length + 16)).toBe(0);
    expect(readStoredArchive(archive)).toEqual([file('documents.jsonl', '123456789'), file('manifest.json')]);
  });

  it('uses canonical ordering and fixed metadata without mutating the inputs or aliasing bytes', () => {
    const files = [file('manifest.json', '{}'), file(`artifacts/${artifactId}.xml`, 'fixture'), file('documents.jsonl', '[]\n')];
    const original = files.map(entry => ({ path: entry.path, bytes: Buffer.from(entry.bytes) }));
    const archive = buildExportArchive(files);
    expect(buildExportArchive([...files].reverse())).toEqual(archive);
    expect(buildExportArchive(files)).toEqual(archive);
    expect(files).toEqual(original);
    files[0].bytes.fill(0);
    expect(readStoredArchive(archive)).toEqual([...original].sort((left, right) => left.path < right.path ? -1 : 1));
  });

  it('allows an empty classic ZIP and enforces its complete 22-byte minimum', () => {
    const archive = buildExportArchive([], 22);
    expect(archive.toString('hex')).toBe('504b0506000000000000000000000000000000000000');
    expect(readStoredArchive(archive)).toEqual([]);
    expect(new AdmZip(archive).getEntries()).toEqual([]);
    expectFailure(() => buildExportArchive([], 21), 422, 'EXPORT_TOO_LARGE');
  });

  it.each([
    '', 'other.json', 'documents.JSONL', 'manifest.json/', 'manifest.json\n', 'documents.jsonl\r\n',
    '../manifest.json', '/manifest.json', './manifest.json', 'C:/manifest.json', 'documents.jsonl\0',
    `artifacts/../${artifactId}.xml`, `artifacts\\${artifactId}.xml`, `artifacts//${artifactId}.xml`,
    `artifacts/${artifactId.toUpperCase()}.xml`, `artifacts/${artifactId}.XML`, `artifacts/${artifactId}.txt`,
    `artifacts/${artifactId}.xml/extra`, `artifacts/${artifactId}.xml\n`, `artifacts/${artifactId}.xml\u2028`,
    `artifacts/${artifactId}.xml\0`, `artifacts/${artifactId}.xml `, `artifacts/%2e%2e/${artifactId}.xml`,
    `artifacts/${artifactId.replace(/-/g, '')}.xml`, 'artifacts/00000000-0000-0000-0000-000000000000.xml',
    `artífácts/${artifactId}.xml`, `artifacts/${artifactId}.ｐｄｆ`,
  ])('rejects unsafe or unrecognized path %j', path => {
    expectFailure(() => buildExportArchive([file(path)]), 400, 'INVALID_REQUEST');
  });

  it.each(['documents.jsonl', 'manifest.json', `artifacts/${artifactId}.xml`])('rejects duplicate %s even with different bytes', path => {
    expectFailure(() => buildExportArchive([file(path, 'one'), file(path, 'two')]), 400, 'INVALID_REQUEST');
  });

  it.each([null, undefined, {}, 'files', [null], [undefined], [{}], [{ path: 1, bytes: Buffer.alloc(0) }],
    [{ path: 'manifest.json', bytes: 'text' }], [{ path: 'manifest.json', bytes: new Uint8Array(0) }],
    new Array(1), [Object.assign([], file('manifest.json'))],
  ])('rejects malformed runtime input %#', value => {
    expectFailure(() => buildExportArchive(value as ArchiveFile[]), 400, 'INVALID_REQUEST');
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, MAXIMUM_BYTES + 1, 0xffffffff, Number.MAX_SAFE_INTEGER,
    null, '1024', {},
  ])('rejects invalid or ZIP64-sized maximum %j', maximum => {
    expectFailure(() => buildExportArchive([], maximum as number), 400, 'INVALID_REQUEST');
  });

  it('counts payloads, both path copies, all local headers, central headers and the end record', () => {
    const files = [file('documents.jsonl', 'fixture\n'), file('manifest.json', '{}'), file(`artifacts/${artifactId}.pdf`, 'bytes')];
    const exact = archiveSize(files);
    expect(buildExportArchive(files, exact).length).toBe(exact);
    expectFailure(() => buildExportArchive(files, exact - 1), 422, 'EXPORT_TOO_LARGE');
    expectFailure(() => buildExportArchive(files, files.reduce((size, entry) => size + entry.bytes.length, 0)), 422, 'EXPORT_TOO_LARGE');
    const emptyFile = [file('manifest.json')];
    expect(buildExportArchive(emptyFile, archiveSize(emptyFile)).length).toBe(archiveSize(emptyFile));
    expectFailure(() => buildExportArchive(emptyFile, archiveSize(emptyFile) - 1), 422, 'EXPORT_TOO_LARGE');
  });

  it('enforces the default 64 MiB boundary including ZIP overhead, with no ZIP64 escape', () => {
    const overhead = archiveSize([file('manifest.json')]);
    const bytes = Buffer.alloc(MAXIMUM_BYTES);
    const exact = buildExportArchive([{ path: 'manifest.json', bytes: bytes.subarray(0, MAXIMUM_BYTES - overhead) }]);
    expect(exact.length).toBe(MAXIMUM_BYTES);
    expect(exact.readUInt32LE(exact.length - 22)).toBe(0x06054b50);
    expect(exact.readUInt16LE(exact.length - 14)).toBe(1);
    expectFailure(() => buildExportArchive([{ path: 'manifest.json', bytes: bytes.subarray(0, MAXIMUM_BYTES - overhead + 1) }]),
      422, 'EXPORT_TOO_LARGE');
    expectFailure(() => buildExportArchive([{ path: 'manifest.json', bytes }]), 422, 'EXPORT_TOO_LARGE');
  });

  it('accepts exactly 10001 unique entries and rejects 10002 before processing entry bytes', () => {
    const empty = Buffer.alloc(0);
    const files = Array.from({ length: 10002 }, (_, index) => ({
      path: `artifacts/00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}.xml`, bytes: empty,
    }));
    const archive = buildExportArchive(files.slice(0, 10001));
    expect(archive.length).toBe(archiveSize(files.slice(0, 10001)));
    expect(archive.readUInt16LE(archive.length - 14)).toBe(10001);
    expect(archive.readUInt16LE(archive.length - 12)).toBe(10001);
    expect(new AdmZip(archive).getEntries()).toHaveLength(10001);
    expectFailure(() => buildExportArchive(files), 422, 'EXPORT_TOO_LARGE');
  });
});
