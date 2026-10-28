import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertPrintablePdf, PRINT_GUIDANCE, PRINTER_COMPATIBILITY, pdfViewerSource } from '../apps/web-pwa/features/workspace/pdf-print';
import { localRecipient } from '../services/mailer-worker/src/local-mail';
import { bearer, identity, authorizedDocument, LivePublisher } from '../packages/service-access/src';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const id = '160250d9-160a-436a-aa32-90f6b996badd';
const user = { sub: id, exp: Math.floor(Date.now()/1000)+600, roles: ['ADMIN'], permissions: ['document.view','document.email'], scope: { kind: 'GLOBAL' } };
describe('impresión de PDF privado', () => {
  it('no depende de una marca ni conexión exclusiva y distingue el papel admitido', () => {
    expect(PRINTER_COMPATIBILITY).toContain('cualquier marca');
    expect(PRINTER_COMPATIBILITY).toContain('USB, red o compartida');
    expect(PRINTER_COMPATIBILITY).toContain('controlador instalado');
    expect(PRINT_GUIDANCE.ticket).toContain('80 mm');
    expect(PRINT_GUIDANCE.ticket).toContain('otro tamaño');
    expect(PRINT_GUIDANCE.a4).toContain('láser, de tinta o multifunción');
    expect(Object.values(PRINT_GUIDANCE).join(' ')).not.toMatch(/xprinter/i);
  });
  it('acepta PDF y rechaza HTML disfrazado', async () => {
    await expect(assertPrintablePdf(new Blob(['%PDF-1.7\n'], { type: 'application/pdf' }))).resolves.toBeUndefined();
    await expect(assertPrintablePdf(new Blob(['<html>'], { type: 'application/pdf' }))).rejects.toThrow();
    await expect(assertPrintablePdf(new Blob(['%PDF-1.7'], { type: 'text/html' }))).rejects.toThrow();
  });
  it('rechaza vacío y más de 10 MB', async () => {
    await expect(assertPrintablePdf(new Blob([], { type: 'application/pdf' }))).rejects.toThrow();
    await expect(assertPrintablePdf(new Blob([new Uint8Array(10*1024*1024+1)], { type: 'application/pdf' }))).rejects.toThrow();
  });
  it('el botón recupera el PDF por apiBlob, no imprime la página ni expone bearer', () => {
    const source = readFileSync(new URL('../apps/web-pwa/features/workspace/pdf-print.tsx', import.meta.url),'utf8');
    expect(source).toContain('await apiBlob(path'); expect(source).toContain('URL.revokeObjectURL');
    expect(source).not.toContain('window.print('); expect(source).not.toContain('token=');
  });
  it('ajusta el visor al ancho sin exponer una URL remota ni tokens', () => {
    expect(pdfViewerSource('blob:pdf-local')).toBe('blob:pdf-local#view=FitH');
    expect(() => pdfViewerSource('https://example.invalid/a.pdf')).toThrow();
    expect(() => pdfViewerSource('blob:pdf-local#token=x')).toThrow();
  });
  it('el diálogo usa altura dinámica y ayuda plegable, sin párrafo obligatorio largo', () => {
    const source = readFileSync(new URL('../apps/web-pwa/features/workspace/pdf-print.tsx', import.meta.url), 'utf8');
    expect(source).toContain('100dvh'); expect(source).toContain('min-h-0 flex-1');
    expect(source).toContain('w-[calc(100%-2rem)]');
    expect(source).toContain('<PrintHelp format={format}'); expect(source).toContain('<details');
    expect(source).toContain('grid-cols-2'); expect(source).not.toContain('h-[55vh]');
  });
});
describe('correo exclusivamente ficticio', () => {
  it('normaliza un destinatario .invalid', () => expect(localRecipient('Cliente@Pruebas.invalid')).toBe('cliente@pruebas.invalid'));
  it.each(['cliente@gmail.com','a@corporativo.pe','a@b.invalid\r\nBcc:otro@b.invalid','a@b.invalid,c@b.invalid','<a@b.invalid>','a@b.invalid.evil','a@b.invalid\n',null])('rechaza destinatario externo o inyección %s', value => expect(() => localRecipient(value)).toThrow());
});
describe('autorización activa por API, sin compartir BD', () => {
  it('valida bearer acotado', () => { expect(bearer('abc.def.xyz')).toBe('Bearer abc.def.xyz'); expect(() => bearer('x\n')).toThrow(); expect(() => bearer('a'.repeat(8193))).toThrow(); });
  it('valida sesión actual y permiso', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json(user)));
    expect((await identity('Bearer abc')).sub).toBe(id);
    await expect(identity('Bearer abc','sunat.configure')).rejects.toMatchObject({ status: 403 });
  });
  it('rechaza revocación y caída de Identity', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('',{status:401})).mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch',fetcher);
    await expect(identity('Bearer abc')).rejects.toMatchObject({status:401}); await expect(identity('Bearer abc')).rejects.toMatchObject({status:503});
  });
  it('rechaza sesión vencida o alcance GLOBAL indebido', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json({...user,exp:1})).mockResolvedValueOnce(Response.json({...user,roles:['CASHIER']})));
    await expect(identity('Bearer abc')).rejects.toMatchObject({status:401}); await expect(identity('Bearer abc')).rejects.toMatchObject({status:401});
  });
  it('no recupera documentos fuera del alcance', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('',{status:404})));
    await expect(authorizedDocument(id,'Bearer abc')).rejects.toMatchObject({status:404});
    await expect(authorizedDocument('../secret','Bearer abc')).rejects.toMatchObject({status:400});
  });
  it('no publica nada si el flag QA está apagado', async () => { vi.stubEnv('WORKSPACE_LIVE_ENABLED','false'); const live = new LivePublisher(); await live.changed(id); await live.close(); });
});
