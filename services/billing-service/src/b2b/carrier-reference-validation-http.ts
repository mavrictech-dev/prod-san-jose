import {request} from 'node:https';
import {checkServerIdentity} from 'node:tls';
import {randomUUID,createHash} from 'node:crypto';
import {types} from 'node:util';
import {fiscalSnapshotSha256 as hash} from '@factuez/sunat-core/dist/fiscal-note';
import {validatePublicGuide09OwnerSnapshot,projectPublicGuide09OwnerSnapshot} from '@factuez/sunat-core/dist/public-guide-profile';
import type {CarrierReferenceSignatureCdrValidator,CarrierReferenceValidationInput} from './carrier-guide-reference';
import type {CarrierReference09Evidence} from '@factuez/sunat-core/dist/carrier-guide-profile';
const PATH='/internal/b2b/carrier-reference-validation',MAX_ARTIFACT=384*1024,MAX_REQUEST=2*1024*1024,MAX_RESPONSE=8192;
const REQUEST='factuez.b2b.carrier-reference-validation.request.v1',RESPONSE='factuez.b2b.carrier-reference-validation.response.v1';
const sha=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const fail=():never=>{throw new Error('CARRIER_REFERENCE_HTTP_VALIDATION_UNAVAILABLE');};
function exact(v:any,keys:string[]){if(!v||typeof v!=='object'||types.isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(v).length!==keys.length||
 keys.some(k=>!Object.hasOwn(v,k))||Object.values(Object.getOwnPropertyDescriptors(v)).some(d=>!d.enumerable||!('value'in d)))fail();}
function inputCopy(v:Readonly<CarrierReferenceValidationInput>):CarrierReferenceValidationInput{
 exact(v,['ownerSnapshot','ownerSnapshotSha256','projection','projectionSha256','signedXml','signedXmlSha256','cdrXml','cdrSha256']);
 for(const b of [v.signedXml,v.cdrXml])if(!(b instanceof Uint8Array)||types.isProxy(b)||!b.byteLength||b.byteLength>MAX_ARTIFACT)fail();
 const s=validatePublicGuide09OwnerSnapshot(v.ownerSnapshot),p=projectPublicGuide09OwnerSnapshot(s),xml=Buffer.from(v.signedXml),cdr=Buffer.from(v.cdrXml);
 if(Buffer.byteLength(JSON.stringify(s))>65536||!s.body.issueDate.endsWith('.000Z')||hash(s)!==v.ownerSnapshotSha256||hash(p)!==v.projectionSha256||hash(v.projection)!==hash(p)||sha(xml)!==v.signedXmlSha256||sha(cdr)!==v.cdrSha256)fail();
 return {ownerSnapshot:s,ownerSnapshotSha256:v.ownerSnapshotSha256,projection:p,projectionSha256:v.projectionSha256,signedXml:xml,signedXmlSha256:v.signedXmlSha256,cdrXml:cdr,cdrSha256:v.cdrSha256};
}
export interface CarrierReferenceValidationHttpOptions {
 enabled?:boolean;origin:string;sunatPeerSha256:string;tls:{ca:Buffer;cert:Buffer;key:Buffer};now?:()=>string;
}
/** Dedicated fixed private RPC: B2bPrivateHttp's shared allowlist is intentionally
 * unchanged. This object sends nothing until explicitly enabled and verify called.
 * It never accepts a request-selected URL/cert/policy or a public acceptance flag. */
