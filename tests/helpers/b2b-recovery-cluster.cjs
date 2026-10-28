'use strict';
// Opt-in fixed NEW resources only. Never accepts a URL, existing DB/container,
// image name, mount, host directory, customer RUC, password or backup pathname.
const assert=require('node:assert/strict'),{spawn,spawnSync}=require('node:child_process');
const {randomBytes,createHash}=require('node:crypto'),{createRequire}=require('node:module');
const {resolve}=require('node:path'),{Duplex}=require('node:stream');
const ROOT=resolve(__dirname,'../..'),LABEL='factuez.b2b.recovery.test';
const OWNERS=['BILLING','RECEIVED','MAILER'],db=owner=>'b2b9_'+owner.toLowerCase()+'_synthetic',reader=owner=>'b2b9_'+owner.toLowerCase()+'_reader';
const sha=b=>createHash('sha256').update(b).digest('hex');
const quote=name=>{assert.match(name,/^[A-Za-z][A-Za-z0-9_]{0,62}$/);return '"'+name+'"';};
const local=createRequire(resolve(ROOT,'services/billing-service/package.json'));
async function newRecoveryCluster(runId,role){
 assert.equal(process.env.FACTUEZ_B2B_RECOVERY_DB,'NEW_NETWORK_NONE_TMPFS_ONLY');
 assert.match(runId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);assert.ok(['source','restore'].includes(role));
 const {Pool}=local('pg'),name='factuez-b2b9-recovery-'+role+'-'+runId.slice(0,8),password=randomBytes(24).toString('hex');
 const pools=[],clients=[],schemas=new Map();let container,closed=false,ready=false;
 const command=(args,input,encoding)=>{const r=spawnSync('docker',['--context','desktop-linux',...args],{input,encoding,windowsHide:true,timeout:30000,maxBuffer:20*1024*1024});
  if(r.status!==0){const diagnostic=args.includes('pg_restore')?String(r.stderr??'').split(/\r?\n/).filter(s=>/ERROR:|pg_restore: error:/.test(s)).map(s=>s.slice(0,300)).slice(0,3).join(' | '):'';throw new Error('OWNED_RECOVERY_DOCKER_FAILED '+diagnostic);}
  return r.stdout;};
 const meta=(args,input)=>command(args,input,'utf8').trim();
 function owned(){
  assert.ok(container&&!closed);const row=JSON.parse(meta(['inspect','--format','{{json .}}',container]));
  assert.equal(row.Id,container);assert.equal(row.Name,'/'+name);assert.equal(row.Config.Labels[LABEL],runId);assert.equal(row.Config.Labels['factuez.b2b.recovery.role'],role);
  assert.equal(row.HostConfig.NetworkMode,'none');assert.deepEqual(row.HostConfig.PortBindings??{},{});assert.ok(row.HostConfig.Tmpfs['/var/lib/postgresql/data']);assert.ok(row.HostConfig.Tmpfs['/tmp']);
  assert.ok(row.Mounts.every(m=>m.Type==='tmpfs'));return row;
 }
 function owner(o){assert.ok(OWNERS.includes(o));assert.ok(ready&&!closed);}
 function sql(o,text){owner(o);return meta(['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db(o)],Buffer.from(text));}
 // Separate binary transport, never host-published. No fallback network socket.
 class Stream extends Duplex{
  constructor(){super({allowHalfOpen:false});this.closing=false;}
  setNoDelay(){return this;}setKeepAlive(){return this;}ref(){return this;}unref(){return this;}
  connect(port,host){assert.equal(port,5432);assert.equal(host,'127.0.0.1');assert.ok(ready&&!closed);
   this.child=spawn('docker',['--context','desktop-linux','exec','-i',container,'nc','127.0.0.1','5432'],{windowsHide:true,stdio:['pipe','pipe','ignore']});
   this.child.stdout.on('data',b=>{if(!this.push(b))this.child.stdout.pause();});this.child.stdout.on('end',()=>this.push(null));
   this.child.on('error',()=>this.destroy(new Error('RECOVERY_PG_STREAM_FAILED')));this.child.stdin.on('error',()=>{if(!this.closing)this.destroy(new Error('RECOVERY_PG_STREAM_FAILED'));});
   this.child.once('spawn',()=>this.emit('connect'));return this;}
  _read(){this.child?.stdout.resume();}_write(b,e,cb){this.child.stdin.write(b,e,cb);}
  _final(cb){this.closing=true;this.child.stdin.end(cb);}_destroy(e,cb){this.closing=true;this.child?.kill();cb(e);}
 }
 const errors=[];
 async function close(){
  if(closed)return;
  try{for(const c of clients)await c.$disconnect();for(const p of pools)if(!p.ended)await p.end();await new Promise(setImmediate);assert.deepEqual(errors,[],'RECOVERY_IDLE_POOL_ERROR');}
  finally{if(container){owned();meta(['stop','--time','1',container]);container=null;}closed=true;}
 }
 try{
  assert.equal(process.platform,'win32','WINDOWS_LOCAL_DESKTOP_REHEARSAL_REQUIRED');
  assert.equal(meta(['context','inspect','desktop-linux','--format','{{(index .Endpoints "docker").Host}}']),'npipe:////./pipe/dockerDesktopLinuxEngine');
  const image=meta(['image','inspect','--format','{{.Id}}','postgres:17-alpine']);assert.match(image,/^sha256:[a-f0-9]{64}$/);
  container=meta(['run','--pull','never','--rm','-d','--name',name,'--label',LABEL+'='+runId,'--label','factuez.b2b.recovery.role='+role,
   '--network','none','--memory','384m','--cpus','1','--pids-limit','128','--tmpfs','/var/lib/postgresql/data:rw,size=268435456','--tmpfs','/tmp:rw,size=33554432',
   '-e','POSTGRES_PASSWORD='+password,image]);assert.match(container,/^[a-f0-9]{64}$/);owned();
  for(let n=0;n<60;n++){
   const r=spawnSync('docker',['--context','desktop-linux','exec',container,'pg_isready','-h','127.0.0.1','-U','postgres'],{windowsHide:true,timeout:3000,stdio:'ignore'});
   if(r.status===0){ready=true;break;}await new Promise(r=>setTimeout(r,150));
  }assert.ok(ready,'NEW_RECOVERY_POSTGRES_NOT_READY');
  for(const o of OWNERS){meta(['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],Buffer.from('CREATE DATABASE '+db(o)+'; CREATE ROLE '+reader(o)+' NOLOGIN;'));}
  const pool=o=>{owner(o);const p=new Pool({host:'127.0.0.1',port:5432,database:db(o),user:'postgres',password,max:4,connectionTimeoutMillis:10000,stream:()=>new Stream()});
   p.on('error',e=>{if(!(p.ending&&e.code==='ERR_STREAM_DESTROYED'&&e.client?._ending===true))errors.push(e.code??'RECOVERY_POOL_ERROR');});pools.push(p);return p;};
  const path=(o,file)=>{owner(o);assert.match(file,/^[a-z0-9][a-z0-9_-]{0,63}\.(xml|zip|pdf)$/);return '/tmp/b2b9-'+runId+'/'+o.toLowerCase()+'/'+file;};
  async function inventory(o){
   owner(o);const names=JSON.parse(sql(o,"SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]') FROM pg_tables WHERE schemaname='public';"));
   const tables=names.map(name=>({name,...JSON.parse(sql(o,`SELECT json_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex')) FROM ${quote(name)} t;`))}));
   const sequences=JSON.parse(sql(o,"SELECT coalesce(json_agg(sequencename ORDER BY sequencename),'[]') FROM pg_sequences WHERE schemaname='public';")).map(name=>({name,...JSON.parse(sql(o,`SELECT json_build_object('lastValue',last_value::text,'isCalled',is_called) FROM ${quote(name)};`))}));
   // pg_dump round-trips can rewrite equivalent array casts in CHECK syntax.
   // Reparse each full predicate in a TEMP VIEW and compare PostgreSQL's own
   // canonical deparse; never strip a predicate or replace it with a boolean.
   const schema=sql(o,`CREATE FUNCTION pg_temp.b2b9_canonical_check(rel regclass,definition text) RETURNS text LANGUAGE plpgsql AS $$
    DECLARE result text; BEGIN
     EXECUTE format('CREATE TEMP VIEW b2b9_constraint_canonical AS SELECT (%s) AS checked FROM %s',definition,rel);
     SELECT pg_get_viewdef(to_regclass('pg_temp.b2b9_constraint_canonical'),false) INTO result;
     DROP VIEW pg_temp.b2b9_constraint_canonical; RETURN result;
    END; $$;
   SELECT jsonb_build_object(
    'columns',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY table_name,ordinal_position),'[]') FROM (SELECT table_name,column_name,ordinal_position,column_default,is_nullable,data_type,udt_name,character_maximum_length,numeric_precision,numeric_scale,is_identity,identity_generation FROM information_schema.columns WHERE table_schema='public') c),
    'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname,x.conname,CASE WHEN x.contype='c' THEN pg_temp.b2b9_canonical_check(c.oid,pg_get_expr(x.conbin,x.conrelid)) ELSE pg_get_constraintdef(x.oid) END) ORDER BY c.relname,x.conname),'[]') FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
    'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_array(tablename,indexname,indexdef) ORDER BY tablename,indexname),'[]') FROM pg_indexes WHERE schemaname='public'),
    'functions',(SELECT coalesce(jsonb_agg(jsonb_build_array(p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid)) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)),'[]') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),
    'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname,t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY c.relname,t.tgname),'[]') FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal),
    'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname,c.relrowsecurity,c.relforcerowsecurity,coalesce((SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a),'[]')) ORDER BY c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S')),
    'reader',(SELECT to_jsonb(r) FROM (SELECT rolname,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='${reader(o)}') r)
   )::text;`);
   schemas.set(o,JSON.parse(schema));return {schemaSha256:sha(Buffer.from(schema)),tables,sequences};
  }
  return {runId,role,pool,sql,inventory,close,owned,schemaEvidence:o=>structuredClone(schemas.get(o)),
   registerClient:c=>{clients.push(c);return c;},
   reader:reader,
   putOriginal:(o,file,b)=>{const p=path(o,file);assert.ok(Buffer.isBuffer(b)&&b.length>0&&b.length<=10*1024*1024);owned();meta(['exec',container,'mkdir','-p','/tmp/b2b9-'+runId+'/'+o.toLowerCase()]);command(['exec','-i',container,'sh','-c','umask 077; cat > "$1"','sh',p],b);},
   getOriginal:(o,file)=>{const p=path(o,file);owned();return command(['exec',container,'cat',p]);},
   dump:o=>{owner(o);assert.equal(role,'source');owned();return command(['exec',container,'pg_dump','-U','postgres','--format=custom','--no-owner','--dbname='+db(o)]);},
   restore:(o,b)=>{owner(o);assert.equal(role,'restore');owned();assert.ok(Buffer.isBuffer(b)&&b.length<=16*1024*1024&&b.subarray(0,5).toString()==='PGDMP');
    const empty=sql(o,"SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')+(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public');");
    assert.equal(empty,'0','RECOVERY_TARGET_MUST_BE_EMPTY');command(['exec','-i',container,'pg_restore','-U','postgres','--no-owner','--single-transaction','--exit-on-error','--dbname='+db(o)],b);},
  };
 }catch(e){await close();throw e;}
}
module.exports={newRecoveryCluster,ROOT,LABEL};
