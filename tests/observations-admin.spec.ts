import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionCodes } from '../packages/contracts/src';
import { ProductAdminService } from '../services/billing-service/src/application/product-admin.service';
import { UserAdministrationService } from '../services/identity-service/src/application/user-administration.service';
import { UserPermissionsService, validateExtraPermissions } from '../services/identity-service/src/application/user-permissions.service';
import { pageWindow } from '../apps/web-pwa/features/workspace/list-pagination';

const userId = '50000000-0000-4000-8000-000000000002';
const actor: any = { sub: '50000000-0000-4000-8000-000000000001', roles: ['ADMIN'], scope: { kind: 'GLOBAL' }, permissions: Object.values(PermissionCodes) };
afterEach(() => vi.unstubAllGlobals());
function products() {
  const row = { id: userId, updatedAt: new Date('2026-01-01T00:00:00.000Z'), sku: 'QA', active: true };
  const tx = { $queryRaw: vi.fn(async () => []), fuelProduct: { findUnique: vi.fn(async () => row), create: vi.fn(async ({ data }: any) => ({ ...row, ...data })), update: vi.fn(async ({ data }: any) => ({ ...row, ...data })) }, configurationAudit: { create: vi.fn(async () => ({})) } };
  return { tx, service: new ProductAdminService({ $transaction: (work: any) => work(tx), fuelProduct: { findMany: vi.fn(async () => []) } } as never) };
}
describe('observaciones: productos sin alterar documentos anteriores', () => {
  it('crea producto válido y registra sólo campos de configuración', async () => {
    const f = products();
    const result = await f.service.save(undefined, { sku: 'QA-01', description: 'Producto ficticio', category: 'Pruebas', unitCode: 'GLL', taxAffectationCode: '10', defaultUnitPrice: '12.345678' }, { user: actor } as never);
    expect(result).toMatchObject({ sku: 'QA-01', defaultUnitPrice: '12.345678' });
    expect(f.tx.configurationAudit.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'product.created', metadata: expect.objectContaining({ historicalDocumentsChanged: false }) }) }));
  });
  it('desactiva sin borrar ni modificar los ítems históricos', async () => {
    const f = products();
    await f.service.save(userId, { active: false, expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }, { user: actor } as never);
    expect(f.tx.fuelProduct.update).toHaveBeenCalledWith(expect.objectContaining({ data: { active: false } }));
    expect(f.tx.configurationAudit.create.mock.calls[0][0].data.action).toBe('product.deactivated');
  });
  it.each([{ active: 'false' }, { defaultUnitPrice: '-2' }, { defaultUnitPrice: '1.1234567' }, { defaultUnitPrice: '1e2' }, { unitCode: 'XX' }, { taxAffectationCode: '99' }, { sunatProductCode: 'abc' }, { description: '\u202edata' }, { number: 0 }])('rechaza campos inválidos %j antes de escribir', async patch => {
    const f = products(); await expect(f.service.save(userId, { expectedUpdatedAt: '2026-01-01T00:00:00.000Z', ...patch }, { user: actor } as never)).rejects.toThrow();
    expect(f.tx.fuelProduct.update).not.toHaveBeenCalled();
  });
  it('rechaza revisión anterior y permisos fuera de administración global', async () => {
    const f = products(); await expect(f.service.save(userId, { active: false, expectedUpdatedAt: '2025-01-01T00:00:00.000Z' }, { user: actor } as never)).rejects.toThrow('cambió');
    for (const user of [{ ...actor, scope: { kind: 'ASSIGNED', branchIds: [] } }, { ...actor, roles: ['STATION_MANAGER'] }, { ...actor, permissions: [] }]) await expect(f.service.save(userId, { active: false }, { user } as never)).rejects.toThrow('administrador general');
  });
});
describe('observaciones: roles vigentes y cambios auditados', () => {
  it('devuelve los permisos almacenados, no el preset hardcodeado', async () => {
    const service = new UserAdministrationService({ role: { findMany: vi.fn(async () => [{ id: userId, code: 'CASHIER', permissions: [{ permission: { name: 'document.view' } }] }]) } } as never, {} as never);
    expect((await service.listRoles(actor))[0]).toMatchObject({ permissions: ['document.view'], editable: true });
  });
  it('guarda una matriz y revoca sesiones de todas las cuentas afectadas', async () => {
    const tx = { $queryRawUnsafe: vi.fn(), role: { findUnique: vi.fn(async () => ({ id: 'role', active: true, permissions: [{ permission: { name: 'document.view' } }], users: [{ userId }] })) }, permission: { findMany: vi.fn(async () => [{ id: 'permission' }]) }, rolePermission: { deleteMany: vi.fn(), createMany: vi.fn() }, user: { updateMany: vi.fn() }, refreshSession: { updateMany: vi.fn() }, auditLog: { create: vi.fn() } };
    const service = new UserAdministrationService({ $transaction: (work: any) => work(tx) } as never, {} as never);
    await service.updateRole('CASHIER', { expectedPermissions: ['document.view'], permissions: ['report.view'] }, actor);
    expect(tx.user.updateMany).toHaveBeenCalledWith({ where: { id: { in: [userId] } }, data: { authVersion: { increment: 1 } } });
    expect(tx.refreshSession.updateMany).toHaveBeenCalledOnce(); expect(tx.auditLog.create).toHaveBeenCalledOnce();
    await expect(service.updateRole('CASHIER', { expectedPermissions: [], permissions: [] }, actor)).rejects.toThrow('cambió');
  });
  it.each([{ code: 'ADMIN', body: { permissions: [], expectedPermissions: [] } }, { code: 'CASHIER', body: { permissions: ['inventado'], expectedPermissions: [] } }, { code: 'CASHIER', body: { permissions: ['document.view', 'document.view'], expectedPermissions: [] } }, { code: 'CASHIER', body: { permissions: [], expectedPermissions: [], scope: 'GLOBAL' } }])('rechaza cambios inválidos %j', async ({ code, body }) => {
    const service = new UserAdministrationService({} as never, {} as never); await expect(service.updateRole(code, body, actor)).rejects.toThrow();
    await expect(service.updateRole('CASHIER', { permissions: [], expectedPermissions: [] }, { ...actor, scope: { kind: 'ASSIGNED' } })).rejects.toThrow('general');
  });
});
describe('observaciones: permisos individuales preparados sin ampliación de sede', () => {
  it.each([['sunat.configure'], ['role.manage'], ['setup.manage'], ['document.view', 'document.view'], 'document.view', null])('rechaza permisos no delegables %j', value => expect(() => validateExtraPermissions(value)).toThrow());
  it('acepta consulta y exportación como facultades diferentes', () => expect(() => validateExtraPermissions(['document.view', 'report.export'])).not.toThrow());
  it('no concede extras ni crea tablas cuando el esquema no está preparado', async () => {
    const query = vi.fn(async () => [{ ready: false }]);
    const service = new UserPermissionsService({ $queryRaw: query } as never);
    expect(await service.effective(userId)).toEqual([]); expect(query).toHaveBeenCalledOnce();
    await expect(service.update(userId, { permissions: ['report.view'], expectedAuthVersion: 1 }, actor)).rejects.toThrow('preparación');
  });
  it('no permite modificar ADMIN propio ni solicitudes fuera de alcance global', async () => {
    const service = new UserPermissionsService({} as never);
    await expect(service.status(actor.sub, actor)).rejects.toThrow('propio');
    await expect(service.status(userId, { ...actor, roles: ['STATION_MANAGER'] })).rejects.toThrow('general');
  });
  function individualFixture(role = 'CASHIER', version = 3) {
    const target = { id: userId, authVersion: version, roles: [{ role: { code: role } }] };
    const query = vi.fn(async (strings: TemplateStringsArray) => strings.join('').includes('to_regclass') ? [{ ready: true }] : [{ permission: 'document.view' }]);
    const tx = { $queryRaw: vi.fn(async () => [{ permission: 'document.view' }]), $executeRaw: vi.fn(), user: { findUnique: vi.fn(async () => target), update: vi.fn() }, refreshSession: { updateMany: vi.fn() }, auditLog: { create: vi.fn() } };
    const service = new UserPermissionsService({ $queryRaw: query, user: tx.user, $transaction: (work: any) => work(tx) } as never);
    return { service, tx };
  }
  it('persiste únicamente permisos operativos y revoca sesiones sin ampliar sedes', async () => {
    const f = individualFixture();
    await f.service.update(userId, { permissions: ['document.view', 'report.export'], expectedAuthVersion: 3 }, actor);
    expect(f.tx.$executeRaw).toHaveBeenCalledTimes(3);
    expect(f.tx.user.update).toHaveBeenCalledWith({ where: { id: userId }, data: { authVersion: { increment: 1 } } });
    expect(f.tx.refreshSession.updateMany).toHaveBeenCalledOnce();
    expect(f.tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'user.extra-permissions.updated', metadata: { before: ['document.view'], after: ['document.view', 'report.export'], scopeChanged: false } }) }));
    expect(Object.keys(f.tx)).not.toContain('userBranch');
  });
  it('rechaza revisiones vencidas antes de escribir permisos', async () => {
    const f = individualFixture();
    await expect(f.service.update(userId, { permissions: [], expectedAuthVersion: 2 }, actor)).rejects.toThrow('cambió');
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it('protege otra cuenta ADMIN incluso con la tabla preparada', async () => {
    const f = individualFixture('ADMIN');
    await expect(f.service.update(userId, { permissions: ['report.export'], expectedAuthVersion: 3 }, actor)).rejects.toThrow('protegido');
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
});
describe('paginación de listas completas cargadas', () => {
  it.each([[0, 1, 1, 0, 0], [25, 3, 3, 20, 25], [25, 9, 3, 20, 25], [1, 0, 1, 0, 1]])('acota %s registros, página %s', (total, requested, page, start, end) => expect(pageWindow(total, requested)).toMatchObject({ page, start, end }));
});
