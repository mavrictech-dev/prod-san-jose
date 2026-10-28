import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EventNames, assertBetaStatusProjection, assertProductionStatusProjection,
  type BetaStatusEvent, type FiscalDocumentSnapshot, type ProductionStatusEvent,
} from '../packages/contracts/src';
import { SunatStatusConsumer } from '../services/billing-service/src/infrastructure/sunat-status.consumer';

// In-memory contract claims only: no actual CDR, credentials, database, Redis or SUNAT.
const doubles = vi.hoisted(() => ({ changed: vi.fn(async (_id: string) => {}), close: vi.fn(async () => {}) }));
vi.mock('@factuez/service-access', () => ({ LivePublisher: class { changed = doubles.changed; close = doubles.close; } }));
vi.mock('../services/billing-service/src/infrastructure/prisma.service', () => ({ PrismaService: class {} }));
vi.mock('bullmq', () => ({ Worker: class { constructor() { throw new Error('RUNTIME_START_FORBIDDEN'); } } }));
const id = '50000000-0000-4000-8000-000000000991', ruc = '20615878481';
const finalStatuses = ['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'] as const;
const progressStatuses = ['QUEUED', 'BUILDING', 'SIGNED', 'SUBMITTED', 'RETRYABLE_ERROR', 'PERMANENT_ERROR'] as const;
function snapshot(environment: 'BETA' | 'PRODUCTION' = 'PRODUCTION'): FiscalDocumentSnapshot {
  return { documentId: id, companyId: 1, environment, documentTypeCode: '01', series: 'F001', number: '1', fullNumber: 'F001-1',
    issueDate: '2026-10-01T18:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101', paymentTerms: { type: 'CONTADO' },
    issuer: { identityType: '6', identityNumber: ruc, legalName: 'SYNTHETIC ISSUER', ubigeo: '150101', establishmentCode: '0000' },
    customer: { identityType: '6', identityNumber: ruc, legalName: 'SYNTHETIC CUSTOMER' }, lines: [],
    totals: { taxableAmount: '1.00', igvAmount: '0.18', payableAmount: '1.18' } };
}
function production(status: ProductionStatusEvent['payload']['status'] = 'ACCEPTED'): ProductionStatusEvent {
  return { eventId: randomUUID(), eventName: EventNames.sunatStatusChanged, producer: 'sunat-service',
    occurredAt: '2026-10-02T18:00:00Z', correlationId: randomUUID(), payload: {
      documentId: id, status, environment: 'PRODUCTION', provenance: 'SUNAT_PRODUCTION', documentTypeCode: '01',
      responseCode: status === 'REJECTED' ? '2335' : '0', description: 'SYNTHETIC VERIFIED CLAIM',
      evidence: { transport: 'SUNAT_PRODUCTION', environment: 'PRODUCTION', issuerRuc: ruc,
        submissionId: randomUUID(), officialCdr: true, cdrSignatureVerified: true },
    } };
}
function beta(status: BetaStatusEvent['payload']['status'] = 'ACCEPTED'): BetaStatusEvent {
  const event = production(status);
  return { ...event, payload: { documentId: id, status, responseCode: event.payload.responseCode, description: event.payload.description,
    evidence: { ...event.payload.evidence!, transport: 'SUNAT_BETA', environment: 'BETA' } } };
}
function fixture(environment: 'BETA' | 'PRODUCTION' = 'PRODUCTION', initial = 'PROCESSING') {
  const document = { id, sunatStatus: initial, immutableSnapshot: snapshot(environment) };
  const tx = { document: { findUniqueOrThrow: vi.fn(async () => document), updateMany: vi.fn(async () => ({ count: 1 })) },
    inboxEvent: { create: vi.fn(async () => ({})) } };
  const prisma = { inboxEvent: { findUnique: vi.fn(async (): Promise<unknown> => null) },
    $transaction: vi.fn(async (run: (value: typeof tx) => Promise<void>) => run(tx)) };
  const consumer = new SunatStatusConsumer(prisma as never);
  const process = (event: unknown) => (consumer as unknown as { process(job: { data: unknown }): Promise<void> }).process({ data: event });
  return { document, tx, prisma, consumer, process };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('NETWORK_FORBIDDEN'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('ProductionStatusEvent / assertProductionStatusProjection', () => {
  it.each(finalStatuses)('allows a fully contextualized signed official CDR claim for %s', status => {
    expect(() => assertProductionStatusProjection(production(status), snapshot())).not.toThrow();
  });
  it.each(progressStatuses)('allows %s without CDR evidence but with explicit production context', status => {
    const event = production(status); delete event.payload.evidence;
    expect(() => assertProductionStatusProjection(event, snapshot())).not.toThrow();
  });
  it.each(finalStatuses.flatMap(status => ['missing', 'official-false', 'signature-false', 'official-string', 'signature-string', 'official-missing', 'signature-missing'].map(change => [status, change] as const)))('%s rejects unverified CDR %s', (status, change) => {
    const event = production(status);
    if (change === 'missing') delete event.payload.evidence;
    else if (change === 'official-false') event.payload.evidence!.officialCdr = false;
    else if (change === 'signature-false') event.payload.evidence!.cdrSignatureVerified = false;
    else if (change === 'official-string') Object.assign(event.payload.evidence!, { officialCdr: 'true' });
    else if (change === 'signature-string') Object.assign(event.payload.evidence!, { cdrSignatureVerified: 'true' });
    else if (change === 'official-missing') Reflect.deleteProperty(event.payload.evidence!, 'officialCdr');
    else Reflect.deleteProperty(event.payload.evidence!, 'cdrSignatureVerified');
    expect(() => assertProductionStatusProjection(event, snapshot())).toThrow('CDR oficial verificado');
  });
  it.each([
    ['eventName', 'sunat.other.v1'], ['producer', 'billing-service'], ['eventId', 'invalid'], ['eventId', undefined],
  ])('rejects envelope %s=%s', (key, value) => {
    const event = production(); Object.assign(event, { [key]: value });
    expect(() => assertProductionStatusProjection(event, snapshot())).toThrow('Contrato');
  });
  it.each([undefined, null, {}, { payload: null }, { payload: {} }])('rejects malformed input %#', value => {
    expect(() => assertProductionStatusProjection(value as ProductionStatusEvent, snapshot())).toThrow();
  });
  it.each([
    ['documentId', 'not-a-uuid'], ['documentId', randomUUID()], ['status', 'VOIDED'], ['status', 'UNKNOWN'], ['status', undefined],
  ])('rejects payload %s=%s', (key, value) => {
    const event = production(); Object.assign(event.payload, { [key]: value });
    expect(() => assertProductionStatusProjection(event, snapshot())).toThrow('Contrato');
  });
  it.each([
    ['environment', 'BETA'], ['environment', undefined], ['provenance', 'SUNAT_BETA'], ['provenance', 'LOCAL_SIMULATION'], ['provenance', undefined],
    ['documentTypeCode', '03'], ['documentTypeCode', '07'], ['documentTypeCode', '08'], ['documentTypeCode', '09'], ['documentTypeCode', undefined],
  ])('rejects production context %s=%s even on progress without evidence', (key, value) => {
    const event = production('BUILDING'); delete event.payload.evidence; Object.assign(event.payload, { [key]: value });
    expect(() => assertProductionStatusProjection(event, snapshot())).toThrow('Contexto');
  });
  it.each(['03', '07', '08', '09'] as const)('does not project a production 01 event onto a %s snapshot', documentTypeCode => {
    expect(() => assertProductionStatusProjection(production(), { ...snapshot(), documentTypeCode })).toThrow('Contexto');
  });
  it.each(['BETA', undefined] as const)('requires an explicit production snapshot, got %s', environment => {
    expect(() => assertProductionStatusProjection(production(), { ...snapshot(), environment })).toThrow('Contexto');
  });
  it.each([
    ['transport', 'SUNAT_BETA'], ['transport', 'LOCAL_SIMULATION'], ['transport', undefined], ['environment', 'BETA'],
    ['environment', undefined], ['issuerRuc', '20450819230'], ['issuerRuc', undefined], ['submissionId', 'invalid'], ['submissionId', undefined],
  ])('rejects evidence %s=%s even on nonfinal status', (key, value) => {
    const event = production('SUBMITTED'); Object.assign(event.payload.evidence!, { [key]: value });
    expect(() => assertProductionStatusProjection(event, snapshot())).toThrow('Contexto de evidencia');
  });
  it('does not accept Beta evidence or treat a production event as Beta', () => {
    const event = production(); Object.assign(event.payload.evidence!, beta().payload.evidence);
    expect(() => assertProductionStatusProjection(event, snapshot())).toThrow('Contexto');
    expect(() => assertBetaStatusProjection(production() as unknown as BetaStatusEvent, snapshot('BETA'))).toThrow('Contexto');
  });
});

describe('Billing consumer: production and Beta stay separate without runtime startup', () => {
  it.each(['BETA', 'PRODUCTION'] as const)('projects verified %s status with unchanged inbox and live delivery', async environment => {
    const f = fixture(environment), event = environment === 'BETA' ? beta() : production();
    await f.process(event);
    expect(f.tx.document.updateMany).toHaveBeenCalledExactlyOnceWith({ where: { id, sunatStatus: 'PROCESSING' },
      data: { sunatStatus: 'ACCEPTED', sunatResponseCode: '0', sunatResponseDescription: 'SYNTHETIC VERIFIED CLAIM' } });
    expect(f.tx.inboxEvent.create).toHaveBeenCalledExactlyOnceWith({ data: { eventId: event.eventId, eventType: event.eventName } });
    expect(doubles.changed).toHaveBeenCalledExactlyOnceWith(id);
  });
  it.each(['BUILDING', 'SIGNED', 'SUBMITTED'] as const)('maps production %s to PROCESSING without requiring a final CDR', async status => {
    const f = fixture('PRODUCTION', 'QUEUED'), event = production(status); delete event.payload.evidence;
    await f.process(event); expect(f.tx.document.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sunatStatus: 'PROCESSING' }) }));
  });
  it.each(finalStatuses)('projects production %s only with complete final evidence', async status => {
    const f = fixture(), event = production(status); await f.process(event);
    expect(f.tx.document.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sunatStatus: status }) }));
  });
  it.each(['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED', 'VOIDED'])('preserves existing final %s against late progress or another result', async initial => {
    const f = fixture('PRODUCTION', initial), event = production('BUILDING'); delete event.payload.evidence;
    await f.process(event); await f.process(production('REJECTED'));
    expect(f.tx.document.updateMany).not.toHaveBeenCalled(); expect(f.tx.inboxEvent.create).toHaveBeenCalledTimes(2); expect(doubles.changed).toHaveBeenCalledTimes(2);
  });
  it.each(['BETA', 'PRODUCTION'] as const)('ignores duplicate %s event before transaction or publication', async environment => {
    const f = fixture(environment); f.prisma.inboxEvent.findUnique.mockResolvedValueOnce({ eventId: randomUUID() });
    await f.process(environment === 'BETA' ? beta() : production());
    expect(f.prisma.$transaction).not.toHaveBeenCalled(); expect(f.tx.inboxEvent.create).not.toHaveBeenCalled(); expect(doubles.changed).not.toHaveBeenCalled();
  });
  it.each(['BUILDING', 'ACCEPTED'] as const)('rejects Beta %s on production, including legacy progress without evidence', async status => {
    const f = fixture(), event = beta(status); if (status === 'BUILDING') delete event.payload.evidence;
    await expect(f.process(event)).rejects.toThrow(); expect(f.tx.document.updateMany).not.toHaveBeenCalled(); expect(f.tx.inboxEvent.create).not.toHaveBeenCalled(); expect(doubles.changed).not.toHaveBeenCalled();
  });
  it.each(['BUILDING', 'ACCEPTED'] as const)('rejects production %s on Beta without fallback', async status => {
    const f = fixture('BETA'), event = production(status); if (status === 'BUILDING') delete event.payload.evidence;
    await expect(f.process(event)).rejects.toThrow('Contexto'); expect(f.tx.document.updateMany).not.toHaveBeenCalled(); expect(f.tx.inboxEvent.create).not.toHaveBeenCalled(); expect(doubles.changed).not.toHaveBeenCalled();
  });
  it.each(['environment', 'provenance'] as const)('a lone production %s marker cannot enter the Beta legacy-progress path', async marker => {
    const f = fixture('BETA'), event = beta('BUILDING'); delete event.payload.evidence;
    Object.assign(event.payload, { [marker]: marker === 'environment' ? 'PRODUCTION' : 'SUNAT_PRODUCTION' });
    await expect(f.process(event)).rejects.toThrow('Contexto'); expect(f.tx.document.updateMany).not.toHaveBeenCalled(); expect(f.tx.inboxEvent.create).not.toHaveBeenCalled();
  });
  it.each(['03', '07', '08', '09'] as const)('consumer rejects production %s snapshots before mutation', async documentTypeCode => {
    const f = fixture(); f.document.immutableSnapshot.documentTypeCode = documentTypeCode;
    await expect(f.process(production())).rejects.toThrow('Contexto'); expect(f.tx.document.updateMany).not.toHaveBeenCalled(); expect(f.tx.inboxEvent.create).not.toHaveBeenCalled();
  });
  it('Beta legacy progress remains allowed on Beta without evidence', async () => {
    const f = fixture('BETA'), event = beta('BUILDING'); delete event.payload.evidence;
    await f.process(event); expect(f.tx.document.updateMany).toHaveBeenCalledOnce(); expect(f.tx.inboxEvent.create).toHaveBeenCalledOnce();
  });
  it.each(finalStatuses)('consumer does not record or publish unverified production %s', async status => {
    const f = fixture(), event = production(status); event.payload.evidence!.cdrSignatureVerified = false;
    await expect(f.process(event)).rejects.toThrow('CDR'); expect(f.tx.document.updateMany).not.toHaveBeenCalled(); expect(f.tx.inboxEvent.create).not.toHaveBeenCalled(); expect(doubles.changed).not.toHaveBeenCalled();
  });
  it('invalid late final evidence still fails when a final state already exists', async () => {
    const f = fixture('PRODUCTION', 'ACCEPTED'), event = production('REJECTED'); delete event.payload.evidence;
    await expect(f.process(event)).rejects.toThrow('CDR'); expect(f.tx.document.updateMany).not.toHaveBeenCalled(); expect(f.tx.inboxEvent.create).not.toHaveBeenCalled();
  });
  it('losing the compare-and-update does not record an inbox event or publish', async () => {
    const f = fixture(); f.tx.document.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(f.process(production())).rejects.toThrow('Estado cambió'); expect(f.tx.inboxEvent.create).not.toHaveBeenCalled(); expect(doubles.changed).not.toHaveBeenCalled();
  });
  it.each([undefined, null, {}, { eventName: 'wrong', payload: { documentId: id } }])('rejects malformed job %# before a database lookup', async value => {
    const f = fixture(); await expect(f.process(value)).rejects.toThrow('Evento'); expect(f.prisma.inboxEvent.findUnique).not.toHaveBeenCalled();
  });
});

describe('03 production status binds final claims to exact RC hashes and Billing snapshot', () => {
  function sample(status: ProductionStatusEvent['payload']['status'] = 'ACCEPTED') {
    const document = { ...snapshot(), documentTypeCode: '03', series: 'B001', fullNumber: 'B001-1' };
    const event = production(status); event.payload.documentTypeCode = '03';
    return { document, event };
  }
  it('allows initial BUILDING without RC evidence but requires exact production context', () => {
    const f = sample('BUILDING'); delete f.event.payload.evidence;
    expect(() => assertProductionStatusProjection(f.event, f.document)).not.toThrow();
    Object.assign(f.event.payload, { provenance: 'SUNAT_BETA' }); expect(() => assertProductionStatusProjection(f.event, f.document)).toThrow();
  });
  it.each(finalStatuses)('%s refuses individual or missing RC evidence', status => {
    const f = sample(status); expect(() => assertProductionStatusProjection(f.event, f.document)).toThrow('CDR RC');
  });
});
