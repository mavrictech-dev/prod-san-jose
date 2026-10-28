import { describe, expect, it } from 'vitest';
import { B2bPhase8Scopes, B2bPhase2Scopes, type B2bIdentityScope } from '../packages/contracts/src/b2b-security';
import { adminFixture, input, ctx, id, basic } from './b2b-integration-admin.fixture';
const requirements: [typeof B2bPhase8Scopes[number], string[]][] = [
  ['b2b:customers:read',['document.view']],['b2b:customers:write',['document.issue']],
  ['b2b:products:read',['document.view']],['b2b:products:write',['product.manage']],
  ['b2b:shifts:read',['report.view']],['b2b:shifts:write',['shift.open','shift.close']],
  ['b2b:cash:write',['shift.open']],['b2b:received:write',['setup.manage']],
  ['b2b:received:sync',['setup.manage']],['b2b:received:configure',['setup.manage']],
  ['b2b:reports:read',['report.view']],['b2b:reports:export',['report.export']],
  ['b2b:history:read',['document.view']],['b2b:masters:manage',['setup.manage','series.manage']],
  ['b2b:identity:manage',['user.manage','role.manage']],['b2b:branding:manage',['setup.manage']],
  ['b2b:fiscal-config:read',['sunat.configure']],['b2b:fiscal-config:write',['sunat.configure']],
  ['b2b:email:send',['document.email']],['b2b:email:read',['document.view']],['b2b:mail-config:manage',['setup.manage']],
];
async function delegated(scope:B2bIdentityScope, permissions:string[], enabled?:readonly B2bIdentityScope[]) {
  const user={clientId:id(80),clientRevision:1,oidcClientId:'admin-test-portal',userId:id(9),authRevision:3,
    tokenScopes:(scope==='b2b:exports:create'?['b2b:context:read','b2b:documents:read',scope]:['b2b:context:read',scope]) as B2bIdentityScope[],permissions,scope:{kind:'GLOBAL' as const}};
  const f=adminFixture({verify:async()=>structuredClone(user)},enabled??['b2b:context:read',scope]);
  const made=await f.core.create('human-step-up',{...input(),kind:'USER',oidcClientId:user.oidcClientId,scopes:user.tokenScopes},ctx());user.clientId=made.client.id;
  return {...f,user,made};
}
describe('Phase8 USER permission mapping is explicit opt-in vocabulary',()=>{
  it('covers exactly the authorized phase8 vocabulary',()=>{expect(requirements.map(([scope])=>scope).sort()).toEqual([...B2bPhase8Scopes].sort());});
  it.each(requirements)('%s needs its exact independent permissions without accidental document.view',async(scope,required)=>{
    const f=await delegated(scope,[...required]);
    expect((await f.core.authenticate('synthetic-delegated-token',[scope],ctx(),'USER')).scopes).toContain(scope);
    for (const missing of required) {
      f.user.permissions=required.filter(p=>p!==missing);
      await expect(f.core.authenticate('synthetic-delegated-token',[scope],ctx(),'USER')).rejects.toMatchObject({status:403,code:'INSUFFICIENT_SCOPE'});
    }
    f.user.permissions=['document.view'];
    if(!required.every(p=>f.user.permissions.includes(p)))await expect(f.core.authenticate('synthetic-delegated-token',[scope],ctx(),'USER')).rejects.toMatchObject({status:403});
  });
  it('does not activate the expanded vocabulary by default or grant it to legacy applications',async()=>{
    const f=adminFixture();await expect(f.core.create('human-step-up',{...input(),scopes:['b2b:context:read','b2b:products:write']},ctx())).rejects.toMatchObject({code:'INVALID_SCOPE'});
    const made=await f.core.create('human-step-up',input(),ctx());expect(made.client.scopes.every(scope=>(B2bPhase2Scopes as readonly string[]).includes(scope))).toBe(true);
  });
  it('intersects token, current permissions and app scopes instead of auto-granting phase8',async()=>{
    const scope='b2b:products:write' as const,f=await delegated(scope,['product.manage']);
    f.user.tokenScopes=['b2b:context:read'];await expect(f.core.authenticate('synthetic-delegated-token',[scope],ctx(),'USER')).rejects.toMatchObject({status:403});
    f.user.tokenScopes=['b2b:context:read',scope];f.store.clients.get(f.made.client.id)!.scopes=['b2b:context:read'];await expect(f.core.authenticate('synthetic-delegated-token',[scope],ctx(),'USER')).rejects.toMatchObject({status:403});
  });
  it('keeps legacy document.view and independent report export requirements',async()=>{
    const f=await delegated('b2b:exports:create',['report.export'],['b2b:context:read','b2b:documents:read','b2b:exports:create']);
    f.user.tokenScopes=['b2b:context:read','b2b:documents:read','b2b:exports:create'];f.store.clients.get(f.made.client.id)!.scopes=[...f.user.tokenScopes];
    await expect(f.core.authenticate('synthetic-delegated-token',['b2b:documents:read','b2b:exports:create'],ctx(),'USER')).rejects.toMatchObject({status:403});
    f.user.permissions.push('document.view');expect((await f.core.authenticate('synthetic-delegated-token',['b2b:documents:read','b2b:exports:create'],ctx(),'USER')).scopes).toContain('b2b:exports:create');
  });
  it('supports an explicitly enrolled full Phase8 scope string while keeping it bounded',async()=>{
    const selected=['b2b:context:read',...B2bPhase8Scopes] as const;
    expect(selected.join(' ').length).toBeGreaterThan(300);
    const f=adminFixture(null,selected),made=await f.core.create('human-step-up',{...input(),scopes:[...selected]},ctx());
    const issued=await f.core.token(basic(made.client.id,made.clientSecret!),{grant_type:'client_credentials',scope:selected.join(' ')},ctx());
    expect((await f.core.authenticate(issued.access_token,[...selected],ctx())).scopes.sort()).toEqual([...selected].sort());
    await expect(f.core.token(basic(made.client.id,made.clientSecret!),{grant_type:'client_credentials',scope:'b2b:context:read '.repeat(500)},ctx())).rejects.toMatchObject({status:400});
  });
  it('does not apply human permission rules to explicitly granted SERVICE tokens',async()=>{
    const f=adminFixture(null,['b2b:context:read','b2b:products:write']),made=await f.core.create('human-step-up',{...input(),scopes:['b2b:context:read','b2b:products:write']},ctx());
    const issued=await f.core.token(basic(made.client.id,made.clientSecret!),{grant_type:'client_credentials',scope:'b2b:products:write'},ctx());
    expect((await f.core.authenticate(issued.access_token,['b2b:products:write'],ctx())).kind).toBe('SERVICE');
  });
});
