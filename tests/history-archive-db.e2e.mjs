// Explicit fresh, synthetic QA only. Never reads .env, active DBs, SOL, P12 or APIs.
// Own internal Docker network, no published ports, tmpfs PostgreSQL,
// Docker-exec byte stream to PostgreSQL's container-local loopback only.
// generated transient roles/passwords, owned temporary source/archive directories.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {Duplex} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';

if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['--isolated-synthetic-only']))throw new Error('ISOLATED_SYNTHETIC_ONLY_REQUIRED');
const root=fileURLToPath(new URL('..',import.meta.url)), local=createRequire(new URL('../services/history-service/package.json',import.meta.url));
const {PrismaClient}=local('./dist/generated/prisma/client'),{PrismaPg}=local('@prisma/adapter-pg');
const {Pool}=local('pg');
const {HistoryArchiveRepository}=local('./dist/repository'),{HistoricalArchiveService}=local('./dist/service'),{HistoryArtifactStore}=local('./dist/artifact-store');
const {createHistoryReadApp}=local('./dist/read-api'),{HistoryReadIdentityAdapter}=local('./dist/read-identity');
const {jwtFixture}=createRequire(import.meta.url)('./helpers/history-read-auth.cjs');
const {prepareHistoricalImport,historicalSha256}=local('@factuez/history-core'),f=createRequire(import.meta.url)('./helpers/history-full-fixtures.cjs');
const nonce=randomBytes(5).toString('hex'),name=`factuez-history-qa-${nonce}`,networkName=`factuez-history-qa-net-${nonce}`;
const databaseName=`factuez_history_qa_${nonce}`,restoreName=`${databaseName}_restore`,markerId=randomUUID();
const password=randomBytes(24).toString('hex'),importPassword=randomBytes(24).toString('hex'),readPassword=randomBytes(24).toString('hex');
const clients=[],pools=[],results=[],allowedDb=new Set([databaseName]);
const httpApps=[];let identityServer;
let containerId,networkId,work,step='INITIALIZE',cleanupOk=true,shuttingDown=false;
function sha(bytes){return createHash('sha256').update(bytes).digest('hex');}
function command(args,input='',binary=false,expectedFailure=false){
  const r=spawnSync('docker',args,{input,encoding:binary?undefined:'utf8',timeout:30000,windowsHide:true,maxBuffer:32*1024*1024});
  if(expectedFailure){assert.notEqual(r.status,0,'EXPECTED_SQL_REJECTION');return String(r.stderr);}
  assert.ok(!r.error&&r.status===0,'ISOLATED_DOCKER_COMMAND_FAILED');return binary?r.stdout:r.stdout.trim();
}
function sql(db,statement,expectedFailure=false){
  assert.ok(containerId&&allowedDb.has(db)&&/^factuez_history_qa_[a-f0-9]{10}(_restore)?$/.test(db));
  return command(['exec','-i',containerId,'psql','-U','postgres','-d',db,'-X','-v','ON_ERROR_STOP=1','-At'],statement,false,expectedFailure);
}
function value(v){return `'${String(v).replaceAll("'","''")}'`;}
class IsolatedPgStream extends Duplex{
  constructor(){super({allowHalfOpen:false});this.closing=false;}
  setNoDelay(){return this;} setKeepAlive(){return this;} ref(){return this;} unref(){return this;}
  connect(port,host){
    assert.equal(port,5432);assert.equal(host,'127.0.0.1');assert.match(containerId,/^[a-f0-9]{64}$/);
    this.child=spawn('docker',['exec','-i',containerId,'nc','127.0.0.1','5432'],{windowsHide:true,stdio:['pipe','pipe','ignore']});
    this.child.stdout.on('data',chunk=>{if(!this.push(chunk))this.child.stdout.pause();});
    this.child.stdout.on('end',()=>this.push(null));
    this.child.on('error',()=>this.destroy(new Error('ISOLATED_PG_STREAM_FAILED')));
    this.child.stdin.on('error',()=>this.destroy(new Error('ISOLATED_PG_STREAM_FAILED')));
    this.child.on('exit',code=>{if(code!==0&&!this.destroyed&&!this.closing)this.destroy(new Error('ISOLATED_PG_STREAM_FAILED'));});
    this.child.once('spawn',()=>this.emit('connect'));return this;
  }
  _read(){this.child?.stdout.resume();}
  _write(chunk,encoding,callback){this.child.stdin.write(chunk,encoding,callback);}
  _final(callback){this.closing=true;this.child.stdin.end(callback);}
  _destroy(error,callback){this.closing=true;this.child?.kill();callback(error);}
}
function client(db,user,pwd){
  assert.ok(allowedDb.has(db));
  const pool=new Pool({host:'127.0.0.1',port:5432,database:db,user,password:pwd,stream:()=>new IsolatedPgStream(),max:4,connectionTimeoutMillis:10000});
  pool.on('error',()=>{if(!shuttingDown){process.exitCode=1;console.error('{"status":"FAIL","reason":"ISOLATED_POOL_ERROR"}');}});
  pools.push(pool);const p=new PrismaClient({adapter:new PrismaPg(pool)});clients.push(p);return p;
}
function count(table,db=databaseName){assert.ok(['HistoryRecord','HistoryImportJob','HistoryBatchReceipt','HistoryRecordImportLink'].includes(table));return Number(sql(db,`SELECT count(*) FROM "${table}";`));}
async function check(label,action){step=label;await action();results.push(label);}
function writeFixtureFiles(input,source){
  for(const d of input.documents)for(const a of d.artifacts){const m=d.ownership,target=path.join(source,m.issuerRuc,m.documentTypeCode,m.series,d.number,a.kind,a.originalName);
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,f.artifactBytes(a.kind),{flag:'wx',mode:0o640});}
}
const identity={authorize:async credential=>{
  if(credential==='qa-admin')return f.actor();
  if(credential==='qa-a')return f.actor(false);
  if(credential==='qa-b'){const a=f.actor(false),m=f.mapping(2,'01');a.scope={kind:'ASSIGNED',branchIds:[m.branchId],emissionPointIds:[m.emissionPointId],seriesCounterIds:[m.seriesCounterId]};return a;}
  if(credential==='qa-wrong-point'){const a=f.actor(false);a.scope.emissionPointIds=[f.mapping(2,'01').emissionPointId];return a;}
  throw new Error('QA_SESSION_DENIED');
}};
const query={issuerRuc:null,branchId:null,documentTypeCode:null,series:null,take:100,afterRecordId:null};
try{
  step='CREATE_INTERNAL_NETWORK';
  networkId=command(['network','create','--internal','--label','factuez.qa=history-stage3','--label',`factuez.qa.run=${nonce}`,networkName]);
  assert.match(networkId,/^[a-f0-9]{64}$/);
  assert.equal(command(['network','inspect','--format','{{.Internal}}',networkId]),'true');
  step='CREATE_FRESH_POSTGRES';
  containerId=command(['run','--pull','never','--rm','-d','--name',name,'--network',networkName,
    '--tmpfs','/var/lib/postgresql/data:rw','--label','factuez.qa=history-stage3','--label',`factuez.qa.run=${nonce}`,
    '-e',`POSTGRES_PASSWORD=${password}`,'-e',`POSTGRES_DB=${databaseName}`,'postgres:17-alpine']);
  assert.match(containerId,/^[a-f0-9]{64}$/);
  step='VERIFY_FRESH_POSTGRES_ISOLATION';
  const inspection=JSON.parse(command(['inspect','--format','{{json .HostConfig}}',containerId]));
  assert.equal(Object.keys(inspection.PortBindings??{}).length,0);
  assert.equal(inspection.NetworkMode,networkName);assert.ok(inspection.Tmpfs['/var/lib/postgresql/data']);
  step='WAIT_FRESH_POSTGRES_READY';
  let ready=false;
  for(let attempt=0;attempt<40;attempt++){
    const r=spawnSync('docker',['exec',containerId,'pg_isready','-U','postgres','-d',databaseName],{encoding:'utf8',timeout:5000,windowsHide:true});
    if(r.status===0){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.ok(ready,'POSTGRES_NOT_READY');
  work=fs.mkdtempSync(path.join(tmpdir(),'factuez-history-persist-qa-'));const sourceRoot=path.join(work,'source'),archiveRoot=path.join(work,'archive');
  const marker=JSON.stringify({profile:'factuez-history-storage-qa-v1',markerId});
  for(const dir of[sourceRoot,archiveRoot]){fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'.history-qa-marker.json'),marker,{flag:'wx'});}
  const input=f.exported(101,true),plan=prepareHistoricalImport(input),inputB={...f.exported(),exportId:f.uuid(9000010),mappings:[f.mapping(2,'01')],documents:[f.document(1,2,'01')]};
  writeFixtureFiles(input,sourceRoot);
  const schema=fs.readFileSync(path.join(root,'services/history-service/prisma/history-qa-schema.sql'),'utf8');
  const guards=fs.readFileSync(path.join(root,'services/history-service/prisma/history-qa-guards.sql'),'utf8');
  const grants=guards.slice(guards.indexOf('REVOKE ALL ON SCHEMA public'));
  step='PROVISION_EMPTY_SCHEMA';
  sql(databaseName,`CREATE ROLE history_import_qa LOGIN PASSWORD ${value(importPassword)}; CREATE ROLE history_reader_qa LOGIN PASSWORD ${value(readPassword)};
    REVOKE CONNECT ON DATABASE "${databaseName}" FROM PUBLIC; GRANT CONNECT ON DATABASE "${databaseName}" TO history_import_qa,history_reader_qa;`);
  sql(databaseName,schema);sql(databaseName,guards);
  sql(databaseName,`INSERT INTO "HistorySandbox" VALUES(1,${value(markerId)},'factuez.history-storage.v1','BETA','SYNTHETIC');`);
  for(const m of [...input.mappings,...inputB.mappings]){
    sql(databaseName,`INSERT INTO "HistoryIssuer" VALUES(${m.companyId},${value(m.issuerRuc)}) ON CONFLICT DO NOTHING;
      INSERT INTO "HistoryOwnerMapping" VALUES(${value(m.mappingId)},${value(m.issuerRuc)},${m.companyId},${value(m.branchId)},${value(m.emissionPointId)},${value(m.seriesCounterId)},${value(m.documentTypeCode)},${value(m.series)},${value(historicalSha256(m))});`);
  }
  const importer=client(databaseName,'history_import_qa',importPassword),reader=client(databaseName,'history_reader_qa',readPassword);
  const repo=new HistoryArchiveRepository(importer,{databaseName,markerId}),readRepo=new HistoryArchiveRepository(reader,{databaseName,markerId});
  const store=new HistoryArtifactStore({sourceRoot,archiveRoot,markerId}),service=new HistoricalArchiveService(identity,repo,store),readService=new HistoricalArchiveService(identity,readRepo,store);
  await check('COMMIT_50_FULL_SNAPSHOTS',async()=>{
    const r=await service.importNext(input,'qa-admin');assert.equal(r.insertedCount,50);assert.equal(r.completedBatches,1);assert.equal(r.complete,false);
    assert.equal(r.fiscalAuthority,false);assert.equal(r.transmission,false);assert.equal(count('HistoryRecord'),50);assert.equal(count('HistoryRecordImportLink'),50);
  });
  await check('TRANSACTION_ROLLBACK_ON_LINK_FAILURE',async()=>{
    sql(databaseName,`CREATE FUNCTION qa_history_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."jobId"=${value(plan.jobId)}::uuid AND NEW."rowOrdinal"=75 THEN RAISE EXCEPTION 'QA_INTENTIONAL_ROLLBACK'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_history_fault BEFORE INSERT ON "HistoryRecordImportLink" FOR EACH ROW EXECUTE FUNCTION qa_history_fault();`);
    await assert.rejects(()=>service.importNext(input,'qa-admin'),/HISTORY_STORAGE_FAILED/);
    assert.equal(count('HistoryRecord'),50);assert.equal(count('HistoryBatchReceipt'),1);assert.equal(count('HistoryRecordImportLink'),50);
    assert.equal((await repo.checkpoint(input,f.actor())).completedBatches,1);
    sql(databaseName,'DROP TRIGGER qa_history_fault ON "HistoryRecordImportLink"; DROP FUNCTION qa_history_fault();');
  });
  await check('OUT_OF_ORDER_BATCH_BLOCKED',async()=>{
    const keys=await store.stageBatch(input,2);await assert.rejects(()=>repo.commitBatch(input,2,f.actor(),keys),/BATCH_OUT_OF_ORDER/);
    assert.equal(count('HistoryRecord'),50);
  });
  await check('CONCURRENT_SAME_BATCH_DEDUPLICATED',async()=>{
    const keys=await store.stageBatch(input,1),results=await Promise.all([repo.commitBatch(input,1,f.actor(),keys),repo.commitBatch(input,1,f.actor(),keys)]);
    assert.deepEqual(results.map(r=>r.insertedCount).sort((a,b)=>a-b),[0,50]);assert.equal(count('HistoryRecord'),100);
    assert.equal(count('HistoryBatchReceipt'),2);assert.equal(count('HistoryRecordImportLink'),100);
  });
  await check('RESUME_AND_COMPLETE_101',async()=>{
    const r=await service.importNext(input,'qa-admin');assert.equal(r.insertedCount,1);assert.equal(r.complete,true);
    const repeated=await service.importNext(input,'qa-admin');assert.equal(repeated.insertedCount,0);assert.equal(repeated.deduplicated,true);
    assert.equal(count('HistoryRecord'),101);assert.equal(count('HistoryBatchReceipt'),3);
  });
  await check('EXACT_REPLAY_OTHER_EXPORT_NO_NEW_RECORDS',async()=>{
    const repeat=f.exported(1,true);repeat.exportId=f.uuid(9000015);
    const r=await service.importNext(repeat,'qa-admin');assert.equal(r.insertedCount,0);assert.equal(r.complete,true);assert.equal(count('HistoryRecord'),101);
  });
  await check('FISCAL_ORIGIN_CONFLICT_ROLLS_BACK',async()=>{
    const conflict=f.exported(1,true);conflict.exportId=f.uuid(9000016);conflict.documents[0].originId='FICTICIO-CONFLICTO';
    const jobs=count('HistoryImportJob');await assert.rejects(()=>service.importNext(conflict,'qa-admin'),/IDENTITY_CONFLICT/);
    assert.equal(count('HistoryRecord'),101);assert.equal(count('HistoryImportJob'),jobs);
  });
  await check('DECLARED_MAPPING_NOT_ACTUAL_MAPPING',async()=>{
    const wrong=f.exported();wrong.exportId=f.uuid(9000017);wrong.mappings[0].branchId=f.uuid(12345);wrong.documents[0].ownership.branchId=f.uuid(12345);
    const before=fs.readdirSync(archiveRoot);await assert.rejects(()=>service.importNext(wrong,'qa-admin'),/OWN_MAPPING_MISMATCH/);
    assert.deepEqual(fs.readdirSync(archiveRoot),before);
  });
  await check('TWO_RUC_OWNERS_ISOLATED',async()=>{assert.equal((await service.importNext(inputB,'qa-admin')).insertedCount,1);assert.equal(count('HistoryRecord'),102);});
  await check('ASSIGNED_READ_AND_PAGINATION',async()=>{
    const first=await readService.list(query,'qa-a');assert.equal(first.length,100);assert.ok(first.every(r=>r.issuerRuc===f.mapping().issuerRuc));
    const last=await readService.list({...query,afterRecordId:first.at(-1).recordId},'qa-a');assert.equal(last.length,1);
    assert.equal((await readService.list(query,'qa-b')).length,1);assert.deepEqual(await readService.list(query,'qa-wrong-point'),[]);
    const d=await readService.detail(plan.records[0].recordId,'qa-a');assert.equal(d.snapshot.customer.legalName,'CLIENTE FICTICIO');
    assert.equal(d.snapshot.items[0].quantity,'2.000000');assert.equal(d.disposition,'QUARANTINED');
    await assert.rejects(()=>readService.detail(plan.records[0].recordId,'qa-b'),/HISTORY_NOT_FOUND/);
    const bytes=await readService.artifact(plan.records[0].recordId,'CDR_XML','qa-a');assert.ok(bytes.bytes.equals(f.artifactBytes('CDR_XML')));assert.equal(bytes.cdrAuthenticityVerified,false);
    await assert.rejects(()=>readService.artifact(plan.records[0].recordId,'CDR_XML','qa-b'),/HISTORY_NOT_FOUND/);
  });
  await check('READONLY_ROLE_CANNOT_IMPORT',async()=>{
    await assert.rejects(()=>readService.importNext(input,'qa-admin'),/SANDBOX_ROLE_READONLY/);
    assert.match(sql(databaseName,'SET ROLE history_reader_qa; UPDATE "HistoryRecord" SET "disposition"=\'ACCEPTED\';',true),/permission denied/);
  });
  await check('IMMUTABLE_RECORD_RECEIPT_AND_CHECKPOINT',async()=>{
    assert.match(sql(databaseName,'UPDATE "HistoryRecord" SET "candidateOnly"=false;',true),/HISTORY_IMMUTABLE/);
    assert.match(sql(databaseName,'DELETE FROM "HistoryBatchReceipt";',true),/HISTORY_IMMUTABLE/);
    assert.match(sql(databaseName,`UPDATE "HistoryImportJob" SET "completedBatches"=0 WHERE "jobId"=${value(plan.jobId)};`,true),/HISTORY_CHECKPOINT_TRANSITION/);
    assert.match(sql(databaseName,'UPDATE "HistoryOwnerMapping" SET "series"=\'BQ02\';',true),/HISTORY_IMMUTABLE/);
  });
  await check('INITIAL_CHECKPOINT_AND_NULL_SNAPSHOT_DENIED',async()=>{
    const job=await importer.historyImportJob.findUniqueOrThrow({where:{jobId:plan.jobId}});
    const {createdAt,...data}=job;
    await assert.rejects(()=>importer.historyImportJob.create({data:{...data,jobId:f.uuid(9000020),completedBatches:1}}));
    const row=await importer.historyRecord.findUniqueOrThrow({where:{recordId:plan.records[0].recordId}});
    const {createdAt:recordCreatedAt,...record}=row;
    await assert.rejects(()=>importer.historyRecord.create({data:{...record,recordId:'c'.repeat(64),number:888n,originId:'FICTICIO-MALFORMADO',snapshot:{}}}));
    assert.equal(count('HistoryRecord'),102);
    assert.equal(await importer.historyImportJob.count({where:{jobId:f.uuid(9000020)}}),0);
  });
  await check('DATABASE_FISCAL_AND_ORIGIN_UNIQUES',async()=>{
    const row=await importer.historyRecord.findUniqueOrThrow({where:{recordId:plan.records[0].recordId}});
    const {createdAt,...data}=row;
    await assert.rejects(()=>importer.historyRecord.create({data:{...data,recordId:'a'.repeat(64)}}),e=>e.code==='P2002');
    const snapshot={...row.snapshot,number:'999'};
    await assert.rejects(()=>importer.historyRecord.create({data:{...data,recordId:'b'.repeat(64),number:999n,snapshot}}),e=>e.code==='P2002');
    assert.equal(count('HistoryRecord'),102);
  });
  await check('MARKER_AND_PLAN_CONFLICT_BLOCKED',async()=>{
    await assert.rejects(()=>new HistoryArchiveRepository(importer,{databaseName,markerId:randomUUID()}).checkpoint(input,f.actor()),/SANDBOX_MARKER_MISMATCH/);
    const changed=structuredClone(input);changed.documents[0].customer.legalName='FICTICIO MODIFICADO';
    await assert.rejects(()=>repo.checkpoint(changed,f.actor()),/JOB_BINDING_MISMATCH/);
  });
  const jwt=jwtFixture(),claimsA=jwt.claims(f.actor(false)),actorB=await identity.authorize('qa-b');actorB.userId=f.uuid(9900001);
  const claimsB=jwt.claims(actorB),claimsAdmin=jwt.claims(),tokenA=jwt.token(claimsA),tokenB=jwt.token(claimsB),tokenAdmin=jwt.token(claimsAdmin);
  const sessions=new Map([[`Bearer ${tokenA}`,claimsA],[`Bearer ${tokenB}`,claimsB],[`Bearer ${tokenAdmin}`,claimsAdmin]]);
  await check('READ_API_EPHEMERAL_IDENTITY_AND_READER_SETUP',async()=>{
    identityServer=createServer((req,res)=>{
      if(req.method!=='GET'||req.url!=='/api/v1/auth/me'){res.writeHead(404).end();return;}
      const claims=sessions.get(req.headers.authorization);
      if(!claims){res.writeHead(401).end();return;}
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(claims));
    });
    await new Promise(resolve=>identityServer.listen(0,'127.0.0.1',resolve));
  });
  const readIdentity=new HistoryReadIdentityAdapter({publicKey:jwt.publicKey,issuer:'factuez-identity',audience:'factuez-services',
    identityBaseUrl:`http://127.0.0.1:${identityServer.address().port}`});
  const apiRepo=new HistoryArchiveRepository(reader,{databaseName,markerId},'READ_ONLY');
  const apiService=new HistoricalArchiveService(readIdentity,apiRepo,store);
  const api=await createHistoryReadApp({enabled:true,environment:'BETA',datasetClass:'SYNTHETIC',service:apiService});httpApps.push(api);
  await api.listen(0,'127.0.0.1');const apiUrl=await api.getUrl();
  const http=(route,token=tokenA,init={})=>fetch(`${apiUrl}/api/v1/history${route}`,{...init,headers:{Authorization:`Bearer ${token}`,...init.headers},signal:AbortSignal.timeout(10000)});
  await check('READ_API_AUTHENTICATED_SCOPE_AND_PAGINATION',async()=>{
    const first=await http('/documents?take=100');assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'private, no-store');
    const body=await first.json();assert.equal(body.items.length,100);assert.equal(body.readOnly,true);assert.equal(body.fiscalAuthority,false);
    const second=await http(`/documents?take=100&afterRecordId=${body.nextCursor}`);assert.equal((await second.json()).items.length,1);
    const other=await http('/documents',tokenB);assert.equal((await other.json()).items.length,1);
    const detail=await http(`/documents/${plan.records[0].recordId}`);assert.equal(detail.status,200);
    const d=await detail.json();assert.equal(d.snapshot.items[0].quantity,'2.000000');assert.ok(!Object.hasOwn(d,'artifactKeys'));
    assert.equal((await http(`/documents/${plan.records[0].recordId}`,tokenB,{headers:{'x-user-id':claimsA.sub,'x-scope':'GLOBAL'}})).status,404);
  });
  await check('READ_API_FULL_RECONCILIATION_NOT_PAGE_TOTAL',async()=>{
    const report=await http('/reconciliation');assert.equal(report.status,200);const r=await report.json();
    assert.equal(r.count,101);assert.equal(r.groups[0].amounts.payableAmount,'11918.00');assert.equal(r.accountingApproved,false);
    const all=await http('/reconciliation',tokenAdmin);const global=await all.json();assert.equal(global.count,102);assert.equal(global.groups.length,2);
    const filter=await http(`/reconciliation?issuerRuc=${inputB.mappings[0].issuerRuc}`,tokenAdmin);assert.equal((await filter.json()).count,1);
    assert.equal((await http('/reconciliation?take=1')).status,400);
  });
  await check('READ_API_ARTIFACT_AND_CROSS_SCOPE_DENIAL',async()=>{
    const result=await http(`/documents/${plan.records[0].recordId}/artifacts/CDR_XML`);assert.equal(result.status,200);
    assert.ok(Buffer.from(await result.arrayBuffer()).equals(f.artifactBytes('CDR_XML')));
    assert.equal(result.headers.get('content-type'),'application/octet-stream');assert.ok(result.headers.get('content-disposition').startsWith('attachment;'));
    assert.equal((await http(`/documents/${plan.records[0].recordId}/artifacts/CDR_XML`,tokenB)).status,404);
  });
  await check('READ_API_SIGNATURE_REVOCATION_AND_MUTATIONS_BLOCKED',async()=>{
    assert.equal((await http('/documents','invalid-token')).status,401);
    assert.equal((await http('/documents',jwtFixture().token(claimsA))).status,401);
    sessions.delete(`Bearer ${tokenA}`);assert.equal((await http('/documents')).status,401);sessions.set(`Bearer ${tokenA}`,claimsA);
    for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await http('/documents',tokenAdmin,{method})).status,404);
    const closed=await createHistoryReadApp({service:apiService});httpApps.push(closed);await closed.listen(0,'127.0.0.1');
    assert.equal((await fetch(`${await closed.getUrl()}/api/v1/history/documents`,{headers:{Authorization:`Bearer ${tokenAdmin}`}})).status,503);
    assert.equal(count('HistoryRecord'),102);await assert.rejects(()=>apiRepo.preflight(input,f.actor()),/SANDBOX_ROLE_READONLY/);
    await assert.rejects(()=>new HistoryArchiveRepository(importer,{databaseName,markerId},'READ_ONLY').detail(plan.records[0].recordId,f.actor()),/SANDBOX_READER_REQUIRED/);
  });
  await check('READ_API_REVOCATION_AFTER_FILE_READ_DOES_NOT_DELIVER_BYTES',async()=>{
    const revokingStore={read:async(...args)=>{const bytes=await store.read(...args);sessions.delete(`Bearer ${tokenA}`);return bytes;}};
    const restricted=await createHistoryReadApp({enabled:true,environment:'BETA',datasetClass:'SYNTHETIC',
      service:new HistoricalArchiveService(readIdentity,apiRepo,revokingStore)});
    httpApps.push(restricted);await restricted.listen(0,'127.0.0.1');
    const r=await fetch(`${await restricted.getUrl()}/api/v1/history/documents/${plan.records[0].recordId}/artifacts/CDR_XML`,{headers:{Authorization:`Bearer ${tokenA}`}});
    assert.equal(r.status,401);assert.equal(r.headers.get('content-disposition'),null);assert.equal((await r.json()).code,'HISTORY_SESSION_REVOKED');
    sessions.set(`Bearer ${tokenA}`,claimsA);
  });
  let dump,dumpSha,storageBackup;
  await check('BACKUP_REFERENCED_FILES_AND_DATABASE',async()=>{
    dump=command(['exec',containerId,'pg_dump','-U','postgres','-d',databaseName,'--format=custom','--no-owner','--no-acl'],'',true);
    assert.ok(dump.length>0);dumpSha=sha(dump);
    const rows=await importer.historyRecord.findMany({select:{artifactKeys:true}});storageBackup=[];
    for(const row of rows)for(const key of row.artifactKeys){
      assert.match(key.key,/^[a-f0-9]{64}\/(SIGNED_XML|CDR_XML)\/ficticio\.xml$/);
      const bytes=fs.readFileSync(path.join(archiveRoot,...key.key.split('/')));storageBackup.push({key:key.key,sha256:sha(bytes),bytes});
    }
    assert.equal(storageBackup.length,2);assert.equal(new Set(storageBackup.map(r=>r.key)).size,2);
  });
  await check('RESTORE_NEW_DATABASE_AND_STORAGE',async()=>{
    assert.equal(sha(dump),dumpSha);sql(databaseName,`CREATE DATABASE "${restoreName}";`);allowedDb.add(restoreName);
    sql(restoreName,`REVOKE CONNECT ON DATABASE "${restoreName}" FROM PUBLIC; GRANT CONNECT ON DATABASE "${restoreName}" TO history_import_qa,history_reader_qa;`);
    command(['exec','-i',containerId,'pg_restore','-U','postgres','-d',restoreName,'--no-owner','--no-acl','--exit-on-error'],dump);
    sql(restoreName,grants);assert.equal(count('HistoryRecord',restoreName),102);
    const restoredRoot=path.join(work,'archive-restore');fs.mkdirSync(restoredRoot);fs.writeFileSync(path.join(restoredRoot,'.history-qa-marker.json'),marker,{flag:'wx'});
    for(const file of storageBackup){assert.equal(sha(file.bytes),file.sha256);const target=path.join(restoredRoot,...file.key.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.bytes,{flag:'wx',mode:0o640});}
    const restoredRepo=new HistoryArchiveRepository(client(restoreName,'history_import_qa',importPassword),{databaseName:restoreName,markerId});
    assert.equal((await restoredRepo.checkpoint(input,f.actor())).completedBatches,3);
    const restoredRead=new HistoryArchiveRepository(client(restoreName,'history_reader_qa',readPassword),{databaseName:restoreName,markerId},'READ_ONLY');
    const restoredService=new HistoricalArchiveService(identity,restoredRead,new HistoryArtifactStore({sourceRoot,archiveRoot:restoredRoot,markerId}));
    assert.equal((await restoredService.detail(plan.records[0].recordId,'qa-a')).snapshotSha256,plan.records[0].snapshotSha256);
    await assert.rejects(()=>restoredService.detail(plan.records[0].recordId,'qa-b'),/HISTORY_NOT_FOUND/);
    const artifact=await restoredService.artifact(plan.records[0].recordId,'CDR_XML','qa-a');assert.ok(artifact.bytes.equals(f.artifactBytes('CDR_XML')));
    assert.match(sql(restoreName,'DELETE FROM "HistoryRecord";',true),/HISTORY_IMMUTABLE/);
    const restoredApi=await createHistoryReadApp({enabled:true,environment:'BETA',datasetClass:'SYNTHETIC',
      service:new HistoricalArchiveService(readIdentity,restoredRead,new HistoryArtifactStore({sourceRoot,archiveRoot:restoredRoot,markerId}))});
    httpApps.push(restoredApi);await restoredApi.listen(0,'127.0.0.1');
    const restoredReport=await fetch(`${await restoredApi.getUrl()}/api/v1/history/reconciliation`,{headers:{Authorization:`Bearer ${tokenA}`}});
    assert.equal(restoredReport.status,200);assert.equal((await restoredReport.json()).count,101);
  });
  await check('NO_FISCAL_TABLES_OR_AUTHORITY',async()=>{
    assert.equal(sql(databaseName,`SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('Document','SeriesCounter','Outbox','FiscalDocument','SunatCredentials');`),'0');
    assert.equal(sql(databaseName,`SELECT count(*) FROM "HistoryRecord" WHERE "candidateOnly"=false OR "disposition"<>'QUARANTINED';`),'0');
    assert.equal(sql(databaseName,'SELECT sum("payableAmount")::text FROM "HistoryRecord";'),'12036.00');
  });
  console.log(JSON.stringify({status:'PASS',environment:'BETA',datasetClass:'SYNTHETIC',checks:results.length,results,
    records:102,completedBatches:3,restoredRecords:102,referencedFiles:2,backupSha256:dumpSha,
    authority:'NONE',actualClientDataRead:false,productionUsed:false,fiscalWrites:0,outboxWrites:0,counterChanges:0,transmission:false},null,2));
}catch(error){
  process.exitCode=1;console.error(JSON.stringify({status:'FAIL',step,reason:/^[A-Z0-9_]{1,80}$/.test(error?.code??'')?error.code:'QA_ASSERTION_OR_RUNTIME_FAILED',
    diagnostic:/^[A-Z0-9_]{1,80}$/.test(error?.message??'')?error.message:'DETAILS_REDACTED',
    actualClientDataRead:false,productionUsed:false,transmission:false}));
}finally{
  shuttingDown=true;
  for(const app of httpApps){try{await app.close();}catch{cleanupOk=false;}}
  if(identityServer){try{await new Promise((resolve,reject)=>identityServer.close(e=>e?reject(e):resolve()));}catch{cleanupOk=false;}}
  for(const p of clients){try{await p.$disconnect();}catch{cleanupOk=false;}}
  for(const pool of pools){try{await pool.end();}catch{cleanupOk=false;}}
  if(containerId){try{
    const match=JSON.parse(command(['inspect','--format','{"id":"{{.Id}}","name":"{{.Name}}","run":"{{index .Config.Labels "factuez.qa.run"}}","qa":"{{index .Config.Labels "factuez.qa"}}"}',containerId]));
    assert.equal(match.id,containerId);assert.equal(match.name,'/'+name);assert.equal(match.run,nonce);assert.equal(match.qa,'history-stage3');
    command(['rm','-f',containerId]);
  }catch{cleanupOk=false;}}
  if(networkId){try{
    const match=JSON.parse(command(['network','inspect','--format','{"id":"{{.Id}}","name":"{{.Name}}","run":"{{index .Labels "factuez.qa.run"}}","internal":{{.Internal}}}',networkId]));
    assert.equal(match.id,networkId);assert.equal(match.name,networkName);assert.equal(match.run,nonce);assert.equal(match.internal,true);
    command(['network','rm',networkId]);
  }catch{cleanupOk=false;}}
  if(work){try{
    const resolved=path.resolve(work);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));assert.match(path.basename(resolved),/^factuez-history-persist-qa-[a-zA-Z0-9]+$/);
    assert.equal(fs.realpathSync(resolved),resolved);assert.ok(!fs.lstatSync(resolved).isSymbolicLink());fs.rmSync(resolved,{recursive:true,force:true});
  }catch{cleanupOk=false;}}
  if(!cleanupOk)process.exitCode=1;
  console.log(JSON.stringify({cleanup:cleanupOk?'OWN_SYNTHETIC_FIXTURES_REMOVED':'CHECK_OWN_REHEARSAL_RESOURCES',activeFactuezDatabasesTouched:false}));
}
