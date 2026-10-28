import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createCarrierGuide31Profile, validateCarrierGuideInput, CARRIER_GUIDE_INPUT_SCHEMA_VERSION, CARRIER_GUIDE31_PROFILE,
  type CarrierGuideInput, type CarrierReference09Snapshot, type CarrierReference09Evidence } from '../packages/sunat-core/src/carrier-guide-profile';
import { buildNumberedGuideXml } from '../packages/sunat-core/src/numbered-guide-profile';
import { fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';
import { guidePreparationBody } from './helpers/guide-preparation.fixture';
import { signLocalGuideXml } from '../services/sunat-service/src/infrastructure/crypto/guide-artifact-crypto';
import { parseSafeInvoice, verifyLocalSignedInvoice } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import { createGuideSidecarPki } from './helpers/guide-sidecar-ephemeral-pki.fixture';

function fixture() {
  const sender = { ruc: '20000000001', legalName: 'REMITENTE FICTICIO & <ENSAYO>' };
  const carrier = { ruc: '20000000028', legalName: 'TRANSPORTISTA FICTICIO' };
  const snapshot: CarrierReference09Snapshot = {
    schemaVersion: 'factuez.carrier-reference09-owner.v1', documentId: '00000000-0000-4000-8000-000000000009', documentType: '09',
    issuer: { ...sender }, series: 'TQ31', number: '19', issueDate: '2026-10-21T14:00:00.000Z', transferDate: '2026-10-22',
    sender, recipient: { ruc: '20000000036', legalName: 'DESTINATARIO FICTICIO' },
    origin: { ubigeo: '150101', address: 'ORIGEN FICTICIO & <PUERTA>' }, destination: { ubigeo: '150102', address: 'DESTINO FICTICIO' },
    carrier, grossWeight: '1.250', weightUnit: 'KGM', transportMode: '01', regulatedGoods: false,
    items: [{ code: 'FICTICIO-1', description: 'BIEN FICTICIO & <ENSAYO>', quantity: '2.0000000001', unitCode: 'NIU' }],
  };
  const reference09 = { documentId: snapshot.documentId, issuerRuc: sender.ruc, series: snapshot.series, number: snapshot.number, snapshotSha256: fiscalSnapshotSha256(snapshot) };
  const input: CarrierGuideInput = {
    schemaVersion: CARRIER_GUIDE_INPUT_SCHEMA_VERSION, companyId: 31, branchId: '00000000-0000-4000-8000-000000000001',
    documentId: '00000000-0000-4000-8000-000000000031', operationId: '00000000-0000-4000-8000-000000000032',
    issuer: { ...carrier }, documentType: '31', series: 'VQ31', number: '7', snapshotSha256: 'b'.repeat(64),
    body: { issueDate: '2026-10-22T02:30:00.000Z', transferDate: snapshot.transferDate, sender: { ...sender }, recipient: { ...snapshot.recipient },
      origin: { ...snapshot.origin }, destination: { ...snapshot.destination }, grossWeight: snapshot.grossWeight, weightUnit: 'KGM',
      transport: { mode: '01', carrier: { ...carrier, mtcRegistration: 'MTC00031' }, vehicle: { plate: 'ABC931', tuc: 'TUC00031' },
        driver: { identityType: '1', identityNumber: '00000001', firstName: 'CONDUCTOR & <UNO>', lastName: 'FICTICIO', license: 'A000000031' } },
      reference09, items: structuredClone(snapshot.items), totalTransfer: true, freightPayer: 'SENDER', subcontracted: false, regulatedGoods: false },
  };
  const evidence: CarrierReference09Evidence = { snapshot, acceptance: {
    environment: 'BETA', documentId: snapshot.documentId, issuerRuc: sender.ruc, fullNumber: 'TQ31-19', snapshotSha256: reference09.snapshotSha256,
    cdrSha256: 'c'.repeat(64), responseCode: '0', status: 'ACCEPTED', acceptedAt: '2026-10-21T15:00:00.000Z',
  } };
  const loadAcceptedReference09 = vi.fn(async () => evidence as unknown);
  return { input, evidence, loadAcceptedReference09, profile: createCarrierGuide31Profile({ loadAcceptedReference09 }) };
}
function node(xml: string, path: string) {
  let current = parseSafeInvoice(xml, 'DespatchAdvice').root;
  for (const part of path.split('/')) {
    const [prefix, name] = part.split(':'), ns = prefix === 'cac' ? 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2' : 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
    const found = Array.from(current.childNodes).filter(n => n.nodeType === 1 && n.namespaceURI === ns && n.localName === name);
    expect(found).toHaveLength(1); current = found[0] as typeof current;
  }
  return current.textContent;
}

describe('separately versioned carrier 31 owner profile', () => {
  it('renders annex paths and binds the scoped private owner query and acceptance', async () => {
    const f = fixture(), before = structuredClone(f.input), result = await f.profile.buildXml(f.input);
    expect(f.input).toEqual(before); expect(await f.profile.buildXml(f.input)).toEqual(result);
    expect(f.loadAcceptedReference09).toHaveBeenCalledWith({ companyId: 31, branchId: f.input.branchId, issuerRuc: f.input.issuer.ruc,
      documentId: f.input.documentId, operationId: f.input.operationId, snapshotSha256: f.input.snapshotSha256,
      asOf: f.input.body.issueDate, reference09: f.input.body.reference09 });
    expect(result).toMatchObject({ profile: CARRIER_GUIDE31_PROFILE, fullNumber: 'VQ31-7', referenceVerification: 'PRIVATE_OWNER_PORT',
      referenceCdrSha256: 'c'.repeat(64), environment: 'BETA', candidateOnly: true, fiscalExecutionEnabled: false,
      transmissionAuthorized: false, authorizedForTransfer: false, officialRulesValidated: false });
    expect(result.xmlSha256).toBe(createHash('sha256').update(result.xml, 'utf8').digest('hex'));
    const xml = result.xml;
    expect(node(xml, 'cbc:DespatchAdviceTypeCode')).toBe('31'); expect(node(xml, 'cbc:IssueDate')).toBe('2026-10-21'); expect(node(xml, 'cbc:IssueTime')).toBe('21:30:00');
    expect(node(xml, 'cac:DespatchSupplierParty/cac:Party/cac:PartyIdentification/cbc:ID')).toBe(f.input.issuer.ruc);
    expect(node(xml, 'cac:DeliveryCustomerParty/cac:Party/cac:PartyIdentification/cbc:ID')).toBe(f.input.body.recipient.ruc);
    expect(node(xml, 'cac:Shipment/cac:Delivery/cac:Despatch/cac:DespatchParty/cac:PartyIdentification/cbc:ID')).toBe(f.input.body.sender.ruc);
    expect(node(xml, 'cac:AdditionalDocumentReference/cbc:ID')).toBe('TQ31-19');
    expect(node(xml, 'cac:AdditionalDocumentReference/cbc:DocumentTypeCode')).toBe('09');
    expect(node(xml, 'cac:AdditionalDocumentReference/cac:IssuerParty/cac:PartyIdentification/cbc:ID')).toBe(f.input.body.sender.ruc);
    expect(node(xml, 'cac:Shipment/cac:ShipmentStage/cac:CarrierParty/cac:PartyLegalEntity/cbc:CompanyID')).toBe('MTC00031');
    expect(node(xml, 'cac:Shipment/cac:TransportHandlingUnit/cac:TransportEquipment/cbc:ID')).toBe('ABC931');
    expect(node(xml, 'cac:Shipment/cac:TransportHandlingUnit/cac:TransportEquipment/cac:ShipmentDocumentReference/cbc:ID')).toBe('TUC00031');
    expect(node(xml, 'cac:Shipment/cac:ShipmentStage/cac:DriverPerson/cbc:FirstName')).toBe('CONDUCTOR & <UNO>');
    expect(node(xml, 'cac:Shipment/cac:ShipmentStage/cac:DriverPerson/cac:IdentityDocumentReference/cbc:ID')).toBe('A000000031');
    expect(node(xml, 'cac:Shipment/cac:Delivery/cac:Despatch/cac:DespatchAddress/cac:AddressLine/cbc:Line')).toBe(f.input.body.origin.address);
    expect(node(xml, 'cac:Shipment/cac:Delivery/cac:DeliveryAddress/cac:AddressLine/cbc:Line')).toBe(f.input.body.destination.address);
    expect(node(xml, 'cac:DespatchLine/cbc:DeliveredQuantity')).toBe('2.0000000001');
    expect(xml).toContain('SUNAT_Envio_IndicadorTrasladoTotal'); expect(xml).toContain('SUNAT_Envio_IndicadorPagadorFlete_Remitente');
    expect(xml).not.toContain('HandlingCode'); expect(xml).not.toContain('RegistrationNationalityID');
    expect(xml).toContain('<ext:ExtensionContent/>'); expect(xml).not.toContain('<ds:Signature');
  });
  it('makes a separate strict copy and accepts supported CE driver identity', async () => {
    const f = fixture(); f.input.body.transport.driver.identityType = '4'; f.input.body.transport.driver.identityNumber = 'CE000031';
    const checked = validateCarrierGuideInput(f.input); checked.body.sender.legalName = 'MUTATED';
    expect(f.input.body.sender.legalName).not.toBe('MUTATED');
    expect((await f.profile.buildXml(f.input)).xml).toContain('>CE000031</cbc:ID>');
  });
  it.each(['schema', 'oldPublic', 'vehicle', 'tuc', 'driver', 'mtc', 'number', 'company', 'issuer', 'unknown', 'boolean', 'mode', 'subcontract', 'payer', 'partial', 'regulated', 'invalidRuc', 'zeroWeight', 'quantity', 'duplicate', 'date', 'unicode'] as const)(
    'rejects missing, unsupported or fabricated %s before loading references', async kind => {
      const f = fixture(), v: any = f.input;
      if (kind === 'schema') v.schemaVersion = 'factuez.numbered-guide-input.v1';
      if (kind === 'oldPublic') v.body.transport = { mode: '01', carrier: v.body.transport.carrier };
      if (kind === 'vehicle') delete v.body.transport.vehicle;
      if (kind === 'tuc') v.body.transport.vehicle.tuc = '';
      if (kind === 'driver') delete v.body.transport.driver.license;
      if (kind === 'mtc') delete v.body.transport.carrier.mtcRegistration;
      if (kind === 'number') v.number = '01';
      if (kind === 'company') v.companyId = 0;
      if (kind === 'issuer') v.issuer.legalName = 'OTHER';
      if (kind === 'unknown') v.body.reasonCode = '04';
      if (kind === 'boolean') v.referenceVerified = true;
      if (kind === 'mode') v.body.transport.mode = '02';
      if (kind === 'subcontract') v.body.subcontracted = true;
      if (kind === 'payer') v.body.freightPayer = 'THIRD_PARTY';
      if (kind === 'partial') v.body.totalTransfer = false;
      if (kind === 'regulated') v.body.regulatedGoods = true;
      if (kind === 'invalidRuc') v.issuer.ruc = '20000000000';
      if (kind === 'zeroWeight') v.body.grossWeight = '0';
      if (kind === 'quantity') v.body.items[0].quantity = '1.00000000001';
      if (kind === 'duplicate') v.body.items.push({ ...v.body.items[0] });
      if (kind === 'date') v.body.transferDate = '2026-10-20';
      if (kind === 'unicode') v.body.transport.driver.firstName = 'x\ud800';
      await expect(f.profile.buildXml(v)).rejects.toThrow(); expect(f.loadAcceptedReference09).not.toHaveBeenCalled();
    });
  it('rejects executable values without invoking getters or proxies', async () => {
    const f = fixture(), getter = vi.fn(); Object.defineProperty(f.input.body, 'sender', { enumerable: true, get: getter });
    await expect(f.profile.buildXml(f.input)).rejects.toThrow('INVALID_CARRIER_GUIDE_INPUT'); expect(getter).not.toHaveBeenCalled();
    await expect(f.profile.buildXml(new Proxy(fixture().input, { get: getter }))).rejects.toThrow('INVALID_CARRIER_GUIDE_INPUT');
    expect(getter).not.toHaveBeenCalled(); expect(f.loadAcceptedReference09).not.toHaveBeenCalled();
  });
  it.each([null, false, true, {}, { verified: true }])('requires actual private owner evidence, received %j', async proof => {
    const f = fixture(); f.loadAcceptedReference09.mockResolvedValue(proof);
    await expect(f.profile.buildXml(f.input)).rejects.toThrow('CARRIER_GUIDE_REFERENCE_UNVERIFIED');
  });
  it('fails closed when owner authorization/resolution fails without exposing its message', async () => {
    const f = fixture(); f.loadAcceptedReference09.mockRejectedValue(new Error('PRIVATE_OWNER_DETAIL'));
    await expect(f.profile.buildXml(f.input)).rejects.toThrow('CARRIER_GUIDE_REFERENCE_UNVERIFIED');
    expect(() => createCarrierGuide31Profile(null as never)).toThrow('CARRIER_GUIDE_REFERENCE_UNVERIFIED');
  });
  it.each(['hash', 'issuer', 'document', 'number', 'state', 'code', 'cdr', 'environment', 'future', 'beforeIssue', 'acceptanceHash'] as const)(
    'rejects mismatched reference acceptance %s', async kind => {
      const f = fixture(), a: any = f.evidence.acceptance;
      if (kind === 'hash') f.evidence.snapshot.items[0].description = 'TAMPERED';
      if (kind === 'issuer') a.issuerRuc = f.input.issuer.ruc;
      if (kind === 'document') a.documentId = f.input.documentId;
      if (kind === 'number') a.fullNumber = 'TQ31-20';
      if (kind === 'state') a.status = 'REJECTED';
      if (kind === 'code') a.responseCode = '99';
      if (kind === 'cdr') a.cdrSha256 = '';
      if (kind === 'environment') a.environment = 'PROD';
      if (kind === 'future') a.acceptedAt = '2026-10-23T12:00:00.000Z';
      if (kind === 'beforeIssue') a.acceptedAt = '2026-10-21T13:00:00.000Z';
      if (kind === 'acceptanceHash') a.snapshotSha256 = 'f'.repeat(64);
      await expect(f.profile.buildXml(f.input)).rejects.toThrow();
    });
  it.each(['sender', 'recipient', 'origin', 'destination', 'carrier', 'items', 'transferDate', 'grossWeight', 'weightUnit', 'transportMode', 'regulatedGoods'] as const)(
    'rejects semantically different owner 09 %s even with a consistent hash', async key => {
      const f = fixture(), s: any = f.evidence.snapshot;
      if (key === 'sender' || key === 'recipient' || key === 'carrier') s[key].legalName = 'DIFFERENT';
      if (key === 'origin' || key === 'destination') s[key].address = 'DIFFERENT';
      if (key === 'items') s.items[0].quantity = '1';
      if (key === 'transferDate') s.transferDate = '2026-10-23';
      if (key === 'grossWeight') s.grossWeight = '3';
      if (key === 'weightUnit') s.weightUnit = 'TNE';
      if (key === 'transportMode') s.transportMode = '02';
      if (key === 'regulatedGoods') s.regulatedGoods = true;
      const hash = fiscalSnapshotSha256(s); f.input.body.reference09.snapshotSha256 = hash; f.evidence.acceptance.snapshotSha256 = hash;
      await expect(f.profile.buildXml(f.input)).rejects.toThrow('CARRIER_GUIDE_REFERENCE_MISMATCH');
    });
  it('allows locally accepted observations but does not grant official acceptance', async () => {
    const f = fixture(); f.evidence.acceptance.status = 'ACCEPTED_WITH_OBSERVATIONS';
    expect((await f.profile.buildXml(f.input)).authorizedForTransfer).toBe(false);
  });
  it('detects mutations during private owner awaits and freezes the query', async () => {
    const f = fixture(); f.loadAcceptedReference09.mockImplementation(async () => { f.input.body.transport.vehicle.plate = 'XYZ931'; return f.evidence; });
    await expect(f.profile.buildXml(f.input)).rejects.toThrow('CARRIER_GUIDE_INPUT_CHANGED');
    const g = fixture(); await g.profile.buildXml(g.input); const query = g.loadAcceptedReference09.mock.calls[0][0] as any;
    expect(Object.isFrozen(query)).toBe(true); expect(Object.isFrozen(query.reference09)).toBe(true);
    const h = fixture(); h.loadAcceptedReference09.mockImplementation(async () => { Object.defineProperty(h.input, 'issuer', { enumerable: true, get() { throw new Error('DO NOT RUN'); } }); return h.evidence; });
    await expect(h.profile.buildXml(h.input)).rejects.toThrow('CARRIER_GUIDE_INPUT_CHANGED');
  });
});

describe('real ephemeral signatures and offline XSD for numbered profiles', () => {
  let pki09: ReturnType<typeof createGuideSidecarPki>, pki31: ReturnType<typeof createGuideSidecarPki>;
  beforeAll(() => { pki09 = createGuideSidecarPki('20000000001'); pki31 = createGuideSidecarPki('20000000028'); }, 60000);
  it('validates signed 09/31 with the pinned SUNAT XSD and rejects unsigned/structurally damaged controls', async () => {
    const f = fixture(), carrier = await f.profile.buildXml(f.input), body = guidePreparationBody();
    const numbered = buildNumberedGuideXml({ schemaVersion: 'factuez.numbered-guide-input.v1',
      documentId: '00000000-0000-4000-8000-000000000091', operationId: '00000000-0000-4000-8000-000000000092',
      issuer: { ...body.sender }, documentType: '09', series: 'TQ91', number: '17', body, snapshotSha256: 'a'.repeat(64) });
    const cases = [numbered, carrier].map((candidate, index) => {
      const pki = index === 0 ? pki09 : pki31;
      const signed = signLocalGuideXml({ unsignedXml: candidate.xml, issuerRuc: candidate.issuerRuc, documentType: candidate.documentType, fullNumber: candidate.fullNumber }, pki.issuer.pkcs12, pki.password);
      expect(verifyLocalSignedInvoice(signed.xml, pki.issuer.certificatePem, candidate.xml, 'DespatchAdvice')).toBe(signed.digestValue);
      expect(() => verifyLocalSignedInvoice(signed.xml.replace(candidate.fullNumber, `${candidate.fullNumber}0`), pki.issuer.certificatePem, candidate.xml, 'DespatchAdvice')).toThrow();
      return { documentType: candidate.documentType, fullNumber: candidate.fullNumber, unsignedXml: candidate.xml, xml: signed.xml };
    });
    const runner = createRequire(import.meta.url)('./numbered-carrier-profiles-signed-xsd.e2e.cjs');
    const report = runner.validateSignedProfiles(cases);
    expect(report.result).toBe('PASS'); expect(report.results).toHaveLength(10);
    expect(report.cleanup).toBe('OWN_TEMP_REMOVED');
    expect(report.results.every((entry: { passed: boolean }) => entry.passed)).toBe(true);
  }, 60000);
});
