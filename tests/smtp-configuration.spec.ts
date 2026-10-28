import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({
  key: 'a1'.repeat(32), keySize: 64, keyMode: 0o600, keyIsFile: true, readFails: false,
  identity: vi.fn(), privateJson: vi.fn(), createTransport: vi.fn(),
}));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(),
  openSync: () => { if (mocks.readFails) throw new Error('PRIVATE_PATH_MUST_NOT_LEAK'); return 123; },
  fstatSync: () => ({ isFile: () => mocks.keyIsFile, size: mocks.keySize, mode: mocks.keyMode }),
  readSync: (_fd: number, target: Buffer) => { const bytes = Buffer.from(mocks.key); bytes.copy(target); return bytes.length; },
  closeSync: () => {},
}));
vi.mock('@factuez/service-access', async original => ({ ...await original<typeof import('@factuez/service-access')>(), identity: mocks.identity, privateJson: mocks.privateJson }));
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.createTransport } }));

import { AccessError } from '@factuez/service-access';
import { SmtpConfigurationVault } from '../services/mailer-worker/src/smtp-configuration.crypto';
import { approvedSmtpHosts, corporateSmtpTransportOptions, parseSmtpInput, smtpHostname, smtpMailbox } from '../services/mailer-worker/src/smtp-configuration.policy';
import { SmtpConfigurationService } from '../services/mailer-worker/src/smtp-configuration.service';
import { SmtpConfigurationStore, type StoredSmtpConfiguration } from '../services/mailer-worker/src/smtp-configuration.store';
import { PreparedCorporateSmtp } from '../services/mailer-worker/src/smtp-configuration.transport';
import { SmtpConfigurationController } from '../services/mailer-worker/src/smtp-configuration.module';
import type { PrismaService } from '../services/mailer-worker/src/prisma.service';

const issuer = { companyId: 1, ruc: '00000000001' };
const context = { ...issuer, field: 'configuration' as const };
const admin = { sub: '084a10ac-df2d-49f5-aa8a-9a784212e320', roles: ['ADMIN'], scope: { kind: 'GLOBAL' } };
const settings = { host: 'smtp.corporativo.pe', port: 587 as const, tlsMode: 'STARTTLS' as const, fromName: 'Emisor ficticio', fromAddress: 'facturacion@pruebas.invalid', replyTo: null };
const credentials = { username: 'UsuarioSMTP-NoDebeVolver', password: 'PasswordSMTP-NoDebeVolver' };
const input = { expectedRevision: 0, settings, credentials };
const authorization = 'Bearer QA.token';

