import { request } from 'node:https';
import type { ConnectionOptions } from 'node:tls';
import { inspect } from 'node:util';
import type { ProductionGuidesGrant as Grant } from '@factuez/contracts/production-guides';
import { productionGuidesBytesHash as hash } from '@factuez/sunat-core/dist/production-guides';
export type ProductionGuidesAction='OAUTH_GRE'|'SUBMIT_GRE'|'QUERY_TICKET';
export interface ProductionGuidesHttp {request(input:{url:string;method:'GET'|'POST';headers:Record<string,string>;body?:Buffer}):Promise<{status:number;body:Buffer}>}
export interface ProductionGuidesGreCredentials {withGre<T>(grant:Grant,work:(gre:{clientId:string;clientSecret:string},sol:{username:string;password:string})=>Promise<T>):Promise<T>}
export interface ProductionGuidesTransport {
 readonly source:'SUNAT_OFFICIAL'|'LOCAL_SYNTHETIC';
 submit(grant:Grant,input:{fileName:string;xmlSha256:string;zipSha256:string;zip:Buffer}):Promise<{ticket:string}>;
 ticket(grant:Grant,ticket:string):Promise<{state:'PENDING'|'CDR'|'FAILED_NO_CDR';cdrZip?:Buffer}>;
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
/** No redirects, bounded response/time, verified TLS. Test transport is pinned to loopback. */
export class ProductionGuidesHttps implements ProductionGuidesHttp {
 constructor(private readonly synthetic?:{origin:string;ca:ConnectionOptions['ca']}){
  if(synthetic){const u=new URL(synthetic.origin);if(u.protocol!=='https:'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!synthetic.ca||u.pathname!=='/'||u.username||u.password||u.search||u.hash)throw Error('GRE_SYNTHETIC_ORIGIN_INVALID');}
 }
 async request(i:{url:string;method:'GET'|'POST';headers:Record<string,string>;body?:Buffer}){
  const u=new URL(i.url), allowed=this.synthetic?u.origin===new URL(this.synthetic.origin).origin:u.protocol==='https:'&&u.port===''&&['api-seguridad.sunat.gob.pe','api-cpe.sunat.gob.pe'].includes(u.hostname);
  if(!allowed||u.username||u.password||u.hash||u.protocol!=='https:'||(i.body?.length??0)>8*1024*1024)throw Error('GRE_HTTP_TARGET_DENIED');
  return new Promise<{status:number;body:Buffer}>((resolve,reject)=>{
   let done=false;const fail=()=>{if(!done){done=true;reject(Error('GRE_HTTP_FAILED'));}};
   const req=request(u,{method:i.method,headers:i.headers,rejectUnauthorized:true,minVersion:'TLSv1.2',ca:this.synthetic?.ca},res=>{
    let size=0;const chunks:Buffer[]=[];res.on('data',(b:Buffer)=>{size+=b.length;if(size>6*1024*1024){req.destroy();fail();}else chunks.push(b);});
    res.on('error',fail);res.on('aborted',fail);res.on('end',()=>{clearTimeout(timer);if(!done){done=true;resolve({status:res.statusCode??0,body:Buffer.concat(chunks)});}});
   });const timer=setTimeout(()=>{req.destroy();fail();},15000);req.on('error',()=>{clearTimeout(timer);fail();});req.end(i.body);
  });
 }
}
export type ProductionGuidesTransportOptions={http:ProductionGuidesHttp;credentials:ProductionGuidesGreCredentials;
 authorize:(action:ProductionGuidesAction,grant:Grant)=>Promise<void>;now?:()=>number;syntheticOrigin?:string};
/** Scoped bounded memory token cache. No serialization, diagnostic output or retry of a POST. */
export class ProductionGuidesRest implements ProductionGuidesTransport {
 readonly source:'SUNAT_OFFICIAL'|'LOCAL_SYNTHETIC';
 #tokens=new Map<string,{token:string;expires:number}>();
 #options:ProductionGuidesTransportOptions;
 constructor(options:ProductionGuidesTransportOptions){
  if(options.syntheticOrigin){const u=new URL(options.syntheticOrigin);if(u.protocol!=='https:'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw Error('GRE_SYNTHETIC_ORIGIN_INVALID');}
  this.#options=options;this.source=options.syntheticOrigin?'LOCAL_SYNTHETIC':'SUNAT_OFFICIAL';
 }
 toJSON(){return {service:'ProductionGuidesRest',source:this.source,contents:'PRIVATE'};}
 [inspect.custom](){return this.toJSON();}
 clear(){this.#tokens.clear();}
 private url(path:string,oauth=false){return (this.#options.syntheticOrigin??(oauth?'https://api-seguridad.sunat.gob.pe':'https://api-cpe.sunat.gob.pe'))+path;}
 private async token(g:Grant){
  const o=this.#options;await o.authorize('OAUTH_GRE',g);
  return o.credentials.withGre(g,async(gre,sol)=>{
   if(!/^[A-Za-z0-9-]{1,100}$/.test(gre.clientId)||!gre.clientSecret||gre.clientSecret.length>8192||!sol.username.startsWith(g.issuerRuc)||!sol.password)throw Error('GRE_CREDENTIALS_INVALID');
   const key=hash(`${g.issuerRuc}:${g.credentialRevision}:${gre.clientId}`),now=o.now?.()??Date.now();
   const cached=this.#tokens.get(key);if(cached&&cached.expires>now)return cached.token;this.#tokens.delete(key);
   const form=new URLSearchParams({grant_type:'password',scope:'https://api-cpe.sunat.gob.pe',client_id:gre.clientId,client_secret:gre.clientSecret,username:sol.username,password:sol.password});
   const body=Buffer.from(form.toString());let res:{status:number;body:Buffer};
   try{res=await o.http.request({url:this.url(`/v1/clientessol/${gre.clientId}/oauth2/token/`,true),method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body});}finally{body.fill(0);}
   let v:any;try{if(res.status!==200||res.body.length>32768)throw Error();v=JSON.parse(res.body.toString('utf8'));}catch{throw Error('GRE_OAUTH_FAILED');}finally{res.body.fill(0);}
   if(v.token_type?.toLowerCase()!=='bearer'||typeof v.access_token!=='string'||!/^[A-Za-z0-9_.~+\/-]{1,16384}={0,2}$/.test(v.access_token)||!Number.isFinite(v.expires_in)||v.expires_in<=30)throw Error('GRE_OAUTH_RESPONSE_INVALID');
   if(this.#tokens.size>=32)this.#tokens.delete(this.#tokens.keys().next().value!);
   this.#tokens.set(key,{token:v.access_token,expires:now+(Math.min(v.expires_in,3600)-30)*1000});return v.access_token as string;
  });
 }
 async submit(g:Grant,i:{fileName:string;xmlSha256:string;zipSha256:string;zip:Buffer}){
  if(!new RegExp(`^${g.issuerRuc}-(09-T|31-V)[A-Z0-9]{3}-[1-9][0-9]{0,7}\\.zip$`).test(i.fileName)||hash(i.zip)!==i.zipSha256||!/^[a-f0-9]{64}$/.test(i.xmlSha256))throw Error('GRE_SUBMISSION_INVALID');
  const token=await this.token(g);await this.#options.authorize('SUBMIT_GRE',g);
  const res=await this.#options.http.request({url:this.url('/v1/contribuyente/gem/comprobantes/'+i.fileName.slice(0,-4)),method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json'},body:Buffer.from(JSON.stringify({archivo:{nomArchivo:i.fileName,arcGreZip:i.zip.toString('base64'),hashZip:i.zipSha256}}))});
  let v:any;try{if(res.status!==200)throw Error();v=JSON.parse(res.body.toString('utf8'));if(!UUID.test(v.numTicket))throw Error();}catch{throw Error('GRE_POST_UNKNOWN');}
  return {ticket:v.numTicket as string};
 }
 async ticket(g:Grant,ticket:string){
  if(!UUID.test(ticket))throw Error('GRE_TICKET_INVALID');const token=await this.token(g);await this.#options.authorize('QUERY_TICKET',g);
  const res=await this.#options.http.request({url:this.url('/v1/contribuyente/gem/comprobantes/envios/'+ticket),method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
  let v:any;try{if(res.status!==200)throw Error();v=JSON.parse(res.body.toString('utf8'));}catch{throw Error('GRE_TICKET_FAILED');}
  if(v.codRespuesta==='98')return {state:'PENDING' as const};
  if(v.codRespuesta==='99'&&v.indCdrGenerado==='0')return {state:'FAILED_NO_CDR' as const};
  if(!['0','99'].includes(v.codRespuesta)||v.indCdrGenerado!=='1'||typeof v.arcCdr!=='string'||v.arcCdr.length>5592408||v.arcCdr.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(v.arcCdr))throw Error('GRE_TICKET_RESPONSE_INVALID');
  const cdrZip=Buffer.from(v.arcCdr,'base64');if(cdrZip.toString('base64')!==v.arcCdr)throw Error('GRE_TICKET_RESPONSE_INVALID');return {state:'CDR' as const,cdrZip};
 }
}
