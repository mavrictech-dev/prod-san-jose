import { describe, expect, it } from 'vitest';
import { catalogForView, changeCatalogSelection, INITIAL_CATALOG_SELECTION, issuerCatalogSource, reconcileCatalogSelection } from '../apps/web-pwa/features/workspace/catalog-model';
import type { CatalogSelection, CatalogView } from '../apps/web-pwa/features/workspace/catalog-model';
import { greBranchSelectionError, greCatalogContext } from '../apps/web-pwa/features/workspace/gre-qa-model';
import type { Catalog, User } from '../apps/web-pwa/features/workspace/types';

const branchA = '10000000-0000-4000-8000-000000000911';
const branchB = '10000000-0000-4000-8000-000000000912';
const branchC = '10000000-0000-4000-8000-000000000913';
const branchD = '10000000-0000-4000-8000-000000000914';
const pointA = '20000000-0000-4000-8000-000000000911';
const pointB = '20000000-0000-4000-8000-000000000912';
const seriesA = '40000000-0000-4000-8000-000000000911';
const seriesB = '40000000-0000-4000-8000-000000000912';
const globalScope: User['scope'] = { kind: 'GLOBAL' };
const assignedScope: User['scope'] = { kind: 'ASSIGNED', branchIds: [branchB], emissionPointIds: [pointB], series: [seriesB] };
const admin: User = { sub: 'mock-admin', username: 'mock-admin', roles: ['ADMIN'], permissions: ['document.view', 'sunat.configure'], scope: globalScope, exp: 9999999999 };

function fixture(): Catalog {
  // Identificadores de mocks. BUSINESS no implica que un RUC sea real ni válido.
  return {
    companies: [
      { id: 1, ruc: '99111111111', legalName: 'EMPRESA DEL MOCK', environment: 'BETA' },
      { id: 2, ruc: '00000000002', legalName: 'LABORATORIO DEL MOCK', environment: 'BETA' },
      { id: 3, ruc: '99222222222', legalName: 'PRUEBA NOMBRE COMERCIAL', environment: 'BETA' },
      { id: 4, ruc: '00000000004', legalName: 'OTRO LABORATORIO', environment: 'BETA' },
    ],
    capabilities: { demoData: false, fiscalTransmission: false },
    branches: [
      { id: branchA, companyId: 1, code: 'A', name: 'SEDE MOCK A' },
      { id: branchB, companyId: 2, code: 'B', name: 'SEDE LAB B' },
      { id: branchC, companyId: 2, code: 'C', name: 'SEDE LAB C' },
      { id: branchD, companyId: 4, code: 'D', name: 'SEDE LAB D' },
    ],
    emissionPoints: [
      { id: pointA, companyId: 1, branchId: branchA, code: 'A', name: 'PUNTO A', series: [{ id: seriesA, documentType: 'INVOICE', series: 'F001' }] },
      { id: pointB, companyId: 2, branchId: branchB, code: 'B', name: 'PUNTO B', series: [{ id: seriesB, documentType: 'INVOICE', series: 'F001' }, { id: seriesA, documentType: 'INVOICE', series: 'F002' }] },
    ],
    products: [{ id: 'product-mock', sku: 'P', description: 'PRODUCTO MOCK', unitCode: 'NIU', taxAffectationCode: '10', defaultUnitPrice: null }],
  };
}
const selected = (companyId: string, branchId = '', source: CatalogView = 'ALL'): CatalogSelection => ({ source, companyId, branchId });

