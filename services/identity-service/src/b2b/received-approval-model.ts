import {B2bSecurityError,type B2bBinding} from '@factuez/contracts/b2b-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {correctionEvidenceFreeze as copy,correctionEvidenceHash as hash} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedScope,type ReceivedScope} from '@factuez/service-access/dist/b2b-received-wire';
export {copy,hash};
export const denied=()=>new B2bSecurityError(403,'RECEIVED_STEP_UP_DENIED');
export const unavailable=()=>new B2bSecurityError(503,'RECEIVED_APPROVAL_UNAVAILABLE');
export const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const integer=(v:unknown,min=0)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=2147483647;
export function exact(v:any,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))throw denied();}
export const automationActions=['CONFIG_READ','CONFIG_SAVE','SYNC_CREATE','SYNC_READ'];
const grantActions=[...automationActions,'LIVE_READ_ONLY','SYNC_EXECUTE'];
export interface ApprovalContext {purpose:'GRANT'|'AUTOMATION';action:string;scope:ReceivedScope;requestSha256:string;requiredScope:string;policy?:any;expectedRevision?:number}
export interface ApprovalRow {
 schemaVersion:'factuez.b2b.received-approval.v1';approvalId:string;nonceHash:string;tokenSha256:string;context:ApprovalContext;
 adminId:string;authRevision:number;clientId:string;clientRevision:number;identitySha256:string;targetSha256:string|null;createdAt:number;expiresAt:number;
}
export function approvalContext(input:unknown):ApprovalContext {
 try{
  const v:any=copy(input);
  if(v?.schemaVersion!=='factuez.b2b.received-approval-prepare.v1')throw denied();
  if(v.purpose==='AUTOMATION'){
   exact(v,['schemaVersion','purpose','scope','action','requestSha256']);if(!automationActions.includes(v.action)||!sha(v.requestSha256))throw denied();
   return {purpose:v.purpose,scope:receivedScope(v.scope),action:v.action,requestSha256:v.requestSha256,requiredScope:v.action.startsWith('CONFIG_')?'b2b:received:configure':'b2b:received:sync'};
  }
  exact(v,['schemaVersion','purpose','policy','expectedRevision']);if(v.purpose!=='GRANT'||!integer(v.expectedRevision)||v.expectedRevision===2147483647)throw denied();
  const p=v.policy;const read=Object.hasOwn(p??{},'permission');
  exact(p,['scope','subject','clientRevision','userAuthRevision','active',read?'permission':'action']);exact(p.subject,['kind','clientId','subjectId']);
  if(!b2bUuid(p.subject.clientId)||!integer(p.clientRevision,1)||typeof p.active!=='boolean'||
   (p.subject.kind==='SERVICE'?p.subject.subjectId!==null||p.userAuthRevision!==null:p.subject.kind!=='USER'||!b2bUuid(p.subject.subjectId)||!integer(p.userAuthRevision))||
   (read?!['READ','ARTIFACT'].includes(p.permission):!grantActions.includes(p.action)))throw denied();
  const scope=receivedScope(p.scope),policy={...p,scope};
  return {purpose:'GRANT',action:read?'SET_'+p.permission+'_GRANT':'SET_'+p.action+'_GRANT',scope,requestSha256:hash({policy,expectedRevision:v.expectedRevision}),requiredScope:'b2b:received:configure',policy,expectedRevision:v.expectedRevision};
 }catch{throw denied();}
}
export function anchor(bindings:B2bBinding[],scope:ReceivedScope){const b=bindings.find(b=>b.environment===scope.environment&&b.issuerId===scope.companyId&&b.issuerRuc===scope.recipientRuc&&b.branchId===scope.branchId);if(!b)throw denied();return b;}
export function targetScopes(c:ApprovalContext){const p=c.policy;if(p?.permission)return p.permission==='READ'?['b2b:received:read']:['b2b:received:read','b2b:received:artifacts:read'];return [String(p?.action).startsWith('CONFIG_')||p?.action==='LIVE_READ_ONLY'?'b2b:received:configure':'b2b:received:sync'];}
