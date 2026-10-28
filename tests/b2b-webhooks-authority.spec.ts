import {describe,it,expect} from 'vitest';
import {B2bWebhookAuthority} from '../services/identity-service/src/b2b/webhook-authority';
import {fixture,ctx,id} from './b2b-identity.fixture';
import {invoiceBinding} from './b2b-read.fixture';
import {B2bEnabledIdentityScopes} from '../packages/contracts/src/b2b-security';
describe('B2B-05 delegated USER worker authorization without stored OIDC bearer',()=>{
  it('intersects fresh user link, revision, permissions and exact tuple on every queued authorization',async()=>{
    const auth=fixture(null,B2bEnabledIdentityScopes),made=await auth.core.create('human-step-up',{kind:'USER',oidcClientId:'synthetic',label:'Synthetic queued user',scopes:['b2b:webhooks:read','b2b:documents:read'],bindings:[invoiceBinding]},ctx());
    let user:any={active:true,authVersion:2,permissions:['document.view'],scope:{kind:'GLOBAL'}};
    const authority=new B2bWebhookAuthority(auth.store,{validate:async()=>{}},{current:async()=>user});const actor={kind:'USER',clientId:made.client.id,revision:1,subjectId:id(50),userAuthRevision:2};
    expect((await authority.check({actor,binding:invoiceBinding},'f'.repeat(64))).allowed).toBe(true);
    user={...user,authVersion:3};expect((await authority.check({actor,binding:invoiceBinding},'f'.repeat(64))).allowed).toBe(false);
    user={...user,authVersion:2,scope:{kind:'ASSIGNED',branchIds:[id(1)],emissionPointIds:[invoiceBinding.pointId],series:[invoiceBinding.seriesId]}};expect((await authority.check({actor,binding:invoiceBinding},'f'.repeat(64))).allowed).toBe(false);
    user=null;expect((await authority.check({actor,binding:invoiceBinding},'f'.repeat(64))).allowed).toBe(false);
  });
  it('does not let a view-only delegated user manage subscriptions',async()=>{
    const user:any={clientId:id(99),clientRevision:1,oidcClientId:'synthetic',userId:id(50),authRevision:1,tokenScopes:['b2b:webhooks:manage','b2b:documents:read'],permissions:['document.view'],scope:{kind:'GLOBAL'}};
    const auth=fixture({verify:async()=>user},B2bEnabledIdentityScopes),made=await auth.core.create('human-step-up',{kind:'USER',oidcClientId:user.oidcClientId,label:'Synthetic manager',scopes:user.tokenScopes,bindings:[invoiceBinding]},ctx());user.clientId=made.client.id;
    await expect(auth.core.authenticate('synthetic',['b2b:webhooks:manage'],ctx(),'USER')).rejects.toMatchObject({status:403});user.permissions.push('setup.manage');expect((await auth.core.authenticate('synthetic',['b2b:webhooks:manage'],ctx(),'USER')).subjectId).toBe(user.userId);
  });
});
