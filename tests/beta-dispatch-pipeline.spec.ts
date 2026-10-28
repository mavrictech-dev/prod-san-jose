import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BetaDispatchPipeline, type BetaDispatchPorts, type BetaDispatchRow, type BetaPhase } from '../services/sunat-service/src/application/beta-dispatch-pipeline';
import { BetaIssuanceRepository } from '../services/sunat-service/src/application/beta-issuance.repository';
import { BetaIssuanceService } from '../services/sunat-service/src/application/beta-issuance.service';
import { LocalPreparationUnavailableError } from '../services/sunat-service/src/application/local-preparation-policy';
import { EventNames, assertBetaStatusProjection, type BetaStatusEvent, type FiscalDocumentSnapshot } from '../packages/contracts/src';
import { SunatStatusConsumer } from '../services/billing-service/src/infrastructure/sunat-status.consumer';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { buildReceiptSummary } from '../packages/sunat-core/src/receipt-summary-ubl';
const id = randomUUID(), ruc = '20615878481';
function snapshot(type: '01' | '03' = '01'): FiscalDocumentSnapshot {
  return { documentId: id, companyId: 1, environment: 'BETA', documentTypeCode: type,
    series: type === '01' ? 'F001' : 'B001', number: '1', fullNumber: `${type === '01' ? 'F001' : 'B001'}-1`,
    issueDate: '2026-10-01T18:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
    issuer: { identityType: '6', identityNumber: ruc, legalName: 'FIXTURE NO COMERCIAL', address: 'DIRECCION FICTICIA DE PRUEBA', ubigeo: '150101', establishmentCode: '0000' },
    customer: { identityType: '6', identityNumber: ruc, legalName: 'FIXTURE SIN DATOS DEL CLIENTE' }, paymentTerms: { type: 'CONTADO' },
    ...calculateDocumentTotals([{ description: 'PRUEBA', quantity: '1', unitCode: 'NIU', unitPriceWithTax: '1.18', igvRate: '18', taxAffectationCode: '10' }]) };
}
function fixture(type: '01' | '03' = '01', initial: BetaPhase = 'AWAITING_AUTHORIZATION') {
  const row: BetaDispatchRow = { id: randomUUID(), documentId: id, phase: initial, attempt: 1, owner: new Date(), snapshot: snapshot(type), ticket: initial === 'WAITING_TICKET' ? 'TICKET_FIXTURE_1' : null };
  const zip = Buffer.from('PK-LOCAL-MOCK'), prepared = { zip, sha256: createHash('sha256').update(zip).digest('hex'), fileName: `${ruc}-${type === '01' ? '01-F001-1' : 'RC-20261001-1'}.zip`, reference: type === '01' ? 'F001-1' : 'RC-20261001-1', revision: 1 };
  const ports = { authorize: vi.fn(async () => {}), claim: vi.fn(async (_input: BetaDispatchRow, phase: BetaPhase) => { row.phase = phase; return row; }),
    prepare: vi.fn(async () => prepared), archived: vi.fn(async () => prepared), savePrepared: vi.fn(async () => { row.phase = 'PREPARED'; return true; }),
    owns: vi.fn(async () => true), transition: vi.fn(async (_row: unknown, from: BetaPhase, to: BetaPhase, details?: { ticket?: string }) => {
      if (row.phase !== from) return false; row.phase = to; if (details?.ticket) row.ticket = details.ticket; return true;
    }), submit: vi.fn(async () => ({ kind: 'CDR' as const, cdrZip: Buffer.from('MOCK') })),
    getStatus: vi.fn(async () => ({ kind: 'CDR' as const, cdrZip: Buffer.from('MOCK') })),
    cdr: vi.fn(async () => ({ trusted: true, status: 'ACCEPTED' as const, code: '0', description: 'MOCK', notes: [] as string[] })) };
  return { row, ports, prepared, pipeline: new BetaDispatchPipeline(ports as BetaDispatchPorts) };
}
describe('Vertical Beta con puertos aislados: no llama a SUNAT', () => {
  it('firma/paquete -> claim de envío -> CDR -> cierre verificable de factura', async () => {
    const f = fixture(); await f.pipeline.run({ ...f.row }); expect(f.row.phase).toBe('DONE'); expect(f.ports.submit).toHaveBeenCalledOnce();
    expect(f.ports.authorize).toHaveBeenCalledTimes(2); expect(f.ports.getStatus).not.toHaveBeenCalled();
    expect(f.ports.transition.mock.calls.map(call => call[2])).toEqual(['SENDING', 'DONE']);
  });
  it('boleta: archiva ticket y consulta exactamente el mismo, no repite envío', async () => {
    const f = fixture('03'); f.ports.submit.mockResolvedValue({ kind: 'TICKET', ticket: 'TICKET_FIXTURE_1' } as never);
    await f.pipeline.run({ ...f.row }); expect(f.row.phase).toBe('WAITING_TICKET');
    await f.pipeline.run({ ...f.row }); expect(f.ports.submit).toHaveBeenCalledOnce(); expect(f.ports.getStatus).toHaveBeenCalledWith(f.row, 'TICKET_FIXTURE_1');
    expect(f.ports.archived).toHaveBeenCalledOnce(); expect(f.row.phase).toBe('DONE');
  });
  it('ocupación XSD antes del POST reintenta sólo preparación, sin otra emisión', async () => {
    const f = fixture(); f.ports.prepare.mockRejectedValueOnce(new LocalPreparationUnavailableError());
    await f.pipeline.run({ ...f.row }); expect(f.row.phase).toBe('RETRY_PREPARATION'); expect(f.ports.submit).not.toHaveBeenCalled();
    await f.pipeline.run({ ...f.row }); expect(f.row.phase).toBe('DONE'); expect(f.ports.submit).toHaveBeenCalledOnce();
  });
  it('preparación agota tres intentos; XML corrupto bloquea de inmediato', async () => {
    const f = fixture(); f.row.attempt = 3; f.ports.prepare.mockRejectedValue(new LocalPreparationUnavailableError());
    await f.pipeline.run({ ...f.row }); expect(f.row.phase).toBe('BLOCKED');
    const invalid = fixture(); invalid.ports.prepare.mockRejectedValue(new Error('XML')); await invalid.pipeline.run({ ...invalid.row });
    expect(invalid.row.phase).toBe('BLOCKED'); expect(invalid.ports.submit).not.toHaveBeenCalled();
  });
  it('respuesta perdida termina UNKNOWN y no permite ejecutar otro POST', async () => {
    const f = fixture(); f.ports.submit.mockRejectedValueOnce(new Error('lost'));
    await f.pipeline.run({ ...f.row }); expect(f.row.phase).toBe('UNKNOWN'); await f.pipeline.run({ ...f.row });
    expect(f.ports.submit).toHaveBeenCalledOnce();
  });
  it('CDR sin confianza se archiva como no verificado, no aceptado fiscal', async () => {
    const f = fixture(); f.ports.cdr.mockResolvedValue({ trusted: false, status: 'ACCEPTED', code: '0', description: 'NO TRUST', notes: [] });
    await f.pipeline.run({ ...f.row }); expect(f.row.phase).toBe('CDR_UNVERIFIED');
    expect(f.ports.transition).toHaveBeenLastCalledWith(f.row, 'SENDING', 'CDR_UNVERIFIED', expect.objectContaining({ code: 'CDR_SIGNATURE_UNVERIFIED' }));
  });
  it('permiso revocado antes de firma no consulta secretos ni hace claim', async () => {
    const f = fixture(); f.ports.authorize.mockRejectedValueOnce(new Error('closed'));
    await expect(f.pipeline.run({ ...f.row })).rejects.toThrow('closed'); expect(f.ports.claim).not.toHaveBeenCalled(); expect(f.ports.prepare).not.toHaveBeenCalled();
  });
  it('permiso revocado después de preparar no llega al POST', async () => {
    const f = fixture(); f.ports.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
    await f.pipeline.run({ ...f.row }); expect(f.row.phase).toBe('BLOCKED'); expect(f.ports.submit).not.toHaveBeenCalled();
  });
  it('worker sin lease no prepara ni publica envío', async () => {
    const f = fixture(); f.ports.owns.mockResolvedValue(false); await f.pipeline.run({ ...f.row });
    expect(f.ports.savePrepared).not.toHaveBeenCalled(); expect(f.ports.submit).not.toHaveBeenCalled();
  });
  it('paquete manipulado y producción rechazados antes del transporte', async () => {
    const f = fixture(); f.prepared.sha256 = '0'.repeat(64); await f.pipeline.run({ ...f.row }); expect(f.row.phase).toBe('BLOCKED');
    const prod = fixture(); prod.row.snapshot.environment = 'PRODUCTION'; await expect(prod.pipeline.run(prod.row)).rejects.toThrow('producción');
    expect(prod.ports.authorize).not.toHaveBeenCalled();
  });
  it('consulta en espera usa backoff acotado y no reenvía', async () => {
    const f = fixture('03', 'WAITING_TICKET'); f.ports.getStatus.mockResolvedValue({ kind: 'PROCESSING' } as never);
    await f.pipeline.run({ ...f.row }); expect(f.row.phase).toBe('WAITING_TICKET'); expect(f.ports.submit).not.toHaveBeenCalled();
    f.row.attempt = 20; await f.pipeline.run({ ...f.row }); expect(f.row.phase).toBe('UNKNOWN');
  });
});
describe('Wiring real bloqueado y staging idempotente', () => {
  it('stage reutiliza submission, sólo real BETA 01/03, sin secretos/correlativos', () => {
    const upsert = vi.fn(() => 'PRISMA_OPERATION'); const repository = new BetaIssuanceRepository({ sunatSubmission: { upsert } } as never);
    const event = { eventId: randomUUID(), eventName: EventNames.documentIssued, producer: 'billing-service', correlationId: randomUUID(), occurredAt: new Date().toISOString(), payload: snapshot() };
    expect(repository.stageOperation(event)).toBe('PRISMA_OPERATION'); expect(repository.stageOperation(event)).toBe('PRISMA_OPERATION');
    expect(upsert.mock.calls[0][0]).toMatchObject({ where: { idempotencyKey: `beta:${id}:v1` }, update: {}, create: { errorCode: 'AWAITING_AUTHORIZATION', result: 'PENDING' } });
    event.payload.environment = 'PRODUCTION'; expect(repository.stageOperation(event)).toBeNull();
    event.payload.environment = 'BETA'; event.payload.issuer.identityNumber = '00000000001'; expect(repository.stageOperation(event)).toBeNull();
    expect(upsert).toHaveBeenCalledTimes(2);
  });
  it('el servicio instalado conserva el gate incluso antes del claim/decrypt', async () => {
    const f = fixture(), repository = { load: vi.fn(async () => f.row), claim: vi.fn() }, vault = { open: vi.fn() };
    const service = new BetaIssuanceService({} as never, repository as never, {} as never, vault as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(service.process(f.row.id)).rejects.toThrow('Emisión oficial bloqueada'); expect(vault.open).not.toHaveBeenCalled(); expect(repository.claim).not.toHaveBeenCalled();
  });
  it('RC conserva RUC y calendario reales; nada de renombrar un fixture ficticio', () => {
    const doc = snapshot('03'); const xml = buildReceiptSummary(doc, 'RC-20261002-1', 'REAL_PREPARATION');
    expect(xml).toContain(ruc); expect(xml).not.toContain('00000000000'); expect(xml).toContain('2026-10-01');
    expect(() => buildReceiptSummary(doc, 'RC-20260230-1', 'REAL_PREPARATION')).toThrow();
    expect(() => buildReceiptSummary(doc, 'RC-20260930-1', 'REAL_PREPARATION')).toThrow();
  });
});
function statusEvent(status: BetaStatusEvent['payload']['status'] = 'ACCEPTED'): BetaStatusEvent {
  return { eventId: randomUUID(), eventName: EventNames.sunatStatusChanged, producer: 'sunat-service', occurredAt: new Date().toISOString(), correlationId: randomUUID(),
    payload: { documentId: id, status, evidence: { transport: 'SUNAT_BETA', environment: 'BETA', issuerRuc: ruc, submissionId: randomUUID(), officialCdr: true, cdrSignatureVerified: true } } };
}
describe('Proyección fiscal no confunde simulado con aceptado', () => {
  it('aceptación exige contexto y firma acreditada; rechaza legado/simulado/otro RUC', () => {
    const event = statusEvent(); expect(() => assertBetaStatusProjection(event, snapshot())).not.toThrow();
    delete event.payload.evidence; expect(() => assertBetaStatusProjection(event, snapshot())).toThrow('CDR');
    const wrong = statusEvent(); wrong.payload.evidence!.issuerRuc = '20450819230'; expect(() => assertBetaStatusProjection(wrong, snapshot())).toThrow('Contexto');
    const unverified = statusEvent(); unverified.payload.evidence!.cdrSignatureVerified = false; expect(() => assertBetaStatusProjection(unverified, snapshot())).toThrow('CDR');
    const simulated = statusEvent(); Object.assign(simulated.payload.evidence!, { transport: 'LOCAL_SIMULATION' }); expect(() => assertBetaStatusProjection(simulated, snapshot())).toThrow('Contexto');
  });
  it('progreso legacy local permite BUILDING pero nunca acepta sin evidencia', () => {
    const event = statusEvent('BUILDING'); delete event.payload.evidence; expect(() => assertBetaStatusProjection(event, snapshot())).not.toThrow();
  });
  it('Billing conserva aceptación final frente a progreso tardío', async () => {
    const tx = { document: { findUniqueOrThrow: vi.fn(async () => ({ id, sunatStatus: 'ACCEPTED', immutableSnapshot: snapshot() })), updateMany: vi.fn() }, inboxEvent: { create: vi.fn() } };
    const service = new SunatStatusConsumer({ inboxEvent: { findUnique: vi.fn() }, $transaction: (run: (value: typeof tx) => unknown) => run(tx) } as never);
    const event = statusEvent('BUILDING'); delete event.payload.evidence;
    await (service as unknown as { process(job: unknown): Promise<void> }).process({ data: event }); expect(tx.document.updateMany).not.toHaveBeenCalled(); expect(tx.inboxEvent.create).toHaveBeenCalledOnce();
  });
});
