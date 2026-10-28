import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FiscalDocumentSnapshot, FiscalPaymentTermsSnapshot } from '../packages/contracts/src/events';
import { buildInvoiceUbl } from '../packages/sunat-core/src/ubl';
import { validateFiscalSnapshot, validateInvoicePaymentTerms } from '../packages/sunat-core/src/fiscal-rules';
import { validateLocalInvoice } from '../packages/sunat-core/src/local-validation';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { buildNoteQaSnapshot, validateNoteQaSnapshot } from '../packages/sunat-core/src/notes-qa';
import { buildNoteQaUbl } from '../packages/sunat-core/src/notes-ubl';

const now = new Date('2026-10-02T12:00:00Z');
// Captured from the original builder, then compared byte-for-byte for 12 legacy variants.
const legacyXmlSha256 = {
  '01': 'a14842bf2764ce40566041ec7910896d9cff8702edc6aede6a91edf0131b1d69',
  '03': '1e2c8768eceb209593e6303a6259af770cd99b0848288ba1318f2dc98d328a57',
};
function invoice(total = '118.00'): FiscalDocumentSnapshot {
  return {
    documentId: '11111111-1111-4111-8111-111111111111', environment: 'BETA',
    documentTypeCode: '01', series: 'FQ01', number: '1', fullNumber: 'FQ01-1',
    issueDate: '2026-10-01T16:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
    issuer: { identityType: '6', identityNumber: '00000000001', legalName: 'EMISOR FICTICIO', ubigeo: '150101', establishmentCode: '0001' },
    customer: { identityType: '6', identityNumber: '00000000000', legalName: 'CLIENTE FICTICIO' },
    ...calculateDocumentTotals([{ description: 'Ítem QA', quantity: '1', unitCode: 'NIU', unitPriceWithTax: total, taxAffectationCode: '10', igvRate: '18' }]),
  };
}
function credit(): Extract<FiscalPaymentTermsSnapshot, { type: 'CREDITO' }> {
  return { type: 'CREDITO', currencyCode: 'PEN', pendingAmount: '118.00', installments: [
    { amount: '59.00', dueDate: '2026-10-02' },
    { amount: '59.00', dueDate: '2026-10-03', currencyCode: 'PEN' },
  ] };
}
function creditInvoice(total = '118.00') {
  const doc = invoice(total); doc.paymentTerms = credit(); return doc;
}
function boleta(): FiscalDocumentSnapshot {
  const doc = invoice();
  Object.assign(doc, { documentTypeCode: '03', series: 'BQ01', fullNumber: 'BQ01-1', customer: { identityType: '0', identityNumber: '0', legalName: 'CLIENTE FICTICIO' } });
  return doc;
}
/** Pure synthetic checksum inputs; no taxpayer lookup, credentials or real certificate. */
function realPreparation(doc: FiscalDocumentSnapshot) {
  const copy = structuredClone(doc);
  copy.issuer.identityNumber = '20000000001';
  copy.customer.identityNumber = '10000000006';
  return copy;
}
const validate = (doc: unknown) => validateFiscalSnapshot(doc, { mode: 'LOCAL_DEVELOPMENT', now });
function rejectsPayment(doc: FiscalDocumentSnapshot, code: string, path?: string) {
  const result = validate(doc);
  expect(result.valid).toBe(false);
  expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code, ...(path ? { path } : {}) })]));
  expect(() => buildInvoiceUbl(doc)).toThrow(code);
  expect(() => validateLocalInvoice(doc, { allowCredit: true })).toThrow(code);
}

