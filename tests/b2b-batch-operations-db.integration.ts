import 'reflect-metadata';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { NestFactory } from '../services/billing-service/node_modules/@nestjs/core';
import { BillingBatchOperationsModule, createBillingBatchOperations } from '../services/billing-service/src/b2b/batch-member-http';
import { B2bBatchOperations, B2bBatchOperationsModule, HttpB2bBatchOperationsOwner } from '../services/b2b-api-service/src/batch-operations';
import { B2bPrivateHttp } from '../packages/service-access/src/b2b';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { fiscalSnapshotSha256 as hash } from '../packages/sunat-core/src/fiscal-note';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { supplementCommandFixture } from './helpers/fiscal-supplement.fixture';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';
const require = createRequire(import.meta.url);
const { withCorrectionDatabase } = require('./helpers/correction-reservation-db.cjs');
if (process.env.FACTUEZ_BATCH_OPERATIONS_DB !== 'NEW_NETWORK_NONE_TMPFS_ONLY') throw new Error('EXPLICIT_NEW_DATABASE_RUNNER_REQUIRED');

/** Real PostgreSQL + both real HTTPS adapters + real fiscal core + durable producer.
 * Admission verification is an EXPLICIT synthetic double, not a PKI assertion. The
 * separate phase7 crypto integration tests the cryptographic admission adapter. */
