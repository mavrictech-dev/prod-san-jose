import { createHash, createPublicKey, constants, timingSafeEqual, verify as verifySignature, type KeyObject } from 'node:crypto';
import { request } from 'node:https';
import type { ClientRequest } from 'node:http';
import { inspect } from 'node:util';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';

export interface AdminSsoProfile {
  issuer: string;
  subject: string;
  clientId: string;
  /** All profile timestamps are epoch milliseconds. OIDC wire timestamps are seconds. */
  expiresAt: number;
  authTime: number;
  acr: string;
  amr: string[];
}

export interface AdminSsoProvider {
  authorize(input: { state: string; nonce: string; codeChallenge: string }): string;
  exchange(input: { code: string; verifier: string; nonce: string }): Promise<{ accessToken: string; profile: AdminSsoProfile }>;
  verify(accessToken: string): Promise<AdminSsoProfile>;
}

export interface HttpsAdminOidcProviderConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  introspectionEndpoint: string;
  /** Explicit public web origin, e.g. https://admin.example.test (no path). */
  webOrigin: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  audience?: string;
  requiredScope?: string;
  acceptedAcr: readonly string[];
  pinnedIdTokenKeys: Readonly<Record<string, string>> | ReadonlyMap<string, string>;
  tls: { ca: Buffer; cert: Buffer; key: Buffer };
  /** Epoch milliseconds. No clock skew is granted to an administrator token. */
  now?: () => number;
}

/** Only these locally created failures may cross the BFF boundary. */
class AdminOidcError extends B2bSecurityError {
  constructor(status: 401 | 503) {
    super(status, status === 401 ? 'ADMIN_SESSION_REQUIRED' : 'ADMIN_BFF_UNAVAILABLE');
  }
}
function safeFailure(error: unknown): AdminOidcError {
  return error instanceof AdminOidcError ? error : new AdminOidcError(503);
}

type Claims = Record<string, unknown>;
const MAX_BYTES = 32 * 1024;
const MAX_AGE = 300_000;
const TIMEOUT = 5000;
const CALLBACK = '/bff/b2b-admin/callback';
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor', 'toJSON']);
const PROFILE_CLAIMS = ['iss', 'sub', 'aud', 'exp', 'iat', 'nbf', 'auth_time', 'acr', 'amr'];
const INTROSPECTION_CLAIMS = [...PROFILE_CLAIMS, 'active', 'token_type', 'client_id', 'scope'];
const ID_CLAIMS = [...PROFILE_CLAIMS, 'azp', 'nonce', 'at_hash'];
function ensure(value: unknown): asserts value {
  if (!value) throw new AdminOidcError(401);
}
function text(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0020\u007f]/.test(value);
}
function object(value: unknown): asserts value is Claims {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}
function closed(value: Claims, allowed: readonly string[]): void {
  ensure(Object.keys(value).every(key => allowed.includes(key)));
}
function httpsUrl(value: string): URL {
  ensure(text(value, 2048) && !/[\\?#]/.test(value));
  const url = new URL(value);
  ensure(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash);
  return url;
}
function opaque(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && value.length >= 16 && value.length <= 8192 && /^[A-Za-z0-9._~+/-]+={0,2}$/.test(value));
}
function randomBinding(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(value));
}
function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function seconds(value: unknown): number {
  ensure(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value * 1000));
  return value * 1000;
}
function audiences(value: unknown, expected: string): void {
  const items = typeof value === 'string' ? [value] : value;
  ensure(Array.isArray(items) && items.length > 0 && items.length <= 16 && items.every(item => text(item)) &&
    new Set(items).size === items.length && items.includes(expected));
}
function scope(value: unknown, required: string): void {
  ensure(typeof value === 'string' && value.length <= 2048 && /^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(value));
  const words = value.split(' ');
  ensure(new Set(words).size === words.length && words.includes(required));
}
function b64url(value: string, max: number): Buffer {
  ensure(value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value));
  const bytes = Buffer.from(value, 'base64url');
  ensure(bytes.toString('base64url') === value);
  return bytes;
}

/** Local equivalent of the SDK's raw-member scan; the backend has no SDK dependency.
 * JSON.parse alone silently drops duplicate keys, including escaped aliases. */
