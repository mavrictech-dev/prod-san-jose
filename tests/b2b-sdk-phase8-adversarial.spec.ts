import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:https';
import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {BoundedTransport} from '../packages/b2b-sdk/src/transport';
import {FactuEzB2bClient,FactuEzB2bAdminClient,type FactuEzB2bOptions} from '../packages/b2b-sdk/src';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {harness,customer} from './b2b-phase8-business-integration/cases';
import {reportsFixture,filters} from './b2b-phase8-reports.fixture';
import {adminFixture,input} from './b2b-integration-admin.fixture';
import {id,scope} from './helpers/b2b-received-commands.fixture';

describe('phase8 SDK adversarial pinned HTTPS responses and bounded admission',()=>{
  let tls:ReturnType<typeof b2bCertificates>,server:Server,origin:string,sdk:FactuEzB2bClient,admin:FactuEzB2bAdminClient;
  let h:ReturnType<typeof harness>,business:any,report:any,reportFile:any,application:any,mode:string,seen:any[],reads:number;
  const bearer=vi.fn(async()=>({token:'synthetic-token',actorKind:'USER' as const})),adminBearer=vi.fn(async()=>'human-step-up');
  const options=():FactuEzB2bOptions=>({origin,tls:{ca:tls.ca,cert:tls.edge,key:tls.key,serverCertificateSha256:fingerprint(tls.server)},bearer});
  const key={idempotencyKey:'sdk_adversarial_0001'};
  beforeAll(()=>{
    tls=b2bCertificates();server=createServer({ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2'},async(req,res)=>{
      const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);seen.push({url:req.url,method:req.method,body:Buffer.concat(chunks)});
      if(mode==='redirect'){res.writeHead(307,{Location:'https://never-contact.invalid/secret'});return res.end();}
      if(mode==='error'){res.writeHead(503,{'Content-Type':'application/json'});return res.end('{"password":"PRIVATE_SERVER_ERROR"}');}
      if(mode==='hang')return;
      const path=new URL(req.url!,origin).pathname;
      if(path.endsWith('/content')){
        const meta=report.data.content;res.writeHead(200,{'Content-Type':mode==='wrong-mime'?'application/pdf':meta.mediaType,'Content-Length':String(mode==='binary-overflow'?meta.sizeBytes+1:meta.sizeBytes),'X-Content-Sha256':mode==='header-hash'?'0'.repeat(64):meta.sha256,'Content-Disposition':`attachment; filename="${mode==='filename'?'../private.csv':meta.fileName}"`});
        return res.end(mode==='binary-overflow'?Buffer.alloc(meta.sizeBytes+1):mode==='byte-hash'?Buffer.alloc(meta.sizeBytes,65):reportFile.bytes);
      }
      let value:any;
      if(path.startsWith('/b2b/v1/admin/')){
        value=structuredClone(application);if(req.method==='GET')delete value.clientSecret;
        if(req.method==='PATCH'){delete value.clientSecret;value.application.revision=2;value.application.enabled=false;}
        if(mode==='admin-secret-read')value.clientSecret='s'.repeat(43);
        if(mode==='admin-missing-secret')delete value.clientSecret;
        if(mode==='admin-id')value.application.id=id(99);
        if(mode==='admin-revision')value.application.revision=8;
        if(mode==='admin-field')value.application.cipher='PRIVATE';
        if(mode==='admin-scope')value.application.scopes=['admin:*'];
        if(mode==='admin-oidc')value.application.oidcClientId='PRIVATE';
        if(mode==='admin-binding')value.application.bindings[0].proof='asserted';
      }else if(path.startsWith('/b2b/v1/report-jobs/')){
        value=structuredClone(report);delete value.replayed;reads++;
        if(mode==='report-id')value.data.id=id(99);
        if(mode==='report-hash')value.data.content.sha256='not-a-hash';
        if(mode==='report-size')value.data.content.sizeBytes=24*1024*1024+1;
        if(mode==='report-schema')value.schemaVersion='reports.v99';
        if(mode==='report-field')value.data.ownerKey='PRIVATE';
        if(mode==='report-state')value.data.state='READY',value.data.content=null;
        if(mode==='changed'&&reads>1)value.data.captureSha256='0'.repeat(64);
      }else if(path.includes('/received-documents')){
        const assign=path.endsWith('/assignment');value={schemaVersion:'factuez.b2b.received-command.v1',scope,action:assign?'ASSIGN':'REGISTER',result:{documentId:id(10),fiscalAcceptance:'NOT_VERIFIED',outcome:assign?'ASSIGNED':'REGISTERED',...(assign?{branchId:id(2)}:{})}};
        if(mode==='received-scope')value.scope={...scope,companyId:2};
        if(mode==='received-action')value.action='IMPORT';
        if(mode==='received-id')value.result.documentId=id(99);
        if(mode==='received-target')value.result.branchId=id(99);
        if(mode==='received-trust')value.result.fiscalAcceptance='ACCEPTED';
        if(mode==='received-field')value.result.secret='PRIVATE';
      }else{
        value=structuredClone(business);if(req.method==='PATCH'){value.data.active=false;value.data.revision=2;}
        if(mode==='business-scope')value.binding.branchId=id(99);
        if(mode==='business-schema')value.schemaVersion='business.v2';
        if(mode==='business-field')value.data.storagePath='PRIVATE';
        if(mode==='business-id')value.data.id=id(99);
        if(mode==='business-operation')value.operationId='not-a-uuid';
        if(mode==='business-revision')value.data.revision=9;
        if(mode==='business-body')value.data.active=true;
        if(mode==='business-replay')value.replayed=true,value.data.id=id(99);
      }
      const status=req.method==='POST'&&!path.endsWith('/rotate-secret')?201:200;res.statusCode=status;res.setHeader('Content-Type','application/json');
      if(mode==='duplicate-json')return res.end('{"schemaVersion":"x","schemaVersion":"y"}');
      if(mode==='reserved-json')return res.end('{"__proto__":{"secret":"PRIVATE"}}');
      if(mode==='invalid-utf8')return res.end(Buffer.from([0xff]));
      if(mode==='oversize-json'){res.setHeader('Content-Length',String(16*1024*1024+1));return res.end();}
      res.end(JSON.stringify(value));
    });return new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>{origin=`https://127.0.0.1:${(server.address() as any).port}`;r();}));
  },30000);
  beforeEach(async()=>{
    h=harness();business={schemaVersion:'factuez.b2b.business.v1',environment:'BETA',binding:h.b,candidateOnly:true,fiscalAuthority:false,...await h.createCustomer()};
    const r=reportsFixture();report=await r.reports.execute(r.auth,'CREATE',{filters,format:'CSV',idempotencyKey:key.idempotencyKey});reportFile=await r.reports.execute(r.auth,'CONTENT',{id:report.data.id});
    const a=adminFixture();application=await a.facade.create('human-step-up',{environment:'BETA'},input());mode='';seen=[];reads=0;bearer.mockClear();adminBearer.mockClear();sdk=new FactuEzB2bClient(options());const {bearer:_b,...base}=options();admin=new FactuEzB2bAdminClient({...base,adminBearer});
  });
  afterAll(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));});
  it.each(['business-scope','business-schema','business-field','business-id','business-operation','business-revision','business-body','business-replay'])('rejects %s including replay of a foreign resource',async m=>{
    mode=m;await expect(sdk.updateCustomer(h.b,business.data.id,{active:false},{...key,expectedRevision:1})).rejects.toMatchObject({code:'INVALID_RESPONSE'});expect(seen).toHaveLength(1);
  });
  it('bounds aggregate cash to owner numeric(30,2) while keeping movement admission unchanged',async()=>{
    business.operationId=null;business.data={customers:'0',activeCustomers:'0',sharedProducts:'0',actorPointShifts:'0',actorPointOpenShifts:'0',cash:[{currency:'PEN',incoming:'9'.repeat(28)+'.99',outgoing:'0.00'}]};
    expect((await sdk.businessSummary(h.b)).data.cash[0].incoming).toBe('9'.repeat(28)+'.99');
    for(const incoming of ['1'.repeat(29)+'.00','-0.01','1e2','1.001','01.00','1','0.0']){
      business.data.cash[0].incoming=incoming;await expect(sdk.businessSummary(h.b)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
    }
    const before=seen.length;bearer.mockClear();
    await expect(sdk.createCashMovement(h.b,id(10),{direction:'IN',amount:'1000000000000.00',reason:'LIMITE SINTETICO'},{...key,expectedRevision:1})).rejects.toMatchObject({code:'INVALID_REQUEST'});
    expect(bearer).not.toHaveBeenCalled();expect(seen).toHaveLength(before);
  });
  it.each(['received-scope','received-action','received-id','received-target','received-trust','received-field'])('rejects %s',async m=>{
    mode=m;await expect(sdk.receivedAssign(scope,id(10),{targetBranchId:id(2),expectedXmlSha256:'a'.repeat(64)},key)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  });
  it.each(['report-id','report-hash','report-size','report-schema','report-field','report-state'])('rejects %s before downloading bytes',async m=>{
    mode=m;await expect(sdk.downloadReport(report.data.id)).rejects.toMatchObject({code:'INVALID_RESPONSE'});expect(seen).toHaveLength(1);
  });
  it.each(['byte-hash','header-hash','wrong-mime','filename'])('verifies report %s against prior metadata',async m=>{
    mode=m;await expect(sdk.downloadReport(report.data.id)).rejects.toMatchObject({code:'ARTIFACT_INTEGRITY_FAILED'});expect(seen).toHaveLength(2);
  });
  it('bounds binary declared length before collecting bytes',async()=>{mode='binary-overflow';await expect(sdk.downloadReport(report.data.id)).rejects.toMatchObject({code:'RESPONSE_TOO_LARGE'});});
  it('rechecks report metadata after content and rejects a changed capture',async()=>{mode='changed';await expect(sdk.downloadReport(report.data.id)).rejects.toMatchObject({code:'ARTIFACT_CHANGED'});expect(bearer).toHaveBeenCalledTimes(3);});
  it.each(['admin-id','admin-field','admin-scope','admin-oidc','admin-binding','admin-secret-read'])('rejects %s on admin metadata',async m=>{mode=m;await expect(admin.readApplication(application.application.id)).rejects.toMatchObject({code:'INVALID_RESPONSE'});});
  it('refuses missing one-time secret and mismatched mutation revision',async()=>{
    mode='admin-missing-secret';await expect(admin.createApplication(input() as any)).rejects.toMatchObject({code:'INVALID_RESPONSE'});mode='admin-revision';await expect(admin.updateApplication(application.application.id,{expectedRevision:1,enabled:false})).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  });
  it.each(['duplicate-json','reserved-json','invalid-utf8'])('strict JSON response validation: %s',async m=>{mode=m;await expect(sdk.readReport(report.data.id)).rejects.toMatchObject({code:'INVALID_RESPONSE'});});
  it('caps JSON responses at configured finite bound',async()=>{mode='oversize-json';await expect(sdk.readReport(report.data.id)).rejects.toMatchObject({code:'RESPONSE_TOO_LARGE'});});
  it.each(['redirect','error'])('does not retry or follow %s, and redacts all remote details',async m=>{
    mode=m;try{await admin.createApplication(input() as any);throw new Error('EXPECTED_REJECTION');}catch(e){expect(e).toMatchObject({code:m==='redirect'?'REDIRECT_REFUSED':'REMOTE_REQUEST_FAILED'});expect(JSON.stringify(e)+inspect(e)).not.toMatch(/PRIVATE|human-step-up|never-contact|BEGIN/);}expect(seen).toHaveLength(1);expect(adminBearer).toHaveBeenCalledTimes(1);
  });
  it('bounds administrator proof providers and never leaks their exceptions',async()=>{
    const {bearer:_b,...base}=options();const c=new FactuEzB2bAdminClient({...base,timeoutMs:100,adminBearer:()=>new Promise(()=>{})});await expect(c.listApplications()).rejects.toMatchObject({code:'REQUEST_TIMEOUT'});
    const bad=new FactuEzB2bAdminClient({...base,adminBearer:async()=>{throw new Error('PRIVATE_PROOF');}});await expect(bad.listApplications()).rejects.toMatchObject({code:'TOKEN_UNAVAILABLE'});expect(seen).toHaveLength(0);
  });
  it('accepts exactly 64 KiB and rejects 64 KiB plus one before bearer',async()=>{
    const file=(n:number)=>({fileName:'original.xml',contentBase64:Buffer.alloc(n,65).toString('base64')});
    // The synthetic owner returns a REGISTER envelope; reaching it proves admission, then schema rejects.
    await expect(sdk.receivedImportXML(scope,file(65536),key)).rejects.toMatchObject({code:'INVALID_RESPONSE'});expect(seen).toHaveLength(1);expect(seen[0].body.length).toBeLessThan(128*1024);
    bearer.mockClear();await expect(sdk.receivedImportXML(scope,file(65537),key)).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(bearer).not.toHaveBeenCalled();expect(seen).toHaveLength(1);
  });
  it('rejects filenames forbidden by the received owner before bearer for every upload command',async()=>{
    for(const stem of ['../original','original..copy','original<copy','original>copy','original:copy','original/copy','original\\copy','original|copy','original?copy','original*copy','original%copy']){
      const xml={fileName:stem+'.xml',contentBase64:Buffer.from('<synthetic/>').toString('base64')};
      const pdf={fileName:stem+'.pdf',contentBase64:Buffer.from('%PDF-synthetic').toString('base64')};
      for(const request of [()=>sdk.receivedImportXML(scope,xml,key),()=>sdk.receivedAttach(scope,id(10),{kind:'CDR',file:xml},key),()=>sdk.receivedAttach(scope,id(10),{kind:'PROVIDER_PDF',file:pdf},key)])
        await expect(request()).rejects.toMatchObject({code:'INVALID_REQUEST'});
    }
    expect(bearer).not.toHaveBeenCalled();expect(seen).toHaveLength(0);
  });
  it('caps serialized request JSON at 128 KiB, measured after UTF-8 encoding',async()=>{
    // Exercise the common transport cap independently of narrower business/admin DTO limits.
    const {bearer:_b,...base}=options(),transport=new BoundedTransport({...base,adminBearer},true);
    const body={value:'\u00e9'.repeat((128*1024-12)/2)};expect(Buffer.byteLength(JSON.stringify(body))).toBe(128*1024);
    await transport.json('adminCreate',[],{environment:'BETA'},body);expect(seen[0].body.length).toBe(128*1024);adminBearer.mockClear();
    await expect(transport.json('adminCreate',[],{environment:'BETA'},{value:body.value+'a'})).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(adminBearer).not.toHaveBeenCalled();expect(seen).toHaveLength(1);
  });
  it('accepts exactly 24 MiB of report bytes with matching size, name and SHA256',async()=>{
    reportFile.bytes=Buffer.alloc(24*1024*1024,65);report.data.content.sizeBytes=reportFile.bytes.length;report.data.content.sha256=createHash('sha256').update(reportFile.bytes).digest('hex');
    const result=await sdk.downloadReport(report.data.id);expect(result.bytes.equals(reportFile.bytes)).toBe(true);expect(seen).toHaveLength(3);
  });
  it('bounds a hanging HTTPS response without retrying',async()=>{mode='hang';const c=new FactuEzB2bClient({...options(),timeoutMs:1000});await expect(c.readReport(report.data.id)).rejects.toMatchObject({code:'REQUEST_TIMEOUT'});expect(seen).toHaveLength(1);});
  it('public clients expose no generic URL/path/method transport or credential objects',()=>{
    for(const client of [sdk,admin])for(const name of ['get','post','patch','request','json','file','transport','download'])expect((client as any)[name]).toBeUndefined();
    expect(JSON.stringify(sdk)+JSON.stringify(admin)+inspect(sdk,{showHidden:true})+inspect(admin,{showHidden:true})).not.toMatch(/synthetic-token|human-step-up|BEGIN|https:/);
  });
  it('rejects proxies and symbol/non-enumerable/getter fields without invoking them',async()=>{
    const trap=vi.fn();const proxy=new Proxy(customer(),{ownKeys(){trap();throw new Error('PRIVATE_PROXY');}});await expect(sdk.createCustomer(h.b,proxy,key)).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(trap).not.toHaveBeenCalled();
    for(const body of [Object.defineProperty(customer(),'hidden',{value:1}),{...customer(),[Symbol('secret')]:1}])await expect(sdk.createCustomer(h.b,body,key)).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(bearer).not.toHaveBeenCalled();
  });
});
