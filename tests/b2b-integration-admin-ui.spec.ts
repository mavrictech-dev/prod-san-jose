import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationAdminPanel, IntegrationAdminBindings, IntegrationAdminEditor } from '../apps/web-pwa/features/b2b/integration-admin-panel';
import {
  IntegrationAdminController, integrationAdminError, integrationAdminInputError, integrationAdminMetadata,
  type B2bBinding, type IntegrationAdminClient, type IntegrationAdminCreate, type IntegrationAdminPage, type IntegrationAdminPort,
} from '../apps/web-pwa/features/b2b/integration-admin-model';

const require = createRequire(new URL('../apps/web-pwa/package.json', import.meta.url));
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const render = (component: unknown, props = {}) => renderToStaticMarkup(React.createElement(component, props));
const binding: B2bBinding = { issuerId: 7, issuerRuc: '00000000007', environment: 'BETA', branchId: '10000000-0000-4000-8000-000000000001', pointId: '10000000-0000-4000-8000-000000000002', seriesId: '10000000-0000-4000-8000-000000000003', documentType: '01' };
const client = (patch: Partial<IntegrationAdminClient> = {}): IntegrationAdminClient => ({ id: '10000000-0000-4000-8000-000000000004', label: 'Servicio de pruebas', kind: 'SERVICE', enabled: true, revision: 3, scopes: ['b2b:context:read'], bindings: [{ ...binding }], oidcClientId: null, ...patch });
const input = (): IntegrationAdminCreate => ({ label: 'Integración de pruebas', kind: 'SERVICE', scopes: ['b2b:context:read'], bindings: [{ ...binding }] });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function setup() {
  let current = client();
  const port = {
    list: vi.fn(async (_query: { after?: string; limit: number }): Promise<IntegrationAdminPage> => ({ items: [current], nextAfter: null, hasMore: false })),
    read: vi.fn(async (_id: string) => current),
    create: vi.fn(async (_input: IntegrationAdminCreate) => { current = client({ revision: 1 }); return { client: current, clientSecret: 'one-time-create-secret' }; }),
    update: vi.fn(async (_id: string, change: { expectedRevision: number; enabled?: boolean; scopes?: string[]; bindings?: B2bBinding[] }) => { current = client({ ...current, ...change, revision: current.revision + 1 }); return { client: current }; }),
    rotate: vi.fn(async (_id: string, _change: { expectedRevision: number }) => { current = client({ revision: current.revision + 1 }); return { client: current, clientSecret: 'one-time-rotate-secret' }; }),
  } satisfies IntegrationAdminPort;
  const controller = new IntegrationAdminController(port);
  return { port, controller, setCurrent(value: IntegrationAdminClient) { current = value; } };
}
async function ready(controller: IntegrationAdminController) {
  controller.start();
  await vi.waitFor(() => expect(controller.getSnapshot().loading).toBe(false));
}

