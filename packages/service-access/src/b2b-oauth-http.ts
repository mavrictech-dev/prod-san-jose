import {request} from 'node:https';
import {inspect} from 'node:util';
import {b2bReadonlyScopes} from './b2b-readonly-owner';

export type B2bOAuthReply={status:number;body:Record<string,string|number>};
type Tls={ca:Buffer;cert:Buffer;key:Buffer};
const unavailable=():B2bOAuthReply=>({status:503,body:{error:'temporarily_unavailable'}});
/** Fixed Identity token endpoint only. No token minting, credential cache,
 * redirects, discovery, audience conversion or administrative RPC forwarding. */
export class B2bOAuthHttp {
 #origin:URL;#tls:Tls;
 constructor(origin:string,tls:Tls){
  this.#origin=new URL(origin);
  if(this.#origin.protocol!=='https:'||this.#origin.pathname!=='/'||this.#origin.username||this.#origin.password||this.#origin.search||this.#origin.hash||
   !tls||![tls.ca,tls.cert,tls.key].every(b=>Buffer.isBuffer(b)&&b.length))throw Error('B2B_OAUTH_FIXED_MTLS_IDENTITY_REQUIRED');
  this.#tls={ca:Buffer.from(tls.ca),cert:Buffer.from(tls.cert),key:Buffer.from(tls.key)};
 }
 async token(authorization:unknown,body:unknown):Promise<B2bOAuthReply>{
  const b=body as Record<string,unknown>;
  if(!b||Object.getPrototypeOf(b)!==Object.prototype||Object.keys(b).sort().join(',')!=='grant_type,scope'||
   typeof b.scope!=='string'||b.scope.length<1||b.scope.length>4096||!/^[a-z0-9: -]+$/.test(b.scope))return {status:400,body:{error:'invalid_request'}};
  if(b.grant_type!=='client_credentials')return {status:400,body:{error:'unsupported_grant_type'}};
  if(b.scope.split(' ').some(scope=>!(b2bReadonlyScopes as readonly string[]).includes(scope)))return {status:403,body:{error:'invalid_scope'}};
  if(typeof authorization!=='string'||authorization.length>512||!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(authorization))return {status:401,body:{error:'invalid_client'}};
  const bytes=Buffer.from(new URLSearchParams({grant_type:'client_credentials',scope:b.scope}).toString());
  return new Promise(resolve=>{
   const req=request(new URL('/b2b/oauth/token',this.#origin),{...this.#tls,method:'POST',rejectUnauthorized:true,minVersion:'TLSv1.2',
    timeout:5000,maxHeaderSize:8192,headers:{Authorization:authorization,Accept:'application/json',
     'Content-Type':'application/x-www-form-urlencoded','Content-Length':bytes.length}},res=>{
    let size=0;const chunks:Buffer[]=[];
    res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>32768)req.destroy();else chunks.push(chunk);});
    res.on('aborted',()=>finish(unavailable()));res.on('error',()=>finish(unavailable()));
    res.on('end',()=>{
     if(!/^application\/json(?:;|$)/.test(String(res.headers['content-type']??'')))return finish(unavailable());
     try{
      const v=JSON.parse(Buffer.concat(chunks).toString('utf8')),status=res.statusCode;
      if(status===200&&v&&Object.keys(v).sort().join(',')==='access_token,expires_in,scope,token_type'&&
       typeof v.access_token==='string'&&/^[A-Za-z0-9._~-]{1,8192}$/.test(v.access_token)&&v.token_type==='Bearer'&&
       Number.isInteger(v.expires_in)&&v.expires_in>0&&v.expires_in<=300&&typeof v.scope==='string'&&v.scope.length<=4096&&
       v.scope.split(' ').every((s:string)=>s&&String(b.scope).split(' ').includes(s))){
       return finish({status:200,body:{access_token:v.access_token,token_type:'Bearer',expires_in:v.expires_in,scope:v.scope}});
      }
      if([400,401,403,429,503].includes(status??0)&&v&&Object.keys(v).join(',')==='error'&&
       ['invalid_client','invalid_request','invalid_scope','unsupported_grant_type','temporarily_unavailable'].includes(v.error))
       return finish({status:status!,body:{error:v.error}});
     }catch{/* Closed OAuth failure; never return upstream bodies or credentials. */}
     finish(unavailable());
    });
   });
   let settled=false;
   const timer=setTimeout(()=>req.destroy(),10000);
   function finish(reply:B2bOAuthReply){if(!settled){settled=true;clearTimeout(timer);resolve(reply);}}
   req.on('timeout',()=>req.destroy());req.on('error',()=>finish(unavailable()));req.on('close',()=>finish(unavailable()));req.end(bytes);
  });
 }
 toJSON(){return {service:'B2bOAuthHttp',credentials:'PRIVATE'};}
 [inspect.custom](){return this.toJSON();}
}
