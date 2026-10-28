import type {B2bPrincipal} from '../../packages/contracts/src/b2b-security';
import {B2bSecurityError} from '../../packages/contracts/src/b2b-security';
import {correctionEvidenceHash as hash} from '../../packages/service-access/src/b2b-correction-evidence-wire';
import type {ReceptionWriteAction,ReceptionWriteAuthority} from '../../services/received-documents-service/src/b2b/commands';
import {PostgresReceptionWriteAuthority} from '../../services/received-documents-service/src/b2b/write-authority';
import {B2bReceptionCommands} from '../../services/received-documents-service/src/b2b/commands';
export const id=(n:number)=>`fea80800-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const scope={environment:'BETA' as const,companyId:1,recipientRuc:'00000000101',branchId:id(1)};
export const target={...scope,branchId:id(2)};
export const access={token:'synthetic-received-write-token',kind:'SERVICE' as const};
export const file=(text:string|Buffer,name='original.xml')=>({fileName:name,contentBase64:Buffer.from(text).toString('base64')});
export function fixture(db:any){
 const principal:B2bPrincipal={kind:'SERVICE',clientId:id(3),revision:1,subjectId:null,userAuthRevision:null,environment:'BETA',scopes:['b2b:received:write'],
  bindings:[scope,target].map(s=>({issuerId:s.companyId,issuerRuc:s.recipientRuc,environment:s.environment,branchId:s.branchId,pointId:id(4),seriesId:id(5),documentType:'01'}))};
 const control={identityCalls:0,adminCalls:0,revoked:false,identityHook:null as null|((n:number)=>Promise<void>|void),adminHook:null as null|((n:number,digest:string)=>Promise<void>|void),adminRevision:1,badDigest:false};
 const identity={authenticate:async(_token:string,required:readonly string[],kind:'SERVICE'|'USER')=>{
  await control.identityHook?.(++control.identityCalls);
  if(control.revoked||kind!==principal.kind||required.some(s=>!principal.scopes.some(own=>own===s)))throw new B2bSecurityError(403,'RECEIVED_ACCESS_DENIED');
  return structuredClone(principal);
 }};
 const admin={authorize:async(handle:string,digest:string)=>{
  await control.adminHook?.(++control.adminCalls,digest);
  if(handle!=='synthetic-live-step-up')throw new B2bSecurityError(403,'STEP_UP_REQUIRED');
  return {adminId:id(90),authRevision:control.adminRevision,policySha256:control.badDigest?hash('wrong'):digest};
 }};
 const authority=new PostgresReceptionWriteAuthority(db,admin);
 const owner=new B2bReceptionCommands(db,identity,authority);
 const policy=(action:ReceptionWriteAction,s=scope)=>({scope:s,subject:{kind:principal.kind,clientId:principal.clientId,subjectId:principal.subjectId},action,active:true,clientRevision:principal.revision,userAuthRevision:principal.userAuthRevision});
 const grant=(action:ReceptionWriteAction,s=scope,expected=0,active=true)=>authority.setGrant('synthetic-live-step-up',{...policy(action,s),active},expected);
 const alternate=(database=db,writeAuthority:ReceptionWriteAuthority=authority)=>new B2bReceptionCommands(database,identity,writeAuthority);
 return {principal,control,identity,admin,authority,owner,grant,policy,alternate};
}
