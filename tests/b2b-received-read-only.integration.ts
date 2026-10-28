import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';import {createRequire} from 'node:module';
import {B2bReceptionReadOnlyDispatch,receptionConfigurationHash} from '../services/received-documents-service/src/b2b/automation-read-only';
import {FixedReceptionReadOnlyAdmission,ServiceReceptionDispatchAuthority} from '../services/received-documents-service/src/b2b/automation-read-only.authority';
import {PostgresReceptionWriteAuthority} from '../services/received-documents-service/src/b2b/write-authority';
import {mailAttachments,mailboxFingerprint} from '../services/received-documents-service/src/automation/mailbox';
import {fixtureMail} from '../services/received-documents-service/src/automation/mail-fixture';
import {fixtureSirePurchases} from '../services/received-documents-service/src/automation/sire-fixture';
import {emptyCounters} from '../services/received-documents-service/src/automation/policy';
import {fixture,scope as template,liveSettings,stepUpHandle,id} from './helpers/b2b-received-automation.fixture';
import type {ReadOnlyReceptionSource,ReadOnlyReceptionBatch,ReadOnlyReceptionSnapshot} from '../services/received-documents-service/src/b2b/automation-read-only.types';
import {PostgresReportsCorrectionReadAuthority} from '../services/billing-service/src/b2b/phase8-reports/correction-read-authority';
const {withReceivedReadOnlyDatabase}=createRequire(import.meta.url)('./helpers/b2b-received-read-only-db.cjs');
let db:any,pool:any,reportsPool:any,release:()=>void,done:Promise<void>,f:ReturnType<typeof fixture>,scope:typeof template,settings:ReturnType<typeof liveSettings>,writes:PostgresReceptionWriteAuthority,seq=0;
const key=()=>`read_only_synthetic_${++seq}`,snapshots:ReadOnlyReceptionSnapshot[]=[];
const tableCount=async(table:string)=>Number((await pool.query(`SELECT count(*)::integer AS n FROM "${table}"`)).rows[0].n);
const row=(id:string)=>db.receptionSyncRun.findUniqueOrThrow({where:{id}});
const state=()=>Promise.all(['ReceivedDocument','ReceivedItemRecord','ReceivedArtifact','B2bReceivedCommand','B2bReceivedReadOnlyObservation','B2bReceivedReadOnlyCursor'].map(tableCount));
const request=(action:'CONFIG_SAVE'|'SYNC_CREATE',payload:any)=>f.owner.execute({token:'synthetic-access',kind:f.principal.kind},action,{scope,key:key(),payload:{...payload,...(f.principal.kind==='USER'?{stepUpHandle}:{})}}) as Promise<any>;
const queue=async(source:'MAIL'|'SIRE'='MAIL')=>(await request('SYNC_CREATE',{source,expectedRevision:1})).items[0].runId as string;
const grant=async(action:'IMPORT'|'ATTACH')=>writes.setGrant('synthetic-enrollment',{scope,subject:{kind:f.principal.kind,clientId:f.principal.clientId,subjectId:f.principal.subjectId},action,clientRevision:f.principal.revision,userAuthRevision:f.principal.userAuthRevision,active:true},0);
const countFor=async(table:string,id:string)=>Number((await pool.query(`SELECT count(*)::integer AS n FROM "${table}" WHERE "runId"=$1::uuid`,[id])).rows[0].n);
const source:ReadOnlyReceptionSource={read:vi.fn(async(s,check)=>{await check();snapshots.push(s);
 if(s.context.source==='SIRE')return {documents:[],incidents:[],cursor:null,purchases:s.periods.flatMap(p=>fixtureSirePurchases(s.context.scope.recipientRuc,p))};
 const documents=[];for(const period of s.periods){const [file]=await mailAttachments(fixtureMail(s.context.scope.recipientRuc,period));documents.push({file:{fileName:file.fileName,contentBase64:file.bytes.toString('base64')},artifacts:[]});}
 await check();return {documents,purchases:[],incidents:[],cursor:{fingerprint:mailboxFingerprint(s.settings.mailbox),uidValidity:'1',lastUid:String(Number(s.cursor?.lastUid??0)+1)}};
})};
function core(changes:{source?:ReadOnlyReceptionSource;admission?:any;executionAuthority?:any;database?:any}={}){
 const admission=changes.admission??new FixedReceptionReadOnlyAdmission([{scope,connectionRevision:1,configurationSha256:receptionConfigurationHash(scope,1,settings),approvalId:id(98),approvalRevision:1,sources:['MAIL','SIRE'],approvedImapHosts:['imap.example.com']}]);
 return new B2bReceptionReadOnlyDispatch(changes.database??db,f.identity,f.authority,writes,changes.source??source,{enabled:true,admission,executionAuthority:changes.executionAuthority??new ServiceReceptionDispatchAuthority(f.identity,async()=>({kind:'SERVICE',token:'synthetic-fresh-service'}))});
}
beforeAll(async()=>{
 vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('OFFICIAL_NETWORK_FORBIDDEN');}));let ready!:()=>void,reject!:(e:unknown)=>void;
 const initialized=new Promise<void>((a,b)=>{ready=a;reject=b;}),finished=new Promise<void>(r=>{release=r;});
 done=withReceivedReadOnlyDatabase(async(c:any)=>{db=c.client;pool=c.pool;reportsPool=c.reportsPool;ready();await finished;});void done.catch(reject);await initialized;
},120000);
afterAll(async()=>{release?.();await done;expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();},120000);
beforeEach(async()=>{
 snapshots.length=0;vi.mocked(source.read).mockClear();const companyId=500+ ++seq;scope={...template,companyId,recipientRuc:`00${String(companyId).padStart(9,'0')}`,branchId:randomUUID()};
 f=fixture(db,{networkProfile:'LIVE_READ_ONLY',approvedImapHosts:['imap.example.com']});
 f.principal.bindings=[{issuerId:companyId,issuerRuc:scope.recipientRuc,environment:'BETA',branchId:scope.branchId,pointId:id(6),seriesId:id(7),documentType:'01'}];
 settings=liveSettings();settings.sire.startPeriod='202001';
 await f.grant('CONFIG_SAVE',scope);await f.grant('LIVE_READ_ONLY',scope);
 await request('CONFIG_SAVE',{expectedRevision:0,settings,credentials:{mailPassword:'SYNTHETIC-MAIL',sireClientSecret:'SYNTHETIC-CLIENT',solPassword:'SYNTHETIC-SOL'}});
 f.principal.kind='SERVICE';f.principal.clientId=randomUUID();f.principal.subjectId=null;f.principal.userAuthRevision=null;f.principal.scopes.push('b2b:received:write');
 for(const action of ['SYNC_CREATE','SYNC_EXECUTE','SYNC_READ','LIVE_READ_ONLY'] as const)await f.grant(action,scope);
 writes=new PostgresReceptionWriteAuthority(db,f.enrollment);await grant('IMPORT');await grant('ATTACH');
});
describe('READ_ONLY protocol on NEW owned network-none tmpfs PG; fake remote source only',()=>{
 it('commits complete MAIL originals/items and cursor, replays without duplicating or reading again',async()=>{
  const id=await queue(),owner=core(),before=await state();expect(await owner.run(id)).toEqual({runId:id,status:'COMPLETED'});
  expect(await row(id)).toMatchObject({status:'COMPLETED',counters:{...emptyCounters(),detected:3,imported:3}});
  expect(await state()).toEqual(before.map((n,i)=>n+([0,1,2,3].includes(i)?3:i===5?1:0)));
  expect(await countFor('B2bReceivedReadOnlyAttempt',id)).toBe(1);expect(snapshots).toHaveLength(1);
  expect(await owner.run(id)).toEqual({runId:id,status:'COMPLETED'});expect(snapshots).toHaveLength(1);
  const next=await queue();expect(await owner.run(next)).toMatchObject({status:'COMPLETED'});expect(snapshots.at(-1)?.cursor?.lastUid).toBe('1');
  expect((await row(next)).counters).toMatchObject({detected:3,imported:0,duplicate:3});
 });
 it('SIRE persists scoped observations with XML_PENDING, then MAIL reconciles without fabricated XML from SIRE',async()=>{
  const id=await queue('SIRE'),owner=core(),before=await state();expect(await owner.run(id)).toMatchObject({status:'COMPLETED'});
  expect((await row(id)).counters).toEqual({...emptyCounters(),detected:3,xmlPending:3});expect((await state()).slice(0,4)).toEqual(before.slice(0,4));
  const mail=await queue('MAIL');expect(await owner.run(mail)).toMatchObject({status:'COMPLETED'});expect((await row(mail)).counters).toMatchObject({matches:3,xmlPending:0});
 });
 it('rejects a changed deployment approval before the source or vault can run',async()=>{
  const id=await queue(),before=await state();const wrong=new FixedReceptionReadOnlyAdmission([{scope,connectionRevision:1,configurationSha256:'f'.repeat(64),approvalId:idForApproval(),approvalRevision:1,sources:['MAIL'],approvedImapHosts:['imap.example.com']}]);
  expect(await core({admission:wrong}).run(id)).toMatchObject({status:'BLOCKED'});expect(source.read).not.toHaveBeenCalled();expect(await state()).toEqual(before);
 });
 it('revocation during a remote read discards the batch and leaves the cursor unchanged',async()=>{
  const id=await queue(),before=await state();const revoked={read:async(s:ReadOnlyReceptionSnapshot,check:()=>Promise<void>)=>{const b=await source.read(s,check);await f.grant('SYNC_EXECUTE',scope,1,false);return b;}};
  expect(await core({source:revoked}).run(id)).toMatchObject({status:'BLOCKED'});expect(await state()).toEqual(before);
 });
 it('configuration change during the read cannot commit into the new revision',async()=>{
  const id=await queue(),before=await state();const changed={read:async(s:ReadOnlyReceptionSnapshot,check:()=>Promise<void>)=>{const b=await source.read(s,check);
   const updated=await pool.query('UPDATE "ReceptionSyncRun" SET "status"=\'BLOCKED\',"activeKey"=NULL,"errorCode"=\'CONFIGURATION_CHANGED\',"finishedAt"=now() WHERE "id"=$1::uuid',[id]);expect(updated.rowCount).toBe(1);return b;}};
  expect(await core({source:changed}).run(id)).toMatchObject({status:'BLOCKED'});expect(await state()).toEqual(before);
 });
 it('three transient reads fail durably, never consuming a mailbox UID or importing a partial document',async()=>{
  const id=await queue(),before=await state(),bad={read:vi.fn(async()=>{throw new Error('SYNTHETIC_PRIVATE_NETWORK_ERROR');})},owner=core({source:bad});
  for(let attempt=1;attempt<=2;attempt++)await expect(owner.run(id)).rejects.toMatchObject({code:'RECEIVED_DISPATCH_RETRY'});
  expect(await owner.run(id)).toMatchObject({status:'FAILED'});expect(await countFor('B2bReceivedReadOnlyAttempt',id)).toBe(3);expect(await state()).toEqual(before);
  expect(JSON.stringify((await pool.query('SELECT "errorCode" FROM "B2bReceivedReadOnlyAttempt" WHERE "runId"=$1::uuid',[id])).rows)).not.toContain('PRIVATE');
 });
 it('rejects mismatched recipient XML atomically',async()=>{
  const id=await queue(),before=await state(),bad={read:async(s:ReadOnlyReceptionSnapshot,check:()=>Promise<void>)=>{const b=await source.read(s,check);const d=b.documents[0];d.file.contentBase64=Buffer.from(Buffer.from(d.file.contentBase64,'base64').toString().replaceAll(scope.recipientRuc,'00000000999')).toString('base64');return b;}};
  expect(await core({source:bad}).run(id)).toMatchObject({status:'BLOCKED'});expect(await state()).toEqual(before);
 });
 it('attaches the original provider PDF through its separate current ATTACH grant',async()=>{
  const id=await queue(),withPdf={read:async(s:ReadOnlyReceptionSnapshot,check:()=>Promise<void>)=>{
   const b=await source.read(s,check);b.documents[0].artifacts.push({kind:'PROVIDER_PDF',file:{fileName:'synthetic-provider.pdf',contentBase64:Buffer.from('%PDF-SYNTHETIC PROVIDER ORIGINAL').toString('base64')}});return b;
  }};expect(await core({source:withPdf}).run(id)).toMatchObject({status:'COMPLETED'});
  const rows=(await pool.query('SELECT a."bytes",a."kind" FROM "ReceivedArtifact" a JOIN "ReceivedDocument" d ON d."id"=a."documentId" WHERE d."companyId"=$1 AND a."kind"=\'PROVIDER_PDF\'',[scope.companyId])).rows;
  expect(rows).toHaveLength(1);expect(Buffer.from(rows[0].bytes).toString()).toBe('%PDF-SYNTHETIC PROVIDER ORIGINAL');
 });
 it('a lost ATTACH grant prevents both attachment and the partial XML/cursor commit',async()=>{
  const id=await queue(),before=await state(),withPdf={read:async(s:ReadOnlyReceptionSnapshot,check:()=>Promise<void>)=>{
   const b=await source.read(s,check);b.documents[0].artifacts.push({kind:'PROVIDER_PDF',file:{fileName:'synthetic-provider.pdf',contentBase64:Buffer.from('%PDF-SYNTHETIC').toString('base64')}});
   await writes.setGrant('synthetic-enrollment',{scope,subject:{kind:f.principal.kind,clientId:f.principal.clientId,subjectId:null},action:'ATTACH',clientRevision:1,userAuthRevision:null,active:false},1);return b;
  }};expect(await core({source:withPdf}).run(id)).toMatchObject({status:'BLOCKED'});expect(await state()).toEqual(before);
 });
 it('a failure after a real import journal rolls all originals and the checkpoint back before retry',async()=>{
  const id=await queue(),before=await state();let failed=false;
  const wrapped={$transaction:(work:any,options:any)=>db.$transaction((tx:any)=>work({$queryRawUnsafe:tx.$queryRawUnsafe.bind(tx),$executeRawUnsafe:async(sql:string,...values:any[])=>{
   const n=await tx.$executeRawUnsafe(sql,...values);if(!failed&&sql.startsWith('INSERT INTO "B2bReceivedCommand"')){failed=true;throw new Error('SYNTHETIC_PRIVATE_SQL_FAILURE');}return n;
  }}),options)};
  await expect(core({database:wrapped}).run(id)).rejects.toMatchObject({code:'RECEIVED_DISPATCH_RETRY'});expect(await state()).toEqual(before);
  expect(await core().run(id)).toMatchObject({status:'COMPLETED'});expect((await row(id)).counters).toMatchObject({imported:3,duplicate:0});
 });
 it('holds no owner SQL transaction during the remote read',async()=>{
  const id=await queue(),observed={read:async(s:ReadOnlyReceptionSnapshot,check:()=>Promise<void>)=>{
   const c=await pool.connect();try{await c.query('BEGIN');const lock=await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`received-automation/company/${scope.companyId}`]);expect(lock.rows[0].locked).toBe(true);await c.query('ROLLBACK');}finally{c.release();}
   return source.read(s,check);
  }};expect(await core({source:observed}).run(id)).toMatchObject({status:'COMPLETED'});
 });
 it('keeps attempt/incident/observation evidence immutable and all emission sentinels untouched',async()=>{
  const id=await queue('SIRE');await core().run(id);
  for(const table of ['B2bReceivedReadOnlyAttempt','B2bReceivedReadOnlyObservation','B2bReceivedReadOnlyIncident'])await expect(pool.query(`DELETE FROM "${table}" WHERE "runId"=$1::uuid`,[id])).rejects.toMatchObject({code:'23514'});
  for(const table of ['Document','OutboxEvent','SeriesCounter','ReceptionSirePurchase'])expect(await tableCount(table)).toBe(0);
 });
});
function idForApproval(){return randomUUID();}
describe('Billing correction READ enrollment on its separate NEW synthetic database',()=>{
 function setup(){
  f.principal.scopes.push('b2b:reports:read','b2b:documents:read','b2b:corrections:read');
  const binding={reference:structuredClone(f.principal.bindings[0]),noteType:'07' as const,noteSeriesId:id(88)};
  const policy={binding,subject:{kind:'SERVICE' as const,clientId:f.principal.clientId,subjectId:null},clientRevision:1,userAuthRevision:null,active:true};
  const owner=new PostgresReportsCorrectionReadAuthority(reportsPool,f.identity,f.enrollment);
  return {binding,policy,owner};
 }
 it('requires independently enrolled READ, persists a hashed audit and exposes no write/issue capability',async()=>{
  const {binding,policy,owner}=setup();await expect(owner.current('synthetic-token','SERVICE',binding)).rejects.toMatchObject({status:403});
  expect(await owner.setGrant('synthetic-enrollment',policy,0)).toEqual({revision:1,active:true});
  expect(await owner.current('synthetic-token','SERVICE',binding)).toMatchObject({action:'READ',binding,clientRevision:1,grantRevision:1,actor:{kind:'SERVICE',subjectId:null,userAuthRevision:null}});
  const audit=(await reportsPool.query('SELECT "revision","policySha256","requestSha256" FROM "B2bReportsCorrectionReadAudit"')).rows.at(-1);expect(audit.revision).toBe(1);expect(audit.policySha256).toMatch(/^[a-f0-9]{64}$/);
 });
 it('does not inherit READ from a write scope or a policy on another note series/RUC',async()=>{
  const {binding,policy,owner}=setup();await owner.setGrant('synthetic-enrollment',policy,0);
  await expect(owner.current('synthetic-token','SERVICE',{...binding,noteSeriesId:id(89)})).rejects.toMatchObject({status:403});
  f.principal.scopes=f.principal.scopes.filter(s=>s!=='b2b:corrections:read');f.principal.scopes.push('b2b:corrections:write');
  await expect(owner.current('synthetic-token','SERVICE',binding)).rejects.toMatchObject({status:403});
 });
 it('revokes by CAS without erasing grant or audit history',async()=>{
  const {binding,policy,owner}=setup();await owner.setGrant('synthetic-enrollment',policy,0);
  await expect(owner.setGrant('synthetic-enrollment',policy,0)).rejects.toMatchObject({status:409});
  expect(await owner.setGrant('synthetic-enrollment',{...policy,active:false},1)).toEqual({revision:2,active:false});
  await expect(owner.current('synthetic-token','SERVICE',binding)).rejects.toMatchObject({status:403});
  await expect(reportsPool.query('DELETE FROM "B2bReportsCorrectionReadAudit"')).rejects.toMatchObject({code:'23514'});
 });
 it('step-up changes roll enrollment back and enrollment is disabled without the owner administrator port',async()=>{
  const {binding,policy}=setup();let calls=0;
  const admin={authorize:async(_h:string,digest:string)=>({adminId:id(90),authRevision:++calls,policySha256:digest})};
  const owner=new PostgresReportsCorrectionReadAuthority(reportsPool,f.identity,admin);
  await expect(owner.setGrant('synthetic-enrollment',policy,0)).rejects.toMatchObject({status:403});
  await expect(owner.current('synthetic-token','SERVICE',binding)).rejects.toMatchObject({status:403});
  const disabled=new PostgresReportsCorrectionReadAuthority(reportsPool,f.identity);await expect(disabled.setGrant('synthetic-enrollment',policy,0)).rejects.toMatchObject({status:503});
 });
});
