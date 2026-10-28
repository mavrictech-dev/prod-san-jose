import {randomUUID} from 'node:crypto';
import {B2bSecurityError,validB2bPrincipal,type B2bPrincipal} from '@factuez/contracts/b2b-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedAnchor,receivedScope,receivedSubject,receivedFail,type ReceivedScope,type ReceivedSubject} from '@factuez/service-access/dist/b2b-received-wire';
import type {ReceptionWriteAction,ReceptionWriteAuthority} from './commands';
import type {ReceptionGrantAdministrator} from './read';
import type {ReceivedDatabase} from './store';

export type ReceptionWriteGrant={scope:ReceivedScope;subject:ReceivedSubject;action:ReceptionWriteAction;clientRevision:number;userAuthRevision:number|null;active:boolean;revision:number};
export const receptionWriteGrantKey=(scope:ReceivedScope,subject:ReceivedSubject,action:ReceptionWriteAction)=>hash({scope,subject,action});
const actions=['IMPORT','ATTACH','ASSIGN','REGISTER'];
const integer=(v:unknown,min:number)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=2147483647;
function copy(value:unknown):any{try{return correctionEvidenceFreeze(value);}catch{receivedFail();}}
function exact(v:any,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.sort().join(','))receivedFail();}
function policy(input:unknown,revision:number):ReceptionWriteGrant{
  const v=copy(input);exact(v,['scope','subject','action','clientRevision','userAuthRevision','active']);
  const scope=receivedScope(v.scope),who=v.subject;exact(who,['kind','clientId','subjectId']);
  if(!b2bUuid(who.clientId)||!actions.includes(v.action)||typeof v.active!=='boolean'||!integer(v.clientRevision,1)||
    (who.kind==='SERVICE'?(who.subjectId!==null||v.userAuthRevision!==null):
      who.kind!=='USER'||!b2bUuid(who.subjectId)||!integer(v.userAuthRevision,0)))receivedFail();
  return {...v,scope,revision};
}
/** Local write enrollment only. No READ inheritance, automatic grants, Identity
 * SQL or application-bootstrap DDL. Every authorization reads a fresh snapshot
 * outside the command transaction so a mid-command revocation is observable. */
