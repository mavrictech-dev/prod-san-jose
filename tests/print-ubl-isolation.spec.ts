import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildInvoiceUbl } from '../packages/sunat-core/src/ubl';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { validateInvoiceSupportedFields } from '../packages/sunat-core/src/fiscal-rules';
import { buildNoteQaSnapshot } from '../packages/sunat-core/src/notes-qa';
import { buildNoteQaUbl } from '../packages/sunat-core/src/notes-ubl';
import { buildGreQaUbl, GRE_QA_PROFILE, type GreQaSnapshot } from '../packages/sunat-core/src/gre-ubl';
import { DEFAULT_PRINT_BRANDING, type FiscalDocumentSnapshot, type FrozenPrintPresentationV1 } from '../packages/contracts/src';

const branchId = '10000000-0000-4000-8000-000000000001';
function sale(): FiscalDocumentSnapshot {
  return { companyId: 1, branchId, documentId: '20000000-0000-4000-8000-000000000001', environment: 'BETA',
    documentTypeCode: '01', series: 'FQ00', number: '1', fullNumber: 'FQ00-1', issueDate: '2026-10-01T15:30:00Z',
    currencyCode: 'PEN', operationTypeCode: '0101', paymentTerms: { type: 'CONTADO' },
    issuer: { identityType: '6', identityNumber: '00000000000', legalName: 'EMISOR FICTICIO QA', address: 'Dirección ficticia', ubigeo: '150101', establishmentCode: '0001' },
    customer: { identityType: '6', identityNumber: '00000000001', legalName: 'CLIENTE FICTICIO QA' },
    ...calculateDocumentTotals([{ description: 'PRODUCTO FICTICIO', quantity: '2.500000', unitCode: 'GLL', unitPriceWithTax: '18.50', taxAffectationCode: '10', igvRate: '18' }]) };
}
function presentation(): FrozenPrintPresentationV1 {
  return { version: 'factuez.print-presentation.v1', issuerRuc: '00000000000', branchId, profileRevision: 2,
    settings: { ...DEFAULT_PRINT_BRANDING, footerNote: 'Texto comercial ficticio' }, logo: null,
    branchName: 'SEDE FICTICIA', branchAddress: 'Dirección de sede ficticia' };
}
describe('aislamiento XML de presentación visual', () => {
  it.each(['LOCAL_DEVELOPMENT', 'REAL_PREPARATION'] as const)('01/03 no modifican el XML ni su SHA con logos en %s', mode => {
    for (const code of ['01', '03'] as const) {
      const original = sale(); original.documentTypeCode = code;
      if (code === '03') { original.series = 'BQ00'; original.fullNumber = 'BQ00-1'; }
      const before = buildInvoiceUbl(original, { mode });
      const after = buildInvoiceUbl({ ...original, printPresentation: presentation(), printOperation: { vehiclePlate: 'QA-000', shiftLabel: 'TURNO FICTICIO' } }, { mode });
      expect(after).toBe(before);
      expect(createHash('sha256').update(after).digest('hex')).toBe(createHash('sha256').update(before).digest('hex'));
      expect(after).not.toContain('Texto comercial ficticio');
    }
  });
  it('congela la presentación de la nota sin introducirla en CreditNote', () => {
    const original = sale(), printed = { ...original, printPresentation: presentation() };
    const input = { idempotencyKey: '30000000-0000-4000-8000-000000000001', documentTypeCode: '07', reasonCode: '01', reasonDescription: 'Anulación ficticia' };
    const identity = { documentId: input.idempotencyKey, number: '1', issueDate: '2026-10-02T15:30:00Z' };
    const before = buildNoteQaSnapshot(original, input, identity), after = buildNoteQaSnapshot(printed, input, identity);
    expect(after.printPresentation).toEqual(printed.printPresentation);
    expect(after.printPresentation).not.toBe(printed.printPresentation);
    expect(buildNoteQaUbl(after, printed)).toBe(buildNoteQaUbl(before, original));
  });
  it('GRE conserva el DespatchAdvice exacto y guards de motivo 04', () => {
    const gre: GreQaSnapshot = { companyId: 1, id: '40000000-0000-4000-8000-000000000001', localIdentifier: 'GRE-QA-40000000-0000-4000-8000-000000000001', ublNumber: 'TQ00-1',
      issueDate: '2026-10-01', issueTime: '10:30:00', transferDate: '2026-10-02', profile: GRE_QA_PROFILE, environment: 'BETA',
      issuer: { ruc: '00000000000', legalName: 'EMISOR FICTICIO' },
      origin: { branchId, address: 'Origen ficticio', ubigeo: '150101', establishmentCode: '0001' },
      destination: { branchId: '10000000-0000-4000-8000-000000000002', address: 'Destino ficticio', ubigeo: '150102', establishmentCode: '0002' },
      reasonCode: '04', nonRegulatedGoods: true, grossWeight: '1.000', weightUnit: 'KGM',
      transport: { mode: '02', plate: 'QA0001', driverDni: '00000000', driverFirstName: 'FICTICIO', driverLastName: 'QA', driverLicense: 'QA0001' },
      items: [{ code: 'QA', description: 'BIEN FICTICIO NO REGULADO', quantity: '1', unitCode: 'NIU' }] };
    expect(buildGreQaUbl({ ...gre, branchId, printPresentation: presentation() })).toBe(buildGreQaUbl(gre));
    expect(() => buildGreQaUbl({ ...gre, reasonCode: '01' } as never)).toThrow();
  });
  it.each([
    { printOperation: { certificate: 'NO' } }, { printOperation: { observations: 'x'.repeat(1001) } },
    { printPresentation: { ...presentation(), issuerRuc: '00000000001' } },
    { printPresentation: { ...presentation(), branchId: null } },
    { printPresentation: { ...presentation(), settings: { ...DEFAULT_PRINT_BRANDING, logoMode: ['DEFAULT'] } } },
    { printPresentation: { ...presentation(), logo: { mediaType: 'image/png', url: 'https://invalid.example/logo.png' } } },
  ])('rechaza metadata visual corrupta sin relajar el perfil: %j', patch => {
    expect(validateInvoiceSupportedFields({ ...sale(), ...patch }).some(issue => issue.code === 'PRINT_METADATA_INVALID')).toBe(true);
  });
  it('los campos fiscales adicionales siguen bloqueados', () => {
    expect(() => buildInvoiceUbl({ ...sale(), printPresentation: presentation(), advanceAmount: '1.00' } as never)).toThrow('UNSUPPORTED_FIELDS');
  });
});
