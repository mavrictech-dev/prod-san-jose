import 'reflect-metadata';
import { Module,type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { B2bReadModule,B2bReadErrorFilter,b2bReadHeaders } from './http';
import { B2bDraftModule } from './command-http';
import type { B2bReads } from './read';
import type { B2bCommands } from './commands';
import { B2bExtractionModule } from './extraction-http';
import type { B2bExports } from './extraction';
import {B2bWebhookModule,type B2bWebhooks} from './webhooks';
import {B2bCommercialModule,type B2bCommercialCommands} from './commercial';
import {B2bCorrectionModule,type B2bCorrections} from './corrections';
import {B2bGuideModule,type B2bGuideCommands} from './guides';
import {B2bGuidePreparationModule,type B2bGuidePreparations} from './guide-preparation';
import {B2bGuideIssueModule,type B2bGuideIssuances} from './guide-issue';
import {B2bGuideArtifactModule,type B2bGuideArtifacts} from './guide-artifacts';
import {B2bCarrierGuideModule,type B2bCarrierGuideOperations} from './carrier-guide-operations';
import {B2bBatchOperationsModule,type B2bBatchOperations} from './batch-operations';
import {B2bBatchArtifactModule,type B2bBatchArtifacts} from './batch-artifacts';
import {B2bReceivedModule,type B2bReceivedReads} from './received';
import {B2bReceivedCommandsModule,type B2bReceivedCommands} from './received-commands';
import {B2bIntegrationAdminModule,type B2bIntegrationAdmin} from './integration-admin';
import {B2bPhase8BusinessModule,type B2bPhase8Business} from './phase8-business';
import {B2bPhase8ReportsModule,type B2bPhase8Reports} from './phase8-reports';
import {B2bPhase8HistoryModule,type B2bPhase8History} from './phase8-history';
import {B2bPhase8AdminModule,type B2bPhase8Admin} from './phase8-admin';
import {B2bReceivedAutomationModule,type B2bReceivedAutomation} from './received-automation';
import {B2bEmailDeliveriesModule,type B2bEmailDeliveryOperations} from './email-deliveries';
import type {B2bOperationalControl} from './operational-control';
export type B2bPhase8Modules={received:B2bReceivedReads;receivedCommands?:B2bReceivedCommands;admin?:B2bIntegrationAdmin;business?:B2bPhase8Business;reports?:B2bPhase8Reports;history?:B2bPhase8History;privileged?:B2bPhase8Admin;automation?:B2bReceivedAutomation;email?:B2bEmailDeliveryOperations};
function phase8Imports(p:B2bPhase8Modules|undefined,peers:string[]){
  return p?[B2bReceivedModule.isolated(p.received,peers),...(p.receivedCommands?[B2bReceivedCommandsModule.isolated(p.receivedCommands,peers)]:[]),
    ...(p.admin?[B2bIntegrationAdminModule.isolated(p.admin,peers)]:[]),...(p.business?[B2bPhase8BusinessModule.isolated(p.business,peers)]:[]),...(p.reports?[B2bPhase8ReportsModule.isolated(p.reports,peers)]:[]),...(p.history?[B2bPhase8HistoryModule.isolated(p.history,peers)]:[]),...(p.privileged?[B2bPhase8AdminModule.isolated(p.privileged,peers)]:[]),...(p.automation?[B2bReceivedAutomationModule.isolated(p.automation,peers)]:[]),...(p.email?[B2bEmailDeliveriesModule.isolated(p.email,peers)]:[])]:[];
}
export type B2bPhase7Modules = { guideIssuance:B2bGuideIssuances; guideArtifacts:B2bGuideArtifacts;
  carrier:B2bCarrierGuideOperations; batches:B2bBatchOperations; batchArtifacts:B2bBatchArtifacts };
function phase7Imports(phase7:B2bPhase7Modules|undefined,peers:string[]) {
  if(!phase7)return [];
  return [B2bGuideIssueModule.isolated(phase7.guideIssuance,peers),B2bGuideArtifactModule.isolated(phase7.guideArtifacts,peers),
    B2bCarrierGuideModule.isolated(phase7.carrier,peers),B2bBatchOperationsModule.isolated(phase7.batches,peers),B2bBatchArtifactModule.isolated(phase7.batchArtifacts,peers)];
}
@Module({})
class B2bDraftCandidateApplication {
  static isolated(read:B2bReads,commands:B2bCommands,peers:string[],extraction?:B2bExports,webhooks?:B2bWebhooks,commercial?:B2bCommercialCommands,corrections?:B2bCorrections,guides?:B2bGuideCommands,preparation?:B2bGuidePreparations,phase7?:B2bPhase7Modules,phase8?:B2bPhase8Modules):DynamicModule{
    const capabilities=phase8?{admin:!!phase8.admin,business:!!phase8.business,receivedCommands:!!phase8.receivedCommands,reports:!!phase8.reports,history:!!phase8.history,privileged:!!phase8.privileged,automation:!!phase8.automation,email:!!phase8.email}:undefined;
    return {module:B2bDraftCandidateApplication,imports:[
      B2bReadModule.isolated(read,peers,true,!!extraction,commands.issuanceConfigured,!!webhooks,!!commercial,commercial?.conversionConfigured??false,!!corrections,!!guides,!!preparation,phase7?{guideIssuance:true,guideArtifacts:true,carrier:true,batches:true}:undefined,!!phase8?.received,capabilities),
      B2bDraftModule.isolated(commands,peers),...(extraction?[B2bExtractionModule.isolated(extraction,peers)]:[]),...(webhooks?[B2bWebhookModule.isolated(webhooks,peers)]:[]),
      ...(commercial?[B2bCommercialModule.isolated(commercial,peers)]:[]),...(corrections?[B2bCorrectionModule.isolated(corrections,peers)]:[]),...(guides?[B2bGuideModule.isolated(guides,peers)]:[]),
      ...(preparation?[B2bGuidePreparationModule.isolated(preparation,peers)]:[]),...phase7Imports(phase7,peers),...phase8Imports(phase8,peers)]};
  }
}
/** Explicit draft-enabled factory; read-only factory and existing QA remain unchanged. */
export async function createB2bDraftApplication(read:B2bReads,commands:B2bCommands,peers:string[],tls:{ca:Buffer;cert:Buffer;key:Buffer},extraction?:B2bExports,webhooks?:B2bWebhooks,commercial?:B2bCommercialCommands,corrections?:B2bCorrections,guides?:B2bGuideCommands,preparation?:B2bGuidePreparations,phase7?:B2bPhase7Modules,phase8?:B2bPhase8Modules,operationalControl?:B2bOperationalControl){
  const httpsOptions={...tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const,maxHeaderSize:8192};
  const app=await NestFactory.create<NestExpressApplication>(B2bDraftCandidateApplication.isolated(read,commands,peers,extraction,webhooks,commercial,corrections,guides,preparation,phase7,phase8),{logger:false,bodyParser:false,
    httpsOptions});
  operationalControl?.install(app);
  let active=0;app.use((req:any,res:any,next:()=>void)=>{
    b2bReadHeaders(res);if(req.url.length>8192)return res.status(400).json({code:'INVALID_REQUEST'});
    if(req.method==='GET'){if(req.headers['transfer-encoding']||(req.headers['content-length']!==undefined&&req.headers['content-length']!=='0'))return res.status(400).json({code:'INVALID_REQUEST'});}
    else{
      const path=req.url.split('?')[0],allowed=req.method==='POST'?(/^\/b2b\/v1\/document-drafts(?:\/[a-f0-9-]{36}\/(?:validate|cancel|issue))?$/.test(path)||!!extraction&&path==='/b2b/v1/exports'):req.method==='PATCH'&&/^\/b2b\/v1\/document-drafts\/[a-f0-9-]{36}$/.test(path);
      const hookAllowed=!!webhooks&&(req.method==='POST'&&(/^\/b2b\/v1\/webhook-subscriptions(?:\/[a-f0-9-]{36}\/(?:verify|rotate-secret))?$/.test(path)||/^\/b2b\/v1\/webhook-deliveries\/[a-f0-9-]{36}\/replay$/.test(path))||req.method==='PATCH'&&/^\/b2b\/v1\/webhook-subscriptions\/[a-f0-9-]{36}$/.test(path));
      const commercialAllowed=!!commercial&&(req.method==='POST'&&(/^\/b2b\/v1\/sales-notes(?:\/[a-f0-9-]{36}\/(?:complete|convert|cancel))?$/.test(path)||/^\/b2b\/v1\/correction-requests(?:\/[a-f0-9-]{36}\/cancel)?$/.test(path))||req.method==='PATCH'&&/^\/b2b\/v1\/sales-notes\/[a-f0-9-]{36}$/.test(path));
      const correctionAllowed=!!corrections&&req.method==='POST'&&/^\/b2b\/v1\/correction-notes(?:\/[a-f0-9-]{36}\/settle)?$/.test(path);
      const guideAllowed=!!guides&&(req.method==='POST'&&/^\/b2b\/v1\/guide-drafts(?:\/[a-f0-9-]{36}\/(?:ready|cancel))?$/.test(path)||req.method==='PATCH'&&/^\/b2b\/v1\/guide-drafts\/[a-f0-9-]{36}$/.test(path));
      const preparationAllowed=!!preparation&&req.method==='POST'&&/^\/b2b\/v1\/guide-drafts\/[a-f0-9-]{36}\/preparation$/.test(path);
      const phase7Allowed=!!phase7&&req.method==='POST'&&(/^\/b2b\/v1\/guide-drafts\/[a-f0-9-]{36}\/(?:issuance|issuances\/[a-f0-9-]{36}\/artifacts)$/.test(path)||/^\/b2b\/v1\/carrier-guide-drafts\/[a-f0-9-]{36}\/(?:ready|issuance)$/.test(path)||/^\/b2b\/v1\/batches\/(?:prepare|recover|[a-f0-9-]{36}\/local-artifacts)$/.test(path));
      const receptionAllowed=!!phase8?.receivedCommands&&(req.method==='POST'&&/^\/b2b\/v1\/received-documents(?:\/[a-f0-9-]{36}\/artifacts)?$/.test(path)||req.method==='PATCH'&&/^\/b2b\/v1\/received-documents\/[a-f0-9-]{36}\/(?:assignment|registration)$/.test(path));
      const adminAllowed=!!phase8?.admin&&(req.method==='POST'&&/^\/b2b\/v1\/admin\/applications(?:\/[a-f0-9-]{36}\/rotate-secret)?$/.test(path)||req.method==='PATCH'&&/^\/b2b\/v1\/admin\/applications\/[a-f0-9-]{36}$/.test(path));
      const businessAllowed=!!phase8?.business&&(req.method==='POST'&&/^\/b2b\/v1\/(?:customers|products|shifts(?:\/[a-f0-9-]{36}\/(?:close|cash-movements))?)$/.test(path)||req.method==='PATCH'&&/^\/b2b\/v1\/(?:customers|products)\/[a-f0-9-]{36}$/.test(path));
      const reportsAllowed=!!phase8?.reports&&req.method==='POST'&&path==='/b2b/v1/report-jobs';
      const automationAllowed=!!phase8?.automation&&(req.method==='POST'&&path==='/b2b/v1/received-sync-jobs'||req.method==='PATCH'&&/^\/b2b\/v1\/admin\/received-connectors\/[1-9][0-9]{0,9}$/.test(path));
      const emailAllowed=!!phase8?.email&&req.method==='POST'&&/^\/b2b\/v1\/documents\/[a-f0-9-]{36}\/email-deliveries$/.test(path);
      const privilegedAllowed=!!phase8?.privileged&&(req.method==='POST'&&/^\/b2b\/v1\/admin\/(?:issuers|branches|branches\/[a-f0-9-]{36}\/points|points\/[a-f0-9-]{36}\/series|users|print-profiles\/[1-9][0-9]{0,9}\/preview|(?:fiscal-config|mail-config)\/[1-9][0-9]{0,9}\/replacements)$/.test(path)||req.method==='PATCH'&&/^\/b2b\/v1\/admin\/(?:issuers\/[1-9][0-9]{0,9}|(?:branches|points|series)\/[a-f0-9-]{36}|users\/[a-f0-9-]{36}\/access|roles\/[A-Z_]{1,40}|print-profiles\/[1-9][0-9]{0,9})$/.test(path));
      if(!allowed&&!hookAllowed&&!commercialAllowed&&!correctionAllowed&&!guideAllowed&&!preparationAllowed&&!phase7Allowed&&!receptionAllowed&&!adminAllowed&&!businessAllowed&&!reportsAllowed&&!automationAllowed&&!privilegedAllowed&&!emailAllowed)return res.status(400).json({code:'DRAFT_COMMANDS_ONLY'});
      const maxBody=privilegedAllowed&&/^\/b2b\/v1\/admin\/(?:print-profiles|fiscal-config|mail-config)\//.test(path)?1024*1024:128*1024;
      if(req.headers['transfer-encoding']||!/^application\/json(?:;|$)/.test(req.headers['content-type']??'')||!/^[1-9]\d{0,6}$/.test(req.headers['content-length']??'')||Number(req.headers['content-length'])>maxBody)return res.status(413).json({code:'INVALID_BODY'});
    }
    if(active>=16){res.setHeader('Retry-After','60');return res.status(429).json({code:'RATE_LIMITED'});}
    active++;let released=false;const release=()=>{if(!released){released=true;active--;}};res.once('finish',release);res.once('close',release);next();
  });
  // The middleware above retains 128 KiB for ordinary commands. Only explicitly
  // installed certificate/logo replacement routes may reach this 1 MiB parser.
  app.useBodyParser('json',{limit:1024*1024,strict:true});app.useGlobalFilters(new B2bReadErrorFilter());return app;
}
