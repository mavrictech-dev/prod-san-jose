import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../services/sunat-service/src/infrastructure/artifact-store';
import { createHistoricalSignedArtifactReader } from '../services/sunat-service/src/application/historical-signed-artifact-reader';

const doc = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'factuez-historical-synthetic-')); roots.push(root);
  const store = new ArtifactStore(root), bytes = Buffer.from('synthetic historic bytes');
  const artifact = { id, ...await store.put(doc, 'historical.xml', bytes) };
  return { root, store, bytes, artifact, reader: createHistoricalSignedArtifactReader(root) };
}
const unavailable = 'HISTORICAL_ARTIFACT_UNAVAILABLE';

describe('independent historical artifact reader, synthetic files only', () => {
  it('reads exact content-addressed historical XML and ZIP and keeps versions distinct', async () => {
    const f = await fixture();
    const zip = { id, ...await f.store.put(doc, 'historical.zip', Buffer.from('synthetic zip')) };
    const version2 = { id, ...await f.store.put(doc, 'historical.xml', Buffer.from('version two')) };
    expect(await f.reader.read(doc, f.artifact)).toEqual(f.bytes);
    expect(await f.reader.read(doc, zip)).toEqual(Buffer.from('synthetic zip'));
    expect(await f.reader.read(doc, version2)).toEqual(Buffer.from('version two'));
    expect(await f.reader.read(doc, f.artifact)).toEqual(f.bytes);
  });
  it('rejects cross-document, traversal, absolute, URL and alternate names', async () => {
    const f = await fixture();
    for (const key of [join(other, f.artifact.storageKey.split(/[\\/]/).pop()!), '../outside.xml', join(f.root, 'outside.xml'),
      'https://example.invalid/a.xml', join(doc, '..', 'outside.xml'), join(doc, 'nested', 'file.xml'), join(doc, `${'a'.repeat(64)}-historical.xml`)]) {
      await expect(f.reader.read(doc, { ...f.artifact, storageKey: key })).rejects.toThrow(unavailable);
    }
    await expect(f.reader.read(other, f.artifact)).rejects.toThrow(unavailable);
  });
  it('rejects corruption, missing files, forged size or digest and invalid metadata', async () => {
    const f = await fixture();
    for (const patch of [{ sizeBytes: 0 }, { sizeBytes: f.bytes.length + 1 }, { sha256: '0'.repeat(64) }, { id: 'bad' }])
      await expect(f.reader.read(doc, { ...f.artifact, ...patch })).rejects.toThrow(unavailable);
    await writeFile(join(f.root, f.artifact.storageKey), Buffer.alloc(f.bytes.length, 1));
    await expect(f.reader.read(doc, f.artifact)).rejects.toThrow(unavailable);
    await rm(join(f.root, f.artifact.storageKey));
    await expect(f.reader.read(doc, f.artifact)).rejects.toThrow(unavailable);
  });
  it('rejects a document directory link to another location', async () => {
    const f = await fixture();
    const target = join(f.root, 'other-dir'); await mkdir(target);
    await rm(join(f.root, doc), { recursive: true });
    await symlink(target, join(f.root, doc), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.reader.read(doc, f.artifact)).rejects.toThrow(unavailable);
  });
  it('requires an explicit absolute non-filesystem-root', () => {
    expect(() => createHistoricalSignedArtifactReader('relative')).toThrow('HISTORICAL_ARTIFACT_ROOT_INVALID');
  });
});
