import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserSessionStore, SESSION_IDLE_MS, SESSION_COOKIE } from '../services/identity-service/src/application/browser-session.store';
import { BrowserSessionController } from '../services/identity-service/src/browser-session.controller';
import { AuthService } from '../services/identity-service/src/application/auth.service';
import { idlePhase, idleSeconds, localIdleDeadline, IDLE_TIMEOUT_MS } from '../apps/web-pwa/features/workspace/session-policy';

const id = 'a'.repeat(64); const cookie = 'A'.repeat(43);
const user = { sub: '30000000-0000-4000-8000-000000000888', authVersion: 1 };
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T22:00:00Z'));
  vi.stubEnv('LOCAL_BROWSER_SESSION_QA_ENABLED', 'true'); vi.stubEnv('AUTH_BROWSER_ORIGINS', 'http://localhost:8091');
  const session = { userId: user.sub, authVersion: 1, lastActivityAt: Date.now() };
  const store = { id: vi.fn(() => id), get: vi.fn(async () => session), create: vi.fn(async () => ({ cookie, id, session })),
    touch: vi.fn(async () => ({ ...session, lastActivityAt: Date.now() })), revoke: vi.fn(async () => {}) };
  const auth = { login: vi.fn(async () => ({ accessToken: 'MOCK_ACCESS' })), verifyAccessToken: vi.fn(() => user),
    browserAccess: vi.fn(async () => ({ accessToken: 'MOCK_BROWSER_ACCESS', expiresIn: 900, tokenType: 'Bearer' })), assertActive: vi.fn(async () => {}) };
  const response = { setHeader: vi.fn() }; const request = { headers: { origin: 'http://localhost:8091', cookie: `${SESSION_COOKIE}=${cookie}` } };
  const controller = new BrowserSessionController(auth as never, store as never);
  return { session, store, auth, response, request, controller };
}

describe('Plazo de inactividad solicitado', () => {
  it('avisa a los 25 min, a los 29:30 y vence exactamente a los 30 min', () => {
    expect(SESSION_IDLE_MS).toBe(IDLE_TIMEOUT_MS); expect(SESSION_IDLE_MS).toBe(1800000);
    const deadline = SESSION_IDLE_MS;
    expect(idlePhase(deadline, 1499999)).toBe('active');
    expect(idlePhase(deadline, 1500000)).toBe('warning'); expect(idleSeconds(deadline, 1500000)).toBe(300);
    expect(idlePhase(deadline, 1769999)).toBe('warning');
    expect(idlePhase(deadline, 1770000)).toBe('critical'); expect(idleSeconds(deadline, 1770000)).toBe(30);
    expect(idlePhase(deadline, 1800000)).toBe('expired'); expect(idleSeconds(deadline, 1800001)).toBe(0);
  });
  it('ajusta diferencias entre reloj cliente y servidor y rechaza plazos inventados', () => {
    expect(localIdleDeadline({ serverNow: 100000, idleExpiresAt: 120000 }, 1000)).toBe(21000);
    expect(() => localIdleDeadline({ serverNow: 1000, idleExpiresAt: 999 })).toThrow();
    expect(() => localIdleDeadline({ serverNow: 1000, idleExpiresAt: 1803000 })).toThrow();
  });
});

