import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supplementCommandFixture } from './helpers/fiscal-supplement.fixture';
const ports = vi.hoisted(() => ({ queues: [] as any[], changed: vi.fn(), close: vi.fn() }));
vi.mock('../services/billing-service/node_modules/bullmq', () => ({ Queue: class {
  item: any;
  constructor(name: string) { this.item = { name, add: vi.fn(async () => {}), close: vi.fn(async () => {}) }; ports.queues.push(this.item); }
  on() { return this; } add(...args: any[]) { return this.item.add(...args); } close() { return this.item.close(); }
} }));
vi.mock('@factuez/service-access', () => ({ LivePublisher: class { changed(id: string) { return ports.changed(id); } close() { return ports.close(); } } }));
import { OutboxPublisher } from '../services/billing-service/src/infrastructure/outbox.publisher';
beforeEach(() => { vi.stubEnv('REDIS_PASSWORD_FILE', ''); ports.queues.length = 0; ports.changed.mockClear(); ports.close.mockClear(); });
afterEach(() => vi.unstubAllEnvs());
function fixture(events: any[]) {
  const prisma = { outboxEvent: { findMany: vi.fn(async () => events), update: vi.fn(async () => {}) } };
  return { prisma, publisher: new OutboxPublisher(prisma as never) };
}
describe('Outbox de Billing no mezcla suplementos con factura-v1', () => {
  it('factura y NOTE/RC/RA usan canales diferentes, preservando eventId/backoff', async () => {
    const events = ['NOTE', 'RC', 'RA'].map(kind => {
      const { command } = supplementCommandFixture(kind as any);
      return { id: command.eventId, eventType: command.eventName, payload: command };
    });
    events.unshift({ id: 'legacy-event', eventType: 'billing.document.issued.v1' as any, payload: { payload: { documentId: 'legacy-document' } } as any });
    const f = fixture(events); await f.publisher.flush();
    expect(ports.queues.map(q => q.name)).toEqual(['sunat-submissions', 'billing-beta-supplement-requests-v1']);
    expect(ports.queues[0].add).toHaveBeenCalledOnce(); expect(ports.queues[1].add).toHaveBeenCalledTimes(3);
    for (const [name, _data, options] of ports.queues[1].add.mock.calls) {
      expect(name).toBe('billing.beta.supplement.requested.v1'); expect(options).toMatchObject({ jobId: events[1].id, attempts: 8 });
    }
    expect(f.prisma.outboxEvent.update).toHaveBeenCalledTimes(4);
    await f.publisher.onModuleDestroy(); expect(ports.queues.every(q => q.close.mock.calls.length === 1)).toBe(true);
  });
  it('fallo al encolar no marca el evento publicado y conserva retry de origen', async () => {
    const { command } = supplementCommandFixture(), f = fixture([{ id: command.eventId, eventType: command.eventName, payload: command }]);
    // Crear lazily la cola con un primer flush, luego probar el fallo de publicación.
    await f.publisher.flush(); f.prisma.outboxEvent.update.mockClear(); ports.queues[1].add.mockRejectedValueOnce(new Error('redis-failure'));
    await expect(f.publisher.flush()).rejects.toThrow(); expect(f.prisma.outboxEvent.update).not.toHaveBeenCalled();
    await f.publisher.flush(); expect(f.prisma.outboxEvent.update).toHaveBeenCalledOnce(); await f.publisher.onModuleDestroy();
  });
  it('contrato desconocido no se reenvía a otro consumidor ni se marca publicado', async () => {
    const f = fixture([{ id: 'x', eventType: 'untrusted.evidence', payload: {} }]);
    await expect(f.publisher.flush()).rejects.toThrow('Contrato Outbox'); expect(ports.queues[0].add).not.toHaveBeenCalled();
    expect(f.prisma.outboxEvent.update).not.toHaveBeenCalled(); await f.publisher.onModuleDestroy();
  });
});
