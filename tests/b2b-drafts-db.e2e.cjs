'use strict';
// Creates its own empty tmpfs PostgreSQL with no network/ports. Never reads .env or QA data.
const assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const {randomBytes,randomUUID}=require('node:crypto');
const {readFileSync}=require('node:fs');
const {createRequire}=require('node:module');
const {resolve}=require('node:path');
const {Duplex}=require('node:stream');
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['--isolated-synthetic-only']))throw new Error('ISOLATED_SYNTHETIC_ONLY_REQUIRED');
const repo=resolve(__dirname,'..'),local=createRequire(resolve(repo,'services/billing-service/package.json'));
local('reflect-metadata');
const {Pool}=local('pg'),{PostgresB2bDraftStore}=local('./dist/b2b/draft-store'),{B2bDrafts}=local('./dist/b2b/drafts');
const run=randomUUID(),name='factuez-b2b-drafts-'+run.slice(0,8),label='factuez.b2b.drafts.test='+run,password=randomBytes(24).toString('hex');
let container=null,pool=null,stage='PREFLIGHT';const passed=[];
function docker(args,input=''){const r=spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});assert.equal(r.status,0,'ISOLATED_DOCKER_FAILED_'+stage);return r.stdout.trim();}
class Stream extends Duplex {
  constructor(){super({allowHalfOpen:false});}
  setNoDelay(){return this;}setKeepAlive(){return this;}ref(){return this;}unref(){return this;}
  connect(port,host){assert.equal(port,5432);assert.equal(host,'127.0.0.1');assert.match(container,/^[a-f0-9]{64}$/);
    this.child=spawn('docker',['exec','-i',container,'nc','127.0.0.1','5432'],{windowsHide:true,stdio:['pipe','pipe','ignore']});
    this.child.stdout.on('data',b=>{if(!this.push(b))this.child.stdout.pause();});this.child.stdout.on('end',()=>this.push(null));this.child.on('error',()=>this.destroy(new Error('ISOLATED_STREAM_FAILED')));this.child.stdin.on('error',()=>this.destroy(new Error('ISOLATED_STREAM_FAILED')));this.child.once('spawn',()=>this.emit('connect'));return this;}
  _read(){this.child?.stdout.resume();}_write(b,e,cb){this.child.stdin.write(b,e,cb);}_final(cb){this.child.stdin.end(cb);}_destroy(e,cb){this.child?.kill();cb(e);}
}
const iid='10000000-0000-4000-8000-000000000001',pid='20000000-0000-4000-8000-000000000001',sid='30000000-0000-4000-8000-000000000001';
const principal={clientId:randomUUID(),kind:'SERVICE',subjectId:null,userAuthRevision:null,revision:1,environment:'BETA',scopes:['b2b:context:read','b2b:drafts:write','b2b:operations:read','b2b:documents:issue'],bindings:[{issuerId:1,issuerRuc:'20555555555',environment:'BETA',branchId:iid,pointId:pid,seriesId:sid,documentType:'01'}]};
const body={issuerId:1,environment:'BETA',branchId:iid,pointId:pid,seriesId:sid,documentType:'01',currency:'PEN',paymentTerms:'CONTADO',externalReference:{namespace:'synthetic',value:'one'},issueDate:'2026-10-20',customer:{identityType:'6',identityNumber:'20444444444',legalName:'SYNTHETIC ONLY'},lines:[{description:'SYNTHETIC ONLY',unitCode:'NIU',quantity:'1',unitPriceWithTax:'118',taxAffectationCode:'10',igvRate:'18'}]};
async function check(label,work){stage=label;await work();passed.push(label);}
(async()=>{
try{
  docker(['image','inspect','postgres:17-alpine']);stage='NEW_EMPTY_ISOLATED_POSTGRES';
  container=docker(['run','--pull','never','--rm','-d','--name',name,'--label',label,'--network','none','--memory','256m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_DB=b2b_synthetic','-e','POSTGRES_PASSWORD='+password,'postgres:17-alpine']);
  assert.match(container,/^[a-f0-9]{64}$/);const config=JSON.parse(docker(['inspect','--format','{{json .HostConfig}}',container]));assert.equal(config.NetworkMode,'none');assert.equal(Object.keys(config.PortBindings??{}).length,0);assert.ok(config.Tmpfs['/var/lib/postgresql/data']);
  stage='WAIT_READY';let ready=false;for(let i=0;i<40;i++){const r=spawnSync('docker',['exec',container,'pg_isready','-U','postgres','-d','b2b_synthetic'],{windowsHide:true,timeout:3000,encoding:'utf8'});if(r.status===0){ready=true;break;}await new Promise(r=>setTimeout(r,200));}assert.ok(ready);
  stage='APPLY_CANDIDATE_TO_EMPTY_DB_ONLY';docker(['exec','-i',container,'psql','-X','-U','postgres','-d','b2b_synthetic','-v','ON_ERROR_STOP=1'],readFileSync(resolve(repo,'services/billing-service/b2b-drafts-schema.candidate.sql'),'utf8'));
  pool=new Pool({host:'127.0.0.1',port:5432,database:'b2b_synthetic',user:'postgres',password,max:3,stream:()=>new Stream(),connectionTimeoutMillis:5000});pool.on('error',()=>{});
  const sql=db=>({$queryRawUnsafe:async(q,...v)=>(await db.query(q,v)).rows,$executeRawUnsafe:async(q,...v)=>(await db.query(q,v)).rowCount});
  const database={$transaction:async work=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='10s'");const v=await work(sql(c));await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
  let failAudit=false,access=true;const backing=new PostgresB2bDraftStore(database);
  const store={transaction:(scope,work)=>backing.transaction(scope,tx=>work({...tx,get:tx.get.bind(tx),create:tx.create.bind(tx),save:tx.save.bind(tx),prior:tx.prior.bind(tx),operation:tx.operation.bind(tx),append:async op=>{if(failAudit)throw new Error('synthetic audit outage');return tx.append(op);}}))};
  const identity={authenticate:async(_token,scopes,kind)=>{if(!access||kind!=='SERVICE'||scopes.some(s=>!principal.scopes.includes(s)))throw new Error('synthetic access denied');return structuredClone(principal);}};
  const core=new B2bDrafts(store,identity,{resolve:async()=>({binding:principal.bindings[0]})});let created;
  const key='synthetic_db_command_001';
  await check('CONCURRENT_IDEMPOTENCY_ONE_DRAFT_ONE_OPERATION',async()=>{const result=await Promise.all(Array.from({length:8},()=>core.command('synthetic','SERVICE','CREATE',null,key,undefined,body)));created=result[0];assert.equal(new Set(result.map(x=>x.operation.operationId)).size,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM "B2bDocumentDraft"')).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM "B2bDraftOperation"')).rows[0].n,1);});
  await check('LOST_RESPONSE_RECOVERY',async()=>assert.deepEqual(await core.operation('synthetic','SERVICE',null,key),created.operation));
  await check('REFERENCE_UNIQUE_ACROSS_NEW_KEYS',async()=>await assert.rejects(core.command('synthetic','SERVICE','CREATE',null,key+'new',undefined,body),e=>e.code==='DRAFT_REFERENCE_CONFLICT'));
  await check('REVISION_CONCURRENCY',async()=>{const r=await Promise.allSettled(['a','b'].map(s=>core.command('synthetic','SERVICE','PATCH',created.response.id,key+s,'"v1"',{issueDate:'2026-10-21'})));assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal((await core.read('synthetic','SERVICE',created.response.id)).revision,'"v2"');});
  await check('AUDIT_FAILURE_ROLLS_BACK_ROW_AND_RETRY',async()=>{failAudit=true;const second={...body,externalReference:{namespace:'synthetic',value:'two'}};await assert.rejects(core.command('synthetic','SERVICE','CREATE',null,key+'second',undefined,second));assert.equal((await pool.query('SELECT count(*)::int AS n FROM "B2bDocumentDraft"')).rows[0].n,1);failAudit=false;const r=await core.command('synthetic','SERVICE','CREATE',null,key+'second',undefined,second);assert.equal(r.replayed,false);});
  await check('PERSISTENCE_SURVIVES_SERVICE_RECREATION',async()=>{const restarted=new B2bDrafts(new PostgresB2bDraftStore(database),identity,{resolve:async()=>({})});assert.deepEqual(await restarted.operation('synthetic','SERVICE',created.operation.operationId),created.operation);});
  await check('NO_FISCAL_TABLES_OR_NETWORK',async()=>{const names=(await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")).rows.map(r=>r.table_name);assert.deepEqual(names,['B2bDocumentDraft','B2bDraftOperation']);await assert.rejects(core.command('synthetic','SERVICE','ISSUE',created.response.id,key+'closed','"v2"',{}),e=>e.code==='PROFILE_NOT_ENABLED');});
  console.log(JSON.stringify({result:'PASS',passed,realData:false,officialNetwork:false,qaRuntimeChanged:false}));
}catch{console.error(JSON.stringify({result:'FAIL',stage,realData:false,qaRuntimeChanged:false}));process.exitCode=1;}
finally{
  await pool?.end();if(container){const labels=JSON.parse(docker(['inspect','--format','{{json .Config.Labels}}',container]));assert.equal(labels['factuez.b2b.drafts.test'],run);docker(['stop','--time','1',container]);}
  console.log('Disposed only the labelled empty synthetic test database; no customer history changed.');
}
})();
