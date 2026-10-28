import 'reflect-metadata';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { PRODUCTION_NOTES_EXTENDED_PROFILE as PRODUCTION_NOTES_PROFILE, PRODUCTION_NOTES_ISSUED, type FiscalDocumentSnapshot, type ProductionNotesAnyIssued as ProductionNotesIssued } from '../packages/contracts/src';
import { calculateDocumentTotals, buildProductionNotesExtendedSnapshot as buildProductionNotesSnapshot, buildReceiptSummarySnapshot, fiscalSnapshotSha256, signProductionNotesOwner, assertProductionNotesOwner } from '../packages/sunat-core/src';
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
import { ProductionPdfService } from '../services/sunat-service/src/application/production-pdf.service';
import { ProductionNotesArtifactsService } from '../services/sunat-service/src/application/production-notes-artifacts.service';
import { productionNotesUnsigned, buildProductionNotesRc } from '../services/sunat-service/src/application/production-notes-rc';
import { XsdValidationService } from '../services/sunat-service/src/infrastructure/sunat/xsd-validation.service';
import { verifyLocalSignedInvoice } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import { productionTransportXml } from '../services/sunat-service/src/infrastructure/sunat/production-transport-zip';
import { renderProductionNotePdf } from '../packages/pdf-renderer/src/production-note';
import { spawnSync } from 'node:child_process';
const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
const RUC = '20100070970', now = new Date(), id = '60000000-0000-4000-8000-000000000001', branchId = '60000000-0000-4000-8000-000000000002';
let pki: ReturnType<typeof createGuideSidecarPki>, directory: string;
beforeAll(() => { pki = createGuideSidecarPki(); }, 30000);
afterAll(() => { for (const p of [pki.issuer, pki.otherIssuer, pki.sunat])
    p.pkcs12.fill(0); });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'factuez-prod-notes-dispatch-')); await writeFile(join(directory, 'owner.key'), randomBytes(32).toString('hex'),{mode:0o600}); vi.stubEnv('PRODUCTION_NOTES_OWNER_KEY_FILE', join(directory, 'owner.key')); vi.stubEnv('SUNAT_PRODUCTION_NOTES_ENABLED', 'true'); vi.stubEnv('SUNAT_PRODUCTION_WORKFLOW_ENABLED', 'true'); vi.stubGlobal('fetch', vi.fn(async () => { throw Error('NETWORK_FORBIDDEN'); })); });
afterEach(async () => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); if (!resolve(directory).startsWith(join(resolve(tmpdir()), 'factuez-prod-notes-dispatch-')))
    throw Error('UNSAFE_CLEANUP'); await rm(directory, { recursive: true, force: true }); });
