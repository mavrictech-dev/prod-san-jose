import { describe,it,expect,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { draftFixture,draftInput } from './b2b-drafts.fixture';
import { ctx } from './b2b-identity.fixture';
import { invoiceBinding } from './b2b-read.fixture';
import { fixture,id as uuid } from './b2b-identity.fixture';
import { B2bEnabledIdentityScopes } from '../packages/contracts/src/b2b-security';
const key='synthetic_command_0001';
const create=async(f:Awaited<ReturnType<typeof draftFixture>>)=>f.core.command(f.token,'SERVICE','CREATE',null,key,undefined,draftInput());
describe('B2B-04 draft lifecycle, transactional command recovery, no issuance',()=>{
  it('creates a typed SERVICE draft, no human impersonation or fiscal numbering',async()=>{
    const f=await draftFixture(),r=await create(f),d=r.response as any;
    expect(d).toMatchObject({state:'DRAFT',revision:'"v1"',validatedRevision:null,context:invoiceBinding});expect(d).not.toHaveProperty('number');expect(d).not.toHaveProperty('xml');
    expect(r.operation).toMatchObject({state:'SUCCEEDED',action:'CREATE',resourceId:d.id,fiscalAcceptance:'NOT_ASSERTED'});
    const stored=[...f.store.operations.values()][0];expect(stored.actor).toMatchObject({kind:'SERVICE',subjectId:null});expect(JSON.stringify(stored)).not.toContain(f.token);
  });
  it('concurrent repeats produce exactly one draft/operation and recover a lost response',async()=>{
    const f=await draftFixture(),results=await Promise.all(Array.from({length:8},()=>create(f)));
    expect(f.store.rows.size).toBe(1);expect(f.store.operations.size).toBe(1);expect(new Set(results.map(r=>r.operation.operationId)).size).toBe(1);expect(results.filter(r=>!r.replayed)).toHaveLength(1);
    expect(await f.core.operation(f.token,'SERVICE',null,key)).toEqual(results[0].operation);
    expect(await f.core.operation(f.token,'SERVICE',results[0].operation.operationId)).toEqual(results[0].operation);
  });
  it('same key with different content conflicts without modifying original',async()=>{
    const f=await draftFixture();await create(f);const b=draftInput();b.customer.legalName='OTRO FICTICIO';
    await expect(f.core.command(f.token,'SERVICE','CREATE',null,key,undefined,b)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});expect(f.store.rows.size).toBe(1);
  });
  it('duplicate external origin with a new idempotency key is not another sale/draft',async()=>{
    const f=await draftFixture();await create(f);await expect(f.core.command(f.token,'SERVICE','CREATE',null,key+'2',undefined,draftInput())).rejects.toMatchObject({code:'DRAFT_REFERENCE_CONFLICT'});expect(f.store.rows.size).toBe(1);
  });
  it('optimistic edit invalidates validation and only one racing revision commits',async()=>{
    const f=await draftFixture(),made=await create(f),id=(made.response as any).id;
    const validated=await f.core.command(f.token,'SERVICE','VALIDATE',id,key+'v','"v1"',{});expect(validated.response).toMatchObject({valid:true,revision:'"v2"',fiscalActivation:false,totals:{payableAmount:'118.00'}});
    const changed=await Promise.allSettled(['a','b'].map(s=>f.core.command(f.token,'SERVICE','PATCH',id,key+s,'"v2"',{customer:{...draftInput().customer,legalName:'FICTICIO '+s}})));
    expect(changed.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await f.core.read(f.token,'SERVICE',id)).toMatchObject({revision:'"v3"',validatedRevision:null});
  });
  it('cancelled draft is immutable and retries still replay the original cancellation',async()=>{
    const f=await draftFixture(),made=await create(f),id=(made.response as any).id;
    const cancelled=await f.core.command(f.token,'SERVICE','CANCEL',id,key+'c','"v1"',{});expect(cancelled.response).toMatchObject({state:'CANCELLED',revision:'"v2"'});
    expect((await f.core.command(f.token,'SERVICE','CANCEL',id,key+'c','"v1"',{})).operation).toEqual(cancelled.operation);
    await expect(f.core.command(f.token,'SERVICE','PATCH',id,key+'p','"v2"',{issueDate:'2026-10-21'})).rejects.toMatchObject({code:'DRAFT_IMMUTABLE'});
  });
  it('failed operation/audit rolls back draft and retry becomes the first commit',async()=>{
    const f=await draftFixture();f.store.failAppend=true;await expect(create(f)).rejects.toMatchObject({code:'DRAFT_STORE_UNAVAILABLE'});expect(f.store.rows.size).toBe(0);expect(f.store.operations.size).toBe(0);
    f.store.failAppend=false;expect((await create(f)).replayed).toBe(false);
  });
  it('revocation before commit rolls back changes; replay also reauthorizes',async()=>{
    const f=await draftFixture();let calls=0;const original=f.identity.authenticate.getMockImplementation()!;
    f.identity.authenticate.mockImplementation(async(...args)=>{if(++calls===2)await f.auth.core.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());return original(...args);});
    await expect(create(f)).rejects.toMatchObject({status:401});expect(f.store.rows.size).toBe(0);
    const g=await draftFixture();await create(g);await g.auth.core.change('human-step-up',g.made.client.id,{expectedRevision:1,enabled:false},ctx());await expect(create(g)).rejects.toMatchObject({status:401});
  });
  it('canonical context is rechecked; foreign client cannot recover another operation',async()=>{
    const f=await draftFixture(),made=await create(f);f.context.resolve.mockResolvedValueOnce(null as any);
    await expect(f.core.read(f.token,'SERVICE',(made.response as any).id)).rejects.toMatchObject({status:404});
    const other=await draftFixture();other.store.rows=f.store.rows;other.store.operations=f.store.operations;
    await expect(other.core.operation(other.token,'SERVICE',made.operation.operationId)).rejects.toMatchObject({status:404});
  });
  it('issue stays closed without an explicitly bound transactional issuer',async()=>{
    const f=await draftFixture(true);f.store.issuance=false;const r=await create(f);
    await expect(f.core.command(f.token,'SERVICE','ISSUE',(r.response as any).id,key+'i','"v1"',{})).rejects.toMatchObject({code:'PROFILE_NOT_ENABLED'});expect(f.store.fiscal.nextNumber).toBe(1);
  });
  it('delegated USER needs document.issue, while read-only staff cannot write drafts',async()=>{
    const user:any={clientId:uuid(99),clientRevision:1,oidcClientId:'synthetic-portal',userId:uuid(9),authRevision:1,tokenScopes:['b2b:context:read','b2b:drafts:write','b2b:operations:read'],permissions:['document.view'],scope:{kind:'GLOBAL'}};
    const auth=fixture({verify:async()=>structuredClone(user)},B2bEnabledIdentityScopes);
    const made=await auth.core.create('human-step-up',{label:'Synthetic delegated client',kind:'USER',oidcClientId:user.oidcClientId,scopes:user.tokenScopes,bindings:[invoiceBinding]},ctx());user.clientId=made.client.id;
    await expect(auth.core.authenticate('synthetic-oidc-token',['b2b:drafts:write'],ctx(),'USER')).rejects.toMatchObject({status:403});
    user.permissions.push('document.issue');expect((await auth.core.authenticate('synthetic-oidc-token',['b2b:drafts:write'],ctx(),'USER')).subjectId).toBe(user.userId);
    user.permissions=['document.view'];await expect(auth.core.authenticate('synthetic-oidc-token',['b2b:operations:read'],ctx(),'USER')).rejects.toMatchObject({status:403});
  });
  it.each([
    {environment:'PRODUCTION'},{documentType:'31'},{issuerId:2},{seriesId:'../private'},{paymentTerms:'CREDITO'},{number:1},{userId:'administrator'},{customer:{...draftInput().customer,identityType:'1'}},
    {lines:[{...draftInput().lines[0],taxAffectationCode:'20'}]}, {lines:[{...draftInput().lines[0],discountAmount:'1'}]}, {issueDate:'2026-02-30'},
  ])('rejects unsupported authority/profile before persistence %j',async patch=>{
    const f=await draftFixture();await expect(f.core.command(f.token,'SERVICE','CREATE',null,key,undefined,{...draftInput(),...patch})).rejects.toBeDefined();expect(f.store.rows.size).toBe(0);
  });
  it('requires strong If-Match and refuses moving fiscal context or editing origin',async()=>{
    const f=await draftFixture(),r=await create(f),id=(r.response as any).id;
    await expect(f.core.command(f.token,'SERVICE','PATCH',id,key+'p',undefined,{issueDate:'2026-10-21'})).rejects.toMatchObject({status:428});
    for(const patch of [{issuerId:2},{externalReference:{namespace:'other',value:'x'}},{seriesId:invoiceBinding.seriesId}])await expect(f.core.command(f.token,'SERVICE','PATCH',id,key+'p','"v1"',patch)).rejects.toMatchObject({code:'INVALID_DRAFT_PATCH'});
  });
  it('candidate schema and adapter cannot reach fiscal counters, original artifacts or legacy outbox',()=>{
    const code=readFileSync(new URL('../services/billing-service/src/b2b/draft-store.ts',import.meta.url),'utf8');
    for(const name of ['SeriesCounter','OutboxEvent','"Document"','storageKey','clientSecret'])expect(code).not.toContain(name);
    expect(code).toContain('pg_advisory_xact_lock');expect(code).not.toMatch(/SELECT \*/);
  });
});
