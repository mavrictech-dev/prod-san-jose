import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Catalog, User } from '../apps/web-pwa/features/workspace/types';

// Ejecuta el proveedor real con estado de hooks controlado. No monta efectos de
// sesión/socket/DOM; todas las respuestas HTTP son mocks locales.
const hookState = { cursor: 0, slots: [] as any[], effects: [] as Array<() => void | (() => void)> };
const dispatcher = {
    useState: (initial: any) => {
      const index = hookState.cursor++;
      if (!(index in hookState.slots)) hookState.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [hookState.slots[index], (next: any) => { hookState.slots[index] = typeof next === 'function' ? next(hookState.slots[index]) : next; }];
    },
    useRef: (initial: any) => {
      const index = hookState.cursor++;
      if (!(index in hookState.slots)) hookState.slots[index] = { current: initial };
      return hookState.slots[index];
    },
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => void | (() => void)) => { hookState.effects.push(effect); },
};
import { WorkspaceProvider, type useWorkspace } from '../apps/web-pwa/features/workspace/provider';

const React = createRequire(new URL('../apps/web-pwa/package.json', import.meta.url))('react');
const branchA = '10000000-0000-4000-8000-000000000931';
const branchB = '10000000-0000-4000-8000-000000000932';
const branchC = '10000000-0000-4000-8000-000000000933';
const pointA = '20000000-0000-4000-8000-000000000931';
const pointB = '20000000-0000-4000-8000-000000000932';
const seriesA = '40000000-0000-4000-8000-000000000931';
const seriesB = '40000000-0000-4000-8000-000000000932';
function fixture(): Catalog {
  return {
    companies: [{ id: 1, ruc: '99111111111', legalName: 'PRUEBA NEGOCIO DEL MOCK', environment: 'BETA' }, { id: 2, ruc: '00000000002', legalName: 'LABORATORIO DEL MOCK', environment: 'BETA' }],
    capabilities: { demoData: false, fiscalTransmission: false },
    branches: [{ id: branchA, companyId: 1, code: 'A', name: 'SEDE A' }, { id: branchB, companyId: 2, code: 'B', name: 'SEDE B' }, { id: branchC, companyId: 2, code: 'C', name: 'SEDE C' }],
    emissionPoints: [
      { id: pointA, companyId: 1, branchId: branchA, code: 'A', name: 'PUNTO A', series: [{ id: seriesA, documentType: 'INVOICE', series: 'F001' }] },
      { id: pointB, companyId: 2, branchId: branchB, code: 'B', name: 'PUNTO B', series: [{ id: seriesB, documentType: 'INVOICE', series: 'F001' }] },
    ], products: [],
  };
}
function render() {
  hookState.cursor = 0;
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const previous = internals.H;
  internals.H = dispatcher;
  try { return WorkspaceProvider({ children: null }).props.value as ReturnType<typeof useWorkspace>; }
  finally { internals.H = previous; }
}
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
let raw: Catalog;
let loginUser: User;
let catalogResponses: Promise<Response>[];
let restoreResponses: Promise<Response>[];
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  hookState.cursor = 0; hookState.slots = []; hookState.effects = [];
  raw = fixture(); catalogResponses = []; restoreResponses = [];
  loginUser = { sub: 'mock-user', username: 'mock-user', roles: ['ADMIN'], permissions: ['document.view', 'sunat.configure'], scope: { kind: 'GLOBAL' }, exp: Math.floor(Date.now() / 1000) + 3600 };
  fetchMock = vi.fn((path: string, _options?: RequestInit) => {
    if (path.endsWith('/browser-session/login')) return Promise.resolve(response({ accessToken: 'MOCK_ACCESS', user: loginUser, serverNow: Date.now(), idleExpiresAt: Date.now() + 1800000 }));
    if (path.endsWith('/browser-session')) return restoreResponses.shift() ?? Promise.resolve(response({ accessToken: 'MOCK_RENEWED', user: { ...structuredClone(loginUser), exp: Math.floor(Date.now() / 1000) + 900 }, serverNow: Date.now(), idleExpiresAt: Date.now() + 1800000 }));
    if (path.endsWith('/catalog/issuance')) return catalogResponses.shift() ?? Promise.resolve(response(raw));
    if (path.endsWith('/browser-session/logout')) return Promise.resolve(response({}));
    throw new Error(`Endpoint no mockeado: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('React', React);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
async function loggedIn() {
  await render().login('mock-user', 'mock-password');
  await render().reloadCatalog();
  return render();
}
async function startRequest() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

describe('Proveedor: selección, recargas y sesión sin datos externos', () => {
  it('volver cinco veces a la pestaña revalida en segundo plano sin cambiar el usuario visual', async () => {
    vi.useFakeTimers(); await loggedIn(); render().setDirty(true); const stable = render().user;
    const doc = new EventTarget() as EventTarget & { hidden: boolean }; doc.hidden = true;
    const win = Object.assign(new EventTarget(), { setInterval, clearInterval });
    vi.stubGlobal('document', doc); vi.stubGlobal('window', win);
    // Monta únicamente el efecto real que escucha visibilidad/actividad. Los
    // sockets y otros efectos del proveedor siguen fuera de este ensayo local.
    const effect = [...hookState.effects].reverse().find(fn => fn.toString().includes('visibilitychange'));
    expect(effect).toBeDefined(); const cleanup = effect!(); fetchMock.mockClear();
    try {
      doc.dispatchEvent(new Event('visibilitychange')); await startRequest();
      expect(fetchMock).not.toHaveBeenCalled();
      for (let n = 0; n < 5; n++) {
        doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
        for (let tick = 0; tick < 20; tick++) await Promise.resolve();
        const view = render(); expect(view.user).toBe(stable); expect(view.dirty).toBe(true); expect(view.restoring).toBe(false);
        doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
      }
      expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/browser-session'))).toHaveLength(5);
      expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/activity'))).toBe(false);
    } finally { if (typeof cleanup === 'function') cleanup(); }
  });
  it('renovaciones sucesivas conservan la referencia visual, borrador, sede y fuente', async () => {
    vi.useFakeTimers(); loginUser.exp = Math.floor(Date.now() / 1000) + 10;
    await loggedIn(); render().setCatalogSource('SYNTHETIC'); render().setCompany('2'); render().setBranch(branchB); render().setDirty(true);
    const stable = render().user;
    for (let n = 0; n < 5; n++) {
      vi.advanceTimersByTime(900000);
      await render().api('/api/v1/documents/catalog/issuance');
      const view = render();
      expect(view.user).toBe(stable);
      expect(view.restoring).toBe(false); expect(view.dirty).toBe(true);
      expect([view.catalogSource, view.companyId, view.branchId]).toEqual(['SYNTHETIC', '2', branchB]);
    }
  });
  it('usa el vencimiento recién renovado y no pide renovar por cada consulta', async () => {
    vi.useFakeTimers(); loginUser.exp = Math.floor(Date.now() / 1000) + 10;
    await loggedIn();
    fetchMock.mockClear();
    for (let n = 0; n < 4; n++) await render().api('/api/v1/documents/catalog/issuance');
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/browser-session'))).toHaveLength(0);
    expect(fetchMock.mock.calls.every(([, options]) => options?.headers?.Authorization === 'Bearer MOCK_RENEWED')).toBe(true);
  });
  it.each(['permissions', 'roles', 'scope'] as const)('un cambio real de %s reemplaza el perfil visual', async field => {
    await loggedIn(); const previous = render().user;
    loginUser.exp = 0;
    if (field === 'permissions') loginUser = { ...loginUser, permissions: ['document.view'] };
    if (field === 'roles') loginUser = { ...loginUser, roles: ['AUDITOR'] };
    if (field === 'scope') loginUser = { ...loginUser, scope: { kind: 'ASSIGNED', branchIds: [branchA], emissionPointIds: [pointA], series: [seriesA] } };
    await render().api('/api/v1/documents/catalog/issuance');
    expect(render().user).not.toBe(previous); expect(render().user?.[field]).toEqual(loginUser[field]);
  });
  it('un 401 al renovar limpia el usuario y el contexto en vez de conservar el modal autorizado', async () => {
    await loggedIn(); loginUser.exp = 0;
    restoreResponses.push(Promise.resolve({ ok: false, status: 401, json: async () => ({ message: 'Sesión QA vencida' }) } as Response));
    await expect(render().api('/api/v1/documents/catalog/issuance')).rejects.toMatchObject({ status: 401 });
    expect(render().user).toBeUndefined(); expect(render().catalog).toBeUndefined(); expect(render().dirty).toBe(false);
  });
  it('un fallo temporal de renovación no borra la pantalla ni el borrador', async () => {
    await loggedIn(); const previous = render().user; render().setDirty(true); loginUser.exp = 0;
    restoreResponses.push(Promise.resolve({ ok: false, status: 503, json: async () => ({ message: 'Corte ficticio QA' }) } as Response));
    await expect(render().api('/api/v1/documents/catalog/issuance')).rejects.toMatchObject({ status: 503 });
    expect(render().user).toBe(previous); expect(render().dirty).toBe(true); expect(render().restoring).toBe(false);
  });
  it('normaliza negocio por defecto, admite ALL y entra a QA sólo mediante el control explícito', async () => {
    let view = await loggedIn();
    expect(view.catalogSource).toBe('BUSINESS');
    expect(view.catalog?.companies.map(c => c.id)).toEqual([1]);
    expect([view.companyId, view.branchId]).toEqual(['', '']);
    view.setCompany('1'); render().setBranch(branchA);
    view = render(); expect([view.companyId, view.branchId]).toEqual(['1', branchA]);
    view.setCatalogSource('ALL');
    view = render(); expect(view.catalog?.companies.map(c => c.id)).toEqual([1, 2]);
    expect([view.companyId, view.branchId]).toEqual(['1', branchA]);
    view.setCatalogSource('SYNTHETIC');
    view = render(); expect(view.catalog?.companies.map(c => c.id)).toEqual([2]);
    expect([view.companyId, view.branchId]).toEqual(['', '']);
  });
  it('dos cambios consecutivos no combinan un emisor nuevo con la sede anterior', async () => {
    await loggedIn(); render().setCatalogSource('ALL');
    render().setCompany('1'); render().setBranch(branchA);
    const view = render(); view.setCompany('2'); view.setBranch(branchA);
    expect([render().companyId, render().branchId]).toEqual(['2', '']);
    render().setBranch(branchB);
    expect([render().companyId, render().branchId]).toEqual(['2', branchB]);
  });
  it('recargar una sede reasignada limpia la sede sin caer en la primera sede QA', async () => {
    await loggedIn(); render().setCatalogSource('ALL'); render().setCompany('2'); render().setBranch(branchB);
    raw.branches[1].companyId = 1;
    await render().reloadCatalog();
    expect([render().companyId, render().branchId]).toEqual(['2', '']);
    expect(render().branchId).not.toBe(branchC);
  });
  it('un ID de emisor retirado se limpia con su sede en una sola recarga', async () => {
    await loggedIn(); render().setCatalogSource('ALL'); render().setCompany('2'); render().setBranch(branchB);
    raw.companies = raw.companies.filter(c => c.id !== 2);
    await render().reloadCatalog();
    expect([render().companyId, render().branchId]).toEqual(['', '']);
    expect(render().catalog?.companies.map(c => c.id)).toEqual([1]);
  });
  it('la última recarga gana cuando las respuestas llegan en orden inverso', async () => {
    await loggedIn();
    const old = deferred(), latest = deferred(); catalogResponses.push(old.promise, latest.promise);
    const oldLoad = render().reloadCatalog(); const latestLoad = render().reloadCatalog();
    await startRequest();
    const newCatalog = fixture(); newCatalog.companies[0].legalName = 'RESPUESTA VIGENTE';
    latest.resolve(response(newCatalog)); await latestLoad;
    expect(render().catalog?.companies[0].legalName).toBe('RESPUESTA VIGENTE');
    old.resolve(response(fixture())); await oldLoad;
    expect(render().catalog?.companies[0].legalName).toBe('RESPUESTA VIGENTE');
  });
  it('un cambio de vista durante la consulta no restaura la fuente ni la selección anterior', async () => {
    await loggedIn(); render().setCompany('1'); render().setBranch(branchA);
    const pending = deferred(); catalogResponses.push(pending.promise);
    const load = render().reloadCatalog(); await startRequest();
    render().setCatalogSource('SYNTHETIC'); render().setCompany('2'); render().setBranch(branchB);
    pending.resolve(response(fixture())); await load;
    expect([render().catalogSource, render().companyId, render().branchId]).toEqual(['SYNTHETIC', '2', branchB]);
  });
  it('ALL y QA siguen respetando ASSIGNED y no eligen un laboratorio por defecto', async () => {
    loginUser = { ...loginUser, roles: ['CASHIER'], scope: { kind: 'ASSIGNED', branchIds: [branchB], emissionPointIds: [pointB], series: [seriesB] } };
    let view = await loggedIn(); expect(view.catalog?.companies).toEqual([]);
    expect([view.companyId, view.branchId]).toEqual(['', '']);
    view.setCatalogSource('ALL'); view = render();
    expect(view.catalog?.companies.map(c => c.id)).toEqual([2]);
    expect(view.catalog?.branches.map(b => b.id)).toEqual([branchB]);
    view.setCompany('1'); expect(render().companyId).toBe('2');
    render().setCompany('2'); render().setBranch(branchC); expect(render().branchId).toBe(branchB);
    render().setBranch(branchB); render().setCatalogSource('SYNTHETIC');
    expect([render().companyId, render().branchId]).toEqual(['2', branchB]);
  });
  it('login de otro perfil restablece la vista y descarta respuestas pendientes del perfil anterior', async () => {
    await loggedIn(); render().setCatalogSource('SYNTHETIC'); render().setCompany('2'); render().setBranch(branchB);
    const pending = deferred(); catalogResponses.push(pending.promise);
    const oldLoad = render().reloadCatalog(); await startRequest();
    loginUser = { ...loginUser, sub: 'another-mock-user', scope: { kind: 'ASSIGNED', branchIds: [branchA], emissionPointIds: [pointA], series: [seriesA] } };
    await render().login('another-mock-user', 'mock-password');
    await render().reloadCatalog();
    pending.resolve(response(fixture())); await oldLoad;
    const view = render();
    expect(view.catalogSource).toBe('BUSINESS'); expect(view.catalog?.companies.map(c => c.id)).toEqual([1]);
    expect([view.companyId, view.branchId]).toEqual(['1', branchA]);
  });
  it('cerrar sesión invalida cualquier catálogo pendiente y limpia el contexto', async () => {
    await loggedIn();
    const pending = deferred(); catalogResponses.push(pending.promise);
    const load = render().reloadCatalog(); await startRequest();
    render().logout(); pending.resolve(response(fixture())); await load;
    expect(render().catalog).toBeUndefined(); expect(render().user).toBeUndefined();
    expect([render().catalogSource, render().companyId, render().branchId]).toEqual(['BUSINESS', '', '']);
  });
});