function strictJson(bytes: Buffer, canonical = false): Claims {
  ensure(bytes.length > 0 && bytes.length <= MAX_BYTES);
  try {
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const parsed: unknown = JSON.parse(source);
    object(parsed);
    const stack: ({ object: true; keys: Set<string>; expectKey: boolean } | { object: false })[] = [];
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (c === '"') {
        const start = i++;
        for (; i < source.length; i++) {
          if (source[i] === '\\') { i++; continue; }
          if (source[i] === '"') break;
        }
        const frame = stack.at(-1);
        if (frame?.object && frame.expectKey) {
          const key: string = JSON.parse(source.slice(start, i + 1));
          ensure(!FORBIDDEN.has(key) && !frame.keys.has(key));
          frame.keys.add(key); frame.expectKey = false;
        }
      } else if (c === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
      else if (c === '[') stack.push({ object: false });
      else if (c === '}' || c === ']') stack.pop();
      else if (c === ',') { const frame = stack.at(-1); if (frame?.object) frame.expectKey = true; }
      ensure(stack.length <= 16);
    }
    const visit = (value: unknown): void => {
      if (typeof value === 'number') ensure(Number.isFinite(value));
      else if (typeof value === 'string') ensure(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value));
      else if (Array.isArray(value)) { ensure(value.length <= 256); value.forEach(visit); }
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(parsed);
    if (canonical) ensure(JSON.stringify(parsed) === source);
    return parsed;
  } catch { throw new AdminOidcError(401); }
}

/** Explicit, pinned OIDC transport. Construction and authorize perform no I/O.
 * State/nonce single-use storage belongs to the BFF; code replay and PKCE are
 * enforced by the issuer's token endpoint. No discovery or remote JWT keys. */
export class HttpsAdminOidcProvider implements AdminSsoProvider {
  #issuer: string;
  #authorizationEndpoint: string;
  #tokenEndpoint: string;
  #introspectionEndpoint: string;
  #redirectUri: string;
  #clientId: string;
  #basic: string;
  #audience: string;
  #scope: string;
  #acr: readonly string[];
  #keys = new Map<string, KeyObject>();
  #tls: { ca: Buffer; cert: Buffer; key: Buffer };
  #now: () => number;

  constructor(config: HttpsAdminOidcProviderConfig) {
    try {
      const issuer = httpsUrl(config.issuer);
      const authorization = httpsUrl(config.authorizationEndpoint);
      const token = httpsUrl(config.tokenEndpoint);
      const introspection = httpsUrl(config.introspectionEndpoint);
      ensure([authorization, token, introspection].every(endpoint => endpoint.origin === issuer.origin));
      const web = httpsUrl(config.webOrigin);
      ensure(config.webOrigin === web.origin && config.redirectUri === web.origin + CALLBACK);
      httpsUrl(config.redirectUri);
      ensure(text(config.clientId) && text(config.clientSecret, 4096));
      const audience = config.audience ?? 'factuez-b2b-admin';
      const requiredScope = config.requiredScope ?? 'factuez.b2b.admin';
      ensure(text(audience) && /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(requiredScope) && requiredScope !== 'openid');
      ensure(Array.isArray(config.acceptedAcr) && config.acceptedAcr.length > 0 && config.acceptedAcr.length <= 16 &&
        config.acceptedAcr.every(acr => text(acr)) && new Set(config.acceptedAcr).size === config.acceptedAcr.length);
      ensure(config.tls && [config.tls.ca, config.tls.cert, config.tls.key].every(part => Buffer.isBuffer(part) && part.length > 0));
      const entries = config.pinnedIdTokenKeys instanceof Map ? [...config.pinnedIdTokenKeys] : Object.entries(config.pinnedIdTokenKeys);
      ensure(entries.length > 0 && entries.length <= 32);
      for (const [kid, pem] of entries) {
        ensure(text(kid, 128) && !FORBIDDEN.has(kid) && typeof pem === 'string' && pem.length <= 16_384 &&
          /^-----BEGIN (?:RSA )?PUBLIC KEY-----\r?\n/.test(pem));
        const key = createPublicKey(pem);
        ensure(key.type === 'public' && key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048);
        this.#keys.set(kid, key);
      }
      ensure(config.now === undefined || typeof config.now === 'function');
      this.#issuer = config.issuer;
      this.#authorizationEndpoint = authorization.href;
      this.#tokenEndpoint = token.href;
      this.#introspectionEndpoint = introspection.href;
      this.#redirectUri = config.redirectUri;
      this.#clientId = config.clientId;
      // RFC 6749 client_secret_basic encodes each credential as a form component.
      const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
      this.#basic = 'Basic ' + Buffer.from(encode(config.clientId) + ':' + encode(config.clientSecret)).toString('base64');
      this.#audience = audience;
      this.#scope = requiredScope;
      this.#acr = [...config.acceptedAcr];
      this.#tls = { ca: Buffer.from(config.tls.ca), cert: Buffer.from(config.tls.cert), key: Buffer.from(config.tls.key) };
      this.#now = config.now ?? Date.now;
    } catch { throw new Error('ADMIN_SSO_INVALID_CONFIG'); }
  }

