import 'reflect-metadata';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { NestFactory } from '../services/b2b-api-service/node_modules/@nestjs/core';
import { BillingCarrierGuideModule, BillingCarrierGuideHttpErrorFilter } from '../services/billing-service/src/b2b/carrier-guide-http';
import { B2bCarrierGuideModule, B2bCarrierGuideOperations, HttpB2bCarrierGuideOwner } from '../services/b2b-api-service/src/carrier-guide-operations';
import { B2bGuideIssueHttpErrorFilter } from '../services/b2b-api-service/src/guide-issue';
import { B2bPrivateHttp } from '../packages/service-access/src/b2b';
import { B2bSecurityError } from '../packages/contracts/src/b2b-security';
import { createCarrierGuideOwner } from '../services/billing-service/src/b2b/carrier-guide-assembly';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';
const require = createRequire(import.meta.url);
const { withCarrierGuideOwnerFixture } = require('./helpers/carrier-guide-owner-db.cjs');
if (process.env.FACTUEZ_CARRIER_HTTP_OWNED_DB !== 'NEW_NETWORK_NONE_TMPFS_ONLY') throw new Error('EXPLICIT_NEW_DATABASE_RUNNER_REQUIRED');

/** Real immutable owner, SERIALIZABLE transactions, counters and two-hop mTLS.
 * Only reference crypto/Identity are explicit fixture ports. Cryptographic
 * verification + PostgreSQL are covered by the separate phase7 crypto runner.
 * Database is NEW, labelled, network-none/tmpfs, no existing QA connection. */
