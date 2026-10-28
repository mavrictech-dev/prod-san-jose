import 'reflect-metadata';
import {beforeAll,describe,it,expect} from 'vitest';import {createRequire} from 'node:module';
import {NestFactory} from '../services/b2b-api-service/node_modules/@nestjs/core';
import {B2bPhase8Reports,B2bPhase8ReportsModule} from '../services/b2b-api-service/src/phase8-reports';
import {FactuEzB2bClient} from '../packages/b2b-sdk/src';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {reportsSourcesFixture,reportsGuideSourcesFixture} from './b2b-phase8-reports-sources.fixture';
let pki:ReturnType<typeof b2bCertificates>;
beforeAll(()=>{pki=b2bCertificates();},30000);
async function withSdk(f:ReturnType<typeof reportsSourcesFixture>,work:(sdk:FactuEzB2bClient,mutate:(fn:(v:any)=>any)=>void)=>Promise<void>){
 let transform=(v:any)=>v;const owner=f.core();
 const port={execute:async(a:any,action:any,input:any)=>transform(await owner.execute(a,action,input)),content:async(a:any,input:any)=>owner.execute(a,'CONTENT',input)};
 const core=new B2bPhase8Reports(f.identity,port),module=B2bPhase8ReportsModule.isolated(core,[fingerprint(pki.edge)]);
 const app=await NestFactory.create(module,{logger:false,httpsOptions:{ca:pki.ca,cert:pki.server,key:pki.key,requestCert:true,rejectUnauthorized:true}});
 await app.listen(0,'127.0.0.1');const origin='https://127.0.0.1:'+app.getHttpServer().address().port;
 const sdk=new FactuEzB2bClient({origin,tls:{ca:pki.ca,cert:pki.edge,key:pki.key,serverCertificateSha256:fingerprint(pki.server)},bearer:async()=>({actorKind:'SERVICE',token:'synthetic-report-token'})});
 try{await work(sdk,fn=>{transform=fn;});}finally{await app.close();}
}
describe('extended reports: public SDK -> pinned mTLS -> facade -> real owner engine',()=>{
 it('propagates expired report 410 through real mTLS HTTP/SDK without regenerating or leaking revoked resources',async()=>{
  const f=reportsSourcesFixture();await withSdk(f,async sdk=>{
   const filters={issuerId:1,environment:'BETA' as const,from:'2026-01-01',to:'2026-01-02',types:['01'] as '01'[]},key='retention_report_http_synthetic';
   const created=await sdk.createReport(filters,'CSV',{idempotencyKey:key}),id=created.data.id;
   f.store.jobs.get(id)!.contentPurgedAt=new Date().toISOString();f.store.files.delete(id);
   for(const action of [()=>sdk.readReport(id),()=>sdk.downloadReport(id),()=>sdk.createReport(filters,'CSV',{idempotencyKey:key})])await expect(action()).rejects.toMatchObject({status:410});
   expect(f.port.execute).toHaveBeenCalledOnce();f.p.bindings[0].branchId='10000000-0000-4000-8000-000000000099';
   await expect(sdk.readReport(id)).rejects.toMatchObject({status:404});
  });
 });
 it('lists signed NC/ND and commercial results, creates and downloads stable CSV without changing legacy defaults',async()=>{
  const f=reportsSourcesFixture();await withSdk(f,async sdk=>{
   const filters={issuerId:1,environment:'BETA' as const,from:'2026-01-01',to:'2026-01-02',types:['07','08','NV'] as ('07'|'08'|'NV')[]};
   const result=await sdk.dashboard(filters);expect(result.source).toBe('BILLING_OWNER_SOURCES');expect(result.data.count).toBe(3);
   expect(result.data.groups.find(g=>g.type==='07')!.payableAmount).toMatch(/^-/);expect(result.data.coverage?.every(c=>c.fiscalAcceptance==='NOT_ASSERTED')).toBe(true);
   const created=await sdk.createReport(filters,'CSV',{idempotencyKey:'extended_reports_http_synthetic'});expect(created.data.types).toEqual(['07','08','NV']);
   const downloaded=await sdk.downloadReport(created.data.id);expect(downloaded.bytes.toString()).toContain('signedPayableAmount');
   expect((await sdk.readReport(created.data.id)).data.captureSha256).toBe(created.data.captureSha256);
  });
 });
 it.each(['09','31'] as const)('exposes %s as transfers with quantities and no sales contribution',async type=>{
  const f=await reportsGuideSourcesFixture(type);await withSdk(f,async sdk=>{
   const result=await sdk.dashboard({issuerId:1,environment:'BETA',from:f.input.filters.from,to:f.input.filters.to,types:[type]});
   expect(result.data.groups).toEqual([]);expect(result.data.netSales).toEqual([]);expect(result.data.transfers).toHaveLength(1);
   expect(result.data.transfers![0].type).toBe(type);expect(result.data.coverage![0]).toMatchObject({financialContribution:'NONE',authorizedForTransfer:false});
   f.control.revoked=true;await expect(sdk.dashboard({issuerId:1,environment:'BETA',from:f.input.filters.from,to:f.input.filters.to,types:[type]})).rejects.toThrow();
  });
 });
 it('rejects fabricated fiscal acceptance, changed filters, hidden owner fields and false net amounts at the facade boundary',async()=>{
  const f=reportsSourcesFixture();await withSdk(f,async(sdk,mutate)=>{
   const filters={issuerId:1,environment:'BETA' as const,from:'2026-01-01',to:'2026-01-02',types:['07','08','NV'] as ('07'|'08'|'NV')[]};
   for(const change of [(r:any)=>{r.data.coverage[0].fiscalAcceptance='ACCEPTED';},(r:any)=>{r.data.filters.issuerId=999;},(r:any)=>{r.data.privateToken='synthetic-hidden';},(r:any)=>{r.data.netSales[0].payableAmount='999999.00';}]){
    mutate(value=>{const copy=structuredClone(value);change(copy);return copy;});await expect(sdk.dashboard(filters)).rejects.toThrow();
   }
  });
 });
});
