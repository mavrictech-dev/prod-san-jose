import 'reflect-metadata';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {request} from 'node:https';
import {NestFactory} from '../services/received-documents-service/node_modules/@nestjs/core';
import {B2bReceptionReadModule} from '../services/received-documents-service/src/b2b/http';
import {B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {B2bReceivedReads,HttpB2bReceivedOwner} from '../services/b2b-api-service/src/received';
import {B2bReads} from '../services/b2b-api-service/src/read';
import {B2bCommands} from '../services/b2b-api-service/src/commands';
import {createB2bPhase8Application} from '../services/b2b-api-service/src/phase8-application';
import {b2bReceivedFixture,receivedId} from './helpers/b2b-received.fixture';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {FactuEzB2bClient} from '../packages/b2b-sdk/src/index';

/** Real TLS/parser/controllers/facade/owner/parser. Identity, grants and storage
 * are explicit synthetic ports here; the separate DB runner proves persistence. */
describe('phase08 TLS consumer → candidate factory → private reception owner',()=>{
  let tls:ReturnType<typeof b2bCertificates>,ownerApp:any,app:any,port:number,f:ReturnType<typeof b2bReceivedFixture>;
  const identity={authenticate:(...a:Parameters<ReturnType<typeof b2bReceivedFixture>['identity']['authenticate']>)=>f.identity.authenticate(...a)};
  const absent={execute:async()=>{throw new Error('OWNER_UNCONFIGURED');},file:async()=>{throw new Error('OWNER_UNCONFIGURED');}};
  const probes={issue:async()=>{throw new Error('NOT_THIS_TEST');},read:async()=>{throw new Error('NOT_THIS_TEST');},ready:async()=>{throw new Error('NOT_THIS_TEST');},
    view:async()=>{throw new Error('NOT_THIS_TEST');},content:async()=>{throw new Error('NOT_THIS_TEST');},execute:async()=>{throw new Error('NOT_THIS_TEST');}};
  beforeEach(async()=>{f=b2bReceivedFixture();f.principal.scopes.push('b2b:context:read');await f.grant('READ');await f.grant('ARTIFACT');});
  beforeAll(async()=>{
    tls=b2bCertificates();const options={ca:tls.ca,cert:tls.server,key:tls.key};
    ownerApp=await NestFactory.create(B2bReceptionReadModule.isolated({execute:(...a:any[])=>f.owner.execute(...a as Parameters<typeof f.owner.execute>)} as any,[fingerprint(tls.resource)]),
      {logger:false,bodyParser:false,httpsOptions:{...options,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2'}});
    ownerApp.useBodyParser('json',{limit:16384,strict:true});await ownerApp.listen(0,'127.0.0.1');
    const http=new B2bPrivateHttp(`https://127.0.0.1:${ownerApp.getHttpServer().address().port}`,{ca:tls.ca,cert:tls.resource,key:tls.key});
    app=await createB2bPhase8Application({read:new B2bReads(identity as any,absent,absent),commands:new B2bCommands(identity as any,absent),
      peers:[fingerprint(tls.edge)],tls:options,phase7:{guideIssuance:probes,guideArtifacts:probes,carrier:probes,batches:probes,batchArtifacts:probes} as any,
      phase8:{received:new B2bReceivedReads(identity as any,new HttpB2bReceivedOwner(http))}});
    await app.listen(0,'127.0.0.1');port=app.getHttpServer().address().port;
  },30000);
  afterAll(async()=>{await app?.close();await ownerApp?.close();});
  const base='/b2b/v1/received-documents',query=()=>'?'+new URLSearchParams(Object.entries(f.scope).map(([k,v])=>[k,String(v)])).toString();
  function send(path:string,peer:'edge'|'other'='edge',method='GET',body?:unknown){
    const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    return new Promise<{status:number;body:any;bytes:Buffer;headers:any}>((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port,path,method,ca:tls.ca,cert:tls[peer],key:tls.key,rejectUnauthorized:true,
        headers:{Authorization:'Bearer '+f.token,'X-FactuEz-Actor-Kind':'SERVICE',...(bytes?{'Content-Type':'application/json','Content-Length':String(bytes.length)}:{})}},res=>{
        const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const bytes=Buffer.concat(chunks);try{resolve({status:res.statusCode!,headers:res.headers,bytes,
          body:String(res.headers['content-type']).startsWith('application/json')?JSON.parse(bytes.toString()):null});}catch(e){reject(e);}});
      });req.on('error',reject);req.end(bytes);
    });
  }
  it('announces only configured reads, not import, SIRE or official acceptance',async()=>{
    const r=await send('/b2b/v1/capabilities?environment=BETA');expect(r.status).toBe(200);
    expect(r.body.features.find((v:any)=>v.id==='received-documents').state).toBe('ENABLED');
    expect(r.body.receivedCoverage).toEqual({source:'RECEIVED_XML_ONLY',unassigned:false,sireOnlyFindings:false,officialTrust:false});
    expect(r.body.fiscalActivation).toBe(false);expect(r.body.features.find((v:any)=>v.id==='customers').state).toBe('NOT_IMPLEMENTED');
  });
  it('lists and reads complete XML item/tax data across both actual controllers',async()=>{
    const list=await send(base+query()+'&from=2026-01-01&to=2026-01-02&limit=1');expect(list.status).toBe(200);expect(list.body.items[0].id).toBe(f.id);
    const detail=await send(base+'/'+f.id+query());expect(detail.status).toBe(200);expect(detail.body.projection.items[0].unitValue).toBe('20.000000');
    expect(detail.body.projection.items[0].taxes[0].amount).toBe('18.00');expect(detail.body.fiscalAcceptance).toBe('NOT_VERIFIED');
    expect(detail.headers['cache-control']).toBe('private, no-store');expect(JSON.stringify(detail.body)).not.toMatch(/storageKey|grantKey|secretHash|authRevision/);
  });
  it('downloads exact XML, CDR and PDF with safe Unicode provider filenames',async()=>{
    const m=await send(base+'/'+f.id+'/artifacts'+query());expect(m.status).toBe(200);expect(m.body.items).toHaveLength(3);
    for(const a of f.state.originals){
      const r=await send(base+'/'+f.id+'/artifacts/'+a.id+'/content'+query());expect(r.status).toBe(200);expect(r.bytes).toEqual(a.bytes);
      expect(r.headers['x-content-sha256']).toBe(a.sha256);expect(r.headers['x-factuez-source']).toBe('RECEIVED_ORIGINAL');
      expect(r.headers['content-disposition']).toContain('filename*=UTF-8');expect(r.headers['content-security-policy']).toContain('sandbox');
      if(a.kind==='PROVIDER_PDF')expect(r.headers['content-disposition']).toContain('San%20Jos%C3%A9.pdf');
    }
  });
  it('SDK consumes the actual candidate facade and private owner without translation',async()=>{
    let tokens=0;
    const sdk=new FactuEzB2bClient({origin:`https://127.0.0.1:${port}`,
      tls:{ca:Buffer.from(tls.ca),cert:Buffer.from(tls.edge),key:Buffer.from(tls.key),serverCertificateSha256:fingerprint(tls.server)},
      bearer:async()=>{tokens++;return {token:f.token,actorKind:'SERVICE'};}});
    expect((await sdk.capabilities()).receivedCoverage?.source).toBe('RECEIVED_XML_ONLY');
    expect((await sdk.listReceived(f.query)).items[0].id).toBe(f.id);
    expect((await sdk.detail(f.scope,f.id)).projection.items[0].unitValue).toBe('20.000000');
    expect((await sdk.artifactManifest(f.scope,f.id)).items).toHaveLength(3);
    for(const [kind,run]of [['XML',()=>sdk.downloadXML(f.scope,f.id)],['CDR',()=>sdk.downloadCDR(f.scope,f.id)],
      ['PROVIDER_PDF',()=>sdk.downloadProviderPDF(f.scope,f.id)]] as const){
      const result=await run(),original=f.state.originals.find(a=>a.kind===kind)!;
      expect(result.bytes).toEqual(original.bytes);expect(result.artifact.fileName).toBe(original.fileName);
    }
    expect(tokens).toBeGreaterThan(7);
    await f.grant('ARTIFACT',false,1);
    await expect(sdk.downloadXML(f.scope,f.id)).rejects.toMatchObject({code:'REMOTE_REQUEST_FAILED',status:403});
  });
  it('denies a different trusted-CA peer before owner authentication',async()=>{
    expect((await send(base+'/'+f.id+query(),'other')).status).toBe(403);expect(f.identity.authenticate).not.toHaveBeenCalled();
  });
  it.each(['duplicate','extra','foreign-branch','foreign-ruc','body','bad-id','alias','incomplete'])('rejects %s request',async scenario=>{
    let path=base+'/'+f.id+query();
    if(scenario==='duplicate')path+='&environment=BETA';if(scenario==='extra')path+='&accepted=true';
    if(scenario==='foreign-branch')path=path.replace(f.scope.branchId,receivedId(99));if(scenario==='foreign-ruc')path=path.replace(f.scope.recipientRuc,'00000000202');
    if(scenario==='bad-id')path=path.replace(f.id,'not-a-uuid');if(scenario==='alias')path=path.replace('companyId=','issuerId=');
    if(scenario==='incomplete')path=base+'/'+f.id+'?environment=BETA';
    expect([400,404]).toContain((await send(path,'edge','GET',scenario==='body'?{}:undefined)).status);
  });
  it('revoked file permission and failed audit cannot release previously checked originals',async()=>{
    await f.grant('ARTIFACT',false,1);
    expect((await send(base+'/'+f.id+'/artifacts/'+f.state.originals[0].id+'/content'+query())).status).toBe(403);
    f.control.failAudit=true;const r=await send(base+'/'+f.id+query());expect(r.status).toBe(503);expect(JSON.stringify(r.body)).not.toContain('PRIVATE_AUDIT_SECRET');
  });
  it('does not enable writes, assignments or connector execution in the read slice',async()=>{
    expect((await send(base,'edge','POST',{})).status).toBe(400);
    expect((await send('/b2b/v1/received-sync-jobs','edge','POST',{})).status).toBe(400);
  });
});
