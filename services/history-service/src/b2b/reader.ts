import { B2bSecurityError,b2bBindingsContain,validB2bBinding,validB2bPrincipal,type B2bIdentityScope } from '@factuez/contracts/b2b-security';
import { HISTORY_ARTIFACT_KINDS,historicalSha256 } from '@factuez/history-core';
import type { B2bHistoryAction,B2bHistoryAuth,B2bHistoryInputMap,B2bHistoryArchivePort,B2bHistoryLiveIdentity } from './types';
export function denyHistory(status:number,code:string):never {throw new B2bSecurityError(status,code);}
export function historyObject(value:unknown):Record<string,any> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))) denyHistory(400,'INVALID_REQUEST');
  return value as Record<string,any>;
}
function keys(v:Record<string,unknown>,allowed:string[],required:string[]) {
  if(Object.keys(v).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(v,k))) denyHistory(400,'INVALID_REQUEST');
}
/** Independent B2B reader; no legacy session delegation and no automatic enrollment. */
export class B2bHistoryReads {
  constructor(private readonly identity:B2bHistoryLiveIdentity,private readonly archive:B2bHistoryArchivePort|null,
    private readonly options:{enabled?:boolean;environment?:'BETA';datasetClass?:'SYNTHETIC'}={}){}
  async execute<A extends B2bHistoryAction>(auth:B2bHistoryAuth,action:A,input:B2bHistoryInputMap[A]):Promise<any> {
    if(this.options.enabled!==true) denyHistory(503,'HISTORY_B2B_DISABLED');
    if(this.options.environment!=='BETA'||this.options.datasetClass!=='SYNTHETIC') denyHistory(503,'HISTORY_SYNTHETIC_PROFILE_REQUIRED');
    const a=historyObject(auth);keys(a,['token','kind'],['token','kind']);
    if(typeof a.token!=='string'||!a.token||a.token.length>16384||!['SERVICE','USER'].includes(a.kind)||!['LIST','DETAIL','CONTENT'].includes(action)) denyHistory(400,'INVALID_REQUEST');
    const token=a.token as string,kind=a.kind as 'SERVICE'|'USER';
    let raw:Record<string,any>;try{raw=historyObject(structuredClone(input));}catch{return denyHistory(400,'INVALID_REQUEST');}
    keys(raw,action==='LIST'?['binding','take','afterRecordId']:action==='DETAIL'?['binding','recordId']:['binding','recordId','artifactKind'],
      action==='LIST'?['binding']:action==='DETAIL'?['binding','recordId']:['binding','recordId','artifactKind']);
    if(Buffer.byteLength(JSON.stringify(raw))>16384||!validB2bBinding(raw.binding)) denyHistory(400,'INVALID_BINDING');
    if(action==='LIST') {
      raw.take=raw.take??25;
      if(!Number.isSafeInteger(raw.take)||raw.take<1||raw.take>100||raw.afterRecordId!==undefined&&!/^[a-f0-9]{64}$/.test(raw.afterRecordId)) denyHistory(400,'INVALID_QUERY');
    }else if(typeof raw.recordId!=='string'||!/^[a-f0-9]{64}$/.test(raw.recordId)||action==='CONTENT'&&!HISTORY_ARTIFACT_KINDS.includes(raw.artifactKind)) denyHistory(400,'INVALID_QUERY');
    const scopes:B2bIdentityScope[]=['b2b:history:read'];if(action==='CONTENT') scopes.push('b2b:artifacts:read');
    let stamp:string|null=null;
    const live=async()=>{
      const p=await this.identity.authenticate(token,scopes,kind);
      if(!validB2bPrincipal(p)||p.kind!==kind||scopes.some(s=>!p.scopes.includes(s))) denyHistory(401,'INVALID_PRINCIPAL');
      const fresh=historicalSha256(p);if(stamp!==null&&stamp!==fresh) denyHistory(401,'ACCESS_CHANGED');stamp=fresh;
      if(!b2bBindingsContain(p.bindings,raw.binding)) denyHistory(404,'RESOURCE_NOT_FOUND');return structuredClone(p);
    };
    await live();
    if(!this.archive) denyHistory(503,'HISTORY_ARCHIVE_PORT_REQUIRED');
    const result=await this.archive.execute(action,raw as B2bHistoryInputMap[A],live);await live();return result;
  }
}