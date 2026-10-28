import 'reflect-metadata';
import {Module,type DynamicModule} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import type {NestExpressApplication} from '@nestjs/platform-express';
import {inspect} from 'node:util';
import {B2bIdentityHttp,B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {B2bOwnerDrain} from '@factuez/service-access/dist/b2b-owner-drain';
import {B2bOwnerRuntimeStatus,B2bOwnerRuntimeStatusModule} from '@factuez/service-access/dist/b2b-runtime-status';
import {B2bMaintenanceNode,stopB2bMaintenanceNode} from '@factuez/service-access/dist/b2b-maintenance-node';
import {HistoryArchiveRepository} from '../repository';
import {SyntheticB2bHistoryArchive} from './synthetic-archive';
import {B2bHistoryReads} from './reader';
import {B2bHistoryOwnerModule,B2bHistoryOwnerFilter} from './http';
import {historyRuntimeConfig,historyRuntimeTls,type B2bHistoryRuntimeConfig,type B2bHistoryRuntimeCredentials} from './runtime-config';
import {historyRuntimeStorage} from './runtime-storage';
import {checkB2bHistoryRuntimeSchema,type HistoryRuntimeDatabase} from './runtime-schema';
import {PostgresB2bHistoryArchivePermission} from './runtime-enrollment';
export type {B2bHistoryRuntimeConfig,B2bHistoryRuntimeCredentials} from './runtime-config';
export interface B2bHistoryRuntimeDependencies {database:HistoryRuntimeDatabase;identityHttp:B2bPrivateHttp;credentials:B2bHistoryRuntimeCredentials}
@Module({})
class B2bHistoryRuntimeModule {static composite(imports:DynamicModule[]):DynamicModule{return {module:B2bHistoryRuntimeModule,imports};}}
export class B2bHistoryOwnerRuntime {
 #started=false;#starting?:Promise<{api:any;control:any}>;#closing?:Promise<void>;#terminal=false;
 constructor(private readonly app:NestExpressApplication,private readonly config:B2bHistoryRuntimeConfig,private readonly credentials:B2bHistoryRuntimeCredentials,
  readonly status:B2bOwnerRuntimeStatus,readonly maintenance:B2bMaintenanceNode,readonly drain:B2bOwnerDrain){}
 get application(){return this.app;}
 get bootId(){return this.status.bootId;}
 toJSON(){return {owner:'history',environment:'BETA',datasetClass:'SYNTHETIC',capabilities:['READ'],deploymentId:this.config.deploymentId,instanceId:this.config.instanceId,bootId:this.bootId,readOnly:true,fiscalActivation:false};}
 [inspect.custom](){return this.toJSON();}
 start(){
  if(this.#started||this.#terminal||this.#closing||this.maintenance.snapshot().state!=='READY')return Promise.reject(Error('B2B_HISTORY_RUNTIME_START_REJECTED'));
  this.#started=true;
  this.#starting=(async()=>{
   try{
    await this.status.inspect();await this.app.listen(this.config.api.port,this.config.api.host);
    const control=await this.maintenance.listen({...this.config.control,tls:this.credentials.controlTls,operatorPeers:[...this.config.peers.operator]});
    return {api:this.app.getHttpServer().address(),control};
   }catch{this.#terminal=true;await stopB2bMaintenanceNode(this.maintenance);throw Error('B2B_HISTORY_RUNTIME_START_BLOCKED');}
  })();return this.#starting;
 }
 /** Local cleanup reuses an active coordinator run; no forced SQL cancellation
  * or independent/global writers-offline assertion. */
 close(){
  if(this.#closing)return this.#closing;this.#terminal=true;
  this.#closing=(async()=>{await this.#starting?.catch(()=>{});await stopB2bMaintenanceNode(this.maintenance);})();return this.#closing;
 }
}
export async function createB2bHistoryRuntime(input?:B2bHistoryRuntimeConfig,deps?:B2bHistoryRuntimeDependencies):Promise<B2bHistoryOwnerRuntime|null>{
 if(input?.enabled!==true)return null;
 const config=historyRuntimeConfig(input);
 if(!deps||typeof deps.database?.$transaction!=='function'||typeof deps.database.$disconnect!=='function'||!(deps.identityHttp instanceof B2bPrivateHttp))throw Error('B2B_HISTORY_RUNTIME_DEPENDENCIES_REQUIRED');
 const credentials={apiTls:historyRuntimeTls(deps.credentials?.apiTls),controlTls:historyRuntimeTls(deps.credentials?.controlTls)},db=deps.database;
 const storage=historyRuntimeStorage(config),drain=new B2bOwnerDrain({enabled:true,maxConcurrent:config.maxConcurrent??16});
 let closing=false,storageClosed=false;const checks=new Set<Promise<void>>();
 const check=()=>{
  if(closing||storageClosed)return Promise.reject(Error('B2B_HISTORY_RUNTIME_STORAGE_CLOSED'));
  const task=(async()=>{storage.check();await checkB2bHistoryRuntimeSchema(db,config);storage.check();})();checks.add(task);void task.then(()=>checks.delete(task),()=>checks.delete(task));return task;
 };
 await check();
 const repository=new HistoryArchiveRepository(db,{databaseName:config.database.name,markerId:config.markerId},'READ_ONLY');
 const enrollment=new PostgresB2bHistoryArchivePermission(db,config),archive=new SyntheticB2bHistoryArchive(repository,storage.store,enrollment);
 const reader=new B2bHistoryReads(new B2bIdentityHttp(deps.identityHttp),archive,{enabled:true,environment:'BETA',datasetClass:'SYNTHETIC'});
 const status=new B2bOwnerRuntimeStatus('history',config.deploymentId,Object.freeze(['READ']),check);
 const httpsOptions={...credentials.apiTls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const,maxHeaderSize:8192};
 const app=await NestFactory.create<NestExpressApplication>(B2bHistoryRuntimeModule.composite([
  B2bHistoryOwnerModule.isolated(reader,config.peers.resource),B2bOwnerRuntimeStatusModule.isolated(status,config.peers.resource),
 ]),{logger:false,abortOnError:false,bodyParser:false,httpsOptions});
 drain.install(app); // Before init/listen, including parser and socket failures.
 app.use((req:any,res:any,next:()=>void)=>{
  const names=req.rawHeaders.filter((_v:string,i:number)=>i%2===0).map((v:string)=>v.toLowerCase()),size=req.headers['content-length'];
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='POST'||!['/internal/b2b/history-read','/internal/b2b/runtime-status'].includes(req.url)||new Set(names).size!==names.length||req.headers['transfer-encoding']||!/^application\/json(?:;|$)/.test(req.headers['content-type']??'')||typeof size!=='string'||!/^\d{1,6}$/.test(size))return res.status(400).json({code:'INVALID_HISTORY_REQUEST'});
  if(Number(size)>16384)return res.status(413).json({code:'NARROW_QUERY'});next();
 });
 app.useBodyParser('json',{limit:16384,strict:true});
 app.use((_error:unknown,_req:unknown,res:any,_next:unknown)=>res.status(400).json({code:'INVALID_HISTORY_REQUEST'}));
 app.useGlobalFilters(new B2bHistoryOwnerFilter());
 const server=app.getHttpServer();server.headersTimeout=10000;server.requestTimeout=60000;server.keepAliveTimeout=1000;server.maxConnections=64;
 const wait=async(which:'COMMANDS'|'MUTATIONS'|'ALL')=>{while((await drain.drain(which,30000)).state!=='DRAINED'){/* disconnected clients retain their SQL slot */}};
 const maintenance=new B2bMaintenanceNode({enabled:true,deploymentId:config.deploymentId,instance:{service:'HISTORY',instanceId:config.instanceId,bootId:status.bootId},hooks:{
  ADMISSION:async()=>{drain.pauseCommands();await wait('COMMANDS');},
  PRODUCERS:async()=>{/* This read-only host owns no publisher, scheduler, importer or queue. */},
  WORKERS:async()=>{await wait('MUTATIONS');},
  STORAGE:async()=>{closing=true;drain.closeAdmission();await wait('ALL');while(checks.size)await Promise.allSettled([...checks]);await app.close();await db.$disconnect();storageClosed=true;},
 }});
 return new B2bHistoryOwnerRuntime(app,config,credentials,status,maintenance,drain);
}
