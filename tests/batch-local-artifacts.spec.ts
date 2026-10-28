import 'reflect-metadata';
import {beforeAll,describe,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {BatchLocalArtifactPipeline,PostgresBatchLocalArtifactStore,createBatchLocalSigner,validateBatchLocalArtifactScope,
  type BatchLocalArtifactRecord,type BatchLocalCdrArchive,type BatchLocalArtifactStore,type BatchLocalArtifactOwned,
  type BatchLocalArtifactScope} from '../services/sunat-service/src/application/batch-local-artifacts';
import {supplementCommandFixture} from './helpers/fiscal-supplement.fixture';
import {createGuideSidecarPki,zipSync,unzipSync} from './helpers/guide-sidecar-ephemeral-pki.fixture';
import {cdrXml} from './helpers/beta-document-evidence.fixture';
import {fiscalSnapshotSha256 as hash} from '../packages/sunat-core/src/fiscal-note';
import {buildFiscalSupplementCommand} from '../packages/sunat-core/src/fiscal-supplement-command';
import {batchMemberEvidenceFixture} from './helpers/batch-member-evidence.fixture';
import {PostgresBatchMemberOwner} from '../services/billing-service/src/b2b/batch-member-postgres';
import {createDurableBatchMemberProducer} from '../services/billing-service/src/b2b/batch-member-durable-producer';

let pki:ReturnType<typeof createGuideSidecarPki>;
beforeAll(()=>{pki=createGuideSidecarPki();},60000);
const cloneRecord=(r:BatchLocalArtifactRecord|null)=>r?{...r,metadata:structuredClone(r.metadata),zip:Buffer.from(r.zip)}:null;
const cloneCdr=(r:BatchLocalCdrArchive|null)=>r?{...r,evidence:structuredClone(r.evidence),zip:Buffer.from(r.zip)}:null;
const ACCESS={token:'synthetic-service-access-token',kind:'SERVICE' as const};
function fixture(kind:'RC'|'RA'='RC') {
  const data=supplementCommandFixture(kind);
  const owned:BatchLocalArtifactOwned={command:data.command,authorizationSha256:'a'.repeat(64)};
  const scope:BatchLocalArtifactScope={environment:'BETA',issuerRuc:data.doc.issuer.identityNumber,companyId:99,
    branchId:data.doc.branchId!,batchId:data.batch!.documentId};
  const state:{record:BatchLocalArtifactRecord|null;cdr:BatchLocalCdrArchive|null;writes:number;cdrWrites:number}={record:null,cdr:null,writes:0,cdrWrites:0};
  const controls={revoked:false,allowWrite:true,allowRead:true,failAfterInsert:false};
  const hooks:{signed?:()=>void;inserted?:()=>void}={};
  let pending=Promise.resolve();
  const store:BatchLocalArtifactStore={transaction:async(_scope,work)=>{
    const prior=pending;let release!:()=>void;pending=new Promise(r=>{release=r;});await prior;
    let record=cloneRecord(state.record),cdr=cloneCdr(state.cdr),writes=0,cdrWrites=0;
    try {
      const result=await work({read:async()=>cloneRecord(record),insert:async r=>{record=cloneRecord(r);writes++;hooks.inserted?.();
        if(controls.failAfterInsert)throw new Error('SECRET_SQL_PATH_MUST_NOT_ESCAPE');},
        readCdr:async()=>cloneCdr(cdr),insertCdr:async r=>{cdr=cloneCdr(r);cdrWrites++;}});
      state.record=record;state.cdr=cdr;state.writes+=writes;state.cdrWrites+=cdrWrites;return result;
    }finally{release();}
  }};
  const owner={current:vi.fn(async(_s:any,_a:any,action:string)=>{
    if(controls.revoked||action==='WRITE'&&!controls.allowWrite||action==='READ'&&!controls.allowRead)throw new Error('PRIVATE_DENIED');
    return structuredClone(owned);
  })};
  const dispose=vi.fn(async()=>{}),keyCopies:Buffer[]=[];
  const keys={acquire:vi.fn(async(ruc:string,purpose:'LOCAL_SYNTHETIC_BATCH')=>{
    const bytes=Buffer.from(pki.issuer.pkcs12);keyCopies.push(bytes);
    return {ruc,purpose,p12:bytes,password:pki.password,certificatePem:pki.issuer.certificatePem,dispose};
  })};
  const base=createBatchLocalSigner(keys),signer={...base,prepare:vi.fn(async(e:Parameters<typeof base.prepare>[0])=>{
    const result=await base.prepare(e);hooks.signed?.();return result;
  })};
  let response:{source:'LOCAL_EMULATOR';zip:Buffer;receivedAt:string}|null=null;
  const source={current:vi.fn(async()=>response?{...response,zip:Buffer.from(response.zip)}:null)};
  const verifier={verify:vi.fn(bytes=>pki.cdrVerifier.verify(bytes))};
  const restart=()=>new BatchLocalArtifactPipeline(owner,store,signer,[scope.issuerRuc],source,verifier);
  const receipt=(code='0',observed=false)=>{
    const xml=pki.signCdr(cdrXml(data.batch!.identifier,kind,scope.issuerRuc,observed).replace('<cbc:ResponseCode>0</cbc:ResponseCode>',`<cbc:ResponseCode>${code}</cbc:ResponseCode>`));
    const zip=Buffer.from(zipSync({[`R-${scope.issuerRuc}-${data.batch!.identifier}.xml`]:Buffer.from(xml)},{level:0}));
    response={source:'LOCAL_EMULATOR',zip,receivedAt:'2026-10-03T19:00:00Z'};return zip;
  };
  return {data,scope,owned,state,controls,hooks,owner,signer,store,keys,keyCopies,dispose,source,verifier,restart,core:restart(),receipt,
    setResponse(value:typeof response){response=value;}};
}
describe('SUNAT-owned opt-in RC/RA immutable local originals',()=>{
  it.each(['RC','RA'] as const)('rebuilds complete persisted %s command, signs and archives exact request ZIP',async kind=>{
    const f=fixture(kind),before=structuredClone(f.owned),result=await f.core.prepare(f.scope,ACCESS),m=result.record.metadata;
    expect(m).toMatchObject({kind,signatureVerifiedLocally:true,certificateTrusted:false,officialCdrVerified:false,transmissionAuthorized:false});
    expect(m.commandSha256).toBe(hash(f.owned.command));expect(m.operationId).toBe(f.scope.batchId);
    expect(result.record.signedXml).toContain(kind==='RC'?'SummaryDocuments':'VoidedDocuments');
    const files=unzipSync(result.record.zip);expect(Object.keys(files)).toEqual([m.fileName.replace('.zip','.xml')]);
    expect(Buffer.from(Object.values(files)[0]).toString('utf8')).toBe(result.record.signedXml);
    expect(f.owned).toEqual(before);expect(f.state.writes).toBe(1);expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(f.keyCopies.every(bytes=>bytes.every(b=>b===0))).toBe(true);
  });
  it('parallel replay and restart retain exact original bytes without signing twice',async()=>{
    const f=fixture(),results=await Promise.all([f.core.prepare(f.scope,ACCESS),f.core.prepare(f.scope,ACCESS)]);
    expect(results.map(r=>r.replayed)).toEqual([false,true]);expect(f.signer.prepare).toHaveBeenCalledTimes(1);
    expect((await f.restart().read(f.scope,ACCESS)).record.zip).toEqual(results[0].record.zip);expect(f.state.writes).toBe(1);
  });
  it('READ never creates files, loads keys or invents a missing CDR',async()=>{
    const f=fixture();await expect(f.core.read(f.scope,ACCESS)).rejects.toThrow('NOT_PREPARED');
    await expect(f.core.readCdr(f.scope,ACCESS)).rejects.toThrow('NOT_PREPARED');expect(f.signer.prepare).not.toHaveBeenCalled();
    await f.core.prepare(f.scope,ACCESS);await expect(f.core.readCdr(f.scope,ACCESS)).rejects.toThrow('CDR_NOT_FOUND');
    expect(f.state.cdr).toBeNull();
  });
  it('uses independent READ and WRITE authority on every call',async()=>{
    const f=fixture();f.controls.allowWrite=false;
    await expect(f.core.prepare(f.scope,ACCESS)).rejects.toThrow('OWNER_UNAVAILABLE');expect(f.signer.prepare).not.toHaveBeenCalled();
    f.controls.allowWrite=true;await f.core.prepare(f.scope,ACCESS);f.controls.allowRead=false;
    await expect(f.core.read(f.scope,ACCESS)).rejects.toThrow('OWNER_UNAVAILABLE');
  });
  it.each(['signed','inserted'] as const)('rollback when permission is revoked at %s fence',async phase=>{
    const f=fixture();f.hooks[phase]=()=>{f.controls.revoked=true;};
    await expect(f.core.prepare(f.scope,ACCESS)).rejects.toThrow('OWNER_UNAVAILABLE');expect(f.state.record).toBeNull();expect(f.state.writes).toBe(0);
  });
  it('all-member grant/catalogue fence changes cannot bless a package in flight',async()=>{
    const f=fixture();f.hooks.signed=()=>{f.owned.authorizationSha256='b'.repeat(64);};
    await expect(f.core.prepare(f.scope,ACCESS)).rejects.toThrow('OWNER_CHANGED');expect(f.state.record).toBeNull();
  });
  it.each(['signedXml','zip','metadata','certificatePem','unsignedXml'] as const)('authenticates stored %s on read',async field=>{
    const f=fixture();await f.core.prepare(f.scope,ACCESS);const r=f.state.record!;
    if(field==='signedXml')r.signedXml=r.signedXml.replace('BIEN FICTICIO','ALTERADO');
    if(field==='unsignedXml')r.unsignedXml+=' ';
    if(field==='zip')r.zip[50]^=1;
    if(field==='metadata')r.metadata.commandSha256='f'.repeat(64);
    if(field==='certificatePem')r.certificatePem=pki.otherIssuer.certificatePem;
    // RC may not include the item description, so corrupt a definitely-present identity.
    if(field==='signedXml')r.signedXml=r.signedXml.replace('RC-20261003-1','RC-20261003-2');
    await expect(f.core.read(f.scope,ACCESS)).rejects.toThrow('INTEGRITY_FAILED');
  });
  it('caller cannot replace command or accept an arbitrary XML even with recomputed checksums',async()=>{
    const f=fixture();await f.core.prepare(f.scope,ACCESS);
    const e=structuredClone(f.owned.command.payload.envelope);if(e.kind!=='BATCH')throw new Error();
    e.batch.identifier='RC-20261003-2';
    f.owned.command=buildFiscalSupplementCommand(e,{eventId:f.owned.command.eventId,correlationId:f.owned.command.correlationId,occurredAt:f.owned.command.occurredAt});
    await expect(f.core.read(f.scope,ACCESS)).rejects.toThrow('INTEGRITY_FAILED');
  });
  it('buffers returned to the caller cannot change stored originals',async()=>{
    const f=fixture(),r=await f.core.prepare(f.scope,ACCESS),bytes=Buffer.from(r.record.zip);r.record.zip.fill(0);r.record.metadata.kind='RA';
    expect((await f.core.read(f.scope,ACCESS)).record.zip).toEqual(bytes);
  });
  it.each(['RC','RA'] as const)('captures and revalidates original %s CDR without promoting member acceptance',async kind=>{
    const f=fixture(kind);await f.core.prepare(f.scope,ACCESS);const zip=f.receipt();
    const cdr=await f.core.captureCdr(f.scope,ACCESS);expect(cdr.zip).toEqual(zip);
    expect(cdr.evidence).toMatchObject({source:'LOCAL_EMULATOR',status:'ACCEPTED',memberAcceptanceGranted:false,requestHashesBoundByCdr:false,officialCdrVerified:false});
    expect(cdr.zip).not.toEqual(f.state.record!.zip);expect((await f.restart().readCdr(f.scope,ACCESS)).zip).toEqual(zip);
    await f.core.captureCdr(f.scope,ACCESS);expect(f.state.cdrWrites).toBe(1);expect(f.verifier.verify).toHaveBeenCalledTimes(3);
  });
  it.each([['2000',false,'REJECTED'],['0',true,'ACCEPTED_WITH_OBSERVATIONS']] as const)('stores authenticated response %s as %s',async(code,observed,status)=>{
    const f=fixture();await f.core.prepare(f.scope,ACCESS);f.receipt(code,observed);
    expect((await f.core.captureCdr(f.scope,ACCESS)).evidence.status).toBe(status);
  });
  it('conflicting CDR cannot overwrite the first original',async()=>{
    const f=fixture();await f.core.prepare(f.scope,ACCESS);const first=f.receipt();await f.core.captureCdr(f.scope,ACCESS);f.receipt('2000');
    await expect(f.core.captureCdr(f.scope,ACCESS)).rejects.toThrow('CDR_CONFLICT');expect(f.state.cdr!.zip).toEqual(first);
  });
  it('no private CDR means no generated receipt',async()=>{
    const f=fixture();await f.core.prepare(f.scope,ACCESS);
    await expect(f.core.captureCdr(f.scope,ACCESS)).rejects.toThrow('CDR_NOT_FOUND');expect(f.state.cdrWrites).toBe(0);
  });
  it('rejects an untrusted or modified CDR signature',async()=>{
    const f=fixture();await f.core.prepare(f.scope,ACCESS);f.receipt();f.verifier.verify.mockResolvedValue(false);
    await expect(f.core.captureCdr(f.scope,ACCESS)).rejects.toThrow('CDR_UNTRUSTED');expect(f.state.cdr).toBeNull();
  });
  it('same authenticated CDR bytes cannot be relabelled as official provenance',async()=>{
    const f=fixture();await f.core.prepare(f.scope,ACCESS);const zip=f.receipt();
    f.setResponse({source:'OFFICIAL' as any,zip,receivedAt:'2026-10-03T19:00:00Z'});
    await expect(f.core.captureCdr(f.scope,ACCESS)).rejects.toThrow('CDR_INVALID');
  });
  it('CDR identity substitution, duplicate references and malicious ZIP are blocked',async()=>{
    const f=fixture();await f.core.prepare(f.scope,ACCESS);
    for(const xml of [cdrXml('RC-20261003-2','RC',f.scope.issuerRuc),cdrXml(f.data.batch!.identifier,'RA',f.scope.issuerRuc),
      cdrXml(f.data.batch!.identifier,'RC',f.scope.issuerRuc).replace('<cbc:ReferenceID>','<cbc:ReferenceID>DUPLICATE</cbc:ReferenceID><cbc:ReferenceID>')]){
      f.setResponse({source:'LOCAL_EMULATOR',receivedAt:'2026-10-03T19:00:00Z',zip:Buffer.from(zipSync({[`R-${f.scope.issuerRuc}-${f.data.batch!.identifier}.xml`]:Buffer.from(pki.signCdr(xml))}))});
      await expect(f.core.captureCdr(f.scope,ACCESS)).rejects.toThrow('CDR_INVALID');
    }
    const zip=f.receipt();zip[35]^=1;await expect(f.core.captureCdr(f.scope,ACCESS)).rejects.toThrow();expect(f.state.cdr).toBeNull();
  });
  it('owner CDR changing while signature verification awaits rolls back',async()=>{
    const f=fixture();await f.core.prepare(f.scope,ACCESS);f.receipt();
    f.verifier.verify.mockImplementationOnce(async bytes=>{const ok=await pki.cdrVerifier.verify(bytes);f.receipt('2000');return ok;});
    await expect(f.core.captureCdr(f.scope,ACCESS)).rejects.toThrow('OWNER_CHANGED');expect(f.state.cdr).toBeNull();
  });
  it('corrupt archived CDR evidence is revalidated, not trusted as an accepted flag',async()=>{
    const f=fixture();await f.core.prepare(f.scope,ACCESS);f.receipt();await f.core.captureCdr(f.scope,ACCESS);
    f.state.cdr!.evidence.officialCdrVerified=true as any;
    await expect(f.core.readCdr(f.scope,ACCESS)).rejects.toThrow('INTEGRITY_FAILED');
  });
  it('finite errors hide SQL, secrets and paths',async()=>{
    const f=fixture();f.controls.failAfterInsert=true;
    await expect(f.core.prepare(f.scope,ACCESS)).rejects.toThrow('BATCH_LOCAL_ARTIFACT_STORE_UNAVAILABLE');expect(f.state.record).toBeNull();
  });
  it('denies unknown RUC before contacting keys or owner',async()=>{
    const f=fixture(),core=new BatchLocalArtifactPipeline(f.owner,f.store,f.signer,['20131312955']);
    await expect(core.prepare(f.scope,ACCESS)).rejects.toThrow('RUC_NOT_ALLOWED');expect(f.owner.current).not.toHaveBeenCalled();expect(f.keys.acquire).not.toHaveBeenCalled();
  });
  it('rejects another key purpose and always disposes acquired private material',async()=>{
    const f=fixture(),bytes=Buffer.from(pki.issuer.pkcs12),dispose=vi.fn(async()=>{});
    const signer=createBatchLocalSigner({acquire:async()=>({ruc:f.scope.issuerRuc,purpose:'PRODUCTION' as any,
      p12:bytes,password:pki.password,certificatePem:pki.issuer.certificatePem,dispose})});
    const core=new BatchLocalArtifactPipeline(f.owner,f.store,signer,[f.scope.issuerRuc]);
    await expect(core.prepare(f.scope,ACCESS)).rejects.toThrow('KEY_POLICY_REQUIRED');
    expect(dispose).toHaveBeenCalledTimes(1);expect(bytes.every(b=>b===0)).toBe(true);expect(f.state.record).toBeNull();
  });
  it('strict local signer mode is mandatory even before key access',()=>{
    const f=fixture();expect(()=>new BatchLocalArtifactPipeline(f.owner,f.store,{...f.signer,mode:'PRODUCTION' as any},[f.scope.issuerRuc])).toThrow('POLICY_REQUIRED');
    expect(f.keys.acquire).not.toHaveBeenCalled();
  });
  it('CDR timestamp inversions and wrong-namespace optional dates cannot bypass validation',async()=>{
    const f=fixture();await f.core.prepare(f.scope,ACCESS);
    const base=cdrXml(f.data.batch!.identifier,'RC',f.scope.issuerRuc);
    for(const xml of [base.replace('</cbc:IssueDate>','</cbc:IssueDate><cbc:IssueTime>13:30:00-05:00</cbc:IssueTime><cbc:ResponseDate>2026-10-03</cbc:ResponseDate><cbc:ResponseTime>13:29:00-05:00</cbc:ResponseTime>'),
      base.replace('</cbc:IssueDate>','</cbc:IssueDate><wrong:ResponseDate xmlns:wrong="urn:wrong">2026-10-03</wrong:ResponseDate>')]){
      f.setResponse({source:'LOCAL_EMULATOR',receivedAt:'2026-10-03T19:00:00Z',zip:Buffer.from(zipSync({[`R-${f.scope.issuerRuc}-${f.data.batch!.identifier}.xml`]:Buffer.from(pki.signCdr(xml))}))});
      await expect(f.core.captureCdr(f.scope,ACCESS)).rejects.toThrow('CDR_INVALID');
    }
    expect(f.state.cdr).toBeNull();
  });
  it('rejects production, accessors, extra public command and malformed scopes',()=>{
    const f=fixture();for(const s of [{...f.scope,environment:'PRODUCTION'},{...f.scope,command:f.owned.command},{...f.scope,batchId:'bad'},
      {...f.scope,get issuerRuc(){throw new Error('SHOULD_NOT_RUN');}}])expect(()=>validateBatchLocalArtifactScope(s)).toThrow('INVALID_SCOPE');
  });
});

// Explicit opt-in runner only; no implicit DB URLs, skips or existing database access.
if(process.env.FACTUEZ_BATCH_LOCAL_ARTIFACT_DB==='NEW_NETWORK_NONE_TMPFS_ONLY'){
  describe('new isolated PostgreSQL + actual persisted owner commands + ephemeral crypto',()=>{
    it('RC/RA durable owner → SUNAT immutable originals → original CDR; replay, revocation, constraints and rollback',async()=>{
      const local=createRequire(import.meta.url),{withCorrectionDatabase}=local('./helpers/correction-reservation-db.cjs');
      for(const kind of ['RC','RA'] as const)await withCorrectionDatabase(async({pool,client}:any)=>{
        await pool.query(readFileSync(new URL('../services/billing-service/b2b-batch-member-schema.candidate.sql',import.meta.url),'utf8'));
        await pool.query(readFileSync(new URL('../services/sunat-service/batch-local-artifacts-schema.candidate.sql',import.meta.url),'utf8'));
          const f=fixture(kind),source=await batchMemberEvidenceFixture(pki,kind==='RC'?'03':'01',{unreported:kind==='RC'});
          const who={kind:'SERVICE' as const,clientId:randomUUID(),subjectId:null},now=()=>new Date().toISOString(),adminId=randomUUID();
          const owner=new PostgresBatchMemberOwner(pool,source.adapter,
            {current:async(subject:any)=>({subject,clientRevision:1,userAuthRevision:null,checkedAt:now()})},
            {authorizeStepUp:async(_handle:string,policySha256:string)=>({adminId,authRevision:1,policySha256,checkedAt:now()})},now);
          // Distinct synthetic identities avoid collision between RC and RA member fixtures.
          source.record.binding.pointId=randomUUID();source.record.binding.seriesId=randomUUID();
          const member=await owner.importVerifiedVersion('synthetic-owned-member');
          const binding=source.record.binding;
          await owner.setLocalGrant('synthetic-local-owner-step-up',{subject:who,binding,kind,permission:'WRITE',clientRevision:1,userAuthRevision:null,active:true,expectedRevision:0});
          await owner.setLocalGrant('synthetic-local-owner-step-up',{subject:who,binding,kind,permission:'READ',clientRevision:1,userAuthRevision:null,active:true,expectedRevision:0});
          const scope={environment:'BETA' as const,issuerRuc:binding.issuerRuc,companyId:binding.companyId,branchId:binding.branchId};
          const request={schemaVersion:'factuez.b2b.batch-members.v1',kind,scope,idempotencyKey:'synthetic-local-artifact-'+randomUUID(),asOf:now(),
            issueDate:'2026-10-03',referenceDate:'2026-10-02',entries:kind==='RC'?[{member,conditionCode:'1'}]:[{member,reasonDescription:'BAJA FICTICIA'}]};
          if(kind==='RA'){
            source.record.notDelivered={status:'NOT_DELIVERED',documentId:source.record.snapshot.documentId,documentTypeCode:'01',fullNumber:source.record.snapshot.fullNumber,
              issuerRuc:binding.issuerRuc,snapshotSha256:member.snapshotSha256,evidenceId:randomUUID(),assertedAt:'2026-10-03T16:00:00Z'};
            // Evidence attached after import is a new owned version, not mutation of an immutable row.
            request.entries[0].member=await owner.importVerifiedVersion('synthetic-owned-member-not-delivered');
          }
          const producer=createDurableBatchMemberProducer(owner,now),result=await producer.coordinate(await producer.plan(request,who),'CREATE');
          const persisted=result.journal.command,s={...scope,batchId:persisted.payload.operationId};
          const privateOwner={current:async(input:any,_access:any,permission:'READ'|'WRITE')=>{
            const rows=(await pool.query('SELECT command FROM b2b_batch_member_command WHERE batch_id=$1',[input.batchId])).rows;
            if(rows.length!==1)throw new Error('NOT_FOUND');
            const marks=[];
            for(const mark of (await producer.plan({...request,asOf:now()},who)).members){
              const current=await owner.member(mark.record.member);if(!current)throw new Error('NOT_FOUND');
              const grant=await owner.authorize(who,current,permission,kind);const {checkedAt,...stable}=grant;marks.push({record:current,grant:stable});
            }
            return {command:rows[0].command,authorizationSha256:hash(marks)};
          }};
          const store=new PostgresBatchLocalArtifactStore(client),core=new BatchLocalArtifactPipeline(privateOwner,store,f.signer,[scope.issuerRuc],f.source,f.verifier);
          const first=await core.prepare(s,ACCESS),again=await core.prepare(s,ACCESS);expect(again.replayed).toBe(true);expect(again.record.zip).toEqual(first.record.zip);
          const metadata=first.record.metadata;
          const xml=pki.signCdr(cdrXml(metadata.identifier,kind,scope.issuerRuc));
          const zip=Buffer.from(zipSync({['R-'+metadata.fileName.replace('.zip','.xml')]:Buffer.from(xml)}));
          f.setResponse({source:'LOCAL_EMULATOR',zip,receivedAt:now()});
          expect((await core.captureCdr(s,ACCESS)).zip).toEqual(zip);expect((await core.readCdr(s,ACCESS)).zip).toEqual(zip);
          await expect(pool.query('UPDATE "BatchLocalArtifact" SET "identifier"="identifier" WHERE "batchId"=$1',[s.batchId])).rejects.toMatchObject({code:'23514'});
          await expect(pool.query('DELETE FROM "BatchLocalCdr" WHERE "batchId"=$1',[s.batchId])).rejects.toMatchObject({code:'23514'});
          await expect(pool.query('TRUNCATE TABLE "BatchLocalCdr"')).rejects.toMatchObject({code:'23514'});
          const r=first.record,m={...r.metadata,zipSha256:'a'.repeat(64),eventId:randomUUID(),operationId:randomUUID(),scope:{...s,batchId:randomUUID()}};
          // Real constraints, never disabled, reject wrong hashes and public provenance.
          m.operationId=m.scope.batchId;
          await expect(pool.query(`INSERT INTO "BatchLocalArtifact" ("batchId","eventId","commandSha256","issuerRuc","identifier","metadata","metadataSha256","unsignedXml","signedXml","zip","certificatePem")
            VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,[m.scope.batchId,m.eventId,m.commandSha256,s.issuerRuc,m.identifier,JSON.stringify(m),hash(m),
            Buffer.from(r.unsignedXml),Buffer.from(r.signedXml),r.zip,r.certificatePem])).rejects.toMatchObject({code:'23514'});
          let escaped:any;
          await store.transaction(s,async tx=>{escaped=tx;return null;});
          await expect(escaped.read()).rejects.toThrow('STORE_UNAVAILABLE');
          await owner.setLocalGrant('synthetic-local-owner-step-up',{subject:who,binding,kind,permission:'READ',clientRevision:1,
            userAuthRevision:null,active:false,expectedRevision:1});
          await expect(core.read(s,ACCESS)).rejects.toThrow('OWNER_UNAVAILABLE');
        expect((await pool.query('SELECT count(*)::int n FROM "BatchLocalArtifact"')).rows[0].n).toBe(1);
        expect((await pool.query('SELECT count(*)::int n FROM "BatchLocalCdr"')).rows[0].n).toBe(1);
        expect((await pool.query('SELECT count(*)::int n FROM b2b_batch_member_command')).rows[0].n).toBe(1);
      });
    },180000);
  });
}
