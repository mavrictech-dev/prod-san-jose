import {createSecureContext} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {correctionEvidenceFreeze} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {imapHost} from '../automation/policy';

export interface B2bReceivedRuntimeConfig {
 enabled?:boolean;environment:'BETA';approvedForPrivateBeta:true;deploymentId:string;instanceId:string;
 api:{host:'127.0.0.1'|'0.0.0.0';port:number};control:{host:'127.0.0.1'|'0.0.0.0';port:number};
 peers:{resource:readonly string[];operator:readonly string[]};maxConcurrent?:number;
 automation?:{networkProfile:'LOCAL_ONLY'|'LIVE_READ_ONLY';approvedImapHosts:readonly string[]};
 readOnlyExecution?:{enabled:boolean;approvedForReadOnlyBeta:boolean;approvalReference:string};
}
export type B2bReceivedRuntimeTls={ca:Buffer;cert:Buffer;key:Buffer};
export interface B2bReceivedRuntimeCredentials {apiTls:B2bReceivedRuntimeTls;controlTls:B2bReceivedRuntimeTls}
const fail=():never=>{throw Error('B2B_RECEIVED_RUNTIME_CONFIG_INVALID');};
function exact(v:unknown,required:readonly string[],optional:readonly string[]=[]):asserts v is Record<string,any>{
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype||required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>![...required,...optional].includes(k)))fail();
}
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export function validateB2bReceivedRuntimeConfig(input:B2bReceivedRuntimeConfig):B2bReceivedRuntimeConfig {
 try{
  const c=correctionEvidenceFreeze(input) as B2bReceivedRuntimeConfig;
  exact(c,['enabled','environment','approvedForPrivateBeta','deploymentId','instanceId','api','control','peers'],['maxConcurrent','automation','readOnlyExecution']);
  if(c.enabled!==true||c.environment!=='BETA'||c.approvedForPrivateBeta!==true||!uuid(c.deploymentId)||!uuid(c.instanceId))fail();
  for(const endpoint of [c.api,c.control]){exact(endpoint,['host','port']);if(!['127.0.0.1','0.0.0.0'].includes(endpoint.host)||!Number.isInteger(endpoint.port)||endpoint.port<0||endpoint.port>65535)fail();}
  if(c.api.port!==0&&c.api.port===c.control.port)fail();
  exact(c.peers,['resource','operator']);
  for(const peers of [c.peers.resource,c.peers.operator])if(!Array.isArray(peers)||!peers.length||peers.length>32||new Set(peers).size!==peers.length||peers.some(p=>typeof p!=='string'||!/^[a-f0-9]{64}$/.test(p)))fail();
  if(c.peers.resource.some(p=>c.peers.operator.includes(p)))fail();
  if(!Number.isInteger(c.maxConcurrent??16)||(c.maxConcurrent??16)<1||(c.maxConcurrent??16)>64)fail();
  if(c.automation){
   exact(c.automation,['networkProfile','approvedImapHosts']);
   if(!['LOCAL_ONLY','LIVE_READ_ONLY'].includes(c.automation.networkProfile)||!Array.isArray(c.automation.approvedImapHosts)||c.automation.approvedImapHosts.length>16||new Set(c.automation.approvedImapHosts).size!==c.automation.approvedImapHosts.length||c.automation.approvedImapHosts.some(h=>!imapHost(h)))fail();
  }
  if(c.readOnlyExecution){
   exact(c.readOnlyExecution,['enabled','approvedForReadOnlyBeta','approvalReference']);
   if(typeof c.readOnlyExecution.enabled!=='boolean'||typeof c.readOnlyExecution.approvedForReadOnlyBeta!=='boolean'||typeof c.readOnlyExecution.approvalReference!=='string'||!/^TI-[A-Za-z0-9._-]{1,80}$/.test(c.readOnlyExecution.approvalReference))fail();
   if(c.readOnlyExecution.enabled&&(c.readOnlyExecution.approvedForReadOnlyBeta!==true||c.automation?.networkProfile!=='LIVE_READ_ONLY'))fail();
  }
  return c;
 }catch{throw Error('B2B_RECEIVED_RUNTIME_CONFIG_INVALID');}
}
export function validateB2bReceivedRuntimeCredentials(input:B2bReceivedRuntimeCredentials):B2bReceivedRuntimeCredentials {
 try{
  const copy=(tls:B2bReceivedRuntimeTls)=>{
   exact(tls,['ca','cert','key']);
   for(const value of [tls.ca,tls.cert,tls.key])if(!Buffer.isBuffer(value)||!value.length||value.length>262144)fail();
   const out={ca:Buffer.from(tls.ca),cert:Buffer.from(tls.cert),key:Buffer.from(tls.key)};
   createSecureContext({...out,minVersion:'TLSv1.2'});const cert=new X509Certificate(out.cert);
   if(Date.parse(cert.validFrom)>Date.now()||Date.parse(cert.validTo)<=Date.now())fail();return out;
  };
  exact(input,['apiTls','controlTls']);return {apiTls:copy(input.apiTls),controlTls:copy(input.controlTls)};
 }catch{throw Error('B2B_RECEIVED_RUNTIME_TLS_INVALID');}
}
