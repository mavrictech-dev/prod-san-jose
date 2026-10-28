import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:https';
import {inspect} from 'node:util';
import {FactuEzB2bOwnerAdminClient} from '../packages/b2b-sdk/src/owner-admin';
import type {FactuEzB2bOptions} from '../packages/b2b-sdk/src/transport';
import type * as T from '../packages/b2b-sdk/src/owner-admin-types';
import {phase8AdminPolicy} from '../packages/service-access/src/b2b-phase8-admin-wire';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const binding:T.OwnerAdminBinding={issuerId:1,issuerRuc:'20123456789',environment:'BETA',branchId:id(1),pointId:id(2),seriesId:id(3),documentType:'01'};
const when='2026-10-24T12:00:00.000Z';
const settings:T.OwnerAdminPrintSettings={template:'SAN_JOSE_V1',logoMode:'DEFAULT',logoWidthMm:40,logoAlignment:'LEFT',showBranchAddress:true,footerNote:''};
const issuer=()=>({id:1,ruc:binding.issuerRuc,legalName:'SYNTHETIC OWNER',tradeName:null,taxAddress:'Synthetic address',ubigeo:'150101',phone:null,contactEmails:[],environment:'BETA',active:true,revision:2});
const branch=()=>({id:binding.branchId,companyId:1,code:'BR01',name:'Synthetic branch',address:null,active:true,revision:2});
const point=()=>({...branch(),id:binding.pointId,branchId:binding.branchId,trackNumber:null});
const series=()=>({id:binding.seriesId,companyId:1,emissionPointId:binding.pointId,documentType:'INVOICE',series:'F001',nextNumber:'1',active:true,revision:2});
const createdPoint=()=>({id:binding.pointId,companyId:1,branchId:binding.branchId,code:'PT01',name:'Synthetic point',active:true,revision:1,series:[{id:id(3),documentType:'INVOICE',series:'F001',revision:1},{id:id(4),documentType:'SALES_RECEIPT',series:'B001',revision:1}]});
const catalog=()=>({version:'factuez.station-admin.v1',capabilities:{betaOnly:true,softDelete:true,counterEditing:false},companies:[issuer()],branches:[{...branch(),effectiveActive:true,pointCount:1,openShiftCount:0}],emissionPoints:[{...point(),effectiveActive:true,openShiftCount:0}],series:[{...series(),effectiveActive:true,documentCount:0,canRename:true}]});
const user=()=>({id:id(5),username:'synthetic.user',fullName:'Synthetic User',active:true,lastLoginAt:null,roles:[{code:'CASHIER',name:'Cashier'}],branchIds:[binding.branchId],emissionPointIds:[binding.pointId],series:[binding.seriesId]});
const role=()=>({id:id(6),code:'CASHIER',name:'Cashier',description:null,permissions:['document.view'],editable:true,assignable:true});
const profile=()=>({version:'factuez.print-settings.v1',companyId:1,ruc:binding.issuerRuc,branchId:binding.branchId,revision:2,updatedAt:when,source:'BRANCH',storageReady:true,fiscalTransmission:false,override:{...settings},effective:{...settings},logoConfigured:false});
const fiscal=()=>({ruc:binding.issuerRuc,environment:'BETA',revision:2,updatedAt:when,solConfigured:true,greConfigured:true,fiscalTransmission:false,certificate:{configured:false,fingerprint:null,expiresAt:null,selfSigned:null,expired:false,trustAndRucVerified:false}});
const audit=()=>({ruc:binding.issuerRuc,environment:'BETA',page:2,pageSize:10,total:11,items:[{id:id(7),actorId:id(8),fields:['sol'],revision:1,occurredAt:when}]});
const smtp=()=>({companyId:1,ruc:binding.issuerRuc,state:'EXTERNAL_SMTP_DISABLED',revision:2,updatedAt:when,configured:true,credentialsConfigured:true,storageReady:true,encryption:'READY',integrity:'VALID',approvedHostListConfigured:true,hostnameApproved:true,networkAttempted:false,dnsValidated:false,smtpAuthenticationVerified:false,deliveredToClient:false,readyToSend:false});
const pdf=()=>({base64:Buffer.from('%PDF-1.7\nsynthetic preview\n%%EOF').toString('base64'),contentType:'application/pdf',fileName:'synthetic-preview.pdf'});
const issuerBody:T.OwnerAdminIssuerCreate={ruc:binding.issuerRuc,legalName:'SYNTHETIC OWNER',taxAddress:'Synthetic address',ubigeo:'150101'};
const userBody:T.OwnerAdminUserCreate={username:'synthetic.user',fullName:'Synthetic User',password:'SYNTHETIC_INPUT_SECRET_123',roles:['CASHIER'],branchIds:[binding.branchId],emissionPointIds:[binding.pointId],series:[binding.seriesId]};
const fiscalBody:T.OwnerAdminFiscalSave={expectedRevision:1,sol:{username:'synthetic.sol',password:'SYNTHETIC_INPUT_SECRET'},gre:{clientId:'synthetic-gre',clientSecret:'SYNTHETIC_INPUT_SECRET'}};
const smtpBody:T.OwnerAdminSmtpSave={expectedRevision:1,settings:{host:'smtp.example.com',port:587,tlsMode:'STARTTLS',fromName:'Synthetic sender',fromAddress:'synthetic@example.com',replyTo:null},credentials:{username:'synthetic',password:'SYNTHETIC_INPUT_SECRET'}};
type Case={action:T.OwnerAdminAction;method:'GET'|'POST'|'PATCH';path:string;data:()=>any;invoke:(sdk:FactuEzB2bOwnerAdminClient)=>Promise<unknown>;body?:unknown};
const cases:Case[]=[
  {action:'MASTERS_READ',method:'GET',path:'masters',data:catalog,invoke:s=>s.readMasters(binding)},
  {action:'ISSUER_CREATE',method:'POST',path:'issuers',data:issuer,body:issuerBody,invoke:s=>s.createIssuer(binding,issuerBody)},
  {action:'ISSUER_UPDATE',method:'PATCH',path:'issuers/1',data:issuer,body:{expectedRevision:1,legalName:'SYNTHETIC OWNER'},invoke:s=>s.updateIssuer(binding,{expectedRevision:1,legalName:'SYNTHETIC OWNER'})},
  {action:'BRANCH_CREATE',method:'POST',path:'branches',data:branch,body:{companyId:1,code:'BR01',name:'Synthetic branch'},invoke:s=>s.createBranch(binding,{companyId:1,code:'BR01',name:'Synthetic branch'})},
  {action:'BRANCH_UPDATE',method:'PATCH',path:`branches/${id(1)}`,data:branch,body:{expectedRevision:1,active:true},invoke:s=>s.updateBranch(binding,{expectedRevision:1,active:true})},
  {action:'POINT_CREATE',method:'POST',path:`branches/${id(1)}/points`,data:createdPoint,body:{code:'PT01',name:'Synthetic point',invoiceSeries:'F001',receiptSeries:'B001'},invoke:s=>s.createPoint(binding,{code:'PT01',name:'Synthetic point',invoiceSeries:'F001',receiptSeries:'B001'})},
  {action:'POINT_UPDATE',method:'PATCH',path:`points/${id(2)}`,data:point,body:{expectedRevision:1,trackNumber:null},invoke:s=>s.updatePoint(binding,{expectedRevision:1,trackNumber:null})},
  {action:'SERIES_CREATE',method:'POST',path:`points/${id(2)}/series`,data:series,body:{documentType:'INVOICE',series:'F001'},invoke:s=>s.createSeries(binding,{documentType:'INVOICE',series:'F001'})},
  {action:'SERIES_UPDATE',method:'PATCH',path:`series/${id(3)}`,data:series,body:{expectedRevision:1,active:true},invoke:s=>s.updateSeries(binding,{expectedRevision:1,active:true})},
  {action:'USERS_LIST',method:'GET',path:'users',data:()=>[{...user(),editable:true}],invoke:s=>s.listUsers(binding)},
  {action:'USERS_CREATE',method:'POST',path:'users',data:user,body:userBody,invoke:s=>s.createUser(binding,userBody)},
  {action:'USERS_UPDATE',method:'PATCH',path:`users/${id(5)}/access`,data:user,body:{active:true},invoke:s=>s.updateUser(binding,id(5),{active:true})},
  {action:'ROLES_LIST',method:'GET',path:'roles',data:()=>[role()],invoke:s=>s.listRoles(binding)},
  {action:'ROLES_UPDATE',method:'PATCH',path:'roles/CASHIER',data:()=>({code:'CASHIER',permissions:['document.view'],affectedUsers:1}),body:{permissions:['document.view'],expectedPermissions:[]},invoke:s=>s.updateRole(binding,'CASHIER',{permissions:['document.view'],expectedPermissions:[]})},
  {action:'PRINT_READ',method:'GET',path:'print-profiles/1',data:profile,invoke:s=>s.readPrintProfile(binding)},
  {action:'PRINT_SAVE',method:'PATCH',path:'print-profiles/1',data:profile,body:{expectedRevision:1,settings},invoke:s=>s.savePrintProfile(binding,{expectedRevision:1,settings})},
  {action:'PRINT_PREVIEW',method:'POST',path:'print-profiles/1/preview',data:pdf,body:{documentTypeCode:'01',format:'a4'},invoke:s=>s.previewPrintProfile(binding,{documentTypeCode:'01',format:'a4'})},
  {action:'FISCAL_READ',method:'GET',path:'fiscal-config/1/readiness',data:fiscal,invoke:s=>s.readFiscalConfiguration(binding)},
  {action:'FISCAL_AUDIT',method:'GET',path:'fiscal-config/1/audit',data:audit,invoke:s=>s.readFiscalAudit(binding,'2')},
  {action:'FISCAL_SAVE',method:'POST',path:'fiscal-config/1/replacements',data:fiscal,body:fiscalBody,invoke:s=>s.saveFiscalConfiguration(binding,fiscalBody)},
  {action:'SMTP_READ',method:'GET',path:'mail-config/1',data:smtp,invoke:s=>s.readSmtpConfiguration(binding)},
  {action:'SMTP_SAVE',method:'POST',path:'mail-config/1/replacements',data:smtp,body:smtpBody,invoke:s=>s.saveSmtpConfiguration(binding,smtpBody)},
];
function envelope(c:Case){return {schemaVersion:'factuez.b2b.owner-admin.v1',action:c.action,binding:{...binding},environment:'BETA',candidateOnly:true,fiscalExecutionEnabled:false,data:c.data()};}
/** Ephemeral loopback HTTPS and synthetic mTLS PKI. No service runtime, DB, credentials or external network. */
describe('B2B08 owner admin SDK: 22 real bounded HTTPS operations',{timeout:30000},()=>{
  let server:Server,tls:ReturnType<typeof b2bCertificates>,origin:string,sdk:FactuEzB2bOwnerAdminClient;
  let reply:any,status:number|undefined,token:string,actorKind:'USER'|'SERVICE',bearer:ReturnType<typeof vi.fn>;
  let records:{method:string;url:URL;body:any;authorization:string|undefined;actor:string|undefined;key:string|undefined}[];
  const options=():FactuEzB2bOptions=>({origin,tls:{ca:tls.ca,cert:tls.edge,key:tls.key,serverCertificateSha256:fingerprint(tls.server)},bearer:bearer as FactuEzB2bOptions['bearer']});
  function select(action:T.OwnerAdminAction){const c=cases.find(c=>c.action===action)!;reply=envelope(c);return c;}
  beforeAll(async()=>{
    tls=b2bCertificates();server=createServer({ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2'},async(req,res)=>{
      const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));const raw=Buffer.concat(chunks).toString('utf8');
      records.push({method:req.method!,url:new URL(req.url!,origin),body:raw?JSON.parse(raw):undefined,authorization:req.headers.authorization,actor:req.headers['x-factuez-actor-kind'] as string|undefined,key:req.headers['idempotency-key'] as string|undefined});
      res.writeHead(status??(req.method==='POST'?201:200),{'Content-Type':'application/json','Cache-Control':'private, no-store'});res.end(JSON.stringify(reply));
    });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`https://127.0.0.1:${(server.address() as {port:number}).port}`;
  },30000);
  beforeEach(()=>{records=[];status=undefined;token='synthetic-current-user';actorKind='USER';bearer=vi.fn(async()=>({token,actorKind}));sdk=new FactuEzB2bOwnerAdminClient(options());select('MASTERS_READ');});
  afterAll(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));});
  it('has exactly the 22 owner actions, explicit public methods and no generic execute',()=>{
    expect(cases).toHaveLength(22);expect(new Set(cases.map(c=>c.action)).size).toBe(22);expect(cases.map(c=>c.action).sort()).toEqual(Object.keys(phase8AdminPolicy).sort());
    expect(Object.getOwnPropertyNames(FactuEzB2bOwnerAdminClient.prototype).filter(k=>!['constructor','toJSON'].includes(k))).toHaveLength(22);expect('execute'in sdk).toBe(false);expect(Object.keys(sdk)).toEqual([]);
  });
  it.each(cases)('$action preserves route, verb, complete binding, exact body and HTTP status',async c=>{
    reply=envelope(c);const result:any=await c.invoke(sdk);expect(result).toMatchObject({action:c.action,binding,environment:'BETA',candidateOnly:true,fiscalExecutionEnabled:false});
    const record=records[0];expect(records).toHaveLength(1);expect(record.method).toBe(c.method);expect(record.url.pathname).toBe('/b2b/v1/admin/'+c.path);expect(record.body).toEqual(c.body);expect(record.actor).toBe('USER');expect(record.authorization).toBe('Bearer synthetic-current-user');expect(record.key).toBeUndefined();
    expect(Object.fromEntries(record.url.searchParams)).toEqual({...Object.fromEntries(Object.entries(binding).map(([k,v])=>[k,String(v)])),...(c.action==='FISCAL_AUDIT'?{page:'2'}:{})});expect(bearer).toHaveBeenCalledTimes(1);
    if(c.action==='PRINT_PREVIEW'){expect(Buffer.isBuffer(result.data.bytes)).toBe(true);expect(result.data.bytes.toString()).toContain('%PDF-');expect(result.data.base64).toBeUndefined();}
    else expect(result.data).toEqual(c.data());
  });
  it.each(cases)('$action rejects SERVICE credentials before opening a socket',async c=>{actorKind='SERVICE';reply=envelope(c);await expect(c.invoke(sdk)).rejects.toMatchObject({code:'TOKEN_UNAVAILABLE'});expect(records).toHaveLength(0);});
  it.each(cases)('$action rejects secret fields in every response shape',async c=>{reply=envelope(c);const data=Array.isArray(reply.data)?reply.data[0]:reply.data;data.password='SECRET_RESPONSE';await expect(c.invoke(sdk)).rejects.toMatchObject({code:'INVALID_RESPONSE'});});
  it.each(cases)('$action rejects incomplete data rather than trusting a valid envelope',async c=>{reply=envelope(c);if(Array.isArray(reply.data))delete reply.data[0].id;else delete reply.data[Object.keys(reply.data)[0]];await expect(c.invoke(sdk)).rejects.toMatchObject({code:'INVALID_RESPONSE'});});
  it.each([
    ['action',(r:any)=>{r.action='SMTP_READ';}],['environment',(r:any)=>{r.environment='PRODUCTION';}],['candidateOnly',(r:any)=>{r.candidateOnly=false;}],['fiscalExecutionEnabled',(r:any)=>{r.fiscalExecutionEnabled=true;}],['schemaVersion',(r:any)=>{r.schemaVersion='other';}],['binding scope',(r:any)=>{r.binding.branchId=id(99);}],['extra envelope secret',(r:any)=>{r.clientSecret='SECRET_RESPONSE';}],['missing envelope binding',(r:any)=>{delete r.binding;}],
  ])('rejects invalid %s',async(_label,mutate)=>{select('MASTERS_READ');mutate(reply);await expect(sdk.readMasters(binding)).rejects.toMatchObject({code:'INVALID_RESPONSE'});});
  it.each([
    ['wrong scope',{...binding,issuerId:0}],['production',{...binding,environment:'PRODUCTION'}],['extra binding',{...binding,token:'SECRET'}],['invalid series',{...binding,seriesId:'../escape'}],['unknown type',{...binding,documentType:'07'}],
  ])('rejects invalid input %s without network',async(_label,b)=>{await expect(sdk.readMasters(b as T.OwnerAdminBinding)).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(records).toHaveLength(0);expect(bearer).not.toHaveBeenCalled();});
  it('rejects getters, proxies, toJSON, prototype members and hidden properties without executing them',async()=>{
    const trap=vi.fn(()=>{throw new Error('SECRET_GETTER');});
    const hostile=[Object.defineProperty({...binding},'issuerId',{get:trap,enumerable:true}),new Proxy(binding,{ownKeys:trap,get:trap,getPrototypeOf:trap}),{...binding,toJSON:trap},Object.defineProperty({...binding},'secret',{value:'SECRET',enumerable:false}),{...binding,[Symbol('secret')]:'SECRET'}];
    for(const b of hostile)await expect(sdk.readMasters(b as T.OwnerAdminBinding)).rejects.toMatchObject({code:'INVALID_REQUEST'});
    await expect(sdk.saveFiscalConfiguration(binding,{expectedRevision:1,sol:Object.defineProperty({username:'synthetic'},'password',{get:trap,enumerable:true})} as any)).rejects.toMatchObject({code:'INVALID_REQUEST'});
    expect(trap).not.toHaveBeenCalled();expect(records).toHaveLength(0);
  });
  it('detaches nested input and binding before awaiting the current credential provider',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});bearer.mockImplementation(async()=>{await gate;return {token,actorKind};});select('SMTP_SAVE');
    const b={...binding},body=structuredClone(smtpBody),pending=sdk.saveSmtpConfiguration(b,body);b.issuerId=99;body.settings.host='mutated.example.com';body.credentials!.password='MUTATED';release();await pending;
    expect(records[0].body).toEqual(smtpBody);expect(records[0].url.searchParams.get('issuerId')).toBe('1');
  });
  it('refreshes USER authority for each call and propagates revocation without retry or replay',async()=>{
    await sdk.readMasters(binding);token='synthetic-revoked-user';status=401;reply={password:'SECRET_REMOTE_ERROR',message:'SECRET_REMOTE_ERROR'};
    const error:any=await sdk.readMasters(binding).catch(e=>e);expect(error).toMatchObject({code:'REMOTE_REQUEST_FAILED',status:401});expect(bearer).toHaveBeenCalledTimes(2);expect(records).toHaveLength(2);expect(records[1].authorization).toBe('Bearer synthetic-revoked-user');expect(JSON.stringify(error)+inspect(error)).not.toContain('SECRET_REMOTE_ERROR');
  });
  it('never retains credentials in serialization, inspection, or provider errors',async()=>{
    const before=JSON.stringify(sdk)+inspect(sdk,{showHidden:true,depth:10});expect(before).not.toMatch(/synthetic-current-user|BEGIN.*PRIVATE KEY|SYNTHETIC_INPUT_SECRET/);
    bearer.mockRejectedValueOnce(new Error('SECRET_PROVIDER'));const e:any=await sdk.readMasters(binding).catch(e=>e);expect(e.code).toBe('TOKEN_UNAVAILABLE');expect(JSON.stringify(e)+inspect(e)).not.toContain('SECRET_PROVIDER');expect(JSON.stringify(sdk)).toEqual(JSON.stringify({sdk:'FactuEzB2bOwnerAdminClient',environment:'BETA'}));
  });
  it('bounds a hanging USER provider with the transport timeout',async()=>{
    bearer.mockImplementation(()=>new Promise(()=>{}));const bounded=new FactuEzB2bOwnerAdminClient({...options(),timeoutMs:100});await expect(bounded.readMasters(binding)).rejects.toMatchObject({code:'REQUEST_TIMEOUT'});expect(records).toHaveLength(0);
  });
  it.each([200,202])('rejects POST status %s and does not retry',async code=>{select('FISCAL_SAVE');status=code;await expect(sdk.saveFiscalConfiguration(binding,fiscalBody)).rejects.toMatchObject({code:'REMOTE_REQUEST_FAILED',status:code});expect(records).toHaveLength(1);});
  it('rejects PATCH/GET status 201',async()=>{select('PRINT_SAVE');status=201;await expect(sdk.savePrintProfile(binding,{expectedRevision:1,settings})).rejects.toMatchObject({code:'REMOTE_REQUEST_FAILED',status:201});select('PRINT_READ');await expect(sdk.readPrintProfile(binding)).rejects.toMatchObject({code:'REMOTE_REQUEST_FAILED',status:201});});
  it.each(['networkAttempted','dnsValidated','smtpAuthenticationVerified','deliveredToClient','readyToSend'])('rejects false SMTP readiness claim %s',async key=>{select('SMTP_READ');reply.data[key]=true;await expect(sdk.readSmtpConfiguration(binding)).rejects.toMatchObject({code:'INVALID_RESPONSE'});});
  it.each(['trustAndRucVerified','fiscalTransmission'])('rejects false fiscal assurance %s',async key=>{select('FISCAL_READ');if(key==='trustAndRucVerified')reply.data.certificate[key]=true;else reply.data[key]=true;await expect(sdk.readFiscalConfiguration(binding)).rejects.toMatchObject({code:'INVALID_RESPONSE'});});
  it('rejects cross-owner rows, stale CAS revisions and nested credential material',async()=>{
    select('MASTERS_READ');reply.data.emissionPoints[0].branchId=id(99);await expect(sdk.readMasters(binding)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
    select('ISSUER_UPDATE');reply.data.revision=1;await expect(sdk.updateIssuer(binding,{expectedRevision:1,active:true})).rejects.toMatchObject({code:'INVALID_RESPONSE'});
    select('FISCAL_READ');reply.data.certificate.certificateCipher='SECRET_CIPHER';await expect(sdk.readFiscalConfiguration(binding)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
    select('USERS_LIST');reply.data[0].roles[0].passwordHash='SECRET_HASH';await expect(sdk.listUsers(binding)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
    select('SMTP_READ');reply.data.settings={host:'SECRET_HOST'};await expect(sdk.readSmtpConfiguration(binding)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
    select('PRINT_READ');reply.data.effective.logoPreviewDataUrl='SECRET_DATA';await expect(sdk.readPrintProfile(binding)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  });
  it.each(['0','01','1000000','1&token=SECRET'])('keeps audit page a bounded decimal query string: %s',async page=>{await expect(sdk.readFiscalAudit(binding,page)).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(records).toHaveLength(0);});
  it('defaults audit page to query string 1 with no GET body',async()=>{select('FISCAL_AUDIT');reply.data={...audit(),page:1,total:0,items:[]};await sdk.readFiscalAudit(binding);expect(records[0].url.searchParams.get('page')).toBe('1');expect(records[0].body).toBeUndefined();});
  it('refuses privileged action expansion and resources outside the binding',async()=>{
    const bad=[()=>sdk.updateIssuer(binding,{expectedRevision:1,ruc:'20999999999'} as any),()=>sdk.updateSeries(binding,{expectedRevision:1,active:true,nextNumber:'5'} as any),()=>sdk.updateSeries(binding,{expectedRevision:1,active:true,series:'F999'} as any),()=>sdk.updateRole(binding,'ADMIN' as any,{permissions:[],expectedPermissions:[]}),()=>sdk.updateRole(binding,'../ADMIN' as any,{permissions:[],expectedPermissions:[]}),()=>sdk.createBranch(binding,{companyId:99,code:'BR01',name:'Bad scope'}),()=>sdk.createUser(binding,{...userBody,branchIds:[id(99)]}),()=>sdk.saveFiscalConfiguration(binding,{expectedRevision:1,remove:['sol']} as any),()=>sdk.saveSmtpConfiguration(binding,{...smtpBody,verify:true} as any),()=>sdk.previewPrintProfile(binding,{documentTypeCode:'01',format:'a4',draft:{settings,logoUpload:{mediaType:'image/png',base64:'AAAA'}}})];
    for(const call of bad)await expect(call()).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(records).toHaveLength(0);
  });
  it('accepts maximum-size synthetic P12 input and a 256 KiB logo only on configured writes',async()=>{
    select('FISCAL_SAVE');const body={expectedRevision:1,certificate:{fileName:'synthetic.p12',base64:Buffer.alloc(512*1024,65).toString('base64'),password:'SYNTHETIC_INPUT_SECRET'}};await sdk.saveFiscalConfiguration(binding,body);expect(records[0].body).toEqual(body);
    select('PRINT_SAVE');const png=Buffer.alloc(256*1024,65);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);const draft:T.OwnerAdminPrintSave={expectedRevision:1,settings:{...settings,logoMode:'CUSTOM'},logoUpload:{mediaType:'image/png',base64:png.toString('base64')}};await sdk.savePrintProfile(binding,draft);expect(records[1].body).toEqual(draft);
    select('PRINT_PREVIEW');await sdk.previewPrintProfile(binding,{documentTypeCode:'01',format:'ticket',draft:{settings:draft.settings,logoUpload:draft.logoUpload}});expect(records[2].body.draft.logoUpload).toEqual(draft.logoUpload);
    await expect(sdk.createIssuer(binding,{...issuerBody,legalName:'A'.repeat(128*1024+1)})).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(records).toHaveLength(3);
  });
  it('decodes a 1,500,000-byte PDF response through the bounded real transport',async()=>{
    select('PRINT_PREVIEW');const bytes=Buffer.alloc(1_500_000,32);bytes.write('%PDF-1.7\n');reply.data.base64=bytes.toString('base64');const result=await sdk.previewPrintProfile(binding,{documentTypeCode:'01',format:'a4'});expect(result.data.bytes.equals(bytes)).toBe(true);
  });
  it.each([
    ['noncanonical base64',(d:any)=>{d.base64='JVBERi0=\n';}],['MIME',(d:any)=>{d.contentType='text/html';}],['filename traversal',(d:any)=>{d.fileName='../secret.pdf';}],['filename extension',(d:any)=>{d.fileName='secret.exe';}],['non-PDF',(d:any)=>{d.base64=Buffer.from('SECRET_NOT_PDF').toString('base64');}],['over 1.5 MB',(d:any)=>{const b=Buffer.alloc(1_500_001,32);b.write('%PDF-');d.base64=b.toString('base64');}],
  ])('rejects preview %s',async(_label,mutate)=>{select('PRINT_PREVIEW');mutate(reply.data);await expect(sdk.previewPrintProfile(binding,{documentTypeCode:'01',format:'a4'})).rejects.toMatchObject({code:'INVALID_RESPONSE'});});
  it('accepts only the nullable master fields omitted by adminPick on sparse owner rows',async()=>{
    select('MASTERS_READ');delete reply.data.branches[0].address;delete reply.data.emissionPoints[0].address;delete reply.data.emissionPoints[0].trackNumber;
    const catalogResult=await sdk.readMasters(binding);expect(catalogResult.data.branches[0].address).toBeUndefined();expect(catalogResult.data.emissionPoints[0].trackNumber).toBeUndefined();
    select('BRANCH_UPDATE');delete reply.data.address;await sdk.updateBranch(binding,{expectedRevision:1,active:true});
    select('POINT_UPDATE');delete reply.data.address;delete reply.data.trackNumber;await sdk.updatePoint(binding,{expectedRevision:1,active:true});
    select('MASTERS_READ');delete reply.data.branches[0].pointCount;await expect(sdk.readMasters(binding)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  });
  it('rejects over-limit certificate/logo and invalid SMTP/fiscal inputs before credentials are requested',async()=>{
    const calls=[()=>sdk.saveFiscalConfiguration(binding,{expectedRevision:1,certificate:{fileName:'synthetic.p12',base64:Buffer.alloc(512*1024+1).toString('base64'),password:'synthetic'}}),()=>sdk.savePrintProfile(binding,{expectedRevision:1,settings:{...settings,logoMode:'CUSTOM'},logoUpload:{mediaType:'image/png',base64:Buffer.alloc(256*1024+1).toString('base64')}}),()=>sdk.saveSmtpConfiguration(binding,{...smtpBody,settings:{...smtpBody.settings,port:465}}),()=>sdk.saveSmtpConfiguration(binding,{...smtpBody,settings:{...smtpBody.settings,host:'127.0.0.1'}}),()=>sdk.saveFiscalConfiguration(binding,{expectedRevision:1,sol:{username:'invalid user',password:'synthetic'}})];
    for(const call of calls)await expect(call()).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(bearer).not.toHaveBeenCalled();expect(records).toHaveLength(0);
  });
});