describe('Forma de pago explícita y snapshots históricos', () => {
  it.each(['01', '03'] as const)('conserva %s antiguo sin inventar Contado ni mutarlo', type => {
    const doc = type === '01' ? invoice() : boleta(), before = structuredClone(doc);
    expect(validate(doc).valid).toBe(true);
    validateLocalInvoice(doc);
    const legacyXml = buildInvoiceUbl(doc);
    expect(createHash('sha256').update(legacyXml).digest('hex')).toBe(legacyXmlSha256[type]);
    expect(legacyXml).not.toContain('PaymentTerms');
    expect(legacyXml).not.toContain('Contado');
    expect(doc).toEqual(before);
    expect(Object.hasOwn(doc, 'paymentTerms')).toBe(false);
  });
  it.each(['01', '03'] as const)('emite un solo FormaPago/Contado para %s explícito, sin importe ni cuota', type => {
    const doc = type === '01' ? invoice() : boleta(); doc.paymentTerms = { type: 'CONTADO' };
    expect(validate(doc).valid).toBe(true); validateLocalInvoice(doc);
    const output = buildInvoiceUbl(doc);
    expect(output.match(/<cac:PaymentTerms>/g)).toHaveLength(1);
    expect(output).toContain('<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Contado</cbc:PaymentMeansID></cac:PaymentTerms>');
    expect(output).not.toContain('Cuota'); expect(output).not.toContain('<cbc:Amount');
  });
  it('REAL_PREPARATION exige declaración en 01 y no suplanta el snapshot antiguo', () => {
    const doc = realPreparation(invoice()), before = structuredClone(doc);
    const result = validateFiscalSnapshot(doc, { mode: 'REAL_PREPARATION', now });
    expect(result.issues.map(issue => issue.code)).toEqual(['PAYMENT_TERMS_REQUIRED']);
    expect(() => buildInvoiceUbl(doc, { mode: 'REAL_PREPARATION' })).toThrow('PAYMENT_TERMS_REQUIRED');
    expect(doc).toEqual(before);
    doc.paymentTerms = { type: 'CONTADO' };
    expect(validateFiscalSnapshot(doc, { mode: 'REAL_PREPARATION', now }).valid).toBe(true);
    expect(buildInvoiceUbl(doc, { mode: 'REAL_PREPARATION' })).toContain('Contado');
  });
  it('no exige la forma de pago de factura a boleta 03 histórica en preparación real', () => {
    const doc = boleta(); doc.issuer.identityNumber = '20000000001';
    expect(validateFiscalSnapshot(doc, { mode: 'REAL_PREPARATION', now }).valid).toBe(true);
    expect(buildInvoiceUbl(doc, { mode: 'REAL_PREPARATION' })).not.toContain('PaymentTerms');
  });
  it.each([null, [], 'CONTADO', 1, {}, { type: 'Contado' }, { type: 'Credito' }, { type: 'OTRO' }])('rechaza forma de pago inválida %#', value => {
    const doc = invoice(); Object.assign(doc, { paymentTerms: value });
    rejectsPayment(doc, value !== null && typeof value === 'object' && !Array.isArray(value) ? 'PAYMENT_TYPE' : 'PAYMENT_TERMS_SHAPE');
  });
  it.each(['pendingAmount', 'installments', 'currencyCode', 'paymentMeansId'])('Contado no admite campo %s aunque sea undefined', field => {
    const doc = invoice(); Object.assign(doc, { paymentTerms: { type: 'CONTADO', [field]: undefined } });
    rejectsPayment(doc, 'UNSUPPORTED_FIELDS', 'paymentTerms');
  });
});

