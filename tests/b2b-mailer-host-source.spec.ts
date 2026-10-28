import {beforeAll,afterEach,describe,it,expect,vi} from 'vitest';
import {createServer,type Server} from 'node:https';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {inspect} from 'node:util';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {adminDigest} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import type {B2bBinding,B2bPrincipal} from '@factuez/contracts/b2b-security';
import {MailerReaderToken,MAILER_READER_SCOPES} from '../services/mailer-worker/src/b2b/host-reader-token';
import {MailerOwnerDocumentSource} from '../services/mailer-worker/src/b2b/host-document-source';
import {createBuiltinMailerHostPorts} from '../services/mailer-worker/src/b2b/host';
import {requireMailerHostPorts} from '../services/mailer-worker/src/b2b/runtime';
import type {B2bMailerRuntimeConfig} from '../services/mailer-worker/src/b2b/runtime-config';
import {emailHash} from '../services/mailer-worker/src/b2b/email-deliveries';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
let tls:ReturnType<typeof b2bCertificates>;
const servers:Server[]=[],sources:MailerOwnerDocumentSource[]=[],tokens:MailerReaderToken[]=[];
const roots:string[]=[],otherOwners:{close():void|Promise<void>}[]=[];
beforeAll(()=>{tls=b2bCertificates();},30000);
afterEach(async()=>{for(const o of otherOwners.splice(0))await o.close();for(const s of sources.splice(0))s.close();for(const t of tokens.splice(0))t.close();for(const s of servers.splice(0))await new Promise<void>(r=>s.close(()=>r()));
 for(const r of roots.splice(0)){if(dirname(resolve(r))!==resolve(realpathSync(tmpdir()))||!basename(r).startsWith('factuez-mailer-host-')||realpathSync(r)!==resolve(r))throw Error('UNSAFE_FIXTURE_CLEANUP');rmSync(r,{recursive:true,force:true});}vi.restoreAllMocks();});
