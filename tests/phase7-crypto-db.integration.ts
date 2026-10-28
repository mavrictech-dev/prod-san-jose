import 'reflect-metadata';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {beforeAll,describe,expect,it} from 'vitest';
import {PostgresBatchMemberOwner} from '../services/billing-service/src/b2b/batch-member-postgres';
import {createDurableBatchMemberProducer} from '../services/billing-service/src/b2b/batch-member-durable-producer';
import {BillingBatchOperations} from '../services/billing-service/src/b2b/batch-member-http';
import {BatchLocalArtifactPipeline,PostgresBatchLocalArtifactStore,createBatchLocalSigner} from '../services/sunat-service/src/application/batch-local-artifacts';
import {BatchArtifactApi,PrivateBatchArtifactOwner} from '../services/sunat-service/src/application/batch-artifact-api';
import {calculateDocumentTotals} from '../packages/sunat-core/src/tax';
import {prepareBetaFiscalPackage} from '../services/sunat-service/src/infrastructure/crypto/beta-fiscal-package-pipeline';
import {verifyLocalSignedInvoice} from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import {buildFiscalBatchUbl} from '../packages/sunat-core/src/fiscal-batch';
import {createGuideSidecarPki,guideSidecarCdrXml,guideSidecarPackCdr} from './helpers/guide-sidecar-ephemeral-pki.fixture';
import {batchMemberEvidenceFixture} from './helpers/batch-member-evidence.fixture';
import {CarrierReferenceCryptoVerifier} from '../services/sunat-service/src/application/carrier-reference-verifier';
import {buildPublicGuide09Xml} from '../packages/sunat-core/src/public-guide-profile';
import {signLocalGuideXml} from '../services/sunat-service/src/infrastructure/crypto/guide-artifact-crypto';
import {CarrierGuideArtifactOwner} from '../services/sunat-service/src/application/guide-carrier-artifact-owner';
import {GuideArtifactPipeline} from '../services/sunat-service/src/application/guide-artifact-pipeline';
import {PostgresGuideArtifactStore} from '../services/sunat-service/src/application/guide-artifact-store';
import {createCarrierReference09Ingestion} from '../services/billing-service/src/b2b/carrier-guide-reference';
const require = createRequire(import.meta.url);
const {withCorrectionDatabase} = require('./helpers/correction-reservation-db.cjs');
const {withCarrierGuideOwnerFixture} = require('./helpers/carrier-guide-owner-db.cjs');
if(process.env.FACTUEZ_PHASE7_OWNED_CRYPTO_DB!=='NEW_NETWORK_NONE_TMPFS_ONLY')throw new Error('EXPLICIT_NEW_DATABASE_RUNNER_REQUIRED');
let pki:ReturnType<typeof createGuideSidecarPki>,sender:ReturnType<typeof createGuideSidecarPki>,carrier:ReturnType<typeof createGuideSidecarPki>;
beforeAll(()=>{pki=createGuideSidecarPki();sender=createGuideSidecarPki('20000000001');carrier=createGuideSidecarPki('20000000028');},120000);
describe('phase7 real PostgreSQL plus real ephemeral XML/CDR signatures',()=>{
  it('SERVICE RC2 exact versions: verified accepted RC base, signed correction, atomic durable command, signed batch and replay',async()=>{
    const f=await batchMemberEvidenceFixture(pki,'03');
    await withCorrectionDatabase(async({pool}:any)=>{
      await pool.query(readFileSync(new URL('../services/billing-service/b2b-batch-member-schema.candidate.sql',import.meta.url),'utf8'));
      const subject={kind:'SERVICE' as const,clientId:randomUUID(),subjectId:null},now=()=>new Date().toISOString();
      const identity={current:async(who:any)=>({subject:structuredClone(who),clientRevision:1,userAuthRevision:null,checkedAt:now()})};
      const admin={authorizeStepUp:async(_handle:string,policySha256:string)=>({adminId:'00000000-0000-4000-8000-000000000999',authRevision:1,policySha256,checkedAt:now()})};
      const owner=new PostgresBatchMemberOwner(pool,f.adapter,identity,admin,now),producer=createDurableBatchMemberProducer(owner,now);
      const previous=await owner.importVerifiedVersion('opaque-member-version-1');
      expect((await owner.member(previous))!.acceptance!.responseCode).toBe('0');
      const calculated=calculateDocumentTotals([{productCode:'SYNTHETIC',description:'CORRECCION FICTICIA',unitCode:'NIU',quantity:'2',unitPriceWithTax:'20',taxAffectationCode:'10',igvRate:'18'}]);
      const corrected={...structuredClone(f.record.snapshot),...calculated};
      const next=await f.add(corrected,null,false,2);f.owner.load.mockImplementation(async()=>structuredClone(next.record));
      const current=await owner.importVerifiedVersion('opaque-member-version-2');expect(current.version).toBe(2);
      await owner.setLocalGrant('synthetic-owner-step-up',{subject,binding:next.record.binding,kind:'RC',permission:'WRITE',clientRevision:1,userAuthRevision:null,active:true,expectedRevision:0});
      const scope={environment:'BETA' as const,issuerRuc:next.record.binding.issuerRuc,companyId:next.record.binding.companyId,branchId:next.record.binding.branchId};
      const request={schemaVersion:'factuez.b2b.batch-members.v1',kind:'RC',scope,idempotencyKey:'synthetic_crypto_rc2_replay_0001',asOf:now(),
        issueDate:'2026-10-03',referenceDate:'2026-10-02',entries:[{member:current,conditionCode:'2',previous}]};
      const first=await producer.coordinate(await producer.plan(request,subject),'CREATE');
      const command=first.journal.command,batch=command.payload.envelope;
      if(batch.kind!=='BATCH')throw new Error('BATCH_REQUIRED');
      const pkg=prepareBetaFiscalPackage(batch,pki.issuer.pkcs12,pki.password);
      expect(verifyLocalSignedInvoice(pkg.xml,pki.issuer.certificatePem,buildFiscalBatchUbl(batch.batch,batch.asOf),'SummaryDocuments')).toBe(pkg.signed.digestValue);
      const replay=await producer.coordinate(await producer.plan({...request,asOf:now()},subject),'REUSE_JOURNAL');
      expect(replay.journal.command).toEqual(command);expect(replay.reused).toBe(true);
      await owner.setLocalGrant('synthetic-owner-step-up',{subject,binding:next.record.binding,kind:'RC',permission:'READ',clientRevision:1,userAuthRevision:null,active:true,expectedRevision:0});
      await pool.query(readFileSync(new URL('../services/sunat-service/batch-local-artifacts-schema.candidate.sql',import.meta.url),'utf8'));
      const b=next.record.binding,principal={...subject,revision:1,userAuthRevision:null,environment:'BETA' as const,
        scopes:['b2b:batches:read','b2b:batches:write','b2b:artifacts:read'],
        bindings:[{issuerId:b.companyId,issuerRuc:b.issuerRuc,environment:b.environment,branchId:b.branchId,pointId:b.pointId,seriesId:b.seriesId,documentType:b.documentType}]};
      // Identity alone is a synthetic port; Billing's exact-version grants, SQL
      // transaction, command resolution, XMLDSig and originals persistence are real.
      const auth={authenticate:async()=>structuredClone(principal)},operations=new BillingBatchOperations(owner,auth as any,now);
      const scopeForFiles={...scope,batchId:batch.batch.documentId},access={token:'synthetic-owned-batch-files',kind:'SERVICE' as const};
      const privateRpc={post:async(path:string,body:any,token:string)=>{
        expect(path).toBe('/internal/b2b/batch-operations');expect(body.action).toBe('ARTIFACT_OWNER');
        return operations.artifactOwnerById(token,body.kind,body.scope,body.permission);
      }};
      const db={$transaction:async(work:any)=>{const c=await pool.connect();await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const sql={$queryRawUnsafe:async(text:string,...values:any[])=> (await c.query(text,values)).rows,
          $executeRawUnsafe:async(text:string,...values:any[])=> (await c.query(text,values)).rowCount};
        try{const result=await work(sql);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
      const signer=createBatchLocalSigner({acquire:async(ruc,purpose)=>({ruc,purpose,p12:Buffer.from(pki.issuer.pkcs12),password:pki.password,
        certificatePem:pki.issuer.certificatePem,dispose:async()=>{}})});
      const artifactPipeline=new BatchLocalArtifactPipeline(new PrivateBatchArtifactOwner(auth as any,privateRpc as any),new PostgresBatchLocalArtifactStore(db),signer,[b.issuerRuc]);
      const artifactApi=new BatchArtifactApi(artifactPipeline),metadata=await artifactApi.view(scopeForFiles,access,true);
      expect(metadata.metadata.kind).toBe('RC');expect(metadata.metadata.commandSha256).toBe(first.journal.commandSha256);
      const original=await artifactApi.content(scopeForFiles,access,'zip');
      expect((await artifactApi.view(scopeForFiles,access,true)).replayed).toBe(true);
      expect((await artifactApi.content(scopeForFiles,access,'zip')).bytes).toEqual(original.bytes);
      expect((await pool.query('SELECT count(*)::int n FROM "BatchLocalArtifact"')).rows[0].n).toBe(1);
      await expect(artifactApi.content(scopeForFiles,access,'cdr-zip')).rejects.toThrow();
      const rows=(await pool.query('SELECT subject,command FROM b2b_batch_member_command')).rows;
      expect(rows).toHaveLength(1);expect(rows[0].subject).toEqual(subject);expect(rows[0].command.payload.envelope.batch.input.entries[0].conditionCode).toBe('2');
      expect((await pool.query('SELECT count(*)::int n FROM b2b_batch_member_local_outbox')).rows[0].n).toBe(1);
      next.record.signerFingerprint='c'.repeat(64);
      await expect(owner.importVerifiedVersion('opaque-member-version-corrupt')).rejects.toThrow();
    });
  },120000);
  it('persisted GT31: real signed public09/CDR → verified reference owner → reserved V counter → signed immutable original',async()=>{
    await withCarrierGuideOwnerFixture(async(f:any)=>{
      const {pool,client,now}=f;
      await pool.query(readFileSync(new URL('../services/sunat-service/guide-artifacts-schema.candidate.sql',import.meta.url),'utf8'));
      const unsigned=buildPublicGuide09Xml(f.ownerSnapshot);
      const signed=signLocalGuideXml({issuerRuc:f.sender.ruc,documentType:'09',fullNumber:'TQ31-9',unsignedXml:unsigned.xml},sender.issuer.pkcs12,sender.password);
      const expected={issuerRuc:f.sender.ruc,documentType:'09' as const,fullNumber:'TQ31-9',requestXmlSha256:signed.xmlSha256,requestZipSha256:signed.zipSha256,
        issuedAt:f.ownerSnapshot.body.issueDate,receivedAt:now};
      const cdrXml=Buffer.from(sender.signCdr(guideSidecarCdrXml(expected).replaceAll('10:30:00','08:00:00').replaceAll('10:31:00','08:01:00')));
      const pins={current:async()=>({fingerprint:sender.issuer.fingerprint,revision:'a'.repeat(64)})};
      const certificates={load:async()=>({certificatePem:sender.issuer.certificatePem,chainPems:sender.issuer.chainPems})};
      // Only the offline trust/CRL policy is a fixture; all XML/CDR signatures, RUC pins, snapshot comparisons and SQL are real.
      const trust={evaluate:async(m:any,_ruc:string,at:Date)=>({profile:'OFFLINE-PINNED-ROOTS-CRL-v1' as const,chainValid:true,identityMatched:true,
        revocation:'VERIFIED_OFFLINE_CRL' as const,blockers:[],certificateFingerprint:m.fingerprint,trustStoreSha256:'b'.repeat(64),checkedAt:at.toISOString()})};
      const validator=new CarrierReferenceCryptoVerifier(pins,certificates,trust,sender.cdrVerifier,()=>now);
      await createCarrierReference09Ingestion(client,validator,()=>now).ingest(f.ownerSnapshot,{signedXml:Buffer.from(signed.xml),cdrXml},
        {companyId:1,branchId:f.ids.branch,issuerRuc:f.carrier.ruc});
      const owner=f.makeOwner(validator),request=await f.ready('SERVICE',owner),issued=await owner.issue(f.token,'SERVICE',request);
      const keys={mode:'ISOLATED_LOCAL_SIGNER' as const,sign:async(input:any)=>signLocalGuideXml(input,carrier.issuer.pkcs12,carrier.password)};
      const pipeline=new GuideArtifactPipeline(new CarrierGuideArtifactOwner(owner),new PostgresGuideArtifactStore(client),keys,[f.carrier.ruc],sender.cdrVerifier,()=>now);
      const scope=f.scope(issued),access={token:f.token,kind:'SERVICE' as const},prepared=await pipeline.prepare(scope,access),replay=await pipeline.prepare(scope,access);
      expect(prepared.record.metadata.guideType).toBe('31');expect(prepared.record.signedXml).toContain(issued.snapshot.fullNumber);
      expect(replay.record.zip).toEqual(prepared.record.zip);expect(replay.replayed).toBe(true);
      expect((await pool.query('SELECT count(*)::int n FROM "GuideLocalArtifact"')).rows[0].n).toBe(1);
      const gtExpected={...expected,issuerRuc:f.carrier.ruc,documentType:'31' as const,fullNumber:issued.snapshot.fullNumber,
        requestXmlSha256:prepared.record.metadata.xmlSha256,requestZipSha256:prepared.record.metadata.zipSha256,issuedAt:issued.snapshot.body.issueDate};
      const gtCdr=guideSidecarPackCdr(sender.signCdr(guideSidecarCdrXml(gtExpected)),gtExpected);
      expect((await pipeline.reviewCdr(scope,access,gtCdr)).zip).toEqual(gtCdr);
      expect((await pipeline.readCdr(scope,access)).evidence.officialCdrVerified).toBe(false);
      expect((await pool.query('SELECT count(*)::int n FROM "GuideLocalCdr"')).rows[0].n).toBe(1);
      expect((await f.state()).counter).toBe('2');expect((await f.state()).legacy_events).toBe(0);
    });
  },120000);
});
