import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IssuanceQueryService } from '../services/billing-service/src/application/issuance-query.service';
import type { AccessScope } from '../packages/contracts/src/authorization';

const branchA = '10000000-0000-4000-8000-000000000921';
const branchB = '10000000-0000-4000-8000-000000000922';
const pointA = '20000000-0000-4000-8000-000000000921';
const pointB = '20000000-0000-4000-8000-000000000922';
const seriesA = '40000000-0000-4000-8000-000000000921';
const seriesB = '40000000-0000-4000-8000-000000000922';

function fixture() {
  const companies = [
    { id: 1, ruc: '99111111111', legalName: 'PRUEBA NOMBRE COMERCIAL', environment: 'BETA' },
    { id: 2, ruc: '00000000002', legalName: 'LABORATORIO DEL MOCK', environment: 'BETA' },
  ];
  const branches = [{ id: branchA, companyId: 1, code: 'A', name: 'SEDE A' }, { id: branchB, companyId: 2, code: 'B', name: 'SEDE B' }];
  const points = [
    { id: pointA, companyId: 1, branchId: branchA, code: 'A', name: 'PUNTO A', trackNumber: 1, counters: [{ id: seriesA, documentType: 'INVOICE', series: 'F001' }] },
    { id: pointB, companyId: 2, branchId: branchB, code: 'B', name: 'PUNTO B', trackNumber: 2, counters: [{ id: seriesB, documentType: 'INVOICE', series: 'F001' }] },
  ];
  const prisma = {
    companySettings: { findMany: vi.fn(async (_args: any) => companies) },
    branch: { findMany: vi.fn(async (_args: any) => branches) },
    emissionPoint: { findMany: vi.fn(async (_args: any) => points) },
    fuelProduct: { findMany: vi.fn(async (_args: any) => [{ id: 'product-mock', sku: 'P', description: 'PRODUCTO MOCK', unitCode: 'NIU', taxAffectationCode: '10', defaultUnitPrice: { toString: () => '1.00' } }]) },
  };
  return { service: new IssuanceQueryService(prisma as never), prisma, companies, branches, points };
}
afterEach(() => vi.unstubAllEnvs());

describe('Metadata de fuente sin eliminar registros ni expandir autorización', () => {
  it.each(['false', 'true'])('mantiene BUSINESS y SYNTHETIC aunque demoData sea %s', async demoData => {
    vi.stubEnv('FACTUEZ_DEMO_SEED', demoData);
    const f = fixture(), before = structuredClone([f.companies, f.branches, f.points]);
    const catalog = await f.service.catalog({ kind: 'GLOBAL' });
    expect(catalog.companies.map(c => [c.id, c.source])).toEqual([[1, 'BUSINESS'], [2, 'SYNTHETIC']]);
    expect(catalog.branches.map(b => [b.id, b.source])).toEqual([[branchA, 'BUSINESS'], [branchB, 'SYNTHETIC']]);
    expect(catalog.emissionPoints.map(p => [p.id, p.source])).toEqual([[pointA, 'BUSINESS'], [pointB, 'SYNTHETIC']]);
    expect(catalog.catalogPolicy).toEqual({ sourceRule: 'RUC00', defaultSource: 'BUSINESS', historyIncludesAllSources: true });
    expect(catalog.capabilities).toEqual({ demoData: demoData === 'true', fiscalTransmission: false });
    expect(catalog.products[0].defaultUnitPrice).toBe('1.00');
    expect([f.companies, f.branches, f.points]).toEqual(before);
  });
  it('conserva filtros de actividad, BETA y UUID de alcance ASSIGNED en todas las consultas', async () => {
    const f = fixture();
    const scope: AccessScope = { kind: 'ASSIGNED', branchIds: [branchB], emissionPointIds: [pointB], series: [seriesB] };
    await f.service.catalog(scope);
    expect(f.prisma.companySettings.findMany.mock.calls[0][0].where).toEqual({ active: true, environment: 'BETA', branches: { some: { id: { in: [branchB] } } } });
    expect(f.prisma.branch.findMany.mock.calls[0][0].where).toEqual({ active: true, company: { active: true, environment: 'BETA' }, id: { in: [branchB] } });
    expect(f.prisma.emissionPoint.findMany.mock.calls[0][0]).toMatchObject({
      where: { active: true, branch: { active: true }, company: { active: true, environment: 'BETA' }, id: { in: [pointB] }, branchId: { in: [branchB] } },
      include: { counters: { where: { active: true, id: { in: [seriesB] } } } },
    });
  });
  it('el historial sigue leyendo ambas fuentes y maestros inactivos con el where existente', async () => {
    const count = vi.fn(async (_args: any) => 1);
    const findMany = vi.fn(async (_args: any) => [{
      id: 'document-mock', companyId: 2, immutableSnapshot: { issuer: { identityNumber: '00000000002' } },
      company: { ruc: '00000000002', active: false }, emissionPoint: { active: false, branch: { active: false, name: 'SEDE INACTIVA DEL MOCK' } },
      fullNumber: 'F001-1', type: 'INVOICE', customerLegalName: 'CLIENTE DEL MOCK', payableAmount: { toString: () => '1.00' }, currencyCode: 'PEN', sunatStatus: 'PENDING', issueDate: new Date('2030-01-01T05:00:00Z'), sunatResponseDescription: null,
    }]);
    const service = new IssuanceQueryService({ document: { count, findMany }, $transaction: (queries: Promise<unknown>[]) => Promise.all(queries) } as never);
    const result = await service.recentDocuments({ kind: 'GLOBAL' });
    expect(count.mock.calls[0][0].where).toEqual({ emissionPoint: {} });
    expect(findMany.mock.calls[0][0].where).toEqual({ emissionPoint: {} });
    expect(result.items[0]).toMatchObject({ companyId: 2, issuerRuc: '00000000002', branchName: 'SEDE INACTIVA DEL MOCK' });
  });
});

