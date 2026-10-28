'use strict';
// A newly labelled, tmpfs PostgreSQL only. No env files, existing DBs, network or published ports.
const assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const {randomBytes,randomUUID}=require('node:crypto');
const {createRequire}=require('node:module');
const {resolve}=require('node:path');
const {readFileSync}=require('node:fs');
const {Duplex}=require('node:stream');
async function withPhase8ReportsDatabase(work){
  const root=resolve(__dirname,'..'),billing=createRequire(resolve(root,'services/billing-service/package.json'));
  const {Pool}=billing('pg'),run=randomUUID(),password=randomBytes(24).toString('hex'),database='b2b_phase8_reports_synthetic';
  let container;const pools=[];
  function docker(args,input=''){
    const r=spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024});
    assert.equal(r.status,0,'ISOLATED_DOCKER_COMMAND_FAILED');return r.stdout.trim();
  }
  class Stream extends Duplex{
    constructor(){super({allowHalfOpen:false});this.closing=false;}
    setNoDelay(){return this;}setKeepAlive(){return this;}ref(){return this;}unref(){return this;}
    connect(port,host){
      assert.equal(port,5432);assert.equal(host,'127.0.0.1');assert.match(container,/^[a-f0-9]{64}$/);
      this.child=spawn('docker',['exec','-i',container,'nc','127.0.0.1','5432'],{windowsHide:true,stdio:['pipe','pipe','ignore']});
      this.child.stdout.on('data',b=>{if(!this.push(b))this.child.stdout.pause();});this.child.stdout.on('end',()=>this.push(null));
      this.child.on('error',()=>this.destroy(new Error('ISOLATED_PG_STREAM_FAILED')));
      this.child.stdin.on('error',()=>this.destroy(new Error('ISOLATED_PG_STREAM_FAILED')));
      this.child.on('exit',c=>{if(c!==0&&!this.destroyed&&!this.closing)this.destroy(new Error('ISOLATED_PG_STREAM_FAILED'));});
      this.child.once('spawn',()=>this.emit('connect'));return this;
    }
    _read(){this.child?.stdout.resume();}_write(b,e,cb){this.child.stdin.write(b,e,cb);}
    _final(cb){this.closing=true;this.child.stdin.end(cb);}_destroy(e,cb){this.closing=true;this.child?.kill();cb(e);}
  }
  try{
    docker(['image','inspect','postgres:17-alpine']);
    container=docker(['run','--pull','never','--rm','-d','--name','factuez-b2b-p8-reports-'+run.slice(0,8),'--label','factuez.b2b.p8.reports.test='+run,
      '--network','none','--memory','256m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw',
      '-e','POSTGRES_DB='+database,'-e','POSTGRES_PASSWORD='+password,'postgres:17-alpine']);
    assert.match(container,/^[a-f0-9]{64}$/);
    const config=JSON.parse(docker(['inspect','--format','{{json .HostConfig}}',container]));
    assert.equal(config.NetworkMode,'none');assert.equal(Object.keys(config.PortBindings??{}).length,0);assert.ok(config.Tmpfs['/var/lib/postgresql/data']);
    let ready=false;for(let n=0;n<40;n++){if(spawnSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database],{encoding:'utf8',windowsHide:true,timeout:3000}).status===0){ready=true;break;}await new Promise(r=>setTimeout(r,150));}assert.ok(ready,'NEW_POSTGRES_NOT_READY');
    const allowed=new Set([database]);
    const sqlAt=(db,s)=>{assert.ok(allowed.has(db));return docker(['exec','-i',container,'psql','-X','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],s);};
    const sql=s=>sqlAt(database,s);
    sql(readFileSync(resolve(root,'services/billing-service/b2b-phase8-reports.candidate.sql'),'utf8'));
    const pool=(db=database,role)=>{assert.ok(allowed.has(db));if(role)assert.ok(['history_import_qa','history_reader_qa'].includes(role));const p=new Pool({host:'127.0.0.1',port:5432,database:db,user:'postgres',password,max:6,options:role?'-c role='+role:undefined,stream:()=>new Stream(),connectionTimeoutMillis:10000});p.on('error',()=>{});pools.push(p);return p;};
    const createHistoryDatabase=async({markerId,mappings})=>{
      const name='factuez_history_qa_'+randomBytes(5).toString('hex');assert.match(name,/^factuez_history_qa_[0-9a-f]{10}$/);
      sql('CREATE DATABASE "'+name+'"; CREATE ROLE history_import_qa NOLOGIN; CREATE ROLE history_reader_qa NOLOGIN;');allowed.add(name);
      sqlAt(name,readFileSync(resolve(root,'services/history-service/prisma/history-qa-schema.sql'),'utf8'));
      sqlAt(name,readFileSync(resolve(root,'services/history-service/prisma/history-qa-guards.sql'),'utf8'));
      const adminPool=pool(name);
      await adminPool.query('INSERT INTO "HistorySandbox" (id,"markerId","schemaVersion",environment,"datasetClass") VALUES (1,$1,\'factuez.history-storage.v1\',\'BETA\',\'SYNTHETIC\')',[markerId]);
      for(const m of mappings){
        await adminPool.query('INSERT INTO "HistoryIssuer" ("companyId","issuerRuc") VALUES ($1,$2)',[m.companyId,m.issuerRuc]);
        await adminPool.query('INSERT INTO "HistoryOwnerMapping" ("mappingId","issuerRuc","companyId","branchId","emissionPointId","seriesCounterId","documentTypeCode",series,"mappingSha256") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[m.mappingId,m.issuerRuc,m.companyId,m.branchId,m.emissionPointId,m.seriesCounterId,m.documentTypeCode,m.series,m.mappingSha256]);
      }
      return {databaseName:name,markerId,adminPool,importPool:pool(name,'history_import_qa'),readerPool:pool(name,'history_reader_qa')};
    };
    return await work({pool:pool(),secondPool:pool(),database,run,createHistoryDatabase});
  }finally{
    for(const p of pools)await p.end();
    if(container){const labels=JSON.parse(docker(['inspect','--format','{{json .Config.Labels}}',container]));assert.equal(labels['factuez.b2b.p8.reports.test'],run);docker(['stop','--time','1',container]);}
  }
}
module.exports={withPhase8ReportsDatabase};