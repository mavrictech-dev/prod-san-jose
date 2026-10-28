import 'reflect-metadata';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {createServer,request} from 'node:https';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createB2bSunatRuntime,type B2bSunatRuntimeDependencies,type B2bSunatRuntimeConfig} from '../services/sunat-service/src/b2b/runtime';
import {sunatRuntimeSchemaChecks,checkSunatRuntimeSchema} from '../services/sunat-service/src/b2b/runtime-schema';
import {validateRuntimeXml} from '../services/sunat-service/src/b2b/runtime-validation';
import {B2bOwnerDrain} from '../packages/service-access/src/b2b-owner-drain';
import {B2bPrivateHttp,B2bIdentityHttp} from '../packages/service-access/src/b2b';
import {correctionEvidenceResponse} from '../packages/service-access/src/b2b-correction-evidence-wire';
import {B2bSecurityError} from '../packages/contracts/src/b2b-security';
import {B2bReadScopes} from '../packages/contracts/src/b2b-security';
import {BetaOwnerXmlTrust} from '../services/sunat-service/src/infrastructure/crypto/beta-owner-xml-trust';
import {CertificateTrustService} from '../services/sunat-service/src/infrastructure/crypto/certificate-trust.service';
import {SecretVault} from '../services/sunat-service/src/infrastructure/crypto/secret-vault';
import {CertificateInspectionService} from '../services/sunat-service/src/infrastructure/crypto/certificate-inspection.service';
import {CurrentPdfService} from '../services/sunat-service/src/application/current-pdf.service';
import {XsdValidationService} from '../services/sunat-service/src/infrastructure/sunat/xsd-validation.service';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {createGuideSidecarPki,zipSync} from './helpers/guide-sidecar-ephemeral-pki.fixture';
import {guideIssueFixture} from './helpers/guide-issue.fixture';
import {supplementCommandFixture,supplementUuid} from './helpers/fiscal-supplement.fixture';
import {fiscalSnapshotSha256} from '../packages/sunat-core/src/fiscal-note';
import {readFixture,issuerRuc,documentId,artifactId,branchId,pointId,counterId} from './integration-read.fixture';
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const runFile=promisify(execFile);
let tls:ReturnType<typeof b2bCertificates>,guidePki:ReturnType<typeof createGuideSidecarPki>,batchPki:ReturnType<typeof createGuideSidecarPki>;
let xsd:XsdValidationService;
const cleanups:(()=>Promise<void>)[]=[];
beforeAll(async()=>{
 tls=b2bCertificates();guidePki=createGuideSidecarPki('20000000001');batchPki=createGuideSidecarPki();
 xsd=new XsdValidationService();
 // REAL official pinned ZIP extraction, REAL libxml schema evaluation. Only the process
 // port changes on Windows; no validate=true, schema bypass or fabricated proof.
 Object.assign(xsd,{run:async(bytes:Buffer,schema:string)=>{
  const script='import sys\nfrom lxml import etree\np=etree.XMLParser(resolve_entities=False,no_network=True,load_dtd=False)\ns=etree.XMLSchema(etree.parse(sys.argv[1],p))\ns.assertValid(etree.fromstring(bytes.fromhex(sys.argv[2]),p))';
  await runFile('python',['-c',script,schema,bytes.toString('hex')],{timeout:5000,maxBuffer:65536,windowsHide:true});
 }});
},60000);
afterEach(async()=>{while(cleanups.length)await cleanups.pop()!();});
const paused=()=>{let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return {promise,release};};

