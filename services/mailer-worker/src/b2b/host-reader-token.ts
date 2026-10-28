import {request} from 'node:https';
import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {checkServerIdentity} from 'node:tls';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import type {MailerRuntimeTls} from './runtime-config';
export const MAILER_READER_SCOPES=['b2b:documents:read','b2b:artifacts:read'] as const;
export interface MailerReaderTokens {token():Promise<string>;close():void}
/** Dedicated least-privilege SERVICE credential. This endpoint belongs to our
 * private Identity service, never to SUNAT. No USER bearer is saved in a job. */
export class MailerReaderToken implements MailerReaderTokens {
 #origin:URL;#tls:MailerRuntimeTls;#secret:Buffer;#closed=false;#active=0;
 constructor(origin:string,tls:MailerRuntimeTls,private readonly serverSha256:string,private readonly clientId:string,secret:Buffer){
  this.#origin=new URL(origin);
  if(this.#origin.protocol!=='https:'||this.#origin.pathname!=='/'||this.#origin.search||this.#origin.hash||this.#origin.username||this.#origin.password||
   !/^[a-f0-9]{64}$/.test(serverSha256)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(clientId)||
   !Buffer.isBuffer(secret)||secret.length!==43||!/^[A-Za-z0-9_-]{43}$/.test(secret.toString('ascii')))throw Error('MAILER_READER_CONFIGURATION_INVALID');
  this.#tls={ca:Buffer.from(tls.ca),cert:Buffer.from(tls.cert),key:Buffer.from(tls.key)};this.#secret=Buffer.from(secret);
 }
 async token():Promise<string>{
  if(this.#closed||this.#active>=4)throw new B2bSecurityError(503,'EMAIL_READER_UNAVAILABLE');
  this.#active++;
  const basic=Buffer.concat([Buffer.from(this.clientId+':'),this.#secret]);
  try{return await new Promise<string>((resolve,reject)=>{
   const body=Buffer.from(new URLSearchParams({grant_type:'client_credentials',scope:MAILER_READER_SCOPES.join(' ')}).toString());
   const fail=()=>new B2bSecurityError(503,'EMAIL_READER_UNAVAILABLE');
   const req=request(new URL('/b2b/oauth/token',this.#origin),{...this.#tls,agent:false,method:'POST',rejectUnauthorized:true,minVersion:'TLSv1.2',maxHeaderSize:8192,
    checkServerIdentity:(host,cert)=>checkServerIdentity(host,cert)??(cert.raw&&createHash('sha256').update(cert.raw).digest('hex')===this.serverSha256?undefined:fail()),
    headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded','Content-Length':body.length,Authorization:'Basic '+basic.toString('base64')}},res=>{
    let count=0;const chunks:Buffer[]=[];
    res.on('data',(b:Buffer)=>{count+=b.length;if(count>16384)req.destroy(fail());else chunks.push(b);});
    res.on('aborted',()=>reject(fail()));res.on('error',()=>reject(fail()));
    res.on('end',()=>{try{
     if(res.statusCode!==200||!/^application\/json(?:;|$)/i.test(String(res.headers['content-type']??'')))throw fail();
     const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));
     if(!r||Object.keys(r).sort().join(',')!=='access_token,expires_in,scope,token_type'||r.token_type!=='Bearer'||r.expires_in!==300||
      typeof r.access_token!=='string'||!/^[A-Za-z0-9._~-]{1,8192}$/.test(r.access_token)||typeof r.scope!=='string'||
      JSON.stringify(r.scope.split(' ').sort())!==JSON.stringify([...MAILER_READER_SCOPES].sort()))throw fail();
     resolve(r.access_token);
    }catch{reject(fail());}});
   });
   const deadline=setTimeout(()=>req.destroy(fail()),10000);deadline.unref();
   req.once('close',()=>clearTimeout(deadline));req.on('error',()=>reject(fail()));req.end(body);
  });}finally{basic.fill(0);this.#active--;}
 }
 close(){if(this.#active)throw Error('MAILER_READER_BUSY');this.#closed=true;this.#secret.fill(0);this.#tls.key.fill(0);}
 toJSON(){return {service:'MailerReaderToken',credentials:'PRIVATE',environment:'BETA'};}[inspect.custom](){return this.toJSON();}
}
