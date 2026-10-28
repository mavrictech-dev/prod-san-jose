import 'reflect-metadata';
import {Controller,Inject,Module,Post,Req,Res,type DynamicModule} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import type {NestExpressApplication} from '@nestjs/platform-express';
import {inspect} from 'node:util';
import {B2bIdentityHttp,B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {HttpB2bEmailActor} from '@factuez/service-access/dist/b2b-email-actor';
import {B2bOwnerDrain} from '@factuez/service-access/dist/b2b-owner-drain';
import {B2bOwnerRuntimeStatus,B2bOwnerRuntimeStatusModule} from '@factuez/service-access/dist/b2b-runtime-status';
import {B2bMaintenanceNode,stopB2bMaintenanceNode} from '@factuez/service-access/dist/b2b-maintenance-node';
import {Phase8AdminCapabilities} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import {Phase8AdminOwnerModule} from '@factuez/service-access/dist/b2b-phase8-admin-http';
import type {SmtpConfigurationService} from '../smtp-configuration.service';
import {createMailerHostAdministration} from './host-administration';
import {B2bPhase8SmtpAdmin} from './phase8-admin';
import {B2bEmailDeliveries} from './email-deliveries';
import {NodemailerCorporateEmailTransport,type CorporateEmailDependencies} from './email-deliveries.corporate';
import {PostgresEmailDeliveryStore,type EmailDeliveryPgPool} from './email-deliveries.store';
import {OwnerEmailDeliveryDocumentSource,type EmailDeliveryArtifactOwner} from './email-deliveries.source';
import type {EmailDeliveryDocumentSource} from './email-deliveries.types';
import {NodemailerLocalEmailCapture} from './email-deliveries.capture';
import {createB2bEmailDeliveriesHandler} from './email-deliveries.http';
import {B2bMailerFileCapture} from './runtime-capture';
import {B2bMailerDispatcher} from './runtime-dispatcher';
import {mailerRuntimeConfig,mailerRuntimeTls,type B2bMailerRuntimeConfig,type MailerRuntimeTls} from './runtime-config';
import {checkB2bMailerRuntimeSchema} from './runtime-schema';
export type {B2bMailerRuntimeConfig} from './runtime-config';
/** Actual host-owned SMTP store/vault/policy. Factory binds THIS request capability.
 * No pre-authorized service, fake ready callback or unowned resource default.
 * Legacy store is QA-only; this contract deliberately does not relabel it BETA. */
export interface MailerSmtpOwnerResource {
 createOwner(capabilities:Phase8AdminCapabilities):SmtpConfigurationService;
 checkStorage():Promise<void>;close():Promise<void>;
}
export interface MailerHostPorts {
 emailArtifacts?:EmailDeliveryArtifactOwner;
 /** Direct concrete source; mutually exclusive with the legacy owner port. */
 emailSource?:(EmailDeliveryDocumentSource&{close?():void|Promise<void>});
 smtpOwner?:MailerSmtpOwnerResource;
 /** Host-owned read-only SMTP configuration, vault and current send permission. */
 corporateOwner?:CorporateEmailDependencies & {checkStorage():Promise<void>};
}
export interface B2bMailerRuntimeDependencies extends MailerHostPorts {
 pool:EmailDeliveryPgPool;identityHttp:B2bPrivateHttp;billingHttp:B2bPrivateHttp;
 /** Dedicated Identity owner-authority certificate, separate from resource/introspection identity. */
 authorityHttp?:B2bPrivateHttp;workerIdentityHttp?:B2bPrivateHttp;credentials:{apiTls:MailerRuntimeTls;controlTls:MailerRuntimeTls};
}
export function requireMailerHostPorts(ports:MailerHostPorts|undefined,config?:B2bMailerRuntimeConfig):asserts ports is MailerHostPorts {
 if(!ports||!!ports.emailArtifacts===!!ports.emailSource||
  (ports.emailSource?typeof ports.emailSource.authorizeDocumentCurrent!=='function':
   ['authorizeDocumentCurrent','currentPdf','readOriginal'].some(k=>typeof (ports.emailArtifacts as any)?.[k]!=='function')))throw Error('B2B_MAILER_EMAIL_ARTIFACTS_CONTRACT_REQUIRED');
 if(config?.profile==='CORPORATE'&&(!ports.corporateOwner||typeof ports.corporateOwner.permission?.authorizeRealSendCurrent!=='function'||typeof ports.corporateOwner.configurations?.read!=='function'||typeof ports.corporateOwner.vault?.open!=='function'||typeof ports.corporateOwner.checkStorage!=='function'))throw Error('B2B_MAILER_CORPORATE_OWNER_RESOURCE_REQUIRED');
 if(config?.smtpAdministration&&['createOwner','checkStorage','close'].some(k=>typeof (ports.smtpOwner as any)?.[k]!=='function'))throw Error('B2B_MAILER_SMTP_OWNER_RESOURCE_REQUIRED');
}
/** Read-only corporate candidate readiness. No DDL, migration or database selection. */
export async function checkCorporateSchema(pool:EmailDeliveryPgPool):Promise<void>{
 let db:Awaited<ReturnType<EmailDeliveryPgPool['connect']>>|undefined,broken:Error|undefined;
 try{
  db=await pool.connect();await db.query('BEGIN READ ONLY');await db.query("SET LOCAL statement_timeout = '10s'");
  const marker=await db.query<{version:string}>('SELECT version FROM "B2bCorporateEmailDeliverySandbox" WHERE singleton=true');
  if(marker.rows.length!==1||marker.rows[0].version!=='factuez.b2b.email-deliveries.corporate.v1')throw Error();
  for(const sql of ['SELECT id,actor_key,key_hash,revision,state,payload FROM "B2bCorporateEmailDeliveryJob" WHERE false','SELECT id,job_id,revision,event_type,attempt_id,payload FROM "B2bCorporateEmailDeliveryEvent" WHERE false'])
   if((await db.query(sql)).rows.length)throw Error();
  const t=await db.query<{name:string;enabled:boolean}>(`SELECT t.tgname AS name,t.tgenabled IN ('O','A') AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND ((c.relname='B2bCorporateEmailDeliveryJob' AND t.tgname IN ('b2b_corporate_email_job_immutable','b2b_corporate_email_job_audit')) OR (c.relname='B2bCorporateEmailDeliveryEvent' AND t.tgname='b2b_corporate_email_event_immutable'))`);
  if(t.rows.length!==3||t.rows.some(x=>!x.enabled)||new Set(t.rows.map(x=>x.name)).size!==3)throw Error();
  const indexes=await db.query<{ok:boolean}>(`SELECT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_class tbl ON tbl.oid=i.indrelid JOIN pg_namespace n ON n.oid=tbl.relnamespace WHERE n.nspname='public' AND tbl.relname='B2bCorporateEmailDeliveryEvent' AND idx.relname='B2bCorporateEmailDelivery_one_attempt' AND i.indisunique AND i.indisvalid AND i.indisready AND pg_get_indexdef(i.indexrelid) LIKE '%(job_id)%' AND pg_get_expr(i.indpred,i.indrelid) = '(event_type = ''ATTEMPT_STARTED''::text)') AS ok`);
  if(indexes.rows.length!==1||indexes.rows[0].ok!==true)throw Error();
  await db.query('COMMIT');
 }catch{
  if(db)try{await db.query('ROLLBACK');}catch{broken=Error('B2B_MAILER_SCHEMA_ROLLBACK_FAILED');}
  throw Error('B2B_MAILER_CORPORATE_STORAGE_NOT_READY');
 }finally{db?.release(broken);}
}
const HANDLER=Symbol('Private Mailer handler');
@Controller('internal/b2b')
class MailerRuntimeController {
 constructor(@Inject(HANDLER)private readonly handle:ReturnType<typeof createB2bEmailDeliveriesHandler>){}
 @Post('email-deliveries')async execute(@Req()req:any,@Res()res:any){await this.handle(req,res);}
}
@Module({})
class B2bMailerRuntimeModule {
 static assembled(imports:DynamicModule[],handler:ReturnType<typeof createB2bEmailDeliveriesHandler>):DynamicModule{
  return {module:B2bMailerRuntimeModule,imports,controllers:[MailerRuntimeController],providers:[{provide:HANDLER,useValue:handler}]};
 }
}
export class B2bMailerOwnerRuntime {
 #started=false;#terminal=false;#starting?:Promise<any>;#closing?:Promise<void>;
 constructor(private readonly app:NestExpressApplication,private readonly config:B2bMailerRuntimeConfig,private readonly controlTls:MailerRuntimeTls,
  readonly status:B2bOwnerRuntimeStatus,readonly maintenance:B2bMaintenanceNode,readonly drain:B2bOwnerDrain,private readonly startDispatcher:()=>void){}
 get application(){return this.app;}
 get bootId(){return this.status.bootId;}
 toJSON(){return {owner:'mailer',deploymentId:this.config.deploymentId,instanceId:this.config.instanceId,bootId:this.bootId,profile:this.config.profile,
  capabilities:[...this.status.capabilities],dispatcherEnabled:this.config.dispatcher.enabled,fiscalActivation:false};}
 [inspect.custom](){return this.toJSON();}
 start(){
  if(this.#started||this.#terminal||this.#closing||this.maintenance.snapshot().state!=='READY')return Promise.reject(Error('B2B_MAILER_RUNTIME_START_REJECTED'));
  this.#started=true;this.#starting=(async()=>{
   try{
    await this.status.inspect();await this.app.listen(this.config.api.port,this.config.api.host);
    const control=await this.maintenance.listen({...this.config.control,tls:this.controlTls,operatorPeers:this.config.peers.operator});
    if(this.maintenance.snapshot().state!=='READY'||this.drain.snapshot().state!=='OPEN')throw Error();
    this.startDispatcher();return {api:this.app.getHttpServer().address(),control};
   }catch{this.#terminal=true;await stopB2bMaintenanceNode(this.maintenance);throw Error('B2B_MAILER_RUNTIME_START_BLOCKED');}
  })();return this.#starting;
 }
 close(){if(this.#closing)return this.#closing;this.#terminal=true;return this.#closing=(async()=>{await this.#starting?.catch(()=>{});await stopB2bMaintenanceNode(this.maintenance);})();}
}
export async function createB2bMailerRuntime(input?:B2bMailerRuntimeConfig,d?:B2bMailerRuntimeDependencies):Promise<B2bMailerOwnerRuntime|null>{
 if(input?.enabled!==true)return null;
 const config=mailerRuntimeConfig(input);requireMailerHostPorts(d,config);
 if(!d||typeof d.pool?.connect!=='function'||typeof d.pool.end!=='function'||!(d.identityHttp instanceof B2bPrivateHttp)||!(d.billingHttp instanceof B2bPrivateHttp)||
  config.dispatcher.enabled&&!(d.workerIdentityHttp instanceof B2bPrivateHttp)||config.smtpAdministration&&!(d.authorityHttp instanceof B2bPrivateHttp))throw Error('B2B_MAILER_RUNTIME_DEPENDENCIES_REQUIRED');
 const credentials={apiTls:mailerRuntimeTls(d.credentials?.apiTls),controlTls:mailerRuntimeTls(d.credentials?.controlTls)};
 const pool=d.pool,identity=new B2bIdentityHttp(d.identityHttp),drain=new B2bOwnerDrain({enabled:true,maxConcurrent:16});
 const capture=config.profile==='LOCAL_CAPTURE'?new B2bMailerFileCapture(config.captureRoot!):undefined;
 const store=new PostgresEmailDeliveryStore(pool,{enabled:true,ownsPool:false,...(config.profile==='CORPORATE'?{profile:'CORPORATE' as const}:{})});
 const corporate=config.profile==='CORPORATE'?new NodemailerCorporateEmailTransport(d.corporateOwner!,{enabled:true,realSendEnabled:true,approvedHosts:config.corporate!.approvedHosts}):null;
 const core=new B2bEmailDeliveries(store,identity,d.emailSource??new OwnerEmailDeliveryDocumentSource(d.emailArtifacts!),
  capture?new NodemailerLocalEmailCapture(capture,'LOCAL_CAPTURE'):corporate,{enabled:true,profile:config.profile});
 const dispatcher=config.dispatcher.enabled?new B2bMailerDispatcher(pool,core,new HttpB2bEmailActor(d.workerIdentityHttp!),{...config.dispatcher,profile:config.profile==='CORPORATE'?'CORPORATE':'LOCAL_CAPTURE'}):undefined;
 const administration=config.smtpAdministration?createMailerHostAdministration(d.authorityHttp!,d.billingHttp):undefined;
 let closingStorage=false;const checks=new Set<Promise<void>>();
 const check=()=>{
  if(closingStorage)return Promise.reject(Error('B2B_MAILER_STORAGE_CLOSED'));
  const work=(async()=>{await checkB2bMailerRuntimeSchema(pool,config.database);capture?.check();
   if(corporate){await checkCorporateSchema(pool);await d.corporateOwner!.checkStorage();}
   if(administration){await administration.assertInfrastructure();await d.smtpOwner!.checkStorage();}})();
  checks.add(work);void work.then(()=>checks.delete(work),()=>checks.delete(work));return work;
 };
 await check();
 const capabilities=['EMAIL',...(administration?['PRIVILEGED_ADMIN']:[])];
 const status=new B2bOwnerRuntimeStatus('mailer',config.deploymentId,Object.freeze(capabilities),check);
 const imports:DynamicModule[]=[B2bOwnerRuntimeStatusModule.isolated(status,config.peers.resource)];
 if(administration){
  const caps=new Phase8AdminCapabilities(),owner=d.smtpOwner!.createOwner(caps);
  if(!owner||typeof owner.status!=='function'||typeof owner.save!=='function')throw Error('B2B_MAILER_SMTP_OWNER_RESOURCE_REQUIRED');
  imports.push(Phase8AdminOwnerModule.isolated(new B2bPhase8SmtpAdmin({identity,...administration,enabled:true},owner,caps),['SMTP_READ','SMTP_SAVE'],config.peers.resource));
 }
 const httpsOptions={...credentials.apiTls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const,maxHeaderSize:8192};
 const app=await NestFactory.create<NestExpressApplication>(B2bMailerRuntimeModule.assembled(imports,createB2bEmailDeliveriesHandler(core,config.peers.resource,'OWNER_RPC')),
  {logger:false,abortOnError:false,bodyParser:false,httpsOptions});
 drain.install(app);
 app.use((req:any,res:any,next:()=>void)=>{
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const names=req.rawHeaders.filter((_v:string,i:number)=>i%2===0).map((v:string)=>v.toLowerCase()),length=req.headers['content-length'];
  const paths=['/internal/b2b/email-deliveries','/internal/b2b/runtime-status',...(administration?['/internal/b2b/owner-admin']:[])];
  if(req.method!=='POST'||!paths.includes(req.url)||new Set(names).size!==names.length||req.headers['transfer-encoding']||
   !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')||typeof length!=='string'||!/^\d{1,5}$/.test(length))return res.status(400).json({code:'INVALID_MAILER_REQUEST'});
  if(Number(length)>16384)return res.status(413).json({code:'NARROW_QUERY'});next();
 });
 app.useBodyParser('json',{limit:16384,strict:true,verify:(req:any,_res:any,bytes:Buffer)=>{req.rawBody=Buffer.from(bytes);}});
 app.use((_error:unknown,_req:unknown,res:any,_next:unknown)=>res.status(400).json({code:'INVALID_MAILER_REQUEST'}));
 const server=app.getHttpServer();server.headersTimeout=10000;server.requestTimeout=60000;server.keepAliveTimeout=1000;server.maxConnections=64;
 const wait=async(which:'COMMANDS'|'MUTATIONS'|'ALL')=>{while((await drain.drain(which,30000)).state!=='DRAINED'){/* Never infer cancellation from client disconnect. */}};
 const once=(work:()=>Promise<void>)=>{let p:Promise<void>|undefined;return ()=>p??=Promise.resolve().then(work);};
 const maintenance=new B2bMaintenanceNode({enabled:true,deploymentId:config.deploymentId,instance:{service:'MAILER',instanceId:config.instanceId,bootId:status.bootId},hooks:{
  ADMISSION:once(async()=>{drain.pauseCommands();dispatcher?.pause();await wait('COMMANDS');}),
  PRODUCERS:once(async()=>{dispatcher?.pause();}),
  WORKERS:once(async()=>{await dispatcher?.drain();await wait('MUTATIONS');}),
  STORAGE:once(async()=>{closingStorage=true;drain.closeAdmission();await wait('ALL');while(checks.size)await Promise.allSettled([...checks]);
   await core.close();await d.emailSource?.close?.();await app.close();if(administration)await d.smtpOwner!.close();await pool.end();}),
 }});
 return new B2bMailerOwnerRuntime(app,config,credentials.controlTls,status,maintenance,drain,()=>{dispatcher?.start();});
}
