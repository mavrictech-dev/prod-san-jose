import {HttpException,ServiceUnavailableException,ForbiddenException} from '@nestjs/common';
import {request} from 'node:https';
import {checkServerIdentity,type TLSSocket} from 'node:tls';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {loadNativeGreConfig,type NativeGreHostConfig} from './native-gre-host';
import {grants,hash,type ProductionActor} from './b2b-production-contract';
type Role='identity'|'billing'|'fiscal';
export const nativeB2bScopes=['production:documents:read','production:masters:read','production:documents:issue:01','production:documents:issue:03','production:notes:issue:07','production:notes:issue:08','production:guides:issue:09','production:guides:issue:31'] as const;
export type NativeB2bTls={ca:Buffer;cert:Buffer;key:Buffer};
export type NativeB2bPeer={origin:string;serverFingerprint:string};
const unavailable=()=>new ServiceUnavailableException({code:'NATIVE_B2B_UNAVAILABLE',message:'No se pudo verificar la aplicación en el servicio propietario. Reintente conservando la clave de operación.'});
export function nativeB2bConfig(){
 if(process.env.NATIVE_B2B_ENABLED!=='true')throw new ServiceUnavailableException({code:'NATIVE_B2B_DISABLED',message:'La API B2B nativa no está habilitada en este servidor.'});
 const c=loadNativeGreConfig();if(!c?.b2b?.peers?.length||c.b2b.peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw unavailable();return c;
}
export function nativeB2bPrivatePeer(req:{socket:TLSSocket},role?:Role){
 const c=nativeB2bConfig(),s=req.socket,fp=s?.encrypted&&s.authorized?s.getPeerCertificate().fingerprint256?.replaceAll(':','').toLowerCase():undefined;
 if(!fp||!c.b2b!.peers.includes(fp)||role&&c.b2b![role]?.serverFingerprint!==fp)throw new ForbiddenException({code:'PRIVATE_PEER_REQUIRED',message:'Esta operación sólo admite el canal interno autenticado del servicio.'});return c;
}
/** Fixed owner RPCs, bounded JSON and independently pinned server certificates. */
export class NativeB2bRpc {
 constructor(private readonly peers:Partial<Record<Role,NativeB2bPeer>>,private readonly tls:NativeB2bTls){}
 static configured(){const c=nativeB2bConfig();return new NativeB2bRpc(c.b2b!,{ca:readFileSync(c.listener.caFile),cert:readFileSync(c.listener.certFile),key:readFileSync(c.listener.keyFile)});}
 async post<T=any>(role:Role,path:string,body:unknown,authorization=''):Promise<T>{
  const peer=this.peers[role];if(!peer||!/^[a-f0-9]{64}$/.test(peer.serverFingerprint)||!/^\/internal\/native-b2b\/[a-z0-9/_-]+$/.test(path))throw unavailable();
  const origin=new URL(peer.origin);if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw unavailable();
  const bytes=Buffer.from(JSON.stringify(body));if(bytes.length>768*1024)throw new HttpException({code:'BODY_TOO_LARGE',message:'La solicitud excede el tamaño admitido por la API.'},413);
  const maximum=path==='/internal/native-b2b/fiscal/artifact'?64*1024*1024:2*1024*1024;
  return new Promise<T>((resolve,reject)=>{
   const req=request(new URL(path,origin),{...this.tls,method:'POST',agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2',maxHeaderSize:8192,
    checkServerIdentity:(hostname,cert)=>checkServerIdentity(hostname,cert)??(createHash('sha256').update(cert.raw).digest('hex')===peer.serverFingerprint?undefined:new Error('PIN_MISMATCH')),
    headers:{'content-type':'application/json','content-length':bytes.length,...(authorization?{authorization}:{})}},res=>{
    let size=0;const chunks:Buffer[]=[];
    res.on('data',(part:Buffer)=>{size+=part.length;if(size>maximum)req.destroy();else chunks.push(part);});
    res.on('error',()=>reject(unavailable()));res.on('aborted',()=>reject(unavailable()));
    res.on('end',()=>{try{
     if(!/^application\/json(?:;|$)/i.test(String(res.headers['content-type']??''))||size>maximum)throw Error();
     const value=JSON.parse(Buffer.concat(chunks).toString('utf8')),status=res.statusCode??503;
     if(status<200||status>=300){reject(new HttpException(value&&typeof value==='object'?value:{message:'El servicio propietario rechazó la solicitud.'},status));return;}
     resolve(value as T);
    }catch{reject(unavailable());}});
   });
   const timeout=setTimeout(()=>req.destroy(),15000);req.once('close',()=>clearTimeout(timeout));req.once('error',()=>reject(unavailable()));req.end(bytes);
  });
 }
 async introspect(token:string):Promise<ProductionActor>{
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new HttpException({code:'INVALID_TOKEN',message:'El token de aplicación no es válido.'},401);
  const value=await this.post<ProductionActor>('identity','/internal/native-b2b/identity/introspect',{},'Bearer '+token);
  if(value?.kind!=='SERVICE'||value.environment!=='PRODUCTION'||!Number.isSafeInteger(value.revision)||value.revision<1||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=Date.now()||value.expiresAt>Date.now()+305000||value.tokenHash!==hash(token)||!/^[a-f0-9-]{36}$/.test(value.clientId))throw unavailable();
  try{return {...value,grants:grants(value.grants)};}catch{throw unavailable();}
 }
 close(){this.tls.key.fill(0);}
}
export function nativeServicePrincipalId(clientId:string){const b=createHash('sha256').update('factuez:native-b2b:service:'+clientId).digest().subarray(0,16);b[6]=(b[6]&15)|80;b[8]=(b[8]&63)|128;const h=b.toString('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
export function nativeServiceBearer(authorization:unknown){if(typeof authorization!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/i.test(authorization))throw new HttpException({code:'INVALID_TOKEN',message:'Envíe un token de aplicación vigente en Authorization: Bearer.'},401);return authorization.slice(7);}

/** Native SERVICE reads stay on pinned mTLS. Human JWT requests retain the existing native route. */
export async function nativeBillingFetch(path:string,authorization:string,fallback:()=>Promise<Response>):Promise<Response>{
 if(process.env.NATIVE_B2B_ENABLED!=='true'||!/^Bearer [A-Za-z0-9_-]{43}$/i.test(authorization))return fallback();
 let rpc:NativeB2bRpc|undefined;
 try{
  const url=new URL(path,'http://billing.internal'),document=/^\/api\/v1\/documents\/([a-f0-9-]{36})$/.exec(url.pathname),print=/^\/api\/v1\/stations\/print-settings\/([1-9]\d*)\/snapshot$/.exec(url.pathname);
  let route:string,body:unknown;
  if(path==='/api/v1/documents/catalog/issuance'){route='catalogue';body={};}
  else if(document&&!url.search){route='document';body={documentId:document[1]};}
  else if(print&&[...url.searchParams.keys()].every(k=>k==='branchId')&&url.searchParams.getAll('branchId').length<=1){route='print-snapshot';body={companyId:print[1],...(url.searchParams.has('branchId')?{branchId:url.searchParams.get('branchId')}:{})};}
  else throw new ForbiddenException({code:'MACHINE_ROUTE_NOT_ALLOWED',message:'Esta lectura no admite credenciales de aplicación.'});
  rpc=NativeB2bRpc.configured();const data=await rpc.post('billing','/internal/native-b2b/billing/'+route,body,authorization);
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json','cache-control':'private, no-store'}});
 }catch(e){const status=e instanceof HttpException?e.getStatus():503,body=e instanceof HttpException?e.getResponse():{message:'No se pudo verificar la lectura en Billing.'};return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'private, no-store'}});}
 finally{rpc?.close();}
}
