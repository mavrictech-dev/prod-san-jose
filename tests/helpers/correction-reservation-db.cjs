'use strict';
const assert=require('node:assert/strict'),{spawn,spawnSync}=require('node:child_process'),{randomBytes,randomUUID}=require('node:crypto');
const {readFileSync}=require('node:fs'),{createRequire}=require('node:module'),{resolve}=require('node:path'),{Duplex}=require('node:stream');
// Fixed target and labelled ownership: no caller-provided paths, URLs, DBs or RUCs.
async function withCorrectionDatabase(work){
  const root=resolve(__dirname,'../..'),service=resolve(root,'services/billing-service'),local=createRequire(resolve(service,'package.json'));
  local('reflect-metadata');const {Pool}=local('pg'),{PrismaPg}=local('@prisma/adapter-pg'),{PrismaClient}=local('./dist/generated/prisma/client');
  const run=randomUUID(),name='factuez-correction-holds-'+run.slice(0,8),label='factuez.correction.holds.test='+run,password=randomBytes(24).toString('hex');
  let container=null,pool=null,client=null;
  function docker(args,input=''){const r=spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024});assert.equal(r.status,0,'ISOLATED_DOCKER_FAILED');return r.stdout.trim();}
  class Stream extends Duplex {
    constructor(){super({allowHalfOpen:false});}setNoDelay(){return this;}setKeepAlive(){return this;}ref(){return this;}unref(){return this;}
    connect(port,host){assert.equal(port,5432);assert.equal(host,'127.0.0.1');assert.match(container,/^[a-f0-9]{64}$/);this.child=spawn('docker',['exec','-i',container,'nc','127.0.0.1','5432'],{windowsHide:true,stdio:['pipe','pipe','ignore']});this.child.stdout.on('data',b=>{if(!this.push(b))this.child.stdout.pause();});this.child.stdout.on('end',()=>this.push(null));this.child.on('error',()=>this.destroy(new Error('ISOLATED_STREAM_FAILED')));this.child.stdin.on('error',()=>this.destroy(new Error('ISOLATED_STREAM_FAILED')));this.child.once('spawn',()=>this.emit('connect'));return this;}
    _read(){this.child?.stdout.resume();}_write(b,e,cb){this.child.stdin.write(b,e,cb);}_final(cb){this.child.stdin.end(cb);}_destroy(e,cb){this.child?.kill();cb(e);}
  }
  try{
    docker(['image','inspect','postgres:17-alpine']);
    container=docker(['run','--pull','never','--rm','-d','--name',name,'--label',label,'--network','none','--memory','256m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_DB=b2b_corrections_synthetic','-e','POSTGRES_PASSWORD='+password,'postgres:17-alpine']);
    const config=JSON.parse(docker(['inspect','--format','{{json .HostConfig}}',container]));assert.equal(config.NetworkMode,'none');assert.equal(Object.keys(config.PortBindings??{}).length,0);assert.ok(config.Tmpfs['/var/lib/postgresql/data']);
    let ready=false;for(let i=0;i<40;i++){const r=spawnSync('docker',['exec',container,'pg_isready','-U','postgres','-d','b2b_corrections_synthetic'],{windowsHide:true,timeout:3000,encoding:'utf8'});if(r.status===0){ready=true;break;}await new Promise(r=>setTimeout(r,200));}assert.ok(ready);
    const ddl=spawnSync(process.execPath,[resolve(service,'node_modules/prisma/build/index.js'),'migrate','diff','--from-empty','--to-schema','prisma/schema.prisma','--script'],{cwd:service,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:16*1024*1024,env:{...process.env,NODE_PATH:resolve(service,'node_modules'),DATABASE_URL:'postgresql://build:build@127.0.0.1:1/not_connected',PRISMA_HIDE_UPDATE_MESSAGE:'true'}});assert.equal(ddl.status,0,'EMPTY_SCHEMA_GENERATION_FAILED');
    const sql=s=>docker(['exec','-i',container,'psql','-X','-U','postgres','-d','b2b_corrections_synthetic','-v','ON_ERROR_STOP=1'],s);
    sql(ddl.stdout);sql(readFileSync(resolve(service,'b2b-correction-holds-schema.candidate.sql'),'utf8'));
    pool=new Pool({host:'127.0.0.1',port:5432,database:'b2b_corrections_synthetic',user:'postgres',password,max:8,stream:()=>new Stream(),connectionTimeoutMillis:10000});pool.on('error',()=>{});client=new PrismaClient({adapter:new PrismaPg(pool)});
    return await work({client,pool,local});
  }finally{
    await client?.$disconnect();if(pool&&!pool.ended)await pool.end();if(container){const labels=JSON.parse(docker(['inspect','--format','{{json .Config.Labels}}',container]));assert.equal(labels['factuez.correction.holds.test'],run);docker(['stop','--time','1',container]);}
  }
}
module.exports={withCorrectionDatabase};
