import {randomUUID} from 'node:crypto';
import {B2bIdentity} from './service';
import {OnpremVerifiedAdminAuthority,type OnpremRequest} from './onprem-admin-authority';
import {plain,fail,uuid} from './model';
const wrap=(body:Record<string,unknown>)=>({schemaVersion:'factuez.b2b.v1',source:'SOURCE',environment:'BETA',candidateOnly:true,...body});
/** Native browser facade over the same B2bIdentity persistent client manager.
 * No human JWT or password crosses the private owner/catalogue boundary. */
export class OnpremAdminApplications {
 constructor(private readonly identity:B2bIdentity,private readonly authority:OnpremVerifiedAdminAuthority){}
 async run(req:OnpremRequest,action:'LIST'|'READ'|'CREATE'|'UPDATE'|'ROTATE',id:string|undefined,query:unknown,body?:unknown){
  if(!query||typeof query!=='object'||Array.isArray(query)||![Object.prototype,null].includes(Object.getPrototypeOf(query)))return fail(400,'INVALID_QUERY');
  const q=query as Record<string,unknown>;
  if(q.environment!=='BETA'||Object.keys(q).some(k=>!['environment',...(action==='LIST'?['limit','after']:[])].includes(k)))return fail(400,'INVALID_QUERY');
  if(action!=='LIST'&&action!=='CREATE'&&!uuid(id))return fail(400,'INVALID_REQUEST');
  if(action==='CREATE'&&(!plain(body)||body.kind!=='SERVICE'||Object.hasOwn(body,'oidcClientId')))return fail(400,'ONPREM_READONLY_SERVICE_REQUIRED');
  const ctx={requestId:randomUUID(),peer:'onprem-native-browser'};
  return this.authority.execute(req,async proof=>{
   if(action==='LIST')return wrap(await this.identity.list(proof,{...q},ctx));
   if(action==='READ')return wrap({application:await this.identity.read(proof,id!,ctx)});
   const result=action==='CREATE'?await this.identity.create(proof,body,ctx):await this.identity.change(proof,id!,body,ctx,action==='ROTATE');
   return wrap({application:result.client,...(result.clientSecret?{clientSecret:result.clientSecret}:{})});
  });
 }
}
