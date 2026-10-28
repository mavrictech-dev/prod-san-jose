import 'reflect-metadata';
import {Module,type DynamicModule} from '@nestjs/common';
import type {NestExpressApplication} from '@nestjs/platform-express';
import {randomUUID} from 'node:crypto';
import {B2bPrivateHttp,B2bBindingCatalogueHttp,B2bCorrectionCatalogueHttp,B2bGuideCatalogueHttp} from '@factuez/service-access/dist/b2b';
import {B2bOwnerRuntimeStatus,B2bOwnerRuntimeStatusModule} from '@factuez/service-access/dist/b2b-runtime-status';
import {B2bMaintenanceNode} from '@factuez/service-access/dist/b2b-maintenance-node';
import {B2bOwnerDrain} from '@factuez/service-access/dist/b2b-owner-drain';
import {Phase8AdminOwnerModule} from '@factuez/service-access/dist/b2b-phase8-admin-http';
import {Phase8AdminCapabilities,type PrivilegedHumanAuthority,type Phase8LiveHumanIdentity,type Phase8AdminBindingOwner} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import type {PrismaService} from '../infrastructure/prisma.service';
import type {PasswordService} from '../application/password.service';
import type {UserPermissionsService} from '../application/user-permissions.service';
import {UserAdministrationService} from '../application/user-administration.service';
import {createB2bIdentityApplication} from './application';
import {PostgresB2bStore} from './postgres-store';
import {B2bTokenCodec} from './token';
import {B2bIdentity} from './service';
import {OidcB2bAdministrator,PostgresOidcAdminDirectory} from './oidc-admin';
import {HttpsOidcIntrospection,OidcDelegationVerifier} from './oidc';
import {PostgresLinkedUsers} from './users';
import {B2bWebhookAuthority,B2bWebhookAuthorityModule,PostgresQueuedUsers} from './webhook-authority';
import {PostgresB2bCorrectionStore} from './correction-store';
import {B2bCorrectionAuthority} from './correction-authority';
import {B2bCorrectionAuthorityModule} from './correction-http';
import {PostgresB2bGuideStore} from './guide-store';
import {B2bGuideAuthority} from './guide-authority';
import {B2bGuideAuthorityModule} from './guide-http';
import {PostgresB2bGuideIssueStore} from './guide-issue-store';
import {B2bGuideIssueAuthority} from './guide-issue-authority';
import {B2bGuideIssueAuthorityModule} from './guide-issue-http';
import {HttpGuideIssueCatalogue} from './guide-issue-catalogue';
import {B2bPhase8IdentityAdmin} from './phase8-admin';
import {validateB2bIdentityRuntimeConfig,validateB2bIdentityRuntimeCredentials,type B2bIdentityRuntimeConfig,type B2bIdentityRuntimeCredentials} from './runtime-config';
import {checkB2bIdentityRuntimeSchema} from './runtime-schema';
export type {B2bIdentityRuntimeConfig,B2bIdentityRuntimeCredentials} from './runtime-config';

