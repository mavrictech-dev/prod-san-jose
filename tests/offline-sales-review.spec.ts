import { beforeAll, describe, expect, it } from 'vitest';
import { inspectOfflineSales, reviewOfflineSalesPair, reviewOfflineSalesInventory } from '../packages/evidence-core/src/offline-sales-review';
import { readSyntheticBusinessXml, EVIDENCE_POLICY } from '../packages/evidence-core/src/xml';
import { buildBusinessEvidenceXml, createBusinessEvidenceSnapshot } from '../packages/evidence-core/src/fixtures';
import { createEvidenceCryptoFixture, editSyntheticXml, unsignedSyntheticCdr, CBC, CAC, DS } from './helpers/evidence-crypto.fixture';

const scope = { schemaVersion: 'factuez.offline-review-scope.v1', environment: 'BETA', purpose: 'DIAGNOSTIC_ONLY',
  issuerRucs: ['00000000001'], fromDate: '2026-10-01', toDate: '2026-10-31' };
let fixture: ReturnType<typeof createEvidenceCryptoFixture>;
beforeAll(() => { fixture = createEvidenceCryptoFixture(); }, 30000);
const xml = (type: '01' | '03' | '07' | '08' = '01') => buildBusinessEvidenceXml(createBusinessEvidenceSnapshot(type));
const signed = (type: '01' | '03' | '07' | '08' = '01') => fixture.sign(xml(type));
const inspect = (value = signed()) => inspectOfflineSales(value, scope);
function cdr(type = '01', options: Parameters<typeof unsignedSyntheticCdr>[0] = {}) {
  return fixture.sign(unsignedSyntheticCdr({ issuerRuc: '00000000001', reference: type === '03' ? 'BQ01-1' : 'FQ01-1',
    responseReference: type === '03' ? 'BQ01-1' : 'FQ01-1', documentTypeCode: type, ...options })
    .replace('<cbc:ID>SYNTHETIC-CDR-QA', '<cbc:UBLVersionID>2.0</cbc:UBLVersionID><cbc:CustomizationID>1.0</cbc:CustomizationID><cbc:IssueDate>2026-10-04</cbc:IssueDate><cbc:ID>SYNTHETIC-CDR-QA'));
}
const pair = (documentXml = signed(), cdrXml: string | null = cdr()) => reviewOfflineSalesPair({ scope, documentXml, cdrXml });

describe('scoped offline sales 01/03/07/08, without importing or relaxing SYNTHETIC', () => {
  it.each(['01', '03', '07', '08'] as const)('projects and verifies type %s', type => {
    const r = inspect(signed(type));
    expect(r.projection.documentTypeCode).toBe(type);
    expect(r.projection.items[0]).toMatchObject({ quantity: '2.000000', unitCode: 'GLL', lineExtensionAmount: '100.00', unitValue: '50.000000' });
    expect(r.projection.issuer.registeredAddress).toMatchObject({ line: 'AVENIDA FICTICIA 123', establishmentCode: '0000' });
    expect(r.projection.customer.registeredAddress?.line).toBe('DIRECCION FICTICIA 456');
    expect(r.reconciliation).toMatchObject({ lineSum: '100.00', headerTaxSum: '18.00', lineTaxSum: '18.00', checksPassed: true, fiscalRulesVerified: false });
    expect(r.signature).toMatchObject({ wholeDocumentIntegrity: true, officialTrust: false });
    expect(r.coverage.unmappedElementCount).toBe(0);
    expect(r).toMatchObject({ canEmit: false, canImportHistory: false, canChangeCounters: false, phase2Closed: false, phase3Closed: false });
  });
  it.each(['01', '03', '07', '08'] as const)('binds individual CDR %s without official acceptance', type => {
    const r = pair(signed(type), cdr(type)); expect(r.cryptographicPairBound).toBe(true);
    expect(r.typeBindingVerified).toBe(true); expect(r.officialAcceptance).toBe(false);
  });
  it('retains padded historical numbers without rewriting the signature', () => {
    const doc = fixture.sign(xml().replaceAll('FQ01-1', 'FQ01-00000001'));
    const r = inspect(doc); expect(r.projection.fullNumber).toBe('FQ01-00000001'); expect(r.signature.wholeDocumentIntegrity).toBe(true);
  });
  it('keeps a missing CDR pending instead of blocking document inspection', () => {
    const r = pair(signed(), null); expect(r.cdr).toBe(null); expect(r.bindings).toBe(null);
    expect(r.issues).toContain('CDR_NOT_PROVIDED'); expect(r.cryptographicPairBound).toBe(false);
  });
  it('never treats a summary CDR as the individual acceptance of a boleta', () => {
    const r = pair(signed('03'), cdr('03', { reference: 'RC-20261004-1', responseReference: 'RC-20261004-1' }));
    expect(r.issues).toContain('CDR_SUMMARY_REQUIRES_BATCH_BINDING'); expect(r.cryptographicPairBound).toBe(false);
  });
  it('does not assume missing CDR type', () => {
    const r = pair(signed(), cdr('01', { documentTypeCode: undefined }));
    expect(r.bindings?.documentTypeMatches).toBe(null); expect(r.typeBindingVerified).toBe(false);
  });
  it.each([{ reference: 'FQ01-2' }, { responseReference: 'FQ01-2' }, { documentTypeCode: '08' }])('detects binding mismatch %j', options => {
    expect(pair(signed(), cdr('01', options)).cryptographicPairBound).toBe(false);
  });
  it('does not call the synthetic parser with a real-data override', () => {
    const fictitiousNonSyntheticNamespace = xml().replaceAll('00000000001', '11111111111');
    expect(inspectOfflineSales(fictitiousNonSyntheticNamespace, { ...scope, issuerRucs: ['11111111111'] }).projection.issuer.identityNumber).toBe('11111111111');
    expect(() => readSyntheticBusinessXml(fictitiousNonSyntheticNamespace, EVIDENCE_POLICY)).toThrow('REAL_ISSUER_BLOCKED');
  });
});

