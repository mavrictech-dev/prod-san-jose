import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { IssuanceQueryService } from '../services/billing-service/src/application/issuance-query.service';

const documentId = '30000000-0000-4000-8000-000000000901';
const branchId = '10000000-0000-4000-8000-000000000901';
const pointId = '20000000-0000-4000-8000-000000000901';
const seriesId = '40000000-0000-4000-8000-000000000901';

describe('Metadata de impresión autorizada para snapshots antiguos', () => {
  it('usa el emisor de la fila y la sede de su punto sin modificar el snapshot', async () => {
    const snapshot = Object.freeze({ companyId: 999, branchId: 'snapshot-antiguo', issuer: { identityNumber: '00000000001' } });
    const findFirst = vi.fn(async () => ({ id: documentId, companyId: 7, immutableSnapshot: snapshot, emissionPoint: { branchId } }));
    const service = new IssuanceQueryService({ document: { findFirst } } as never);
    const detail = await service.documentDetail({ kind: 'GLOBAL' }, documentId);
    expect(detail.printContext).toEqual({ companyId: 7, branchId });
    expect(detail.immutableSnapshot).toBe(snapshot);
    expect(detail.immutableSnapshot).toEqual({ companyId: 999, branchId: 'snapshot-antiguo', issuer: { identityNumber: '00000000001' } });
    expect(findFirst.mock.calls[0][0]).toMatchObject({ select: { emissionPoint: { select: { branchId: true } } } });
    expect(detail).not.toHaveProperty('emissionPoint');
  });

  it.each([
    [{ branchId: 'sede-del-snapshot' }, 'sede-del-snapshot'],
    [{ issuer: { identityNumber: '00000000001' } }, null],
    [null, null],
  ])('tolera mocks antiguos sin relación: %j', async (snapshot, expectedBranch) => {
    const service = new IssuanceQueryService({ document: { findFirst: async () => ({ id: documentId, companyId: 7, immutableSnapshot: snapshot }) } } as never);
    const detail = await service.documentDetail({ kind: 'GLOBAL' }, documentId);
    expect(detail.printContext).toEqual({ companyId: 7, branchId: expectedBranch });
    expect(detail.immutableSnapshot).toBe(snapshot);
  });

  it('mantiene el where autorizado sin excluir historial de maestros inactivos', async () => {
    const findFirst = vi.fn(async () => ({ id: documentId, companyId: 7, immutableSnapshot: {}, emissionPoint: { branchId } }));
    const service = new IssuanceQueryService({ document: { findFirst } } as never);
    await service.documentDetail({ kind: 'ASSIGNED', branchIds: [branchId], emissionPointIds: [pointId], series: [seriesId] }, documentId);
    expect(findFirst.mock.calls[0][0].where).toEqual({ id: documentId, emissionPoint: { id: { in: [pointId] }, branchId: { in: [branchId] } }, seriesCounterId: { in: [seriesId] } });
  });

  it('no entrega metadata cuando el documento no pertenece al alcance', async () => {
    const service = new IssuanceQueryService({ document: { findFirst: async () => null } } as never);
    await expect(service.documentDetail({ kind: 'GLOBAL' }, documentId)).rejects.toThrow('Documento no disponible en su alcance');
  });
});