describe('Fuentes explícitas del catálogo operativo', () => {
  it.each([
    ['00000000001', 'SYNTHETIC'], ['00999999999', 'SYNTHETIC'],
    ['99111111111', 'BUSINESS'], ['0000000001', 'BUSINESS'], ['000000000001', 'BUSINESS'], ['00abcdefghi', 'BUSINESS'],
  ])('clasifica %s con la misma identidad RUC00 que GRE', (ruc, source) => expect(issuerCatalogSource({ ruc })).toBe(source));
  it('la vista inicial sólo contiene negocio, incluido un nombre PRUEBA sin RUC00', () => {
    const raw = fixture(), before = structuredClone(raw);
    const catalog = catalogForView(raw, globalScope, INITIAL_CATALOG_SELECTION.source);
    expect(catalog.companies.map(c => [c.id, c.source])).toEqual([[1, 'BUSINESS'], [3, 'BUSINESS']]);
    expect(catalog.branches.map(b => b.id)).toEqual([branchA]);
    expect(catalog.emissionPoints.map(p => p.id)).toEqual([pointA]);
    expect(catalog.products).toBe(raw.products);
    expect(raw).toEqual(before);
  });
  it('la vista QA muestra sólo emisores RUC00 y hereda la fuente en sedes y puntos', () => {
    const catalog = catalogForView(fixture(), globalScope, 'SYNTHETIC');
    expect(catalog.companies.map(c => c.id)).toEqual([2, 4]);
    expect(catalog.branches.map(b => b.id)).toEqual([branchB, branchC, branchD]);
    expect(catalog.emissionPoints.map(p => p.id)).toEqual([pointB]);
    expect([...catalog.companies, ...catalog.branches, ...catalog.emissionPoints].every(row => row.source === 'SYNTHETIC')).toBe(true);
  });
  it('ALL mantiene ambas fuentes para consulta explícita sin alterar el catálogo original', () => {
    const raw = fixture();
    expect(catalogForView(raw, globalScope, 'ALL').companies).toHaveLength(4);
    expect(raw.companies).toHaveLength(4);
    expect(raw.companies[1]).not.toHaveProperty('source');
  });
  it('metadatos erróneos, demoData y nombre no habilitan un RUC negocio como laboratorio', () => {
    const raw = fixture(); Object.assign(raw.companies[0], { source: 'SYNTHETIC', legalName: 'PRUEBA' }); raw.capabilities.demoData = true;
    expect(catalogForView(raw, globalScope, 'SYNTHETIC').companies.map(c => c.id)).toEqual([2, 4]);
    expect(greCatalogContext(raw, '1', '', admin).ready).toBe(false);
  });
  it('ASSIGNED conserva sólo sedes, puntos y UUIDs de series asignadas incluso en ALL', () => {
    const raw = fixture();
    const catalog = catalogForView(raw, assignedScope, 'ALL');
    expect(catalog.companies.map(c => c.id)).toEqual([2]);
    expect(catalog.branches.map(b => b.id)).toEqual([branchB]);
    expect(catalog.emissionPoints.map(p => [p.id, p.series.map(s => s.id)])).toEqual([[pointB, [seriesB]]]);
    expect(catalogForView(raw, assignedScope, 'BUSINESS').companies).toEqual([]);
    expect(catalogForView(raw, assignedScope, 'SYNTHETIC').branches.map(b => b.id)).toEqual([branchB]);
  });
  it('ASSIGNED no adquiere permisos de una serie por compartir la etiqueta F001', () => {
    const scope: User['scope'] = { ...assignedScope, series: [seriesA] };
    const catalog = catalogForView(fixture(), scope, 'ALL');
    expect(catalog.emissionPoints[0].series.map(s => s.series)).toEqual(['F002']);
    expect(catalog.emissionPoints[0].series.map(s => s.id)).not.toContain(seriesB);
  });
  it('descarta relaciones huérfanas o inconsistentes en presentación sin inventar emisores', () => {
    const raw = fixture();
    raw.branches.push({ id: 'orphan', companyId: 99, code: 'X', name: 'HUÉRFANA' });
    raw.emissionPoints.push({ ...raw.emissionPoints[0], id: 'mismatch', companyId: 2 });
    const catalog = catalogForView(raw, globalScope, 'ALL');
    expect(catalog.branches.some(b => b.id === 'orphan')).toBe(false);
    expect(catalog.emissionPoints.some(p => p.id === 'mismatch')).toBe(false);
    expect(raw.branches).toHaveLength(5);
  });
});

