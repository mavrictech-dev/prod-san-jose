import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src/events';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import {
  buildFiscalNoteSnapshot, buildFiscalNoteUbl, fiscalSnapshotSha256,
  validateFiscalNoteSnapshot, validateFiscalOriginal,
  type FiscalAcceptanceEvidence, type FiscalDocumentIdentity, type FiscalNoteContext, type FiscalNoteInput,
} from '../packages/sunat-core/src/fiscal-note';
import { buildNoteQaSnapshot } from '../packages/sunat-core/src/notes-qa';

const { DOMParser } = createRequire(new URL('../services/sunat-service/package.json', import.meta.url))('@xmldom/xmldom');
const asOf = '2026-10-04T18:00:00Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// RUC de formato real; evidencia simulada en memoria, NO una venta/CDR/certificado real.
function original(type: '01' | '03' = '01'): FiscalDocumentSnapshot {
  const series = type === '01' ? 'F001' : 'B001';
  return { documentId: uuid(1), companyId: 1, branchId: uuid(2), environment: 'BETA', documentTypeCode: type,
    series, number: '10', fullNumber: `${series}-10`, issueDate: '2026-10-02T16:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
    ...(type === '01' ? { paymentTerms: { type: 'CONTADO' as const } } : {}),
    issuer: { identityType: '6', identityNumber: '20100070970', legalName: 'Emisor & compañía', tradeName: 'Comercial', address: 'Av. Perú 123 & local', ubigeo: '150101', establishmentCode: '0000' },
    customer: type === '01' ? { identityType: '6', identityNumber: '20131312955', legalName: 'Cliente <RUC>' } : { identityType: '1', identityNumber: '12345678', legalName: 'Cliente DNI' },
    ...calculateDocumentTotals([
      { productCode: 'P&1', description: 'Producto <uno>', unitCode: 'NIU', quantity: '2', unitPriceWithTax: '118', taxAffectationCode: '10', igvRate: '18' },
      { description: 'Producto dos', unitCode: 'KGM', quantity: '1', unitPriceWithTax: '59', taxAffectationCode: '10', igvRate: '18' },
    ]) };
}
function acceptance(doc: FiscalDocumentSnapshot): FiscalAcceptanceEvidence {
  return { environment: 'BETA', issuerRuc: doc.issuer.identityNumber, documentId: doc.documentId, documentTypeCode: doc.documentTypeCode as '01' | '03',
    fullNumber: doc.fullNumber, snapshotSha256: fiscalSnapshotSha256(doc), cdrSha256: 'a'.repeat(64), responseCode: '0', status: 'ACCEPTED', acceptedAt: '2026-10-02T16:10:00Z',
    source: doc.documentTypeCode === '01' ? { kind: 'CDR_DOCUMENT' } : { kind: 'CDR_SUMMARY', identifier: 'RC-20261002-1', referenceDate: '2026-10-02', lineNumber: 1, conditionCode: '1' } };
}
function context(type: '01' | '03' = '01'): FiscalNoteContext {
  const doc = original(type); return { original: doc, acceptance: acceptance(doc), asOf, creditHistory: { complete: true, entries: [] } };
}
function identity(n = 100, prefix: 'F' | 'B' = 'F'): FiscalDocumentIdentity {
  return { documentId: uuid(n), series: `${prefix}N01`, number: String(n), issueDate: '2026-10-02T17:00:00Z' };
}
const partial: FiscalNoteInput = { documentTypeCode: '07', reasonCode: '07', reasonDescription: 'Devolución parcial & sustento', lines: [{ originalLineNumber: 1, quantity: '1' }] };
const decrease: FiscalNoteInput = { documentTypeCode: '07', reasonCode: '09', reasonDescription: 'Disminución pactada', lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '11.8' }] };
const increase: FiscalNoteInput = { documentTypeCode: '08', reasonCode: '02', reasonDescription: 'Aumento pactado', lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '11.8' }] };
const interest: FiscalNoteInput = { documentTypeCode: '08', reasonCode: '01', reasonDescription: 'Interés por mora', interestNature: 'MORATORIO', interestBasis: 'Cláusula de mora, importe liquidado por el caller', lines: [{ originalLineNumber: 1, interestAmount: '12.34' }] };
function parsed(xml: string) {
  const errors: string[] = [];
  const doc = new DOMParser({ onError: (level: string, message: string) => { if (level !== 'warning') errors.push(message); } }).parseFromString(xml, 'application/xml');
  expect(errors).toEqual([]); return doc;
}
const children = (node: any, name: string) => Array.from(node.childNodes).filter((n: any) => n.nodeType === 1 && n.localName === name) as any[];
const first = (node: any, name: string) => children(node, name)[0];

