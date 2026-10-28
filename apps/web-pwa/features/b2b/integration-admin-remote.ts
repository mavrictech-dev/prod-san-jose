import type {IntegrationAdminPort,IntegrationAdminClient} from './integration-admin-model';
import {validB2bBinding,B2bEnabledIdentityScopes} from '@factuez/contracts/b2b-security';
/** Supplied by the session-bound BFF host. This adapter never reads PWA cookies,
 * localStorage, environment variables or Bearer tokens. Node mTLS stays server-side. */
export interface AuthorizedAdminHttpClient{request<T>(path:string,init?:{method:'POST'|'PATCH';body:unknown}):Promise<T>}
function fail():never{throw {status:503,code:'INVALID_ADMIN_RESPONSE'};}
function id(v:unknown):asserts v is string{if(typeof v!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v))fail();}
function client(v:any):IntegrationAdminClient{
 if(!v||Object.keys(v).sort().join(',')!=='bindings,enabled,id,kind,label,oidcClientId,revision,scopes')fail();id(v.id);
 if(typeof v.label!=='string'||!v.label.trim()||v.label.length>120||!['SERVICE','USER'].includes(v.kind)||typeof v.enabled!=='boolean'||!Number.isSafeInteger(v.revision)||v.revision<1||!Array.isArray(v.scopes)||!v.scopes.length||v.scopes.some((s:any)=>!B2bEnabledIdentityScopes.includes(s))||!Array.isArray(v.bindings)||!v.bindings.length||v.bindings.length>500||!v.bindings.every(validB2bBinding)||v.kind==='SERVICE'&&v.oidcClientId!==null||v.kind==='USER'&&typeof v.oidcClientId!=='string')fail();return structuredClone(v);
}
function reply(v:any,keys:string[]){
 if(!v||v.schemaVersion!=='factuez.b2b.v1'||v.source!=='SOURCE'||v.environment!=='BETA'||v.candidateOnly!==true||Object.keys(v).sort().join(',')!==['schemaVersion','source','environment','candidateOnly',...keys].sort().join(','))fail();return v;
}
export function createIntegrationAdminPort(http:AuthorizedAdminHttpClient):IntegrationAdminPort{
 const base='/b2b/v1/admin/applications',q='?environment=BETA';
 const mutation=async(path:string,method:'POST'|'PATCH',body:unknown,secretAllowed:boolean)=>{
  const r:any=await http.request(path,{method,body}),has=Object.hasOwn(r??{},'clientSecret');reply(r,['application',...(has?['clientSecret']:[])]);const c=client(r.application);
  if(has&&(!secretAllowed||c.kind!=='SERVICE'||typeof r.clientSecret!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(r.clientSecret)))fail();
  if(secretAllowed&&c.kind==='SERVICE'&&!has)fail();return {client:c,...(has?{clientSecret:r.clientSecret}: {})};
 };
 return {
  async list(query){if(!Number.isInteger(query.limit)||query.limit<1||query.limit>50)throw {status:400,code:'INVALID_QUERY'};if(query.after)id(query.after);
   const r:any=reply(await http.request(base+q+'&limit='+query.limit+(query.after?'&after='+query.after:'')),['items','nextAfter']);
   if(!Array.isArray(r.items)||r.items.length>query.limit||r.nextAfter!==null&&typeof r.nextAfter!=='string')fail();const items=r.items.map(client);if(r.nextAfter!==null){id(r.nextAfter);if(items.length!==query.limit||r.nextAfter!==items.at(-1)?.id)fail();}
   return {items,nextAfter:r.nextAfter,hasMore:r.nextAfter!==null};
  },
  async read(appId){id(appId);const r=reply(await http.request(base+'/'+appId+q),['application']),c=client(r.application);if(c.id!==appId)fail();return c;},
  create:input=>mutation(base+q,'POST',input,true),
  async update(appId,input){id(appId);const r=await mutation(base+'/'+appId+q,'PATCH',input,false);if(r.client.id!==appId||r.client.revision!==input.expectedRevision+1)fail();return {client:r.client};},
  async rotate(appId,input){id(appId);const r=await mutation(base+'/'+appId+'/rotate-secret'+q,'POST',input,true);if(r.client.id!==appId||r.client.revision!==input.expectedRevision+1)fail();return r;},
 };
}
