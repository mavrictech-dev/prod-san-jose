import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentSourceFixture, documentIssuer, documentAuthorization, documentActor } from './corporate-document.fixture';
import { bytesDigest, canonical } from '../services/mailer-worker/src/corporate-document-policy';
beforeEach(() => { vi.stubEnv('SERVER_SMTP_ENABLED', 'true'); vi.stubEnv('SERVER_SMTP_DOCUMENTS_ENABLED', 'true'); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('fuente fiscal operativa: Billing y originales/PDF bajo Bearer, sin red externa', () => {
  it.each(['01', '03', '07', '08'] as const)('prepara %s con cinco adjuntos originales y PDF vigente, nunca genera/reemplaza originales', async type => {
    const f = documentSourceFixture(type), prepared = await f.source.prepare(documentIssuer, f.id, 'a4', documentAuthorization);
    expect(prepared.proof).toMatchObject({ documentId: f.id, documentType: type, ruc: documentIssuer.ruc, actorId: documentActor });
    expect(prepared.attachments).toHaveLength(5); expect(f.fetch).toHaveBeenCalledTimes(5); expect(f.json).toHaveBeenCalledTimes(2);
    expect(prepared.attachments[1].content.equals(f.xml)).toBe(true); expect(prepared.attachments[3].content.equals(f.cdr)).toBe(true);
    expect(prepared.attachments[2].filename).toBe(f.submitted + '.zip'); expect(prepared.attachments[4].filename).toBe('R-' + f.submitted + '.zip');
    expect(prepared.attachments.every(a => bytesDigest(a.content) === a.sha256)).toBe(true);
    expect(prepared.documentProof).toBe(bytesDigest(canonical({ proof: prepared.proof,
      originals: prepared.attachments.filter(a => a.kind !== 'PDF').map(a => ({ kind: a.kind, filename: a.filename, sha256: a.sha256, size: a.content.length })) })));
    expect(f.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/fiscal-artifacts/' + f.id + '/a4',
      ...['xml', 'submission-zip', 'cdr-xml', 'cdr-zip'].map(kind => '/api/v1/fiscal-artifacts/' + f.id + '/original/' + kind),
    ]);
    for (const [url, options] of f.fetch.mock.calls) {
      expect(String(url)).toContain('/api/v1/fiscal-artifacts/' + f.id + '/');
      expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: documentAuthorization, 'Cache-Control': 'no-store' } });
      expect(options).not.toHaveProperty('body');
    }
    expect(f.identity).toHaveBeenCalledWith(documentAuthorization, 'document.email');
    expect(f.json).toHaveBeenCalledWith(expect.any(String), '/api/v1/documents/' + f.id, documentAuthorization);
  });
  it.each(['07', '08'] as const)('prepara nota %s aceptada con observaciones en ticket y ZIP propio', async type => {
    const f = documentSourceFixture(type); f.doc.sunatStatus = 'ACCEPTED_WITH_OBSERVATIONS';
    const prepared = await f.source.prepare(documentIssuer, f.id, 'ticket', documentAuthorization);
    expect(prepared.proof).toMatchObject({ documentType: type, companyId: 1, fiscalStatus: 'ACCEPTED_WITH_OBSERVATIONS' });
    expect(prepared.attachments[0].filename).toBe(f.base + '-ticket-PRODUCCION.pdf');
    expect(prepared.attachments[2].filename).toBe(f.base + '.zip');
    expect(prepared.attachments[4].filename).toBe('R-' + f.base + '.zip');
    expect(prepared.attachments.some(a => a.filename.includes('-RC-'))).toBe(false);
  });
  describe.each(['07', '08'] as const)('nota productiva %s cerrada ante inconsistencias', type => {
    it.each(['company', 'missing-company', 'ruc', 'document', 'snapshot-id', 'beta', 'rejected', 'pending', 'series',
      'profile', 'reason', 'adjustment-type', 'adjustment-reason', 'reference-type'])('deniega %s antes de archivos', async change => {
      const f = documentSourceFixture(type), s = f.doc.immutableSnapshot as any;
      if (change === 'company') f.doc.companyId = 2;
      if (change === 'missing-company') delete s.companyId;
      if (change === 'ruc') s.issuer.identityNumber = '00000000002';
      if (change === 'document') f.doc.id = 'other';
      if (change === 'snapshot-id') s.documentId = 'other';
      if (change === 'beta') s.environment = 'BETA';
      if (change === 'rejected') f.doc.sunatStatus = 'REJECTED';
      if (change === 'pending') f.doc.sunatStatus = 'SUBMITTED';
      if (change === 'series') { s.series = 'B001'; s.fullNumber = f.doc.fullNumber = 'B001-1'; }
      if (change === 'profile') s.profile = 'unsupported';
      if (change === 'reason') s.reasonCode = type === '07' ? '02' : '01';
      if (change === 'adjustment-type') s.adjustment.documentTypeCode = type === '07' ? '08' : '07';
      if (change === 'adjustment-reason') s.adjustment.reasonCode = type === '07' ? '02' : '01';
      if (change === 'reference-type') s.reference.documentTypeCode = '03';
      await expect(f.source.prepare(documentIssuer, f.id, 'a4', documentAuthorization)).rejects.toMatchObject({ status: 409 });
      expect(f.fetch).not.toHaveBeenCalled();
    });
    it.each(['rc', 'xml-name', 'pdf-name', 'submission-name', 'submission-content', 'submission-entry', 'cdr-name', 'cdr-content'])('deniega originales %s', async change => {
      const f = documentSourceFixture(type);
      if (change === 'rc') {
        const rc = documentIssuer.ruc + '-RC-20261028-1';
        f.files.get('submission-zip')!.name = rc + '.zip';
        f.files.get('submission-zip')!.bytes = Buffer.from(f.zipSync({ [rc + '.xml']: f.summary }));
        f.files.get('cdr-xml')!.name = 'R-' + rc + '.xml';
        f.files.get('cdr-zip')!.name = 'R-' + rc + '.zip';
        f.files.get('cdr-zip')!.bytes = Buffer.from(f.zipSync({ ['R-' + rc + '.xml']: f.cdr }));
      }
      if (change === 'xml-name') f.files.get('xml')!.name = f.base + '0.xml';
      if (change === 'pdf-name') f.files.get('a4')!.name = '00000000002-' + type + '-' + f.doc.fullNumber + '-a4-PRODUCCION.pdf';
      if (change === 'submission-name') f.files.get('submission-zip')!.name = f.base.replace('-' + type + '-', '-01-') + '.zip';
      if (change === 'submission-content') f.files.get('submission-zip')!.bytes = Buffer.from(f.zipSync({ [f.base + '.xml']: Buffer.from('<Other>TAMPER</Other>') }));
      if (change === 'submission-entry') f.files.get('submission-zip')!.bytes = Buffer.from(f.zipSync({ [f.base + '0.xml']: f.xml }));
      if (change === 'cdr-name') f.files.get('cdr-xml')!.name = 'R-' + f.base + '0.xml';
      if (change === 'cdr-content') f.files.get('cdr-zip')!.bytes = Buffer.from(f.zipSync({ ['R-' + f.base + '.xml']: Buffer.from('<ApplicationResponse>TAMPER</ApplicationResponse>') }));
      await expect(f.source.prepare(documentIssuer, f.id, 'a4', documentAuthorization)).rejects.toMatchObject({ status: 409 });
    });
    it.each(['a4', 'xml', 'submission-zip', 'cdr-xml', 'cdr-zip'])('propaga denegación owner de %s (manifest/PKI/revisión)', async denied => {
      const f = documentSourceFixture(type), originalFetch = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation(async (url, options) => String(url).endsWith('/' + denied)
        ? new Response('PRIVATE owner evidence denial', { status: 409 }) : originalFetch(url, options));
      await expect(f.source.prepare(documentIssuer, f.id, 'a4', documentAuthorization)).rejects.toMatchObject({ status: 409 });
    });
  });
  it('PDF actual puede cambiar sin alterar prueba de originales; XML no puede', async () => {
    const f = documentSourceFixture(), one = await f.source.prepare(documentIssuer, f.id, 'a4', documentAuthorization);
    f.files.get('a4')!.bytes = Buffer.from('%PDF-1.7 current new presentation');
    const two = await f.source.prepare(documentIssuer, f.id, 'a4', documentAuthorization);
    expect(two.documentProof).toBe(one.documentProof); expect(two.attachments[0].sha256).not.toBe(one.attachments[0].sha256);
    const different = Buffer.from('<Invoice>CHANGED ORIGINAL</Invoice>');
    f.files.get('xml')!.bytes = different; f.files.get('submission-zip')!.bytes = Buffer.from(f.zipSync({ [f.base + '.xml']: different }));
    expect((await f.source.prepare(documentIssuer, f.id, 'a4', documentAuthorization)).documentProof).not.toBe(one.documentProof);
  });
  it.each(['ruc', 'company', 'snapshot-company', 'id', 'beta', 'rejected', 'pending', 'type', 'number'])('deniega documento %s antes de archivos', async change => {
    const f = documentSourceFixture();
    if (change === 'ruc') f.doc.immutableSnapshot.issuer.identityNumber = '00000000002';
    if (change === 'company') f.doc.companyId = 2;
    if (change === 'snapshot-company') f.doc.immutableSnapshot.companyId = 2;
    if (change === 'id') f.doc.immutableSnapshot.documentId = 'wrong';
    if (change === 'beta') f.doc.immutableSnapshot.environment = 'BETA';
    if (change === 'rejected') f.doc.sunatStatus = 'REJECTED';
    if (change === 'pending') f.doc.sunatStatus = 'QUEUED';
    if (change === 'type') f.doc.immutableSnapshot.documentTypeCode = '09' as never;
    if (change === 'number') f.doc.immutableSnapshot.fullNumber = 'F001-2';
    await expect(f.source.prepare(documentIssuer, f.id, 'a4', documentAuthorization)).rejects.toMatchObject({ status: 409 }); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(['role', 'scope', 'revoked'])('deniega %s antes de Billing/archivos', async change => {
    const f = documentSourceFixture();
    if (change === 'role') f.identity.mockResolvedValue({ sub: documentActor, roles: ['CASHIER'], scope: { kind: 'GLOBAL' } });
    if (change === 'scope') f.identity.mockResolvedValue({ sub: documentActor, roles: ['ADMIN'], scope: { kind: 'ASSIGNED' } });
    if (change === 'revoked') f.identity.mockRejectedValue(Error('PRIVATE revoked'));
    await expect(f.source.prepare(documentIssuer, f.id, 'a4', documentAuthorization)).rejects.toThrow(); expect(f.json).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it('status puede autorizar lectura con flags false, sin preparar ni contactar SMTP', async () => {
    const f = documentSourceFixture(); vi.stubEnv('SERVER_SMTP_DOCUMENTS_ENABLED', 'false');
    await expect(f.source.authorize(documentIssuer, f.id, documentAuthorization, false)).resolves.toMatchObject({ documentId: f.id });
    await expect(f.source.prepare(documentIssuer, f.id, 'a4', documentAuthorization)).rejects.toMatchObject({ status: 423 }); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(['filename', 'contentType', 'pdf', 'doctype', 'mismatch-zip', 'cdr-zip', 'zip-path', 'multi-zip', 'rc'])('rechaza archivo inseguro/inconsistente %s', async change => {
    const f = documentSourceFixture(change === 'rc' ? '03' : '01');
    if (change === 'filename') f.files.get('xml')!.name = '../unsafe.xml';
    if (change === 'contentType') f.files.get('xml')!.type = 'text/html';
    if (change === 'pdf') f.files.get('a4')!.bytes = Buffer.from('<html>NOT PDF');
    if (change === 'doctype') f.files.get('xml')!.bytes = Buffer.from('<!DOCTYPE x><Invoice/>');
    if (change === 'mismatch-zip') f.files.get('submission-zip')!.bytes = Buffer.from(f.zipSync({ [f.base + '.xml']: Buffer.from('<Invoice>other</Invoice>') }));
    if (change === 'cdr-zip') f.files.get('cdr-zip')!.bytes = Buffer.from(f.zipSync({ ['R-' + f.submitted + '.xml']: Buffer.from('<ApplicationResponse>other</ApplicationResponse>') }));
    if (change === 'zip-path') f.files.get('submission-zip')!.bytes = Buffer.from(f.zipSync({ '../evil.xml': f.xml }));
    if (change === 'multi-zip') f.files.get('submission-zip')!.bytes = Buffer.from(f.zipSync({ [f.base + '.xml']: f.xml, 'other.xml': f.xml }));
    if (change === 'rc') f.files.get('cdr-xml')!.name = 'R-' + f.base + '.xml';
    await expect(f.source.prepare(documentIssuer, f.id, 'a4', documentAuthorization)).rejects.toMatchObject({ status: 409 });
  });
  it.each([401,403,404,409,500])('conserva denegación HTTP %s saneada sin respuestas ni secretos', async status => {
    const f = documentSourceFixture(); f.fetch.mockResolvedValue(new Response('PRIVATE', { status }));
    await expect(f.source.prepare(documentIssuer, f.id, 'a4', documentAuthorization)).rejects.toMatchObject({ status: status === 500 ? 503 : status });
  });
  it('no acepta redirect, red caída, length falso ni body excesivo', async () => {
    const f = documentSourceFixture(); f.fetch.mockRejectedValue(Error('PRIVATE connection details'));
    await expect(f.source.prepare(documentIssuer, f.id, 'a4', documentAuthorization)).rejects.toThrow('Servicio de originales fiscales no disponible');
    const g = documentSourceFixture(); g.fetch.mockResolvedValue(new Response('x', { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="safe.pdf"', 'content-length': '999999999' } }));
    await expect(g.source.prepare(documentIssuer, g.id, 'a4', documentAuthorization)).rejects.toMatchObject({ status: 409 });
    const h = documentSourceFixture(); h.files.get('xml')!.bytes = Buffer.alloc(5 * 1024 * 1024 + 1, 65);
    await expect(h.source.prepare(documentIssuer, h.id, 'a4', documentAuthorization)).rejects.toMatchObject({ status: 409 });
  });
  it('cambio de estado o snapshot durante descarga deniega preparación', async () => {
    const f = documentSourceFixture(); f.json.mockResolvedValueOnce(structuredClone(f.doc)); f.doc.sunatStatus = 'ACCEPTED_WITH_OBSERVATIONS';
    await expect(f.source.prepare(documentIssuer, f.id, 'a4', documentAuthorization)).rejects.toMatchObject({ status: 409 });
  });
});