export interface B2bIdentityRuntimePrivileged {
 passwords:PasswordService;authority:PrivilegedHumanAuthority;liveIdentity:Phase8LiveHumanIdentity;bindingOwner:Phase8AdminBindingOwner;
}
export interface B2bIdentityRuntimeDependencies {
 /** Already constructed/owned by the Identity composition; no new Prisma or Auth is created here. */
 prisma:PrismaService;permissions:Pick<UserPermissionsService,'effective'>;credentials:B2bIdentityRuntimeCredentials;
 privileged?:B2bIdentityRuntimePrivileged;
 /** Statically assembled private owner modules only; never resolved from files or user JSON. */
 privateModules?:readonly DynamicModule[];
 /** Code-owned assembly only; no request/config module loading. */
 privateModuleFactories?:readonly ((identity:B2bIdentity)=>DynamicModule)[];
 privateStorageChecks?:readonly (()=>Promise<void>)[];
 lifecycle:{stopProducers():Promise<void>;stopWorkers():Promise<void>;waitForDependentWorkers():Promise<void>;closeOtherOwnerListeners():Promise<void>};
}
const unavailable=()=>Error('B2B_IDENTITY_RUNTIME_DEPENDENCIES_REQUIRED');
@Module({})
export class B2bIdentityRuntimeModule {
 static composite(imports:DynamicModule[]):DynamicModule {
  return {module:B2bIdentityRuntimeModule,imports};
 }
}
export class B2bIdentityOwnerRuntime {
 #app:NestExpressApplication;#config:B2bIdentityRuntimeConfig;#credentials:B2bIdentityRuntimeCredentials;#node:B2bMaintenanceNode;#status:B2bOwnerRuntimeStatus;
 #close:()=>Promise<void>;#started=false;#terminal=false;
 constructor(app:NestExpressApplication,config:B2bIdentityRuntimeConfig,credentials:B2bIdentityRuntimeCredentials,node:B2bMaintenanceNode,status:B2bOwnerRuntimeStatus,close:()=>Promise<void>){
  this.#app=app;this.#config=config;this.#credentials=credentials;this.#node=node;this.#status=status;this.#close=close;
 }
 get application(){return this.#app;}
 get maintenance(){return this.#node;}
 get status(){return this.#status;}
 get bootId(){return this.#status.bootId;}
 get statusMetadata(){return {owner:'identity',deploymentId:this.#config.deploymentId,instanceId:this.#config.instanceId,bootId:this.bootId,capabilities:[...this.#status.capabilities]};}
 async start(){
  if(this.#started||this.#terminal||this.#node.snapshot().state!=='READY')throw Error('B2B_IDENTITY_RUNTIME_START_REJECTED');
  this.#started=true;
  try{
   await this.#status.inspect();if(this.#terminal||this.#node.snapshot().state!=='READY')throw Error();
   await this.#app.listen(this.#config.api.port,this.#config.api.host);
   if(this.#terminal||this.#node.snapshot().state!=='READY')throw Error();
   const control=await this.#node.listen({...this.#config.control,tls:this.#credentials.controlTls,operatorPeers:this.#config.peers.operator});
   if(this.#terminal||this.#node.snapshot().state!=='READY')throw Error();
   return {api:this.#app.getHttpServer().address(),control};
  }catch{this.#terminal=true;await this.#node.closeListener().catch(()=>{});await this.#app.close().catch(()=>{});throw Error('B2B_IDENTITY_RUNTIME_START_FAILED');}
 }
 /** Explicit process termination also closes the operator listener; STORAGE alone keeps it PARKED. */
 async close(){this.#terminal=true;await this.#node.closeListener();await this.#close();}
 toJSON(){return this.statusMetadata;}
}
/** Opt-in assembly. Disabled calls inspect no credentials, dependencies, mounted files or environment. */
export async function createB2bIdentityRuntime(input?:B2bIdentityRuntimeConfig,deps?:B2bIdentityRuntimeDependencies):Promise<B2bIdentityOwnerRuntime|null>{
 if(input?.enabled!==true)return null;
 const config=validateB2bIdentityRuntimeConfig(input);
 if(!deps||typeof deps.prisma?.$transaction!=='function'||typeof deps.prisma.$queryRawUnsafe!=='function'||typeof deps.prisma.$executeRawUnsafe!=='function'||
   typeof deps.prisma.$disconnect!=='function'||!deps.prisma.user||typeof deps.permissions?.effective!=='function'||
   typeof deps.lifecycle?.waitForDependentWorkers!=='function'||typeof deps.lifecycle.closeOtherOwnerListeners!=='function'||typeof deps.lifecycle.stopProducers!=='function'||typeof deps.lifecycle.stopWorkers!=='function')throw unavailable();
 const privileged=deps.privileged;
 if(privileged&&(typeof privileged.passwords?.hash!=='function'||typeof privileged.authority?.authorize!=='function'||typeof privileged.liveIdentity?.current!=='function'||typeof privileged.bindingOwner?.revalidate!=='function'))throw unavailable();
 const credentials=validateB2bIdentityRuntimeCredentials(deps.credentials),db=deps.prisma,drain=new B2bOwnerDrain({enabled:true,maxConcurrent:16});
 let storageClosed=false,app:NestExpressApplication|undefined;
 if(deps.privateStorageChecks&&(!Array.isArray(deps.privateStorageChecks)||deps.privateStorageChecks.length>4||deps.privateStorageChecks.some(fn=>typeof fn!=='function')))throw unavailable();
 const check=async()=>{if(storageClosed||drain.snapshot().state==='CLOSED')throw Error('B2B_IDENTITY_RUNTIME_STORAGE_CLOSED');await checkB2bIdentityRuntimeSchema(db);for(const inspect of deps.privateStorageChecks??[])await inspect();};
 await check();
 const provider=new HttpsOidcIntrospection(config.oidc.introspectionEndpoint,credentials.oidcBasicCredential,credentials.oidcTls);
 const admin=new OidcB2bAdministrator({issuer:config.oidc.issuer,clientId:config.oidc.adminClientId,acceptedAcr:config.oidc.acceptedAcr,provider,
  directory:new PostgresOidcAdminDirectory(db,deps.permissions),enabled:true});
 const linkedUsers=new PostgresLinkedUsers(db,deps.permissions),queuedUsers=new PostgresQueuedUsers(db,linkedUsers);
 const codec=new B2bTokenCodec(credentials.signingKey,config.tokenIssuer,()=>Math.floor(Date.now()/1000),{human:credentials.humanPublicKey,integration:credentials.integrationPublicKey,tls:credentials.apiTls.cert});
 const billing=new B2bPrivateHttp(config.billingOrigin,credentials.billingTls),catalogue=new B2bBindingCatalogueHttp(billing),store=new PostgresB2bStore(db);
 const identity=new B2bIdentity(store,codec,credentials.pepper,admin,catalogue,new OidcDelegationVerifier(config.oidc.issuer,provider,linkedUsers),Date.now,config.scopes);
 const p=config.peers,capabilities=['IDENTITY','APPLICATION_ADMIN','CORRECTION_AUTHORITY','GUIDE_AUTHORITY','WEBHOOK_AUTHORITY'];
 const imports:DynamicModule[]=[
  B2bCorrectionAuthorityModule.isolated(new B2bCorrectionAuthority(new PostgresB2bCorrectionStore(db),identity,new B2bCorrectionCatalogueHttp(billing),admin,queuedUsers),{admin:p.admin,owner:p.correctionOwner}),
  B2bGuideAuthorityModule.isolated(new B2bGuideAuthority(new PostgresB2bGuideStore(db),identity,new B2bGuideCatalogueHttp(billing),admin,queuedUsers),{admin:p.admin,owner:p.guideOwner}),
  B2bGuideIssueAuthorityModule.isolated(new B2bGuideIssueAuthority(new PostgresB2bGuideIssueStore(db),identity,new HttpGuideIssueCatalogue(billing),admin,queuedUsers),{admin:p.admin,owner:p.guideIssueOwner}),
  B2bWebhookAuthorityModule.isolated(new B2bWebhookAuthority(store,catalogue,queuedUsers),p.webhook),
 ];
 if(deps.privateModules){if(!Array.isArray(deps.privateModules)||deps.privateModules.length>4||deps.privateModules.some(m=>!m||typeof m.module!=='function'))throw unavailable();imports.push(...deps.privateModules);}
 if(deps.privateModuleFactories){
  if(!Array.isArray(deps.privateModuleFactories)||deps.privateModuleFactories.length>2||deps.privateModuleFactories.some(f=>typeof f!=='function'))throw unavailable();
  for(const factory of deps.privateModuleFactories){const module=factory(identity);if(!module||typeof module.module!=='function')throw unavailable();imports.push(module);}
 }
 if(privileged){
  const caps=new Phase8AdminCapabilities(),owner=UserAdministrationService.createWithOwnerResources(db,privileged.passwords,caps);
  const bridge=new B2bPhase8IdentityAdmin({identity:{authenticate:(token,required,kind)=>identity.authenticate(token,required,{requestId:randomUUID(),peer:'identity-owner-private'},kind)},
   authority:privileged.authority,liveIdentity:privileged.liveIdentity,bindingOwner:privileged.bindingOwner,enabled:true},owner,caps);
  imports.push(Phase8AdminOwnerModule.isolated(bridge,['USERS_LIST','USERS_CREATE','USERS_UPDATE','ROLES_LIST','ROLES_UPDATE'],p.resource));capabilities.push('PRIVILEGED_ADMIN');
 }
 const status=new B2bOwnerRuntimeStatus('identity',config.deploymentId,Object.freeze([...capabilities]),check);
 imports.push(B2bOwnerRuntimeStatusModule.isolated(status,p.resource));
 app=await createB2bIdentityApplication(identity,{token:p.token,admin:p.admin,resource:p.resource},credentials.apiTls,B2bIdentityRuntimeModule.composite(imports));
 drain.install(app); // Before any app.init/listen.
 const ensureDrained=async(which:'COMMANDS'|'MUTATIONS'|'ALL')=>{const result=await drain.drain(which);if(result.state!=='DRAINED'||result.pending!==0)throw Error('B2B_IDENTITY_RUNTIME_WORK_PENDING');};
 const closeStorage=async()=>{
  if(storageClosed)return;drain.closeAdmission();await ensureDrained('ALL');
  await deps.lifecycle.closeOtherOwnerListeners();await app!.close();await db.$disconnect();storageClosed=true;
 };
 const node=new B2bMaintenanceNode({enabled:true,deploymentId:config.deploymentId,instance:{service:'IDENTITY',instanceId:config.instanceId,bootId:status.bootId},hooks:{
  ADMISSION:async()=>{drain.pauseCommands();await ensureDrained('COMMANDS');},
  PRODUCERS:async()=>{await deps.lifecycle.stopProducers();},
  WORKERS:async()=>{await deps.lifecycle.stopWorkers();await deps.lifecycle.waitForDependentWorkers();await ensureDrained('MUTATIONS');},
  STORAGE:closeStorage,
 }});
 return new B2bIdentityOwnerRuntime(app,config,credentials,node,status,closeStorage);
}
