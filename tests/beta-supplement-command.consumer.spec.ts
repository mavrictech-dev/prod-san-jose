import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supplementCommandFixture, supplementUuid } from './helpers/fiscal-supplement.fixture';
const ports = vi.hoisted(() => ({ allowed: false, workers: [] as any[], redis: vi.fn(() => ({ host: 'fixture.invalid', port: 6379 })) }));
vi.mock('../services/sunat-service/src/application/fiscal-readiness.service', () => ({ assertOfficialFiscalActivation() { if (!ports.allowed) throw new Error('ACTIVATION_BLOCKED'); } }));
vi.mock('@factuez/service-access', () => ({ redisConnection: ports.redis, LivePublisher: class {} }));
vi.mock('../services/sunat-service/node_modules/bullmq', () => ({ Worker: class {
  item: any;
  constructor(queue: string, processor: any, options: any) { this.item = { queue, processor, options, close: vi.fn(async () => {}) }; ports.workers.push(this.item); }
  on() { return this; } close() { return this.item.close(); }
}, Queue: class {} }));
import { BetaSupplementCommandConsumer } from '../services/sunat-service/src/application/beta-supplement-command.consumer';
function fixture(kind: 'NOTE' | 'RC' | 'RA' = 'NOTE') {
  const { command } = supplementCommandFixture(kind), submissionId = supplementUuid(10);
  const row = { id: submissionId, idempotencyKey: `beta-supplement:${command.payload.operationId}:v1`,
    documentId: kind === 'NOTE' ? command.payload.operationId : null, batchId: kind === 'NOTE' ? null : supplementUuid(11),
    errorMessage: JSON.stringify({ version: 1, kind: 'BETA_SUPPLEMENT', eventId: command.eventId, correlationId: command.correlationId,
      envelope: command.payload.envelope, envelopeSha256: command.payload.envelopeSha256 }) };
  let inbox: { eventType: string } | null = null;
  const prisma: any = { sunatSubmission: { findUnique: vi.fn(async () => row) },
    inboxEvent: { findUnique: vi.fn(async () => inbox), create: vi.fn(async () => { inbox = { eventType: command.eventName }; }) },
    $executeRaw: vi.fn(async () => 0), $transaction: vi.fn(async (action: any, options: any) => { expect(options).toEqual({ isolationLevel: 'Serializable' }); return action(prisma); }) };
  const service = { stage: vi.fn(async () => submissionId) }, consumer = new BetaSupplementCommandConsumer(prisma, service as never);
  const job = () => ({ name: command.eventName, id: command.eventId, data: structuredClone(command) });
  return { consumer, command, service, prisma, row, job, setInbox: (value: { eventType: string }) => { inbox = value; } };
}
beforeEach(() => { ports.allowed = false; ports.workers.length = 0; ports.redis.mockClear(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NETWORK_FORBIDDEN'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('canal interno de comando BETA mantiene activación cerrada', () => {
  it.each(['NOTE', 'RC', 'RA'] as const)('guard real equivalente bloquea %s antes de stage o DB', async kind => {
    const f = fixture(kind); await expect(f.consumer.process(f.job())).rejects.toThrow('Comando BETA no procesado');
    expect(f.service.stage).not.toHaveBeenCalled(); expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(['name', 'jobId', 'producer', 'production', 'hash', 'extra'] as const)('rechaza contrato %s antes de puertos', async change => {
    ports.allowed = true; const f = fixture(), job = f.job();
    if (change === 'name') job.name = 'billing.document.issued.v1' as any;
    if (change === 'jobId') job.id = supplementUuid(50);
    if (change === 'producer') job.data.producer = 'pwa';
    if (change === 'production') job.data.payload.environment = 'PRODUCTION' as any;
    if (change === 'hash') job.data.payload.envelopeSha256 = 'b'.repeat(64);
    if (change === 'extra') (job.data as any).password = 'SYNTHETIC';
    await expect(f.consumer.process(job)).rejects.toThrow('Comando BETA no procesado'); expect(f.service.stage).not.toHaveBeenCalled();
  });
  it.each(['NOTE', 'RC', 'RA'] as const)('ACK de %s sólo después de reservar/contrastar metadata propia', async kind => {
    ports.allowed = true; const f = fixture(kind); await f.consumer.process(f.job());
    expect(f.service.stage).toHaveBeenCalledWith(f.command.payload.envelope, f.command.eventId, f.command.correlationId);
    expect(f.prisma.inboxEvent.create).toHaveBeenCalledWith({ data: { eventId: f.command.eventId, eventType: f.command.eventName } });
    await f.consumer.process(f.job()); expect(f.prisma.inboxEvent.create).toHaveBeenCalledOnce(); expect(f.service.stage).toHaveBeenCalledTimes(2);
  });
  it.each(['event', 'correlation', 'hash', 'kind', 'owner', 'idempotency'] as const)('no ACK si reserva contradice %s', async change => {
    ports.allowed = true; const f = fixture(), meta = JSON.parse(f.row.errorMessage);
    if (change === 'event') meta.eventId = supplementUuid(60);
    if (change === 'correlation') meta.correlationId = supplementUuid(61);
    if (change === 'hash') meta.envelopeSha256 = 'a'.repeat(64);
    if (change === 'kind') meta.kind = 'QA';
    if (change === 'owner') f.row.documentId = supplementUuid(62);
    if (change === 'idempotency') f.row.idempotencyKey = 'NOT_A_RESERVATION';
    f.row.errorMessage = JSON.stringify(meta);
    await expect(f.consumer.process(f.job())).rejects.toThrow('Comando BETA no procesado'); expect(f.prisma.inboxEvent.create).not.toHaveBeenCalled();
  });
  it('sanitiza error de stage y no registra Inbox', async () => {
    ports.allowed = true; const f = fixture(); f.service.stage.mockRejectedValueOnce(new Error('PRIVATE_PASSWORD_FIXTURE'));
    const error = await f.consumer.process(f.job()).catch(e => e); expect(error.message).not.toContain('PRIVATE_PASSWORD'); expect(error.cause).toBeUndefined();
    expect(f.prisma.inboxEvent.create).not.toHaveBeenCalled();
  });
  it('Inbox de otro contrato no se reutiliza', async () => {
    ports.allowed = true; const f = fixture(); f.setInbox({ eventType: 'billing.document.issued.v1' });
    await expect(f.consumer.process(f.job())).rejects.toThrow('Comando BETA no procesado'); expect(f.prisma.inboxEvent.create).not.toHaveBeenCalled();
  });
  it('flag true no crea worker si guard sigue cerrado', () => {
    vi.stubEnv('SUNAT_BETA_WORKFLOW_ENABLED', 'true'); fixture().consumer.onApplicationBootstrap();
    expect(ports.workers).toHaveLength(0); expect(ports.redis).not.toHaveBeenCalled();
  });
  it('lifecycle con autorización sólo sintética prueba cola única y cierre', async () => {
    ports.allowed = true; vi.stubEnv('SUNAT_BETA_WORKFLOW_ENABLED', 'true'); const f = fixture();
    f.consumer.onApplicationBootstrap(); f.consumer.onApplicationBootstrap(); expect(ports.workers).toHaveLength(1);
    expect(ports.workers[0].queue).toBe('billing-beta-supplement-requests-v1');
    await f.consumer.onModuleDestroy(); expect(ports.workers[0].close).toHaveBeenCalledOnce();
    await expect(f.consumer.process(f.job())).rejects.toThrow('Comando BETA no procesado'); f.consumer.onApplicationBootstrap(); expect(ports.workers).toHaveLength(1);
  });
});
