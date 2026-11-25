import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GUIDE_ROLES, GUIDE_PRODUCT_TYPES, GUIDE_UNITS, validateGuideSettingsWrite } from '../packages/contracts/src/guide-operational-settings';
import { GuideOperationalSettingsService } from '../services/billing-service/src/application/guide-operational-settings.service';
import { GuideOperationalSettingsController } from '../services/billing-service/src/guide-operational-settings.controller';
import { REQUIRED_PERMISSIONS_KEY, JwtPermissionGuard } from '../services/billing-service/src/auth/jwt-permission.guard';

export const draft = () => ({ expectedRevision: 0, settings: { role: 'AMBOS', products: [{ id: randomUUID(), name: 'Diésel B5 S-50 sintético', type: 'FUEL', unit: 'GLL' }], routes: [{ id: randomUUID(), name: 'Ruta ficticia', origin: { address: "Av. Ficticia O'Higgins 123", ubigeo: '150101', department: 'Lima', province: 'Lima', district: 'Lima', establishmentCode: '0001' }, destination: { address: 'Av. Prueba 456', ubigeo: '200101', department: 'Piura', province: 'Piura', district: 'Piura' } }] } });
const actor = { headers: {}, user: { sub: randomUUID(), scope: { kind: 'GLOBAL' }, roles: ['ADMIN'], permissions: ['setup.manage'] } } as any;

describe('guide operational contract', () => {
  it('accepts every role, regulated type and appropriate unit without recategorizing', () => {
    for (const role of GUIDE_ROLES) for (const type of GUIDE_PRODUCT_TYPES) for (const unit of GUIDE_UNITS) {
      const input = draft(); Object.assign(input.settings, { role }); Object.assign(input.settings.products[0], { type, unit });
      expect(validateGuideSettingsWrite(input)).toEqual({ ok: true, value: input });
    }
  });
  it.each(['ruc', 'actor', 'updatedBy', 'grant', 'activation', 'environment', 'counters', 'fiscalTransmission', 'trust', 'companyId'])('rejects spoofed %s at all object levels', key => {
    for (const target of ['', 'settings', 'product', 'route', 'point']) {
      const input: any = draft();
      const obj = target === '' ? input : target === 'settings' ? input.settings : target === 'product' ? input.settings.products[0] : target === 'route' ? input.settings.routes[0] : input.settings.routes[0].origin;
      obj[key] = true; expect(validateGuideSettingsWrite(input).ok).toBe(false);
    }
  });
  it('rejects incomplete lists, duplicates, control/bidi text, tags and invalid enums/codes', () => {
    const cases = [
      (d: any) => { d.settings.role = 'ADMIN'; }, (d: any) => { d.settings.products = []; }, (d: any) => { d.settings.routes = []; },
      (d: any) => { d.settings.products[0].type = 'FUEL_AS_GENERAL'; }, (d: any) => { d.settings.products[0].unit = 'L'; },
      (d: any) => { d.settings.routes[0].origin.ubigeo = '15010'; }, (d: any) => { d.settings.routes[0].origin.establishmentCode = '001'; },
      (d: any) => { d.settings.routes[0].origin.scop = 'operation'; }, (d: any) => { d.settings.products[0].name = 'x\u202ey'; },
      (d: any) => { d.settings.products[0].name = 'x\u000ay'; }, (d: any) => { d.settings.products[0].name = '<script>alert(1)</script>'; },
      (d: any) => { d.settings.products[0].name = 'a'.repeat(161); }, (d: any) => { d.settings.routes[0].destination.address = 'a'.repeat(301); },
      (d: any) => { d.settings.products.push({ ...d.settings.products[0] }); },
      (d: any) => { d.settings.products.push({ ...d.settings.products[0], id: randomUUID() }); },
      (d: any) => { d.settings.routes.push({ ...d.settings.routes[0], id: randomUUID() }); },
      (d: any) => { d.settings.products = Array.from({ length: 31 }, (_, i) => ({ ...d.settings.products[0], name: `Product ${i}`, id: randomUUID() })); },
      (d: any) => { d.settings.routes[0].id = d.settings.products[0].id; },
      (d: any) => { d.expectedRevision = -1; }, (d: any) => { d.settings.products[0].id = 'not-uuid'; },
    ];
    for (const mutate of cases) { const input = draft(); mutate(input); expect(validateGuideSettingsWrite(input).ok).toBe(false); }
    expect(validateGuideSettingsWrite({ ...draft(), junk: 'x'.repeat(131072) })).toMatchObject({ ok: false, issues: [{ path: '', message: expect.stringContaining('tamaño') }] });
  });
  it('accepts maximum list counts and Unicode names; trims declared fields', () => {
    const input = draft(); input.settings.products = Array.from({ length: 30 }, (_, i) => ({ ...input.settings.products[0], name: `Producto áé ${i}`, id: randomUUID() }));
    input.settings.routes = Array.from({ length: 30 }, (_, i) => ({ ...input.settings.routes[0], name: `Ruta ${i}`, id: randomUUID() }));
    expect(validateGuideSettingsWrite(input).ok).toBe(true);
    const other = draft(); other.settings.products[0].name = '  Diésel  '; expect(validateGuideSettingsWrite(other)).toMatchObject({ ok: true, value: { settings: { products: [{ name: 'Diésel' }] } } });
  });
});

describe('guide operational authorization and persistence boundary', () => {
  it('requires the existing revocation-aware guard and setup permission', () => {
    expect(Reflect.getMetadata('__guards__', GuideOperationalSettingsController)).toContain(JwtPermissionGuard);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, GuideOperationalSettingsController)).toEqual(['setup.manage']);
  });
  it('rejects non-native/assigned/permissionless administrators before any DB query', () => {
    const prisma = { $transaction: vi.fn() }; const service = new GuideOperationalSettingsService(prisma as any);
    for (const user of [undefined, { ...actor.user, roles: ['AUDITOR'] }, { ...actor.user, scope: { kind: 'ASSIGNED' } }, { ...actor.user, permissions: [] }]) {
      expect(() => service.get('1', { headers: {}, user } as any)).toThrow('administrador general');
      expect(() => service.put('1', draft(), { headers: {}, user } as any)).toThrow('administrador general');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('maps absent table/column to a safe 503 without exposing SQL', async () => {
    for (const error of [{ code: 'P2010', meta: { code: '42P01' } }, { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '42P01' } } } }, { code: 'P2021' }, { code: '42703' }]) {
      const prisma = { $transaction: vi.fn().mockRejectedValue(error) }; const service = new GuideOperationalSettingsService(prisma as any);
      await expect(service.get('1', actor)).rejects.toMatchObject({ status: 503, message: expect.stringContaining('almacenamiento') });
    }
  });
});