describe('Factura 01 al crédito: decimales exactos y UBL SUNAT', () => {
  it('serializa saldo y cada cuota en agregados independientes antes de TaxTotal, conservando orden y snapshot', () => {
    const doc = creditInvoice(), before = structuredClone(doc);
    expect(validate(doc).valid).toBe(true);
    validateLocalInvoice(doc, { allowCredit: true });
    const output = buildInvoiceUbl(doc);
    const terms = output.match(/<cac:PaymentTerms>[\s\S]*?<\/cac:PaymentTerms>/g)!;
    expect(terms).toEqual([
      '<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Credito</cbc:PaymentMeansID><cbc:Amount currencyID="PEN">118.00</cbc:Amount></cac:PaymentTerms>',
      '<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Cuota001</cbc:PaymentMeansID><cbc:Amount currencyID="PEN">59.00</cbc:Amount><cbc:PaymentDueDate>2026-10-02</cbc:PaymentDueDate></cac:PaymentTerms>',
      '<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Cuota002</cbc:PaymentMeansID><cbc:Amount currencyID="PEN">59.00</cbc:Amount><cbc:PaymentDueDate>2026-10-03</cbc:PaymentDueDate></cac:PaymentTerms>',
    ]);
    expect(terms.every(term => (term.match(/<cbc:PaymentMeansID>/g) ?? []).length === 1)).toBe(true);
    expect(output.indexOf('</cac:AccountingCustomerParty>')).toBeLessThan(output.indexOf('<cac:PaymentTerms>'));
    expect(output.lastIndexOf('</cac:PaymentTerms>')).toBeLessThan(output.indexOf('<cac:TaxTotal>'));
    expect(doc).toEqual(before);
    expect(validateFiscalSnapshot(realPreparation(doc), { mode: 'REAL_PREPARATION', now }).valid).toBe(true);
  });
  it('admite pago parcial: compara la suma con el saldo y no con el total', () => {
    const doc = invoice(); doc.paymentTerms = { type: 'CREDITO', currencyCode: 'PEN', pendingAmount: '0.30', installments: [
      { amount: '0.10', dueDate: '2026-10-02' }, { amount: '0.20', dueDate: '2026-10-03' },
    ] };
    expect(validate(doc).valid).toBe(true);
    expect(buildInvoiceUbl(doc)).toContain('<cbc:Amount currencyID="PEN">0.30</cbc:Amount>');
    doc.paymentTerms.pendingAmount = '0.31'; rejectsPayment(doc, 'PAYMENT_INSTALLMENTS_SUM');
  });
  it('admite saldo igual al total y una única cuota, normalizando sin redondear', () => {
    const doc = invoice('0.30'); doc.paymentTerms = { type: 'CREDITO', currencyCode: 'PEN', pendingAmount: '0.3', installments: [{ amount: '0.30', dueDate: '2026-10-02' }] };
    expect(validate(doc).valid).toBe(true);
    expect(buildInvoiceUbl(doc).match(/<cbc:Amount currencyID="PEN">0.30<\/cbc:Amount>/g)).toHaveLength(2);
    expect(doc.paymentTerms.pendingAmount).toBe('0.3');
  });
  it('conserva exactitud hasta 12 enteros, con centavos distintos', () => {
    const doc = invoice('999999999999.99'); doc.paymentTerms = { type: 'CREDITO', currencyCode: 'PEN', pendingAmount: '999999999999.99', installments: [
      { amount: '999999999999.98', dueDate: '2026-10-02' }, { amount: '0.01', dueDate: '2026-10-03' },
    ] };
    expect(validate(doc).valid).toBe(true);
    expect(buildInvoiceUbl(doc)).toContain('<cbc:Amount currencyID="PEN">999999999999.99</cbc:Amount>');
  });
  it('rechaza saldo mayor que el total', () => {
    const doc = creditInvoice(); doc.paymentTerms = { ...credit(), pendingAmount: '118.01' };
    rejectsPayment(doc, 'PAYMENT_PENDING_LIMIT', 'paymentTerms.pendingAmount');
  });
  it.each([['saldo', 'pendingAmount'], ['cuota', 'amount']] as const)('rechaza %s cero', (_label, field) => {
    const doc = creditInvoice(), terms = doc.paymentTerms as ReturnType<typeof credit>;
    if (field === 'pendingAmount') terms.pendingAmount = '0.00'; else terms.installments[0].amount = '0';
    rejectsPayment(doc, 'PAYMENT_POSITIVE');
  });
  it.each([undefined, null, 0.1, NaN, Infinity, '-1.00', '+1', '1e2', '1,00', ' 1.00', '1.00 ', '.10', '1.', '0.001', '118.000', '1000000000000.00', '1<script>', '1'.repeat(500)])('rechaza decimal no exacto/inseguro %# tanto en saldo como cuota', value => {
    for (const field of ['pendingAmount', 'amount']) {
      const doc = creditInvoice(), terms = doc.paymentTerms as ReturnType<typeof credit>;
      if (field === 'pendingAmount') Object.assign(terms, { pendingAmount: value });
      else Object.assign(terms.installments[0], { amount: value });
      rejectsPayment(doc, 'PAYMENT_DECIMAL');
    }
  });
  it.each([undefined, null, {}, [], Array.from({ length: 1000 }, () => ({ amount: '0.01', dueDate: '2026-10-02' }))])('requiere 1..999 cuotas %#', value => {
    const doc = creditInvoice(); Object.assign(doc.paymentTerms!, { installments: value });
    rejectsPayment(doc, 'PAYMENT_INSTALLMENTS_COUNT');
  });
  it.each([null, [], 'cuota', undefined])('rechaza cuota sin objeto %#', value => {
    const doc = creditInvoice(); Object.assign(doc.paymentTerms!, { installments: [value] });
    rejectsPayment(doc, 'PAYMENT_INSTALLMENT_SHAPE');
  });
  it('rechaza un hueco en el array sin saltar la cuota', () => {
    const doc = creditInvoice(); Object.assign(doc.paymentTerms!, { installments: Array(1) });
    rejectsPayment(doc, 'PAYMENT_INSTALLMENT_SHAPE');
  });
  it('genera identificadores consecutivos únicos hasta Cuota999, sin Cuota000 ni Cuota1000', () => {
    const doc = invoice(); doc.paymentTerms = { type: 'CREDITO', currencyCode: 'PEN', pendingAmount: '9.99', installments: Array.from({ length: 999 }, () => ({ amount: '0.01', dueDate: '2026-10-02' })) };
    expect(validate(doc).valid).toBe(true);
    const ids = [...buildInvoiceUbl(doc).matchAll(/<cbc:PaymentMeansID>(Cuota\d+)<\/cbc:PaymentMeansID>/g)].map(match => match[1]);
    expect(ids).toHaveLength(999); expect(new Set(ids).size).toBe(999);
    expect(ids[0]).toBe('Cuota001'); expect(ids[9]).toBe('Cuota010'); expect(ids[98]).toBe('Cuota099'); expect(ids[998]).toBe('Cuota999');
  });
  it('no acepta identificadores personalizados o duplicados declarados por el emisor', () => {
    const doc = creditInvoice(), terms = doc.paymentTerms as ReturnType<typeof credit>;
    Object.assign(terms.installments[0], { id: 'Cuota001' });
    Object.assign(terms.installments[1], { id: 'Cuota001' });
    rejectsPayment(doc, 'UNSUPPORTED_FIELDS', 'paymentTerms.installments[0]');
  });
  it('la nueva capacidad mantiene cobertura parcial y transmisión no autorizada', () => {
    expect(validate(creditInvoice())).toMatchObject({ valid: true, coverageComplete: false, transmissionAuthorized: false });
  });
});

