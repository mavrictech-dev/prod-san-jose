import { describe, expect, it, vi } from 'vitest';
import { B2bIntegrationAdmin, HttpB2bIntegrationAdminOwner, B2bIntegrationAdminModule } from '../services/b2b-api-service/src/integration-admin';
import { B2bSecurityError } from '../packages/contracts/src/b2b-security';
import { adminFixture, input, ctx, id, binding, basic } from './b2b-integration-admin.fixture';
const q = { environment: 'BETA' };
const human = 'human-step-up';

describe('SOURCE LOCAL/BETA delegated application administration', () => {
  it('creates once, reads metadata, relabels, rotates and invalidates prior credentials', async () => {
    const f = adminFixture(), made: any = await f.facade.create(human,q,input());
    expect(made).toMatchObject({ source:'SOURCE', environment:'BETA', candidateOnly:true, application:{ revision:1 } });
    expect(made.clientSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const appId = made.application.id;
    const token = await f.core.token(basic(appId,made.clientSecret),{grant_type:'client_credentials',scope:'b2b:context:read'},ctx());
    const changed: any = await f.facade.update(human,appId,q,{expectedRevision:1,label:'  Renamed app  ',enabled:false});
    expect(changed.application).toMatchObject({label:'Renamed app',enabled:false,revision:2});
    expect(changed).not.toHaveProperty('clientSecret');
    const rotated: any = await f.facade.rotate(human,appId,q,{expectedRevision:2});
    expect(rotated.application.revision).toBe(3); expect(rotated.clientSecret).not.toBe(made.clientSecret);
    const read: any = await f.facade.read(human,appId,q); const page = await f.facade.list(human,q);
    for (const v of [read,page,changed,f.store.audits]) {
      expect(JSON.stringify(v)).not.toMatch(/secretHash|password|clientSecret/);
      expect(JSON.stringify(v)).not.toContain(made.clientSecret);
      expect(JSON.stringify(v)).not.toContain(rotated.clientSecret);
    }
    await expect(f.core.authenticate(token.access_token,[],ctx())).rejects.toMatchObject({status:401});
    await expect(f.core.token(basic(appId,made.clientSecret),{grant_type:'client_credentials',scope:'b2b:context:read'},ctx())).rejects.toMatchObject({status:401});
    expect(f.store.audits.map(a=>a.action)).toEqual(expect.arrayContaining(['CREATE','UPDATE','ROTATE','READ_METADATA','LIST_METADATA']));
    expect(f.store.audits.filter(a=>a.actorId).every(a=>a.actorId===id(9)&&a.peerHash.length===64)).toBe(true);
  });
  it('pages deterministically without missing or duplicating disabled applications', async () => {
    const f = adminFixture();
    for (let n=1;n<=3;n++) { const made = await f.core.create(human,input(),ctx()); const row=f.store.clients.get(made.client.id)!;f.store.clients.delete(row.id);row.id=id(n+20);row.enabled=n!==2;f.store.clients.set(row.id,row); }
    const first: any = await f.facade.list(human,{...q,limit:'2'});
    expect(first.items.map((v:any)=>v.id)).toEqual([id(21),id(22)]);expect(first.nextAfter).toBe(id(22));
    const second: any = await f.facade.list(human,{...q,limit:'2',after:first.nextAfter});
    expect(second.items.map((v:any)=>v.id)).toEqual([id(23)]);expect(second.nextAfter).toBeNull();
    expect((await f.facade.list(human,{...q,after:id(99)})) as any).toMatchObject({items:[],nextAfter:null});
  });
  it.each(['CREATE','UPDATE','ROTATE'] as const)('rolls back %s plus audit if human/step-up is revoked after write', async action => {
    for (const hook of ['onWrite','onAudit'] as const) {
      const f=adminFixture(),made=await f.core.create(human,input(),ctx()),before=structuredClone(f.store.clients),audits=structuredClone(f.store.audits);
      f.store[hook]=()=>{f.state.stepUp=false;};
      const operation=action==='CREATE'?f.core.create(human,input(),ctx()):f.core.change(human,made.client.id,action==='UPDATE'?{expectedRevision:1,label:'unsafe commit'}:{expectedRevision:1},ctx(),action==='ROTATE');
      await expect(operation).rejects.toMatchObject({status:403});expect(f.store.clients).toEqual(before);expect(f.store.audits).toEqual(audits);
    }
  });
  it('revalidates actor identity after catalogue/lock waits before writing', async () => {
    const f=adminFixture();f.catalogue.validate.mockImplementation(async()=>{f.state.active=false;});
    await expect(f.core.create(human,input(),ctx())).rejects.toMatchObject({status:403});expect(f.store.clients.size).toBe(0);
    const g=adminFixture(),made=await g.core.create(human,input(),ctx());g.store.onGet=()=>{g.state.actorId=id(88);};
    await expect(g.core.change(human,made.client.id,{expectedRevision:1,enabled:false},ctx())).rejects.toMatchObject({status:403});expect(g.store.clients.get(made.client.id)?.revision).toBe(1);
  });
  it('suppresses reads/list results when authority changes during audit', async () => {
    for(const list of [true,false]) { const f=adminFixture(),made=await f.core.create(human,input(),ctx());const count=f.store.audits.length;f.store.onAudit=()=>{f.state.active=false;};
      await expect(list?f.core.list(human,q,ctx()):f.core.read(human,made.client.id,ctx())).rejects.toMatchObject({status:403});expect(f.store.audits).toHaveLength(count); }
  });
  it('rolls back when audit/current admin is unavailable and never bypasses quotas', async () => {
    const f=adminFixture();f.store.failAudit=true;await expect(f.core.create(human,input(),ctx())).rejects.toMatchObject({status:503});expect(f.store.clients.size).toBe(0);
    const g=adminFixture();g.state.down=true;await expect(g.core.list(human,q,ctx())).rejects.toMatchObject({code:'ADMIN_AUTHORITY_UNAVAILABLE'});
    const h=adminFixture();for(let n=0;n<30;n++)await h.core.list(human,q,ctx());await expect(h.core.list(human,q,ctx())).rejects.toMatchObject({status:429});h.advance(60000);expect(await h.core.list(human,q,ctx())).toMatchObject({items:[]});
  });
  it('revision checks serialize competing writes and reject overflow/empty updates', async () => {
    const f=adminFixture(),made=await f.core.create(human,input(),ctx());
    const outcomes=await Promise.allSettled(['first','second'].map(label=>f.core.change(human,made.client.id,{expectedRevision:1,label},ctx())));
    expect(outcomes.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect(outcomes.find(v=>v.status==='rejected')).toMatchObject({reason:{status:409}});
    for(const body of [{expectedRevision:2},{expectedRevision:2147483647,label:'bad'},{expectedRevision:'2',enabled:false},{expectedRevision:2,label:'\n'}])await expect(f.facade.update(human,made.client.id,q,body)).rejects.toMatchObject({status:400});
  });
  it('USER applications never issue secrets and cannot rotate or impersonate admin', async () => {
    const f=adminFixture(),made:any=await f.facade.create(human,q,{...input(),kind:'USER',oidcClientId:'portal'});
    expect(made).not.toHaveProperty('clientSecret');await expect(f.facade.rotate(human,made.application.id,q,{expectedRevision:1})).rejects.toMatchObject({code:'CLIENT_KIND_NOT_ALLOWED'});
    const service=await f.core.create(human,input(),ctx()),issued=await f.core.token(basic(service.client.id,service.clientSecret!),{grant_type:'client_credentials',scope:'b2b:context:read'},ctx());
    await expect(f.facade.list(issued.access_token,q)).rejects.toMatchObject({status:403});
  });
  it.each([{}, {environment:'PRODUCTION'}, {...q,limit:'0'}, {...q,limit:'51'}, {...q,limit:'01'}, {...q,limit:['2','3']}, {...q,after:'bad'}, {...q,issuerId:'1'}, {...q,roles:['ADMIN']}])('rejects invalid query without contacting owner: %j', async bad => {
    const f=adminFixture();await expect(f.facade.list(human,bad)).rejects.toMatchObject({status:400});expect(f.owner.execute).not.toHaveBeenCalled();
  });
  it.each(['password','secretHash','clientSecret','roles','permissions','actor','scope','environment'])('rejects authority or credential injection: %s', async field => {
    const f=adminFixture();await expect(f.facade.create(human,q,{...input(),[field]:'fake'})).rejects.toMatchObject({status:400});expect(f.owner.execute).not.toHaveBeenCalled();
  });
  it('rejects non-list pagination and missing BETA on every operation', async () => {
    const f=adminFixture();for(const operation of [f.facade.read(human,id(1),{}),f.facade.create(human,{},input()),f.facade.update(human,id(1),{...q,limit:'1'},{expectedRevision:1,enabled:false}),f.facade.rotate(human,id(1),{},{expectedRevision:1})])await expect(operation).rejects.toMatchObject({status:400});
    expect(f.owner.execute).not.toHaveBeenCalled();
  });
  it('does not invoke owner getters or return a hash, password, extra field, wrong id or secret on metadata', async () => {
    const f=adminFixture(),made=await f.core.create(human,input(),ctx()),meta=made.client;
    for(const result of [{...meta,secretHash:'x'}, {...meta,password:'x'}, {...meta,id:id(77)}, {...meta,bindings:[{...binding,environment:'PRODUCTION'}]}, {get id(){throw new Error('getter must not execute');}}]) {
      const owner={execute:vi.fn(async()=>result)},api=new B2bIntegrationAdmin(owner);await expect(api.read(human,meta.id,q)).rejects.toMatchObject({status:503});
    }
    for(const result of [{client:meta,clientSecret:'x'.repeat(43)},{client:{...meta,revision:2}},{client:meta,clientSecret:'x'.repeat(43),password:'x'}]) {
      const api=new B2bIntegrationAdmin({execute:async()=>result});await expect(api.update(human,meta.id,q,{expectedRevision:1,enabled:false})).rejects.toMatchObject({status:503});
    }
  });
  it('rejects invalid pagination, kind and mutation results from a misbehaving owner', async () => {
    const f=adminFixture(),made=await f.core.create(human,input(),ctx()),row=made.client;
    for(const value of [{items:[row,row],nextAfter:null},{items:[row],nextAfter:id(99)},{items:[{...row,kind:'ADMIN'}],nextAfter:null},{items:[row],nextAfter:row.id}])await expect(new B2bIntegrationAdmin({execute:async()=>value}).list(human,{...q,limit:2})).rejects.toMatchObject({status:503});
    await expect(new B2bIntegrationAdmin({execute:async()=>({client:row})}).create(human,q,input())).rejects.toMatchObject({status:503});
    await expect(new B2bIntegrationAdmin({execute:async()=>({client:{...row,revision:2},clientSecret:'bad'})}).rotate(human,row.id,q,{expectedRevision:1})).rejects.toMatchObject({status:503});
  });
  it('uses a single fixed POST RPC and forwards only the independent admin bearer', async () => {
    const post=vi.fn(async()=>({items:[],nextAfter:null})),owner=new HttpB2bIntegrationAdminOwner({post});
    await new B2bIntegrationAdmin(owner).list(human,{...q,limit:'7',after:id(1)});
    expect(post).toHaveBeenCalledExactlyOnceWith('/internal/b2b/integration-admin',{action:'LIST',args:{environment:'BETA',limit:7,after:id(1)}},human);
    post.mockRejectedValue(new B2bSecurityError(409,'OWNER_REQUEST_DENIED'));await expect(owner.execute(human,{action:'LIST',args:{environment:'BETA',limit:1}})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    expect(()=>B2bIntegrationAdminModule.isolated(new B2bIntegrationAdmin(owner),[])).toThrow();
    expect(()=>B2bIntegrationAdminModule.isolated(new B2bIntegrationAdmin(owner),['a'.repeat(64),'a'.repeat(64)])).toThrow();
  });
});
