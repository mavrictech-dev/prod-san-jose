import {it,expect,vi} from 'vitest';import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';
import {PostgresEmailDeliveryStore} from '../services/mailer-worker/src/b2b/email-deliveries.store';
import {corporateEmailFixture} from './b2b-email-deliveries-corporate.fixture';
import {B2bWorkerMaintenance} from '../packages/service-access/src/b2b-worker-maintenance';
const {withCorporateEmailDatabase}=createRequire(import.meta.url)('./b2b-email-deliveries-corporate-db.runner.cjs');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
it('PostgreSQL journal survives graceful shutdown during SMTP, both accepted and unknown; reconstruction cannot resend either',async()=>{
 await withCorporateEmailDatabase(async({pool,secondPool}:any)=>{
  const store=new PostgresEmailDeliveryStore(pool,{enabled:true,profile:'CORPORATE'}),h=corporateEmailFixture(undefined,store),engines=[h.app.engine],pending:Promise<any>[]=[],releases:(()=>void)[]=[];
  const group=(engine:any)=>new B2bWorkerMaintenance({enabled:true,owner:'MAILER',expected:['MAILER_DELIVERIES'],components:[{id:'MAILER_DELIVERIES',worker:engine}]});
  let current=h.app,currentStore=store;
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('OFFICIAL_NETWORK_FORBIDDEN');}));
  try{
   for(const accepted of [true,false]){
    const created=await current.engine.execute({token:'synthetic-token',kind:'SERVICE'},'CREATE',{...h.input,idempotencyKey:randomUUID()}),entered=deferred(),finish=deferred();releases.push(finish.resolve);
    h.sendMail.mockImplementationOnce(async(m:any)=>{entered.resolve();await finish.promise;if(!accepted)throw Error('SYNTHETIC_SMTP_OUTCOME_LOST');return {messageId:m.messageId,accepted:[m.to],rejected:[],response:'250 accepted'};});
    const running=current.run(created.id);pending.push(running);await entered.promise;
    expect((await secondPool.query('SELECT state FROM "B2bCorporateEmailDeliveryJob" WHERE id=$1',[created.id])).rows[0].state).toBe('DISPATCHING');
    const maintenance=group(current.engine);maintenance.stop();expect((await maintenance.wait(5)).state).toBe('STOPPING');
    // No SQL is active while SMTP waits: the engine, not just the store, must drain.
    expect((await currentStore.transaction([],tx=>tx.job(created.id)))?.state).toBe('DISPATCHING');
    await expect(current.engine.execute({token:'synthetic-token',kind:'SERVICE'},'READ',{id:created.id})).rejects.toMatchObject({code:'EMAIL_DISABLED'});
    finish.resolve();expect(await running).toMatchObject({state:accepted?'SMTP_ACCEPTED':'UNKNOWN'});expect((await maintenance.wait(5000)).state).toBe('QUIESCED_LOCAL');
    await expect(currentStore.transaction([],tx=>tx.job(created.id))).rejects.toMatchObject({code:'EMAIL_STORE_UNAVAILABLE'});
    const row=(await secondPool.query('SELECT state,payload FROM "B2bCorporateEmailDeliveryJob" WHERE id=$1',[created.id])).rows[0];expect(row.state).toBe(accepted?'SMTP_ACCEPTED':'UNKNOWN');
    const events=(await secondPool.query('SELECT event_type FROM "B2bCorporateEmailDeliveryEvent" WHERE job_id=$1 ORDER BY revision',[created.id])).rows.map((r:any)=>r.event_type);
    expect(events.at(-1)).toBe(accepted?'SMTP_ACCEPTED':'UNKNOWN');expect(events.filter((e:string)=>e==='ATTEMPT_STARTED')).toHaveLength(1);
    const sent=h.sendMail.mock.calls.length;currentStore=new PostgresEmailDeliveryStore(secondPool,{enabled:true,profile:'CORPORATE'});current=h.assemble(currentStore);engines.push(current.engine);
    expect(await current.run(created.id)).toMatchObject({state:row.state,deliveredToClient:false});expect(h.sendMail).toHaveBeenCalledTimes(sent);
   }
   expect(fetch).not.toHaveBeenCalled();
  }finally{releases.forEach(release=>release());await Promise.allSettled(pending);const stopped=await Promise.allSettled(engines.map(e=>e.close()));vi.unstubAllGlobals();expect(stopped.every(r=>r.status==='fulfilled')).toBe(true);}
 });
},90000);
