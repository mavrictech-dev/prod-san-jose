import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { inspect } from 'node:util';
export type ProductionGuidesPrivateTls={ca:Buffer;cert:Buffer;key:Buffer;serverFingerprint:string};
export const PRODUCTION_GUIDES_PRIVATE_PATHS=Object.freeze([
 '/internal/production-guides/billing/current','/internal/production-guides/billing/grant-current','/internal/production-guides/billing/reference-owner','/internal/production-guides/billing/status',
 '/internal/production-guides/sunat/grant-evidence','/internal/production-guides/sunat/admit','/internal/production-guides/sunat/ingest','/internal/production-guides/sunat/status','/internal/production-guides/sunat/artifact','/internal/production-guides/sunat/pdf','/internal/production-guides/sunat/reference-evidence'
]);
export function productionGuidesPrivatePeer(request:{socket:TLSSocket},pins:readonly string[]){
 const s=request.socket,pin=s?.encrypted&&s.authorized&&s.getPeerCertificate().fingerprint256?.replaceAll(':','').toLowerCase();
 if(!pin||!pins.includes(pin))throw Error('GRE_PRIVATE_PEER_REQUIRED');return pin;
}
/** Fixed routes, client certificate, pinned server certificate and CA, no redirects or bearer persistence. */
export class ProductionGuidesPrivateHttp {
 #tls:ProductionGuidesPrivateTls;#origin:URL;
 constructor(origin:string,tls:ProductionGuidesPrivateTls){const u=new URL(origin);if(u.protocol!=='https:'||u.pathname!=='/'||u.username||u.password||u.search||u.hash||!/^[a-f0-9]{64}$/.test(tls.serverFingerprint)||![tls.ca,tls.cert,tls.key].every(b=>Buffer.isBuffer(b)&&b.length))throw Error('GRE_PRIVATE_TLS_REQUIRED');this.#origin=u;this.#tls={...tls,ca:Buffer.from(tls.ca),cert:Buffer.from(tls.cert),key:Buffer.from(tls.key)};}
 toJSON(){return {service:'ProductionGuidesPrivateHttp',contents:'PRIVATE'};}[inspect.custom](){return this.toJSON();}
 close(){this.#tls.key.fill(0);}
 async post<T>(path:string,body:unknown):Promise<T>{
  if(!PRODUCTION_GUIDES_PRIVATE_PATHS.includes(path))throw Error('GRE_PRIVATE_ROUTE_DENIED');const input=Buffer.from(JSON.stringify(body));if(input.length>1024*1024)throw Error('GRE_PRIVATE_INPUT_LIMIT');
  return new Promise<T>((resolve,reject)=>{
   let settled=false;const fail=()=>{if(!settled){settled=true;reject(Error('GRE_PRIVATE_EXCHANGE_FAILED'));}};
   const req=request(new URL(path,this.#origin),{method:'POST',ca:this.#tls.ca,cert:this.#tls.cert,key:this.#tls.key,rejectUnauthorized:true,minVersion:'TLSv1.2',headers:{'Content-Type':'application/json',Accept:'application/json','Content-Length':input.length}},res=>{
    const socket=res.socket as TLSSocket;if(!socket.authorized||socket.getPeerCertificate().fingerprint256?.replaceAll(':','').toLowerCase()!==this.#tls.serverFingerprint){req.destroy();fail();return;}
    const chunks:Buffer[]=[];let size=0;res.on('data',(b:Buffer)=>{size+=b.length;if(size>8*1024*1024){req.destroy();fail();}else chunks.push(b);});res.on('error',fail);res.on('aborted',fail);res.on('end',()=>{clearTimeout(timer);if(!settled){try{if(res.statusCode!==201&&res.statusCode!==200)throw Error();const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));settled=true;resolve(value);}catch{fail();}}});
   });const timer=setTimeout(()=>{req.destroy();fail();},45000);req.on('error',()=>{clearTimeout(timer);fail();});req.end(input);
  });
 }
}
