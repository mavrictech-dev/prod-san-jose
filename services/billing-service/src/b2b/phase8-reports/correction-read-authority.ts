import {randomUUID} from 'node:crypto';
import {B2bSecurityError,b2bBindingsContain,validB2bCorrectionBinding,type B2bCorrectionBinding} from '@factuez/contracts/b2b-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {reportActor,type ReportsCorrectionReadAuthority} from './source-types';
import type {ReportsPgPool,ReportsAuth} from './types';
type Subject={kind:'USER'|'SERVICE';clientId:string;subjectId:string|null};
type ReadGrant={binding:B2bCorrectionBinding;subject:Subject;clientRevision:number;userAuthRevision:number|null;active:boolean};
export interface ReportsReadGrantAdministrator{authorize(handle:string,requestSha256:string):Promise<{adminId:string;authRevision:number;policySha256:string}>}
const integer=(v:unknown,min=0)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=2147483647;
function fail(status:number,code:string):never{throw new B2bSecurityError(status,code);}
const key=(g:Omit<ReadGrant,'active'>)=>hash({binding:g.binding,subject:g.subject,clientRevision:g.clientRevision,userAuthRevision:g.userAuthRevision});
function grant(input:unknown):ReadGrant{
 const g=correctionEvidenceFreeze(input) as ReadGrant;
 if(!g||Object.keys(g).sort().join(',')!=='active,binding,clientRevision,subject,userAuthRevision'||!validB2bCorrectionBinding(g.binding)||typeof g.active!=='boolean'||!integer(g.clientRevision,1)||
  !g.subject||Object.keys(g.subject).sort().join(',')!=='clientId,kind,subjectId'||!b2bUuid(g.subject.clientId)||
  (g.subject.kind==='SERVICE'?(g.subject.subjectId!==null||g.userAuthRevision!==null):g.subject.kind!=='USER'||!b2bUuid(g.subject.subjectId)||!integer(g.userAuthRevision)))fail(400,'INVALID_REPORT_READ_GRANT');return g;
}
/** Concrete Billing-owned READ authority. No write/issue proof is accepted.
 * Enrollment is private and independently stepped-up; no grant is inferred
 * from a report request, a reference document binding or an issuer certificate. */
export class PostgresReportsCorrectionReadAuthority implements ReportsCorrectionReadAuthority{
 constructor(private readonly pool:ReportsPgPool,private readonly identity:B2bIdentityPort,private readonly administrator:ReportsReadGrantAdministrator|null=null){}
 async current(token:string,kind:ReportsAuth['kind'],input:B2bCorrectionBinding){
  try{
   const binding=correctionEvidenceFreeze(input);if(!validB2bCorrectionBinding(binding))fail(400,'INVALID_REPORT_READ_GRANT');
   const frame=new B2bOwnerReadFrame(this.identity,kind),required=['b2b:reports:read','b2b:documents:read','b2b:corrections:read'] as const;
   const current=async()=>{const p=await frame.principal(token,[...required]);if(!b2bBindingsContain(p.bindings,binding.reference))fail(403,'REPORT_CORRECTION_READ_DENIED');return p;};
   const p=await current(),subject:Subject={kind:p.kind,clientId:p.clientId,subjectId:p.subjectId};
   const db=await this.pool.connect();let g:any;
   try{const rows=await db.query<{payload:any}>('SELECT "payload" FROM "B2bReportsCorrectionReadGrant" WHERE "grantKey"=$1',[key({binding,subject,clientRevision:p.revision,userAuthRevision:p.userAuthRevision})]);if(rows.rows.length!==1)fail(403,'REPORT_CORRECTION_READ_GRANT_REQUIRED');g=correctionEvidenceFreeze(rows.rows[0].payload);}
   finally{db.release();}
   if(g.active!==true||!integer(g.revision,1)||hash(g.binding)!==hash(binding)||hash(g.subject)!==hash(subject)||g.clientRevision!==p.revision||g.userAuthRevision!==p.userAuthRevision)fail(403,'REPORT_CORRECTION_READ_GRANT_REQUIRED');
   await current();return {action:'READ' as const,binding,actor:reportActor(p),clientRevision:p.revision,grantRevision:g.revision as number};
  }catch(e){if(e instanceof B2bSecurityError)throw e;fail(503,'REPORT_CORRECTION_READ_UNAVAILABLE');}
 }
 async setGrant(handle:string,input:unknown,expectedRevision:number){
  if(!this.administrator)fail(503,'REPORT_READ_ENROLLMENT_DISABLED');
  if(typeof handle!=='string'||!handle.length||handle.length>8192||!integer(expectedRevision)||expectedRevision>=2147483647)fail(400,'INVALID_REPORT_READ_GRANT');
  const requested=grant(input),digest=hash({policy:requested,expectedRevision}),administrator=this.administrator;
  const approval=async()=>{const a=correctionEvidenceFreeze(await administrator.authorize(handle,digest));if(!a||!b2bUuid(a.adminId)||!integer(a.authRevision)||a.policySha256!==digest)fail(403,'REPORT_READ_STEP_UP_REQUIRED');return a;};
  const first=await approval(),stamp=hash(first),grantKey=key(requested),payload={...requested,revision:expectedRevision+1};
  const db=await this.pool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await db.query("SET LOCAL statement_timeout='10s'");await db.query("SET LOCAL lock_timeout='3s'");
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[grantKey]);
   const rows=await db.query<{revision:number;id:string}>('SELECT "revision","id" FROM "B2bReportsCorrectionReadGrant" WHERE "grantKey"=$1 FOR UPDATE',[grantKey]);
   if((rows.rows[0]?.revision??0)!==expectedRevision)fail(409,'REPORT_READ_GRANT_CONFLICT');if(hash(await approval())!==stamp)fail(403,'REPORT_READ_STEP_UP_CHANGED');
   const id=rows.rows[0]?.id??randomUUID();
   const result=expectedRevision===0?await db.query('INSERT INTO "B2bReportsCorrectionReadGrant" ("id","grantKey","revision","payload") VALUES($1::uuid,$2,$3,$4::jsonb)',[id,grantKey,payload.revision,JSON.stringify(payload)]):
    await db.query('UPDATE "B2bReportsCorrectionReadGrant" SET "revision"=$2,"payload"=$3::jsonb WHERE "grantKey"=$1 AND "revision"=$4',[grantKey,payload.revision,JSON.stringify(payload),expectedRevision]);
   if(result.rowCount!==1)fail(409,'REPORT_READ_GRANT_CONFLICT');
   await db.query('INSERT INTO "B2bReportsCorrectionReadAudit" ("grantId","revision","adminId","authRevision","policySha256","requestSha256") VALUES($1::uuid,$2,$3::uuid,$4,$5,$6)',[id,payload.revision,first.adminId,first.authRevision,hash(payload),digest]);
   if(hash(await approval())!==stamp)fail(403,'REPORT_READ_STEP_UP_CHANGED');await db.query('COMMIT');return {revision:payload.revision,active:requested.active};
  }catch(e){try{await db.query('ROLLBACK');}catch{}if(e instanceof B2bSecurityError)throw e;fail(503,'REPORT_READ_GRANT_UNAVAILABLE');}
  finally{db.release();}
 }
}
