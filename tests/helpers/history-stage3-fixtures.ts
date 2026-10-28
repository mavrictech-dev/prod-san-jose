import type { HistoryPreviewRow, NormalizedHistoryExport } from '../../migration/history-preview';

// Deliberately fictitious data, independent of databases and actual issuer setup.
export function historyRow(number = 1, overrides: Partial<HistoryPreviewRow> = {}): HistoryPreviewRow {
  return {
    issuerRuc: '00000000000', companyId: 999, type: '03', series: 'BQ01', number: String(number),
    issueDate: '2026-10-01T10:00:00-05:00', currencyCode: 'PEN', originId: `FICTICIO-${number}`,
    amounts: { taxableAmount: '1.00', exemptAmount: '0.00', unaffectedAmount: '0.00', freeAmount: '0.00',
      discountTotal: '0.00', igvAmount: '0.18', iscAmount: '0.00', otherTaxesAmount: '0.00', payableAmount: '1.18' },
    tax: [{ taxSchemeId: '1000', taxName: 'IGV', taxableAmount: '1.00', taxAmount: '0.18' }],
    artifacts: [{ kind: 'CDR_XML', originalName: 'ficticio.xml', sizeBytes: 123, sha256: 'a'.repeat(64) }],
    ownIssuerMapping: { issuerRuc: '00000000000', companyId: 999, type: '03', series: 'BQ01',
      branchId: '90000000-0000-4000-8000-000000000001', emissionPointId: '90000000-0000-4000-8000-000000000002',
      seriesCounterId: '90000000-0000-4000-8000-000000000003' }, ...overrides,
  };
}
export function historyExport(rows: readonly HistoryPreviewRow[] = [historyRow()]): NormalizedHistoryExport {
  return { schemaVersion: 'factuez.history-normalized.v1', environment: 'BETA', originSystem: 'RESTOAPP', rows };
}
export const cloneHistory = <T>(value: T): T => JSON.parse(JSON.stringify(value));
