import https, { createServer, type Server } from 'node:https';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ServerResponse } from 'node:http';
import { inspect } from 'node:util';
import { B2bSecurityError } from '../packages/contracts/src/b2b-security';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpsAdminOidcProvider, type AdminSsoProvider, type HttpsAdminOidcProviderConfig } from '../services/b2b-api-service/src/admin-bff-oidc';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';

const NOW = 1_790_000_000_000;
const SEC = NOW / 1000;
const CLIENT = 'synthetic-admin-client';
const SECRET = 'synthetic-only-client-secret';
const ACCESS = 'synthetic_opaque_access_token_0123456789';
const NONCE = 'synthetic_nonce_01234567890123456789';
const STATE = 'synthetic_state_01234567890123456789';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const ACR = 'urn:synthetic:mfa';
const WEB = 'https://admin.example.invalid';
type Wire = Record<string, unknown>;
type Reply = { status?: number; headers?: Record<string, string>; raw?: string | Buffer; hang?: boolean; trickle?: boolean; abort?: boolean };

describe('B2B08 pinned administrator OIDC with real loopback HTTPS', () => {
  let tls: ReturnType<typeof b2bCertificates>, server: Server, origin: string;
  let privateKey: KeyObject, publicKey: string, otherPrivateKey: KeyObject;
  let config: HttpsAdminOidcProviderConfig, provider: AdminSsoProvider;
  let idChanges: Wire, introChanges: Wire, tokenChanges: Wire, headerChanges: Wire;
  let tokenReply: Reply, introReply: Reply;
  let idRaw: string | undefined, headerRaw: string | undefined, signingKey: KeyObject;
  let calls: { path: string; fields: URLSearchParams; authorization?: string; protocol: string | null }[];
  let grants: Map<string, { nonce: string; challenge: string; used: boolean }>;
  let serial = 0;
  const tricklers = new Set<ReturnType<typeof setInterval>>();

  const idClaims = (nonce: string): Wire => ({
    iss: origin, sub: 'synthetic-human', aud: CLIENT, exp: SEC + 180, iat: SEC,
    auth_time: SEC - 20, acr: ACR, amr: ['pwd', 'mfa'], nonce,
    at_hash: createHash('sha256').update(ACCESS).digest().subarray(0, 16).toString('base64url'), ...idChanges,
  });
  const introspection = (): Wire => ({
    active: true, token_type: 'Bearer', iss: origin, aud: 'factuez-b2b-admin', client_id: CLIENT,
    sub: 'synthetic-human', scope: 'openid factuez.b2b.admin', exp: SEC + 120, iat: SEC,
    auth_time: SEC - 20, acr: ACR, amr: ['pwd', 'mfa'], ...introChanges,
  });
  function jwt(nonce: string) {
    const header = Buffer.from(headerRaw ?? JSON.stringify({ alg: 'RS256', kid: 'synthetic-key', typ: 'JWT', ...headerChanges })).toString('base64url');
    const payload = Buffer.from(idRaw ?? JSON.stringify(idClaims(nonce))).toString('base64url');
    const data = header + '.' + payload;
    return data + '.' + sign('RSA-SHA256', Buffer.from(data), signingKey).toString('base64url');
  }
  function reply(res: ServerResponse, options: Reply, value: Wire) {
    res.writeHead(options.status ?? 200, { 'content-type': 'application/json', ...options.headers });
    if (options.hang) return;
    if (options.abort) { res.write('{'); res.destroy(); return; }
    if (options.trickle) {
      res.write(' ');
      const interval = setInterval(() => res.write(' '), 100);
      tricklers.add(interval);
      res.on('close', () => { clearInterval(interval); tricklers.delete(interval); });
      return;
    }
    res.end(options.raw ?? JSON.stringify(value));
  }
  beforeAll(async () => {
    tls = b2bCertificates();
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = keys.privateKey;
    publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    otherPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    server = createServer({ ca: tls.ca, cert: tls.server, key: tls.key, minVersion: 'TLSv1.2', requestCert: true, rejectUnauthorized: true }, async (req, res) => {
      const socket = req.socket as import('node:tls').TLSSocket;
      if (!socket.authorized || fingerprint(socket.getPeerCertificate().raw) !== fingerprint(tls.resource)) { res.writeHead(403); res.end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const fields = new URLSearchParams(Buffer.concat(chunks).toString());
      calls.push({ path: req.url!, fields, authorization: req.headers.authorization, protocol: socket.getProtocol() });
      if (req.method !== 'POST' || req.headers.authorization !== 'Basic ' + Buffer.from(CLIENT + ':' + SECRET).toString('base64') || req.headers['content-type'] !== 'application/x-www-form-urlencoded') {
        reply(res, { status: 401 }, { error: SECRET + ACCESS }); return;
      }
      if (req.url === '/token') {
        const grant = grants.get(fields.get('code') ?? '');
        if (!grant || grant.used || fields.get('grant_type') !== 'authorization_code' || fields.get('redirect_uri') !== WEB + '/bff/b2b-admin/callback' ||
          createHash('sha256').update(fields.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) {
          reply(res, { status: 400 }, { error: 'invalid_grant', error_description: SECRET + ACCESS }); return;
        }
        grant.used = true;
        reply(res, tokenReply, { access_token: ACCESS, token_type: 'Bearer', expires_in: 240, id_token: jwt(grant.nonce), ...tokenChanges });
      } else if (req.url === '/introspect') {
        if (fields.get('token') !== ACCESS || fields.get('token_type_hint') !== 'access_token') { reply(res, {}, { active: false }); return; }
        reply(res, introReply, introspection());
      } else reply(res, { status: 404 }, {});
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = 'https://127.0.0.1:' + (server.address() as AddressInfo).port;
  }, 30_000);
  afterAll(async () => {
    for (const interval of tricklers) clearInterval(interval);
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  beforeEach(() => {
    idChanges = {}; introChanges = {}; tokenChanges = {}; headerChanges = {};
    tokenReply = {}; introReply = {}; idRaw = undefined; headerRaw = undefined; signingKey = privateKey;
    calls = []; grants = new Map();
    config = {
      issuer: origin, authorizationEndpoint: origin + '/authorize', tokenEndpoint: origin + '/token', introspectionEndpoint: origin + '/introspect',
      webOrigin: WEB, redirectUri: WEB + '/bff/b2b-admin/callback', clientId: CLIENT, clientSecret: SECRET,
      acceptedAcr: [ACR, 'urn:synthetic:hardware'], pinnedIdTokenKeys: { 'synthetic-key': publicKey },
      tls: { ca: Buffer.from(tls.ca), cert: Buffer.from(tls.resource), key: Buffer.from(tls.key) }, now: () => NOW,
    };
    provider = new HttpsAdminOidcProvider(config);
  });
  function issue(target = provider, nonce = NONCE) {
    const url = new URL(target.authorize({ state: STATE, nonce, codeChallenge: CHALLENGE }));
    expect(url.origin).toBe(origin);
    const code = 'synthetic-code-' + ++serial;
    grants.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, used: false });
    return { code, verifier: VERIFIER, nonce };
  }
  const exchange = () => provider.exchange(issue());
  async function rejected(operation: Promise<unknown>, status: 401 | 503 = 401) {
    try { await operation; expect.fail('Expected rejection'); }
    catch (error) {
      expect(error).toBeInstanceOf(B2bSecurityError);
      expect(error).toMatchObject({ status, code: status === 401 ? 'ADMIN_SESSION_REQUIRED' : 'ADMIN_BFF_UNAVAILABLE' });
      expect((error as Error).message).toBe(status === 401 ? 'ADMIN_SESSION_REQUIRED' : 'ADMIN_BFF_UNAVAILABLE');
      for (const output of [String(error), inspect(error, { showHidden: true }), JSON.stringify(error)]) {
        expect(output).not.toContain(SECRET); expect(output).not.toContain(ACCESS); expect(output).not.toContain(VERIFIER);
      }
    }
  }

  it('constructs and authorizes without network, discovery, or environment configuration', () => {
    const spy = vi.spyOn(https, 'request');
    try {
      const client = new HttpsAdminOidcProvider(config);
      const url = new URL(client.authorize({ state: STATE, nonce: NONCE, codeChallenge: CHALLENGE }));
      expect(spy).not.toHaveBeenCalled(); expect(calls).toEqual([]);
      expect(url.pathname).toBe('/authorize');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: CLIENT, redirect_uri: WEB + '/bff/b2b-admin/callback', response_type: 'code', scope: 'openid factuez.b2b.admin',
        state: STATE, nonce: NONCE, code_challenge: CHALLENGE, code_challenge_method: 'S256', prompt: 'login', max_age: '300',
        acr_values: ACR + ' urn:synthetic:hardware',
      });
    } finally { spy.mockRestore(); }
  });
  it('exchanges RS256 ID token and opaque access via authenticated mTLS introspection, returning epoch ms', async () => {
    const result = await exchange();
    expect(result.accessToken).toBe(ACCESS);
    expect(result.profile).toEqual({ issuer: origin, subject: 'synthetic-human', clientId: CLIENT, expiresAt: NOW + 120_000, authTime: NOW - 20_000, acr: ACR, amr: ['pwd', 'mfa'] });
    expect(calls.map(call => call.path)).toEqual(['/token', '/introspect']);
    expect(calls.every(call => ['TLSv1.2', 'TLSv1.3'].includes(call.protocol!))).toBe(true);
    expect(calls[0].fields.get('code_verifier')).toBe(VERIFIER);
    expect(calls[0].fields.has('client_secret')).toBe(false);
  });
  it.each(['id', 'access', 'expires_in'] as const)('chooses earliest expiry: %s', async source => {
    idChanges.exp = SEC + (source === 'id' ? 30 : 180);
    introChanges.exp = SEC + (source === 'access' ? 30 : 120);
    tokenChanges.expires_in = source === 'expires_in' ? 30 : 240;
    expect((await exchange()).profile.expiresAt).toBe(NOW + 30_000);
  });
  it('caps expires_in from request start and rechecks time after introspection', async () => {
    let now = NOW;
    provider = new HttpsAdminOidcProvider({ ...config, now: () => { const value = now; now += 1000; return value; } });
    tokenChanges.expires_in = 10;
    expect((await exchange()).profile.expiresAt).toBe(NOW + 10_000);
    now = NOW;
    tokenChanges.expires_in = 1;
    await rejected(exchange());
  });
  it('checks a live access token on every verify without an ID token and observes revocation', async () => {
    expect((await provider.verify(ACCESS)).subject).toBe('synthetic-human');
    introChanges.active = false;
    await rejected(provider.verify(ACCESS));
    expect(calls.map(call => call.path)).toEqual(['/introspect', '/introspect']);
  });
  it('supports configured admin scope, audience, ACRs, and a Map of pinned keys', async () => {
    provider = new HttpsAdminOidcProvider({ ...config, audience: 'synthetic-admin-audience', requiredScope: 'synthetic.admin', pinnedIdTokenKeys: new Map([['synthetic-key', publicKey]]) });
    introChanges.aud = 'synthetic-admin-audience'; introChanges.scope = 'openid synthetic.admin';
    expect((await exchange()).accessToken).toBe(ACCESS);
  });
  it('validates PKCE at the issuer, rejects code replay and unknown codes', async () => {
    const grant = issue();
    await rejected(provider.exchange({ ...grant, verifier: 'x'.repeat(64) }));
    expect(calls.map(call => call.path)).toEqual(['/token']);
    expect((await provider.exchange(grant)).accessToken).toBe(ACCESS);
    await rejected(provider.exchange(grant));
    await rejected(provider.exchange({ ...grant, code: 'synthetic-unknown-code' }));
  });
  it('binds signed nonce to this exchange and rejects a prior signed login response', async () => {
    const old = issue();
    const oldJwt = jwt(old.nonce);
    const fresh = issue(provider, 'different_nonce_01234567890123456789');
    tokenChanges.id_token = oldJwt;
    await rejected(provider.exchange(fresh));
    expect(calls.map(call => call.path)).toEqual(['/token']);
  });
  it('snapshots caller input and configuration across awaits', async () => {
    const grant = issue(); const pending = provider.exchange(grant);
    grant.nonce = 'mutated_nonce_01234567890123456789';
    config.clientSecret = 'mutated'; config.acceptedAcr = []; (config.pinnedIdTokenKeys as Record<string, string>)['synthetic-key'] = 'mutated';
    config.tls.ca.fill(0);
    expect((await pending).profile.subject).toBe('synthetic-human');
  });

  it.each([
    ['issuer', 'http://127.0.0.1'], ['issuer', 'https://user:password@127.0.0.1'],
    ['authorizationEndpoint', 'http://127.0.0.1/authorize'], ['tokenEndpoint', 'https://other.example.invalid/token'],
    ['introspectionEndpoint', 'https://other.example.invalid/introspect'], ['tokenEndpoint', 'https://127.0.0.1/token?x=y'],
    ['introspectionEndpoint', 'https://127.0.0.1/introspect#fragment'], ['webOrigin', 'http://admin.example.invalid'],
    ['webOrigin', WEB + '/path'], ['redirectUri', 'https://other.example.invalid/bff/b2b-admin/callback'],
    ['redirectUri', WEB + '/bff/b2b-admin/callback?next=evil'], ['redirectUri', WEB + '/other-callback'],
    ['clientSecret', ''], ['clientId', 'bad\nclient'], ['audience', ''], ['requiredScope', 'openid admin'], ['requiredScope', 'openid'],
    ['acceptedAcr', []], ['acceptedAcr', ['']], ['acceptedAcr', [ACR, ACR]], ['pinnedIdTokenKeys', {}], ['now', 'not-a-clock'],
  ])('rejects unsafe configuration %s=%j before I/O', (field, value) => {
    expect(() => new HttpsAdminOidcProvider({ ...config, [field]: value } as HttpsAdminOidcProviderConfig)).toThrow('ADMIN_SSO_INVALID_CONFIG');
    expect(calls).toEqual([]);
  });
  it('requires Buffer CA, certificate, and key', () => {
    for (const field of ['ca', 'cert', 'key']) {
      expect(() => new HttpsAdminOidcProvider({ ...config, tls: { ...config.tls, [field]: 'not-a-buffer' } })).toThrow('ADMIN_SSO_INVALID_CONFIG');
      expect(() => new HttpsAdminOidcProvider({ ...config, tls: { ...config.tls, [field]: Buffer.alloc(0) } })).toThrow('ADMIN_SSO_INVALID_CONFIG');
    }
  });
  it('rejects private PEM, weak RSA, non-RSA keys and URL keys locally', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'pem', type: 'spki' }).toString();
    for (const pem of [weak, ec, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), 'https://127.0.0.1/jwks'])
      expect(() => new HttpsAdminOidcProvider({ ...config, pinnedIdTokenKeys: { key: pem } })).toThrow('ADMIN_SSO_INVALID_CONFIG');
    expect(calls).toEqual([]);
  });
  it('validates state/nonce/PKCE and access input without I/O', async () => {
    for (const input of [{ state: '' }, { nonce: '' }, { codeChallenge: 'x'.repeat(43) + '=' }, { codeChallenge: 'x'.repeat(42) }])
      expect(() => provider.authorize({ state: STATE, nonce: NONCE, codeChallenge: CHALLENGE, ...input })).toThrow('ADMIN_SESSION_REQUIRED');
    for (const access of ['', 'a'.repeat(15), 'a'.repeat(8193), 'bad token with spaces', 'bad\nheader_0123456789']) await rejected(provider.verify(access));
    for (const change of [{ code: '' }, { verifier: 'short' }, { nonce: '' }, { code: 'bad\ncode' }])
      await rejected(provider.exchange({ code: 'synthetic-code', nonce: NONCE, verifier: VERIFIER, ...change }));
    expect(calls).toEqual([]);
  });

  it.each([
    { kid: 'unknown-key' }, { alg: 'none' }, { alg: 'HS256' }, { alg: 'PS256' }, { typ: 'at+jwt' },
    { jku: 'https://127.0.0.1/jwks' }, { x5u: 'https://127.0.0.1/cert' }, { jwk: {} }, { crit: ['nonce'] },
  ])('rejects unpinned/unsupported JWT header %j without key lookup network', async change => {
    headerChanges = change; await rejected(exchange()); expect(calls.map(call => call.path)).toEqual(['/token']);
  });
  it('rejects a valid RSA signature from a different key', async () => {
    signingKey = otherPrivateKey; await rejected(exchange()); expect(calls).toHaveLength(1);
  });
  it.each([
    { iss: 'https://other.example.invalid' }, { sub: '' }, { aud: 'other-client' }, { aud: [CLIENT, 'other-client'] },
    { aud: [CLIENT, 'other-client'], azp: 'other-client' }, { azp: 'other-client' }, { nonce: 'wrong-nonce' },
    { exp: SEC }, { exp: SEC + 301 }, { exp: '1790000100' }, { iat: SEC + 1 }, { iat: SEC - 400 },
    { nbf: SEC + 1 }, { auth_time: SEC - 301 }, { auth_time: SEC + 1 }, { auth_time: undefined },
    { acr: 'password-only' }, { amr: ['pwd'] }, { amr: ['mfa', 'mfa'] }, { at_hash: 'invalid-access-hash' },
    { roles: ['ADMIN'] }, { is_admin: true },
  ])('rejects invalid signed ID claims %j', async change => {
    idChanges = change; await rejected(exchange()); expect(calls).toHaveLength(1);
  });
  it('accepts multi-audience ID token only with our azp and optional at_hash/nbf', async () => {
    idChanges = { aud: [CLIENT, 'synthetic-other-audience'], azp: CLIENT, at_hash: undefined, nbf: SEC };
    expect((await exchange()).profile.subject).toBe('synthetic-human');
  });
  it.each([
    { active: false }, { active: 'true' }, { token_type: 'bearer' }, { client_id: 'other-client' }, { iss: 'https://other.example.invalid' },
    { sub: '' }, { aud: 'ordinary-b2b' }, { aud: ['ordinary-b2b', 1] }, { scope: 'openid' },
    { scope: 'factuez.b2b.admin.evil' }, { scope: 'factuez.b2b.admin factuez.b2b.admin' }, { scope: 'openid  factuez.b2b.admin' },
    { exp: SEC }, { exp: SEC + 301 }, { exp: SEC + 1.5 }, { iat: SEC + 1 }, { iat: undefined }, { nbf: SEC + 1 },
    { auth_time: SEC - 301 }, { auth_time: SEC + 1 }, { auth_time: undefined }, { acr: 'password-only' },
    { amr: ['pwd'] }, { amr: 'mfa' }, { roles: ['ADMIN'] }, { role: 'ADMIN' }, { is_admin: true }, { admin: true },
  ])('rejects invalid live introspection claims %j', async change => {
    introChanges = change; await rejected(provider.verify(ACCESS)); expect(calls).toHaveLength(1);
  });
  it.each([{ sub: 'other-human' }, { auth_time: SEC - 21 }])('crosschecks ID and introspection identity %j', async change => {
    introChanges = change; await rejected(exchange()); expect(calls).toHaveLength(2);
  });
  it('role flags cannot rescue missing MFA or missing admin scope', async () => {
    introChanges = { amr: ['pwd'], scope: 'openid', roles: ['ADMIN'], is_admin: true };
    await rejected(provider.verify(ACCESS));
  });
  it.each([
    { token_type: 'bearer' }, { access_token: 'short' }, { access_token: 'a'.repeat(8193) }, { access_token: 'invalid token whitespace' },
    { expires_in: 301 }, { expires_in: 0 }, { expires_in: -1 }, { expires_in: '300' }, { expires_in: 1.5 },
    { id_token: 'a.b' }, { id_token: 'a.b.c.d' }, { id_token: 'x'.repeat(24_577) }, { refresh_token: 'unexpected' }, { error: SECRET },
  ])('rejects closed token response case %#', async change => {
    tokenChanges = change; await rejected(exchange(), Object.hasOwn(change, 'error') ? 503 : 401); expect(calls).toHaveLength(1);
  });
  it('rejects invalid signature bytes and noncanonical base64url', async () => {
    const valid = jwt(NONCE);
    const pieces = valid.split('.');
    for (const raw of [valid + '=', pieces[0] + '=.' + pieces[1] + '.' + pieces[2], pieces[0] + '.' + pieces[1] + '.AA', pieces[0] + '.' + pieces[1] + '.' + 'A'.repeat(pieces[2].length)]) {
      tokenChanges.id_token = raw; await rejected(exchange());
    }
  });
  it.each(['{"alg":"none","alg":"RS256","kid":"synthetic-key"}', '{"alg":"RS256","kid":"synthetic-key","k\\u0069d":"other"}',
    '{"alg":"RS256","kid":"synthetic-key","__proto__":{}}', '{ "alg":"RS256","kid":"synthetic-key"}'])('rejects duplicate/prototype/noncanonical signed header %s', async raw => {
    headerRaw = raw; await rejected(exchange());
  });
  it('rejects duplicate, escaped duplicate and prototype ID claims even when correctly signed', async () => {
    const base = JSON.stringify(idClaims(NONCE));
    for (const suffix of [',"sub":"other"}', ',"s\\u0075b":"other"}', ',"__proto__":{}}', ',"constructor":{}}']) {
      idRaw = base.slice(0, -1) + suffix; await rejected(exchange());
    }
    idRaw = ' ' + base; await rejected(exchange());
  });
  it.each(['token', 'introspection'] as const)('rejects malformed, duplicate, prototype, invalid UTF8 and deep JSON at %s endpoint', async endpoint => {
    for (const raw of ['{}garbage', '[]', 'null', '{"active":true,"active":false}', '{"active":true,"a\\u0063tive":false}',
      '{"__proto__":{"active":true}}', '{"nested":{"constructor":{}}}', '{"nested":' + '['.repeat(17) + '0' + ']'.repeat(17) + '}',
      '{"number":1e999}', '{"text":"\\ud800"}', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), Buffer.from('\ufeff{}')]) {
      if (endpoint === 'token') { tokenReply = { raw }; await rejected(exchange(), 503); }
      else { introReply = { raw }; await rejected(provider.verify(ACCESS), 503); }
    }
  });
  it.each(['token', 'introspection'] as const)('denies redirects, malformed transport, oversized headers/bodies and server errors at %s endpoint', async endpoint => {
    const responses: Reply[] = [
      { status: 302, headers: { location: origin + '/unexpected-redirect' } },
      { status: 307, headers: { location: 'https://example.invalid/secret' } },
      { status: 500, raw: SECRET + ACCESS }, { headers: { 'content-type': 'text/html' }, raw: '<html>' + SECRET },
      { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-length': '32769' }, raw: 'x'.repeat(32769) },
      { raw: 'x'.repeat(32769) }, { headers: { 'x-big': 'x'.repeat(9000) } }, { abort: true },
    ];
    for (const options of responses) {
      const count = calls.length;
      if (endpoint === 'token') { tokenReply = options; await rejected(exchange(), 503); }
      else { introReply = options; await rejected(provider.verify(ACCESS), 503); }
      expect(calls).toHaveLength(count + 1);
    }
    expect(calls.every(call => ['/token', '/introspect'].includes(call.path))).toBe(true);
  });
  it.each(['token', 'introspection'] as const)('enforces a five second absolute deadline even with trickle data at %s endpoint', async endpoint => {
    const start = performance.now();
    if (endpoint === 'token') { tokenReply = { trickle: true }; await rejected(exchange(), 503); }
    else { introReply = { trickle: true }; await rejected(provider.verify(ACCESS), 503); }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(4500); expect(elapsed).toBeLessThan(7000);
  }, 10_000);
  it('validates the server CA and requires a client certificate acceptable to the server', async () => {
    for (const tlsConfig of [{ ...config.tls, ca: Buffer.from('not-a-trusted-ca') }, { ...config.tls, cert: tls.server }]) {
      const client = new HttpsAdminOidcProvider({ ...config, tls: tlsConfig });
      await rejected(client.verify(ACCESS), 503);
    }
    expect(calls).toEqual([]);
  });
  it('rejects duplicate transport members whose last value would otherwise authorize access', async () => {
    const claims = JSON.stringify(introspection());
    introReply = { raw: '{"active":false,' + claims.slice(1) };
    await rejected(provider.verify(ACCESS), 503);
    introReply = { raw: '{"a\\u0063tive":false,' + claims.slice(1) };
    await rejected(provider.verify(ACCESS), 503);
    introReply = {};
    const token = JSON.stringify({ access_token: ACCESS, token_type: 'Bearer', expires_in: 120, id_token: jwt(NONCE) });
    tokenReply = { raw: '{"token_type":"wrong",' + token.slice(1) };
    await rejected(exchange(), 503);
    expect(calls.map(call => call.path)).toEqual(['/introspect', '/introspect', '/token']);
  });
  it('does not call JWT-supplied key URLs even on the trusted issuer origin', async () => {
    for (const key of ['jku', 'x5u']) {
      headerChanges = { [key]: origin + '/untrusted-key-url' };
      const count = calls.length;
      await rejected(exchange()); expect(calls).toHaveLength(count + 1);
    }
    expect(calls.every(call => call.path === '/token')).toBe(true);
  });
  it('encodes Basic credentials as form components without sending secrets in the body', async () => {
    const clientId = 'synthetic:+&%', clientSecret = 'secret:+&%';
    provider = new HttpsAdminOidcProvider({ ...config, clientId, clientSecret });
    await rejected(provider.verify(ACCESS), 503); // The fake issuer only accepts its registered credentials.
    expect(calls[0].authorization).toBe('Basic ' + Buffer.from('synthetic%3A%2B%26%25:secret%3A%2B%26%25').toString('base64'));
    expect(calls[0].fields.has('client_secret')).toBe(false);
  });
  it.each([
    { status: 400, error: 'invalid_grant', expected: 401 },
    { status: 400, error: 'invalid_client', expected: 503 },
    { status: 400, error: 'ADMIN_SESSION_REQUIRED', expected: 503 },
    { status: 401, error: 'invalid_grant', expected: 503 },
    { status: 200, error: 'upstream-arbitrary-code', expected: 503 },
  ] as const)('uses only closed local error codes for OAuth error $error with HTTP $status', async entry => {
    tokenReply = { status: entry.status, raw: JSON.stringify({ error: entry.error, error_description: SECRET + ACCESS }) };
    await rejected(exchange(), entry.expected);
    expect(calls).toHaveLength(1);
  });
  it('does not propagate arbitrary B2bSecurityError instances from injected callbacks', async () => {
    provider = new HttpsAdminOidcProvider({ ...config, now: () => { throw new B2bSecurityError(401, 'UNTRUSTED_CODE_' + SECRET); } });
    await rejected(provider.verify(ACCESS), 503);
    expect(calls).toHaveLength(1);
    provider = new HttpsAdminOidcProvider({ ...config, now: () => Number.NaN });
    await rejected(exchange(), 503);
    expect(calls).toHaveLength(1);
  });
  it('classifies signed malformed ID JSON as an invalid session', async () => {
    headerRaw = '{';
    await rejected(exchange(), 401);
    expect(calls).toHaveLength(1);
  });
  it('sanitizes synchronous TLS configuration errors without retaining a deadline', async () => {
    provider = new HttpsAdminOidcProvider({ ...config, tls: { ...config.tls, key: Buffer.from('bad-private-key-' + SECRET) } });
    await rejected(provider.verify(ACCESS), 503);
  });
  it('redacts client credentials, TLS private key and access tokens from JSON and inspection', async () => {
    const result = await exchange();
    for (const value of [provider, result]) {
      for (const output of [JSON.stringify(value), inspect(value), inspect(value, { customInspect: false, showHidden: true })]) {
        expect(output).not.toContain(SECRET); expect(output).not.toContain(ACCESS); expect(output).not.toContain('PRIVATE KEY');
      }
    }
    expect(result.accessToken).toBe(ACCESS);
    const input = { ...issue(), verifier: 'wrong-but-valid-format-' + 'a'.repeat(43) };
    await rejected(provider.exchange(input));
  });
});
