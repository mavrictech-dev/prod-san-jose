'use strict';
// The old helper unconditionally installs LOCAL_CAPTURE DDL. This runner installs ONLY CORPORATE.
// NEW service-owned database, tmpfs, no published port/network, no existing DB/SMTP/env/certificates.
const assert=require('node:assert/strict'),{spawn,spawnSync}=require('node:child_process');
const {randomUUID,randomBytes}=require('node:crypto'),{resolve}=require('node:path');
const {createRequire}=require('node:module'),{readFileSync}=require('node:fs'),{Duplex}=require('node:stream');
async function withCorporateEmailDatabase(work){
 const root=resolve(__dirname,'..'),{Pool}=createRequire(resolve(root,'services/mailer-worker/package.json'))('pg');
 const run=randomUUID(),name='factuez-corporate-email-'+run.slice(0,8),database='factuez_mailer_corporate_synthetic',password=randomBytes(24).toString('hex');
 let container;const pools=[];
 const docker=(args,input='')=>{
  const r=spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024});
  assert.equal(r.status,0,'NEW_CORPORATE_EMAIL_POSTGRES_COMMAND_FAILED');return r.stdout.trim();
 };
 class Stream extends Duplex{
  constructor(){super({allowHalfOpen:false});this.closing=false;}
  setNoDelay(){return this;}setKeepAlive(){return this;}ref(){return this;}unref(){return this;}
  connect(port,host){
   assert.equal(port,5432);assert.equal(host,'127.0.0.1');assert.match(container,/^[a-f0-9]{64}$/);
   this.child=spawn('docker',['exec','-i',container,'nc','127.0.0.1','5432'],{windowsHide:true,stdio:['pipe','pipe','ignore']});
   this.child.stdout.on('data',b=>{if(!this.push(b))this.child.stdout.pause();});this.child.stdout.on('end',()=>this.push(null));
   this.child.on('error',()=>this.destroy(Error('NEW_CORPORATE_EMAIL_PG_STREAM_FAILED')));
   this.child.stdin.on('error',()=>this.destroy(Error('NEW_CORPORATE_EMAIL_PG_STREAM_FAILED')));
   this.child.on('exit',c=>{if(c!==0&&!this.destroyed&&!this.closing)this.destroy(Error('NEW_CORPORATE_EMAIL_PG_STREAM_FAILED'));});
   this.child.once('spawn',()=>this.emit('connect'));return this;
  }
  _read(){this.child?.stdout.resume();}_write(b,e,cb){this.child.stdin.write(b,e,cb);}
  _final(cb){this.closing=true;this.child.stdin.end(cb);}_destroy(e,cb){this.closing=true;this.child?.kill();cb(e);}
 }
 try{
  docker(['image','inspect','postgres:17-alpine']);
  container=docker(['run','--pull','never','--rm','-d','--name',name,'--label','factuez.b2b.corporate-email.test='+run,
   '--network','none','--memory','256m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw',
   '-e','POSTGRES_DB='+database,'-e','POSTGRES_PASSWORD='+password,'postgres:17-alpine']);
  assert.match(container,/^[a-f0-9]{64}$/);
  const inspection=JSON.parse(docker(['inspect','--format','{{json .}}',container]));
  assert.equal(inspection.Config.Labels['factuez.b2b.corporate-email.test'],run);
  assert.equal(inspection.HostConfig.NetworkMode,'none');assert.deepEqual(inspection.HostConfig.PortBindings??{},{});
  assert.deepEqual(inspection.HostConfig.Tmpfs,{'/var/lib/postgresql/data':'rw'});
  assert.ok(inspection.Mounts.every(m=>m.Type==='tmpfs'));
  let ready=false;for(let i=0;i<40;i++){
   if(spawnSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database],
    {encoding:'utf8',windowsHide:true,timeout:3000}).status===0){ready=true;break;}
   await new Promise(r=>setTimeout(r,150));
  }assert.ok(ready,'NEW_CORPORATE_EMAIL_POSTGRES_NOT_READY');
  const sql=s=>docker(['exec','-i',container,'psql','-X','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],s);
  sql(readFileSync(resolve(root,'services/mailer-worker/src/b2b/email-deliveries.corporate-schema.candidate.sql'),'utf8'));
  const pool=()=>{const p=new Pool({host:'127.0.0.1',port:5432,database,user:'postgres',password,max:4,
    stream:()=>new Stream(),connectionTimeoutMillis:10000});p.on('error',()=>{});pools.push(p);return p;};
  return await work({pool:pool(),secondPool:pool(),sql});
 }finally{
  await Promise.allSettled(pools.map(p=>p.end()));
  if(container){const labels=JSON.parse(docker(['inspect','--format','{{json .Config.Labels}}',container]));
   assert.equal(labels['factuez.b2b.corporate-email.test'],run);docker(['stop','--time','1',container]);}
 }
}
module.exports={withCorporateEmailDatabase};
if(require.main===module){
 if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['--isolated-synthetic-only'])){
  console.error('ISOLATED_SYNTHETIC_ONLY_REQUIRED');process.exitCode=1;
 }else{
  const r=spawnSync(process.execPath,[resolve(__dirname,'../node_modules/vitest/vitest.mjs'),'run',
   'tests/b2b-email-deliveries-corporate-http.spec.ts','--maxWorkers=1','--testTimeout=60000','--hookTimeout=30000'],
   {cwd:resolve(__dirname,'..'),windowsHide:true,stdio:'inherit',timeout:180000});process.exitCode=r.status===0?0:1;
 }
}