async function fixture(){
 const binding:B2bBinding={issuerId:1,issuerRuc:'20000000001',environment:'BETA',branchId:randomUUID(),pointId:randomUUID(),seriesId:randomUUID(),documentType:'03'};
 const other={...binding,branchId:randomUUID(),pointId:randomUUID(),seriesId:randomUUID()},documentId=randomUUID(),memberId=randomUUID(),batchId=randomUUID();
 const actor:B2bPrincipal={kind:'USER',clientId:randomUUID(),revision:1,subjectId:randomUUID(),userAuthRevision:1,environment:'BETA',scopes:['b2b:email:send','b2b:documents:read','b2b:artifacts:read'],bindings:[binding]};
 const reader:B2bPrincipal={kind:'SERVICE',clientId:randomUUID(),revision:1,subjectId:null,userAuthRevision:null,environment:'BETA',scopes:[...MAILER_READER_SCOPES],bindings:[binding,other]};
 const secret=Buffer.from('s'.repeat(43)),snapshot={documentId,environment:'BETA',companyId:1,branchId:binding.branchId,items:[]};
 const xml=Buffer.from('<SyntheticOriginal/>'),cdr=Buffer.from('PK-SyntheticOriginalCDR'),pdf=Buffer.from('%PDF-1.7 SyntheticOnly');
 const xmlId=randomUUID(),cdrId=randomUUID();let shared=false,xmlFromBatch=false,changed=false,missing=false,corrupt=false,revoked=false,extraScope=false,revision=1,tokenStatus=200,tokenScope=MAILER_READER_SCOPES.join(' '),tokenLifetime=300;
 const requests:{path:string;authorization?:string;body:any}[]=[];
 const metadata=()=>({schemaVersion:'factuez.integration.v1',items:missing?[]:[
  {id:xmlId,kind:'SIGNED_XML',owner:{kind:xmlFromBatch?'BATCH':'DOCUMENT',id:xmlFromBatch?batchId:documentId},fileName:'original.xml',mediaType:'application/xml',sha256:emailHash(xml),byteLength:xml.length,availability:'AVAILABLE',representation:'ORIGINAL'},
  {id:cdrId,kind:'CDR_ZIP',owner:{kind:shared?'BATCH':'DOCUMENT',id:shared?batchId:documentId},fileName:'original.zip',mediaType:'application/zip',sha256:emailHash(cdr),byteLength:cdr.length,availability:'AVAILABLE',representation:'ORIGINAL'}],warnings:[]});
 const server=createServer({ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true},async(req,res)=>{
  const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));
  const raw=Buffer.concat(chunks).toString(),body=req.url==='/b2b/oauth/token'?Object.fromEntries(new URLSearchParams(raw)):JSON.parse(raw);
  requests.push({path:req.url!,authorization:req.headers.authorization,body});
  const json=(value:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(req.url==='/b2b/oauth/token')return json({access_token:'machine-only.fixture.token',token_type:'Bearer',expires_in:tokenLifetime,scope:tokenScope},tokenStatus);
  if(req.url==='/internal/b2b/introspect')return json({...reader,scopes:extraScope?[...reader.scopes,'b2b:documents:issue']:reader.scopes});
  if(req.url==='/internal/b2b/authorize-email-actor')return revoked?json({code:'DENIED'},403):json({schemaVersion:'factuez.b2b.email-actor.response.v1',requestSha256:adminDigest(body),principal:{...actor,scopes:body.requiredScopes},verifiedAt:Date.now(),expiresAt:Date.now()+10000});
  if(req.url==='/internal/b2b/read'){
   if(body.action==='batch')return json({identifier:'RC-LOCAL',items:[{documentId,conditionCode:'1'},{documentId:memberId,conditionCode:'1'}]});
   const id=body.args.id,context=id===memberId?other:binding;
   return json({schemaVersion:'factuez.b2b.v1',context,document:{id},snapshotSha256:adminDigest(snapshot),...(body.action==='print-snapshot'?{snapshot,presentation:{revision}}:{})});
  }
  if(req.url==='/internal/b2b/fiscal-read'){
   if(body.action==='artifacts')return json(metadata());
   const bytes=body.action==='pdf'?pdf:body.args.id===xmlId?xml:cdr,name=body.action==='pdf'?'current.pdf':body.args.id===xmlId?'original.xml':'original.zip',mime=body.action==='pdf'?'application/pdf':body.args.id===xmlId?'application/xml':'application/zip';
   if(body.action==='pdf'&&changed)revision++;
   const out=corrupt&&body.action==='content'?Buffer.from('bad'):bytes;
   res.writeHead(200,{'Content-Type':mime,'Content-Length':out.length,'Content-Disposition':`attachment; filename="${name}"`,'X-Content-Sha256':emailHash(out)});return res.end(out);
  }
  return json({},404);
 });servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin='https://127.0.0.1:'+(server.address() as AddressInfo).port,t={ca:tls.ca,cert:tls.edge,key:tls.key},client=new B2bPrivateHttp(origin,t);
 const token=new MailerReaderToken(origin,t,fingerprint(tls.server),reader.clientId,secret);tokens.push(token);
 const source=new MailerOwnerDocumentSource(client,client,client,client,token);sources.push(source);
 return {origin,t,binding,other,actor,reader,documentId,xml,cdr,pdf,requests,secret,source,token,
  set shared(v:boolean){shared=v;},set xmlFromBatch(v:boolean){xmlFromBatch=v;},set changed(v:boolean){changed=v;},set missing(v:boolean){missing=v;},set corrupt(v:boolean){corrupt=v;},set revoked(v:boolean){revoked=v;},set extraScope(v:boolean){extraScope=v;},
  set tokenStatus(v:number){tokenStatus=v;},set tokenScope(v:string){tokenScope=v;},set tokenLifetime(v:number){tokenLifetime=v;}};
}
describe('Mailer builtin source, real HTTPS/mTLS with synthetic owner wire fixtures',()=>{
 it('obtains a fixed-scope SERVICE token and preserves the actual current PDF and original bytes',async()=>{
  const f=await fixture(),result=await f.source.authorizeDocumentCurrent(f.actor,f.binding,f.documentId,'a4');
  expect(result.attachments.map(a=>a.kind)).toEqual(['PDF','XML','CDR']);expect(result.attachments.map(a=>Buffer.from(a.bytes))).toEqual([f.pdf,f.xml,f.cdr]);
  expect(result.sourceProofSha256).toMatch(/^[a-f0-9]{64}$/);expect(result.presentationRevision).toMatch(/^[a-f0-9]{64}$/);
  const tokenRequest=f.requests.find(r=>r.path==='/b2b/oauth/token')!;
  expect(tokenRequest.body).toEqual({grant_type:'client_credentials',scope:MAILER_READER_SCOPES.join(' ')});
  expect(f.requests.filter(r=>['/internal/b2b/read','/internal/b2b/fiscal-read'].includes(r.path)).every(r=>r.authorization==='Bearer machine-only.fixture.token')).toBe(true);
  expect(f.requests.filter(r=>r.path==='/internal/b2b/authorize-email-actor').every(r=>!r.authorization)).toBe(true);
 });
 it('denies a shared CDR when a single batch member belongs to another unauthorized branch',async()=>{
  const f=await fixture();f.shared=true;
  await expect(f.source.authorizeDocumentCurrent(f.actor,f.binding,f.documentId,'a4')).rejects.toMatchObject({code:'EMAIL_ARTIFACT_INTEGRITY'});
  expect(f.requests.some(r=>r.path==='/internal/b2b/fiscal-read'&&r.body.action==='content')).toBe(false);
 });
 it('rejects a batch XML offered as the signed original of an individual document',async()=>{
  const f=await fixture();f.xmlFromBatch=true;
  await expect(f.source.authorizeDocumentCurrent(f.actor,f.binding,f.documentId,'a4')).rejects.toMatchObject({code:'EMAIL_ARTIFACT_INTEGRITY'});
  expect(f.requests.some(r=>r.path==='/internal/b2b/fiscal-read'&&r.body.action==='content')).toBe(false);
 });
 it('allows a shared CDR only when the fresh queued actor covers every member',async()=>{
  const f=await fixture();f.shared=true;f.actor.bindings.push(f.other);
  expect((await f.source.authorizeDocumentCurrent(f.actor,f.binding,f.documentId,'ticket')).attachments).toHaveLength(3);
  expect(f.requests.filter(r=>r.body.action==='batch')).toHaveLength(2);
 });
 it('keeps missing originals absent; the email core can leave the job waiting',async()=>{
  const f=await fixture();f.missing=true;
  expect((await f.source.authorizeDocumentCurrent(f.actor,f.binding,f.documentId,'a4')).attachments.map(a=>a.kind)).toEqual(['PDF']);
 });
 it.each(['layout','bytes','actor','reader'] as const)('fails closed on %s change or excessive service scope',async(which)=>{
  const f=await fixture();if(which==='layout')f.changed=true;if(which==='bytes')f.corrupt=true;if(which==='actor')f.revoked=true;if(which==='reader')f.extraScope=true;
  await expect(f.source.authorizeDocumentCurrent(f.actor,f.binding,f.documentId,'a4')).rejects.toBeDefined();
 });
 it('checks the identity server pin before sending the client secret',async()=>{
  const f=await fixture(),t=new MailerReaderToken(f.origin,f.t,'0'.repeat(64),f.reader.clientId,f.secret);tokens.push(t);
  await expect(t.token()).rejects.toMatchObject({code:'EMAIL_READER_UNAVAILABLE'});expect(f.requests).toHaveLength(0);
 });
 it.each(['scope','lifetime','redirect'] as const)('rejects an unexpected %s token response',async(which)=>{
  const f=await fixture();if(which==='scope')f.tokenScope+=' b2b:documents:issue';if(which==='lifetime')f.tokenLifetime=3600;if(which==='redirect')f.tokenStatus=302;
  await expect(f.token.token()).rejects.toMatchObject({code:'EMAIL_READER_UNAVAILABLE'});expect(f.requests).toHaveLength(1);
 });
 it('redacts inspection, does not own the caller secret buffer, and closes admission',async()=>{
  const f=await fixture();expect(JSON.stringify(f.source)+inspect(f.source)+JSON.stringify(f.token)+inspect(f.token)).not.toContain(f.secret.toString());
  f.source.close();expect(f.secret.toString()).toBe('s'.repeat(43));await expect(f.token.token()).rejects.toMatchObject({code:'EMAIL_READER_UNAVAILABLE'});
  await expect(f.source.authorizeDocumentCurrent(f.actor,f.binding,f.documentId,'a4')).rejects.toMatchObject({status:404});
 });
 it('constructs the actual builtin source and prepared SMTP resource from explicit synthetic mounts without opening PG or SMTP',async()=>{
  const f=await fixture(),root=mkdtempSync(join(realpathSync(tmpdir()),'factuez-mailer-host-'));roots.push(root);
  writeFileSync(join(root,'mailer-artifacts.json'),JSON.stringify({schemaVersion:'factuez.b2b.mailer-artifacts.v1',environment:'BETA',clientId:f.reader.clientId,fiscalOrigin:f.origin,identityServerSha256:fingerprint(tls.server)}));
  writeFileSync(join(root,'reader-secret.bin'),f.secret,{mode:0o600});
  for(const p of ['reader-token','fiscal','email-worker']){
   writeFileSync(join(root,p+'-ca.pem'),tls.ca);writeFileSync(join(root,p+'.crt'),tls.edge);writeFileSync(join(root,p+'.key'),tls.key,{mode:0o600});
  }
  writeFileSync(join(root,'smtp-host.json'),JSON.stringify({schemaVersion:'factuez.b2b.mailer-smtp-host.v1',environment:'BETA',profile:'PREPARED_ONLY',keyFile:'smtp-key.bin',keyVersion:1,approvedHosts:['smtp.example.com']}));
  writeFileSync(join(root,'smtp-key.bin'),Buffer.alloc(32,9),{mode:0o600});
  const pool={connect:vi.fn(async()=>{throw Error('NO_DATABASE_IN_CONSTRUCTION');}),end:vi.fn(async()=>{})},client=new B2bPrivateHttp(f.origin,f.t);
  const config={smtpAdministration:true,identityOrigin:f.origin,database:{name:'factuez_mailer_beta',user:'mailer_owner'}} as B2bMailerRuntimeConfig;
  const ports=await createBuiltinMailerHostPorts(root,pool,{config,identityHttp:client,billingHttp:client});
  otherOwners.push(ports.emailSource as MailerOwnerDocumentSource,ports.smtpOwner!);
  expect(()=>requireMailerHostPorts(ports,config)).not.toThrow();expect(pool.connect).not.toHaveBeenCalled();expect(f.requests).toHaveLength(0);
  expect(()=>requireMailerHostPorts(ports,{...config,profile:'CORPORATE',corporate:{realSendEnabled:true,approvedHosts:['smtp.example.com']}})).toThrow('B2B_MAILER_CORPORATE_OWNER_RESOURCE_REQUIRED');
  expect(pool.connect).not.toHaveBeenCalled();expect(f.requests).toHaveLength(0);
  expect((await ports.emailSource!.authorizeDocumentCurrent(f.actor,f.binding,f.documentId,'a4')).attachments).toHaveLength(3);
  expect(pool.connect).not.toHaveBeenCalled();expect(pool.end).not.toHaveBeenCalled();
  await expect(createBuiltinMailerHostPorts(root,pool,{config:{...config,identityOrigin:'http://not-allowed.invalid'},identityHttp:client,billingHttp:client})).rejects.toThrow('ARTIFACT_SOURCE_CONFIGURATION_INVALID');
 });
});
