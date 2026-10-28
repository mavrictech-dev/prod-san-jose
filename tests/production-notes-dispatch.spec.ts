import 'reflect-metadata';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { PRODUCTION_NOTES_PROFILE, PRODUCTION_NOTES_ISSUED, type FiscalDocumentSnapshot, type ProductionNotesIssued } from '../packages/contracts/src';
import { calculateDocumentTotals, buildProductionNotesSnapshot, fiscalSnapshotSha256, signProductionNotesOwner, assertProductionNotesOwner } from '../packages/sunat-core/src';
import { ArtifactStore } from '../services/sunat-service/src/infrastructure/artifact-store';
import { PublicSignerArchive } from '../services/sunat-service/src/infrastructure/crypto/public-signer-archive';
import { inspectCertificate } from '../services/sunat-service/src/infrastructure/crypto/certificate-inspector';
import { prepareBetaXml } from '../services/sunat-service/src/infrastructure/crypto/beta-xml-pipeline';
import { prepareProductionNotesXml } from '../services/sunat-service/src/application/production-notes-crypto';
import { ProductionNotesEvidenceService } from '../services/sunat-service/src/application/production-notes-evidence.service';
import { ProductionNotesPolicyService, PRODUCTION_NOTES_CONFIRMATION } from '../services/sunat-service/src/application/production-notes-policy.service';
import { ProductionNotesDispatchRepository } from '../services/sunat-service/src/application/production-notes-dispatch.repository';
import { ProductionNotesDispatchService } from '../services/sunat-service/src/application/production-notes-dispatch.service';
import { ProductionNotesController } from '../services/sunat-service/src/production-notes.controller';
import { ProductionNotesOwnerRuntime } from '../services/billing-service/src/application/production-notes-runtime.service';
import { createGuideSidecarPki, guideSidecarHash as hash, guideSidecarCdrXml, zipSync } from './helpers/guide-sidecar-ephemeral-pki.fixture';
import * as soapAuthority from '../services/sunat-service/src/infrastructure/sunat/production-soap-authorization';
const RUC = '20100070970', now = new Date(), id = '60000000-0000-4000-8000-000000000001', branchId = '60000000-0000-4000-8000-000000000002';
let pki: ReturnType<typeof createGuideSidecarPki>, directory: string;
beforeAll(() => { pki = createGuideSidecarPki(); }, 30000);
afterAll(() => { for (const p of [pki.issuer, pki.otherIssuer, pki.sunat])
    p.pkcs12.fill(0); });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'factuez-prod-notes-dispatch-')); await writeFile(join(directory, 'owner.key'), randomBytes(32).toString('hex'),{mode:0o600}); vi.stubEnv('PRODUCTION_NOTES_OWNER_KEY_FILE', join(directory, 'owner.key')); vi.stubEnv('SUNAT_PRODUCTION_NOTES_ENABLED', 'true'); vi.stubEnv('SUNAT_PRODUCTION_WORKFLOW_ENABLED', 'true'); vi.stubGlobal('fetch', vi.fn(async () => { throw Error('NETWORK_FORBIDDEN'); })); });
afterEach(async () => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); if (!resolve(directory).startsWith(join(resolve(tmpdir()), 'factuez-prod-notes-dispatch-')))
    throw Error('UNSAFE_CLEANUP'); await rm(directory, { recursive: true, force: true }); });
