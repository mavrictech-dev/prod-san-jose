import {randomBytes} from 'node:crypto';
import type {B2bPrincipal} from '../../packages/contracts/src/b2b-security';
import {B2bSecurityError} from '../../packages/contracts/src/b2b-security';
import {defaultReceptionSettings} from '../../services/received-documents-service/src/automation/policy';
import {B2bReceptionAutomation,createReceptionAutomationVault,type ReceptionAutomationOptions} from '../../services/received-documents-service/src/b2b/automation';
import {PostgresReceptionAutomationAuthority,type ReceptionAutomationPolicyAction} from '../../services/received-documents-service/src/b2b/automation-authority';
export const id=(n:number)=>`fea80810-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const scope={environment:'BETA' as const,companyId:1,recipientRuc:'00000000101',branchId:id(1)};
export const access={token:'synthetic-automation-token',kind:'USER' as const};
export const stepUpHandle='synthetic-global-step-up';
export const localSettings=()=>({...defaultReceptionSettings(),enabled:true,mode:'LOCAL_FIXTURE' as const,mailbox:{...defaultReceptionSettings().mailbox,enabled:true},sire:{...defaultReceptionSettings().sire,enabled:true}});
export const liveSettings=()=>({...localSettings(),mode:'LIVE_READ_ONLY' as const,mailbox:{...localSettings().mailbox,host:'imap.example.com',username:'FAKE'},sire:{...localSettings().sire,clientId:'fake-client',solUsername:'FAKEUSER'}});
export function fixture(db:any,custom:Partial<ReceptionAutomationOptions>={}){
 const principal:B2bPrincipal={kind:'USER',clientId:id(2),subjectId:id(3),revision:1,userAuthRevision:1,environment:'BETA',scopes:['b2b:received:configure','b2b:received:sync'],
 bindings:[scope,{...scope,companyId:2,recipientRuc:'00000000202',branchId:id(4)},{...scope,companyId:3,recipientRuc:'99999999999',branchId:id(5)}].map(s=>({issuerId:s.companyId,issuerRuc:s.recipientRuc,environment:s.environment,branchId:s.branchId,pointId:id(6),seriesId:id(7),documentType:'01'}))};
 const control={identityCalls:0,adminCalls:0,enrollmentCalls:0,revoked:false,global:true,adminRevision:1,adminHook:null as null|((n:number)=>void|Promise<void>),identityHook:null as null|((n:number)=>void|Promise<void>),enrollmentHook:null as null|((n:number)=>void|Promise<void>)};
 const identity={authenticate:async(_token:string,required:readonly string[],kind:'USER'|'SERVICE')=>{
  await control.identityHook?.(++control.identityCalls);if(control.revoked||kind!==principal.kind||required.some(s=>!principal.scopes.some(x=>x===s)))throw new B2bSecurityError(403,'RECEIVED_AUTOMATION_ACCESS_DENIED');return structuredClone(principal);
 }};
 const administrator={authorize:async(_p:B2bPrincipal,s:typeof scope,_a:string,handle:string,digest:string)=>{
  await control.adminHook?.(++control.adminCalls);if(!control.global||handle!==stepUpHandle)throw new B2bSecurityError(403,'RECEIVED_GLOBAL_ADMIN_REQUIRED');
  return {adminId:principal.subjectId!,authRevision:control.adminRevision,scope:s,requestSha256:digest,authority:'GLOBAL_ADMIN' as const};
 }};
 const enrollment={authorize:async(handle:string,digest:string)=>{await control.enrollmentHook?.(++control.enrollmentCalls);if(handle!=='synthetic-enrollment')throw new B2bSecurityError(403,'STEP_UP_REQUIRED');return {adminId:id(90),authRevision:1,policySha256:digest};}};
 const vault=createReceptionAutomationVault(randomBytes(32)),config:ReceptionAutomationOptions={vault,userAdministrator:administrator,localFixtureEnabled:true,...custom};
 const authority=new PostgresReceptionAutomationAuthority(db,enrollment),owner=new B2bReceptionAutomation(db,identity,authority,config);
 const policy=(action:ReceptionAutomationPolicyAction,s=scope)=>({scope:s,subject:{kind:principal.kind,clientId:principal.clientId,subjectId:principal.subjectId},action,clientRevision:principal.revision,userAuthRevision:principal.userAuthRevision,active:true});
 const grant=(action:ReceptionAutomationPolicyAction,s=scope,expected=0,active=true)=>authority.setGrant('synthetic-enrollment',{...policy(action,s),active},expected);
 const alternate=(database=db,changes:Partial<ReceptionAutomationOptions>={})=>new B2bReceptionAutomation(database,identity,authority,{...config,...changes});
 return {principal,control,identity,administrator,enrollment,vault,authority,owner,policy,grant,config,alternate};
}
