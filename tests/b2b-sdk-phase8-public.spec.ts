import 'reflect-metadata';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {inspect} from 'node:util';
import {createRequire} from 'node:module';
import {NestFactory} from '../services/b2b-api-service/node_modules/@nestjs/core';
import {B2bEnabledIdentityScopes} from '../packages/contracts/src/b2b-security';
import {FactuEzB2bClient,FactuEzB2bAdminClient,AdminScopes,type FactuEzB2bOptions,type ReportFilters} from '../packages/b2b-sdk/src';
import {B2bPhase8Business,B2bPhase8BusinessModule} from '../services/b2b-api-service/src/phase8-business';
import {B2bPhase8Reports,B2bPhase8ReportsModule} from '../services/b2b-api-service/src/phase8-reports';
import {B2bReceivedCommands,B2bReceivedCommandsModule} from '../services/b2b-api-service/src/received-commands';
import {B2bIntegrationAdmin,B2bIntegrationAdminModule} from '../services/b2b-api-service/src/integration-admin';
import {createReportsRenderers} from '../services/billing-service/src/b2b/phase8-reports';
import {harness,customer,product,MemoryBusinessStore} from './b2b-phase8-business-integration/cases';
import {reportsFixture,filters} from './b2b-phase8-reports.fixture';
import {adminFixture,input as applicationInput} from './b2b-integration-admin.fixture';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {receivedXml} from './received-fixture.mjs';
import {scope as receivedScope,id as receivedId} from './helpers/b2b-received-commands.fixture';

/** All sockets are ephemeral loopback; real public controllers and business/admin/report owners.
 * Reception uses a recording owner port: PostgreSQL command persistence is tested by its owner suite. */