describe('Moneda y fechas de cuotas', () => {
  it('USD coherente se conserva en el saldo y en cada cuota, incluyendo moneda heredada', () => {
    const doc = creditInvoice(), terms = doc.paymentTerms as ReturnType<typeof credit>;
    doc.currencyCode = 'USD'; terms.currencyCode = 'USD'; terms.installments[1].currencyCode = 'USD';
    expect(validate(doc).valid).toBe(true);
    expect(buildInvoiceUbl(doc).match(/<cbc:Amount currencyID="USD">/g)).toHaveLength(3);
  });
  it.each([undefined, null, 'USD', 'EUR', 'PEN"/>', 1, new String('PEN')])('rechaza moneda del saldo distinta, omitida o inválida %#', value => {
    const doc = creditInvoice(); Object.assign(doc.paymentTerms!, { currencyCode: value });
    rejectsPayment(doc, 'PAYMENT_CURRENCY', 'paymentTerms.currencyCode');
  });
  it.each([null, 'USD', 'EUR', 'PEN"/>', 1])('rechaza moneda incoherente de cuota %#', value => {
    const doc = creditInvoice(), terms = doc.paymentTerms as ReturnType<typeof credit>;
    Object.assign(terms.installments[0], { currencyCode: value });
    rejectsPayment(doc, 'PAYMENT_CURRENCY', 'paymentTerms.installments[0].currencyCode');
  });
  it.each([undefined, null, 20261002, '2026-02-29', '2026-02-30', '2026-04-31', '2026-00-01', '2026-13-01', '2026-10-00', '2026-10-32', '2026-1-2', '2026-10-02T12:00:00Z', '2026-10-02<script>', '2026-10-02 '])('rechaza fecha fuera del calendario/formato %#', value => {
    const doc = creditInvoice(), terms = doc.paymentTerms as ReturnType<typeof credit>;
    Object.assign(terms.installments[0], { dueDate: value });
    rejectsPayment(doc, 'PAYMENT_DUE_DATE', 'paymentTerms.installments[0].dueDate');
  });
  it('acepta 29 de febrero bisiesto y rechaza el de un siglo no bisiesto', () => {
    const doc = creditInvoice(), terms = doc.paymentTerms as ReturnType<typeof credit>;
    terms.installments[0].dueDate = '2028-02-29'; expect(validate(doc).valid).toBe(true);
    terms.installments[0].dueDate = '2100-02-29'; rejectsPayment(doc, 'PAYMENT_DUE_DATE');
  });
  it('rechaza vencimiento anterior a emisión', () => {
    const doc = creditInvoice(), terms = doc.paymentTerms as ReturnType<typeof credit>;
    terms.installments[0].dueDate = '2026-09-30'; rejectsPayment(doc, 'PAYMENT_DUE_BEFORE_ISSUE');
  });
  it.each(['2026-10-02T02:30:00Z', '2026-10-02T05:30:00+03:00'])('usa emisión Lima, no el día UTC/offset del texto (%s)', timestamp => {
    const doc = creditInvoice(), terms = doc.paymentTerms as ReturnType<typeof credit>;
    doc.issueDate = timestamp; terms.installments[0].dueDate = '2026-10-01';
    expect(validate(doc).valid).toBe(true);
    expect(buildInvoiceUbl(doc)).toContain('<cbc:IssueDate>2026-10-01</cbc:IssueDate>');
    terms.installments[0].dueDate = '2026-10-02';
    expect(validateFiscalSnapshot(realPreparation(doc), { mode: 'REAL_PREPARATION', now }).valid).toBe(true);
  });
  it('igualdad de fecha admitida localmente se bloquea en REAL_PREPARATION por regla oficial 3267', () => {
    const doc = creditInvoice(), terms = doc.paymentTerms as ReturnType<typeof credit>;
    terms.installments[0].dueDate = '2026-10-01';
    expect(validate(doc).valid).toBe(true); expect(buildInvoiceUbl(doc)).toContain('<cbc:PaymentDueDate>2026-10-01</cbc:PaymentDueDate>');
    const real = realPreparation(doc), result = validateFiscalSnapshot(real, { mode: 'REAL_PREPARATION', now });
    expect(result.issues.map(issue => issue.code)).toEqual(['PAYMENT_DUE_AFTER_ISSUE_REQUIRED']);
    expect(() => buildInvoiceUbl(real, { mode: 'REAL_PREPARATION' })).toThrow('PAYMENT_DUE_AFTER_ISSUE_REQUIRED');
  });
  it('no ordena las cuotas por fecha ni cambia sus identificadores', () => {
    const doc = creditInvoice(), terms = doc.paymentTerms as ReturnType<typeof credit>;
    terms.installments.reverse(); const before = structuredClone(doc);
    const output = buildInvoiceUbl(doc);
    expect(output).toContain('<cbc:PaymentMeansID>Cuota001</cbc:PaymentMeansID><cbc:Amount currencyID="PEN">59.00</cbc:Amount><cbc:PaymentDueDate>2026-10-03</cbc:PaymentDueDate>');
    expect(doc).toEqual(before);
  });
  it('no normaliza un calendario inválido en la emisión antes de comparar cuotas', () => {
    const doc = creditInvoice(); doc.issueDate = '2026-02-30T12:00:00Z'; rejectsPayment(doc, 'ISSUE_DATE');
  });
});

