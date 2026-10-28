import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StationAdminService } from '../services/billing-service/src/application/station-admin.service';
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
    branch: [{ id: branchId, companyId: 1, code: 'SEDE01', name: 'Sede ficticia', address: null, active: true, masterRevision: 1 }],
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

describe('CRUD privado de emisores, sedes, puntos y series', () => {
  beforeEach(() => vi.stubEnv('STATION_MASTER_CRUD_ENABLED', 'true'));
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    undefined,
    { ...request.user, roles: ['CASHIER'] },
    { ...request.user, scope: { kind: 'ASSIGNED', branchIds: [branchId], emissionPointIds: [pointId], series: [seriesId] } },
    { ...request.user, permissions: [] },
  ])('rechaza lectura y escritura sin administrador general y permiso: %j', async user => {
    const f = fixture();
    await expect(f.service.catalog({ user } as never)).rejects.toThrow('administrador general');
    await expect(f.service.createIssuer(issuerDraft, { user } as never)).rejects.toThrow('administrador general');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('mantiene permisos separados para configuración y series', async () => {
    const f = fixture();
    const setupOnly = { user: { ...request.user, permissions: ['setup.manage'] } } as any;
    await expect(f.service.createSeries(pointId, { documentType: 'INVOICE', series: 'F002' }, setupOnly)).rejects.toThrow('permiso');
    await expect(f.service.createIssuer(issuerDraft, setupOnly)).resolves.toMatchObject({ ruc: issuerDraft.ruc });
  });
  it('el flag cerrado bloquea el CRUD antes de abrir transacción', async () => {
    vi.stubEnv('STATION_MASTER_CRUD_ENABLED', 'false'); const f = fixture();
    await expect(f.service.catalog(request)).rejects.toThrow('no está habilitado');
    await expect(f.service.updatePoint(pointId, { expectedRevision: 1, name: 'Cambio' }, request)).rejects.toThrow('no está habilitado');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('lista sólo Beta con lectura consistente y sin secretos; conserva inactivos y correlativos exactos', async () => {
    const f = fixture(); f.state.companySettings[0].active = false; f.state.companySettings[1].environment = 'PRODUCTION';
    f.state.seriesCounter[0].nextNumber = 9007199254740993n;
    const result = await f.controller.catalog(request);
    expect(result.version).toBe(STATION_ADMIN_VERSION);
    expect(result.capabilities).toEqual({ betaOnly: true, softDelete: true, counterEditing: false });
    expect(result.companies).toHaveLength(1); expect(result.companies[0].active).toBe(false);
    expect(result.branches[0].effectiveActive).toBe(false); expect(result.emissionPoints[0].effectiveActive).toBe(false);
    expect(result.series[0]).toMatchObject({ effectiveActive: false, canRename: false, nextNumber: '9007199254740993' });
    expect(f.prisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'RepeatableRead' });
    expect(Object.keys(f.tx.companySettings.findMany.mock.calls[0][0].select)).not.toContain('certificate');
  });
  it('crea emisor Beta, sus datos de contacto y auditoría, sin activar SUNAT', async () => {
    const f = fixture();
    const created = await f.service.createIssuer({ ...issuerDraft, tradeName: 'Comercial ficticio', phone: '000', contactEmails: ['qa@pruebas.invalid'] }, request);
    expect(created).toMatchObject({ active: true, environment: 'BETA', revision: 1, ruc: issuerDraft.ruc });
    expect(f.state.configurationAudit[0]).toMatchObject({ action: 'issuer.created', actorId: request.user.sub, metadata: { environment: 'BETA', softDelete: false } });
    expect(f.state.outboxEvent).toEqual([]); expect(f.state.document).toEqual([]);
  });
  it('edita cabecera del emisor sin cambiar RUC, documentos ni contadores', async () => {
    const f = fixture(); const frozen = { seriesCounterId: seriesId, immutableSnapshot: { issuer: { legalName: 'ORIGINAL' } } };
    f.state.document.push(structuredClone(frozen));
    await f.service.updateIssuer('1', { expectedRevision: 1, legalName: 'FICTICIO EDITADO', tradeName: null, phone: null, contactEmails: [] }, request);
    expect(f.state.companySettings[0]).toMatchObject({ ruc: '00000000001', legalName: 'FICTICIO EDITADO', configVersion: 2 });
    expect(f.state.document[0]).toEqual(frozen); expect(f.state.seriesCounter[0].nextNumber).toBe(1n);
    expect(f.tx.document.update).not.toHaveBeenCalled(); expect(f.tx.outboxEvent.create).not.toHaveBeenCalled();
  });
  it.each(['ruc', 'environment', 'certificate', 'solPassword', 'configVersion', 'id'])('rechaza campo protegido de emisor %s', async field => {
    const f = fixture();
    await expect(f.service.updateIssuer('1', { expectedRevision: 1, [field]: 'protegido' }, request)).rejects.toThrow('Campos no admitidos');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    { legalName: '' }, { legalName: 'X\u202e' }, { ubigeo: '12345' }, { phone: 'X'.repeat(41) },
    { contactEmails: ['no correo'] }, { active: 'false' }, { expectedRevision: '1', legalName: 'QA' },
  ])('rechaza entradas inválidas sin cambios persistentes: %j', async patch => {
    const f = fixture();
    await expect(f.service.updateIssuer('1', { expectedRevision: 1, ...patch }, request)).rejects.toThrow();
    expect(f.state.companySettings[0].configVersion).toBe(1); expect(f.state.configurationAudit).toEqual([]);
  });
  it('revisión obsoleta devuelve conflicto en los cuatro niveles, sin sobrescribir', async () => {
    const f = fixture();
    for (const action of [() => f.service.updateIssuer('1', { expectedRevision: 2, legalName: 'QA' }, request),
      () => f.service.updateBranch(branchId, { expectedRevision: 2, name: 'QA' }, request),
      () => f.service.updatePoint(pointId, { expectedRevision: 2, name: 'QA' }, request),
      () => f.service.updateSeries(seriesId, { expectedRevision: 2, active: false }, request)]) await expect(action()).rejects.toThrow('El registro cambió');
    expect(f.state.configurationAudit).toHaveLength(0);
  });
  it('duplicados devuelven conflicto y revierten auditoría', async () => {
    const f = fixture();
    await expect(f.service.createIssuer({ ...issuerDraft, ruc: '00000000001' }, request)).rejects.toThrow('ya existe');
    await expect(f.service.createSeries(pointId, { documentType: 'INVOICE', series: 'F001' }, request)).rejects.toThrow('ya existe');
    expect(f.state.configurationAudit).toHaveLength(0); expect(f.state.seriesCounter).toHaveLength(1);
  });
  it('auditoría y cambio son atómicos si falla persistir el registro de auditoría', async () => {
    const f = fixture(); f.tx.configurationAudit.create.mockRejectedValueOnce(new Error('Fallo sintético de auditoría'));
    await expect(f.service.updateBranch(branchId, { expectedRevision: 1, name: 'No debe persistir' }, request)).rejects.toThrow('auditoría');
    expect(f.state.branch[0]).toMatchObject({ name: 'Sede ficticia', masterRevision: 1 });
  });
  it.each(['issuer', 'branch', 'point'] as const)('DELETE %s desactiva y PATCH reactiva sin borrar dependencias', async kind => {
    const f = fixture();
    const table = kind === 'issuer' ? 'companySettings' : kind === 'branch' ? 'branch' : 'emissionPoint';
    if (kind === 'issuer') { await f.controller.deactivateIssuer('1', { expectedRevision: 1 }, request); await f.controller.updateIssuer('1', { expectedRevision: 2, active: true }, request); }
    if (kind === 'branch') { await f.controller.deactivate(branchId, { expectedRevision: 1 }, request); await f.controller.update(branchId, { expectedRevision: 2, active: true }, request); }
    if (kind === 'point') { await f.controller.deactivatePoint(pointId, { expectedRevision: 1 }, request); await f.controller.updatePoint(pointId, { expectedRevision: 2, active: true }, request); }
    expect(f.state[table][0].active).toBe(true);
    for (const model of Object.values(f.tx) as any[]) if (model?.delete) { expect(model.delete).not.toHaveBeenCalled(); expect(model.deleteMany).not.toHaveBeenCalled(); }
    expect(f.state.seriesCounter[0].nextNumber).toBe(1n); expect(f.state.configurationAudit[0].metadata.softDelete).toBe(true);
  });
  it.each(['issuer', 'branch', 'point'] as const)('turno abierto impide desactivar %s', async kind => {
    const f = fixture(); f.state.shift.push({ emissionPointId: pointId, status: 'OPEN' });
    const action = kind === 'issuer' ? f.service.deactivateIssuer('1', { expectedRevision: 1 }, request)
      : kind === 'branch' ? f.service.deactivateBranch(branchId, { expectedRevision: 1 }, request) : f.service.deactivatePoint(pointId, { expectedRevision: 1 }, request);
    await expect(action).rejects.toThrow('turnos abiertos'); expect(f.state.configurationAudit).toHaveLength(0);
  });
  it.each(['issuer', 'branch', 'point'] as const)('un padre inactivo bloquea la creación de series: %s', async kind => {
    const f = fixture(); f.state[kind === 'issuer' ? 'companySettings' : kind === 'branch' ? 'branch' : 'emissionPoint'][0].active = false;
    await expect(f.service.createSeries(pointId, { documentType: 'INVOICE', series: 'F002' }, request)).rejects.toThrow('inactivo');
    expect(f.state.seriesCounter).toHaveLength(1);
  });
  it('emisor inactivo impide reactivar sede o punto, pero permite editar su nombre', async () => {
    const f = fixture(); f.state.companySettings[0].active = false; f.state.branch[0].active = false; f.state.emissionPoint[0].active = false;
    await expect(f.service.updateBranch(branchId, { expectedRevision: 1, active: true }, request)).rejects.toThrow('Emisor inactivo');
    await expect(f.service.updatePoint(pointId, { expectedRevision: 1, active: true }, request)).rejects.toThrow('Emisor inactivo');
    await expect(f.service.updateBranch(branchId, { expectedRevision: 1, name: 'Nombre corregido' }, request)).resolves.toMatchObject({ active: false });
  });
  it('crear punto crea ambas series en la misma transacción y revierte todo al duplicar', async () => {
    const f = fixture();
    await expect(f.service.createPoint(branchId, { code: 'CAJA02', name: 'Nueva', invoiceSeries: 'F001', receiptSeries: 'B002' }, request)).rejects.toThrow('ya existe');
    expect(f.state.emissionPoint).toHaveLength(1); expect(f.state.seriesCounter).toHaveLength(1);
    await f.service.createPoint(branchId, { code: 'CAJA02', name: 'Nueva', address: null, trackNumber: 2, invoiceSeries: 'F002', receiptSeries: 'B002' }, request);
    expect(f.state.emissionPoint).toHaveLength(2); expect(f.state.seriesCounter.slice(1).map(r => r.nextNumber)).toEqual([1n, 1n]);
  });
  it('edita sede y punto sin mover su propietario ni series', async () => {
    const f = fixture();
    await f.controller.update(branchId, { expectedRevision: 1, code: 'SEDE_QA', name: 'Nueva denominación', address: 'Dirección QA' }, request);
    await f.controller.updatePoint(pointId, { expectedRevision: 1, code: 'CAJA_QA', name: 'Caja renombrada', address: null, trackNumber: 3 }, request);
    expect(f.state.branch[0]).toMatchObject({ companyId: 1, masterRevision: 2 });
    expect(f.state.emissionPoint[0]).toMatchObject({ branchId, companyId: 1, masterRevision: 2, trackNumber: 3 });
    expect(f.state.seriesCounter[0].emissionPointId).toBe(pointId);
  });
  it('cambiar RUC de sede sólo se permite antes de crear puntos, incluidos los inactivos', async () => {
    const f = fixture(); f.state.emissionPoint[0].active = false;
    await expect(f.service.assignIssuer(branchId, { companyId: 2, expectedRevision: 1 }, request)).rejects.toThrow('ya tiene puntos');
    f.state.emissionPoint = []; f.state.seriesCounter = [];
    await f.service.assignIssuer(branchId, { companyId: 2, expectedRevision: 1 }, request);
    expect(f.state.branch[0]).toMatchObject({ companyId: 2, masterRevision: 2 });
  });
  it.each(['issuer', 'branch', 'point', 'series'] as const)('producción bloqueada para editar %s', async kind => {
    const f = fixture(); f.state.companySettings[0].environment = 'PRODUCTION';
    const action = kind === 'issuer' ? f.service.updateIssuer('1', { expectedRevision: 1, legalName: 'QA' }, request)
      : kind === 'branch' ? f.service.updateBranch(branchId, { expectedRevision: 1, name: 'QA' }, request)
      : kind === 'point' ? f.service.updatePoint(pointId, { expectedRevision: 1, name: 'QA' }, request)
      : f.service.updateSeries(seriesId, { expectedRevision: 1, active: false }, request);
    await expect(action).rejects.toThrow('producción bloqueada'); expect(f.state.configurationAudit).toHaveLength(0);
  });
  it.each(['INVOICE', 'SALES_RECEIPT', 'CREDIT_NOTE', 'DEBIT_NOTE', 'DESPATCH_ADVICE'] as const)('crea serie válida %s sin ejecutar una emisión', async documentType => {
    const f = fixture(); const series = documentType === 'SALES_RECEIPT' ? 'B002' : documentType === 'DESPATCH_ADVICE' ? 'T002' : 'F002';
    await expect(f.controller.createSeries(pointId, { documentType, series }, request)).resolves.toMatchObject({ documentType, series, nextNumber: '1' });
    expect(f.state.document).toHaveLength(0); expect(f.state.outboxEvent).toHaveLength(0);
  });
  it.each([{ documentType: 'INVOICE', series: 'B002' }, { documentType: 'SALES_RECEIPT', series: 'F002' },
    { documentType: 'DESPATCH_ADVICE', series: 'V002' }, { documentType: 'TRANSPORT_GUIDE', series: 'V002' }])('rechaza tipo o prefijo inválido: %j', async body => {
    const f = fixture(); await expect(f.service.createSeries(pointId, body, request)).rejects.toThrow(); expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('renombra serie no usada sin cambiar UUID, dueño, tipo o correlativo', async () => {
    const f = fixture(); await f.controller.updateSeries(seriesId, { expectedRevision: 1, series: 'f002' }, request);
    expect(f.state.seriesCounter[0]).toMatchObject({ id: seriesId, series: 'F002', nextNumber: 1n, companyId: 1, emissionPointId: pointId, documentType: 'INVOICE', masterRevision: 2 });
    const tables = f.tx.$queryRawUnsafe.mock.calls.map((call: any[]) => call[0].match(/FROM "(\w+)"/)[1]);
    expect(tables).toEqual(['CompanySettings', 'Branch', 'EmissionPoint', 'SeriesCounter']);
    expect(f.tx.$queryRawUnsafe.mock.calls.every((call: any[]) => call[0].includes('FOR UPDATE') && call.length === 2)).toBe(true);
  });
  it.each(['consumed', 'document'] as const)('historial %s impide renombrar, pero permite desactivar y reactivar', async reason => {
    const f = fixture(); if (reason === 'consumed') f.state.seriesCounter[0].nextNumber = 25n; else f.state.document.push({ seriesCounterId: seriesId });
    const number = f.state.seriesCounter[0].nextNumber;
    await expect(f.service.updateSeries(seriesId, { expectedRevision: 1, series: 'F002' }, request)).rejects.toThrow('no se permite renombrar');
    await f.controller.deactivateSeries(seriesId, { expectedRevision: 1 }, request);
    await f.controller.updateSeries(seriesId, { expectedRevision: 2, active: true }, request);
    expect(f.state.seriesCounter[0]).toMatchObject({ series: 'F001', nextNumber: number, active: true });
  });
  it.each(['nextNumber', 'companyId', 'emissionPointId', 'documentType', 'masterRevision'])('no acepta edición del campo protegido de serie %s', async field => {
    const f = fixture(); await expect(f.service.updateSeries(seriesId, { expectedRevision: 1, [field]: 'protegido' }, request)).rejects.toThrow('Campos no admitidos');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('identificadores inválidos no se interpolan en SQL', async () => {
    const f = fixture(); await expect(f.service.updatePoint("x';DELETE FROM Document", { expectedRevision: 1, name: 'QA' }, request)).rejects.toThrow('Identificador inválido');
    expect(f.tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
