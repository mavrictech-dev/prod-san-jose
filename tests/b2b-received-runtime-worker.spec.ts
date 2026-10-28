import {describe,it,expect,vi,afterEach} from 'vitest';
import {randomUUID} from 'node:crypto';
import {ReceptionWorkerScheduler,receptionWorkerCloseOnce} from '../services/received-documents-service/src/b2b/runtime-worker-lifecycle';
import {B2bReceivedProducerGate,startB2bReceivedReadOnlyWorker} from '../services/received-documents-service/src/b2b/runtime-read-only';
import {defaultReceptionSettings} from '../services/received-documents-service/src/automation/policy';
import {b2bReceivedRuntimeSchemaChecks,b2bReceivedReadOnlySchemaChecks} from '../services/received-documents-service/src/b2b/runtime-schema';
import * as queueModule from '../services/received-documents-service/src/b2b/automation-dispatch-queue';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
afterEach(()=>{vi.restoreAllMocks();});
function setup(){
 const settings=defaultReceptionSettings();settings.enabled=true;settings.mailbox.enabled=true;settings.mode='LOCAL_FIXTURE';
 const connection={companyId:1,recipientRuc:'00000000101',revision:1,settings};
 const db:any={receptionConnection:{findMany:vi.fn(async()=>[connection])},receptionSyncRun:{findFirst:vi.fn(async()=>null),findMany:vi.fn(async()=>[{id:randomUUID()},{id:randomUUID()}])}};
 const enqueue=vi.fn(async(_id:string)=>{}),createRun=vi.fn(async()=>({}));
 const scheduler=new ReceptionWorkerScheduler({database:db,enqueue,createRun:createRun as any,allowLocalFixture:()=>true,allowLiveRead:()=>false});
 const order:string[]=[],closed=Object.fromEntries(['Worker','Queue','Live','Health','Database'].map(name=>['close'+name,vi.fn(async()=>{order.push(name);})]));
 const stop=receptionWorkerCloseOnce({scheduler,...closed} as any);return {db,scheduler,enqueue,createRun,order,closed,stop};
}
describe('Received worker lifecycle: real scheduler fences late SQL/enqueues',()=>{
 it('waits an in-flight createSyncRun before closing any resource and skips later writes',async()=>{
  const f=setup(),entered=deferred(),release=deferred();f.createRun.mockImplementation(async()=>{entered.resolve();await release.promise;return {};});
  const tick=f.scheduler.tick();await entered.promise;let finished=false;const closing=f.stop().then(()=>{finished=true;});
  await Promise.resolve();expect(finished).toBe(false);expect(f.order).toEqual([]);release.resolve();await tick;await closing;
  expect(f.createRun).toHaveBeenCalledTimes(1);expect(f.db.receptionSyncRun.findMany).not.toHaveBeenCalled();expect(f.enqueue).not.toHaveBeenCalled();expect(f.order).toEqual(['Worker','Queue','Live','Health','Database']);
  expect(f.stop()).toBe(f.stop());await f.scheduler.tick();expect(f.createRun).toHaveBeenCalledTimes(1);
 });
 it('a stop during a SELECT never starts the subsequent write',async()=>{
  const f=setup(),entered=deferred(),release=deferred();f.db.receptionSyncRun.findFirst.mockImplementation(async()=>{entered.resolve();await release.promise;return null;});
  const tick=f.scheduler.tick();await entered.promise;const closing=f.stop();release.resolve();await tick;await closing;expect(f.createRun).not.toHaveBeenCalled();expect(f.enqueue).not.toHaveBeenCalled();
 });
 it('waits an already started enqueue and prevents a second enqueue after pause',async()=>{
  const f=setup(),entered=deferred(),release=deferred();f.db.receptionConnection.findMany.mockResolvedValue([]);f.enqueue.mockImplementation(async()=>{entered.resolve();await release.promise;});
  const tick=f.scheduler.tick();await entered.promise;const closing=f.stop();expect(f.order).toEqual([]);release.resolve();await tick;await closing;expect(f.enqueue).toHaveBeenCalledTimes(1);
 });
 it('deduplicates ticks and excludes all B2B run keys from the legacy scheduler',async()=>{
  const f=setup(),entered=deferred(),release=deferred();f.db.receptionConnection.findMany.mockImplementation(async()=>{entered.resolve();await release.promise;return [];});
  const a=f.scheduler.tick(),b=f.scheduler.tick();expect(a).toBe(b);await entered.promise;release.resolve();await a;
  expect(f.db.receptionSyncRun.findMany.mock.calls[0][0].where.NOT).toEqual({activeKey:{startsWith:'b2b/'}});expect(f.scheduler.lastTick).toBeGreaterThan(0);await f.stop();
 });
 it('worker close failure never falls through to pool close or a second concurrent close',async()=>{
  const f=setup();f.closed.closeWorker.mockRejectedValue(Error('FIXTURE_FAILURE'));const a=f.stop(),b=f.stop();expect(a).toBe(b);await expect(a).rejects.toThrow();expect(f.closed.closeDatabase).not.toHaveBeenCalled();
 });
 it('explicit scheduler start installs only one timer and pause makes it terminal',async()=>{
  const f=setup();f.db.receptionConnection.findMany.mockResolvedValue([]);await f.scheduler.start(1000);await expect(f.scheduler.start(1000)).rejects.toThrow();await f.stop();await expect(f.scheduler.start(1000)).rejects.toThrow();
 });
});
describe('Received approved read-only composition, with a synthetic queue transport only',()=>{
 it('disabled/invalid approval does not inspect private resources or start OAuth/Redis',async()=>{
  const poison=new Proxy({},{get(){throw Error('PRIVATE_DEPENDENCY_ACCESSED');}});
  expect(await startB2bReceivedReadOnlyWorker(poison as any)).toBeNull();
  await expect(startB2bReceivedReadOnlyWorker(poison as any,{enabled:true,approvedForReadOnlyBeta:false,approvalReference:'TI-unit'})).rejects.toThrow('APPROVAL_REQUIRED');
 });
 it('pauses pending producers without losing in-flight work or allowing a future add',async()=>{
  const gate=new B2bReceivedProducerGate(),release=deferred(),entered=deferred(),add=vi.fn();
  const pending=gate.run(async()=>{entered.resolve();await release.promise;return ['run'];},()=>[] as string[]);await entered.promise;
  let paused=false;const stop=gate.pause().then(()=>{paused=true;});await Promise.resolve();expect(paused).toBe(false);release.resolve();expect(await pending).toEqual([]);await stop;
  expect(await gate.run(async()=>{add();return true;},()=>false)).toBe(false);expect(add).not.toHaveBeenCalled();
 });
 it('composes existing service-token, source and owner classes without OAuth at construction',async()=>{
  const tls=b2bCertificates(),credentialRead=vi.fn(async()=>{throw Error('OAUTH_CREDENTIALS_MUST_STAY_UNREAD');});
  const all=[...b2bReceivedRuntimeSchemaChecks,...b2bReceivedReadOnlySchemaChecks];
  const query=vi.fn(async(sql:string)=>{if(all.includes(sql))return [];if(sql.startsWith('SELECT a."runId" FROM "B2bReceivedAutomationRun"'))return [];throw Error('UNEXPECTED_QUERY');});
  const db:any={$transaction:async(work:any)=>work({$queryRawUnsafe:query})};
  let ports:queueModule.B2bReceivedDispatchPorts|undefined,options:queueModule.B2bReceivedDispatchOptions|undefined;
  const close=vi.fn(async()=>{});
  vi.spyOn(queueModule,'createB2bReceivedDispatchQueue').mockImplementation(async(_connection,p,o)=>{ports=p;options=o;return {enabled:true,enqueue:async()=>false,poll:async()=>{},close};});
  const d:any={database:db,identity:{authenticate:vi.fn(async()=>{throw Error('IDENTITY_MUST_STAY_UNREAD');})},automationAuthority:{authorize:vi.fn()},writeAuthority:{authorize:vi.fn()},vault:{open:vi.fn(),seal:vi.fn()},resources:{
   connection:{host:'redis.synthetic.invalid',port:6379},bindings:[{scope:{environment:'BETA',companyId:1,recipientRuc:'00000000101',branchId:randomUUID()},connectionRevision:1,configurationSha256:'ab'.repeat(32),approvalId:randomUUID(),approvalRevision:1,sources:['SIRE'],approvedImapHosts:[]}],
   token:{origin:'https://identity.synthetic.invalid',tls:{ca:tls.ca,cert:tls.resource,key:tls.key,serverFingerprintSha256:fingerprint(tls.server)},credentials:credentialRead},
  }};
  const worker=(await startB2bReceivedReadOnlyWorker(d,{enabled:true,approvedForReadOnlyBeta:true,approvalReference:'TI-unit'}))!;
  expect(options).toMatchObject({enabled:true,profile:'LIVE_READ_ONLY'});expect(await ports!.pending(10)).toEqual([]);expect(query.mock.calls.length).toBe(all.length+1);await expect(ports!.run('invalid-id')).rejects.toThrow();
  expect(credentialRead).not.toHaveBeenCalled();expect(d.identity.authenticate).not.toHaveBeenCalled();expect(d.vault.open).not.toHaveBeenCalled();
  await worker.pauseProducers();query.mockClear();expect(await ports!.pending(10)).toEqual([]);expect(query).not.toHaveBeenCalled();await worker.close();expect(close).toHaveBeenCalledTimes(1);
 },30000);
});
