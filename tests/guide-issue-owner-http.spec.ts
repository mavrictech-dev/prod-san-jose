import 'reflect-metadata';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '../services/billing-service/node_modules/@nestjs/core';
import { BillingGuideIssueModule } from '../services/billing-service/src/b2b/guide-issue-http';
import { BillingGuideHttpErrorFilter } from '../services/billing-service/src/b2b/guide-http';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';
import { guideIssueFixture } from './helpers/guide-issue.fixture';

describe('guide issuance private owner HTTPS', () => {
  let tls: ReturnType<typeof b2bCertificates>, app: any, port: number, f: ReturnType<typeof guideIssueFixture>;
  beforeEach(() => { f = guideIssueFixture(); });
  beforeAll(async () => {
    tls = b2bCertificates();
    const core = { issue: (...args: Parameters<typeof f.core.issue>) => f.core.issue(...args),
      read: (...args: Parameters<typeof f.core.read>) => f.core.read(...args) };
    app = await NestFactory.create(BillingGuideIssueModule.isolated(core, [fingerprint(tls.resource)]), {
      logger: false, bodyParser: false, httpsOptions: { ca: tls.ca, cert: tls.server, key: tls.key,
        requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    });
    app.useBodyParser('json', { limit: '128kb', strict: true }); app.useGlobalFilters(new BillingGuideHttpErrorFilter());
    await app.listen(0, '127.0.0.1'); port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => { await app?.close(); });
  function send(path: string, body: unknown, headers: Record<string, string> = {}, peer: 'resource' | 'other' = 'resource', raw?: string) {
    const bytes = raw ?? JSON.stringify(body);
    return new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method: 'POST', ca: tls.ca, cert: tls[peer], key: tls.key,
        rejectUnauthorized: true, headers: { Authorization: 'Bearer synthetic-issue-token', 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bytes), ...headers } }, response => {
        const chunks: Buffer[] = []; response.on('data', b => chunks.push(b)); response.on('end', () => {
          try { resolve({ status: response.statusCode!, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch (e) { reject(e); }
        });
      }); req.on('error', reject); req.end(bytes);
    });
  }
  const envelope = () => ({ kind: 'SERVICE', request: f.request });
  it('returns only public snapshot, never receipt internals or token', async () => {
    const r = await send('/internal/b2b/issue-guide', envelope()); expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['binding', 'draftId', 'operationId', 'replayed', 'schemaVersion', 'snapshot', 'snapshotSha256']);
    expect(r.body.snapshot.fullNumber).toBe('T001-1'); expect(r.body.snapshot.authorizedForTransfer).toBe(false);
    expect(JSON.stringify(r.body)).not.toMatch(/keySha256|requestSha256|grantRevision|synthetic-issue-token/);
    expect(r.headers['cache-control']).toBe('private, no-store');
    const again = await send('/internal/b2b/issue-guide', envelope()); expect(again.body.operationId).toBe(r.body.operationId);
    expect(again.body.replayed).toBe(true); expect(f.state().next).toBe(2);
  });
  it('recovers operation without an idempotency key or another number', async () => {
    const issued = await send('/internal/b2b/issue-guide', envelope()), before = structuredClone(f.state());
    const r = await send('/internal/b2b/read-guide-issuance', { kind: 'SERVICE', binding: f.binding,
      draftId: f.request.draftId, operationId: issued.body.operationId });
    expect(r.status).toBe(200); expect(r.body.replayed).toBeNull(); expect(r.body.snapshot).toEqual(issued.body.snapshot);
    expect(f.state()).toEqual(before);
  });
  it('rejects a different trusted certificate before looking at business data', async () => {
    const r = await send('/internal/b2b/issue-guide', envelope(), {}, 'other');
    expect(r.status).toBe(403); expect(f.authority.current).not.toHaveBeenCalled();
  });
  it.each([
    ['/internal/b2b/issue-guide?extra=1', () => envelope()],
    ['/internal/b2b/issue-guide', () => ({ ...envelope(), extra: true })],
    ['/internal/b2b/issue-guide', () => ({ kind: 'ADMIN', request: f.request })],
    ['/internal/b2b/read-guide-issuance', () => ({ kind: 'SERVICE', binding: f.binding, draftId: f.request.draftId, operationId: '../other' })],
  ] as const)('rejects malformed private request %#', async (path, value) => {
    const r = await send(path, value()); expect(r.status).toBe(400); expect(f.state().next).toBe(1);
  });
  it('sanitizes a malformed JSON parser error', async () => {
    const r = await send('/internal/b2b/issue-guide', {}, {}, 'resource', '{"secret":');
    expect(r.status).toBe(400); expect(JSON.stringify(r.body)).not.toContain('secret');
  });
  it('requires bearer authentication even on pinned transport', async () => {
    const r = await send('/internal/b2b/issue-guide', envelope(), { Authorization: 'Basic invalid' });
    expect(r.status).toBe(401); expect(f.state().next).toBe(1);
  });
});