function original(): FiscalDocumentSnapshot { return { documentId: id, companyId: 1, branchId, documentTypeCode: '03', environment: 'PRODUCTION', series: 'B001', number: '1', fullNumber: 'B001-1', issueDate: new Date(now.getTime() - 7200000).toISOString(), currencyCode: 'PEN', operationTypeCode: '0101', paymentTerms: { type: 'CONTADO' }, issuer: { identityType: '6', identityNumber: RUC, legalName: 'FICTITIOUS ISSUER', address: 'FICTITIOUS ADDRESS', ubigeo: '150101', establishmentCode: '0000' }, customer: { identityType: '6', identityNumber: '20131312955', legalName: 'FICTITIOUS CUSTOMER' }, ...calculateDocumentTotals([{ description: 'FICTITIOUS ITEM', quantity: '2', unitPriceWithTax: '11.80', unitCode: 'NIU', igvRate: '18', taxAffectationCode: '10' }]) }; }
async function fixture(type: '07' | '08' = '07') {
    const metadata = inspectCertificate(pki.issuer.pkcs12, pki.password), o = original(), store = new ArtifactStore(directory), archive = new PublicSignerArchive(directory);
    await archive.archive(RUC, metadata);
    const originalRc='RC-'+day()+'-1', noteRc='RC-'+day()+'-2', originalEventId=randomUUID(), batchId=randomUUID();
    const packed = prepareBetaXml(o, pki.issuer.pkcs12, pki.password,originalRc), originalArtifacts: any[] = [];
    async function save(owner: string, kind: string, name: string, bytes: Buffer, target = originalArtifacts) { const file = await store.put(owner, name, bytes), artifact = { documentId: owner, kind, mediaType: kind.endsWith('ZIP') ? 'application/zip' : 'application/xml', ...file, sizeBytes: BigInt(file.sizeBytes) }; target.push(artifact); return artifact; }
    const xml = await save(id, 'SIGNED_XML', packed.documentFileName + '.xml', Buffer.from(packed.document.xml)), zip = await save(id, 'SUBMISSION_ZIP', packed.documentFileName + '.zip', packed.individualZip!);
    const originalCdr = pki.signCdr(guideSidecarCdrXml({ issuerRuc: RUC, fullNumber: originalRc, documentType: 'RC' } as any));
    const cdrXml = await save(id, 'CDR_XML', 'R-' + packed.fileName + '.xml', Buffer.from(originalCdr)), cdrZip = await save(id, 'CDR_ZIP', 'R-' + packed.fileName + '.zip', Buffer.from(zipSync({ ['R-' + packed.fileName + '.xml']: Buffer.from(originalCdr) })));
    const originalSubmission = {documentId:id, batchId,channel:'SOAP_SEND_SUMMARY', id: randomUUID(), idempotencyKey: 'production:' + id + ':v1', errorCode: 'DONE', result: 'SUCCESS', completedAt: new Date(), requestArtifactKey: zip.storageKey, responseArtifactKey: cdrZip.storageKey };
    const documents = new Map<string, any>([[id, { documentId: id, issuerRuc: RUC, environment: 'PRODUCTION', billingEventId:originalEventId, documentType: '03', series: o.series, number: BigInt(o.number), immutablePayload: JSON.parse(JSON.stringify(o)), status: 'ACCEPTED', acceptedAt: new Date(now.getTime() - 3600000), digestValue: packed.document.digestValue, artifacts: originalArtifacts, submissions: [originalSubmission] }]]);
    const state = { dispatch: null as any, submission: null as any, statusEvents: [] as any[], ticket:null as any, batch:null as any, grant: { issuerRuc: RUC, enabled: true, version: 1, credentialRevision: 4, fingerprint: metadata.fingerprint, profile: PRODUCTION_NOTES_PROFILE } };
    const credentials = { revision: 4, certificateFingerprint: metadata.fingerprint, certificateCipher: 'EPHEMERAL_TEST', certificatePasswordCipher: 'EPHEMERAL_TEST', certificateSelfSigned: false, certificateExpiresAt: metadata.expiresAt, solUsernameCipher: 'EPHEMERAL_USER', solPasswordCipher: 'EPHEMERAL_PASS' };
    const prisma: any = { sunatCredentials: { findUnique: vi.fn(async () => credentials) }, fiscalDocument: { findUnique: vi.fn(async ({ where }: any) => documents.get(where.documentId)), findUniqueOrThrow: vi.fn(async ({ where }: any) => { const d = documents.get(where.documentId); if (!d)
                throw Error('NOT_FOUND'); return d; }), create: vi.fn(async ({ data }: any) => { documents.set(data.documentId, { ...data, artifacts: [], submissions: [] }); return data; }), update: vi.fn(async ({ where, data }: any) => Object.assign(documents.get(where.documentId), data)) },
        sunatSubmission: { create: vi.fn(async ({ data }: any) => { state.submission = { ...data, id: randomUUID() }; documents.get(data.documentId).submissions.push(state.submission); return state.submission; }), findUniqueOrThrow: vi.fn(async () => state.submission), updateMany: vi.fn(async ({ data }: any) => { Object.assign(state.submission, data); return { count: 1 }; }), update: vi.fn(async ({ data }: any) => Object.assign(state.submission, data)) },
        documentArtifact: { findUnique: vi.fn(async ({ where }: any) => documents.get(where.documentId_kind.documentId)?.artifacts.find((a: any) => a.kind === where.documentId_kind.kind)), upsert: vi.fn(async ({ where, create }: any) => { const docs = documents.get(where.documentId_kind.documentId).artifacts; let found = docs.find((a: any) => a.kind === where.documentId_kind.kind); if (!found) {
                found = { ...create, sizeBytes: BigInt(create.sizeBytes) };
                docs.push(found);
            } return found; }) } };
    const originalBatchSnapshot=buildReceiptSummarySnapshot(o,originalRc),originalBatchArtifacts:any[]=[];
    async function batchSave(kind:string,name:string,bytes:Buffer){const a=await save(originalBatchSnapshot.documentId,kind,name,bytes,originalBatchArtifacts);delete a.documentId;a.batchId=batchId;return a;}
    const summaryXml=await batchSave('SIGNED_XML',packed.fileName+'.xml',Buffer.from(packed.request.xml)),summaryZip=await batchSave('SUBMISSION_ZIP',packed.fileName+'.zip',packed.zip);
    await batchSave('CDR_XML','R-'+packed.fileName+'.xml',Buffer.from(originalCdr));
    await batchSave('CDR_ZIP','R-'+packed.fileName+'.zip',await store.read(id,cdrZip));
    const originalBatch={id:batchId,summaryId:id,issuerRuc:RUC,identifier:originalRc,environment:'PRODUCTION',status:'ACCEPTED',billingEventId:originalEventId,immutablePayload:JSON.parse(JSON.stringify(originalBatchSnapshot)),artifacts:originalBatchArtifacts};
    const file=(a:any)=>({...a,sizeBytes:Number(a.sizeBytes)});
    Object.assign(originalSubmission,{requestArtifactKey:summaryZip.storageKey,errorMessage:JSON.stringify({version:1,eventId:originalEventId,correlationId:randomUUID(),prepared:{reference:originalRc,fileName:packed.fileName+'.zip',requestOwnerId:originalBatchSnapshot.documentId,documentSnapshotSha256:fiscalSnapshotSha256(o),revision:4,fingerprint:metadata.fingerprint,digest:packed.document.digestValue,documentXml:file(xml),individualXmlZip:file(zip),xml:file(summaryXml),zip:file(summaryZip)}})});
    prisma.fiscalBatch={findUnique:vi.fn(async({where}:any)=>where.summaryId===id?originalBatch:state.batch),create:vi.fn(async({data}:any)=>state.batch={...data,id:randomUUID(),artifacts:[]})};
    prisma.sunatSubmission.findMany=vi.fn(async({where}:any)=>where.documentId===id?[originalSubmission]:[state.submission]);
    prisma.$queryRawUnsafe = vi.fn(async (sql: string, ...args: any[]) => {
        if(sql.startsWith('SELECT MAX('))return [{maximum:1}];
        if(sql.startsWith('SELECT "ticket"'))return state.ticket?[structuredClone(state.ticket)]:[];
        if(sql.startsWith('WITH claimed AS')){
          if(state.dispatch?.phase!=='POLLING'||!state.ticket||state.ticket.nextPollAt>new Date()||state.dispatch.leaseUntil&&state.dispatch.leaseUntil>new Date())return [];
          state.dispatch.lease=args[1];state.dispatch.leaseUntil=new Date(Date.now()+90000);
          return [{...structuredClone(state.dispatch),ticket:state.ticket.ticket,pollAttempts:state.ticket.pollAttempts}];
        }
        if(sql.startsWith('SELECT d."documentId"'))return state.dispatch?.phase==='POLLING'&&state.ticket?.nextPollAt<=new Date()?[{documentId:state.dispatch.documentId}]:[];
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
        if(sql.startsWith('INSERT INTO "ProductionNotesRcTicket"')){if(state.ticket)throw Error('DUPLICATE_TICKET');state.ticket={documentId:args[0],ticket:args[1],requestSha256:args[2],pollAttempts:0,nextPollAt:new Date()};}
        else if(sql.startsWith('UPDATE "ProductionNotesDispatch" SET "rcIdentifier"'))state.dispatch.rcIdentifier=args[1];
        else if(sql.startsWith('UPDATE "ProductionNotesDispatch" SET "phase"=\'POLLING\'')){state.dispatch.phase='POLLING';state.dispatch.lease=null;state.dispatch.leaseUntil=null;}
        else if(sql.startsWith('UPDATE "ProductionNotesDispatch" SET "lease"=NULL')){if(state.dispatch.lease!==args[1])return 0;state.dispatch.lease=null;state.dispatch.leaseUntil=null;state.dispatch.lastCode=args[2];}
        else if(sql.startsWith('UPDATE "ProductionNotesRcTicket"')){state.ticket.pollAttempts++;state.ticket.nextPollAt=new Date(Date.now()+args[1]*1000);state.ticket.lastCode=args[2];}
        else if (sql.startsWith('INSERT INTO "ProductionNotesDispatch"'))
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
    const evidence = new ProductionNotesEvidenceService(prisma, store, archive, trust as never, pki.cdrVerifier as never, new ProductionPdfService(prisma,store,{} as never,trust as never,pki.cdrVerifier as never,archive));
    const proof = await evidence.original(o), adjustment = type === '07' ? { documentTypeCode: '07', reasonCode: '01', reasonDescription: 'FICTITIOUS ANNULMENT' } : { documentTypeCode: '08', reasonCode: '02', reasonDescription: 'FICTITIOUS INCREASE', lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '1.18' }] };
    const note = buildProductionNotesSnapshot(o, proof, adjustment, { documentId: randomUUID(), series: type === '07' ? 'BC01' : 'BD01', number: '1', issueDate: new Date().toISOString() });
    const configuration = { status: vi.fn(async () => ({ ruc: RUC, revision: 4, certificate: { fingerprint: metadata.fingerprint }, emissionEnvironment: 'PRODUCTION' })) };
    const readiness = { inspect: vi.fn(async () => ({ revision: 4, checks: ['ISSUER_REAL_RUC', 'SECRET_VAULT', 'SOL_SECRETS_LOCAL', 'CERTIFICATE_KEY_PAIR', 'CERTIFICATE_RUC', 'CERTIFICATE_CHAIN', 'CERTIFICATE_REVOCATION', 'XSD_RUNTIME', 'CDR_TRUST'].map(code => ({ code, status: 'PASS' })) })) };
    const policy = new ProductionNotesPolicyService(prisma, configuration as never, readiness as never, evidence);
    const admission = await policy.admit(note, o, []), unsigned: any = { eventId: randomUUID(), eventName: PRODUCTION_NOTES_ISSUED, producer: 'billing-service', occurredAt: note.issueDate, correlationId: randomUUID(), payload: { snapshot: note, original: o, creditHistory: [], ownerRevisionSha256: 'f'.repeat(64), admission } };
    const event: ProductionNotesIssued = { ...unsigned, ownerProof: signProductionNotesOwner(unsigned, 'issued') }, repository = new ProductionNotesDispatchRepository(prisma);
    const opened: Buffer[] = [], vault = { open: vi.fn((_cipher: string, aad: any) => { const b = Buffer.from(aad.field === 'certificate' ? pki.issuer.pkcs12 : Buffer.from(aad.field === 'certificatePassword' ? pki.password : aad.field === 'solUsername' ? 'FICTITIOUS_USER' : 'FICTITIOUS_PASSWORD')); opened.push(b); return b; }) };
    const xsd = { validate: vi.fn(async (xml: string | Buffer) => ({ xmlSha256: hash(xml) })) };
    const dispatch: any = new ProductionNotesDispatchService(repository, policy, evidence, store, vault as never, inspection as never, trust as never, archive, xsd as never);
    dispatch.sign = vi.fn(async (n: any, b: Buffer, p: string,c:any) => prepareProductionNotesXml(n, b, p,c));
    const signed = pki.signCdr(guideSidecarCdrXml({ issuerRuc: RUC, fullNumber: noteRc, documentType: 'RC' } as any));
    const noteCdrZip = Buffer.from(zipSync({ ['R-' + RUC + '-' + noteRc + '.xml']: Buffer.from(signed) }));
    const adapter = { submit:vi.fn(),submitSummary:vi.fn(async()=> 'TEST-TICKET-RC'),getStatus:vi.fn(async()=>({kind:'CDR',cdrZip:noteCdrZip})) }, realAdapter = dispatch.adapter.bind(dispatch);
    dispatch.adapter = vi.fn(async () => adapter);
    return { o, note, noteRc, originalRc, originalSubmission, originalBatch, event, repository, state, documents, prisma, evidence, dispatch, adapter, realAdapter, store, archive, policy, configuration, readiness, metadata, credentials, trust, opened, xsd, noteCdrZip };
}

