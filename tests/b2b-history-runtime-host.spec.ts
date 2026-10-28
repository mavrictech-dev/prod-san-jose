import 'reflect-metadata';
import {beforeAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {writeFileSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {request} from 'node:https';
import type {AddressInfo} from 'node:net';
import {bootstrapB2bHistory} from '../services/history-service/src/b2b/main';
import {loadB2bHistoryRuntimeMount,b2bHistoryPrismaAdapter} from '../services/history-service/src/b2b/runtime-files';
import {b2bHistoryRuntimeSchemaChecks} from '../services/history-service/src/b2b/runtime-schema';
import {historyFixture} from './b2b-phase8-reports-history.fixture';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
const state=vi.hoisted(()=>({db:undefined as any,created:[] as any[]}));
// Only Prisma's network boundary is replaced. Main constructs the actual
// PrismaPg adapter, verified PG/TLS options and all real History/Nest classes.
vi.mock('../services/history-service/src/generated/prisma/client',()=>({PrismaClient:class {constructor(options:any){state.created.push(options);return state.db;}}}));
let tls:ReturnType<typeof b2bCertificates>;
const fixtures:ReturnType<typeof historyFixture>[]=[],hosts:NonNullable<Awaited<ReturnType<typeof bootstrapB2bHistory>>>[]=[];
beforeAll(()=>{tls=b2bCertificates();},30000);
beforeEach(()=>{state.created=[];state.db=undefined;});
afterEach(async()=>{for(const h of hosts.splice(0))await h.close();for(const f of fixtures.splice(0))f.close();vi.unstubAllEnvs();});
function mounted(){
 const f=historyFixture();fixtures.push(f);const storage={sourceRoot:(f.artifacts as any).sourceRoot as string,archiveRoot:(f.artifacts as any).archiveRoot as string};
 const root=join(dirname(storage.sourceRoot),'config');mkdirSync(root,{mode:0o700});
 const config:any={enabled:true,schemaVersion:'factuez.b2b.history-runtime.v1',environment:'BETA',datasetClass:'SYNTHETIC',approvedForSyntheticQa:true,
  deploymentId:randomUUID(),instanceId:randomUUID(),markerId:f.markerId,api:{host:'127.0.0.1',port:0},control:{host:'127.0.0.1',port:0},peers:{resource:[fingerprint(tls.resource)],operator:[fingerprint(tls.other)]},identityOrigin:'https://identity.synthetic.invalid',
  database:{host:'history-pg.synthetic.invalid',port:5432,name:'factuez_history_qa_aabbccddee',user:'history_reader_qa',passwordFile:'database-password.bin'},storage};
 const write=(name:string,bytes:Buffer|string)=>writeFileSync(join(root,name),bytes,{mode:0o600});
 const save=()=>write('runtime.json',JSON.stringify(config));save();
 for(const p of ['api','operator','identity']){write(p+'-ca.pem',tls.ca);write(p+'.crt',p==='identity'?tls.edge:tls.server);write(p+'.key',tls.key);}
 write('database-ca.pem',tls.ca);write('database-password.bin','SYNTHETIC-READER-PASSWORD\n');
 const query=vi.fn(async(sql:string)=>{if(sql==='SELECT current_database() AS database, current_user AS role')return [{database:config.database.name,role:'history_reader_qa'}];if(b2bHistoryRuntimeSchemaChecks.includes(sql))return [];throw Error('UNEXPECTED_BOOTSTRAP_SQL');});
 f.tx.$queryRawUnsafe=query;
 const db:any={...f.prisma,$connect:vi.fn(async()=>{}),$disconnect:vi.fn(async()=>{}),$executeRawUnsafe:vi.fn(async()=>{throw Error('NO_BOOTSTRAP_WRITE');})};state.db=db;
 return {f,root,config,save,write,query,db};
}
describe('History concrete executable host, mounted QA profile and actual PrismaPg TLS options',()=>{
 it('disabled host does not read metadata or instantiate a database',async()=>{
  const env={B2B_HISTORY_ENABLED:'false',get B2B_HISTORY_CONFIG_ROOT():string{throw Error('ROOT_MUST_STAY_UNREAD');}};
  expect(await bootstrapB2bHistory(env)).toBeNull();expect(state.created).toHaveLength(0);await expect(bootstrapB2bHistory({B2B_HISTORY_ENABLED:'true'})).rejects.toThrow('ROOT_REQUIRED');
 });
 it('starts actual history/status HTTP surfaces and disposes the owned adapter exactly once',async()=>{
  const m=mounted(),host=(await bootstrapB2bHistory({B2B_HISTORY_ENABLED:'true',B2B_HISTORY_CONFIG_ROOT:m.root}))!;hosts.push(host);
  expect(m.db.$connect).toHaveBeenCalledTimes(1);expect(state.created).toHaveLength(1);expect(m.db.$executeRawUnsafe).not.toHaveBeenCalled();
  const port=(host.ports.api as AddressInfo).port,bytes=Buffer.from('{}');
  const probe=await new Promise<any>((resolve,reject)=>{
   const req=request({hostname:'127.0.0.1',port,path:'/internal/b2b/runtime-status',method:'POST',ca:tls.ca,cert:tls.resource,key:tls.key,agent:false,rejectUnauthorized:true,headers:{'Content-Type':'application/json','Content-Length':bytes.length}},res=>{const b:Buffer[]=[];res.on('data',x=>b.push(x));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(b).toString())}));});req.on('error',reject);req.end(bytes);
  });expect(probe).toMatchObject({status:200,body:{owner:'history',capabilities:['READ'],bootId:host.runtime.maintenance.snapshot().instance.bootId,fiscalActivation:false}});
  await host.close();await host.close();expect(m.db.$disconnect).toHaveBeenCalledTimes(1);
 });
 it('mount/metadata/CA failures occur before database construction or connect',async()=>{
  const m=mounted();rmSync(join(m.root,'database-ca.pem'));
  await expect(bootstrapB2bHistory({B2B_HISTORY_ENABLED:'true',B2B_HISTORY_CONFIG_ROOT:m.root})).rejects.toThrow('MOUNTED_CONFIGURATION_INVALID');expect(state.created).toHaveLength(0);expect(m.db.$connect).not.toHaveBeenCalled();
  m.write('database-ca.pem',tls.ca);delete m.config.database;m.save();expect(()=>loadB2bHistoryRuntimeMount(m.root)).toThrow();expect(state.created).toHaveLength(0);
 });
 it.each(['name','user','environment','datasetClass','markerId','root'])('never relaxes the original %s profile',field=>{
  const m=mounted();if(field==='name')m.config.database.name='b2b_history_beta';if(field==='user')m.config.database.user='history_import_qa';if(field==='environment')m.config.environment='PRODUCTION';if(field==='datasetClass')m.config.datasetClass='AUTHORIZED_COPY';if(field==='markerId')m.config.markerId='not-a-marker';if(field==='root')m.config.storage.archiveRoot='relative/archive';m.save();expect(()=>loadB2bHistoryRuntimeMount(m.root)).toThrow();expect(state.created).toHaveLength(0);
 });
 it('does not use DATABASE_URL, DB_* or PGSSLMODE to override the approved TLS profile',async()=>{
  const m=mounted();vi.stubEnv('DATABASE_URL','postgresql://SYNTHETIC:ONLY@outside.invalid/other?sslmode=disable');vi.stubEnv('DB_NAME','outside');vi.stubEnv('PGSSLMODE','disable');
  const host=(await bootstrapB2bHistory({B2B_HISTORY_ENABLED:'true',B2B_HISTORY_CONFIG_ROOT:m.root}))!;hosts.push(host);
  const pg=state.created[0].adapter.config;
  expect(pg).toMatchObject({host:'history-pg.synthetic.invalid',database:'factuez_history_qa_aabbccddee',user:'history_reader_qa',password:'SYNTHETIC-READER-PASSWORD',max:4,connectionTimeoutMillis:3000,statement_timeout:10000,idleTimeoutMillis:30000,ssl:{rejectUnauthorized:true,minVersion:'TLSv1.2'},options:'-c search_path=public'});
  expect(pg.ssl.ca).toEqual(tls.ca);expect(pg).not.toHaveProperty('connectionString');
 });
 it('invalid CA or verification bypass cannot construct an adapter',()=>{
  const m=mounted(),options=loadB2bHistoryRuntimeMount(m.root).database;
  for(const ssl of [{...options.ssl,rejectUnauthorized:false},{...options.ssl,ca:Buffer.from('NOT_A_CERT')},{...options.ssl,minVersion:'TLSv1'}])expect(()=>b2bHistoryPrismaAdapter({...options,ssl} as any)).toThrow();
 });
 it('wrong actual database role or marker prevents startup and closes the host-owned connection',async()=>{
  const m=mounted();m.query.mockImplementation(async()=>[{database:m.config.database.name,role:'history_import_qa'}]);
  await expect(bootstrapB2bHistory({B2B_HISTORY_ENABLED:'true',B2B_HISTORY_CONFIG_ROOT:m.root})).rejects.toThrow('STARTUP_BLOCKED');expect(m.db.$disconnect).toHaveBeenCalledTimes(1);expect(m.db.$executeRawUnsafe).not.toHaveBeenCalled();
 });
 it('standard dist/main.js has a guarded executable entrypoint and no legacy activation',()=>{
  const source=readFileSync(new URL('../services/history-service/src/main.ts',import.meta.url),'utf8'),host=readFileSync(new URL('../services/history-service/src/b2b/main.ts',import.meta.url),'utf8');
  expect(source).toContain('require.main===module');expect(host).toContain("env.B2B_HISTORY_ENABLED!=='true'");expect(host).toContain('new PrismaClient({adapter:b2bHistoryPrismaAdapter(mounted.database)})');expect(host).not.toMatch(/DATABASE_URL|process\.env\.DB_|\.stageBatch\(|\.importNext\(/);
 });
});
