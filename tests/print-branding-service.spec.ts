import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { DEFAULT_PRINT_BRANDING } from '../packages/contracts/src/print-presentation';
import { PrintBrandingService } from '../services/billing-service/src/application/print-branding.service';
import { PrintSettingsController } from '../services/billing-service/src/print-settings.controller';
import { REQUIRED_PERMISSIONS_KEY } from '../services/billing-service/src/auth/jwt-permission.guard';
import type { AccessTokenClaims } from '../packages/contracts/src';

const billingRequire = createRequire(new URL('../services/billing-service/package.json', import.meta.url));
billingRequire('reflect-metadata');
const siteId = '20000000-0000-4000-8000-000000000001';
const actor = { sub: '10000000-0000-4000-8000-000000000001', roles: ['ADMIN'], permissions: ['setup.manage', 'document.view'], scope: { kind: 'GLOBAL' } } as AccessTokenClaims;
const issuer = { id: 1, ruc: '00000000001', legalName: 'EMISOR FICTICIO QA', taxAddress: 'DIRECCIÓN FICTICIA', environment: 'BETA' };
let root: string;
let service: PrintBrandingService;
let prisma: { companySettings: { findUnique: ReturnType<typeof vi.fn> }; branch: { findFirst: ReturnType<typeof vi.fn> } };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'factuez-print-service-synthetic-'));
  vi.stubEnv('PRINT_SETTINGS_ENABLED', 'true'); vi.stubEnv('PRINT_BRANDING_ROOT', root);
  prisma = { companySettings: { findUnique: vi.fn().mockResolvedValue(issuer) },
    branch: { findFirst: vi.fn().mockResolvedValue({ id: siteId, companyId: 1, name: 'SEDE FICTICIA', address: 'DIRECCIÓN DE SEDE FICTICIA' }) } };
  service = new PrintBrandingService(prisma as never); await service.onModuleInit();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('autorización y alcance de formatos', () => {
  it('usa guard JWT vigente y permiso de configuración, sin rutas nuevas en Kong', () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, PrintSettingsController)).toEqual(['setup.manage']);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, PrintSettingsController.prototype.snapshot)).toEqual(['document.view']);
  });
  it.each([
    undefined,
    { ...actor, roles: ['CASHIER'] },
    { ...actor, permissions: ['document.view'] },
    { ...actor, scope: { kind: 'ASSIGNED', branchIds: [siteId], emissionPointIds: [], series: [] } },
  ])('no configura logos sin administrador general: %j', async user => {
    await expect(service.settings('1', siteId, user as never)).rejects.toMatchObject({ status: 403 });
    expect(prisma.companySettings.findUnique).not.toHaveBeenCalled();
  });
  it('rechaza un emisor configurado en producción', async () => {
    prisma.companySettings.findUnique.mockResolvedValue({ ...issuer, environment: 'PRODUCTION' });
    await expect(service.settings('1', undefined, actor)).rejects.toMatchObject({ status: 403 });
    expect(await readdir(join(root, 'profiles'))).toHaveLength(0);
  });
  it('no reasigna una sede al consultar otro RUC', async () => {
    prisma.branch.findFirst.mockResolvedValue(null);
    await expect(service.settings('1', siteId, actor)).rejects.toMatchObject({ status: 403 });
    expect(prisma.branch.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: siteId, companyId: 1, active: true } }));
  });
  it.each(['../', '0', 'NaN', '1?secret=true', '-1'])('rechaza companyId ambiguo: %s', async companyId => {
    await expect(service.settings(companyId, undefined, actor)).rejects.toMatchObject({ status: 400 });
    expect(prisma.companySettings.findUnique).not.toHaveBeenCalled();
  });
  it.each([['20000000-0000-4000-8000-000000000001'], '../../secrets', ''])('rechaza branchId ambiguo: %j', async branchId => {
    await expect(service.settings('1', branchId, actor)).rejects.toMatchObject({ status: 400 });
    expect(prisma.companySettings.findUnique).not.toHaveBeenCalled();
  });
  it('consulta sólo metadata del emisor, nunca credenciales ni certificado', async () => {
    await service.settings('1', undefined, actor);
    expect(prisma.companySettings.findUnique).toHaveBeenCalledWith({ where: { id: 1 },
      select: { id: true, ruc: true, legalName: true, tradeName: true, taxAddress: true, environment: true, active: true } });
  });
  it('no permite datos fiscales o rutas entre las opciones visuales', async () => {
    await expect(service.save('1', undefined, { expectedRevision: 0, settings: DEFAULT_PRINT_BRANDING, ruc: '99999999999' }, actor))
      .rejects.toMatchObject({ status: 400 });
    await expect(service.save('1', undefined, { expectedRevision: 0, settings: { ...DEFAULT_PRINT_BRANDING, certificateFile: '../../key.pem' } }, actor))
      .rejects.toMatchObject({ status: 400 });
    expect(await readdir(join(root, 'profiles'))).toHaveLength(0);
  });
  it('guarda sólo en el volumen visual y congela RUC/sede correctos', async () => {
    const response = await service.save('1', siteId, { expectedRevision: 0, settings: DEFAULT_PRINT_BRANDING }, actor);
    expect(response).toMatchObject({ revision: 1, branchId: siteId, source: 'BRANCH', fiscalTransmission: false });
    const presentation = await service.freezeIssued(issuer, { id: siteId, companyId: 1, name: 'SEDE FICTICIA' });
    expect(presentation).toMatchObject({ issuerRuc: issuer.ruc, branchId: siteId, profileRevision: 1 });
    expect(Object.keys(prisma)).toEqual(['companySettings', 'branch']);
  });
  it('conserva idempotencia de configuración por revisión', async () => {
    await service.save('1', undefined, { expectedRevision: 0, settings: DEFAULT_PRINT_BRANDING }, actor);
    await expect(service.save('1', undefined, { expectedRevision: 0, settings: DEFAULT_PRINT_BRANDING }, actor)).rejects.toMatchObject({ status: 409 });
    expect((await service.settings('1', undefined, actor)).revision).toBe(1);
  });
  it('la lectura entre servicios sólo permite la sede asignada', async () => {
    const assigned = { ...actor, roles: ['CASHIER'], permissions: ['document.view'], scope: { kind: 'ASSIGNED', branchIds: [siteId], emissionPointIds: [], series: [] } } as AccessTokenClaims;
    await expect(service.snapshot('1', undefined, assigned)).rejects.toMatchObject({ status: 403 });
    await expect(service.snapshot('1', '20000000-0000-4000-8000-000000000002', assigned)).rejects.toMatchObject({ status: 403 });
    expect((await service.snapshot('1', siteId, assigned)).branchId).toBe(siteId);
  });
  it('no agrega el perfil en emisión si la función está deshabilitada', async () => {
    vi.stubEnv('PRINT_SETTINGS_ENABLED', 'false');
    expect(await service.freezeIssued(issuer, { id: siteId, companyId: 1, name: 'SEDE FICTICIA' })).toBeUndefined();
    await expect(service.settings('1', undefined, actor)).rejects.toMatchObject({ status: 503 });
  });
  it('maestros inactivos permiten lectura histórica autorizada, no guardado ni preview', async () => {
    prisma.companySettings.findUnique.mockResolvedValue({ ...issuer, active: false });
    prisma.branch.findFirst.mockResolvedValue({ id: siteId, companyId: 1, name: 'SEDE INACTIVA FICTICIA', active: false });
    expect((await service.snapshot('1', siteId, actor)).issuerRuc).toBe(issuer.ruc);
    expect(prisma.branch.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: siteId, companyId: 1 } }));
    await expect(service.save('1', siteId, { expectedRevision: 0, settings: DEFAULT_PRINT_BRANDING }, actor)).rejects.toMatchObject({ status: 403 });
    await expect(service.preview('1', siteId, { documentTypeCode: '03', format: 'a4' }, actor)).rejects.toMatchObject({ status: 403 });
    expect(await readdir(join(root, 'profiles'))).toHaveLength(0);
  });
  it.each([
    { documentTypeCode: 31, format: 'a4' }, { documentTypeCode: ['01'], format: 'a4' },
    { documentTypeCode: '01', format: ['a4'] }, { documentTypeCode: '01', format: 'a4', fiscalTransmission: true },
    { documentTypeCode: '01', format: 'a4', draft: { settings: DEFAULT_PRINT_BRANDING, nextNumber: 5 } },
  ])('rechaza solicitud de preview mal tipada o fiscal: %j', async body => {
    await expect(service.preview('1', undefined, body, actor)).rejects.toMatchObject({ status: 400 });
    expect(await readdir(join(root, 'profiles'))).toHaveLength(0);
  });
  it.each(['01', '03', '07', '08', '09', '31'].flatMap(documentTypeCode =>
    ['a4', 'ticket'].map(format => ({ documentTypeCode, format }))))(
    'genera PDF ficticio %j sin emitir ni persistir', async request => {
      const result = await service.preview('1', siteId, request, actor);
      expect(result.bytes.subarray(0, 5).toString()).toBe('%PDF-');
      expect(result.fileName).toBe(`vista-previa-${request.documentTypeCode}-${request.format}-NO-FISCAL.pdf`);
      expect(await readdir(join(root, 'profiles'))).toHaveLength(0);
      expect(await readdir(join(root, 'logos'))).toHaveLength(0);
      expect(Object.keys(prisma)).toEqual(['companySettings', 'branch']);
    },
  );
});