describe('Fiscal notes BETA reales, independientes de QA', () => {
  it.each(['01', '06'] as const)('07 motivo %s copia base/IGV/importe original sin renombrar RUC ni inventar serie', reasonCode => {
    const ctx = context(), before = structuredClone(ctx);
    const note = buildFiscalNoteSnapshot(ctx, { documentTypeCode: '07', reasonCode, reasonDescription: 'Sustento completo' }, identity());
    expect(note.issuer).toEqual(ctx.original.issuer); expect(note.customer).toEqual(ctx.original.customer);
    expect(note.series).toBe('FN01'); expect(note.totals).toEqual({ ...ctx.original.totals, unaffectedAmount: '0.00' });
    expect(note.lines.map(l => l.originalLineNumber)).toEqual([1, 2]);
    expect(ctx).toEqual(before); note.issuer.legalName = 'Cambiado'; expect(ctx.original.issuer.legalName).toBe(before.original.issuer.legalName);
  });
  it('07 devolución parcial toma precio original y referencia precisa', () => {
    const ctx = context(), note = buildFiscalNoteSnapshot(ctx, partial, identity());
    expect(note.lines[0]).toMatchObject({ originalLineNumber: 1, quantity: '1', unitPriceWithTax: '118', lineExtensionAmount: '100.00', igvAmount: '18.00', totalAmount: '118.00' });
    expect(note.reference).toMatchObject({ fullNumber: 'F001-10', documentId: ctx.original.documentId, snapshotSha256: fiscalSnapshotSha256(ctx.original) });
  });
  it.each(['05', '09'] as const)('07 motivo %s aplica delta por unidad y conserva cantidad', reasonCode => {
    const note = buildFiscalNoteSnapshot(context(), { ...decrease, reasonCode } as FiscalNoteInput, identity());
    expect(note.lines[0]).toMatchObject({ quantity: '2', unitPriceWithTax: '11.8', totalAmount: '23.60', lineExtensionAmount: '20.00', igvAmount: '3.60' });
  });
  it('08-02 declara aumento como delta, no sustituye el precio del original', () => {
    const note = buildFiscalNoteSnapshot(context(), increase, identity());
    expect(note.totals.payableAmount).toBe('23.60'); expect(note.lines[0].quantity).toBe('2');
  });
  it('08-01 mora: inafecta onerosa 30, tributo 9998/INA/FRE y suma exacta sin IGV', () => {
    const ctx = context(), note = buildFiscalNoteSnapshot(ctx, interest, identity());
    expect(note.lines[0]).toMatchObject({ quantity: '1', unitCode: 'ZZ', taxAffectationCode: '30', igvRate: '0', igvAmount: '0.00', totalAmount: '12.34' });
    expect(note.totals).toEqual({ taxableAmount: '0.00', unaffectedAmount: '12.34', igvAmount: '0.00', payableAmount: '12.34' });
    const xml = buildFiscalNoteUbl(note, ctx);
    expect(xml).toContain('>30</cbc:TaxExemptionReasonCode>'); expect(xml).not.toContain('>40</cbc:TaxExemptionReasonCode>');
    expect(xml).toContain('>9998</cbc:ID><cbc:Name>INA</cbc:Name><cbc:TaxTypeCode>FRE</cbc:TaxTypeCode>');
  });
  it.each(['01', '03'] as const)('07/08 conserva enlace al original %s aceptado', type => {
    const ctx = context(type), prefix = type === '01' ? 'F' : 'B';
    for (const input of [partial, increase]) {
      const note = buildFiscalNoteSnapshot(ctx, input, identity(100, prefix)); const xml = parsed(buildFiscalNoteUbl(note, ctx));
      const reference = first(first(xml.documentElement, 'BillingReference'), 'InvoiceDocumentReference');
      expect(first(reference, 'ID').textContent).toBe(ctx.original.fullNumber); expect(first(reference, 'DocumentTypeCode').textContent).toBe(type);
    }
  });
  it('05 en boleta y motivos sin soporte fallan cerrados', () => {
    expect(() => buildFiscalNoteSnapshot(context('03'), { ...decrease, reasonCode: '05' } as FiscalNoteInput, identity(100, 'B'))).toThrow('sólo admite factura');
    for (const code of ['02', '03', '04', '08', '13']) expect(() => buildFiscalNoteSnapshot(context(), { documentTypeCode: '07', reasonCode: code, reasonDescription: 'Sustento' } as never, identity())).toThrow();
  });
  it.each([
    ['sin contado', (d: any) => { delete d.paymentTerms; }],
    ['crédito/cuotas', (d: any) => { d.paymentTerms = { type: 'CREDITO', installments: [] }; }],
    ['RUC ficticio', (d: any) => { d.issuer.identityNumber = '00000000001'; }],
    ['checksum RUC', (d: any) => { d.issuer.identityNumber = '20100070971'; }],
    ['RUC cliente', (d: any) => { d.customer.identityNumber = '20131312956'; }],
    ['PRODUCTION', (d: any) => { d.environment = 'PRODUCTION'; }],
    ['USD', (d: any) => { d.currencyCode = 'USD'; }],
    ['descuento oculto', (d: any) => { d.discountAmount = undefined; }],
    ['cuotas ocultas', (d: any) => { d.paymentTerms.installments = undefined; }],
    ['IGV', (d: any) => { d.lines[0].igvRate = '10'; }],
    ['base alterada', (d: any) => { d.lines[0].lineExtensionAmount = '199.99'; }],
    ['suma alterada', (d: any) => { d.totals.payableAmount = '295.01'; }],
    ['importe >2 decimales', (d: any) => { d.lines[0].igvAmount = '36.000'; }],
    ['cantidad numérica', (d: any) => { d.lines[0].quantity = 2; }],
    ['correlativo numérico', (d: any) => { d.number = 10; }],
    ['fecha imposible', (d: any) => { d.issueDate = '2026-02-30T16:00:00Z'; }],
    ['offset imposible', (d: any) => { d.issueDate = '2026-10-02T16:00:00+14:01'; }],
    ['sin dirección', (d: any) => { delete d.issuer.address; }],
    ['ubigeo nulo', (d: any) => { d.issuer.ubigeo = '000000'; }],
    ['array con campo', (d: any) => { d.lines.discount = '1'; }],
  ])('rechaza original: %s', (_, mutate) => {
    const ctx = context(); (mutate as (d: unknown) => void)(ctx.original);
    expect(() => buildFiscalNoteSnapshot(ctx, partial, identity())).toThrow();
  });
  it.each([
    ['sin aceptación', (c: any) => { c.acceptance = undefined; }],
    ['rechazado', (c: any) => { c.acceptance.status = 'REJECTED'; }],
    ['código distinto', (c: any) => { c.acceptance.responseCode = '98'; }],
    ['otro RUC', (c: any) => { c.acceptance.issuerRuc = '20131312955'; }],
    ['otro ID', (c: any) => { c.acceptance.documentId = uuid(999); }],
    ['otro número', (c: any) => { c.acceptance.fullNumber = 'F001-11'; }],
    ['otra huella', (c: any) => { c.acceptance.snapshotSha256 = 'b'.repeat(64); }],
    ['CDR sin huella', (c: any) => { c.acceptance.cdrSha256 = ''; }],
    ['aceptación futura', (c: any) => { c.acceptance.acceptedAt = '2027-01-01T00:00:00Z'; }],
    ['historial incompleto', (c: any) => { c.creditHistory.complete = false; }],
    ['historial omitido', (c: any) => { delete c.creditHistory; }],
  ])('exige evidencia e historial: %s', (_, mutate) => {
    const ctx = context(); (mutate as (d: unknown) => void)(ctx); expect(() => buildFiscalNoteSnapshot(ctx, partial, identity())).toThrow();
  });
  it('boleta exige pertenencia explícita al RC aceptado y fecha de emisión del documento', () => {
    const ctx = context('03'); ctx.acceptance.source = { kind: 'CDR_DOCUMENT' };
    expect(() => buildFiscalNoteSnapshot(ctx, partial, identity(100, 'B'))).toThrow();
    ctx.acceptance = acceptance(ctx.original); (ctx.acceptance.source as any).referenceDate = '2026-10-01';
    expect(() => buildFiscalNoteSnapshot(ctx, partial, identity(100, 'B'))).toThrow();
  });
  it('aceptado con observaciones y huella canónica tolera orden de claves JSON', () => {
    const ctx = context(); ctx.acceptance.status = 'ACCEPTED_WITH_OBSERVATIONS';
    const note = buildFiscalNoteSnapshot(ctx, partial, identity());
    expect(() => validateFiscalNoteSnapshot(Object.fromEntries(Object.entries(note).reverse()) as typeof note, ctx)).not.toThrow();
  });
  it.each([
    { ...partial, lines: [{ originalLineNumber: 999, quantity: '1' }] },
    { ...partial, lines: [{ originalLineNumber: 1, quantity: '3' }] },
    { ...partial, lines: [{ originalLineNumber: 1, quantity: '1', unitPriceWithTax: '1' }] },
    { ...partial, lines: [{ originalLineNumber: 1, quantity: '1' }, { originalLineNumber: 1, quantity: '1' }] },
    { ...partial, lines: [{ originalLineNumber: 1, quantity: '2' }, { originalLineNumber: 2, quantity: '1' }] },
    { ...decrease, lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '119' }] },
    { ...decrease, lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '0.000001' }] },
    { ...interest, interestNature: 'COMPENSATORIO' },
    { ...interest, interestBasis: '' },
    { ...interest, lines: [{ originalLineNumber: 1, interestAmount: '12.345' }] },
  ])('rechaza selección, precio y semántica inválidos (%#)', input => {
    expect(() => buildFiscalNoteSnapshot(context(), input as FiscalNoteInput, identity())).toThrow();
  });
  it('dos devoluciones consumen el saldo; reserva y aceptado impiden tercera devolución/anulación', () => {
    const ctx = context(), one = buildFiscalNoteSnapshot(ctx, partial, identity(100));
    ctx.creditHistory.entries.push({ state: 'RESERVED', note: one });
    const two = buildFiscalNoteSnapshot(ctx, partial, identity(101));
    ctx.creditHistory.entries.push({ state: 'ACCEPTED', note: two });
    expect(() => buildFiscalNoteSnapshot(ctx, partial, identity(102))).toThrow('Sobreacreditación');
    expect(() => buildFiscalNoteSnapshot(ctx, { documentTypeCode: '07', reasonCode: '01', reasonDescription: 'Anular' }, identity(102))).toThrow('Sobreacreditación');
  });
  it('disminuciones acumuladas no exceden valor original y no inventan saldo mezclado', () => {
    const ctx = context(); const one = buildFiscalNoteSnapshot(ctx, { ...decrease, lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '70.8' }] }, identity(100));
    ctx.creditHistory.entries.push({ state: 'ACCEPTED', note: one });
    expect(() => buildFiscalNoteSnapshot(ctx, { ...decrease, lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '59' }] }, identity(101))).toThrow('Sobreacreditación');
    expect(() => buildFiscalNoteSnapshot(ctx, partial, identity(101))).toThrow('Mezcla');
  });
  it('historial duplicado o manipulado y redondeo acumulado fallan cerrados', () => {
    const ctx = context(); const one = buildFiscalNoteSnapshot(ctx, partial, identity(100));
    ctx.creditHistory.entries = [{ state: 'RESERVED', note: one }, { state: 'ACCEPTED', note: one }];
    expect(() => buildFiscalNoteSnapshot(ctx, partial, identity(101))).toThrow();
    ctx.creditHistory.entries = [{ state: 'RESERVED', note: structuredClone(one) }]; ctx.creditHistory.entries[0].note.totals.igvAmount = '0.00';
    expect(() => buildFiscalNoteSnapshot(ctx, partial, identity(101))).toThrow();
    const small = context(); Object.assign(small.original, calculateDocumentTotals([{ description: 'Centavos', unitCode: 'NIU', quantity: '2', unitPriceWithTax: '0.03', taxAffectationCode: '10', igvRate: '18' }]));
    small.acceptance = acceptance(small.original); const firstNote = buildFiscalNoteSnapshot(small, partial, identity(100));
    small.creditHistory.entries = [{ state: 'RESERVED', note: firstNote }];
    expect(() => buildFiscalNoteSnapshot(small, partial, identity(101))).toThrow('Sobreacreditación');
  });
  it.each(['customer', 'reference', 'tax', 'sum', 'extra', 'adjustment', 'mora40'])('no genera XML de snapshot manipulado: %s', field => {
    const ctx = context(), note: any = buildFiscalNoteSnapshot(ctx, field === 'mora40' ? interest : partial, identity());
    if (field === 'customer') note.customer.legalName = 'Otro cliente';
    if (field === 'reference') note.reference.fullNumber = 'F001-999';
    if (field === 'tax') note.lines[0].igvAmount = '0.00';
    if (field === 'sum') note.totals.payableAmount = '1.00';
    if (field === 'extra') note.discount = undefined;
    if (field === 'adjustment') note.adjustment.lines[0].quantity = '0.5';
    if (field === 'mora40') note.lines[0].taxAffectationCode = '40';
    expect(() => buildFiscalNoteUbl(note, ctx)).toThrow();
  });
  it('UBL contiene estructura fiscal, dirección, referencias, firma enlazada y subtotales de cabecera', () => {
    const ctx = context(), note = buildFiscalNoteSnapshot(ctx, partial, identity()), raw = buildFiscalNoteUbl(note, ctx), root = parsed(raw).documentElement;
    expect(root.namespaceURI).toBe('urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2');
    expect(first(root, 'UBLVersionID').textContent).toBe('2.1'); expect(first(root, 'CustomizationID').textContent).toBe('2.0');
    const signature = first(root, 'Signature'), uri = first(first(first(signature, 'DigitalSignatureAttachment'), 'ExternalReference'), 'URI');
    expect(first(signature, 'ID').textContent).toBe('signatureFactuEz'); expect(uri.textContent).toBe('#signatureFactuEz');
    const address = first(first(first(first(root, 'AccountingSupplierParty'), 'Party'), 'PartyLegalEntity'), 'RegistrationAddress');
    expect(first(address, 'ID').textContent).toBe('150101'); expect(first(address, 'AddressTypeCode').textContent).toBe('0000');
    expect(first(first(address, 'AddressLine'), 'Line').textContent).toBe(ctx.original.issuer.address); expect(first(first(address, 'Country'), 'IdentificationCode').textContent).toBe('PE');
    const tax = first(first(root, 'TaxTotal'), 'TaxSubtotal'); expect(first(tax, 'TaxableAmount').textContent).toBe('100.00'); expect(first(tax, 'TaxAmount').textContent).toBe('18.00');
    const reason = first(first(root, 'DiscrepancyResponse'), 'ResponseCode'); expect(reason.getAttribute('listURI')).toContain('catalogo09');
    expect(raw).toContain('Emisor &amp; compañía'); expect(raw).toContain('Producto &lt;uno&gt;'); expect(raw).not.toContain('<ds:Signature');
  });
  it('fecha civil XML Lima respeta cambio de día y fechas de nota son posteriores a aceptación', () => {
    const ctx = context(), id = { ...identity(), issueDate: '2026-10-03T01:00:00Z' };
    const note = buildFiscalNoteSnapshot(ctx, partial, id); expect(buildFiscalNoteUbl(note, ctx)).toContain('<cbc:IssueDate>2026-10-02</cbc:IssueDate>');
    for (const issueDate of ['2026-10-02T16:05:00Z', '2026-10-05T17:00:00Z', '2026-02-30T12:00:00Z']) expect(() => buildFiscalNoteSnapshot(ctx, partial, { ...identity(), issueDate })).toThrow();
  });
  it('validadores QA siguen cerrados a RUC real', () => {
    const doc = original(); expect(() => validateFiscalOriginal(doc, asOf)).not.toThrow();
    expect(() => buildNoteQaSnapshot(doc, { idempotencyKey: uuid(100), documentTypeCode: '07', reasonCode: '01', reasonDescription: 'QA' }, { documentId: uuid(101), number: '1', issueDate: '2026-10-02T17:00:00Z' })).toThrow();
  });
});
