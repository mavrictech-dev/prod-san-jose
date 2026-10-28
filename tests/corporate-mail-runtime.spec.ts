import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessError } from '@factuez/service-access';
import { CorporateMailService } from '../services/mailer-worker/src/corporate-mail.service';
import { CorporateMailSmtp } from '../services/mailer-worker/src/corporate-mail.transport';
import { CorporateMailController } from '../services/mailer-worker/src/corporate-mail.controller';
import { activationInput, activeGrant, configurationDigest, jobView, testInput } from '../services/mailer-worker/src/corporate-mail.policy';
import { EventEmitter } from 'node:events';
const issuer = { companyId: 1, ruc: '00000000001' }, actorId = '084a10ac-df2d-49f5-aa8a-9a784212e320';
const config = { host: 'smtp.corporativo.pe', port: 587 as const, tlsMode: 'STARTTLS' as const, fromName: 'Synthetic',
  fromAddress: 'synthetic@example.invalid', replyTo: null, username: 'PRIVATE-USER', password: 'PRIVATE-PASSWORD' };
const recipient = 'recipient@example.invalid', authorization = 'Bearer synthetic.token';
function fixture() {
  const row = { ...issuer, revision: 1, keyVersion: 1, configurationCipher: 'v1.1.synthetic.cipher', updatedAt: new Date() };
  const snapshot = { issuer, actorId, row, config };
  const grant = { companyId: 1, issuerRuc: issuer.ruc, revision: 1, configurationRevision: 1, configurationDigest: configurationDigest(row), enabled: true };
  const jobs = new Map<string, any>();
  const settings = { corporateAuthorization: vi.fn().mockResolvedValue({ issuer, actorId }), corporateSnapshot: vi.fn(async () => ({ ...snapshot, row: { ...row } })),
    status: vi.fn().mockResolvedValue({ revision: 1, integrity: 'VALID', hostnameApproved: true }),
    corporateRuntime: vi.fn().mockResolvedValue({ storageReady: true, readyToSendTest: true, scope: 'TEST_ONLY', b2bAuthorized: false, readyToSend: false }) };
  const health = { ready: true };
  const store = {
    activation: vi.fn(async () => ({ ...grant })), setActivation: vi.fn(),
    enqueue: vi.fn(async (input: any) => { const prior = [...jobs.values()].find(j => j.idempotencyHash === input.idempotencyHash);
      if (prior) { if (prior.requestHash !== input.requestHash) throw new AccessError(409, 'Conflict'); return prior; }
      const job = { ...input, ...issuer, issuerRuc: issuer.ruc, configurationRevision: row.revision, configurationDigest: configurationDigest(row),
        state: 'QUEUED', createdAt: new Date(), expiresAt: new Date(Date.now() + 120000), finishedAt: null }; jobs.set(job.id, job); return job; }),
    claim: vi.fn(async (id: string) => { const job = jobs.get(id); if (!job || job.state !== 'QUEUED') return null; job.state = 'PREPARING'; return { ...job }; }),
    get: vi.fn(async (id: string) => jobs.get(id)), history: vi.fn(async () => ({ jobs: [...jobs.values()], events: [] })),
    transition: vi.fn(async (id: string, from: string, to: string) => { const job = jobs.get(id); if (!job || job.state !== from) return false;
      job.state = to; if (to !== 'SENDING') { job.payloadCipher = null; job.finishedAt = new Date(); } return true; }),
  };
  const sealed = new Map<string, string>();
  const vault = { seal: vi.fn((bytes: Buffer, context: unknown) => { const cipher = 'encrypted:' + randomUUID(); sealed.set(cipher, bytes.toString()); return { cipher, keyVersion: 1 }; }),
    open: vi.fn((cipher: string) => Buffer.from(sealed.get(cipher)!)) };
  const smtp = { send: vi.fn(async (_config, _recipient, _id, current, submitting) => { await current(); await submitting(); return { handedOffToSmtp: true, deliveredToClient: false }; }) };
  const service = new CorporateMailService(settings as never, store as never, vault as never, health as never, smtp as never);
  const body = { expectedRevision: 1, expectedActivationRevision: 1, recipient, confirmed: true };
  return { service, settings, health, store, vault, smtp, jobs, row, grant, body, snapshot, sealed,
    enqueue: (key = randomUUID()) => service.sendTest('1', body, key, authorization) };
}
beforeEach(() => { vi.stubEnv('SERVER_SMTP_ENABLED', 'true'); vi.stubEnv('SMTP_APPROVED_HOSTS', config.host); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('correo corporativo PWA: consentimiento por RUC y trabajo duradero', () => {
  it('admite tarea, luego worker reautoriza y envía; nunca presenta SMTP aceptado como entrega', async () => {
    const f = fixture(), created = await f.enqueue();
    expect(created).toMatchObject({ state: 'QUEUED', deliveredToClient: false, handedOffToSmtp: false, scope: 'TEST_ONLY', attachments: false });
    expect(JSON.stringify(created)).not.toMatch(/recipient@|Bearer|PRIVATE|payloadCipher|idempotencyHash/);
    expect(f.smtp.send).not.toHaveBeenCalled();
    await f.service.process(created.id);
    expect(f.smtp.send).toHaveBeenCalledOnce(); expect(f.smtp.send.mock.calls[0][1]).toBe(recipient);
    expect(f.jobs.get(created.id)).toMatchObject({ state: 'HANDED_OFF', payloadCipher: null });
    expect(jobView(f.jobs.get(created.id))).toMatchObject({ handedOffToSmtp: true, deliveredToClient: false });
    await f.service.process(created.id); expect(f.smtp.send).toHaveBeenCalledOnce();
    expect(f.settings.corporateSnapshot).toHaveBeenCalledWith('1', authorization, 1);
  });
  it('sólo flag no concede envío: requiere grant exacto, cola y revisión', async () => {
    const f = fixture(); f.grant.enabled = false; await expect(f.enqueue()).rejects.toMatchObject({ status: 409 });
    f.grant.enabled = true; f.grant.configurationRevision = 2; await expect(f.enqueue()).rejects.toMatchObject({ status: 409 });
    f.grant.configurationRevision = 1; f.grant.configurationDigest = 'changed'; await expect(f.enqueue()).rejects.toMatchObject({ status: 409 });
    f.health.ready = false; await expect(f.enqueue()).rejects.toMatchObject({ status: 503 }); expect(f.store.enqueue).not.toHaveBeenCalled();
  });
  it.each(['false', '', 'TRUE', '1'])('SERVER_SMTP_ENABLED opt-in estricto: %s', async flag => {
    const f = fixture(); vi.stubEnv('SERVER_SMTP_ENABLED', flag);
    await expect(f.enqueue()).rejects.toMatchObject({ status: 423 }); expect(f.vault.seal).not.toHaveBeenCalled(); expect(f.smtp.send).not.toHaveBeenCalled();
  });
  it('activar es separado de guardar y de enviar, no concede B2B', async () => {
    const f = fixture();
    const result = await f.service.activate('1', { expectedRevision: 1, expectedActivationRevision: 0, enabled: true, confirmed: true }, authorization);
    expect(f.store.setActivation).toHaveBeenCalledWith(f.row, actorId, 0, true);
    expect(result).toMatchObject({ scope: 'TEST_ONLY', b2bAuthorized: false, readyToSend: false });
    expect(f.smtp.send).not.toHaveBeenCalled(); expect(f.store.enqueue).not.toHaveBeenCalled();
    vi.stubEnv('SERVER_SMTP_ENABLED', 'false');
    await f.service.activate('1', { expectedRevision: 1, expectedActivationRevision: 1, enabled: false, confirmed: true }, authorization);
    expect(f.store.setActivation).toHaveBeenLastCalledWith(f.row, actorId, 1, false);
  });
  it('no concede ni encola si sesión o configuración cambian durante preparación', async () => {
    const f = fixture(); f.settings.corporateSnapshot.mockResolvedValueOnce(f.snapshot).mockResolvedValueOnce({ ...f.snapshot, actorId: 'other' });
    await expect(f.enqueue()).rejects.toMatchObject({ status: 409 }); expect(f.store.enqueue).not.toHaveBeenCalled();
  });
  it('idempotencia estable devuelve la misma tarea; cambio de destinatario con misma key falla', async () => {
    const f = fixture(), key = randomUUID(), first = await f.enqueue(key), second = await f.enqueue(key);
    expect(second.id).toBe(first.id); expect(f.jobs.size).toBe(1);
    f.body.recipient = 'other@example.invalid'; await expect(f.enqueue(key)).rejects.toMatchObject({ status: 409 });
    await f.service.process(first.id); await f.service.process(second.id); expect(f.smtp.send).toHaveBeenCalledOnce();
  });
  it.each(['revoked', 'revision', 'grant', 'expiry', 'ruc'])('worker deniega %s antes de SMTP', async change => {
    const f = fixture(), job = await f.enqueue();
    if (change === 'revoked') f.settings.corporateSnapshot.mockRejectedValue(new AccessError(401, 'Revoked'));
    if (change === 'revision') f.row.configurationCipher = 'v1.1.new.cipher';
    if (change === 'grant') f.grant.revision++;
    if (change === 'expiry') f.jobs.get(job.id).expiresAt = new Date(0);
    if (change === 'ruc') f.settings.corporateSnapshot.mockResolvedValue({ ...f.snapshot, issuer: { companyId: 1, ruc: '00000000002' } });
    await f.service.process(job.id); expect(f.smtp.send).not.toHaveBeenCalled();
    expect(f.jobs.get(job.id)).toMatchObject({ state: 'CANCELLED', payloadCipher: null });
  });
  it('fallo después de cruzar SENDING queda UNKNOWN y nunca se reintenta', async () => {
    const f = fixture(), job = await f.enqueue();
    f.smtp.send.mockImplementationOnce(async (_c, _r, _id, current, submitting) => { await current(); await submitting(); throw new Error('PRIVATE SMTP response recipient@example.invalid'); });
    await f.service.process(job.id); expect(f.jobs.get(job.id)).toMatchObject({ state: 'UNKNOWN', payloadCipher: null });
    await f.service.process(job.id); expect(f.smtp.send).toHaveBeenCalledOnce();
    expect(JSON.stringify(jobView(f.jobs.get(job.id)))).not.toContain(recipient);
  });
  it('el worker detecta revocación tras preparar y antes de enviar', async () => {
    const f = fixture(), job = await f.enqueue();
    f.smtp.send.mockImplementationOnce(async (_c, _r, _id, current, submitting) => { f.grant.enabled = false; await current(); await submitting(); });
    await f.service.process(job.id); expect(f.jobs.get(job.id)).toMatchObject({ state: 'CANCELLED', payloadCipher: null });
  });
  it('AAD de payload queda ligado al RUC y al ID; token nunca va en respuesta o cola', async () => {
    const f = fixture(), job = await f.enqueue();
    expect(f.vault.seal.mock.calls[0][1]).toEqual({ ...issuer, field: 'corporate-test:' + job.id });
    await f.service.process(job.id); expect(f.vault.open).toHaveBeenCalledWith(expect.any(String), { ...issuer, field: 'corporate-test:' + job.id });
  });
  it('lectura no inicia red ni tareas y sanea errores de controlador', async () => {
    const f = fixture(); await f.service.status('1', authorization);
    expect(f.smtp.send).not.toHaveBeenCalled(); expect(f.store.enqueue).not.toHaveBeenCalled(); expect(f.store.setActivation).not.toHaveBeenCalled();
    const bad = new CorporateMailController({ sendTest: vi.fn().mockRejectedValue(Error('PRIVATE')) } as never);
    await expect(bad.sendTest('1', {}, { headers: {} })).rejects.toThrow('Correo corporativo no disponible');
    expect(Reflect.getMetadata('path', CorporateMailController.prototype.sendTest)).toBe(':companyId/send-test');
  });
});

describe('contratos estrictos de activación y envío', () => {
  it.each([{}, null, { expectedRevision: 1, expectedActivationRevision: 0, enabled: true, confirmed: false },
    { expectedRevision: '1', expectedActivationRevision: 0, enabled: true, confirmed: true },
    { expectedRevision: 1, expectedActivationRevision: 0, enabled: true, confirmed: true, b2b: true }])('rechaza activación %j', body => { expect(() => activationInput(body)).toThrow(); });
  it.each(['a@example.invalid,b@example.invalid', 'Name <a@example.invalid>', 'a@example.invalid\r\nBcc:b@x.invalid', '', 'a@b'])('rechaza destinatario %j', recipient => {
    expect(() => testInput({ expectedRevision: 1, expectedActivationRevision: 1, confirmed: true, recipient }, randomUUID())).toThrow();
  });
  it('rechaza adjuntos y sin confirmación/idempotencia', () => {
    const base = { expectedRevision: 1, expectedActivationRevision: 1, confirmed: true, recipient };
    for (const body of [{ ...base, attachments: [] }, { ...base, subject: 'x' }, { ...base, confirmed: false }]) expect(() => testInput(body, randomUUID())).toThrow();
    expect(() => testInput(base, undefined)).toThrow();
  });
});

describe('transporte de envío reutiliza política SMTP segura', () => {
  function transport() {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const mailer = { close: vi.fn(), sendMail: vi.fn(async (m: any) => ({ messageId: m.messageId, accepted: [recipient], rejected: [], response: '250 OK' })) };
    const io = { resolve: vi.fn().mockResolvedValue(['8.8.8.8']), connect: vi.fn(() => socket), createTransport: vi.fn((_o: any) => mailer) };
    return { smtp: new CorporateMailSmtp(io as never), io, socket, mailer, current: vi.fn().mockResolvedValue(undefined), submitting: vi.fn().mockResolvedValue(undefined) };
  }
  it('sendMail efectivo utiliza remitente guardado, no adjuntos ni verify ni datos de cliente', async () => {
    const f = transport(); expect(await f.smtp.send(config, recipient, randomUUID(), f.current, f.submitting)).toEqual({ handedOffToSmtp: true, deliveredToClient: false });
    expect(f.mailer.sendMail).toHaveBeenCalledOnce(); const message = f.mailer.sendMail.mock.calls[0][0];
    expect(message).toMatchObject({ from: { address: config.fromAddress }, to: recipient, envelope: { from: config.fromAddress, to: [recipient] } });
    expect(message).not.toHaveProperty('attachments'); expect(message).not.toHaveProperty('html');
    expect(f.io.createTransport.mock.calls[0][0]).toMatchObject({ host: '8.8.8.8', requireTLS: true, forceAuth: true, pool: false,
      tls: { servername: config.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, debug: false, logger: false });
    expect(f.current).toHaveBeenCalledTimes(4); expect(f.mailer.close).toHaveBeenCalledOnce();
  });
  it('DNS mixto/privado deniega envío', async () => {
    const f = transport(); f.io.resolve.mockResolvedValue(['8.8.8.8', '10.0.0.1']);
    await expect(f.smtp.send(config, recipient, randomUUID(), f.current, f.submitting)).rejects.toMatchObject({ status: 503 });
    expect(f.io.createTransport).not.toHaveBeenCalled(); expect(f.submitting).not.toHaveBeenCalled();
  });
  it('revocación durante DNS y tras preparación impide sendMail', async () => {
    const f = transport(); f.io.resolve.mockImplementationOnce(async () => { f.current.mockRejectedValue(new AccessError(401, 'Revoked')); return ['8.8.8.8']; });
    await expect(f.smtp.send(config, recipient, randomUUID(), f.current, f.submitting)).rejects.toMatchObject({ status: 401 }); expect(f.mailer.sendMail).not.toHaveBeenCalled();
    const g = transport(); g.current.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new AccessError(401, 'Revoked'));
    await expect(g.smtp.send(config, recipient, randomUUID(), g.current, g.submitting)).rejects.toMatchObject({ status: 401 }); expect(g.mailer.sendMail).not.toHaveBeenCalled();
  });
  it('timeout real cierra socket y transporte, sin repetición', async () => {
    vi.useFakeTimers(); const f = transport(); f.mailer.sendMail.mockImplementationOnce(() => new Promise(() => {}));
    const check = expect(f.smtp.send(config, recipient, randomUUID(), f.current, f.submitting)).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(15000); await check; expect(f.mailer.sendMail).toHaveBeenCalledOnce(); expect(f.mailer.close).toHaveBeenCalledOnce();
  });
});
