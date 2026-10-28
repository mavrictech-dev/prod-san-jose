import 'reflect-metadata';
import {Module,type DynamicModule} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import type {NestExpressApplication} from '@nestjs/platform-express';
import {inspect} from 'node:util';
import type {AddressInfo} from 'node:net';
import {B2bPrivateHttp,B2bIdentityHttp} from '@factuez/service-access/dist/b2b';
import {B2bOwnerDrain} from '@factuez/service-access/dist/b2b-owner-drain';
import {B2bOwnerRuntimeStatus,B2bOwnerRuntimeStatusModule} from '@factuez/service-access/dist/b2b-runtime-status';
import {B2bMaintenanceNode} from '@factuez/service-access/dist/b2b-maintenance-node';
import type {ReceptionPrisma} from '../prisma.service';
import {ReceptionService} from '../reception.service';
import {ReceptionAutomationService} from '../automation/service';
import {PostgresReceivedReadStore,type ReceivedDatabase} from './store';
import {B2bReceptionReads,type ReceptionGrantAdministrator} from './read';
import {B2bReceptionReadModule,B2bReceptionHttpFilter} from './http';
import {B2bReceptionCommands} from './commands';
import {PostgresReceptionWriteAuthority} from './write-authority';
import {B2bReceptionCommandModule} from './command-http';
import {B2bReceptionAutomation,type ReceptionAutomationVault,type ReceptionAutomationUserAdministrator} from './automation';
import {PostgresReceptionAutomationAuthority} from './automation-authority';
import {B2bReceptionAutomationOwnerModule} from './automation-http';
import {validateB2bReceivedRuntimeConfig,validateB2bReceivedRuntimeCredentials,type B2bReceivedRuntimeConfig,type B2bReceivedRuntimeCredentials} from './runtime-config';
import {checkB2bReceivedRuntimeSchema} from './runtime-schema';
import type {B2bReceivedReadOnlyResources,B2bReceivedReadOnlyWorker} from './runtime-read-only';
export type {B2bReceivedRuntimeConfig,B2bReceivedRuntimeCredentials} from './runtime-config';

/** Supplied by the actual legacy composition, covering its HTTP requests,
 * schedulers and workers too. No no-op defaults or fabricated quiescence. */
export interface B2bReceivedLegacyLifecycle {
 pauseCommands():Promise<void>;drainCommands():Promise<void>;stopProducers():Promise<void>;
 stopWorkers():Promise<void>;drainMutations():Promise<void>;closeAdmission():Promise<void>;
 drainAll():Promise<void>;closeListeners():Promise<void>;
}
export interface B2bReceivedRuntimeDependencies {
 database:ReceivedDatabase&Pick<ReceptionPrisma,'$queryRawUnsafe'|'$executeRawUnsafe'|'$disconnect'>;
 /** Already constructed by legacy DI. Never convert SERVICE into a legacy user. */
 legacy:{reception:ReceptionService;automation:ReceptionAutomationService};
 identityHttp:B2bPrivateHttp;grantAdministrator:ReceptionGrantAdministrator;
 userAdministrator:ReceptionAutomationUserAdministrator;vault:ReceptionAutomationVault;
 credentials:B2bReceivedRuntimeCredentials;legacyLifecycle:B2bReceivedLegacyLifecycle;
 readOnly?:B2bReceivedReadOnlyResources;
}
@Module({})
class B2bReceivedRuntimeModule {
 static composite(imports:DynamicModule[]):DynamicModule{return {module:B2bReceivedRuntimeModule,imports};}
}
const paths=new Set(['/internal/b2b/received-read','/internal/b2b/received-command','/internal/b2b/received-automation','/internal/b2b/runtime-status']);
type Ports={api:AddressInfo|string|null;control:Awaited<ReturnType<B2bMaintenanceNode['listen']>>};
type Phase='ADMISSION'|'PRODUCERS'|'WORKERS'|'STORAGE';
export class B2bReceivedOwnerRuntime {
 #started=false;#terminal=false;#starting?:Promise<Ports>;#closing?:Promise<void>;
 constructor(private readonly config:B2bReceivedRuntimeConfig,private readonly credentials:B2bReceivedRuntimeCredentials,
  private readonly app:NestExpressApplication,readonly status:B2bOwnerRuntimeStatus,readonly maintenance:B2bMaintenanceNode,
  readonly drain:B2bOwnerDrain,private readonly hooks:Record<Phase,()=>Promise<void>>,private readonly startWorker:()=>Promise<boolean>){ }
 get application(){return this.app;}
 get bootId(){return this.status.bootId;}
 get statusMetadata(){return {owner:'received',deploymentId:this.config.deploymentId,instanceId:this.config.instanceId,bootId:this.bootId,capabilities:[...this.status.capabilities],readOnlyExecution:'EXPLICIT_START_ONLY',fiscalActivation:false};}
 start():Promise<Ports>{
  if(this.#started||this.#terminal||this.#closing||this.maintenance.snapshot().state!=='READY')return Promise.reject(Error('B2B_RECEIVED_RUNTIME_START_REJECTED'));
  this.#started=true;
  this.#starting=(async()=>{
   try{
    await this.status.inspect();
    // Both surfaces are explicit starts. Neither exists at factory return.
    await this.app.listen(this.config.api.port,this.config.api.host);
    const control=await this.maintenance.listen({...this.config.control,tls:this.credentials.controlTls,operatorPeers:[...this.config.peers.operator]});
    return {api:this.app.getHttpServer().address(),control};
   }catch{
    this.#terminal=true;await this.maintenance.closeListener().catch(()=>{});await this.app.close().catch(()=>{});
    throw Error('B2B_RECEIVED_RUNTIME_START_FAILED');
   }
  })();return this.#starting;
 }
 /** Private process API, never an HTTP route or a side effect of CONFIG_SAVE. */
 async startReadOnlyWorker(){
  if(!this.#started||this.#terminal||this.#closing||this.maintenance.snapshot().state!=='READY')throw Error('B2B_RECEIVED_READ_ONLY_START_REJECTED');
  await this.#starting;return this.startWorker();
 }
 /** Local ordered cleanup only. Does not issue a deployment/offline receipt. */
 close():Promise<void>{
  if(this.#closing)return this.#closing;
  if(this.maintenance.snapshot().state==='STOPPING')return Promise.reject(Error('B2B_RECEIVED_MAINTENANCE_IN_PROGRESS'));
  this.#terminal=true;
  this.#closing=(async()=>{
   await this.#starting?.catch(()=>{});
   for(const phase of ['ADMISSION','PRODUCERS','WORKERS','STORAGE'] as const)await this.hooks[phase]();
   await this.maintenance.closeListener();
  })();return this.#closing;
 }
 toJSON(){return this.statusMetadata;}[inspect.custom](){return this.statusMetadata;}
}