describe('B2B-08 panel de administración con puerto explícito', () => {
  it('sin puerto de sesión muestra configuración y ningún control funcional', () => {
    const html = render(IntegrationAdminPanel);
    expect(html).toContain('Error de configuración');
    expect(html).not.toContain('<button'); expect(html).not.toContain('Nueva integración');
    expect(render(IntegrationAdminPanel, { port: {} })).toContain('Error de configuración');
  });
  it('SSR muestra carga real y no invoca el puerto ni simula accesos', () => {
    const { port } = setup();
    const html = render(IntegrationAdminPanel, { port });
    expect(html).toContain('Integraciones B2B'); expect(html).toContain('Cargando accesos');
    expect(html).toContain('aria-busy="true"'); expect(html).not.toContain('Servicio de pruebas');
    expect(html).not.toContain('one-time'); expect(port.list).not.toHaveBeenCalled();
    expect(html.match(/<button\b/g)?.length).toBe(2);
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });
  it('representa RUC, sede, punto, serie, ambiente y documento sin cuerpo crudo', () => {
    const html = render(IntegrationAdminBindings, { bindings: [binding, { ...binding, documentType: '03' }] });
    for (const value of [binding.issuerRuc, binding.branchId, binding.pointId, binding.seriesId, 'BETA', 'Factura (01)', 'Boleta (03)', 'Punto de emisión']) expect(html).toContain(value);
    expect(html).not.toContain('&quot;issuerId&quot;');
  });
  it('formulario accesible parte sin permisos ni alcance inventados y sólo prepara confirmación', () => {
    const prepare = vi.fn(); const html = render(IntegrationAdminEditor, { onPrepare: prepare, onCancel: vi.fn() });
    expect(html).toContain('Revisar y confirmar'); expect(html).toContain('Seleccionar documento');
    expect(html).toContain('<fieldset'); expect(html).toContain('<legend'); expect(html).toContain('for=');
    expect(html).not.toContain('checked=""'); expect(html).not.toContain(binding.issuerRuc);
    expect(prepare).not.toHaveBeenCalled();
    const user = render(IntegrationAdminEditor, { client: client({ kind: 'USER', oidcClientId: 'oidc-user' }), onPrepare: prepare, onCancel: vi.fn() });
    expect(user).toContain('Identificador del cliente OIDC'); expect(user).toContain('oidc-user');
  });
  it('valida combinaciones exactas, dependencias de permisos, OIDC y duplicados', () => {
    expect(integrationAdminInputError(input())).toBeUndefined();
    expect(integrationAdminInputError({ ...input(), scopes: [] })).toContain('permiso');
    expect(integrationAdminInputError({ ...input(), scopes: ['inventado'] })).toContain('permiso');
    expect(integrationAdminInputError({ ...input(), scopes: ['b2b:artifacts:read'] })).toContain('documentos');
    expect(integrationAdminInputError({ ...input(), scopes: ['b2b:received:artifacts:read'] })).toContain('recibidos');
    expect(integrationAdminInputError({ ...input(), bindings: [] })).toContain('alcance');
    expect(integrationAdminInputError({ ...input(), bindings: [binding, binding] })).toContain('duplicados');
    expect(integrationAdminInputError({ ...input(), bindings: [{ ...binding, issuerRuc: '*' }] })).toContain('11 dígitos');
    expect(integrationAdminInputError({ ...input(), kind: 'USER' })).toContain('OIDC');
    expect(integrationAdminInputError({ ...input(), kind: 'USER', oidcClientId: 'approved_oidc' })).toBeUndefined();
    expect(integrationAdminInputError({ ...input(), oidcClientId: 'unexpected' })).toContain('servicio');
  });
  it('carga páginas sin duplicados y consulta el detalle vigente mediante read', async () => {
    const { port, controller } = setup();
    port.list.mockResolvedValueOnce({ items: [client()], nextAfter: 'cursor-2', hasMore: true });
    await ready(controller);
    expect(port.list).toHaveBeenCalledWith({ limit: 25 });
    port.list.mockResolvedValueOnce({ items: [client({ revision: 4 }), client({ id: 'other', label: 'Otra integración' })], nextAfter: null, hasMore: false });
    await controller.load(true);
    expect(port.list).toHaveBeenLastCalledWith({ after: 'cursor-2', limit: 25 });
    expect(controller.getSnapshot().items).toHaveLength(2);
    expect(controller.getSnapshot().items[0].revision).toBe(4);
    await controller.inspect(client().id);
    expect(port.read).toHaveBeenCalledWith(client().id);
    expect(controller.getSnapshot().selected?.revision).toBe(3);
    controller.dispose();
  });
  it('distingue lista vacía de fallo y no expone respuestas de error', async () => {
    const { port, controller } = setup();
    port.list.mockResolvedValueOnce({ items: [], nextAfter: null, hasMore: false });
    await ready(controller); expect(controller.getSnapshot()).toMatchObject({ loaded: true, items: [], error: '' });
    port.list.mockRejectedValueOnce({ status: 503, message: 'DO-NOT-RENDER', body: { secret: 'RAW' } });
    await controller.load();
    expect(controller.getSnapshot()).toMatchObject({ loaded: false, items: [] });
    expect(JSON.stringify(controller.getSnapshot())).not.toMatch(/DO-NOT-RENDER|RAW/);
    expect(controller.getSnapshot().error).toContain('No se pudo'); controller.dispose();
  });
  it.each(['create', 'rotate'] as const)('%s revela sólo tras confirmar y nunca almacena secreto en snapshots', async action => {
    const { port, controller } = setup(); const reveal = vi.fn(), complete = vi.fn();
    await ready(controller); expect(port[action]).not.toHaveBeenCalled();
    const snapshots: string[] = []; controller.subscribe(() => snapshots.push(JSON.stringify(controller.getSnapshot())));
    await controller.confirm(action === 'create' ? { action, input: input() } : { action, id: client().id, input: { expectedRevision: 3 } }, reveal, complete);
    expect(port[action]).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledExactlyOnceWith(`one-time-${action}-secret`);
    expect(complete).not.toHaveBeenCalled(); expect(snapshots.join('')).not.toContain('one-time');
    expect(port.read).toHaveBeenLastCalledWith(client().id); expect(port.list).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().selected?.revision).toBe(action === 'create' ? 1 : 4);
    controller.dispose();
  });
  it.each(['create', 'rotate'] as const)('cerrar durante %s descarta el secreto y refresca revisión', async action => {
    const { port, controller, setCurrent } = setup();
    const pending = deferred<{ client: IntegrationAdminClient; clientSecret: string }>(); port[action].mockImplementationOnce(() => pending.promise);
    await ready(controller); const reveal = vi.fn(), complete = vi.fn();
    const work = controller.confirm(action === 'create' ? { action, input: input() } : { action, id: client().id, input: { expectedRevision: 3 } }, reveal, complete);
    controller.cancelReveal(); const next = client({ revision: 4 }); setCurrent(next);
    pending.resolve({ client: next, clientSecret: 'MUST-DISCARD' }); await work;
    expect(reveal).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
    expect(controller.getSnapshot().selected?.revision).toBe(4);
    expect(port.read).toHaveBeenLastCalledWith(next.id); expect(JSON.stringify(controller.getSnapshot())).not.toContain('MUST-DISCARD');
    controller.dispose();
  });
  it('desmontar descarta resultados tardíos y una nueva instancia consulta la revisión actual', async () => {
    const { port, controller, setCurrent } = setup(); const pending = deferred<{ client: IntegrationAdminClient; clientSecret: string }>();
    port.rotate.mockImplementationOnce(() => pending.promise); await ready(controller); const reveal = vi.fn();
    const work = controller.confirm({ action: 'rotate', id: client().id, input: { expectedRevision: 3 } }, reveal, vi.fn());
    controller.dispose(); const next = client({ revision: 4 }); setCurrent(next); pending.resolve({ client: next, clientSecret: 'LATE' }); await work;
    expect(reveal).not.toHaveBeenCalled(); expect(controller.getSnapshot().selected).toBeNull();
    const replacement = new IntegrationAdminController(port); await ready(replacement);
    expect(replacement.getSnapshot().items[0].revision).toBe(4); replacement.dispose();
  });
  it('actualiza estado, permisos y alcances con revisión, sin flags de autorización ni secretos', async () => {
    const { port, controller } = setup(); await ready(controller); const reveal = vi.fn();
    const change = { expectedRevision: 3, enabled: false, scopes: ['b2b:context:read'], bindings: [binding] };
    await controller.confirm({ action: 'update', id: client().id, input: change }, reveal, vi.fn());
    expect(port.update).toHaveBeenCalledExactlyOnceWith(client().id, change);
    expect(controller.getSnapshot().selected).toMatchObject({ revision: 4, enabled: false });
    expect(reveal).not.toHaveBeenCalled(); controller.dispose();
  });
  it('409 refresca la revisión, informa conflicto y exige otra confirmación sin reintentar', async () => {
    const { port, controller, setCurrent } = setup(); await ready(controller);
    port.rotate.mockRejectedValueOnce({ status: 409, code: 'REVISION_CONFLICT', message: 'RAW-SECRET' });
    setCurrent(client({ revision: 9 })); const reveal = vi.fn();
    await controller.confirm({ action: 'rotate', id: client().id, input: { expectedRevision: 3 } }, reveal, vi.fn());
    expect(controller.getSnapshot().selected?.revision).toBe(9); expect(controller.getSnapshot().error).toContain('otra sesión');
    expect(port.rotate).toHaveBeenCalledTimes(1); expect(reveal).not.toHaveBeenCalled();
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('RAW-SECRET'); controller.dispose();
  });
  it('step-up se resuelve en servidor y el fallo no revela secreto', async () => {
    const { port, controller } = setup(); await ready(controller); port.create.mockRejectedValueOnce({ status: 403, code: 'STEP_UP_REQUIRED', detail: 'PRIVATE' });
    const reveal = vi.fn(); await controller.confirm({ action: 'create', input: input() }, reveal, vi.fn());
    expect(controller.getSnapshot().error).toContain('verificación adicional'); expect(reveal).not.toHaveBeenCalled();
    expect(port.create).toHaveBeenCalledExactlyOnceWith(input()); controller.dispose();
  });
  it('fallo incierto tras cambio consulta el servidor y no reintenta automáticamente', async () => {
    const { port, controller, setCurrent } = setup(); await ready(controller);
    port.rotate.mockImplementationOnce(async () => { setCurrent(client({ revision: 4 })); throw new Error('network response lost'); });
    await controller.confirm({ action: 'rotate', id: client().id, input: { expectedRevision: 3 } }, vi.fn(), vi.fn());
    expect(controller.getSnapshot().selected?.revision).toBe(4); expect(port.rotate).toHaveBeenCalledTimes(1); controller.dispose();
  });
  it('bloquea escrituras concurrentes y descarta consultas de una sesión desmontada', async () => {
    const { port, controller } = setup(); const pending = deferred<IntegrationAdminPage>(); port.list.mockImplementationOnce(() => pending.promise);
    controller.start(); await controller.confirm({ action: 'create', input: input() }, vi.fn(), vi.fn());
    expect(port.create).not.toHaveBeenCalled(); controller.dispose(); pending.resolve({ items: [client()], nextAfter: null, hasMore: false });
    await Promise.resolve(); await Promise.resolve(); expect(controller.getSnapshot().items).toEqual([]);
  });
  it('metadatos se proyectan sin propiedades extra ni referencias mutables', () => {
    const raw = { ...client(), clientSecret: 'NEVER-CACHE', secretHash: 'PRIVATE', debug: { body: 'RAW' } };
    const safe = integrationAdminMetadata(raw); raw.scopes.push('extra'); raw.bindings[0].issuerRuc = 'changed';
    expect(safe.scopes).toEqual(['b2b:context:read']); expect(safe.bindings[0].issuerRuc).toBe(binding.issuerRuc);
    expect(JSON.stringify(safe)).not.toMatch(/NEVER-CACHE|PRIVATE|RAW/);
  });
  it.each([401, 403, 404, 400, 429, 503, 999])('error %s sólo produce mensajes finitos', status => {
    const message = integrationAdminError({ status, code: 'SENSITIVE', message: 'PRIVATE', body: 'RAW' });
    expect(message).not.toMatch(/SENSITIVE|PRIVATE|RAW/); expect(message.length).toBeGreaterThan(20);
  });
  it('no revela secreto para USER aunque una respuesta incluya uno por error', async () => {
    const { port, controller, setCurrent } = setup(); await ready(controller);
    const user = client({ kind: 'USER', oidcClientId: 'oidc_user', revision: 1 }); setCurrent(user);
    port.create.mockResolvedValueOnce({ client: user, clientSecret: 'DISCARD-USER-SECRET' });
    const reveal = vi.fn(), complete = vi.fn();
    await controller.confirm({ action: 'create', input: { ...input(), kind: 'USER', oidcClientId: 'oidc_user' } }, reveal, complete);
    expect(reveal).not.toHaveBeenCalled(); expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('DISCARD-USER-SECRET'); controller.dispose();
  });
  it('si no llega secreto SERVICE informa el resultado sin fingir recuperación', async () => {
    const { port, controller } = setup(); await ready(controller);
    port.create.mockResolvedValueOnce({ client: client(), clientSecret: '' }); const reveal = vi.fn();
    await controller.confirm({ action: 'create', input: input() }, reveal, vi.fn());
    expect(reveal).not.toHaveBeenCalled(); expect(controller.getSnapshot().error).toContain('no se recibió el secreto'); controller.dispose();
  });
  it('si falla releer después del cambio retira el detalle para impedir otra escritura con revisión vieja', async () => {
    const { port, controller } = setup(); await ready(controller);
    port.read.mockRejectedValueOnce({ status: 503 });
    await controller.confirm({ action: 'rotate', id: client().id, input: { expectedRevision: 3 } }, vi.fn(), vi.fn());
    expect(controller.getSnapshot().selected).toBeNull(); expect(controller.getSnapshot().error).toContain('Pulsa Actualizar');
    expect(controller.getSnapshot().loading).toBe(false); controller.dispose();
  });
  it('no permite paginación ambigua que repita el cursor', async () => {
    const { port, controller } = setup();
    port.list.mockResolvedValueOnce({ items: [client()], nextAfter: 'same', hasMore: true }); await ready(controller);
    port.list.mockResolvedValueOnce({ items: [client()], nextAfter: 'same', hasMore: true }); await controller.load(true);
    expect(controller.getSnapshot().items).toHaveLength(1); expect(controller.getSnapshot().error).toContain('No se pudo'); controller.dispose();
  });
  it('mantiene el límite del puerto y los controles de cierre sin persistencia, copia automática ni autoridad cliente', () => {
    const ui = readFileSync(new URL('../apps/web-pwa/features/b2b/integration-admin-panel.tsx', import.meta.url), 'utf8');
    const model = readFileSync(new URL('../apps/web-pwa/features/b2b/integration-admin-model.ts', import.meta.url), 'utf8');
    expect(ui).toContain('@factuez/ui/components/dialog'); expect(ui).toContain('@factuez/ui/components/table');
    expect(ui).toContain('controller.cancelReveal()'); expect(ui).toContain('controller.dispose()'); expect(ui).toContain('onOpenChange=');
    expect(ui).toContain('storedModal?.owner === controller'); expect(ui).toContain('Confirmar operación'); expect(ui).toContain('Cerrar y ocultar secreto');
    expect(ui + model).not.toMatch(/\bfetch\s*\(|localStorage|sessionStorage|console\.|clipboard|process\.env|useWorkspace|stepUpVerified\s*:|Authorization\s*:/);
  });
});


