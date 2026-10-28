import {B2bIdentityHttp,B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {createB2bPhase9Application} from './phase9-application';
import {B2bReads,HttpB2bReadOwner} from './read';
import {B2bCommands,HttpB2bCommandOwner} from './commands';
import {B2bExports,HttpB2bExportPort} from './extraction';
import {B2bWebhooks,HttpWebhookOwner} from './webhooks';
import {B2bCommercialCommands,HttpB2bCommercialOwner} from './commercial';
import {B2bCorrections,HttpB2bCorrectionOwner} from './corrections';
import {B2bGuideCommands,HttpB2bGuideOwner} from './guides';
import {B2bGuidePreparations,HttpB2bGuidePreparationOwner} from './guide-preparation';
import {B2bGuideIssuances,HttpB2bGuideIssueOwner} from './guide-issue';
import {B2bGuideArtifacts,HttpB2bGuideArtifactOwner} from './guide-artifacts';
import {B2bCarrierGuideOperations,HttpB2bCarrierGuideOwner} from './carrier-guide-operations';
import {B2bBatchOperations,HttpB2bBatchOperationsOwner} from './batch-operations';
import {B2bBatchArtifacts,HttpB2bBatchArtifactOwner} from './batch-artifacts';
import {B2bReceivedReads,HttpB2bReceivedOwner} from './received';
import {B2bReceivedCommands,HttpReceptionCommands} from './received-commands';
import {B2bReceivedAutomation,HttpReceptionAutomation} from './received-automation';
import {B2bIntegrationAdmin,HttpB2bIntegrationAdminOwner} from './integration-admin';
import {B2bPhase8Business,HttpPhase8Business} from './phase8-business';
import {B2bPhase8Reports,HttpPhase8Reports} from './phase8-reports';
import {B2bPhase8History,HttpB2bHistoryOwner} from './phase8-history';
import {B2bPhase8Admin,HttpPrivilegedOwner} from './phase8-admin';
import {B2bEmailDeliveryOperations,HttpEmailDeliveryOwner} from './email-deliveries';
import type {B2bOperationalControl} from './operational-control';

export const b2bRuntimeOwners=['identity','billing','fiscal','webhooks','received','history','exports','mailer'] as const;
export type B2bRuntimeOwner=typeof b2bRuntimeOwners[number];
export interface B2bFacadeTransports {
 resources:Record<B2bRuntimeOwner,B2bPrivateHttp>;
 administrators:Pick<Record<B2bRuntimeOwner,B2bPrivateHttp>,'identity'|'billing'|'fiscal'|'mailer'>;
}
/** Concrete graph, HTTP adapters only. Real owner listeners/schema readiness must
 * be verified by bootstrap before this factory; no memory or synthetic fallback. */
export function assembleB2bFacade(transports:B2bFacadeTransports,options:{
 tls:{ca:Buffer;cert:Buffer;key:Buffer};peers:string[];operations:B2bOperationalControl;
 localIssuanceEnabled:boolean;localConversionEnabled:boolean;automaticReceivedApprovals?:boolean;
}){
 const r=transports.resources,a=transports.administrators;
 if(b2bRuntimeOwners.some(owner=>!(r[owner] instanceof B2bPrivateHttp))||(['identity','billing','fiscal','mailer'] as const).some(owner=>!(a[owner] instanceof B2bPrivateHttp))||
  typeof options.localIssuanceEnabled!=='boolean'||typeof options.localConversionEnabled!=='boolean'||options.automaticReceivedApprovals!==undefined&&typeof options.automaticReceivedApprovals!=='boolean')throw Error('COMPLETE_B2B_HTTP_OWNER_GRAPH_REQUIRED');
 const identity=new B2bIdentityHttp(r.identity);
 return createB2bPhase9Application({
  tls:options.tls,peers:options.peers,operations:options.operations,
  read:new B2bReads(identity,new HttpB2bReadOwner(r.billing),new HttpB2bReadOwner(r.fiscal,true)),
  commands:new B2bCommands(identity,new HttpB2bCommandOwner(r.billing),options.localIssuanceEnabled),
  extraction:new B2bExports(identity,new HttpB2bExportPort(r.exports)),
  webhooks:new B2bWebhooks(identity,new HttpWebhookOwner(r.webhooks)),
  commercial:new B2bCommercialCommands(identity,new HttpB2bCommercialOwner(r.billing),options.localConversionEnabled),
  corrections:new B2bCorrections(identity,new HttpB2bCorrectionOwner(r.billing)),
  guides:new B2bGuideCommands(identity,new HttpB2bGuideOwner(r.billing)),preparation:new B2bGuidePreparations(identity,new HttpB2bGuidePreparationOwner(r.billing)),
  phase7:{guideIssuance:new B2bGuideIssuances(identity,new HttpB2bGuideIssueOwner(r.billing)),guideArtifacts:new B2bGuideArtifacts(identity,new HttpB2bGuideArtifactOwner(r.fiscal)),
   carrier:new B2bCarrierGuideOperations(identity,new HttpB2bCarrierGuideOwner(r.billing)),batches:new B2bBatchOperations(identity,new HttpB2bBatchOperationsOwner(r.billing)),batchArtifacts:new B2bBatchArtifacts(identity,new HttpB2bBatchArtifactOwner(r.fiscal))},
  phase8:{received:new B2bReceivedReads(identity,new HttpB2bReceivedOwner(r.received)),receivedCommands:new B2bReceivedCommands(identity,new HttpReceptionCommands(r.received)),
   admin:new B2bIntegrationAdmin(new HttpB2bIntegrationAdminOwner(a.identity)),business:new B2bPhase8Business(identity,new HttpPhase8Business(r.billing)),
   reports:new B2bPhase8Reports(identity,new HttpPhase8Reports(r.billing)),history:new B2bPhase8History(identity,new HttpB2bHistoryOwner(r.history)),
   privileged:new B2bPhase8Admin(identity,{billing:new HttpPrivilegedOwner(a.billing),identity:new HttpPrivilegedOwner(a.identity),fiscal:new HttpPrivilegedOwner(a.fiscal),smtp:new HttpPrivilegedOwner(a.mailer)}),
   automation:new B2bReceivedAutomation(identity,new HttpReceptionAutomation(r.received),{automaticReceivedApprovals:options.automaticReceivedApprovals??false}),email:new B2bEmailDeliveryOperations(identity,new HttpEmailDeliveryOwner(r.mailer))},
 });
}
