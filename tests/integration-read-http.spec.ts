import 'reflect-metadata';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { NestFactory } from '../services/integration-service/node_modules/@nestjs/core';
import type { NestExpressApplication } from '../services/integration-service/node_modules/@nestjs/platform-express';
import { PrivateReadFilter,privateReadBoundary } from '../packages/service-access/src/integration-http';
import { PrivateReadHttp, RemoteReadIdentity } from '../packages/service-access/src/integration';
import { IntegrationIdentityModule, IntegrationErrorFilter } from '../services/identity-service/src/integration/http';
import { BillingReadModule } from '../services/billing-service/src/integration/http';
import { BillingRead } from '../services/billing-service/src/integration/read';
import { SunatReadModule } from '../services/sunat-service/src/integration/http';
import { SunatRead, RemoteBillingOwner } from '../services/sunat-service/src/integration/read';
import { IntegrationReadModule } from '../services/integration-service/src/http';
import { IntegrationReads } from '../services/integration-service/src/read';
import { fixture, basic, ctx } from './integration-identity.fixture';
import { readFixture, principal, issuerRuc, otherRuc, documentId, artifactId, batchId, branchId } from './integration-read.fixture';
const forge=createRequire(resolve('packages/evidence-core/package.json'))('node-forge');
function certificateFixture() {
  const pki=forge.pki,root=pki.rsa.generateKeyPair(2048),pair=pki.rsa.generateKeyPair(2048);
  const ca=pki.createCertificate();ca.publicKey=root.publicKey;ca.serialNumber='01';
  ca.validity.notBefore=new Date(Date.now()-60000);ca.validity.notAfter=new Date(Date.now()+3600000);
  ca.setSubject([{name:'commonName',value:'Fictitious phase4 CA'}]);ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([{name:'basicConstraints',cA:true},{name:'keyUsage',keyCertSign:true,cRLSign:true}]);ca.sign(root.privateKey,forge.md.sha256.create());
  const leaf=(serial:string,server=false)=>{
    const c=pki.createCertificate();c.publicKey=pair.publicKey;c.serialNumber=serial;c.validity=ca.validity;
    c.setSubject([{name:'commonName',value:server?'localhost':'fictitious-client-'+serial}]);c.setIssuer(ca.subject.attributes);
    c.setExtensions([{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},
      {name:'extKeyUsage',serverAuth:server,clientAuth:!server},...(server?[{name:'subjectAltName',altNames:[{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'}]}]:[])]);
    c.sign(root.privateKey,forge.md.sha256.create());return Buffer.from(pki.certificateToPem(c));
  };
  return {ca:Buffer.from(pki.certificateToPem(ca)),key:Buffer.from(pki.privateKeyToPem(pair.privateKey)),server:leaf('02',true),
    client:leaf('03'),resource:leaf('04'),rejected:leaf('05')};
}
describe('Phase4 real HTTPS: identity → integration → owners, fixture repositories only',()=>{
  const f=readFixture(),id=fixture(),apps:NestExpressApplication[]=[];
  let tls:ReturnType<typeof certificateFixture>,origin:string,token:string,made:Awaited<ReturnType<typeof id.core.create>>;
  const fingerprint=(cert:Buffer)=>new X509Certificate(cert).fingerprint256.replace(/:/g,'').toLowerCase();
  async function start(module:any,identity=false) {
    const options={cert:tls.server,key:tls.key,ca:tls.ca,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const};
    const app=await NestFactory.create<NestExpressApplication>(module,{logger:false,bodyParser:false,httpsOptions:options});
    apps.push(app);if(identity) {app.useBodyParser('json',{limit:'32kb',strict:true});app.useGlobalFilters(new IntegrationErrorFilter());}
    else {app.use(privateReadBoundary());app.useGlobalFilters(new PrivateReadFilter());}
    await app.listen(0,'127.0.0.1');return 'https://127.0.0.1:'+app.getHttpServer().address().port;
  }
  beforeAll(async()=>{
    tls=certificateFixture();const p=principal();
    made=await id.core.create('human-fixture',{label:'ERP ficticio fase4',scopes:p.scopes,grants:p.grants},ctx());
    token=(await id.core.token(basic(made.client.id,made.clientSecret),{grant_type:'client_credentials',scope:p.scopes.join(' ')},ctx())).access_token;
    const identityOrigin=await start(IntegrationIdentityModule.isolated(id.core,{token:[fingerprint(tls.client)],admin:[fingerprint(tls.resource)],resource:[fingerprint(tls.resource)]}),true);
    const transport={ca:tls.ca,cert:tls.resource,key:tls.key};
    const identity=new RemoteReadIdentity(new PrivateReadHttp(identityOrigin,transport));
    const billingOrigin=await start(BillingReadModule.isolated(new BillingRead(f.billingRepo,identity),[fingerprint(tls.resource)]));
    const billingHttp=new PrivateReadHttp(billingOrigin,transport);
    const sunatOrigin=await start(SunatReadModule.isolated(new SunatRead(f.sunatRepo,identity,new RemoteBillingOwner(billingHttp),f.store),[fingerprint(tls.resource)]));
    origin=await start(IntegrationReadModule.isolated(new IntegrationReads(identity,billingHttp,new PrivateReadHttp(sunatOrigin,transport)),[fingerprint(tls.client)]));
  },30000);
  afterAll(async()=>{for(const app of apps.reverse()) await app.close();});
  function send(path:string,options:{bearer?:string;peer?:'client'|'rejected'|null;trust?:boolean;method?:string}={}) {
    return new Promise<{status:number;bytes:Buffer;headers:any;body:any}>((resolveResult,reject)=>{
      const peer=options.peer===undefined?'client':options.peer;
      const req=request(origin+path,{method:options.method??'GET',rejectUnauthorized:true,
        ...(options.trust===false?{}:{ca:tls.ca}),...(peer?{cert:tls[peer],key:tls.key}:{}),timeout:10000,
        headers:{Authorization:'Bearer '+(options.bearer??token),'X-Forwarded-Proto':'https','X-User-Id':'administrator'}},res=>{
        const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{
          const bytes=Buffer.concat(chunks);let body:any;try{body=JSON.parse(bytes.toString());}catch{}
          resolveResult({status:res.statusCode!,bytes,headers:res.headers,body});
        });
      });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Fixture request timeout')));req.end();
    });
  }
  it('reads frozen full item detail through all authenticated owner boundaries',async()=>{
    const r=await send(`/integration/v1/documents/${documentId}?issuerRuc=${issuerRuc}`);expect(r.status).toBe(200);
    expect(r.body.detail.items[0].unitValue).toBe('100.123456');expect(r.body.state.fiscal).toBe('NOT_CHECKED');
    expect(r.headers['cache-control']).toBe('private, no-store');expect(r.headers).not.toHaveProperty('access-control-allow-origin');
  });
  it('performs exact fiscal lookup without rounding number or copying human identity',async()=>{
    const r=await send(`/integration/v1/documents/lookup?issuerRuc=${issuerRuc}&type=01&series=F001&number=1`);
    expect(r.status).toBe(200);expect(r.body.number).toBe('00000001');
  });
  it('returns inventory with no paths, embedded contents or credentials',async()=>{
    const r=await send(`/integration/v1/documents/${documentId}/artifacts?issuerRuc=${issuerRuc}`);expect(r.status).toBe(200);
    expect(r.body.items[0].id).toBe(artifactId);expect(r.bytes.toString()).not.toContain('storageKey');expect(r.bytes.toString()).not.toContain(made.clientSecret);
  });
  it('downloads complete original bytes with contract checksum and safe filename',async()=>{
    const r=await send(`/integration/v1/artifacts/${artifactId}/content?issuerRuc=${issuerRuc}`);expect(r.status).toBe(200);
    expect(r.bytes).toEqual(f.bytes);expect(r.headers['x-content-sha256']).toBe(f.artifact.sha256);
    expect(r.headers['content-disposition']).toContain('20555555555-01-F001-00000001-SIGNED_XML.xml');expect(f.sunatRepo.audit).toHaveBeenCalled();
  });
  it('reads full legacy singleton RC without changing fiscal state',async()=>{
    const r=await send(`/integration/v1/batches/${batchId}?issuerRuc=${issuerRuc}`);expect(r.status).toBe(200);expect(r.body.membersComplete).toBe(true);
  });
  it.each(['issuers','branches','points'])('catalog %s uses private owner source and no counters',async kind=>{
    const r=await send(`/integration/v1/${kind}`+(kind==='issuers'?'':`?issuerRuc=${issuerRuc}`+(kind==='points'?`&branchId=${branchId}`:'')));
    expect(r.status).toBe(200);expect(r.body.items).toHaveLength(1);expect(r.bytes.toString()).not.toContain('nextNumber');
  });
  it.each(['human-fixture','bogus'])('does not accept human/forged bearer %s',async bearer=>{
    const r=await send(`/integration/v1/documents/${documentId}?issuerRuc=${issuerRuc}`,{bearer});expect(r.status).toBe(401);
  });
  it('refuses unapproved client certificate despite forwarded identity headers',async()=>{
    const r=await send(`/integration/v1/documents/${documentId}?issuerRuc=${issuerRuc}`,{peer:'rejected'});expect(r.status).toBe(403);
  });
  it('requires authentic TLS on both sides and rejects absent mTLS',async()=>{
    await expect(send('/integration/v1/issuers',{peer:null})).rejects.toThrow();
    await expect(send('/integration/v1/issuers',{trust:false})).rejects.toThrow();
  });
  it.each([`issuerRuc=${otherRuc}`,`issuerRuc=${issuerRuc}&environment=PRODUCTION`,`issuerRuc=${issuerRuc}&issuerRuc=${otherRuc}`])('blocks forbidden query %s',async query=>{
    const r=await send(`/integration/v1/documents/${documentId}?${query}`);expect([400,404]).toContain(r.status);
    expect(r.body.error).toHaveProperty('code');expect(r.bytes.toString()).not.toContain('prisma');
  });
  it('reports absent GR/GT sources honestly',async()=>{
    const r=await send(`/integration/v1/capabilities?issuerRuc=${issuerRuc}`);expect(r.status).toBe(200);
    expect(r.body.types.filter((t:any)=>['09','31'].includes(t.type)).every((t:any)=>t.readState==='UNSUPPORTED')).toBe(true);
  });
  it('never exposes emission/write routes or document exports from later phases',async()=>{
    expect((await send('/integration/v1/documents',{method:'POST'})).status).not.toBe(200);
    expect((await send('/integration/v1/exports')).status).not.toBe(200);
  });
  it('an unavailable receipt audit prevents successful binary response',async()=>{
    f.sunatRepo.audit.mockRejectedValueOnce(new Error('sensitive fake database details'));
    const r=await send(`/integration/v1/artifacts/${artifactId}/content?issuerRuc=${issuerRuc}`);expect(r.status).toBe(503);
    expect(r.bytes.toString()).not.toContain('sensitive fake');expect(r.bytes.toString()).not.toContain('FICTITIOUS-NOT-OFFICIAL');
  });
  it('client revocation is seen immediately without restarting owners',async()=>{
    await id.core.change('human-fixture',made.client.id,{expectedRevision:made.client.revision,enabled:false},ctx());
    const r=await send(`/integration/v1/documents/${documentId}?issuerRuc=${issuerRuc}`);expect(r.status).toBe(401);
  });
});
