import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
import {correctionEvidenceHash as hash} from '../packages/service-access/src/b2b-correction-evidence-wire';
import {emptyCounters} from '../services/received-documents-service/src/automation/policy';
import {receptionAutomationGrantKey} from '../services/received-documents-service/src/b2b/automation-authority';
import type {ReceptionAutomationAction} from '../services/received-documents-service/src/b2b/automation';
import {fixture,scope,access,stepUpHandle,localSettings,liveSettings,id} from './helpers/b2b-received-automation.fixture';
const require=createRequire(import.meta.url),{withReceivedAutomationDatabase}=require('./helpers/b2b-received-automation-db.cjs');
let db:any,pool:any,f:ReturnType<typeof fixture>,release:()=>void,completed:Promise<void>,initial:any,sequence=0;
const second={...scope,companyId:2,recipientRuc:'00000000202',branchId:id(4)},real={...scope,companyId:3,recipientRuc:'99999999999',branchId:id(5)};
const all=['CONFIG_READ','CONFIG_SAVE','SYNC_CREATE','SYNC_READ','LIVE_READ_ONLY'] as const;
const key=()=>`synthetic_automation_${++sequence}`;
const run=(action:ReceptionAutomationAction,payload:any,s=scope,k=key(),owner=f.owner)=>owner.execute({token:access.token,kind:f.principal.kind},action,{scope:s,...(['CONFIG_SAVE','SYNC_CREATE'].includes(action)?{key:k}:{}),payload:{...payload,...(f.principal.kind==='USER'?{stepUpHandle}:{})}});
const row=(s=scope)=>db.receptionConnection.findUnique({where:{companyId:s.companyId}});
const count=async(t:string)=>Number((await pool.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n);
const stage=async(settings=localSettings(),credentials:Record<string,string>={},s=scope)=>run('CONFIG_SAVE',{expectedRevision:(await row(s))?.revision??0,settings,credentials},s);
const queue=async(source='MAIL',s=scope,k=key(),owner=f.owner)=>run('SYNC_CREATE',{source,expectedRevision:(await row(s))?.revision??0},s,k,owner);
const wrap=(hook:(sql:string,values:any[])=>void|Promise<void>)=>({$transaction:(work:any,options:any)=>db.$transaction((tx:any)=>work({$queryRawUnsafe:tx.$queryRawUnsafe.bind(tx),$executeRawUnsafe:async(sql:string,...values:any[])=>{const n=await tx.$executeRawUnsafe(sql,...values);await hook(sql,values);return n;}}),options)});
beforeAll(async()=>{
 vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('OFFICIAL_NETWORK_FORBIDDEN');}));
 let ready!:()=>void,failed!:(e:unknown)=>void;const initialized=new Promise<void>((a,b)=>{ready=a;failed=b;}),finished=new Promise<void>(r=>{release=r;});
 completed=withReceivedAutomationDatabase(async context=>{
  db=context.client;pool=context.pool;f=fixture(db);initial=structuredClone(f.principal);
  try{for(const s of [scope,second,real])for(const action of all)await f.grant(action,s);ready();await finished;}catch(e){failed(e);throw e;}
 });void completed.catch(failed);await initialized;
},120000);
afterAll(async()=>{release?.();await completed;expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();},120000);
beforeEach(()=>{Object.assign(f.principal,structuredClone(initial));Object.assign(f.control,{identityCalls:0,adminCalls:0,enrollmentCalls:0,revoked:false,global:true,adminRevision:1,adminHook:null,identityHook:null,enrollmentHook:null});});
describe('B2B08 automation real SQL on NEW isolated network-none tmpfs PG',()=>{
 it('CONFIG_READ absent configuration uses real disabled defaults without creating it',async()=>{
  const r=await run('CONFIG_READ',{});expect(r).toMatchObject({revision:0,state:'DISABLED',runtimeEnabled:false,networkProfile:'LOCAL_ONLY',credentialPresence:{mailPassword:false,sireClientSecret:false,solPassword:false}});expect(await row()).toBeNull();
 });
 it('CONFIG_SAVE persists exact settings, legitimate USER configuredBy, cipher and atomic append-only audit; save never activates runtime',async()=>{
  const credentials={mailPassword:'FAKE-MAIL-SECRET',sireClientSecret:'FAKE-OAUTH-SECRET',solPassword:'FAKE-SOL-SECRET'},r=await stage(localSettings(),credentials),stored=await row();
  expect(r).toMatchObject({revision:1,state:'STAGED_LOCAL',runtimeEnabled:false,credentialPresence:{mailPassword:true,sireClientSecret:true,solPassword:true}});
  expect(stored).toMatchObject({configuredBy:f.principal.subjectId,enabled:false,revision:1,settings:localSettings()});
  expect(await f.vault.open(stored.encryptedCredentials,{companyId:1,ruc:scope.recipientRuc,revision:1})).toEqual(credentials);
  for(const secret of Object.values(credentials))expect(JSON.stringify(r)).not.toContain(secret);expect(JSON.stringify(r)).not.toContain(stored.encryptedCredentials);
  const audit=await db.receptionConnectionAudit.findFirstOrThrow({where:{companyId:1},orderBy:{revision:'desc'}});expect(audit).toMatchObject({actorId:f.principal.subjectId,revision:1,action:'CONFIGURATION_SAVED'});expect(JSON.stringify(audit.detail)).not.toContain('SECRET');
  expect(await count('ReceptionSyncRun')).toBe(0);
 });
 it('preserves secrets on empty replacement and clears them when connector identities change, then reseals for the new revision',async()=>{
  const before=await stage(localSettings(),{mailPassword:'FAKE-MAIL',sireClientSecret:'FAKE-CLIENT',solPassword:'FAKE-SOL'}),old=await row();
  const r=await stage(localSettings(),{mailPassword:''});expect(r.credentialPresence).toEqual({mailPassword:true,sireClientSecret:true,solPassword:true});
  const changed=localSettings();changed.mailbox.username='OTHER';changed.sire.clientId='OTHER';changed.sire.solUsername='OTHER';
  const cleared=await stage(changed);expect(cleared.credentialPresence).toEqual({mailPassword:false,sireClientSecret:false,solPassword:false});expect((await row()).encryptedCredentials).toBeNull();
  expect(()=>f.vault.open(old.encryptedCredentials,{companyId:1,ruc:scope.recipientRuc,revision:before.revision+1})).toThrow('RECEIVED_VAULT_UNAVAILABLE');
 });
 it('CONFIG_SAVE has durable idempotency, conflict detection and optimistic revision CAS',async()=>{
  const revision=(await row()).revision,payload={expectedRevision:revision,settings:localSettings(),credentials:{mailPassword:'FAKE-IDEMPOTENT'}},k=key();
  const r=await run('CONFIG_SAVE',payload,scope,k),countBefore=await count('ReceptionConnectionAudit');expect(await run('CONFIG_SAVE',payload,scope,k)).toEqual(r);expect(await count('ReceptionConnectionAudit')).toBe(countBefore);
  await expect(run('CONFIG_SAVE',{...payload,credentials:{mailPassword:'DIFFERENT'}},scope,k)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  await expect(run('CONFIG_SAVE',payload)).rejects.toMatchObject({code:'RECEIVED_AUTOMATION_REVISION_CONFLICT'});
 });
 it('concurrent stale configuration CAS has one winner with no unaudited revision',async()=>{
  const payload={expectedRevision:(await row()).revision,settings:localSettings()};const results=await Promise.allSettled([run('CONFIG_SAVE',payload),run('CONFIG_SAVE',payload)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);const failed=results.find(r=>r.status==='rejected') as PromiseRejectedResult;expect(failed.reason).toMatchObject({status:409});
 });
 it('requires independent owner grant, exact Identity tuple and global live USER step-up',async()=>{
  f.principal.clientId=id(20);await expect(run('CONFIG_READ',{})).rejects.toMatchObject({status:403});Object.assign(f.principal,initial);
  f.control.global=false;await expect(run('CONFIG_READ',{})).rejects.toMatchObject({code:'RECEIVED_GLOBAL_ADMIN_REQUIRED'});f.control.global=true;
  await expect(run('CONFIG_READ',{}, {...scope,recipientRuc:'00000000999'})).rejects.toMatchObject({status:404});
  const wrongAdmin={authorize:async(...args:any[])=>({...await (f.administrator.authorize as any)(...args),scope:second})};
  await expect(run('CONFIG_READ',{},scope,key(),f.alternate(db,{userAdministrator:wrongAdmin}))).rejects.toMatchObject({status:403});
 });
 it('mid-transaction step-up change rolls configuration and both audits back',async()=>{
  const before=await row(),auditBefore=await count('ReceptionConnectionAudit');f.control.adminHook=n=>{if(n===3)f.control.adminRevision=2;};
  await expect(stage()).rejects.toMatchObject({status:403});expect(await row()).toEqual(before);expect(await count('ReceptionConnectionAudit')).toBe(auditBefore);
 });
 it('persistent CONFIG_SAVE revocation inside transaction rolls configuration back',async()=>{
  f.principal.clientId=id(21);await f.grant('CONFIG_SAVE');const before=await row();let changed=false;
  const owner=f.alternate(wrap(async sql=>{if(!changed&&sql.includes('UPDATE "ReceptionConnection" SET')){changed=true;await f.grant('CONFIG_SAVE',scope,1,false);}}));
  await expect(run('CONFIG_SAVE',{expectedRevision:before.revision,settings:localSettings()},scope,key(),owner)).rejects.toMatchObject({status:403});expect(await row()).toEqual(before);
 });
 it('vault failure and failure after audit insert roll every write back with finite errors',async()=>{
  const before=await row(),owner=f.alternate(db,{vault:{...f.vault,seal:()=>{throw new Error('PRIVATE_VAULT_SECRET');}}});
  await expect(run('CONFIG_SAVE',{expectedRevision:before.revision,settings:localSettings(),credentials:{mailPassword:'FAKE'}},scope,key(),owner)).rejects.toMatchObject({code:'RECEIVED_VAULT_UNAVAILABLE'});expect(await row()).toEqual(before);
  const broken=f.alternate(wrap(sql=>{if(sql.includes('INSERT INTO "B2bReceivedAutomationAudit"'))throw new Error('PRIVATE_SQL_SECRET');}));
  await expect(run('CONFIG_SAVE',{expectedRevision:before.revision,settings:localSettings()},scope,key(),broken)).rejects.toMatchObject({status:503,code:'RECEIVED_AUTOMATION_UNAVAILABLE'});expect(await row()).toEqual(before);
 });
 it('SYNC_CREATE persists real MAIL/SIRE rows and actor membership before any queue dispatch; replay returns the same IDs',async()=>{
  const staged=await stage(),k=key(),r=await queue('ALL',scope,k);expect(r.items).toHaveLength(2);expect(r.items.every((x:any)=>x.status==='QUEUED'&&x.dispatch==='NOT_DISPATCHED')).toBe(true);
  expect(await queue('ALL',scope,k)).toEqual(r);
  for(const item of r.items){const stored=await db.receptionSyncRun.findUniqueOrThrow({where:{id:item.runId}});expect(stored).toMatchObject({companyId:1,recipientRuc:scope.recipientRuc,revision:staged.revision,status:'QUEUED',counters:emptyCounters()});}
  await expect(queue('MAIL')).rejects.toMatchObject({code:'RECEIVED_AUTOMATION_SYNC_ACTIVE'});
  const status=await run('SYNC_READ',{runId:r.items[0].runId});expect(status.run).toMatchObject({status:'QUEUED',counters:emptyCounters()});expect(status).toMatchObject({runtimeEnabled:false,fiscalAcceptance:'NOT_VERIFIED'});
 });
 it('configuration revision change blocks QUEUED/RUNNING jobs and clears active keys atomically',async()=>{
  await stage();const r=await queue('ALL');await pool.query('UPDATE "ReceptionSyncRun" SET "status"=\'RUNNING\' WHERE "id"=$1',[r.items[0].runId]);
  const next=await stage();for(const item of r.items){const run=await db.receptionSyncRun.findUniqueOrThrow({where:{id:item.runId}});expect(run).toMatchObject({status:'BLOCKED',activeKey:null,errorCode:'CONFIGURATION_CHANGED'});expect(run.revision).toBe(next.revision-1);}
  await expect(run('SYNC_CREATE',{source:'MAIL',expectedRevision:next.revision-1})).rejects.toMatchObject({status:409});
 });
 it('SERVICE requires explicit SYNC grants and persists null human identity; cannot see another actor or scope run',async()=>{
  await stage();const userRun=(await queue('MAIL')).items[0].runId;await stage();f.principal.kind='SERVICE';f.principal.subjectId=null;f.principal.userAuthRevision=null;f.principal.clientId=id(22);
  await expect(queue()).rejects.toMatchObject({status:403});await f.grant('SYNC_CREATE');await f.grant('SYNC_READ');
  const serviceRun=(await queue()).items[0].runId;expect((await run('SYNC_READ',{runId:serviceRun})).run.runId).toBe(serviceRun);
  await expect(run('SYNC_READ',{runId:userRun})).rejects.toMatchObject({status:404});
  await expect(run('SYNC_READ',{runId:serviceRun},second)).rejects.toMatchObject({status:403});
  const audit=(await pool.query('SELECT "subjectId","userAuthRevision","adminStamp" FROM "B2bReceivedAutomationAudit" WHERE "clientId"=$1',[id(22)])).rows;expect(audit.length).toBeGreaterThan(0);expect(audit.every((x:any)=>x.subjectId===null&&x.userAuthRevision===null&&x.adminStamp===null)).toBe(true);
  Object.assign(f.principal,initial);await expect(run('SYNC_READ',{runId:serviceRun})).rejects.toMatchObject({status:404});
 });
 it('default LOCAL_ONLY rejects live synchronization and LOCAL_FIXTURE on a real RUC',async()=>{
  await expect(stage(localSettings(),{},real)).rejects.toMatchObject({status:400});
  const r=await stage(liveSettings(),{mailPassword:'FAKE',sireClientSecret:'FAKE',solPassword:'FAKE'},real);expect(r.state).toBe('WAITING_TI');
  await expect(queue('ALL',real)).rejects.toMatchObject({code:'RECEIVED_AUTOMATION_NETWORK_DENIED'});expect((await row(real)).enabled).toBe(false);
 });
 it('LIVE_READ_ONLY needs separate policy, explicit profile, TI host approval and credentials; it only creates undispatched durable metadata',async()=>{
  const owner=f.alternate(db,{networkProfile:'LIVE_READ_ONLY',approvedImapHosts:['imap.example.com']});
  const wrongHost=f.alternate(db,{networkProfile:'LIVE_READ_ONLY',approvedImapHosts:['other.example.com']});
  await expect(queue('ALL',real,key(),wrongHost)).rejects.toMatchObject({code:'RECEIVED_AUTOMATION_NETWORK_DENIED'});
  f.principal.clientId=id(23);await f.grant('SYNC_CREATE',real);await expect(queue('ALL',real,key(),owner)).rejects.toMatchObject({status:403});await f.grant('LIVE_READ_ONLY',real);
  const k=key(),r=await queue('ALL',real,k,owner);expect(r).toMatchObject({mode:'LIVE_READ_ONLY',networkProfile:'LIVE_READ_ONLY',runtimeEnabled:false});expect(r.items).toHaveLength(2);
  await f.grant('LIVE_READ_ONLY',real,1,false);await expect(queue('ALL',real,k,owner)).rejects.toMatchObject({status:403});expect((await row(real)).enabled).toBe(false);
 });
 it('local fixture switch must be explicit; disabled source and disabled settings deny job creation',async()=>{
  await stage();await expect(queue('MAIL',scope,key(),f.alternate(db,{localFixtureEnabled:false}))).rejects.toMatchObject({status:403});
  const settings=localSettings();settings.mailbox.enabled=false;await stage(settings);await expect(queue('MAIL')).rejects.toMatchObject({code:'RECEIVED_AUTOMATION_SOURCE_DISABLED'});
  settings.enabled=false;await stage(settings);await expect(queue('SIRE')).rejects.toMatchObject({status:403});
 });
 it('SYNC creation rolls back run and actor membership if Identity revokes after the audit INSERT',async()=>{
  await stage();const before=await count('ReceptionSyncRun'),members=await count('B2bReceivedAutomationRun');
  const owner=f.alternate(wrap(sql=>{if(sql.includes('INSERT INTO "B2bReceivedAutomationAudit"'))f.control.revoked=true;}));
  await expect(queue('ALL',scope,key(),owner)).rejects.toMatchObject({status:403});expect(await count('ReceptionSyncRun')).toBe(before);expect(await count('B2bReceivedAutomationRun')).toBe(members);
 });
 it('SYNC_READ returns only own run metadata, never SIRE raw records or full XML',async()=>{
  await stage();const idRun=(await queue('SIRE')).items[0].runId;
  await db.receptionSireIncident.create({data:{companyId:1,recipientRuc:scope.recipientRuc,period:'202610',ordinal:1,code:'SYNTHETIC_ONLY',recordHash:hash(key()),rawRecord:{xml:'FULL_XML_FORBIDDEN',secret:'RAW_SECRET_FORBIDDEN'},observedRunId:idRun}});
  const result=await run('SYNC_READ',{runId:idRun});expect(JSON.stringify(result)).not.toContain('FULL_XML_FORBIDDEN');expect(JSON.stringify(result)).not.toContain('RAW_SECRET_FORBIDDEN');expect(Object.keys(result.run).sort()).toEqual(['runId','source','status','revision','startedAt','finishedAt','counters','errorCode'].sort());
 });
 it('persistent enrollment CAS and step-up produce one revision and mandatory append-only policy audit',async()=>{
  const policy={...f.policy('SYNC_READ'),subject:{kind:'SERVICE',clientId:id(30),subjectId:null},userAuthRevision:null};
  await expect(f.authority.setGrant('bad-handle',policy,0)).rejects.toMatchObject({status:403});await f.authority.setGrant('synthetic-enrollment',policy,0);
  const results=await Promise.allSettled([f.authority.setGrant('synthetic-enrollment',{...policy,active:false},1),f.authority.setGrant('synthetic-enrollment',{...policy,active:false},1)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const grant=(await pool.query('SELECT * FROM "B2bReceivedAutomationGrant" WHERE "grantKey"=$1',[receptionAutomationGrantKey(scope,policy.subject,'SYNC_READ')])).rows[0];expect(grant.revision).toBe(2);
  expect((await pool.query('SELECT count(*) AS n FROM "B2bReceivedAutomationPolicyAudit" WHERE "policyId"=$1',[grant.policyId])).rows[0].n).toBe('2');
 });
 it.each(['B2bReceivedAutomationAudit','B2bReceivedAutomationCommand','B2bReceivedAutomationPolicyAudit','B2bReceivedAutomationRun','ReceptionConnectionAudit'])('%s is append-only',async table=>{
  for(const sql of [`DELETE FROM "${table}"`,`TRUNCATE "${table}"`])await expect(pool.query(sql)).rejects.toMatchObject({code:'23514'});
 });
 it('SQL denies runtime activation, stale revision updates, fake SERVICE human and unaudited policies',async()=>{
  await expect(pool.query('UPDATE "ReceptionConnection" SET "enabled"=true WHERE "companyId"=1')).rejects.toMatchObject({code:'23514'});
  const p={...f.policy('SYNC_READ'),revision:1,subject:{kind:'SERVICE',clientId:id(31),subjectId:null},userAuthRevision:null};
  await expect(pool.query('INSERT INTO "B2bReceivedAutomationGrant" ("grantKey","policyId","policy","revision") VALUES($1,$2,$3,1)',[receptionAutomationGrantKey(scope,p.subject,'SYNC_READ'),id(32),p])).rejects.toMatchObject({code:'23514'});
  await expect(pool.query('INSERT INTO "B2bReceivedAutomationCommand" ("key","requestHash","clientId","subjectId","actorKind","scope","action","result") VALUES($1,$2,$3,$4,\'SERVICE\',$5,\'SYNC_CREATE\',$6)',[hash(key()),hash('x'),id(22),id(3),scope,{scope,runtimeEnabled:false,fiscalAcceptance:'NOT_VERIFIED'}])).rejects.toMatchObject({code:'23514'});
 });
 it('concurrent SYNC_CREATE with one key converges to the same durable jobs',async()=>{
  await stage();const k=key(),before=await count('ReceptionSyncRun');
  const results=await Promise.all([queue('ALL',scope,k),queue('ALL',scope,k)]);expect(results[0]).toEqual(results[1]);expect(await count('ReceptionSyncRun')).toBe(before+2);
 });
 it('SYNC grant revocation after run INSERT rolls both jobs and ownership back',async()=>{
  await stage();f.principal.clientId=id(40);await f.grant('SYNC_CREATE');let revoked=false;const before=await count('ReceptionSyncRun');
  const owner=f.alternate(wrap(async sql=>{if(!revoked&&sql.includes('INSERT INTO "ReceptionSyncRun"')){revoked=true;await f.grant('SYNC_CREATE',scope,1,false);}}));
  await expect(queue('ALL',scope,key(),owner)).rejects.toMatchObject({status:403});expect(await count('ReceptionSyncRun')).toBe(before);
 });
 it('authorization binds client and USER auth revisions independently',async()=>{
  f.principal.revision=2;await expect(run('CONFIG_READ',{})).rejects.toMatchObject({status:403});f.principal.revision=1;
  f.principal.userAuthRevision=2;await expect(run('CONFIG_READ',{})).rejects.toMatchObject({status:403});
 });
 it('enrollment revocation after the policy audit INSERT rolls both policy and audit back',async()=>{
  const requested={...f.policy('SYNC_READ'),subject:{kind:'SERVICE',clientId:id(41),subjectId:null},userAuthRevision:null};
  const before=await count('B2bReceivedAutomationPolicyAudit');f.control.enrollmentHook=n=>{if(n===4)throw new Error('SYNTHETIC_STEP_UP_REVOKED');};
  await expect(f.authority.setGrant('synthetic-enrollment',requested,0)).rejects.toMatchObject({status:503});expect(await count('B2bReceivedAutomationPolicyAudit')).toBe(before);
  expect((await pool.query('SELECT count(*) AS n FROM "B2bReceivedAutomationGrant" WHERE "grantKey"=$1',[receptionAutomationGrantKey(scope,requested.subject,'SYNC_READ')])).rows[0].n).toBe('0');
 });
 it('never writes emission, Outbox, documents, counters or READ/WRITE command grants; no connector call is made',async()=>{
  for(const table of ['Document','OutboxEvent','SeriesCounter','CompanySettings','Branch','EmissionPoint','ReceivedDocument','ReceivedItemRecord','ReceivedArtifact','B2bReceivedCommand','B2bReceivedReadGrant','B2bReceivedWriteGrant'])expect(await count(table)).toBe(0);
  expect(fetch).not.toHaveBeenCalled();expect((await pool.query('SELECT bool_and("enabled"=false) AS staged FROM "ReceptionConnection"')).rows[0].staged).toBe(true);
 });
});