async function fixture(mode:'all'|'read'='all'){
 const old=readFixture(),guide=guideIssueFixture(),issued=await guide.issue(),batch=supplementCommandFixture('RC');
 const guideScope={binding:guide.binding,draftId:guide.request.draftId,operationId:issued.receipt.id};
 const issuance={schemaVersion:'factuez.b2b.guide-issuance.v1',operationId:issued.receipt.id,draftId:guideScope.draftId,binding:guide.binding,snapshot:issued.receipt.snapshot,snapshotSha256:issued.receipt.snapshotSha256,replayed:null};
 const batchScope={environment:'BETA' as const,issuerRuc:batch.doc.issuer.identityNumber,companyId:99,branchId:batch.doc.branchId!,batchId:batch.batch!.documentId};
 const readBinding={issuerId:1,issuerRuc,environment:'BETA' as const,branchId,pointId,seriesId:counterId,documentType:'01' as const};
 const humanId=randomUUID(),binding=readBinding;
 const claims:any={sub:humanId,authVersion:2,roles:['ADMIN'],permissions:['sunat.configure'],scope:{kind:'GLOBAL'},exp:Math.floor(Date.now()/1000)+3600};
 const state={missing:'',revoked:false,denyHuman:false,wrongXsd:false,workersClosed:false,producersClosed:false,poolClosed:false};
 const order:string[]=[],rows=new Map<string,any>(),rpcCalls:string[]=[];
 const principal=(token:string,kind:'USER'|'SERVICE')=>{
  const clientId=token==='guide-token'?guide.proof.actor.b2b!.clientId:token==='batch-token'?supplementUuid(50):supplementUuid(80);
  const scopes=token==='guide-token'?['b2b:documents:read','b2b:guides:issue','b2b:guides:read','b2b:guide-operations:read']:
   token==='batch-token'?['b2b:batches:read','b2b:batches:write','b2b:artifacts:read']:token==='human-token'?['b2b:fiscal-config:read','b2b:fiscal-config:write']:[...B2bReadScopes];
  const bindings=token==='guide-token'?[guide.binding.draft.anchor]:token==='batch-token'?[{issuerId:99,issuerRuc:batchScope.issuerRuc,environment:'BETA',branchId:batchScope.branchId,pointId:supplementUuid(51),seriesId:supplementUuid(52),documentType:'03'}]:[readBinding];
  return {kind,clientId,revision:1,subjectId:kind==='USER'?humanId:null,userAuthRevision:kind==='USER'?2:null,environment:'BETA',scopes,bindings};
 };
 const rpc=createServer({ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true},async(req,res)=>{
  try{
   if(fingerprint((req.socket as any).getPeerCertificate().raw)!==fingerprint(tls.resource))throw Error();
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString()),token=req.headers.authorization?.slice(7)??'';
   rpcCalls.push(req.url!);let value:any;
   if(state.revoked)throw new B2bSecurityError(401,'REVOKED');
   if(req.url==='/internal/b2b/introspect')value=principal(token,body.kind);
   else if(req.url==='/internal/b2b/authorize-guide-issue')value={schemaVersion:'factuez.b2b.guide-issue-authorization.v1',capability:'BETA_GUIDE_ISSUE_LOCAL',binding:guide.binding,action:body.action,
    actor:guide.proof.actor,clientRevision:1,grantRevision:1,candidateOnly:true,fiscalExecutionEnabled:false,transmissionAuthorized:false};
   else if(req.url==='/internal/b2b/read-guide-issuance')value=issuance;
   else if(req.url==='/internal/b2b/batch-operations')value={schemaVersion:'factuez.b2b.batch-artifact-owner.v1',permission:body.permission,
    subject:{kind:'SERVICE',clientId:supplementUuid(50),subjectId:null},command:batch.command,requestSha256:'a'.repeat(64),authorizationSha256:'b'.repeat(64),checkedAt:new Date().toISOString(),
    operationId:batchScope.batchId,identifier:batch.batch!.identifier,kind:'RC',scope:{environment:'BETA',issuerRuc:batchScope.issuerRuc,companyId:99,branchId:batchScope.branchId},state:'QUEUED',memberCount:1,
    commandSha256:fiscalSnapshotSha256(batch.command),candidateOnly:true,localOnly:true,fiscalExecutionEnabled:false,transmissionAuthorized:false,officialAcceptance:false};
   else if(req.url==='/internal/b2b/read'&&body.action==='document')value=await old.billing.document('fixture-token',issuerRuc,body.args.id);
   else if(req.url==='/internal/b2b/correction-evidence-authorize')value=correctionEvidenceResponse(body,'d'.repeat(64),{authorized:true},new Date().toISOString());
   else throw Error('UNEXPECTED_PRIVATE_RPC');
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
  }catch(e){res.writeHead(e instanceof B2bSecurityError?e.status:503,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'SYNTHETIC_UPSTREAM_DENIED'}));}
 });
 await new Promise<void>(r=>rpc.listen(0,'127.0.0.1',r));cleanups.push(()=>new Promise<void>((r,j)=>rpc.close(e=>e?j(e):r())));
 const http=new B2bPrivateHttp('https://127.0.0.1:'+(rpc.address() as any).port,{ca:tls.ca,cert:tls.resource,key:tls.key});
 let queryHold:ReturnType<typeof paused>|undefined;
 const query=vi.fn(async(sql:string,...values:any[])=>{
  if(state.poolClosed)throw Error('POOL_CLOSED');
  if(sql.endsWith('WHERE false')){if(state.missing&&sql.includes('"'+state.missing+'"'))throw Error('PRIVATE_SCHEMA_DETAIL');return [];}
  if(sql.includes('pg_advisory_xact_lock'))return [{locked:null}];
  if(sql.includes('FROM "GuideLocalArtifact"'))return rows.has('guide')?[rows.get('guide')]:[];
  if(sql.includes('FROM "BatchLocalArtifact"'))return rows.has('batch')?[rows.get('batch')]:[];
  if(sql.includes('FROM "GuideLocalCdr"')||sql.includes('FROM "BatchLocalCdr"'))return [];
  throw Error('UNEXPECTED_SQL');
 });
 const execute=vi.fn(async(sql:string,...v:any[])=>{
  if(sql.startsWith('INSERT INTO "GuideLocalArtifact"')){if(queryHold)await queryHold.promise;rows.set('guide',{operationId:v[0],documentId:v[1],issuerRuc:v[2],fullNumber:v[3],metadata:JSON.parse(v[4]),metadataSha256:v[5],unsignedXml:v[6],signedXml:v[7],zip:v[8],certificatePem:v[9]});order.push('guide-commit');return 1;}
  if(sql.startsWith('INSERT INTO "BatchLocalArtifact"')){rows.set('batch',{batchId:v[0],eventId:v[1],commandSha256:v[2],issuerRuc:v[3],identifier:v[4],metadata:JSON.parse(v[5]),metadataSha256:v[6],unsignedXml:v[7],signedXml:v[8],zip:v[9],certificatePem:v[10]});return 1;}
  if(sql.startsWith('INSERT INTO "B2bArtifactAudit"'))return 1;
  throw Error('UNEXPECTED_SQL_MUTATION');
 });
 const db:any={
  $queryRawUnsafe:query,$executeRawUnsafe:execute,$transaction:vi.fn(async(work:any)=>work(db)),
  $disconnect:vi.fn(async()=>{order.push('pool-close');state.poolClosed=true;}),
  fiscalDocument:{findFirst:vi.fn(async({where}:any)=>structuredClone(old.docs.get(where.documentId)??null))},
  fiscalBatch:{findFirst:vi.fn(async()=>null),findMany:vi.fn(async()=>[])},
  documentArtifact:{findFirst:vi.fn(async({where}:any)=>where.id===artifactId?{...old.artifact,documentId}:null),findMany:vi.fn(async()=>[])},
  batchArtifact:{findFirst:vi.fn(async()=>null),findMany:vi.fn(async()=>[])},cdrLog:{findMany:vi.fn(async()=>[])},sunatSubmission:{findFirst:vi.fn(async()=>null)},
  sunatCredentials:{findUnique:vi.fn(async()=>null)},fiscalConfigurationAudit:{findMany:vi.fn(async()=>[]),count:vi.fn(async()=>0)},
 };
 const guideKeys={withKey:vi.fn(async(ruc:string,purpose:string,work:any)=>{
  expect(ruc).toBe('20000000001');expect(purpose).toBe('LOCAL_GUIDE_ARTIFACT');const owned=Buffer.from(guidePki.issuer.pkcs12);
  try{return await work(owned,guidePki.password);}finally{owned.fill(0);}
 })};
 const batchKeys={acquire:vi.fn(async(ruc:string,purpose:'LOCAL_SYNTHETIC_BATCH')=>({ruc,purpose,p12:Buffer.from(batchPki.issuer.pkcs12),password:batchPki.password,certificatePem:batchPki.issuer.certificatePem,dispose:vi.fn(async()=>{})}))};
 // Real XMLDSig/chain implementation; CRL policy is deliberately NOT granted by a test Boolean.
 const certificates={load:vi.fn(async()=>({certificatePem:batchPki.issuer.certificatePem,chainPems:batchPki.issuer.chainPems}))};
 const signatures=new BetaOwnerXmlTrust(certificates,new CertificateTrustService());
 const drain=new B2bOwnerDrain({enabled:true,maxConcurrent:8});
 const config:B2bSunatRuntimeConfig={enabled:true,environment:'BETA',deploymentId:randomUUID(),instanceId:randomUUID(),api:{host:'127.0.0.1',port:0},control:{host:'127.0.0.1',port:0},
  peers:{resource:[fingerprint(tls.resource)],billing:[fingerprint(tls.edge)],operator:[fingerprint(tls.other)]}};
 const deps:B2bSunatRuntimeDependencies={prisma:db,artifacts:old.store,pdf:new CurrentPdfService(),identity:new B2bIdentityHttp(http),identityHttp:http,billingHttp:http,
  credentials:{apiTls:{ca:tls.ca,cert:tls.server,key:tls.key},controlTls:{ca:tls.ca,cert:tls.server,key:tls.key}},drain,
  lifecycle:{stopProducers:vi.fn(async()=>{state.producersClosed=true;order.push('stop-producers');}),stopWorkers:vi.fn(async()=>{state.workersClosed=true;order.push('stop-workers');}),closeOtherOwnerListeners:vi.fn(async()=>{order.push('close-other-listeners');})},
  ...(mode==='all'?{
   guide:{keys:guideKeys,allowedRucs:['20000000001'],cdr:guidePki.cdrVerifier,xsd},
   batch:{keys:batchKeys,allowedRucs:[batchScope.issuerRuc],cdr:batchPki.cdrVerifier,xsd},
   corrections:{signatures,cdr:batchPki.cdrVerifier,xsd},
   privileged:{vault:new SecretVault(),certificates:new CertificateInspectionService(),
    authority:{authorize:vi.fn(async()=>{if(state.denyHuman)throw new B2bSecurityError(403,'NO_STEP_UP');return {claims,policyRevision:'synthetic-live-policy-1',stepUpVerified:true as const,expiresAt:Date.now()+10000};})},
    liveIdentity:{current:vi.fn(async()=>structuredClone(claims))},bindingOwner:{revalidate:vi.fn(async()=>({binding,revision:'1'}))}},
  }:{})};
 const runtime=await createB2bSunatRuntime(config,deps);if(!runtime)throw Error();cleanups.push(()=>runtime.close());
 const addresses=await runtime.start(),port=(addresses.api as any).port,controlPort=(addresses.control as any).port;
 const send=(path:string,body:any={},token:string|null=null,peer:'resource'|'edge'|'other'|null='resource')=>{
  const bytes=Buffer.from(JSON.stringify(body));return new Promise<{status:number;body:any;bytes:Buffer;headers:any}>((resolve,reject)=>{
   const req=request({hostname:'127.0.0.1',port,path,method:'POST',ca:tls.ca,...(peer?{cert:tls[peer],key:tls.key}:{}),rejectUnauthorized:true,
    headers:{'Content-Type':'application/json','Content-Length':String(bytes.length),...(token?{Authorization:'Bearer '+token}:{})}},res=>{
    const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const value=Buffer.concat(chunks);resolve({status:res.statusCode!,bytes:value,headers:res.headers,
     body:String(res.headers['content-type']).startsWith('application/json')?JSON.parse(value.toString()):null});});});req.on('error',reject);req.end(bytes);
  });
 };
 const advance=async(phase:'ADMISSION'|'PRODUCERS'|'WORKERS'|'STORAGE')=>runtime.maintenance.advance(phase,{deploymentId:config.deploymentId,runId:maintenanceRun,
  inventorySha256:'a'.repeat(64),instance:{service:'SUNAT',instanceId:config.instanceId,bootId:runtime.bootId}});
 const maintenanceRun=randomUUID();
 return {old,guide,batch,guideScope,batchScope,config,deps,runtime,port,controlPort,send,advance,state,rows,query,execute,db,guideKeys,batchKeys,order,rpcCalls,claims,binding,drain,
  holdQuery(){queryHold=paused();return queryHold;}};
}

