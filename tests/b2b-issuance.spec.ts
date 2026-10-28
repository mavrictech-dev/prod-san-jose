import { describe,it,expect } from 'vitest';
import { draftFixture,draftInput } from './b2b-drafts.fixture';
import { ctx,fixture,id } from './b2b-identity.fixture';
import { invoiceBinding } from './b2b-read.fixture';
import { B2bEnabledIdentityScopes } from '../packages/contracts/src/b2b-security';
import { b2bDraftIssuer } from '../services/billing-service/src/b2b/issuance';
const key='issue_synthetic_command_001';
async function ready(){const f=await draftFixture(true),made=await f.core.command(f.token,'SERVICE','CREATE',null,key,undefined,draftInput()),draftId=(made.response as any).id;
  await f.core.command(f.token,'SERVICE','VALIDATE',draftId,key+'v','"v1"',{});return {...f,draftId};}
describe('B2B-04 validated issuance transaction orchestration',()=>{
  it('commits once under concurrent identical commands; recovery references the document, not the draft',async()=>{
    const f=await ready(),result=await Promise.all(Array.from({length:8},()=>f.core.command(f.token,'SERVICE','ISSUE',f.draftId,key+'i','"v2"',{})));
    expect(new Set(result.map(r=>r.operation.operationId)).size).toBe(1);expect(result.filter(r=>!r.replayed)).toHaveLength(1);
    expect(result[0].response).toMatchObject({state:'COMMITTED',fiscalAcceptance:'NOT_ASSERTED',number:'1',revision:'"v3"'});
    expect(result[0].operation).toMatchObject({state:'COMMITTED',resourceId:(result[0].response as any).documentId});
    expect(await f.core.operation(f.token,'SERVICE',null,key+'i')).toEqual(result[0].operation);
    expect(f.store.fiscal.nextNumber).toBe(2);expect(f.store.fiscal.documents).toHaveLength(1);
    expect(f.store.fiscal.documents[0].actor).toMatchObject({kind:'SERVICE',subjectId:null});
  });
  it('different keys cannot issue twice; issued drafts cannot be edited or cancelled',async()=>{
    const f=await ready();await f.core.command(f.token,'SERVICE','ISSUE',f.draftId,key+'i','"v2"',{});
    for(const action of ['ISSUE','CANCEL','PATCH'] as const)await expect(f.core.command(f.token,'SERVICE',action,f.draftId,key+action,'"v3"',action==='PATCH'?{issueDate:'2026-10-21'}:{})).rejects.toMatchObject({code:'DRAFT_IMMUTABLE'});
    expect(f.store.fiscal.nextNumber).toBe(2);
  });
  it('requires validation of the exact current revision and empty command body',async()=>{
    const f=await ready();await f.core.command(f.token,'SERVICE','PATCH',f.draftId,key+'p','"v2"',{issueDate:'2026-10-21'});
    await expect(f.core.command(f.token,'SERVICE','ISSUE',f.draftId,key+'i','"v3"',{})).rejects.toMatchObject({code:'DRAFT_VALIDATION_REQUIRED'});
    await expect(f.core.command(f.token,'SERVICE','ISSUE',f.draftId,key+'i','"v3"',{number:1})).rejects.toMatchObject({code:'EMPTY_COMMAND_REQUIRED'});
    expect(f.store.fiscal.nextNumber).toBe(1);
  });
  it('audit failure rolls back document, draft revision, operation and counter; retry is first commit',async()=>{
    const f=await ready();f.store.failAppend=true;
    await expect(f.core.command(f.token,'SERVICE','ISSUE',f.draftId,key+'i','"v2"',{})).rejects.toMatchObject({status:503});
    expect(f.store.fiscal.documents).toHaveLength(0);expect(f.store.fiscal.nextNumber).toBe(1);expect(f.store.rows.get(f.draftId)?.state).toBe('DRAFT');
    f.store.failAppend=false;expect((await f.core.command(f.token,'SERVICE','ISSUE',f.draftId,key+'i','"v2"',{})).replayed).toBe(false);
  });
  it('rechecks revocation after fiscal writes but before commit and rolls back everything',async()=>{
    const f=await ready();let calls=0;const original=f.identity.authenticate.getMockImplementation()!;
    f.identity.authenticate.mockImplementation(async(...args)=>{if(++calls===2)await f.auth.core.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());return original(...args);});
    await expect(f.core.command(f.token,'SERVICE','ISSUE',f.draftId,key+'i','"v2"',{})).rejects.toMatchObject({status:401});
    expect(f.store.fiscal.nextNumber).toBe(1);expect(f.store.fiscal.documents).toHaveLength(0);expect(f.store.rows.get(f.draftId)?.revision).toBe(2);
  });
  it('draft scope alone cannot issue; explicitly unbound owner remains closed',async()=>{
    const f=await draftFixture(),r=await f.core.command(f.token,'SERVICE','CREATE',null,key,undefined,draftInput());
    await expect(f.core.command(f.token,'SERVICE','ISSUE',(r.response as any).id,key+'i','"v1"',{})).rejects.toMatchObject({status:403});
    const g=await ready();g.store.issuance=false;await expect(g.core.command(g.token,'SERVICE','ISSUE',g.draftId,key+'i','"v2"',{})).rejects.toMatchObject({code:'PROFILE_NOT_ENABLED'});
  });
  it('a changed request using the issue key conflicts and cannot renumber',async()=>{
    const f=await ready();await f.core.command(f.token,'SERVICE','ISSUE',f.draftId,key+'i','"v2"',{});
    await expect(f.core.command(f.token,'SERVICE','ISSUE',f.draftId,key+'i','"v3"',{})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});expect(f.store.fiscal.nextNumber).toBe(2);
  });
  it('USER issue permission is not granted by document.view, and default identity policy never enables issuance',async()=>{
    const user:any={clientId:id(99),clientRevision:1,oidcClientId:'synthetic',userId:id(9),authRevision:1,
      tokenScopes:['b2b:drafts:write','b2b:documents:issue'],permissions:['document.view'],scope:{kind:'GLOBAL'}};
    const auth=fixture({verify:async()=>structuredClone(user)},B2bEnabledIdentityScopes);
    const made=await auth.core.create('human-step-up',{label:'Synthetic user',kind:'USER',oidcClientId:user.oidcClientId,scopes:user.tokenScopes,bindings:[invoiceBinding]},ctx());user.clientId=made.client.id;
    await expect(auth.core.authenticate('synthetic',['b2b:documents:issue'],ctx(),'USER')).rejects.toMatchObject({status:403});
    user.permissions.push('document.issue');expect((await auth.core.authenticate('synthetic',['b2b:documents:issue'],ctx(),'USER')).subjectId).toBe(user.userId);
    const closed=fixture();await expect(closed.core.create('human-step-up',{label:'No implicit issue',kind:'SERVICE',scopes:user.tokenScopes,bindings:[invoiceBinding]},ctx())).rejects.toMatchObject({code:'INVALID_SCOPE'});
  });
  it('adapter cannot be constructed without an explicit BETA profile and issuer allowlist',()=>{
    expect(()=>b2bDraftIssuer({} as any,{profile:'PRODUCTION',allowedIssuerRucs:[]} as any)).toThrow();
    expect(()=>b2bDraftIssuer({} as any,{profile:'BETA_01_03_TAXABLE18_V1',allowedIssuerRucs:[]})).toThrow();
  });
  it('an inconsistent issuer result rolls back all writes instead of advertising a commit',async()=>{
    const f=await ready(),original=f.store.transaction.bind(f.store);
    f.store.transaction=(scope,work)=>original(scope,tx=>{const issue=tx.issue!;return work({...tx,issue:async(d,op)=>({...await issue(d,op),number:'0'})});});
    await expect(f.core.command(f.token,'SERVICE','ISSUE',f.draftId,key+'i','"v2"',{})).rejects.toMatchObject({code:'INCONSISTENT_ISSUANCE_RESULT'});
    expect(f.store.fiscal.documents).toHaveLength(0);expect(f.store.fiscal.nextNumber).toBe(1);
  });
  it('validates product codes against the persistent 40-character column limit',async()=>{
    const f=await draftFixture(true),body=draftInput();body.lines[0].productCode='x'.repeat(41);
    await expect(f.core.command(f.token,'SERVICE','CREATE',null,key,undefined,body)).rejects.toMatchObject({status:400});expect(f.store.rows.size).toBe(0);
  });
});
