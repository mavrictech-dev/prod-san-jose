import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectOfflineCdr, inspectOfflineGuide, reviewOfflineGuideInventory, reviewOfflineGuidePair, validateOfflineReviewScope } from '../packages/evidence-core/src/offline-review';
import { createEvidenceCryptoFixture, unsignedSyntheticCdr, unsignedSyntheticXml, editSyntheticXml, DS, CBC, CAC } from './helpers/evidence-crypto.fixture';

const scope = { schemaVersion: 'factuez.offline-review-scope.v1', environment: 'BETA', purpose: 'DIAGNOSTIC_ONLY',
  issuerRucs: ['00000000101'], fromDate: '2026-10-01', toDate: '2026-10-31' };
let fixture: ReturnType<typeof createEvidenceCryptoFixture>, guide: string, cdr: string;
function unsignedGuide(type = '31') {
  const number = `${type === '31' ? 'V' : 'T'}Q01-00000001`;
  return unsignedSyntheticXml('Invoice', `<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID>
    <cbc:ID>${number}</cbc:ID><cbc:IssueDate>2026-10-02</cbc:IssueDate><cbc:IssueTime>03:40:49</cbc:IssueTime><cbc:DespatchAdviceTypeCode>${type}</cbc:DespatchAdviceTypeCode>
    <cac:DespatchSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="6">00000000101</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>EMISOR FICTICIO</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:DespatchSupplierParty>
    <cac:Shipment><cbc:ID>SYNTHETIC_ENVIO</cbc:ID><cbc:GrossWeightMeasure unitCode="KGM">108.000</cbc:GrossWeightMeasure><cbc:SpecialInstructions>SYNTHETIC_INDICATOR</cbc:SpecialInstructions>
      <cac:ShipmentStage><cac:TransitPeriod><cbc:StartDate>2026-10-02</cbc:StartDate></cac:TransitPeriod>
        <cac:CarrierParty><cac:PartyLegalEntity><cbc:CompanyID>QA_MTC</cbc:CompanyID></cac:PartyLegalEntity></cac:CarrierParty>
        <cac:DriverPerson><cbc:ID>00000001</cbc:ID><cbc:FirstName>CONDUCTOR FICTICIO</cbc:FirstName><cbc:FamilyName>QA</cbc:FamilyName><cbc:JobTitle>Principal</cbc:JobTitle><cac:IdentityDocumentReference><cbc:ID>QA000001</cbc:ID></cac:IdentityDocumentReference></cac:DriverPerson>
      </cac:ShipmentStage><cac:Delivery><cac:DeliveryAddress><cbc:ID>150101</cbc:ID><cac:AddressLine><cbc:Line>DESTINO FICTICIO</cbc:Line></cac:AddressLine></cac:DeliveryAddress>
        <cac:Despatch><cac:DespatchAddress><cbc:ID>150102</cbc:ID><cac:AddressLine><cbc:Line>ORIGEN FICTICIO</cbc:Line></cac:AddressLine></cac:DespatchAddress></cac:Despatch></cac:Delivery>
      <cac:TransportHandlingUnit><cac:TransportEquipment><cbc:ID>QA0001</cbc:ID></cac:TransportEquipment></cac:TransportHandlingUnit>
    </cac:Shipment><cac:DespatchLine><cbc:ID>1</cbc:ID><cbc:DeliveredQuantity unitCode="GLL">30.0000</cbc:DeliveredQuantity><cac:Item><cbc:Description>PRODUCTO FICTICIO</cbc:Description><cac:SellersItemIdentification><cbc:ID>QA01</cbc:ID></cac:SellersItemIdentification></cac:Item></cac:DespatchLine>`).replaceAll('Invoice', 'DespatchAdvice');
}
function unsignedCdr(options: Parameters<typeof unsignedSyntheticCdr>[0] = {}) {
  return unsignedSyntheticCdr({ issuerRuc: '00000000101', reference: 'VQ01-00000001', responseReference: 'VQ01-00000001', documentTypeCode: '31', ...options })
    .replace('<cbc:ID>SYNTHETIC-CDR-QA', '<cbc:UBLVersionID>2.0</cbc:UBLVersionID><cbc:CustomizationID>1.0</cbc:CustomizationID><cbc:IssueDate>2026-10-02</cbc:IssueDate><cbc:ID>SYNTHETIC-CDR-QA');
}
const pair = (g = guide, c = cdr) => reviewOfflineGuidePair({ scope, documentXml: g, cdrXml: c });
beforeAll(() => { fixture = createEvidenceCryptoFixture(); guide = fixture.sign(unsignedGuide()); cdr = fixture.sign(unsignedCdr()); }, 30000);

