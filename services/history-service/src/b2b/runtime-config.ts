import {isAbsolute,normalize} from 'node:path';
import {createSecureContext} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {historyJson} from '@factuez/history-core';
export interface B2bHistoryRuntimeConfig {
 enabled?:boolean;schemaVersion:'factuez.b2b.history-runtime.v1';environment:'BETA';datasetClass:'SYNTHETIC';approvedForSyntheticQa:true;
 deploymentId:string;instanceId:string;markerId:string;
 api:{host:'127.0.0.1'|'0.0.0.0';port:number};control:{host:'127.0.0.1'|'0.0.0.0';port:number};
 peers:{resource:readonly string[];operator:readonly string[]};identityOrigin:string;
 database:{host:string;port:number;name:string;user:'history_reader_qa';passwordFile:'database-password.bin'};
 storage:{sourceRoot:string;archiveRoot:string};maxConcurrent?:number;
}
export interface HistoryRuntimeTls {ca:Buffer;cert:Buffer;key:Buffer}
export interface B2bHistoryRuntimeCredentials {apiTls:HistoryRuntimeTls;controlTls:HistoryRuntimeTls}
export const historyQaDatabase=(v:unknown):v is string=>typeof v==='string'&&/^factuez_history_qa_[a-f0-9]{10}(?:_restore)?$/.test(v);
function exact(v:any,required:string[],optional:string[]=[]){if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v))||required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>![...required,...optional].includes(k)))throw Error();}
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export function historyRuntimeConfig(input:unknown):B2bHistoryRuntimeConfig {
 try{
  const c=historyJson(input) as B2bHistoryRuntimeConfig;
  exact(c,['enabled','schemaVersion','environment','datasetClass','approvedForSyntheticQa','deploymentId','instanceId','markerId','api','control','peers','identityOrigin','database','storage'],['maxConcurrent']);
  if(c.enabled!==true||c.schemaVersion!=='factuez.b2b.history-runtime.v1'||c.environment!=='BETA'||c.datasetClass!=='SYNTHETIC'||c.approvedForSyntheticQa!==true||![c.deploymentId,c.instanceId,c.markerId].every(uuid))throw Error();
  for(const p of [c.api,c.control]){exact(p,['host','port']);if(!['127.0.0.1','0.0.0.0'].includes(p.host)||!Number.isInteger(p.port)||p.port<0||p.port>65535)throw Error();}
  if(c.api.port!==0&&c.api.port===c.control.port)throw Error();
  exact(c.peers,['resource','operator']);for(const p of [c.peers.resource,c.peers.operator])if(!Array.isArray(p)||!p.length||p.length>32||new Set(p).size!==p.length||p.some(v=>!/^[a-f0-9]{64}$/.test(v)))throw Error();
  if(c.peers.resource.some(p=>c.peers.operator.includes(p)))throw Error();
  const origin=new URL(c.identityOrigin);if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||origin.hash||origin.search)throw Error();
  exact(c.database,['host','port','name','user','passwordFile']);if(!historyQaDatabase(c.database.name)||c.database.user!=='history_reader_qa'||c.database.passwordFile!=='database-password.bin'||typeof c.database.host!=='string'||!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(c.database.host)||!Number.isInteger(c.database.port)||c.database.port<1||c.database.port>65535)throw Error();
  exact(c.storage,['sourceRoot','archiveRoot']);for(const p of Object.values(c.storage))if(typeof p!=='string'||!isAbsolute(p)||normalize(p)!==p)throw Error();
  if(!Number.isInteger(c.maxConcurrent??16)||(c.maxConcurrent??16)<1||(c.maxConcurrent??16)>64)throw Error();
  return c;
 }catch{throw Error('B2B_HISTORY_RUNTIME_CONFIG_INVALID');}
}
export function historyRuntimeTls(tls:HistoryRuntimeTls):HistoryRuntimeTls {
 try{
  exact(tls,['ca','cert','key']);for(const b of [tls.ca,tls.cert,tls.key])if(!Buffer.isBuffer(b)||!b.length||b.length>65536)throw Error();
  const c={ca:Buffer.from(tls.ca),cert:Buffer.from(tls.cert),key:Buffer.from(tls.key)};
  createSecureContext({...c,minVersion:'TLSv1.2'});const cert=new X509Certificate(c.cert);if(Date.parse(cert.validFrom)>Date.now()||Date.parse(cert.validTo)<=Date.now())throw Error();return c;
 }catch{throw Error('B2B_HISTORY_RUNTIME_TLS_INVALID');}
}