describe('phase-3 sales inventory and exact reconciliation without persistence', () => {
  const entry = (documentXml = signed(), cdrXml: string | null = cdr(), originRecordId = 'row-1') =>
    ({ documentXml, cdrXml, originSystem: 'OFFLINE_EXPORT_QA', originRecordId });
  const inventory = (entries: unknown[]) => reviewOfflineSalesInventory({ schemaVersion: 'factuez.offline-sales-inventory.v1', scope, entries });
  it('groups declared amounts by RUC/currency/type/series without assuming cutover authority', () => {
    const r = inventory([entry()]); expect(r.metadataChecksPassed).toBe(true);
    expect(r.groups[0]).toMatchObject({ currencyCode: 'PEN', documentTypeCode: '01', series: 'FQ01', declaredPayableTotal: '118.00', declaredTaxTotal: '18.00' });
    expect(r.canImportHistory).toBe(false); expect(r.notAnImportManifest).toBe(true);
    expect(r.missingApprovals).toContain('ACCOUNTING_RECONCILIATION');
  });
  it('does not subtract notes from invoices or mix currencies', () => {
    const usd = fixture.sign(xml().replaceAll('PEN', 'USD'));
    const r = inventory([entry(), entry(signed('07'), cdr('07'), 'row-2'), entry(usd, cdr(), 'row-3')]);
    expect(r.groups).toHaveLength(3); expect(r.groups.every(g => g.declaredPayableTotal === '118.00')).toBe(true);
  });
  it('detects duplicate fiscal and origin keys, retains both rows in declared totals', () => {
    const one = entry(); const r = inventory([one, one]);
    expect(r.findings).toContainEqual({ row: 2, code: 'DUPLICATE_ORIGIN' });
    expect(r.findings).toContainEqual({ row: 2, code: 'DUPLICATE_FISCAL' });
    expect(r.rowCount).toBe(2); expect(r.groups[0].declaredPayableTotal).toBe('236.00');
    expect(r.metadataChecksPassed).toBe(false);
  });
  it('normalizes fiscal key padding only for conflict detection, never rewriting signed files', () => {
    const padded = fixture.sign(xml().replaceAll('FQ01-1', 'FQ01-00000001'));
    const r = inventory([entry(), entry(padded, null, 'row-2')]);
    expect(r.uniqueFiscalCount).toBe(1); expect(r.findings).toContainEqual({ row: 2, code: 'CONFLICTING_FISCAL_XML' });
    expect(r.summaries[1].documentSha256).toBe(inspect(padded).rawSha256);
  });
  it('flags missing CDR and accounting inconsistencies separately', () => {
    const doc = fixture.sign(xml().replace('>118.00</cbc:PayableAmount>', '>118.01</cbc:PayableAmount>'));
    const r = inventory([entry(doc, null)]);
    expect(r.groups[0]).toMatchObject({ pairIntegrityFailures: 1, reconciliationFailures: 1 });
    expect(r.findings).toContainEqual({ row: 1, code: 'PAYABLE_TOTAL_MISMATCH' });
  });
  it('uses integer cents for repeated fractional totals', () => {
    const small = fixture.sign(xml().replaceAll('100.00', '0.10').replaceAll('118.00', '0.12').replaceAll('18.00</cbc:TaxAmount>', '0.02</cbc:TaxAmount>'));
    const r = inventory([entry(small, null), entry(small, null, 'row-2'), entry(small, null, 'row-3')]);
    expect(r.groups[0].declaredPayableTotal).toBe('0.36'); expect(r.groups[0].declaredTaxTotal).toBe('0.06');
  });
  it('rejects an empty, oversized, sparse or accessor inventory', () => {
    expect(() => inventory([])).toThrow('INVENTORY_LIMIT'); expect(() => inventory(Array.from({ length: 21 }, () => entry()))).toThrow('INVENTORY_LIMIT');
    expect(() => inventory(new Array(2))).toThrow('INVENTORY_SHAPE');
    let calls = 0; const entries = [entry()]; Object.defineProperty(entries, '0', { get() { calls++; return entry(); } });
    expect(() => inventory(entries)).toThrow('INVENTORY_SHAPE'); expect(calls).toBe(0);
  });
  it('rejects proxy array without running getPrototypeOf traps', () => {
    let calls = 0; const proxy = new Proxy([entry()], { getPrototypeOf() { calls++; return Array.prototype; } });
    expect(() => inventory(proxy)).toThrow('INVENTORY_SHAPE'); expect(calls).toBe(0);
  });
  it('requires explicit source identifiers and does not invent them from filenames', () => {
    expect(() => inventory([{ ...entry(), originRecordId: '' }])).toThrow('ORIGIN_ID');
    expect(() => inventory([{ ...entry(), fileName: 'FQ01-1.xml' }])).toThrow('INVENTORY_ENTRY');
  });
});
describe('diagnostic coverage, references and exact arithmetic', () => {
  it.each(['07', '08'] as const)('retains reference and reason of %s', type => {
    const r = inspect(signed(type)); expect(r.projection.references[0]).toMatchObject({ fullNumber: 'FQ01-1', type: '01' });
    expect(r.projection.discrepancies[0].reasonCode).toBe('01');
  });
  it('reads a credit note for a boleta', () => {
    const changed = editSyntheticXml(xml('07'), doc => {
      doc.documentElement!.getElementsByTagNameNS(CBC, 'ID')[0].textContent = 'BQ01-00000002';
      doc.getElementsByTagNameNS(CAC, 'InvoiceDocumentReference')[0].getElementsByTagNameNS(CBC, 'ID')[0].textContent = 'BQ01-00000001';
      doc.getElementsByTagNameNS(CBC, 'ReferenceID')[0].textContent = 'BQ01-00000001';
      doc.getElementsByTagNameNS(CBC, 'DocumentTypeCode')[0].textContent = '03';
    });
    const r = inspect(fixture.sign(changed)); expect(r.projection.references[0].type).toBe('03'); expect(r.reconciliation.checksPassed).toBe(true);
  });
  it('returns note reference disagreement as an explicit finding', () => {
    const r = inspect(fixture.sign(xml('07').replace('<cbc:ReferenceID>FQ01-1', '<cbc:ReferenceID>FQ01-2')));
    expect(r.findings).toContainEqual({ code: 'NOTE_REFERENCE_MISMATCH', path: 'references' });
  });
  it('lists unknown business fields rather than silently certifying complete mapping', () => {
    const r = inspect(fixture.sign(xml().replace('</Invoice>', '<cac:PrepaidPayment><cbc:ID>QA-PREPAYMENT</cbc:ID></cac:PrepaidPayment></Invoice>')));
    expect(r.coverage.unmappedElementCount).toBe(2); expect(r.coverage.unmappedPaths.some(p => p.includes('PrepaidPayment'))).toBe(true);
    expect(r.reconciliation.checksPassed).toBe(false); expect(r.canImportHistory).toBe(false);
  });
  it('separates signature integrity from accounting totals', () => {
    const r = inspect(fixture.sign(xml().replace('>118.00</cbc:PayableAmount>', '>118.01</cbc:PayableAmount>')));
    expect(r.signature.wholeDocumentIntegrity).toBe(true); expect(r.findings.some(f => f.code === 'PAYABLE_TOTAL_MISMATCH')).toBe(true);
  });
  it('detects tax subtotal inconsistencies', () => {
    const r = inspect(fixture.sign(xml().replace('>18.00</cbc:TaxAmount>', '>17.99</cbc:TaxAmount>')));
    expect(r.findings.some(f => f.code === 'TAX_SUBTOTAL_SUM_MISMATCH')).toBe(true);
  });
  it('detects a different tax scheme despite equal overall tax sums', () => {
    const doc = fixture.sign(xml().replace('<cbc:ID>1000</cbc:ID>', '<cbc:ID>2000</cbc:ID>'));
    expect(inspect(doc).findings.some(f => f.code === 'TAX_SCHEME_SUM_MISMATCH')).toBe(true);
  });
  it('does not invent optional values', () => {
    const doc = xml().replace(/<cbc:IssueTime>[^<]+<\/cbc:IssueTime>/, '').replace(/<cbc:TaxInclusiveAmount[^>]+>[^<]+<\/cbc:TaxInclusiveAmount>/, '');
    const r = inspect(doc); expect(r.projection.issueTime).toBe(null); expect(r.projection.totals.taxInclusiveAmount).toBe(null);
    expect(r.findings.some(f => f.code === 'PAYABLE_RECONCILIATION_INCOMPLETE')).toBe(true); expect(r.signature.status).toBe('MISSING');
  });
  it('supports credit installments as declared, without claiming fiscal validation', () => {
    const snapshot = structuredClone(createBusinessEvidenceSnapshot());
    snapshot.paymentTerms = { type: 'CREDITO', currencyCode: 'PEN', pendingAmount: '118.00',
      installments: [{ amount: '59.00', dueDate: '2026-11-04' }, { amount: '59.00', dueDate: '2026-12-04' }] };
    const r = inspect(fixture.sign(buildBusinessEvidenceXml(snapshot)));
    expect(r.projection.payments.map(p => p.amount)).toEqual(['118.00', '59.00', '59.00']);
    expect(r.projection.payments[2].dueDate).toBe('2026-12-04'); expect(r.businessRulesVerified).toBe(false);
  });
  it('retains discounts rather than subtracting them twice from net lines', () => {
    const r = inspect(xml().replace('<cac:InvoiceLine>', '<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:Amount currencyID="PEN">5.00</cbc:Amount></cac:AllowanceCharge><cac:InvoiceLine>'));
    expect(r.projection.allowances[0].amount).toBe('5.00'); expect(r.projection.totals.payableAmount).toBe('118.00');
  });
  it('preserves UTF8 BOM evidence hash while validating the XML infoset', () => {
    const doc = '\uFEFF' + signed(); const r = inspect(doc); expect(r.signature.wholeDocumentIntegrity).toBe(true);
    expect(r.rawSha256).not.toBe(inspect(doc.slice(1)).rawSha256);
  });
});
describe('fail-closed scopes, malicious XML and signed payloads', () => {
  it.each([{ environment: 'PRODUCTION' }, { purpose: 'IMPORT' }, { issuerRucs: ['00000000002'] }, { fromDate: '2026-10-05' }, { extra: true }])('blocks scope %j', patch => {
    expect(() => inspectOfflineSales(xml(), { ...scope, ...patch })).toThrow();
  });
  it.each(['<!DOCTYPE Invoice [<!ENTITY e SYSTEM "file:///secret">]>', '<?network x?>', '<!-- x -->'])('blocks active markup %s', prefix => {
    expect(() => inspect(prefix + xml())).toThrow('XML_UNSAFE');
  });
  it.each([['>2.000000<', '>0.000000<'], ['currencyID="PEN"', 'currencyID="USD"'], ['unitCode="GLL"', 'unitCode="BAD!"'],
    ['FQ01-1', 'BQ01-1'], ['>100.00<', '>-100.00<'], ['>100.00<', '>100.001<'], ['>2026-10-04<', '>2026-02-30<']])('blocks invalid field %s', (from, to) => {
    expect(() => inspect(xml().replace(from, to))).toThrow();
  });
  it('rejects duplicate header and line IDs', () => {
    expect(() => inspect(xml().replace('<cbc:ID>FQ01-1</cbc:ID>', '<cbc:ID>FQ01-1</cbc:ID><cbc:ID>FQ01-2</cbc:ID>'))).toThrow('XML_CARDINALITY');
    const duplicate = xml().match(/<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/)![0];
    expect(() => inspect(xml().replace('</Invoice>', duplicate + '</Invoice>'))).toThrow('SALES_LINE_ID');
  });
  it('rejects external and subdocument signature references', () => {
    expect(() => inspect(signed().replace('URI=""', 'URI="https://example.invalid/xml"'))).toThrow('SIGNATURE_REFERENCE');
  });
  it('detects digest tampering independently of reported acceptance', () => {
    const r = pair(signed().replace('EMISOR FICTICIO QA', 'EMISOR ALTERADO QA'), cdr());
    expect(r.document.signature.status).toBe('DIGEST_MISMATCH'); expect(r.officialAcceptance).toBe(false);
  });
  it('detects altered CDR body', () => {
    const r = pair(signed(), cdr().replace('>0</cbc:ResponseCode>', '>1</cbc:ResponseCode>'));
    expect(r.cdr?.signature.status).toBe('DIGEST_MISMATCH'); expect(r.cryptographicPairBound).toBe(false);
  });
  it('rejects proxy inputs without invoking traps', () => {
    let calls = 0; expect(() => reviewOfflineSalesPair(new Proxy({}, { get() { calls++; return xml(); } }))).toThrow(); expect(calls).toBe(0);
  });
  it('refuses missing note references rather than inventing a target', () => {
    const doc = xml('07').replace(/<cac:BillingReference>[\s\S]*?<\/cac:BillingReference>/, '');
    expect(() => inspect(doc)).toThrow('SALES_NOTE_REFERENCE');
  });
});
