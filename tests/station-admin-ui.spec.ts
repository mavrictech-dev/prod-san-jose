import { describe, expect, it } from 'vitest';
import { canAdminMasters, emptyMasterDraft, masterCommand, masterDraftError, masterDraftFor, masterSeriesValid, parseMasterEmails, seriesLabels } from '../apps/web-pwa/features/workspace/station-admin-model';
import type { MasterDialog, MasterDraft } from '../apps/web-pwa/features/workspace/station-admin-model';
import type { StationAdminCatalog } from '../packages/contracts/src';

const issuer = { id: 1, ruc: '00000000001', legalName: 'EMISOR FICTICIO', tradeName: null, taxAddress: 'Dirección QA', ubigeo: '200101', phone: null, contactEmails: ['qa@pruebas.invalid'], environment: 'BETA' as const, active: true, revision: 3 };
const catalog: StationAdminCatalog = { version: 'factuez.station-admin.v1', capabilities: { betaOnly: true, softDelete: true, counterEditing: false }, companies: [issuer], branches: [], emissionPoints: [], series: [] };
const draft: MasterDraft = { ...emptyMasterDraft, ...issuer, companyId: '1', tradeName: '', phone: '', contactEmails: 'qa@pruebas.invalid', code: 'caJa02', name: 'Nombre QA', address: 'Dirección QA', invoiceSeries: 'f002', receiptSeries: 'b002', series: 'f002', trackNumber: '2' };
describe('Contratos y formularios CRUD de maestros', () => {
  it.each([
    { scope: { kind: 'ASSIGNED' }, roles: ['ADMIN'], permissions: ['setup.manage'] },
    { scope: { kind: 'GLOBAL' }, roles: ['CASHIER'], permissions: ['setup.manage'] },
    { scope: { kind: 'GLOBAL' }, roles: ['ADMIN'], permissions: [] },
    undefined,
  ])('no expone CRUD a un perfil insuficiente: %j', user => expect(canAdminMasters(user as never)).toBe(false));
  it('permite el administrador general con permiso, no sólo GLOBAL', () => expect(canAdminMasters({ scope: { kind: 'GLOBAL' }, roles: ['ADMIN'], permissions: ['setup.manage'] } as never)).toBe(true));
  it('precarga los datos de edición sin obligar a volver a escribir el RUC', () => {
    expect(masterDraftFor({ kind: 'issuer', mode: 'edit', targetId: '1' }, catalog)).toMatchObject({ legalName: issuer.legalName, ruc: issuer.ruc, tradeName: '', phone: '', contactEmails: 'qa@pruebas.invalid' });
  });
  it('no asigna el primer emisor al crear una sede', () => {
    expect(masterDraftFor({ kind: 'branch', mode: 'create' }, catalog).companyId).toBe('');
  });
  it('crear emisor no incluye entorno, credenciales ni activación fiscal', () => {
    const command = masterCommand({ kind: 'issuer', mode: 'create' }, draft);
    expect(command).toMatchObject({ path: '/api/v1/stations/issuers', method: 'POST', body: { ruc: issuer.ruc } });
    expect(command.body).not.toHaveProperty('environment'); expect(command.body).not.toHaveProperty('active');
  });
  it('editar emisor nunca transmite RUC y sí la revisión', () => {
    const command = masterCommand({ kind: 'issuer', mode: 'edit', targetId: '1', revision: 3 }, draft);
    expect(command.method).toBe('PATCH'); expect(command.body).not.toHaveProperty('ruc'); expect(command.body).toHaveProperty('expectedRevision', 3);
  });
  it.each(['issuer', 'branch', 'point', 'series'] as const)('DELETE %s sólo solicita desactivación con revisión', kind => {
    const command = masterCommand({ kind, mode: 'deactivate', targetId: '1', revision: 3 }, draft);
    expect(command.method).toBe('DELETE'); expect(command.body).toEqual({ expectedRevision: 3 });
  });
  it.each(['issuer', 'branch', 'point', 'series'] as const)('PATCH %s reactiva sin enviar campos del borrador', kind => {
    expect(masterCommand({ kind, mode: 'reactivate', targetId: '1', revision: 3 }, draft).body).toEqual({ expectedRevision: 3, active: true });
  });
  it('crea sede para el RUC seleccionado, pero su edición normal no puede trasladarla', () => {
    expect(masterCommand({ kind: 'branch', mode: 'create' }, draft).body).toHaveProperty('companyId', 1);
    expect(masterCommand({ kind: 'branch', mode: 'edit', targetId: 'QA', revision: 1 }, draft).body).not.toHaveProperty('companyId');
  });
  it('cambio explícito de emisor requiere la revisión de la sede', () => {
    expect(masterCommand({ kind: 'assign', mode: 'edit', targetId: 'QA', revision: 1 }, draft)).toEqual({ path: '/api/v1/stations/QA/issuer', method: 'PATCH', body: { companyId: 1, expectedRevision: 1 } });
  });
  it('crea punto con sus dos series normalizadas sin editar números', () => {
    const command = masterCommand({ kind: 'point', mode: 'create', parentId: 'QA' }, draft);
    expect(command).toMatchObject({ path: '/api/v1/stations/QA/points', body: { code: 'CAJA02', invoiceSeries: 'F002', receiptSeries: 'B002', trackNumber: 2 } });
    expect(command.body).not.toHaveProperty('nextNumber'); expect(command.body).not.toHaveProperty('companyId');
  });
  it('editar punto no altera las series ni cambia la sede', () => {
    const command = masterCommand({ kind: 'point', mode: 'edit', targetId: 'QA', revision: 3 }, draft);
    for (const field of ['branchId', 'companyId', 'invoiceSeries', 'receiptSeries', 'nextNumber']) expect(command.body).not.toHaveProperty(field);
  });
  it('nueva serie incluye el tipo; el renombrado no altera tipo, propietario ni contador', () => {
    expect(masterCommand({ kind: 'series', mode: 'create', parentId: 'QA' }, draft).body).toEqual({ documentType: 'INVOICE', series: 'F002' });
    expect(masterCommand({ kind: 'series', mode: 'edit', targetId: 'QA', revision: 3 }, draft).body).toEqual({ expectedRevision: 3, series: 'F002' });
    expect(Object.keys(seriesLabels)).not.toContain('TRANSPORT_GUIDE');
  });
  it('valida correo, ubigeo, pista y prefijos antes de enviar', () => {
    expect(masterDraftError({ kind: 'issuer', mode: 'create' }, { ...draft, contactEmails: 'no correo' })).toContain('correos');
    expect(masterDraftError({ kind: 'issuer', mode: 'create' }, { ...draft, ubigeo: '12345' })).toContain('ubigeo');
    expect(masterDraftError({ kind: 'point', mode: 'create' }, { ...draft, trackNumber: '0' })).toContain('pista');
    expect(masterDraftError({ kind: 'point', mode: 'create' }, { ...draft, invoiceSeries: 'B001' })).toContain('series');
    expect(masterSeriesValid('V001', 'DESPATCH_ADVICE')).toBe(false);
    expect(parseMasterEmails('qa@pruebas.invalid; qa@pruebas.invalid, otro@pruebas.invalid')).toEqual(['qa@pruebas.invalid', 'otro@pruebas.invalid']);
  });
  it('la reactivación no exige ni vuelve a guardar cabecera o series', () => {
    const action: MasterDialog = { kind: 'issuer', mode: 'reactivate', targetId: '1', revision: 3 };
    expect(masterDraftError(action, emptyMasterDraft)).toBeUndefined();
    expect(masterCommand(action, emptyMasterDraft).body).toEqual({ expectedRevision: 3, active: true });
  });
});