describe('Fuente explícita en listados y totales, sin ampliar alcance', () => {
  function queries() {
    const document = { count: vi.fn(async (_args: any) => 0), findMany: vi.fn(async (_args: any) => []),
      aggregate: vi.fn(async (_args: any) => ({ _count: { _all: 0 }, _sum: {} })), groupBy: vi.fn(async (_args: any) => []) };
    return { document, service: new IssuanceQueryService({ document, $transaction: (q: Promise<unknown>[]) => Promise.all(q) } as never) };
  }
  it.each(['BUSINESS', 'SYNTHETIC', 'ALL'])('%s filtra en SQL tanto filas como cuenta y agregados', async source => {
    const f = queries();
    const scope: AccessScope = { kind: 'ASSIGNED', branchIds: [branchB], emissionPointIds: [pointB], series: [seriesB] };
    const page = await f.service.recentDocuments(scope, undefined, 1, '', undefined, source);
    const summary = await f.service.dashboard(scope, undefined, undefined, source);
    const company = source === 'BUSINESS' ? { ruc: { not: { startsWith: '00' } } } : source === 'SYNTHETIC' ? { ruc: { startsWith: '00' } } : undefined;
    const calls = [f.document.count, f.document.findMany, f.document.aggregate, f.document.groupBy];
    for (const method of calls) for (const [args] of method.mock.calls) {
      expect(args.where.company).toEqual(company);
      expect(args.where.emissionPoint).toEqual({ id: { in: [pointB] }, branchId: { in: [branchB] } });
      expect(args.where.seriesCounterId).toEqual({ in: [seriesB] });
      expect(args.where).not.toHaveProperty('active');
    }
    expect(page.dataSource).toBe(source); expect(summary.dataSource).toBe(source);
  });
  it.each(['', 'business', 'PRODUCTION', 'ALL OR 1=1'])('rechaza fuente %s antes de consultar documentos', async source => {
    const f = queries();
    await expect(f.service.recentDocuments({ kind: 'GLOBAL' }, undefined, 1, '', undefined, source)).rejects.toMatchObject({ status: 400 });
    await expect(f.service.dashboard({ kind: 'GLOBAL' }, undefined, undefined, source)).rejects.toMatchObject({ status: 400 });
    expect(f.document.count).not.toHaveBeenCalled(); expect(f.document.aggregate).not.toHaveBeenCalled();
  });
});
