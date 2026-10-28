// Ejecutar SÓLO dentro de identity-service del QA existente. No datos fiscales.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const Redis = require('/workspace/services/identity-service/node_modules/ioredis');
if (!process.argv.includes('--isolated-only') || process.env.LOCAL_BROWSER_SESSION_QA_ENABLED !== 'true' || process.env.SUNAT_ENVIRONMENT !== 'BETA') throw new Error('Sólo QA Beta');
const origin = 'http://localhost:8091'; const base = 'http://kong:8000';
const redis = new Redis({ host: 'redis', password: readFileSync('/run/secrets/redis_password', 'utf8').trim(), maxRetriesPerRequest: 1, commandTimeout: 3000 });
redis.on('error', () => {});
let sessionCookie = ''; let key;
const call = (path, options = {}) => fetch(base + path, { redirect: 'error', signal: AbortSignal.timeout(10000), ...options, headers: {
  Origin: origin, Accept: 'application/json', 'Content-Type': 'application/json', ...(sessionCookie ? { Cookie: sessionCookie } : {}), ...options.headers,
} });
(async () => {
  const response = await call('/api/v1/auth/browser-session/login', { method: 'POST', body: JSON.stringify({
    username: process.env.INITIAL_ADMIN_USERNAME, password: readFileSync('/run/secrets/initial_admin_password', 'utf8').trim(),
  }) });
  assert.equal(response.status, 200, 'login');
  const login = await response.json(); const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  sessionCookie = setCookie.split(';')[0]; const raw = sessionCookie.slice(sessionCookie.indexOf('=') + 1);
  key = 'factuez:identity:browser-session:v1:' + createHash('sha256').update(raw).digest('hex');
  assert.equal(login.idleTimeoutSeconds, 1800); assert.equal(login.user.browserSessionId, key.split(':').at(-1));
  const before = await redis.get(key); const ttlBefore = await redis.pttl(key);
  const restoredResponse = await call('/api/v1/auth/browser-session'); assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json(); assert.equal(restored.user.sub, login.user.sub);
  assert.equal(await redis.get(key), before); assert.ok(await redis.pttl(key) <= ttlBefore, 'restore no extiende TTL');
  for (const [elapsed, remaining] of [[1500000, 300000], [1770000, 30000]]) {
    const record = JSON.parse(before); record.lastActivityAt = Date.now() - elapsed;
    await redis.set(key, JSON.stringify(record), 'PX', 1800000);
    const r = await call('/api/v1/auth/browser-session'); assert.equal(r.status, 200);
    const status = await r.json(); const left = status.idleExpiresAt - status.serverNow;
    assert.ok(left <= remaining && left >= remaining - 5000, 'umbral de aviso');
  }
  const continuedResponse = await call('/api/v1/auth/browser-session/activity', { method: 'POST' }); assert.equal(continuedResponse.status, 200);
  const continued = await continuedResponse.json(); assert.ok(continued.idleExpiresAt - continued.serverNow >= 1799000);
  const refused = await call('/api/v1/auth/browser-session/activity', { method: 'POST', headers: { Origin: 'http://evil.invalid' } }); assert.equal(refused.status, 403);
  const logout = await call('/api/v1/auth/browser-session/logout', { method: 'POST' }); assert.equal(logout.status, 200);
  assert.equal(await redis.get(key), null);
  const bearerAfterLogout = await call('/api/v1/auth/me', { headers: { Authorization: 'Bearer ' + restored.accessToken } }); assert.equal(bearerAfterLogout.status, 401);
  // Sólo revive el registro recién creado de ESTE TEST para comprobar el borde 30 min.
  const expired = JSON.parse(before); expired.lastActivityAt = Date.now() - 1800000;
  await redis.set(key, JSON.stringify(expired), 'PX', 10000);
  assert.equal((await call('/api/v1/auth/browser-session')).status, 401);
  assert.equal((await call('/api/v1/auth/browser-session/activity', { method: 'POST' })).status, 401);
  console.log(JSON.stringify({ login: true, cookieHttpOnly: true, restoreWithoutIdleExtension: true, warning5Minutes: true, warning30Seconds: true,
    continueSession: true, csrfRejected: true, logoutRevokesBearer: true, expiredCannotRevive: true, fiscalWrites: 0 }));
})().catch(() => { console.error('Falló una comprobación de sesión QA; sin detalles ni secretos'); process.exitCode = 1; })
  .finally(async () => { if (key) await redis.del(key); redis.disconnect(); });