describe('SUNAT runtime assembled owner: actual Nest HTTPS/mTLS, real crypto and XSD',()=>{
 it('disabled factory does not inspect dependencies, credentials, env or start listeners',async()=>{
  const inaccessible=new Proxy({},{get(){throw Error('ACCESSED_DISABLED_DEPENDENCY');}});
  expect(await createB2bSunatRuntime()).toBeNull();expect(await createB2bSunatRuntime({enabled:false} as any,inaccessible as any)).toBeNull();
 });
 it('advertises only real installed modules and the SAME boot identity on status and maintenance',async()=>{
  const f=await fixture();const result=await f.send('/internal/b2b/runtime-status');expect(result.status).toBe(200);
  expect(result.body).toMatchObject({owner:'fiscal',deploymentId:f.config.deploymentId,bootId:f.runtime.bootId,state:'ASSEMBLED_AND_STORAGE_CHECKED',fiscalActivation:false});
  expect(result.body.capabilities).toEqual(['BATCH_ARTIFACTS','CORRECTION_EVIDENCE','GUIDE_ARTIFACTS','PRIVILEGED_ADMIN','READ']);
  expect(f.runtime.maintenance.snapshot().instance.bootId).toBe(result.body.bootId);
  expect(JSON.stringify(f.runtime)).not.toMatch(/PRIVATE KEY|password|p12|certificatePem/);
 });
 it('READ-only assembly never announces modules or routes that were not installed',async()=>{
  const f=await fixture('read');expect((await f.send('/internal/b2b/runtime-status')).body.capabilities).toEqual(['READ']);
  for(const route of ['guide-artifacts','batch-artifacts','correction-evidence','owner-admin'])expect((await f.send('/internal/b2b/'+route,{},'read-token')).status).toBe(404);
 });
 it('readiness uses only fixed SELECT projections without reading rows, DDL or writes, and rechecks each probe',async()=>{
  const f=await fixture();const before=f.query.mock.calls.length;expect((await f.send('/internal/b2b/runtime-status')).status).toBe(200);
  expect(f.query.mock.calls.length).toBeGreaterThan(before);expect(f.execute).not.toHaveBeenCalled();
  for(const [sql] of f.query.mock.calls)expect(sql).toMatch(/^SELECT .* WHERE false$/);
  f.state.missing='GuideLocalArtifact';const fail=await f.send('/internal/b2b/runtime-status');expect(fail.status).toBe(503);expect(JSON.stringify(fail.body)).not.toContain('PRIVATE_SCHEMA');
  f.state.missing='';expect((await f.send('/internal/b2b/runtime-status')).status).toBe(200);
 });
 it('requires mTLS certificate and pinned peer, rejecting public claims and query aliases before private RPC',async()=>{
  const f=await fixture();await expect(f.send('/internal/b2b/runtime-status',{},null,null)).rejects.toThrow();
  expect((await f.send('/internal/b2b/runtime-status',{},null,'other')).status).toBe(403);
  expect((await f.send('/internal/b2b/runtime-status',{approved:true})).status).toBe(400);
  expect((await f.send('/internal/b2b/runtime-status?ready=true')).status).toBe(400);expect(f.rpcCalls).toHaveLength(0);
 });
 it('reads originals via actual PrismaB2bSunatRead/Billing RPC and persists actual download audit',async()=>{
  const f=await fixture();const args={issuerId:'1',environment:'BETA',id:artifactId};
  const result=await f.send('/internal/b2b/fiscal-read',{kind:'SERVICE',action:'content',args},'read-token');
  expect(result.status).toBe(200);expect(result.bytes).toEqual(f.old.bytes);expect(result.headers['x-content-sha256']).toBe(sha(f.old.bytes));
  expect(f.db.documentArtifact.findFirst).toHaveBeenCalled();expect(f.db.fiscalDocument.findFirst).toHaveBeenCalled();
  expect(f.execute.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO "B2bArtifactAudit"'))).toBe(true);
  f.state.revoked=true;expect((await f.send('/internal/b2b/fiscal-read',{kind:'SERVICE',action:'content',args},'read-token')).status).not.toBe(200);
 });
 it('prepares guide originals through the real phase7 factory, Postgres store, real XMLDSig and pinned XSD; replays without signing again',async()=>{
  const f=await fixture();const body={kind:'SERVICE',action:'PREPARE',scope:f.guideScope};
  const result=await f.send('/internal/b2b/guide-artifacts',body,'guide-token');expect(result.status).toBe(200);expect(result.body.replayed).toBe(false);
  expect(result.body.metadata.transmissionAuthorized).toBe(false);expect(f.guideKeys.withKey).toHaveBeenCalledOnce();
  const replay=await f.send('/internal/b2b/guide-artifacts',body,'guide-token');expect(replay.status).toBe(200);expect(replay.body.replayed).toBe(true);expect(f.guideKeys.withKey).toHaveBeenCalledOnce();
  const xml=await f.send('/internal/b2b/guide-artifacts',{kind:'SERVICE',action:'CONTENT',artifact:'xml',scope:f.guideScope},'guide-token');
  expect(xml.status).toBe(200);expect(xml.bytes).toEqual(Buffer.from(f.rows.get('guide').signedXml));expect(xml.bytes.toString()).toContain('SignatureValue');
  expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE KEY|password|certificatePem|pkcs12/);
 });
 it('prepares RC batch with actual Billing owner command, real signature/XSD and idempotent local original bytes',async()=>{
  const f=await fixture();const body={kind:'SERVICE',action:'PREPARE',scope:f.batchScope};
  const result=await f.send('/internal/b2b/batch-artifacts',body,'batch-token');expect(result.status).toBe(200);expect(result.body.replayed).toBe(false);
  expect(f.batchKeys.acquire).toHaveBeenCalledOnce();expect((await f.send('/internal/b2b/batch-artifacts',body,'batch-token')).body.replayed).toBe(true);
  const zip=await f.send('/internal/b2b/batch-artifacts',{kind:'SERVICE',action:'CONTENT',scope:f.batchScope,artifact:'zip'},'batch-token');
  expect(zip.status).toBe(200);expect(zip.bytes).toEqual(f.rows.get('batch').zip);expect(f.batchKeys.acquire).toHaveBeenCalledOnce();
 });
 it('does not fabricate correction approval from missing owner rows or caller booleans; callback uses actual private RPC',async()=>{
  const f=await fixture();const doc=f.batch.doc,binding={reference:{issuerId:doc.companyId,issuerRuc:doc.issuer.identityNumber,branchId:doc.branchId,pointId:supplementUuid(90),seriesId:supplementUuid(91),documentType:'03',environment:'BETA'},noteSeriesId:supplementUuid(92),noteType:'07'};
  const request={schemaVersion:'factuez.b2b.correction-evidence-request.v1',requestId:randomUUID(),kind:'SERVICE',action:'ORIGINAL',binding,payload:doc,asOf:new Date().toISOString()};
  const result=await f.send('/internal/b2b/correction-evidence',request,'batch-token','edge');expect(result.status).not.toBe(404);expect(result.status).not.toBe(200);
  expect((await f.send('/internal/b2b/correction-evidence',{...request,verified:true},'batch-token','edge')).status).not.toBe(200);
 });
 it('mounts the real capability-bound fiscal owner and current privileged human policy; no service token or missing step-up fallback',async()=>{
  const f=await fixture();const body={kind:'USER',action:'FISCAL_READ',input:{binding:f.binding,payload:{}}};
  const read=await f.send('/internal/b2b/owner-admin',body,'human-token');expect(read.status).toBe(200);expect(read.body.data.fiscalTransmission).toBe(false);expect(read.body.data.certificate.trustAndRucVerified).toBe(false);
  expect(f.db.sunatCredentials.findUnique).toHaveBeenCalled();f.state.denyHuman=true;
  const denied=await f.send('/internal/b2b/owner-admin',body,'human-token');

  expect(denied.status,JSON.stringify(denied.body)).toBe(403);
  expect((await f.send('/internal/b2b/owner-admin',{...body,kind:'SERVICE'},'human-token')).status).toBe(403);
 });
});