  toJSON() { return { provider: 'HttpsAdminOidcProvider', credentials: '[REDACTED]' }; }
  [inspect.custom]() { return this.toJSON(); }

  authorize(input: { state: string; nonce: string; codeChallenge: string }): string {
    try {
      randomBinding(input.state); randomBinding(input.nonce);
      ensure(typeof input.codeChallenge === 'string' && b64url(input.codeChallenge, 43).length === 32);
      const url = new URL(this.#authorizationEndpoint);
      url.search = new URLSearchParams({
        client_id: this.#clientId, redirect_uri: this.#redirectUri, response_type: 'code',
        scope: 'openid ' + this.#scope, state: input.state, nonce: input.nonce,
        code_challenge: input.codeChallenge, code_challenge_method: 'S256',
        prompt: 'login', max_age: '300', acr_values: this.#acr.join(' '),
      }).toString();
      return url.href;
    } catch (error) { throw safeFailure(error); }
  }

  async exchange(input: { code: string; verifier: string; nonce: string }): Promise<{ accessToken: string; profile: AdminSsoProfile }> {
    try {
      // Snapshot before the first await; the caller cannot replace the nonce mid-flight.
      const { code, verifier, nonce } = input;
      ensure(text(code, 2048) && typeof verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier));
      randomBinding(nonce);
      const startedAt = this.#clock();
      const token = await this.#post(this.#tokenEndpoint, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: this.#redirectUri }, true);
      closed(token, ['access_token', 'token_type', 'expires_in', 'id_token', 'scope']);
      opaque(token.access_token);
      ensure(token.token_type === 'Bearer' && typeof token.expires_in === 'number' && Number.isSafeInteger(token.expires_in) && token.expires_in > 0 && token.expires_in <= 300);
      if (token.scope !== undefined) scope(token.scope, this.#scope);
      const id = this.#idToken(token.id_token, nonce, token.access_token);
      const profile = await this.#introspect(token.access_token);
      ensure(id.issuer === profile.issuer && id.subject === profile.subject && id.clientId === profile.clientId && id.authTime === profile.authTime);
      profile.expiresAt = Math.min(profile.expiresAt, id.expiresAt, startedAt + token.expires_in * 1000);
      const now = this.#clock();
      ensure(profile.expiresAt > now && now - profile.authTime <= MAX_AGE);
      // Access remains available to the BFF but is absent from JSON/debug output.
      const accessToken = token.access_token;
      const result = { profile } as { accessToken: string; profile: AdminSsoProfile };
      Object.defineProperties(result, {
        accessToken: { get: () => accessToken },
        toJSON: { value: () => ({ profile, accessToken: '[REDACTED]' }) },
        [inspect.custom]: { value: () => ({ profile, accessToken: '[REDACTED]' }) },
      });
      return result;
    } catch (error) { throw safeFailure(error); }
  }

  async verify(accessToken: string): Promise<AdminSsoProfile> {
    try { opaque(accessToken); return await this.#introspect(accessToken); }
    catch (error) { throw safeFailure(error); }
  }

  #clock(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new AdminOidcError(503);
    return now;
  }

  #profile(claims: Claims): AdminSsoProfile {
    const now = this.#clock();
    ensure(claims.iss === this.#issuer && text(claims.sub, 255));
    const expiresAt = seconds(claims.exp), issuedAt = seconds(claims.iat), authTime = seconds(claims.auth_time);
    ensure(issuedAt <= now && expiresAt > now && expiresAt > issuedAt && expiresAt - issuedAt <= MAX_AGE &&
      authTime <= issuedAt && now - authTime <= MAX_AGE);
    if (claims.nbf !== undefined) { const nbf = seconds(claims.nbf); ensure(nbf <= now && nbf < expiresAt); }
    ensure(typeof claims.acr === 'string' && this.#acr.includes(claims.acr));
    ensure(Array.isArray(claims.amr) && claims.amr.length > 0 && claims.amr.length <= 16 &&
      claims.amr.every(method => text(method, 128)) && new Set(claims.amr).size === claims.amr.length && claims.amr.includes('mfa'));
    return { issuer: this.#issuer, subject: claims.sub, clientId: this.#clientId, expiresAt, authTime, acr: claims.acr, amr: [...claims.amr] };
  }

  #idToken(raw: unknown, nonce: string, accessToken: string): AdminSsoProfile {
    ensure(typeof raw === 'string' && raw.length <= 24_576);
    const parts = raw.split('.');
    ensure(parts.length === 3);
    const header = strictJson(b64url(parts[0], 2048), true);
    closed(header, ['alg', 'kid', 'typ']);
    ensure(header.alg === 'RS256' && text(header.kid, 128) && (header.typ === undefined || header.typ === 'JWT'));
    const key = this.#keys.get(header.kid);
    ensure(key);
    const signature = b64url(parts[2], 2048);
    ensure(signature.length === Math.ceil(key.asymmetricKeyDetails!.modulusLength! / 8));
    ensure(verifySignature('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), { key, padding: constants.RSA_PKCS1_PADDING }, signature));
    const claims = strictJson(b64url(parts[1], 16_384), true);
    closed(claims, ID_CLAIMS);
    audiences(claims.aud, this.#clientId);
    if (Array.isArray(claims.aud) && claims.aud.length > 1) ensure(claims.azp === this.#clientId);
    if (claims.azp !== undefined) ensure(claims.azp === this.#clientId);
    ensure(typeof claims.nonce === 'string' && same(claims.nonce, nonce));
    if (claims.at_hash !== undefined) {
      const hash = createHash('sha256').update(accessToken, 'ascii').digest().subarray(0, 16).toString('base64url');
      ensure(typeof claims.at_hash === 'string' && same(claims.at_hash, hash));
    }
    return this.#profile(claims);
  }

  async #introspect(accessToken: string): Promise<AdminSsoProfile> {
    const claims = await this.#post(this.#introspectionEndpoint, { token: accessToken, token_type_hint: 'access_token' });
    closed(claims, INTROSPECTION_CLAIMS);
    ensure(claims.active === true && claims.token_type === 'Bearer' && claims.client_id === this.#clientId);
    audiences(claims.aud, this.#audience);
    scope(claims.scope, this.#scope);
    return this.#profile(claims);
  }

  #post(endpoint: string, fields: Record<string, string>, loginExchange = false): Promise<Claims> {
    const body = new URLSearchParams(fields).toString();
    ensure(Buffer.byteLength(body) <= MAX_BYTES);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value?: Claims, status: 401 | 503 = 503) => {
        if (settled) return;
        settled = true; clearTimeout(deadline);
        if (value) resolve(value); else reject(new AdminOidcError(status));
      };
      let req: ClientRequest | undefined;
      const deadline = setTimeout(() => { finish(); req?.destroy(); }, TIMEOUT);
      deadline.unref();
      try {
        req = request(endpoint, {
          ...this.#tls, method: 'POST', agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2', timeout: TIMEOUT, maxHeaderSize: 8192,
          headers: { Authorization: this.#basic, 'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body), Accept: 'application/json', 'Accept-Encoding': 'identity' },
        }, res => {
          if ((res.statusCode !== 200 && !(res.statusCode === 400 && loginExchange)) || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(res.headers['content-type'] ?? '') ||
            (res.headers['content-encoding'] !== undefined && res.headers['content-encoding'] !== 'identity') ||
            (res.headers['content-length'] !== undefined && (!/^\d+$/.test(res.headers['content-length']) || Number(res.headers['content-length']) > MAX_BYTES))) {
            finish(); res.destroy(); req?.destroy(); return;
          }
          const chunks: Buffer[] = []; let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BYTES) { finish(); res.destroy(); req?.destroy(); } else chunks.push(chunk);
          });
          res.on('aborted', () => finish());
          res.on('error', () => finish());
          res.on('end', () => {
            if (settled) return;
            try {
              ensure(res.complete);
              const value = strictJson(Buffer.concat(chunks));
              // Only a bounded OAuth invalid_grant error means a rejected login.
              // Client authentication failures, unknown codes and HTTP failures
              // indicate an unavailable provider; never relay its error strings.
              if (res.statusCode === 400) {
                closed(value, ['error', 'error_description', 'error_uri']);
                finish(undefined, value.error === 'invalid_grant' ? 401 : 503);
              } else if (Object.hasOwn(value, 'error')) finish();
              else finish(value);
            }
            catch { finish(); }
          });
        });
        req.on('error', () => finish());
        req.on('timeout', () => { finish(); req?.destroy(); });
        req.end(body);
      } catch { finish(); req?.destroy(); }
    });
  }
}
