import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FiscalCircuitQaService } from '../services/sunat-service/src/application/fiscal-circuit-qa.service';
import { LocalPreparationUnavailableError } from '../services/sunat-service/src/application/local-preparation-policy';
import { BoundedSoapAdapter, SoapSubmissionError } from '../services/sunat-service/src/infrastructure/sunat/bounded-soap.adapter';
const require = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const { zipSync } = require('fflate');
const { BadRequestException } = require('@nestjs/common');
const now = new Date('2026-10-02T22:10:00Z');
function fixture() {
  const documentId = randomUUID(); const ruc = '00000000001'; const xml = Buffer.from('MOCK-XML');
  const row = { id: randomUUID(), documentId, state: 'QUEUED', scenario: 'ACCEPTED', credentialRevision: 1,
    requestFileName: `${ruc}-01-FQ01-1.zip`, pollAttempts: 0, claimedAt: null as Date | null, nextPollAt: now,
    requestArtifact: { storageKey: 'zip' }, signedXmlArtifact: { storageKey: 'xml' }, documentXmlArtifact: { storageKey: 'xml' } };
  const table = { findUnique: vi.fn(async () => structuredClone(row)), updateMany: vi.fn(async ({ where, data }: { where: any; data: any }) => {
    if (where.state !== row.state || where.pollAttempts !== row.pollAttempts || (where.claimedAt && where.claimedAt.getTime() !== row.claimedAt?.getTime())) return { count: 0 };
    for (const [key, value] of Object.entries(data)) (row as any)[key] = (value as any)?.increment ? (row as any)[key] + (value as any).increment : value;
    return { count: 1 };
  }) };
  const prisma = { fiscalCircuitQa: table,
    fiscalDocument: { findUniqueOrThrow: vi.fn(async () => ({ environment: 'BETA', issuerRuc: ruc, status: 'BUILDING', immutablePayload: { documentId, documentTypeCode: '01' } })) },
    sunatCredentials: { findUnique: vi.fn(async () => ({ revision: 1, certificateSelfSigned: true, certificateExpiresAt: new Date('2030-01-01T00:00:00Z') })) } };
  const store = { read: vi.fn(async (_id: string, item: { storageKey: string }) => item.storageKey === 'zip' ? Buffer.from(zipSync({ [row.requestFileName.replace('.zip', '.xml')]: xml })) : xml) };
  const xsd = { validate: vi.fn(async () => ({ xmlSha256: 'MOCK-SHA', verifiedAt: now.toISOString() })) };
  const service = new FiscalCircuitQaService(prisma as never, {} as never, store as never, {} as never, {} as never, xsd as never);
  Object.assign(service, { live: { changed: vi.fn(async () => {}) } });
  return { row, table, xsd, service };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('FISCAL_CIRCUIT_QA_ENABLED', 'true'); vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'false'); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('SIN RED REAL'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('Circuito individual: recuperación sólo antes del POST', () => {
  it('XSD ocupado reencola antes del POST; resultado desconocido después detiene todo reenvío', async () => {
    const f = fixture(); f.xsd.validate.mockRejectedValueOnce(new LocalPreparationUnavailableError('XSD_BUSY'));
    const submit = vi.spyOn(BoundedSoapAdapter.prototype, 'submit').mockRejectedValue(new SoapSubmissionError('UNKNOWN', 'TIMEOUT'));
    await f.service.process(f.row.id); expect(f.row.state).toBe('QUEUED'); expect(submit).not.toHaveBeenCalled();
    await f.service.process(f.row.id); expect(f.xsd.validate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000); await f.service.process(f.row.id);
    expect(f.row.state).toBe('UNKNOWN'); expect(submit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000); await f.service.process(f.row.id); expect(submit).toHaveBeenCalledOnce();
  });
  it('XML inválido permanece bloqueado, no se relaja para enviar', async () => {
    const f = fixture(); f.xsd.validate.mockRejectedValue(new BadRequestException('XML inválido'));
    const submit = vi.spyOn(BoundedSoapAdapter.prototype, 'submit');
    await f.service.process(f.row.id); expect(f.row.state).toBe('BLOCKED'); expect(submit).not.toHaveBeenCalled();
  });
  it('un claim cambiado durante XSD impide que el worker viejo envíe o modifique el circuito', async () => {
    const f = fixture(); f.xsd.validate.mockImplementationOnce(async () => {
      f.row.claimedAt = new Date(now.getTime() + 1); f.row.pollAttempts = 1;
      return { xmlSha256: 'MOCK-SHA', verifiedAt: now.toISOString() };
    });
    const submit = vi.spyOn(BoundedSoapAdapter.prototype, 'submit'); await f.service.process(f.row.id);
    expect(f.row.state).toBe('SENDING'); expect(f.row.pollAttempts).toBe(1); expect(submit).not.toHaveBeenCalled();
  });
});
