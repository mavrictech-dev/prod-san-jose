import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src/events';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import {
  buildFiscalNoteSnapshot, buildFiscalNoteUbl, fiscalSnapshotSha256,
  type FiscalAcceptanceEvidence, type FiscalNoteContext, type FiscalNoteInput, type FiscalNoteSnapshot,
} from '../packages/sunat-core/src/fiscal-note';
import {
  buildFiscalBatchSnapshot, buildFiscalBatchUbl, validateFiscalBatchSnapshot,
  type FiscalBatchDocument, type FiscalBatchIdentity, type FiscalBatchInput,
  type FiscalNotDeliveredEvidence, type FiscalRcEntry, type FiscalRaEntry,
} from '../packages/sunat-core/src/fiscal-batch';

const { DOMParser } = createRequire(new URL('../services/sunat-service/package.json', import.meta.url))('@xmldom/xmldom');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const asOf = '2026-10-04T18:00:00Z';
// Fixtures en memoria con identidad RUC real estructural; no se envían ni se firman.
function receipt(n: number, type: '01' | '03' = '03', issueDate = '2026-10-02T16:00:00Z'): FiscalDocumentSnapshot {
  const series = type === '01' ? 'F001' : 'B001';
  return { documentId: uuid(n), companyId: 1, branchId: uuid(999), documentTypeCode: type, environment: 'BETA',
    series, number: String(n), fullNumber: `${series}-${n}`, issueDate, currencyCode: 'PEN', operationTypeCode: '0101',
    ...(type === '01' ? { paymentTerms: { type: 'CONTADO' as const } } : {}),
    issuer: { identityType: '6', identityNumber: '20100070970', legalName: 'Emisor & real', address: 'Av. Perú 123', ubigeo: '150101', establishmentCode: '0001' },
    customer: { identityType: '6', identityNumber: '20131312955', legalName: 'Cliente RUC' },
    ...calculateDocumentTotals([{ description: 'Bien gravado', unitCode: 'NIU', quantity: '2', unitPriceWithTax: '118', taxAffectationCode: '10', igvRate: '18' }]) };
}
function acceptance(doc: FiscalBatchDocument['snapshot']): FiscalAcceptanceEvidence {
  const isReceipt = doc.series.startsWith('B');
  return { environment: 'BETA', issuerRuc: doc.issuer.identityNumber, documentId: doc.documentId, documentTypeCode: doc.documentTypeCode as FiscalAcceptanceEvidence['documentTypeCode'],
    fullNumber: doc.fullNumber, snapshotSha256: fiscalSnapshotSha256(doc), cdrSha256: 'c'.repeat(64), responseCode: '0', status: 'ACCEPTED',
    acceptedAt: doc.documentTypeCode === '01' || doc.documentTypeCode === '03' ? '2026-10-02T16:10:00Z' : '2026-10-02T17:10:00Z',
    source: isReceipt ? { kind: 'CDR_SUMMARY', identifier: 'RC-20261002-10', referenceDate: '2026-10-02', lineNumber: 1, conditionCode: '1' } : { kind: 'CDR_DOCUMENT' } };
}
function notDelivered(doc: FiscalBatchDocument['snapshot']): FiscalNotDeliveredEvidence {
  return { status: 'NOT_DELIVERED', documentId: doc.documentId, documentTypeCode: doc.documentTypeCode as FiscalNotDeliveredEvidence['documentTypeCode'],
    fullNumber: doc.fullNumber, issuerRuc: doc.issuer.identityNumber, snapshotSha256: fiscalSnapshotSha256(doc), evidenceId: uuid(800), assertedAt: '2026-10-03T16:00:00Z' };
}
function batchIdentity(kind: 'RC' | 'RA' = 'RC', issueDate = '2026-10-03'): FiscalBatchIdentity {
  return { documentId: uuid(900), identifier: `${kind}-${issueDate.replaceAll('-', '')}-123`, issueDate, referenceDate: '2026-10-02' };
}
function mixed(): FiscalBatchInput & { kind: 'RC' } {
  const old = receipt(2), modified = structuredClone(old);
  Object.assign(modified, calculateDocumentTotals([{ description: 'Bien corregido', unitCode: 'NIU', quantity: '2', unitPriceWithTax: '59', taxAffectationCode: '10', igvRate: '18' }]));
  const cancelled = receipt(3);
  return { kind: 'RC', entries: [
    { conditionCode: '1', document: { snapshot: receipt(1) } },
    { conditionCode: '2', document: { snapshot: modified }, previous: { document: { snapshot: old }, acceptance: acceptance(old) } },
    { conditionCode: '3', document: { snapshot: cancelled }, previous: { document: { snapshot: cancelled }, acceptance: acceptance(cancelled) }, notDelivered: notDelivered(cancelled) },
  ] };
}
const partial: FiscalNoteInput = { documentTypeCode: '07', reasonCode: '07', reasonDescription: 'Devolver una unidad', lines: [{ originalLineNumber: 1, quantity: '1' }] };
const mora: FiscalNoteInput = { documentTypeCode: '08', reasonCode: '01', reasonDescription: 'Interés moratorio', interestNature: 'MORATORIO', interestBasis: 'Sustento contractual del caller', lines: [{ originalLineNumber: 1, interestAmount: '10.00' }] };
const increase: FiscalNoteInput = { documentTypeCode: '08', reasonCode: '02', reasonDescription: 'Aumento del valor', lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '11.8' }] };
function noteDocument(n: number, type: '01' | '03' = '03', input: FiscalNoteInput = partial, originalDate = '2026-10-02T16:00:00Z'): FiscalBatchDocument & { snapshot: FiscalNoteSnapshot; noteContext: FiscalNoteContext } {
  const doc = receipt(500, type, originalDate);
  const ctx: FiscalNoteContext = { original: doc, acceptance: acceptance(doc), asOf, creditHistory: { complete: true, entries: [] } };
  if (originalDate.startsWith('2026-10-01')) {
    ctx.acceptance.acceptedAt = '2026-10-01T16:10:00Z';
    if (ctx.acceptance.source.kind === 'CDR_SUMMARY') { ctx.acceptance.source.identifier = 'RC-20261001-1'; ctx.acceptance.source.referenceDate = '2026-10-01'; }
  }
  return { snapshot: buildFiscalNoteSnapshot(ctx, input, { documentId: uuid(n), series: type === '01' ? 'FN01' : 'BN01', number: String(n), issueDate: '2026-10-02T17:00:00Z' }), noteContext: ctx };
}
function raEntry(document: FiscalBatchDocument): FiscalRaEntry {
  return { document, acceptance: acceptance(document.snapshot), notDelivered: notDelivered(document.snapshot), reasonDescription: 'No entregado & numeración anulada' };
}
const elements = (node: any, name: string) => Array.from(node.childNodes).filter((n: any) => n.nodeType === 1 && n.localName === name) as any[];
const first = (node: any, name: string) => elements(node, name)[0];
function root(xml: string) {
  const errors: string[] = [];
  const doc = new DOMParser({ onError: (level: string, message: string) => { if (level !== 'warning') errors.push(message); } }).parseFromString(xml, 'application/xml');
  expect(errors).toEqual([]); return doc.documentElement;
}

