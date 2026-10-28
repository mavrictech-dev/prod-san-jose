import 'reflect-metadata';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { NestFactory } from '../services/integration-export-service/node_modules/@nestjs/core';
import type { NestExpressApplication } from '../services/integration-export-service/node_modules/@nestjs/platform-express';
import { PrivateReadFilter, privateReadBoundary } from '../packages/service-access/src/integration-http';
import { PrivateReadHttp, RemoteReadIdentity } from '../packages/service-access/src/integration';
import { IntegrationIdentityModule, IntegrationErrorFilter } from '../services/identity-service/src/integration/http';
import { BillingReadModule, billingCapturePostPaths } from '../services/billing-service/src/integration/http';
import { BillingCapture } from '../services/billing-service/src/integration/capture';
import { BillingRead } from '../services/billing-service/src/integration/read';
import { SunatReadModule } from '../services/sunat-service/src/integration/http';
import { SunatRead, RemoteBillingOwner } from '../services/sunat-service/src/integration/read';
import { IntegrationReadModule } from '../services/integration-service/src/http';
import { IntegrationReads } from '../services/integration-service/src/read';
import { IntegrationExports } from '../services/integration-export-service/src/core';
import { IntegrationExportModule,exportPostPaths } from '../services/integration-export-service/src/http';
import { exportFixture } from './integration-export.fixture';
import { fixture,basic,ctx } from './integration-identity.fixture';
import { issuerRuc,documentId,secondId } from './integration-read.fixture';
const forge=createRequire(resolve('packages/evidence-core/package.json'))('node-forge');
function certificates() {
  const pki=forge.pki,root=pki.rsa.generateKeyPair(2048),pair=pki.rsa.generateKeyPair(2048),ca=pki.createCertificate();
  ca.publicKey=root.publicKey;ca.serialNumber='01';ca.validity.notBefore=new Date(Date.now()-60000);ca.validity.notAfter=new Date(Date.now()+3600000);
  ca.setSubject([{name:'commonName',value:'Fictitious export CA'}]);ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([{name:'basicConstraints',cA:true},{name:'keyUsage',keyCertSign:true,cRLSign:true}]);ca.sign(root.privateKey,forge.md.sha256.create());
  const leaf=(serial:string,server=false)=>{const c=pki.createCertificate();c.publicKey=pair.publicKey;c.serialNumber=serial;c.validity=ca.validity;
    c.setSubject([{name:'commonName',value:server?'localhost':'fictitious-'+serial}]);c.setIssuer(ca.subject.attributes);
    c.setExtensions([{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},
      {name:'extKeyUsage',serverAuth:server,clientAuth:!server},...(server?[{name:'subjectAltName',altNames:[{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'}]}]:[])]);
    c.sign(root.privateKey,forge.md.sha256.create());return Buffer.from(pki.certificateToPem(c));};
  return {ca:Buffer.from(pki.certificateToPem(ca)),key:Buffer.from(pki.privateKeyToPem(pair.privateKey)),server:leaf('02',true),client:leaf('03'),resource:leaf('04'),rejected:leaf('05')};
}
describe('Phase5 actual five-service HTTPS/mTLS pipeline with fictitious repositories',()=>{
  const f=exportFixture(),id=fixture(),apps:NestExpressApplication[]=[];let tls:ReturnType<typeof certificates>,origin:string,token:string,core:IntegrationExports,made:any;
  const fp=(b:Buffer)=>new X509Certificate(b).fingerprint256.replace(/:/g,'').toLowerCase();
  async function start(module:any,posts:Record<string,number>={},isIdentity=false) {
    const options={cert:tls.server,key:tls.key,ca:tls.ca,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const};
    const app=await NestFactory.create<NestExpressApplication>(module,{logger:false,bodyParser:false,httpsOptions:options});apps.push(app);
    if(isIdentity){app.useBodyParser('json',{limit:'32kb',strict:true});app.useGlobalFilters(new IntegrationErrorFilter());}
    else{app.use(privateReadBoundary(posts));if(Object.keys(posts).length) app.useBodyParser('json',{limit:'4mb',strict:true});app.useGlobalFilters(new PrivateReadFilter());}
    await app.listen(0,'127.0.0.1');return 'https://127.0.0.1:'+app.getHttpServer().address().port;
  }
  beforeAll(async()=>{
    tls=certificates();made=await id.core.create('human-fixture',{label:'ERP fictitious exports',scopes:f.p.scopes,grants:f.p.grants},ctx());
    token=(await id.core.token(basic(made.client.id,made.clientSecret),{grant_type:'client_credentials',scope:f.p.scopes.join(' ')},ctx())).access_token;
    const identityOrigin=await start(IntegrationIdentityModule.isolated(id.core,{token:[fp(tls.client)],admin:[fp(tls.resource)],resource:[fp(tls.resource)]}),{},true);
    const transport={ca:tls.ca,cert:tls.resource,key:tls.key},identity=new RemoteReadIdentity(new PrivateReadHttp(identityOrigin,transport));
    const repository={capture:async(filters:any)=>[...f.rows.values()].filter(r=>r.type!=='DRAFT'&&filters.types.includes(r.immutableSnapshot.documentTypeCode)),
      reauthorize:async(ruc:string,ids:string[])=>ids.map(id=>f.rows.get(id)).filter(Boolean)};
    const billingOrigin=await start(BillingReadModule.isolated(new BillingRead(f.billingRepo,identity),[fp(tls.resource)],new BillingCapture(repository,identity,f.now)),billingCapturePostPaths);
    const billing=new PrivateReadHttp(billingOrigin,transport);
    // Only the fictitious bounded artifact reader, never a mounted fiscal volume.
    const sunat=await start(SunatReadModule.isolated(new SunatRead(f.sunatRepo,identity,new RemoteBillingOwner(billing),{read:async()=>f.bytes}),[fp(tls.resource)]));
    core=new IntegrationExports(f.store,f.vault,identity,billing,new PrivateReadHttp(sunat,transport),f.now);
    const exportOrigin=await start(IntegrationExportModule.isolated(core,identity,billing,[fp(tls.resource)]),exportPostPaths);
    origin=await start(IntegrationReadModule.isolated(new IntegrationReads(identity,billing,new PrivateReadHttp(sunat,transport),f.now,new PrivateReadHttp(exportOrigin,transport)),[fp(tls.client)]),{'/integration/v1/exports':16384});
  },30000);
  afterAll(async()=>{for(const app of apps.reverse())await app.close();});
  function send(path:string,options:{method?:string;body?:unknown;raw?:string;key?:string;bearer?:string;peer?:'client'|'rejected'|null;type?:string}={}) {
    return new Promise<{status:number;body:any;bytes:Buffer;headers:any}>((resolveResult,reject)=>{
      const data=options.raw??(options.body===undefined?undefined:JSON.stringify(options.body)),peer=options.peer===undefined?'client':options.peer;
      const req=request(origin+path,{method:options.method??'GET',ca:tls.ca,rejectUnauthorized:true,...(peer?{cert:tls[peer],key:tls.key}:{}),timeout:15000,
        headers:{Authorization:'Bearer '+(options.bearer??token),...(options.key?{'Idempotency-Key':options.key}:{}),
          ...(data!==undefined?{'Content-Type':options.type??'application/json','Content-Length':Buffer.byteLength(data)}:{})}},res=>{
        const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{const bytes=Buffer.concat(chunks);let body:any;
          try{body=JSON.parse(bytes.toString());}catch{}resolveResult({status:res.statusCode!,body,bytes,headers:res.headers});});
      });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Fixture request timeout')));req.end(data);
    });
  }
  const listQuery=`issuerRuc=${issuerRuc}&from=2026-01-01&to=2026-01-01&types=01,03&limit=1`;
  let exportId:string;
  it('reports snapshot readiness only through configured/capable owner',async()=>{
    const r=await send(`/integration/v1/capabilities?issuerRuc=${issuerRuc}`);expect(r.status).toBe(200);expect(r.body.consistency).toBe('SNAPSHOT_READY');expect(r.body.changes).toBe('NOT_READY');
  });
  it('lists stable paginated rows and resolves same-cut full detail through HTTPS',async()=>{
    const first=await send('/integration/v1/documents?'+listQuery);expect(first.status).toBe(200);expect(first.body.items[0].id).toBe(documentId);
    const second=await send('/integration/v1/documents?'+listQuery+'&cursor='+first.body.page.nextCursor);expect(second.status).toBe(200);expect(second.body.items[0].id).toBe(secondId);
    const d=await send(`/integration/v1/documents/${documentId}?issuerRuc=${issuerRuc}&snapshotId=${first.body.page.snapshotId}`);
    expect(d.status).toBe(200);expect(d.body.detail.items[0].description).toBe('Ítem ficticio');
  });
  it('creates actual 202 asynchronous export with JSON request and header idempotency',async()=>{
    const r=await send('/integration/v1/exports',{method:'POST',key:'http-idempotency-000001',body:f.request});expect(r.status).toBe(202);expect(r.body.state).toBe('QUEUED');exportId=r.body.id;
  });
  it('returns ready manifest and original ZIP through both authorized transports',async()=>{
    await core.runOne();const r=await send(`/integration/v1/exports/${exportId}?issuerRuc=${issuerRuc}`);expect(r.status).toBe(200);expect(r.body.state).toBe('READY');
    expect((await send(`/integration/v1/exports/${exportId}/manifest?issuerRuc=${issuerRuc}`)).body.complete).toBe(true);
    const b=await send(`/integration/v1/exports/${exportId}/content?issuerRuc=${issuerRuc}`);expect(b.status).toBe(200);
    expect(b.bytes.readUInt32LE(0)).toBe(0x04034b50);expect(b.headers['x-content-sha256']).toMatch(/^[a-f0-9]{64}$/);
    expect(b.headers['cache-control']).toBe('private, no-store');expect(b.headers).not.toHaveProperty('access-control-allow-origin');
  });
  it.each(['human-fixture','bogus'])('rejects non M2M bearer %s for create',async bearer=>{
    const r=await send('/integration/v1/exports',{method:'POST',key:'http-another-key-00001',body:f.request,bearer});
    expect(r.status).toBe(401);expect(r.headers['www-authenticate']).toBe('Bearer realm="factuez-integration"');
  });
  it.each([{key:undefined,body:f.request},{key:'short',body:f.request},{key:'http-badrequest-00001',body:{...f.request,administrator:true}}])('rejects invalid keys/body %j',async options=>{
    expect((await send('/integration/v1/exports',{method:'POST',...options})).status).toBe(400);
  });
  it('blocks unknown POST routes and bodies on GET, without turning API into write gateway',async()=>{
    expect((await send('/integration/v1/documents',{method:'POST',body:f.request})).status).toBe(400);
    expect((await send('/integration/v1/documents?'+listQuery,{body:{emit:true}})).status).toBe(400);
    expect((await send('/integration/v1/exports',{method:'POST',body:f.request,key:'http-wrong-type-00001',type:'text/plain'})).status).toBe(400);
  });
  it('rejects oversized, malformed and ambiguous requests without leaking internal errors',async()=>{
    for(const options of [{raw:'{broken',key:'http-invalid-json-0001'},{raw:' '.repeat(17000),key:'http-oversized-000001'}]){
      const r=await send('/integration/v1/exports',{method:'POST',...options});expect(r.status).toBe(400);expect(r.bytes.toString()).not.toContain('SyntaxError');
    }
    expect((await send('/integration/v1/documents?'+listQuery+'&issuerRuc='+issuerRuc)).status).toBe(400);
  });
  it('requires mTLS and approved peers for exports as well as documents',async()=>{
    expect((await send('/integration/v1/documents?'+listQuery,{peer:'rejected'})).status).toBe(403);
    await expect(send('/integration/v1/documents?'+listQuery,{peer:null})).rejects.toThrow();
  });
  it('sanitizes audit errors before returning any ZIP body',async()=>{
    f.store.audit.mockRejectedValueOnce(new Error('sensitive-password-fake'));
    const r=await send(`/integration/v1/exports/${exportId}/content?issuerRuc=${issuerRuc}`);expect(r.status).toBe(503);
    expect(r.bytes.toString()).not.toContain('sensitive-password');expect(r.bytes.subarray(0,2).toString()).not.toBe('PK');
  });
  it('real identity revocation immediately denies cached ready content',async()=>{
    await id.core.change('human-fixture',made.client.id,{expectedRevision:1,enabled:false},ctx(),false);
    expect((await send(`/integration/v1/exports/${exportId}/content?issuerRuc=${issuerRuc}`)).status).toBe(401);
  });
});