export class HttpCarrierReferenceSignatureCdrValidator implements CarrierReferenceSignatureCdrValidator {
 #origin:URL;#tls:CarrierReferenceValidationHttpOptions['tls'];#peer:string;#enabled:boolean;#now:()=>string;
 constructor(options:CarrierReferenceValidationHttpOptions){
  try {const u=new URL(options.origin);
  if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!/^[a-f0-9]{64}$/.test(options.sunatPeerSha256)||
   [options.tls?.ca,options.tls?.cert,options.tls?.key].some(v=>!Buffer.isBuffer(v)||types.isProxy(v)||!v.length||v.length>128*1024))fail();
  this.#origin=u;this.#tls={ca:Buffer.from(options.tls.ca),cert:Buffer.from(options.tls.cert),key:Buffer.from(options.tls.key)};this.#peer=options.sunatPeerSha256;this.#enabled=options.enabled===true;this.#now=options.now??(()=>new Date().toISOString());}catch{throw Error('CARRIER_REFERENCE_HTTP_VALIDATION_UNAVAILABLE');}
 }
 async verify(raw:Readonly<CarrierReferenceValidationInput>):Promise<CarrierReference09Evidence['acceptance']>{
  try{
   if(!this.#enabled)fail();const v=inputCopy(raw),asOf=this.#now();if(!Number.isFinite(Date.parse(asOf))||new Date(asOf).toISOString()!==asOf)fail();
   const body={schemaVersion:REQUEST,environment:'BETA',requestId:randomUUID(),asOf,input:{ownerSnapshot:v.ownerSnapshot,ownerSnapshotSha256:v.ownerSnapshotSha256,projection:v.projection,projectionSha256:v.projectionSha256,
    signedXmlBase64:Buffer.from(v.signedXml).toString('base64'),signedXmlSha256:v.signedXmlSha256,cdrXmlBase64:Buffer.from(v.cdrXml).toString('base64'),cdrSha256:v.cdrSha256}};
   const data=Buffer.from(JSON.stringify(body));if(data.length>MAX_REQUEST)fail();
   const response=await this.exchange(data);exact(response,['schemaVersion','environment','requestId','requestSha256','verifiedAt','acceptance']);
   const now=Date.parse(this.#now()),verified=Date.parse(response.verifiedAt),start=Date.parse(asOf);
   if(response.schemaVersion!==RESPONSE||response.environment!=='BETA'||response.requestId!==body.requestId||response.requestSha256!==hash(body)||
    typeof response.verifiedAt!=='string'||!Number.isFinite(verified)||new Date(verified).toISOString()!==response.verifiedAt||verified<start-2000||verified>now+2000||now-start<0||now-start>30000)fail();
   const a=response.acceptance;exact(a,['environment','documentId','issuerRuc','fullNumber','snapshotSha256','cdrSha256','responseCode','status','acceptedAt']);
   if(a.environment!=='BETA'||a.documentId!==v.ownerSnapshot.documentId||a.issuerRuc!==v.ownerSnapshot.issuer.ruc||a.fullNumber!==`${v.ownerSnapshot.series}-${v.ownerSnapshot.number}`||a.snapshotSha256!==v.projectionSha256||
    a.cdrSha256!==v.cdrSha256||a.responseCode!=='0'||!['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(a.status)||typeof a.acceptedAt!=='string'||!Number.isFinite(Date.parse(a.acceptedAt))||
    new Date(a.acceptedAt).toISOString()!==a.acceptedAt||Date.parse(a.acceptedAt)<Date.parse(v.ownerSnapshot.body.issueDate)||Date.parse(a.acceptedAt)>verified||
    hash({...inputCopy(raw),signedXml:sha(raw.signedXml),cdrXml:sha(raw.cdrXml)})!==hash({...v,signedXml:v.signedXmlSha256,cdrXml:v.cdrSha256}))fail();
   return Object.freeze({...a});
  }catch{return fail();}
 }
 private exchange(data:Buffer):Promise<any>{
  return new Promise((resolve,reject)=>{
   let settled=false;const finish=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;if(error)reject(Error('CARRIER_REFERENCE_HTTP_VALIDATION_UNAVAILABLE'));else resolve(value);};
   const req=request(new URL(PATH,this.#origin),{...this.#tls,method:'POST',rejectUnauthorized:true,agent:false,minVersion:'TLSv1.2',timeout:15000,maxHeaderSize:8192,
    checkServerIdentity:(hostname,certificate)=>checkServerIdentity(hostname,certificate)??(certificate.fingerprint256?.replace(/:/g,'').toLowerCase()===this.#peer?undefined:Error('SUNAT_PEER_PIN_REQUIRED')),
    headers:{'Content-Type':'application/json','Content-Length':String(data.length),Accept:'application/json'}},res=>{
    if(res.statusCode!==200||!/^application\/json(?:;|$)/i.test(String(res.headers['content-type']))||res.headers['content-encoding']){res.resume();finish(Error());return;}
    let total=0;const chunks:Buffer[]=[];res.on('data',chunk=>{total+=chunk.length;if(total>MAX_RESPONSE){req.destroy();finish(Error());return;}chunks.push(Buffer.from(chunk));});
    res.on('error',()=>finish(Error()));res.on('aborted',()=>finish(Error()));res.on('end',()=>{if(settled)return;try{finish(undefined,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(Error());}});
   });req.on('timeout',()=>req.destroy(Error('TIMEOUT')));req.on('error',()=>finish(Error()));req.end(data);
  });
 }
 toJSON(){return {service:'HttpCarrierReferenceSignatureCdrValidator',enabled:this.#enabled,environment:'BETA',transmissionAuthorized:false};}
}