describe('GT31 HTTP connected to actual CarrierGuideOwner and owned fresh PostgreSQL', () => {
  it('SERVICE/USER ready, numbered issuance, replay, independent read, private artifact reference and revocation', async () => {
    const tls = b2bCertificates();
    await withCarrierGuideOwnerFixture(async (f: any) => {
      await f.ingest();
      let ownerApp: any, app: any;
      // Load the owner in the same module realm as its HTTP adapter. Fixture
      // setup uses compiled CJS; do not make error-class identity in a mixed
      // ESM/CJS test into a reason to duck-type exceptions in production.
      const authority = { current: async (token: string, kind: 'SERVICE' | 'USER', binding: any, action: 'ISSUE' | 'READ') => {
        if (f.control.revoked || !f.control[action === 'ISSUE' ? 'issueAllowed' : 'readAllowed'])
          throw new B2bSecurityError(403, 'SYNTHETIC_AUTHORITY_DENIED');
        return f.authority.current(token, kind, binding, action);
      } };
      const actualOwner = createCarrierGuideOwner({ database: f.client, authority, referenceValidator: f.validator,
        allowedRucs: [f.carrier.ruc], now: () => f.now });
      const httpsOptions = { ca: tls.ca, cert: tls.server, key: tls.key, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const };
      try {
        ownerApp = await NestFactory.create(BillingCarrierGuideModule.isolated(actualOwner, [fingerprint(tls.resource)]),
          { logger: false, bodyParser: false, httpsOptions });
        ownerApp.useBodyParser('json', { strict: true, limit: 128 * 1024 }); ownerApp.useGlobalFilters(new BillingCarrierGuideHttpErrorFilter());
        await ownerApp.listen(0, '127.0.0.1'); const ownerPort = (ownerApp.getHttpServer().address() as AddressInfo).port;
        const http = new B2bPrivateHttp(`https://127.0.0.1:${ownerPort}`, { ca: tls.ca, cert: tls.resource, key: tls.key });
        const remoteOwner = new HttpB2bCarrierGuideOwner(http);
        const identity = { authenticate: async (_token: string, _scopes: any, kind: 'SERVICE' | 'USER') => ({ kind, clientId: f.ids.client,
          revision: f.control.clientRevision, subjectId: kind === 'USER' ? f.ids.subject : null,
          userAuthRevision: kind === 'USER' ? f.control.userAuthRevision : null, environment: 'BETA' as const,
          scopes: ['b2b:documents:read', 'b2b:guides:issue', 'b2b:guides:read', 'b2b:guide-operations:read'], bindings: [f.binding.draft.anchor] }) };
        app = await NestFactory.create(B2bCarrierGuideModule.isolated(new B2bCarrierGuideOperations(identity as any, remoteOwner), [fingerprint(tls.edge)]),
          { logger: false, bodyParser: false, httpsOptions });
        app.useBodyParser('json', { strict: true, limit: 128 * 1024 }); app.useGlobalFilters(new B2bGuideIssueHttpErrorFilter());
        await app.listen(0, '127.0.0.1'); const port = (app.getHttpServer().address() as AddressInfo).port;
        async function send(path: string, kind: 'SERVICE' | 'USER', body?: unknown, headers: Record<string, string> = {}, peer = tls.edge) {
          const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
          return new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
            const req = request({ hostname: '127.0.0.1', port, path, method: bytes ? 'POST' : 'GET',
              ca: tls.ca, cert: peer, key: tls.key, rejectUnauthorized: true, timeout: 30000,
              headers: { Authorization: 'Bearer ' + f.token, 'X-FactuEz-Actor-Kind': kind,
                ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) } : {}), ...headers } }, res => {
              const parts: Buffer[] = []; res.on('data', c => parts.push(c)); res.on('error', reject);
              res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(parts).toString('utf8')), headers: res.headers }); } catch (e) { reject(e); } });
            }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('SYNTHETIC_TIMEOUT'))); req.end(bytes);
          });
        }
        for (const kind of ['SERVICE', 'USER'] as const) {
          const draftId = randomUUID(), base = `/b2b/v1/carrier-guide-drafts/${draftId}`, body = { binding: f.binding, body: f.body };
          const ready = await send(base + '/ready', kind, body); expect(ready.status).toBe(200); expect(ready.headers.etag).toBe('"v1"');
          expect((await send(base + '/ready', kind, body)).body).toEqual(ready.body);
          const key = 'synthetic_carrier_http_db_' + kind + '_0001', h = { 'If-Match': '"v1"', 'Idempotency-Key': key };
          const first = await send(base + '/issuance', kind, { binding: f.binding }, h); expect(first.status).toBe(200);
          expect(first.body.replayed).toBe(false); expect(first.body.snapshot.number).toBe(kind === 'SERVICE' ? '1' : '2');
          const replay = await send(base + '/issuance', kind, { binding: f.binding }, h); expect(replay.status).toBe(200);
          expect(replay.body).toEqual({ ...first.body, replayed: true });
          const q = new URLSearchParams(Object.entries({ ...f.binding.draft.anchor, guideSeriesId: f.binding.draft.guideSeriesId,
            guideType: '31', fiscalSeriesId: f.binding.fiscalSeriesId }).map(([k, v]) => [k, String(v)])).toString();
          const path = base + `/issuances/${first.body.operationId}?` + q;
          const read = await send(path, kind); expect(read.status).toBe(200); expect(read.body).toEqual(first.body);
          expect(JSON.stringify(read.body)).not.toMatch(/authorizationSha256|cdrSha256|privateKey|certificatePem|password|synthetic-carrier-owner-token/);
          const scope = { binding: f.binding, draftId, operationId: first.body.operationId };
          const privateOwned = await remoteOwner.artifactCurrent(scope, { token: f.token, kind }, 'READ');
          expect(Object.keys(privateOwned).sort()).toEqual(['authorizationSha256', 'issuance', 'reference']);
          expect(privateOwned.reference.snapshot.documentType).toBe('09'); expect(privateOwned.issuance).toEqual(first.body);
          f.control.readAllowed = false;
          expect((await send(path, kind)).status).toBe(403);
          await expect(remoteOwner.artifactCurrent(scope, { token: f.token, kind }, 'READ')).rejects.toThrow();
          // READ revocation never silently turns an artifact read into ISSUE.
          expect((await remoteOwner.artifactCurrent(scope, { token: f.token, kind }, 'ISSUE')).issuance).toEqual(first.body);
          f.control.readAllowed = true;
          const authorityCalls = f.control.authorityCalls;
          expect((await send(path, kind, undefined, {}, tls.other)).status).toBe(403);
          expect(f.control.authorityCalls).toBe(authorityCalls);
          f.control.issueAllowed = false;
          expect((await send(`/b2b/v1/carrier-guide-drafts/${randomUUID()}/ready`, kind, body)).status).toBe(403);
          expect((await send(path, kind)).status).toBe(200); f.control.issueAllowed = true;
        }
        expect(await f.state()).toMatchObject({ counter: '3', documents: 2, items: 4, receipts: 2, events: 2, legacy_documents: 0, legacy_events: 0 });
        const persisted = (await f.pool.query('SELECT "payload" FROM "CarrierGuideReceipt"')).rows;
        // SERVICE is not assigned a fabricated human user; the private owner
        // maintains actor provenance without including it in public responses.
        expect(persisted).toHaveLength(2);
        expect(persisted.find((row: any) => row.payload.actor.kind === 'SERVICE').payload.actor.subjectId).toBeNull();
        expect(persisted.find((row: any) => row.payload.actor.kind === 'USER').payload.actor.subjectId).toBe(f.ids.subject);
      } finally { await app?.close(); await ownerApp?.close(); }
    });
  }, 120000);
});