describe('Fiscal batches BETA RC/RA reales', () => {
  it('RC múltiple 1/2/3 conserva RUC, snapshots, importes y totales exactos', () => {
    const input = mixed(), before = structuredClone(input), batch = buildFiscalBatchSnapshot(input, batchIdentity(), asOf);
    expect(batch.totals).toEqual({ taxableAmount: '500.00', igvAmount: '90.00', payableAmount: '590.00', unaffectedAmount: '0.00' });
    expect(batch.issuer.identityNumber).toBe('20100070970'); expect(input).toEqual(before);
    const xml = buildFiscalBatchUbl(batch, asOf), lines = elements(root(xml), 'SummaryDocumentsLine');
    expect(lines.map(l => first(l, 'LineID').textContent)).toEqual(['1', '2', '3']);
    expect(lines.map(l => first(first(l, 'Status'), 'ConditionCode').textContent)).toEqual(['1', '2', '3']);
    expect(lines.map(l => first(l, 'TotalAmount').textContent)).toEqual(['236.00', '118.00', '236.00']);
    expect(first(root(xml), 'CustomizationID').textContent).toBe('1.1');
    batch.input.entries[0].document.snapshot.customer.legalName = 'Cambio aislado'; expect(input).toEqual(before);
  });
  it('RC 03, 07 y 08 usa BillingReference 03 sólo en notas y fecha de la nota', () => {
    const credit = noteDocument(100, '03', partial, '2026-10-01T16:00:00Z'), debit = noteDocument(101, '03', increase, '2026-10-01T16:00:00Z');
    const batch = buildFiscalBatchSnapshot({ kind: 'RC', entries: [{ conditionCode: '1', document: { snapshot: receipt(1) } }, { conditionCode: '1', document: credit }, { conditionCode: '1', document: debit }] }, batchIdentity(), asOf);
    const r = root(buildFiscalBatchUbl(batch, asOf)), lines = elements(r, 'SummaryDocumentsLine');
    expect(first(r, 'ReferenceDate').textContent).toBe('2026-10-02'); expect(elements(lines[0], 'BillingReference')).toHaveLength(0);
    for (const line of lines.slice(1)) expect(first(first(first(line, 'BillingReference'), 'InvoiceDocumentReference'), 'DocumentTypeCode').textContent).toBe('03');
  });
  it('RC mora declara BillingPayment inafecto 03, TaxSubtotal 9998 y cero IGV', () => {
    const document = noteDocument(100, '03', mora), batch = buildFiscalBatchSnapshot({ kind: 'RC', entries: [{ conditionCode: '1', document }] }, batchIdentity(), asOf);
    const line = first(root(buildFiscalBatchUbl(batch, asOf)), 'SummaryDocumentsLine');
    expect(elements(line, 'BillingPayment').map(p => [first(p, 'InstructionID').textContent, first(p, 'PaidAmount').textContent])).toEqual([['01', '0.00'], ['02', '0.00'], ['03', '10.00']]);
    expect(first(first(line, 'TaxTotal'), 'TaxAmount').textContent).toBe('0.00');
    expect(first(first(first(first(line, 'TaxTotal'), 'TaxSubtotal'), 'TaxCategory'), 'TaxScheme').textContent).toBe('9998INAFRE');
  });
  it('RA múltiple sólo 01/07/08 F aceptados, no entregados, sin importes ficticios', () => {
    const input: FiscalBatchInput = { kind: 'RA', entries: [raEntry({ snapshot: receipt(1, '01') }), raEntry(noteDocument(100, '01')), raEntry(noteDocument(101, '01', mora))] };
    const batch = buildFiscalBatchSnapshot(input, batchIdentity('RA'), asOf), xml = buildFiscalBatchUbl(batch, asOf), r = root(xml);
    expect(r.localName).toBe('VoidedDocuments'); expect(first(r, 'UBLVersionID').textContent).toBe('2.0'); expect(first(r, 'CustomizationID').textContent).toBe('1.0');
    expect(elements(r, 'VoidedDocumentsLine').map(l => first(l, 'DocumentTypeCode').textContent)).toEqual(['01', '07', '08']);
    expect(xml).toContain('<sac:VoidReasonDescription>No entregado &amp; numeración anulada</sac:VoidReasonDescription>'); expect(xml).not.toContain('PayableAmount'); expect(xml).not.toContain('<cac:TaxTotal>');
  });
  it('firma referencial enlazada y RegistrationAddress completo en RC y RA', () => {
    for (const kind of ['RC', 'RA'] as const) {
      const input: FiscalBatchInput = kind === 'RC' ? mixed() : { kind, entries: [raEntry({ snapshot: receipt(1, '01') })] };
      const r = root(buildFiscalBatchUbl(buildFiscalBatchSnapshot(input, batchIdentity(kind), asOf), asOf));
      const signature = first(r, 'Signature'); expect(first(signature, 'ID').textContent).toBe('signatureFactuEz');
      expect(first(first(first(signature, 'DigitalSignatureAttachment'), 'ExternalReference'), 'URI').textContent).toBe('#signatureFactuEz');
      const address = first(first(first(first(r, 'AccountingSupplierParty'), 'Party'), 'PartyLegalEntity'), 'RegistrationAddress');
      expect(first(address, 'ID').textContent).toBe('150101'); expect(first(address, 'AddressTypeCode').textContent).toBe('0001');
      expect(first(first(address, 'AddressLine'), 'Line').textContent).toBe('Av. Perú 123'); expect(first(first(address, 'Country'), 'IdentificationCode').textContent).toBe('PE');
      expect(elements(r, 'TaxTotal')).toHaveLength(0); // No existe TaxTotal global en RC/RA.
      if (kind === 'RC') for (const line of elements(r, 'SummaryDocumentsLine')) {
        const subtotal = first(first(line, 'TaxTotal'), 'TaxSubtotal'); expect(first(subtotal, 'TaxableAmount')).toBeDefined(); expect(first(subtotal, 'TaxAmount')).toBeDefined();
      }
    }
  });
  it.each([
    ['duplicado ID', (i: any) => { i.entries[1].document.snapshot.documentId = i.entries[0].document.snapshot.documentId; }],
    ['duplicado número', (i: any) => { i.entries[1].document.snapshot.fullNumber = i.entries[0].document.snapshot.fullNumber; i.entries[1].document.snapshot.number = '1'; }],
    ['otro emisor', (i: any) => { i.entries[1].document.snapshot.issuer.identityNumber = '20131312955'; }],
    ['otra razón social', (i: any) => { i.entries[1].document.snapshot.issuer.legalName = 'Otro'; }],
    ['otra sede', (i: any) => { i.entries[1].document.snapshot.branchId = uuid(998); }],
    ['otra empresa', (i: any) => { i.entries[1].document.snapshot.companyId = 2; }],
    ['otra fecha', (i: any) => { i.entries[0].document.snapshot.issueDate = '2026-10-01T16:00:00Z'; }],
    ['estado inventado', (i: any) => { i.entries[0].conditionCode = '4'; }],
    ['modificación sin previo', (i: any) => { delete i.entries[1].previous; }],
    ['previo rechazado', (i: any) => { i.entries[1].previous.acceptance.status = 'REJECTED'; }],
    ['previo otra versión', (i: any) => { i.entries[1].previous.acceptance.snapshotSha256 = 'd'.repeat(64); }],
    ['cliente modificado', (i: any) => { i.entries[1].document.snapshot.customer.legalName = 'Otro cliente'; }],
    ['baja sin no-entrega', (i: any) => { delete i.entries[2].notDelivered; }],
    ['baja entregada', (i: any) => { i.entries[2].notDelivered.status = 'DELIVERED'; }],
    ['baja cero inventado', (i: any) => { i.entries[2].document.snapshot.totals.payableAmount = '0.00'; }],
    ['RUC ficticio', (i: any) => { i.entries[0].document.snapshot.issuer.identityNumber = '00000000001'; }],
    ['crédito', (i: any) => { i.entries[0].document.snapshot.paymentTerms = { type: 'CREDITO' }; }],
    ['extra entrada', (i: any) => { i.entries[0].total = '0.00'; }],
    ['alta con previo', (i: any) => { i.entries[0].previous = i.entries[1].previous; }],
  ])('rechaza RC: %s', (_, mutate) => {
    const input = mixed(); (mutate as (i: unknown) => void)(input); expect(() => buildFiscalBatchSnapshot(input, batchIdentity(), asOf)).toThrow();
  });
  it.each(['missing', 'delivered', 'other-id', 'other-hash', 'future', 'rejected'])('RA exige evidencia no entregado y aceptado: %s', scenario => {
    const entry: any = raEntry({ snapshot: receipt(1, '01') });
    if (scenario === 'missing') delete entry.notDelivered;
    if (scenario === 'delivered') entry.notDelivered.status = 'DELIVERED';
    if (scenario === 'other-id') entry.notDelivered.documentId = uuid(99);
    if (scenario === 'other-hash') entry.notDelivered.snapshotSha256 = 'e'.repeat(64);
    if (scenario === 'future') entry.notDelivered.assertedAt = '2026-10-05T16:00:00Z';
    if (scenario === 'rejected') entry.acceptance.status = 'REJECTED';
    expect(() => buildFiscalBatchSnapshot({ kind: 'RA', entries: [entry] }, batchIdentity('RA'), asOf)).toThrow();
  });
  it('enrutamiento: RA bloquea boletas/notas B, RC bloquea facturas/notas F', () => {
    for (const document of [{ snapshot: receipt(1) }, noteDocument(100)]) expect(() => buildFiscalBatchSnapshot({ kind: 'RA', entries: [raEntry(document)] }, batchIdentity('RA'), asOf)).toThrow();
    for (const document of [{ snapshot: receipt(1, '01') }, noteDocument(100, '01')]) expect(() => buildFiscalBatchSnapshot({ kind: 'RC', entries: [{ conditionCode: '1', document }] }, batchIdentity(), asOf)).toThrow();
  });
  it('nota sin contexto o referencia manipulada nunca entra en RC', () => {
    const document: any = noteDocument(100); delete document.noteContext;
    expect(() => buildFiscalBatchSnapshot({ kind: 'RC', entries: [{ conditionCode: '1', document }] }, batchIdentity(), asOf)).toThrow();
    const bad = noteDocument(100); bad.snapshot.reference.documentTypeCode = '01';
    expect(() => buildFiscalBatchSnapshot({ kind: 'RC', entries: [{ conditionCode: '1', document: bad }] }, batchIdentity(), asOf)).toThrow();
  });
  it('lote no sobreacredita al agrupar notas preparadas separadamente', () => {
    const documents = [noteDocument(100), noteDocument(101), noteDocument(102)];
    const entries = documents.map(document => ({ conditionCode: '1' as const, document }));
    expect(() => buildFiscalBatchSnapshot({ kind: 'RC', entries: entries.slice(0, 2) }, batchIdentity(), asOf)).not.toThrow();
    expect(() => buildFiscalBatchSnapshot({ kind: 'RC', entries }, batchIdentity(), asOf)).toThrow('Sobreacreditación');
  });
  it('límites exactos de identidad, calendario y 7 días en RC/RA', () => {
    for (const identity of [ { ...batchIdentity(), identifier: 'RA-20261003-123' }, { ...batchIdentity(), identifier: 'RC-20261002-123' }, { ...batchIdentity(), documentId: 'bad' }, { ...batchIdentity(), identifier: 'RC-20260230-1', issueDate: '2026-02-30' }, { ...batchIdentity(), identifier: 'RC-20261003-0' } ])
      expect(() => buildFiscalBatchSnapshot(mixed(), identity, asOf)).toThrow();
    const later = '2026-10-11T18:00:00Z';
    expect(() => buildFiscalBatchSnapshot(mixed(), batchIdentity('RC', '2026-10-09'), later)).not.toThrow();
    expect(() => buildFiscalBatchSnapshot(mixed(), batchIdentity('RC', '2026-10-10'), later)).toThrow('7 días');
    const ra: FiscalBatchInput = { kind: 'RA', entries: [raEntry({ snapshot: receipt(1, '01') })] };
    expect(() => buildFiscalBatchSnapshot(ra, batchIdentity('RA', '2026-10-09'), later)).not.toThrow();
    expect(() => buildFiscalBatchSnapshot(ra, batchIdentity('RA', '2026-10-10'), later)).toThrow('7 días');
  });
  it('sin entradas, >100 y snapshot alterado no generan XML', () => {
    expect(() => buildFiscalBatchSnapshot({ kind: 'RC', entries: [] }, batchIdentity(), asOf)).toThrow();
    const entries: FiscalRcEntry[] = Array.from({ length: 101 }, (_, index) => ({ conditionCode: '1', document: { snapshot: receipt(index + 1) } }));
    expect(() => buildFiscalBatchSnapshot({ kind: 'RC', entries }, batchIdentity(), asOf)).toThrow();
    const batch = buildFiscalBatchSnapshot(mixed(), batchIdentity(), asOf); batch.totals.payableAmount = '0.00';
    expect(() => buildFiscalBatchUbl(batch, asOf)).toThrow();
    const other = buildFiscalBatchSnapshot(mixed(), batchIdentity(), asOf); (other as any).guardOpen = true;
    expect(() => validateFiscalBatchSnapshot(other, asOf)).toThrow();
  });

  // Auditoría opcional offline, sin archivos generados, red ni certificado.
  // FACTUEZ_FISCAL_XSD_PYTHON selecciona Python con lxml; no cambia runtime/gates.
  it.skipIf(!process.env.FACTUEZ_FISCAL_XSD_PYTHON)('valida cuerpo NC/ND/RC/RA con XSD oficial; slot de firma vacío se omite sólo en copia de auditoría', () => {
    const credit = noteDocument(100, '01'), debit = noteDocument(101, '01', increase), late = noteDocument(102, '01', mora);
    const documents = [credit, debit, late].map(d => ({ kind: d.snapshot.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote', xml: buildFiscalNoteUbl(d.snapshot, d.noteContext) }));
    for (const input of [mixed(), { kind: 'RC' as const, entries: [{ conditionCode: '1' as const, document: noteDocument(103, '03', mora) }] }, { kind: 'RA' as const, entries: [raEntry({ snapshot: receipt(1, '01') }), raEntry(credit)] }]) {
      const batch = buildFiscalBatchSnapshot(input, batchIdentity(input.kind), asOf);
      documents.push({ kind: input.kind === 'RC' ? 'SummaryDocuments' : 'VoidedDocuments', xml: buildFiscalBatchUbl(batch, asOf) });
    }
    const script = `import hashlib,json,sys,zipfile,posixpath
from lxml import etree
data=json.load(sys.stdin)
assert hashlib.sha256(open(data['archive'],'rb').read()).hexdigest()=='5cac9d9353521340fbc15d23f465a4946b004535b9ff411541c87da01694dbd5'
archive=zipfile.ZipFile(data['archive'])
prefix=next(n[:-len('2.1/maindoc/UBL-CreditNote-2.1.xsd')] for n in archive.namelist() if n.endswith('2.1/maindoc/UBL-CreditNote-2.1.xsd'))
class Offline(etree.Resolver):
 def resolve(self,url,pubid,ctx):
  assert url.startswith('file:///sunat/'), 'External XSD import blocked'
  key=posixpath.normpath(url[len('file:///sunat/'):])
  assert not key.startswith('../')
  return self.resolve_string(archive.read(prefix+key),ctx,base_url=url)
parser=etree.XMLParser(resolve_entities=False,load_dtd=False,no_network=True)
parser.resolvers.add(Offline())
paths={'CreditNote':'2.1/maindoc/UBL-CreditNote-2.1.xsd','DebitNote':'2.1/maindoc/UBL-DebitNote-2.1.xsd','SummaryDocuments':'2.0/maindoc/UBLPE-SummaryDocuments-1.0.xsd','VoidedDocuments':'2.0/maindoc/UBLPE-VoidedDocuments-1.0.xsd'}
schemas={}
for document in data['documents']:
 kind=document['kind']
 if kind not in schemas: schemas[kind]=etree.XMLSchema(etree.parse('file:///sunat/'+paths[kind],parser))
 xml=document['xml'].encode('utf-8')
 assert b'<!DOCTYPE' not in xml and b'<!ENTITY' not in xml
 root=etree.fromstring(xml,etree.XMLParser(resolve_entities=False,load_dtd=False,no_network=True))
 # Antes de crypto, ExtensionContent vacío no cumple el XSD. Omitir extensión
 # opcional SOLO en esta copia audita el cuerpo, no valida firma/XML final.
 ns={'ext':'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2'}
 extensions=root.find('ext:UBLExtensions',ns)
 assert extensions is not None and len(extensions)==1
 content=extensions.find('ext:UBLExtension/ext:ExtensionContent',ns)
 assert content is not None and len(content)==0 and not content.text
 root.remove(extensions)
 schemas[kind].assertValid(root)
print('NC/ND/RC/RA: XSD SUNAT offline correcto')`;
    const result = spawnSync(process.env.FACTUEZ_FISCAL_XSD_PYTHON!, ['-c', script], {
      input: JSON.stringify({ archive: fileURLToPath(new URL('../services/sunat-service/assets/sunat/xsd-20220228.zip', import.meta.url)), documents }), encoding: 'utf8', shell: false, timeout: 20000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PYTHONNOUSERSITE: '1' },
    });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('correcto');
  }, 25000);
});