describe('SUNAT runtime maintenance and fail-closed boundaries',()=>{
 it('holds the SQL lifetime after client abort, drains commands before producers/workers, and keeps private control alive after STORAGE',async()=>{
  const f=await fixture(),gate=f.holdQuery();const bytes=Buffer.from(JSON.stringify({kind:'SERVICE',action:'PREPARE',scope:f.guideScope}));
  const req=request({hostname:'127.0.0.1',port:f.port,path:'/internal/b2b/guide-artifacts',method:'POST',ca:tls.ca,cert:tls.resource,key:tls.key,
   headers:{Authorization:'Bearer guide-token','Content-Type':'application/json','Content-Length':String(bytes.length)}},res=>res.resume());req.on('error',()=>{});req.end(bytes);
  try{
   await vi.waitFor(()=>expect(f.execute.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO "GuideLocalArtifact"'))).toBe(true),{timeout:10000});
   req.destroy();await vi.waitFor(()=>expect(f.drain.snapshot().aborted).toBe(1));
   const stopping=f.advance('ADMISSION');await vi.waitFor(()=>expect(f.runtime.maintenance.snapshot().pending).toBe(1));
   expect(f.drain.snapshot().commands).toBe(1);expect(f.state.poolClosed).toBe(false);expect(f.state.workersClosed).toBe(false);
   expect((await f.send('/internal/b2b/runtime-status')).status).toBe(200);
   expect((await f.send('/internal/b2b/guide-artifacts',{kind:'SERVICE',action:'READ',scope:f.guideScope},'guide-token')).status).toBe(503);
   await expect(f.advance('PRODUCERS')).rejects.toThrow('PHASE_IN_PROGRESS');gate.release();await stopping;
   expect(f.order).toEqual(['guide-commit']);await f.advance('PRODUCERS');await f.advance('WORKERS');
   expect(f.order).toEqual(['guide-commit','stop-producers','stop-workers']);expect(f.state.poolClosed).toBe(false);
   await f.advance('STORAGE');expect(f.runtime.application.getHttpServer().listening).toBe(false);
   expect(f.order).toEqual(['guide-commit','stop-producers','stop-workers','close-other-listeners','pool-close']);expect(f.db.$disconnect).toHaveBeenCalledOnce();
   const parked=await new Promise<any>((resolve,reject)=>{const r=request({hostname:'127.0.0.1',port:f.controlPort,path:'/internal/maintenance/status',method:'GET',ca:tls.ca,cert:tls.other,key:tls.key},res=>{
    const parts:Buffer[]=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(parts).toString())}));});r.on('error',reject);r.end();});
   expect(parked.status).toBe(200);expect(parked.body).toMatchObject({state:'PARKED',storageClosed:true,instance:{bootId:f.runtime.bootId}});
  }finally{gate.release();req.destroy();}
 });
 it('rejects a boot mismatch before any hook or shutdown',async()=>{
  const f=await fixture();await expect(f.runtime.maintenance.advance('ADMISSION',{deploymentId:f.config.deploymentId,runId:randomUUID(),inventorySha256:'a'.repeat(64),
   instance:{service:'SUNAT',instanceId:f.config.instanceId,bootId:randomUUID()}})).rejects.toThrow('INSTANCE_MISMATCH');
  expect(f.state.poolClosed).toBe(false);expect(f.deps.lifecycle.stopWorkers).not.toHaveBeenCalled();
 });
 it('checks all installed table/column projections and refuses fake nonempty readiness results',async()=>{
  const f=await fixture('read');const check=vi.fn(async()=>[]);
  await checkSunatRuntimeSchema({$queryRawUnsafe:check} as any,Object.keys(sunatRuntimeSchemaChecks) as any);
  expect(check.mock.calls.length).toBe(Object.values(sunatRuntimeSchemaChecks).flat().length);
  check.mockResolvedValueOnce([{approved:true}] as any);await expect(checkSunatRuntimeSchema({$queryRawUnsafe:check} as any,['READ'])).rejects.toThrow('STORAGE_NOT_READY');
 });
 it('rejects invalid configurations or incomplete genuine dependency groups before assembly',async()=>{
  const f=await fixture();
  for(const change of [{environment:'PRODUCTION'},{instanceId:'invalid'},{api:{host:'*',port:0}},{peers:{...f.config.peers,operator:f.config.peers.resource}}])
   await expect(createB2bSunatRuntime({...f.config,...change} as any,f.deps)).rejects.toThrow('CONFIG_INVALID');
  for(const patch of [{lifecycle:{}},{drain:{}},{guide:{keys:{}}},{corrections:{signatures:{verifyIssuer:async()=>({approved:true})}}},{privileged:{authority:{}}}])
   await expect(createB2bSunatRuntime(f.config,{...f.deps,...patch} as any)).rejects.toThrow('DEPENDENCIES_REQUIRED');
 });
 it('fails genuine XSD before persisting a newly signed guide, without enabling any transmission',async()=>{
  const f=await fixture();const failing=new XsdValidationService();
  const validator=vi.spyOn(xsd,'validate').mockImplementationOnce(async()=>failing.validate('<not-a-guide/>','DespatchAdvice'));
  try{const result=await f.send('/internal/b2b/guide-artifacts',{kind:'SERVICE',action:'PREPARE',scope:f.guideScope},'guide-token');expect(result.status).toBe(503);expect(f.rows.has('guide')).toBe(false);}
  finally{validator.mockRestore();}
 });
 it('rejects bogus XSD proofs and actual invalid XML instead of accepting caller-approved flags',async()=>{
  const fake={validate:async()=>({verified:true})};await expect(validateRuntimeXml(fake as any,'<x/>','Invoice')).rejects.toThrow('XSD_EVIDENCE_INVALID');
  await expect(validateRuntimeXml(xsd,'<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>','Invoice')).rejects.toThrow();
 });
 it('does not prepare files or invoke keys for READ or malformed approved input',async()=>{
  const f=await fixture();expect((await f.send('/internal/b2b/guide-artifacts',{kind:'SERVICE',action:'READ',scope:f.guideScope},'guide-token')).status).toBe(404);
  expect((await f.send('/internal/b2b/batch-artifacts',{kind:'SERVICE',action:'READ',scope:f.batchScope},'batch-token')).status).toBe(404);
  expect((await f.send('/internal/b2b/guide-artifacts',{kind:'SERVICE',action:'PREPARE',scope:f.guideScope,verified:true},'guide-token')).status).toBe(400);
  expect(f.guideKeys.withKey).not.toHaveBeenCalled();expect(f.batchKeys.acquire).not.toHaveBeenCalled();expect(f.execute).not.toHaveBeenCalled();
 });
});