export class PostgresReceptionWriteAuthority implements ReceptionWriteAuthority{
  constructor(private readonly db:ReceivedDatabase,private readonly admin:ReceptionGrantAdministrator|null=null){}
  async authorize(principal:B2bPrincipal,input:ReceivedScope,action:ReceptionWriteAction){
    try{
      const p=copy(principal),scope=receivedScope(input);
      if(!validB2bPrincipal(p)||!p.scopes.includes('b2b:received:write')||!actions.includes(action))receivedFail(403,'RECEIVED_ACCESS_DENIED');
      receivedAnchor(p,scope);
      const subject=receivedSubject(p),key=receptionWriteGrantKey(scope,subject,action);
      return await this.db.$transaction(async tx=>{
        const rows=await tx.$queryRawUnsafe<any[]>('SELECT "policyId","policy","revision" FROM "B2bReceivedWriteGrant" WHERE "grantKey"=$1',key);
        const g=rows[0]?.policy;
        if(rows.length!==1||!b2bUuid(rows[0].policyId)||!g||g.active!==true||g.action!==action||
          !integer(g.revision,1)||g.revision!==rows[0].revision||g.clientRevision!==p.revision||g.userAuthRevision!==p.userAuthRevision||
          hash(g.scope)!==hash(scope)||hash(g.subject)!==hash(subject))receivedFail(403,'RECEIVED_WRITE_GRANT_REQUIRED');
        return {policyId:rows[0].policyId as string,revision:g.revision as number};
      },{isolationLevel:'Serializable',timeout:30000,maxWait:3000});
    }catch(e){if(e instanceof B2bSecurityError)throw e;receivedFail(503,'RECEIVED_OWNER_UNAVAILABLE');}
  }
  async setGrant(handle:string,input:unknown,expectedRevision:number){
    try{
      if(!this.admin)receivedFail(503,'RECEIVED_STEP_UP_NOT_CONFIGURED');
      if(typeof handle!=='string'||!handle.length||handle.length>8192||!integer(expectedRevision,0)||expectedRevision===2147483647)receivedFail();
      const grant=policy(input,expectedRevision+1),{revision:_,...requested}=grant;
      const digest=hash({policy:requested,expectedRevision}),admin=this.admin;
      const authorize=async()=>{
        const a=copy(await admin.authorize(handle,digest));
        if(!a||!b2bUuid(a.adminId)||!integer(a.authRevision,0)||a.policySha256!==digest)receivedFail(403,'STEP_UP_REQUIRED');
        return hash(a);
      };
      const first=await authorize(),key=receptionWriteGrantKey(grant.scope,grant.subject,grant.action);
      const result=await this.db.$transaction(async tx=>{
        await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))',key);
        const rows=await tx.$queryRawUnsafe<any[]>('SELECT "policyId","revision" FROM "B2bReceivedWriteGrant" WHERE "grantKey"=$1 FOR UPDATE',key);
        if((rows[0]?.revision??0)!==expectedRevision)receivedFail(409,'RECEIVED_POLICY_CONFLICT');
        if(await authorize()!==first)receivedFail(403,'STEP_UP_CHANGED');
        const policyId=rows[0]?.policyId??randomUUID();
        const n=expectedRevision===0?await tx.$executeRawUnsafe('INSERT INTO "B2bReceivedWriteGrant" ("grantKey","policyId","policy","revision") VALUES($1,$2::uuid,$3::jsonb,$4)',key,policyId,JSON.stringify(grant),grant.revision):
          await tx.$executeRawUnsafe('UPDATE "B2bReceivedWriteGrant" SET "policy"=$2::jsonb,"revision"=$3 WHERE "grantKey"=$1 AND "revision"=$4',key,JSON.stringify(grant),grant.revision,expectedRevision);
        if(n!==1)receivedFail(409,'RECEIVED_POLICY_CONFLICT');
        // Reauthorize returns an opaque stamp; the trusted admin identity is
        // obtained again and compared before writing the append-only audit.
        const proof=copy(await admin.authorize(handle,digest));
        if(hash(proof)!==first)receivedFail(403,'STEP_UP_CHANGED');
        if(await tx.$executeRawUnsafe('INSERT INTO "B2bReceivedWritePolicyAudit" ("policyId","revision","adminId","authRevision","policySha256","requestSha256") VALUES($1::uuid,$2,$3::uuid,$4,$5,$6)',
          policyId,grant.revision,proof.adminId,proof.authRevision,hash(grant),digest)!==1)receivedFail(503,'RECEIVED_OWNER_UNAVAILABLE');
        if(await authorize()!==first)receivedFail(403,'STEP_UP_CHANGED');
        return {revision:grant.revision,active:grant.active};
      },{isolationLevel:'Serializable',timeout:30000,maxWait:3000});
      if(await authorize()!==first)receivedFail(403,'STEP_UP_CHANGED');
      return result;
    }catch(e){
      if(e instanceof B2bSecurityError)throw e;
      // Driver and Prisma errors are never part of the public error vocabulary.
      const v=e as {code?:string;meta?:{code?:string;driverAdapterError?:{cause?:{originalCode?:string}}}};
      if(['P2034','P2002','40001','23505','40P01'].includes(v?.code??'')||[v?.meta?.code,v?.meta?.driverAdapterError?.cause?.originalCode].some(code=>['40001','23505','40P01'].includes(code??'')))receivedFail(409,'RECEIVED_POLICY_CONFLICT');
      receivedFail(503,'RECEIVED_OWNER_UNAVAILABLE');
    }
  }
}


