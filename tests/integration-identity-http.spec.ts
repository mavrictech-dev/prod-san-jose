import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { request } from 'node:https';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '../services/identity-service/node_modules/@nestjs/core';
import type { NestExpressApplication } from '../services/identity-service/node_modules/@nestjs/platform-express';
import { IntegrationErrorFilter, IntegrationIdentityModule } from '../services/identity-service/src/integration/http';
import { basic, fixture, input } from './integration-identity.fixture';

// Ephemeral fictitious CA and keys in memory. No user certificates, filesystem secrets or TLS bypass.
const forge = createRequire(resolve('packages/evidence-core/package.json'))('node-forge');
function certificates() {
  const pki = forge.pki, rootPair = pki.rsa.generateKeyPair(2048), leafPair = pki.rsa.generateKeyPair(2048);
  const ca = pki.createCertificate(); ca.publicKey = rootPair.publicKey; ca.serialNumber = '01';
  ca.validity.notBefore = new Date(Date.now() - 60000); ca.validity.notAfter = new Date(Date.now() + 3600000);
  ca.setSubject([{ name: 'commonName', value: 'FactuEz fictitious QA CA' }]); ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
  ca.sign(rootPair.privateKey, forge.md.sha256.create());
  const leaf = (serial: string, name: string, server = false) => {
    const cert = pki.createCertificate(); cert.publicKey = leafPair.publicKey; cert.serialNumber = serial;
    cert.validity.notBefore = ca.validity.notBefore; cert.validity.notAfter = ca.validity.notAfter;
    cert.setSubject([{ name: 'commonName', value: name }]); cert.setIssuer(ca.subject.attributes);
    cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: server, clientAuth: !server },
      ...(server ? [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }] : [])]);
    cert.sign(rootPair.privateKey, forge.md.sha256.create()); return pki.certificateToPem(cert);
  };
  return { ca: pki.certificateToPem(ca), key: pki.privateKeyToPem(leafPair.privateKey), server: leaf('02','localhost',true),
    token: leaf('03','token-fixture'), admin: leaf('04','admin-fixture'), resource: leaf('05','resource-fixture'), rejected: leaf('06','unapproved-fixture') };
}

