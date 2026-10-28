import {randomUUID} from 'node:crypto';
import {B2bSecurityError,type B2bPrincipal} from '@factuez/contracts/b2b-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import type {ReceivedSyncCounters} from '@factuez/contracts';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedAnchor,receivedScope,receivedFail,type ReceivedScope} from '@factuez/service-access/dist/b2b-received-wire';
import {parseReceivedXml} from '@factuez/received-core';
import {emptyCounters,fiscalAmountsMatch,parseAutomationSave,receptionPeriods} from '../automation/policy';
import {mailboxFingerprint} from '../automation/mailbox';
import {B2bReceptionCommands,type ReceptionWriteAuthority} from './commands';
import type {ReceptionAutomationAuthority} from './automation-authority';
import type {ReceptionDispatchAuthority,ReceptionDispatchContext} from './automation-dispatch';
import type {ReceivedDatabase,ReceivedSql} from './store';
import type {ReadOnlyReceptionAdmissionPort,ReadOnlyReceptionSnapshot,ReadOnlyReceptionBatch,ReadOnlyReceptionFile} from './automation-read-only.types';
import {readOnlyBatchSnapshot} from './automation-read-only.batch';
const txOptions={isolationLevel:'Serializable' as const,timeout:30000,maxWait:3000};
const meta=`SELECT a.*,r."source",r."status",r."createdAt" AS "queuedAt",r."activeKey",r."revision" AS "runRevision",
 c."revision" AS "connectionRevision",c."recipientRuc",c."companyId",c."mode",c."enabled",c."settings",c."encryptedCredentials"
 FROM "B2bReceivedAutomationRun" a JOIN "ReceptionSyncRun" r ON r."id"=a."runId"
 JOIN "ReceptionConnection" c ON c."companyId"=r."companyId" WHERE a."runId"=$1::uuid`;
const integer=(v:unknown,min=0)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=2147483647;
const denied:()=>never=()=>receivedFail(403,'RECEIVED_READ_ONLY_APPROVAL_REQUIRED');
const exact=(v:any,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))receivedFail(400,'INVALID_RECEIVED_READ_ONLY_BATCH');};
const retryable=(e:any)=>['40001','40P01','23505','P2002','P2034'].includes(e?.code)||['40001','40P01','23505'].includes(e?.meta?.code)||['40001','40P01','23505'].includes(e?.meta?.driverAdapterError?.cause?.originalCode);
const terminal=(status:string)=>['COMPLETED','BLOCKED','FAILED'].includes(status);
export type ReadOnlyReceptionOptions={enabled?:boolean;executionAuthority?:ReceptionDispatchAuthority;admission?:ReadOnlyReceptionAdmissionPort};
export function receptionConfigurationHash(scope:ReceivedScope,revision:number,settings:unknown){return hash({scope,revision,settings});}
function file(value:ReadOnlyReceptionFile){
 exact(value,['fileName','contentBase64']);
 if(typeof value.fileName!=='string'||value.fileName.length>180||/[\\/\x00-\x1f]/.test(value.fileName)||typeof value.contentBase64!=='string'||value.contentBase64.length>87384)receivedFail(400,'INVALID_RECEIVED_READ_ONLY_BATCH');
 const bytes=Buffer.from(value.contentBase64,'base64');if(!bytes.length||bytes.length>65536||bytes.toString('base64')!==value.contentBase64)receivedFail(400,'INVALID_RECEIVED_READ_ONLY_BATCH');return bytes;
}
/** Separate READ_ONLY protocol. Legacy/local guards stay unchanged. Remote reads
 * happen without a SQL transaction; a second authorization/configuration check
 * fences the atomic import + cursor + observations + result commit. */
