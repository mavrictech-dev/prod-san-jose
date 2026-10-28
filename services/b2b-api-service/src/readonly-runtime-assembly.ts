import {randomUUID} from 'node:crypto';
import {B2bIdentityHttp,B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {B2bOAuthHttp} from '@factuez/service-access/dist/b2b-oauth-http';
import {b2bOwnerRuntimeCapabilities} from '@factuez/service-access/dist/b2b-runtime-status';
import {B2bReads,HttpB2bReadOwner} from './read';
import {B2bWebhooks,HttpWebhookOwner} from './webhooks';
import {createB2bReadonlyApplication} from './readonly-application';
import {readonlyOwners,readonlyRequiredCapabilities,type ReadonlyOwner} from './readonly-runtime-config';
import type {B2bOperationalControl} from './operational-control';
export type ReadonlyTransports=Record<ReadonlyOwner,B2bPrivateHttp>;
/** Subset proof only. This function cannot satisfy or replace verifyB2bOwnerGraph. */
export async function verifyB2bReadonlyOwners(resources:ReadonlyTransports,deploymentId:string){
 const boots=new Set<string>();
 for(const owner of readonlyOwners){
  if(!(resources?.[owner] instanceof B2bPrivateHttp))throw Error('B2B_READONLY_HTTP_OWNER_REQUIRED');
  const r:any=await resources[owner].post('/internal/b2b/runtime-status',{});
  if(!r||Object.keys(r).sort().join(',')!=='bootId,capabilities,deploymentId,environment,fiscalActivation,owner,schemaVersion,state'||
   r.schemaVersion!=='factuez.b2b.owner-runtime.v1'||r.environment!=='BETA'||r.owner!==owner||r.deploymentId!==deploymentId||
   r.state!=='ASSEMBLED_AND_STORAGE_CHECKED'||r.fiscalActivation!==false||typeof r.bootId!=='string'||
   !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.bootId)||boots.has(r.bootId)||
   !Array.isArray(r.capabilities)||new Set(r.capabilities).size!==r.capabilities.length||
   r.capabilities.some((c:string)=>!(b2bOwnerRuntimeCapabilities[owner] as readonly string[]).includes(c))||
   readonlyRequiredCapabilities[owner].some(c=>!r.capabilities.includes(c)))throw Error('B2B_READONLY_OWNER_NOT_READY');
  boots.add(r.bootId);
 }
 return Object.freeze({profile:'READONLY_OAUTH_WEBHOOKS' as const,storageCheckedAt:new Date().toISOString(),owners:[...readonlyOwners]});
}
class ReadonlyReads extends B2bReads{
 override async capabilities(...args:Parameters<B2bReads['capabilities']>){
  // The superclass retains per-token scope evaluation and NOT_PROBED.
  const value=await super.capabilities(...args);
  return {...value,localRepresentations:[],publishedProfile:{id:'READONLY_OAUTH_WEBHOOKS',businessWrites:false,oauthGrant:'client_credentials',
   userDelegation:'LIVE_IDENTITY_SSO_REQUIRED_NOT_PROBED',webhooks:'OWNER_MANAGEMENT_AND_READS',callbackDispatch:'OWNER_CONTROLLED_NOT_PROBED',
   fullGraphReady:false,owners:[...readonlyOwners]}};
 }
}
export async function assembleB2bReadonlyFacade(transports:ReadonlyTransports,options:{
 deploymentId:string;tls:{ca:Buffer;cert:Buffer;key:Buffer};peers:string[];operations:B2bOperationalControl;oauth:B2bOAuthHttp;
}){
 if(!(options.oauth instanceof B2bOAuthHttp))throw Error('B2B_READONLY_OAUTH_TRANSPORT_REQUIRED');
 const proof=await verifyB2bReadonlyOwners(transports,options.deploymentId),identity=new B2bIdentityHttp(transports.identity);
 const app=await createB2bReadonlyApplication({tls:options.tls,peers:options.peers,operations:options.operations,oauth:options.oauth,
  read:new ReadonlyReads(identity,new HttpB2bReadOwner(transports.billing),new HttpB2bReadOwner(transports.fiscal,true)),
  webhooks:new B2bWebhooks(identity,new HttpWebhookOwner(transports.webhooks))});
 return {app,proof,bootId:randomUUID()};
}
