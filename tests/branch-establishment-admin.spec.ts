import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StationAdminService } from '../services/billing-service/src/application/station-admin.service';
import { BillingPhase8AdminBindingOwner } from '../services/billing-service/src/b2b/phase8-admin';
import { StationsController } from '../services/billing-service/src/stations.controller';
import { PermissionCodes, STATION_ADMIN_VERSION } from '../packages/contracts/src';

const branchId = '10000000-0000-4000-8000-000000000001';
const pointId = '20000000-0000-4000-8000-000000000001';
const seriesId = '40000000-0000-4000-8000-000000000001';
const request = { user: { sub: '30000000-0000-4000-8000-000000000001', scope: { kind: 'GLOBAL' },
  roles: ['ADMIN'], permissions: [PermissionCodes.SETUP_MANAGE, PermissionCodes.SERIES_MANAGE] } } as any;
const issuerDraft = { ruc: '00000000003', legalName: 'EMISOR FICTICIO C', taxAddress: 'Dirección de prueba', ubigeo: '200101' };

// Sólo datos sintéticos en memoria. El rollback reproduce el límite transaccional del servicio.
function fixture() {
  const state: Record<string, any[]> = {
    companySettings: [1, 2].map(id => ({ id, ruc: `0000000000${id}`, legalName: `FICTICIO ${id}`, taxAddress: 'Dirección ficticia',
      ubigeo: '200101', tradeName: null, phone: null, contactEmails: [], environment: 'BETA', active: true, configVersion: 1 })),
    branch: [{ id: branchId, companyId: 1, code: 'SEDE01', name: 'Sede ficticia', address: null, establishmentCode: null, active: true, masterRevision: 1 }],
    emissionPoint: [{ id: pointId, companyId: 1, branchId, code: 'CAJA01', name: 'Caja ficticia', address: null, trackNumber: null, active: true, masterRevision: 1 }],
    seriesCounter: [{ id: seriesId, companyId: 1, emissionPointId: pointId, documentType: 'INVOICE', series: 'F001', nextNumber: 1n, active: true, masterRevision: 1 }],
    document: [], shift: [], configurationAudit: [], outboxEvent: [],
  };
  function matches(row: any, where: any = {}) {
    return Object.entries(where).every(([key, value]: any) => {
      if (key === 'emissionPoint') return matches(state.emissionPoint.find(p => p.id === row.emissionPointId), value);
      if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row?.[key]);
      return row?.[key] === value;
    });
  }
  function output(table: string, row: any, args: any) {
    if (!row) return null;
    const result = structuredClone(args.select ? Object.fromEntries(Object.keys(args.select).map(key => [key, row[key]])) : row);
    if (args.include?._count) result._count = table === 'branch' ? { emissionPoints: state.emissionPoint.filter(p => p.branchId === row.id).length }
      : table === 'emissionPoint' ? { shifts: state.shift.filter(s => s.emissionPointId === row.id && s.status === 'OPEN').length }
      : { documents: state.document.filter(d => d.seriesCounterId === row.id).length };
    return result;
  }
  const tx: any = { $queryRawUnsafe: vi.fn(async () => []) };
  for (const table of Object.keys(state)) {
    tx[table] = {
      findUnique: vi.fn(async (args: any) => output(table, state[table].find(row => matches(row, args.where)), args)),
      findUniqueOrThrow: vi.fn(async (args: any) => { const row = state[table].find(row => matches(row, args.where)); if (!row) throw { code: 'P2025' }; return output(table, row, args); }),
      findMany: vi.fn(async (args: any) => state[table].filter(row => matches(row, args.where)).map(row => output(table, row, args))),
      count: vi.fn(async (args: any) => state[table].filter(row => matches(row, args.where)).length),
      create: vi.fn(async (args: any) => {
        if (table === 'companySettings' && state[table].some(r => r.ruc === args.data.ruc) ||
          ['branch', 'emissionPoint'].includes(table) && state[table].some(r => r.code === args.data.code) ||
          table === 'seriesCounter' && state[table].some(r => r.companyId === args.data.companyId && r.documentType === args.data.documentType && r.series === args.data.series)) throw { code: 'P2002' };
        const row = { id: table === 'companySettings' ? state[table].length + 1 : randomUUID(), active: true, masterRevision: 1, configVersion: 1,
          ...(table === 'seriesCounter' ? { nextNumber: 1n } : {}), ...args.data };
        state[table].push(row);
        if (table === 'emissionPoint' && args.data.counters?.create) {
          const nested = [];
          for (const data of args.data.counters.create) nested.push(await tx.seriesCounter.create({ data: { ...data, companyId: row.companyId, emissionPointId: row.id } }));
          return { ...output(table, row, args), counters: nested };
        }
        return output(table, row, args);
      }),
      update: vi.fn(async (args: any) => {
        const row = state[table].find(r => matches(r, args.where)); if (!row) throw { code: 'P2025' };
        if (table === 'seriesCounter' && args.data.series && state[table].some(r => r.id !== row.id && r.companyId === row.companyId && r.documentType === row.documentType && r.series === args.data.series)) throw { code: 'P2002' };
        for (const [key, value] of Object.entries(args.data)) row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + (value as any).increment : value;
        return output(table, row, args);
      }),
      delete: vi.fn(), deleteMany: vi.fn(),
    };
  }
  const prisma = { $transaction: vi.fn(async (work: any) => {
    const backup = structuredClone(state);
    try { return await work(tx); } catch (error) { for (const key of Object.keys(state)) state[key] = backup[key]; throw error; }
  }) };
  const service = new StationAdminService(prisma as never);
  return { service, controller: new StationsController(service), state, tx, prisma };
}


