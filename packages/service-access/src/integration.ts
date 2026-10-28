/** Opt-in M2M read transport. Not exported through the human-access index. */
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import type { TLSSocket } from 'node:tls';
import { IntegrationErrors, IntegrationPatterns, IntegrationScopes, validIntegrationGrant,
  type IntegrationErrorCode, type IntegrationGrantV1, type IntegrationScope,
  type IntegrationDocumentDetailV1 } from '@factuez/contracts/integration';

export class IntegrationReadError extends Error {
  constructor(readonly status: number, readonly code: IntegrationErrorCode) { super(code); }
}
export const deny = (status: number, code: IntegrationErrorCode): never => { throw new IntegrationReadError(status, code); };
export const plain = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const uuid = (value: unknown): value is string => typeof value === 'string' && new RegExp(IntegrationPatterns.uuid).test(value);
export const ruc = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{10}$/.test(value);
export interface ReadPrincipal { clientId: string; revision: number; environment: 'BETA'; scopes: IntegrationScope[]; grants: IntegrationGrantV1[] }
export function validPrincipal(value: unknown): value is ReadPrincipal {
  return plain(value) && Object.keys(value).every(k => ['clientId','revision','environment','scopes','grants'].includes(k)) &&
    uuid(value.clientId) && Number.isSafeInteger(value.revision) && value.revision > 0 && value.environment === 'BETA' &&
    Array.isArray(value.scopes) && value.scopes.length > 0 && value.scopes.length <= 6 && value.scopes.every((s: any) => IntegrationScopes.includes(s)) &&
    new Set(value.scopes).size === value.scopes.length && Array.isArray(value.grants) && value.grants.length > 0 && value.grants.length <= 100 &&
    value.grants.every((g: unknown) => validIntegrationGrant(g) && ruc(g.issuerRuc));
}
export function requireIssuer(p: ReadPrincipal, issuerRuc: string) {
  if (!validPrincipal(p)) return deny(401, 'UNAUTHENTICATED');
  if (!p.grants.some(g => g.issuerRuc === issuerRuc && [g.branches,g.points,g.series].every(s => s.kind === 'ALL' || s.ids.length > 0)))
    return deny(404, 'RESOURCE_NOT_FOUND');
}
export function requireScopes(p: ReadPrincipal, required: IntegrationScope[]) {
  if (!validPrincipal(p)) return deny(401, 'UNAUTHENTICATED');
  if (!required.every(s => p.scopes.includes(s))) return deny(403, 'INSUFFICIENT_SCOPE');
}
export interface BillingReadEnvelope { document: IntegrationDocumentDetailV1 }
export interface ReadRequest { headers: Record<string, string | string[] | undefined>; socket: TLSSocket }
export function privateRequest(req: ReadRequest, peers: readonly string[]): { token: string; requestId: string } {
  const fingerprint = req.socket.encrypted && req.socket.authorized && req.socket.getPeerCertificate().fingerprint256?.replace(/:/g,'').toLowerCase();
  if (!fingerprint || !peers.includes(fingerprint)) return deny(403, 'INSUFFICIENT_SCOPE');
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(header)) return deny(401, 'UNAUTHENTICATED');
  return { token: header.slice(7), requestId: randomUUID() };
}
export function readQuery(value: unknown, keys: string[], required: string[] = ['issuerRuc']) {
  if (!plain(value) || Object.keys(value).some(k => !keys.includes(k)) || Object.values(value).some(v => typeof v !== 'string' || !v) ||
      required.some(k => !Object.hasOwn(value,k)) || (value.environment !== undefined && value.environment !== 'BETA') ||
      (value.issuerRuc !== undefined && !ruc(value.issuerRuc))) return deny(400, 'INVALID_QUERY');
  return value as Record<string,string>;
}
/** Deterministic snapshot hash, bounded depth/size. Never used as proof of signature or acceptance. */
export function snapshotHash(value: unknown) {
  let nodes = 0;
  function canonical(v: unknown, depth: number): unknown {
    if (++nodes > 100000 || depth > 32) return deny(409, 'EVIDENCE_INCONSISTENT');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(x => canonical(x, depth + 1));
    if (!plain(v)) return deny(409, 'EVIDENCE_INCONSISTENT');
    return Object.fromEntries(Object.keys(v).sort().map(k => [k,canonical(v[k],depth+1)]));
  }
  const json = JSON.stringify(canonical(value,0));
  if (Buffer.byteLength(json) > 2 * 1024 * 1024) return deny(409, 'EVIDENCE_INCONSISTENT');
  return createHash('sha256').update(json).digest('hex');
}
export interface Transport { ca: Buffer; cert: Buffer; key: Buffer }
export class PrivateReadHttp {
  private readonly origin: URL;
  constructor(origin: string, private readonly tls: Transport) {
    this.origin = new URL(origin);
    if (this.origin.protocol !== 'https:' || this.origin.username || this.origin.password || this.origin.pathname !== '/' || this.origin.search || this.origin.hash)
      throw new Error('Fixed private HTTPS origin required');
  }
  async bytes(path: string, token: string, maximum = 16 * 1024 * 1024, body?: unknown): Promise<{ bytes: Buffer; headers: Record<string, unknown> }> {
    if (!/^\/(?:internal\/integration|integration\/v1)(?:\/|\?)/.test(path) || path.includes('..') ||
        !/^[A-Za-z0-9_.-]{1,8192}$/.test(token)) return deny(400, 'INVALID_REQUEST');
    if(!Number.isSafeInteger(maximum) || maximum<1 || maximum>64*1024*1024) return deny(400,'INVALID_REQUEST');
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if(encoded && Buffer.byteLength(encoded)>4*1024*1024) return deny(400,'INVALID_REQUEST');
    // Fixed read-only operations may materialize an authorized cut before 202. No caller-selected timeout.
    const timeoutMs=/^\/(?:internal\/integration|integration\/v1)\/changes\?/.test(path)?60000:
      encoded && path==='/internal/integration/exports'?240000:
      encoded && ['/internal/integration/capture','/internal/integration/reauthorize'].includes(path)?20000:5000;
    return new Promise((resolveResult,reject) => {
      const req = request(new URL(path,this.origin), { ...this.tls, rejectUnauthorized: true, timeout: timeoutMs, method: encoded ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer '+token, Accept: encoded ? 'application/json' : '*/*', 'Cache-Control':'no-store',
          ...(encoded ? { 'Content-Type':'application/json','Content-Length': Buffer.byteLength(encoded) } : {}) } }, response => {
        const chunks: Buffer[] = []; let length = 0;
        response.on('data',(chunk: Buffer) => { length += chunk.length; if (length > maximum) req.destroy(new Error('Bounded upstream'));
          else chunks.push(chunk); });
        response.on('error',() => reject(new IntegrationReadError(503,'UPSTREAM_UNAVAILABLE')));
        response.on('end',() => {
          const bytes = Buffer.concat(chunks);
          if (response.statusCode !== 200 && !(encoded && response.statusCode===202)) {
            const status = response.statusCode ?? 503;
            let code: IntegrationErrorCode = status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'INSUFFICIENT_SCOPE' : status === 404 ? 'RESOURCE_NOT_FOUND' : 'UPSTREAM_UNAVAILABLE';
            try { const error = JSON.parse(bytes.toString()).error;
              if (plain(error) && IntegrationErrors.includes(error.code)) code = error.code;
            } catch { /* Never relay arbitrary upstream body/errors. */ }
            reject(new IntegrationReadError([400,401,403,404,409,410,422,429,503].includes(status) ? status : 503,code));
          } else resolveResult({ bytes, headers: response.headers });
        });
      });
      const deadline=setTimeout(()=>req.destroy(new Error('Private read deadline')),timeoutMs);
      req.once('close',()=>clearTimeout(deadline));
      req.on('timeout',() => req.destroy(new Error('Private read timeout')));
      req.on('error',() => reject(new IntegrationReadError(503,'UPSTREAM_UNAVAILABLE'))); req.end(encoded);
    });
  }
  async json<T>(path: string, token: string, body?: unknown): Promise<T> {
    const response = await this.bytes(path,token,16*1024*1024,body);
    if (!String(response.headers['content-type'] ?? '').startsWith('application/json')) return deny(503,'UPSTREAM_UNAVAILABLE');
    try { return JSON.parse(response.bytes.toString('utf8')) as T; } catch { return deny(503,'UPSTREAM_UNAVAILABLE'); }
  }
}
export interface ReadIdentity { authenticate(token: string, scopes: IntegrationScope[]): Promise<ReadPrincipal> }
export class RemoteReadIdentity implements ReadIdentity {
  constructor(private readonly http: PrivateReadHttp) {}
  async authenticate(token: string, scopes: IntegrationScope[]) {
    const result = await this.http.json<unknown>('/internal/integration/introspect',token,{ requiredScopes: scopes });
    if (!validPrincipal(result)) return deny(503,'UPSTREAM_UNAVAILABLE');
    requireScopes(result,scopes); return result;
  }
}
export function ownerRuntimeConfig(env: NodeJS.ProcessEnv, flag: string) {
  if (env[flag] !== 'true') return null;
  if (env.INTEGRATION_READ_ENVIRONMENT !== 'BETA' || (env.INTEGRATION_READ_HOST && env.INTEGRATION_READ_HOST !== '127.0.0.1'))
    throw new Error('Read runtime is BETA and loopback only');
  const required = (name: string) => { const value = env[name]; if (!value) throw new Error('Missing '+name); return value; };
  const pem = (name: string) => readFileSync(required(name));
  const port = Number(required('INTEGRATION_READ_PORT'));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid private read port');
  const peers = required('INTEGRATION_READ_PEERS').split(',');
  if (!peers.length || peers.length > 100 || peers.some(p => !/^[a-f0-9]{64}$/.test(p)) || new Set(peers).size !== peers.length)
    throw new Error('Explicit mTLS peer allowlist required');
  return { port, peers, cert: pem('INTEGRATION_READ_TLS_CERT_FILE'),key: pem('INTEGRATION_READ_TLS_KEY_FILE'),ca: pem('INTEGRATION_READ_TLS_CA_FILE'),
    client: { ca: pem('INTEGRATION_READ_CLIENT_CA_FILE'),cert: pem('INTEGRATION_READ_CLIENT_CERT_FILE'),key: pem('INTEGRATION_READ_CLIENT_KEY_FILE') },
    identityOrigin: required('INTEGRATION_READ_IDENTITY_ORIGIN') };
}
