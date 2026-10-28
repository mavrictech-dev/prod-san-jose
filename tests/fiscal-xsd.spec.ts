import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { XsdValidationService, XSD_PROFILE, XSD_ARCHIVE_SHA256 } from '../services/sunat-service/src/infrastructure/sunat/xsd-validation.service';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const xml = '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>';
function child() { return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() }); }
function service() { const result = new XsdValidationService(); Object.assign(result, { bundle: async () => ({ Invoice: '/tmp/factuez-xsd-test/Invoice.xsd', SummaryDocuments: '/tmp/factuez-xsd-test/Summary.xsd' }) }); return result; }
beforeEach(() => vi.mocked(spawn).mockReset());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('Gate XSD fijo, acotado y sin secretos', () => {
  it('verifica y extrae el ZIP oficial fijado, sin schema remoto', async () => {
    const process = child(); vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => process.emit('close', 0)); return process as never; });
    const validator = new XsdValidationService();
    const paths = await Reflect.get(validator, 'extract').call(validator);
    Object.assign(validator, { bundle: async () => paths });
    const result = await validator.validate(xml, 'Invoice');
    expect(result).toMatchObject({ profile: XSD_PROFILE, archiveSha256: XSD_ARCHIVE_SHA256 });
    expect(vi.mocked(spawn).mock.calls[0][1]).toContain('--schema');
  }, 15000); // Sólo extracción del fixture oficial en disco; el proceso runtime sigue limitado a 5 s.
  it('liga evidencia a bytes exactos y usa stdin, sin shell, catálogo ni variables de claves', async () => {
    const process = child(); vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => process.emit('close', 0)); return process as never; });
    const result = await service().validate(xml, 'Invoice');
    expect(result.xmlSha256).toBe(createHash('sha256').update(xml).digest('hex'));
    const [executable, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(executable).toBe('/usr/bin/xmllint'); expect(args).toEqual(['--nonet','--nocatalogs','--noout','--maxmem','134217728','--schema','/tmp/factuez-xsd-test/Invoice.xsd','-']);
    expect(options).toMatchObject({ shell: false, env: { XML_CATALOG_FILES: '', SGML_CATALOG_FILES: '' } });
    expect(Object.keys(options!.env!)).toEqual(['PATH','LANG','XML_CATALOG_FILES','SGML_CATALOG_FILES']);
  });
  it.each([
    '<!DOCTYPE Invoice>' + xml,
    xml.replace('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2', 'urn:foreign'),
    xml.replace('/>', ' xml:base="https://example.invalid/"/>'),
    xml.replace('/>', ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="x https://example.invalid/schema.xsd"/>'),
    xml.replace('/>', ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="/etc/passwd"/>'),
    xml.replace('/>', '><xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="file:///etc/passwd"/></Invoice>'),
  ])('rechaza entradas externas/ambiguas antes del proceso (%#)', async input => {
    await expect(service().validate(input, 'Invoice')).rejects.toThrow(); expect(spawn).not.toHaveBeenCalled();
  });
  it('rechaza root/profile no permitido', async () => { await expect(service().validate(xml, 'toString' as never)).rejects.toThrow(); expect(spawn).not.toHaveBeenCalled(); });
  it('error XSD no filtra stderr/XML externo', async () => {
    const process = child(); vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => { process.stderr.emit('data', Buffer.from('FAKE SOL/P12 - NO PUBLICAR')); process.emit('close', 3); }); return process as never; });
    await expect(service().validate(xml, 'Invoice')).rejects.toThrow('XML rechazado por XSD oficial');
  });
  it('proceso faltante falla cerrado', async () => {
    const process = child(); vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => { if (process.listenerCount('error')) process.emit('error', new Error('ENOENT')); }); return process as never; });
    await expect(service().validate(xml, 'Invoice')).rejects.toThrow('Validador XSD no disponible'); expect(process.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it('salida mayor a 64 KB mata el proceso sin volcar XML', async () => {
    const process = child(); vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => process.stderr.emit('data', Buffer.alloc(65537))); return process as never; });
    await expect(service().validate(xml, 'Invoice')).rejects.toThrow('XML rechazado por XSD oficial'); expect(process.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it('timeout mata el proceso a cinco segundos', async () => {
    vi.useFakeTimers(); const process = child(); vi.mocked(spawn).mockReturnValue(process as never);
    const failure = expect(service().validate(xml, 'Invoice')).rejects.toThrow('límite seguro');
    await vi.advanceTimersByTimeAsync(5001); await failure; expect(process.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it('máximo dos procesos, sin cola ilimitada', async () => {
    const processes: ReturnType<typeof child>[] = []; vi.mocked(spawn).mockImplementation(() => { const next = child(); processes.push(next); return next as never; });
    const validator = service(); const one = validator.validate(xml, 'Invoice'); const two = validator.validate(xml, 'Invoice');
    await expect(validator.validate(xml, 'Invoice')).rejects.toThrow('ocupado');
    processes.forEach(p => p.emit('close', 0)); await Promise.all([one, two]); expect(spawn).toHaveBeenCalledTimes(2);
  });
});
