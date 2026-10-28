import {randomUUID,randomBytes,createCipheriv,createDecipheriv,hkdfSync,createHmac} from 'node:crypto';
import type {ReceivedAutomationSettings,ReceivedSyncCounters} from '@factuez/contracts';
import {B2bSecurityError,type B2bPrincipal} from '@factuez/contracts/b2b-security';
import {AccessError} from '@factuez/service-access';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedAnchor,receivedScope,receivedFail,type ReceivedScope} from '@factuez/service-access/dist/b2b-received-wire';
import {parseAutomationSave,defaultReceptionSettings,emptyCounters,imapApproved} from '../automation/policy';
import type {ReceivedDatabase,ReceivedSql} from './store';
import type {ReceptionAutomationAction,ReceptionAutomationPolicyAction,ReceptionAutomationAuthority} from './automation-authority';
export type {ReceptionAutomationAction} from './automation-authority';
export interface ReceptionAutomationVault{
 seal(secrets:Record<string,string>,context:{companyId:number;ruc:string;revision:number}):string|Promise<string>;
 open(cipher:string|null,context:{companyId:number;ruc:string;revision:number}):Record<string,string>|Promise<Record<string,string>>;
 /** Keyed request fingerprint prevents an offline dictionary attack on saved passwords. */
 fingerprint?(value:string):string|Promise<string>;
}
export interface ReceptionAutomationUserAdministrator{
 /** Owner-side live verification of GLOBAL+ADMIN+setup.manage and opaque step-up.
  * The caller supplies only a handle, never these trusted authority facts. */
 authorize(principal:B2bPrincipal,scope:ReceivedScope,action:ReceptionAutomationAction,handle:string,requestSha256:string):Promise<{
  adminId:string;authRevision:number;scope:ReceivedScope;requestSha256:string;authority:'GLOBAL_ADMIN';
 }>;
}
export type ReceptionAutomationOptions={vault:ReceptionAutomationVault;userAdministrator?:ReceptionAutomationUserAdministrator;
 networkProfile?:'LOCAL_ONLY'|'LIVE_READ_ONLY';localFixtureEnabled?:boolean;approvedImapHosts?:readonly string[]};
type Access={token:string;kind:'SERVICE'|'USER'};
const actions=['CONFIG_READ','CONFIG_SAVE','SYNC_CREATE','SYNC_READ'];
const options={isolationLevel:'Serializable' as const,timeout:30000,maxWait:3000};
export function automationCopy(value:unknown):any{try{return correctionEvidenceFreeze(value);}catch{receivedFail(400,'INVALID_RECEIVED_AUTOMATION_REQUEST');}}
function exact(v:any,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.sort().join(','))receivedFail(400,'INVALID_RECEIVED_AUTOMATION_REQUEST');}
const integer=(v:unknown,min=0)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=2147483647;
function conflict(e:unknown){const v=e as {code?:string;meta?:{code?:string;driverAdapterError?:{cause?:{originalCode?:string}}}};
 return ['P2034','P2002','40001','23505','40P01'].includes(v?.code??'')||[v?.meta?.code,v?.meta?.driverAdapterError?.cause?.originalCode].some(c=>['40001','23505','40P01'].includes(c??''));}
function secrets(value:unknown):Record<string,string>{
 const v=automationCopy(value);if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['mailPassword','sireClientSecret','solPassword'].includes(k))||
 Object.values(v).some(x=>typeof x!=='string'||!x.length||x.length>1024||/[\x00-\x1f\x7f]/.test(x)))receivedFail(503,'RECEIVED_VAULT_UNAVAILABLE');return {...v};
}
/** Explicit master only; no environment, filesystem or default vault. Domain
 * and AAD match reception v1; fingerprints use a separate derived key. */
