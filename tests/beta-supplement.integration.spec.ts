import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { buildFiscalNoteSnapshot, fiscalSnapshotSha256, type FiscalAcceptanceEvidence, type FiscalNoteContext } from '../packages/sunat-core/src/fiscal-note';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src';
import { BetaSupplementService } from '../services/sunat-service/src/application/beta-supplement.service';

const verification = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../services/sunat-service/src/application/beta-summary-acceptance', () => ({ verifyBetaSummaryAcceptance: verification.verify }));
const asOf = '2026-10-03T18:00:00Z';
function original(type: '01' | '03' = '03'): FiscalDocumentSnapshot {
  return { documentId: randomUUID(), companyId: 1, environment: 'BETA', documentTypeCode: type,
    series: type === '01' ? 'F001' : 'B001', number: '1', fullNumber: `${type === '01' ? 'F001' : 'B001'}-1`,
    issueDate: '2026-10-02T18:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
    ...(type === '01' ? { paymentTerms: { type: 'CONTADO' as const } } : {}),
    issuer: { identityType: '6', identityNumber: '20615878481', legalName: 'EMISOR SINTETICO', address: 'DIRECCION SINTETICA QA', ubigeo: '150101', establishmentCode: '0000' },
    customer: { identityType: '6', identityNumber: '20615878481', legalName: 'CLIENTE SINTETICO' },
    ...calculateDocumentTotals([{ description: 'FIXTURE', unitCode: 'NIU', quantity: '1', unitPriceWithTax: '1.18', igvRate: '18', taxAffectationCode: '10' }]) };
}
function evidence(doc: FiscalDocumentSnapshot): FiscalAcceptanceEvidence {
  return { environment: 'BETA', issuerRuc: doc.issuer.identityNumber, documentId: doc.documentId,
    documentTypeCode: doc.documentTypeCode as '01' | '03', fullNumber: doc.fullNumber,
    snapshotSha256: fiscalSnapshotSha256(doc), cdrSha256: 'a'.repeat(64), status: 'ACCEPTED', responseCode: '0', acceptedAt: '2026-10-02T18:10:00Z',
    source: doc.documentTypeCode === '01' ? { kind: 'CDR_DOCUMENT' } : { kind: 'CDR_SUMMARY', identifier: 'RC-20261002-1', referenceDate: '2026-10-02', lineNumber: 1, conditionCode: '1' } };
}
function service(doc: FiscalDocumentSnapshot) {
  const prisma = { fiscalDocument: { findFirst: vi.fn(async () => ({ immutablePayload: structuredClone(doc), status: 'QUEUED' })) },
    fiscalBatch: { findMany: vi.fn(async () => []) }, sunatSubmission: { findFirst: vi.fn() }, sunatCredentials: { findUnique: vi.fn() } };
  const repository = { stage: vi.fn(), load: vi.fn(), claim: vi.fn() }, vault = { open: vi.fn() };
  const value = new BetaSupplementService(prisma as never, repository as never, {} as never, vault as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { prisma, repository, vault, value, internal: value as unknown as {
    acceptance(doc: FiscalDocumentSnapshot, evidence: FiscalAcceptanceEvidence, asOf: string): Promise<unknown>;
  } };
}
describe('Wiring de suplementos Beta: sólo puertos sintéticos, sin red/DB/claves', () => {
  it('RC exige verificador de miembro y devuelve proof para cercarlo al reservar', async () => {
    const doc = original(), ev = evidence(doc), f = service(doc), proof = { identifier: 'RC-20261002-1', issuerRuc: doc.issuer.identityNumber, acceptedAt: ev.acceptedAt };
    verification.verify.mockResolvedValueOnce(proof);
    expect(await f.internal.acceptance(doc, ev, asOf)).toBe(proof);
    expect(verification.verify).toHaveBeenLastCalledWith(doc, ev, asOf, expect.objectContaining({ loadBatch: expect.any(Function), readCdr: expect.any(Function), verifySignature: expect.any(Function) }));
    expect(f.prisma.fiscalBatch.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ issuerRuc: doc.issuer.identityNumber, environment: 'BETA' }) }));
    expect(f.vault.open).not.toHaveBeenCalled();
  });
  it('CDR global no sustituye prueba de pertenencia/versión', async () => {
    const doc = original(), f = service(doc);
    verification.verify.mockRejectedValueOnce(new Error('MEMBER_VERSION_MISMATCH'));
    await expect(f.internal.acceptance(doc, evidence(doc), asOf)).rejects.toThrow('MEMBER_VERSION_MISMATCH');
    expect(f.repository.stage).not.toHaveBeenCalled(); expect(f.vault.open).not.toHaveBeenCalled();
  });
  it('rechaza otra versión/baja posterior y un historial truncado', async () => {
    const doc = original(), ev = evidence(doc), f = service(doc), proof = { identifier: 'RC-20261002-1', issuerRuc: doc.issuer.identityNumber, acceptedAt: ev.acceptedAt };
    verification.verify.mockResolvedValue(proof);
    f.prisma.fiscalBatch.findMany.mockResolvedValueOnce([{ id: randomUUID(), identifier: 'RC-20261002-2', immutablePayload: { input: { entries: [{ document: { snapshot: doc }, conditionCode: '3' }] } } }] as never);
    f.prisma.sunatSubmission.findFirst.mockResolvedValueOnce({ id: randomUUID() } as never);
    await expect(f.internal.acceptance(doc, ev, asOf)).rejects.toThrow('otra versión/baja RC');
    f.prisma.fiscalBatch.findMany.mockResolvedValueOnce(Array.from({ length: 201 }, () => ({})) as never);
    await expect(f.internal.acceptance(doc, ev, asOf)).rejects.toThrow('Historial RC');
  });
  it('identidad cambiada o documento de otro RUC nunca llegan al verificador', async () => {
    const doc = original(), f = service(doc), changed = { ...doc, customer: { ...doc.customer, legalName: 'OTRO CLIENTE' } };
    await expect(f.internal.acceptance(changed, evidence(changed), asOf)).rejects.toThrow('Identidad de versión RC');
    f.prisma.fiscalDocument.findFirst.mockResolvedValueOnce(null as never);
    await expect(f.internal.acceptance(doc, evidence(doc), asOf)).rejects.toThrow('copia propia');
  });
  it('gate de activación sigue cerrado antes de reserva, consultas o descifrado', async () => {
    const doc = original('01'), f = service(doc), context: FiscalNoteContext = { original: doc, acceptance: evidence(doc), asOf, creditHistory: { complete: true, entries: [] } };
    const note = buildFiscalNoteSnapshot(context, { documentTypeCode: '07', reasonCode: '01', reasonDescription: 'ANULACION FIXTURE' }, { documentId: randomUUID(), series: 'FC01', number: '1', issueDate: '2026-10-03T17:00:00Z' });
    await expect(f.value.stage({ kind: 'NOTE', note, context }, randomUUID(), randomUUID())).rejects.toThrow('Emisión oficial bloqueada');
    expect(f.repository.stage).not.toHaveBeenCalled(); expect(f.prisma.fiscalDocument.findFirst).not.toHaveBeenCalled(); expect(f.vault.open).not.toHaveBeenCalled();
  });
});