describe('durable batch HTTP concrete owner in a NEW isolated PostgreSQL', () => {
  it('RC1/RC2/RC3/RA persist once; READ recovery and private artifact fences never allocate', async () => {
    await withCorrectionDatabase(async ({ pool }: any) => {
      await pool.query(readFileSync(new URL('../services/billing-service/b2b-batch-member-schema.candidate.sql', import.meta.url), 'utf8'));
      const material = new Map<string, any>(), bindings: any[] = [], tls = b2bCertificates();
      const subject = { kind: 'SERVICE' as const, clientId: randomUUID(), subjectId: null };
      let time = '2026-10-03T18:00:00Z', allowed = true, readOnly = false;
      const identity = { authenticate: async (_token: string, scopes: string[], kind: 'SERVICE' | 'USER') => {
        if (!allowed || kind !== 'SERVICE' || readOnly && scopes.includes('b2b:batches:write')) throw new B2bSecurityError(403, 'DENIED');
        return { ...subject, revision: 1, userAuthRevision: null, environment: 'BETA', scopes: readOnly ? ['b2b:batches:read'] : ['b2b:batches:read', 'b2b:batches:write'],
          bindings: [...new Map(bindings.map(b => [JSON.stringify(b), b])).values()] } as any;
      } };
      const memberIdentity = { current: async (who: any) => {
        if (!allowed) throw new Error('SYNTHETIC_DENIED');
        return { subject: who, clientRevision: 1, userAuthRevision: null, checkedAt: time };
      } };
      const { owner, operations } = createBillingBatchOperations({ pool, identity, memberIdentity, now: () => time,
        evidence: { verifySignedVersion: async handle => {
          if (!material.has(handle)) throw new Error('OPAQUE_SYNTHETIC_ONLY'); return structuredClone(material.get(handle));
        } }, policyAdmin: { authorizeStepUp: async (handle, policySha256) => {
          if (handle !== 'synthetic-owner-step-up') throw new Error('DENIED');
          return { adminId: '00000000-0000-4000-8000-000000000999', authRevision: 1, policySha256, checkedAt: time };
        } } });
      const httpsOptions = { ca: tls.ca, cert: tls.server, key: tls.key, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const };
      let internal: any, edge: any;
      try {
        internal = await NestFactory.create(BillingBatchOperationsModule.isolated(operations, [fingerprint(tls.resource)]), { logger: false, bodyParser: false, httpsOptions });
        internal.useBodyParser('json', { limit: 32768, strict: true }); await internal.listen(0, '127.0.0.1');
        const internalPort = (internal.getHttpServer().address() as AddressInfo).port;
        const wire = new B2bPrivateHttp(`https://127.0.0.1:${internalPort}`, { ca: tls.ca, cert: tls.resource, key: tls.key });
        edge = await NestFactory.create(B2bBatchOperationsModule.isolated(new B2bBatchOperations(identity, new HttpB2bBatchOperationsOwner(wire)), [fingerprint(tls.edge)]), { logger: false, bodyParser: false, httpsOptions });
        edge.useBodyParser('json', { limit: 32768, strict: true }); await edge.listen(0, '127.0.0.1');
        const port = (edge.getHttpServer().address() as AddressInfo).port;
        const send = (action: 'prepare' | 'recover', body: any) => new Promise<{ status: number; body: any }>((resolve, reject) => {
          const bytes = Buffer.from(JSON.stringify(body));
          const req = httpsRequest({ hostname: '127.0.0.1', port, path: `/b2b/v1/batches/${action}`, method: 'POST',
            ca: tls.ca, cert: tls.edge, key: tls.key, rejectUnauthorized: true,
            headers: { Authorization: 'Bearer synthetic-batch-access', 'X-FactuEz-Actor-Kind': 'SERVICE', 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) } }, res => {
            const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
          }); req.on('error', reject); req.end(bytes);
        });
        const counts = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM b2b_batch_member_reservation) reservations,
          (SELECT count(*)::int FROM b2b_batch_member_command) commands, (SELECT count(*)::int FROM b2b_batch_member_local_outbox) outbox,
          (SELECT coalesce(sum(last_number),0)::int FROM b2b_batch_member_counter) numbers`)).rows[0];
        let number = 10;
        async function admission(snapshot: any, acceptance: any, tuple: any) {
          const ownerHandle = `synthetic-only:${randomUUID()}`;
          material.set(ownerHandle, { snapshot, binding: tuple, acceptance, original: null,
            notDelivered: { status: 'NOT_DELIVERED', documentId: snapshot.documentId, documentTypeCode: snapshot.documentTypeCode, fullNumber: snapshot.fullNumber,
              issuerRuc: tuple.issuerRuc, snapshotSha256: hash(snapshot), evidenceId: randomUUID(), assertedAt: '2026-10-03T16:00:00Z' },
            provenance: { verifierId: 'SYNTHETIC-DOUBLE-NOT-PKI', artifactId: ownerHandle, verifiedAt: time,
              signedXmlSha256: 'a'.repeat(64), cdrSha256: acceptance?.cdrSha256 ?? null, catalogueSha256: hash([]) } });
          return owner.importVerifiedVersion(ownerHandle);
        }
        for (const variant of ['RC1', 'RC2', 'RC3', 'RA']) {
          const kind = variant === 'RA' ? 'RA' : 'RC', f = supplementCommandFixture(kind), snapshot = structuredClone(f.doc);
          snapshot.documentId = randomUUID(); snapshot.number = String(++number); snapshot.fullNumber = `${snapshot.series}-${number}`;
          const tuple = { environment: 'BETA' as const, issuerRuc: snapshot.issuer.identityNumber, companyId: snapshot.companyId!, branchId: snapshot.branchId!,
            pointId: randomUUID(), seriesId: randomUUID(), series: snapshot.series, documentType: snapshot.documentTypeCode };
          bindings.push({ issuerId: tuple.companyId, issuerRuc: tuple.issuerRuc, environment: 'BETA', branchId: tuple.branchId,
            pointId: tuple.pointId, seriesId: tuple.seriesId, documentType: tuple.documentType });
          const proof = { ...f.acceptance, documentId: snapshot.documentId, fullNumber: snapshot.fullNumber, snapshotSha256: hash(snapshot) };
          const original = await admission(snapshot, variant === 'RC1' ? null : proof, tuple);
          let current = original;
          if (variant === 'RC2') {
            const corrected = JSON.parse(JSON.stringify({ ...snapshot, ...calculateDocumentTotals([{ productCode: 'QA', description: 'BIEN CORREGIDO FICTICIO', unitCode: 'NIU', quantity: '2',
              unitPriceWithTax: '59', taxAffectationCode: '10', igvRate: '18' }]) }));
            current = await admission(corrected, null, tuple);
          }
          // The resolver reads the actual stored immutable version; a missing
          // snapshot cannot fall back to the document's latest version.
          expect(await owner.resolve(current.documentId, current.snapshotSha256)).toEqual(current);
          expect(await owner.resolve(current.documentId, 'f'.repeat(64))).toBeNull();
          for (const permission of ['READ', 'WRITE'] as const) await owner.setLocalGrant('synthetic-owner-step-up', {
            subject, binding: tuple, kind, permission, clientRevision: 1, userAuthRevision: null, active: true, expectedRevision: 0,
          });
          const scope = { environment: 'BETA', issuerRuc: tuple.issuerRuc, companyId: tuple.companyId, branchId: tuple.branchId };
          const body: any = { schemaVersion: 'factuez.b2b.batch-members.v1', kind, scope, idempotencyKey: `synthetic-batch-${randomUUID()}`,
            issueDate: '2026-10-03', referenceDate: '2026-10-02', entries: kind === 'RA' ? [{ member: current, reasonDescription: 'SUSTENTO FICTICIO' }]
              : [{ member: current, conditionCode: variant.slice(-1), ...(variant === 'RC1' ? {} : { previous: original }) }] };
          const before = await counts(), first = await send('prepare', body);
          expect(first.status, `${variant} ${JSON.stringify(first.body)}`).toBe(200);
          const after = await counts();
          expect(after).toEqual(Object.fromEntries(Object.entries(before).map(([k, v]) => [k, Number(v) + 1])));
          expect((await send('prepare', body)).status).toBe(409); expect(await counts()).toEqual(after);
          readOnly = true;
          const recovered = await send('recover', body); expect(recovered.status).toBe(200);
          expect(recovered.body).toEqual({ ...first.body, replayed: true }); expect(await counts()).toEqual(after);
          const artifactScope = { ...scope, batchId: first.body.operationId };
          const privateFirst: any = await wire.post('/internal/b2b/batch-operations', { kind: 'SERVICE', action: 'ARTIFACT_OWNER', permission: 'READ', scope: artifactScope }, 'synthetic-batch-access');
          expect(privateFirst).toMatchObject({ schemaVersion: 'factuez.b2b.batch-artifact-owner.v1', permission: 'READ', subject, scope,
            operationId: artifactScope.batchId, candidateOnly: true, localOnly: true, fiscalExecutionEnabled: false,
            transmissionAuthorized: false, officialAcceptance: false });
          expect(privateFirst.commandSha256).toBe(hash(privateFirst.command));
          time = new Date(Date.parse(time) + 1000).toISOString();
          const privateSecond: any = await wire.post('/internal/b2b/batch-operations', { kind: 'SERVICE', action: 'ARTIFACT_OWNER', permission: 'READ', scope: artifactScope }, 'synthetic-batch-access');
          expect(privateSecond.command).toEqual(privateFirst.command); expect(privateSecond.authorizationSha256).toBe(privateFirst.authorizationSha256);
          expect({ ...privateSecond, checkedAt: privateFirst.checkedAt }).toEqual(privateFirst);
          expect(await counts()).toEqual(after);
          expect(await owner.loadArtifactRequest({ ...artifactScope, batchId: randomUUID() }, subject)).toBeNull();
          expect(await owner.loadArtifactRequest(artifactScope as any, { ...subject, clientId: randomUUID() })).toBeNull();
          expect(await owner.loadArtifactRequest({ ...artifactScope, branchId: randomUUID() }, subject)).toBeNull();
          await owner.setLocalGrant('synthetic-owner-step-up', { subject, binding: tuple, kind, permission: 'READ', clientRevision: 1,
            userAuthRevision: null, active: false, expectedRevision: 1 });
          expect((await send('recover', body)).status).toBe(403); expect(await counts()).toEqual(after);
          await expect(wire.post('/internal/b2b/batch-operations', { kind: 'SERVICE', action: 'ARTIFACT_OWNER', permission: 'READ', scope: artifactScope }, 'synthetic-batch-access')).rejects.toThrow();
          readOnly = false;
          if (variant === 'RC1') {
            // One immutable snapshot can have both a signed and an accepted
            // admission. The hash alone must never pick one of those states.
            const acceptedVersion = await admission(snapshot, proof, tuple);
            expect(acceptedVersion.version).toBe(original.version + 1);
            await expect(owner.resolve(snapshot.documentId, hash(snapshot))).rejects.toMatchObject({code: 'BATCH_MEMBER_CHANGED'});
          }
        }
        const rows = (await pool.query('SELECT subject,command,request,request_sha256 FROM b2b_batch_member_command')).rows;
        expect(rows).toHaveLength(4); expect(rows.every((r: any) => r.subject.kind === 'SERVICE' && r.subject.subjectId === null)).toBe(true);
        expect(rows.every((r: any) => r.request_sha256 === hash({ ...r.request, asOf: null, subject: r.subject }))).toBe(true);
        expect((await pool.query('SELECT count(*)::int n FROM "OutboxEvent"')).rows[0].n).toBe(0);
        allowed = false;
      } finally { await edge?.close(); await internal?.close(); }
    });
  }, 120000);
});
