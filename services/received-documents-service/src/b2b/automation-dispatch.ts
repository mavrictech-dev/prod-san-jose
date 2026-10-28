import {randomUUID} from 'node:crypto';
import type {B2bPrincipal} from '@factuez/contracts/b2b-security';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedAnchor,receivedScope,receivedFail,type ReceivedScope} from '@factuez/service-access/dist/b2b-received-wire';
import type {ReceivedSyncCounters} from '@factuez/contracts';
import type {ReceivedDatabase,ReceivedSql} from './store';
import type {ReceptionAutomationAuthority} from './automation-authority';
import {B2bReceptionCommands,type ReceptionWriteAuthority} from './commands';
import {emptyCounters,fiscalAmountsMatch,parseAutomationSave,receptionPeriods} from '../automation/policy';
import {fixtureMail} from '../automation/mail-fixture';
import {fixtureSirePurchases} from '../automation/sire-fixture';
import {mailAttachments} from '../automation/mailbox';
import {parseReceivedXml} from '@factuez/received-core';

export type ReceptionDispatchContext={runId:string;scope:ReceivedScope;source:'MAIL'|'SIRE';revision:number;
 actor:{kind:'USER'|'SERVICE';clientId:string;subjectId:string|null;clientRevision:number;userAuthRevision:number|null}};
export interface ReceptionDispatchAuthority{
 /** Trusted owner-side adapter: fresh original-actor credentials and a live,
  * run-bound execution approval. Never read a queued bearer/step-up handle.
  * USER approvals must recheck GLOBAL+ADMIN+setup.manage and current MFA. */
 authorize(context:ReceptionDispatchContext):Promise<{access:{token:string;kind:'USER'|'SERVICE'};
  executionId:string;contextSha256:string;expiresAt:string;
  administrator:null|{adminId:string;authRevision:number;authority:'GLOBAL_ADMIN'}}>;
}
export type ReceptionDispatchOptions={enabled?:boolean;authority?:ReceptionDispatchAuthority};
const transaction={isolationLevel:'Serializable' as const,timeout:30000,maxWait:3000};
const metadata=`SELECT a."runId",a."clientId",a."subjectId",a."actorKind",a."scope",a."revision",a."clientRevision",a."userAuthRevision",a."createAuthority",a."dispatchVersion",
 a."networkProfile",r."revision" AS "runRevision",r."source",r."status",r."counters",r."createdAt",r."activeKey",c."revision" AS "connectionRevision",c."mode",c."enabled",c."settings",c."recipientRuc",c."companyId"
 FROM "B2bReceivedAutomationRun" a JOIN "ReceptionSyncRun" r ON r."id"=a."runId"
 JOIN "ReceptionConnection" c ON c."companyId"=r."companyId" WHERE a."runId"=$1::uuid`;
const integer=(v:unknown,min=0)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=2147483647;
function exact(v:any,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))receivedFail(403,'RECEIVED_DISPATCH_APPROVAL_REQUIRED');}
function conflict(e:any){return ['P2034','P2002','40001','23505','40P01'].includes(e?.code)||['40001','23505','40P01'].includes(e?.meta?.code)||['40001','23505','40P01'].includes(e?.meta?.driverAdapterError?.cause?.originalCode);}
function terminal(status:string){return ['COMPLETED','FAILED','BLOCKED'].includes(status);}
function fault(code:string){return new B2bSecurityError(409,code);}

/** Explicit LOCAL_FIXTURE executor. All imports, observations, counters and the
 * completion receipt commit in ONE owner transaction. SQL locks are the fence:
 * a killed process rolls back RUNNING and leaves QUEUED for recovery. No lease
 * expiry can permit a second writer. No network awaits, vault or live connector.
 * BullMQ is a wake-up hint, never the execution/authorization source of truth. */
