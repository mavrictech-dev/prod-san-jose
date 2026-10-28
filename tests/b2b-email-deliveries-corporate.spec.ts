import {randomUUID} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {corporateEmailSmtpOptions,NodemailerCorporateEmailTransport} from '../services/mailer-worker/src/b2b/email-deliveries.corporate';
import {emailHash} from '../services/mailer-worker/src/b2b/email-deliveries';
import {B2bSecurityError} from '../services/mailer-worker/src/b2b/email-deliveries.security';
import {PostgresEmailDeliveryStore} from '../services/mailer-worker/src/b2b/email-deliveries.store';
import {PreparedCorporateSmtp} from '../services/mailer-worker/src/smtp-configuration.transport';

import {corporateEmailFixture as fixture} from './b2b-email-deliveries-corporate.fixture';

describe('CORPORATE opt-in worker with fake SMTP only',()=>{
  it('defaults to disabled NONE and does not access any owner or network on construction',async()=>{
    const h=fixture({});
    await expect(h.create()).rejects.toMatchObject({code:'EMAIL_DISABLED'});
    expect(h.identity.authenticate).not.toHaveBeenCalled();expect(h.configurations.read).not.toHaveBeenCalled();
    expect(h.vault.open).not.toHaveBeenCalled();expect(h.network.resolve).not.toHaveBeenCalled();expect(h.network.createTransport).not.toHaveBeenCalled();
    const transport=new NodemailerCorporateEmailTransport(h.owner,{},h.network);
    await expect(transport.authorizeCurrent(h.p,h.input,{} as any)).rejects.toMatchObject({code:'EMAIL_CORPORATE_DISABLED'});
  });
  it.each([false,undefined])('requires independent real-send activation (%s), even with email and configuration scopes',async realSendEnabled=>{
    const h=fixture({enabled:true,profile:'CORPORATE',realSendEnabled,approvedHosts:['smtp.corporate.example.org']});
    h.p.scopes.push('b2b:mail-config:manage');
    await expect(h.create()).rejects.toMatchObject({code:'EMAIL_CORPORATE_DISABLED'});
    expect(h.network.createTransport).not.toHaveBeenCalled();expect(h.configurations.read).not.toHaveBeenCalled();
  });
  it('keeps an enabled assembly at NONE until CORPORATE is explicitly selected',async()=>{
    const h=fixture({enabled:true,realSendEnabled:true}),j=await h.create();expect(j.profile).toBe('NONE');
    await expect(h.app.run(j.id)).rejects.toMatchObject({code:'EMAIL_CAPTURE_DISABLED'});
    expect(h.permission.authorizeRealSendCurrent).not.toHaveBeenCalled();expect(h.configurations.read).not.toHaveBeenCalled();
    expect(h.network.createTransport).not.toHaveBeenCalled();
  });
  it('does not infer real-send permission from email:send or mail-config:manage',async()=>{
    const h=fixture();h.p.scopes.push('b2b:mail-config:manage');h.permission.authorizeRealSendCurrent.mockResolvedValue(null);
    await expect(h.create()).rejects.toMatchObject({code:'EMAIL_REAL_SEND_FORBIDDEN'});
    expect(h.store.disk.jobs).toHaveLength(0);expect(h.configurations.read).not.toHaveBeenCalled();
  });
  it.each(['b2b:email:send','b2b:documents:read','b2b:artifacts:read'])('requires current %s',async scope=>{
    const h=fixture();h.p.scopes=h.p.scopes.filter(s=>s!==scope);
    await expect(h.create()).rejects.toMatchObject({code:'INVALID_PRINCIPAL'});expect(h.sendMail).not.toHaveBeenCalled();
  });
  it('assembles actual owner originals, pins configuration and persists before SMTP, then replays across restart',async()=>{
    const h=fixture(),created=await h.create();
    expect(h.sendMail).not.toHaveBeenCalled();expect(h.network.resolve).not.toHaveBeenCalled();expect(h.network.createTransport).not.toHaveBeenCalled();
    const saved=h.store.disk.jobs[0],id=saved.corporate!.messageId;
    expect(saved.corporate).toEqual({grantId:h.grant.grantId,grantRevision:1,configurationRevision:1,
      configurationSnapshotId:emailHash(h.row.configurationCipher),messageId:'<factuez-b2b-'+created.id+'@delivery.factuez.invalid>'});
    h.sendMail.mockImplementation(async m=>{
      expect(h.store.disk.jobs[0]).toMatchObject({state:'DISPATCHING',corporate:{messageId:id}});
      expect(h.store.disk.events.at(-1)?.type).toBe('ATTEMPT_STARTED');
      expect(m.envelope).toEqual({from:h.configuration.fromAddress,to:[h.input.recipient]});
      expect(m.attachments).toHaveLength(3);
      for(const original of h.originals){const a=m.attachments.find((x:any)=>x.filename===original.fileName);
        expect(a.content).toEqual(original.bytes);expect(a.headers['X-Content-Sha256']).toBe(emailHash(original.bytes));}
      return {messageId:m.messageId,accepted:[m.to],rejected:[],response:'250 2.0.0 queued'};
    });
    expect(await h.assemble().run(created.id)).toMatchObject({state:'SMTP_ACCEPTED',deliveredToClient:false,fiscalAuthority:false});
    expect(await h.create()).toMatchObject({id:created.id,replayed:true,state:'SMTP_ACCEPTED'});
    await h.assemble().run(created.id);expect(h.sendMail).toHaveBeenCalledTimes(1);expect(h.mailer.close).toHaveBeenCalledOnce();
    expect(h.store.disk.events.map(e=>e.type)).toEqual(['CREATED','ATTEMPT_STARTED','SMTP_ACCEPTED']);
    expect(h.configurations.read).toHaveBeenCalledWith({companyId:1,ruc:h.binding.issuerRuc});
    expect(h.vault.open).toHaveBeenCalledWith(h.row.configurationCipher,{companyId:1,ruc:h.binding.issuerRuc,field:'configuration'});
    expect(h.buffers.every(b=>b.every(n=>n===0))).toBe(true);
    const disk=JSON.stringify(h.store.disk),view=JSON.stringify(await h.app.engine.execute({token:'synthetic-token',kind:'SERVICE'},'READ',{id:created.id}));
    for(const secret of ['fictional-password','synthetic-user','synthetic-token','v1.1.synthetic'])expect(disk).not.toContain(secret);
    expect(view).not.toContain(h.input.recipient);expect(view).not.toContain('configurationSnapshotId');
  });
  it.each(['grant','client','applicationRevision','userRevision','scope','ruc','branch','point','series','type'])('honors live revocation/change: %s',async change=>{
    const h=fixture();h.p.kind='USER';h.p.subjectId=randomUUID();h.p.userAuthRevision=1;const j=await h.create();
    if(change==='grant')h.permission.authorizeRealSendCurrent.mockResolvedValue(null);
    if(change==='client')h.p.clientId=randomUUID();if(change==='applicationRevision')h.p.revision++;
    if(change==='userRevision')h.p.userAuthRevision++;if(change==='scope')h.p.scopes=h.p.scopes.filter(s=>s!=='b2b:artifacts:read');
    const b=h.p.bindings[0];if(change==='ruc')b.issuerRuc='20000000002';if(change==='branch')b.branchId=randomUUID();
    if(change==='point')b.pointId=randomUUID();if(change==='series')b.seriesId=randomUUID();if(change==='type')b.documentType='03';
    await expect(h.app.run(j.id)).rejects.toBeInstanceOf(B2bSecurityError);
    expect(h.sendMail).not.toHaveBeenCalled();expect(h.store.disk.jobs[0].state).toBe('QUEUED');
  });
  it.each(['revision','cipher','grantRevision'])('rejects changed pinned %s before claiming an attempt',async change=>{
    const h=fixture(),j=await h.create();
    if(change==='revision')h.row.revision++;if(change==='cipher')h.row.configurationCipher='v1.1.synthetic.ciphertext.two';if(change==='grantRevision')h.grant.grantRevision++;
    await expect(h.app.run(j.id)).rejects.toMatchObject({code:'EMAIL_SMTP_CONFIGURATION_CHANGED'});
    expect(h.store.disk.events.map(e=>e.type)).toEqual(['CREATED']);expect(h.network.createTransport).not.toHaveBeenCalled();
  });
  it.each(['absent','removed','credentials','issuer','cipher'])('fails closed for configuration %s',async change=>{
    const h=fixture();
    if(change==='absent')h.configurations.read.mockResolvedValue(null);
    if(change==='removed')h.vault.open.mockImplementation(()=>Buffer.from('{"removed":true}'));
    if(change==='credentials')h.configuration.password='';if(change==='issuer')h.row.ruc='20000000002';
    if(change==='cipher')h.vault.open.mockImplementation(()=>{throw Error('private decrypt detail');});
    await expect(h.create()).rejects.toMatchObject({code:'EMAIL_SMTP_CONFIGURATION_UNAVAILABLE'});
    expect(h.network.createTransport).not.toHaveBeenCalled();expect(h.store.disk.jobs).toHaveLength(0);
  });
  it('keeps missing CDR pending; the same authorized job can obtain its original later',async()=>{
    const h=fixture(),cdr=h.proof.originals.pop()!,j=await h.create();expect(j.state).toBe('WAITING_ARTIFACTS');
    expect(await h.app.run(j.id)).toMatchObject({state:'WAITING_ARTIFACTS'});expect(h.sendMail).not.toHaveBeenCalled();
    h.proof.originals.push(cdr);expect(await h.app.run(j.id)).toMatchObject({state:'SMTP_ACCEPTED'});
  });
  it.each(['permission','configuration','identity','original','presentation'])('rechecks %s after DNS before opening SMTP',async change=>{
    const h=fixture(),j=await h.create();
    h.network.resolve.mockImplementation(async()=>{
      if(change==='permission')h.permission.authorizeRealSendCurrent.mockResolvedValue(null);
      if(change==='configuration')h.row.revision++;if(change==='identity')h.p.revision++;
      if(change==='original')h.originals[0].bytes[0]=0;if(change==='presentation')h.proof.presentationRevision='pdf-v2';
      return ['8.8.8.8'];
    });
    expect(await h.app.run(j.id)).toMatchObject({state:'UNKNOWN',errorCode:'SMTP_OUTCOME_UNKNOWN'});
    expect(h.network.createTransport).not.toHaveBeenCalled();
    if(change==='identity')await expect(h.app.run(j.id)).rejects.toMatchObject({code:'ACCESS_CHANGED'});
    else await h.app.run(j.id);
    expect(h.sendMail).not.toHaveBeenCalled();
  });
  it('checks CAS again after constructing the lazy transport and always closes it',async()=>{
    const h=fixture(),j=await h.create();h.network.createTransport.mockImplementation(()=>{h.row.revision++;return h.mailer;});
    expect(await h.app.run(j.id)).toMatchObject({state:'UNKNOWN'});
    expect(h.sendMail).not.toHaveBeenCalled();expect(h.mailer.close).toHaveBeenCalledOnce();
  });
  it.each(['permission','identity'])('checks final %s revocation after the lazy transport factory',async change=>{
    const h=fixture(),j=await h.create();h.network.createTransport.mockImplementation(()=>{
      if(change==='permission')h.permission.authorizeRealSendCurrent.mockResolvedValue(null);else h.p.revision++;
      return h.mailer;
    });
    expect(await h.app.run(j.id)).toMatchObject({state:'UNKNOWN'});
    expect(h.sendMail).not.toHaveBeenCalled();expect(h.mailer.close).toHaveBeenCalledOnce();
  });
  it('rolls back failed creation/claim audit before any SMTP factory or network call',async()=>{
    const h=fixture();h.store.failAudit=true;
    await expect(h.create()).rejects.toMatchObject({code:'EMAIL_STORE_UNAVAILABLE'});expect(h.store.disk.jobs).toHaveLength(0);
    h.store.failAudit=false;const j=await h.create();h.store.failAudit=true;
    await expect(h.app.run(j.id)).rejects.toMatchObject({code:'EMAIL_STORE_UNAVAILABLE'});
    expect(h.store.disk.jobs[0].state).toBe('QUEUED');expect(h.network.resolve).not.toHaveBeenCalled();expect(h.network.createTransport).not.toHaveBeenCalled();
  });
  it.each(['throw','partial','pending','wrongId','not250'])('makes ambiguous SMTP %s terminal without automatic resend',async outcome=>{
    const h=fixture(),j=await h.create();h.sendMail.mockImplementation(async m=>{
      if(outcome==='throw')throw Error('fictional-password recipient@example.invalid');
      return {messageId:outcome==='wrongId'?'other':m.messageId,accepted:[m.to],rejected:outcome==='partial'?[m.to]:[],
        ...(outcome==='pending'?{pending:[m.to]}:{}),response:outcome==='not250'?'451 deferred':'250 queued'};
    });
    expect(await h.app.run(j.id)).toMatchObject({state:'UNKNOWN',errorCode:'SMTP_OUTCOME_UNKNOWN'});
    await h.assemble().run(j.id);await h.create();expect(h.sendMail).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.store.disk.events)).not.toContain('fictional-password');
  });
  it('recovers crash after SMTP acceptance and before final audit as UNKNOWN without sending again',async()=>{
    const h=fixture(),j=await h.create();h.sendMail.mockImplementation(async m=>{
      h.store.failAudit=true;return {messageId:m.messageId,accepted:[m.to],rejected:[],response:'250 queued'};
    });
    await expect(h.app.run(j.id)).rejects.toMatchObject({code:'EMAIL_STORE_UNAVAILABLE'});
    expect(h.store.disk.jobs[0].state).toBe('DISPATCHING');h.store.failAudit=false;
    expect(await h.assemble().run(j.id)).toMatchObject({state:'UNKNOWN'});expect(h.sendMail).toHaveBeenCalledOnce();
  });
  it('does not send if a competing worker recovers DISPATCHING while DNS is outstanding',async()=>{
    const h=fixture(),j=await h.create();let entered!:()=>void,release!:()=>void;
    const ready=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
    h.network.resolve.mockImplementation(async()=>{entered();await blocked;return ['8.8.8.8'];});
    const running=h.app.run(j.id);await ready;
    expect(await h.assemble().run(j.id)).toMatchObject({state:'UNKNOWN'});release();
    expect(await running).toMatchObject({state:'UNKNOWN'});expect(h.sendMail).not.toHaveBeenCalled();
    expect(h.store.disk.events.filter(e=>e.type==='ATTEMPT_STARTED')).toHaveLength(1);
  });
  it('keeps an in-flight SMTP race UNKNOWN even when the first sender later receives acceptance',async()=>{
    const h=fixture(),j=await h.create();let entered!:()=>void,release!:()=>void;
    const ready=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
    h.sendMail.mockImplementation(async m=>{entered();await blocked;return {messageId:m.messageId,accepted:[m.to],rejected:[],response:'250 queued'};});
    const running=h.app.run(j.id);await ready;
    expect(await h.assemble().run(j.id)).toMatchObject({state:'UNKNOWN'});release();
    expect(await running).toMatchObject({state:'UNKNOWN'});await h.app.run(j.id);expect(h.sendMail).toHaveBeenCalledOnce();
  });
  it('accepts PostgreSQL JSONB key reordering while preserving actor/configuration/attachment comparisons',async()=>{
    const h=fixture(),j=await h.create();
    h.store.disk=JSON.parse(JSON.stringify(h.store.disk,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>b.localeCompare(a))) : value));
    expect(await h.app.run(j.id)).toMatchObject({state:'SMTP_ACCEPTED'});expect(h.sendMail).toHaveBeenCalledOnce();
  });
  it('serializes duplicate creates and rejects changed recipient or LOCAL_CAPTURE job reuse',async()=>{
    const h=fixture(),[a,b]=await Promise.all([h.create(),h.create()]);expect(a.id).toBe(b.id);expect(h.store.disk.jobs).toHaveLength(1);
    await expect(h.create({...h.input,recipient:'other@example.invalid'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    h.store.disk.jobs[0].profile='LOCAL_CAPTURE';await expect(h.create()).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  });
});

describe('CORPORATE mandatory SMTP security with fake network only',()=>{
  it('supports only an exact TI-approved RFC1918 intranet relay while preserving hostname and TLS checks',async()=>{
    const host='smtp.corporate.example.org',h=fixture({enabled:true,realSendEnabled:true,profile:'CORPORATE',approvedHosts:[host],privateRelays:[{host,address:'10.50.0.25'}]});
    h.network.resolve.mockResolvedValue(['10.50.0.25']);const j=await h.create();expect(await h.app.run(j.id)).toMatchObject({state:'SMTP_ACCEPTED'});
    expect(h.network.createTransport).toHaveBeenCalledWith(expect.objectContaining({host:'10.50.0.25',requireTLS:true,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2',servername:host}}));
    for(const address of ['10.50.0.26','127.0.0.1','169.254.169.254'])expect(()=>corporateEmailSmtpOptions(h.configuration,[host],address,[{host,address:'10.50.0.25'}])).toThrow('EMAIL_SMTP_POLICY');
    expect(()=>corporateEmailSmtpOptions(h.configuration,[host],'10.50.0.25',[{host:'other.example.org',address:'10.50.0.25'}])).toThrow('EMAIL_SMTP_POLICY');
  });
  it('does not unlock the existing proprietary SMTP verify/send provider',async()=>{
    const prepared=new PreparedCorporateSmtp();
    await expect(prepared.verify()).rejects.toMatchObject({status:423});
    await expect(prepared.send()).rejects.toMatchObject({status:423});
  });
  it.each([465,587])('pins public IP with verified hostname and mandatory TLS on %s',async port=>{
    const h=fixture();h.configuration.port=port as 465|587;h.configuration.tlsMode=port===465?'TLS':'STARTTLS';
    const j=await h.create();await h.app.run(j.id);
    expect(h.network.createTransport).toHaveBeenCalledWith(expect.objectContaining({host:'8.8.8.8',port,secure:port===465,
      requireTLS:true,ignoreTLS:false,opportunisticTLS:false,pool:false,disableFileAccess:true,disableUrlAccess:true,
      tls:{rejectUnauthorized:true,minVersion:'TLSv1.2',servername:'smtp.corporate.example.org'}}));
  });
  it.each(['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.0.1','100.64.0.1','0.0.0.0','::1','::ffff:127.0.0.1','203.0.113.1'])('blocks resolved private/reserved address %s',async address=>{
    const h=fixture(),j=await h.create();h.network.resolve.mockResolvedValue([address]);
    expect(await h.app.run(j.id)).toMatchObject({state:'UNKNOWN'});expect(h.network.createTransport).not.toHaveBeenCalled();
  });
  it('rejects mixed DNS answers, DNS failure and no implicit approved hosts',async()=>{
    for(const addresses of [[],['8.8.8.8','127.0.0.1']]){
      const h=fixture(),j=await h.create();h.network.resolve.mockResolvedValue(addresses);
      expect(await h.app.run(j.id)).toMatchObject({state:'UNKNOWN'});expect(h.sendMail).not.toHaveBeenCalled();
    }
    const h=fixture(),j=await h.create();h.network.resolve.mockRejectedValue(Error('DNS failure'));
    expect(await h.app.run(j.id)).toMatchObject({state:'UNKNOWN'});expect(h.sendMail).not.toHaveBeenCalled();
    const disabled=fixture({enabled:true,realSendEnabled:true,profile:'CORPORATE'});
    await expect(disabled.create()).rejects.toMatchObject({code:'EMAIL_SMTP_POLICY'});
  });
  it.each(['wrongHost','ip','url','wildcard','local','port25','tlsMismatch','starttlsMismatch'])('rejects SMTP policy %s',change=>{
    const h=fixture(),config={...h.configuration};
    if(change==='wrongHost')config.host='unapproved.example.org';if(change==='ip')config.host='8.8.8.8';
    if(change==='url')config.host='https://smtp.corporate.example.org';if(change==='wildcard')config.host='*.example.org';
    if(change==='local')config.host='smtp.internal';if(change==='port25')(config as any).port=25;
    if(change==='tlsMismatch')config.tlsMode='TLS';if(change==='starttlsMismatch')config.port=465;
    expect(()=>corporateEmailSmtpOptions(config,['smtp.corporate.example.org'],'8.8.8.8')).toThrow('EMAIL_SMTP_POLICY');
  });
});

describe('CORPORATE PostgreSQL adapter with fake SQL only',()=>{
  it('uses a separate marker and tables, parameterized CAS and atomic audit without touching local schema',async()=>{
    const calls:{sql:string;values?:unknown[]}[]=[],db={query:vi.fn(async(sql:string,values?:unknown[])=>{
      calls.push({sql,values});return {rows:sql.includes('SELECT version')?[{version:'factuez.b2b.email-deliveries.corporate.v1'}]:[],rowCount:1};
    }),release:vi.fn()};
    const pool={connect:vi.fn(async()=>db),end:vi.fn()},store=new PostgresEmailDeliveryStore(pool,{enabled:true,profile:'CORPORATE'});
    expect(pool.connect).not.toHaveBeenCalled();const h=fixture(),j=await h.create(),job=h.store.disk.jobs[0];
    await store.transaction(['email:job:'+j.id],async tx=>{await tx.job(j.id);await tx.prior(job.actorKey,job.keyHash);
      await tx.insert(job);await tx.save({...job,revision:2},1);await tx.append(h.store.disk.events[0]);});
    expect(calls.some(c=>c.sql.includes('"B2bEmailDelivery'))).toBe(false);
    expect(calls.some(c=>c.sql.includes('"B2bCorporateEmailDeliveryEvent"'))).toBe(true);
    const cas=calls.find(c=>c.sql.startsWith('UPDATE'))!;
    expect(cas.sql).toContain('AND revision=$5');expect(cas.values?.[4]).toBe(1);expect(calls.at(-1)?.sql).toBe('COMMIT');
    await store.close();expect(pool.end).not.toHaveBeenCalled();
  });
  it('rejects a local schema marker before dispatch and preserves typed corporate failures on rollback',async()=>{
    let marker='factuez.b2b.email-deliveries.v1';
    const db={query:vi.fn(async(sql:string)=>({rows:sql.includes('SELECT version')?[{version:marker}]:[],rowCount:0})),release:vi.fn()};
    const store=new PostgresEmailDeliveryStore({connect:async()=>db,end:async()=>{}},{enabled:true,profile:'CORPORATE'});
    await expect(store.transaction([],async()=>1)).rejects.toMatchObject({code:'EMAIL_STORE_UNAVAILABLE'});
    marker='factuez.b2b.email-deliveries.corporate.v1';
    await expect(store.transaction([],async()=>{throw new B2bSecurityError(409,'EMAIL_SMTP_CONFIGURATION_CHANGED');})).rejects.toMatchObject({code:'EMAIL_SMTP_CONFIGURATION_CHANGED'});
    expect(db.query).toHaveBeenLastCalledWith('ROLLBACK');
  });
});
