import 'reflect-metadata';
import {Module,Catch,Controller,HttpException,type DynamicModule,type ArgumentsHost} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {EXCEPTION_FILTERS_METADATA} from '@nestjs/common/constants';
import type {NestExpressApplication} from '@nestjs/platform-express';
import {inspect} from 'node:util';
import {B2bOwnerRuntimeStatus,B2bOwnerRuntimeStatusModule} from '@factuez/service-access/dist/b2b-runtime-status';
import {B2bMaintenanceNode,stopB2bMaintenanceNode,type B2bMaintenanceHooks} from '@factuez/service-access/dist/b2b-maintenance-node';
import {PrismaOwnerJournal} from '@factuez/service-access/dist/integration-owner-changes';
import {Phase8AdminOwnerModule} from '@factuez/service-access/dist/b2b-phase8-admin-http';
import {Phase8AdminCapabilities} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import {PersistentBatchMemberEvidence} from './batch-member-evidence-assembly';
import {BatchMemberEvidenceModule} from './batch-member-evidence-http';
import {CarrierReferenceValidation} from './carrier-reference-validation';
import {CarrierReferenceValidationModule} from './carrier-reference-validation-http';
import {B2bSunatReadModule} from './http';
import {B2bSunatReads,HttpB2bBillingPort} from './read';
import {PrismaB2bSunatRead} from './repository';
import {PostgresB2bDownloadAudit} from './audit';
import {SunatCorrectionEvidence,HttpCorrectionEvidenceAuthority} from './correction-evidence';
import {SunatCorrectionEvidenceModule} from './correction-evidence-http';
import {B2bPhase8FiscalAdmin} from './phase8-admin';
import {createBetaCorrectionOwnerAssembly} from '../application/beta-correction-owner-assembly';
import {createLocalPhase7GuideArtifactPipeline} from '../application/guide-artifact-assembly';
import {createLocalPhase7BatchArtifactPipeline} from '../application/batch-artifact-assembly';
import {FiscalConfigurationService} from '../application/fiscal-configuration.service';
import {BetaOwnerXmlTrust} from '../infrastructure/crypto/beta-owner-xml-trust';
import {GuideArtifactModule} from '../guide-artifact-http';
import {BatchArtifactModule} from '../batch-artifact-http';
import {sunatRuntimeConfig,sunatRuntimeTls} from './runtime-config';
import {checkSunatRuntimeSchema,type SunatRuntimeCapability} from './runtime-schema';
import {RuntimeGuideArtifactApi,RuntimeBatchArtifactApi,runtimeArtifactDatabase,runtimeCorrectionSignatures} from './runtime-validation';
import type {B2bSunatRuntimeConfig,B2bSunatRuntimeDependencies} from './runtime-types';
export type {B2bSunatRuntimeConfig,B2bSunatRuntimeDependencies} from './runtime-types';
@Catch()
export class SunatRuntimeFilter {
 catch(e:unknown,host:ArgumentsHost){
  // Keep only bounded denial statuses across source/compiled owner boundaries; never exception messages/codes.
  const code=e instanceof HttpException?e.getStatus():e&&typeof e==='object'&&'status'in e?Number(e.status):503;
  const status=[400,401,403,404,409,413,422,429].includes(code)?code:503,res=host.switchToHttp().getResponse();
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  return res.status(status).json({code:status===503?'SUNAT_RUNTIME_UNAVAILABLE':'SUNAT_RUNTIME_REQUEST_DENIED'});
 }
}
@Module({})
export class B2bSunatRuntimeModule {
 static assembled(imports:DynamicModule[]):DynamicModule{return {module:B2bSunatRuntimeModule,imports};}
}
export class B2bSunatOwnerRuntime {
 #started=false;#terminal=false;#closing?:Promise<void>;
 constructor(private readonly app:NestExpressApplication,private readonly config:B2bSunatRuntimeConfig,
  private readonly controlTls:ReturnType<typeof sunatRuntimeTls>,private readonly node:B2bMaintenanceNode,
  private readonly readiness:B2bOwnerRuntimeStatus){}
 get application(){return this.app;}
 get maintenance(){return this.node;}
 get status(){return this.readiness;}
 get bootId(){return this.readiness.bootId;}
 get statusMetadata(){return {owner:'fiscal',deploymentId:this.config.deploymentId,instanceId:this.config.instanceId,bootId:this.bootId,
  capabilities:[...this.readiness.capabilities],fiscalActivation:false};}
 async start(){
  if(this.#started||this.#terminal||this.node.snapshot().state!=='READY')throw Error('B2B_SUNAT_RUNTIME_START_REJECTED');this.#started=true;
  try{await this.readiness.inspect();await this.app.listen(this.config.api.port,this.config.api.host);
   const control=await this.node.listen({...this.config.control,tls:this.controlTls,operatorPeers:this.config.peers.operator});
   return {api:this.app.getHttpServer().address(),control};
  }catch{this.#terminal=true;await this.app.close().catch(()=>{});await this.node.closeListener().catch(()=>{});throw Error('B2B_SUNAT_RUNTIME_START_FAILED');}
 }
 /** Explicit process termination, separate from STORAGE's surviving control listener. */
 close(){this.#terminal=true;return this.#closing??=stopB2bMaintenanceNode(this.node);}
 toJSON(){return this.statusMetadata;}[inspect.custom](){return this.statusMetadata;}
}
const required=()=>Error('B2B_SUNAT_RUNTIME_DEPENDENCIES_REQUIRED');
/** No environment/files lookup, bootstrap/migrations, transport or automatic listen.
 * Optional modules yield capabilities ONLY after real construction and schema checks. */
export async function createB2bSunatRuntime(input?:B2bSunatRuntimeConfig,deps?:B2bSunatRuntimeDependencies):Promise<B2bSunatOwnerRuntime|null>{
 if(input?.enabled!==true)return null;
 const config=sunatRuntimeConfig(input),d=deps;
 if(!d||typeof d.prisma?.$queryRawUnsafe!=='function'||typeof d.prisma.$executeRawUnsafe!=='function'||typeof d.prisma.$transaction!=='function'||typeof d.prisma.$disconnect!=='function'||
  !d.prisma.fiscalDocument||!d.prisma.fiscalBatch||!d.prisma.documentArtifact||!d.prisma.batchArtifact||!d.prisma.cdrLog||
  typeof d.artifacts?.read!=='function'||typeof d.pdf?.b2bDocument!=='function'||typeof d.identity?.authenticate!=='function'||
  typeof d.identityHttp?.post!=='function'||typeof d.billingHttp?.post!=='function'||
  !['install','pauseCommands','closeAdmission','drain','snapshot'].every(k=>typeof (d.drain as any)?.[k]==='function')||d.drain.snapshot().state!=='OPEN'||
  !['stopProducers','stopWorkers','closeOtherOwnerListeners'].every(k=>typeof (d.lifecycle as any)?.[k]==='function'))throw required();
 const g=d.guide,b=d.batch,c=d.corrections,p=d.privileged;
 if(d.batchMemberEvidence&&!(d.batchMemberEvidence instanceof PersistentBatchMemberEvidence))throw required();
 if(d.carrierReference&&!(d.carrierReference instanceof CarrierReferenceValidation))throw required();
 if(g&&(typeof g.keys?.withKey!=='function'||typeof g.cdr?.verify!=='function'||typeof g.xsd?.validate!=='function')||
  b&&(typeof b.keys?.acquire!=='function'||typeof b.cdr?.verify!=='function'||typeof b.xsd?.validate!=='function')||
  c&&(!(c.signatures instanceof BetaOwnerXmlTrust)||typeof c.cdr?.verify!=='function'||typeof c.xsd?.validate!=='function')||
  p&&(typeof p.vault?.seal!=='function'||typeof p.certificates?.inspect!=='function'||typeof p.authority?.authorize!=='function'||typeof p.liveIdentity?.current!=='function'||typeof p.bindingOwner?.revalidate!=='function'))throw required();
 const credentials={apiTls:sunatRuntimeTls(d.credentials?.apiTls),controlTls:sunatRuntimeTls(d.credentials?.controlTls)};
 const capabilities:SunatRuntimeCapability[]=['READ'];if(g)capabilities.push('GUIDE_ARTIFACTS');if(b)capabilities.push('BATCH_ARTIFACTS');if(c)capabilities.push('CORRECTION_EVIDENCE');if(p)capabilities.push('PRIVILEGED_ADMIN');
 let storageClosed=false;
 const check=async()=>{if(storageClosed||d.drain.snapshot().state==='CLOSED')throw Error('B2B_SUNAT_RUNTIME_STORAGE_CLOSED');await checkSunatRuntimeSchema(d.prisma,capabilities);if(d.batchMemberEvidence)await d.batchMemberEvidence.readiness();};
 await check();
 const read=new B2bSunatReads(new PrismaB2bSunatRead(d.prisma),d.identity,new HttpB2bBillingPort(d.billingHttp),d.artifacts,d.pdf,new PostgresB2bDownloadAudit(d.prisma),new PrismaOwnerJournal(d.prisma,'SUNAT'));
 const imports:DynamicModule[]=[B2bSunatReadModule.isolated(read,[...config.peers.resource])];
 if(d.batchMemberEvidence)imports.push(BatchMemberEvidenceModule.isolated(d.batchMemberEvidence,{billing:config.peers.billing}));
 if(d.carrierReference)imports.push(CarrierReferenceValidationModule.isolated(d.carrierReference,{billing:config.peers.billing}));
 if(g){const pipeline=createLocalPhase7GuideArtifactPipeline({database:runtimeArtifactDatabase(d.prisma,g.xsd,'GUIDE'),identity:d.identity,identityHttp:d.identityHttp,billingHttp:d.billingHttp,
  keys:g.keys,allowedRucs:g.allowedRucs,cdr:g.cdr});imports.push(GuideArtifactModule.isolated(new RuntimeGuideArtifactApi(pipeline,g.xsd),config.peers.resource));}
 if(b){const pipeline=createLocalPhase7BatchArtifactPipeline({database:runtimeArtifactDatabase(d.prisma,b.xsd,'BATCH'),identity:d.identity,billingHttp:d.billingHttp,keys:b.keys,
  allowedRucs:b.allowedRucs,cdrVerifier:b.cdr,cdrSource:b.cdrSource});imports.push(BatchArtifactModule.isolated(new RuntimeBatchArtifactApi(pipeline,b.xsd),config.peers.resource));}
 if(c){const owner=createBetaCorrectionOwnerAssembly(d.prisma,d.artifacts,runtimeCorrectionSignatures(c.signatures,c.xsd),c.cdr);
  imports.push(SunatCorrectionEvidenceModule.isolated(new SunatCorrectionEvidence(owner,new HttpCorrectionEvidenceAuthority(d.billingHttp)),[...config.peers.billing]));}
 if(p){const caps=new Phase8AdminCapabilities(),owner=FiscalConfigurationService.createWithOwnerContext(d.prisma,p.vault,p.certificates,caps);
  const adminModule=Phase8AdminOwnerModule.isolated(new B2bPhase8FiscalAdmin({identity:d.identity,authority:p.authority,liveIdentity:p.liveIdentity,bindingOwner:p.bindingOwner,enabled:true},owner,caps),
   ['FISCAL_READ','FISCAL_AUDIT','FISCAL_SAVE'],config.peers.resource);
  // Keep the actual base handler/injection/guards; specialize only its runtime error boundary.
  const Base=adminModule.controllers![0];class RuntimeFiscalAdminController extends Base {} 
  Controller('internal/b2b')(RuntimeFiscalAdminController);Reflect.defineMetadata(EXCEPTION_FILTERS_METADATA,[SunatRuntimeFilter],RuntimeFiscalAdminController);
  adminModule.controllers=[RuntimeFiscalAdminController];adminModule.providers!.push(SunatRuntimeFilter);imports.push(adminModule);}
 const status=new B2bOwnerRuntimeStatus('fiscal',config.deploymentId,Object.freeze([...capabilities]),check);
 imports.push(B2bOwnerRuntimeStatusModule.isolated(status,config.peers.resource));
 const httpsOptions={...credentials.apiTls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const,maxHeaderSize:16384};
 const app=await NestFactory.create<NestExpressApplication>(B2bSunatRuntimeModule.assembled(imports),{logger:false,bodyParser:false,httpsOptions});
 try{
  d.drain.install(app); // Required BEFORE init/listen. Independent subscription outlives disconnects.
  app.use((req:any,res:any,next:()=>void)=>{const names=(req.rawHeaders??[]).filter((_v:string,i:number)=>i%2===0).map((v:string)=>v.toLowerCase());
   if(new Set(names).size!==names.length||req.url.includes('?'))return res.status(400).json({code:'SUNAT_RUNTIME_REQUEST_DENIED'});next();});
  app.useBodyParser('json',{limit:'2mb',strict:true});app.useGlobalFilters(new SunatRuntimeFilter());
 }catch{await app.close();throw required();}
 const completed=new Map<string,Promise<void>>();
 const once=(phase:string,work:()=>Promise<void>)=>()=>{const old=completed.get(phase);if(old)return old;const active=Promise.resolve().then(work);completed.set(phase,active);return active;};
 const drained=async(which:'COMMANDS'|'MUTATIONS'|'ALL')=>{const result=await d.drain.drain(which);if(result.state!=='DRAINED'||result.pending!==0)throw Error('B2B_SUNAT_RUNTIME_NOT_DRAINED');};
 const hooks:B2bMaintenanceHooks={
  ADMISSION:once('ADMISSION',async()=>{d.drain.pauseCommands();await drained('COMMANDS');}),
  PRODUCERS:once('PRODUCERS',async()=>{await d.lifecycle.stopProducers();}),
  WORKERS:once('WORKERS',async()=>{await d.lifecycle.stopWorkers();await drained('MUTATIONS');}),
  STORAGE:once('STORAGE',async()=>{d.drain.closeAdmission();await drained('ALL');await d.lifecycle.closeOtherOwnerListeners();await app.close();if(d.lifecycle.closeStorage)await d.lifecycle.closeStorage();else await d.prisma.$disconnect();storageClosed=true;}),
 };
 const node=new B2bMaintenanceNode({enabled:true,deploymentId:config.deploymentId,instance:{service:'SUNAT',instanceId:config.instanceId,bootId:status.bootId},hooks});
 return new B2bSunatOwnerRuntime(app,config,credentials.controlTls,node,status);
}