describe('Selección atómica de emisor y sede al recargar o cambiar la fuente', () => {
  it.each([
    [selected('1', branchA), selected('1', branchA)],
    [selected('99', branchB), selected('')],
    [selected('1', branchB), selected('1')],
    [selected('1', 'stale-branch'), selected('1')],
    [selected('', branchB), selected('2', branchB)],
    [selected('2'), selected('2')],
    [selected(''), selected('')],
  ])('reconcilia %j sin fallback a otro registro', (current, expected) => {
    expect(reconcileCatalogSelection(catalogForView(fixture(), globalScope, 'ALL'), current)).toEqual(expected);
  });
  it('al ocultar QA limpia su selección sin escoger el primer emisor negocio', () => {
    expect(changeCatalogSelection(fixture(), globalScope, selected('2', branchB), { kind: 'source', value: 'BUSINESS' })).toEqual(selected('', '', 'BUSINESS'));
  });
  it('entrar al laboratorio exige escoger su emisor; no toma el primer RUC00', () => {
    expect(changeCatalogSelection(fixture(), globalScope, selected('1', branchA, 'BUSINESS'), { kind: 'source', value: 'SYNTHETIC' })).toEqual(selected('', '', 'SYNTHETIC'));
  });
  it('ALL conserva un contexto negocio válido y el cambio de emisor limpia su sede', () => {
    const all = changeCatalogSelection(fixture(), globalScope, selected('1', branchA, 'BUSINESS'), { kind: 'source', value: 'ALL' });
    expect(all).toEqual(selected('1', branchA));
    expect(changeCatalogSelection(fixture(), globalScope, all, { kind: 'company', value: '2' })).toEqual(selected('2'));
  });
  it('una sede de otro RUC no cambia silenciosamente el emisor activo', () => {
    expect(changeCatalogSelection(fixture(), globalScope, selected('1', branchA), { kind: 'branch', value: branchB })).toEqual(selected('1'));
  });
  it('seleccionar sede desde consolidado determina su emisor y quitarla conserva ese RUC', () => {
    const choice = changeCatalogSelection(fixture(), globalScope, selected(''), { kind: 'branch', value: branchB });
    expect(choice).toEqual(selected('2', branchB));
    expect(changeCatalogSelection(fixture(), globalScope, choice, { kind: 'branch', value: '' })).toEqual(selected('2'));
  });
  it('eliminar una sede o cambiar su emisor durante recarga invalida sólo la sede', () => {
    const raw = fixture(); raw.branches.find(b => b.id === branchB)!.companyId = 4;
    expect(reconcileCatalogSelection(catalogForView(raw, globalScope, 'ALL'), selected('2', branchB))).toEqual(selected('2'));
    raw.companies = raw.companies.filter(c => c.id !== 2);
    expect(reconcileCatalogSelection(catalogForView(raw, globalScope, 'ALL'), selected('2', branchB))).toEqual(selected(''));
  });
  it('la revocación ASSIGNED limpia IDs antiguos y no selecciona la primera sede nueva', () => {
    const visible = catalogForView(fixture(), assignedScope, 'ALL');
    expect(reconcileCatalogSelection(visible, selected('1', branchA))).toEqual(selected(''));
    expect(changeCatalogSelection(fixture(), assignedScope, selected('2', branchB), { kind: 'branch', value: branchC })).toEqual(selected('2'));
    expect(changeCatalogSelection(fixture(), assignedScope, selected('2'), { kind: 'company', value: '4' })).toEqual(selected(''));
  });
});

describe('Contexto explícito GRE QA sin fallback ni datos de RUC negocio', () => {
  it.each(['', '1', '3', '99'])('bloquea selección %s aunque exista un emisor QA disponible', companyId => {
    expect(greCatalogContext(fixture(), companyId, '', admin).ready).toBe(false);
  });
  it('elige el RUC QA solicitado, no el primero, y respeta la sede activa como origen', () => {
    const context = greCatalogContext(fixture(), '4', branchD, admin);
    expect(context).toMatchObject({ ready: true, company: { id: 4, ruc: '00000000004' }, originBranchId: branchD });
    expect(context.ready && context.branches.map(b => b.id)).toEqual([branchD]);
  });
  it.each([branchA, branchD, 'stale-branch'])('bloquea sede %s que no pertenece al RUC elegido', branchId => {
    expect(greCatalogContext(fixture(), '2', branchId, admin).ready).toBe(false);
  });
  it('no escoge una sede cuando la cabecera está en todas las sedes', () => {
    expect(greCatalogContext(fixture(), '2', '', admin)).toMatchObject({ ready: true, originBranchId: '' });
  });
  it.each(['PRODUCTION', 'OTHER'])('el entorno %s no habilita GRE aunque tenga RUC00', environment => {
    const raw = fixture(); raw.companies[1].environment = environment;
    expect(greCatalogContext(raw, '2', '', admin).ready).toBe(false);
  });
  it.each([
    { ...admin, scope: assignedScope }, { ...admin, roles: ['AUDITOR'] },
    { ...admin, permissions: ['document.view'] }, { ...admin, permissions: ['sunat.configure'] }, undefined,
  ])('un perfil insuficiente no obtiene contexto GRE: %j', user => expect(greCatalogContext(fixture(), '2', branchB, user).ready).toBe(false));
  it('sin catálogo o razón social no prepara guía', () => {
    expect(greCatalogContext(undefined, '2', '', admin).ready).toBe(false);
    const raw = fixture(); raw.companies[1].legalName = '   ';
    expect(greCatalogContext(raw, '2', '', admin).ready).toBe(false);
  });
  it('valida dos sedes vigentes y distintas del RUC elegido, incluyendo selecciones obsoletas', () => {
    const address = (branchId: string) => ({ branchId, ubigeo: '150101', address: 'Dirección del mock', establishmentCode: '0001' });
    const branches = fixture().branches;
    expect(greBranchSelectionError(branches, 2, address(branchB), address(branchC))).toBeUndefined();
    for (const invalid of ['', branchA, branchD, 'stale-branch', branchB]) expect(greBranchSelectionError(branches, 2, address(branchB), address(invalid))).toBeTypeOf('string');
    expect(greBranchSelectionError(branches.filter(b => b.id !== branchC), 2, address(branchB), address(branchC))).toBeTypeOf('string');
  });
});
