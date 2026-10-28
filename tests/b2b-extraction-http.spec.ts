import 'reflect-metadata';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { request } from 'node:https';
import { NestFactory } from '../services/billing-service/node_modules/@nestjs/core';
import { createB2bIdentityApplication } from '../services/identity-service/src/b2b/application';
import { B2bBillingReadModule } from '../services/billing-service/src/b2b/read-http';
import { B2bSunatReadModule } from '../services/sunat-service/src/b2b/http';
import { B2bExtractionOwnerModule } from '../services/integration-export-service/src/b2b/http';
import { HttpB2bExtractionOwner } from '../services/integration-export-service/src/b2b/core';
import { B2bReadErrorFilter } from '../services/b2b-api-service/src/http';
import { createB2bDraftApplication } from '../services/b2b-api-service/src/draft-application';
import { B2bReads } from '../services/b2b-api-service/src/read';
import { B2bCommands } from '../services/b2b-api-service/src/commands';
import { B2bExports,HttpB2bExportPort } from '../services/b2b-api-service/src/extraction';
import { B2bPrivateHttp,B2bIdentityHttp } from '../packages/service-access/src/b2b';
import { b2bCertificates,fingerprint as fp } from './b2b-tls.fixture';
import { b2bExtractionFixture } from './b2b-extraction.fixture';
import { documentId } from './integration-read.fixture';
import { ctx } from './b2b-identity.fixture';
describe('B2B-03 five-service actual mTLS export/feed chain',()=>{
  const apps:any[]=[];let tls:ReturnType<typeof b2bCertificates>,f:Awaited<ReturnType<typeof b2bExtractionFixture>>,port:number,exportId:string,checkpoint:string;
  beforeAll(async()=>{
    tls=b2bCertificates();f=await b2bExtractionFixture();const options={ca:tls.ca,cert:tls.server,key:tls.key};
    const auth=await createB2bIdentityApplication(f.auth.core,{token:[fp(tls.resource)],resource:[fp(tls.resource)],admin:[fp(tls.other)]},options);apps.push(auth);await auth.listen(0,'127.0.0.1');
    const http=(p:number)=>new B2bPrivateHttp('https://127.0.0.1:'+p,{ca:tls.ca,cert:tls.resource,key:tls.key});
    const identity=new B2bIdentityHttp(http(auth.getHttpServer().address().port));f.identity.authenticate.mockImplementation((t,s,k)=>identity.authenticate(t,s,k));
    for(const module of [B2bBillingReadModule.isolated(f.billing,[fp(tls.resource)]),B2bSunatReadModule.isolated(f.sunat,[fp(tls.resource)]),B2bExtractionOwnerModule.isolated(f.core,[fp(tls.resource)])]){
      const app=await NestFactory.create(module,{logger:false,httpsOptions:{...options,requestCert:true,rejectUnauthorized:true}});apps.push(app);app.useGlobalFilters(new B2bReadErrorFilter());await app.listen(0,'127.0.0.1');
    }
    const billing=new HttpB2bExtractionOwner(http(apps[1].getHttpServer().address().port)),fiscal=new HttpB2bExtractionOwner(http(apps[2].getHttpServer().address().port),true);
    f.billingPort.execute.mockImplementation((t,k,a,args)=>billing.execute(t,k,a,args));f.fiscal.execute.mockImplementation((t,k,a,args)=>fiscal.execute(t,k,a,args));f.fiscal.file.mockImplementation((t,k,a,args)=>fiscal.file(t,k,a,args));
    const reads=new B2bReads(identity,billing,fiscal),commands=new B2bCommands(identity,{execute:async()=>{throw new Error('Drafts not bound in extraction test');}});
    const exports=new B2bExports(identity,new HttpB2bExportPort(http(apps[3].getHttpServer().address().port)));
    const facade=await createB2bDraftApplication(reads,commands,[fp(tls.edge)],options,exports);apps.push(facade);await facade.listen(0,'127.0.0.1');port=facade.getHttpServer().address().port;
  },30000);
  afterAll(async()=>{for(const app of apps.reverse())await app.close();});
  const q='?issuerId=1&environment=BETA';
  async function send(path:string,method='GET',body?:any,headers:Record<string,string>={}){
    const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));return new Promise<{status:number;body:any;bytes:Buffer;headers:any}>((done,reject)=>{
      const req=request({hostname:'127.0.0.1',port,path,method,ca:tls.ca,cert:tls.edge,key:tls.key,rejectUnauthorized:true,timeout:10000,headers:{Authorization:'Bearer '+f.token,...(bytes?{'Content-Type':'application/json','Content-Length':String(bytes.length)}:{}),...headers}},res=>{
        const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{const bytes=Buffer.concat(chunks);try{done({status:res.statusCode!,bytes,body:res.headers['content-type']?.includes('application/json')?JSON.parse(bytes.toString()):null,headers:res.headers});}catch(e){reject(e);}});
      });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('timeout')));req.end(bytes);
    });
  }
  it('advertises only configured and scoped capabilities, not emission',async()=>{
    const r=await send('/b2b/v1/capabilities?environment=BETA');expect(r.status).toBe(200);expect(r.body.features.find((v:any)=>v.id==='exports').state).toBe('ENABLED');expect(r.body.features.find((v:any)=>v.id==='issue').state).toBe('DISABLED');
  });
  it('obtains durable initial cut and reads its frozen item details',async()=>{
    const r=await send('/b2b/v1/document-cuts'+q+'&from=2026-01-01&to=2026-01-01&types=01,03&limit=1');expect(r.status).toBe(200);checkpoint=r.body.payload.page.changeCheckpoint;expect(checkpoint).toBeTruthy();
    const detail=await send('/b2b/v1/document-cuts/'+r.body.payload.page.snapshotId+'/documents/'+documentId+q);expect(detail.status).toBe(200);expect(detail.body.payload.detail.items).toHaveLength(1);
  });
  it('creates and recovers one export, packages original XML and downloads exact ZIP through five services',async()=>{
    const key={'Idempotency-Key':'synthetic_http_export_001'},made=await send('/b2b/v1/exports'+q,'POST',f.request,key);expect(made.status).toBe(202);exportId=made.body.payload.id;
    const retry=await send('/b2b/v1/exports'+q,'POST',f.request,key);expect(retry.body.payload.id).toBe(exportId);expect(f.persistence.exports.records.size).toBe(2); // one cut + one export
    await f.core.runOne();const manifest=await send('/b2b/v1/exports/'+exportId+'/manifest'+q);expect(manifest.status).toBe(200);expect(manifest.body.payload.complete).toBe(true);
    const file=await send('/b2b/v1/exports/'+exportId+'/content'+q);expect(file.status).toBe(200);expect(file.bytes.subarray(0,2).toString()).toBe('PK');expect(file.headers['content-type']).toBe('application/zip');expect(file.headers['x-content-sha256']).toMatch(/^[a-f0-9]{64}$/);
    expect(f.old.identity.authenticate).not.toHaveBeenCalled(); // no B2B bearer reaches the legacy audience
  });
  it('returns journal events without fabricating fiscal acceptance',async()=>{
    f.old.append('SUNAT','ARTIFACT_ADDED',documentId);const r=await send('/b2b/v1/changes'+q+'&checkpoint='+encodeURIComponent(checkpoint));expect(r.status).toBe(200);expect(r.body.payload.items[0].kind).toBe('ARTIFACT_ADDED');expect(JSON.stringify(r.body)).not.toContain('ACCEPTED_VERIFIED');
  });
  it('rejects production and unauthorized issuer for persistent operations',async()=>{
    expect((await send('/b2b/v1/exports/'+exportId+'?issuerId=2&environment=BETA')).status).toBe(404);
    expect((await send('/b2b/v1/exports'+q,'POST',{...f.request,filters:{...f.request.filters,environment:'PRODUCTION'}},{'Idempotency-Key':'synthetic_http_bad_001'})).status).toBe(400);
  });
  it('revocation blocks already prepared packages',async()=>{
    await f.auth.core.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());expect((await send('/b2b/v1/exports/'+exportId+'/content'+q)).status).toBe(401);
  });
});