describe('phase8 SDK through actual public controllers over pinned mTLS',()=>{
  let tls:ReturnType<typeof b2bCertificates>,app:any,origin:string,h:ReturnType<typeof harness>,r:ReturnType<typeof reportsFixture>,a:ReturnType<typeof adminFixture>;
  let store:MemoryBusinessStore;let sdk:FactuEzB2bClient,admin:FactuEzB2bAdminClient,readCalls:any[],receptionCalls:any[],requests:{method:string;path:string;body:any;actor?:string;authorization?:string;key?:string}[];
  const bearer=vi.fn(async()=>({token:h.auth().token,actorKind:h.principal.kind}));
  const adminBearer=vi.fn(async()=>'human-step-up');
  const identity={authenticate:async(token:string,scopes:any,kind:any)=>token==='synthetic-report-token'?r.identity.authenticate(token,scopes,kind):h.identity.authenticate(token,scopes,kind)};
  const options=():FactuEzB2bOptions=>({origin,tls:{ca:tls.ca,cert:tls.edge,key:tls.key,serverCertificateSha256:fingerprint(tls.server)},bearer});
  const reportQuery=():ReportFilters=>({issuerId:1,environment:'BETA',from:filters.from,to:filters.to,types:['01']});
  const reportSdk=()=>new FactuEzB2bClient({...options(),bearer:async()=>({token:r.auth.token,actorKind:r.auth.kind})});
  beforeAll(async()=>{
    tls=b2bCertificates();
    const business=new B2bPhase8Business(identity as any,{execute:(access,action,input)=>h.engine.execute(access,action,input)});
    const reports=new B2bPhase8Reports(identity as any,{execute:async(access,action,input)=>{readCalls.push(action);return r.reports.execute(access,action,input);},content:async(access,input)=>{readCalls.push('CONTENT');return r.reports.execute(access,'CONTENT',input);}});
    const receptionIdentity={authenticate:async()=>({kind:'SERVICE',clientId:receivedId(3),revision:1,subjectId:null,userAuthRevision:null,environment:'BETA',scopes:['b2b:received:write'],bindings:[{issuerId:receivedScope.companyId,issuerRuc:receivedScope.recipientRuc,environment:'BETA',branchId:receivedScope.branchId,pointId:receivedId(4),seriesId:receivedId(5),documentType:'01'}]})};
    const reception=new B2bReceivedCommands(receptionIdentity as any,{execute:async(access,action,input:any)=>{receptionCalls.push({access,action,input});return {documentId:input.payload.documentId??receivedId(10),outcome:{IMPORT:'IMPORTED',ATTACH:'ATTACHED',ASSIGN:'ASSIGNED',REGISTER:'REGISTERED'}[action],fiscalAcceptance:'NOT_VERIFIED',...(action==='ASSIGN'?{branchId:input.payload.targetBranchId}:{})};}});
    // A real facade delegates to a fresh Identity owner fixture per test.
    const adminCore=new B2bIntegrationAdmin({execute:(proof,request)=>a.owner.execute(proof,request)});
    const peers=[fingerprint(tls.edge)];
    const httpsOptions={ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const};
    app=await NestFactory.create({module:class Phase8SdkTest{},imports:[B2bPhase8BusinessModule.isolated(business,peers),B2bPhase8ReportsModule.isolated(reports,peers),B2bReceivedCommandsModule.isolated(reception,peers),B2bIntegrationAdminModule.isolated(adminCore,peers)]},{logger:false,httpsOptions});
    app.use((req:any,res:any,next:any)=>{const record={method:req.method,path:req.url,body:undefined,actor:req.headers['x-factuez-actor-kind'],authorization:req.headers.authorization,key:req.headers['idempotency-key']};requests.push(record);res.on('finish',()=>{record.body=req.body;});next();});
    await app.listen(0,'127.0.0.1');origin=`https://127.0.0.1:${app.getHttpServer().address().port}`;
  },30000);
  beforeEach(()=>{store=new MemoryBusinessStore();h=harness(store);r=reportsFixture();a=adminFixture();readCalls=[];receptionCalls=[];requests=[];bearer.mockClear();adminBearer.mockClear();sdk=new FactuEzB2bClient(options());const {bearer:_b,...base}=options();admin=new FactuEzB2bAdminClient({...base,adminBearer});});
  afterAll(async()=>{await app?.close();});
  const key=(suffix='0')=>({idempotencyKey:'sdk_phase8_synthetic_'+suffix});
  it('keeps its immutable admin scope vocabulary aligned with the approved contract',()=>{expect([...AdminScopes].sort()).toEqual([...B2bEnabledIdentityScopes].sort());expect(Object.isFrozen(AdminScopes)).toBe(true);});
  it('creates, lists, reads and updates real customers with a flat seven-key binding and CAS body',async()=>{
    const made=await sdk.createCustomer(h.b,customer(),key()),id=made.data.id;
    expect(made.data.revision).toBe(1);expect((await sdk.listCustomers(h.b,{limit:1})).data[0].id).toBe(id);expect((await sdk.readCustomer(h.b,id)).data.id).toBe(id);
    const updated=await sdk.updateCustomer(h.b,id,{legalName:'CAMBIO'},{...key('1'),expectedRevision:1});expect(updated.data).toMatchObject({legalName:'CAMBIO',revision:2});
    const req=requests.at(-1)!;expect(req.method).toBe('PATCH');expect([...new URL(req.path,origin).searchParams.keys()].sort()).toEqual(Object.keys(h.b).sort());expect(req.key).toBe(key('1').idempotencyKey);expect(req.body).toEqual({body:{legalName:'CAMBIO'},expectedRevision:1});
    await expect(sdk.updateCustomer(h.b,id,{active:false},{...key('2'),expectedRevision:1})).rejects.toMatchObject({status:412});
    expect(store.state.operations).toHaveLength(2);
  });
  it('preserves idempotency and refuses changed requests with the same key, with no retry',async()=>{
    const first=await sdk.createCustomer(h.b,customer(),key());const replay=await sdk.createCustomer(h.b,customer(),key());expect(replay).toMatchObject({operationId:first.operationId,replayed:true,data:first.data});
    const before=requests.length;await expect(sdk.createCustomer(h.b,{...customer(),legalName:'CHANGED'},key())).rejects.toMatchObject({status:409});expect(requests.length-before).toBe(1);expect(store.state.operations).toHaveLength(1);
  });
  it('uses candidate GET business-products and concrete product create/update, preserving six decimals',async()=>{
    const first=await sdk.createProduct(h.b,product(),key());expect(first.data.defaultUnitPrice).toBe('0.100001');await sdk.listBusinessProducts(h.b);expect(requests.at(-1)?.path).toMatch(/^\/b2b\/v1\/business-products\?/);
    expect((await sdk.updateProduct(h.b,first.data.id,{defaultUnitPrice:'1.000002'},{...key('1'),expectedRevision:1})).data.defaultUnitPrice).toBe('1.000002');
  });
  it('accepts owner-valid SKU text on catalogue reads, creates and CAS updates',async()=>{
    const seeded=await h.createProduct({body:{...product(),sku:' mezcla / catálogo #1 '}});
    const listed=await sdk.listBusinessProducts(h.b);expect(listed.data[0]).toEqual(seeded.data);
    const made=await sdk.createProduct(h.b,{...product(),sku:' mezcla / catálogo #2 '},key());expect(made.data.sku).toBe('mezcla / catálogo #2');
    const updated=await sdk.updateProduct(h.b,made.data.id,{sku:' mezcla / catálogo #3 '},{...key('1'),expectedRevision:1});
    expect(updated.data).toMatchObject({sku:'mezcla / catálogo #3',revision:2});
    expect(requests.at(-1)?.body).toEqual({body:{sku:' mezcla / catálogo #3 '},expectedRevision:1});
  });
  it('accepts accumulated cash totals above an individual movement limit',async()=>{
    const shift=await sdk.openShift(h.b,{openingAmount:'0',currency:'PEN'},key());
    for(let n=0;n<4;n++)await sdk.createCashMovement(h.b,shift.data.id,{direction:n%2===0?'IN':'OUT',amount:'999999999999.99',reason:'ACUMULADO SINTETICO'},{...key(String(n+1)),expectedRevision:n+1});
    expect((await sdk.businessSummary(h.b)).data.cash).toEqual([{currency:'PEN',incoming:'1999999999999.98',outgoing:'1999999999999.98'}]);
  });
  it('opens, moves cash and closes a real shift using expectedRevision in each body',async()=>{
    const shift=await sdk.openShift(h.b,{openingAmount:'10.00',currency:'PEN'},key());
    const moved=await sdk.createCashMovement(h.b,shift.data.id,{direction:'IN',amount:'0.10',reason:'PRUEBA'},{...key('1'),expectedRevision:1});expect(moved.data.balance).toBe('10.10');
    expect((await sdk.listShifts(h.b)).data).toHaveLength(1);const closed=await sdk.closeShift(h.b,shift.data.id,{countedAmount:'10.10',reason:'CIERRE'},{...key('2'),expectedRevision:2});expect(closed.data.state).toBe('CLOSED');expect((await sdk.businessSummary(h.b)).data.actorPointShifts).toBe('1');
  });
  it('retains owner permission and full-binding denials',async()=>{
    h.allowed=false;await expect(sdk.createCustomer(h.b,customer(),key())).rejects.toMatchObject({status:403});h.allowed=true;
    await expect(sdk.listCustomers({...h.b,seriesId:receivedId(77)})).rejects.toMatchObject({status:404});
    h.principal={...h.principal,scopes:['b2b:context:read']};await expect(sdk.listCustomers(h.b)).rejects.toMatchObject({status:401});
  });
  it('sends exact received import/attach/assign/register commands, CAS hashes and ERP reference',async()=>{
    const c=new FactuEzB2bClient({...options(),bearer:async()=>({token:'synthetic-received-token',actorKind:'SERVICE'})});const s=receivedScope,doc=receivedId(10),file={fileName:'original.xml',contentBase64:Buffer.from(receivedXml()).toString('base64')};
    expect((await c.receivedImportXML(s,file,key())).action).toBe('IMPORT');
    await c.receivedAttach(s,doc,{kind:'PROVIDER_PDF',file:{fileName:'provider.pdf',contentBase64:Buffer.from('%PDF-synthetic').toString('base64')}},key('1'));
    await c.receivedAssign(s,doc,{targetBranchId:receivedId(2),expectedXmlSha256:'a'.repeat(64)},key('2'));
    await c.receivedRegister(s,doc,{registeredAt:'2026-01-01T00:00:00.000Z',erpReference:'ERP-1',expectedErpReference:null},key('3'));
    expect(receptionCalls.map(c=>c.action)).toEqual(['IMPORT','ATTACH','ASSIGN','REGISTER']);expect(receptionCalls[0].input.payload).toEqual(file);expect(receptionCalls[2].input.payload).toMatchObject({documentId:doc,expectedXmlSha256:'a'.repeat(64)});
    expect(requests.slice(-4).map(r=>r.method)).toEqual(['POST','POST','PATCH','PATCH']);
  });
  it('serializes normalized report filters in the dashboard query and create body',async()=>{
    const c=reportSdk(),b=r.p.bindings[0],q={...reportQuery(),types:['03','01'] as ('01'|'03')[],branchId:b.branchId,pointId:b.pointId,seriesId:b.seriesId};
    await c.dashboard(q);const dashboard=requests.at(-1)!;
    const wire={issuerId:String(q.issuerId),environment:'BETA',from:q.from,to:q.to,types:'01,03',branchId:b.branchId,pointId:b.pointId,seriesId:b.seriesId};
    expect(dashboard.method).toBe('GET');expect(new URL(dashboard.path,origin).pathname).toBe('/b2b/v1/dashboard');
    expect(Object.fromEntries(new URL(dashboard.path,origin).searchParams)).toEqual(wire);expect(dashboard.body).toBeUndefined();
    await c.createReport(q,'CSV',key());const create=requests.at(-1)!;
    expect(create.method).toBe('POST');expect(create.path).toBe('/b2b/v1/report-jobs?environment=BETA');
    expect(create.body).toEqual({filters:wire,format:'CSV'});expect(create.key).toBe(key().idempotencyKey);
  });
  it('returns dashboard and byte-identical CSV through real capture/render/store, using fresh access per hop',async()=>{
    const c=reportSdk(),q=reportQuery();expect((await c.dashboard(q)).data.groups[0].payableAmount).toBe('118.00');
    const made=await c.createReport(q,'CSV',key());expect(made.data.state).toBe('READY');expect((await c.createReport(q,'CSV',key())).replayed).toBe(true);
    readCalls=[];const download=await c.downloadReport(made.data.id);expect(download.bytes.equals(r.store.files.get(made.data.id)!.bytes)).toBe(true);expect(readCalls).toEqual(['READ','CONTENT','READ']);expect(download.report.content?.fileName).toBe(`b2b-report-${made.data.id}.csv`);
  });
  it.each(['XLSX','PDF'] as const)('downloads actual %s renderers over the public controller',async format=>{
    const req=createRequire(new URL('../services/received-documents-service/package.json',import.meta.url));r=reportsFixture({renderers:createReportsRenderers({Workbook:req('exceljs').Workbook,PdfDocument:req('pdfkit')})});
    const c=reportSdk(),made=await c.createReport(reportQuery(),format,key(format)),file=await c.downloadReport(made.data.id);expect(file.bytes.subarray(0,format==='PDF'?4:2).toString()).toBe(format==='PDF'?'%PDF':'PK');
  });
  it('enforces report export revocation between metadata and content without a retry',async()=>{
    const c=reportSdk(),made=await c.createReport(reportQuery(),'CSV',key());r.p.scopes=r.p.scopes.filter(s=>s!=='b2b:reports:export');expect((await c.readReport(made.data.id)).data.id).toBe(made.data.id);await expect(c.downloadReport(made.data.id)).rejects.toMatchObject({status:403});
  });
  it('independent human administrator creates/lists/reads/updates/rotates; secrets appear only on explicit calls',async()=>{
    const made=await admin.createApplication(applicationInput() as any),id=made.application.id;expect(made.clientSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);expect((await admin.listApplications({limit:1})).items[0].id).toBe(id);
    expect(await admin.readApplication(id)).not.toHaveProperty('clientSecret');const changed=await admin.updateApplication(id,{expectedRevision:1,label:'CAMBIO'});expect(changed).not.toHaveProperty('clientSecret');expect(changed.application.revision).toBe(2);
    const rotated=await admin.rotateApplicationSecret(id,{expectedRevision:2});expect(rotated.clientSecret).not.toBe(made.clientSecret);await expect(admin.rotateApplicationSecret(id,{expectedRevision:2})).rejects.toMatchObject({status:409});
    expect(bearer).not.toHaveBeenCalled();expect(adminBearer).toHaveBeenCalledTimes(6);expect(requests.every(r=>r.actor===undefined&&r.authorization==='Bearer human-step-up')).toBe(true);
    expect(JSON.stringify(admin)+inspect(admin,{showHidden:true})).not.toMatch(/human-step-up|BEGIN|[A-Za-z0-9_-]{43}/);
  });
  it('creates USER application metadata without a secret and refuses SERVICE-only rotation',async()=>{
    const made=await admin.createApplication({...applicationInput(),kind:'USER',oidcClientId:'synthetic_oidc'} as any);expect(made.application.kind).toBe('USER');expect(made).not.toHaveProperty('clientSecret');
    await expect(admin.rotateApplicationSecret(made.application.id,{expectedRevision:1})).rejects.toMatchObject({status:400});
  });
  it('paginates administrator metadata and business rows only when explicitly requested',async()=>{
    for(let n=0;n<3;n++)await admin.createApplication({...applicationInput(),label:'synthetic '+n} as any);
    const page=await admin.listApplications({limit:1});expect(page.items).toHaveLength(1);expect(page.nextAfter).toBe(page.items[0].id);const next=await admin.listApplications({limit:1,after:page.nextAfter!});expect(next.items[0].id>page.items[0].id).toBe(true);
    for(let n=0;n<2;n++)await sdk.createCustomer(h.b,{...customer(),identityNumber:'0000000001'+n},key(String(n)));
    const first=await sdk.listCustomers(h.b,{limit:1});expect(first.nextCursor).toBe(first.data[0].id);const second=await sdk.listCustomers(h.b,{limit:1,after:first.nextCursor!});expect(second.data[0].id>first.data[0].id).toBe(true);expect(second.nextCursor).toBe(null);
  });
  it('returns a finite format-not-available error when XLSX renderer was not configured',async()=>{
    await expect(reportSdk().createReport(reportQuery(),'XLSX',key())).rejects.toMatchObject({status:422});expect(r.store.jobs.size).toBe(0);expect(requests).toHaveLength(1);
  });
  it('never substitutes SERVICE or missing step-up for administrator authority',async()=>{
    a.state.stepUp=false;await expect(admin.listApplications()).rejects.toMatchObject({status:403});const {bearer:_b,...base}=options();const serviceAdmin=new FactuEzB2bAdminClient({...base,adminBearer:async()=>'synthetic-token'});await expect(serviceAdmin.listApplications()).rejects.toMatchObject({status:403});
    expect(()=>new FactuEzB2bAdminClient(options() as any)).toThrow('INVALID_CONFIGURATION');expect(()=>new FactuEzB2bClient({...options(),adminBearer} as any)).toThrow('INVALID_CONFIGURATION');
  });
  it('requires CA, approved client certificate and DER pin for administrator too',async()=>{
    const {bearer:_b,...base}=options();for(const patch of [{ca:tls.other},{serverCertificateSha256:fingerprint(tls.other)}])await expect(new FactuEzB2bAdminClient({...base,tls:{...base.tls,...patch},adminBearer}).listApplications()).rejects.toMatchObject({code:'TLS_OR_NETWORK_ERROR'});
    await expect(new FactuEzB2bAdminClient({...base,tls:{...base.tls,cert:tls.other},adminBearer}).listApplications()).rejects.toMatchObject({status:403});
  });
  it('detaches mutable caller bodies and binding before waiting for bearer',async()=>{
    let resume!:()=>void;const gate=new Promise<void>(r=>{resume=r;}),b=structuredClone(h.b),body=customer(),c=new FactuEzB2bClient({...options(),bearer:async()=>{await gate;return {token:'synthetic-token',actorKind:'USER'};}});const pending=c.createCustomer(b,body,key());body.legalName='MUTATED';b.issuerRuc='00000000999';resume();expect((await pending).data.legalName).toBe(customer().legalName);
  });
  it('rejects unknown/reserved keys, malformed IDs, revisions, base64 and oversized uploads before bearer',async()=>{
    for(const bad of [{...customer(),unknown:true},JSON.parse('{"__proto__":{},"legalName":"x"}')])await expect(sdk.createCustomer(h.b,bad as any,key())).rejects.toMatchObject({code:'INVALID_REQUEST'});
    await expect(sdk.updateCustomer(h.b,receivedId(1),{active:false},{...key(),expectedRevision:0})).rejects.toMatchObject({code:'INVALID_REQUEST'});
    await expect(sdk.readCustomer(h.b,'../admin/applications')).rejects.toMatchObject({code:'INVALID_REQUEST'});
    for(const contentBase64 of [Buffer.alloc(65537).toString('base64'),'YWJ='])await expect(sdk.receivedImportXML(receivedScope,{fileName:'original.xml',contentBase64},key())).rejects.toMatchObject({code:'INVALID_REQUEST'});
    const getter=vi.fn();await expect(sdk.createCustomer(h.b,{...customer(),get secret(){getter();return 1;}} as any,key())).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(getter).not.toHaveBeenCalled();expect(bearer).not.toHaveBeenCalled();expect(requests).toHaveLength(0);
  });
});
