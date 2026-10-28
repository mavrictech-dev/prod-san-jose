import {describe,it,expect,vi} from 'vitest';import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {sealB2bSyntheticRecovery,openB2bSyntheticRecovery,b2bRecoveryInventorySha} from '../infra/b2b/recovery-bundle.mjs';
import {B2bReports,PostgresReportsStore} from '../services/billing-service/src/b2b/phase8-reports';
import {reportsFixture,createInput} from './b2b-phase8-reports.fixture';
import {B2bReportRetention,FixedReportRetentionPolicy} from '../services/billing-service/src/b2b/phase8-reports/retention';
import {fixture as receivedFixture,scope,access,file} from './helpers/b2b-received-commands.fixture';
import {receivedXml,receivedCdr} from './received-fixture.mjs';
import {corporateEmailFixture} from './b2b-email-deliveries-corporate.fixture';
import {PostgresEmailDeliveryStore} from '../services/mailer-worker/src/b2b/email-deliveries.store';
const require=createRequire(import.meta.url),{newRecoveryCluster,ROOT}=require('./helpers/b2b-recovery-cluster.cjs');
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const sourceSql=(path:string)=>readFileSync(resolve(ROOT,path),'utf8');
function receivedSchema(){
 const dir=resolve(ROOT,'services/received-documents-service');
 const r=spawnSync(process.execPath,[resolve(dir,'node_modules/prisma/build/index.js'),'migrate','diff','--from-empty','--to-schema','prisma/schema.prisma','--script'],{
  cwd:dir,windowsHide:true,encoding:'utf8',timeout:60000,maxBuffer:16*1024**2,
  env:{...process.env,NODE_PATH:resolve(dir,'node_modules'),DATABASE_URL:'postgresql://build:build@127.0.0.1:1/not_connected',PRISMA_HIDE_UPDATE_MESSAGE:'true'},
 });expect(r.status).toBe(0);return r.stdout;
}
function receivedClient(cluster:any){
 const local=createRequire(resolve(ROOT,'services/received-documents-service/package.json')),{PrismaPg}=local('@prisma/adapter-pg'),{PrismaClient}=local('./dist/generated/prisma/client');
 return cluster.registerClient(new PrismaClient({adapter:new PrismaPg(cluster.pool('RECEIVED'))}));
}
const profiles={BILLING:'B2B_REPORTS_V1',RECEIVED:'B2B_RECEPTION_COMMANDS_V1',MAILER:'B2B_CORPORATE_EMAIL_V1'};
describe('B2B-09 real pg_dump/restore across NEW isolated clusters, synthetic modules only',()=>{
 it('restores owner data, originals, schema/ACL/sequence evidence and replay after the source is destroyed',async()=>{
  const runId=randomUUID(),backupId=randomUUID(),key=randomBytes(32);let source:any,target:any;
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('OFFICIAL_NETWORK_FORBIDDEN');}));
  try{
   source=await newRecoveryCluster(runId,'source');
   source.sql('BILLING',sourceSql('services/billing-service/b2b-phase8-reports.candidate.sql'));
   source.sql('BILLING',sourceSql('services/billing-service/b2b-report-retention.candidate.sql'));
   source.sql('RECEIVED',receivedSchema());
   source.sql('RECEIVED',sourceSql('services/received-documents-service/b2b-received-read-schema.candidate.sql'));
   source.sql('RECEIVED',sourceSql('services/received-documents-service/b2b-received-commands.candidate.sql'));
   source.sql('MAILER',sourceSql('services/mailer-worker/src/b2b/email-deliveries.corporate-schema.candidate.sql'));
   // Construct legitimate persisted state through the existing owner engines.
   const report=reportsFixture({store:new PostgresReportsStore(source.pool('BILLING'))});
   const made=await report.reports.execute(report.auth,'CREATE',createInput),reportBytes=(await report.reports.execute(report.auth,'CONTENT',{id:made.data.id})).bytes;
   const expiredInput={...createInput,idempotencyKey:'recovery_retention_expired_01'};
   const agingReport=new B2bReports(new PostgresReportsStore(source.pool('BILLING')),report.identity,report.port,{enabled:true,now:()=>Date.now()-48*3600000});
   const expired=await agingReport.execute(report.auth,'CREATE',expiredInput);
   const retentionPolicy=new FixedReportRetentionPolicy({policyId:randomUUID(),revision:1,environment:'BETA',owner:'BILLING',profile:'REPORT_RENDERED_CONTENT_ONLY',
    issuerIds:[1],minAgeHours:24,batchSize:10,maxBytes:25165824,readerContract:'REPORT_410_V1',mode:'EXECUTE'});
   const retention=new B2bReportRetention(source.pool('BILLING'),retentionPolicy,{enabled:true}),retentionPlan=await retention.plan();
   const retentionReceipt=await retention.apply(retentionPlan.planId);expect(retentionReceipt.rows).toBe(1);await retention.close();
   const rx=receivedFixture(receivedClient(source));await rx.grant('IMPORT');await rx.grant('ATTACH');
   const xml=Buffer.from(receivedXml('01','FQA1-00000001')),cdr=Buffer.from(receivedCdr('FQA1-00000001'));
   const receptionInput={scope,key:'b2b9_recovery_import_001',payload:file(xml,'received-original.xml')};
   const imported=await rx.owner.execute(access,'IMPORT',receptionInput);
   await rx.owner.execute(access,'ATTACH',{scope,key:'b2b9_recovery_attach_001',payload:{documentId:imported.documentId,kind:'CDR',file:file(cdr,'received-cdr.xml')}});
   const mailStore=new PostgresEmailDeliveryStore(source.pool('MAILER'),{enabled:true,profile:'CORPORATE'}),mail=corporateEmailFixture(undefined,mailStore);
   const accepted=await mail.create();expect(await mail.app.run(accepted.id)).toMatchObject({state:'SMTP_ACCEPTED'});
   mail.sendMail.mockRejectedValueOnce(new Error('SYNTHETIC_RESPONSE_LOST'));
   const unknown=await mail.create({...mail.input,idempotencyKey:randomUUID()});expect(await mail.app.run(unknown.id)).toMatchObject({state:'UNKNOWN'});const sends=mail.sendMail.mock.calls.length;
   const patch=sourceSql('infra/b2b/received-recovery-search-path.patch.sql');
   const beforePatch=await source.inventory('RECEIVED');source.sql('RECEIVED',patch);expect(await source.inventory('RECEIVED')).toEqual(beforePatch);
   const wrongOwner=await source.pool('BILLING').connect();try{await expect(wrongOwner.query(patch)).rejects.toMatchObject({code:'55000'});}finally{await wrongOwner.query('ROLLBACK');wrongOwner.release();}
   const originals:any={BILLING:[],RECEIVED:[{name:'received-original.xml',mediaType:'application/xml',bytes:xml},{name:'received-cdr.xml',mediaType:'application/xml',bytes:cdr}],MAILER:[]};
   for(const o of Object.keys(profiles)){
    const selected=o==='BILLING'?'"B2bP8ReportJob"':o==='RECEIVED'?'"ReceivedDocument","ReceivedItemRecord","ReceivedArtifact"':'"B2bCorporateEmailDeliveryEvent"';
    source.sql(o,'REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO '+source.reader(o)+'; GRANT SELECT ON '+selected+' TO '+source.reader(o)+';');
    for(const original of originals[o])source.putOriginal(o,original.name,original.bytes);
   }
   // No background workers/listeners exist in this owned rehearsal. Owners have
   // finished their transactions; each stable inventory is checked after dump.
   const owners=[],schemaEvidence:any={};
   for(const [owner,profile] of Object.entries(profiles)){
    const inventory=await source.inventory(owner),databaseDump=source.dump(owner);
    expect(await source.inventory(owner)).toEqual(inventory);
    schemaEvidence[owner]=source.schemaEvidence(owner);
    owners.push({owner,profile,...inventory,databaseDump,originals:originals[owner].map((f:any)=>({...f,bytes:source.getOriginal(owner,f.name)}))});
   }
   const bundle={runId,backupId,keyVersion:1,environment:'BETA',datasetClass:'SYNTHETIC',capturedAt:new Date().toISOString(),consistency:'QUIESCED_ISOLATED_REHEARSAL',owners};
   const expected={runId,backupId,keyVersion:1,owners:Object.keys(profiles)},sealed=sealB2bSyntheticRecovery(bundle,key);
   const altered=Buffer.from(sealed);altered[altered.length-1]^=1;
   expect(()=>openB2bSyntheticRecovery(altered,key,expected)).toThrow();expect(target).toBeUndefined();
   expect(()=>openB2bSyntheticRecovery(sealed,randomBytes(32),expected)).toThrow();expect(target).toBeUndefined();
   expect(()=>openB2bSyntheticRecovery(sealed,key,{...expected,owners:['BILLING']})).toThrow();
   const recovered=openB2bSyntheticRecovery(sealed,key,expected);
   await source.close();source=null; // Source tmpfs is gone before any destination starts.
   target=await newRecoveryCluster(runId,'restore');
   for(const o of recovered.owners){
    target.restore(o.owner,o.databaseDump);
    const actual={owner:o.owner,profile:o.profile,...await target.inventory(o.owner)};
    const actualSchema=target.schemaEvidence(o.owner),expectedSchema=schemaEvidence[o.owner];
    for(const k of Object.keys(expectedSchema))if(JSON.stringify(actualSchema[k])!==JSON.stringify(expectedSchema[k])){
     const a=actualSchema[k],b=expectedSchema[k],index=Array.isArray(a)&&Array.isArray(b)?a.findIndex((x:any,i:number)=>JSON.stringify(x)!==JSON.stringify(b[i])):-1;
     throw new Error('RECOVERY_SCHEMA_DIFFERENCE '+JSON.stringify({owner:o.owner,section:k,index,actual:index>=0?a[index]:a,expected:index>=0?b[index]:b}).slice(0,3500));
    }
    expect(b2bRecoveryInventorySha(actual)).toBe(b2bRecoveryInventorySha({owner:o.owner,profile:o.profile,schemaSha256:o.schemaSha256,tables:o.tables,sequences:o.sequences}));
    for(const f of o.originals){target.putOriginal(o.owner,f.name,f.bytes);expect(sha(target.getOriginal(o.owner,f.name))).toBe(sha(f.bytes));}
   }
   const stable=await target.inventory('BILLING');expect(()=>target.restore('BILLING',recovered.owners.find((o:any)=>o.owner==='BILLING').databaseDump)).toThrow('RECOVERY_TARGET_MUST_BE_EMPTY');expect(await target.inventory('BILLING')).toEqual(stable);
   // Read-side roles and immutable trigger policies were restored, not disabled.
   const receivedPool=target.pool('RECEIVED');
   const restricted=await receivedPool.connect();try{
    await restricted.query('BEGIN READ ONLY');await restricted.query('SET LOCAL search_path = pg_catalog, pg_temp');
    expect((await restricted.query('SELECT public.factuez_received_write_hash(\'{}\'::jsonb) AS hash')).rows[0].hash).toBe(sha(Buffer.from('{}')));
    expect((await restricted.query('SELECT public.factuez_received_write_policy("policy") AS valid FROM public."B2bReceivedWriteGrant"')).rows.every((r:any)=>r.valid===true)).toBe(true);
   }finally{await restricted.query('ROLLBACK');restricted.release();}
   for(const statement of ['SET ROLE b2b9_received_reader; SELECT * FROM "B2bReceivedWriteGrant";','SET ROLE b2b9_received_reader; DELETE FROM "ReceivedDocument";']){
    const c=await receivedPool.connect();try{await expect(c.query(statement)).rejects.toMatchObject({code:'42501'});}finally{await c.query('RESET ROLE');c.release();}
   }
   await expect(receivedPool.query('DELETE FROM "B2bReceivedCommand"')).rejects.toMatchObject({code:'23514'});
   const foreign=await target.pool('BILLING').connect();try{await expect(foreign.query('SET ROLE b2b9_received_reader; SELECT * FROM public."B2bP8ReportJob";')).rejects.toMatchObject({code:'42501'});}finally{await foreign.query('RESET ROLE');foreign.release();}
   const mailPool=target.pool('MAILER');await expect(mailPool.query('DELETE FROM "B2bCorporateEmailDeliveryEvent"')).rejects.toThrow();
   // Rebuild real owners from restored PostgreSQL, without reading the source.
   report.rows.length=0;const restoredReport=new B2bReports(new PostgresReportsStore(target.pool('BILLING')),report.identity,report.port,{enabled:true});
   const replay=await restoredReport.execute(report.auth,'CREATE',createInput);expect(replay.replayed).toBe(true);expect(replay.data.id).toBe(made.data.id);
   expect((await restoredReport.execute(report.auth,'CONTENT',{id:made.data.id})).bytes).toEqual(reportBytes);expect(report.port.execute).toHaveBeenCalledTimes(2);
   for(const action of ['READ','CONTENT','CREATE'] as const)await expect(restoredReport.execute(report.auth,action,action==='CREATE'?expiredInput:{id:expired.data.id})).rejects.toMatchObject({status:410});
   const restoredRetention=new B2bReportRetention(target.pool('BILLING'),retentionPolicy,{enabled:true});
   expect(await restoredRetention.apply(retentionPlan.planId)).toEqual({...retentionReceipt,replayed:true});
   await expect(target.pool('BILLING').query('DELETE FROM "B2bReportContentPurgeAudit"')).rejects.toMatchObject({code:'23514'});await restoredRetention.close();
   const restoredRx=receivedFixture(receivedClient(target)),beforeReplay=await target.inventory('RECEIVED');
   expect(await restoredRx.owner.execute(access,'IMPORT',receptionInput)).toEqual(imported);expect(await target.inventory('RECEIVED')).toEqual(beforeReplay);
   const artifact=(await receivedPool.query('SELECT bytes FROM "ReceivedArtifact" WHERE "documentId"=$1 AND kind=\'XML\'',[imported.documentId])).rows[0];expect(Buffer.from(artifact.bytes)).toEqual(xml);
   const restoredMail=mail.assemble(new PostgresEmailDeliveryStore(mailPool,{enabled:true,profile:'CORPORATE'}));
   expect(await restoredMail.run(accepted.id)).toMatchObject({state:'SMTP_ACCEPTED'});expect(await restoredMail.run(unknown.id)).toMatchObject({state:'UNKNOWN',errorCode:'SMTP_OUTCOME_UNKNOWN'});expect(mail.sendMail).toHaveBeenCalledTimes(sends);
   // Restoring data is not an authorization bypass: current identity still wins.
   restoredRx.control.revoked=true;await expect(restoredRx.owner.execute(access,'IMPORT',receptionInput)).rejects.toMatchObject({status:403});
   // Canonicalizing SQL must still detect an actual predicate being removed.
   const intact=await target.inventory('RECEIVED');target.sql('RECEIVED','ALTER TABLE "ReceivedArtifact" DROP CONSTRAINT received_artifact_bounded; ALTER TABLE "ReceivedArtifact" ADD CONSTRAINT received_artifact_bounded CHECK (true);');
   expect((await target.inventory('RECEIVED')).schemaSha256).not.toBe(intact.schemaSha256);
   expect(fetch).not.toHaveBeenCalled();
  }finally{vi.unstubAllGlobals();key.fill(0);await target?.close();await source?.close();}
 },240000);
});
