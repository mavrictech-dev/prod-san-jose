'use strict';
// Explicit opt-in for Windows verification without Docker. Never accepts a DB URL.
const {spawnSync}=require('node:child_process'),{createServer}=require('node:net'),{randomUUID}=require('node:crypto');
const {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync}=require('node:fs');
const {tmpdir}=require('node:os'),{resolve,join,sep}=require('node:path'),{createRequire}=require('node:module');
const assert=require('node:assert/strict');
async function withNativePostgres(work){
 const root=resolve(__dirname,'../..'),bin=resolve(process.env.NATIVE_TEST_POSTGRES_BIN??'');
 assert.equal(process.platform,'win32');assert.ok(bin.startsWith(join(root,'.qa')+sep),'Only downloaded test binaries under this checkout/.qa are accepted');
 const local=createRequire(join(root,'services/billing-service/package.json')),{Pool}=local('pg');
 const dir=mkdtempSync(join(tmpdir(),'factuez-synthetic-pg-')),run=randomUUID(),data=join(dir,'data');writeFileSync(join(dir,'owner'),run);
 const exe=name=>join(bin,name+'.exe');let started=false,pool;
 function command(name,args){const r=spawnSync(exe(name),args,{windowsHide:true,stdio:'ignore',encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});assert.equal(r.status,0,`SYNTHETIC_POSTGRES_${name.toUpperCase()}_FAILED: ${r.stderr}`);return r.stdout;}
 try{
  const server=createServer();await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});const port=server.address().port;await new Promise(r=>server.close(r));
  command('initdb',['-D',data,'-U','synthetic','--auth=trust','--encoding=UTF8','--no-locale']);
  writeFileSync(join(data,'postgresql.auto.conf'),`listen_addresses='127.0.0.1'\nport=${port}\nmax_connections=30\nshared_buffers='16MB'\nfsync=off\nsynchronous_commit=off\n`);
  command('pg_ctl',['-D',data,'-l',join(dir,'server.log'),'-w','start']);started=true;
  pool=new Pool({host:'127.0.0.1',port,database:'postgres',user:'synthetic',max:8,connectionTimeoutMillis:10000});
  const database='synthetic_'+run.replaceAll('-','');await pool.query(`CREATE DATABASE "${database}"`);await pool.end();
  pool=new Pool({host:'127.0.0.1',port,database,user:'synthetic',max:8,connectionTimeoutMillis:10000});pool.on('error',()=>{});
  return await work({pool,local,root});
 }finally{
  if(pool&&!pool.ended)await pool.end();if(started)command('pg_ctl',['-D',data,'-w','stop','-m','fast']);
  assert.equal(readFileSync(join(dir,'owner'),'utf8'),run);assert.ok(realpathSync(dir).startsWith(realpathSync(tmpdir())+sep));rmSync(dir,{recursive:true});
 }
}
async function withNativeCorrection(work){return withNativePostgres(async({pool,local,root})=>{
 local('reflect-metadata');const service=join(root,'services/billing-service'),{PrismaPg}=local('@prisma/adapter-pg'),{PrismaClient}=local('./dist/generated/prisma/client');
 const r=spawnSync(process.execPath,[join(service,'node_modules/prisma/build/index.js'),'migrate','diff','--from-empty','--to-schema','prisma/schema.prisma','--script'],{cwd:service,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:16*1024*1024,env:{...process.env,DATABASE_URL:'postgresql://build:build@127.0.0.1:1/not_connected'}});assert.equal(r.status,0,'EMPTY_SYNTHETIC_SCHEMA_FAILED');
 await pool.query(r.stdout);await pool.query(readFileSync(join(service,'b2b-correction-holds-schema.candidate.sql'),'utf8'));
 const client=new PrismaClient({adapter:new PrismaPg(pool)});try{return await work({pool,local,client});}finally{await client.$disconnect();}
});}
module.exports={withNativePostgres,withNativeCorrection};
