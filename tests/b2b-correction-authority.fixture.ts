import { vi } from 'vitest';
import { B2bEnabledIdentityScopes } from '../packages/contracts/src/b2b-security';
import { B2bCorrectionAuthority, correctionScopes, type CorrectionGrantSet, type CorrectionStore } from '../services/identity-service/src/b2b/correction-authority';
import { binding, id, fixture, basic, ctx, input } from './b2b-identity.fixture';
import type { DelegatedUser } from '../services/identity-service/src/b2b/model';
import type { QueuedUsers } from '../services/identity-service/src/b2b/webhook-authority';
export const pair=()=>({reference:structuredClone(binding),noteType:'07' as const,noteSeriesId:id(40)});
export async function correctionFixture(kind:'SERVICE'|'USER'='SERVICE') {
  let linked:DelegatedUser;
  const f=fixture(kind==='USER'?{verify:async()=>structuredClone(linked)}:null,B2bEnabledIdentityScopes),grants=new Map<string,CorrectionGrantSet>();
  const catalogue={validate:vi.fn(async()=>{})},users={current:vi.fn<QueuedUsers['current']>(async()=>kind==='USER'?{active:true,authVersion:linked.authRevision,permissions:[...linked.permissions],scope:structuredClone(linked.scope)}:null)};
  const store:CorrectionStore={rate:()=>f.store.rate(),transaction:work=>f.store.transaction(async tx=>{
    const copy=structuredClone(grants);
    const result=await work({...tx,correctionGrants:async id=>structuredClone(copy.get(id)??null),saveCorrectionGrants:async g=>{copy.set(g.clientId,structuredClone(g));}});
    grants.clear();for(const [id,g]of copy)grants.set(id,g);return result;
  })};
  const core=new B2bCorrectionAuthority(store,f.core,catalogue,f.admin,users);
  const made=await f.core.create('human-step-up',{...input(),kind,...(kind==='USER'?{oidcClientId:'synthetic_oidc'}:{}),scopes:[...correctionScopes]},ctx());
  linked={clientId:made.client.id,clientRevision:1,oidcClientId:'synthetic_oidc',userId:id(50),authRevision:3,tokenScopes:[...correctionScopes],
    permissions:['document.view','document.issue'],scope:{kind:'ASSIGNED',branchIds:[binding.branchId],emissionPointIds:[binding.pointId],series:[binding.seriesId,id(40)]}};
  const token=kind==='USER'?'synthetic-user-token':(await f.core.token(basic(made.client.id,made.clientSecret!),{grant_type:'client_credentials',scope:correctionScopes.join(' ')},ctx())).access_token!;
  const replace=(bindings:unknown[]= [pair()],expectedGrantRevision=0,expectedClientRevision=1)=>core.replace('human-step-up',made.client.id,{bindings,expectedGrantRevision,expectedClientRevision},ctx());
  const authorize=(binding:unknown=pair())=>core.authorize(token,{kind,binding},ctx());
  return {...f,identity:f.core,memory:f.store,store,grants,core,catalogue,users,made,token,replace,authorize,linked};
}
