import {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import {createB2bIdentityRuntime,type B2bIdentityRuntimeDependencies} from './runtime';
import {runtimeObject,validateB2bIdentityRuntimeConfig,type B2bIdentityRuntimeConfig,type B2bIdentityRuntimeCredentials} from './runtime-config';
type Files={signingKey:string;pepper:string;humanPublicKey:string;integrationPublicKey:string;oidcCredential:string;
 apiTls:{ca:string;cert:string;key:string};controlTls:{ca:string;cert:string;key:string};billingTls:{ca:string;cert:string;key:string};oidcTls:{ca:string;cert:string;key:string}};
/** Optional mount bootstrap. Neither metadata nor credentials are read unless explicitly opted in. */
export function readB2bIdentityRuntimeFiles(files:B2bRuntimeFiles){
 try{
  const metadata=files.metadata('identity-runtime.json');
  if(!runtimeObject(metadata,['config','files']))throw Error();
  if(metadata.config?.enabled!==true)return null;
  const config=validateB2bIdentityRuntimeConfig(metadata.config as B2bIdentityRuntimeConfig),refs=metadata.files as Files;
  if(!runtimeObject(refs,['signingKey','pepper','humanPublicKey','integrationPublicKey','oidcCredential','apiTls','controlTls','billingTls','oidcTls']))throw Error();
  const names:unknown[]=[refs.signingKey,refs.pepper,refs.humanPublicKey,refs.integrationPublicKey,refs.oidcCredential];
  for(const tls of [refs.apiTls,refs.controlTls,refs.billingTls,refs.oidcTls]){if(!runtimeObject(tls,['ca','cert','key']))throw Error();names.push(tls.ca,tls.cert,tls.key);}
  if(names.some(n=>typeof n!=='string'||!/^[a-z][a-z0-9-]{0,63}\.(pem|key|crt|bin)$/.test(n)))throw Error();
  const tls=(t:Files['apiTls'])=>({ca:files.publicPem(t.ca),cert:files.publicPem(t.cert),key:files.privatePem(t.key)});
  const credentials:B2bIdentityRuntimeCredentials={signingKey:files.privatePem(refs.signingKey),pepper:files.secretBytes(refs.pepper),humanPublicKey:files.publicPem(refs.humanPublicKey),
   integrationPublicKey:files.publicPem(refs.integrationPublicKey),oidcBasicCredential:files.secretBytes(refs.oidcCredential).toString('ascii'),
   apiTls:tls(refs.apiTls),controlTls:tls(refs.controlTls),billingTls:tls(refs.billingTls),oidcTls:tls(refs.oidcTls)};
  return {config,credentials};
 }catch{throw Error('B2B_IDENTITY_MOUNTED_RUNTIME_NOT_READY');}
}

export async function createB2bIdentityRuntimeFromFiles(files:B2bRuntimeFiles,deps:Omit<B2bIdentityRuntimeDependencies,'credentials'>,options:{enabled?:boolean}={}){
 if(options.enabled!==true)return null;
 const loaded=readB2bIdentityRuntimeFiles(files);
 return loaded?createB2bIdentityRuntime(loaded.config,{...deps,credentials:loaded.credentials}):null;
}