describe('explicit offline scope, not authorization or production activation', () => {
  it('copies bounded scope without granting authority', () => {
    const s = validateOfflineReviewScope(scope); expect(s.issuerRucs).not.toBe(scope.issuerRucs);
    expect(pair()).toMatchObject({ canEmit: false, canImportHistory: false, canChangeCounters: false, officialTrust: false, officialAcceptance: false, phase2Closed: false, phase3Closed: false });
  });
  it.each([{ environment: 'PRODUCTION' }, { purpose: 'IMPORT' }, { schemaVersion: 'other' }, { extra: true }, { issuerRucs: [] },
    { issuerRucs: ['bad'] }, { issuerRucs: ['00000000101', '00000000101'] }, { fromDate: '2026-02-30' }, { toDate: '2025-01-01' }])('rejects scope %j', patch => expect(() => validateOfflineReviewScope({ ...scope, ...patch })).toThrow());
  it('rejects objects, proxies and accessors without invoking callbacks', () => {
    let called = 0; const fail = () => { called++; throw new Error('CALLBACK'); };
    const getter = { ...scope }; Object.defineProperty(getter, 'environment', { get: fail });
    expect(() => validateOfflineReviewScope(getter)).toThrow();
    expect(() => validateOfflineReviewScope(new Proxy(scope, { get: fail, ownKeys: fail, getPrototypeOf: fail }))).toThrow();
    expect(called).toBe(0);
  });
  it('rejects an array index getter without executing it', () => {
    let called = 0; const a = ['00000000101']; Object.defineProperty(a, '0', { get() { called++; return '00000000101'; } });
    expect(() => validateOfflineReviewScope({ ...scope, issuerRucs: a })).toThrow(); expect(called).toBe(0);
  });
  it('requires issuer and dates within the explicit scope', () => {
    expect(() => inspectOfflineGuide(guide, { ...scope, issuerRucs: ['00000000102'] })).toThrow('ISSUER_OUT_OF_SCOPE');
    expect(() => inspectOfflineCdr(cdr, { ...scope, fromDate: '2026-10-03' })).toThrow('DATE_OUT_OF_SCOPE');
  });
});
describe('guide-specific versioned diagnostic projection', () => {
  it.each(['09', '31'])('reads type %s without silently inserting an invoice snapshot', type => {
    const r = inspectOfflineGuide(fixture.sign(unsignedGuide(type)), scope);
    expect(r.projection.documentTypeCode).toBe(type); expect(r.signature.wholeDocumentIntegrity).toBe(true);
    expect(r.projection.items[0]).toMatchObject({ quantity: '30.0000', unitCode: 'GLL' });
    expect(r.projection.shipment).toMatchObject({ origin: { ubigeo: '150102', address: 'ORIGEN FICTICIO' }, destination: { ubigeo: '150101' } });
    expect(r.projection.shipment.stages[0].drivers[0].licenseNumber).toBe('QA000001');
    expect(r.mappingCompleteness).toBe('PARTIAL_DIAGNOSTIC'); expect(r.notMapped).toContain('ownership.station');
    expect(r.xsdVerified).toBe(false); expect(r.businessRulesVerified).toBe(false);
  });
  it.each([['>31<', '>01<'], ['VQ01-00000001', 'VQ01-00000000'], ['unitCode="GLL"', 'unitCode="BAD!"'],
    ['>30.0000<', '>-1<'], ['>30.0000<', '>0.0000<'], ['>03:40:49<', '>99:40:49<'], ['>150101<', '>BAD<']])('rejects unsupported business field %s', (from, to) => {
    expect(() => inspectOfflineGuide(guide.replace(from, to), scope)).toThrow();
  });
});
describe('cryptographic integrity remains separate from trust and reported response', () => {
  it('verifies SHA256 fixture integrity but never trusts its embedded certificate', () => {
    const r = pair(); expect(r.cryptographicPairBound).toBe(true); expect(r.typeBindingVerified).toBe(true);
    expect(r.guide.signature.status).toBe('INTEGRITY_VERIFIED_UNTRUSTED'); expect(r.cdr.signature.revocationChecked).toBe(false);
    expect(r.cdr.senderClaimsSunat).toBe(false); expect(r.officialAcceptance).toBe(false);
  });
  it('supports isolated read-only legacy SHA1 diagnostics', () => {
    const legacy = fixture.sign(unsignedGuide(), { signatureAlgorithm: DS + 'rsa-sha1', digestAlgorithm: DS + 'sha1', transforms: [DS + 'enveloped-signature'] });
    const r = pair(legacy); expect(r.cryptographicPairBound).toBe(true); expect(r.issues).toContain('LEGACY_SHA1_OBSERVED');
  });
  it('supports CDR RSA-SHA512 and exclusive-with-comments canonicalization with no XML comments', () => {
    const c = fixture.sign(unsignedCdr(), { signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512', digestAlgorithm: DS + 'sha1',
      transforms: [DS + 'enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#WithComments'] });
    expect(pair(guide, c).cdr.signature.wholeDocumentIntegrity).toBe(true);
  });
  it('rejects a changed CDR body even when SignatureValue is still mathematically correct', () => {
    const changed = cdr.replace('Resultado FICTICIO SYNTHETIC QA', 'Resultado FICTICIO MODIFICADO');
    const r = pair(guide, changed); expect(r.cdr.signature.signatureValueVerified).toBe(true);
    expect(r.cdr.signature.referenceDigestVerified).toBe(false); expect(r.cdr.signature.status).toBe('DIGEST_MISMATCH');
    expect(r.cdr.projection.reportedResult).toBe('REPORTED_ACCEPTED'); expect(r.cdr.contentAuthenticated).toBe(false);
    expect(r.cryptographicPairBound).toBe(false); expect(r.officialAcceptance).toBe(false);
  });
  it('distinguishes a changed signature from changed content', () => {
    const changed = editSyntheticXml(cdr, doc => {
      const n = doc.getElementsByTagNameNS(DS, 'SignatureValue')[0]; const b = Buffer.from(n.textContent!, 'base64'); b[0] ^= 1; n.textContent = b.toString('base64');
    });
    const r = pair(guide, changed).cdr.signature; expect(r.status).toBe('SIGNATURE_MISMATCH'); expect(r.referenceDigestVerified).toBe(true);
  });
  it('handles missing and unsupported signatures without declaring acceptance', () => {
    expect(inspectOfflineGuide(unsignedGuide(), scope).signature.status).toBe('MISSING');
    const changed = guide.replace('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', 'http://unsupported');
    expect(pair(changed).guide.signature.status).toBe('PROFILE_UNSUPPORTED');
  });
  it('reports warning codes and does not infer transport authorization', () => {
    const r = pair(guide, fixture.sign(unsignedCdr({ notes: ['4186 - FICTICIO', '4399 - FICTICIO', '4412 - FICTICIO'] })));
    expect(r.cdr.warningCodes).toEqual(['4186', '4399', '4412']); expect(r.cdr.projection.reportedResult).toBe('REPORTED_ACCEPTED_WITH_OBSERVATIONS');
    expect(r.canEmit).toBe(false);
  });
  it('treats missing type as unknown, not a verified type match', () => {
    const r = pair(guide, fixture.sign(unsignedCdr({ documentTypeCode: undefined })));
    expect(r.bindings.documentTypeMatches).toBe(null); expect(r.typeBindingVerified).toBe(false); expect(r.issues).toContain('CDR_TYPE_NOT_DECLARED');
  });
  it.each([{ reference: 'VQ01-00000002' }, { responseReference: 'VQ01-00000002' }, { documentTypeCode: '09' }])('detects mismatched CDR binding %j', options => {
    expect(pair(guide, fixture.sign(unsignedCdr(options))).cryptographicPairBound).toBe(false);
  });
});
describe('XML security and bounded parsing', () => {
  it.each(['<!DOCTYPE x [<!ENTITY e SYSTEM "file:///secret">]>', '<?network x?>', '<!--COMMENT-->'])('refuses active/non-profile XML %s', prefix => {
    expect(() => inspectOfflineGuide(prefix + guide, scope)).toThrow('XML_UNSAFE');
  });
  it('rejects complexity, duplicate IDs, malformed and oversized XML', () => {
    expect(() => inspectOfflineGuide('x'.repeat(2 * 1024 * 1024 + 1), scope)).toThrow('XML_UNSAFE');
    expect(() => inspectOfflineGuide('<broken>', scope)).toThrow();
    expect(() => inspectOfflineGuide(guide.replace('<cbc:ID>VQ', '<cbc:ID Id="dup">VQ').replace('<cbc:IssueDate>', '<cbc:IssueDate Id="dup">'), scope)).toThrow('XML_DUPLICATE_ID');
    expect(() => inspectOfflineGuide(guide.replace('<cac:Shipment>', '<cac:Shipment>' + '<a>'.repeat(40) + '</a>'.repeat(40)), scope)).toThrow('XML_COMPLEXITY');
  });
  it('rejects external, nested and ambiguous signature references', () => {
    expect(() => inspectOfflineGuide(guide.replace('URI=""', 'URI="https://example.invalid/a"'), scope)).toThrow('SIGNATURE_REFERENCE');
    expect(() => inspectOfflineGuide(guide.replace('<cbc:IssueDate>', '<cbc:IssueDate Id="sub">').replace('URI=""', 'URI="#sub"'), scope)).toThrow('SIGNATURE_REFERENCE');
    const doubled = editSyntheticXml(guide, d => { const sig = d.getElementsByTagNameNS(DS, 'Signature')[0]; const clone = sig.cloneNode(true) as typeof sig; clone.removeAttribute('Id'); sig.parentNode!.appendChild(clone); });
    expect(() => inspectOfflineGuide(doubled, scope)).toThrow('SIGNATURE_AMBIGUOUS');
  });
  it('rejects duplicated responses rather than selecting the first', () => {
    const doubled = editSyntheticXml(cdr, d => { const n = d.getElementsByTagNameNS(CAC, 'DocumentResponse')[0]; n.parentNode!.appendChild(n.cloneNode(true)); });
    expect(() => inspectOfflineCdr(doubled, scope)).toThrow('CDR_RESPONSE_COUNT');
  });
  it('does not invoke fields on a proxy pair input', () => {
    let called = 0; const p = new Proxy({}, { get() { called++; throw Error(); } });
    expect(() => reviewOfflineGuidePair(p)).toThrow(); expect(called).toBe(0);
  });
});
describe('standalone offline CLI: explicit inventory, bounded reads and redacted output', () => {
  let dir: string, manifestPath: string;
  beforeAll(() => {
    expect(existsSync(resolve('packages/evidence-core/dist/offline-review.js'))).toBe(true);
    dir = mkdtempSync(resolve('tmp/offline-guide-cli-synthetic-'));
    manifestPath = join(dir, 'scope.json');
    writeFileSync(join(dir, 'guide.xml'), guide); writeFileSync(join(dir, 'cdr.xml'), cdr);
  });
  beforeEach(() => { writeFileSync(join(dir, 'guide.xml'), guide); writeFileSync(join(dir, 'cdr.xml'), cdr); });
  function manifest(changes: Record<string, unknown> = {}) {
    const m = { schemaVersion: 'factuez.offline-guide-files.v1', scope,
      documentFiles: [{ role: 'GUIDE_XML', path: join(dir, 'guide.xml'), sha256: createHash('sha256').update(guide).digest('hex') },
        { role: 'CDR_XML', path: join(dir, 'cdr.xml'), sha256: createHash('sha256').update(cdr).digest('hex') }], ...changes };
    writeFileSync(manifestPath, JSON.stringify(m)); return m;
  }
  function run(args = ['--authorized-offline-review', '--manifest', manifestPath]) {
    return spawnSync(process.execPath, [resolve('migration/offline-guide-review-cli.cjs'), ...args], { encoding: 'utf8', timeout: 15000 });
  }
  it('produces redacted metadata and no writes even for an integrity-correct pair', () => {
    manifest(); const before = readFileSync(join(dir, 'guide.xml')); const r = run(); expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ networkRequests: 0, fiscalWrites: 0, outboxWrites: 0, canImportHistory: false, officialAcceptance: false });
    for (const value of ['CONDUCTOR FICTICIO', 'ORIGEN FICTICIO', 'QA000001', 'QA0001', 'X509Certificate', 'SignatureValue']) expect(r.stdout).not.toContain(value);
    expect(readFileSync(join(dir, 'guide.xml')).equals(before)).toBe(true);
  });
  it.each([[], ['--manifest', 'anywhere'], ['--authorized-offline-review', '--manifest', 'relative.json']].map(args => ({ args })))('refuses absent/relative scope $args', ({ args }) => {
    expect(run(args).status).toBe(1);
  });
  it('blocks wrong hashes before outputting content', () => {
    const m = manifest(); m.documentFiles[0].sha256 = '0'.repeat(64); writeFileSync(manifestPath, JSON.stringify(m));
    const r = run(); expect(r.status).toBe(1); expect(r.stdout).toBe(''); expect(r.stderr).toContain('FILE_SHA256_MISMATCH');
  });
  it('preserves the original UTF8 byte hash when the XML has a BOM', () => {
    const bomGuide = '\uFEFF' + guide; writeFileSync(join(dir, 'guide.xml'), bomGuide);
    const m = manifest(); m.documentFiles[0].sha256 = createHash('sha256').update(bomGuide).digest('hex'); writeFileSync(manifestPath, JSON.stringify(m));
    const r = run(); expect(r.status).toBe(0); expect(JSON.parse(r.stdout).guide.rawSha256).toBe(m.documentFiles[0].sha256);
    writeFileSync(join(dir, 'guide.xml'), guide);
  });
  it('rejects production and extra inventory fields', () => {
    manifest({ scope: { ...scope, environment: 'PRODUCTION' } }); expect(run().status).toBe(1);
    manifest({ permitEmission: true }); expect(run().status).toBe(1);
  });
  it('exits 2 for a changed CDR whose inventory hash is explicitly updated', () => {
    const altered = cdr.replace('Resultado FICTICIO SYNTHETIC QA', 'OTRO RESULTADO FICTICIO'); writeFileSync(join(dir, 'cdr.xml'), altered);
    const m = manifest(); m.documentFiles[1].sha256 = createHash('sha256').update(altered).digest('hex'); writeFileSync(manifestPath, JSON.stringify(m));
    const r = run(); expect(r.status).toBe(2); const body = JSON.parse(r.stdout);
    expect(body.cdr.signature.status).toBe('DIGEST_MISMATCH'); expect(body.officialAcceptance).toBe(false);
    writeFileSync(join(dir, 'cdr.xml'), cdr);
  });
  it('does not load emission, database, network or credential code', () => {
    const source = readFileSync(resolve('packages/evidence-core/src/offline-review.ts'), 'utf8');
    const cli = readFileSync(resolve('migration/offline-guide-review-cli.cjs'), 'utf8');
    for (const forbidden of ['@prisma', 'bullmq', 'nodemailer', "require('node:http')", "require('node:https')", 'process.env.', 'createPrivateKey']) {
      expect(source).not.toContain(forbidden); expect(cli).not.toContain(forbidden);
    }
  });
});
describe('phase-3 read-only preflight never deduplicates or authorizes import', () => {
  const entry = (id = 'source-1', documentXml = guide, cdrXml = cdr) => ({ originSystem: 'FICTICIO_QA', originRecordId: id, documentXml, cdrXml });
  const inventory = (entries: unknown[]) => reviewOfflineGuideInventory({ schemaVersion: 'factuez.offline-guide-inventory.v1', scope, entries });
  it('provides stable fiscal keys and required approvals without checkpoints or counters', () => {
    const r = inventory([entry()]); expect(r.metadataChecksPassed).toBe(true); expect(r.summaries[0].fiscalKey).toBe('00000000101:31:VQ01:1');
    expect(r).toMatchObject({ canImportHistory: false, canChangeCounters: false, accountingApproved: false, cutoverAuthorized: false, notAnImportManifest: true });
    expect(r.missingApprovals).toContain('CONFIRMED_OWNERSHIP_MAP');
  });
  it('detects duplicate source and fiscal records without deleting either row', () => {
    const r = inventory([entry(), entry()]); expect(r.rowCount).toBe(2); expect(r.uniqueOriginCount).toBe(1);
    expect(r.findings.map(x => x.code)).toEqual(['DUPLICATE_ORIGIN', 'DUPLICATE_FISCAL']); expect(r.canImportHistory).toBe(false);
  });
  it('detects a conflicting signed version of the same fiscal key', () => {
    const changed = fixture.sign(unsignedGuide().replace('PRODUCTO FICTICIO', 'OTRO PRODUCTO FICTICIO'));
    const r = inventory([entry(), entry('source-2', changed)]); expect(r.findings.map(x => x.code)).toContain('CONFLICTING_FISCAL_XML');
  });
  it('normalizes leading zeros in fiscal numbering, not in signed XML', () => {
    const g = fixture.sign(unsignedGuide().replace('VQ01-00000001', 'VQ01-1'));
    const c = fixture.sign(unsignedCdr({ reference: 'VQ01-1', responseReference: 'VQ01-1' }));
    expect(inventory([entry(), entry('source-2', g, c)]).findings.map(x => x.code)).toContain('CONFLICTING_FISCAL_XML');
  });
  it('detects corrupt evidence and rejects fabricated scope/source/extra fields', () => {
    expect(inventory([entry('s1', guide, cdr.replace('Resultado FICTICIO', 'CDR ALTERADO'))]).metadataChecksPassed).toBe(false);
    expect(() => inventory([{ ...entry(), originRecordId: '' }])).toThrow('ORIGIN_ID');
    expect(() => inventory([{ ...entry(), counterStart: 2 }])).toThrow('INVENTORY_ENTRY');
    expect(() => inventory([])).toThrow('INVENTORY_LIMIT');
    expect(() => inventory(Array.from({ length: 21 }, () => entry()))).toThrow('INVENTORY_LIMIT');
  });
});