function original(): FiscalDocumentSnapshot { return { documentId: id, companyId: 1, branchId, documentTypeCode: '01', environment: 'PRODUCTION', series: 'F001', number: '1', fullNumber: 'F001-1', issueDate: new Date(now.getTime() - 7200000).toISOString(), currencyCode: 'PEN', operationTypeCode: '0101', paymentTerms: { type: 'CONTADO' }, issuer: { identityType: '6', identityNumber: RUC, legalName: 'FICTITIOUS ISSUER', address: 'FICTITIOUS ADDRESS', ubigeo: '150101', establishmentCode: '0000' }, customer: { identityType: '6', identityNumber: '20131312955', legalName: 'FICTITIOUS CUSTOMER' }, ...calculateDocumentTotals([{ description: 'FICTITIOUS ITEM', quantity: '2', unitPriceWithTax: '11.80', unitCode: 'NIU', igvRate: '18', taxAffectationCode: '10' }]) }; }
async function fixture(type: '07' | '08' = '07') {
    const metadata = inspectCertificate(pki.issuer.pkcs12, pki.password), o = original(), store = new ArtifactStore(directory), archive = new PublicSignerArchive(directory);
    await archive.archive(RUC, metadata);
    const packed = prepareBetaXml(o, pki.issuer.pkcs12, pki.password), originalArtifacts: any[] = [];
    async function save(owner: string, kind: string, name: string, bytes: Buffer, target = originalArtifacts) { const file = await store.put(owner, name, bytes), artifact = { documentId: owner, kind, mediaType: kind.endsWith('ZIP') ? 'application/zip' : 'application/xml', ...file, sizeBytes: BigInt(file.sizeBytes) }; target.push(artifact); return artifact; }
    const xml = await save(id, 'SIGNED_XML', packed.fileName + '.xml', Buffer.from(packed.document.xml)), zip = await save(id, 'SUBMISSION_ZIP', packed.fileName + '.zip', packed.zip);
    const originalCdr = pki.signCdr(guideSidecarCdrXml({ issuerRuc: RUC, fullNumber: o.fullNumber, documentType: '01' } as any));
    const cdrXml = await save(id, 'CDR_XML', 'R-' + packed.fileName + '.xml', Buffer.from(originalCdr)), cdrZip = await save(id, 'CDR_ZIP', 'R-' + packed.fileName + '.zip', Buffer.from(zipSync({ ['R-' + packed.fileName + '.xml']: Buffer.from(originalCdr) })));
    const originalSubmission = { id: randomUUID(), idempotencyKey: 'production:' + id + ':v1', errorCode: 'DONE', result: 'SUCCESS', completedAt: new Date(), requestArtifactKey: zip.storageKey, responseArtifactKey: cdrZip.storageKey };
    const documents = new Map<string, any>([[id, { documentId: id, issuerRuc: RUC, environment: 'PRODUCTION', documentType: '01', series: o.series, number: BigInt(o.number), immutablePayload: JSON.parse(JSON.stringify(o)), status: 'ACCEPTED', acceptedAt: new Date(now.getTime() - 3600000), digestValue: packed.document.digestValue, artifacts: originalArtifacts, submissions: [originalSubmission] }]]);
    const state = { dispatch: null as any, submission: null as any, statusEvents: [] as any[], grant: { issuerRuc: RUC, enabled: true, version: 1, credentialRevision: 4, fingerprint: metadata.fingerprint, profile: PRODUCTION_NOTES_PROFILE } };
    const credentials = { revision: 4, certificateFingerprint: metadata.fingerprint, certificateCipher: 'EPHEMERAL_TEST', certificatePasswordCipher: 'EPHEMERAL_TEST', certificateSelfSigned: false, certificateExpiresAt: metadata.expiresAt, solUsernameCipher: 'EPHEMERAL_USER', solPasswordCipher: 'EPHEMERAL_PASS' };
    const prisma: any = { sunatCredentials: { findUnique: vi.fn(async () => credentials) }, fiscalDocument: { findUnique: vi.fn(async ({ where }: any) => documents.get(where.documentId)), findUniqueOrThrow: vi.fn(async ({ where }: any) => { const d = documents.get(where.documentId); if (!d)
                throw Error('NOT_FOUND'); return d; }), create: vi.fn(async ({ data }: any) => { documents.set(data.documentId, { ...data, artifacts: [], submissions: [] }); return data; }), update: vi.fn(async ({ where, data }: any) => Object.assign(documents.get(where.documentId), data)) },
        sunatSubmission: { create: vi.fn(async ({ data }: any) => { state.submission = { ...data, id: randomUUID() }; documents.get(data.documentId).submissions.push(state.submission); return state.submission; }), findUniqueOrThrow: vi.fn(async () => state.submission), updateMany: vi.fn(async ({ data }: any) => { Object.assign(state.submission, data); return { count: 1 }; }), update: vi.fn(async ({ data }: any) => Object.assign(state.submission, data)) },
        documentArtifact: { findUnique: vi.fn(async ({ where }: any) => documents.get(where.documentId_kind.documentId)?.artifacts.find((a: any) => a.kind === where.documentId_kind.kind)), upsert: vi.fn(async ({ where, create }: any) => { const docs = documents.get(where.documentId_kind.documentId).artifacts; let found = docs.find((a: any) => a.kind === where.documentId_kind.kind); if (!found) {
                found = { ...create, sizeBytes: BigInt(create.sizeBytes) };
                docs.push(found);
            } return found; }) } };
    prisma.$queryRawUnsafe = vi.fn(async (sql: string, ...args: any[]) => {
        if (sql.startsWith('SELECT * FROM "ProductionNotesGrant"'))
            return [structuredClone(state.grant)];
        if (sql.startsWith('SELECT * FROM "ProductionNotesDispatch"'))
            return state.dispatch ? [structuredClone(state.dispatch)] : [];
        if (sql.startsWith('UPDATE "ProductionNotesDispatch" SET "phase"=\'PREPARING\'')) {
            const d = state.dispatch;
            if (!d || !['AWAITING_AUTHORIZATION', 'PREPARED'].includes(d.phase) || d.lease && d.leaseUntil > new Date())
                return [];
            d.phase = 'PREPARING';
            d.lease = args[1];
            d.leaseUntil = new Date(Date.now() + 90000);
            return [structuredClone(d)];
        }
        if (sql.startsWith('UPDATE "ProductionNotesDispatch" SET "lease"=gen_random_uuid()')) {
            if (state.dispatch?.phase === 'SENDING' && state.dispatch.leaseUntil <= new Date()) {
                state.dispatch.lease = randomUUID();
                state.dispatch.leaseUntil = new Date(Date.now() + 30000);
                return [structuredClone(state.dispatch)];
            }
            return [];
        }
        return [];
    });
    prisma.$executeRawUnsafe = vi.fn(async (sql: string, ...args: any[]) => {
        if (sql.startsWith('INSERT INTO "ProductionNotesDispatch"'))
            state.dispatch = { documentId: args[0], eventId: args[1], payload: JSON.parse(args[2]), snapshotSha256: args[3], phase: 'AWAITING_AUTHORIZATION', lease: null, leaseUntil: null, manifest: null };
        else if (sql.startsWith('UPDATE "ProductionNotesDispatch" SET "manifest"')) {
            state.dispatch.manifest = JSON.parse(args[1]);
            state.dispatch.phase = 'PREPARED';
        }
        else if (sql.startsWith('UPDATE "ProductionNotesDispatch" SET "phase"=\'SENDING\'')) {
            if (state.dispatch.lease !== args[1] || state.dispatch.phase !== 'PREPARED' || state.dispatch.leaseUntil <= new Date())
                return 0;
            state.dispatch.phase = 'SENDING';
        }
        else if (sql.startsWith('UPDATE "ProductionNotesDispatch" SET "phase"=$2')) {
            state.dispatch.phase = args[1];
            state.dispatch.leaseUntil = null;
        }
        else if (sql.startsWith('INSERT INTO "ProductionNotesStatusOutbox"'))
            state.statusEvents.push(JSON.parse(args[2]));
        else if (sql.startsWith('UPDATE "ProductionNotesDispatch" SET "phase"=CASE')) {
            if (['PREPARING', 'PREPARED'].includes(state.dispatch?.phase) && state.dispatch.leaseUntil <= new Date()) {
                state.dispatch.phase = state.dispatch.manifest ? 'PREPARED' : 'AWAITING_AUTHORIZATION';
                state.dispatch.lease = null;
                state.dispatch.leaseUntil = null;
            }
        }
        return 1;
    });
    prisma.$transaction = async (run: any) => run(prisma);
    const inspection = { inspect: vi.fn(async () => metadata) }, trust = { evaluate: vi.fn(async (m: any, _ruc: string, time = new Date()) => ({ profile: 'OFFLINE-PINNED-ROOTS-CRL-v1', chainValid: true, identityMatched: true, revocation: 'VERIFIED_OFFLINE_CRL', certificateFingerprint: m.fingerprint, checkedAt: time.toISOString(), trustStoreSha256: hash(pki.rootPem), blockers: [] })) };
    const evidence = new ProductionNotesEvidenceService(prisma, store, archive, trust as never, pki.cdrVerifier as never);
    const proof = await evidence.original(o), adjustment = type === '07' ? { documentTypeCode: '07', reasonCode: '01', reasonDescription: 'FICTITIOUS ANNULMENT' } : { documentTypeCode: '08', reasonCode: '02', reasonDescription: 'FICTITIOUS INCREASE', lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '1.18' }] };
    const note = buildProductionNotesSnapshot(o, proof, adjustment, { documentId: randomUUID(), series: type === '07' ? 'FC01' : 'FD01', number: '1', issueDate: new Date().toISOString() });
    const configuration = { status: vi.fn(async () => ({ ruc: RUC, revision: 4, certificate: { fingerprint: metadata.fingerprint }, emissionEnvironment: 'PRODUCTION' })) };
    const readiness = { inspect: vi.fn(async () => ({ revision: 4, checks: ['ISSUER_REAL_RUC', 'SECRET_VAULT', 'SOL_SECRETS_LOCAL', 'CERTIFICATE_KEY_PAIR', 'CERTIFICATE_RUC', 'CERTIFICATE_CHAIN', 'CERTIFICATE_REVOCATION', 'XSD_RUNTIME', 'CDR_TRUST'].map(code => ({ code, status: 'PASS' })) })) };
    const policy = new ProductionNotesPolicyService(prisma, configuration as never, readiness as never, evidence);
    const admission = await policy.admit(note, o, []), unsigned: any = { eventId: randomUUID(), eventName: PRODUCTION_NOTES_ISSUED, producer: 'billing-service', occurredAt: note.issueDate, correlationId: randomUUID(), payload: { snapshot: note, original: o, creditHistory: [], ownerRevisionSha256: 'f'.repeat(64), admission } };
    const event: ProductionNotesIssued = { ...unsigned, ownerProof: signProductionNotesOwner(unsigned, 'issued') }, repository = new ProductionNotesDispatchRepository(prisma);
    const opened: Buffer[] = [], vault = { open: vi.fn((_cipher: string, aad: any) => { const b = Buffer.from(aad.field === 'certificate' ? pki.issuer.pkcs12 : Buffer.from(aad.field === 'certificatePassword' ? pki.password : aad.field === 'solUsername' ? 'FICTITIOUS_USER' : 'FICTITIOUS_PASSWORD')); opened.push(b); return b; }) };
    const xsd = { validate: vi.fn(async (xml: string | Buffer) => ({ xmlSha256: hash(xml) })) };
    const dispatch: any = new ProductionNotesDispatchService(repository, policy, evidence, store, vault as never, inspection as never, trust as never, archive, xsd as never);
    dispatch.sign = vi.fn(async (n: any, b: Buffer, p: string) => prepareProductionNotesXml(n, b, p));
    const signed = pki.signCdr(guideSidecarCdrXml({ issuerRuc: RUC, fullNumber: note.fullNumber, documentType: type } as any));
    const noteCdrZip = Buffer.from(zipSync({ ['R-' + RUC + '-' + type + '-' + note.fullNumber + '.xml']: Buffer.from(signed) }));
    const adapter = { submit: vi.fn(async () => ({ kind: 'CDR', cdrZip: noteCdrZip })) }, realAdapter = dispatch.adapter.bind(dispatch);
    dispatch.adapter = vi.fn(async () => adapter);
    return { o, note, event, repository, state, documents, prisma, evidence, dispatch, adapter, realAdapter, store, archive, policy, configuration, readiness, metadata, credentials, trust, opened, xsd, noteCdrZip };
}
describe('Production notes actual ensemble, ephemeral signatures/CDRs and physical archives', () => {
    it.each(['07', '08'] as const)('%s stages a private owner event, signs, submits once and finalizes exact CDR with authenticated status', async (type) => {
        const f = await fixture(type);
        await f.repository.stage(f.event);
        await f.dispatch.process(f.note.documentId);
        expect(f.state.dispatch.phase).toBe('DONE');
        expect(f.state.submission.errorCode).toBe('DONE');
        expect(f.documents.get(f.note.documentId).status).toBe('ACCEPTED');
        expect(f.adapter.submit).toHaveBeenCalledOnce();
        expect(f.documents.get(f.note.documentId).artifacts.map((a: any) => a.kind)).toEqual(['SIGNED_XML', 'SUBMISSION_ZIP', 'CDR_XML', 'CDR_ZIP']);
        const event = f.state.statusEvents[0], { ownerProof, ...unsigned } = event;
        expect(() => assertProductionNotesOwner(unsigned, 'status', ownerProof)).not.toThrow();
        expect(event.payload).toMatchObject({ status: 'ACCEPTED', cdrSignatureVerified: true, snapshotSha256: fiscalSnapshotSha256(f.note), requestXmlSha256: f.state.dispatch.manifest.xml.sha256 });
        expect(f.opened.every(b => b.every(x => x === 0))).toBe(true);
        await f.dispatch.process(f.note.documentId);
        expect(f.adapter.submit).toHaveBeenCalledOnce();
    });
    it('lost sendBill response persists UNKNOWN and a replay never resubmits', async () => { const f = await fixture(); await f.repository.stage(f.event); f.adapter.submit.mockRejectedValueOnce(Error('LOST_RESPONSE')); await f.dispatch.process(f.note.documentId); expect(f.state.dispatch.phase).toBe('UNKNOWN'); await f.dispatch.process(f.note.documentId); expect(f.adapter.submit).toHaveBeenCalledOnce(); expect(f.state.statusEvents[0].payload.cdrSignatureVerified).toBe(false); });
    it('interrupted SENDING recovers UNKNOWN; a stale worker cannot attach CDR or emit another result', async () => { const f = await fixture(); await f.repository.stage(f.event); const row = await f.repository.claim(f.note.documentId); f.state.dispatch.phase = 'SENDING'; f.state.dispatch.leaseUntil = new Date(0); await f.repository.recover(); expect(f.state.dispatch.phase).toBe('UNKNOWN'); await expect(f.repository.finish(row!, 'BLOCKED')).rejects.toThrow('Lease'); await f.dispatch.process(f.note.documentId); expect(f.adapter.submit).not.toHaveBeenCalled(); });
    it('an active PREPARED lease cannot be stolen by a second dispatcher', async () => { const f = await fixture(); await f.repository.stage(f.event); await f.repository.claim(f.note.documentId); f.state.dispatch.phase = 'PREPARED'; expect(await f.repository.claim(f.note.documentId)).toBeUndefined(); });
    it.each(['original-xml', 'original-cdr', 'unsigned-note', 'owner-hmac'])('rejects tampering %s without posting', async (change) => {
        const f = await fixture();
        if (change === 'unsigned-note') {
            f.event.payload.snapshot.totals.payableAmount = '0.01';
            await expect(f.repository.stage(f.event)).rejects.toThrow();
        }
        else if (change === 'owner-hmac') {
            f.event.ownerProof.signature = '0'.repeat(64);
            await expect(f.repository.stage(f.event)).rejects.toThrow('auténtica');
        }
        else {
            await f.repository.stage(f.event);
            const artifact = f.documents.get(id).artifacts.find((a: any) => a.kind === (change === 'original-xml' ? 'SIGNED_XML' : 'CDR_XML'));
            const path = join(directory, artifact.storageKey), bytes = await readFile(path);
            bytes[bytes.length - 1] ^= 1;
            await writeFile(path, bytes);
            await expect(f.dispatch.process(f.note.documentId)).rejects.toThrow();
        }
        expect(f.adapter.submit).not.toHaveBeenCalled();
    });
    it.each(['grant-disabled', 'grant-version', 'credential-revision', 'fingerprint', 'old-profile', 'server-disabled'])('current authority %s blocks preparation and outbound calls', async (change) => { const f = await fixture(); await f.repository.stage(f.event); if (change === 'grant-disabled')
        f.state.grant.enabled = false;
    else if (change === 'grant-version')
        f.state.grant.version++;
    else if (change === 'credential-revision')
        f.credentials.revision++;
    else if (change === 'fingerprint')
        f.state.grant.fingerprint = '0'.repeat(64);
    else if (change === 'old-profile')
        f.state.grant.profile = '01-03-PEN-0101-IGV18-v2';
    else
        vi.stubEnv('SUNAT_PRODUCTION_NOTES_ENABLED', 'false'); await expect(f.dispatch.process(f.note.documentId)).rejects.toThrow(); expect(f.dispatch.sign).not.toHaveBeenCalled(); expect(f.adapter.submit).not.toHaveBeenCalled(); });
    it('invalid CDR trust after a POST requires reconciliation, never marks the note accepted', async () => { const f = await fixture(); await f.repository.stage(f.event); const verify = f.evidence.cdr.bind(f.evidence); vi.spyOn(f.evidence, 'cdr').mockImplementation(async (...args) => { if (args[3] === '01')
        return verify(...args); throw Error('UNTRUSTED_CDR'); }); await f.dispatch.process(f.note.documentId); expect(f.state.dispatch.phase).toBe('UNKNOWN'); expect(f.state.statusEvents[0].payload.status).toBe('UNKNOWN'); await f.dispatch.process(f.note.documentId); expect(f.adapter.submit).toHaveBeenCalledOnce(); });
    it('private production transport grants only sendBill for the exact current note and rechecks revocation', async () => { const f = await fixture(); await f.repository.stage(f.event); const factory = vi.spyOn(soapAuthority, 'createProductionSoapAuthorization'); await f.realAdapter(f.state.dispatch); expect(factory.mock.calls[0][0]).toEqual({ ruc: RUC, operations: ['sendBill'] }); const cap = factory.mock.results[0].value; await expect(soapAuthority.assertProductionSoapAuthorized(cap, RUC, 'sendSummary')).rejects.toThrow(); await expect(soapAuthority.assertProductionSoapAuthorized(cap, RUC, 'sendBill')).resolves.toBeUndefined(); f.state.grant.enabled = false; await expect(soapAuthority.assertProductionSoapAuthorized(cap, RUC, 'sendBill')).rejects.toThrow(); });
    it('original HTTP evidence is cryptographic owner evidence: unaccepted original and changed submission links fail', async () => { const f = await fixture(); f.documents.get(id).status = 'SIGNED'; await expect(f.evidence.original(f.o)).rejects.toThrow('aceptada'); f.documents.get(id).status = 'ACCEPTED'; f.documents.get(id).submissions[0].requestArtifactKey = 'OTHER_PACKAGE'; await expect(f.evidence.original(f.o)).rejects.toThrow('exacto'); });
    it('user/global admission without owner transaction attestation never reaches policy', async () => {
        const f = await fixture(), admit = vi.spyOn(f.policy, 'admit'), controller = new ProductionNotesController(f.policy, f.evidence);
        const body = { snapshot: f.note, original: f.o, creditHistory: [], ownerRevisionSha256: 'a'.repeat(64) };
        await expect(controller.admit('1', body, undefined as any, { headers: { authorization: 'Bearer FICTITIOUS' }, user: { scope: { kind: 'GLOBAL' } } } as any)).rejects.toThrow('atestación');
        expect(admit).not.toHaveBeenCalled();
    });
});
describe('Billing production notes projection uses the private signed evidence envelope', () => {
    it('projects final CDR hashes against its own snapshot, keeps duplicate inbox idempotent and refuses edited progress', async () => {
        const f = await fixture();
        await f.repository.stage(f.event);
        await f.dispatch.process(f.note.documentId);
        const event = f.state.statusEvents[0];
        const own: any = { id: f.note.documentId, originSystem: 'PRODUCTION_NOTES', immutableSnapshot: f.note, sunatStatus: 'QUEUED' };
        const reservation: any = { snapshotSha256: fiscalSnapshotSha256(f.note), state: 'QUEUED', outcome: null };
        const inbox = new Map();
        const tx: any = { document: { findUnique: vi.fn(async () => own), updateMany: vi.fn(async ({ where, data }: any) => { if (where.sunatStatus !== own.sunatStatus)
                    return { count: 0 }; Object.assign(own, data); return { count: 1 }; }) } };
        tx.$queryRawUnsafe = vi.fn(async (sql: string, id: string) => sql.includes('ProductionNotesInbox') ? inbox.has(id) ? [{ payloadSha256: inbox.get(id) }] : [] : [reservation]);
        tx.$executeRawUnsafe = vi.fn(async (sql: string, ...args: any[]) => { if (sql.startsWith('UPDATE "ProductionNotesReservation"')) {
            reservation.state = args[1];
            reservation.outcome = JSON.parse(args[2]);
        }
        else if (sql.startsWith('INSERT INTO "ProductionNotesInbox"'))
            inbox.set(args[0], args[2]); return 1; });
        const changedLive=vi.fn(async()=>{});const runtime = new ProductionNotesOwnerRuntime({ $transaction: async (run: any) => run(tx) } as never,()=>({changed:changedLive,close:async()=>{}}));
        await runtime.project(event);
        expect(own.sunatStatus).toBe('ACCEPTED');
        await runtime.project(event);
        expect(tx.document.updateMany).toHaveBeenCalledOnce();expect(changedLive).toHaveBeenCalledOnce();
        const changed = structuredClone(event);
        changed.payload.status = 'SUBMITTED';
        await expect(runtime.project(changed)).rejects.toThrow('Atestación');
        expect(own.sunatStatus).toBe('ACCEPTED');
        const { ownerProof, ...unsigned } = structuredClone(event);
        unsigned.eventId = randomUUID();
        unsigned.payload.cdrXmlSha256 = undefined;
        const invalid = { ...unsigned, ownerProof: signProductionNotesOwner(unsigned, 'status') };
        await expect(runtime.project(invalid)).rejects.toThrow('incompleta');
        expect(own.sunatStatus).toBe('ACCEPTED');
    });
});
describe('new production-notes grant never borrows 01/03 authority', () => {
    it('requires a new explicit document scope and phrase; a fresh v2 01/03 grant is still insufficient', async () => {
        const f = await fixture(), input = { enabled: true, expectedVersion: 1, expectedRevision: 4, authorizedDocumentTypes: ['07', '08'], confirmation: PRODUCTION_NOTES_CONFIRMATION };
        for (const change of [{ authorizedDocumentTypes: ['01', '03'] }, { authorizedDocumentTypes: ['07'] }, { confirmation: 'ACTIVAR ENVÍOS REALES A SUNAT' }, { expectedVersion: 99 }]) {
            await expect(f.policy.configure('1', { ...input, ...change }, 'Bearer FICTITIOUS', randomUUID())).rejects.toThrow();
        }
        expect(f.prisma.$executeRawUnsafe.mock.calls.some((c: any) => c[0].startsWith('INSERT INTO "ProductionNotesGrant"'))).toBe(false);
    });
    it('explicit enablement writes only a new versioned 07/08 grant and its audit, never touches the old grants', async () => {
        const f = await fixture(), original = f.prisma.$executeRawUnsafe.getMockImplementation();
        f.prisma.$executeRawUnsafe.mockImplementation(async (sql: string, ...args: any[]) => {
            if (sql.startsWith('INSERT INTO "ProductionNotesGrant"'))
                Object.assign(f.state.grant, { enabled: args[2], version: args[3], credentialRevision: args[4], fingerprint: args[5] });
            return original(sql, ...args);
        });
        expect(await f.policy.configure('1', { enabled: true, expectedVersion: 1, expectedRevision: 4, authorizedDocumentTypes: ['07', '08'], confirmation: PRODUCTION_NOTES_CONFIRMATION }, 'Bearer FICTITIOUS', randomUUID())).toMatchObject({ enabled: true, version: 2, supportedDocumentTypes: ['07', '08'] });
        expect(f.prisma.$executeRawUnsafe.mock.calls.some((c: any) => c[0].includes('FiscalDispatchAuthorization'))).toBe(false);
        f.state.grant.enabled = false;
        await expect(f.policy.current(RUC, f.event.payload.admission)).rejects.toThrow();
    });
});