describe('Cierre de perfiles adicionales y compatibilidad de notas', () => {
  it('boleta rechaza crédito incluso con saldo y cuotas coherentes', () => {
    const doc = boleta(); doc.paymentTerms = credit(); rejectsPayment(doc, 'PAYMENT_DOCUMENT_PROFILE');
  });
  it.each(['iscAmount', 'icbperAmount', 'discountAmount', 'prepaidAmount', 'retention', 'detraction', 'perception', 'exemptAmount'])('no descarta campo fiscal adicional %s', field => {
    for (const scope of ['root', 'line', 'total', 'payment'] as const) {
      const doc = creditInvoice();
      const target = scope === 'root' ? doc : scope === 'line' ? doc.lines[0] : scope === 'total' ? doc.totals : doc.paymentTerms!;
      Object.assign(target, { [field]: '0.01' }); rejectsPayment(doc, 'UNSUPPORTED_FIELDS');
    }
  });
  it.each(['20', '30', '40', '11'])('no genera IGV gravado para afectación no implementada %s', affectation => {
    const doc = creditInvoice(); doc.lines[0].taxAffectationCode = affectation;
    expect(validate(doc).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TAX_PROFILE', category: 'UNSUPPORTED' })]));
    expect(() => buildInvoiceUbl(doc)).toThrow('Perfil tributario XML no implementado');
    expect(() => validateLocalInvoice(doc, { allowCredit: true })).toThrow();
  });
  it('rechaza modos desconocidos antes de usar reglas de pago o serializar', () => {
    const doc = creditInvoice(), options = { mode: 'UNKNOWN' as never };
    expect(validateInvoicePaymentTerms(doc, options)[0].code).toBe('PROFILE_MODE');
    expect(() => buildInvoiceUbl(doc, options)).toThrow('PROFILE_MODE');
  });
  const identity = { documentId: '22222222-2222-4222-8222-222222222222', number: '1', issueDate: '2026-10-02T10:00:00Z' };
  const noteInput = (type: '07' | '08') => ({ idempotencyKey: identity.documentId, documentTypeCode: type, reasonCode: type === '07' ? '01' : '02', reasonDescription: 'Ajuste QA',
    ...(type === '08' ? { lines: [{ originalLineNumber: 1, quantity: '1', unitPriceWithTax: '1.18' }] } : {}) });
  it.each(['07', '08'] as const)('nota %s antigua o de original Contado sigue funcionando', type => {
    for (const paymentTerms of [undefined, { type: 'CONTADO' } as const]) {
      const original = invoice(); if (paymentTerms) original.paymentTerms = paymentTerms;
      const note = buildNoteQaSnapshot(original, noteInput(type), identity);
      validateNoteQaSnapshot(note, original);
      expect(buildNoteQaUbl(note, original)).toContain(type === '07' ? '<CreditNote ' : '<DebitNote ');
      expect(buildNoteQaUbl(note, original)).not.toContain('PaymentTerms');
    }
  });
  it.each(['07', '08'] as const)('nota %s de original crédito falla cerrado sin fabricar nuevo saldo', type => {
    const original = creditInvoice(), before = structuredClone(original);
    expect(() => validateLocalInvoice(original)).toThrow('notas QA no implementan actualización');
    expect(() => buildNoteQaSnapshot(original, noteInput(type), identity)).toThrow('notas QA no implementan actualización');
    const legacyOriginal = invoice(), note = buildNoteQaSnapshot(legacyOriginal, noteInput(type), identity);
    note.paymentTerms = structuredClone(original.paymentTerms);
    expect(() => validateNoteQaSnapshot(note, original)).toThrow('notas QA no implementan actualización');
    expect(() => buildNoteQaUbl(note, original)).toThrow('notas QA no implementan actualización');
    expect(() => validateNoteQaSnapshot(note, legacyOriginal)).toThrow('La nota no coincide');
    expect(original).toEqual(before);
  });
});