export function createReceptionAutomationVault(master:Uint8Array):ReceptionAutomationVault{
 if(!(master instanceof Uint8Array)||master.length!==32)receivedFail(503,'RECEIVED_VAULT_UNAVAILABLE');
 const key=Buffer.from(hkdfSync('sha256',master,'factuez.received','reception-settings-v1',32));
 const mac=Buffer.from(hkdfSync('sha256',master,'factuez.received','b2b-automation-request-v1',32));
 const aad=(c:{companyId:number;ruc:string;revision:number})=>{if(!integer(c.companyId,1)||!/^\d{11}$/.test(c.ruc)||!integer(c.revision,1))receivedFail(503,'RECEIVED_VAULT_UNAVAILABLE');return Buffer.from(`factuez.reception.v1|${c.companyId}|${c.ruc}|${c.revision}`);};
 return {
  fingerprint:value=>createHmac('sha256',mac).update(value).digest('hex'),
  seal(value,c){const bytes=Buffer.from(JSON.stringify(secrets(value)));try{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(c));const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');}finally{bytes.fill(0);}},
  open(envelope,c){
   if(envelope===null)return {};let bytes:Buffer|undefined,provisional:Buffer|undefined;
   try{if(typeof envelope!=='string'||envelope.length>11500)throw new Error();const parts=envelope.split('.');
    if(parts.length!==4||parts[0]!=='v1')throw new Error();const [iv,tag,data]=parts.slice(1).map(v=>Buffer.from(v,'base64url'));
    if(iv.length!==12||tag.length!==16||data.length>8192||[iv,tag,data].some((v,i)=>v.toString('base64url')!==parts[i+1]))throw new Error();
    const cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(c));cipher.setAuthTag(tag);provisional=cipher.update(data);bytes=Buffer.concat([provisional,cipher.final()]);return secrets(JSON.parse(bytes.toString('utf8')));
   }catch{receivedFail(503,'RECEIVED_VAULT_UNAVAILABLE');}finally{bytes?.fill(0);provisional?.fill(0);}
  },
 };
}
export class B2bReceptionAutomation{
 private readonly profile:'LOCAL_ONLY'|'LIVE_READ_ONLY';private readonly local:boolean;private readonly hosts:string[];
 constructor(private readonly db:ReceivedDatabase,private readonly identity:B2bIdentityPort,private readonly authority:ReceptionAutomationAuthority,private readonly config:ReceptionAutomationOptions){
  this.profile=config?.networkProfile??'LOCAL_ONLY';this.local=config?.localFixtureEnabled===true;this.hosts=[...(config?.approvedImapHosts??[])];
  if(!['LOCAL_ONLY','LIVE_READ_ONLY'].includes(this.profile)||this.hosts.length>16||this.hosts.some(h=>typeof h!=='string'))receivedFail(503,'RECEIVED_AUTOMATION_NOT_CONFIGURED');
 }
 async execute(access:Access,action:ReceptionAutomationAction,input:unknown){
  try{return await this.run(access,action,input);}catch(e){if(e instanceof B2bSecurityError)throw e;if(e instanceof AccessError)receivedFail(400,'INVALID_RECEIVED_AUTOMATION_REQUEST');
   if(conflict(e))receivedFail(409,'RECEIVED_AUTOMATION_CONFLICT');receivedFail(503,'RECEIVED_AUTOMATION_UNAVAILABLE');}
 }
 private async run(access:Access,action:ReceptionAutomationAction,input:unknown){
  if(!actions.includes(action))receivedFail(400,'INVALID_RECEIVED_AUTOMATION_REQUEST');
  const a=automationCopy(access);exact(a,['token','kind']);if(!['USER','SERVICE'].includes(a.kind)||typeof a.token!=='string'||!/^[A-Za-z0-9._~-]{1,8192}$/.test(a.token))receivedFail(401,'INVALID_TOKEN');
  const v=automationCopy(input),mutating=action==='CONFIG_SAVE'||action==='SYNC_CREATE';exact(v,mutating?['scope','key','payload']:['scope','payload']);
  const scope=receivedScope(v.scope);if(mutating&&(typeof v.key!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(v.key)))receivedFail(400,'INVALID_RECEIVED_AUTOMATION_REQUEST');
  if(action.startsWith('CONFIG_')&&a.kind!=='USER')receivedFail(403,'RECEIVED_GLOBAL_ADMIN_REQUIRED');
  const b=v.payload,keys=action==='CONFIG_READ'?[]:action==='CONFIG_SAVE'?['expectedRevision','settings',...(b&&Object.hasOwn(b,'credentials')?['credentials']:[])]:action==='SYNC_CREATE'?['source','expectedRevision']:['runId'];
  exact(b,a.kind==='USER'?[...keys,'stepUpHandle']:keys);
  if(a.kind==='USER'&&(typeof b.stepUpHandle!=='string'||b.stepUpHandle.length<1||b.stepUpHandle.length>8192))receivedFail(403,'STEP_UP_REQUIRED');
  const command=action==='CONFIG_SAVE'?parseAutomationSave({expectedRevision:b.expectedRevision,settings:b.settings,...(Object.hasOwn(b,'credentials')?{credentials:b.credentials}:{})},scope.recipientRuc):null;
  if(action==='SYNC_CREATE'&&(!['MAIL','SIRE','ALL'].includes(b.source)||!integer(b.expectedRevision,1))||action==='SYNC_READ'&&!b2bUuid(b.runId))receivedFail(400,'INVALID_RECEIVED_AUTOMATION_REQUEST');
  const vault=this.config?.vault;if(!vault||typeof vault.seal!=='function'||typeof vault.open!=='function')receivedFail(503,'RECEIVED_VAULT_UNAVAILABLE');
  const frame=new B2bOwnerReadFrame(this.identity,a.kind),required=action.startsWith('CONFIG_')?'b2b:received:configure' as const:'b2b:received:sync' as const;
  const current=async()=>{const p=await frame.principal(a.token,[required]);receivedAnchor(p,scope);return p;},p=await current();
  const semantic=command??Object.fromEntries(Object.entries(b).filter(([k])=>k!=='stepUpHandle'));
  const semanticHash=hash({action,scope,payload:semantic}),requestHash=vault.fingerprint?await vault.fingerprint(semanticHash):semanticHash;if(typeof requestHash!=='string'||!/^[a-f0-9]{64}$/.test(requestHash))receivedFail(503,'RECEIVED_VAULT_UNAVAILABLE');
  const approvalActions:ReceptionAutomationPolicyAction[]=[action];
  if(command?.settings.mode==='LIVE_READ_ONLY')approvalActions.push('LIVE_READ_ONLY');
  const decisions=async()=>{const list=[];for(const act of approvalActions){const d=automationCopy(await this.authority.authorize(p,scope,act));exact(d,['policyId','revision']);if(!b2bUuid(d.policyId)||!integer(d.revision,1))receivedFail(403,'RECEIVED_AUTOMATION_ACCESS_DENIED');list.push({action:act,...d});}return list;};
  let approved=await decisions(),stamp=hash(approved);
  const administrator=async()=>{
   if(p.kind==='SERVICE')return null;const port=this.config.userAdministrator;if(!port)receivedFail(503,'RECEIVED_STEP_UP_NOT_CONFIGURED');
   const proof=automationCopy(await port.authorize(p,scope,action,b.stepUpHandle,requestHash));
   exact(proof,['adminId','authRevision','scope','requestSha256','authority']);
   if(proof.adminId!==p.subjectId||!integer(proof.authRevision)||proof.authority!=='GLOBAL_ADMIN'||proof.requestSha256!==requestHash||hash(receivedScope(proof.scope))!==hash(scope))receivedFail(403,'RECEIVED_GLOBAL_ADMIN_REQUIRED');return proof;
  };
  const admin=await administrator(),adminStamp=hash(admin);
  const check=async()=>{await current();if(hash(await decisions())!==stamp||hash(await administrator())!==adminStamp)receivedFail(403,'RECEIVED_AUTOMATION_ACCESS_DENIED');};
  const includeLive=async()=>{
   if(approvalActions.includes('LIVE_READ_ONLY'))return;await check();
   const d=automationCopy(await this.authority.authorize(p,scope,'LIVE_READ_ONLY'));exact(d,['policyId','revision']);
   if(!b2bUuid(d.policyId)||!integer(d.revision,1))receivedFail(403,'RECEIVED_AUTOMATION_ACCESS_DENIED');
   approvalActions.push('LIVE_READ_ONLY');approved.push({action:'LIVE_READ_ONLY',...d});stamp=hash(approved);await check();
  };
  const key=mutating?hash({scope,kind:p.kind,clientId:p.clientId,subjectId:p.subjectId,key:v.key}):null;
  for(let attempt=0;;attempt++)try{
   const result=await this.db.$transaction(async tx=>{
    await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))',`received-automation/company/${scope.companyId}`);
    await check();
    if(key){const rows=await tx.$queryRawUnsafe<any[]>('SELECT "requestHash","result" FROM "B2bReceivedAutomationCommand" WHERE "key"=$1',key);if(rows.length){if(rows[0].requestHash!==requestHash)receivedFail(409,'IDEMPOTENCY_CONFLICT');if(action==='SYNC_CREATE'&&rows[0].result?.mode==='LIVE_READ_ONLY')await includeLive();await check();return automationCopy(rows[0].result);}}
    const rows=await tx.$queryRawUnsafe<any[]>('SELECT * FROM "ReceptionConnection" WHERE "companyId"=$1 FOR UPDATE',scope.companyId),connection=rows[0]??null;
    if(connection&&connection.recipientRuc!==scope.recipientRuc)receivedFail(409,'RECEIVED_AUTOMATION_CONTEXT_MISMATCH');
    let result:any;
    if(action==='CONFIG_READ')result=await this.dto(scope,connection);
    else if(action==='CONFIG_SAVE')result=await this.save(tx,p,scope,connection,command!);
    else if(action==='SYNC_CREATE'){
     if(connection?.mode==='LIVE_READ_ONLY'){
      await includeLive();
     }
     result=await this.queue(tx,p,scope,connection,b,approved);
    }else result=await this.readRun(tx,p,scope,b.runId);
    await check();
    if(await tx.$executeRawUnsafe(`INSERT INTO "B2bReceivedAutomationAudit" ("clientId","subjectId","actorKind","scope","action","clientRevision","userAuthRevision","authority","adminStamp","resourceId") VALUES($1::uuid,$2::uuid,$3,$4::jsonb,$5,$6,$7,$8::jsonb,$9,$10)`,
     p.clientId,p.subjectId,p.kind,JSON.stringify(scope),action,p.revision,p.userAuthRevision,JSON.stringify(approved),p.kind==='USER'?adminStamp:null,action==='SYNC_READ'?b.runId:action==='CONFIG_SAVE'?String(result.revision):null)!==1)receivedFail(503,'RECEIVED_AUTOMATION_UNAVAILABLE');
    if(key&&await tx.$executeRawUnsafe(`INSERT INTO "B2bReceivedAutomationCommand" ("key","requestHash","clientId","subjectId","actorKind","scope","action","result") VALUES($1,$2,$3::uuid,$4::uuid,$5,$6::jsonb,$7,$8::jsonb)`,key,requestHash,p.clientId,p.subjectId,p.kind,JSON.stringify(scope),action,JSON.stringify(result))!==1)receivedFail(503,'RECEIVED_AUTOMATION_UNAVAILABLE');
    await check();return result;
   },options);await check();return result;
  }catch(e){if(attempt>=2||!conflict(e))throw e;await check();}
 }
 private async opened(scope:ReceivedScope,row:any){
  try{return secrets(await this.config.vault.open(row?.encryptedCredentials??null,{companyId:scope.companyId,ruc:scope.recipientRuc,revision:row?.revision??1}));}catch{receivedFail(503,'RECEIVED_VAULT_UNAVAILABLE');}
 }
 private settings(row:any,ruc:string):ReceivedAutomationSettings{
  if(!row)return defaultReceptionSettings();
  try{const parsed=parseAutomationSave({expectedRevision:row.revision-1,settings:row.settings},ruc);if(row.mode!==parsed.settings.mode)receivedFail(409,'RECEIVED_AUTOMATION_CONTEXT_MISMATCH');return parsed.settings;}catch{receivedFail(409,'RECEIVED_AUTOMATION_CONTEXT_MISMATCH');}
 }
 private async dto(scope:ReceivedScope,row:any){
  const s=this.settings(row,scope.recipientRuc),stored=await this.opened(scope,row);
  const ready=this.readiness(s,scope.recipientRuc,stored);
  return {scope,revision:row?.revision??0,updatedAt:row?new Date(row.updatedAt).toISOString():null,settings:s,
   credentialPresence:{mailPassword:!!stored.mailPassword,sireClientSecret:!!stored.sireClientSecret,solPassword:!!stored.solPassword},
   state:ready,runtimeEnabled:false,networkProfile:this.profile,fiscalAcceptance:'NOT_VERIFIED'};
 }
 private readiness(s:ReceivedAutomationSettings,ruc:string,stored:Record<string,string>){
  if(!s.enabled)return 'DISABLED';
  if(s.mode==='LOCAL_FIXTURE')return this.local&&/^00\d{9}$/.test(ruc)?'STAGED_LOCAL':'WAITING_TI';
  return this.profile==='LIVE_READ_ONLY'&&(!s.mailbox.enabled||imapApproved(s.mailbox.host,this.hosts.join(','))&&!!stored.mailPassword)&&
   (!s.sire.enabled||!!stored.sireClientSecret&&!!stored.solPassword)?'STAGED_READ_ONLY':'WAITING_TI';
 }
 private async save(tx:ReceivedSql,p:B2bPrincipal,s:ReceivedScope,row:any,command:ReturnType<typeof parseAutomationSave>){
  if(p.kind!=='USER'||!b2bUuid(p.subjectId))receivedFail(403,'RECEIVED_GLOBAL_ADMIN_REQUIRED');
  if((row?.revision??0)!==command.expectedRevision)receivedFail(409,'RECEIVED_AUTOMATION_REVISION_CONFLICT');
  const revision=command.expectedRevision+1,before=this.settings(row,s.recipientRuc),stored=await this.opened(s,row),next=command.settings;
  if(before.mailbox.host!==next.mailbox.host||before.mailbox.username!==next.mailbox.username)delete stored.mailPassword;
  if(before.sire.clientId!==next.sire.clientId)delete stored.sireClientSecret;
  if(before.sire.solUsername!==next.sire.solUsername)delete stored.solPassword;
  Object.assign(stored,command.credentials);
  let cipher:string|null=null;try{cipher=Object.keys(stored).length?await this.config.vault.seal(stored,{companyId:s.companyId,ruc:s.recipientRuc,revision}):null;}catch{receivedFail(503,'RECEIVED_VAULT_UNAVAILABLE');}
  if(cipher!==null&&(typeof cipher!=='string'||!cipher.startsWith('v1.')||cipher.length>11500))receivedFail(503,'RECEIVED_VAULT_UNAVAILABLE');
  const updatedAt=new Date();
  const n=row?await tx.$executeRawUnsafe('UPDATE "ReceptionConnection" SET "revision"=$2,"enabled"=false,"mode"=$3,"settings"=$4::jsonb,"encryptedCredentials"=$5,"configuredBy"=$6::uuid,"updatedAt"=$7::timestamp WHERE "companyId"=$1 AND "revision"=$8',s.companyId,revision,next.mode,JSON.stringify(next),cipher,p.subjectId,updatedAt,command.expectedRevision):
   await tx.$executeRawUnsafe('INSERT INTO "ReceptionConnection" ("companyId","recipientRuc","revision","enabled","mode","settings","encryptedCredentials","configuredBy","updatedAt") VALUES($1,$2,$3,false,$4,$5::jsonb,$6,$7::uuid,$8::timestamp)',s.companyId,s.recipientRuc,revision,next.mode,JSON.stringify(next),cipher,p.subjectId,updatedAt);
  if(n!==1)receivedFail(409,'RECEIVED_AUTOMATION_REVISION_CONFLICT');
  await tx.$executeRawUnsafe('INSERT INTO "ReceptionConnectionAudit" ("id","companyId","actorId","action","revision","detail") VALUES($1::uuid,$2,$3::uuid,\'CONFIGURATION_SAVED\',$4,$5::jsonb)',randomUUID(),s.companyId,p.subjectId,revision,JSON.stringify({enabled:false,requestedEnabled:next.enabled,mode:next.mode,source:'B2B',runtimeEnabled:false}));
  await tx.$executeRawUnsafe('UPDATE "ReceptionSyncRun" SET "status"=\'BLOCKED\',"activeKey"=NULL,"finishedAt"=$2::timestamp,"errorCode"=\'CONFIGURATION_CHANGED\' WHERE "companyId"=$1 AND "status" IN (\'QUEUED\',\'RUNNING\')',s.companyId,updatedAt);
  return this.dto(s,{revision,updatedAt,settings:next,mode:next.mode,encryptedCredentials:cipher});
 }
 private async queue(tx:ReceivedSql,p:B2bPrincipal,s:ReceivedScope,row:any,b:any,decisions:{action:string;policyId:string;revision:number}[]){
  if(!row||row.revision!==b.expectedRevision)receivedFail(409,'RECEIVED_AUTOMATION_REVISION_CONFLICT');
  const settings=this.settings(row,s.recipientRuc),ready=this.readiness(settings,s.recipientRuc,await this.opened(s,row));
  if(!['STAGED_LOCAL','STAGED_READ_ONLY'].includes(ready))receivedFail(403,'RECEIVED_AUTOMATION_NETWORK_DENIED');
  const sources=(['MAIL','SIRE'] as const).filter(source=>(b.source==='ALL'||b.source===source)&&(source==='MAIL'?settings.mailbox.enabled:settings.sire.enabled));
  if(!sources.length)receivedFail(409,'RECEIVED_AUTOMATION_SOURCE_DISABLED');
  const items=[];
  const createAuthority=decisions.find(d=>d.action==='SYNC_CREATE')!,liveAuthority=decisions.find(d=>d.action==='LIVE_READ_ONLY');
  const dispatchProfile=settings.mode==='LOCAL_FIXTURE'?'LOCAL_ONLY':this.profile;
  for(const source of sources){
   const existing=await tx.$queryRawUnsafe<any[]>('SELECT "id" FROM "ReceptionSyncRun" WHERE "companyId"=$1 AND "source"=$2 AND "status" IN (\'QUEUED\',\'RUNNING\') FOR UPDATE',s.companyId,source);
   if(existing.length)receivedFail(409,'RECEIVED_AUTOMATION_SYNC_ACTIVE');
   const id=randomUUID();await tx.$executeRawUnsafe('INSERT INTO "ReceptionSyncRun" ("id","companyId","recipientRuc","revision","source","status","activeKey","counters") VALUES($1::uuid,$2,$3,$4,$5,\'QUEUED\',$6,$7::jsonb)',id,s.companyId,s.recipientRuc,row.revision,source,`b2b/${s.companyId}/${source}`,JSON.stringify(emptyCounters()));
   await tx.$executeRawUnsafe('INSERT INTO "B2bReceivedAutomationRun" ("runId","clientId","subjectId","actorKind","scope","revision","networkProfile","clientRevision","userAuthRevision","createAuthority","liveAuthority") VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11::jsonb)',id,p.clientId,p.subjectId,p.kind,JSON.stringify(s),row.revision,dispatchProfile,p.revision,p.userAuthRevision,JSON.stringify({policyId:createAuthority.policyId,revision:createAuthority.revision}),liveAuthority?JSON.stringify({policyId:liveAuthority.policyId,revision:liveAuthority.revision}):null);
   items.push({runId:id,source,status:'QUEUED',revision:row.revision,dispatch:'NOT_DISPATCHED'});
  }
  return {scope:s,items,mode:settings.mode,networkProfile:this.profile,runtimeEnabled:false,fiscalAcceptance:'NOT_VERIFIED'};
 }
 private async readRun(tx:ReceivedSql,p:B2bPrincipal,s:ReceivedScope,id:string){
  const rows=await tx.$queryRawUnsafe<any[]>(`SELECT r."id",r."source",r."status",r."revision",r."startedAt",r."finishedAt",r."counters",r."errorCode",r."createdAt" FROM "ReceptionSyncRun" r JOIN "B2bReceivedAutomationRun" a ON a."runId"=r."id"
   WHERE r."id"=$1::uuid AND r."companyId"=$2 AND r."recipientRuc"=$3 AND a."scope"=$4::jsonb AND a."clientId"=$5::uuid AND a."actorKind"=$6 AND a."subjectId" IS NOT DISTINCT FROM $7::uuid FOR SHARE`,id,s.companyId,s.recipientRuc,JSON.stringify(s),p.clientId,p.kind,p.subjectId);
  if(rows.length!==1)receivedFail(404,'RESOURCE_NOT_FOUND');const r=rows[0],counts=automationCopy(r.counters);exact(counts,Object.keys(emptyCounters()));
  if(Object.values(counts).some(n=>!integer(n))||!['MAIL','SIRE'].includes(r.source)||!['QUEUED','RUNNING','COMPLETED','FAILED','BLOCKED'].includes(r.status))receivedFail(503,'INVALID_RECEIVED_AUTOMATION_RESPONSE');
  return {scope:s,run:{runId:r.id,source:r.source,status:r.status,revision:r.revision,startedAt:r.startedAt?new Date(r.startedAt).toISOString():null,finishedAt:r.finishedAt?new Date(r.finishedAt).toISOString():null,
   counters:counts as ReceivedSyncCounters,errorCode:r.errorCode===null?null:['CONFIGURATION_CHANGED','CONNECTION_NOT_READY','CONNECTION_OR_SCOPE_CHANGED','CONNECTOR_UNAVAILABLE'].includes(r.errorCode)?r.errorCode:'SYNC_FAILED'},runtimeEnabled:false,fiscalAcceptance:'NOT_VERIFIED'};
 }
}