export class B2bReceptionDispatch{
 constructor(private readonly db:ReceivedDatabase,private readonly identity:B2bIdentityPort,
  private readonly automation:ReceptionAutomationAuthority,private readonly writes:ReceptionWriteAuthority,
  private readonly options:ReceptionDispatchOptions={}){}
 async pending(limit:number):Promise<string[]>{
  if(this.options.enabled!==true)return [];
  if(!integer(limit,1)||limit>100)receivedFail(400,'INVALID_RECEIVED_DISPATCH_REQUEST');
  try{return await this.db.$transaction(async tx=>(await tx.$queryRawUnsafe<any[]>(`SELECT a."runId" FROM "B2bReceivedAutomationRun" a
   JOIN "ReceptionSyncRun" r ON r."id"=a."runId" WHERE r."status"='QUEUED' AND a."dispatchVersion"=1 AND a."networkProfile"='LOCAL_ONLY'
   ORDER BY r."createdAt",a."runId" LIMIT $1`,limit)).map(r=>{if(!b2bUuid(r.runId))receivedFail(503,'RECEIVED_DISPATCH_UNAVAILABLE');return r.runId;}),transaction);}
  catch{receivedFail(503,'RECEIVED_DISPATCH_UNAVAILABLE');}
 }
 async run(runId:string):Promise<{runId:string;status:string}>{
  if(this.options.enabled!==true)return {runId,status:'DISABLED'};
  if(!b2bUuid(runId))receivedFail(400,'INVALID_RECEIVED_DISPATCH_REQUEST');
  try{
   return await this.db.$transaction(async tx=>{
    const initial=(await tx.$queryRawUnsafe<any[]>(metadata,runId))[0];if(!initial)return {runId,status:'NOT_FOUND'};
    const scope=receivedScope(initial.scope);
    // Same company lock as CONFIG_SAVE and SYNC_CREATE; fail fast on competing
    // deliveries instead of holding a pool connection waiting for another job.
    const locks=await tx.$queryRawUnsafe<any[]>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',`received-automation/company/${scope.companyId}`);
    if(locks[0]?.locked!==true)return {runId,status:'BUSY'};
    const row=(await tx.$queryRawUnsafe<any[]>(`${metadata} FOR UPDATE OF r FOR SHARE OF c`,runId))[0];
    if(!row)return {runId,status:'NOT_FOUND'};
    if(terminal(row.status))return {runId,status:row.status};
    if(row.status!=='QUEUED')throw fault('CONNECTION_OR_SCOPE_CHANGED');
    if(row.dispatchVersion!==1||row.revision!==row.connectionRevision||row.revision!==row.runRevision||row.companyId!==scope.companyId||row.recipientRuc!==scope.recipientRuc)throw fault('CONFIGURATION_CHANGED');
    if(row.mode!=='LOCAL_FIXTURE'||row.networkProfile!=='LOCAL_ONLY'||row.enabled!==false||!/^00\d{9}$/.test(scope.recipientRuc)||row.activeKey!==`b2b/${scope.companyId}/${row.source}`)throw fault('CONNECTION_NOT_READY');
    const settings=parseAutomationSave({expectedRevision:row.revision-1,settings:row.settings},scope.recipientRuc).settings;
    if(!settings.enabled||settings.mode!=='LOCAL_FIXTURE'||!['MAIL','SIRE'].includes(row.source)||!(row.source==='MAIL'?settings.mailbox.enabled:settings.sire.enabled))throw fault('CONNECTION_NOT_READY');
    const context:ReceptionDispatchContext=correctionEvidenceFreeze({runId,scope,source:row.source,revision:row.revision,
     actor:{kind:row.actorKind,clientId:row.clientId,subjectId:row.subjectId,clientRevision:row.clientRevision,userAuthRevision:row.userAuthRevision}});
    const frame=new B2bOwnerReadFrame(this.identity,context.actor.kind);let stamp:string|undefined,authorization:unknown;
    const check=async()=>{
     const port=this.options.authority;if(!port)receivedFail(403,'RECEIVED_DISPATCH_APPROVAL_REQUIRED');
     const proof=correctionEvidenceFreeze(await port.authorize(context));exact(proof,['access','executionId','contextSha256','expiresAt','administrator']);exact(proof.access,['token','kind']);
     if(!b2bUuid(proof.executionId)||proof.contextSha256!==hash(context)||proof.access.kind!==context.actor.kind||typeof proof.access.token!=='string'||!/^[A-Za-z0-9._~-]{1,8192}$/.test(proof.access.token)||
      typeof proof.expiresAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(proof.expiresAt)||!Number.isFinite(Date.parse(proof.expiresAt))||new Date(proof.expiresAt).toISOString()!==proof.expiresAt||
      Date.parse(proof.expiresAt)<=Date.now()||Date.parse(proof.expiresAt)>Date.now()+300000)receivedFail(403,'RECEIVED_DISPATCH_APPROVAL_REQUIRED');
     const p=await frame.principal(proof.access.token,row.source==='MAIL'?['b2b:received:sync','b2b:received:write']:['b2b:received:sync']);
     receivedAnchor(p,scope);this.actor(p,context);
     if(p.kind==='USER'){
      exact(proof.administrator,['adminId','authRevision','authority']);const a=proof.administrator!;
      if(a.adminId!==p.subjectId||a.authRevision!==p.userAuthRevision||a.authority!=='GLOBAL_ADMIN')receivedFail(403,'RECEIVED_DISPATCH_APPROVAL_REQUIRED');
     }else if(proof.administrator!==null)receivedFail(403,'RECEIVED_DISPATCH_APPROVAL_REQUIRED');
     const create=await this.automation.authorize(p,scope,'SYNC_CREATE'),execute=await this.automation.authorize(p,scope,'SYNC_EXECUTE');
     if(hash(create)!==hash(row.createAuthority))receivedFail(403,'RECEIVED_DISPATCH_APPROVAL_REQUIRED');
     const decision={executionId:proof.executionId,contextSha256:proof.contextSha256,expiresAt:proof.expiresAt,administrator:proof.administrator,create,execute};
     const next=hash(decision);if(stamp!==undefined&&stamp!==next)receivedFail(403,'RECEIVED_DISPATCH_APPROVAL_REQUIRED');stamp=next;authorization=correctionEvidenceFreeze(decision);
     return {access:proof.access,principal:p};
    };
    await check();
    await tx.$executeRawUnsafe('UPDATE "ReceptionSyncRun" SET "status"=\'RUNNING\',"startedAt"=coalesce("startedAt",CURRENT_TIMESTAMP) WHERE "id"=$1::uuid AND "status"=\'QUEUED\'',runId);
    const counters=emptyCounters(),periods=receptionPeriods(settings.sire.startPeriod,new Date(row.createdAt));
    if(!periods.length)throw fault('CONNECTION_NOT_READY');
    // Reuse the actual guarded command handler inside this same SQL transaction.
    // It still rechecks Identity, the independent IMPORT grant and writes its
    // append-only command journal; no synthetic SERVICE/human impersonation.
    let commandConflict:unknown;
    const bound:ReceivedDatabase={$transaction:async work=>{
     // A nested command cannot restart this already-open SQL transaction.
     // Preserve the first serialization/unique/deadlock error so its bounded
     // retry loop never turns an aborted transaction into a permanent denial.
     if(commandConflict)throw commandConflict;
     try{return await work(tx);}catch(error){if(conflict(error))commandConflict=error;throw error;}
    }};
    const commands=new B2bReceptionCommands(bound,this.identity,this.writes);
    if(row.source==='MAIL')for(const period of periods){
     await check();const raw=fixtureMail(scope.recipientRuc,period);
     try{
      for(const file of await mailAttachments(raw)){
       if(!/\.xml$/i.test(file.fileName)||file.bytes.length>65536)throw fault('CONNECTION_NOT_READY');
       const xml=parseReceivedXml(file.bytes);
       if(!/^00\d{9}$/.test(xml.supplier.identityNumber??''))throw fault('CONNECTION_NOT_READY');
       const current=await check();let result:{outcome:string};
       try{result=await commands.execute(current.access,'IMPORT',{scope,key:`dispatch_${runId}_${period}`,
        payload:{fileName:file.fileName,contentBase64:file.bytes.toString('base64')}}) as {outcome:string};}
       catch(error){throw commandConflict??error;}
       counters.detected++;if(result.outcome==='IMPORTED')counters.imported++;else if(result.outcome==='DUPLICATE')counters.duplicate++;else throw fault('CONNECTION_NOT_READY');
       await check();file.bytes.fill(0);
      }
     }finally{raw.fill(0);}
    }
    if(row.source==='SIRE'){
     let ordinal=0;
     for(const period of periods)for(const purchase of fixtureSirePurchases(scope.recipientRuc,period)){
      await check();
      const comparison=await this.compare(tx,scope,purchase);counters.detected++;this.tally(counters,comparison.status);
      await tx.$executeRawUnsafe(`INSERT INTO "B2bReceivedDispatchObservation" ("runId","ordinal","scope","recordKey","recordSha256","record","documentId","comparison") VALUES($1::uuid,$2,$3::jsonb,$4,$5,$6::jsonb,$7::uuid,$8)`,
       runId,ordinal++,JSON.stringify(scope),hash({period,supplierRuc:purchase.supplierRuc,documentType:purchase.documentType,series:purchase.series,number:purchase.number}),hash(purchase),JSON.stringify(purchase),comparison.documentId,comparison.status);
     }
    }else{
     const observed=await tx.$queryRawUnsafe<any[]>(`SELECT DISTINCT ON (o."recordKey") o."record" FROM "B2bReceivedDispatchObservation" o
      JOIN "ReceptionSyncRun" r ON r."id"=o."runId" WHERE o."scope"=$1::jsonb AND r."status"='COMPLETED' AND (o."record"->>'period')=ANY($2::text[])
      ORDER BY o."recordKey",r."createdAt" DESC,o."runId" DESC LIMIT 100`,JSON.stringify(scope),periods);
     for(const o of observed){await check();this.tally(counters,(await this.compare(tx,scope,o.record)).status);}
    }
    await check();
    if(await tx.$executeRawUnsafe('UPDATE "ReceptionSyncRun" SET "status"=\'COMPLETED\',"activeKey"=NULL,"finishedAt"=CURRENT_TIMESTAMP,"errorCode"=NULL,"counters"=$2::jsonb WHERE "id"=$1::uuid AND "status"=\'RUNNING\'',runId,JSON.stringify(counters))!==1)throw fault('CONNECTION_OR_SCOPE_CHANGED');
    await this.receipt(tx,runId,'COMPLETED',null,counters,authorization);await check();return {runId,status:'COMPLETED'};
   },transaction);
  }catch(e){
   // A serialization loser does not consume an attempt: retry from durable QUEUED.
   if(conflict(e))receivedFail(503,'RECEIVED_DISPATCH_RETRY');
   return this.failure(runId,e);
  }
 }
 private actor(p:B2bPrincipal,c:ReceptionDispatchContext){
  const a=c.actor;if(p.clientId!==a.clientId||p.subjectId!==a.subjectId||p.kind!==a.kind||p.revision!==a.clientRevision||p.userAuthRevision!==a.userAuthRevision)receivedFail(403,'RECEIVED_DISPATCH_APPROVAL_REQUIRED');
 }
 private tally(c:ReceivedSyncCounters,status:string){if(status==='MATCHED')c.matches++;else if(status==='CONFLICT')c.mismatches++;else c.xmlPending++;}
 private async compare(tx:ReceivedSql,s:ReceivedScope,p:any){
  if(p.recipientRuc!==s.recipientRuc||!/^00\d{9}$/.test(p.supplierRuc)||!/^\d{1,8}$/.test(p.number))throw fault('CONNECTION_OR_SCOPE_CHANGED');
  const rows=await tx.$queryRawUnsafe<any[]>(`SELECT "id","issueDate","currencyCode","payableAmount" FROM "ReceivedDocument" WHERE "companyId"=$1 AND "recipientRuc"=$2 AND "branchId"=$3::uuid AND "supplierRuc"=$4 AND "documentType"=$5 AND "series"=$6 AND "number"=$7 FOR SHARE`,s.companyId,s.recipientRuc,s.branchId,p.supplierRuc,p.documentType,p.series,BigInt(p.number).toString());
  if(!rows.length)return {documentId:null,status:'PENDING'};
  const d=rows[0],amount=p.documentType==='07'&&p.amount?.startsWith('-')?p.amount.slice(1):p.amount;
  return {documentId:d.id,status:new Date(d.issueDate).toISOString().slice(0,10)===p.issueDate&&d.currencyCode===p.currencyCode&&fiscalAmountsMatch(d.payableAmount,amount)?'MATCHED':'CONFLICT'};
 }
 private async receipt(tx:ReceivedSql,runId:string,status:string,errorCode:string|null,counters:ReceivedSyncCounters,authority:unknown){
  const rows=await tx.$queryRawUnsafe<any[]>('SELECT coalesce(max("attempt"),0)+1 AS next FROM "B2bReceivedDispatchAttempt" WHERE "runId"=$1::uuid',runId);
  await tx.$executeRawUnsafe('INSERT INTO "B2bReceivedDispatchAttempt" ("id","runId","attempt","status","errorCode","counters","authoritySha256","executionAuthority") VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7,$8::jsonb)',randomUUID(),runId,rows[0].next,status,errorCode,JSON.stringify(counters),authority===null?null:hash(authority),authority===null?null:JSON.stringify(authority));
 }
 private async failure(runId:string,error:unknown):Promise<{runId:string;status:string}>{
  let retry=false;
  try{const result=await this.db.$transaction(async tx=>{
   const initial=(await tx.$queryRawUnsafe<any[]>(metadata,runId))[0];if(!initial)return {runId,status:'NOT_FOUND'};
   const s=receivedScope(initial.scope);
   await tx.$queryRawUnsafe('SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))',`received-automation/company/${s.companyId}`);
   const row=(await tx.$queryRawUnsafe<any[]>(`${metadata} FOR UPDATE OF r`,runId))[0];if(!row||terminal(row.status))return {runId,status:row?.status??'NOT_FOUND'};
   const known=error instanceof B2bSecurityError&&[400,403,404,409].includes(error.status),codes=['CONFIGURATION_CHANGED','CONNECTION_NOT_READY','CONNECTION_OR_SCOPE_CHANGED'];
   const code=known&&codes.includes((error as B2bSecurityError).code)?(error as B2bSecurityError).code:known?'CONNECTION_OR_SCOPE_CHANGED':'CONNECTOR_UNAVAILABLE';
   const attempts=await tx.$queryRawUnsafe<any[]>('SELECT count(*)::integer AS n FROM "B2bReceivedDispatchAttempt" WHERE "runId"=$1::uuid',runId);
   const status=known?'BLOCKED':attempts[0].n>=2?'FAILED':'QUEUED';retry=status==='QUEUED';
   await tx.$executeRawUnsafe(`UPDATE "ReceptionSyncRun" SET "status"=$2::text,"activeKey"=CASE WHEN $2::text='QUEUED' THEN "activeKey" ELSE NULL END,"finishedAt"=CASE WHEN $2::text='QUEUED' THEN NULL ELSE CURRENT_TIMESTAMP END,"errorCode"=$3 WHERE "id"=$1::uuid`,runId,status,code);
   await this.receipt(tx,runId,retry?'RETRY':status,code,emptyCounters(),null);return {runId,status};
  },transaction);if(retry)receivedFail(503,'RECEIVED_DISPATCH_RETRY');return result;}
  catch(e){if(e instanceof B2bSecurityError&&e.code==='RECEIVED_DISPATCH_RETRY')throw e;receivedFail(503,'RECEIVED_DISPATCH_UNAVAILABLE');}
 }
}
