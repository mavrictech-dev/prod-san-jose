import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdminBrowserError, createAdminBrowserClient,
  type AdminBrowserClient, type AdminBrowserWindow,
} from '../apps/web-pwa/features/b2b/admin-browser-client';

const ORIGIN = 'https://factuez.example';
const BASE = ORIGIN + '/bff/b2b-admin';
const PATH = '/b2b/v1/admin/applications';
const ID = '10000000-0000-4000-8000-000000000004';
const TOKEN = 'c'.repeat(43), OTHER_TOKEN = 'd'.repeat(43);
const clients: AdminBrowserClient[] = [];
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const authenticated = (token = TOKEN, expiresAt = new Date(Date.now() + 60_000).toISOString()) =>
  ({ enabled: true, environment: 'BETA', authenticated: true, csrfToken: token, expiresAt });
const anonymous = () => ({ enabled: true, environment: 'BETA', authenticated: false });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup(origin = ORIGIN) {
  const events = new EventTarget(), assign = vi.fn(), fetch = vi.fn<typeof globalThis.fetch>();
  const browser: AdminBrowserWindow = {
    location: { origin, assign },
    addEventListener: vi.fn((name, listener) => events.addEventListener(name, listener)),
    removeEventListener: vi.fn((name, listener) => events.removeEventListener(name, listener)),
  };
  Object.defineProperties(browser, {
    localStorage: { get() { throw Error('FORBIDDEN_STORAGE_READ'); } },
    sessionStorage: { get() { throw Error('FORBIDDEN_STORAGE_READ'); } },
    cookie: { get() { throw Error('FORBIDDEN_COOKIE_READ'); } },
  });
  const client = createAdminBrowserClient({ window: browser, fetch });
  clients.push(client);
  const ready = async () => { fetch.mockResolvedValueOnce(json(authenticated())); await client.status(); };
  return { client, fetch, browser, assign, events, ready };
}
afterEach(() => {
  clients.splice(0).forEach(client => client.close());
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('B2B admin same-origin browser transport', () => {
  it('SSR has no implicit endpoint, network, storage or session', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(), client = createAdminBrowserClient({ fetch });
    clients.push(client);
    expect(client.getSnapshot()).toMatchObject({ phase: 'disabled', enabled: false });
    await expect(client.status()).rejects.toMatchObject({ code: 'HTTPS_REQUIRED' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['http://factuez.example', 'https://user:pass@factuez.example', 'https://factuez.example/path', 'https://factuez.example/', 'javascript:alert(1)', 'null', '//factuez.example'])('rejects insecure/non-origin dependency %s', async origin => {
    const { client, fetch } = setup(origin);
    await expect(client.status()).rejects.toMatchObject({ code: 'HTTPS_REQUIRED' });
    expect(client.getSnapshot().phase).toBe('disabled'); expect(fetch).not.toHaveBeenCalled();
  });
  it('derives production origin and fetch from the browser only', async () => {
    const mock = setup();
    vi.stubGlobal('window', { ...mock.browser, fetch: mock.fetch });
    const client = createAdminBrowserClient(); clients.push(client);
    mock.fetch.mockResolvedValueOnce(json(anonymous()));
    await client.status();
    expect(mock.fetch).toHaveBeenCalledExactlyOnceWith(BASE + '/session', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' },
    }));
    expect(mock.assign).not.toHaveBeenCalled();
  });
  it('keeps CSRF out of public state and requires a validated authenticated session', async () => {
    const { client, fetch, ready } = setup();
    await expect(client.request(PATH + '?environment=BETA')).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled(); await ready();
    expect(JSON.stringify(client.getSnapshot())).not.toContain(TOKEN);
    expect(client.getSnapshot()).toEqual({ phase: 'authenticated', enabled: true, busy: false, error: null });
    fetch.mockResolvedValueOnce(json({ ok: true }));
    expect(await client.request(PATH + '?environment=BETA&limit=25')).toEqual({ ok: true });
    expect(fetch).toHaveBeenLastCalledWith(BASE + '/applications?environment=BETA&limit=25', expect.objectContaining({
      headers: { Accept: 'application/json', 'X-FactuEz-CSRF': TOKEN }, method: 'GET',
      cache: 'no-store', credentials: 'same-origin', redirect: 'error',
    }));
    expect(fetch.mock.calls[1][1]).not.toHaveProperty('body');
  });
  it.each([
    [PATH + '?environment=BETA&limit=50&after=' + ID, undefined, '/applications?environment=BETA&limit=50&after=' + ID],
    [PATH + '/' + ID + '?environment=BETA', undefined, '/applications/' + ID + '?environment=BETA'],
    [PATH + '?environment=BETA', { method: 'POST', body: { label: 'Test' } }, '/applications?environment=BETA'],
    [PATH + '/' + ID + '?environment=BETA', { method: 'PATCH', body: { expectedRevision: 1 } }, '/applications/' + ID + '?environment=BETA'],
    [PATH + '/' + ID + '/rotate-secret?environment=BETA', { method: 'POST', body: { expectedRevision: 1 } }, '/applications/' + ID + '/rotate-secret?environment=BETA'],
  ] as const)('maps allowed application call %s', async (path, init, target) => {
    const { client, fetch, ready } = setup(); await ready(); fetch.mockResolvedValueOnce(json({ result: true }));
    await client.request(path, init);
    const [url, options] = fetch.mock.calls[1];
    expect(url).toBe(BASE + target);
    expect(options).toMatchObject({ method: init?.method ?? 'GET', headers: { 'X-FactuEz-CSRF': TOKEN, Accept: 'application/json' },
      credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (init) {
      expect(options?.body).toBe(JSON.stringify(init.body));
      expect(options?.headers).toHaveProperty('Content-Type', 'application/json');
    }
    expect(JSON.stringify(options)).not.toMatch(/Bearer|Authorization/);
  });
  it.each([
    'https://evil.example' + PATH + '?environment=BETA',
    '//evil.example' + PATH + '?environment=BETA',
    PATH, PATH + '?', PATH + '?environment=PRODUCTION', PATH + '?limit=25',
    PATH + '?environment=BETA&environment=BETA', PATH + '?environment=BETA&limit=1&limit=2',
    PATH + '?environment=BETA&after=' + ID + '&after=' + ID,
    PATH + '?environment=BETA&limit=0', PATH + '?environment=BETA&limit=51',
    PATH + '?environment=BETA&limit=01', PATH + '?environment=BETA&limit=1e1',
    PATH + '?environment=BETA&limit=1%30', PATH + '?%65nvironment=BETA',
    PATH + '?environment=BETA&after=not-a-uuid',
    PATH + '?environment=BETA&redirect=https://evil.example',
    PATH + '?environment=BETA&', PATH + '?environment=BETA?limit=1',
    PATH + '?environment=BETA#ignored', PATH + '?environment=BETA\n',
    PATH + '/?environment=BETA', PATH + '/../session?environment=BETA',
    PATH + '/%2e%2e/session?environment=BETA', PATH + '/' + ID + '/rotate?environment=BETA',
    PATH + '/' + ID + '?environment=BETA&limit=25',
    PATH + '/' + ID + '?environment=BETA&after=' + ID,
  ])('rejects path/query outside the allowlist before fetch: %s', async path => {
    const { client, fetch, ready } = setup(); await ready();
    await expect(client.request(path)).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [PATH + '?environment=BETA', { method: 'PATCH', body: {} }],
    [PATH + '/' + ID + '?environment=BETA', { method: 'POST', body: {} }],
    [PATH + '/' + ID + '/rotate-secret?environment=BETA', undefined],
    [PATH + '?environment=BETA&limit=25', { method: 'POST', body: {} }],
    [PATH + '?environment=BETA', { method: 'DELETE', body: {} }],
    [PATH + '?environment=BETA', { method: 'GET', body: {} }],
    [PATH + '?environment=BETA', { method: 'POST', body: {}, headers: { Authorization: 'PRIVATE' } }],
  ])('rejects method/route mismatches and caller headers', async (path, init) => {
    const { client, fetch, ready } = setup(); await ready();
    await expect(client.request(path as string, init as any)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('permits a 120KB mutation but bounds UTF-8 request bytes to 128KiB', async () => {
    const { client, fetch, ready } = setup(); await ready(); fetch.mockResolvedValueOnce(json({ ok: true }));
    await client.request(PATH + '?environment=BETA', { method: 'POST', body: { metadata: 'a'.repeat(120_000) } });
    await expect(client.request(PATH + '?environment=BETA', { method: 'POST', body: { metadata: 'é'.repeat(70_000) } })).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' });
    expect(fetch).toHaveBeenCalledTimes(2);
    const circular: any = {}; circular.circular = circular;
    await expect(client.request(PATH + '?environment=BETA', { method: 'POST', body: circular })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.request(PATH + '?environment=BETA', { method: 'POST', body: undefined })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('checks generation after body serialization, before CSRF can be reused', async () => {
    const { client, fetch, ready } = setup(); await ready();
    await expect(client.request(PATH + '?environment=BETA', { method: 'POST', body: { toJSON() { client.invalidate(); return {}; } } })).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('session schema, SSO and errors', () => {
  it('disabled-by-default BFF response closes access without inventing success', async () => {
    const { client, fetch, assign } = setup();
    fetch.mockResolvedValueOnce(json({ code: 'ADMIN_BFF_DISABLED', message: 'PRIVATE' }, 503));
    await expect(client.status()).rejects.toMatchObject({ code: 'ADMIN_BFF_DISABLED' });
    expect(client.getSnapshot()).toMatchObject({ phase: 'disabled', enabled: false });
    await expect(client.start()).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(assign).not.toHaveBeenCalled();
  });
  it.each([
    null, {}, { ...anonymous(), enabled: false }, { ...anonymous(), environment: 'PRODUCTION' },
    { ...anonymous(), csrfToken: TOKEN }, { ...authenticated(), csrfToken: 'short' },
    { ...authenticated(), csrfToken: '+'.repeat(43) }, { ...authenticated(), expiresAt: 'tomorrow' },
    { ...authenticated(), expiresAt: '2026-99-99T12:00:00Z' }, { ...authenticated(), bearer: 'PRIVATE' },
  ])('rejects malformed or extra session authority fields: %#', async value => {
    const { client, fetch } = setup(); fetch.mockResolvedValueOnce(json(value));
    await expect(client.status()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(client.getSnapshot().phase).toBe('error');
    await expect(client.request(PATH + '?environment=BETA')).rejects.toMatchObject({ status: 401 });
  });
  it('never starts automatically and posts only {} on explicit start', async () => {
    const { client, fetch, assign } = setup();
    fetch.mockResolvedValueOnce(json(anonymous())); await client.status();
    expect(fetch).toHaveBeenCalledTimes(1); expect(assign).not.toHaveBeenCalled();
    const authorizeUrl = 'https://idp.example/authorize?client_id=admin&state=bound';
    fetch.mockResolvedValueOnce(json({ authorizeUrl })); await client.start();
    expect(fetch).toHaveBeenLastCalledWith(BASE + '/session/start', expect.objectContaining({
      method: 'POST', body: '{}', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    }));
    expect(assign).toHaveBeenCalledExactlyOnceWith(authorizeUrl);
  });
  it.each([
    'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '//evil.example/authorize',
    'http://idp.example/authorize', 'https://user:pass@idp.example/authorize',
    'https://idp.example@evil.example/authorize', 'https://@idp.example/authorize',
    'https://idp.example/authorize#javascript:alert(1)', 'https://idp.example/authorize#',
    'https://idp.example/\n/authorize', 'https:\\\\evil.example', '/authorize',
  ])('never navigates to unsafe SSO destination %s', async authorizeUrl => {
    const { client, fetch, assign } = setup();
    fetch.mockResolvedValueOnce(json(anonymous())); await client.status();
    fetch.mockResolvedValueOnce(json({ authorizeUrl }));
    await expect(client.start()).rejects.toMatchObject({ code: 'INVALID_AUTHORIZE_URL' });
    expect(assign).not.toHaveBeenCalled(); expect(client.getSnapshot().phase).toBe('error');
  });
  it('requires the exact start response envelope', async () => {
    const { client, fetch, assign } = setup();
    fetch.mockResolvedValueOnce(json(anonymous())); await client.status();
    fetch.mockResolvedValueOnce(json({ authorizeUrl: 'https://idp.example/auth', redirect: 'https://evil.example' }));
    await expect(client.start()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(assign).not.toHaveBeenCalled();
  });
  it.each([400, 404, 409, 429, 500, 502])('maps HTTP %i to finite errors without response secrets', async status => {
    const { client, fetch, ready } = setup(); await ready();
    fetch.mockResolvedValueOnce(json({ code: 'PRIVATE_CODE', message: TOKEN, secret: 'PRIVATE_SECRET' }, status));
    const error = await client.request(PATH + '?environment=BETA').catch(error => error);
    expect(error).toBeInstanceOf(AdminBrowserError);
    if (!(error instanceof AdminBrowserError)) throw Error('Expected finite admin error');
    expect(JSON.stringify(error) + error.message).not.toMatch(/PRIVATE|cccccc/);
    expect(error.status).toBe([400, 404, 409, 429].includes(status) ? status : 503);
  });
  it('sanitizes network errors and never retries writes', async () => {
    const { client, fetch, ready } = setup(); await ready();
    fetch.mockRejectedValueOnce(Error('PRIVATE_NETWORK_DETAIL'));
    await expect(client.request(PATH + '?environment=BETA', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: 'NETWORK_ERROR' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403])('HTTP %i invalidates memory and aborts concurrent work, including CSRF expiry', async status => {
    const { client, fetch, ready } = setup(); await ready();
    const slow = deferred<Response>(); fetch.mockReturnValueOnce(slow.promise);
    const pending = client.request(PATH + '?environment=BETA').catch(error => error);
    const signal = fetch.mock.calls[1][1]!.signal!;
    fetch.mockResolvedValueOnce(json({ code: 'ADMIN_CSRF_EXPIRED', secret: 'PRIVATE' }, status));
    await expect(client.request(PATH + '/' + ID + '?environment=BETA')).rejects.toMatchObject({ status });
    expect(signal.aborted).toBe(true); expect(client.getSnapshot().phase).toBe('expired');
    slow.resolve(json({ clientSecret: 'LATE_SECRET' }));
    expect(await pending).toMatchObject({ code: 'REQUEST_CANCELLED' });
    await expect(client.request(PATH + '?environment=BETA')).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(client.getSnapshot())).not.toMatch(/PRIVATE|LATE|cccccc/);
  });
});

describe('expiry, logout and stale responses', () => {
  it('expires independently of React and aborts a pending write at the deadline', async () => {
    vi.useFakeTimers();
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(json(authenticated(TOKEN, new Date(Date.now() + 1000).toISOString())));
    await client.status();
    const slow = deferred<Response>(); fetch.mockReturnValueOnce(slow.promise);
    const pending = client.request(PATH + '?environment=BETA', { method: 'POST', body: {} }).catch(error => error);
    const signal = fetch.mock.calls[1][1]!.signal!;
    await vi.advanceTimersByTimeAsync(1001);
    expect(client.getSnapshot().phase).toBe('expired'); expect(signal.aborted).toBe(true);
    slow.resolve(json({ clientSecret: 'DO_NOT_REVEAL' })); expect(await pending).toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('checks Date on every request even if the expiry timer has not fired', async () => {
    vi.useFakeTimers();
    const { client, fetch, ready } = setup(); await ready();
    vi.setSystemTime(Date.now() + 60_001);
    await expect(client.request(PATH + '?environment=BETA')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(fetch).toHaveBeenCalledTimes(1); expect(client.getSnapshot().phase).toBe('expired');
  });
  it('discards a response if Date advances during its body read', async () => {
    vi.useFakeTimers();
    const { client, fetch, ready } = setup(); await ready();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'Content-Type': 'application/json' } }));
    const work = client.request(PATH + '?environment=BETA').catch(error => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    vi.setSystemTime(Date.now() + 60_001);
    stream.enqueue(new TextEncoder().encode('{"clientSecret":"LATE"}')); stream.close();
    expect(await work).toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(client.getSnapshot().phase).toBe('expired');
  });
  it('rejects an already expired session without scheduling a timer', async () => {
    vi.useFakeTimers();
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(json(authenticated(TOKEN, new Date(Date.now() - 1).toISOString())));
    await expect(client.status()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(client.getSnapshot().phase).toBe('expired'); expect(vi.getTimerCount()).toBe(0);
  });
  it('posts logout with the memory CSRF and closes local access before the response', async () => {
    const { client, fetch, ready } = setup(); await ready();
    const slow = deferred<Response>(); fetch.mockReturnValueOnce(slow.promise);
    const logout = client.logout();
    expect(client.getSnapshot()).toMatchObject({ phase: 'anonymous', busy: true });
    expect(fetch).toHaveBeenLastCalledWith(BASE + '/session/logout', expect.objectContaining({
      method: 'POST', body: '{}', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-FactuEz-CSRF': TOKEN },
    }));
    await expect(client.request(PATH + '?environment=BETA')).rejects.toMatchObject({ status: 401 });
    slow.resolve(json({ loggedOut: true })); await logout;
    expect(client.getSnapshot()).toMatchObject({ phase: 'anonymous', busy: false });
    expect(JSON.stringify(client.getSnapshot())).not.toContain(TOKEN);
  });
  it.each([false, 'network', { loggedOut: false }, { loggedOut: true, secret: 'PRIVATE' }])('logout failure remains closed: %#', async response => {
    const { client, fetch, ready } = setup(); await ready();
    if (response === 'network') fetch.mockRejectedValueOnce(Error('PRIVATE'));
    else fetch.mockResolvedValueOnce(json(response));
    await expect(client.logout()).rejects.toBeInstanceOf(AdminBrowserError);
    expect(client.getSnapshot().phase).toBe('error');
    await expect(client.request(PATH + '?environment=BETA')).rejects.toMatchObject({ status: 401 });
  });
  it('close is idempotent, aborts work and discards late secrets even when fetch ignores abort', async () => {
    const { client, fetch, ready } = setup(); await ready();
    const slow = deferred<Response>(); fetch.mockReturnValueOnce(slow.promise);
    const work = client.request(PATH + '?environment=BETA', { method: 'POST', body: {} }).catch(error => error);
    const signal = fetch.mock.calls[1][1]!.signal!;
    const listener = vi.fn(); client.subscribe(listener); client.close(); client.close();
    expect(signal.aborted).toBe(true); expect(listener).toHaveBeenCalledTimes(1);
    slow.resolve(json({ clientSecret: 'LATE' }));
    expect(await work).toMatchObject({ code: 'REQUEST_CANCELLED' });
    await expect(client.status()).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
    expect(client.getSnapshot().phase).toBe('closed');
  });
  it('workspace logout closes only the B2B client and removes its event listener', async () => {
    vi.useFakeTimers();
    const { client, fetch, browser, events, ready } = setup(); await ready();
    expect(browser.addEventListener).toHaveBeenCalledTimes(1);
    events.dispatchEvent(new Event('factuez:workspace-logout'));
    expect(client.getSnapshot().phase).toBe('closed'); expect(vi.getTimerCount()).toBe(0);
    expect(browser.removeEventListener).toHaveBeenCalledWith('factuez:workspace-logout', expect.any(Function));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('stale unauthorized response cannot invalidate a replacement session', async () => {
    const { client, fetch, ready } = setup(); await ready();
    const slow = deferred<Response>(); fetch.mockReturnValueOnce(slow.promise);
    const work = client.request(PATH + '?environment=BETA').catch(error => error);
    fetch.mockResolvedValueOnce(json(authenticated(OTHER_TOKEN))); await client.status();
    slow.resolve(json({ code: 'EXPIRED' }, 401));
    expect(await work).toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(client.getSnapshot().phase).toBe('authenticated');
    fetch.mockResolvedValueOnce(json({ ok: true })); await client.request(PATH + '?environment=BETA');
    expect(fetch.mock.calls[3][1]!.headers).toHaveProperty('X-FactuEz-CSRF', OTHER_TOKEN);
  });
  it('stale session response cannot restore CSRF after invalidate', async () => {
    const { client, fetch } = setup();
    const slow = deferred<Response>(); fetch.mockReturnValueOnce(slow.promise);
    const work = client.status().catch(error => error);
    client.invalidate(); slow.resolve(json(authenticated()));
    expect(await work).toMatchObject({ code: 'REQUEST_CANCELLED' }); expect(client.getSnapshot().phase).toBe('expired');
    await expect(client.request(PATH + '?environment=BETA')).rejects.toMatchObject({ status: 401 });
  });
  it('stale start response never navigates after close', async () => {
    const { client, fetch, assign } = setup();
    fetch.mockResolvedValueOnce(json(anonymous())); await client.status();
    const slow = deferred<Response>(); fetch.mockReturnValueOnce(slow.promise);
    const work = client.start().catch(error => error); client.close();
    slow.resolve(json({ authorizeUrl: 'https://idp.example/authorize' }));
    expect(await work).toMatchObject({ code: 'REQUEST_CANCELLED' }); expect(assign).not.toHaveBeenCalled();
  });
  it('coalesces lifecycle actions while busy and never polls or starts on focus', async () => {
    vi.useFakeTimers();
    const { client, fetch, events } = setup();
    const slow = deferred<Response>(); fetch.mockReturnValueOnce(slow.promise);
    const work = client.status(); await client.status();
    expect(fetch).toHaveBeenCalledTimes(1);
    slow.resolve(json(anonymous())); await work;
    events.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('bounded JSON response reads', () => {
  it('limits session reads to 16KiB and rejects content-length before reading', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(json({ ...anonymous(), padding: 'x'.repeat(16 * 1024) }));
    await expect(client.status()).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    fetch.mockResolvedValueOnce(json(anonymous(), 200, { 'Content-Length': '16385' }));
    await expect(client.status()).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
  it('supports responses above 8MiB within the 16MiB BFF boundary', async () => {
    const { client, fetch, ready } = setup(); await ready();
    fetch.mockResolvedValueOnce(json({ metadata: 'x'.repeat(8 * 1024 * 1024 + 1) }));
    const value = await client.request<{ metadata: string }>(PATH + '?environment=BETA&limit=50');
    expect(value.metadata.length).toBe(8 * 1024 * 1024 + 1);
  });
  it('counts actual streamed bytes without relying on content-length', async () => {
    const { client, fetch, ready } = setup(); await ready();
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); }, cancel,
    }), { headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } }));
    await expect(client.request(PATH + '?environment=BETA')).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each([
    () => new Response('<script>PRIVATE</script>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{"secret":PRIVATE}', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('', { status: 302, headers: { Location: 'https://evil.example' } }),
  ])('rejects non-JSON, malformed data and redirects without rendering raw content: %#', async response => {
    const { client, fetch } = setup(); fetch.mockResolvedValueOnce(response());
    await expect(client.status()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', message: 'INVALID_RESPONSE' });
    expect(client.getSnapshot().phase).toBe('error');
  });
});


describe('workspace teardown cookie revocation', () => {
  it('clears CSRF, aborts session work, and sends detached keepalive logout before unmount', async () => {
    const { client, fetch, events, ready } = setup(); await ready();
    const slow = deferred<Response>(), revocation = deferred<Response>();
    fetch.mockReturnValueOnce(slow.promise);
    const work = client.request(PATH + '?environment=BETA').catch(error => error);
    const signal = fetch.mock.calls[1][1]!.signal!;
    fetch.mockReturnValueOnce(revocation.promise);
    events.dispatchEvent(new Event('factuez:workspace-logout'));
    expect(client.getSnapshot().phase).toBe('closed');
    expect(signal.aborted).toBe(true);
    const [url, request] = fetch.mock.calls[2];
    expect(url).toBe(BASE + '/session/logout');
    expect(request).toEqual({
      method: 'POST', body: '{}', cache: 'no-store', credentials: 'same-origin',
      redirect: 'error', keepalive: true,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-FactuEz-CSRF': TOKEN },
    });
    expect(request).not.toHaveProperty('signal');
    client.close();
    revocation.resolve(json({ loggedOut: true }));
    slow.resolve(json({ clientSecret: 'LATE' }));
    expect(await work).toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(client.getSnapshot().phase).toBe('closed');
    expect(JSON.stringify(client.getSnapshot())).not.toContain(TOKEN);
  });
  it('best-effort keepalive failures cannot reopen the panel or surface secrets', async () => {
    const { client, fetch, events, ready } = setup(); await ready();
    fetch.mockRejectedValueOnce(Error('PRIVATE_LOGOUT_FAILURE'));
    events.dispatchEvent(new Event('factuez:workspace-logout'));
    await Promise.resolve(); await Promise.resolve();
    expect(client.getSnapshot()).toEqual({ phase: 'closed', enabled: false, busy: false, error: null });
  });
  it('does not invent a CSRF header or send logout for an unauthenticated session', async () => {
    const { client, fetch, events } = setup();
    fetch.mockResolvedValueOnce(json(anonymous())); await client.status();
    events.dispatchEvent(new Event('factuez:workspace-logout'));
    expect(client.getSnapshot().phase).toBe('closed'); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

