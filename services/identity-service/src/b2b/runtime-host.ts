import {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import {mountedB2bPostgres} from '@factuez/service-access/dist/b2b-postgres-options';
import {B2bPrivateHttp,B2bBindingCatalogueHttp} from '@factuez/service-access/dist/b2b';
import {stopB2bMaintenanceNode} from '@factuez/service-access/dist/b2b-maintenance-node';
import {PrismaService} from '../infrastructure/prisma.service';
import {PasswordService} from '../application/password.service';
import {UserPermissionsService} from '../application/user-permissions.service';
import {PostgresLinkedUsers} from './users';
import {HttpsOidcIntrospection} from './oidc';
import {PostgresB2bStore} from './postgres-store';
import {createB2bIdentityRuntime,type B2bIdentityOwnerRuntime} from './runtime';
import {readB2bIdentityRuntimeFiles} from './runtime-files';
import {validateB2bIdentityRuntimeCredentials} from './runtime-config';
import {b2bIdentityHostConfig,checkB2bIdentityDatabaseEnvironment} from './runtime-host-config';
import {PostgresB2bLiveHumanIdentity,OidcB2bPrivilegedHumanAuthority,HttpB2bIdentityBindingOwner} from './runtime-host-authority';
import {phase8AdminPolicy,type Phase8AdminAction} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import {B2bOwnerAdministration} from './owner-administration';
import {B2bOwnerAdministrationModule} from './owner-administration-http';
import {createReceivedApprovalServer} from './received-approval';
import {PostgresQueuedUsers} from './webhook-authority';
import {B2bQueuedEmailActor} from './email-actor';
import {B2bQueuedEmailActorModule} from './email-actor-http';
import {B2bBillingCurrentAuthority} from './billing-current-authority';
import {B2bBillingCurrentAuthorityModule} from './billing-current-authority-http';
import type {B2bIdentity} from './service';
/** Fixed standalone composition: no AppModule/RBAC bootstrap, outbox, timers, consumers or other owner listener is constructed. */
export class B2bStandaloneIdentityLifecycle {
 #resources=Object.freeze({producers:Object.freeze([]),workers:Object.freeze([]),otherListeners:Object.freeze([])});
 async stopProducers(){if(this.#resources.producers.length)throw Error('UNEXPECTED_IDENTITY_PRODUCER');}
 async stopWorkers(){if(this.#resources.workers.length)throw Error('UNEXPECTED_IDENTITY_WORKER');}
 // Identity's read side stays open until STORAGE. External worker completion belongs to the global phase barrier, not a local invented receipt.
 async waitForDependentWorkers(){if(this.#resources.workers.length)throw Error('IDENTITY_WORKER_NOT_DRAINED');}
 async closeOtherOwnerListeners(){if(this.#resources.otherListeners.length)throw Error('UNEXPECTED_IDENTITY_LISTENER');}
 snapshot(){return {mode:'STANDALONE',legacyApplication:false,producers:this.#resources.producers.length,workers:this.#resources.workers.length,otherOwnerListeners:this.#resources.otherListeners.length,externalWorkers:'GLOBAL_PHASE_BARRIER'};}
}
/** Executable owner composition. All defaults below are concrete production implementations, never injected allow decisions. */
export async function startB2bIdentityHost(){
 if(process.env.B2B_IDENTITY_ENABLED!=='true')return null;
 const root=process.env.B2B_IDENTITY_CONFIG_ROOT;if(!root)throw Error('B2B_IDENTITY_CONFIG_ROOT_REQUIRED');
 let db:PrismaService|undefined,runtime:B2bIdentityOwnerRuntime|undefined;
 try{
  const files=new B2bRuntimeFiles(root),host=b2bIdentityHostConfig(files.metadata('identity-host.json')),loaded=readB2bIdentityRuntimeFiles(files);
  if(!loaded||!loaded.config.scopes.includes('b2b:identity:manage'))throw Error();
  const config=loaded.config,credentials=validateB2bIdentityRuntimeCredentials(loaded.credentials);
  checkB2bIdentityDatabaseEnvironment(host,root,process.env);
  const database=mountedB2bPostgres(files,host.database);
  db=new PrismaService(database);await db.$connect();
  const permissions=new UserPermissionsService(db),passwords=new PasswordService(),lifecycle=new B2bStandaloneIdentityLifecycle();
  const liveIdentity=new PostgresB2bLiveHumanIdentity(db,permissions,config.oidc.issuer);
  const authority=new OidcB2bPrivilegedHumanAuthority({provider:new HttpsOidcIntrospection(config.oidc.introspectionEndpoint,credentials.oidcBasicCredential,credentials.oidcTls),
   users:new PostgresLinkedUsers(db,permissions),live:liveIdentity,store:new PostgresB2bStore(db),issuer:config.oidc.issuer,
   clientId:host.privileged.clientId,acceptedAcr:config.oidc.acceptedAcr,policyRevision:host.privileged.policyRevision});
  const billingHttp=new B2bPrivateHttp(config.billingOrigin,credentials.billingTls),bindingOwner=new HttpB2bIdentityBindingOwner(billingHttp),privateModules=[],privateStorageChecks=[],privateModuleFactories=[];
  if(host.administrationPeers){
   const ownerPeers=Object.values(host.administrationPeers).flat();
   if(ownerPeers.some(p=>[...config.peers.token,...config.peers.admin,...config.peers.resource,...config.peers.operator].includes(p)))throw Error('DEDICATED_OWNER_AUTHORITY_PEERS_REQUIRED');
   const ownerAuthority=new OidcB2bPrivilegedHumanAuthority({provider:new HttpsOidcIntrospection(config.oidc.introspectionEndpoint,credentials.oidcBasicCredential,credentials.oidcTls),
    users:new PostgresLinkedUsers(db,permissions),live:liveIdentity,store:new PostgresB2bStore(db),issuer:config.oidc.issuer,clientId:host.privileged.clientId,
    acceptedAcr:config.oidc.acceptedAcr,policyRevision:host.privileged.policyRevision,actions:Object.keys(phase8AdminPolicy) as Phase8AdminAction[],allowedScopes:config.scopes});
   privateModules.push(B2bOwnerAdministrationModule.isolated(new B2bOwnerAdministration({enabled:true,peers:host.administrationPeers,authority:ownerAuthority,live:liveIdentity,bindings:bindingOwner,store:new PostgresB2bStore(db)})));
  }
  if(host.receivedApprovals){
   const peers=host.receivedApprovals;
   if([...peers.preparePeers,...peers.verifyPeers].some(peer=>config.peers.operator.includes(peer)))throw Error('DEDICATED_RECEIVED_APPROVAL_PEERS_REQUIRED');
   const approvals=createReceivedApprovalServer({enabled:true,db,permissions,catalogue:new B2bBindingCatalogueHttp(billingHttp),
    provider:new HttpsOidcIntrospection(config.oidc.introspectionEndpoint,credentials.oidcBasicCredential,credentials.oidcTls),issuer:config.oidc.issuer,
    clientId:peers.clientId,acceptedAcr:config.oidc.acceptedAcr,peers:{prepare:peers.preparePeers,verify:peers.verifyPeers}})!;
   privateModules.push(approvals.module);privateStorageChecks.push(()=>approvals.store.ready());
  }
  if(host.emailWorkerPeers){
   if(host.emailWorkerPeers.some(p=>[...config.peers.operator,...config.peers.token,...config.peers.resource,...config.peers.admin].includes(p))||
    !['b2b:email:send','b2b:documents:read'].every(s=>config.scopes.includes(s as any)))throw Error('DEDICATED_EMAIL_WORKER_POLICY_REQUIRED');
   privateModules.push(B2bQueuedEmailActorModule.isolated(new B2bQueuedEmailActor({enabled:true,allowedScopes:config.scopes,store:new PostgresB2bStore(db),
    users:new PostgresQueuedUsers(db,new PostgresLinkedUsers(db,permissions)),catalogue:new B2bBindingCatalogueHttp(billingHttp)}),host.emailWorkerPeers));
  }
  if(host.billingPermissionPeers){
   if(host.billingPermissionPeers.some(p=>[...config.peers.operator,...config.peers.token,...config.peers.resource,...config.peers.admin,...(host.emailWorkerPeers??[])].includes(p)))throw Error('DEDICATED_BILLING_PERMISSION_PEERS_REQUIRED');
   const database=db;
   privateModuleFactories.push((identity:B2bIdentity)=>B2bBillingCurrentAuthorityModule.isolated(new B2bBillingCurrentAuthority({enabled:true,identity,
    provider:new HttpsOidcIntrospection(config.oidc.introspectionEndpoint,credentials.oidcBasicCredential,credentials.oidcTls),users:new PostgresLinkedUsers(database,permissions),
    live:liveIdentity,store:new PostgresB2bStore(database),catalogue:new B2bBindingCatalogueHttp(billingHttp),issuer:config.oidc.issuer,
    clientId:host.privileged.clientId,acceptedAcr:config.oidc.acceptedAcr}),host.billingPermissionPeers!));
  }
  runtime=(await createB2bIdentityRuntime(config,{prisma:db,permissions,credentials,lifecycle,privateModules,privateStorageChecks,privateModuleFactories,privileged:{passwords,authority,liveIdentity,bindingOwner}}))!;
  if(!runtime||runtime.statusMetadata.capabilities.length!==6||!runtime.statusMetadata.capabilities.includes('PRIVILEGED_ADMIN'))throw Error();
  const addresses=await runtime.start(),owner=runtime;
  let stopping:Promise<void>|undefined;
  const detach=()=>{process.off('SIGTERM',signal);process.off('SIGINT',signal);};
  const shutdown=()=>stopping??=(async()=>{await stopB2bMaintenanceNode(owner.maintenance);await owner.close();detach();})();
  const signal=()=>{void shutdown().catch(()=>{process.stderr.write('B2B_IDENTITY_SHUTDOWN_BLOCKED\n');process.exitCode=1;});};
  process.once('SIGTERM',signal);process.once('SIGINT',signal);
  return {runtime:owner,addresses,lifecycle,shutdown};
 }catch{
  if(runtime){await runtime.close().catch(()=>{});}else if(db){await db.$disconnect().catch(()=>{});}
  throw Error('B2B_IDENTITY_HOST_STARTUP_BLOCKED');
 }
}
