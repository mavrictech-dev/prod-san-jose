import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {B2bEmailDeliveries,emailHash,checkedEmailDocument} from '../services/mailer-worker/src/b2b/email-deliveries';
import {B2bSecurityError} from '../services/mailer-worker/src/b2b/email-deliveries.security';
import {PostgresEmailDeliveryStore} from '../services/mailer-worker/src/b2b/email-deliveries.store';
import {NodemailerLocalEmailCapture} from '../services/mailer-worker/src/b2b/email-deliveries.capture';
import {OwnerEmailDeliveryDocumentSource} from '../services/mailer-worker/src/b2b/email-deliveries.source';
import type {B2bBinding,B2bPrincipal,EmailDeliveryJob,EmailDeliveryEvent,EmailDeliveryStore,EmailDeliveryTransaction,EmailDeliveryDocument,EmailDeliveryExecutionAuthority,EmailDeliveryCaptureMessage} from '../services/mailer-worker/src/b2b/email-deliveries.types';
const binding:B2bBinding={issuerId:1,issuerRuc:'20000000001',environment:'BETA',branchId:randomUUID(),pointId:randomUUID(),seriesId:randomUUID(),documentType:'01'};
const documentId=randomUUID(),token='synthetic-email-token';
function principal():B2bPrincipal{return {kind:'SERVICE',clientId:randomUUID(),revision:1,subjectId:null,userAuthRevision:null,
 scopes:['b2b:email:send','b2b:email:read','b2b:documents:read'],bindings:[structuredClone(binding)],environment:'BETA'};}
