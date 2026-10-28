import 'reflect-metadata';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '../services/identity-service/node_modules/@nestjs/core';
import { B2bGuideIssueAuthorityModule } from '../services/identity-service/src/b2b/guide-issue-http';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';
import { guideIssueFixture, issuePair } from './b2b-guide-issue-authority.fixture';

describe('isolated guide issue authority mTLS HTTP routes', () => {
  let f: Awaited<ReturnType<typeof guideIssueFixture>>, app: any, port: number, tls: ReturnType<typeof b2bCertificates>;
  const body = () => ({ kind: 'SERVICE', action: 'ISSUE', binding: issuePair() });
  beforeAll(async () => {
    f = await guideIssueFixture(); tls = b2bCertificates();
    app = await NestFactory.create(B2bGuideIssueAuthorityModule.isolated(f.core, { admin: [fingerprint(tls.edge)], owner: [fingerprint(tls.resource)] }),
      { logger: false, httpsOptions: { ca: tls.ca, cert: tls.server, key: tls.key, requestCert: true, rejectUnauthorized: true } });
    await app.listen(0, '127.0.0.1'); port = (app.getHttpServer().address() as AddressInfo).port;
  }, 30000);
  afterAll(async () => { await app?.close(); });
  async function send(path: string, value: unknown = body(), peer: 'edge' | 'resource' | 'other' | null = 'resource', token = f.token, method = 'POST') {
    const bytes = value === undefined ? undefined : JSON.stringify(value);
    return new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method, ca: tls.ca, rejectUnauthorized: true, timeout: 5000,
        ...(peer ? { cert: tls[peer], key: tls.key } : {}), headers: { Authorization: 'Bearer ' + token,
          'X-User-Role': 'ADMIN', 'X-Forwarded-Client-Cert': fingerprint(tls.edge),
          ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) } : {}) } }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => { try { resolve({ status: res.statusCode!, headers: res.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null }); } catch (error) { reject(error); } });
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('SYNTHETIC_TIMEOUT'))); req.end(bytes);
    });
  }
  it('separates owner/admin TLS peers, requires trusted client TLS, and ignores forwarded roles', async () => {
    await expect(send('/internal/b2b/authorize-guide-issue', body(), null)).rejects.toThrow();
    expect((await send('/internal/b2b/authorize-guide-issue', body(), 'other')).status).toBe(403);
    expect((await send('/internal/b2b/authorize-guide-issue', body(), 'edge')).status).toBe(403);
    const path = `/internal/b2b/clients/${f.made.client.id}/guide-issue-grants`;
    expect((await send(path, {}, 'resource', 'human-step-up')).status).toBe(403);
    expect((await send(path, {}, 'edge', f.token)).status).toBe(403);
  });
  it('requires human enrollment, serves private metadata, and authorizes the exact SERVICE binding', async () => {
    expect((await send('/internal/b2b/authorize-guide-issue')).status).toBe(404);
    const path = `/internal/b2b/clients/${f.made.client.id}/guide-issue-grants`;
    const enrollment = { expectedClientRevision: 1, expectedGrantRevision: 0, bindings: [issuePair()] };
    const saved = await send(path, enrollment, 'edge', 'human-step-up');
    expect(saved.status).toBe(200); expect(saved.headers['cache-control']).toBe('private, no-store');
    expect((await send(path, undefined, 'edge', 'human-step-up', 'GET')).body).toMatchObject({ current: true, revision: 1 });
    expect((await send(path, enrollment, 'edge', 'human-step-up')).status).toBe(409);
    const answer = await send('/internal/b2b/authorize-guide-issue');
    expect(answer.status).toBe(200); expect(answer.body).toMatchObject({ capability: 'BETA_GUIDE_ISSUE_LOCAL', actor: { userId: null }, transmissionAuthorized: false });
    expect(Object.keys(answer.body)).toHaveLength(10); expect(JSON.stringify(answer.body)).not.toContain(f.token);
  });
  it('rejects actor injection, wrong whole pair and invalid tokens without resource leakage', async () => {
    expect((await send('/internal/b2b/authorize-guide-issue', { ...body(), actor: { role: 'ADMIN' } })).status).toBe(400);
    const denied = await send('/internal/b2b/authorize-guide-issue', { ...body(), binding: { ...issuePair(), fiscalSeriesId: issuePair().draft.anchor.pointId } });
    expect(denied.status).toBe(404); expect(denied.body.code).toBe('RESOURCE_NOT_FOUND');
    expect((await send('/internal/b2b/authorize-guide-issue', body(), 'resource', 'fake.jwt.token')).status).toBe(401);
  });
  it('supports READ through the same isolated route and publishes no public issuance route', async () => {
    expect((await send('/internal/b2b/authorize-guide-issue', { ...body(), action: 'READ' })).body).toMatchObject({ action: 'READ' });
    expect((await send('/b2b/v1/guides/issue')).status).toBe(404);
  });
  it('module construction rejects overlapping or malicious peer configuration', () => {
    expect(() => B2bGuideIssueAuthorityModule.isolated(f.core, { admin: [fingerprint(tls.edge)], owner: [fingerprint(tls.edge)] })).toThrow();
    expect(() => B2bGuideIssueAuthorityModule.isolated(f.core, { admin: [], owner: [] })).toThrow();
  });
});
