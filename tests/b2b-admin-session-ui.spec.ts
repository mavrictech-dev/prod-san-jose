import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminSsoSessionHost, AdminSsoCallbackNotice, adminSsoCallbackFailed } from '../apps/web-pwa/features/b2b/admin-session-host';
import { createAdminBrowserClient, type AdminBrowserClient } from '../apps/web-pwa/features/b2b/admin-browser-client';
import { IntegrationAdminHost, IntegrationAdminSessionProvider } from '../apps/web-pwa/features/b2b/integration-admin-host';
import { createIntegrationAdminPort } from '../apps/web-pwa/features/b2b/integration-admin-remote';
import { IntegrationAdminController } from '../apps/web-pwa/features/b2b/integration-admin-model';

const require = createRequire(new URL('../apps/web-pwa/package.json', import.meta.url));
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const render = (client?: AdminBrowserClient) => renderToStaticMarkup(React.createElement(AdminSsoSessionHost, client ? { client } : {}));
const TOKEN = 't'.repeat(43), SECRET = 's'.repeat(43);
const ID = '10000000-0000-4000-8000-000000000004';
const PATH = '/b2b/v1/admin/applications';
const clients: AdminBrowserClient[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const anonymous = { enabled: true, environment: 'BETA', authenticated: false };
const session = () => ({ ...anonymous, authenticated: true, csrfToken: TOKEN, expiresAt: new Date(Date.now() + 60_000).toISOString() });
function setup(origin = 'https://factuez.example') {
  const events = new EventTarget(), fetch = vi.fn<typeof globalThis.fetch>(), assign = vi.fn();
  const client = createAdminBrowserClient({
    window: {
      location: { origin, assign },
      addEventListener: (name, listener) => events.addEventListener(name, listener),
      removeEventListener: (name, listener) => events.removeEventListener(name, listener),
    },
    fetch,
  });
  clients.push(client);
  const status = async (value: unknown = session()) => { fetch.mockResolvedValueOnce(json(value)); await client.status(); };
  return { client, fetch, assign, events, status };
}
afterEach(() => { clients.splice(0).forEach(client => client.close()); vi.useRealTimers(); });

describe('B2B-08 SSO host SSR and session-driven UI', () => {
  it('keeps HTTPS requirements visible without attempting SSO or a request', async () => {
    const { client, fetch, assign } = setup('http://factuez.example');
    await client.status().catch(() => {});
    const html = render(client);
    expect(html).toContain('Requiere HTTPS'); expect(html).toContain('requiere una conexión HTTPS');
    expect(html).not.toContain('Verificar acceso'); expect(html).not.toContain('Iniciar sesión');
    expect(html).not.toContain('Nueva integración'); expect(fetch).not.toHaveBeenCalled(); expect(assign).not.toHaveBeenCalled();
  });
  it.each([404, 429, 503, 200])('does not infer disabled or available service from an unconfirmed HTTP %i response', async code => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(json({ detail: 'PRIVATE', enabled: true }, code));
    await client.status().catch(() => {});
    const html = render(client);
    expect(html).toContain('Sin confirmar'); expect(html).toContain('Reintentar verificación');
    expect(html).not.toContain('No habilitado'); expect(html).not.toContain('Sesión verificada');
    expect(html).not.toContain('Nueva integración'); expect(html).not.toContain('PRIVATE');
  });
  it('SSR uses a closed Card without touching browser dependencies or the network', () => {
    const fetch = vi.fn(), browser = { get location(): never { throw Error('SSR_BROWSER_READ'); } };
    const html = renderToStaticMarkup(React.createElement(AdminSsoSessionHost, { dependencies: { fetch, window: browser } }));
    expect(html).toContain('data-slot="card"'); expect(html).toContain('Integraciones B2B');
    expect(html).toContain('Sin verificar'); expect(html).toContain('aún no se ha verificado');
    expect(html).not.toContain('aún no está habilitada');
    expect(html).not.toContain('Nueva integración'); expect(html).not.toContain('Iniciar sesión');
    expect(html).toContain('Verificar acceso'); expect(html).toContain('disabled=""');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('mount-ready SSR does not check status or start SSO during render', () => {
    const { client, fetch, assign } = setup();
    const html = render(client);
    expect(html).toContain('Verificando acceso'); expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('Nueva integración'); expect(fetch).not.toHaveBeenCalled(); expect(assign).not.toHaveBeenCalled();
  });
  it('disabled BFF keeps the panel unavailable and offers explicit verification', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(json({ code: 'ADMIN_BFF_DISABLED', detail: 'PRIVATE_DETAIL' }, 503));
    await client.status().catch(() => {});
    const html = render(client);
    expect(html).toContain('aún no está habilitada'); expect(html).toContain('TI debe configurar');
    expect(html).toContain('No habilitado'); expect(html).toContain('Verificar acceso');
    expect(html).not.toContain('Nueva integración'); expect(html).not.toContain('Iniciar sesión');
    expect(html).not.toContain('PRIVATE_DETAIL'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('anonymous session shows user-initiated SSO and verify access, with no panel', async () => {
    const { client, fetch, assign, status } = setup(); await status(anonymous);
    const html = render(client);
    expect(html).toContain('Iniciar sesión de administración'); expect(html).toContain('Verificar acceso');
    expect(html).toContain('BETA'); expect(html).toContain('Inicio de sesión requerido');
    expect(html).not.toContain('Sesión verificada'); expect(html).not.toContain('Nueva integración');
    expect(html).not.toContain('Cerrar sesión'); expect(fetch).toHaveBeenCalledTimes(1); expect(assign).not.toHaveBeenCalled();
  });
  it('authenticated host installs the actual provider and current panel without SSR fetch', async () => {
    const { client, fetch, status } = setup(); await status();
    const html = render(client);
    expect(html).toContain('Acceso de administración verificado');
    expect(html).toContain('Sesión verificada'); expect(html).toContain('La consulta de aplicaciones comprueba el servicio');
    expect(html).toContain('Un acceso habilitado no confirma la conexión');
    expect(html).toContain('Cerrar sesión de administración'); expect(html).toContain('Nueva integración');
    expect(html).toContain('Cargando accesos'); expect(html).not.toContain('aún no está habilitada');
    expect(html).not.toContain('Iniciar sesión de administración');
    expect(html).not.toMatch(new RegExp(TOKEN + '|' + SECRET));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403])('HTTP %i removes the panel and offers reauthentication without PWA logout', async statusCode => {
    const { client, fetch, status } = setup(); await status();
    fetch.mockResolvedValueOnce(json({ code: 'ADMIN_CSRF_EXPIRED', secret: 'PRIVATE' }, statusCode));
    await client.request(PATH + '?environment=BETA').catch(() => {});
    const html = render(client);
    expect(html).toContain('Iniciar sesión de administración'); expect(html).toContain('Verificar acceso');
    expect(html).toContain('role="alert"'); expect(html).not.toContain('Nueva integración');
    expect(html).not.toContain('Cerrar sesión'); expect(html).not.toMatch(/PRIVATE|ADMIN_CSRF_EXPIRED/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('independent expiry closes UI and allows explicit verification to install a fresh session', async () => {
    vi.useFakeTimers();
    const { client, status } = setup(); await status();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(render(client)).toContain('La sesión de administración venció');
    expect(render(client)).not.toContain('Nueva integración');
    await status();
    expect(render(client)).toContain('Acceso de administración verificado');
  });
  it('status failures remain closed, expose finite copy and allow retry', async () => {
    const { client, fetch, status } = setup();
    fetch.mockRejectedValueOnce(Error('PRIVATE_FAILURE'));
    await client.status().catch(() => {});
    const html = render(client);
    expect(html).toContain('Reintentar verificación'); expect(html).toContain('El panel permanece cerrado');
    expect(html).toContain('Sin confirmar'); expect(html).not.toContain('No habilitado');
    expect(html).not.toContain('Nueva integración'); expect(html).not.toContain('PRIVATE_FAILURE');
    await status(anonymous); expect(render(client)).toContain('Iniciar sesión de administración');
  });
  it('unsafe SSO URL never navigates and displays a retryable finite error', async () => {
    const { client, fetch, assign, status } = setup(); await status(anonymous);
    fetch.mockResolvedValueOnce(json({ authorizeUrl: 'javascript:alert("PRIVATE")' }));
    await client.start().catch(() => {});
    const html = render(client);
    expect(html).toContain('No se pudo validar el destino'); expect(html).toContain('Reintentar verificación');
    expect(html).not.toMatch(/javascript|PRIVATE/); expect(assign).not.toHaveBeenCalled();
  });
  it('logout removes the panel during the request and returns to anonymous on success', async () => {
    const { client, fetch, status } = setup(); await status();
    let resolve!: (response: Response) => void;
    fetch.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
    const work = client.logout();
    expect(render(client)).not.toContain('Nueva integración');
    expect(render(client)).toContain('aria-busy="true"');
    resolve(json({ loggedOut: true })); await work;
    expect(render(client)).toContain('Iniciar sesión de administración');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('workspace logout closes the B2B UI and revokes the cookie with keepalive', async () => {
    const { client, fetch, events, status } = setup(); await status();
    fetch.mockResolvedValueOnce(json({ loggedOut: true }));
    events.dispatchEvent(new Event('factuez:workspace-logout'));
    const html = render(client);
    expect(html).toContain('La sesión de administración se cerró');
    expect(html).not.toContain('Nueva integración'); expect(html).not.toContain('Iniciar sesión');
    expect(html).not.toContain('Verificar acceso'); expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1]).toMatchObject({ keepalive: true, method: 'POST', body: '{}' });
  });
  it('preserves existing injected provider and the original host fallback', () => {
    const request = vi.fn();
    const fallback = renderToStaticMarkup(React.createElement(IntegrationAdminHost));
    expect(fallback).toContain('El estado del servicio no se ha verificado');
    expect(fallback).not.toContain('aún no está habilitada');
    const html = renderToStaticMarkup(React.createElement(IntegrationAdminSessionProvider, { client: { request } }, React.createElement(IntegrationAdminHost)));
    expect(html).toContain('Nueva integración'); expect(request).not.toHaveBeenCalled();
  });
  it('end-to-end fake transport and panel model discard a secret returned after access denial', async () => {
    const { client, fetch, status } = setup(); await status();
    const application = {
      id: ID, label: 'Aplicación de prueba', kind: 'SERVICE', enabled: true, revision: 1,
      oidcClientId: null, scopes: ['b2b:context:read'], bindings: [{
        issuerId: 7, issuerRuc: '00000000007', environment: 'BETA',
        branchId: '10000000-0000-4000-8000-000000000001',
        pointId: '10000000-0000-4000-8000-000000000002',
        seriesId: '10000000-0000-4000-8000-000000000003', documentType: '01',
      }],
    };
    const wrap = (value: unknown) => ({ schemaVersion: 'factuez.b2b.v1', source: 'SOURCE', environment: 'BETA', candidateOnly: true, ...value as object });
    fetch.mockResolvedValueOnce(json(wrap({ items: [application], nextAfter: null })));
    const controller = new IntegrationAdminController(createIntegrationAdminPort(client));
    controller.start(); await vi.waitFor(() => expect(controller.getSnapshot().loaded).toBe(true));
    let resolve!: (response: Response) => void;
    fetch.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
    const reveal = vi.fn();
    const work = controller.confirm({ action: 'rotate', id: ID, input: { expectedRevision: 1 } }, reveal, vi.fn());
    fetch.mockResolvedValueOnce(json({ code: 'ADMIN_CSRF_EXPIRED' }, 403));
    await client.request(PATH + '/' + ID + '?environment=BETA').catch(() => {});
    resolve(json(wrap({ application: { ...application, revision: 2 }, clientSecret: SECRET }))); await work;
    expect(reveal).not.toHaveBeenCalled();
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(SECRET);
    expect(render(client)).not.toContain('Nueva integración'); controller.dispose();
  });
});


describe('public SSO callback failure marker', () => {
  it.each([
    ['?adminSso=failed', true], ['?adminSso=failed&code=PRIVATE&state=PRIVATE', true],
    ['?adminSso=javascript:PRIVATE', false], ['?adminSso=failed&adminSso=failed', false],
    ['?adminSso=success', false], ['?code=PRIVATE&error=PRIVATE', false], ['', false],
  ])('recognizes only the known marker: %s', (search, failed) => {
    const actual = adminSsoCallbackFailed(search);
    expect(actual).toBe(failed);
    const html = renderToStaticMarkup(React.createElement(AdminSsoCallbackNotice, { failed: actual }));
    expect(html).not.toMatch(/PRIVATE|javascript|state=|code=/);
    if (failed) {
      expect(html).toContain('No se pudo completar el inicio de sesión de administración');
      expect(html).toContain('role="alert"');
    } else expect(html).toBe('');
  });
});

