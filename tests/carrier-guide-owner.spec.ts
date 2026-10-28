import { describe, expect, it, vi } from 'vitest';
import { buildPublicGuide09Xml, projectPublicGuide09OwnerSnapshot, validatePublicGuide09OwnerSnapshot,
  type PublicGuide09OwnerSnapshot } from '../packages/sunat-core/src/public-guide-profile';
import { fiscalSnapshotSha256 as hash } from '../packages/sunat-core/src/fiscal-note';
import { carrierCanonicalJson, validateCarrierProof, type CarrierGuideBinding } from '../services/billing-service/src/b2b/carrier-guide-model';
import { createCarrierGuideOwner } from '../services/billing-service/src/b2b/carrier-guide-assembly';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function reference(): PublicGuide09OwnerSnapshot {
  const sender = { ruc: '20000000001', legalName: 'REMITENTE FICTICIO' };
  return { schemaVersion: 'factuez.public-guide09-issued-owner.v1', companyId: 9, branchId: id(1), documentId: id(9), operationId: id(10),
    issuer: sender, series: 'TQ31', number: '9', body: { issueDate: '2026-10-23T12:00:00.000Z', transferDate: '2026-10-24',
      sender, recipient: { ruc: '20000000036', legalName: 'DESTINATARIO FICTICIO' }, carrier: { ruc: '20000000028', legalName: 'TRANSPORTISTA FICTICIO' },
      origin: { ubigeo: '150101', address: 'ORIGEN & <UNO>' }, destination: { ubigeo: '150102', address: 'DESTINO FICTICIO' },
      grossWeight: '1.250', weightUnit: 'KGM', items: [{ code: 'LOCAL-1', description: 'BIEN & <UNO>', quantity: '2.0000000001', unitCode: 'NIU' }],
      reasonCode: '01', mtcRegistration: 'MTC00031', transportMode: '01', regulatedGoods: false } };
}
const binding: CarrierGuideBinding = { draft: { anchor: { issuerId: 1, issuerRuc: '20000000028', environment: 'BETA', branchId: id(1),
  pointId: id(2), seriesId: id(3), documentType: '01' }, guideSeriesId: id(4), guideType: '31' }, fiscalSeriesId: id(5) };
const proof = (action: 'ISSUE' | 'READ', kind: 'SERVICE' | 'USER' = 'SERVICE') => ({ capability: 'BETA_CARRIER_GUIDE_ISSUE_LOCAL', action,
  binding, clientRevision: 3, grantRevision: 4, actor: { userId: kind === 'USER' ? id(7) : null,
    scope: { kind: 'ASSIGNED', branchIds: [id(1)], emissionPointIds: [id(2)], series: [id(3), id(4), id(5)] },
    b2b: { kind, clientId: id(6), revision: 3, subjectId: kind === 'USER' ? id(7) : null, userAuthRevision: kind === 'USER' ? 5 : null } } });

describe('carrier owner contract and separate public09 expected XML', () => {
  it('renders all public09 values and deterministically binds full owner and projection', () => {
    const s = reference(), before = structuredClone(s), r = buildPublicGuide09Xml(s);
    expect(r).toEqual(buildPublicGuide09Xml(s)); expect(s).toEqual(before);
    expect(r.snapshotSha256).toBe(hash(s)); expect(r.projectionSha256).toBe(hash(projectPublicGuide09OwnerSnapshot(s)));
    expect(r.xml).toContain('>01</cbc:TransportModeCode>'); expect(r.xml).toContain('>09</cbc:DespatchAdviceTypeCode>');
    expect(r.xml).toContain('MTC00031'); expect(r.xml).toContain('2.0000000001'); expect(r.xml).toContain('ORIGEN &amp; &lt;UNO&gt;');
    expect(r.xml).not.toContain('DriverPerson'); expect(r.xml).not.toContain('RegistrationNationalityID');
    expect(r).toMatchObject({ transmissionAuthorized: false, authorizedForTransfer: false, officialRulesValidated: false });
    const copy = validatePublicGuide09OwnerSnapshot(s); copy.body.sender.legalName = 'ALTERADO'; expect(s).toEqual(before);
  });
  it.each(['private02', 'wrongSchema', 'unknown', 'issuer', 'reason', 'emptyItems', 'duplicateItems', 'date', 'mtc'])(
    'rejects %s rather than adapting an incomplete reference', kind => {
      const s: any = reference();
      if (kind === 'private02') s.body.transportMode = '02';
      if (kind === 'wrongSchema') s.schemaVersion = 'factuez.guide-issued-local.v1';
      if (kind === 'unknown') s.approved = true;
      if (kind === 'issuer') s.issuer = s.body.carrier;
      if (kind === 'reason') s.body.reasonCode = '04';
      if (kind === 'emptyItems') s.body.items = [];
      if (kind === 'duplicateItems') s.body.items.push({ ...s.body.items[0] });
      if (kind === 'date') s.body.transferDate = '2026-10-22';
      if (kind === 'mtc') s.body.mtcRegistration = '';
      expect(() => buildPublicGuide09Xml(s)).toThrow('INVALID_PUBLIC_GUIDE09_OWNER');
    });
  it('rejects executable reference inputs without running a getter', () => {
    const s = reference(), getter = vi.fn(); Object.defineProperty(s, 'body', { enumerable: true, get: getter });
    expect(() => buildPublicGuide09Xml(s)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('preserves SERVICE/USER provenance and independent actions', () => {
    expect(validateCarrierProof(proof('READ'), 'SERVICE', binding, 'READ').actor.b2b?.revision).toBe(3);
    expect(validateCarrierProof(proof('ISSUE', 'USER'), 'USER', binding, 'ISSUE').actor.b2b?.userAuthRevision).toBe(5);
    expect(() => validateCarrierProof(proof('READ'), 'SERVICE', binding, 'ISSUE')).toThrow();
    const global: any = proof('ISSUE'); global.actor.scope = { kind: 'GLOBAL' };
    expect(() => validateCarrierProof(global, 'SERVICE', binding, 'ISSUE')).toThrow();
    const wrong = proof('ISSUE'); wrong.clientRevision++;
    expect(() => validateCarrierProof(wrong, 'SERVICE', binding, 'ISSUE')).toThrow();
  });
  it('canonicalizes receipt object keys without changing item ordering and bounds actual bytes', () => {
    expect(carrierCanonicalJson({ z: 1, a: { z: 'é', a: [2, 1] } })).toBe('{"a":{"a":[2,1],"z":"é"},"z":1}');
    expect(() => carrierCanonicalJson({ values: Array.from({ length: 30 }, () => 'é'.repeat(8000)) })).toThrow();
  });
  it('requires private authority/crypto capabilities and has inert assembly', () => {
    const database = { $transaction: vi.fn() };
    expect(() => createCarrierGuideOwner({ database, authority: { current: vi.fn() }, referenceValidator: { verify: vi.fn() }, allowedRucs: ['20000000028'] })).not.toThrow();
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(() => createCarrierGuideOwner({ database, authority: { current: vi.fn() }, referenceValidator: null as never, allowedRucs: ['20000000028'] })).toThrow();
  });
});