describe('Cookie, restauración y renovación sin actividad ficticia', () => {
  it('restaurar al recargar devuelve JWT sin prolongar el plazo ni tocar Redis', async () => {
    const f = fixture(); vi.advanceTimersByTime(25 * 60000);
    const result = await f.controller.restore(f.request, f.response);
    expect(result.idleExpiresAt - result.serverNow).toBe(5 * 60000);
    expect(f.store.touch).not.toHaveBeenCalled();
    expect(f.auth.browserAccess).toHaveBeenCalledWith(user.sub, 1, id);
    expect(f.response.setHeader).toHaveBeenCalledWith('Set-Cookie', expect.stringContaining('HttpOnly; SameSite=Strict; Max-Age=300'));
    expect(f.response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, private');
  });
  it('sólo POST de actividad renueva los 30 minutos', async () => {
    const f = fixture(); vi.advanceTimersByTime(29 * 60000);
    const result = await f.controller.activity(f.request, f.response);
    expect(result.idleExpiresAt - result.serverNow).toBe(SESSION_IDLE_MS);
    expect(f.store.touch).toHaveBeenCalledExactlyOnceWith(id);
  });
  it.each([undefined, 'http://evil.invalid', 'null'])('rechaza CSRF de origen %s antes de tocar sesión', async origin => {
    const f = fixture();
    await expect(f.controller.activity({ headers: { ...f.request.headers, origin } } as never, f.response)).rejects.toThrow('Origen');
    expect(f.store.touch).not.toHaveBeenCalled(); expect(f.store.get).not.toHaveBeenCalled();
  });
  it('exige HTTPS y cookie Secure fuera del QA explícito', async () => {
    const f = fixture(); vi.stubEnv('LOCAL_BROWSER_SESSION_QA_ENABLED', 'false');
    await expect(f.controller.activity(f.request, f.response)).rejects.toThrow('seguro');
    vi.stubEnv('AUTH_BROWSER_ORIGINS', 'https://factuez.intranet');
    await f.controller.activity({ headers: { ...f.request.headers, origin: 'https://factuez.intranet' } }, f.response);
    expect(f.response.setHeader).toHaveBeenCalledWith('Set-Cookie', expect.stringContaining('; Secure'));
  });
  it('rechaza cookies repetidas, accesos revocados y sesiones ya vencidas', async () => {
    const f = fixture();
    await expect(f.controller.restore({ headers: { cookie: `${SESSION_COOKIE}=${cookie}; ${SESSION_COOKIE}=${cookie}` } }, f.response)).rejects.toThrow();
    f.auth.assertActive.mockRejectedValueOnce(new Error('Acceso revocado'));
    await expect(f.controller.activity(f.request, f.response)).rejects.toThrow('revocado');
    expect(f.store.touch).not.toHaveBeenCalled();
    f.store.get.mockRejectedValueOnce(new Error('Sesión vencida'));
    await expect(f.controller.restore(f.request, f.response)).rejects.toThrow('vencida');
  });
  it('cerrar sesión revoca el registro y borra la cookie', async () => {
    const f = fixture(); await f.controller.logout(f.request, f.response);
    expect(f.store.revoke).toHaveBeenCalledExactlyOnceWith(id);
    expect(f.response.setHeader).toHaveBeenCalledWith('Set-Cookie', expect.stringContaining('Max-Age=0'));
  });
  it('login no devuelve la cookie opaca en JSON y sustituye la sesión previa', async () => {
    const f = fixture(); const result = await f.controller.login(f.request, f.response, { username: 'MOCK_USER', password: 'MOCK_PASSWORD' });
    expect(JSON.stringify(result)).not.toContain(cookie); expect(f.store.revoke).toHaveBeenCalledExactlyOnceWith(id);
    expect(f.response.setHeader).toHaveBeenCalledWith('Set-Cookie', expect.stringContaining(cookie));
  });
});

describe('Enforcement en Identity y almacenamiento', () => {
  it('un Bearer web se invalida al cerrar o vencer la sesión aunque no haya expirado su JWT', async () => {
    const sessions = { get: vi.fn(async () => ({ userId: user.sub, authVersion: 1, lastActivityAt: Date.now() })) };
    const prisma = { user: { findUnique: vi.fn(async () => ({ active: true, authVersion: 1 })) } };
    const auth = new AuthService(prisma as never, {} as never, sessions as never);
    await auth.assertActive({ ...user, browserSessionId: id });
    sessions.get.mockRejectedValueOnce(new Error('Sesión vencida'));
    await expect(auth.assertActive({ ...user, browserSessionId: id })).rejects.toThrow('vencida');
    sessions.get.mockResolvedValueOnce({ userId: 'OTHER_MOCK_USER', authVersion: 1, lastActivityAt: Date.now() });
    await expect(auth.assertActive({ ...user, browserSessionId: id })).rejects.toThrow('inválida');
  });
  it('guarda sólo el hash de la cookie con TTL 30 min y get no renueva TTL', async () => {
    const redis = { set: vi.fn(async () => 'OK'), get: vi.fn(), eval: vi.fn(), del: vi.fn() };
    const store = new BrowserSessionStore(); vi.spyOn(store as never, 'client' as never).mockReturnValue(redis as never);
    const created = await store.create(user.sub, 1);
    expect(created.cookie).toHaveLength(43); expect(created.id).toHaveLength(64);
    const [key, value, px, ttl, nx] = redis.set.mock.calls[0] as unknown as [string, string, string, number, string];
    expect(key).toContain(created.id); expect(key + value).not.toContain(created.cookie); expect([px, ttl, nx]).toEqual(['PX', SESSION_IDLE_MS, 'NX']);
    redis.get.mockResolvedValue(JSON.stringify(created.session));
    await store.get(created.id); expect(redis.set).toHaveBeenCalledOnce(); expect(redis.eval).not.toHaveBeenCalled();
    await store.revoke(created.id); expect(redis.del).toHaveBeenCalledWith(key);
  });
  it('no revive una sesión a los 30 minutos aunque Redis tarde en eliminarla', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000000);
    const record = { userId: user.sub, authVersion: 1, lastActivityAt: Date.now() };
    const redis = { get: vi.fn(async () => JSON.stringify(record)), eval: vi.fn(async () => null) };
    const store = new BrowserSessionStore(); vi.spyOn(store as never, 'client' as never).mockReturnValue(redis as never);
    vi.advanceTimersByTime(SESSION_IDLE_MS);
    await expect(store.get(id)).rejects.toThrow('vencida');
    await expect(store.touch(id)).rejects.toThrow('inactividad');
    expect(redis.eval).toHaveBeenCalledOnce();
  });
});