describe('production notes 07/08 on receipt 03: own RC, durable ticket and exact archive',()=>{
  it.each(['07','08'] as const)('%s signs individual and RC, posts summary once, polls and authenticates the actual RC CDR',async type=>{
    const f=await fixture(type);await f.repository.stage(f.event);await f.dispatch.process(f.note.documentId);
    expect(f.state.dispatch.phase).toBe('POLLING');expect(f.state.ticket.ticket).toBe('TEST-TICKET-RC');
    expect(f.state.submission.channel).toBe('SOAP_SEND_SUMMARY');expect(f.state.dispatch.manifest.rc.identifier).toBe(f.noteRc);
    expect(f.adapter.submitSummary).toHaveBeenCalledOnce();expect(f.adapter.submit).not.toHaveBeenCalled();
    const manifest=f.state.dispatch.manifest,request=f.adapter.submitSummary.mock.calls[0][0];
    expect(request.fileName).toBe(`${RUC}-${f.noteRc}.zip`);expect(request.sha256).toBe(manifest.zip.sha256);
    const xml=await f.store.read(f.note.documentId,manifest.xml),summary=await f.store.read(f.note.documentId,manifest.rc.xml);
    const unsigned=productionNotesUnsigned(f.note,f.event.payload),rc=buildProductionNotesRc(f.note,f.noteRc,f.event.payload);
    expect(verifyLocalSignedInvoice(xml.toString(),pki.issuer.certificatePem,unsigned,type==='07'?'CreditNote':'DebitNote')).toBe(manifest.digest);
    expect(verifyLocalSignedInvoice(summary.toString(),pki.issuer.certificatePem,rc,'SummaryDocuments')).toBe(manifest.rc.digest);
    expect(manifest.digest).not.toBe(manifest.rc.digest);
    expect(productionTransportXml(request.zip,`${RUC}-${f.noteRc}.xml`).xml).toEqual(summary);
    expect(rc).toContain('<cbc:UBLVersionID>2.0</cbc:UBLVersionID><cbc:CustomizationID>1.1</cbc:CustomizationID>');
    expect(rc).toContain(`<cbc:ID>${f.note.reference.fullNumber}</cbc:ID><cbc:DocumentTypeCode>03</cbc:DocumentTypeCode>`);
    expect(rc.match(/<sac:SummaryDocumentsLine>/g)).toHaveLength(1);
    await f.dispatch.process(f.note.documentId);expect(f.state.dispatch.phase).toBe('DONE');
    const status=f.state.statusEvents[0],{ownerProof,...body}=status;assertProductionNotesOwner(body,'status',ownerProof);
    expect(status.payload).toMatchObject({profile:PRODUCTION_NOTES_PROFILE,status:'ACCEPTED',cdrSignatureVerified:true,requestXmlSha256:manifest.xml.sha256,requestZipSha256:manifest.zip.sha256});
    expect(f.adapter.getStatus).toHaveBeenCalledWith('TEST-TICKET-RC');expect(f.adapter.submitSummary).toHaveBeenCalledOnce();
    expect(f.documents.get(f.note.documentId).artifacts.map((a:any)=>a.kind)).toEqual(['SIGNED_XML','SUBMISSION_ZIP','CDR_XML','CDR_ZIP']);
    expect(f.opened.every(b=>b.every(v=>v===0))).toBe(true);
  });
  it('lost sendSummary response is UNKNOWN without a ticket and never rePOSTs',async()=>{
    const f=await fixture();await f.repository.stage(f.event);f.adapter.submitSummary.mockRejectedValueOnce(Error('LOST_RESPONSE'));
    await f.dispatch.process(f.note.documentId);expect(f.state.dispatch.phase).toBe('UNKNOWN');expect(f.state.ticket).toBeNull();
    await f.repository.recover();await f.dispatch.process(f.note.documentId);expect(f.adapter.submitSummary).toHaveBeenCalledOnce();expect(f.adapter.getStatus).not.toHaveBeenCalled();
    expect(f.state.statusEvents[0].payload.cdrSignatureVerified).toBe(false);
  });
  it('restart resumes getStatus from the durable ticket and unchanged manifest',async()=>{
    const f=await fixture();await f.repository.stage(f.event);await f.dispatch.process(f.note.documentId);const manifest=structuredClone(f.state.dispatch.manifest);
    const restarted:any=new ProductionNotesDispatchService(f.repository,f.policy,f.evidence,f.store,{} as never,{} as never,f.trust as never,f.archive,f.xsd as never);
    restarted.adapter=vi.fn(async()=>f.adapter);restarted.sign=vi.fn(()=>{throw Error('NO_RESIGN');});
    await f.repository.recover();await restarted.process(f.note.documentId);
    expect(f.state.dispatch.phase).toBe('DONE');expect(f.state.dispatch.manifest).toEqual(manifest);expect(restarted.sign).not.toHaveBeenCalled();expect(f.adapter.submitSummary).toHaveBeenCalledOnce();
  });
  it('processing and lost getStatus responses back off durably; expired polling lease can be reclaimed',async()=>{
    const f=await fixture();await f.repository.stage(f.event);await f.dispatch.process(f.note.documentId);
    f.adapter.getStatus.mockResolvedValueOnce({kind:'PROCESSING'} as never);await f.dispatch.process(f.note.documentId);
    expect(f.state.ticket.pollAttempts).toBe(1);expect(f.state.ticket.nextPollAt.getTime()).toBeGreaterThan(Date.now());
    await f.dispatch.process(f.note.documentId);expect(f.adapter.getStatus).toHaveBeenCalledOnce();
    f.state.ticket.nextPollAt=new Date(0);const dead=await f.repository.claimPoll(f.note.documentId);expect(dead).toBeDefined();
    expect(await f.repository.claimPoll(f.note.documentId)).toBeUndefined();f.state.dispatch.leaseUntil=new Date(0);
    f.adapter.getStatus.mockRejectedValueOnce(Error('LOST_STATUS'));await f.dispatch.process(f.note.documentId);
    expect(f.state.ticket.pollAttempts).toBe(2);expect(f.state.dispatch.phase).toBe('POLLING');expect(f.state.dispatch.lastCode).toBe('GETSTATUS_RECONCILIATION_REQUIRED');
    f.state.ticket.nextPollAt=new Date(0);await f.dispatch.process(f.note.documentId);expect(f.state.dispatch.phase).toBe('DONE');expect(f.adapter.submitSummary).toHaveBeenCalledOnce();
  });
  it('SENDING crash without a ticket is UNKNOWN and stale workers cannot store a ticket',async()=>{
    const f=await fixture();await f.repository.stage(f.event);const stale=await f.repository.claim(f.note.documentId);
    f.state.dispatch.phase='SENDING';f.state.dispatch.leaseUntil=new Date(0);await f.repository.recover();
    expect(f.state.dispatch.phase).toBe('UNKNOWN');await expect(f.repository.ticket(stale!,'LATE-TICKET')).rejects.toThrow('Lease');
    await f.dispatch.process(f.note.documentId);expect(f.adapter.submitSummary).not.toHaveBeenCalled();
  });
  it('rejects the individual note CDR as an RC outcome, keeps the ticket and never reposts',async()=>{
    const f=await fixture();await f.repository.stage(f.event);await f.dispatch.process(f.note.documentId);
    const wrong=pki.signCdr(guideSidecarCdrXml({issuerRuc:RUC,fullNumber:f.note.fullNumber,documentType:'07'} as any));
    f.adapter.getStatus.mockResolvedValueOnce({kind:'CDR',cdrZip:Buffer.from(zipSync({[`R-${RUC}-07-${f.note.fullNumber}.xml`]:Buffer.from(wrong)}))});
    await f.dispatch.process(f.note.documentId);expect(f.state.dispatch.phase).toBe('POLLING');expect(f.state.statusEvents).toHaveLength(0);
    expect(f.documents.get(f.note.documentId).artifacts.some((a:any)=>a.kind==='CDR_XML')).toBe(false);expect(f.adapter.submitSummary).toHaveBeenCalledOnce();
  });
  it('rejects re-signed RC references/individual bytes different from the snapshot before POST',async()=>{
    const f=await fixture();await f.repository.stage(f.event);
    const real=f.dispatch.sign;f.dispatch.sign=vi.fn(async(...args:any[])=>{
      const result=await real(...args),changed=buildProductionNotesRc(args[0],args[3].identifier,args[3]).replace('<cbc:DocumentTypeCode>03</cbc:DocumentTypeCode>','<cbc:DocumentTypeCode>01</cbc:DocumentTypeCode>');
      const {XmlSignerService}=await import('../services/sunat-service/src/infrastructure/crypto/xml-signer.service');
      const signed=new XmlSignerService().sign(changed,pki.issuer.pkcs12,pki.password,'SummaryDocuments');
      return {...result,rc:{...result.rc,...signed,zip:Buffer.from(zipSync({[result.rc.fileName+'.xml']:Buffer.from(signed.xml)}))}};
    });
    await f.dispatch.process(f.note.documentId);expect(f.state.dispatch.phase).toBe('BLOCKED');expect(f.adapter.submitSummary).not.toHaveBeenCalled();
  });
  it('admission profile must equal the snapshot profile even with a valid owner proof',async()=>{
    const f=await fixture();const event=structuredClone(f.event);event.payload.admission.profile='07-08-ON-01-PEN-0101-IGV18-v1';
    const {ownerProof,...body}=event;event.ownerProof=signProductionNotesOwner(body,'issued');await expect(f.repository.stage(event)).rejects.toThrow('Admisión');
  });
  it.each(['07','08'] as const)('%s canonical individual and RC XML validate with the pinned official XSD bundle offline',async type=>{
    const f=await fixture(type);const result=prepareProductionNotesXml(f.note,pki.issuer.pkcs12,pki.password,{...f.event.payload,identifier:f.noteRc});
    const validator:any=new XsdValidationService();
    // Only replace the OS process port. Bundle hash, extraction, safe paths, XML guards and schema selection stay real.
    validator.run=async(bytes:Buffer,schema:string)=>{
      const code=["from pathlib import Path","from runpy import run_path","from lxml import etree","import sys","h=run_path('tests/validate-official-xsd.py')","schema=Path(sys.argv[1]).resolve(strict=True)","root=schema.parents[2]","s=etree.XMLSchema(etree.parse(str(schema),h['parser'](root)))","s.assertValid(h['xml_root'](sys.stdin.buffer.read()))"].join('\n');
      const run=spawnSync('python',['-c',code,schema],{cwd:resolve('.'),input:bytes,encoding:'utf-8',timeout:20000});
      expect(run.stderr).toBe('');expect(run.status).toBe(0);
    };
    expect((await validator.validate(result.xml,type==='07'?'CreditNote':'DebitNote')).xmlSha256).toBe(hash(result.xml));
    expect((await validator.validate(result.rc!.xml,'SummaryDocuments')).xmlSha256).toBe(hash(result.rc!.xml));
  },30000);
  it.each(['OBSERVED','REJECTED'])('%s interprets only the verified summary CDR',async outcome=>{
    const f=await fixture();await f.repository.stage(f.event);await f.dispatch.process(f.note.documentId);
    let xml=guideSidecarCdrXml({issuerRuc:RUC,fullNumber:f.noteRc,documentType:'RC'} as any,outcome==='REJECTED'?'2001':'0');
    if(outcome==='OBSERVED')xml=xml.replace('<cac:SenderParty>','<cbc:Note>FICTITIOUS RC OBSERVATION</cbc:Note><cac:SenderParty>');
    const signed=pki.signCdr(xml),zip=Buffer.from(zipSync({[`R-${RUC}-${f.noteRc}.xml`]:Buffer.from(signed)}));
    f.adapter.getStatus.mockResolvedValueOnce({kind:'CDR',cdrZip:zip});await f.dispatch.process(f.note.documentId);
    expect(f.state.dispatch.phase).toBe('DONE');expect(f.state.statusEvents[0].payload.status).toBe(outcome==='REJECTED'?'REJECTED':'ACCEPTED_WITH_OBSERVATIONS');
    expect(f.state.submission.result).toBe(outcome==='REJECTED'?'BUSINESS_ERROR':'SUCCESS');
    expect(f.documents.get(f.note.documentId).artifacts.find((a:any)=>a.kind==='CDR_ZIP').sha256).toBe(hash(zip));
  });
  it('prepared RC manifest cannot be replaced after an interrupted preparation',async()=>{
    const f=await fixture();await f.repository.stage(f.event);await f.dispatch.process(f.note.documentId);
    const previous=structuredClone(f.state.dispatch.manifest);f.state.dispatch.phase='PREPARED';f.state.dispatch.lease=null;f.state.dispatch.leaseUntil=null;
    const claimed=await f.repository.claim(f.note.documentId);const replacement=structuredClone(previous);replacement.rc.digest='A'.repeat(43)+'=';
    await expect(f.repository.prepared(claimed!,replacement)).rejects.toThrow('No se reemplaza');expect(f.state.dispatch.manifest).toEqual(previous);
  });
  it('raw returns individual XML, submitted RC ZIP and RC CDR filenames; PDF checks PKI/CDR before every cache hit',async()=>{
    const f=await fixture();await f.repository.stage(f.event);await f.dispatch.process(f.note.documentId);await f.dispatch.process(f.note.documentId);
    const draw=vi.fn(async()=>Buffer.from('%PDF-FICTITIOUS-RC')),presentation={presentationForDocument:vi.fn(async(s:any)=>({printable:s}))};
    const service:any=new ProductionNotesArtifactsService(f.prisma,f.repository,f.store,f.evidence,presentation as never,draw);
    service.billing=vi.fn(async(id:string)=>({id,immutableSnapshot:JSON.parse(JSON.stringify(id===f.note.documentId?f.note:f.o)),companyId:1}));
    try{
      const raw=await service.download(f.note.documentId,'signed-xml','Bearer TEST');expect(raw.fileName).toBe(`${RUC}-07-${f.note.fullNumber}.xml`);
      expect(raw.sha256).toBe(f.state.dispatch.manifest.xml.sha256);
      const request=await service.download(f.note.documentId,'submission-zip','Bearer TEST');expect(request.fileName).toBe(`${RUC}-${f.noteRc}.zip`);
      const cdr=await service.download(f.note.documentId,'cdr-xml','Bearer TEST');expect(cdr.fileName).toBe(`R-${RUC}-${f.noteRc}.xml`);
      await service.pdf(f.note.documentId,'a4','Bearer TEST');await service.pdf(f.note.documentId,'a4','Bearer TEST');expect(draw).toHaveBeenCalledOnce();
      const proof=draw.mock.calls[0][2];expect(proof.receiptSummary.identifier).toBe(f.noteRc);expect(proof.digestValue).toBe(f.state.dispatch.manifest.digest);
      await renderProductionNotePdf(f.note,'a4',proof,async()=>Buffer.from('DRAW'));
      f.trust.evaluate.mockRejectedValueOnce(Error('REVOKED_NOW'));await expect(service.pdf(f.note.documentId,'a4','Bearer TEST')).rejects.toThrow();expect(draw).toHaveBeenCalledOnce();
      f.trust.evaluate.mockRejectedValue(Error('NO_PKI_FOR_RAW'));await expect(service.download(f.note.documentId,'cdr-zip','Bearer TEST')).resolves.toMatchObject({fileName:`R-${RUC}-${f.noteRc}.zip`,currentFiscalValidityVerified:false});
    }finally{service.onModuleDestroy();}
  });
  it.each(['summary-hash','original-summary-signature','note-cdr'])('raw fails closed on %s without reading current secrets/PKI',async change=>{
    const f=await fixture();await f.repository.stage(f.event);await f.dispatch.process(f.note.documentId);await f.dispatch.process(f.note.documentId);
    const service:any=new ProductionNotesArtifactsService(f.prisma,f.repository,f.store,f.evidence,{} as never,vi.fn());
    service.billing=vi.fn(async(id:string)=>({id,immutableSnapshot:JSON.parse(JSON.stringify(id===f.note.documentId?f.note:f.o))}));
    if(change==='summary-hash')f.state.dispatch.manifest.rc.xml.sha256='0'.repeat(64);
    else if(change==='original-summary-signature'){
      const file=f.originalBatch.artifacts.find((a:any)=>a.kind==='SIGNED_XML');const bytes=await f.store.read(f.originalBatch.immutablePayload.documentId,file);
      const changed=Buffer.from(bytes.toString().replace('<cbc:DocumentTypeCode>03</cbc:DocumentTypeCode>','<cbc:DocumentTypeCode>07</cbc:DocumentTypeCode>'));
      const stored=await f.store.put(f.originalBatch.immutablePayload.documentId,`${RUC}-${f.originalRc}.xml`,changed);Object.assign(file,stored,{sizeBytes:BigInt(stored.sizeBytes)});
      const metadata=JSON.parse(f.originalSubmission.errorMessage);metadata.prepared.xml=stored;f.originalSubmission.errorMessage=JSON.stringify(metadata);
    }else{
      const file=f.documents.get(f.note.documentId).artifacts.find((a:any)=>a.kind==='CDR_XML');file.sha256='0'.repeat(64);
    }
    f.trust.evaluate.mockRejectedValue(Error('RAW_MUST_NOT_CHECK_CURRENT_TRUST'));
    try{await expect(service.download(f.note.documentId,'signed-xml','Bearer TEST')).rejects.toThrow();}finally{service.onModuleDestroy();}
  });
});
