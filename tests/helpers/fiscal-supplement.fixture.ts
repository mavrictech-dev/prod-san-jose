import type { FiscalDocumentSnapshot } from '../../packages/contracts/src/events';
import { calculateDocumentTotals } from '../../packages/sunat-core/src/tax';
import { buildFiscalNoteSnapshot, fiscalSnapshotSha256, type FiscalNoteContext, type FiscalAcceptanceEvidence } from '../../packages/sunat-core/src/fiscal-note';
import { buildFiscalBatchSnapshot } from '../../packages/sunat-core/src/fiscal-batch';
import { buildFiscalSupplementCommand } from '../../packages/sunat-core/src/fiscal-supplement-command';
export const supplementUuid = (n: number) => `abcdefab-0000-4000-8000-${String(n).padStart(12, '0')}`;
const asOf = '2026-10-03T18:00:00Z';
/** Invented snapshots/public-format RUC only. No stored business data, certificate or official CDR. */
export function supplementCommandFixture(kind: 'NOTE' | 'RC' | 'RA' = 'NOTE') {
  const doc: FiscalDocumentSnapshot = { documentId: supplementUuid(1), companyId: 99, branchId: supplementUuid(2), environment: 'BETA',
    documentTypeCode: kind === 'RC' ? '03' : '01', series: kind === 'RC' ? 'BQ01' : 'FQ01', number: '1',
    fullNumber: kind === 'RC' ? 'BQ01-1' : 'FQ01-1', issueDate: '2026-10-02T16:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
    ...(kind === 'RC' ? {} : { paymentTerms: { type: 'CONTADO' as const } }),
    issuer: { identityType: '6', identityNumber: '20100070970', legalName: 'EMISOR SINTETICO', address: 'DIRECCION INVENTADA', ubigeo: '150101', establishmentCode: '0000' },
    customer: { identityType: '6', identityNumber: '20131312955', legalName: 'CLIENTE SINTETICO' },
    ...calculateDocumentTotals([{ productCode: 'QA', description: 'BIEN FICTICIO', unitCode: 'NIU', quantity: '2', unitPriceWithTax: '118', taxAffectationCode: '10', igvRate: '18' }]),
  };
  const acceptance: FiscalAcceptanceEvidence = { environment: 'BETA', issuerRuc: doc.issuer.identityNumber, documentId: doc.documentId,
    documentTypeCode: doc.documentTypeCode as '01' | '03', fullNumber: doc.fullNumber, snapshotSha256: fiscalSnapshotSha256(doc),
    cdrSha256: 'a'.repeat(64), status: 'ACCEPTED', responseCode: '0', acceptedAt: '2026-10-02T16:10:00Z',
    source: kind === 'RC' ? { kind: 'CDR_SUMMARY', identifier: 'RC-20261002-1', referenceDate: '2026-10-02', lineNumber: 1, conditionCode: '1' } : { kind: 'CDR_DOCUMENT' } };
  const context: FiscalNoteContext = { original: doc, acceptance, asOf, creditHistory: { complete: true, entries: [] } };
  const note = buildFiscalNoteSnapshot(context, { documentTypeCode: '07', reasonCode: '07', reasonDescription: 'DEVOLUCION SINTETICA', lines: [{ originalLineNumber: 1, quantity: '1' }] },
    { documentId: supplementUuid(3), series: kind === 'RC' ? 'BC01' : 'FC01', number: '1', issueDate: '2026-10-02T17:00:00Z' });
  const batch = kind === 'NOTE' ? undefined : buildFiscalBatchSnapshot(kind === 'RC' ? { kind: 'RC', entries: [{ conditionCode: '1', document: { snapshot: doc } }] }
    : { kind: 'RA', entries: [{ document: { snapshot: doc }, acceptance,
      notDelivered: { status: 'NOT_DELIVERED', documentId: doc.documentId, documentTypeCode: '01', fullNumber: doc.fullNumber,
        issuerRuc: doc.issuer.identityNumber, snapshotSha256: fiscalSnapshotSha256(doc), evidenceId: supplementUuid(6), assertedAt: '2026-10-03T16:00:00Z' }, reasonDescription: 'SUSTENTO SINTETICO' }] },
    { documentId: supplementUuid(4), identifier: `${kind}-20261003-1`, issueDate: '2026-10-03', referenceDate: '2026-10-02' }, asOf);
  const envelope = kind === 'NOTE' ? { kind: 'NOTE' as const, note, context } : { kind: 'BATCH' as const, batch: batch!, asOf };
  const command = buildFiscalSupplementCommand(envelope, { eventId: supplementUuid(7), correlationId: supplementUuid(8), occurredAt: asOf });
  return { doc, acceptance, context, note, batch, envelope, command };
}
