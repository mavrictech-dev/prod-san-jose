import 'reflect-metadata';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '../services/billing-service/node_modules/@nestjs/core';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { BillingBatchOperations, BillingBatchOperationsModule } from '../services/billing-service/src/b2b/batch-member-http';
import type { PostgresBatchMemberOwner } from '../services/billing-service/src/b2b/batch-member-postgres';
import { B2bBatchOperations, B2bBatchOperationsModule, HttpB2bBatchOperationsOwner, validateB2bBatchRequest } from '../services/b2b-api-service/src/batch-operations';
import { B2bPrivateHttp } from '../packages/service-access/src/b2b';
import { buildFiscalNoteSnapshot, fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';
import { fixture, acceptance, actor, asOf, uuid } from './b2b-batch-member-authority.fixture';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';

/** HTTPS adapter/authority unit integration. The storage fixture is explicitly an
 * in-memory transaction port; the separate .integration.ts exercises concrete PG. */
describe('consumer HTTPS → private HTTPS durable batch adapters (synthetic storage port)', () => {
  let tls: ReturnType<typeof b2bCertificates>, app: any, ownerApp: any, port: number, ownerPort: number;
  let f: ReturnType<typeof fixture>, core: BillingBatchOperations, wire: B2bPrivateHttp;
  let scopes: string[], denied: boolean, wrongPoint: boolean, time: string;
  const authenticate = vi.fn(async (_token: string, required: string[], kind: 'SERVICE' | 'USER') => {
    if (denied || required.some(s => !scopes.includes(s))) throw new B2bSecurityError(403, 'SCOPE_DENIED');
    const bindings = [...new Map([...f.rows.values()].filter(r => ['01', '03'].includes(r.binding.documentType)).map(r => {
      const b = r.binding;
      const v = { issuerId: b.companyId, issuerRuc: b.issuerRuc, environment: 'BETA', branchId: b.branchId,
        pointId: wrongPoint ? uuid(88000) : b.pointId, seriesId: b.seriesId, documentType: b.documentType };
      return [JSON.stringify(v), v];
    })).values()];
    return { kind, clientId: actor.clientId, revision: 1, subjectId: kind === 'USER' ? uuid(6000) : null,
      userAuthRevision: kind === 'USER' ? 1 : null, scopes, bindings, environment: 'BETA' } as any;
  });
  const reserve = vi.fn(), persist = vi.fn();
  function setup(kind: 'RC' | 'RA' = 'RC', condition: '1' | '2' | '3' = '1') {
    f = fixture(kind, 2);
    if (condition !== '1') {
      const v = f.previous(0, condition);
      v.current.snapshot = JSON.parse(JSON.stringify(v.current.snapshot));
      v.current.member.snapshotSha256 = fiscalSnapshotSha256(v.current.snapshot);
      v.current.notDelivered!.snapshotSha256 = v.current.member.snapshotSha256;
    }
    const original = f.transaction.getMockImplementation()!;
    f.transaction.mockImplementation((plan, work) => original(plan, async tx => {
      const old = tx.reserveIdentity;
      tx.reserveIdentity = async p => { reserve(); return old(p); };
      Object.assign(tx.owner, { persist: async (prepared: any) => {
        persist(); tx.owner.write('dedicated-local-outbox');
        const command = prepared.command, batch = command.payload.envelope.batch;
        return { batchId: batch.documentId, eventId: command.eventId, identifier: batch.identifier,
          state: 'PREPARED', localOnly: true, fiscalExecutionEnabled: false, officialAcceptance: false };
      } });
      return work(tx as any);
    }));
    Object.assign(f.owner, { loadArtifactRequest: async (scope: any, subject: any) => {
      const journal = [...f.journals.values()].find(j => j.command.payload.operationId === scope.batchId);
      const { batchId: _batchId, ...tuple } = scope;
      return journal && fiscalSnapshotSha256(journal.subject) === fiscalSnapshotSha256(subject) &&
        fiscalSnapshotSha256(journal.scope) === fiscalSnapshotSha256(tuple) ? structuredClone(f.request) : null;
    } });
    core = new BillingBatchOperations(f.owner as unknown as PostgresBatchMemberOwner, { authenticate }, () => time);
  }
  const body = () => { const { asOf: _asOf, ...value } = structuredClone(f.request); return value; };
  beforeEach(() => {
    scopes = ['b2b:batches:write', 'b2b:batches:read']; denied = false; wrongPoint = false; time = asOf;
    authenticate.mockClear(); reserve.mockClear(); persist.mockClear(); setup();
  });
  beforeAll(async () => {
    tls = b2bCertificates();
    const httpsOptions = { ca: tls.ca, cert: tls.server, key: tls.key, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const };
    const delegate = { execute: (...args: Parameters<BillingBatchOperations['execute']>) => core.execute(...args),
      artifactOwnerById: (...args: Parameters<BillingBatchOperations['artifactOwnerById']>) => core.artifactOwnerById(...args) };
    ownerApp = await NestFactory.create(BillingBatchOperationsModule.isolated(delegate as BillingBatchOperations, [fingerprint(tls.resource)]), {
      logger: false, bodyParser: false, httpsOptions });
    ownerApp.useBodyParser('json', { limit: 32768, strict: true }); await ownerApp.listen(0, '127.0.0.1');
    ownerPort = (ownerApp.getHttpServer().address() as AddressInfo).port;
    wire = new B2bPrivateHttp(`https://127.0.0.1:${ownerPort}`, { ca: tls.ca, cert: tls.resource, key: tls.key });
    const facade = new B2bBatchOperations({ authenticate }, new HttpB2bBatchOperationsOwner(wire));
    app = await NestFactory.create(B2bBatchOperationsModule.isolated(facade, [fingerprint(tls.edge)]), { logger: false, bodyParser: false, httpsOptions });
    app.useBodyParser('json', { limit: 32768, strict: true }); await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  }, 30000);
  afterAll(async () => { await app?.close(); await ownerApp?.close(); });
  async function send(path: string, value: unknown, peer: 'edge' | 'other' | 'resource' = 'edge', kind = 'SERVICE', destination = port) {
    const bytes = Buffer.from(JSON.stringify(value));
    return new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
      const req = httpsRequest({ hostname: '127.0.0.1', port: destination, path, method: 'POST', ca: tls.ca, cert: tls[peer], key: tls.key,
        rejectUnauthorized: true, headers: { Authorization: 'Bearer synthetic-batch-access', 'X-FactuEz-Actor-Kind': kind,
          'Content-Type': 'application/json', 'Content-Length': String(bytes.length) } }, res => {
        const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode!,
          headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); req.on('error', reject); req.end(bytes);
    });
  }
  const prepare = (value = body(), kind = 'SERVICE') => send('/b2b/v1/batches/prepare', value, 'edge', kind);
  const recover = (value = body(), kind = 'SERVICE') => send('/b2b/v1/batches/recover', value, 'edge', kind);
  const artifact = (permission: 'READ' | 'WRITE' = 'READ') => send('/internal/b2b/batch-operations', {
    kind: 'SERVICE', action: 'ARTIFACT_OWNER', permission, scope: { ...f.request.scope,
      batchId: [...f.journals.values()][0]?.command.payload.operationId ?? uuid(99999) },
  }, 'resource', 'SERVICE', ownerPort);

  it.each(['RC1', 'RC2', 'RC3', 'RA'])('%s prepares real core command once and recovers read-only', async variant => {
    setup(variant === 'RA' ? 'RA' : 'RC', variant === 'RC2' ? '2' : variant === 'RC3' ? '3' : '1');
    const first = await prepare(); expect(first.status).toBe(200); expect(first.body.replayed).toBe(false);
    expect(first.body).toMatchObject({ candidateOnly: true, localOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false, officialAcceptance: false });
    expect(JSON.stringify(first.body)).not.toMatch(/snapshot|acceptance|subjectId|PRIVATE|synthetic-batch-access|envelope|issuer.*legalName/);
    expect(f.journals.size).toBe(1); expect(reserve).toHaveBeenCalledTimes(1); expect(persist).toHaveBeenCalledTimes(1);
    scopes = ['b2b:batches:read'];
    const second = await recover(); expect(second.status).toBe(200);
    expect(second.body).toEqual({ ...first.body, replayed: true });
    expect(reserve).toHaveBeenCalledTimes(1); expect(persist).toHaveBeenCalledTimes(1);
    expect(second.headers['cache-control']).toBe('private, no-store');
  });
  it('does not create, reserve or produce when recovery has no journal', async () => {
    expect((await recover()).status).toBe(404); expect(reserve).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  });
  it('duplicate prepare requires explicit recovery, never a second callback', async () => {
    expect((await prepare()).status).toBe(200); expect((await prepare()).status).toBe(409);
    expect(reserve).toHaveBeenCalledTimes(1); expect(persist).toHaveBeenCalledTimes(1); expect((await recover()).status).toBe(200);
  });
  it('preserves USER subject and true SERVICE null subject', async () => {
    expect((await prepare(body(), 'USER')).status).toBe(200);
    expect([...f.journals.values()][0].subject).toEqual({ kind: 'USER', clientId: actor.clientId, subjectId: uuid(6000) });
    expect((await recover()).status).not.toBe(200);
  });
  it('rejects revoked member and foreign full binding even with broad scope', async () => {
    await prepare(); f.deny(f.roots[1].member);
    expect((await recover()).status).toBe(403);
    setup(); wrongPoint = true; expect((await prepare()).status).toBe(404); expect(persist).toHaveBeenCalledTimes(1);
  });
  it('revalidates historical previous version, not merely the newest member', async () => {
    setup('RC', '2'); await prepare();
    const old = (f.request as any).entries[0].previous; f.deny(old);
    expect((await recover()).status).toBe(403); expect(reserve).toHaveBeenCalledTimes(1);
  });
  it.each(['original', 'credit-history'])('READ and ARTIFACT_OWNER reauthorize a note %s dependency', async dependency => {
    const originalSnapshot = structuredClone(f.roots[0].snapshot);
    Object.assign(originalSnapshot, { documentId: uuid(90000), number: '90000', fullNumber: `${originalSnapshot.series}-90000` });
    const proof = acceptance(originalSnapshot); proof.acceptedAt = '2026-10-02T16:10:00Z';
    const original = f.add(originalSnapshot, 1, { reporting: 'REPORTED', acceptance: proof });
    const note = (number: number, history: any[]) => {
      const snapshot = buildFiscalNoteSnapshot({ original: original.snapshot as any, acceptance: proof, asOf,
        creditHistory: { complete: true, entries: history.map(h => ({ state: 'RESERVED', note: h.snapshot })) } },
      { documentTypeCode: '07', reasonCode: '07', reasonDescription: 'DEVOLUCION FICTICIA', lines: [{ originalLineNumber: 1, quantity: '0.25' }] },
      { documentId: uuid(number), series: 'BC01', number: String(number), issueDate: '2026-10-02T17:00:00Z' });
      return f.add(JSON.parse(JSON.stringify(snapshot)), 1, { note: { original: original.member, historyRevision: 1,
        creditHistory: history.map(h => ({ state: 'RESERVED', member: h.member })) } });
    };
    const prior = note(90001, []), root = note(90002, [prior]);
    (f.request as any).entries = [{ member: root.member, conditionCode: '1' }];
    expect((await prepare()).status).toBe(200);
    f.deny(dependency === 'original' ? original.member : prior.member);
    expect((await recover()).status).toBe(403); expect((await artifact()).status).toBe(403);
    expect(reserve).toHaveBeenCalledTimes(1); expect(persist).toHaveBeenCalledTimes(1);
  });
  it('recovers a lost commit reply without another producer callback or counter allocation', async () => {
    f.loseReply(); expect((await prepare()).status).toBe(503);
    expect(f.journals.size).toBe(1);
    expect((await recover()).status).toBe(200); expect(reserve).toHaveBeenCalledTimes(1); expect(persist).toHaveBeenCalledTimes(1);
  });
  it('READ cannot be promoted to preparation, scope alone cannot supply owner grant', async () => {
    scopes = ['b2b:batches:read']; expect((await prepare()).status).toBe(403);
    expect(reserve).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  });
  it.each(['actor', 'snapshot', 'accepted', 'asOf', 'command', 'extraScope'])('rejects injected %s before owner work', async name => {
    const v: any = body(); if (name === 'extraScope') v.scope.pointId = uuid(1); else v[name] = name === 'asOf' ? time : {};
    expect((await prepare(v)).status).toBe(400); expect(f.member).not.toHaveBeenCalled();
  });
  it('rejects wrong mTLS peer before Identity, including the private route', async () => {
    expect((await send('/b2b/v1/batches/prepare', body(), 'other')).status).toBe(403);
    expect((await send('/internal/b2b/batch-operations', { kind: 'SERVICE', action: 'PREPARE', request: body() }, 'other', 'SERVICE', ownerPort)).status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });
  it('private envelope never admits actor, commands, unknown actions or query aliases', async () => {
    for (const value of [
      { kind: 'SERVICE', action: 'PREPARE', request: body(), actor },
      { kind: 'SERVICE', action: 'SIGN', request: body() },
      { kind: 'SERVICE', action: 'ARTIFACT_OWNER', request: body(), permission: 'ADMIN' },
      { kind: 'SERVICE', action: 'ARTIFACT_OWNER', request: body(), permission: 'READ' },
    ]) expect((await send('/internal/b2b/batch-operations', value, 'resource', 'SERVICE', ownerPort)).status).toBe(400);
    expect((await send('/b2b/v1/batches/prepare?accepted=true', body())).status).toBe(400);
    expect(reserve).not.toHaveBeenCalled();
  });
  it('private artifact command and authority digest stay stable as clock advances; READ/WRITE remain distinct', async () => {
    await prepare(); const first = await artifact(); expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ schemaVersion: 'factuez.b2b.batch-artifact-owner.v1', permission: 'READ', subject: actor,
      scope: f.request.scope, candidateOnly: true, localOnly: true, fiscalExecutionEnabled: false,
      transmissionAuthorized: false, officialAcceptance: false });
    expect(first.body.commandSha256).toBe(fiscalSnapshotSha256(first.body.command));
    expect(first.body.requestSha256).toBe(fiscalSnapshotSha256({ ...f.request, asOf: null, subject: actor }));
    expect(first.body.command).toEqual([...f.journals.values()][0].command);
    time = '2026-10-03T18:00:05Z'; f.setTime(time);
    const second = await artifact(); expect(second.status).toBe(200);
    expect(second.body.authorizationSha256).toBe(first.body.authorizationSha256);
    expect(second.body.commandSha256).toBe(first.body.commandSha256); expect(second.body.command).toEqual(first.body.command);
    expect(second.body.checkedAt).not.toBe(first.body.checkedAt);
    expect({ ...second.body, checkedAt: first.body.checkedAt }).toEqual(first.body);
    const write = await artifact('WRITE'); expect(write.status).toBe(200);
    expect(write.body.authorizationSha256).not.toBe(second.body.authorizationSha256);
    scopes = ['b2b:batches:read']; expect((await artifact('WRITE')).status).toBe(403);
    expect(reserve).toHaveBeenCalledTimes(1); expect(persist).toHaveBeenCalledTimes(1);
  });
  it('rejects changed journal commands and changed request selectors on recovery', async () => {
    await prepare(); const v = body(); v.idempotencyKey = 'synthetic-missing-key-0001';
    expect((await recover(v)).status).toBe(404);
    const journal = [...f.journals.values()][0]; journal.commandSha256 = 'f'.repeat(64);
    expect((await recover()).status).toBe(409);
  });
  it('strict request validator rejects getters without invoking them', () => {
    const getter = vi.fn(); const value = Object.defineProperty({}, 'scope', { enumerable: true, get: getter });
    expect(() => validateB2bBatchRequest(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
});
