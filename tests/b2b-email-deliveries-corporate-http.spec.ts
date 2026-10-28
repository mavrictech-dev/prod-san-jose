import 'reflect-metadata';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:https';
import {describe,it,expect,vi} from 'vitest';
import {NestFactory} from '../services/b2b-api-service/node_modules/@nestjs/core';
import {FactuEzB2bClient} from '../packages/b2b-sdk/src';
import {B2bEmailDeliveryOperations,B2bEmailDeliveriesModule,HttpEmailDeliveryOwner} from '../services/b2b-api-service/src/email-deliveries';
import {B2bReadErrorFilter} from '../services/b2b-api-service/src/http';
import {B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {PostgresEmailDeliveryStore} from '../services/mailer-worker/src/b2b/email-deliveries.store';
import {createB2bEmailDeliveriesHandler} from '../services/mailer-worker/src/b2b/email-deliveries.http';
import type {EmailDeliveryStore} from '../services/mailer-worker/src/b2b/email-deliveries.types';
import type {CorporateEmailOptions} from '../services/mailer-worker/src/b2b/email-deliveries.corporate';
import {corporateEmailFixture} from './b2b-email-deliveries-corporate.fixture';
import {corporateEmailPki,corporateFingerprint} from './b2b-email-deliveries-corporate-tls.fixture';

async function close(server:Server){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
async function withChain(work:(chain:any)=>Promise<void>,store?:EmailDeliveryStore,options?:CorporateEmailOptions){
  const h=options===undefined?corporateEmailFixture(undefined,store):corporateEmailFixture(options,store);
  const pki=corporateEmailPki(),responses:any[]=[],requests:any[]=[],ownerRequests:any[]=[];
  const httpsOptions={ca:pki.ca,...pki.server,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const};
  const handler=createB2bEmailDeliveriesHandler(h.app.engine,[corporateFingerprint(pki.owner.cert)],'OWNER_RPC');
  const owner=createServer(httpsOptions,async(req,res)=>{
    ownerRequests.push({method:req.method,path:req.url,authorization:req.headers.authorization});
    if(!await handler(req,res)){res.statusCode=404;res.end();}
  });
  let nest:any;
  try{
    await new Promise<void>(r=>owner.listen(0,'127.0.0.1',r));
    const ownerOrigin='https://127.0.0.1:'+(owner.address() as {port:number}).port;
    const http=new B2bPrivateHttp(ownerOrigin,{ca:pki.ca,...pki.owner});
    const adapter=new HttpEmailDeliveryOwner(http),ownerExecute=vi.spyOn(adapter,'execute');
    const facadeIdentity={authenticate:vi.fn(async()=>structuredClone(h.p))};
    const facade=new B2bEmailDeliveryOperations(facadeIdentity,adapter);
    nest=await NestFactory.create(B2bEmailDeliveriesModule.isolated(facade,[corporateFingerprint(pki.sdk.cert)]),
      {logger:false,bodyParser:false,httpsOptions});
    const hooks={mutate:(v:any)=>v};
    nest.use((req:any,res:any,next:()=>void)=>{
      requests.push({method:req.method,path:req.url,authorization:req.headers.authorization});
      const json=res.json.bind(res);res.json=(value:any)=>{responses.push({status:res.statusCode,body:structuredClone(value)});return json(hooks.mutate(value));};next();
    });
    nest.useBodyParser('json',{limit:16384,strict:true});nest.useGlobalFilters(new B2bReadErrorFilter());
    await nest.listen(0,'127.0.0.1');const origin='https://127.0.0.1:'+nest.getHttpServer().address().port;
    const sdkOptions={origin,tls:{ca:pki.ca,...pki.sdk,serverCertificateSha256:corporateFingerprint(pki.server.cert)},
      bearer:async()=>({token:'synthetic-corporate-sdk-token',actorKind:h.p.kind})};
    const sdk=new FactuEzB2bClient(sdkOptions);
    const create=(idempotencyKey=randomUUID())=>sdk.requestDocumentEmail(h.binding,h.documentId,
      {recipient:h.input.recipient,format:'a4'},{idempotencyKey});
    await work({h,sdk,create,nest,adapter,ownerExecute,facadeIdentity,responses,requests,ownerRequests,hooks,sdkOptions,pki});
  }finally{
    if(nest){nest.getHttpServer().closeAllConnections();await nest.close();}
    if(owner.listening)await close(owner);await h.store.close();
  }
}

describe('CORPORATE SDK -> Nest facade -> HTTP owner -> Mailer with own ephemeral mTLS',()=>{
  it('persists CREATE/READ, progress and terminal outcomes with only candidate DDL in NEW tmpfs PostgreSQL',async()=>{
    const {withCorporateEmailDatabase}=createRequire(import.meta.url)('./b2b-email-deliveries-corporate-db.runner.cjs');
    await withCorporateEmailDatabase(async({pool,secondPool}:any)=>{
      const store=new PostgresEmailDeliveryStore(pool,{enabled:true,profile:'CORPORATE'});
      const second=new PostgresEmailDeliveryStore(secondPool,{enabled:true,profile:'CORPORATE'});
      try{await withChain(async({h,sdk,create,ownerExecute,requests,ownerRequests}:any)=>{
        expect((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map((r:any)=>r.tablename))
          .toEqual(['B2bCorporateEmailDeliveryEvent','B2bCorporateEmailDeliveryJob','B2bCorporateEmailDeliverySandbox']);
        const key=randomUUID(),created=await create(key);
        expect(created).toMatchObject({profile:'CORPORATE',state:'QUEUED',errorCode:null,deliveredToClient:false});
        expect(h.sendMail).not.toHaveBeenCalled();expect(await sdk.readEmailDelivery(created.id)).toMatchObject({state:'QUEUED'});
        expect(await create(key)).toMatchObject({id:created.id,replayed:true});
        expect(await h.app.run(created.id)).toMatchObject({state:'SMTP_ACCEPTED',errorCode:null,deliveredToClient:false});
        expect(await sdk.readEmailDelivery(created.id)).toMatchObject({profile:'CORPORATE',state:'SMTP_ACCEPTED',errorCode:null,deliveredToClient:false});
        expect(await create(key)).toMatchObject({id:created.id,state:'SMTP_ACCEPTED',replayed:true});
        await h.assemble(second).run(created.id);expect(h.sendMail).toHaveBeenCalledOnce();
        const persisted=(await pool.query('SELECT payload FROM "B2bCorporateEmailDeliveryJob" WHERE id=$1',[created.id])).rows[0].payload;
        expect(h.sendMail.mock.calls[0][0].messageId).toBe(persisted.corporate.messageId);
        expect(persisted.corporate.messageId).toBe('<factuez-b2b-'+created.id+'@delivery.factuez.invalid>');
        expect((await pool.query('SELECT event_type FROM "B2bCorporateEmailDeliveryEvent" WHERE job_id=$1 ORDER BY revision',[created.id])).rows.map((r:any)=>r.event_type))
          .toEqual(['CREATED','ATTEMPT_STARTED','SMTP_ACCEPTED']);
        await expect(store.transaction([],async tx=>{const j=(await tx.job(created.id))!;
          await tx.save({...j,state:'UNKNOWN',errorCode:'SMTP_OUTCOME_UNKNOWN',revision:j.revision+1},j.revision);
        })).rejects.toMatchObject({code:'EMAIL_STORE_UNAVAILABLE'});
        expect(await sdk.readEmailDelivery(created.id)).toMatchObject({state:'SMTP_ACCEPTED'});
        const event=(await pool.query('SELECT payload FROM "B2bCorporateEmailDeliveryEvent" WHERE job_id=$1 AND event_type=$2',[created.id,'ATTEMPT_STARTED'])).rows[0].payload;
        await expect(store.transaction([],tx=>tx.append({...event,id:randomUUID(),revision:10}))).rejects.toMatchObject({code:'EMAIL_STORE_UNAVAILABLE'});

        const queued=await create();
        await expect(store.transaction([],async tx=>{const j=(await tx.job(queued.id))!;await tx.save({...j,revision:j.revision+1},0);})).rejects.toMatchObject({code:'EMAIL_REVISION_CONFLICT'});
        await expect(store.transaction([],async tx=>{const j=(await tx.job(queued.id))!;
          await tx.save({...j,state:'DISPATCHING',attemptId:randomUUID(),revision:j.revision+1},j.revision);
          // No audit append: deferred candidate constraint must roll the entire transaction back.
        })).rejects.toMatchObject({code:'EMAIL_STORE_UNAVAILABLE'});
        expect(await sdk.readEmailDelivery(queued.id)).toMatchObject({state:'QUEUED',revision:1});
        await expect(store.transaction([],async tx=>{const j=(await tx.job(queued.id))!;
          await tx.save({...j,state:'DISPATCHING',attemptId:randomUUID(),revision:j.revision+1,
            corporate:{...j.corporate!,configurationRevision:j.corporate!.configurationRevision+1}},j.revision);
        })).rejects.toMatchObject({code:'EMAIL_STORE_UNAVAILABLE'});
        expect(await h.app.run(queued.id)).toMatchObject({state:'SMTP_ACCEPTED'});

        const cdr=h.proof.originals.pop(),waiting=await create();
        expect(waiting).toMatchObject({state:'WAITING_ARTIFACTS',errorCode:'ARTIFACTS_PENDING'});
        expect(await sdk.readEmailDelivery(waiting.id)).toMatchObject({state:'WAITING_ARTIFACTS',errorCode:'ARTIFACTS_PENDING'});
        expect(await h.app.run(waiting.id)).toMatchObject({state:'WAITING_ARTIFACTS'});h.proof.originals.push(cdr);
        expect(await h.app.run(waiting.id)).toMatchObject({state:'SMTP_ACCEPTED'});

        const ambiguous=await create(),before=h.sendMail.mock.calls.length;
        h.sendMail.mockRejectedValueOnce(Error('synthetic ambiguous SMTP result'));
        expect(await h.app.run(ambiguous.id)).toMatchObject({state:'UNKNOWN',errorCode:'SMTP_OUTCOME_UNKNOWN'});
        expect(await sdk.readEmailDelivery(ambiguous.id)).toMatchObject({profile:'CORPORATE',state:'UNKNOWN',errorCode:'SMTP_OUTCOME_UNKNOWN',deliveredToClient:false});
        await h.assemble(second).run(ambiguous.id);expect(h.sendMail).toHaveBeenCalledTimes(before+1);

        const raced=await create();let entered!:()=>void,release!:()=>void;
        const ready=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
        h.sendMail.mockImplementationOnce(async(m:any)=>{entered();await blocked;return {messageId:m.messageId,accepted:[m.to],rejected:[],response:'250 queued'};});
        const running=h.app.run(raced.id);await ready;
        try{
          expect(await sdk.readEmailDelivery(raced.id)).toMatchObject({state:'DISPATCHING',errorCode:null});
          expect(await h.assemble(second).run(raced.id)).toMatchObject({state:'UNKNOWN'});
        }finally{release();expect(await running).toMatchObject({state:'UNKNOWN'});}
        expect(await sdk.readEmailDelivery(raced.id)).toMatchObject({state:'UNKNOWN',errorCode:'SMTP_OUTCOME_UNKNOWN'});
        expect((await pool.query('SELECT count(*)::int AS n FROM "B2bCorporateEmailDeliveryEvent" WHERE job_id=$1 AND event_type=$2',[raced.id,'ATTEMPT_STARTED'])).rows[0].n).toBe(1);
        await expect(pool.query('DELETE FROM "B2bCorporateEmailDeliveryEvent" WHERE job_id=$1',[raced.id])).rejects.toThrow();
        expect(ownerExecute).toHaveBeenCalledWith({token:'synthetic-corporate-sdk-token',kind:'SERVICE'},'CREATE',expect.objectContaining({binding:h.binding}));
        expect(requests.every((r:any)=>r.path.startsWith('/b2b/v1/')&&!r.path.includes('?'))).toBe(true);
        expect(ownerRequests.every((r:any)=>r.path==='/internal/b2b/email-deliveries'&&r.authorization==='Bearer synthetic-corporate-sdk-token')).toBe(true);
        const disk=JSON.stringify((await pool.query('SELECT payload FROM "B2bCorporateEmailDeliveryJob"')).rows);
        expect(disk).not.toContain('synthetic-corporate-sdk-token');expect(disk).not.toContain('fictional-password');
      },store);}finally{await second.close();}
    });
  },60000);

  it('passes through owner auth revision/revocation and blocks live execution without any SMTP',async()=>{
    await withChain(async({h,sdk,create,responses}:any)=>{
      let calls=0;h.identity.authenticate.mockImplementation(async()=>{if(++calls===2)h.p.revision++;return structuredClone(h.p);});
      await expect(create()).rejects.toMatchObject({code:'REMOTE_REQUEST_FAILED',status:401});
      expect(responses.at(-1).body.code).toBe('ACCESS_CHANGED');expect(h.store.disk.jobs).toHaveLength(0);
      h.identity.authenticate.mockImplementation(async()=>structuredClone(h.p));
      const created=await create();h.p.revision++;
      await expect(h.app.run(created.id)).rejects.toMatchObject({code:'ACCESS_CHANGED'});
      expect(await sdk.readEmailDelivery(created.id)).toMatchObject({state:'QUEUED'});
      h.p.scopes=h.p.scopes.filter((s:string)=>s!=='b2b:artifacts:read');
      await expect(sdk.readEmailDelivery(created.id)).rejects.toMatchObject({code:'REMOTE_REQUEST_FAILED',status:401});
      expect(responses.at(-1).body.code).toBe('INVALID_PRINCIPAL');h.p.scopes.push('b2b:artifacts:read');
      const pinned=await create();h.row.revision++;
      await expect(h.app.run(pinned.id)).rejects.toMatchObject({code:'EMAIL_SMTP_CONFIGURATION_CHANGED'});
      expect(await sdk.readEmailDelivery(pinned.id)).toMatchObject({state:'QUEUED'});
      h.permission.authorizeRealSendCurrent.mockResolvedValue(null);
      await expect(create()).rejects.toMatchObject({code:'REMOTE_REQUEST_FAILED',status:403});
      expect(responses.at(-1).body.code).toBe('EMAIL_REAL_SEND_FORBIDDEN');expect(h.sendMail).not.toHaveBeenCalled();
      expect(h.network.createTransport).not.toHaveBeenCalled();
    });
  },30000);

  it('preserves NONE by default through the same chain and independently rejects incompatible SDK terminal metadata',async()=>{
    await withChain(async({h,sdk,create,hooks}:any)=>{
      const j=await create();expect(j).toMatchObject({profile:'NONE',state:'QUEUED',deliveredToClient:false});
      await expect(h.app.run(j.id)).rejects.toMatchObject({code:'EMAIL_CAPTURE_DISABLED'});
      expect(await sdk.readEmailDelivery(j.id)).toMatchObject({profile:'NONE',state:'QUEUED'});
      for(const outcome of [{profile:'NONE',state:'SMTP_ACCEPTED',errorCode:null},
        {profile:'CORPORATE',state:'CAPTURED_LOCAL',errorCode:null},
        {profile:'LOCAL_CAPTURE',state:'UNKNOWN',errorCode:'SMTP_OUTCOME_UNKNOWN'},
        {profile:'CORPORATE',state:'UNKNOWN',errorCode:'CAPTURE_OUTCOME_UNKNOWN'},
        {profile:'CORPORATE',state:'SMTP_ACCEPTED',errorCode:null,deliveredToClient:true}]){
        hooks.mutate=(value:any)=>({...value,...outcome});
        await expect(sdk.readEmailDelivery(j.id)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
      }
      expect(h.configurations.read).not.toHaveBeenCalled();expect(h.network.resolve).not.toHaveBeenCalled();expect(h.sendMail).not.toHaveBeenCalled();
    },undefined,{enabled:true});
  },30000);
});
