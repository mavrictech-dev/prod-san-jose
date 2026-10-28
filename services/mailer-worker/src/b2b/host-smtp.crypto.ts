import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {inspect} from 'node:util';
import {AccessError} from '@factuez/service-access';
import type {SmtpIssuer} from '../smtp-configuration.store';
const invalid=()=>new AccessError(503,'B2B_MAILER_SMTP_INTEGRITY');
/** Explicit mounted binary key copy. No environment, filesystem or legacy QA fallback. */
export class MailerHostSmtpVault {
 #key:Buffer; #version:number; #closed=false;
 constructor(key:Buffer,version:number){
  if(!Buffer.isBuffer(key)||key.length!==32||!Number.isInteger(version)||version<1||version>10000)throw invalid();
  this.#key=Buffer.from(key);this.#version=version;
 }
 #aad(issuer:SmtpIssuer){
  if(this.#closed||!Number.isInteger(issuer.companyId)||issuer.companyId<1||issuer.companyId>2147483647||!/^\d{11}$/.test(issuer.ruc))throw invalid();
  return Buffer.from(`factuez.b2b.host-smtp.v1|BETA|${this.#version}|${issuer.companyId}|${issuer.ruc}|configuration`);
 }
 seal(bytes:Buffer,issuer:SmtpIssuer){
  const aad=this.#aad(issuer);
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>4096)throw invalid();
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key,iv);cipher.setAAD(aad);
  const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
  return {keyVersion:this.#version,cipher:['v1',this.#version,iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.')};
 }
 open(envelope:string,keyVersion:number,issuer:SmtpIssuer):Buffer{
  let provisional:Buffer|undefined;
  try{
   const aad=this.#aad(issuer);
   if(keyVersion!==this.#version||typeof envelope!=='string'||envelope.length>5700)throw invalid();
   const parts=envelope.split('.');
   if(parts.length!==5||parts[0]!=='v1'||parts[1]!==String(this.#version)||parts.slice(2).some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))throw invalid();
   const [iv,tag,encrypted]=parts.slice(2).map(p=>Buffer.from(p,'base64url'));
   if(iv.length!==12||tag.length!==16||!encrypted.length||encrypted.length>4096||[iv,tag,encrypted].some((p,i)=>p.toString('base64url')!==parts[i+2]))throw invalid();
   const decipher=createDecipheriv('aes-256-gcm',this.#key,iv);decipher.setAAD(aad);decipher.setAuthTag(tag);
   provisional=decipher.update(encrypted);return Buffer.concat([provisional,decipher.final()]);
  }catch{throw invalid();}finally{provisional?.fill(0);}
 }
 readiness(){return this.#closed?'INVALID' as const:'READY' as const;}
 close(){this.#closed=true;this.#key.fill(0);}
 toJSON(){return {service:'MailerHostSmtpVault',contents:'PRIVATE',closed:this.#closed};}
 [inspect.custom](){return this.toJSON();}
}