describe('Isolated real Nest HTTPS/mTLS transport (fictitious clients only)', () => {
  let app: NestExpressApplication, port: number, tls: ReturnType<typeof certificates>;
  const f = fixture(); let made: Awaited<ReturnType<typeof f.core.create>>;
  const fingerprint = (cert: string) => new X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase();
  beforeAll(async () => {
    tls = certificates();
    made = await f.core.create('human-fixture', input(), { requestId: '90000000-0000-4000-8000-000000000001', peer: 'fixture-local' });
    const options = { cert: tls.server, key: tls.key, ca: tls.ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const };
    app = await NestFactory.create<NestExpressApplication>(IntegrationIdentityModule.isolated(f.core,
      { token: [fingerprint(tls.token)], admin: [fingerprint(tls.admin)], resource: [fingerprint(tls.resource)] }),
      { logger: false, bodyParser: false, httpsOptions: options });
    app.useBodyParser('json', { limit: '32kb', strict: true });
    app.useBodyParser('urlencoded', { limit: '2kb', extended: false, parameterLimit: 4 });
    app.useGlobalFilters(new IntegrationErrorFilter()); await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  }, 30000);
  afterAll(async () => { await app?.close(); });
  function send(path: string, body?: string, headers: Record<string,string> = {}, peer: keyof typeof tls | null = 'token', trust = true, method = body === undefined ? 'GET' : 'POST') {
    return new Promise<{ status: number; body: any; headers: Record<string, unknown> }>((resolveResult, reject) => {
      const req = request({ hostname: '127.0.0.1', servername: 'localhost', port, path, method,
        rejectUnauthorized: true, ...(trust ? { ca: tls.ca } : {}), ...(peer ? { cert: tls[peer], key: tls.key } : {}), timeout: 3000,
        headers: { ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers } }, res => {
        const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('error', reject);
        res.on('end', () => { try { resolveResult({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()), headers: res.headers }); } catch (e) { reject(e); } });
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Timeout'))); req.end(body);
    });
  }
  const form = 'grant_type=client_credentials&scope=integration%3Adocuments%3Aread';
  async function issue() {
    return send('/integration/oauth/token', form, { Authorization: basic(made.client.id, made.clientSecret) });
  }
  it('issues OAuth token over authenticated TLS and sends no-store, without refresh token', async () => {
    const result = await issue(); expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ token_type: 'Bearer', expires_in: 300 });
    expect(result.body).not.toHaveProperty('refresh_token'); expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.headers).not.toHaveProperty('access-control-allow-origin');
  });
  it('TLS rejects absent client certificates and untrusted server chains', async () => {
    await expect(send('/integration/oauth/token', form, {}, null)).rejects.toThrow();
    await expect(send('/integration/oauth/token', form, {}, 'token', false)).rejects.toThrow();
  });
  it('a valid but unapproved TLS peer cannot spoof its authorization using forwarded headers', async () => {
    const result = await send('/integration/oauth/token', form, { 'X-Forwarded-Proto': 'https', 'X-User-Id': 'admin' }, 'rejected');
    expect(result.status).toBe(403); expect(result.body.error).toBe('PRIVATE_PEER_REQUIRED');
  });
  it('bad secret returns generic 401 and Basic challenge, never the supplied secret', async () => {
    const secret = 'a'.repeat(43), result = await send('/integration/oauth/token', form, { Authorization: basic(made.client.id, secret) });
    expect(result.status).toBe(401); expect(result.body).toEqual({ error: 'invalid_client' });
    expect(String(result.headers['www-authenticate'])).toContain('Basic'); expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('rate quota returns OAuth-compatible error and Retry-After without leaking backend details', async () => {
    const previous = f.store.rate;
    f.store.rate = async () => false;
    try {
      const res = await issue(); expect(res.status).toBe(429);
      expect(res.body).toEqual({ error: 'temporarily_unavailable' }); expect(res.headers['retry-after']).toBe('60');
    } finally { f.store.rate = previous; }
  });
  it('rejects duplicates, credentials in body, unknown fields and JSON token requests', async () => {
    for (const body of [form + '&scope=integration%3Acatalog%3Aread', form + '&client_secret=unsafe', form + '&refresh_token=unsafe']) {
      expect((await send('/integration/oauth/token', body, { Authorization: basic(made.client.id, made.clientSecret) })).status).toBe(400);
    }
    expect((await send('/integration/oauth/token', '{}', { 'Content-Type': 'application/json' })).status).toBe(400);
  });
  it('requires a resource mTLS peer for introspection and returns only freshly reloaded grants', async () => {
    const token = (await issue()).body.access_token, headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const body = JSON.stringify({ requiredScopes: ['integration:documents:read'] });
    expect((await send('/internal/integration/introspect', body, headers)).status).toBe(403);
    const response = await send('/internal/integration/introspect', body, headers, 'resource');
    expect(response.status).toBe(200); expect(response.body.clientId).toBe(made.client.id); expect(response.body.environment).toBe('BETA');
    expect(response.body).not.toHaveProperty('secretHash');
    expect((await send('/internal/integration/introspect', body, { ...headers, Authorization: 'Bearer human-fixture' }, 'resource')).status).toBe(401);
  });
  it('JWKS is internal; token client cannot reach it; key contains no private material', async () => {
    expect((await send('/internal/integration/jwks')).status).toBe(403);
    const res = await send('/internal/integration/jwks', undefined, {}, 'resource');
    expect(res.status).toBe(200); expect(res.body.keys[0]).not.toHaveProperty('d');
  });
  it('admin routes require both dedicated mTLS peer and human admin authority', async () => {
    expect((await send('/internal/integration/clients', undefined, { Authorization: 'Bearer human-fixture' })).status).toBe(403);
    expect((await send('/internal/integration/clients', undefined, { Authorization: 'Bearer fake-human' }, 'admin')).status).toBe(403);
    const res = await send('/internal/integration/clients', undefined, { Authorization: 'Bearer human-fixture' }, 'admin');
    expect(res.status).toBe(200); expect(JSON.stringify(res.body)).not.toContain(made.clientSecret);
  });
  it('administrative disable revokes a previously issued token on the next HTTP check', async () => {
    const token = (await issue()).body.access_token;
    const change = await send('/internal/integration/clients/' + made.client.id, JSON.stringify({ expectedRevision: 1, enabled: false }),
      { Authorization: 'Bearer human-fixture', 'Content-Type': 'application/json' }, 'admin', true, 'PATCH');
    expect(change.status).toBe(200);
    const result = await send('/internal/integration/introspect', '{"requiredScopes":[]}',
      { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, 'resource');
    expect(result.status).toBe(401); expect(result.headers['www-authenticate']).toBe('Bearer');
  });
  it('does not expose business documents, fiscal credentials or emission commands', async () => {
    for (const path of ['/api/v1/auth/login', '/api/v1/documents', '/integration/v1/documents', '/api/v1/sunat/configuration'])
      expect((await send(path, undefined, {}, 'resource')).status).toBe(404);
  });
});
