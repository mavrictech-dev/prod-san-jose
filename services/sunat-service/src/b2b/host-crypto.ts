import {Worker} from 'node:worker_threads';
import {join,isAbsolute} from 'node:path';
import {inspect} from 'node:util';
import {CertificateTrustService,type InspectedSigningCertificate,type CertificateTrustResult} from '../infrastructure/crypto/certificate-trust.service';
import {CdrSignatureTrustService} from '../infrastructure/crypto/cdr-signature-trust.service';
import {CertificateInspectionService} from '../infrastructure/crypto/certificate-inspection.service';
import type {inspectCertificate} from '../infrastructure/crypto/certificate-inspector';
export type SunatHostPki={roots:{path:string;sha256:string};crl:{path:string;sha256:string};cdrSigner:{path:string;sha256:string};opensslPath:string};
export interface SunatHostCryptoModules {trust:string;cdr:string;inspector:string}
// Only application-owned absolute module paths, never mounted metadata or request code.
const program=`
const {parentPort,workerData}=require('node:worker_threads');
(async()=>{let bytes;
 try{
  const {CertificateTrustService,loadPinnedPublicFile,verifyWithOpenSsl}=require(workerData.modules.trust);
  const trust=new CertificateTrustService();let result;
  if(workerData.action==='TRUST')result=await trust.evaluate(workerData.value.metadata,workerData.value.ruc,new Date(workerData.value.now));
  else if(workerData.action==='CDR'){bytes=Buffer.from(workerData.value);const {CdrSignatureTrustService}=require(workerData.modules.cdr);result=await new CdrSignatureTrustService(trust).verify(bytes);}
  else if(workerData.action==='INSPECT'){bytes=Buffer.from(workerData.value.bytes);result=require(workerData.modules.inspector).inspectCertificate(bytes,workerData.value.password);}
  else if(workerData.action==='READINESS'){
   for(const pair of [[process.env.SUNAT_TRUST_STORE_FILE,process.env.SUNAT_TRUST_STORE_SHA256],[process.env.SUNAT_CRL_BUNDLE_FILE,process.env.SUNAT_CRL_BUNDLE_SHA256],[process.env.SUNAT_CDR_SIGNER_CERT_FILE,process.env.SUNAT_CDR_SIGNER_CERT_SHA256]])await loadPinnedPublicFile(...pair);
   await verifyWithOpenSsl(['version']);result={state:'AVAILABLE'};
  }else throw Error();
  parentPort.postMessage({result});
 }catch{parentPort.postMessage({error:'SUNAT_HOST_CRYPTO_UNAVAILABLE'});}
 finally{bytes?.fill(0);if(workerData.value?.bytes)workerData.value.bytes.fill(0);}
})();`;
/** Worker-local environment runs the EXISTING crypto classes, without changing
 * process.env in the owner or inheriting DB/vault/customer configuration. No shell,
 * source text, module path or trust decision comes from a request/mounted JSON. */
export class SunatHostCrypto {
 #closed=false;#jobs=new Set<Worker>();#modules:SunatHostCryptoModules;#env:Record<string,string>;
 readonly trust:CertificateTrustService;readonly cdr:CdrSignatureTrustService;readonly inspector:CertificateInspectionService;
 constructor(pki:SunatHostPki,modules:SunatHostCryptoModules={trust:join(__dirname,'../infrastructure/crypto/certificate-trust.service.js'),cdr:join(__dirname,'../infrastructure/crypto/cdr-signature-trust.service.js'),inspector:join(__dirname,'../infrastructure/crypto/certificate-inspector.js')}){
  if(Object.values(modules).some(p=>!isAbsolute(p))||!isAbsolute(pki.opensslPath))throw Error('SUNAT_HOST_CRYPTO_MODULES_REQUIRED');
  this.#modules={...modules};this.#env={SUNAT_OPENSSL_PATH:pki.opensslPath,SUNAT_TRUST_STORE_FILE:pki.roots.path,SUNAT_TRUST_STORE_SHA256:pki.roots.sha256,
   SUNAT_CRL_BUNDLE_FILE:pki.crl.path,SUNAT_CRL_BUNDLE_SHA256:pki.crl.sha256,SUNAT_CDR_SIGNER_CERT_FILE:pki.cdrSigner.path,SUNAT_CDR_SIGNER_CERT_SHA256:pki.cdrSigner.sha256,
   ...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot??''}:{})};
  const owner=this;
  this.trust=new class extends CertificateTrustService {override evaluate(metadata:InspectedSigningCertificate,ruc:string,now=new Date()){return owner.run<CertificateTrustResult>('TRUST',{metadata,ruc,now:now.toISOString()});}}();
  this.cdr=new class extends CdrSignatureTrustService {override verify(bytes:Buffer){if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>2*1024*1024)return Promise.resolve(false);return owner.run<boolean>('CDR',Buffer.from(bytes));}}(this.trust);
  this.inspector=new class extends CertificateInspectionService {override async inspect(bytes:Buffer,password:string){
   if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>512*1024||typeof password!=='string'||Buffer.byteLength(password)>4096)throw Error('SUNAT_HOST_KEY_INVALID');
   return owner.run<ReturnType<typeof inspectCertificate>>('INSPECT',{bytes,password});}}();
 }
 private async run<T>(action:string,value:unknown):Promise<T>{
  if(this.#closed||this.#jobs.size>=4)throw Error('SUNAT_HOST_CRYPTO_UNAVAILABLE');
  let worker:Worker;
  try{worker=new Worker(program,{eval:true,env:this.#env,workerData:{action,value,modules:this.#modules},execArgv:[],stdout:true,stderr:true,
   resourceLimits:{maxOldGenerationSizeMb:96,maxYoungGenerationSizeMb:16}});}catch{throw Error('SUNAT_HOST_CRYPTO_UNAVAILABLE');}
  this.#jobs.add(worker);
  try{return await new Promise<T>((accept,reject)=>{
   let settled=false;const finish=(error?:unknown,result?:T)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(Error('SUNAT_HOST_CRYPTO_UNAVAILABLE')):accept(result as T);};
   const timer=setTimeout(()=>finish(Error()),14000);let output=0;
   for(const stream of [worker.stdout,worker.stderr])stream?.on('data',(chunk:Buffer)=>{output+=chunk.length;if(output>65536)finish(Error());});
   worker.once('message',message=>message&&Object.keys(message).join(',')==='result'?finish(undefined,message.result):finish(Error()));
   worker.once('error',()=>finish(Error()));worker.once('exit',()=>finish(Error()));
  });}finally{await worker.terminate();this.#jobs.delete(worker);}
 }
 async assertInfrastructure(){const result=await this.run<{state:string}>('READINESS',null);if(result.state!=='AVAILABLE')throw Error('SUNAT_HOST_CRYPTO_UNAVAILABLE');}
 async close(){this.#closed=true;await Promise.all([...this.#jobs].map(w=>w.terminate()));}
 toJSON(){return {service:'SunatHostCrypto',profile:'EXPLICIT_OFFLINE_PINS',closed:this.#closed,active:this.#jobs.size,officialTrustGranted:false};}[inspect.custom](){return this.toJSON();}
}
