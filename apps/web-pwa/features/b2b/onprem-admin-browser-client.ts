import {validB2bBinding} from '@factuez/contracts/b2b-security';
import type {AuthorizedAdminHttpClient} from './integration-admin-remote';
export type OnpremSessionApi=<T>(path:string,options?:RequestInit)=>Promise<T>;
export const onpremReadonlyScopes=['b2b:context:read','b2b:catalog:read','b2b:documents:read','b2b:artifacts:read','b2b:webhooks:read','b2b:webhooks:manage'] as const;
export interface OnpremSessionState {
 phase:'checking'|'disabled'|'password-required'|'authenticated'|'expired'|'error'|'closed';busy:boolean;
 expiresAt:number|null;error:string|null;
}
export interface OnpremBrowserClient extends AuthorizedAdminHttpClient {
 subscribe(fn:()=>void):()=>void;getSnapshot():OnpremSessionState;
 status():Promise<void>;reauthenticate(password:string):Promise<void>;logout():Promise<void>;close():void;
}
export const onpremServerState:OnpremSessionState=Object.freeze({phase:'checking',busy:false,expiresAt:null,error:null});
const base='/api/v1/b2b-admin',source='/b2b/v1/admin/applications',uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail(status:number,code:string):never{throw Object.assign(new Error(code),{status,code});}
function exact(v:any,keys:string[]){return v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');}
export function onpremApplicationTarget(path:string,method:string){
 if(typeof path!=='string'||path.length>2048||/[%#\\\s]/.test(path))return fail(400,'INVALID_ONPREM_PATH');
 const parts=path.split('?');if(parts.length!==2)return fail(400,'INVALID_ONPREM_PATH');
 const tail=parts[0]===source?[]:parts[0].startsWith(source+'/')?parts[0].slice(source.length+1).split('/'):['invalid'];
 const collection=tail.length===0,detail=tail.length===1&&uuid.test(tail[0]),rotate=tail.length===2&&uuid.test(tail[0])&&tail[1]==='rotate-secret';
 if(!(method==='GET'&&(collection||detail)||method==='POST'&&(collection||rotate)||method==='PATCH'&&detail))return fail(400,'INVALID_ONPREM_PATH');
 const q:Record<string,string>={};
 for(const entry of parts[1].split('&')){
  const [key,value,...extra]=entry.split('=');
  if(extra.length||Object.hasOwn(q,key)||!value||!(key==='environment'?value==='BETA':method==='GET'&&collection&&(key==='limit'?/^(?:[1-9]|[1-4][0-9]|50)$/.test(value):key==='after'&&uuid.test(value))))return fail(400,'INVALID_ONPREM_QUERY');
  q[key]=value;
 }
 if(q.environment!=='BETA')return fail(400,'INVALID_ONPREM_QUERY');
 return {path:base+'/applications'+(collection?'':('/'+tail.join('/')))+(method==='GET'?(collection?'/query':'/read'):'')+(method==='GET'&&collection?'':'?'+parts[1]),
  method:method==='GET'?'POST':method,query:q};
}
function validateMutation(method:string,body:any){
 if(!body||typeof body!=='object'||Array.isArray(body))return fail(400,'INVALID_ONPREM_BODY');
 if(body.kind!==undefined&&body.kind!=='SERVICE'||Object.hasOwn(body,'oidcClientId'))return fail(400,'ONPREM_READONLY_SERVICE_REQUIRED');
 if(body.scopes!==undefined&&(!Array.isArray(body.scopes)||!body.scopes.length||body.scopes.some((s:string)=>!(onpremReadonlyScopes as readonly string[]).includes(s))))return fail(400,'ONPREM_READONLY_SCOPES_REQUIRED');
 if(body.bindings!==undefined&&(!Array.isArray(body.bindings)||!body.bindings.length||!body.bindings.every(validB2bBinding)))return fail(400,'ONPREM_BETA_BINDINGS_REQUIRED');
}
/** Uses only the workspace's existing authorized API function. No token/cookie
 * reading, new login, storage, redirects, automatic reauth or mutation retries. */
export function createOnpremBrowserClient(api:OnpremSessionApi,now=Date.now):OnpremBrowserClient{
 let state=onpremServerState,csrf:string|null=null,closed=false,epoch=0,timer:ReturnType<typeof setTimeout>|undefined;
 const listeners=new Set<()=>void>(),abort=new AbortController();
 const update=(patch:Partial<OnpremSessionState>)=>{state=Object.freeze({...state,...patch});for(const fn of listeners)fn();};
 const invalidate=(phase:'expired'|'error'|'closed',error:string|null)=>{epoch++;csrf=null;clearTimeout(timer);update({phase,busy:false,error,expiresAt:null});};
 const call=async<T>(path:string,method:string,body:unknown,withCsrf:boolean)=>{
  if(closed)return fail(401,'ONPREM_SESSION_CLOSED');
  try{
   return await api<T>(path,{method,body:JSON.stringify(body),cache:'no-store',credentials:'same-origin',redirect:'error',signal:abort.signal,
    headers:{'Content-Type':'application/json','X-FactuEz-B2b-Admin':'ONPREM',...(withCsrf?{'X-FactuEz-CSRF':csrf??''}:{})}});
  }catch(error){
   const status=Number((error as {status?:number})?.status)||503;
   if(status===401||status===403)invalidate('expired','ONPREM_REAUTH_REQUIRED');
   else if(status===503)invalidate('error','ONPREM_SERVICE_UNAVAILABLE');
   throw Object.assign(new Error('ONPREM_REQUEST_FAILED'),{status});
  }
 };
 const install=(v:any)=>{
  if(!exact(v,['profile','enabled','environment','authenticated','csrfToken','expiresAt','serviceOnly','readonly'])||v.profile!=='ONPREM'||v.enabled!==true||
   v.environment!=='BETA'||typeof v.authenticated!=='boolean'||v.serviceOnly!==true||v.readonly!==true||
   typeof v.csrfToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(v.csrfToken)||typeof v.expiresAt!=='string'||
   !Number.isFinite(Date.parse(v.expiresAt))||Date.parse(v.expiresAt)<=now()||Date.parse(v.expiresAt)>now()+125000)return fail(503,'INVALID_ONPREM_STATUS');
  csrf=v.csrfToken;clearTimeout(timer);
  const expiresAt=Date.parse(v.expiresAt);
  timer=setTimeout(()=>invalidate('expired','ONPREM_REAUTH_REQUIRED'),Math.max(0,expiresAt-now()));
  update({phase:v.authenticated?'authenticated':'password-required',busy:false,error:null,expiresAt});
 };
 const client:OnpremBrowserClient={
  getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn);};},
  async status(){
   if(closed)return;const revision=++epoch;csrf=null;update({phase:'checking',busy:true,error:null});
   try{
    const v:any=await call(base+'/status','POST',{},false);if(closed||revision!==epoch)return;
    if(exact(v,['profile','enabled','environment','authenticated'])&&v.profile==='ONPREM'&&v.enabled===false&&v.environment==='BETA'&&v.authenticated===false){update({phase:'disabled',busy:false,expiresAt:null,error:null});return;}
    install(v);
   }catch(error){if(!closed&&revision===epoch)invalidate('error','ONPREM_STATUS_UNVERIFIED');throw error;}
  },
  async reauthenticate(password){
   if(closed||state.busy||!csrf||state.phase!=='password-required'||typeof password!=='string'||!password||password.length>256)return fail(403,'ONPREM_PASSWORD_REAUTH_REQUIRED');
   const revision=epoch;update({busy:true,error:null});
   try{
    const v:any=await call(base+'/reauthenticate','POST',{password},true);password='';
    if(closed||revision!==epoch)return;
    if(!exact(v,['profile','authenticated','expiresAt'])||v.profile!=='ONPREM'||v.authenticated!==true||Date.parse(v.expiresAt)!==state.expiresAt)return fail(503,'INVALID_ONPREM_REAUTH');
    update({phase:'authenticated',busy:false,error:null});
   }catch(error){password='';if(!closed&&revision===epoch)invalidate('error','ONPREM_REAUTH_FAILED');throw error;}
  },
  async request<T>(path:string,init?:{method:'POST'|'PATCH';body:unknown}){
   if(closed||state.phase!=='authenticated'||!csrf||!state.expiresAt||state.expiresAt<=now())return fail(403,'ONPREM_PASSWORD_REAUTH_REQUIRED');
   const method=init?.method??'GET',target=onpremApplicationTarget(path,method),revision=epoch;
   if(method!=='GET')validateMutation(method,init?.body);
   const v=await call<T>(target.path,target.method,method==='GET'?(target.path.endsWith('/query')?target.query:{}):init!.body,true);
   if(closed||revision!==epoch||state.phase!=='authenticated'||!state.expiresAt||state.expiresAt<=now())return fail(401,'ONPREM_SESSION_CHANGED');
   return v;
  },
  async logout(){
   try{if(csrf&&!closed)await call(base+'/logout','POST',{},true);}finally{invalidate('expired','ONPREM_REAUTH_REQUIRED');}
  },
  close(){closed=true;abort.abort();invalidate('closed',null);listeners.clear();},
 };
 return client;
}