describe('Establecimiento SUNAT persistido por sede', () => {
  beforeEach(() => { vi.stubEnv('STATION_MASTER_CRUD_ENABLED', 'true'); vi.stubEnv('BILLING_PRODUCTION_ISSUANCE_ENABLED', 'false'); });
  afterEach(() => vi.unstubAllEnvs());
  const human = () => ({ ...request, headers: { authorization: 'Bearer SYNTHETIC.HUMAN.TEST' } });
  const draft = { companyId: 1, code: 'SEDE_NUEVA', name: 'Sede sintética' };
  it.each([undefined, null, '0042', '9876'])('crea sin inventar establecimiento y conserva ceros: %s', async establishmentCode => {
    const f = fixture();
    const result = await f.service.createBranch({ ...draft, ...(establishmentCode === undefined ? {} : { establishmentCode }) }, request);
    expect(result.establishmentCode).toBe(establishmentCode ?? null);
    expect(f.state.configurationAudit[0].metadata.changedFields).toContain('establishmentCode');
    expect(f.tx.seriesCounter.update).not.toHaveBeenCalled();
  });
  it.each(['', '42', '12345', ' 0042', '0042 ', '00a2', '１２３４', '٠٠٤٢', '0042\n', 42, false, {}, undefined])('rechaza valor no exacto %j en create/update', async establishmentCode => {
    const f = fixture();
    await expect(f.service.createBranch({ ...draft, establishmentCode }, request)).rejects.toThrow('4 dígitos');
    await expect(f.service.updateBranch(branchId, { expectedRevision: 1, establishmentCode }, request)).rejects.toThrow('4 dígitos');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('lee, configura, omite y limpia con null, incrementando revisión sin mover RUC/puntos/series/historial', async () => {
    const f = fixture();
    f.state.document.push({ seriesCounterId: seriesId, immutableSnapshot: { issuer: { establishmentCode: '0099' } } });
    const before = structuredClone({ points: f.state.emissionPoint, counters: f.state.seriesCounter, documents: f.state.document });
    expect((await f.service.catalog(request)).branches[0].establishmentCode).toBeNull();
    await f.service.updateBranch(branchId, { expectedRevision: 1, establishmentCode: '0042' }, request);
    expect((await f.service.catalog(request)).branches[0]).toMatchObject({ establishmentCode: '0042', companyId: 1, revision: 2 });
    await f.service.updateBranch(branchId, { expectedRevision: 2, name: 'Cambio local' }, request);
    expect(f.state.branch[0].establishmentCode).toBe('0042');
    await f.service.updateBranch(branchId, { expectedRevision: 3, establishmentCode: null }, request);
    expect(f.state.branch[0]).toMatchObject({ establishmentCode: null, companyId: 1, masterRevision: 4 });
    expect({ points: f.state.emissionPoint, counters: f.state.seriesCounter, documents: f.state.document }).toEqual(before);
    expect(f.state.configurationAudit.at(-1).metadata).toMatchObject({ changedFields: ['establishmentCode'], issuerRuc: '00000000001' });
  });
  it('respeta CAS y revierte el establecimiento si falla la auditoría', async () => {
    const f = fixture();
    await expect(f.service.updateBranch(branchId, { expectedRevision: 2, establishmentCode: '0042' }, request)).rejects.toThrow('El registro cambió');
    f.tx.configurationAudit.create.mockRejectedValueOnce(new Error('auditoría no disponible'));
    await expect(f.service.updateBranch(branchId, { expectedRevision: 1, establishmentCode: '0042' }, request)).rejects.toThrow('auditoría');
    expect(f.state.branch[0]).toMatchObject({ establishmentCode: null, masterRevision: 1 });
    expect(f.state.configurationAudit).toEqual([]);
  });
  it('no acepta establecimiento en punto ni ownership en edición de sede', async () => {
    const f = fixture();
    await expect(f.service.updatePoint(pointId, { expectedRevision: 1, establishmentCode: '0042' }, request)).rejects.toThrow('Campos no admitidos');
    await expect(f.service.createPoint(branchId, { code: 'CAJA02', name: 'Caja', establishmentCode: '0042', invoiceSeries: 'F002', receiptSeries: 'B002' }, request)).rejects.toThrow('Campos no admitidos');
    await expect(f.service.updateBranch(branchId, { expectedRevision: 1, companyId: 2, establishmentCode: '0042' }, request)).rejects.toThrow('Campos no admitidos');
    await expect(f.service.assignIssuer(branchId, { expectedRevision: 1, companyId: 2 }, request)).rejects.toThrow('No se permite cambiar su RUC');
    expect(f.tx.branch.update).not.toHaveBeenCalled();
  });
  it.each(['false', '', 'TRUE', '1'])('oculta y bloquea Producción sin flag exacto: %j', async flag => {
    vi.stubEnv('BILLING_PRODUCTION_ISSUANCE_ENABLED', flag);
    const f = fixture(); f.state.companySettings[0].environment = 'PRODUCTION';
    expect((await f.service.catalog(human())).companies.every(c => c.environment === 'BETA')).toBe(true);
    await expect(f.service.updateBranch(branchId, { expectedRevision: 1, establishmentCode: '0042' }, human())).rejects.toThrow('producción bloqueada');
    expect(f.tx.branch.update).not.toHaveBeenCalled();
  });
  it('admin humano con flag lista ambiente real y configura establecimiento Prod con auditoría', async () => {
    vi.stubEnv('BILLING_PRODUCTION_ISSUANCE_ENABLED', 'true');
    const f = fixture(); f.state.companySettings[0].environment = 'PRODUCTION';
    const catalog = await f.service.catalog(human());
    expect(catalog.capabilities).toEqual({ betaOnly: false, softDelete: true, counterEditing: false });
    expect(catalog.companies[0].environment).toBe('PRODUCTION');
    expect(catalog.companies[1].environment).toBe('BETA');
    await f.service.updateBranch(branchId, { expectedRevision: 1, establishmentCode: '0042' }, human());
    expect(f.state.branch[0]).toMatchObject({ establishmentCode: '0042', masterRevision: 2 });
    expect(f.state.configurationAudit[0].metadata.environment).toBe('PRODUCTION');
    expect(f.tx.seriesCounter.update).not.toHaveBeenCalled();
  });
  it('el canal delegado sin Bearer permanece Beta incluso con flag abierto', async () => {
    vi.stubEnv('BILLING_PRODUCTION_ISSUANCE_ENABLED', 'true');
    const f = fixture(); f.state.companySettings[0].environment = 'PRODUCTION';
    expect((await f.service.catalog({ ...request, headers: {} })).capabilities.betaOnly).toBe(true);
    await expect(f.service.updateBranch(branchId, { expectedRevision: 1, establishmentCode: '0042' }, { ...request, headers: {} })).rejects.toThrow('producción bloqueada');
    expect(f.tx.branch.update).not.toHaveBeenCalled();
  });
  it.each([
    { roles: ['CASHIER'] }, { permissions: ['series.manage'] }, { scope: { kind: 'ASSIGNED' } },
  ])('flag abierto conserva autoridad de administrador global: %j', async patch => {
    vi.stubEnv('BILLING_PRODUCTION_ISSUANCE_ENABLED', 'true'); const f = fixture();
    const req = { ...human(), user: { ...request.user, ...patch } } as any;
    await expect(f.service.updateBranch(branchId, { expectedRevision: 1, establishmentCode: '0042' }, req)).rejects.toThrow('administrador general');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('el binding owner B2B rechaza un emisor Prod aunque esté abierto el flag humano', async () => {
    vi.stubEnv('BILLING_PRODUCTION_ISSUANCE_ENABLED', 'true'); const f = fixture();
    const owner = new BillingPhase8AdminBindingOwner(f.prisma as never);
    const binding = { issuerId: 1, issuerRuc: '00000000001', environment: 'BETA' as const,
      branchId, pointId, seriesId, documentType: '01' as const };
    await expect(owner.revalidate(binding)).resolves.toMatchObject({ binding });
    f.state.companySettings[0].environment = 'PRODUCTION';
    await expect(owner.revalidate(binding)).rejects.toMatchObject({ code: 'ADMIN_OWNER_BINDING_CHANGED' });
    expect(f.tx.branch.update).not.toHaveBeenCalled();
  });
  it.each(['issuer', 'point', 'series'] as const)('el acceso humano habilita maestros Prod sin tocar numeración: %s', async kind => {
    vi.stubEnv('BILLING_PRODUCTION_ISSUANCE_ENABLED', 'true'); const f = fixture();
    f.state.companySettings[0].environment = 'PRODUCTION'; f.state.seriesCounter[0].nextNumber = 876n;
    if (kind === 'issuer') await f.service.updateIssuer('1', { expectedRevision: 1, legalName: 'SYNTHETIC EDITED' }, human());
    if (kind === 'point') await f.service.updatePoint(pointId, { expectedRevision: 1, name: 'SYNTHETIC EDITED' }, human());
    if (kind === 'series') await f.service.updateSeries(seriesId, { expectedRevision: 1, active: false }, human());
    expect(f.state.seriesCounter[0].nextNumber).toBe(876n);
    expect(f.state.configurationAudit[0].metadata).toMatchObject({ environment: 'PRODUCTION', issuerRuc: '00000000001' });
  });
});
