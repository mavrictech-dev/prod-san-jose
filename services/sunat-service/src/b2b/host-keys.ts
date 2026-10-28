import {createHash,X509Certificate} from 'node:crypto';
import {inspect} from 'node:util';
import type {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import type {LocalGuideKeys} from '../application/guide-artifact-assembly';
import type {BatchLocalKeyProvider} from '../application/batch-local-artifacts';
import type {CertificateInspectionService} from '../infrastructure/crypto/certificate-inspection.service';
import {syntheticSunatHostRuc} from './host-synthetic-profile';
export type SunatHostKey={issuerRuc:string;purpose:'LOCAL_GUIDE_ARTIFACT'|'LOCAL_SYNTHETIC_BATCH';pkcs12File:string;passwordFile:string;certificateFile:string;pkcs12Sha256:string;certificateSha256:string};
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
/** Mounted SYNTHETIC custody only. Acquisitions are exclusive copies, bounded,
 * purpose-bound and erased on every release/failure. JS password strings and
 * cryptographic-library internals cannot be guaranteed erasable by this port. */
export class SunatHostKeys implements LocalGuideKeys,BatchLocalKeyProvider {
 #closed=false;#active=new Set<object>();#keys:SunatHostKey[];
 constructor(private readonly files:Pick<B2bRuntimeFiles,'privateBinary'|'secretBytes'|'publicPem'>,keys:SunatHostKey[],private readonly inspector:Pick<CertificateInspectionService,'inspect'>){
  if(!Array.isArray(keys)||!keys.length||keys.length>100||keys.some(k=>!syntheticSunatHostRuc(k.issuerRuc)||!['LOCAL_GUIDE_ARTIFACT','LOCAL_SYNTHETIC_BATCH'].includes(k.purpose)||
   !/^[a-f0-9]{64}$/.test(k.pkcs12Sha256)||!/^[a-f0-9]{64}$/.test(k.certificateSha256)||![k.pkcs12File,k.passwordFile,k.certificateFile].every(n=>/^[a-z][a-z0-9-]{0,63}\.(bin|pem|crt)$/.test(n)))||new Set(keys.map(k=>k.issuerRuc+':'+k.purpose)).size!==keys.length)throw Error('SUNAT_SYNTHETIC_CUSTODY_REQUIRED');
  this.#keys=structuredClone(keys);
 }
 private async lease(ruc:string,purpose:SunatHostKey['purpose']){
  const pin=this.#keys.find(k=>k.issuerRuc===ruc&&k.purpose===purpose);
  if(this.#closed||this.#active.size>=2||!syntheticSunatHostRuc(ruc)||!pin)throw Error('SUNAT_SYNTHETIC_KEY_UNAVAILABLE');
  const ticket={};this.#active.add(ticket);let p12:Buffer|undefined,passwordBytes:Buffer|undefined;
  const dispose=async()=>{p12?.fill(0);passwordBytes?.fill(0);this.#active.delete(ticket);};
  try{
   p12=this.files.privateBinary(pin.pkcs12File);passwordBytes=this.files.secretBytes(pin.passwordFile);
   if(!p12.length||p12.length>512*1024||!passwordBytes.length||passwordBytes.length>4096||sha(p12)!==pin.pkcs12Sha256)throw Error();
   const password=passwordBytes.toString('utf8');if(!Buffer.from(password).equals(passwordBytes)||/[\x00-\x1f\x7f]/.test(password))throw Error();
   const certificate=this.files.publicPem(pin.certificateFile);if(sha(certificate)!==pin.certificateSha256||certificate.includes('PRIVATE KEY'))throw Error();
   const metadata=await this.inspector.inspect(p12,password),x509=new X509Certificate(certificate);
   if(this.#closed||!/(?:^|\n)CN=[^\n]*\bSYNTHETIC\b/.test(x509.subject)||metadata.subjectRucCandidates.length!==1||metadata.subjectRucCandidates[0]!==ruc||!metadata.digitalSignature||
    metadata.fingerprint!==x509.fingerprint256.replace(/:/g,'').toLowerCase()||metadata.expiresAt<=new Date())throw Error();
   return {ruc,purpose,p12,password,certificatePem:certificate.toString('utf8'),dispose};
  }catch{await dispose();throw Error('SUNAT_SYNTHETIC_KEY_UNAVAILABLE');}
 }
 async withKey<T>(ruc:string,purpose:'LOCAL_GUIDE_ARTIFACT',work:(p12:Buffer,password:string)=>Promise<T>):Promise<T>{
  if(purpose!=='LOCAL_GUIDE_ARTIFACT'||typeof work!=='function')throw Error('SUNAT_SYNTHETIC_KEY_UNAVAILABLE');
  const material=await this.lease(ruc,purpose);try{return await work(material.p12,material.password);}finally{await material.dispose();}
 }
 async acquire(ruc:string,purpose:'LOCAL_SYNTHETIC_BATCH'){
  if(purpose!=='LOCAL_SYNTHETIC_BATCH')throw Error('SUNAT_SYNTHETIC_KEY_UNAVAILABLE');
  const material=await this.lease(ruc,purpose);return {...material,purpose:'LOCAL_SYNTHETIC_BATCH' as const};
 }
 async close(){this.#closed=true;if(this.#active.size)throw Error('SUNAT_SYNTHETIC_KEYS_STILL_ACTIVE');}
 toJSON(){return {service:'SunatHostKeys',profile:'SYNTHETIC_ONLY',closed:this.#closed,active:this.#active.size};}[inspect.custom](){return this.toJSON();}
}
