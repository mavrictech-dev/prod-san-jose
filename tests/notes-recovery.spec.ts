import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker as CryptoWorker } from 'node:worker_threads';
import { Queue, Worker as QueueWorker } from 'bullmq';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { buildNoteQaSnapshot, noteQaCanonical, NOTES_QA_PROFILE } from '../packages/sunat-core/src/notes-qa';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src/events';
import { NotesQaService } from '../services/sunat-service/src/application/notes-qa.service';
import { NotesQaRepository, NOTES_QA_LEASE_MS, type NotesQaRow } from '../services/sunat-service/src/application/notes-qa.repository';
import { LocalPreparationUnavailableError, LOCAL_PREPARATION_MAX_ATTEMPTS, localPreparationRetryDelay } from '../services/sunat-service/src/application/local-preparation-policy';
import { XsdValidationService } from '../services/sunat-service/src/infrastructure/sunat/xsd-validation.service';

vi.mock('bullmq', () => ({ Queue: vi.fn(() => { throw new Error('REDIS PROHIBIDO'); }), Worker: vi.fn(() => { throw new Error('REDIS PROHIBIDO'); }) }));
vi.mock('node:worker_threads', () => ({ Worker: vi.fn(() => { throw new Error('PFX/WORKER REAL PROHIBIDO'); }) }));
vi.mock('../services/sunat-service/src/infrastructure/prisma.service', () => ({ PrismaService: class {} }));
const require = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const { ServiceUnavailableException, BadRequestException, ForbiddenException } = require('@nestjs/common');
const now = new Date('2026-10-02T21:50:00Z');
const fingerprint = 'a'.repeat(64);
const hash = (value: unknown) => createHash('sha256').update(noteQaCanonical(value)).digest('hex');
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Modelo de persistencia en memoria; también exige los predicados CAS del SQL real.
 * No usa Prisma/DB, reservas nuevas, filesystem, PFX, Redis ni red. */
