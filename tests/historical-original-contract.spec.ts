import { describe, expect, it } from 'vitest';
import { fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';
import { supplementCommandFixture, supplementUuid as id } from './helpers/fiscal-supplement.fixture';
import { makeHistoricalOriginal, checkHistoricalOriginal, type HistoricalOriginalInput } from '../services/sunat-service/src/application/historical-original-contract';

function fixture(type: '01' | '03' = '01'): HistoricalOriginalInput {
  const s = supplementCommandFixture(type === '01' ? 'NOTE' : 'RC').doc;
  return { handle:'synthetic-v1', member:{ documentId:s.documentId, version:1, snapshotSha256:fiscalSnapshotSha256(s) },
    binding:{ environment:'BETA', issuerRuc:s.issuer.identityNumber, companyId:s.companyId, branchId:s.branchId,
      pointId:id(90), seriesId:id(91), series:s.series, documentType:type }, snapshot:s,
    signerFingerprint:'a'.repeat(64), digestValue:'A'.repeat(43)+'=',
    signedXml:{ id:id(10),storageKey:'synthetic.xml',sha256:'b'.repeat(64),sizeBytes:100 },
    documentZip:{ id:id(11),storageKey:'synthetic.zip',sha256:'c'.repeat(64),sizeBytes:200 } };
}
describe('historical original candidate, synthetic data only', () => {
  it.each(['01','03'] as const)('freezes a detached %s version and validates its exact handle', type => {
    const input = fixture(type), r = makeHistoricalOriginal(input);
    input.snapshot.issuer.legalName = 'changed'; input.signedXml.sha256 = '0'.repeat(64);
    expect(r.snapshot.issuer.legalName).not.toBe('changed');
    expect(Object.isFrozen(r.snapshot.issuer)).toBe(true);
    expect(Object.isFrozen(r.signedXml)).toBe(true);
    expect(checkHistoricalOriginal(structuredClone(r), r.handle)).toEqual(r);
    expect(() => checkHistoricalOriginal(r, 'other')).toThrow('HISTORICAL_ORIGINAL_INVALID');
  });
  it('rejects identity, binding, snapshot, descriptor, type and format conflicts', () => {
    const cases: ((r: HistoricalOriginalInput) => void)[] = [
      r => { r.member.version = 0; }, r => { r.member.snapshotSha256 = '0'.repeat(64); },
      r => { r.binding.issuerRuc = '0'.repeat(11); }, r => { r.binding.companyId++; },
      r => { r.binding.branchId = id(92); }, r => { r.binding.pointId = 'bad'; },
      r => { r.binding.seriesId = 'bad'; }, r => { r.binding.series = 'B001'; },
      r => { (r.binding as any).documentType = '07'; }, r => { (r.binding as any).environment = 'PROD'; },
      r => { r.signedXml.sizeBytes = 0; }, r => { r.documentZip.id = r.signedXml.id; },
      r => { r.documentZip.storageKey = r.signedXml.storageKey; }, r => { r.signerFingerprint = 'bad'; },
      r => { r.digestValue = 'bad'; }, r => { r.handle = '../latest'; },
      r => { (r as any).creditCatalogue = { complete:true, entries:[] }; },
    ];
    for (const change of cases) { const r=fixture(); change(r); expect(() => makeHistoricalOriginal(r)).toThrow('HISTORICAL_ORIGINAL_INVALID'); }
  });
  it('detects changed record bytes and keeps exact versions distinct', () => {
    const a=makeHistoricalOriginal(fixture());
    const next=fixture(); next.handle='synthetic-v2'; next.member.version=2;
    const b=makeHistoricalOriginal(next);
    expect(a.recordSha256).not.toBe(b.recordSha256);
    const changed=structuredClone(a); changed.binding.pointId=id(93);
    expect(() => checkHistoricalOriginal(changed, a.handle)).toThrow('HISTORICAL_ORIGINAL_INVALID');
    expect(() => checkHistoricalOriginal({...a, recordSha256:b.recordSha256}, a.handle)).toThrow('HISTORICAL_ORIGINAL_INVALID');
  });
  it('rejects executable input and oversized JSON', () => {
    const r=fixture(); Object.defineProperty(r.snapshot.issuer,'legalName',{get(){throw new Error('executed');}, enumerable:true});
    expect(() => makeHistoricalOriginal(r)).toThrow('HISTORICAL_ORIGINAL_INVALID');
    const large=fixture(); large.snapshot.issuer.legalName='x'.repeat(20000);
    expect(() => makeHistoricalOriginal(large)).toThrow('HISTORICAL_ORIGINAL_INVALID');
  });
});
