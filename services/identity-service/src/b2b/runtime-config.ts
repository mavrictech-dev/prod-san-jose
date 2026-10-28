import {createPrivateKey,createPublicKey,X509Certificate} from 'node:crypto';
import {createSecureContext} from 'node:tls';
import {types} from 'node:util';
import {B2bEnabledIdentityScopes,type B2bIdentityScope} from '@factuez/contracts/b2b-security';
export interface B2bIdentityRuntimeTls {ca:Buffer;cert:Buffer;key:Buffer}
export interface B2bIdentityRuntimeConfig {
 enabled?:boolean;environment:'BETA';deploymentId:string;instanceId:string;
 api:{host:'127.0.0.1'|'0.0.0.0';port:number};control:{host:'127.0.0.1'|'0.0.0.0';port:number};
 tokenIssuer:string;billingOrigin:string;
 oidc:{issuer:string;introspectionEndpoint:string;adminClientId:string;acceptedAcr:string[]};
 scopes:B2bIdentityScope[];
 peers:{token:string[];admin:string[];resource:string[];correctionOwner:string[];guideOwner:string[];guideIssueOwner:string[];webhook:string[];operator:string[]};
}
export interface B2bIdentityRuntimeCredentials {
 signingKey:Buffer;pepper:Buffer;humanPublicKey:Buffer;integrationPublicKey:Buffer;oidcBasicCredential:string;
 apiTls:B2bIdentityRuntimeTls;controlTls:B2bIdentityRuntimeTls;billingTls:B2bIdentityRuntimeTls;oidcTls:B2bIdentityRuntimeTls;
}
const invalid=()=>Error('B2B_IDENTITY_RUNTIME_CONFIGURATION_INVALID');
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export function runtimeObject(v:unknown,required:string[],optional:string[]=[]):v is Record<string,any>{
 if(!v||typeof v!=='object'||types.isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)return false;
 const ds=Object.getOwnPropertyDescriptors(v),ks=Reflect.ownKeys(v);
 return required.every(k=>Object.hasOwn(ds,k))&&ks.every(k=>typeof k==='string'&&[...required,...optional].includes(k)&&ds[k].enumerable&&'value'in ds[k]);
}
function url(value:unknown,origin=false){
 if(typeof value!=='string'||value.length>2048||!value.startsWith('https://')||/[\s\\?#]/.test(value))throw invalid();
 const u=new URL(value);if(u.protocol!=='https:'||!u.hostname||u.username||u.password||origin&&u.pathname!=='/')throw invalid();return u;
}
export function validateB2bIdentityRuntimeConfig(input:B2bIdentityRuntimeConfig):B2bIdentityRuntimeConfig {
 try{
  if(!runtimeObject(input,['enabled','environment','deploymentId','instanceId','api','control','tokenIssuer','billingOrigin','oidc','scopes','peers'])||input.enabled!==true||input.environment!=='BETA'||!uuid(input.deploymentId)||!uuid(input.instanceId))throw invalid();
  for(const listener of [input.api,input.control])if(!runtimeObject(listener,['host','port'])||!['127.0.0.1','0.0.0.0'].includes(listener.host)||!Number.isInteger(listener.port)||listener.port<0||listener.port>65535)throw invalid();
  if(input.api.port!==0&&input.api.port===input.control.port)throw invalid();
  url(input.tokenIssuer);url(input.billingOrigin,true);
  if(!runtimeObject(input.oidc,['issuer','introspectionEndpoint','adminClientId','acceptedAcr'])||url(input.oidc.issuer).origin!==url(input.oidc.introspectionEndpoint).origin||
    !/^[A-Za-z0-9_-]{1,120}$/.test(input.oidc.adminClientId)||!Array.isArray(input.oidc.acceptedAcr)||!input.oidc.acceptedAcr.length||input.oidc.acceptedAcr.length>32||
    input.oidc.acceptedAcr.some((a:unknown)=>typeof a!=='string'||!a||a.length>255||/[\x00-\x20\x7f]/.test(a))||new Set(input.oidc.acceptedAcr).size!==input.oidc.acceptedAcr.length)throw invalid();
  if(!Array.isArray(input.scopes)||!input.scopes.length||input.scopes.length>B2bEnabledIdentityScopes.length||new Set(input.scopes).size!==input.scopes.length||input.scopes.some((s:B2bIdentityScope)=>!B2bEnabledIdentityScopes.includes(s)))throw invalid();
  if(!runtimeObject(input.peers,['token','admin','resource','correctionOwner','guideOwner','guideIssueOwner','webhook','operator']))throw invalid();
  for(const [name,list] of Object.entries(input.peers))if(!Array.isArray(list)||!list.length||list.length>(name==='operator'?32:100)||new Set(list).size!==list.length||list.some(p=>typeof p!=='string'||!/^[a-f0-9]{64}$/.test(p)))throw invalid();
  const p=input.peers,owners=[...p.token,...p.resource,...p.correctionOwner,...p.guideOwner,...p.guideIssueOwner,...p.webhook];
  if(p.admin.some((s:string)=>owners.includes(s)||p.operator.includes(s))||p.operator.some((s:string)=>owners.includes(s)))throw invalid();
  return structuredClone(input);
 }catch{throw invalid();}
}
export function validateB2bIdentityRuntimeCredentials(input:B2bIdentityRuntimeCredentials):B2bIdentityRuntimeCredentials {
 try{
  if(!runtimeObject(input,['signingKey','pepper','humanPublicKey','integrationPublicKey','oidcBasicCredential','apiTls','controlTls','billingTls','oidcTls'])||
    !Buffer.isBuffer(input.pepper)||input.pepper.length!==32||typeof input.oidcBasicCredential!=='string'||input.oidcBasicCredential.length>4096||!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(input.oidcBasicCredential))throw invalid();
  for(const b of [input.signingKey,input.humanPublicKey,input.integrationPublicKey])if(!Buffer.isBuffer(b)||!b.length||b.length>32768)throw invalid();
  const der=(v:Buffer)=>createPublicKey(v).export({format:'der',type:'spki'}),signing=der(input.signingKey);
  if(der(input.humanPublicKey).equals(signing)||der(input.integrationPublicKey).equals(signing))throw invalid();
  const copyTls=(tls:B2bIdentityRuntimeTls)=>{
   if(!runtimeObject(tls,['ca','cert','key']))throw invalid();
   for(const b of Object.values(tls))if(!Buffer.isBuffer(b)||!b.length||b.length>32768)throw invalid();
   const cert=new X509Certificate(tls.cert),key=createPrivateKey(tls.key);
   if(!cert.checkPrivateKey(key)||cert.publicKey.export({format:'der',type:'spki'}).equals(signing))throw invalid();
   createSecureContext(tls);return {ca:Buffer.from(tls.ca),cert:Buffer.from(tls.cert),key:Buffer.from(tls.key)};
  };
  const apiTls=copyTls(input.apiTls),controlTls=copyTls(input.controlTls),billingTls=copyTls(input.billingTls),oidcTls=copyTls(input.oidcTls);
  if(new X509Certificate(apiTls.cert).fingerprint256===new X509Certificate(controlTls.cert).fingerprint256)throw invalid();
  return {signingKey:Buffer.from(input.signingKey),pepper:Buffer.from(input.pepper),humanPublicKey:Buffer.from(input.humanPublicKey),integrationPublicKey:Buffer.from(input.integrationPublicKey),
   oidcBasicCredential:input.oidcBasicCredential,apiTls,controlTls,billingTls,oidcTls};
 }catch{throw invalid();}
}
