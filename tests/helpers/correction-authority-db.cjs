'use strict';
// Two NEW owner databases, one labelled tmpfs container, no network or published ports.
const assert=require('node:assert/strict'),{spawn,spawnSync}=require('node:child_process'),{randomBytes,randomUUID}=require('node:crypto');
const {readFileSync}=require('node:fs'),{createRequire}=require('node:module'),{resolve}=require('node:path'),{Duplex}=require('node:stream');
async function withCorrectionAuthorityDatabases(work){
  const root=resolve(__dirname,'../..'),billing=resolve(root,'services/billing-service'),identity=resolve(root,'services/identity-service');
  const b=createRequire(resolve(billing,'package.json')),i=createRequire(resolve(identity,'package.json'));b('reflect-metadata');
  const {Pool}=b('pg'),{PrismaPg}=b('@prisma/adapter-pg'),{PrismaClient}=b('./dist/generated/prisma/client'),IdentityClient=i('./dist/generated/prisma/client').PrismaClient;
  const run=randomUUID(),label='factuez.correction.authority.test='+run,password=randomBytes(24).toString('hex');
  let container=null,billingPool=null,identityPool=null,billingClient=null,identityClient=null;
  function docker(args,input=''){const r=spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024});assert.equal(r.status,0,'ISOLATED_DOCKER_FAILED');return r.stdout.trim();}
  class Stream extends Duplex {
    constructor(){super({allowHalfOpen:false});}setNoDelay(){return this;}setKeepAlive(){return this;}ref(){return this;}unref(){return this;}
    connect(port,host){assert.equal(port,5432);assert.equal(host,'127.0.0.1');assert.match(container,/^[a-f0-9]{64}$/);this.child=spawn('docker',['exec','-i',container,'nc','127.0.0.1','5432'],{windowsHide:true,stdio:['pipe','pipe','ignore']});this.child.stdout.on('data',b=>{if(!this.push(b))this.child.stdout.pause();});this.child.stdout.on('end',()=>this.push(null));this.child.on('error',()=>this.destroy(new Error('ISOLATED_STREAM_FAILED')));this.child.stdin.on('error',()=>this.destroy(new Error('ISOLATED_STREAM_FAILED')));this.child.once('spawn',()=>this.emit('connect'));return this;}
    _read(){this.child?.stdout.resume();}_write(b,e,cb){this.child.stdin.write(b,e,cb);}_final(cb){this.child.stdin.end(cb);}_destroy(e,cb){this.child?.kill();cb(e);}
  }
  try {
    docker(['image','inspect','postgres:17-alpine']);
    container=docker(['run','--pull','never','--rm','-d','--name','factuez-correction-authority-'+run.slice(0,8),'--label',label,'--network','none','--memory','256m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_DB=correction_billing_synthetic','-e','POSTGRES_PASSWORD='+password,'postgres:17-alpine']);
    const config=JSON.parse(docker(['inspect','--format','{{json .HostConfig}}',container]));assert.equal(config.NetworkMode,'none');assert.equal(Object.keys(config.PortBindings??{}).length,0);assert.ok(config.Tmpfs['/var/lib/postgresql/data']);
    let ready=false;for(let n=0;n<40;n++){if(spawnSync('docker',['exec',container,'pg_isready','-U','postgres'],{windowsHide:true,timeout:3000,encoding:'utf8'}).status===0){ready=true;break;}await new Promise(r=>setTimeout(r,200));}assert.ok(ready);
    const sql=(db,s)=>{assert.ok(['correction_billing_synthetic','correction_identity_synthetic'].includes(db));return docker(['exec','-i',container,'psql','-X','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],s);};
    sql('correction_billing_synthetic','CREATE DATABASE correction_identity_synthetic;');
    for(const [dir,db]of [[billing,'correction_billing_synthetic'],[identity,'correction_identity_synthetic']]){
      const ddl=spawnSync(process.execPath,[resolve(dir,'node_modules/prisma/build/index.js'),'migrate','diff','--from-empty','--to-schema','prisma/schema.prisma','--script'],{cwd:dir,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:16*1024*1024,env:{...process.env,NODE_PATH:resolve(dir,'node_modules'),DATABASE_URL:'postgresql://build:build@127.0.0.1:1/not_connected',PRISMA_HIDE_UPDATE_MESSAGE:'true'}});assert.equal(ddl.status,0,'EMPTY_SCHEMA_GENERATION_FAILED');sql(db,ddl.stdout);
    }
    for(const file of ['b2b-schema.candidate.sql','b2b-correction-grants-schema.candidate.sql'])sql('correction_identity_synthetic',readFileSync(resolve(identity,file),'utf8'));
    const pool=db=>new Pool({host:'127.0.0.1',port:5432,database:db,user:'postgres',password,max:6,stream:()=>new Stream(),connectionTimeoutMillis:10000});
    billingPool=pool('correction_billing_synthetic');identityPool=pool('correction_identity_synthetic');for(const p of [billingPool,identityPool])p.on('error',()=>{});
    billingClient=new PrismaClient({adapter:new PrismaPg(billingPool)});identityClient=new IdentityClient({adapter:new PrismaPg(identityPool)});
    return await work({billingClient,identityClient,billingPool,identityPool,b,i});
  }finally{
    await billingClient?.$disconnect();await identityClient?.$disconnect();for(const pool of [billingPool,identityPool])if(pool&&!pool.ended)await pool.end();
    if(container){const labels=JSON.parse(docker(['inspect','--format','{{json .Config.Labels}}',container]));assert.equal(labels['factuez.correction.authority.test'],run);docker(['stop','--time','1',container]);}
  }
}
module.exports={withCorrectionAuthorityDatabases};
