import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const access = vi.hoisted(() => ({ identity: vi.fn(), privateJson: vi.fn() }));
vi.mock('@factuez/service-access', async original => ({ ...await original<typeof import('@factuez/service-access')>(), ...access }));
import { AccessError } from '@factuez/service-access';
import { SmtpLiveDiagnostic, diagnosticPublicIpv4, type SmtpDiagnosticNetwork } from '../services/mailer-worker/src/smtp-live-diagnostic';
import { SmtpConfigurationService } from '../services/mailer-worker/src/smtp-configuration.service';
import { SmtpConfigurationController } from '../services/mailer-worker/src/smtp-configuration.module';
import { PreparedCorporateSmtp } from '../services/mailer-worker/src/smtp-configuration.transport';

const issuer = { companyId: 1, ruc: '00000000001' };
const admin = { sub: 'synthetic-admin', roles: ['ADMIN'], scope: { kind: 'GLOBAL' } };
const auth = 'Bearer synthetic-token';
const config = { host: 'smtp.corporativo.pe', port: 587, tlsMode: 'STARTTLS', fromName: 'QA',
  fromAddress: 'qa@example.invalid', replyTo: null, username: 'PRIVATE-USER', password: 'PRIVATE-PASSWORD' };
beforeEach(() => {
  vi.stubEnv('SMTP_APPROVED_HOSTS', config.host);
  vi.stubEnv('SMTP_CONNECTION_DIAGNOSTICS_ENABLED', 'true');
  access.identity.mockReset().mockResolvedValue(admin);
  access.privateJson.mockReset().mockResolvedValue({ companies: [{ id: 1, ruc: issuer.ruc }, { id: 2, ruc: '00000000002' }] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function fixture(configuration = config) {
  const row = { ...issuer, revision: 1, keyVersion: 1, configurationCipher: 'v1.1.synthetic.cipher', updatedAt: new Date() };
  const store = { read: vi.fn(async () => ({ ...row })), save: vi.fn(), ready: vi.fn().mockResolvedValue(true) };
  const buffers: Buffer[] = [];
  const vault = { open: vi.fn(() => { const buffer = Buffer.from(JSON.stringify(configuration)); buffers.push(buffer); return buffer; }), seal: vi.fn() };
  const mailer = { verify: vi.fn().mockResolvedValue(true), close: vi.fn(), sendMail: vi.fn() };
  const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const io = { resolve: vi.fn().mockResolvedValue(['8.8.8.8']), createTransport: vi.fn((_options: Parameters<SmtpDiagnosticNetwork['createTransport']>[0]) => mailer), connect: vi.fn((_options: Parameters<SmtpDiagnosticNetwork['connect']>[0]) => socket) };
  const diagnostic = new SmtpLiveDiagnostic(io as never);
  const service = new SmtpConfigurationService(store as never, vault as never, new PreparedCorporateSmtp(), diagnostic);
  return { service, diagnostic, io, row, store, vault, mailer, socket, buffers,
    check: (body: unknown = { expectedRevision: 1 }) => service.verifyConnection('1', body, auth) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe('API de conexión SMTP, sin mensajes ni persistencia', () => {
  it('verifica DNS/TLS/AUTH de la misma revisión con identidad viva, sin secretos ni habilitar envío', async () => {
    const f = fixture();
    const response = await f.check();
    expect(response).toMatchObject({ ...issuer, revision: 1, state: 'EXTERNAL_SMTP_DISABLED', connectionVerified: true,
      networkAttempted: true, dnsValidated: true, tlsVerified: true, smtpAuthenticationVerified: true, readyToSend: false, deliveredToClient: false });
    expect(access.identity).toHaveBeenCalledTimes(4);
    expect(access.identity).toHaveBeenCalledWith(auth, 'document.email');
    expect(access.privateJson).toHaveBeenCalledTimes(4);
    expect(f.io.resolve).toHaveBeenCalledExactlyOnceWith(config.host);
    expect(f.mailer.verify).toHaveBeenCalledOnce(); expect(f.mailer.close).toHaveBeenCalledOnce();
    expect(f.store.save).not.toHaveBeenCalled(); expect(f.vault.seal).not.toHaveBeenCalled(); expect(f.mailer.sendMail).not.toHaveBeenCalled();
    expect(f.buffers.every(b => b.every(value => value === 0))).toBe(true);
    expect(JSON.stringify(response)).not.toMatch(/PRIVATE|cipher|Bearer|8.8.8.8/);
    expect(f.io.createTransport.mock.calls[0][0]).toMatchObject({ host: '8.8.8.8', port: 587, secure: false, requireTLS: true,
      ignoreTLS: false, opportunisticTLS: false, forceAuth: true, pool: false, logger: false, debug: false,
      tls: { servername: config.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' } });
  });
  it('mantiene TLS obligatorio en 465', async () => {
    const f = fixture({ ...config, port: 465, tlsMode: 'TLS' }); await f.check();
    expect(f.io.createTransport.mock.calls[0][0]).toMatchObject({ port: 465, secure: true, forceAuth: true, requireTLS: true, tls: { rejectUnauthorized: true } });
  });
  it.each([undefined, '', 'false', '1', 'TRUE'])('gate opt-in estricto: %s no abre secretos ni DNS', async flag => {
    if (flag === undefined) delete process.env.SMTP_CONNECTION_DIAGNOSTICS_ENABLED; else vi.stubEnv('SMTP_CONNECTION_DIAGNOSTICS_ENABLED', flag);
    const f = fixture(); await expect(f.check()).rejects.toMatchObject({ status: 423 });
    expect(f.store.read).not.toHaveBeenCalled(); expect(f.vault.open).not.toHaveBeenCalled(); expect(f.io.resolve).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { expectedRevision: '1' }, { expectedRevision: 0 }, { expectedRevision: -1 }, { expectedRevision: 1.5 },
    { expectedRevision: 2147483648 }, { expectedRevision: 1, host: 'smtp.other.pe' }, { expectedRevision: 1, recipient: 'x@example.invalid' },
    { expectedRevision: 1, credentials: {} }, { expectedRevision: 1, sendMail: true }])('rechaza body ajeno al contrato %j', async body => {
    const f = fixture(); await expect(f.check(body)).rejects.toMatchObject({ status: 400 });
    expect(access.identity).not.toHaveBeenCalled(); expect(f.vault.open).not.toHaveBeenCalled(); expect(f.io.resolve).not.toHaveBeenCalled();
  });
  it.each([{ ...admin, roles: ['CASHIER'] }, { ...admin, scope: { kind: 'ASSIGNED' } }])('rechaza no ADMIN/GLOBAL antes de secretos y red', async user => {
    const f = fixture(); access.identity.mockResolvedValue(user); await expect(f.check()).rejects.toMatchObject({ status: 403 });
    expect(f.store.read).not.toHaveBeenCalled(); expect(f.vault.open).not.toHaveBeenCalled(); expect(f.io.resolve).not.toHaveBeenCalled();
  });
  it('rechaza sesión revocada y Billing sin RUC válido antes de abrir secretos', async () => {
    const f = fixture(); access.identity.mockRejectedValueOnce(new AccessError(401, 'Revocado'));
    await expect(f.check()).rejects.toMatchObject({ status: 401 });
    access.privateJson.mockResolvedValue({ companies: [{ id: 1, ruc: 'invalid' }] });
    await expect(f.check()).rejects.toMatchObject({ status: 404 }); expect(f.vault.open).not.toHaveBeenCalled(); expect(f.io.resolve).not.toHaveBeenCalled();
  });
  it('no admite capacidad B2B como autorización de diagnóstico', async () => {
    const f = fixture(); await expect(f.service.verifyConnection('1', { expectedRevision: 1 }, {} as never)).rejects.toMatchObject({ status: 403 });
    expect(f.store.read).not.toHaveBeenCalled(); expect(f.io.resolve).not.toHaveBeenCalled();
  });
  it('rechaza revisión vieja, otro RUC, tombstone y configuración corrupta', async () => {
    const f = fixture(); await expect(f.check({ expectedRevision: 2 })).rejects.toMatchObject({ status: 409 });
    expect(f.vault.open).not.toHaveBeenCalled();
    f.row.ruc = '00000000002'; await expect(f.check()).rejects.toMatchObject({ status: 503 });
    expect(f.io.resolve).not.toHaveBeenCalled();
    const removed = fixture(); removed.vault.open.mockReturnValue(Buffer.from('{"removed":true}'));
    await expect(removed.check()).rejects.toMatchObject({ status: 409 }); expect(removed.io.resolve).not.toHaveBeenCalled();
    const corrupt = fixture(); corrupt.vault.open.mockReturnValue(Buffer.from('invalid-json'));
    await expect(corrupt.check()).rejects.toMatchObject({ status: 503 }); expect(corrupt.io.resolve).not.toHaveBeenCalled();
  });
  it('revalida Identity después de leer antes de abrir el secreto', async () => {
    const f = fixture(); access.identity.mockResolvedValueOnce(admin).mockRejectedValue(new AccessError(401, 'Revocado'));
    await expect(f.check()).rejects.toMatchObject({ status: 401 }); expect(f.vault.open).not.toHaveBeenCalled(); expect(f.io.resolve).not.toHaveBeenCalled();
  });
  it.each(['revision', 'cipher', 'revocation', 'issuer', 'allowlist', 'gate'])('deniega cambio durante DNS: %s antes de crear transporte', async change => {
    const f = fixture(); f.io.resolve.mockImplementation(async () => {
      if (change === 'revision') f.row.revision++;
      if (change === 'cipher') f.row.configurationCipher += '.replacement';
      if (change === 'revocation') access.identity.mockRejectedValue(new AccessError(401, 'Revocado'));
      if (change === 'issuer') access.privateJson.mockResolvedValue({ companies: [{ id: 1, ruc: '00000000009' }] });
      if (change === 'allowlist') vi.stubEnv('SMTP_APPROVED_HOSTS', 'other.example.org');
      if (change === 'gate') vi.stubEnv('SMTP_CONNECTION_DIAGNOSTICS_ENABLED', 'false');
      return ['8.8.8.8'];
    });
    await expect(f.check()).rejects.toBeInstanceOf(AccessError); expect(f.io.createTransport).not.toHaveBeenCalled(); expect(f.io.connect).not.toHaveBeenCalled();
  });
  it.each(['revision', 'cipher', 'revocation', 'issuer', 'gate'])('deniega cambio durante SMTP: %s también tras resultado', async change => {
    const f = fixture(); f.mailer.verify.mockImplementation(async () => {
      if (change === 'revision') f.row.revision++;
      if (change === 'cipher') f.row.configurationCipher += '.replacement';
      if (change === 'revocation') access.identity.mockRejectedValue(new AccessError(401, 'Revocado'));
      if (change === 'issuer') access.privateJson.mockResolvedValue({ companies: [{ id: 1, ruc: '00000000009' }] });
      if (change === 'gate') vi.stubEnv('SMTP_CONNECTION_DIAGNOSTICS_ENABLED', 'false');
      return true;
    });
    await expect(f.check()).rejects.toBeInstanceOf(AccessError); expect(f.mailer.close).toHaveBeenCalledOnce(); expect(f.store.save).not.toHaveBeenCalled();
  });
  it('sanitiza error DNS y SMTP, revalida incluso ante fallo y nunca envía', async () => {
    const f = fixture(); f.io.resolve.mockRejectedValueOnce(new Error('PRIVATE-DNS'));
    await expect(f.check()).rejects.toThrow('No se pudo verificar');
    f.mailer.verify.mockRejectedValueOnce(new Error('PRIVATE-PASSWORD'));
    await expect(f.check()).rejects.toThrow('No se pudo verificar');
    expect(f.mailer.sendMail).not.toHaveBeenCalled(); expect(access.identity).toHaveBeenCalledTimes(7);
    f.mailer.verify.mockImplementationOnce(async () => { access.identity.mockRejectedValue(new AccessError(401, 'Revocado')); throw Error('PRIVATE'); });
    await expect(f.check()).rejects.toMatchObject({ status: 401 });
  });
  it('verify false no produce éxito de autenticación', async () => {
    const f = fixture(); f.mailer.verify.mockResolvedValue(false); await expect(f.check()).rejects.toMatchObject({ status: 503 });
  });
  it('controlador expone ruta POST con no-store y sanea errores desconocidos', async () => {
    expect(Reflect.getMetadata('path', SmtpConfigurationController.prototype.verifyConnection)).toBe(':companyId/verify-connection');
    expect(Reflect.getMetadata('method', SmtpConfigurationController.prototype.verifyConnection)).toBe(1);
    expect(Reflect.getMetadata('__headers__', SmtpConfigurationController.prototype.verifyConnection)).toContainEqual({ name: 'Cache-Control', value: 'private, no-store' });
    const service = { verifyConnection: vi.fn().mockRejectedValue(new Error('PRIVATE-PASSWORD')) };
    const controller = new SmtpConfigurationController(service as never);
    await expect(controller.verifyConnection('1', { expectedRevision: 1 }, { headers: { authorization: auth } })).rejects.toThrow('Configuración SMTP no disponible');
    expect(service.verifyConnection).toHaveBeenCalledWith('1', { expectedRevision: 1 }, auth);
  });
});

describe('DNS público fijado y límites de red', () => {
  it.each(['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '192.0.0.9', '192.0.2.1', '192.88.99.1', '198.18.1.1', '198.19.1.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '::1', '::ffff:8.8.8.8', 'https://example.org', '08.8.8.8'])('rechaza dirección privada/reservada/multicast %s', async ip => {
    expect(diagnosticPublicIpv4(ip)).toBe(false);
    const f = fixture(); f.io.resolve.mockResolvedValue(['8.8.8.8', ip]);
    await expect(f.check()).rejects.toMatchObject({ status: 503 }); expect(f.io.createTransport).not.toHaveBeenCalled();
  });
  it.each([[], Array(33).fill('8.8.8.8')])('deniega DNS vacío o excesivo', async addresses => {
    const f = fixture(); f.io.resolve.mockResolvedValue(addresses); await expect(f.check()).rejects.toMatchObject({ status: 503 }); expect(f.io.connect).not.toHaveBeenCalled();
  });
  it.each(['http://smtp.corporativo.pe', '8.8.8.8', 'other.example.org'])('no acepta URL/IP/host sin aprobación: %s', async host => {
    const f = fixture({ ...config, host }); await expect(f.check()).rejects.toBeInstanceOf(AccessError); expect(f.io.resolve).not.toHaveBeenCalled();
  });
  it('socket y callback lookup fijan una sola IP pública; cierra sin duplicar callback', async () => {
    const f = fixture(); f.mailer.verify.mockImplementationOnce(async () => {
      const options: any = f.io.createTransport.mock.calls[0][0]; const callback = vi.fn();
      options.getSocket(options, callback);
      expect(f.io.connect).toHaveBeenCalledWith(expect.objectContaining({ host: '8.8.8.8', port: 587, family: 4 }));
      const pinned: any = f.io.connect.mock.calls[0][0]; const resolved = vi.fn();
      pinned.lookup('untrusted.example.org', {}, resolved); expect(resolved).toHaveBeenLastCalledWith(null, '8.8.8.8', 4);
      pinned.lookup('untrusted.example.org', { all: true }, resolved); expect(resolved).toHaveBeenLastCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
      f.socket.emit('connect'); await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce()); f.socket.emit('error', new Error('PRIVATE'));
      expect(callback).toHaveBeenCalledOnce(); expect(callback).toHaveBeenCalledWith(null, { connection: f.socket });
      return true;
    }); await f.check(); expect(f.socket.destroy).toHaveBeenCalledOnce();
  });
  it('revocación durante TCP impide entregar el socket para TLS', async () => {
    const f = fixture(); f.mailer.verify.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      const options: any = f.io.createTransport.mock.calls[0][0];
      options.getSocket(options, (error: unknown) => { if (error) reject(error); else reject(new Error('TLS must not start')); });
      access.identity.mockRejectedValue(new AccessError(401, 'Revocado'));
      f.socket.emit('connect');
    }));
    await expect(f.check()).rejects.toMatchObject({ status: 401 }); expect(f.socket.destroy).toHaveBeenCalled();
  });
  it('tiempo de autorización inicial se descuenta del límite de 15 segundos', async () => {
    vi.useFakeTimers(); const f = fixture(), authorized = deferred<typeof admin>();
    access.identity.mockReturnValueOnce(authorized.promise);
    f.io.resolve.mockReturnValue(new Promise(() => {}));
    const outcome = expect(f.check()).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(10000); authorized.resolve(admin); await vi.advanceTimersByTimeAsync(5000); await outcome;
    expect(f.io.createTransport).not.toHaveBeenCalled();
  });
  it('lectura pendiente caduca sin abrir el secreto cuando termina tarde', async () => {
    vi.useFakeTimers(); const f = fixture(), read = deferred<typeof f.row>(); f.store.read.mockReturnValueOnce(read.promise);
    const outcome = expect(f.check()).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(15000); await outcome; read.resolve(f.row); await vi.advanceTimersByTimeAsync(1);
    expect(f.vault.open).not.toHaveBeenCalled(); expect(f.io.resolve).not.toHaveBeenCalled();
  });
  it('límite total cancela DNS pendiente y no continúa a secretos ni SMTP después', async () => {
    vi.useFakeTimers(); const f = fixture(), dns = deferred<readonly string[]>(); f.io.resolve.mockReturnValue(dns.promise as never);
    const outcome = expect(f.check()).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(15000); await outcome;
    dns.resolve(['8.8.8.8']); await vi.advanceTimersByTimeAsync(1);
    expect(f.io.createTransport).not.toHaveBeenCalled(); expect(f.io.connect).not.toHaveBeenCalled();
  });
  it('límite total destruye socket de verify pendiente y libera capacidad', async () => {
    vi.useFakeTimers(); const f = fixture();
    f.mailer.verify.mockImplementationOnce(() => {
      const options: any = f.io.createTransport.mock.calls[0][0]; options.getSocket(options, vi.fn()); return new Promise(() => {});
    });
    const outcome = expect(f.check()).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(15000); await outcome;
    expect(f.socket.destroy).toHaveBeenCalledOnce(); expect(f.mailer.close).toHaveBeenCalledOnce();
    f.socket.emit('connect'); // A late connection cannot escape the expired scope.
    await expect(f.diagnostic.run('another', '00000000002', async scope => { scope.check(); return true; })).resolves.toBe(true);
    expect(f.mailer.sendMail).not.toHaveBeenCalled();
  });
  it('concurrencia máxima dos sin cola', async () => {
    const f = fixture(), first = deferred<void>(), second = deferred<void>();
    const a = f.diagnostic.run('one', '00000000001', () => first.promise);
    const b = f.diagnostic.run('two', '00000000002', () => second.promise);
    await expect(f.diagnostic.run('three', '00000000003', async () => {})).rejects.toMatchObject({ status: 429 });
    first.resolve(); second.resolve(); await Promise.all([a, b]);
    await expect(f.diagnostic.run('three', '00000000003', async () => true)).resolves.toBe(true);
  });
  it('rate limit por RUC independiente del usuario y por sujeto independiente del RUC; vence al minuto', async () => {
    vi.useFakeTimers(); const f = fixture();
    for (let n = 0; n < 3; n++) await f.diagnostic.run('user' + n, issuer.ruc, async () => {});
    await expect(f.diagnostic.run('other', issuer.ruc, async () => {})).rejects.toMatchObject({ status: 429 });
    for (let n = 0; n < 6; n++) await f.diagnostic.run('same-user', 'ruc' + n, async () => {});
    await expect(f.diagnostic.run('same-user', 'new-ruc', async () => {})).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(60000);
    await expect(f.diagnostic.run('same-user', issuer.ruc, async () => true)).resolves.toBe(true);
  });
});
