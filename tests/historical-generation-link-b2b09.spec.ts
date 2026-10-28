import { describe, it, expect, vi } from 'vitest';
import { linkGeneratedHistoricalOriginal } from '../services/sunat-service/src/application/historical-generation-link-b2b09';
import type { HistoricalOriginal } from '../services/sunat-service/src/application/historical-original-contract';
import { batchMemberEvidenceFixture, batchMemberTestPki, id } from './helpers/batch-member-evidence.fixture';

async function setup(type: '01'|'03') {
  const f = await batchMemberEvidenceFixture(batchMemberTestPki(), type, {unreported:true});
  const r = f.record;
  const {id: xmlId, ...documentXml} = r.signedXml;
  const {id: zipId, ...individual} = r.requestZip;
  // For 03 this stands in for the distinct RC ZIP, not the individual ZIP.
  const rc = {storageKey:'rc.zip',sha256:'0'.repeat(64),sizeBytes:12};
  const input = {handle:'generated-v1', version:1, snapshot:r.snapshot as any,
    binding:structuredClone(r.binding) as any, snapshotSha256:r.member.snapshotSha256, signedXmlId:xmlId, documentZipId:zipId,
    asOf:f.asOf, manifest:{fileName:'test.zip',reference:'test',revision:1,
      fingerprint:r.signerFingerprint,digest:r.digestValue,documentXml,
      zip:type === '03' ? rc : individual, xml:documentXml,
      ...(type === '03' ? {individualXmlZip:individual} : {}),xsdEvidence:{}}};
  let value: HistoricalOriginal | null = null;
  const store = {insert:vi.fn(async (next:HistoricalOriginal) => {
    if (value && value.recordSha256 !== next.recordSha256) throw Error('HISTORICAL_ORIGINAL_CONFLICT');
    value = structuredClone(next);
  }),loadExact:vi.fn(async (handle:string) => value?.handle === handle ? structuredClone(value) : null)};
  const ports = {store, artifacts:f.artifacts, signatures:f.signatures};
  return {f,input,ports,store,read:()=>value,run:()=>linkGeneratedHistoricalOriginal(input,ports)};
}

describe('isolated generation to historical original candidate',()=>{
  it.each(['01','03'] as const)('verifies and records the individual %s package, and allows an identical retry',async type=>{
    const t=await setup(type), proof=await t.run();
    expect(proof.acceptance).toBe('NOT_VERIFIED');
    expect(t.read()?.documentZip.sha256).toBe(t.f.record.requestZip.sha256);
    expect((await t.run()).recordSha256).toBe(proof.recordSha256);
  });
  it('rejects missing individual 03 ZIP and altered artifacts before insertion',async()=>{
    const t=await setup('03'); delete (t.input.manifest as any).individualXmlZip;
    await expect(t.run()).rejects.toThrow('HISTORICAL_GENERATION_INVALID');
    expect(t.store.insert).not.toHaveBeenCalled();
    const u=await setup('01'); u.f.blobs.set(u.f.record.signedXml.id,Buffer.from('tampered'));
    await expect(u.run()).rejects.toThrow('HISTORICAL_ORIGINAL_VERIFICATION_FAILED');
    expect(u.store.insert).not.toHaveBeenCalled();
  });
  it('rejects changed signer, binding and conflicting version without replacing the first record',async()=>{
    const t=await setup('01'); await t.run(); const before=t.read()?.recordSha256;
    t.input.manifest.fingerprint='0'.repeat(64);
    await expect(t.run()).rejects.toThrow(); expect(t.read()?.recordSha256).toBe(before);
    const u=await setup('01'); u.input.snapshot.branchId=id(55);
    await expect(u.run()).rejects.toThrow(); expect(u.store.insert).not.toHaveBeenCalled();
    const v=await setup('01'); await v.run(); v.input.binding.pointId=id(99);
    await expect(v.run()).rejects.toThrow('HISTORICAL_ORIGINAL_CONFLICT');
  });
  it('reports ambiguous readback failure after insert and allows a retry',async()=>{
    const t=await setup('01'); t.store.loadExact.mockResolvedValueOnce(null);
    await expect(t.run()).rejects.toThrow('HISTORICAL_GENERATION_READBACK_FAILED');
    expect(t.read()).not.toBeNull();
    await expect(t.run()).resolves.toMatchObject({acceptance:'NOT_VERIFIED'});
  });
});

