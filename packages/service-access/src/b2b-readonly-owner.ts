import {X509Certificate} from 'node:crypto';
import {createSecureContext} from 'node:tls';
import {b2bPrivatePeer} from './b2b';
import {B2bOwnerDrain} from './b2b-owner-drain';
import type {NestInterceptor} from '@nestjs/common';
export type ReadonlyTls={ca:Buffer;cert:Buffer;key:Buffer};
export const b2bReadonlyScopes=['b2b:context:read','b2b:catalog:read','b2b:documents:read','b2b:artifacts:read','b2b:webhooks:read','b2b:webhooks:manage'] as const;
export interface ReadonlyOwnerOptions {
 enabled?:boolean;B2B_PRIVATE_ACCESS?:boolean;environment:'BETA';deploymentId:string;
 listen:{host:'127.0.0.1'|'0.0.0.0';port:number};tls:ReadonlyTls;callers:string[];
}
export function readonlyOwnerOptions(v:ReadonlyOwnerOptions){
 if(v.enabled!==true||v.B2B_PRIVATE_ACCESS!==true||v.environment!=='BETA'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.deploymentId)||
  !v.listen||!['127.0.0.1','0.0.0.0'].includes(v.listen.host)||!Number.isInteger(v.listen.port)||v.listen.port<9000||v.listen.port>9099)throw Error('B2B_PRIVATE_ACCESS_READONLY_OWNER_REQUIRED');
 readonlyPeers(v.callers);readonlyTls(v.tls);
 return structuredClone(v);
}
export function readonlyPeers(peers:readonly string[]){
 if(!Array.isArray(peers)||!peers.length||peers.length>32||new Set(peers).size!==peers.length||peers.some(p=>typeof p!=='string'||!/^[a-f0-9]{64}$/.test(p)))throw Error('B2B_READONLY_OWNER_PEERS_REQUIRED');
 return [...peers];
}
export function readonlyTls(tls:ReadonlyTls){
 if(!tls||![tls.ca,tls.cert,tls.key].every(b=>Buffer.isBuffer(b)&&b.length))throw Error('B2B_READONLY_OWNER_MTLS_REQUIRED');
 createSecureContext({...tls,minVersion:'TLSv1.2'});
 const ca=new X509Certificate(tls.ca),leaf=new X509Certificate(tls.cert);
 if(!ca.ca||leaf.ca||Date.parse(leaf.validFrom)>Date.now()||Date.parse(leaf.validTo)<=Date.now())throw Error('B2B_READONLY_OWNER_MTLS_REQUIRED');
 return {ca:Buffer.from(tls.ca),cert:Buffer.from(tls.cert),key:Buffer.from(tls.key)};
}
/** Installed before parsers/listening: fixed private RPC surface, mTLS, bounded
 * requests. Existing controllers still authenticate current Identity/grants. */
export function installReadonlyOwnerBoundary(app:{use(fn:any):any;useGlobalInterceptors(...interceptors:NestInterceptor[]):unknown},peers:readonly string[],paths:readonly string[]){
 const fixed=new Set([...paths,'/internal/b2b/runtime-status']);
 const drain=new B2bOwnerDrain({enabled:true,maxConcurrent:16});
 app.use((req:any,res:any,next:()=>void)=>{
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try{b2bPrivatePeer(req,peers);}catch{return res.status(403).json({code:'PRIVATE_PEER_REQUIRED'});}
  if(req.method!=='POST'||!fixed.has(req.url)||req.headers['transfer-encoding'])return res.status(404).json({code:'PRIVATE_OPERATION_NOT_PUBLISHED'});
  const oauth=req.url==='/b2b/oauth/token',max=oauth?8192:262144,type=String(req.headers['content-type']??'');
  if(!/^[1-9][0-9]{0,5}$/.test(req.headers['content-length']??'')||Number(req.headers['content-length'])>max||
   !(oauth?/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i:/^application\/json(?:;|$)/).test(type))return res.status(413).json({code:'INVALID_BODY'});
  next();
 });
 drain.install(app);
 return {isOpen:()=>drain.snapshot().state==='OPEN',async closeAdmission(){
  drain.closeAdmission();while((await drain.drain('ALL',30000)).state!=='DRAINED'){/* Never force an unfinished owner transaction. */}
 }};
}
