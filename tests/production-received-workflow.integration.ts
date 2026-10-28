import 'reflect-metadata';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {it,expect,vi} from 'vitest';
import {ReceptionAutomationService} from '../services/received-documents-service/src/automation/service';
import {ReceptionProductionWorkflow,ACTIVATION_REVIEW} from '../services/received-documents-service/src/automation/readiness';
import {ReceptionSyncProcessor} from '../services/received-documents-service/src/automation/processor';
import {NativeReceptionScheduler} from '../services/received-documents-service/src/automation/scheduler';
import {defaultReceptionSettings} from '../services/received-documents-service/src/automation/policy';
import {fixtureMail} from '../services/received-documents-service/src/automation/mail-fixture';
import {receivedCdr} from './received-fixture.mjs';
import {syntheticTransports} from './production-received-transports';
const {withReceivedDatabase}=createRequire(import.meta.url)('./helpers/b2b-received-db.cjs');
if(process.env.FACTUEZ_B2B_RECEIVED_OWNED_DB!=='NEW_NETWORK_NONE_TMPFS_ONLY')throw Error('EXPLICIT_NEW_DATABASE_REQUIRED');
const ruc='00000000101',otherRuc='00000000202';
const access:any={user:{sub:'fea80800-0000-4000-8000-000000000080',roles:['ADMIN'],permissions:['setup.manage'],scope:{kind:'GLOBAL'}},catalog:{companies:[{id:1,ruc,environment:'PRODUCTION'},{id:2,ruc:otherRuc,environment:'PRODUCTION'}],branches:[]}};
it('save → server readiness → TLS validation → RUC confirmation → durable scheduling → SIRE ticket recovery → IMAP import → reconciliation → credential fencing',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'factuez-production-received-')),key=join(dir,'synthetic-key');
  writeFileSync(key,randomBytes(32).toString('hex'),{mode:0o600});
  vi.stubEnv('RECEIVED_SETTINGS_KEY_FILE',key);vi.stubEnv('RECEIVED_LIVE_READ_ALLOWED','true');vi.stubEnv('RECEIVED_IMAP_APPROVED_HOSTS','imap.synthetic.example.com');vi.stubEnv('RECEIVED_LOCAL_FIXTURE_ENABLED','false');
  vi.stubGlobal('fetch',()=>{throw Error('REAL_PROVIDER_NETWORK_FORBIDDEN');});
  const period=defaultReceptionSettings().sire.startPeriod;
  const cdr=Buffer.from(receivedCdr('FZ01-'+period));
  const mime=fixtureMail(ruc,period).toString().replace('--factuez-reception-qa--', '--factuez-reception-qa\r\nContent-Type: application/xml\r\nContent-Disposition: attachment; filename="R-00000000002-01-FZ01-'+period+'.xml"\r\nContent-Transfer-Encoding: base64\r\n\r\n'+cdr.toString('base64')+'\r\n--factuez-reception-qa--');
  const stubs=await syntheticTransports(Buffer.from(mime),ruc,period);
  try{await withReceivedDatabase(async({client:db,pool}:any)=>{
    const service=new ReceptionAutomationService(db),workflow=new ReceptionProductionWorkflow(db,stubs.connectors),processor=new ReceptionSyncProcessor(db,async()=>{},stubs.connectors);
    const settings={...defaultReceptionSettings(),enabled:true,mailbox:{enabled:true,host:'imap.synthetic.example.com',port:993 as const,username:'synthetic-user',folder:'INBOX'},sire:{enabled:true,clientId:'synthetic-client',solUsername:'SYNTHETIC',startPeriod:period}};
    const credentials={mailPassword:'SYNTHETIC-MAIL-PASSWORD',sireClientSecret:'SYNTHETIC-CLIENT-SECRET',solPassword:'SYNTHETIC-SOL-PASSWORD'};
    const saved=await service.save(access,1,{expectedRevision:0,settings,credentials});
    expect(saved.settings.enabled).toBe(false);expect(stubs.paths).toHaveLength(0);expect(stubs.commands).toHaveLength(0);
    expect(JSON.stringify(saved)).not.toContain(credentials.mailPassword);
    await expect(service.queue(access,{companyId:1,source:'ALL'})).rejects.toMatchObject({status:403});
    const enqueued:string[]=[];const scheduler=new NativeReceptionScheduler(db,async id=>{enqueued.push(id);});await scheduler.tick();expect(enqueued).toEqual([]);
    const request={expectedRevision:1,recipientRuc:ruc};
    // Missing runtime columns fail readiness without reading any stored rows.
    for(const [table,column] of [['ReceptionMailboxCheckpoint','uidValidity'],['ReceptionSireIncident','recordHash']]){
      await pool.query('ALTER TABLE "'+table+'" RENAME COLUMN "'+column+'" TO "synthetic_missing"');
      try{expect((await workflow.serverReadiness()).checks.database).toBe(false);}finally{await pool.query('ALTER TABLE "'+table+'" RENAME COLUMN "synthetic_missing" TO "'+column+'"');}
    }
    expect((await workflow.serverReadiness()).checks.database).toBe(true);
    vi.stubEnv('RECEIVED_LIVE_READ_ALLOWED','false');
    const blocked=await workflow.validate(access,1,request);expect(blocked.ready).toBe(false);expect(stubs.paths).toHaveLength(0);
    vi.stubEnv('RECEIVED_LIVE_READ_ALLOWED','true');
    const valid=await workflow.validate(access,1,request);expect(valid).toMatchObject({ready:true,mail:'VALID',sire:'VALID'});
    const activation={...request,validationId:valid.validationId,confirmation:ruc,reviewVersion:ACTIVATION_REVIEW};
    await expect(workflow.activate(access,1,{...activation,confirmation:otherRuc})).rejects.toMatchObject({status:400});
    await expect(workflow.activate(access,2,activation)).rejects.toMatchObject({status:409});
    await db.receptionConnectionAudit.update({where:{id:valid.validationId},data:{createdAt:new Date(Date.now()-16*60000)}});
    await expect(workflow.activate(access,1,activation)).rejects.toMatchObject({status:409});
    await db.receptionConnectionAudit.update({where:{id:valid.validationId},data:{createdAt:new Date()}});
    await workflow.activate(access,1,activation);await scheduler.tick();expect(enqueued).toHaveLength(2);
    expect((await service.status(access,1)).connectors.every(c=>c.authorized)).toBe(true);
    const runs=await db.receptionSyncRun.findMany({where:{companyId:1}}),sire=runs.find((r:any)=>r.source==='SIRE'),mail=runs.find((r:any)=>r.source==='MAIL');
    stubs.failTicket(true);await expect(processor.run(sire.id)).rejects.toThrow();expect(stubs.exports).toBe(1);
    expect(await db.receptionConnectionAudit.count({where:{action:'SIRE_TICKET_CREATED'}})).toBe(1);
    stubs.failTicket(false);await processor.run(sire.id);expect(stubs.exports).toBe(1);
    expect(await db.receivedDocument.count()).toBe(0);
    expect(await db.receptionSirePurchase.findFirst()).toMatchObject({xmlStatus:'PENDING',amount:'118.00',documentId:null});
    const queuedBefore=enqueued.length;await scheduler.tick();expect(enqueued.length).toBe(queuedBefore+1);
    await processor.run(mail.id);
    expect(await db.receivedDocument.count()).toBe(1);expect(await db.receivedItemRecord.count()).toBe(1);expect(await db.receivedArtifact.count()).toBe(2);
    expect(await db.receptionSirePurchase.findFirst()).toMatchObject({xmlStatus:'MATCHED'});
    expect(await db.receptionMailboxCheckpoint.findUnique({where:{companyId:1}})).toMatchObject({lastUid:1n,uidValidity:'91'});
    await service.queue(access,{companyId:1,source:'MAIL'});const duplicate=await db.receptionSyncRun.findFirst({where:{status:'QUEUED',source:'MAIL'}});stubs.addDuplicate();await processor.run(duplicate.id);
    expect(await db.receivedDocument.count()).toBe(1);expect((await db.receptionSyncRun.findUnique({where:{id:duplicate.id}})).counters).toMatchObject({duplicate:1});
    // A second recipient's XML is quarantined, even inside this authorized mailbox.
    stubs.replaceMessage(fixtureMail(otherRuc,period));stubs.addDuplicate();
    await service.queue(access,{companyId:1,source:'MAIL'});const foreign=await db.receptionSyncRun.findFirst({where:{status:'QUEUED',source:'MAIL'}});await processor.run(foreign.id);
    expect(await db.receivedDocument.count()).toBe(1);expect((await db.receptionSyncRun.findUnique({where:{id:foreign.id}})).counters.rejected).toBe(1);
    expect(stubs.commands).not.toContain('SELECT');expect(stubs.commands).not.toContain('STORE');expect(stubs.commands).not.toContain('APPEND');expect(stubs.commands).toContain('EXAMINE');
    await service.queue(access,{companyId:1,source:'SIRE'});const stale=await db.receptionSyncRun.findFirst({where:{status:'QUEUED',source:'SIRE'}});
    const config=await service.config(access,1);await service.save(access,1,{expectedRevision:config.revision,settings:config.settings,credentials:{mailPassword:'SYNTHETIC-ROTATED'}});
    expect((await service.config(access,1)).settings.enabled).toBe(false);expect(await db.receptionMailboxCheckpoint.count()).toBe(0);
    const calls=stubs.paths.length;await processor.run(stale.id);expect(stubs.paths).toHaveLength(calls);
    await expect(workflow.activate(access,1,activation)).rejects.toMatchObject({status:409});
    expect((await service.runs(access,1)).items.some((r:any)=>r.errorCode==='CONFIGURATION_CHANGED')).toBe(true);
    const audits=JSON.stringify(await db.receptionConnectionAudit.findMany());for(const secret of Object.values(credentials))expect(audits).not.toContain(secret);
    const server=await workflow.readiness(access,1);expect(server).toMatchObject({activated:false,sireProvides:'PURCHASE_REGISTRY_TOTALS',xmlDetailSource:'PROVIDER_MAIL_ATTACHMENTS'});
    expect(Number((await pool.query('SELECT count(*) n FROM "Document"')).rows[0].n)).toBe(0);
    // No immediate new run after successful completion; cadence includes terminal rows.
    await scheduler.tick();expect(await db.receptionSyncRun.count({where:{status:'QUEUED'}})).toBe(0);
    // Credentials changed while an authorized HTTPS response is in flight cannot persist that response.
    const next=await workflow.validate(access,1,{expectedRevision:2,recipientRuc:ruc});expect(next.ready).toBe(true);
    await workflow.activate(access,1,{expectedRevision:2,recipientRuc:ruc,validationId:next.validationId,confirmation:ruc,reviewVersion:ACTIVATION_REVIEW});
    await service.queue(access,{companyId:1,source:'SIRE'});const racing=await db.receptionSyncRun.findFirst({where:{status:'QUEUED',source:'SIRE'}});
    const raceConnectors={...stubs.connectors,sire:(credentials:any)=>{
      const client=stubs.connectors.sire(credentials),read=client.readPeriodDetailed.bind(client);
      client.readPeriodDetailed=async(period,checkpoint)=>{const batch=await read(period,checkpoint);const current=await service.config(access,1);await service.save(access,1,{expectedRevision:current.revision,settings:current.settings,credentials:{solPassword:'SYNTHETIC-ROTATED-IN-FLIGHT'}});return batch;};
      return client;
    }};
    await expect(new ReceptionSyncProcessor(db,async()=>{},raceConnectors).run(racing.id)).rejects.toMatchObject({status:409});
    expect(await db.receptionSirePurchase.count({where:{observedRunId:racing.id}})).toBe(0);
    expect((await db.receptionSyncRun.findUnique({where:{id:racing.id}})).status).toBe('BLOCKED');
    await scheduler.pause();
  });}finally{await stubs.close();vi.unstubAllEnvs();vi.unstubAllGlobals();rmSync(dir,{recursive:true,force:true});}
});