beforeEach(() => {
  vi.stubEnv('MAILER_DATABASE_NAME', 'factuez_mailer_qa');
  vi.stubEnv('DB_NAME', 'factuez_mailer_qa');
  vi.clearAllMocks();
  vi.stubEnv('SMTP_SETTINGS_KEY_FILE', resolve('smtp-qa-key-test-fixture'));
  vi.stubEnv('SMTP_SETTINGS_KEY_VERSION', '1'); vi.stubEnv('SMTP_APPROVED_HOSTS', 'smtp.corporativo.pe');
  mocks.key = 'a1'.repeat(32); mocks.keySize = 64; mocks.keyMode = 0o600; mocks.keyIsFile = true; mocks.readFails = false;
  mocks.identity.mockResolvedValue(admin);
  mocks.privateJson.mockResolvedValue({ companies: [{ id: 1, ruc: issuer.ruc }, { id: 2, ruc: '00000000002' }] });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function fixture() {
  const vault = new SmtpConfigurationVault();
  const rows = new Map<string, StoredSmtpConfiguration>();
  const store = {
    ready: vi.fn().mockResolvedValue(true),
    read: vi.fn(async (target: typeof issuer) => rows.get(target.ruc) ?? null),
    save: vi.fn(async (target: typeof issuer, sealed: { cipher: string; keyVersion: number }, expected: number) => {
      if ((rows.get(target.ruc)?.revision ?? 0) !== expected) throw new AccessError(409, 'La configuración SMTP cambió');
      const row = { ...target, configurationCipher: sealed.cipher, keyVersion: sealed.keyVersion, revision: expected + 1, updatedAt: new Date() };
      rows.set(target.ruc, row); return row;
    }),
  };
  return { service: new SmtpConfigurationService(store as unknown as SmtpConfigurationStore, vault, new PreparedCorporateSmtp()), store, vault, rows };
}

describe('bóveda SMTP vinculada al emisor', () => {
  it('usa IV aleatorio y AES-256-GCM sin persistir texto plano', () => {
    const vault = new SmtpConfigurationVault(); const bytes = Buffer.from(JSON.stringify(credentials));
    const first = vault.seal(bytes, context); const second = vault.seal(bytes, context);
    expect(first.cipher).not.toEqual(second.cipher); expect(first.cipher).not.toContain(credentials.password);
    expect(first.cipher.split('.')[2]).toHaveLength(16); expect(first.cipher.split('.')[3]).toHaveLength(22);
    expect(vault.open(first.cipher, context)).toEqual(bytes);
  });
  it('rechaza otro RUC, emisor o campo aun usando la misma clave', () => {
    const vault = new SmtpConfigurationVault(); const { cipher } = vault.seal(Buffer.from('secret'), context);
    for (const changed of [{ ...context, ruc: '00000000002' }, { ...context, companyId: 2 }, { ...context, field: 'password' }])
      expect(() => vault.open(cipher, changed as never)).toThrow('Integridad');
  });
  it('rechaza ciphertext, IV y tag alterados o truncados', () => {
    const vault = new SmtpConfigurationVault(); const { cipher } = vault.seal(Buffer.from('secret'), context);
    for (const index of [2, 3, 4]) {
      const parts = cipher.split('.'); parts[index] = `${parts[index][0] === 'A' ? 'B' : 'A'}${parts[index].slice(1)}`;
      expect(() => vault.open(parts.join('.'), context)).toThrow('Integridad');
    }
    for (const invalid of [cipher + '.extra', 'v1.1.bad.bad.bad', cipher.slice(0, 15), 'x'.repeat(6000)]) expect(() => vault.open(invalid, context)).toThrow('Integridad');
  });
  it('no usa otra clave ni versión como fallback', () => {
    const vault = new SmtpConfigurationVault(); const { cipher } = vault.seal(Buffer.from('secret'), context);
    mocks.key = 'b2'.repeat(32); expect(() => vault.open(cipher, context)).toThrow('Integridad');
    mocks.key = 'a1'.repeat(32); vi.stubEnv('SMTP_SETTINGS_KEY_VERSION', '2'); expect(() => vault.open(cipher, context)).toThrow('Integridad');
  });
  it('falla cerrado sin archivo/clave válida y no revela rutas o contenido', () => {
    const vault = new SmtpConfigurationVault(); vi.stubEnv('SMTP_SETTINGS_KEY_FILE', '');
    expect(vault.readiness()).toBe('MISSING'); expect(() => vault.seal(Buffer.from('secret'), context)).toThrow('no configurado');
    vi.stubEnv('SMTP_SETTINGS_KEY_FILE', resolve('smtp-qa-key-test-fixture'));
    mocks.readFails = true; expect(vault.readiness()).toBe('INVALID');
    expect(() => vault.open('v1.1.a.b.c', context)).toThrow('no disponible o inválida');
    mocks.readFails = false; mocks.key = 'bad'; expect(vault.readiness()).toBe('INVALID');
    mocks.key = 'a1'.repeat(32); mocks.keySize = 129; expect(vault.readiness()).toBe('INVALID');
    mocks.keySize = 64; mocks.keyIsFile = false; expect(vault.readiness()).toBe('INVALID');
  });
  it('acota el tamaño de entrada y valida contexto/version de clave', () => {
    const vault = new SmtpConfigurationVault();
    expect(() => vault.seal(Buffer.alloc(4097), context)).toThrow();
    expect(() => vault.seal(Buffer.from('secret'), { ...context, ruc: '123' })).toThrow('Contexto');
    vi.stubEnv('SMTP_SETTINGS_KEY_VERSION', '0'); expect(vault.readiness()).toBe('INVALID');
  });
});

describe('política y adaptador corporativo preparado', () => {
  it('no admite IPs, URL, hostname interno, comodines ni lista inválida', () => {
    for (const host of ['127.0.0.1', '10.0.0.1', '[::1]', 'mailpit', 'mailpit.local', 'localhost.pe', 'metadata.google.internal', 'http://smtp.corporativo.pe', '*.corporativo.pe', 'smtp.corporativo.pe.', 'smtp.corporativo.pe\r\n']) expect(smtpHostname(host)).toBe(false);
    expect(approvedSmtpHosts('smtp.corporativo.pe,*.pe')).toEqual([]);
    expect(approvedSmtpHosts('smtp.corporativo.pe,smtp.corporativo.pe')).toEqual(['smtp.corporativo.pe']);
    expect(approvedSmtpHosts()).toEqual(['smtp.corporativo.pe']);
  });
  it('rechaza puerto inseguro, rebaja TLS, flags de activación y overrides', () => {
    for (const body of [{ ...input, enabled: true }, { ...input, settings: { ...settings, port: 25 } },
      { ...input, settings: { ...settings, tlsMode: 'TLS' } }, { ...input, settings: { ...settings, rejectUnauthorized: false } },
      { ...input, settings: { ...settings, url: 'smtps://arbitrary' } }, { ...input, credentials: { ...credentials, password: 'line\r\n' } }]) expect(() => parseSmtpInput(body)).toThrow();
  });
  it('rechaza listas de remitentes y cabeceras inyectadas', () => {
    for (const address of ['a@pe', 'a@b.pe,b@b.pe', 'Nombre <a@b.pe>', 'a@b.pe\r\nBcc:x@y.pe', 'a@b.pe;']) expect(smtpMailbox(address)).toBe(false);
    expect(smtpMailbox('facturacion@pruebas.invalid')).toBe(true);
  });
  it('prepara TLS estricto con STARTTLS obligatorio y límites sin log de protocolo', () => {
    const options = corporateSmtpTransportOptions({ ...settings, ...credentials });
    expect(options).toMatchObject({ port: 587, secure: false, requireTLS: true, ignoreTLS: false, opportunisticTLS: false,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: settings.host },
      disableFileAccess: true, disableUrlAccess: true, debug: false, logger: false, connectionTimeout: 5000, socketTimeout: 10000 });
    expect(corporateSmtpTransportOptions({ ...settings, port: 465, tlsMode: 'TLS', ...credentials }).secure).toBe(true);
  });
  it('bloquea hostname fuera de allowlist y cambios de variable no activan red', async () => {
    const adapter = new PreparedCorporateSmtp();
    expect(() => adapter.dryRun({ ...settings, host: 'otro.corporativo.pe', ...credentials })).toThrow('no aprobado');
    vi.stubEnv('EXTERNAL_SMTP_ENABLED', 'true');
    expect(adapter.dryRun({ ...settings, ...credentials })).toMatchObject({ state: 'EXTERNAL_SMTP_DISABLED', networkAttempted: false, readyToSend: false });
    await expect(adapter.verify()).rejects.toMatchObject({ status: 423 }); await expect(adapter.send()).rejects.toMatchObject({ status: 423 });
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });
});

describe('API SMTP autorizada por RUC, sólo local', () => {
  it('retira servidor y claves con tombstone cifrado sin reiniciar revisión ni enviar correos', async () => {
    const f = fixture(); await f.service.save('1', input, authorization);
    const view = await f.service.remove('1', { expectedRevision: 1 }, authorization);
    expect(view).toMatchObject({ revision: 2, configured: false, credentialsConfigured: false, settings: null, integrity: 'NOT_CONFIGURED', readyToSend: false });
    const bytes = f.vault.open(f.rows.get(issuer.ruc)!.configurationCipher, context);
    expect(JSON.parse(bytes.toString())).toEqual({ removed: true }); bytes.fill(0);
    await expect(f.service.save('1', { expectedRevision: 2, settings }, authorization)).rejects.toMatchObject({ status: 400 });
    await expect(f.service.remove('1', { expectedRevision: 1 }, authorization)).rejects.toMatchObject({ status: 409 });
    expect(mocks.createTransport).not.toHaveBeenCalled();
    await f.service.save('1', { ...input, expectedRevision: 2 }, authorization);
    expect(await f.service.status('1', authorization)).toMatchObject({ configured: true, revision: 3 });
  });
  it.each([{}, { expectedRevision: -1 }, { expectedRevision: 1, send: true }, null])('no admite retiro inválido %j', async body => {
    const f = fixture(); await expect(f.service.remove('1', body, authorization)).rejects.toMatchObject({ status: 400 }); expect(f.store.save).not.toHaveBeenCalled();
  });
  it('cifra toda la configuración y devuelve sólo metadata sin credenciales/cipher/JWT', async () => {
    const f = fixture(); const view = await f.service.save('1', input, authorization);
    expect(view).toMatchObject({ ruc: issuer.ruc, revision: 1, configured: true, credentialsConfigured: true, hostnameApproved: true,
      readyToSend: false, deliveredToClient: false, state: 'EXTERNAL_SMTP_DISABLED' });
    expect(view.settings).toEqual(settings);
    expect(JSON.stringify(view)).not.toMatch(/UsuarioSMTP|PasswordSMTP|configurationCipher|Bearer/);
    expect(f.store.save.mock.calls[0][1].cipher).not.toContain(settings.host);
    expect(f.store.save.mock.calls[0][3]).toBe(admin.sub); expect(f.store.save.mock.calls[0][4]).toBe(true);
    expect(mocks.identity).toHaveBeenCalledWith(authorization, 'document.email');
    expect(mocks.privateJson).toHaveBeenCalledWith('http://billing-service:3002', '/api/v1/documents/catalog/issuance', authorization);
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });
  it('no comparte configuración entre RUC y reemplazar settings conserva credenciales sólo del mismo RUC', async () => {
    const f = fixture(); await f.service.save('1', input, authorization);
    expect(await f.service.status('2', authorization)).toMatchObject({ ruc: '00000000002', configured: false, revision: 0, settings: null });
    await expect(f.service.save('2', { expectedRevision: 0, settings }, authorization)).rejects.toMatchObject({ status: 400 });
    const view = await f.service.save('1', { expectedRevision: 1, settings: { ...settings, fromName: 'Emisor actualizado' } }, authorization);
    expect(view.revision).toBe(2); expect(f.store.save.mock.calls[1][4]).toBe(false);
    const bytes = f.vault.open(f.rows.get(issuer.ruc)!.configurationCipher, context);
    expect(JSON.parse(bytes.toString()).password).toBe(credentials.password); bytes.fill(0);
  });
  it('rechaza revisión obsoleta, campos de envío y credenciales parciales sin persistir', async () => {
    const f = fixture(); await f.service.save('1', input, authorization);
    await expect(f.service.save('1', input, authorization)).rejects.toMatchObject({ status: 409 });
    await expect(f.service.save('1', { ...input, enabled: true }, authorization)).rejects.toMatchObject({ status: 400 });
    await expect(f.service.save('1', { ...input, credentials: { username: 'alone' } }, authorization)).rejects.toMatchObject({ status: 400 });
    expect(f.store.save).toHaveBeenCalledOnce();
  });
  it('diagnóstico informa pendientes sin éxito inventado, ni conexión SMTP o envío', async () => {
    const f = fixture(); vi.stubEnv('SMTP_SETTINGS_KEY_FILE', '');
    const empty = await f.service.dryRun('1', {}, authorization);
    expect(empty).toMatchObject({ state: 'EXTERNAL_SMTP_DISABLED', locallyPrepared: false, readyToSend: false, networkAttempted: false });
    expect(empty.checks).toContainEqual({ code: 'CONFIGURATION', status: 'MISSING' });
    expect(empty.checks).toContainEqual({ code: 'SMTP_AUTHENTICATION', status: 'NOT_TESTED' });
    expect(f.store.save).not.toHaveBeenCalled(); expect(mocks.createTransport).not.toHaveBeenCalled();
  });
  it('diagnóstico válido sólo confirma preparación local y nunca entrega remota', async () => {
    const f = fixture(); await f.service.save('1', input, authorization);
    const result = await f.service.dryRun('1', {}, authorization);
    expect(result).toMatchObject({ locallyPrepared: true, readyToSend: false, dnsValidated: false, smtpAuthenticationVerified: false, deliveredToClient: false });
    expect(result.checks).toContainEqual({ code: 'DELIVERY', status: 'DISABLED' });
    expect(JSON.stringify(result)).not.toMatch(/UsuarioSMTP|PasswordSMTP|cipher|Bearer/); expect(mocks.createTransport).not.toHaveBeenCalled();
  });
  it('configuración corrupta o clave ausente produce diagnóstico cerrado sin secretos', async () => {
    const f = fixture(); await f.service.save('1', input, authorization);
    const row = f.rows.get(issuer.ruc)!; row.configurationCipher = row.configurationCipher.slice(0, 50);
    expect(await f.service.status('1', authorization)).toMatchObject({ integrity: 'INVALID', settings: null, credentialsConfigured: false });
    expect(await f.service.dryRun('1', {}, authorization)).toMatchObject({ locallyPrepared: false, readyToSend: false });
    vi.stubEnv('SMTP_SETTINGS_KEY_FILE', ''); expect(await f.service.status('1', authorization)).toMatchObject({ encryption: 'MISSING', integrity: 'NOT_CHECKED', settings: null });
  });
  it('no admite destinatarios/verify flags en dry-run ni escribe al diagnosticar', async () => {
    const f = fixture();
    for (const body of [{ recipient: 'real@cliente.pe' }, { verify: true }, { host: 'arbitrary.pe' }, null, []])
      await expect(f.service.dryRun('1', body, authorization)).rejects.toMatchObject({ status: 400 });
    expect(f.store.save).not.toHaveBeenCalled(); expect(mocks.createTransport).not.toHaveBeenCalled();
  });
  it('falla cerrado para sesión revocada, no ADMIN/no GLOBAL y servicio Identity caído', async () => {
    const f = fixture(); mocks.identity.mockRejectedValue(new AccessError(401, 'Sesión revocada'));
    await expect(f.service.status('1', authorization)).rejects.toMatchObject({ status: 401 });
    mocks.identity.mockResolvedValue({ ...admin, roles: ['CASHIER'] }); await expect(f.service.status('1', authorization)).rejects.toMatchObject({ status: 403 });
    mocks.identity.mockResolvedValue({ ...admin, scope: { kind: 'ASSIGNED' } }); await expect(f.service.status('1', authorization)).rejects.toMatchObject({ status: 403 });
    mocks.identity.mockRejectedValue(new AccessError(503, 'Identity caído')); await expect(f.service.save('1', input, authorization)).rejects.toMatchObject({ status: 503 });
    expect(f.store.save).not.toHaveBeenCalled(); expect(mocks.privateJson).not.toHaveBeenCalled();
  });
  it('no admite compañía/RUC arbitrarios ni guarda si se revoca durante preparación', async () => {
    const f = fixture(); await expect(f.service.status('99', authorization)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.status('../1', authorization)).rejects.toMatchObject({ status: 400 });
    mocks.identity.mockResolvedValueOnce(admin).mockRejectedValueOnce(new AccessError(401, 'Sesión revocada'));
    await expect(f.service.save('1', input, authorization)).rejects.toMatchObject({ status: 401 }); expect(f.store.save).not.toHaveBeenCalled();
  });
  it('almacenamiento no preparado no rompe la consulta de readiness ni inventa configuración', async () => {
    const f = fixture(); f.store.ready.mockResolvedValue(false);
    expect(await f.service.status('1', authorization)).toMatchObject({ storageReady: false, configured: false, readyToSend: false });
    expect(f.store.read).not.toHaveBeenCalled();
  });
  it('el controlador traduce errores sin devolver trazas ni mensajes internos con secretos', async () => {
    const service = { status: vi.fn().mockRejectedValue(new Error('PASSWORD-NEVER-RETURN')), save: vi.fn().mockRejectedValue(new AccessError(403, 'No autorizado')) };
    const controller = new SmtpConfigurationController(service as never);
    await expect(controller.status('1', { headers: {} })).rejects.toThrow('Configuración SMTP no disponible');
    await expect(controller.save('1', {}, { headers: {} })).rejects.toThrow('No autorizado');
  });
});

describe('repositorio aditivo parametrizado y auditado', () => {
  it('no usa base ajena ni crea tablas o ejecuta migraciones automáticamente', async () => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ db: 'factuez_billing', configuration: 'found', audit: 'found' }]) };
    const store = new SmtpConfigurationStore(prisma as unknown as PrismaService);
    expect(await store.ready()).toBe(false); await expect(store.read(issuer)).rejects.toMatchObject({ status: 503 });
  });
  it('revisión y audit se guardan en la misma transacción con bloqueo por RUC', async () => {
    const vault = new SmtpConfigurationVault(); const sealed = vault.seal(Buffer.from(JSON.stringify({ ...settings, ...credentials })), context);
    const row = { ...issuer, configurationCipher: sealed.cipher, keyVersion: 1, revision: 1, updatedAt: new Date() };
    const tx = { $queryRaw: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([row]), $executeRaw: vi.fn().mockResolvedValue(1) };
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ db: 'factuez_mailer_qa', configuration: 'found', audit: 'found' }]),
      $transaction: vi.fn(async (action: (value: typeof tx) => unknown) => action(tx)) };
    const store = new SmtpConfigurationStore(prisma as unknown as PrismaService);
    expect(await store.save(issuer, sealed, 0, admin.sub, true)).toEqual(row);
    expect(tx.$queryRaw.mock.calls[0][0].join('')).toContain('pg_advisory_xact_lock');
    const audit = tx.$executeRaw.mock.calls[0]; expect(audit[0].join('')).toContain('CorporateSmtpConfigurationAudit');
    expect(JSON.stringify(audit)).not.toMatch(/UsuarioSMTP|PasswordSMTP|configurationCipher|Bearer/);
  });
});
