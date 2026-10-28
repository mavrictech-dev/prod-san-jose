import 'reflect-metadata';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:https';
import {inspect} from 'node:util';
import {NestFactory} from '../services/b2b-api-service/node_modules/@nestjs/core';
import {B2bReceivedModule,B2bReceivedReads} from '../services/b2b-api-service/src/received';
import {B2bReadModule} from '../services/b2b-api-service/src/http';
import {B2bReads} from '../services/b2b-api-service/src/read';
import {FactuEzB2bClient,B2bSdkError,type FactuEzB2bOptions} from '../packages/b2b-sdk/src';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {b2bReceivedFixture,receivedId} from './helpers/b2b-received.fixture';

describe('Node SDK → actual incoming-read controllers over mandatory pinned mTLS',()=>{
  let tls:ReturnType<typeof b2bCertificates>,app:any,origin:string,f:ReturnType<typeof b2bReceivedFixture>,sdk:FactuEzB2bClient;
  const bearer=vi.fn(async()=>({token:f.token,actorKind:f.principal.kind}));
  const identity={authenticate:(...a:Parameters<ReturnType<typeof b2bReceivedFixture>['identity']['authenticate']>)=>f.identity.authenticate(...a)};
  const absent={execute:async()=>{throw new Error('NOT_CONFIGURED');},file:async()=>{throw new Error('NOT_CONFIGURED');}};
  const options=():FactuEzB2bOptions=>({origin,tls:{ca:tls.ca,cert:tls.edge,key:tls.key,serverCertificateSha256:fingerprint(tls.server)},bearer});
  beforeAll(async()=>{
    tls=b2bCertificates();const facade=new B2bReceivedReads(identity as any,{
      execute:(...a:any[])=>f.port.execute(...a as Parameters<typeof f.port.execute>),
      content:(...a:any[])=>f.port.content(...a as Parameters<typeof f.port.content>),
    });
    app=await NestFactory.create({module:class SdkTestModule{},imports:[
      B2bReceivedModule.isolated(facade,[fingerprint(tls.edge)]),
      B2bReadModule.isolated(new B2bReads(identity as any,absent,absent),[fingerprint(tls.edge)],false,false,false,false,false,false,false,false,false,undefined,true),
    ]},{logger:false,bodyParser:false,httpsOptions:{ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2'}});
    await app.listen(0,'127.0.0.1');origin=`https://127.0.0.1:${app.getHttpServer().address().port}`;
  },30000);
  beforeEach(async()=>{f=b2bReceivedFixture();f.principal.scopes.push('b2b:context:read');await f.grant('READ');await f.grant('ARTIFACT');bearer.mockClear();sdk=new FactuEzB2bClient(options());});
  afterAll(async()=>{await app?.close();});
  it('capabilities describe configured BETA received reads without claiming SUNAT verification',async()=>{
    const c=await sdk.capabilities();expect(c.environment).toBe('BETA');expect(c.fiscalActivation).toBe(false);
    expect(c.features.find(f=>f.id==='received-documents')?.state).toBe('ENABLED');expect(c.receivedCoverage?.officialTrust).toBe(false);
  });
  it('preserves complete item and tax decimal strings, with manifest and bound scope',async()=>{
    const p=await sdk.listReceived(f.query);expect(p.items[0].id).toBe(f.id);expect(p.page.consistency).toBe('LIVE_KEYSET_NOT_SNAPSHOT');
    const d=await sdk.detail(f.scope,f.id);expect(d.projection.items[0].unitValue).toBe('20.000000');expect(d.projection.items[0].taxes[0].amount).toBe('18.00');
    expect((await sdk.artifactManifest(f.scope,f.id)).items).toHaveLength(3);
  });
  it.each(['XML','CDR','PROVIDER_PDF'] as const)('returns byte-identical %s with Unicode filename and fresh bearer per hop',async kind=>{
    const result=await (kind==='XML'?sdk.downloadXML(f.scope,f.id):kind==='CDR'?sdk.downloadCDR(f.scope,f.id):sdk.downloadProviderPDF(f.scope,f.id));
    const source=f.state.originals.find(a=>a.kind===kind)!;expect(result.bytes.equals(source.bytes)).toBe(true);expect(result.artifact.fileName).toBe(source.fileName);
    expect(bearer).toHaveBeenCalledTimes(3);expect(result.artifact.signatureTrust).toBe('NOT_VERIFIED');
  });
  it('explicit artifact selection returns only the specified original',async()=>{
    const r=await sdk.downloadArtifact(f.scope,f.id,f.state.originals[1].id);expect(r.bytes).toEqual(f.state.originals[1].bytes);
  });
  it('supports USER without inventing a service actor or decoding tokens',async()=>{
    f.principal.kind='USER';f.principal.subjectId=receivedId(70);f.principal.userAuthRevision=1;
    await f.grant('READ');await f.grant('ARTIFACT');expect((await sdk.detail(f.scope,f.id)).document.id).toBe(f.id);
    expect(f.identity.authenticate.mock.calls.at(-1)?.[2]).toBe('USER');
  });
  it('keyset pagination never auto-fetches or promises an immutable history cut',async()=>{
    f.state.rows.push({...structuredClone(f.row),id:receivedId(20)});
    const first=await sdk.listReceived({...f.query,limit:1});expect(first.page.hasMore).toBe(true);expect(bearer).toHaveBeenCalledTimes(1);
    const next=await sdk.listReceived({...f.query,limit:1,after:first.page.nextAfter!});expect(next.items[0].id).toBe(receivedId(20));
  });
  it('denies a CA-trusted but unapproved client fingerprint',async()=>{
    const o=options();o.tls.cert=tls.other;await expect(new FactuEzB2bClient(o).detail(f.scope,f.id)).rejects.toMatchObject({code:'REMOTE_REQUEST_FAILED',status:403});
  });
  it('rejects a different server fingerprint despite a valid CA',async()=>{
    const o=options();o.tls.serverCertificateSha256=fingerprint(tls.other);
    await expect(new FactuEzB2bClient(o).capabilities()).rejects.toMatchObject({code:'TLS_OR_NETWORK_ERROR'});
  });
  it('rejects a different CA, without disabling trust validation',async()=>{
    const o=options();o.tls.ca=tls.other;await expect(new FactuEzB2bClient(o).capabilities()).rejects.toMatchObject({code:'TLS_OR_NETWORK_ERROR'});
  });
  it('does not cache access after revocation or serialize credentials',async()=>{
    await sdk.detail(f.scope,f.id);f.control.revoked=true;
    await expect(sdk.detail(f.scope,f.id)).rejects.toMatchObject({code:'REMOTE_REQUEST_FAILED',status:403});
    expect(JSON.stringify(sdk)).not.toMatch(/BEGIN|synthetic-received|https:/);expect(inspect(sdk,{showHidden:true})).not.toMatch(/BEGIN|synthetic-received/);
  });
  it.each(['http://localhost','https://user:secret@localhost','https://localhost/api','https://localhost?token=private','https://localhost/#x'])('rejects unsafe origin %s',url=>{
    expect(()=>new FactuEzB2bClient({...options(),origin:url})).toThrow(B2bSdkError);
  });
  it.each([{environment:'PRODUCTION'},{limit:0},{limit:101},{from:'2026-02-30'},{after:'https://external.test'},{type:'NV'},{to:'2028-01-01'}])('invalid input never reaches bearer or network %j',async change=>{
    const q:any={...f.query,...change};if('environment'in change){q.scope={...f.scope,...change};delete q.environment;}
    await expect(sdk.listReceived(q)).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(bearer).not.toHaveBeenCalled();
  });
  it('refuses arbitrary paths and TLS overrides in options',()=>{
    expect(()=>new FactuEzB2bClient({...options(),tls:{...options().tls,rejectUnauthorized:false}} as any)).toThrow('INVALID_CONFIGURATION');
  });
  it('does not leak token-provider exceptions or accept invalid tokens',async()=>{
    const o=options();o.bearer=async()=>{throw new Error('PRIVATE_BEARER_OR_PASSWORD');};
    try{await new FactuEzB2bClient(o).capabilities();throw 0;}catch(e){expect(e).toMatchObject({code:'TOKEN_UNAVAILABLE'});expect(JSON.stringify(e)).not.toContain('PRIVATE_BEARER');}
    o.bearer=async()=>({token:'secret\r\nx-header:bad',actorKind:'SERVICE'});await expect(new FactuEzB2bClient(o).capabilities()).rejects.toMatchObject({code:'TOKEN_UNAVAILABLE'});
  });
  it('bounds even a hanging token provider',async()=>{
    const o=options();o.timeoutMs=100;o.bearer=()=>new Promise(()=>{});
    await expect(new FactuEzB2bClient(o).capabilities()).rejects.toMatchObject({code:'REQUEST_TIMEOUT'});
  });
});

describe('SDK hostile HTTPS response validation (synthetic server, never remote URLs)',()=>{
  let tls:ReturnType<typeof b2bCertificates>,server:Server,origin:string,f:ReturnType<typeof b2bReceivedFixture>,sdk:FactuEzB2bClient;
  let mode='',requests:string[]=[],manifestReads=0,tokenCalls=0;
  const manifest=()=>({schemaVersion:'factuez.b2b.received-artifacts.v1',scope:f.scope,documentId:f.id,fiscalAcceptance:'NOT_VERIFIED',items:
    f.state.originals.map(({bytes,...a})=>({...a,mediaType:a.kind==='PROVIDER_PDF'?'application/pdf':'application/xml',representation:'PROVIDER_ORIGINAL',signatureTrust:'NOT_VERIFIED'}))});
  beforeAll(()=>{
    tls=b2bCertificates();server=createServer({ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2'},async(req,res)=>{
      requests.push(req.url!);const path=new URL(req.url!,'https://localhost').pathname;
      if(mode==='timeout')return;
      if(mode==='redirect'){res.writeHead(302,{Location:'https://do-not-contact.invalid/secret'});return res.end();}
      if(mode==='error'){res.writeHead(503,{'Content-Type':'application/json'});return res.end('{"password":"PRIVATE_RESPONSE_PII"}');}
      if(path.endsWith('/content')){
        const a=f.state.originals[0],b=mode==='hash'?Buffer.alloc(a.bytes.length,65):a.bytes;
        res.setHeader('Content-Type',mode==='media'?'application/pdf':'application/xml');res.setHeader('Content-Length',String(b.length));
        res.setHeader('X-Content-Sha256',mode==='header-hash'?'0'.repeat(64):a.sha256);
        res.setHeader('Content-Disposition',mode==='filename'?'attachment; filename="documento.xml"; filename*=UTF-8\'\'other.xml':`attachment; filename="documento.xml"; filename*=UTF-8''original.xml`);
        res.setHeader('X-FactuEz-Source',mode==='source'?'SIMULATED':'RECEIVED_ORIGINAL');return res.end(b);
      }
      let value:any;
      if(path.endsWith('/artifacts')){
        value=manifest();manifestReads++;
        if(mode==='scope')value.scope.branchId=receivedId(99);
        if(mode==='duplicate-artifact')value.items.push(value.items[0]);
        if(mode==='oversize-file')value.items[0].byteLength=10*1024*1024+1;
        if(mode==='unknown-field')value.storageKey='PRIVATE';
        if(mode==='changed'&&manifestReads>1)value.items[0].fileName='replaced.xml';
        if(mode==='ambiguous')value.items.push({...value.items[0],id:receivedId(40)});
        if(mode==='missing')value.items=[];
        if(mode==='trust')value.fiscalAcceptance='ACCEPTED';
      }else if(path===`/b2b/v1/received-documents/${f.id}`){
        value=structuredClone(await f.facade.detail(f.token,'SERVICE',f.scope,f.id));
        if(mode==='projection')value.projection.recipient.identityNumber='00000000999';
        if(mode==='schema')value.schemaVersion='factuez.b2b.received-detail.v99';
        if(mode==='items')value.projection.items[0].quantity={private:'wrong shape'};
        if(mode==='decimal')value.projection.items[0].unitPrice='Infinity';
        if(mode==='duplicate-line'){value.projection.items.push(structuredClone(value.projection.items[0]));value.document.itemCount=2;}
        if(mode==='supplier-name')value.projection.supplier.legalName='OTHER SYNTHETIC SUPPLIER';
        if(mode==='valid-long')value.projection.items[0].description='Descripción ficticia '.repeat(2000);
      }else value=await f.facade.list(f.token,'SERVICE',f.query);
      res.setHeader('Content-Type','application/json; charset=utf-8');
      if(mode==='encoding')res.setHeader('Content-Encoding','gzip');
      if(mode==='cookie')res.setHeader('Set-Cookie','session=PRIVATE');
      if(mode==='too-large'){res.setHeader('Content-Length',17*1024*1024);return res.end();}
      if(mode==='malformed')return res.end('{"schemaVersion":');
      if(mode==='duplicate-json')return res.end(JSON.stringify(value).replace('"schemaVersion":','"scope":{},"schemaVersion":'));
      if(mode==='utf8')return res.end(Buffer.from([0xff,0xfe]));
      if(mode==='prototype')return res.end('{"__proto__":{"private":"secret"}}');
      return res.end(JSON.stringify(value));
    });
    return new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>{origin=`https://127.0.0.1:${(server.address() as any).port}`;resolve();}));
  },30000);
  beforeEach(async()=>{mode='';requests=[];manifestReads=0;tokenCalls=0;f=b2bReceivedFixture();await f.grant('READ');await f.grant('ARTIFACT');
    sdk=new FactuEzB2bClient({origin,tls:{ca:tls.ca,cert:tls.edge,key:tls.key,serverCertificateSha256:fingerprint(tls.server)},timeoutMs:1000,
      bearer:async()=>{tokenCalls++;return {token:'synthetic-'+tokenCalls,actorKind:'SERVICE'};}});
  });
  afterAll(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  it.each(['scope','duplicate-artifact','oversize-file','unknown-field','trust'])('rejects malformed manifest %s',async m=>{
    mode=m;await expect(sdk.artifactManifest(f.scope,f.id)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  });
  it.each(['malformed','duplicate-json','utf8','prototype','encoding','cookie'])('refuses invalid JSON/headers %s',async m=>{
    mode=m;await expect(sdk.listReceived(f.query)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  });
  it.each(['projection','schema','items','decimal','duplicate-line','supplier-name'])('rejects wrong detail %s',async m=>{
    mode=m;await expect(sdk.detail(f.scope,f.id)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  });
  it('preserves legitimate long item descriptions without silently truncating',async()=>{
    mode='valid-long';const d=await sdk.detail(f.scope,f.id);expect(d.projection.items[0].description).toBe('Descripción ficticia '.repeat(2000));
  });
  it('preserves legitimate punctuation in metadata, but never writes filenames to disk',async()=>{
    f.state.originals[0].fileName='Factura "San José" (1); versión.xml';
    const m=await sdk.artifactManifest(f.scope,f.id);expect(m.items[0].fileName).toBe(f.state.originals[0].fileName);
  });
  it.each(['hash','media','header-hash','filename','source'])('rejects modified original %s',async m=>{
    mode=m;await expect(sdk.downloadXML(f.scope,f.id)).rejects.toMatchObject({code:'ARTIFACT_INTEGRITY_FAILED'});
    expect(requests).toHaveLength(2);
  });
  it('discards bytes if manifest changes after download',async()=>{mode='changed';await expect(sdk.downloadXML(f.scope,f.id)).rejects.toMatchObject({code:'ARTIFACT_CHANGED'});expect(tokenCalls).toBe(3);});
  it.each(['missing','ambiguous'])('never guesses or generates an original when %s',async m=>{
    mode=m;await expect(sdk.downloadXML(f.scope,f.id)).rejects.toMatchObject({code:m==='missing'?'ARTIFACT_NOT_FOUND':'ARTIFACT_AMBIGUOUS'});expect(requests).toHaveLength(1);
  });
  it('does not follow a redirect or retry an error',async()=>{
    mode='redirect';await expect(sdk.listReceived(f.query)).rejects.toMatchObject({code:'REDIRECT_REFUSED',status:302});expect(requests).toHaveLength(1);
    mode='error';try{await sdk.listReceived(f.query);}catch(e){expect(e).toMatchObject({code:'REMOTE_REQUEST_FAILED',status:503});expect(inspect(e)).not.toMatch(/PRIVATE_RESPONSE|password/);}
    expect(requests).toHaveLength(2);
  });
  it('bounds declared bytes and total request time',async()=>{
    mode='too-large';await expect(sdk.listReceived(f.query)).rejects.toMatchObject({code:'RESPONSE_TOO_LARGE'});
    mode='timeout';await expect(sdk.listReceived(f.query)).rejects.toMatchObject({code:'REQUEST_TIMEOUT'});
  });
});
