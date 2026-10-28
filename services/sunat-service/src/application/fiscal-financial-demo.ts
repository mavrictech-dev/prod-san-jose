import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { calculateDocumentTotals } from '@factuez/sunat-core';
import { buildFiscalNoteSnapshot, fiscalSnapshotSha256, type FiscalNoteContext } from '@factuez/sunat-core/dist/fiscal-note';
import { projectFiscalFinancialLedger, type FiscalFinancialLedgerInput, type FiscalLedgerEntry } from '@factuez/sunat-core/dist/fiscal-financial-ledger';

export const FINANCIAL_DEMO_SCENARIOS = ['CREDIT_ACCEPTED', 'DEBIT_ACCEPTED', 'RC_REPLACE', 'VOID', 'CDR_UNVERIFIED', 'REJECTED', 'REPLAY', 'STALE_VERSION'] as const;
type Scenario = typeof FINANCIAL_DEMO_SCENARIOS[number];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Fixed synthetic workbench. No input IDs, company lookups, secrets, clock, DB or network.
 * RUC only satisfies structural checksum; it is NOT a registered/configured issuer here.
 */
export function financialDemo(scenario: Scenario) {
  if (!FINANCIAL_DEMO_SCENARIOS.includes(scenario)) throw new Error('Escenario de laboratorio inválido');
  const receipt = scenario === 'RC_REPLACE';
  const scope = { environment: 'BETA' as const, issuerRuc: '20999999990', companyId: 999, branchId: id(2) };
  const line = { productCode: 'FICTICIO', description: 'BIEN FICTICIO DE LABORATORIO', unitCode: 'NIU', quantity: '2', unitPriceWithTax: '118', taxAffectationCode: '10', igvRate: '18' };
  const document: FiscalDocumentSnapshot = { environment: 'BETA', companyId: scope.companyId, branchId: scope.branchId,
    documentId: id(1), documentTypeCode: receipt ? '03' : '01', series: receipt ? 'BQ01' : 'FQ01', number: '1', fullNumber: receipt ? 'BQ01-1' : 'FQ01-1',
    issueDate: '2026-10-02T16:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101', ...(receipt ? {} : { paymentTerms: { type: 'CONTADO' as const } }),
    issuer: { identityType: '6', identityNumber: scope.issuerRuc, legalName: 'EMISOR FICTICIO · NO FISCAL', address: 'DIRECCION INVENTADA DE LABORATORIO', ubigeo: '150101', establishmentCode: '0000' },
    customer: { identityType: '6', identityNumber: scope.issuerRuc, legalName: 'CLIENTE FICTICIO' }, ...calculateDocumentTotals([line]) };
  const input: FiscalFinancialLedgerInput = { scope, documents: [document], entries: [] };
  const initial = projectFiscalFinancialLedger(input);
  if (!initial.ok) throw new Error('Base ficticia inconsistente');
  const context: FiscalNoteContext = { original: document, asOf: '2026-10-03T18:00:00Z', creditHistory: { complete: true, entries: [] },
    acceptance: { environment: 'BETA', issuerRuc: scope.issuerRuc, documentId: document.documentId, documentTypeCode: document.documentTypeCode as '01' | '03',
      fullNumber: document.fullNumber, snapshotSha256: fiscalSnapshotSha256(document), cdrSha256: 'a'.repeat(64), status: 'ACCEPTED', responseCode: '0',
      acceptedAt: '2026-10-02T16:10:00Z', source: receipt ? { kind: 'CDR_SUMMARY', identifier: 'RC-20261002-1', referenceDate: '2026-10-02', lineNumber: 1, conditionCode: '1' } : { kind: 'CDR_DOCUMENT' } } };
  const base = { ...scope, eventId: id(7), operationId: id(8), documentId: document.documentId, sequence: 1,
    expectedPreviousSha256: initial.documents[0].currentVersion.sha256,
    evidence: { status: scenario === 'REJECTED' ? 'REJECTED' as const : 'ACCEPTED' as const, cdrSignatureVerified: scenario !== 'CDR_UNVERIFIED', officialCdr: scenario !== 'CDR_UNVERIFIED',
      cdrSha256: 'b'.repeat(64), requestSha256: 'c'.repeat(64), responseCode: scenario === 'REJECTED' ? '2335' : '0', acceptedAt: context.asOf } };
  let entry: FiscalLedgerEntry;
  if (scenario === 'RC_REPLACE') entry = { ...base, kind: 'RC_REPLACE', nextSnapshot: { ...document, ...calculateDocumentTotals([{ ...line, unitPriceWithTax: '59' }]) } };
  else if (scenario === 'VOID') entry = { ...base, kind: 'VOID', nextSnapshot: document, notDelivered: {
    status: 'NOT_DELIVERED', documentId: document.documentId, documentTypeCode: '01', fullNumber: document.fullNumber, issuerRuc: scope.issuerRuc,
    snapshotSha256: fiscalSnapshotSha256(document), evidenceId: id(9), assertedAt: '2026-10-03T16:00:00Z' } };
  else {
    const debit = scenario === 'DEBIT_ACCEPTED';
    const note = buildFiscalNoteSnapshot(context, debit ? { documentTypeCode: '08', reasonCode: '02', reasonDescription: 'AJUSTE FICTICIO', lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '11.8' }] }
      : { documentTypeCode: '07', reasonCode: '07', reasonDescription: 'DEVOLUCION FICTICIA', lines: [{ originalLineNumber: 1, quantity: '1' }] },
      { documentId: id(3), series: 'FC01', number: '1', issueDate: '2026-10-02T17:00:00Z' });
    entry = { ...base, kind: debit ? 'NOTE_DEBIT' : 'NOTE_CREDIT', nextSnapshot: note, noteContext: context };
  }
  if (scenario === 'STALE_VERSION') entry.expectedPreviousSha256 = 'd'.repeat(64);
  const projection = projectFiscalFinancialLedger({ ...input, entries: scenario === 'REPLAY' ? [entry, structuredClone(entry)] : [entry] });
  return { profile: 'FINANCIAL_DEMO_BETA_V1' as const, scenario, localOnly: true as const, simulationOnly: true as const,
    source: 'FIXED_SYNTHETIC_FIXTURE' as const, fiscalWrites: 0 as const, certificateAccess: false as const, transmissionAuthorized: false as const,
    evidenceAuthenticityVerified: false as const, originalPayableAmount: document.totals.payableAmount,
    originalPreserved: fiscalSnapshotSha256(document) === initial.documents[0].originalSha256,
    result: projection.ok ? { ok: true as const, currentVersion: projection.documents[0].currentVersion,
      financialPayableAmount: projection.documents[0].financialSnapshot.totals.payableAmount, outcomes: projection.entries.map(e => e.outcome),
      versionCount: projection.documents[0].versions.length } : { ok: false as const, code: projection.error.code },
    notice: 'Datos y CDR ficticios. Los efectos son sólo simulados; no verifica confianza PKI, no registra cambios ni habilita emisión fiscal.' };
}
