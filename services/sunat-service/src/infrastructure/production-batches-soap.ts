import { assertProductionSoapAuthorized, type ProductionSoapAuthorization } from './sunat/production-soap-authorization';
import { SUNAT_PRODUCTION_ENDPOINT, base64Zip } from './sunat/bounded-soap.adapter';
import { safeXml, child, children, leaf, escapeXml, SOAP_NS, SERVICE_NS } from './sunat/safe-xml';
import { productionBatchesHash } from './production-batches-cdr';
import { productionTransportXml } from './sunat/production-transport-zip';
import type { SignedPackage, TicketStatus } from '../domain/ports/sunat-adapter.port';
/** Fixed official endpoint, no redirects/retries. Does not use the legacy single-CDR response parser. */
export class ProductionBatchesSoap {
 constructor(private readonly ruc:string,private readonly user:string,private readonly password:string,private readonly authority:ProductionSoapAuthorization){}
 private async call(method:'sendSummary'|'getStatus',body:string){
  if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0'||!this.user.trim()||this.user.startsWith(this.ruc)||/moddatos/i.test(this.user+this.password)||!this.password.trim())throw Error('Credenciales/TLS productivos requeridos');
  const wsse='http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
  const xml='<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="'+SOAP_NS+'" xmlns:ser="'+SERVICE_NS+'" xmlns:wsse="'+wsse+'"><soap:Header><wsse:Security soap:mustUnderstand="1"><wsse:UsernameToken><wsse:Username>'+escapeXml(this.ruc+this.user)+'</wsse:Username><wsse:Password Type="'+wsse+'#PasswordText">'+escapeXml(this.password)+'</wsse:Password></wsse:UsernameToken></wsse:Security></soap:Header><soap:Body><ser:'+method+'>'+body+'</ser:'+method+'></soap:Body></soap:Envelope>';
  await assertProductionSoapAuthorized(this.authority,this.ruc,method);
  if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw Error('TLS requerido');
  const r=await fetch(SUNAT_PRODUCTION_ENDPOINT,{method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:method},body:xml,redirect:'error',signal:AbortSignal.timeout(15000)});
  if(Number(r.headers.get('content-length'))>7*1024*1024){await r.body?.cancel();throw Error('Respuesta excedida');}
  const reader=r.body?.getReader();if(!reader)throw Error('Respuesta ausente');
  let length=0;const chunks:Uint8Array[]=[];
  try{while(true){const item=await reader.read();if(item.done)break;length+=item.value.length;if(length>7*1024*1024)throw Error('Respuesta excedida');chunks.push(item.value);}}catch(e){await reader.cancel();throw e;}
  const root=safeXml(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),7*1024*1024);
  if(!r.ok||root.namespaceURI!==SOAP_NS||root.localName!=='Envelope')throw Error('Resultado SOAP incierto');
  const soapBody=child(root,SOAP_NS,'Body');
  if(children(soapBody,SOAP_NS,'Fault').length)throw Error('Resultado SOAP incierto');
  return child(soapBody,SERVICE_NS,method+'Response');
 }
 async submitSummary(pkg:SignedPackage){
  if(pkg.sha256!==productionBatchesHash(pkg.zip)||!new RegExp('^'+this.ruc+'-(RC|RA)-[0-9]{8}-[1-9][0-9]{0,4}\\.zip$').test(pkg.fileName))throw Error('Paquete inválido');
  productionTransportXml(pkg.zip,pkg.fileName.replace(/\.zip$/,'.xml'));
  const response=await this.call('sendSummary','<fileName>'+escapeXml(pkg.fileName)+'</fileName><contentFile>'+pkg.zip.toString('base64')+'</contentFile>');
  const ticket=leaf(response,'','ticket',120);
  if(!/^[A-Za-z0-9_-]{1,120}$/.test(ticket))throw Error('Ticket incierto');return ticket;
 }
 async getStatus(ticket:string):Promise<TicketStatus>{
  if(!/^[A-Za-z0-9_-]{1,120}$/.test(ticket))throw Error('Ticket inválido');
  const status=child(await this.call('getStatus','<ticket>'+escapeXml(ticket)+'</ticket>'),'','status'),code=leaf(status,'','statusCode',10);
  if(code==='98'&&!children(status,'','content').length)return {kind:'PROCESSING'};
  if(code==='0'||code==='99')return {kind:'CDR',cdrZip:base64Zip(leaf(status,'','content',6*1024*1024))};
  return {kind:'ERROR',code,message:'Conciliar ticket; no reenviar',retryable:false};
 }
}
