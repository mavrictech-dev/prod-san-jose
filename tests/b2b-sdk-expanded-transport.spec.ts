import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:https';
import {BoundedTransport,type Operation} from '../packages/b2b-sdk/src/transport';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';

// Transport tests deliberately do not stand in for owner authorization/DTO tests.
const uuid='40000000-0000-4000-8000-000000000001',record='a'.repeat(64);
const cases:[Operation,string,string,string[]][]=[
 ['ownerMasters','GET','admin/masters',[]],['ownerIssuerCreate','POST','admin/issuers',[]],['ownerIssuerUpdate','PATCH','admin/issuers/7',['7']],
 ['ownerBranchCreate','POST','admin/branches',[]],['ownerBranchUpdate','PATCH','admin/branches/'+uuid,[uuid]],['ownerPointCreate','POST','admin/branches/'+uuid+'/points',[uuid]],['ownerPointUpdate','PATCH','admin/points/'+uuid,[uuid]],['ownerSeriesCreate','POST','admin/points/'+uuid+'/series',[uuid]],['ownerSeriesUpdate','PATCH','admin/series/'+uuid,[uuid]],
 ['ownerUsers','GET','admin/users',[]],['ownerUserCreate','POST','admin/users',[]],['ownerUserUpdate','PATCH','admin/users/'+uuid+'/access',[uuid]],['ownerRoles','GET','admin/roles',[]],['ownerRoleUpdate','PATCH','admin/roles/ADMIN',['ADMIN']],
 ['ownerPrintRead','GET','admin/print-profiles/7',['7']],['ownerPrintSave','PATCH','admin/print-profiles/7',['7']],['ownerPrintPreview','POST','admin/print-profiles/7/preview',['7']],
 ['ownerFiscalRead','GET','admin/fiscal-config/7/readiness',['7']],['ownerFiscalAudit','GET','admin/fiscal-config/7/audit',['7']],['ownerFiscalSave','POST','admin/fiscal-config/7/replacements',['7']],['ownerSmtpRead','GET','admin/mail-config/7',['7']],['ownerSmtpSave','POST','admin/mail-config/7/replacements',['7']],
 ['receptionConfigRead','GET','admin/received-connectors/7',['7']],['receptionConfigSave','PATCH','admin/received-connectors/7',['7']],['receptionSyncCreate','POST','received-sync-jobs',[]],['receptionSyncRead','GET','received-sync-jobs/'+uuid,[uuid]],
 ['historyList','GET','history/documents',[]],['historyDetail','GET','history/documents/'+record,[record]],['historyContent','GET','history/documents/'+record+'/artifacts/SIGNED_XML',[record,'SIGNED_XML']],
 ['emailCreate','POST','documents/'+uuid+'/email-deliveries',[uuid]],['emailRead','GET','email-deliveries/'+uuid,[uuid]],
];
describe('expanded SDK transport: closed 31-operation boundary',()=>{
 let tls:ReturnType<typeof b2bCertificates>,server:Server,origin:string,transport:BoundedTransport,mode:string,seen:any[];
 const bearer=vi.fn(async()=>({token:'synthetic-user-token',actorKind:'USER' as 'USER'|'SERVICE'}));
 const options=()=>({origin,tls:{ca:tls.ca,cert:tls.edge,key:tls.key,serverCertificateSha256:fingerprint(tls.server)},bearer});
 beforeAll(async()=>{
  tls=b2bCertificates();server=createServer({ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2'},async(req,res)=>{
   const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);
   seen.push({method:req.method,url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString()});
   const file=req.url!.includes('/artifacts/'),status=req.method==='POST'?req.url!.includes('/email-deliveries')?202:201:200;
   let value:any=mode==='large-preview'?{data:{base64:'Y'.repeat(100000)}}:mode==='large-other-field'?{data:{note:'Y'.repeat(100000)}}:{};
   res.writeHead(mode==='wrong-status'?200:status,{'Content-Type':file?'application/xml':'application/json'});res.end(file?'<x/>':JSON.stringify(value));
  });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin='https://127.0.0.1:'+(server.address() as {port:number}).port;
 },30000);
 beforeEach(()=>{seen=[];mode='normal';bearer.mockReset().mockResolvedValue({token:'synthetic-user-token',actorKind:'USER'});transport=new BoundedTransport(options(),false);});
 afterAll(async()=>{server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));});
 it.each(cases)('dispatches %s using its exact fixed method, path and accepted status',async(op,method,path,ids)=>{
  if(op==='historyContent')expect((await transport.file(op,ids,{environment:'BETA'},4)).bytes.toString()).toBe('<x/>');
  else expect(await transport.json(op,ids,{environment:'BETA'},method==='GET'?undefined:{})).toEqual({});
  expect(seen).toHaveLength(1);expect(seen[0]).toMatchObject({method,url:'/b2b/v1/'+path+'?environment=BETA',headers:{'x-factuez-actor-kind':'USER'}});expect(bearer).toHaveBeenCalledOnce();
 });
 it.each(['ownerMasters','ownerIssuerCreate','receptionConfigRead'] as const)('denies a SERVICE credential before network for %s',async op=>{
  bearer.mockResolvedValue({token:'synthetic-service-token',actorKind:'SERVICE'});
  await expect(transport.json(op,op==='receptionConfigRead'?['7']:[],{},op==='ownerIssuerCreate'?{}:undefined)).rejects.toMatchObject({code:'TOKEN_UNAVAILABLE'});expect(seen).toEqual([]);
 });
 it('puts additional verification only in the reception header, never the query/body',async()=>{
  await transport.json('receptionSyncCreate',[],{environment:'BETA'},{source:'ALL'},'synthetic_sync_key_001',{stepUpHandle:'synthetic-live-step-up'});
  expect(seen[0].headers['x-factuez-step-up']).toBe('synthetic-live-step-up');expect(seen[0].url).not.toContain('step-up');expect(seen[0].body).toBe('{"source":"ALL"}');
  for(const op of ['ownerMasters','emailRead'] as const)await expect(transport.json(op,op==='emailRead'?[uuid]:[],{},undefined,undefined,{stepUpHandle:'inapplicable'})).rejects.toThrow();
  expect(seen).toHaveLength(1);
 });
 it.each([['ownerIssuerUpdate',['0']],['ownerRoleUpdate',['ADMIN/../roles']],['historyDetail',[uuid]],['historyContent',[record,'../../signed.xml']],['emailRead',[record]]] as [Operation,string[]][] )('rejects route substitution %s before resolving credentials',async(op,ids)=>{
  await expect(transport.json(op,ids,{})).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(seen).toEqual([]);expect(bearer).not.toHaveBeenCalled();
 });
 it('retains the separate application-administration transport',async()=>{
  await expect(transport.json('adminList',[],{})).rejects.toMatchObject({code:'INVALID_REQUEST'});
  // Invalid options must never silently switch a client to administrative identity.
  expect(()=>new BoundedTransport({...options(),bearer:undefined,adminBearer:async()=>'synthetic-admin-proof'} as any,true)).toThrow('INVALID_CONFIGURATION');
  const {bearer:_provider,...rest}=options(),admin=new BoundedTransport({...rest,adminBearer:async()=>'synthetic-admin-proof'},true);
  await expect(admin.json('ownerMasters',[],{})).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(seen).toEqual([]);
 });
 it('admits larger certificate payloads only on the explicitly expanded paths',async()=>{
  const body={base64:'A'.repeat(200000)};
  await transport.json('ownerFiscalSave',['7'],{},body);expect(seen).toHaveLength(1);
  await expect(transport.json('ownerUserCreate',[],{},body)).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(seen).toHaveLength(1);
  await expect(transport.json('ownerFiscalSave',['7'],{},{base64:'A'.repeat(1024*1024)})).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(seen).toHaveLength(1);
 });
 it('admits a large preview base64 solely at the expected response location',async()=>{
  mode='large-preview';expect((await transport.json('ownerPrintPreview',['7'],{},{})) as any).toHaveProperty('data.base64');
  await expect(transport.json('ownerPrintRead',['7'],{})).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  mode='large-other-field';await expect(transport.json('ownerPrintPreview',['7'],{},{})).rejects.toMatchObject({code:'INVALID_RESPONSE'});
 });
 it('requires 202 for email creation rather than mistaking an arbitrary 200 for success',async()=>{
  mode='wrong-status';await expect(transport.json('emailCreate',[uuid],{},{})).rejects.toMatchObject({code:'REMOTE_REQUEST_FAILED',status:200});
 });
});