function fixture() {
  const original: FiscalDocumentSnapshot = {
    documentId: randomUUID(), environment: 'BETA', documentTypeCode: '01', series: 'FQ01', number: '1', fullNumber: 'FQ01-1',
    issueDate: '2026-10-02T16:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
    issuer: { identityType: '6', identityNumber: '00000000001', legalName: 'FICTICIO SÓLO MEMORIA', ubigeo: '150101', establishmentCode: '0001' },
    customer: { identityType: '6', identityNumber: '00000000000', legalName: 'CLIENTE FICTICIO' },
    ...calculateDocumentTotals([{ description: 'PRUEBA SIN VENTA', unitCode: 'NIU', quantity: '1', unitPriceWithTax: '1.18', taxAffectationCode: '10', igvRate: '18' }]),
  };
  const snapshot = buildNoteQaSnapshot(original, { idempotencyKey: randomUUID(), documentTypeCode: '07', reasonCode: '01', reasonDescription: 'PRUEBA EN MEMORIA' },
    { documentId: randomUUID(), number: '17', issueDate: now.toISOString() });
  const circuit = { id: randomUUID(), state: 'ACCEPTED', cdrZipArtifact: { mock: true } };
  const credentials = { revision: 1, certificateFingerprint: fingerprint, certificateSelfSigned: true,
    certificateExpiresAt: new Date('2030-01-01T00:00:00Z'), certificateCipher: 'MOCK-NOT-CIPHER', certificatePasswordCipher: 'MOCK-NOT-CIPHER' };
  const row: NotesQaRow = { id: snapshot.documentId, originalDocumentId: original.documentId, actorId: randomUUID(), idempotencyKey: randomUUID(),
    requestSha256: 'b'.repeat(64), originalSha256: hash(original), originalCircuitId: circuit.id, credentialRevision: 1, certificateFingerprint: fingerprint,
    snapshot, state: 'QUEUED', attempts: 0, claimedAt: null, createdAt: now, digestValue: null, xmlArtifact: null, zipArtifact: null, xsdEvidence: null, description: null };
  const currentTime = () => Date.now(); const copy = () => structuredClone(row);
  const expired = (lease: number) => row.claimedAt !== null && row.claimedAt.getTime() <= currentTime() - lease;
  const due = () => row.claimedAt === null || row.claimedAt.getTime() <= currentTime();
  const prisma = {
    fiscalDocument: { findUnique: vi.fn(async () => ({ issuerRuc: original.issuer.identityNumber, environment: original.environment, status: 'BUILDING', immutablePayload: original })) },
    fiscalCircuitQa: { findUnique: vi.fn(async () => circuit) }, sunatCredentials: { findUnique: vi.fn(async () => credentials) },
    $queryRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => {
      if (sql.startsWith('UPDATE')) {
        expect(sql).toContain('"state"=\'QUEUED\' AND "attempts"<$2');
        expect(sql).toContain('("claimedAt" IS NULL OR "claimedAt"<=NOW())');
        if (args[0] !== row.id || row.state !== 'QUEUED' || row.attempts >= Number(args[1]) || !due()) return [];
        row.state = 'SIGNING'; row.attempts++; row.claimedAt = new Date(currentTime()); return [copy()];
      }
      if (sql.includes('"state"=\'SIGNING\'')) {
        expect(sql).toContain('"claimedAt"<=NOW()-($1::double precision');
        return row.state === 'SIGNING' && expired(Number(args[0])) ? [copy()] : [];
      }
      expect(sql).toContain('"state"=\'QUEUED\' AND "attempts"<$1');
      expect(sql).toContain('("claimedAt" IS NULL OR "claimedAt"<=NOW())');
      return row.state === 'QUEUED' && row.attempts < Number(args[0]) && due() ? [copy()] : [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => {
      const predicate = sql.split('WHERE ')[1];
      expect(predicate).toContain('"id"=$1::uuid'); expect(predicate).toContain('"attempts"=$2');
      expect(predicate).toMatch(/"state"='SIGNING'/);
      const reclaim = predicate.includes('"claimedAt"<=NOW()-');
      expect(predicate).toContain(`"claimedAt"${reclaim ? '<=' : '>'}NOW()-(`);
      const lease = Number(args.at(-1));
      if (args[0] !== row.id || row.state !== 'SIGNING' || row.attempts !== args[1] || row.claimedAt === null || (reclaim ? !expired(lease) : expired(lease))) return 0;
      if (sql.includes('"state"=CASE')) {
        row.state = row.attempts < Number(args[2]) ? 'QUEUED' : 'BLOCKED';
        row.claimedAt = row.state === 'QUEUED' ? new Date(currentTime() + Number(args[3])) : null;
        row.description = row.state === 'QUEUED' ? String(args[4]) : 'Preparación local agotó sus intentos; reserva QA conservada, sin envío';
      } else if (sql.includes('"state"=\'SIGNED_LOCAL\'')) {
        row.state = 'SIGNED_LOCAL'; row.claimedAt = null; row.digestValue = String(args[2]);
        row.xmlArtifact = JSON.parse(String(args[3])); row.zipArtifact = JSON.parse(String(args[4])); row.xsdEvidence = JSON.parse(String(args[5]));
      } else if (sql.includes('"state"=\'BLOCKED\'')) {
        row.state = 'BLOCKED'; row.claimedAt = null;
      } else {
        expect(sql).toContain('SET "claimedAt"=NOW()'); row.claimedAt = new Date(currentTime());
      }
      return 1;
    }),
  };
  const repository = new NotesQaRepository(prisma as never);
  const prepared = { certificateFingerprintSha256: fingerprint, profile: NOTES_QA_PROFILE,
    xml: '<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"/>', zip: Buffer.from('MOCK-ZIP'), fileName: 'MOCK-NOTE', digestValue: 'MOCK-DIGEST' };
  const signer = { prepare: vi.fn(async () => prepared) };
  const secretBuffers: Buffer[] = [];
  const vault = { open: vi.fn(() => { const bytes = Buffer.from('MOCK-NOT-A-PFX'); secretBuffers.push(bytes); return bytes; }) };
  const store = { put: vi.fn(async (id: string, name: string, bytes: Buffer) => ({ storageKey: `${id}/${name}`, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length })) };
  const xsd = new XsdValidationService(); const run = vi.fn(async () => {});
  Object.assign(xsd, { bundle: async () => ({ CreditNote: '/mock-only/CreditNote.xsd' }), run });
  const live = { changed: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const makeService = () => {
    const service = new NotesQaService(prisma as never, {} as never, repository, signer as never, store as never, vault as never, xsd);
    Object.assign(service, { live }); return service;
  };
  return { row, original, circuit, credentials, prisma, repository, prepared, signer, vault, secretBuffers, store, xsd, run, live, makeService, service: makeService() };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks();
  for (const flag of ['NOTES_QA_ENABLED', 'LOCAL_XML_VALIDATION_ENABLED', 'FISCAL_CIRCUIT_QA_ENABLED']) vi.stubEnv(flag, 'true');
  vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'false'); vi.stubEnv('WORKSPACE_LIVE_ENABLED', 'false');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('RED PROHIBIDA'); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled(); expect(Queue).not.toHaveBeenCalled(); expect(QueueWorker).not.toHaveBeenCalled(); expect(CryptoWorker).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('recuperación durable de la misma reserva de nota QA', () => {
  it('recupera XSD ocupado después del backoff, incluso con otro servicio', async () => {
    const f = fixture(); const reservation = structuredClone(f.row);
    Object.assign(f.xsd, { active: 2 }); await f.service.process(f.row.id);
    expect(f.row.state).toBe('QUEUED'); expect(f.row.attempts).toBe(1); expect(f.row.claimedAt?.getTime()).toBe(now.getTime() + 2000);
    expect(f.store.put).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
    expect(await f.repository.pending()).toEqual([]); await f.makeService().process(f.row.id); expect(f.row.attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1999); expect(await f.repository.pending()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); expect(await f.repository.pending()).toHaveLength(1);
    Object.assign(f.xsd, { active: 0 }); await f.makeService().process(f.row.id);
    expect(f.row.state).toBe('SIGNED_LOCAL'); expect(f.row.attempts).toBe(2); expect(f.row.claimedAt).toBeNull();
    for (const key of ['id', 'originalDocumentId', 'actorId', 'idempotencyKey', 'requestSha256', 'snapshot', 'createdAt'] as const) expect(f.row[key]).toEqual(reservation[key]);
    expect(f.row.snapshot.number).toBe('17'); expect(f.row.snapshot.fullNumber).toBe('FCQ1-17');
    expect(f.row.xsdEvidence).toMatchObject({ xmlSha256: f.row.xmlArtifact?.sha256 });
    expect(f.secretBuffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    expect(f.live.changed).toHaveBeenCalledTimes(2);
  });
  it('agota tres intentos con 2 s/4 s y conserva la reserva BLOCKED', async () => {
    const f = fixture(); const snapshot = structuredClone(f.row.snapshot); Object.assign(f.xsd, { active: 2 });
    for (let attempt = 1; attempt <= LOCAL_PREPARATION_MAX_ATTEMPTS; attempt++) {
      await f.service.process(f.row.id); expect(f.row.attempts).toBe(attempt);
      if (attempt < LOCAL_PREPARATION_MAX_ATTEMPTS) {
        expect(f.row.state).toBe('QUEUED'); expect(f.row.claimedAt?.getTime()).toBe(Date.now() + localPreparationRetryDelay(attempt));
        await vi.advanceTimersByTimeAsync(localPreparationRetryDelay(attempt));
      }
    }
    expect(f.row.state).toBe('BLOCKED'); expect(f.row.claimedAt).toBeNull(); expect(f.row.description).toContain('agotó');
    Object.assign(f.xsd, { active: 0 }); await vi.advanceTimersByTimeAsync(60000);
    expect(await f.repository.pending()).toEqual([]); await f.service.process(f.row.id);
    expect(f.row.attempts).toBe(3); expect(f.row.snapshot).toEqual(snapshot); expect(f.signer.prepare).toHaveBeenCalledTimes(3); expect(f.store.put).not.toHaveBeenCalled();
  });
  it.each([new BadRequestException('XML inválido'), new ServiceUnavailableException('Integridad/certificado'), new ForbiddenException('No autorizado')])('errores permanentes no reintentan (%#)', async error => {
    const f = fixture(); f.run.mockRejectedValueOnce(error); await f.service.process(f.row.id);
    expect(f.row.state).toBe('BLOCKED'); expect(f.row.attempts).toBe(1); expect(f.store.put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000); await f.service.process(f.row.id); expect(f.signer.prepare).toHaveBeenCalledOnce();
  });
  it('XML con DTD se bloquea sin llamar al validador externo', async () => {
    const f = fixture(); f.prepared.xml = '<!DOCTYPE CreditNote>' + f.prepared.xml; await f.service.process(f.row.id);
    expect(f.row.state).toBe('BLOCKED'); expect(f.run).not.toHaveBeenCalled(); expect(f.store.put).not.toHaveBeenCalled();
  });
  it('BLOCKED histórico conserva estado, snapshot y crédito reservado', async () => {
    const f = fixture(); f.row.state = 'BLOCKED'; f.row.description = 'BLOQUEO HISTÓRICO'; const previous = structuredClone(f.row);
    expect(await f.repository.pending()).toEqual([]); await f.service.process(f.row.id);
    expect(f.row).toEqual(previous); expect(f.vault.open).not.toHaveBeenCalled(); expect(f.prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('leases, fencing y affected count de notas', () => {
  it('heartbeat mantiene SIGNING más de 60 s sin que pending lo reclame', async () => {
    const f = fixture(); const gate = deferred<typeof f.prepared>(); f.signer.prepare.mockReturnValueOnce(gate.promise);
    const processing = f.service.process(f.row.id); await vi.advanceTimersByTimeAsync(75000);
    expect(f.row.state).toBe('SIGNING'); expect(f.row.attempts).toBe(1); expect(f.row.claimedAt).toEqual(new Date(Date.now()));
    expect(await f.repository.pending()).toEqual([]); expect(f.row.state).toBe('SIGNING');
    gate.resolve(f.prepared); await processing; expect(f.row.state).toBe('SIGNED_LOCAL');
  });
  it('sólo recupera leases vencidos y aplica backoff antes del siguiente claim', async () => {
    const f = fixture(); const old = (await f.repository.claim(f.row.id))!;
    await vi.advanceTimersByTimeAsync(NOTES_QA_LEASE_MS - 1); expect(await f.repository.pending()).toEqual([]); expect(f.row.state).toBe('SIGNING');
    await vi.advanceTimersByTimeAsync(1); expect(await f.repository.pending()).toEqual([]); expect(f.row.state).toBe('QUEUED');
    expect(await f.repository.heartbeat(old)).toBe(false); expect(await f.repository.claim(f.row.id)).toBeNull();
    await vi.advanceTimersByTimeAsync(2000); expect(await f.repository.pending()).toHaveLength(1);
    expect((await f.repository.claim(f.row.id))?.attempts).toBe(2);
  });
  it('tercer lease vencido queda BLOCKED sin liberar la reserva', async () => {
    const f = fixture(); f.row.attempts = 2; await f.repository.claim(f.row.id); const snapshot = structuredClone(f.row.snapshot);
    await vi.advanceTimersByTimeAsync(NOTES_QA_LEASE_MS); expect(await f.repository.pending()).toEqual([]);
    expect(f.row.state).toBe('BLOCKED'); expect(f.row.attempts).toBe(3); expect(f.row.claimedAt).toBeNull(); expect(f.row.snapshot).toEqual(snapshot);
  });
  it('reclaim tardío no toca un lease renovado después de seleccionar candidatos', async () => {
    const f = fixture(); await f.repository.claim(f.row.id); await vi.advanceTimersByTimeAsync(NOTES_QA_LEASE_MS);
    const stale = structuredClone(f.row); f.row.claimedAt = new Date(Date.now());
    f.prisma.$queryRawUnsafe.mockResolvedValueOnce([stale]);
    expect(await f.repository.pending()).toEqual([]); expect(f.row.state).toBe('SIGNING'); expect(f.row.attempts).toBe(1);
  });
  it('lease vencido no puede completar, bloquear, diferir ni resucitar con heartbeat', async () => {
    const f = fixture(); const old = (await f.repository.claim(f.row.id))!; await vi.advanceTimersByTimeAsync(NOTES_QA_LEASE_MS);
    const artifact = { storageKey: 'MOCK', sha256: 'MOCK', sizeBytes: 1 };
    expect(await f.repository.complete(old, { digestValue: 'OLD', xml: artifact, zip: artifact, xsdEvidence: null })).toBe(false);
    expect(await f.repository.block(old)).toBe(false); expect(await f.repository.defer(old)).toBe(false); expect(await f.repository.heartbeat(old)).toBe(false);
    expect(f.row.state).toBe('SIGNING'); expect(f.row.digestValue).toBeNull();
  });
  it('worker antiguo no completa ni altera el worker nuevo con attempts distinto', async () => {
    const f = fixture(); const old = (await f.repository.claim(f.row.id))!;
    await vi.advanceTimersByTimeAsync(NOTES_QA_LEASE_MS); await f.repository.pending(); await vi.advanceTimersByTimeAsync(2000);
    const current = (await f.repository.claim(f.row.id))!; const artifact = { storageKey: 'MOCK', sha256: 'MOCK', sizeBytes: 1 };
    expect(await f.repository.complete(old, { digestValue: 'OLD', xml: artifact, zip: artifact, xsdEvidence: null })).toBe(false);
    expect(await f.repository.block(old)).toBe(false); expect(await f.repository.defer(old)).toBe(false); expect(await f.repository.heartbeat(old)).toBe(false);
    expect(f.row.state).toBe('SIGNING'); expect(f.row.attempts).toBe(2);
    expect(await f.repository.complete(current, { digestValue: 'NEW', xml: artifact, zip: artifact, xsdEvidence: null })).toBe(true);
    expect(f.row.digestValue).toBe('NEW');
  });
  it.each(['complete', 'block', 'defer', 'heartbeat'] as const)('%s devuelve false si el CAS no afecta exactamente una fila', async method => {
    const f = fixture(); const claimed = (await f.repository.claim(f.row.id))!;
    const artifact = { storageKey: 'MOCK', sha256: 'MOCK', sizeBytes: 1 };
    for (const affected of [0, 2]) {
      f.prisma.$executeRawUnsafe.mockResolvedValueOnce(affected);
      const result = method === 'complete' ? await f.repository.complete(claimed, { digestValue: 'MOCK', xml: artifact, zip: artifact, xsdEvidence: null }) : await f.repository[method](claimed);
      expect(result).toBe(false);
    }
    expect(f.row.state).toBe('SIGNING');
  });
  it('worker que pierde el fencing en heartbeat deja de persistir y no bloquea al nuevo', async () => {
    const f = fixture(); const gate = deferred<typeof f.prepared>(); f.signer.prepare.mockReturnValueOnce(gate.promise);
    const processing = f.service.process(f.row.id); await vi.advanceTimersByTimeAsync(0);
    f.row.attempts = 2; f.row.claimedAt = new Date(Date.now());
    await vi.advanceTimersByTimeAsync(NOTES_QA_LEASE_MS / 4); gate.resolve(f.prepared); await processing;
    expect(f.row.state).toBe('SIGNING'); expect(f.row.attempts).toBe(2); expect(f.run).not.toHaveBeenCalled(); expect(f.store.put).not.toHaveBeenCalled(); expect(f.live.changed).not.toHaveBeenCalled();
    expect(f.secretBuffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
  });
  it('completion stale durante un await de artefacto no sobreescribe la prueba nueva', async () => {
    const f = fixture(); const gate = deferred<{ storageKey: string; sha256: string; sizeBytes: number }>();
    f.store.put.mockReturnValueOnce(gate.promise); const processing = f.service.process(f.row.id); await vi.advanceTimersByTimeAsync(0);
    expect(f.store.put).toHaveBeenCalledOnce();
    f.row.attempts = 2; f.row.state = 'SIGNED_LOCAL'; f.row.digestValue = 'NUEVO'; f.row.claimedAt = null;
    gate.resolve({ storageKey: 'OLD', sha256: createHash('sha256').update(f.prepared.xml).digest('hex'), sizeBytes: f.prepared.xml.length }); await processing;
    expect(f.row.state).toBe('SIGNED_LOCAL'); expect(f.row.digestValue).toBe('NUEVO'); expect(f.live.changed).not.toHaveBeenCalled();
  });
  it('sin confirmación del heartbeat deja expirar el lease para recuperación', async () => {
    const f = fixture(); f.prisma.$executeRawUnsafe.mockRejectedValueOnce(new Error('DB local no disponible')); await f.service.process(f.row.id);
    expect(f.row.state).toBe('SIGNING'); expect(f.vault.open).not.toHaveBeenCalled(); expect(f.live.changed).not.toHaveBeenCalled();
  });
  it.each(['complete', 'defer', 'block'] as const)('service respeta CAS fallido de %s sin publicar ni otra transición', async method => {
    const f = fixture(); const complete = vi.spyOn(f.repository, 'complete'); const block = vi.spyOn(f.repository, 'block'); const defer = vi.spyOn(f.repository, 'defer');
    ({ complete, block, defer })[method].mockResolvedValueOnce(false);
    if (method === 'defer') f.run.mockRejectedValueOnce(new LocalPreparationUnavailableError('XSD temporalmente no disponible'));
    if (method === 'block') f.run.mockRejectedValueOnce(new BadRequestException('XML inválido'));
    await f.service.process(f.row.id);
    expect(f.live.changed).not.toHaveBeenCalled(); expect(f.row.state).toBe('SIGNING');
    for (const [name, spy] of Object.entries({ complete, block, defer })) expect(spy).toHaveBeenCalledTimes(name === method ? 1 : 0);
  });
});

describe('guards QA y producción permanecen activos', () => {
  it.each(['NOTES_QA_ENABLED', 'LOCAL_XML_VALIDATION_ENABLED', 'FISCAL_CIRCUIT_QA_ENABLED'])('flag %s deshabilitado falla antes de claim', async flag => {
    const f = fixture(); vi.stubEnv(flag, 'false'); await expect(f.service.process(f.row.id)).rejects.toThrow('deshabilitadas');
    expect(f.prisma.$queryRawUnsafe).not.toHaveBeenCalled(); expect(f.vault.open).not.toHaveBeenCalled();
  });
  it('Beta real habilitada falla antes del claim', async () => {
    const f = fixture(); vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'true'); await expect(f.service.process(f.row.id)).rejects.toThrow('Beta real deshabilitada');
    expect(f.prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
  it.each(['production', 'real-ruc', 'certificate', 'snapshot'] as const)('contexto %s bloquea sin abrir certificado ni XSD', async violation => {
    const f = fixture();
    if (violation === 'production') f.original.environment = 'PRODUCTION';
    if (violation === 'real-ruc') f.original.issuer.identityNumber = '20123456789';
    if (violation === 'certificate') f.credentials.certificateSelfSigned = false;
    if (violation === 'snapshot') f.row.snapshot.totals.payableAmount = '999.00';
    await f.service.process(f.row.id); expect(f.row.state).toBe('BLOCKED'); expect(f.vault.open).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
});
