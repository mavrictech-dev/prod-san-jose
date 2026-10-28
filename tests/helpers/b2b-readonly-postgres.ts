import {spawn,spawnSync} from 'node:child_process';
import {Duplex} from 'node:stream';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const repo=resolve(__dirname,'../..');
const local=createRequire(resolve(repo,'services/billing-service/package.json'));
const fiscal=createRequire(resolve(repo,'services/sunat-service/package.json'));
const {Pool}=local('pg'),{PrismaPg}=local('@prisma/adapter-pg');
const {PrismaClient}=local('./dist/generated/prisma/client'),FiscalClient=fiscal('./dist/generated/prisma/client').PrismaClient;
/** Fresh, labelled container, no network, no host port, no volume or existing
 * database credentials. SQL reaches only this owned container over docker exec. */
export async function readonlyPostgres(){
 const run=randomUUID(),name='factuez-readonly-'+run.slice(0,8),password=randomBytes(24).toString('hex');
 let container:string|undefined;const pools:any[]=[];let billing:any,fiscalDb:any;
 const docker=(args:string[],input='')=>{
  const r=spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024});
  if(r.status!==0)throw Error('ISOLATED_READONLY_DOCKER_FAILED');return r.stdout.trim();
 };
 const close=async()=>{
  await billing?.$disconnect().catch(()=>{});await fiscalDb?.$disconnect().catch(()=>{});
  for(const p of pools)if(!p.ended)await p.end();
  if(container){
   const labels=JSON.parse(docker(['inspect','--format','{{json .Config.Labels}}',container]));
   if(labels['factuez.b2b.readonly.test']!==run)throw Error('ISOLATED_READONLY_CLEANUP_OWNERSHIP_REQUIRED');
   docker(['stop','--time','1',container]);container=undefined;
  }
 };
 try{
  container=docker(['run','--pull','never','--rm','-d','--name',name,'--label','factuez.b2b.readonly.test='+run,
   '--network','none','--memory','512m','--cpus','2','--tmpfs','/var/lib/postgresql/data:rw',
   '-e','POSTGRES_DB=billing_synthetic','-e','POSTGRES_PASSWORD='+password,'postgres:17-alpine']);
  if(!/^[a-f0-9]{64}$/.test(container))throw Error('ISOLATED_CONTAINER_ID_REQUIRED');
  const host=JSON.parse(docker(['inspect','--format','{{json .HostConfig}}',container]));
  if(host.NetworkMode!=='none'||Object.keys(host.PortBindings??{}).length||!host.Tmpfs['/var/lib/postgresql/data'])throw Error('ISOLATED_POSTGRES_REQUIRED');
  let ready=false;
  for(let i=0;i<60;i++){
   const r=spawnSync('docker',['exec',container,'pg_isready','-U','postgres','-d','billing_synthetic'],{windowsHide:true,timeout:3000,stdio:'ignore'});
   if(r.status===0){ready=true;break;}await new Promise(r=>setTimeout(r,200));
  }
  if(!ready)throw Error('ISOLATED_POSTGRES_NOT_READY');
  const sql=(db:string,text:string)=>docker(['exec','-i',container!,'psql','-X','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],text);
  for(const db of ['identity_synthetic','fiscal_synthetic','b2b_webhooks_beta'])sql('billing_synthetic','CREATE DATABASE '+db+';');
  for(const [service,db] of [['billing-service','billing_synthetic'],['sunat-service','fiscal_synthetic']]){
   const root=resolve(repo,'services',service),r=spawnSync(process.execPath,[resolve(root,'node_modules/prisma/build/index.js'),
    'migrate','diff','--from-empty','--to-schema','prisma/schema.prisma','--script'],{cwd:root,encoding:'utf8',windowsHide:true,
    timeout:60000,maxBuffer:16*1024*1024,env:{...process.env,NODE_PATH:resolve(root,'node_modules'),DATABASE_URL:'postgresql://synthetic:synthetic@127.0.0.1:1/not_connected'}});
   if(r.status!==0)throw Error('ISOLATED_SCHEMA_GENERATION_FAILED:'+service);sql(db,r.stdout);
  }
  sql('identity_synthetic','CREATE TABLE "User" ("id" uuid PRIMARY KEY);');
  sql('identity_synthetic',readFileSync(resolve(repo,'services/identity-service/b2b-schema.candidate.sql'),'utf8'));
  sql('fiscal_synthetic',readFileSync(resolve(repo,'services/sunat-service/b2b-read-schema.candidate.sql'),'utf8'));
  sql('b2b_webhooks_beta',readFileSync(resolve(repo,'services/webhook-service/webhooks-schema.candidate.sql'),'utf8'));
  class Stream extends Duplex{
   child:any;
   constructor(){super({allowHalfOpen:false});}
   setNoDelay(){return this;}setKeepAlive(){return this;}ref(){return this;}unref(){return this;}
   connect(port:number,host:string){
    if(port!==5432||host!=='127.0.0.1'||!container)throw Error('ISOLATED_STREAM_TARGET_REQUIRED');
    this.child=spawn('docker',['exec','-i',container,'nc','127.0.0.1','5432'],{windowsHide:true,stdio:['pipe','pipe','ignore']});
    this.child.stdout.on('data',(b:Buffer)=>{if(!this.push(b))this.child.stdout.pause();});
    this.child.stdout.on('end',()=>this.push(null));this.child.on('error',()=>this.destroy(Error('ISOLATED_STREAM_FAILED')));
    this.child.stdin.on('error',()=>this.destroy(Error('ISOLATED_STREAM_FAILED')));this.child.once('spawn',()=>this.emit('connect'));return this;
   }
   _read(){this.child?.stdout.resume();}
   _write(b:any,e:any,cb:any){this.child.stdin.write(b,e,cb);}
   _final(cb:any){this.child.stdin.end(cb);}
   _destroy(e:any,cb:any){this.child?.kill();cb(e);}
  }
  const pool=(database:string)=>{
   const p=new Pool({host:'127.0.0.1',port:5432,user:'postgres',password,database,max:8,stream:()=>new Stream(),connectionTimeoutMillis:10000});
   p.on('error',()=>{});pools.push(p);return p;
  };
  const billingPool=pool('billing_synthetic'),fiscalPool=pool('fiscal_synthetic'),identityPool=pool('identity_synthetic'),hooks=pool('b2b_webhooks_beta');
  billing=new PrismaClient({adapter:new PrismaPg(billingPool)});fiscalDb=new FiscalClient({adapter:new PrismaPg(fiscalPool)});
  const raw=(db:any)=>({
   $queryRawUnsafe:async(q:string,...values:any[])=>(await db.query(q,values)).rows,
   $executeRawUnsafe:async(q:string,...values:any[])=>(await db.query(q,values)).rowCount,
  });
  const identity={...raw(identityPool),$transaction:async(work:any)=>{
   const db=await identityPool.connect();
   try{await db.query('BEGIN');const result=await work(raw(db));await db.query('COMMIT');return result;}
   catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  }};
  return {billing,fiscal:fiscalDb,identity,hooks,identityPool,sql,close};
 }catch(e){await close();throw e;}
}
