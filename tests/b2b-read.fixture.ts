import 'reflect-metadata';
import { vi } from 'vitest';
import { B2bReadScopes,type B2bBinding } from '../packages/contracts/src/b2b-security';
import { fixture,basic,ctx } from './b2b-identity.fixture';
import { readFixture,branchId,pointId,counterId,issuerRuc,secondId } from './integration-read.fixture';
import { B2bBillingReads } from '../services/billing-service/src/b2b/read';
import { B2bSunatReads } from '../services/sunat-service/src/b2b/read';
import { B2bReads } from '../services/b2b-api-service/src/read';
import { CurrentPdfService } from '../services/sunat-service/src/application/current-pdf.service';
export const receiptSeries='30000000-0000-4000-8000-000000000002';
export const invoiceBinding:B2bBinding={issuerId:1,issuerRuc,environment:'BETA',branchId,pointId,seriesId:counterId,documentType:'01'};
export const receiptBinding:B2bBinding={...invoiceBinding,seriesId:receiptSeries,documentType:'03'};
export async function b2bReadFixture(bindings:B2bBinding[]=[invoiceBinding,receiptBinding],scopes:import('../packages/contracts/src/b2b-security').B2bIdentityScope[]=[...B2bReadScopes]){
  const auth=fixture(null,B2bReadScopes),old=readFixture();
  old.rows.get(secondId)!.seriesCounter.id=receiptSeries;
  for(const row of old.docs.values())Object.assign(row,{status:'QUEUED'});
  const made=await auth.core.create('human-step-up',{label:'Synthetic B2B reader',kind:'SERVICE',scopes,bindings},ctx());
  const issued=await auth.core.token(basic(made.client.id,made.clientSecret!),{grant_type:'client_credentials',scope:scopes.join(' ')},ctx());
  const identity={authenticate:vi.fn((t:string,s:any[],kind:'SERVICE'|'USER')=>auth.core.authenticate(t,s,ctx(),kind))};
  const repository={...old.billingRepo,
    contexts:vi.fn(async(values:B2bBinding[])=>values.map(binding=>({binding,issuer:{id:1,ruc:issuerRuc,legalName:'Emisor ficticio QA'},
      branch:{id:branchId,code:'QA',name:'Sede ficticia'},point:{id:pointId,code:'QA',name:'Punto ficticio'},
      series:{id:binding.seriesId,label:binding.documentType==='01'?'F001':'B001',type:binding.documentType}}))),
    capture:vi.fn(async()=>structuredClone([...old.rows.values()])),
    products:vi.fn(async()=>[{id:'90000000-0000-4000-8000-000000000001',sku:'QA-1',description:'Ítem ficticio',unitCode:'NIU',taxAffectationCode:'10',defaultUnitPrice:'118'}])};
  const presentation:any={version:'factuez.print-presentation.v1',issuerRuc,branchId,profileRevision:1,
    settings:{template:'SAN_JOSE_V1',logoMode:'NONE',logoWidthMm:40,logoAlignment:'LEFT',showBranchAddress:true,footerNote:'Sólo prueba ficticia'},logo:null};
  const printing={snapshotForB2b:vi.fn(async()=>structuredClone(presentation))};
  const billing=new B2bBillingReads(repository,identity,printing);
  const renderers={document:vi.fn(async(s:any,format:string)=>Buffer.from('%PDF-SYNTHETIC-'+format+'-'+JSON.stringify(s))),gre:vi.fn()};
  const pdf=new CurrentPdfService(renderers as any),audit={record:vi.fn(async()=>{})};
  const billingPort={execute:vi.fn((t:string,k:'SERVICE'|'USER',a:string,args:unknown)=>billing.execute(t,k,a,args))};
  const fiscal=new B2bSunatReads(old.sunatRepo,identity,billingPort,old.store,pdf,audit);
  const fiscalPort={execute:vi.fn((t:string,k:'SERVICE'|'USER',a:string,args:unknown)=>fiscal.execute(t,k,a,args)),file:vi.fn((t:string,k:'SERVICE'|'USER',a:string,args:unknown)=>fiscal.execute(t,k,a,args) as Promise<any>)};
  const gateway=new B2bReads(identity,billingPort,fiscalPort,()=>auth.now()*1000);
  return {auth,old,made,token:issued.access_token!,identity,repository,presentation,printing,billing,billingPort,fiscal,fiscalPort,pdf,renderers,audit,gateway,
    close:()=>pdf.onModuleDestroy(),refresh:async()=> (await auth.core.token(basic(made.client.id,made.clientSecret!),{grant_type:'client_credentials',scope:scopes.join(' ')},ctx())).access_token!};
}
