import 'reflect-metadata';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { request } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { NestFactory } from '../services/billing-service/node_modules/@nestjs/core';
import { createB2bIdentityApplication } from '../services/identity-service/src/b2b/application';
import { createB2bReadApplication } from '../services/b2b-api-service/src/application';
import { B2bReads,HttpB2bReadOwner } from '../services/b2b-api-service/src/read';
import { B2bReadErrorFilter } from '../services/b2b-api-service/src/http';
import { B2bBillingReadModule } from '../services/billing-service/src/b2b/read-http';
import { B2bSunatReadModule } from '../services/sunat-service/src/b2b/http';
import { HttpB2bBillingPort } from '../services/sunat-service/src/b2b/read';
import { B2bPrivateHttp,B2bIdentityHttp } from '../packages/service-access/src/b2b';
import { b2bReadFixture } from './b2b-read.fixture';
import { documentId,artifactId } from './integration-read.fixture';
import { ctx } from './b2b-identity.fixture';
const forge=createRequire(resolve('packages/evidence-core/package.json'))('node-forge');
function certificates(){
  const pki=forge.pki,root=pki.rsa.generateKeyPair(2048),leaf=pki.rsa.generateKeyPair(2048),ca=pki.createCertificate();
  ca.publicKey=root.publicKey;ca.serialNumber='01';ca.validity.notBefore=new Date(Date.now()-60000);ca.validity.notAfter=new Date(Date.now()+3600000);
  ca.setSubject([{name:'commonName',value:'SYNTHETIC B2B READ ONLY CA'}]);ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([{name:'basicConstraints',cA:true},{name:'keyUsage',keyCertSign:true,cRLSign:true}]);ca.sign(root.privateKey,forge.md.sha256.create());
  const make=(serial:string,server=false)=>{const c=pki.createCertificate();c.publicKey=leaf.publicKey;c.serialNumber=serial;c.validity.notBefore=ca.validity.notBefore;c.validity.notAfter=ca.validity.notAfter;
    c.setSubject([{name:'commonName',value:server?'localhost':'synthetic-reader-'+serial}]);c.setIssuer(ca.subject.attributes);
    c.setExtensions([{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},{name:'extKeyUsage',serverAuth:server,clientAuth:!server},...(server?[{name:'subjectAltName',altNames:[{type:7,ip:'127.0.0.1'},{type:2,value:'localhost'}]}]:[])]);
    c.sign(root.privateKey,forge.md.sha256.create());return Buffer.from(pki.certificateToPem(c));};
  return {ca:Buffer.from(pki.certificateToPem(ca)),key:Buffer.from(pki.privateKeyToPem(leaf.privateKey)),server:make('02',true),resource:make('03'),edge:make('04'),other:make('05')};
}
describe('B2B-03 actual four-service mTLS synthetic chain',()=>{
  const apps:any[]=[];let f:Awaited<ReturnType<typeof b2bReadFixture>>,tls:ReturnType<typeof certificates>,facadePort:number,billingPort:number,sunatPort:number;
  const fp=(cert:Buffer)=>new X509Certificate(cert).fingerprint256.replace(/:/g,'').toLowerCase();
  const port=(app:any)=>app.getHttpServer().address().port;
  beforeAll(async()=>{
    f=await b2bReadFixture();tls=certificates();const options={ca:tls.ca,cert:tls.server,key:tls.key};
    const auth=await createB2bIdentityApplication(f.auth.core,{token:[fp(tls.resource)],resource:[fp(tls.resource)],admin:[fp(tls.other)]},options);apps.push(auth);await auth.listen(0,'127.0.0.1');
    const http=(p:number)=>new B2bPrivateHttp(`https://127.0.0.1:${p}`,{ca:tls.ca,cert:tls.resource,key:tls.key});
    const identity=new B2bIdentityHttp(http(port(auth)));f.identity.authenticate.mockImplementation((t,s,k)=>identity.authenticate(t,s,k));
    for(const module of [B2bBillingReadModule.isolated(f.billing,[fp(tls.resource)]),B2bSunatReadModule.isolated(f.fiscal,[fp(tls.resource)])]){
      const app=await NestFactory.create(module,{logger:false,httpsOptions:{...options,requestCert:true,rejectUnauthorized:true}});apps.push(app);app.useGlobalFilters(new B2bReadErrorFilter());await app.listen(0,'127.0.0.1');
    }
    billingPort=port(apps[1]);sunatPort=port(apps[2]);const billing=new HttpB2bBillingPort(http(billingPort));
    f.billingPort.execute.mockImplementation((t,k,a,args)=>billing.execute(t,k,a,args));
    const core=new B2bReads(identity,new HttpB2bReadOwner(http(billingPort)),new HttpB2bReadOwner(http(sunatPort),true));
    const facade=await createB2bReadApplication(core,[fp(tls.edge)],options);apps.push(facade);await facade.listen(0,'127.0.0.1');facadePort=port(facade);
  },30000);
  afterAll(async()=>{for(const app of apps.reverse())await app.close();f?.close();});
  async function send(path:string,peer:'edge'|'resource'|'other'|null='edge',method='GET',target=facadePort,body?:string){
    return new Promise<{status:number;body:any;bytes:Buffer;headers:any}>((done,reject)=>{
      const req=request({hostname:'127.0.0.1',port:target,path,method,ca:tls.ca,rejectUnauthorized:true,...(peer?{cert:tls[peer],key:tls.key}:{}),timeout:5000,
        headers:{Authorization:'Bearer '+f.token,...(body?{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body))}:{})}},res=>{
          const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{const bytes=Buffer.concat(chunks);try{done({status:res.statusCode!,bytes,body:res.headers['content-type']?.includes('application/json')?JSON.parse(bytes.toString()):null,headers:res.headers});}catch(e){reject(e);}});
        });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('timeout')));req.end(body);
    });
  }
  const query='?issuerId=1&environment=BETA';
  it('selects only authorized series through facade -> Billing -> Identity',async()=>{
    const result=await send('/b2b/v1/series'+query);expect(result.status).toBe(200);expect(result.body.items).toHaveLength(2);expect(result.headers['cache-control']).toBe('private, no-store');
  });
  it('returns full immutable document detail and strict status',async()=>{
    const result=await send('/b2b/v1/documents/'+documentId+query);expect(result.status).toBe(200);expect(result.body.detail.items).toHaveLength(1);expect(result.body.state.fiscal).toBe('NOT_VERIFIED');
  });
  it('downloads original XML via SUNAT owner, matching hash/length without keys',async()=>{
    const meta=await send('/b2b/v1/documents/'+documentId+'/artifacts'+query);expect(meta.status).toBe(200);expect(JSON.stringify(meta.body)).not.toContain('storageKey');
    const file=await send('/b2b/v1/artifacts/'+artifactId+'/content'+query);expect(file.status).toBe(200);expect(file.bytes).toEqual(f.old.bytes);expect(file.headers['x-content-sha256']).toBe(f.old.artifact.sha256);expect(Number(file.headers['content-length'])).toBe(f.old.bytes.length);
  });
  it('generates temporary local PDF through current owner profile',async()=>{
    const result=await send('/b2b/v1/documents/'+documentId+'/representations/ticket'+query);expect(result.status).toBe(200);expect(result.headers['content-type']).toContain('application/pdf');expect(result.headers['content-disposition']).toContain('CURRENT-PRUEBA.pdf');expect(result.bytes.subarray(0,4).toString()).toBe('%PDF');
  });
  it('rejects production, duplicate query parameters, mixed RUC, unsupported source and writes',async()=>{
    expect((await send('/b2b/v1/documents/'+documentId+'?issuerId=1&environment=PRODUCTION')).status).toBe(400);
    expect((await send('/b2b/v1/documents/'+documentId+query+'&issuerId=2')).status).toBe(400);
    expect((await send('/b2b/v1/documents/'+documentId+'?issuerId=2&environment=BETA')).status).toBe(404);
    expect((await send('/b2b/v1/documents'+query+'&from=2026-01-01&to=2026-01-02&types=31')).status).toBe(422);
    expect((await send('/b2b/v1/document-drafts','edge','POST',facadePort,'{}')).status).toBe(400);
  });
  it('separates edge/owner peers and rejects a missing client certificate',async()=>{
    expect((await send('/b2b/v1/me','other')).status).toBe(403);await expect(send('/b2b/v1/me',null)).rejects.toThrow();
    expect((await send('/internal/b2b/read','edge','POST',billingPort,JSON.stringify({kind:'SERVICE',action:'catalog',args:{environment:'BETA'}}))).status).toBe(403);
  });
  it('client revocation immediately prevents the next download over every hop',async()=>{
    await f.auth.core.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());
    expect((await send('/b2b/v1/artifacts/'+artifactId+'/content'+query)).status).toBe(401);
  });
});
