import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { BillingRead } from '../services/billing-service/src/integration/read';
import { SunatRead, type StoredArtifact, type FiscalReadBatch } from '../services/sunat-service/src/integration/read';
import { IntegrationReads } from '../services/integration-service/src/read';
import { deny, requireScopes, type ReadPrincipal } from '../packages/service-access/src/integration';
export const issuerRuc='20555555555', otherRuc='20444444444';
export const branchId='10000000-0000-4000-8000-000000000001',pointId='20000000-0000-4000-8000-000000000001',
  counterId='30000000-0000-4000-8000-000000000001',documentId='40000000-0000-4000-8000-000000000001',
  secondId='40000000-0000-4000-8000-000000000002',batchId='50000000-0000-4000-8000-000000000001',
  summaryId='60000000-0000-4000-8000-000000000001',artifactId='70000000-0000-4000-8000-000000000001';
export function principal():ReadPrincipal {return {clientId:'80000000-0000-4000-8000-000000000001',revision:1,environment:'BETA',
  scopes:['integration:catalog:read','integration:documents:read','integration:artifacts:read'],grants:[{issuerRuc,environment:'BETA',
    documentTypes:['01','03','07','08'],branches:{kind:'ALL'},points:{kind:'ALL'},series:{kind:'ALL'}}]};}
