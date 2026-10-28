import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessError } from '@factuez/service-access';
import { CorporateDocumentService } from '../services/mailer-worker/src/corporate-document-service';
import { CorporateDocumentController } from '../services/mailer-worker/src/corporate-document-controller';
import { documentSendInput, documentActivationInput, documentJobView } from '../services/mailer-worker/src/corporate-document-policy';
import { documentConfigurationDigest as configurationDigest } from '../services/mailer-worker/src/corporate-document-policy';
import { documentSourceFixture, documentIssuer, documentActor, documentAuthorization, documentConfig } from './corporate-document.fixture';
beforeEach(() => { vi.stubEnv('SERVER_SMTP_ENABLED', 'true'); vi.stubEnv('SERVER_SMTP_DOCUMENTS_ENABLED', 'true'); vi.stubEnv('SMTP_APPROVED_HOSTS', documentConfig.host); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });
export function documentRuntimeFixture(type: '01' | '03' | '07' | '08' = '01') {
  const src = documentSourceFixture(type), row = { ...documentIssuer, revision: 1, keyVersion: 1, configurationCipher: 'v1.1.synthetic.cipher', updatedAt: new Date() };
  const snapshot = { issuer: documentIssuer, actorId: documentActor, row, config: documentConfig };
  const settings = { corporateAuthorization: vi.fn(async () => ({ issuer: documentIssuer, actorId: documentActor })),
    corporateSnapshot: vi.fn(async () => ({ ...snapshot, row: { ...row } })), status: vi.fn(async () => ({ revision: 1, integrity: 'VALID', hostnameApproved: true })) };
  const grant = { companyId: 1, issuerRuc: documentIssuer.ruc, revision: 1, configurationRevision: 1,
    configurationDigest: configurationDigest(row), enabled: true };
  const jobs = new Map<string, any>();
  const store = { ready: vi.fn(async () => true), activation: vi.fn(async () => ({ ...grant })),
    setActivation: vi.fn(async (_row, _actor, _rev, enabled) => ({ ...grant, enabled, revision: grant.revision + 1 })),
    prior: vi.fn(async (_issuer, _actor, key, request) => { const existing = [...jobs.values()].find(j => j.idempotencyHash === key);
      if (existing && existing.requestHash !== request) throw new AccessError(409, 'Conflict'); return existing ?? null; }),
    enqueue: vi.fn(async (input: any) => { const job = { ...input, companyId: 1, issuerRuc: documentIssuer.ruc, actorId: documentActor,
      configurationRevision: 1, configurationDigest: configurationDigest(row), state: 'QUEUED', createdAt: new Date(), expiresAt: new Date(Date.now() + 120000), finishedAt: null }; jobs.set(job.id, job); return job; }),
    claim: vi.fn(async id => { const j = jobs.get(id); if (!j || j.state !== 'QUEUED') return null; j.state = 'PREPARING'; return { ...j }; }),
    get: vi.fn(async id => jobs.get(id)), transition: vi.fn(async (id, from, to) => { const j = jobs.get(id); if (j.state !== from) return false;
      j.state = to; if (to !== 'SENDING') { j.payloadCipher = null; j.finishedAt = new Date(); } return true; }),
    history: vi.fn(async () => ({ jobs: [...jobs.values()], events: [] })),
  };
  const sealed = new Map<string, string>(), buffers: Buffer[] = [];
  const vault = { seal: vi.fn((bytes: Buffer, _context) => { const cipher = 'cipher:' + randomUUID(); sealed.set(cipher, bytes.toString()); buffers.push(bytes); return { cipher, keyVersion: 1 }; }),
    open: vi.fn((cipher: string, _context) => { const b = Buffer.from(sealed.get(cipher)!); buffers.push(b); return b; }) };
  const health = { ready: true };
  const smtp = { send: vi.fn(async (_config, _recipient, _id, _prepared, current, submitting) => { await current(); await submitting(); return { handedOffToSmtp: true, deliveredToClient: false }; }) };
  const source = src.source, prepare = vi.spyOn(source, 'prepare'), authorize = vi.spyOn(source, 'authorize');
  const service = new CorporateDocumentService(settings as never, store as never, vault as never, health as never, smtp as never, source);
  const body = { expectedRevision: 1, expectedActivationRevision: 1, recipient: 'recipient@example.invalid', documentId: src.id, format: 'a4', confirmed: true };
  return { src, row, settings, store, grant, jobs, vault, buffers, health, smtp, source, prepare, authorize, service, body, sealed,
    enqueue: (key = randomUUID()) => service.enqueue('1', body, key, documentAuthorization) };
}
describe('runtime documental efectivo PWA, aislado de TEST y B2B', () => {
  it.each(['01','03','07','08'] as const)('encola %s, worker obtiene PDF actual y originales, envía y cierra payload', async type => {
    const f = documentRuntimeFixture(type), result = await f.enqueue();
    expect(result).toMatchObject({ documentId: f.src.id, scope: 'DOCUMENT', state: 'QUEUED', deliveredToClient: false });
    expect(f.smtp.send).not.toHaveBeenCalled(); expect(f.prepare).toHaveBeenCalledOnce();
    f.src.files.get('a4')!.bytes = Buffer.from('%PDF-1.7 CURRENT AT WORKER TIME');
    await f.service.process(result.id);
    expect(f.prepare).toHaveBeenCalledTimes(2); expect(f.smtp.send).toHaveBeenCalledOnce();
    expect(f.smtp.send.mock.calls[0][3].attachments[0].content.toString()).toContain('CURRENT AT WORKER TIME');
    expect(f.jobs.get(result.id)).toMatchObject({ state: 'HANDED_OFF', payloadCipher: null });
    expect(documentJobView(f.jobs.get(result.id))).toMatchObject({ handedOffToSmtp: true, deliveredToClient: false, scope: 'DOCUMENT' });
    await f.service.process(result.id); expect(f.smtp.send).toHaveBeenCalledOnce();
    expect(f.buffers.every(b => b.every(n => n === 0))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/recipient@|PRIVATE|Bearer|cipher|documentProof/);
  });
  describe.each(['07', '08'] as const)('manifest documental de nota %s en worker', type => {
    it.each(['xml-and-zip', 'cdr-pair', 'snapshot', 'company', 'owner-manifest'])('cancela %s sin SMTP y cierra payload', async change => {
      const f = documentRuntimeFixture(type), job = await f.enqueue();
      if (change === 'xml-and-zip') {
        const bytes = Buffer.from('<Note>TAMPERED PAIR</Note>');
        f.src.files.get('xml')!.bytes = bytes;
        f.src.files.get('submission-zip')!.bytes = Buffer.from(f.src.zipSync({ [f.src.base + '.xml']: bytes }));
      }
      if (change === 'cdr-pair') {
        const bytes = Buffer.from('<ApplicationResponse>TAMPERED PAIR</ApplicationResponse>');
        f.src.files.get('cdr-xml')!.bytes = bytes;
        f.src.files.get('cdr-zip')!.bytes = Buffer.from(f.src.zipSync({ ['R-' + f.src.base + '.xml']: bytes }));
      }
      if (change === 'snapshot') f.src.doc.immutableSnapshot.totals.payableAmount = '11.00';
      if (change === 'company') f.src.doc.companyId = 2;
      if (change === 'owner-manifest') f.src.fetch.mockResolvedValue(new Response('PRIVATE manifest mismatch', { status: 409 }));
      await f.service.process(job.id);
      expect(f.smtp.send).not.toHaveBeenCalled();
      expect(f.jobs.get(job.id)).toMatchObject({ state: 'CANCELLED', payloadCipher: null });
    });
  });
  it('autoriza DOCUMENT separado sin enviar ni conceder B2B; TEST no participa', async () => {
    const f = documentRuntimeFixture();
    const result = await f.service.activate('1', { expectedRevision: 1, expectedActivationRevision: 0, enabled: true, confirmed: true }, documentAuthorization);
    expect(result).toMatchObject({ scope: 'DOCUMENT', b2bAuthorized: false, enabledForDocuments: true });
    expect(f.smtp.send).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled(); expect(f.store.enqueue).not.toHaveBeenCalled();
    f.grant.enabled = false; await expect(f.enqueue()).rejects.toMatchObject({ status: 409 });
    vi.stubEnv('SERVER_SMTP_DOCUMENTS_ENABLED', 'false');
    await f.service.activate('1', { expectedRevision: 1, expectedActivationRevision: 1, enabled: false, confirmed: true }, documentAuthorization);
    expect(f.store.setActivation).toHaveBeenLastCalledWith(f.row, documentActor, 1, false);
  });
  it.each(['SERVER_SMTP_ENABLED', 'SERVER_SMTP_DOCUMENTS_ENABLED'])('%s false deniega antes de adjuntos o jobs', async flag => {
    const f = documentRuntimeFixture(); vi.stubEnv(flag, 'false');
    await expect(f.enqueue()).rejects.toMatchObject({ status: 423 }); expect(f.prepare).not.toHaveBeenCalled(); expect(f.store.enqueue).not.toHaveBeenCalled();
  });
  it.each(['missing', 'disabled', 'old-config', 'old-grant', 'changed-cipher', 'queue'])('exige grant DOCUMENT y cola %s', async which => {
    const f = documentRuntimeFixture();
    if (which === 'missing') f.store.activation.mockResolvedValue(null as never);
    if (which === 'disabled') f.grant.enabled = false;
    if (which === 'old-config') f.grant.configurationRevision++;
    if (which === 'old-grant') f.grant.revision++;
    if (which === 'changed-cipher') f.row.configurationCipher += '.changed';
    if (which === 'queue') f.health.ready = false;
    await expect(f.enqueue()).rejects.toMatchObject({ status: which === 'queue' ? 503 : 409 }); expect(f.prepare).not.toHaveBeenCalled(); expect(f.store.enqueue).not.toHaveBeenCalled();
  });
  it('idempotencia devuelve misma tarea aun finalizada sin repetir preparación/envío', async () => {
    const f = documentRuntimeFixture(), key = randomUUID(), first = await f.enqueue(key);
    await f.service.process(first.id); const count = f.prepare.mock.calls.length;
    const repeated = await f.enqueue(key); expect(repeated.id).toBe(first.id); expect(f.prepare).toHaveBeenCalledTimes(count); expect(f.jobs.size).toBe(1);
    f.body.recipient = 'other@example.invalid'; await expect(f.enqueue(key)).rejects.toMatchObject({ status: 409 }); expect(f.smtp.send).toHaveBeenCalledOnce();
  });
  it.each(['identity', 'document', 'config'])('cambio %s durante preparación impide enqueue', async which => {
    const f = documentRuntimeFixture(), original = f.source.prepare.bind(f.source);
    f.prepare.mockImplementationOnce(async (...args) => { const p = await original(...args);
      if (which === 'identity') f.settings.corporateSnapshot.mockResolvedValue({ ...f.settings.corporateSnapshot.mock.results[0].value, actorId: 'other' } as never);
      if (which === 'document') f.src.doc.sunatStatus = 'REJECTED';
      if (which === 'config') f.row.configurationCipher += '.changed';
      return p;
    });
    await expect(f.enqueue()).rejects.toBeInstanceOf(Error); expect(f.store.enqueue).not.toHaveBeenCalled();
  });
  it.each(['revoked', 'grant', 'config', 'document', 'originals', 'expiry', 'ruc'])('worker deniega %s y no abre SMTP', async which => {
    const f = documentRuntimeFixture(), job = await f.enqueue();
    if (which === 'revoked') f.settings.corporateSnapshot.mockRejectedValue(new AccessError(401, 'Revoked'));
    if (which === 'grant') f.grant.revision++;
    if (which === 'config') f.row.configurationCipher += '.changed';
    if (which === 'document') f.src.doc.sunatStatus = 'REJECTED';
    if (which === 'originals') { const changed = Buffer.from('<Invoice>CHANGED</Invoice>'); f.src.files.get('xml')!.bytes = changed; f.src.files.get('submission-zip')!.bytes = Buffer.from(f.src.zipSync({ [f.src.base + '.xml']: changed })); }
    if (which === 'expiry') f.jobs.get(job.id).expiresAt = new Date(0);
    if (which === 'ruc') f.src.doc.immutableSnapshot.issuer.identityNumber = '00000000002';
    await f.service.process(job.id); expect(f.smtp.send).not.toHaveBeenCalled(); expect(f.jobs.get(job.id)).toMatchObject({ state: 'CANCELLED', payloadCipher: null });
  });
  it('revocación de documento durante preparación de worker cancela antes de SMTP', async () => {
    const f = documentRuntimeFixture(), job = await f.enqueue(), original = f.source.prepare.bind(f.source);
    f.prepare.mockImplementationOnce(async (...args) => { const result = await original(...args); f.src.doc.sunatStatus = 'REJECTED'; return result; });
    await f.service.process(job.id); expect(f.smtp.send).not.toHaveBeenCalled(); expect(f.jobs.get(job.id).state).toBe('CANCELLED');
  });
  it('resultado incierto no se reintenta y no filtra respuesta SMTP', async () => {
    const f = documentRuntimeFixture(), job = await f.enqueue();
    f.smtp.send.mockImplementationOnce(async (_c, _r, _id, _p, current, submitting) => { await current(); await submitting(); throw Error('PRIVATE recipient@example.invalid'); });
    await f.service.process(job.id); expect(f.jobs.get(job.id)).toMatchObject({ state: 'UNKNOWN', payloadCipher: null });
    await f.service.process(job.id); expect(f.smtp.send).toHaveBeenCalledOnce(); expect(JSON.stringify(documentJobView(f.jobs.get(job.id)))).not.toMatch(/PRIVATE|recipient@/);
  });
  it('estado usa lectura DOCUMENT sin SMTP ni preparación, incluso con flags false', async () => {
    const f = documentRuntimeFixture(); vi.stubEnv('SERVER_SMTP_DOCUMENTS_ENABLED', 'false');
    const view = await f.service.status('1', f.src.id, documentAuthorization);
    expect(view).toMatchObject({ scope: 'DOCUMENT', readyToSendDocument: false, b2bAuthorized: false, deliveredToClient: false });
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.smtp.send).not.toHaveBeenCalled(); expect(f.src.fetch).not.toHaveBeenCalled();
  });
  it('contrato estricto prohíbe adjuntos/contenido/flags de bypass y requiere idempotencia/confirmación', () => {
    const f = documentRuntimeFixture(); expect(documentSendInput(f.body, randomUUID())).toMatchObject({ documentId: f.src.id });
    for (const patch of [{ attachments: [] }, { subject: 'custom' }, { url: 'https://x.invalid' }, { confirmed: false }, { documentId: '../x' }, { format: 'xml' }, { expectedActivationRevision: '1' }])
      expect(() => documentSendInput({ ...f.body, ...patch }, randomUUID())).toThrow();
    expect(() => documentSendInput(f.body, undefined)).toThrow();
    expect(() => documentActivationInput({ expectedRevision: 1, expectedActivationRevision: 0, enabled: true, confirmed: true, test: true })).toThrow();
  });
  it('controlador usa rutas mail-settings separadas, no-store y sanea errores', async () => {
    expect(Reflect.getMetadata('path', CorporateDocumentController.prototype.enqueue)).toBe(':companyId/send-document');
    expect(Reflect.getMetadata('path', CorporateDocumentController.prototype.activate)).toBe(':companyId/document-activation');
    expect(Reflect.getMetadata('__headers__', CorporateDocumentController.prototype.enqueue)).toContainEqual({ name: 'Cache-Control', value: 'private, no-store' });
    const service = { enqueue: vi.fn().mockRejectedValue(Error('PRIVATE')) }, controller = new CorporateDocumentController(service as never);
    await expect(controller.enqueue('1', {}, { headers: { authorization: documentAuthorization, 'idempotency-key': 'synthetic' } })).rejects.toThrow('Correo documental no disponible');
  });
});
