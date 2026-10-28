import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { LocalPreparationUnavailableError, isRetryableLocalPreparationError, LOCAL_PREPARATION_MAX_ATTEMPTS, localPreparationRetryDelay } from '../services/sunat-service/src/application/local-preparation-policy';
import { XsdValidationService } from '../services/sunat-service/src/infrastructure/sunat/xsd-validation.service';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const require = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const { ServiceUnavailableException, BadRequestException, ForbiddenException } = require('@nestjs/common');
const xml = '<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"/>';
const paths = { CreditNote: '/mock-only/CreditNote.xsd' };
function child() { return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() }); }
function validator() {
  const service = new XsdValidationService();
  const extract = vi.fn().mockResolvedValue(paths);
  Object.assign(service, { extract }); // Ninguna lectura/extracción real ni proceso real.
  return { service, extract };
}

beforeEach(() => { vi.mocked(spawn).mockReset(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('RED PROHIBIDA'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('política compartida de preparación local', () => {
  it('sólo el error explícito es transitorio, aun cuando ambos respondan 503', () => {
    const error = new LocalPreparationUnavailableError('Recurso local ocupado');
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getStatus()).toBe(503);
    expect(isRetryableLocalPreparationError(error)).toBe(true);
    expect(LOCAL_PREPARATION_MAX_ATTEMPTS).toBe(3);
  });
  it.each([
    new ServiceUnavailableException('Validador XSD ocupado; reintente'),
    new ServiceUnavailableException('Integridad del paquete XSD'),
    new ServiceUnavailableException('Certificado no disponible'),
    new BadRequestException('XML inválido'), new ForbiddenException('No autorizado'),
    new Error('timeout'), { name: 'LocalPreparationUnavailableError', status: 503 }, null, undefined,
  ])('no infiere transitoriedad del mensaje, nombre o status (%#)', error => {
    expect(isRetryableLocalPreparationError(error)).toBe(false);
  });
  it('backoff exponencial acotado y seguro para valores fuera del rango', () => {
    expect([1, 2, 3, 4, 999].map(localPreparationRetryDelay)).toEqual([2000, 4000, 8000, 8000, 8000]);
    expect(localPreparationRetryDelay(0)).toBe(2000);
    expect(localPreparationRetryDelay(-100)).toBe(2000);
    expect(localPreparationRetryDelay(1.5)).toBe(2000);
    expect(localPreparationRetryDelay(Number.NaN)).toBe(8000);
    expect(localPreparationRetryDelay(Number.POSITIVE_INFINITY)).toBe(8000);
  });
});

describe('XSD comunica disponibilidad sin volver transitoria la integridad', () => {
  it('ocupación desaparece y los mismos bytes se validan después', async () => {
    const { service } = validator(); const processes: ReturnType<typeof child>[] = [];
    vi.mocked(spawn).mockImplementation(() => { const next = child(); processes.push(next); return next as never; });
    const one = service.validate(xml, 'CreditNote'); const two = service.validate(xml, 'CreditNote');
    await expect(service.validate(xml, 'CreditNote')).rejects.toBeInstanceOf(LocalPreparationUnavailableError);
    processes.forEach(process => process.emit('close', 0)); await Promise.all([one, two]);
    vi.mocked(spawn).mockImplementation(() => { const process = child(); queueMicrotask(() => process.emit('close', 0)); return process as never; });
    await expect(service.validate(xml, 'CreditNote')).resolves.toHaveProperty('xmlSha256');
    expect(spawn).toHaveBeenCalledTimes(3);
  });
  it.each(['ENOENT', 'EBUSY', 'ETIMEDOUT'])('paquete local no disponible (%s) puede recuperarse', async code => {
    const { service, extract } = validator();
    extract.mockRejectedValueOnce(Object.assign(new Error('Detalle privado'), { code }));
    await expect(service.validate(xml, 'CreditNote')).rejects.toBeInstanceOf(LocalPreparationUnavailableError);
    vi.mocked(spawn).mockImplementation(() => { const process = child(); queueMicrotask(() => process.emit('close', 0)); return process as never; });
    await expect(service.validate(xml, 'CreditNote')).resolves.toHaveProperty('xmlSha256');
    expect(extract).toHaveBeenCalledTimes(2);
  });
  it.each([new Error('hash incorrecto'), new Error('referencia externa'), Object.assign(new Error('Permisos/configuración'), { code: 'EACCES' })])('integridad/configuración del paquete no permite reintento (%#)', async error => {
    const { service, extract } = validator(); extract.mockRejectedValue(error);
    const rejected = await service.validate(xml, 'CreditNote').catch(value => value);
    expect(rejected).toBeInstanceOf(ServiceUnavailableException);
    expect(isRetryableLocalPreparationError(rejected)).toBe(false);
    expect(rejected.message).not.toContain(error.message); expect(spawn).not.toHaveBeenCalled();
  });
  it('proceso faltante usa el error explícito sin publicar sus detalles', async () => {
    const { service } = validator(); const process = child();
    vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => process.emit('error', new Error('DETALLE PRIVADO ENOENT'))); return process as never; });
    await expect(service.validate(xml, 'CreditNote')).rejects.toThrow(LocalPreparationUnavailableError);
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it('fallo síncrono al iniciar el proceso también es indisponibilidad local', async () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error('Recurso no disponible'); });
    await expect(validator().service.validate(xml, 'CreditNote')).rejects.toBeInstanceOf(LocalPreparationUnavailableError);
  });
  it('timeout es transitorio y libera la capacidad al matar el proceso', async () => {
    vi.useFakeTimers(); const { service } = validator(); const process = child(); vi.mocked(spawn).mockReturnValue(process as never);
    const failure = expect(service.validate(xml, 'CreditNote')).rejects.toBeInstanceOf(LocalPreparationUnavailableError);
    await vi.advanceTimersByTimeAsync(5000); await failure;
    expect(process.kill).toHaveBeenCalledWith('SIGKILL'); expect(Reflect.get(service, 'active')).toBe(0);
  });
  it('XML inválido permanece permanente incluso si cierra stdin con EPIPE', async () => {
    const process = child(); vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => { process.stdin.emit('error', Object.assign(new Error(), { code: 'EPIPE' })); process.emit('close', 3); });
      return process as never;
    });
    const error = await validator().service.validate(xml, 'CreditNote').catch(value => value);
    expect(error).toBeInstanceOf(BadRequestException); expect(isRetryableLocalPreparationError(error)).toBe(false);
  });
  it('no acredita XSD si stdin falló aunque el proceso cierre con código cero', async () => {
    const process = child(); vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => { process.stdin.emit('error', new Error('EPIPE')); process.emit('close', 0); }); return process as never;
    });
    await expect(validator().service.validate(xml, 'CreditNote')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rechaza referencias externas aun con validador ocupado', async () => {
    const { service } = validator(); Object.assign(service, { active: 2 });
    await expect(service.validate('<!DOCTYPE CreditNote>' + xml, 'CreditNote')).rejects.toBeInstanceOf(BadRequestException);
    expect(spawn).not.toHaveBeenCalled();
  });
});