export class B2bReceptionReadOnlyDispatch{
 constructor(private readonly db:ReceivedDatabase,private readonly identity:B2bIdentityPort,private readonly automation:ReceptionAutomationAuthority,
  private readonly writes:ReceptionWriteAuthority,private readonly source:import('./automation-read-only.types').ReadOnlyReceptionSource,
  private readonly options:ReadOnlyReceptionOptions={}){}
 private read(runId:string){return this.db.$transaction(async tx=>(await tx.$queryRawUnsafe<any[]>(meta,runId))[0]??null,txOptions);}
 async pending(limit:number){
  if(this.options.enabled!==true)return [];
  if(!integer(limit,1)||limit>100)receivedFail(400,'INVALID_RECEIVED_DISPATCH_REQUEST');
  try{return await this.db.$transaction(async tx=>(await tx.$queryRawUnsafe<any[]>(`SELECT a."runId" FROM "B2bReceivedAutomationRun" a JOIN "ReceptionSyncRun" r ON r."id"=a."runId"
   WHERE a."networkProfile"='LIVE_READ_ONLY' AND a."liveAuthority" IS NOT NULL AND r."status"='QUEUED' ORDER BY r."createdAt",a."runId" LIMIT $1`,limit)).map(r=>{if(!b2bUuid(r.runId))receivedFail(503,'RECEIVED_DISPATCH_UNAVAILABLE');return r.runId as string;}),txOptions);}catch{receivedFail(503,'RECEIVED_DISPATCH_UNAVAILABLE');}
 }
 async run(runId:string):Promise<{runId:string;status:string}>{
  if(this.options.enabled!==true)return {runId,status:'DISABLED'};
  if(!b2bUuid(runId))receivedFail(400,'INVALID_RECEIVED_DISPATCH_REQUEST');
  let selected=false;
  try{
   const initial=await this.read(runId);if(!initial)return {runId,status:'NOT_FOUND'};
   if(initial.networkProfile!=='LIVE_READ_ONLY')return {runId,status:'NOT_APPLICABLE'};selected=true;
   if(terminal(initial.status))return {runId,status:initial.status};
   const scope=receivedScope(initial.scope),context:ReceptionDispatchContext=correctionEvidenceFreeze({runId,scope,source:initial.source,revision:initial.revision,
    actor:{kind:initial.actorKind,clientId:initial.clientId,subjectId:initial.subjectId,clientRevision:initial.clientRevision,userAuthRevision:initial.userAuthRevision}});
   const settings=parseAutomationSave({expectedRevision:initial.revision-1,settings:initial.settings},scope.recipientRuc).settings;
   const configurationSha256=receptionConfigurationHash(scope,initial.revision,settings),frame=new B2bOwnerReadFrame(this.identity,context.actor.kind);
   let decisionStamp:string|undefined,execution:any,admission:any,principal:B2bPrincipal;
   const check=async()=>{
    const r=await this.read(runId);
    if(!r||r.status!=='QUEUED'||r.mode!=='LIVE_READ_ONLY'||r.enabled!==false||!settings.enabled||settings.mode!=='LIVE_READ_ONLY'||
     !['MAIL','SIRE'].includes(context.source)||r.runRevision!==context.revision||r.connectionRevision!==context.revision||r.revision!==context.revision||
     r.companyId!==scope.companyId||r.recipientRuc!==scope.recipientRuc||hash(r.scope)!==hash(scope)||r.activeKey!==`b2b/${scope.companyId}/${context.source}`||
     receptionConfigurationHash(scope,r.revision,r.settings)!==configurationSha256||!r.liveAuthority||!(context.source==='MAIL'?settings.mailbox.enabled:settings.sire.enabled))denied();
    if(!this.options.executionAuthority||!this.options.admission)denied();
    const proof=correctionEvidenceFreeze(await this.options.executionAuthority.authorize(context));
    exact(proof,['access','executionId','contextSha256','expiresAt','administrator']);exact(proof.access,['kind','token']);
    if(!b2bUuid(proof.executionId)||proof.contextSha256!==hash(context)||proof.access.kind!==context.actor.kind||typeof proof.access.token!=='string'||!/^[A-Za-z0-9._~-]{1,8192}$/.test(proof.access.token)||
     typeof proof.expiresAt!=='string'||!Number.isFinite(Date.parse(proof.expiresAt))||new Date(proof.expiresAt).toISOString()!==proof.expiresAt||Date.parse(proof.expiresAt)<=Date.now()||Date.parse(proof.expiresAt)>Date.now()+300000)denied();
    const p=await frame.principal(proof.access.token,context.source==='MAIL'?['b2b:received:sync','b2b:received:write']:['b2b:received:sync']);receivedAnchor(p,scope);
    if(p.kind!==context.actor.kind||p.clientId!==context.actor.clientId||p.subjectId!==context.actor.subjectId||p.revision!==context.actor.clientRevision||p.userAuthRevision!==context.actor.userAuthRevision)denied();
    if(p.kind==='USER'){exact(proof.administrator,['adminId','authRevision','authority']);if(proof.administrator?.authority!=='GLOBAL_ADMIN'||proof.administrator.adminId!==p.subjectId||proof.administrator.authRevision!==p.userAuthRevision)denied();}
    else if(proof.administrator!==null)denied();
    const create=await this.automation.authorize(p,scope,'SYNC_CREATE'),execute=await this.automation.authorize(p,scope,'SYNC_EXECUTE'),live=await this.automation.authorize(p,scope,'LIVE_READ_ONLY');
    if(hash(create)!==hash(initial.createAuthority)||hash(live)!==hash(initial.liveAuthority))denied();
    const approved=correctionEvidenceFreeze(await this.options.admission.authorize(context,configurationSha256));
    exact(approved,['approvalId','revision','profile','contextSha256','configurationSha256','approvedImapHosts']);
    if(!b2bUuid(approved.approvalId)||!integer(approved.revision,1)||approved.profile!=='READ_ONLY'||approved.contextSha256!==hash(context)||approved.configurationSha256!==configurationSha256||
     !Array.isArray(approved.approvedImapHosts)||approved.approvedImapHosts.length>16||approved.approvedImapHosts.some((h:any)=>typeof h!=='string'))denied();
    const imports=context.source==='MAIL'?await this.writes.authorize(p,scope,'IMPORT'):null;
    const decision={create,execute,live,admission:approved,imports,administrator:proof.administrator},stamp=hash(decision);
    if(decisionStamp!==undefined&&stamp!==decisionStamp)denied();decisionStamp=stamp;
    principal=p;admission=approved;execution={...decision,executionId:proof.executionId,expiresAt:proof.expiresAt,contextSha256:proof.contextSha256};return proof.access;
   };
   await check();
   const cursors=await this.db.$transaction(tx=>tx.$queryRawUnsafe<any[]>('SELECT "fingerprint","uidValidity","lastUid","revision","configurationSha256" FROM "B2bReceivedReadOnlyCursor" WHERE "scopeHash"=$1',hash(scope)),txOptions);
   const saved=cursors[0],cursor=saved&&saved.revision===context.revision&&saved.configurationSha256===configurationSha256?
    {fingerprint:saved.fingerprint,uidValidity:saved.uidValidity,lastUid:String(saved.lastUid)}:null;
   const periods=receptionPeriods(settings.sire.startPeriod,new Date(initial.queuedAt));if(!periods.length)denied();
   const snapshot:ReadOnlyReceptionSnapshot={context,settings,configurationSha256,encryptedCredentials:initial.encryptedCredentials,periods,admission,cursor};
   const batch=readOnlyBatchSnapshot(await this.source.read(snapshot,async()=>{await check();}));
   this.validate(batch,snapshot);await check();
   return await this.db.$transaction(async tx=>{
    const locks=await tx.$queryRawUnsafe<any[]>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',`received-automation/company/${scope.companyId}`);
    if(locks[0]?.locked!==true)return {runId,status:'BUSY'};
    const row=(await tx.$queryRawUnsafe<any[]>(`${meta} FOR UPDATE OF r FOR SHARE OF c`,runId))[0];
    if(!row)return {runId,status:'NOT_FOUND'};if(terminal(row.status))return {runId,status:row.status};await check();
    await tx.$executeRawUnsafe('UPDATE "ReceptionSyncRun" SET "status"=\'RUNNING\',"startedAt"=coalesce("startedAt",CURRENT_TIMESTAMP) WHERE "id"=$1::uuid',runId);
    let firstConflict:unknown;
    const bound:ReceivedDatabase={$transaction:async work=>{if(firstConflict)throw firstConflict;try{return await work(tx);}catch(e){if(retryable(e))firstConflict=e;throw e;}}};
    const commands=new B2bReceptionCommands(bound,this.identity,this.writes),counts=emptyCounters();
    counts.rejected=batch.incidents.length;
    for(const [ordinal,d]of batch.documents.entries()){
     const access=await check();let result:any;
     try{result=await commands.execute(access,'IMPORT',{scope,key:`read_only_${runId}_${ordinal}`,payload:d.file});}
     catch(e){throw firstConflict??e;}
     counts.detected++;if(result.outcome==='IMPORTED')counts.imported++;else counts.duplicate++;
     for(const [i,a]of d.artifacts.entries()){
      await check();try{await commands.execute(access,'ATTACH',{scope,key:`read_only_${runId}_${ordinal}_attachment_${i}`,payload:{documentId:result.documentId,kind:a.kind,file:a.file}});}catch(e){throw firstConflict??e;}
     }
    }
    for(const [ordinal,p]of batch.purchases.entries()){
     await check();const comparison=await this.compare(tx,scope,p);counts.detected++;
     if(comparison.status==='MATCHED')counts.matches++;else if(comparison.status==='CONFLICT')counts.mismatches++;else counts.xmlPending++;
     await tx.$executeRawUnsafe('INSERT INTO "B2bReceivedReadOnlyObservation" ("runId","ordinal","scope","recordKey","record","recordSha256","documentId","comparison") VALUES($1::uuid,$2,$3::jsonb,$4,$5::jsonb,$6,$7::uuid,$8)',runId,ordinal,JSON.stringify(scope),hash({period:p.period,supplierRuc:p.supplierRuc,documentType:p.documentType,series:p.series,number:p.number}),JSON.stringify(p),hash(p),comparison.documentId,comparison.status);
    }
    if(context.source==='MAIL'){
     const observed=await tx.$queryRawUnsafe<any[]>(`SELECT DISTINCT ON (o."recordKey") o."record" FROM "B2bReceivedReadOnlyObservation" o JOIN "ReceptionSyncRun" r ON r."id"=o."runId"
      WHERE o."scope"=$1::jsonb AND r."status"='COMPLETED' AND (o."record"->>'period')=ANY($2::text[]) ORDER BY o."recordKey",r."createdAt" DESC,o."runId" DESC LIMIT 101`,JSON.stringify(scope),periods);
     if(observed.length>100)receivedFail(409,'RECEIVED_READ_ONLY_BATCH_TOO_LARGE');
     for(const o of observed){await check();const c=await this.compare(tx,scope,o.record);if(c.status==='MATCHED')counts.matches++;else if(c.status==='CONFLICT')counts.mismatches++;else counts.xmlPending++;}
    }
    for(const [ordinal,incident]of batch.incidents.entries())await tx.$executeRawUnsafe('INSERT INTO "B2bReceivedReadOnlyIncident" ("runId","ordinal","scope","code","sourceSha256") VALUES($1::uuid,$2,$3::jsonb,$4,$5)',runId,ordinal,JSON.stringify(scope),incident.code,incident.sourceSha256);
    if(batch.cursor){
     const c=batch.cursor;await tx.$executeRawUnsafe(`INSERT INTO "B2bReceivedReadOnlyCursor" ("scopeHash","scope","revision","configurationSha256","fingerprint","uidValidity","lastUid","runId") VALUES($1,$2::jsonb,$3,$4,$5,$6,$7::bigint,$8::uuid)
      ON CONFLICT ("scopeHash") DO UPDATE SET "revision"=EXCLUDED."revision","configurationSha256"=EXCLUDED."configurationSha256","fingerprint"=EXCLUDED."fingerprint","uidValidity"=EXCLUDED."uidValidity","lastUid"=EXCLUDED."lastUid","runId"=EXCLUDED."runId","updatedAt"=CURRENT_TIMESTAMP`,hash(scope),JSON.stringify(scope),context.revision,configurationSha256,c.fingerprint,c.uidValidity,c.lastUid,runId);
    }
    await check();await tx.$executeRawUnsafe('UPDATE "ReceptionSyncRun" SET "status"=\'COMPLETED\',"counters"=$2::jsonb,"activeKey"=NULL,"errorCode"=NULL,"finishedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid',runId,JSON.stringify(counts));
    await this.receipt(tx,runId,'COMPLETED',null,counts,execution);await check();return {runId,status:'COMPLETED'};
   },txOptions);
  }catch(e){if(!selected)receivedFail(503,'RECEIVED_DISPATCH_UNAVAILABLE');if(retryable(e))receivedFail(503,'RECEIVED_DISPATCH_RETRY');return this.failure(runId,e);}
 }
 private validate(b:ReadOnlyReceptionBatch,s:ReadOnlyReceptionSnapshot){
  exact(b,['documents','purchases','incidents','cursor']);
  if(!Array.isArray(b.documents)||b.documents.length>50||!Array.isArray(b.purchases)||b.purchases.length>100||!Array.isArray(b.incidents)||b.incidents.length>100||Buffer.byteLength(JSON.stringify(b))>5*1024*1024)receivedFail(409,'RECEIVED_READ_ONLY_BATCH_TOO_LARGE');
  if(s.context.source==='SIRE'&&(b.documents.length||b.cursor!==null)||s.context.source==='MAIL'&&b.purchases.length)denied();
  for(const d of b.documents){exact(d,['file','artifacts']);const p=parseReceivedXml(file(d.file));if(p.recipient.identityType!=='6'||p.recipient.identityNumber!==s.context.scope.recipientRuc)denied();
   if(!Array.isArray(d.artifacts)||d.artifacts.length>20)denied();for(const a of d.artifacts){exact(a,['kind','file']);if(!['CDR','PROVIDER_PDF'].includes(a.kind))denied();file(a.file);}}
  for(const p of b.purchases){exact(p,['recipientRuc','period','supplierRuc','supplierName','documentType','series','number','fullNumber','issueDate','currencyCode','amount','rawRecord']);
   if(p.recipientRuc!==s.context.scope.recipientRuc||!s.periods.includes(p.period)||!/^\d{11}$/.test(p.supplierRuc)||!/^[A-Z0-9]{2}$/.test(p.documentType)||!/^[A-Za-z0-9]{1,20}$/.test(p.series)||!/^[A-Za-z0-9]{1,20}$/.test(p.number)||
    typeof p.issueDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(p.issueDate)||!Number.isFinite(Date.parse(p.issueDate))||new Date(p.issueDate).toISOString().slice(0,10)!==p.issueDate||
    p.currencyCode!==null&&!/^[A-Z]{3}$/.test(p.currencyCode)||p.amount!==null&&!/^-?\d{1,16}(?:\.\d{1,6})?$/.test(p.amount))denied();}
  for(const i of b.incidents){exact(i,['code','sourceSha256']);if(!['INVALID_MESSAGE','INVALID_DOCUMENT','DOCUMENT_TOO_LARGE','ARTIFACT_UNMATCHED','SIRE_RECORD_REJECTED'].includes(i.code)||!/^[a-f0-9]{64}$/.test(i.sourceSha256))denied();}
  if(b.cursor){exact(b.cursor,['fingerprint','uidValidity','lastUid']);const c=b.cursor;
   if(c.fingerprint!==mailboxFingerprint(s.settings.mailbox)||!/^\d{1,20}$/.test(c.uidValidity)||!/^\d{1,10}$/.test(c.lastUid)||BigInt(c.lastUid)>4294967295n||
    s.cursor?.fingerprint===c.fingerprint&&s.cursor.uidValidity===c.uidValidity&&BigInt(c.lastUid)<BigInt(s.cursor.lastUid))denied();}
 }
 private async compare(tx:ReceivedSql,s:ReceivedScope,p:any){
  if(!['01','03','07','08'].includes(p.documentType)||!/^[A-Z0-9]{4}$/.test(p.series)||!/^\d{1,8}$/.test(p.number))return {documentId:null,status:'PENDING'};
  const rows=await tx.$queryRawUnsafe<any[]>('SELECT "id","issueDate","currencyCode","payableAmount" FROM "ReceivedDocument" WHERE "companyId"=$1 AND "recipientRuc"=$2 AND "branchId"=$3::uuid AND "supplierRuc"=$4 AND "documentType"=$5 AND "series"=$6 AND "number"=$7 FOR SHARE',s.companyId,s.recipientRuc,s.branchId,p.supplierRuc,p.documentType,p.series,BigInt(p.number).toString());
  if(!rows.length)return {documentId:null,status:'PENDING'};const d=rows[0],amount=p.documentType==='07'&&p.amount?.startsWith('-')?p.amount.slice(1):p.amount;
  return {documentId:d.id,status:new Date(d.issueDate).toISOString().slice(0,10)===p.issueDate&&d.currencyCode===p.currencyCode&&fiscalAmountsMatch(d.payableAmount,amount)?'MATCHED':'CONFLICT'};
 }
 private async receipt(tx:ReceivedSql,id:string,status:string,code:string|null,counts:ReceivedSyncCounters,authority:unknown){
  const n=(await tx.$queryRawUnsafe<any[]>('SELECT count(*)::integer+1 AS n FROM "B2bReceivedReadOnlyAttempt" WHERE "runId"=$1::uuid',id))[0].n;
  await tx.$executeRawUnsafe('INSERT INTO "B2bReceivedReadOnlyAttempt" ("runId","attempt","status","errorCode","counters","authority","authoritySha256") VALUES($1::uuid,$2,$3,$4,$5::jsonb,$6::jsonb,$7)',id,n,status,code,JSON.stringify(counts),authority===null?null:JSON.stringify(authority),authority===null?null:hash(authority));
 }
 private async failure(id:string,error:unknown):Promise<{runId:string;status:string}>{
  let again=false;try{const result=await this.db.$transaction(async tx=>{
   const first=(await tx.$queryRawUnsafe<any[]>(meta,id))[0];if(!first)return {runId:id,status:'NOT_FOUND'};if(first.networkProfile!=='LIVE_READ_ONLY')return {runId:id,status:'NOT_APPLICABLE'};
   const scope=receivedScope(first.scope);await tx.$queryRawUnsafe('SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))',`received-automation/company/${scope.companyId}`);
   const row=(await tx.$queryRawUnsafe<any[]>(`${meta} FOR UPDATE OF r`,id))[0];if(terminal(row.status))return {runId:id,status:row.status};
   const known=error instanceof B2bSecurityError&&[400,401,403,404,409].includes(error.status),code=known?'CONNECTION_OR_SCOPE_CHANGED':'CONNECTOR_UNAVAILABLE';
   const n=(await tx.$queryRawUnsafe<any[]>('SELECT count(*)::integer AS n FROM "B2bReceivedReadOnlyAttempt" WHERE "runId"=$1::uuid',id))[0].n;
   const status=known?'BLOCKED':n>=2?'FAILED':'QUEUED';again=status==='QUEUED';
   await tx.$executeRawUnsafe('UPDATE "ReceptionSyncRun" SET "status"=$2::text,"errorCode"=$3,"activeKey"=CASE WHEN $2::text=\'QUEUED\' THEN "activeKey" ELSE NULL END,"finishedAt"=CASE WHEN $2::text=\'QUEUED\' THEN NULL ELSE CURRENT_TIMESTAMP END WHERE "id"=$1::uuid',id,status,code);
   await this.receipt(tx,id,again?'RETRY':status,code,emptyCounters(),null);return {runId:id,status};
  },txOptions);if(again)receivedFail(503,'RECEIVED_DISPATCH_RETRY');return result;}
  catch(e){if(e instanceof B2bSecurityError&&e.code==='RECEIVED_DISPATCH_RETRY')throw e;receivedFail(503,'RECEIVED_DISPATCH_UNAVAILABLE');}
 }
}
