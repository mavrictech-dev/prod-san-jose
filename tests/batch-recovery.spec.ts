import 'reflect-metadata';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { FiscalBatchQaService } from '../services/sunat-service/src/application/fiscal-batch-qa.service';
import { LocalPreparationUnavailableError } from '../services/sunat-service/src/application/local-preparation-policy';
import { BoundedSoapAdapter, SoapSubmissionError } from '../services/sunat-service/src/infrastructure/sunat/bounded-soap.adapter';
const require = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const { BadRequestException } = require('@nestjs/common');
const { zipSync } = require('fflate');
const now = new Date('2026-10-02T22:00:00Z');
const fingerprint = 'a'.repeat(64);
const clone = <T>(value: T): T => structuredClone(value);
function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((part: Record<string, any>) => matches(row, part));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(row[key]);
      if ('lt' in value) return row[key] != null && row[key] < value.lt;
      if ('lte' in value) return row[key] != null && row[key] <= value.lte;
      if ('gt' in value) return row[key] != null && row[key] > value.gt;
    }
    return value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value;
  });
}
function fixture(size = 1) {
  const snapshots = Array.from({ length: size }, (_, index) => JSON.parse(JSON.stringify({
    documentId: randomUUID(), environment: 'BETA', documentTypeCode: '03', series: 'BQ01', number: String(index + 1), fullNumber: `BQ01-${index + 1}`,
    issueDate: '2026-10-02T16:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
    issuer: { identityType: '6', identityNumber: '00000000001', legalName: 'FICTICIO MEMORIA', ubigeo: '150101', establishmentCode: '0001' },
    customer: { identityType: '0', identityNumber: '0', legalName: 'CLIENTE FICTICIO' },
    ...calculateDocumentTotals([{ description: 'NO ES VENTA', unitCode: 'NIU', quantity: '1', unitPriceWithTax: '1.18', taxAffectationCode: '10', igvRate: '18' }]),
  })));
  const credentials = { revision: 1, certificateFingerprint: fingerprint, certificateSelfSigned: true, certificateExpiresAt: new Date('2030-01-01T00:00:00Z'), certificateCipher: 'MOCK-ENVELOPE', certificatePasswordCipher: 'MOCK-ENVELOPE' };
  const state: { row?: Record<string, any> } = {};
  const table = {
    findUnique: vi.fn(async ({ where }: { where: Record<string, any> }) => {
      if (!state.row || (where.id && state.row.id !== where.id)) return null;
      return clone(state.row);
    }),
    findUniqueOrThrow: vi.fn(async () => clone(state.row!)),
    findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => state.row && matches(state.row, where) ? [clone(state.row)] : []),
    create: vi.fn(async ({ data }: { data: Record<string, any> }) => { state.row = { ...clone(data), state: 'BUILDING', pollAttempts: 0, claimedAt: null, nextPollAt: new Date(), createdAt: new Date(), updatedAt: new Date() }; return clone(state.row); }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
      if (!state.row || !matches(state.row, where)) return { count: 0 };
      for (const [key, value] of Object.entries(data)) state.row[key] = value?.increment ? state.row[key] + value.increment : clone(value);
      state.row.updatedAt = data.updatedAt ?? new Date(); return { count: 1 };
    }),
  };
  const prisma: Record<string, any> = { fiscalBatchQa: table, $executeRawUnsafe: vi.fn(),
    sunatCredentials: { findUnique: vi.fn(async () => clone(credentials)) },
    fiscalDocument: { findUnique: vi.fn(async ({ where }: { where: { documentId: string } }) => ({ environment: 'BETA', issuerRuc: '00000000001', status: 'BUILDING', immutablePayload: clone(snapshots.find(s => s.documentId === where.documentId)) })) },
    fiscalBatchQaMember: { findUnique: vi.fn(async () => null) }, fiscalCircuitQa: { findUnique: vi.fn(async () => null) },
    fiscalQaCounter: { upsert: vi.fn(async () => ({ lastNumber: 1 })) } };
  prisma.$transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma));
  const artifacts = new Map<string, Buffer>();
  const store = { put: vi.fn(async (_id: string, file: string, bytes: Buffer) => {
    const sha256 = createHash('sha256').update(bytes).digest('hex'); const storageKey = `${sha256}-${file}`;
    artifacts.set(storageKey, Buffer.from(bytes)); return { storageKey, sha256, sizeBytes: bytes.length };
  }), read: vi.fn(async (_id: string, item: { storageKey: string }) => artifacts.get(item.storageKey)!) };
  const signer = { prepare: vi.fn(async (_input: unknown, identifier: string) => {
    const fileName = `00000000001-${identifier}.xml`; const xml = 'MOCK SIGNED XML';
    return { certificateFingerprintSha256: fingerprint, xml, digestValue: 'MOCK-DIGEST', zip: Buffer.from(zipSync({ [fileName]: Buffer.from(xml) })) };
  }) };
  const xsd = { validate: vi.fn(async (xml: string | Buffer) => ({ profile: 'MOCK-XSD', archiveSha256: 'MOCK', xmlSha256: createHash('sha256').update(xml).digest('hex') })) };
  const local = { context: vi.fn(async (id: string) => ({ snapshot: clone(snapshots.find(s => s.documentId === id)), credentials: clone(credentials) })) };
  const queue = { add: vi.fn() }; const live = { changed: vi.fn(async () => {}) };
  const service = new FiscalBatchQaService(prisma as never, local as never, store as never, { open: vi.fn(() => Buffer.from('MOCK-NOT-PFX')) } as never, signer as never, xsd as never);
  Object.assign(service, { enabled: () => {}, live, queue });
  const request = { kind: 'RC_ALTA', scenario: 'ACCEPTED', documentIds: snapshots.map(s => s.documentId) };
  const key = randomUUID(); const actor = randomUUID();
  const start = () => service.start(request, key, actor, 'Bearer MOCK');
  const dispatch = () => (service as unknown as { dispatch(): Promise<void> }).dispatch();
  return { state, service, table, prisma, signer, xsd, store, live, queue, snapshots, credentials, start, dispatch };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('FISCAL_CIRCUIT_QA_ENABLED', 'true'); vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'false'); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('RED PROHIBIDA'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Recuperación durable de RC/RA QA sin nuevos correlativos', () => {
  it('reintenta XSD ocupado y prepara la misma reserva al recuperarse', async () => {
    const f = fixture(); f.xsd.validate.mockRejectedValueOnce(new LocalPreparationUnavailableError('XSD_BUSY'));
    const initial = await f.start(); expect(initial.state).toBe('BUILDING');
    const id = f.state.row!.id; const identifier = f.state.row!.identifier;
    expect(f.state.row!.claimedAt).toBeNull(); expect(f.state.row!.nextPollAt > now).toBe(true);
    await f.service.process(id); expect(f.signer.prepare).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000); await f.service.process(id);
    expect(f.state.row!.state).toBe('QUEUED'); expect(f.state.row!.id).toBe(id); expect(f.state.row!.identifier).toBe(identifier);
    expect(f.prisma.fiscalQaCounter.upsert).toHaveBeenCalledOnce(); expect(f.table.create).toHaveBeenCalledOnce();
    expect(f.signer.prepare).toHaveBeenCalledTimes(2); expect(f.store.put).toHaveBeenCalledTimes(2);
  });
  it('mantiene límite de tres intentos y conserva la reserva bloqueada', async () => {
    const f = fixture(); f.xsd.validate.mockRejectedValue(new LocalPreparationUnavailableError('XSD_BUSY'));
    await f.start(); const id = f.state.row!.id;
    await vi.advanceTimersByTimeAsync(2000); await f.service.process(id);
    await vi.advanceTimersByTimeAsync(4000); await f.service.process(id);
    expect(f.state.row!.state).toBe('BLOCKED'); expect(f.state.row!.responseCode).toBe('QA_PREPARATION_RETRY_LIMIT');
    await vi.advanceTimersByTimeAsync(60000); await f.service.process(id); await f.start();
    expect(f.signer.prepare).toHaveBeenCalledTimes(3); expect(f.prisma.fiscalQaCounter.upsert).toHaveBeenCalledOnce();
  });
  it('XML inválido no se clasifica como error temporal', async () => {
    const f = fixture(); f.xsd.validate.mockRejectedValue(new BadRequestException('XML rechazado por XSD oficial'));
    await expect(f.start()).rejects.toThrow('XML rechazado'); expect(f.state.row!.state).toBe('BLOCKED');
    await f.service.process(f.state.row!.id); expect(f.signer.prepare).toHaveBeenCalledOnce();
  });
  it('50 miembros y preparación de más de 60s mantienen una lease activa', async () => {
    const f = fixture(50); let release!: (result: any) => void;
    const prepared = await f.signer.prepare({}, 'RC-20261002-1'); f.signer.prepare.mockClear();
    f.signer.prepare.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const running = f.start();
    await vi.waitFor(() => expect(f.signer.prepare).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(70000); await f.dispatch();
    expect(f.state.row!.state).toBe('BUILDING'); expect(f.state.row!.claimedAt).not.toBeNull();
    expect(f.queue.add).not.toHaveBeenCalled(); release(prepared); await running;
    expect(f.state.row!.state).toBe('QUEUED'); expect(f.state.row!.claimedAt).toBeNull();
  });
  it('recupera lease realmente vencida sin usar createdAt ni cambiar número', async () => {
    const f = fixture(); await f.start(); const id = f.state.row!.id;
    Object.assign(f.state.row!, { state: 'BUILDING', claimedAt: new Date(now.getTime() - 90000), updatedAt: new Date(now.getTime() - 90000), pollAttempts: 1 });
    await f.dispatch(); expect(f.state.row!.state).toBe('BUILDING'); expect(f.state.row!.claimedAt).toBeNull();
    expect(f.queue.add).toHaveBeenCalledOnce(); await f.service.process(id);
    expect(f.state.row!.state).toBe('QUEUED'); expect(f.prisma.fiscalQaCounter.upsert).toHaveBeenCalledOnce();
  });
  it('un propietario antiguo no puede publicar ni bloquear una preparación reemplazada', async () => {
    const f = fixture(); let release!: (result: any) => void;
    const prepared = await f.signer.prepare({}, 'RC-20261002-1'); f.signer.prepare.mockClear();
    f.signer.prepare.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const running = f.start(); await vi.waitFor(() => expect(f.signer.prepare).toHaveBeenCalledOnce());
    Object.assign(f.state.row!, { claimedAt: new Date(now.getTime() + 1), pollAttempts: 2 });
    release(prepared); await running;
    expect(f.state.row!.state).toBe('BUILDING'); expect(f.state.row!.pollAttempts).toBe(2);
    expect(f.state.row!.digestValue).toBeUndefined();
  });
  it('ocupación antes del POST reintenta el mismo paquete; respuesta perdida no se reenvía', async () => {
    const f = fixture(); await f.start(); const id = f.state.row!.id;
    f.xsd.validate.mockRejectedValueOnce(new LocalPreparationUnavailableError('XSD_BUSY'));
    const submit = vi.spyOn(BoundedSoapAdapter.prototype, 'submitSummary').mockRejectedValue(new SoapSubmissionError('UNKNOWN', 'TIMEOUT'));
    await f.service.process(id); expect(f.state.row!.state).toBe('QUEUED'); expect(submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000); await f.service.process(id);
    expect(f.state.row!.state).toBe('UNKNOWN'); expect(submit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000); await f.dispatch(); await f.service.process(id);
    expect(submit).toHaveBeenCalledOnce(); expect(f.prisma.fiscalQaCounter.upsert).toHaveBeenCalledOnce();
  });
  it('ticket pendiente se consulta incluso si conserva claimedAt del runtime anterior', async () => {
    const f = fixture(); await f.start(); Object.assign(f.state.row!, { state: 'WAITING_TICKET', ticket: 'LOCAL-MOCK', claimedAt: now, pollAttempts: 1 });
    await f.dispatch(); expect(f.queue.add).toHaveBeenCalledOnce();
    const query = vi.spyOn(BoundedSoapAdapter.prototype, 'getStatus').mockResolvedValue({ kind: 'PROCESSING' });
    await f.service.process(f.state.row!.id); expect(query).toHaveBeenCalledOnce(); expect(f.state.row!.claimedAt).toBeNull();
    expect(f.state.row!.state).toBe('WAITING_TICKET');
  });
});
