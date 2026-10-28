import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupplementTrackingService } from '../services/sunat-service/src/application/supplement-tracking.service';
const id = '60000000-0000-4000-8000-000000000001', batchId = '60000000-0000-4000-8000-000000000002';
const ruc = '20615878481';
const original = () => ({ documentId: id, companyId: 1, branchId: '60000000-0000-4000-8000-000000000003',
  environment: 'BETA', documentTypeCode: '03', series: 'B001', number: '1', fullNumber: 'B001-1',
  issueDate: '2026-10-03T14:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
  issuer: { identityNumber: ruc, legalName: 'EMISOR FICTICIO DE TEST' },
  customer: { identityNumber: '0', legalName: 'CLIENTE FICTICIO' }, lines: [],
  totals: { taxableAmount: '1.00', igvAmount: '0.18', payableAmount: '1.18' } });
function fixture() {
  const snapshot = original();
  const prisma = { fiscalDocument: { findFirst: vi.fn(async () => ({ immutablePayload: structuredClone(snapshot) })), findMany: vi.fn(async () => [] as any[]) },
    fiscalBatch: { findMany: vi.fn(async () => [] as any[]) },
    sunatSubmission: { findFirst: vi.fn(async () => ({ errorCode: 'CDR_UNVERIFIED', attempt: 1, completedAt: new Date('2026-10-03T15:00:00Z') })) } };
  const fetch = vi.fn(async () => new Response(JSON.stringify({ id, immutableSnapshot: snapshot }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  return { snapshot, prisma, fetch, service: new SupplementTrackingService(prisma as never) };
}
function batch(snapshot = original(), conditionCode = '1') {
  return { id: batchId, identifier: 'RC-20261003-1', status: 'ACCEPTED', immutablePayload: {
    environment: 'BETA', issuer: snapshot.issuer, identifier: 'RC-20261003-1', kind: 'RC',
    input: { entries: [{ conditionCode, document: { snapshot } }] } } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('Seguimiento de suplementos autorizado y sin escrituras fiscales', () => {
  it('rechaza sin sesión antes de HTTP/Prisma', async () => {
    const f = fixture(); await expect(f.service.list(id)).rejects.toMatchObject({ status: 401 });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.prisma.fiscalDocument.findFirst).not.toHaveBeenCalled();
  });
  it('UUID inválido no se concatena a ruta interna', async () => {
    const f = fixture(); await expect(f.service.list('../secrets', 'Bearer fixture.token')).rejects.toMatchObject({ status: 400 });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 500])('falla cerrado al verificar acceso %s', async status => {
    const f = fixture(); f.fetch.mockResolvedValue(new Response('{}', { status }));
    await expect(f.service.list(id, 'Bearer fixture.token')).rejects.toMatchObject({ status: status === 401 ? 401 : status === 500 ? 503 : 404 });
    expect(f.prisma.fiscalDocument.findFirst).not.toHaveBeenCalled();
  });
  it('fallo de Billing no consulta BD ni devuelve contexto', async () => {
    const f = fixture(); f.fetch.mockRejectedValue(new Error('secreto-no-mostrar'));
    await expect(f.service.list(id, 'Bearer fixture.token')).rejects.toThrow('No se pudo verificar el acceso');
    expect(f.prisma.fiscalDocument.findFirst).not.toHaveBeenCalled();
  });
  it.each(['PRODUCTION', 'INVENTADO'])('ambiente %s bloqueado antes de BD', async environment => {
    const f = fixture(); f.fetch.mockResolvedValue(new Response(JSON.stringify({ id, immutableSnapshot: { ...f.snapshot, environment } })));
    await expect(f.service.list(id, 'Bearer fixture.token')).rejects.toMatchObject({ status: 409 });
    expect(f.prisma.fiscalDocument.findFirst).not.toHaveBeenCalled();
  });
  it('acota la respuesta de autorización', async () => {
    const f = fixture(); f.fetch.mockResolvedValue(new Response('x'.repeat(512 * 1024 + 1)));
    await expect(f.service.list(id, 'Bearer fixture.token')).rejects.toMatchObject({ status: 409 });
    expect(f.prisma.fiscalDocument.findFirst).not.toHaveBeenCalled();
  });
  it('snapshot distinto falla cerrado', async () => {
    const f = fixture(); f.prisma.fiscalDocument.findFirst.mockResolvedValue({ immutablePayload: { ...f.snapshot, fullNumber: 'B001-999' } });
    await expect(f.service.list(id, 'Bearer fixture.token')).rejects.toMatchObject({ status: 409 });
    expect(f.prisma.fiscalBatch.findMany).not.toHaveBeenCalled();
  });
  it('consulta sólo RUC/Beta/miembro y no otorga aceptación por estado registrado', async () => {
    const f = fixture(); f.prisma.fiscalBatch.findMany.mockResolvedValue([batch()]);
    const result = await f.service.list(id, 'Bearer fixture.token');
    expect(result).toMatchObject({ readOnly: true, financialProjectionApplied: false, transmissionAuthorized: false, certificateAccess: false,
      items: [{ reference: 'RC-20261003-1', phase: 'CDR_UNVERIFIED', recordedStatus: 'ACCEPTED', requestedAction: 'ALTA', fiscalEffectsAppliedByThisView: false }] });
    expect(f.prisma.fiscalBatch.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { issuerRuc: ruc, environment: 'BETA',
      immutablePayload: { path: ['input', 'entries'], array_contains: [{ document: { snapshot: { documentId: id } } }] } } }));
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledWith(expect.stringContaining(`/api/v1/documents/${id}`), expect.objectContaining({ redirect: 'error',
      headers: expect.objectContaining({ Authorization: 'Bearer fixture.token' }) }));
    expect(JSON.stringify(result)).not.toContain('CLIENTE FICTICIO');
    expect(Object.keys(f.prisma)).not.toContain('sunatCredentials');
  });
  it.each(['2', '3'])('presenta condición RC %s sin alterar snapshot ni importes', async condition => {
    const f = fixture(), version = { ...f.snapshot, totals: { taxableAmount: '2.00', igvAmount: '0.36', payableAmount: '2.36' } };
    f.prisma.fiscalBatch.findMany.mockResolvedValue([batch(version, condition)]);
    const result = await f.service.list(id, 'Bearer fixture.token');
    expect(result.items[0].requestedAction).toBe(condition === '2' ? 'MODIFICACION' : 'BAJA');
    expect(f.snapshot.totals.payableAmount).toBe('1.18'); expect(result.financialProjectionApplied).toBe(false);
  });
  it('miembro de otra identidad o repetido se bloquea', async () => {
    const f = fixture(), row = batch();
    row.immutablePayload.input.entries.push(row.immutablePayload.input.entries[0]);
    f.prisma.fiscalBatch.findMany.mockResolvedValue([row]);
    await expect(f.service.list(id, 'Bearer fixture.token')).rejects.toMatchObject({ status: 409 });
  });
  it('lote con cabecera cambiada no usa coincidencia sólo por UUID', async () => {
    const f = fixture(); f.prisma.fiscalBatch.findMany.mockResolvedValue([batch({ ...original(), series: 'B999' })]);
    await expect(f.service.list(id, 'Bearer fixture.token')).rejects.toMatchObject({ status: 409 });
  });
  it('más de 200 versiones exige conciliación, no trunca silenciosamente', async () => {
    const f = fixture(); f.prisma.fiscalBatch.findMany.mockResolvedValue(Array.from({ length: 201 }, () => batch()));
    await expect(f.service.list(id, 'Bearer fixture.token')).rejects.toMatchObject({ status: 409 });
    expect(f.prisma.sunatSubmission.findFirst).not.toHaveBeenCalled();
  });
  it('fase desconocida se oculta, no se propaga texto arbitrario de error', async () => {
    const f = fixture(); f.prisma.fiscalBatch.findMany.mockResolvedValue([batch()]);
    f.prisma.sunatSubmission.findFirst.mockResolvedValue({ errorCode: 'secreto-no-mostrar', attempt: 1, completedAt: new Date() });
    const result = await f.service.list(id, 'Bearer fixture.token'); expect(result.items[0].phase).toBeNull();
    expect(JSON.stringify(result)).not.toContain('secreto-no-mostrar');
  });
});
