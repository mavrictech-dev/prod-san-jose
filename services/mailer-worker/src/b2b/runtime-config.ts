import {smtpHostname} from '../smtp-configuration.policy';
import {createSecureContext} from 'node:tls';
export interface MailerRuntimeTls {ca:Buffer;cert:Buffer;key:Buffer}
export interface B2bMailerRuntimeConfig {
 enabled:true;schemaVersion:'factuez.b2b.mailer-runtime.v1';environment:'BETA';
 deploymentId:string;instanceId:string;profile:'NONE'|'LOCAL_CAPTURE'|'CORPORATE';
 api:{host:'127.0.0.1'|'0.0.0.0';port:number};control:{host:'127.0.0.1'|'0.0.0.0';port:number};
 peers:{resource:string[];operator:string[]};identityOrigin:string;billingOrigin:string;
 database:{host:string;port:number;name:string;user:string;passwordFile:string};
 dispatcher:{enabled:boolean;intervalMs:number;batchSize:number};
 smtpAdministration:boolean;captureRoot?:string;
 corporate?:{realSendEnabled:true;approvedHosts:string[]};
}
const exact=(v:any,keys:string[])=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.sort().join(',');
export function mailerRuntimeConfig(input:B2bMailerRuntimeConfig):B2bMailerRuntimeConfig {
 try {
  const c=structuredClone(input);
  if(!exact(c,['enabled','schemaVersion','environment','deploymentId','instanceId','profile','api','control','peers','identityOrigin','billingOrigin','database','dispatcher','smtpAdministration',...(c.captureRoot===undefined?[]:['captureRoot']),...(c.corporate===undefined?[]:['corporate'])])||
   c.enabled!==true||c.schemaVersion!=='factuez.b2b.mailer-runtime.v1'||c.environment!=='BETA'||!['NONE','LOCAL_CAPTURE','CORPORATE'].includes(c.profile)||
   [c.deploymentId,c.instanceId].some(v=>!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v)))throw Error();
  for(const v of [c.api,c.control])if(!exact(v,['host','port'])||!['127.0.0.1','0.0.0.0'].includes(v.host)||!Number.isInteger(v.port)||v.port<0||v.port>65535)throw Error();
  if(c.api.port!==0&&c.api.port===c.control.port)throw Error();
  if(!exact(c.peers,['resource','operator']))throw Error();
  for(const peers of Object.values(c.peers))if(!Array.isArray(peers)||!peers.length||peers.length>32||new Set(peers).size!==peers.length||peers.some(v=>!/^[a-f0-9]{64}$/.test(v)))throw Error();
  for(const origin of [c.identityOrigin,c.billingOrigin]){const u=new URL(origin);if(u.protocol!=='https:'||u.pathname!=='/'||u.username||u.password||u.search||u.hash)throw Error();}
  if(!exact(c.database,['host','port','name','user','passwordFile'])||!/^factuez_mailer[a-z0-9_]*_beta$/.test(c.database.name)||
   !/^[a-z][a-z0-9_]{0,62}$/.test(c.database.user)||!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(c.database.host)||
   !Number.isInteger(c.database.port)||c.database.port<1||c.database.port>65535||!/^[a-z][a-z0-9-]{0,63}\.bin$/.test(c.database.passwordFile))throw Error();
  if(!exact(c.dispatcher,['enabled','intervalMs','batchSize'])||typeof c.dispatcher.enabled!=='boolean'||!Number.isInteger(c.dispatcher.intervalMs)||c.dispatcher.intervalMs<1000||c.dispatcher.intervalMs>60000||
   !Number.isInteger(c.dispatcher.batchSize)||c.dispatcher.batchSize<1||c.dispatcher.batchSize>32||c.dispatcher.enabled&&c.profile==='NONE'||typeof c.smtpAdministration!=='boolean'||
   c.profile==='LOCAL_CAPTURE'&&typeof c.captureRoot!=='string'||c.profile!=='LOCAL_CAPTURE'&&c.captureRoot!==undefined)throw Error();
  if(c.profile==='CORPORATE'){
   if(!exact(c.corporate,['realSendEnabled','approvedHosts'])||c.corporate!.realSendEnabled!==true||!Array.isArray(c.corporate!.approvedHosts)||!c.corporate!.approvedHosts.length||c.corporate!.approvedHosts.length>16||c.corporate!.approvedHosts.some(h=>!smtpHostname(h))||new Set(c.corporate!.approvedHosts).size!==c.corporate!.approvedHosts.length)throw Error();
  }else if(c.corporate!==undefined)throw Error();
  return c;
 }catch{throw Error('B2B_MAILER_RUNTIME_CONFIG_INVALID');}
}
export function mailerRuntimeTls(t:MailerRuntimeTls):MailerRuntimeTls {
 try{if(!t||!Object.values(t).every(v=>Buffer.isBuffer(v)&&v.length>0))throw Error();createSecureContext({...t,minVersion:'TLSv1.2'});return {ca:Buffer.from(t.ca),cert:Buffer.from(t.cert),key:Buffer.from(t.key)};}
 catch{throw Error('B2B_MAILER_MTLS_REQUIRED');}
}
