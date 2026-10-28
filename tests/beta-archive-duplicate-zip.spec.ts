import 'reflect-metadata';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { BetaIssuanceService } from '../services/sunat-service/src/application/beta-issuance.service';

const { zipSync } = createRequire(new URL('../services/sunat-service/package.json', import.meta.url))('fflate') as typeof import('fflate');
const xml = Buffer.from('synthetic xml');
const fileName = '00000000001-RC-20261003-1.zip';
const xmlName = fileName.replace(/\.zip$/, '.xml');

function fixture(zip: Buffer) {
  const manifest = { fileName, revision: 1, reference: 'RC-20261003-1', zip: { sha256: 'zip-hash' }, xml: { sha256: 'xml-hash' } };
  const repository = { manifest: vi.fn(async () => manifest) };
  const store = { read: vi.fn(async (_id: string, artifact: unknown) => artifact === manifest.xml ? xml : zip) };
  const xsd = { validate: vi.fn(async () => ({ xmlSha256: 'xml-hash' })) };
  const service = new BetaIssuanceService({} as never, repository as never, store as never, {} as never, {} as never, {} as never, {} as never, xsd as never, {} as never);
  const internals = service as unknown as { context: (...args: unknown[]) => Promise<void>; archived: (row: unknown) => Promise<unknown> };
  internals.context = vi.fn(async () => {});
  return () => internals.archived({ documentId: 'synthetic', snapshot: { documentTypeCode: '03' } });
}

describe('archivo RC Beta: ZIP sintético sin red ni DB', () => {
  it('acepta una entrada XML coincidente', async () => {
    const zip = Buffer.from(zipSync({ [xmlName]: xml }));
    await expect(fixture(zip)()).resolves.toMatchObject({ fileName });
  });
  it('rechaza entradas duplicadas aunque la última coincida con el XML', async () => {
    const other = 'x' + xmlName.slice(1);
    const zip = Buffer.from(zipSync({ [other]: Buffer.from('other content'), [xmlName]: xml }));
    for (let i = 0; i <= zip.length - other.length; i++) {
      if (zip.subarray(i, i + other.length).toString() === other) zip.write(xmlName, i);
    }
    await expect(fixture(zip)()).rejects.toThrow('ZIP inconsistente');
  });
});