function doc(cdr=true):EmailDeliveryDocument {
 const proof=emailHash('synthetic-document'),parts=[['PDF','application/pdf','pdf','CURRENT_GENERATED'],['XML','application/xml','xml','IMMUTABLE_ORIGINAL'],
 ...(cdr?[['CDR','application/zip','zip','IMMUTABLE_ORIGINAL']]:[])];
 return {binding:structuredClone(binding),documentId,sourceProofSha256:proof,presentationRevision:'current-1',
 attachments:parts.map(([kind,mediaType,ext,representation])=>{const bytes=Buffer.from(kind==='PDF'?'%PDF-1.7 synthetic current':kind==='XML'?'<SyntheticOriginal/>':'PK-synthetic-cdr');
 return {kind,mediaType,fileName:'synthetic-'+kind+'.'+ext,representation,bytes,sha256:emailHash(bytes),documentId,binding:structuredClone(binding),sourceProofSha256:proof};})} as EmailDeliveryDocument;
}
/** Bounded persisted fixture: serialize at each commit, retain no shared references or tokens. */
class FixtureStore implements EmailDeliveryStore {
 disk={jobs:[] as EmailDeliveryJob[],events:[] as EmailDeliveryEvent[]};failAudit=false;closed=false;private tail:Promise<unknown>=Promise.resolve();
 transaction<T>(_locks:readonly string[],work:(tx:EmailDeliveryTransaction)=>Promise<T>):Promise<T>{
 const run=this.tail.then(async()=>{if(this.closed)throw new B2bSecurityError(503,'EMAIL_STORE_UNAVAILABLE');
 const data=structuredClone(this.disk);let active=true;const check=()=>{if(!active)throw new B2bSecurityError(503,'EMAIL_STORE_UNAVAILABLE');};
 const tx:EmailDeliveryTransaction={
 job:async id=>{check();return structuredClone(data.jobs.find(j=>j.id===id)??null);},
 prior:async(a,k)=>{check();return structuredClone(data.jobs.find(j=>j.actorKey===a&&j.keyHash===k)??null);},
 insert:async j=>{check();if(data.jobs.length>=100||data.jobs.some(x=>x.id===j.id||x.actorKey===j.actorKey&&x.keyHash===j.keyHash))throw Error('BOUND');data.jobs.push(structuredClone(j));},
 save:async(j,r)=>{check();const n=data.jobs.findIndex(x=>x.id===j.id&&x.revision===r);if(n<0)throw new B2bSecurityError(409,'EMAIL_REVISION_CONFLICT');data.jobs[n]=structuredClone(j);},
 append:async e=>{check();if(this.failAudit||data.events.length>=400)throw new B2bSecurityError(503,'EMAIL_STORE_UNAVAILABLE');data.events.push(structuredClone(e));}};
 try{const r=await work(tx);this.disk=JSON.parse(JSON.stringify(data));return r;}finally{active=false;}
 });this.tail=run.catch(()=>{});return run;}
 async close(){this.closed=true;await this.tail;}
}
function harness(store:EmailDeliveryStore=new FixtureStore(),options:{enabled?:boolean;profile?:'NONE'|'LOCAL_CAPTURE'}={enabled:true,profile:'LOCAL_CAPTURE'}){
 let p=principal(),document=doc();
 const identity={authenticate:vi.fn(async()=>structuredClone(p))},source={authorizeDocumentCurrent:vi.fn(async()=>structuredClone(document))};
 const transport={profile:'LOCAL_CAPTURE' as const,capture:vi.fn(async(_m:EmailDeliveryCaptureMessage)=>({state:'CAPTURED_LOCAL' as const}))};
 const authority:EmailDeliveryExecutionAuthority={freshIdentity:vi.fn(async()=>structuredClone(p))};
 const engine=new B2bEmailDeliveries(store,identity,source,transport,options);
 const input=()=>({binding:structuredClone(binding),documentId,recipient:'synthetic@example.invalid',format:'a4' as 'a4'|'ticket',idempotencyKey:randomUUID()});
 const access=()=>({token,kind:p.kind});
 return {store,engine,identity,source,transport,authority,input,access,get p(){return p;},set p(v){p=v;},get document(){return document;},set document(v){document=v;},
 create:(q=input())=>engine.execute(access(),'CREATE',q),read:(id:string)=>engine.execute(access(),'READ',{id})};
}
describe('B2B email worker persisted fixture',()=>{
 it('is disabled by default; enabled profile NONE cannot capture',async()=>{
 const h=harness(undefined,{});await expect(h.create()).rejects.toMatchObject({code:'EMAIL_DISABLED'});expect(h.identity.authenticate).not.toHaveBeenCalled();
 const n=harness(undefined,{enabled:true}),j=await n.create();expect(j.profile).toBe('NONE');
 await expect(n.engine.run(j.id,n.authority)).rejects.toMatchObject({code:'EMAIL_CAPTURE_DISABLED'});expect(n.transport.capture).not.toHaveBeenCalled();
 });
 it('persists before capture, journals a service with no human and replays the same job',async()=>{
 const store=new FixtureStore(),h=harness(store),q=h.input(),j=await h.create(q);
 expect(store.disk.jobs[0]).toMatchObject({actor:{kind:'SERVICE',subjectId:null,userAuthRevision:null},state:'QUEUED'});
 expect(JSON.stringify(store.disk)).not.toContain(token);expect(h.transport.capture).not.toHaveBeenCalled();
 expect(await h.create(q)).toMatchObject({id:j.id,replayed:true});expect(await h.read(j.id)).toMatchObject({id:j.id});
 h.transport.capture.mockImplementation(async()=>{expect(store.disk.jobs[0].state).toBe('DISPATCHING');expect(store.disk.events.at(-1)?.type).toBe('ATTEMPT_STARTED');return {state:'CAPTURED_LOCAL'};});
 expect(await h.engine.run(j.id,h.authority)).toMatchObject({state:'CAPTURED_LOCAL',deliveredToClient:false,fiscalAuthority:false});
 await h.engine.run(j.id,h.authority);expect(h.transport.capture).toHaveBeenCalledTimes(1);
 expect(store.disk.events.map(e=>e.type)).toEqual(['CREATED','ATTEMPT_STARTED','CAPTURED_LOCAL']);
 expect(JSON.stringify(await h.read(j.id))).not.toContain(q.recipient);
 });
 it('restarts with saved inputs and recovers missing CDR without another key',async()=>{
 const store=new FixtureStore(),h=harness(store);h.document=doc(false);const q=h.input(),j=await h.create(q);
 expect(j).toMatchObject({state:'WAITING_ARTIFACTS',errorCode:'ARTIFACTS_PENDING'});
 expect(await h.engine.run(j.id,h.authority)).toMatchObject({state:'WAITING_ARTIFACTS'});expect(h.transport.capture).not.toHaveBeenCalled();
 const restart=new B2bEmailDeliveries(store,h.identity,{authorizeDocumentCurrent:async()=>doc()},h.transport,{enabled:true,profile:'LOCAL_CAPTURE'});
 expect(await restart.run(j.id,h.authority)).toMatchObject({id:j.id,state:'CAPTURED_LOCAL'});
 h.document=doc();expect(await h.create(q)).toMatchObject({id:j.id,replayed:true,state:'CAPTURED_LOCAL'});expect(store.disk.jobs).toHaveLength(1);
 });
 it('ambiguous capture becomes UNKNOWN and is never automatically retried',async()=>{
 const h=harness(),j=await h.create();h.transport.capture.mockRejectedValue(Error('private password recipient@invalid'));
 expect(await h.engine.run(j.id,h.authority)).toMatchObject({state:'UNKNOWN',errorCode:'CAPTURE_OUTCOME_UNKNOWN'});
 await h.engine.run(j.id,h.authority);expect(h.transport.capture).toHaveBeenCalledTimes(1);
 expect(JSON.stringify((h.store as FixtureStore).disk.events)).not.toContain('password');
 });
 it('crash after capture and before final audit leaves a durable ambiguous attempt',async()=>{
 const store=new FixtureStore(),h=harness(store),j=await h.create();
 h.transport.capture.mockImplementation(async()=>{store.failAudit=true;return {state:'CAPTURED_LOCAL'};});
 await expect(h.engine.run(j.id,h.authority)).rejects.toMatchObject({code:'EMAIL_STORE_UNAVAILABLE'});
 expect(store.disk.jobs[0].state).toBe('DISPATCHING');store.failAudit=false;
 expect(await h.engine.run(j.id,h.authority)).toMatchObject({state:'UNKNOWN'});expect(h.transport.capture).toHaveBeenCalledTimes(1);
 });
 it('audit failure atomically rolls back creation and permits the same idempotency key',async()=>{
 const store=new FixtureStore(),h=harness(store),q=h.input();store.failAudit=true;
 await expect(h.create(q)).rejects.toMatchObject({code:'EMAIL_STORE_UNAVAILABLE'});expect(store.disk.jobs).toHaveLength(0);
 store.failAudit=false;expect(await h.create(q)).toMatchObject({replayed:false});
 });
 it('serializes idempotency and conflicts on changed recipient, format or full binding',async()=>{
 const store=new FixtureStore(),h=harness(store),q=h.input(),r=await Promise.all([h.create(q),h.create(q)]);
 expect(r[0].id).toBe(r[1].id);expect(store.disk.jobs).toHaveLength(1);
 await expect(h.create({...q,recipient:'other@example.invalid'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 await expect(h.create({...q,format:'ticket'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 const other={...binding,seriesId:randomUUID()};h.p.bindings.push(other);
 await expect(h.create({...q,binding:other})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 });
 it.each(['b2b:email:send','b2b:documents:read'])('requires CREATE scope %s',async s=>{
 const h=harness();h.p.scopes=h.p.scopes.filter(x=>x!==s);await expect(h.create()).rejects.toMatchObject({status:401,code:'INVALID_PRINCIPAL'});
 });
 it('requires email READ scope and isolates client and human subject',async()=>{
 const h=harness(),j=await h.create();h.p.scopes=h.p.scopes.filter(x=>x!=='b2b:email:read');
 await expect(h.read(j.id)).rejects.toMatchObject({code:'INVALID_PRINCIPAL'});h.p.scopes.push('b2b:email:read');h.p.clientId=randomUUID();
 await expect(h.read(j.id)).rejects.toMatchObject({code:'RESOURCE_NOT_FOUND'});
 const u=harness();u.p={...u.p,kind:'USER',subjectId:randomUUID(),userAuthRevision:4};const a=await u.create();u.p.subjectId=randomUUID();
 await expect(u.read(a.id)).rejects.toMatchObject({code:'RESOURCE_NOT_FOUND'});
 });
 it.each(['issuerRuc','branchId','pointId','seriesId','documentType'])('matches full binding %s',async key=>{
 const h=harness(),q=h.input();(q.binding as any)[key]=key==='documentType'?'03':key==='issuerRuc'?'20000000002':randomUUID();
 await expect(h.create(q)).rejects.toMatchObject({code:'RESOURCE_NOT_FOUND'});
 });
 it.each(['revision','userAuthRevision','bindings','scopes'])('revalidates live %s before dispatch',async key=>{
 const h=harness();h.p={...h.p,kind:'USER',subjectId:randomUUID(),userAuthRevision:3};const j=await h.create();
 if(key==='revision')h.p.revision++;if(key==='userAuthRevision')h.p.userAuthRevision=h.p.userAuthRevision!+1;
 if(key==='bindings')h.p.bindings=[{...binding,pointId:randomUUID()}];if(key==='scopes')h.p.scopes=['b2b:documents:read'];
 await expect(h.engine.run(j.id,h.authority)).rejects.toMatchObject({status:key==='bindings'?404:401});expect(h.transport.capture).not.toHaveBeenCalled();
 });
 it('checks revocation after claim and before capture',async()=>{
 const h=harness(),j=await h.create();let calls=0;
 vi.mocked(h.authority.freshIdentity).mockImplementation(async()=>{if(++calls===4)throw new B2bSecurityError(401,'INVALID_PRINCIPAL');return structuredClone(h.p);});
 expect(await h.engine.run(j.id,h.authority)).toMatchObject({state:'UNKNOWN'});expect(h.transport.capture).not.toHaveBeenCalled();
 });
 it('freezes caller inputs and detects changing identity within the request',async()=>{
 const h=harness(),q=h.input();h.identity.authenticate.mockImplementation(async()=>{q.recipient='changed@example.invalid';return structuredClone(h.p);});
 const j=await h.create(q);expect((h.store as FixtureStore).disk.jobs[0].recipient).toBe('synthetic@example.invalid');
 h.identity.authenticate.mockImplementation(async()=>{h.p.revision++;return structuredClone(h.p);});
 await expect(h.read(j.id)).rejects.toMatchObject({code:'ACCESS_CHANGED'});
 });
 it.each([15,101])('rejects idempotency length %s',async n=>{
 const h=harness();await expect(h.create({...h.input(),idempotencyKey:'x'.repeat(n)})).rejects.toMatchObject({code:'INVALID_REQUEST'});
 });
 it.each(['a@example.invalid\r\nBcc: x@example.invalid','a@example.invalid,b@example.invalid','Name <a@example.invalid>','a..b@example.invalid'])('rejects recipient injection %s',async recipient=>{
 const h=harness();await expect(h.create({...h.input(),recipient})).rejects.toMatchObject({code:'INVALID_REQUEST'});
 });
 it('bounds attachments and verifies original hashes ownership and a common document proof',()=>{
 const j={binding,documentId},d=doc(),bytes=Buffer.from(d.attachments[1].bytes),checked=checkedEmailDocument(d,j);
 checked.attachments[1].bytes[0]=0;expect(d.attachments[1].bytes).toEqual(bytes);
 for(const change of [(x:any)=>x.attachments[1].sha256='0'.repeat(64),(x:any)=>x.attachments[1].binding.pointId=randomUUID(),
 (x:any)=>x.attachments[2].sourceProofSha256='1'.repeat(64),(x:any)=>x.attachments[0].fileName='../escape.pdf',
 (x:any)=>x.attachments.push(x.attachments[0]),(x:any)=>x.attachments[0].bytes=Buffer.alloc(10*1024*1024+1)]){
 const bad=structuredClone(d);change(bad);expect(()=>checkedEmailDocument(bad,j)).toThrow('EMAIL_ARTIFACT_INTEGRITY');}
 });
 it('rechecks current presentation immediately before capture',async()=>{
 const h=harness(),j=await h.create();let calls=0;h.source.authorizeDocumentCurrent.mockImplementation(async()=>{
 const d=doc();if(++calls>=2)(d as any).presentationRevision='current-2';return d;});
 expect(await h.engine.run(j.id,h.authority)).toMatchObject({state:'UNKNOWN'});expect(h.transport.capture).not.toHaveBeenCalled();
 });
 it('redacts arbitrary owner errors',async()=>{
 const h=harness();h.source.authorizeDocumentCurrent.mockRejectedValue(Error('private credentials customer@example.invalid'));
 await expect(h.create()).rejects.toMatchObject({message:'EMAIL_OWNER_UNAVAILABLE'});
 });
 it('source combines actual current PDF with unchanged owner originals; absent CDR remains absent',async()=>{
 const d=doc(),originals=d.attachments.filter(a=>a.kind!=='PDF'),proof={binding,documentId,sourceProofSha256:d.sourceProofSha256,presentationRevision:'current-1',
 originals:originals.map(a=>({id:a.kind,kind:a.kind as 'XML'|'CDR',fileName:a.fileName,mediaType:a.mediaType as 'application/xml'|'application/zip',sha256:a.sha256,byteLength:a.bytes.length}))};
 const owner={authorizeDocumentCurrent:vi.fn(async()=>structuredClone(proof)),currentPdf:vi.fn(async()=>({bytes:d.attachments[0].bytes,presentationRevision:'current-1'})),
 readOriginal:vi.fn(async(_p:any,id:string)=>originals.find(a=>a.kind===id)!.bytes)};
 const source=new OwnerEmailDeliveryDocumentSource(owner),r=await source.authorizeDocumentCurrent(principal(),binding,documentId,'ticket');
 expect(r.attachments[1].bytes).toEqual(originals[0].bytes);expect(r.attachments[2].sha256).toBe(originals[1].sha256);
 expect(owner.currentPdf).toHaveBeenCalledWith(expect.objectContaining({documentId}),'ticket');
 proof.originals=proof.originals.filter(o=>o.kind!=='CDR');expect((await source.authorizeDocumentCurrent(principal(),binding,documentId,'a4')).attachments).toHaveLength(2);
 });
 it('Nodemailer builds local EML in memory without SMTP configuration or connections',async()=>{
 const captures:any[]=[],capture=new NodemailerLocalEmailCapture({writeLocalCapture:async v=>{captures.push(v);}},'LOCAL_CAPTURE'),h=harness();
 const core=new B2bEmailDeliveries(h.store,h.identity,h.source,capture,{enabled:true,profile:'LOCAL_CAPTURE'}),j=await core.execute(h.access(),'CREATE',h.input());
 expect(await core.run(j.id,h.authority)).toMatchObject({state:'CAPTURED_LOCAL'});expect(captures).toHaveLength(1);
 const eml=Buffer.from(captures[0].eml).toString();expect(eml).toMatch(/X-FactuEz-Profile: LOCAL_CAPTURE/i);
 expect(eml).toContain('filename=synthetic-XML.xml');expect(emailHash(captures[0].eml)).toBe(captures[0].sha256);
 });
});
describe('PostgreSQL lifecycle',()=>{
 it('disabled store never connects; owned store drains then ends once; escaped tx fails',async()=>{
 let finish:()=>void=()=>{},entered:()=>void=()=>{};const block=new Promise<void>(r=>finish=r),ready=new Promise<void>(r=>entered=r),sql:string[]=[];
 const db={query:vi.fn(async(s:string)=>{sql.push(s);return {rows:s.includes('SELECT version')?[{version:'factuez.b2b.email-deliveries.v1'}]:[],rowCount:0};}),release:vi.fn()};
 const pool={connect:vi.fn(async()=>db),end:vi.fn(async()=>{})},disabled=new PostgresEmailDeliveryStore(pool);
 await expect(disabled.transaction([],async()=>1)).rejects.toMatchObject({code:'EMAIL_STORE_UNAVAILABLE'});expect(pool.connect).not.toHaveBeenCalled();
 const store=new PostgresEmailDeliveryStore(pool,{enabled:true,ownsPool:true});let escaped:EmailDeliveryTransaction|undefined;
 const run=store.transaction(['z','a','a'],async tx=>{escaped=tx;entered();await block;return 1;});await ready;
 const closing=store.close();expect(pool.end).not.toHaveBeenCalled();finish();expect(await run).toBe(1);await closing;await store.close();
 expect(pool.end).toHaveBeenCalledTimes(1);await expect(escaped!.job(randomUUID())).rejects.toMatchObject({code:'EMAIL_STORE_UNAVAILABLE'});
 expect(sql.at(-1)).toBe('COMMIT');expect(db.release).toHaveBeenCalledTimes(1);
 });
 it('rolls back sanitizes PG errors and does not close a borrowed pool',async()=>{
 const sql:string[]=[],db={query:vi.fn(async(s:string)=>{sql.push(s);return {rows:s.includes('SELECT version')?[{version:'factuez.b2b.email-deliveries.v1'}]:[],rowCount:0};}),release:vi.fn()};
 const pool={connect:vi.fn(async()=>db),end:vi.fn()},store=new PostgresEmailDeliveryStore(pool,{enabled:true});
 await expect(store.transaction([],async()=>{throw Error('postgres password');})).rejects.toMatchObject({message:'EMAIL_STORE_UNAVAILABLE'});
 expect(sql.at(-1)).toBe('ROLLBACK');expect(db.release).toHaveBeenCalledOnce();await store.close();expect(pool.end).not.toHaveBeenCalled();
 });
});
describe('dedicated PostgreSQL actual worker',()=>{
 it('persists restart races audit rollback immutable guards and ambiguous attempts in NEW PostgreSQL',async()=>{
 const {withEmailDatabase}=createRequire(import.meta.url)('./b2b-email-deliveries-db.runner.cjs');
 await withEmailDatabase(async({pool,secondPool,sql}:any)=>{
 const store=new PostgresEmailDeliveryStore(pool,{enabled:true}),second=new PostgresEmailDeliveryStore(secondPool,{enabled:true}),h=harness(store),q=h.input();
 const other=new B2bEmailDeliveries(second,h.identity,h.source,h.transport,{enabled:true,profile:'LOCAL_CAPTURE'});
 const [one,two]=await Promise.all([h.create(q),other.execute(h.access(),'CREATE',q)]);expect(one.id).toBe(two.id);
 expect((await pool.query('SELECT count(*)::int AS count FROM "B2bEmailDeliveryJob"')).rows[0].count).toBe(1);
 const seen=h.transport.capture;seen.mockImplementation(async()=>{expect((await secondPool.query('SELECT state FROM "B2bEmailDeliveryJob" WHERE id=$1',[one.id])).rows[0].state).toBe('DISPATCHING');return {state:'CAPTURED_LOCAL'};});
 expect(await other.run(one.id,h.authority)).toMatchObject({state:'CAPTURED_LOCAL'});expect(await h.read(one.id)).toMatchObject({state:'CAPTURED_LOCAL'});
 await h.engine.run(one.id,h.authority);expect(seen).toHaveBeenCalledTimes(1);
 await expect(pool.query('UPDATE "B2bEmailDeliveryJob" SET payload=jsonb_set(payload,\'{recipient}\',\'"changed@example.invalid"\') WHERE id=$1',[one.id])).rejects.toThrow();
 await expect(pool.query('DELETE FROM "B2bEmailDeliveryEvent" WHERE job_id=$1',[one.id])).rejects.toThrow();
 sql(`CREATE FUNCTION email_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END $$;
 CREATE TRIGGER email_test_fail BEFORE INSERT ON "B2bEmailDeliveryEvent" FOR EACH ROW EXECUTE FUNCTION email_test_fail_audit();`);
 const retry=h.input();await expect(h.create(retry)).rejects.toMatchObject({code:'EMAIL_STORE_UNAVAILABLE'});
 expect((await pool.query('SELECT count(*)::int AS count FROM "B2bEmailDeliveryJob"')).rows[0].count).toBe(1);
 sql('DROP TRIGGER email_test_fail ON "B2bEmailDeliveryEvent";');
 const r=await h.create(retry);seen.mockRejectedValue(Error('ambiguous private detail'));
 expect(await h.engine.run(r.id,h.authority)).toMatchObject({state:'UNKNOWN'});await other.run(r.id,h.authority);expect(seen).toHaveBeenCalledTimes(2);
 h.document=doc(false);const waiting=await h.create();expect(waiting.state).toBe('WAITING_ARTIFACTS');h.document=doc();
 seen.mockResolvedValue({state:'CAPTURED_LOCAL'});expect(await other.run(waiting.id,h.authority)).toMatchObject({state:'CAPTURED_LOCAL'});
 
   // Two live workers race the same durable claim. Recovery is conservative and never captures twice.
   const raced=await h.create();let entered:()=>void=()=>{},release:()=>void=()=>{};
   const started=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
   seen.mockImplementation(async()=>{entered();await blocked;return {state:'CAPTURED_LOCAL'};});
   const running=h.engine.run(raced.id,h.authority);await started;
   expect(await other.run(raced.id,h.authority)).toMatchObject({state:'UNKNOWN'});release();
   expect(await running).toMatchObject({state:'UNKNOWN'});
   const attempts=await pool.query('SELECT count(*)::int AS count FROM "B2bEmailDeliveryEvent" WHERE job_id=$1 AND event_type=\'ATTEMPT_STARTED\'',[raced.id]);
   expect(attempts.rows[0].count).toBe(1);

const rows=(await pool.query('SELECT payload FROM "B2bEmailDeliveryJob"')).rows;expect(JSON.stringify(rows)).not.toContain(token);
 expect(rows.every((r:any)=>r.payload.actor.subjectId===null)).toBe(true);
 expect(JSON.stringify((await pool.query('SELECT payload FROM "B2bEmailDeliveryEvent"')).rows)).not.toContain(q.recipient);
 await store.close();await second.close();
 });
 },60000);
});