export function sale(type:'01'|'03'|'07'|'08'='01',id=documentId) {
  const name={'01':'INVOICE','03':'SALES_RECEIPT','07':'CREDIT_NOTE','08':'DEBIT_NOTE'}[type];
  const series=type==='03'?'B001':'F001',date='2026-01-02T04:30:00.000Z';
  const snapshot:any={companyId:1,branchId,environment:'BETA',documentId:id,documentTypeCode:type,series,number:'00000001',
    fullNumber:series+'-00000001',issueDate:date,currencyCode:'PEN',operationTypeCode:'0101',
    issuer:{identityType:'6',identityNumber:issuerRuc,legalName:'Emisor ficticio QA',address:'Dirección ficticia',ubigeo:'150101'},
    customer:{identityType:'6',identityNumber:otherRuc,legalName:'Cliente ficticio'},
    lines:[{lineNumber:1,productCode:'QA-1',description:'Ítem ficticio',unitCode:'NIU',quantity:'1.000',unitValue:'100.123456',
      unitPriceWithTax:'118.000',lineExtensionAmount:'100.00',igvAmount:'18.00',igvRate:'18.00',taxAffectationCode:'10'}],
    totals:{taxableAmount:'100.00',igvAmount:'18.00',payableAmount:'118.00'}};
  if (['07','08'].includes(type)) Object.assign(snapshot,{reference:{documentId:secondId,documentTypeCode:'01',fullNumber:'F002-50'},
    reasonCode:'01',reasonDescription:'Ajuste ficticio',originalAcceptance:{DO_NOT_EXPOSE:'private-proof'},creditHistoryIds:[secondId]});
  return {id,companyId:1,type:name,series,number:1n,fullNumber:series+'-00000001',issueDate:new Date(date),updatedAt:new Date(date),
    status:'ISSUED',sunatStatus:'ACCEPTED',sunatResponseCode:'0',payableAmount:'118',originSystem:null,originId:null,
    immutableSnapshot:snapshot,company:{ruc:issuerRuc},emissionPoint:{id:pointId,companyId:1,branchId,branch:{companyId:1}},
    seriesCounter:{id:counterId,companyId:1,emissionPointId:pointId,documentType:name,series}};
}
export function readFixture() {
  let time=1800000000000;const p=principal();
  const identity={authenticate:vi.fn(async(token:string,scopes:any[])=>{if(token!=='fixture-token') return deny(401,'UNAUTHENTICATED');requireScopes(p,scopes);return structuredClone(p);})};
  const rows=new Map([[documentId,sale()],[secondId,sale('03',secondId)]]);
  const catalog={issuer:{issuerRuc,legalName:'Emisor ficticio QA',environment:'BETA' as const,active:true},observedAt:'2026-01-01T00:00:00.000Z',
    branches:[{id:branchId,issuerRuc,code:'QA',name:'Sede ficticia',active:true,address:null,establishmentCode:null}],
    points:[{id:pointId,branchId,issuerRuc,code:'QA',name:'Punto ficticio',active:true,
      series:[{id:counterId,type:'01' as const,label:'F001',active:true}]}]};
  const summaries=new Map([[summaryId,{identifier:'RC-20260101-1',items:[{documentId:secondId,conditionCode:'1'}]}]]);
  const billingRepo={document:vi.fn(async(ruc:string,key:any)=>ruc===issuerRuc?
    structuredClone('id' in key?rows.get(key.id)??null:[...rows.values()].find(r=>r.immutableSnapshot.documentTypeCode===key.type && r.series===key.series && r.number===key.number)??null):null),
    catalog:vi.fn(async(ruc:string)=>ruc===issuerRuc?structuredClone(catalog):null),
    batch:vi.fn(async(ruc:string,id:string)=>ruc===issuerRuc?structuredClone(summaries.get(id)??null):null)};
  const billing=new BillingRead(billingRepo,identity),bytes=Buffer.from('<fixture>FICTITIOUS-NOT-OFFICIAL</fixture>');
  const artifact:StoredArtifact={id:artifactId,kind:'SIGNED_XML',storageKey:documentId+'/fixture.xml',mediaType:'application/xml',
    sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),createdAt:new Date('2026-01-01T00:00:00Z')};
  const docs=new Map([...rows.values()].map(r=>[r.id,{documentId:r.id,issuerRuc,environment:'BETA',documentType:r.immutableSnapshot.documentTypeCode,
    series:r.series,number:r.number,immutablePayload:structuredClone(r.immutableSnapshot),artifacts:r.id===documentId?[artifact]:[]} ]));
  const batches=new Map<string,FiscalReadBatch>([[batchId,{id:batchId,summaryId,issuerRuc,environment:'BETA',identifier:'RC-20260101-1',
    immutablePayload:structuredClone(rows.get(secondId)!.immutableSnapshot),artifacts:[]}]]);
  const shared:{artifact:StoredArtifact;batchId:string}[]=[];
  const sunatRepo={document:vi.fn(async(ruc:string,id:string)=>ruc===issuerRuc?structuredClone(docs.get(id)??null):null),
    batch:vi.fn(async(ruc:string,id:string)=>ruc===issuerRuc?structuredClone(batches.get(id)??null):null),
    artifact:vi.fn(async(ruc:string,id:string)=>{
      if(ruc!==issuerRuc) return null;
      for(const d of docs.values()) {const a=d.artifacts.find(a=>a.id===id);if(a) return {artifact:structuredClone(a),owner:{kind:'DOCUMENT' as const,id:d.documentId}};}
      for(const b of batches.values()) {const a=b.artifacts.find(a=>a.id===id);if(a) return {artifact:structuredClone(a),owner:{kind:'BATCH' as const,id:b.id}};}return null;
    }),sharedCdr:vi.fn(async()=>structuredClone(shared)),audit:vi.fn(async()=>{})};
  const store={read:vi.fn(async()=>Buffer.from(bytes))};
  const billingOwner={document:(t:string,r:string,id:string)=>billing.document(t,r,id),batch:(t:string,r:string,id:string)=>billing.batch(t,r,id)};
  const sunat=new SunatRead(sunatRepo,identity,billingOwner,store);
  const billingHttp={json:vi.fn(async(path:string,token:string)=>{
    const u=new URL(path,'https://fixture.invalid'),r=u.searchParams.get('issuerRuc')!;
    if(u.pathname.endsWith('/catalog')) return billing.catalog(token,r);
    if(u.pathname.endsWith('/lookup')) return billing.lookup(token,Object.fromEntries(u.searchParams));
    return billing.document(token,r,u.pathname.split('/').at(-1)!);
  }),bytes:vi.fn()};
  const sunatHttp={json:vi.fn(async(path:string,token:string)=>{
    const u=new URL(path,'https://fixture.invalid'),r=u.searchParams.get('issuerRuc')!,parts=u.pathname.split('/').slice(3);
    return parts.at(-1)==='artifacts'?sunat.artifacts(token,r,parts[1],parts[0]==='documents'?'DOCUMENT':'BATCH'):sunat.batch(token,r,parts[1]);
  }),bytes:vi.fn(async(path:string,token:string)=>{
    const u=new URL(path,'https://fixture.invalid');const f=await sunat.content(token,u.searchParams.get('issuerRuc')!,u.pathname.split('/').at(-2)!);
    return {bytes:f.bytes,headers:{'content-type':f.mediaType,'content-length':String(f.bytes.length),'x-content-sha256':f.sha256,
      'content-disposition':'attachment; filename="'+f.fileName+'"'}};
  })};
  const gateway=new IntegrationReads(identity,billingHttp as any,sunatHttp as any,()=>time);
  return {p,identity,rows,billingRepo,billing,catalog,summaries,bytes,artifact,docs,batches,shared,sunatRepo,store,sunat,
    billingOwner,billingHttp,sunatHttp,gateway,advance:(ms:number)=>{time+=ms;}};
}
