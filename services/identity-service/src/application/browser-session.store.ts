import { Injectable, ServiceUnavailableException, UnauthorizedException, type OnApplicationShutdown } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Redis from 'ioredis';

export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_COOKIE = 'factuez_session';
export const SESSION_COOKIE_PATH = '/api/v1/auth/browser-session';
export type BrowserSession = { userId: string; authVersion: number; lastActivityAt: number };
const prefix = 'factuez:identity:browser-session:v1:';
const touchScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local session = cjson.decode(raw)
local now = tonumber(ARGV[1])
local idle = tonumber(ARGV[2])
if now >= session.lastActivityAt + idle then redis.call('DEL', KEYS[1]); return nil end
session.lastActivityAt = now
local updated = cjson.encode(session)
redis.call('SET', KEYS[1], updated, 'PX', idle)
return updated
`;

/** Identity owns these TTL records; no Prisma migration and no plaintext cookie in Redis. */
@Injectable()
export class BrowserSessionStore implements OnApplicationShutdown {
  private redis?: Redis;
  private client() {
    if (!this.redis) {
      this.redis = new Redis({ host: process.env.REDIS_HOST ?? 'redis', port: Number(process.env.REDIS_PORT ?? 6379),
        password: process.env.REDIS_PASSWORD_FILE ? readFileSync(process.env.REDIS_PASSWORD_FILE, 'utf8').trim() : undefined,
        lazyConnect: true, connectTimeout: 2000, commandTimeout: 3000, maxRetriesPerRequest: 1, autoResendUnfulfilledCommands: false });
      this.redis.on('error', () => { /* No infrastructure/credential diagnostics in responses or logs. */ });
    }
    return this.redis;
  }
  private async command<T>(run: (redis: Redis) => Promise<T>): Promise<T> {
    try { return await run(this.client()); }
    catch { throw new ServiceUnavailableException('El servicio de sesiones no está disponible; reintente'); }
  }
  id(cookie: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(cookie)) throw new UnauthorizedException('Sesión inválida');
    return createHash('sha256').update(cookie).digest('hex');
  }
  private key(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new UnauthorizedException('Sesión inválida');
    return prefix + id;
  }
  private parse(raw: string | null, now = Date.now()): BrowserSession {
    if (!raw) throw new UnauthorizedException('Sesión vencida por inactividad');
    let value: BrowserSession;
    try { value = JSON.parse(raw) as BrowserSession; } catch { throw new UnauthorizedException('Sesión inválida'); }
    if (!value || typeof value.userId !== 'string' || !Number.isInteger(value.authVersion) || !Number.isSafeInteger(value.lastActivityAt) ||
      value.lastActivityAt > now + 5000 || now >= value.lastActivityAt + SESSION_IDLE_MS) throw new UnauthorizedException('Sesión vencida o inválida');
    return value;
  }
  async create(userId: string, authVersion: number) {
    const cookie = randomBytes(32).toString('base64url'); const id = this.id(cookie);
    const session: BrowserSession = { userId, authVersion, lastActivityAt: Date.now() };
    const saved = await this.command(redis => redis.set(this.key(id), JSON.stringify(session), 'PX', SESSION_IDLE_MS, 'NX'));
    if (saved !== 'OK') throw new ServiceUnavailableException('No se pudo crear la sesión; reintente');
    return { cookie, id, session };
  }
  async get(id: string) {
    const key = this.key(id);
    return this.parse(await this.command(redis => redis.get(key)));
  }
  async touch(id: string) {
    const key = this.key(id);
    return this.parse(await this.command(async redis => await redis.eval(touchScript, 1, key, Date.now(), SESSION_IDLE_MS) as string | null));
  }
  async revoke(id: string) { const key = this.key(id); await this.command(redis => redis.del(key)); }
  onApplicationShutdown() { this.redis?.disconnect(); }
}