export async function createB2bReceivedRuntime(input?:B2bReceivedRuntimeConfig,deps?:B2bReceivedRuntimeDependencies):Promise<B2bReceivedOwnerRuntime|null>{
 if(input?.enabled!==true)return null;
 const config=validateB2bReceivedRuntimeConfig(input);
 if(!deps||typeof deps.database?.$transaction!=='function'||typeof deps.database.$queryRawUnsafe!=='function'||typeof deps.database.$executeRawUnsafe!=='function'||typeof deps.database.$disconnect!=='function'||
  !(deps.legacy?.reception instanceof ReceptionService)||!(deps.legacy.automation instanceof ReceptionAutomationService)||!(deps.identityHttp instanceof B2bPrivateHttp)||
  typeof deps.grantAdministrator?.authorize!=='function'||typeof deps.userAdministrator?.authorize!=='function'||typeof deps.vault?.seal!=='function'||typeof deps.vault.open!=='function'||
  !deps.legacyLifecycle||['pauseCommands','drainCommands','stopProducers','stopWorkers','drainMutations','closeAdmission','drainAll','closeListeners'].some(k=>typeof deps.legacyLifecycle[k as keyof B2bReceivedLegacyLifecycle]!=='function'))throw Error('B2B_RECEIVED_RUNTIME_DEPENDENCIES_REQUIRED');
 const credentials=validateB2bReceivedRuntimeCredentials(deps.credentials),db=deps.database,lifecycle=deps.legacyLifecycle;
 const drain=new B2bOwnerDrain({enabled:true,maxConcurrent:config.maxConcurrent??16});
 let closingStorage=false,storageClosed=false,workerAllowed=true,workerStart:Promise<boolean>|undefined,worker:B2bReceivedReadOnlyWorker|undefined;
 const checks=new Set<Promise<void>>();
 const check=()=>{
  if(closingStorage||storageClosed)return Promise.reject(Error('B2B_RECEIVED_RUNTIME_STORAGE_CLOSED'));
  const task=checkB2bReceivedRuntimeSchema(db);checks.add(task);void task.then(()=>checks.delete(task),()=>checks.delete(task));return task;
 };
 await check();
 const identity=new B2bIdentityHttp(deps.identityHttp),writeAuthority=new PostgresReceptionWriteAuthority(db,deps.grantAdministrator),automationAuthority=new PostgresReceptionAutomationAuthority(db,deps.grantAdministrator);
 const reads=new B2bReceptionReads(new PostgresReceivedReadStore(db),identity,deps.grantAdministrator);
 const commands=new B2bReceptionCommands(db,identity,writeAuthority);
 const automation=new B2bReceptionAutomation(db,identity,automationAuthority,{vault:deps.vault,userAdministrator:deps.userAdministrator,
  networkProfile:config.automation?.networkProfile??'LOCAL_ONLY',localFixtureEnabled:false,approvedImapHosts:config.automation?.approvedImapHosts??[]});
 const status=new B2bOwnerRuntimeStatus('received',config.deploymentId,Object.freeze(['READ','COMMANDS','AUTOMATION']),check),peers=config.peers.resource;
 const httpsOptions={...credentials.apiTls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const,maxHeaderSize:8192};
 const app=await NestFactory.create<NestExpressApplication>(B2bReceivedRuntimeModule.composite([
  B2bReceptionReadModule.isolated(reads,peers),B2bReceptionCommandModule.isolated(commands,peers),
  B2bReceptionAutomationOwnerModule.isolated(automation,peers),B2bOwnerRuntimeStatusModule.isolated(status,peers),
 ]),{logger:false,abortOnError:false,bodyParser:false,httpsOptions});
 drain.install(app); // Must precede body parsing, init and listen.
 app.use((req:any,res:any,next:()=>void)=>{
  const names=req.rawHeaders.filter((_v:string,i:number)=>i%2===0).map((v:string)=>v.toLowerCase());
  const length=req.headers['content-length'];
  if(req.method!=='POST'||!paths.has(req.url)||new Set(names).size!==names.length||req.headers['transfer-encoding']||!/^application\/json(?:;|$)/.test(req.headers['content-type']??'')||typeof length!=='string'||!/^\d{1,6}$/.test(length))return res.status(400).json({code:'INVALID_RECEIVED_REQUEST'});
  if(Number(length)>131072)return res.status(413).json({code:'NARROW_QUERY'});next();
 });
 app.useBodyParser('json',{limit:131072,strict:true});
 app.use((error:unknown,_req:unknown,res:any,_next:unknown)=>{res.setHeader('Cache-Control','private, no-store');res.status((error as {status?:number})?.status===413?413:400).json({code:'INVALID_RECEIVED_REQUEST'});});
 app.useGlobalFilters(new B2bReceptionHttpFilter());
 const server=app.getHttpServer();server.headersTimeout=10000;server.requestTimeout=60000;server.keepAliveTimeout=1000;server.maxConnections=64;
 const wait=async(which:'COMMANDS'|'MUTATIONS'|'ALL')=>{while((await drain.drain(which,30000)).state!=='DRAINED'){/* pending work keeps its slot, including aborted clients */}};
 const once=(fn:()=>Promise<void>)=>{let pending:Promise<void>|undefined;return ()=>pending??=(async()=>{try{await fn();}catch{throw Error('B2B_RECEIVED_RUNTIME_PHASE_FAILED');}})();};
 const hooks:Record<Phase,()=>Promise<void>>={
  ADMISSION:once(async()=>{workerAllowed=false;drain.pauseCommands();await lifecycle.pauseCommands();await Promise.all([wait('COMMANDS'),lifecycle.drainCommands()]);}),
  PRODUCERS:once(async()=>{await workerStart;await Promise.all([worker?.pauseProducers(),lifecycle.stopProducers()]);}),
  WORKERS:once(async()=>{await Promise.all([worker?.close(),lifecycle.stopWorkers()]);await Promise.all([wait('MUTATIONS'),lifecycle.drainMutations()]);}),
  STORAGE:once(async()=>{
   closingStorage=true;drain.closeAdmission();await lifecycle.closeAdmission();await Promise.all([wait('ALL'),lifecycle.drainAll()]);
   while(checks.size)await Promise.allSettled([...checks]);
   await lifecycle.closeListeners();await app.close();await db.$disconnect();storageClosed=true;
  }),
 };
 const node=new B2bMaintenanceNode({enabled:true,deploymentId:config.deploymentId,instance:{service:'RECEIVED',instanceId:config.instanceId,bootId:status.bootId},hooks});
 const startWorker=():Promise<boolean>=>{
  if(!workerAllowed)return Promise.reject(Error('B2B_RECEIVED_READ_ONLY_START_REJECTED'));
  if(config.readOnlyExecution?.enabled!==true)return Promise.resolve(false);
  if(workerStart)return workerStart;
  if(!deps.readOnly)return Promise.reject(Error('B2B_RECEIVED_READ_ONLY_RESOURCES_REQUIRED'));
  workerStart=(async()=>{
   const {startB2bReceivedReadOnlyWorker}=await import('./runtime-read-only');
   const owned=await startB2bReceivedReadOnlyWorker({database:db,identity,automationAuthority,writeAuthority,vault:deps.vault,resources:deps.readOnly!},config.readOnlyExecution);
   if(!owned)throw Error('B2B_RECEIVED_READ_ONLY_START_BLOCKED');worker=owned;return true;
  })();return workerStart;
 };
 return new B2bReceivedOwnerRuntime(config,credentials,app,status,node,drain,hooks,startWorker);
}