describe('lazy production notes live notifications',()=>{
 it('creates no live connection or queue with flags off',async()=>{vi.stubEnv('BILLING_PRODUCTION_NOTES_ENABLED','false');const factory=vi.fn(()=>({changed:vi.fn(async()=>{}),close:vi.fn(async()=>{})}));const runtime=new ProductionNotesOwnerRuntime({} as never,factory);runtime.onApplicationBootstrap();await runtime.flush();await runtime.onModuleDestroy();expect(factory).not.toHaveBeenCalled();});
 it('notifies only after durable Outbox publication; websocket failures do not cause another publication',async()=>{let marked=false,rows=[{id:randomUUID(),documentId:randomUUID(),payload:{testOnly:true}}];const add=vi.fn(async()=>{expect(marked).toBe(false);});const changed=vi.fn(async()=>{expect(marked).toBe(true);throw Error('LIVE_UNAVAILABLE');});
  const prisma:any={$queryRawUnsafe:vi.fn(async()=>rows),$executeRawUnsafe:vi.fn(async()=>{marked=true;rows=[];return 1;})};const runtime:any=new ProductionNotesOwnerRuntime(prisma,()=>({changed,close:async()=>{}}));runtime.queue={add};await expect(runtime.flush()).resolves.toBeUndefined();expect(changed).toHaveBeenCalledExactlyOnceWith(expect.any(String));await runtime.flush();expect(add).toHaveBeenCalledOnce();});
 it('failed queue publication never marks Outbox or notifies a user',async()=>{const changed=vi.fn(async()=>{}),prisma:any={$queryRawUnsafe:vi.fn(async()=>[{id:randomUUID(),documentId:randomUUID(),payload:{}}]),$executeRawUnsafe:vi.fn()};const runtime:any=new ProductionNotesOwnerRuntime(prisma,()=>({changed,close:async()=>{}}));runtime.queue={add:async()=>{throw Error('QUEUE_DOWN');}};await expect(runtime.flush()).rejects.toThrow('QUEUE_DOWN');expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();});
});
