import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReceiptSummary, buildReceiptSummarySnapshot, calculateDocumentTotals, fiscalSnapshotSha256 } from '../packages/sunat-core/src';
import { buildFiscalBatchUbl } from '../packages/sunat-core/src/fiscal-batch';
import { BetaIssuanceRepository } from '../services/sunat-service/src/application/beta-issuance.repository';
import type { BetaDispatchRow } from '../services/sunat-service/src/application/beta-dispatch-pipeline';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src';
const now = '2026-10-03T12:00:00Z';
function doc(): FiscalDocumentSnapshot {
  return { documentId: randomUUID(), companyId: 1, documentTypeCode: '03', environment: 'BETA', series: 'B001', number: '1', fullNumber: 'B001-1',
    issueDate: '2026-10-02T12:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
    issuer: { identityType: '6', identityNumber: '20615878481', legalName: 'EMISOR QA FICTICIO', address: 'DIRECCION QA FICTICIA', ubigeo: '150101', establishmentCode: '0000' },
    customer: { identityType: '0', identityNumber: '0', legalName: 'CLIENTE QA FICTICIO' },
    ...calculateDocumentTotals([{ description: 'TEST', quantity: '1', unitCode: 'NIU', unitPriceWithTax: '1.18', igvRate: '18', taxAffectationCode: '10' }]) };
}
afterEach(() => vi.useRealTimers());
describe('RC inicial y archivo propio, sin DB/secretos/red', () => {
  it('conserva snapshot/ID técnico distinto y el mismo cuerpo del builder múltiple', () => {
    vi.setSystemTime(now); const snapshot = doc(), before = structuredClone(snapshot), identifier = 'RC-20261003-1';
    const batch = buildReceiptSummarySnapshot(snapshot, identifier, now);
    expect(batch.documentId).not.toBe(snapshot.documentId); expect(batch.input.entries[0]).toEqual({ conditionCode: '1', document: { snapshot } });
    expect(buildReceiptSummarySnapshot(snapshot, identifier, now)).toEqual(batch);
    expect(buildReceiptSummary(snapshot, identifier, 'REAL_PREPARATION')).toBe(buildFiscalBatchUbl(batch, now));
    expect(snapshot).toEqual(before);
  });
  it('reserva y enlaza el RC normal sin consumir contadores de Billing', async () => {
    vi.setSystemTime(now); const snapshot = doc(), id = randomUUID(), eventId = randomUUID(), batchId = randomUUID();
    const tx = { $executeRawUnsafe: vi.fn(), $queryRawUnsafe: vi.fn(async () => [{ maximum: null }]),
      fiscalBatch: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ id: batchId })) },
      sunatSubmission: { findUniqueOrThrow: vi.fn(async () => ({ errorMessage: JSON.stringify({ version: 1, eventId, correlationId: randomUUID() }) })), update: vi.fn() } };
    const repository = new BetaIssuanceRepository({ $transaction: (run: (tx: unknown) => unknown) => run(tx) } as never);
    const row = { id, documentId: snapshot.documentId, snapshot } as BetaDispatchRow;
    expect(await repository.reserveSummary(row)).toBe('RC-20261003-1');
    const stored = tx.fiscalBatch.create.mock.calls[0][0].data;
    expect(stored.immutablePayload).toEqual(buildReceiptSummarySnapshot(snapshot, 'RC-20261003-1', now));
    expect(stored.summaryId).toBe(snapshot.documentId);
    expect(tx.sunatSubmission.update).toHaveBeenCalledWith({ where: { id }, data: { batchId } });
    expect(tx.$executeRawUnsafe.mock.calls.map(c => c[1])).toEqual(['20615878481:BETA:supplement', '20615878481:BETA:RC']);
  });
  it('reutiliza evidencia idéntica y bloquea un RC legado sin sobrescribirlo', async () => {
    vi.setSystemTime(now); const snapshot = doc(), batchId = randomUUID(), row = { id: randomUUID(), documentId: snapshot.documentId, snapshot } as BetaDispatchRow;
    const batch = { id: batchId, issuerRuc: snapshot.issuer.identityNumber, environment: 'BETA', identifier: 'RC-20261003-1', immutablePayload: buildReceiptSummarySnapshot(snapshot, 'RC-20261003-1', now) };
    const tx = { $executeRawUnsafe: vi.fn(), fiscalBatch: { findUnique: vi.fn(async () => batch), create: vi.fn() }, sunatSubmission: { findUniqueOrThrow: vi.fn(async () => ({ batchId })), update: vi.fn() } };
    const repository = new BetaIssuanceRepository({ $transaction: (run: (tx: unknown) => unknown) => run(tx) } as never);
    expect(await repository.reserveSummary(row)).toBe(batch.identifier);
    batch.immutablePayload = snapshot as never;
    await expect(repository.reserveSummary(row)).rejects.toThrow('legado o inconsistente');
    expect(tx.fiscalBatch.create).not.toHaveBeenCalled(); expect(tx.sunatSubmission.update).not.toHaveBeenCalled();
  });
  it('proyecta el CDR confiable al documento y RC con la misma fecha, nunca con CDR no confiable', async () => {
    vi.setSystemTime(now); const snapshot = doc(), row = { id: randomUUID(), documentId: snapshot.documentId, snapshot, attempt: 1, owner: new Date(now), phase: 'SENDING' } as BetaDispatchRow;
    const tx = { sunatSubmission: { findUniqueOrThrow: vi.fn(async () => ({ batchId: 'batch-id', errorMessage: JSON.stringify({ version: 1, eventId: randomUUID(), correlationId: randomUUID() }) })), updateMany: vi.fn(async () => ({ count: 1 })) },
      fiscalDocument: { update: vi.fn() }, fiscalBatch: { update: vi.fn() }, outboxEvent: { create: vi.fn() } };
    const repository = new BetaIssuanceRepository({ $transaction: (run: (tx: unknown) => unknown) => run(tx) } as never);
    const cdr = { trusted: true, status: 'ACCEPTED' as const, code: '0', description: 'FIXTURE', notes: [] };
    expect(await repository.transition(row, 'SENDING', 'DONE', { cdr })).toBe(true);
    expect(tx.fiscalBatch.update).toHaveBeenCalledWith({ where: { id: 'batch-id' }, data: { status: 'ACCEPTED' } });
    expect(tx.fiscalDocument.update.mock.calls[0][0].data.acceptedAt).toEqual(tx.sunatSubmission.updateMany.mock.calls[0][0].data.completedAt);
    await expect(repository.transition(row, 'SENDING', 'DONE', { cdr: { ...cdr, trusted: false } })).rejects.toThrow('CDR confiable');
  });
  it('la PWA importa la entrada de reglas apta para navegador, no crypto de Node', () => {
    const source = readFileSync(new URL('../apps/web-pwa/features/workspace/payment-input.ts', import.meta.url), 'utf8');
    expect(source).toContain("from '@factuez/sunat-core/dist/fiscal-rules'");
    expect(source).not.toMatch(/from\s+['"]@factuez\/sunat-core['"]/);
    expect(fiscalSnapshotSha256({ local: true })).toMatch(/^[a-f0-9]{64}$/);
  });
});
