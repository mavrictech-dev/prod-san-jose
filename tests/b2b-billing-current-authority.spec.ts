import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {B2bBillingCurrentAuthority} from '../services/identity-service/src/b2b/billing-current-authority';
import {binding} from './b2b-identity.fixture';
function fixture(){
 const subjectId=randomUUID(),clientId=randomUUID(),now=Math.floor(Date.now()/1000),principal:any={kind:'USER',clientId,revision:2,subjectId,userAuthRevision:3,environment:'BETA',scopes:['b2b:products:write'],bindings:[binding]};
 const human:any={sub:subjectId,authVersion:3,username:'SYNTHETIC',roles:['ADMIN'],permissions:['product.manage'],scope:{kind:'GLOBAL'},iss:'https://synthetic-oidc.invalid',aud:'factuez-b2b-v1',iat:now,exp:now+30};
 const app:any={id:clientId,label:'SYNTHETIC',kind:'USER',enabled:true,revision:2,secretHash:'PRIVATE_CANARY',oidcClientId:'synthetic-client',scopes:principal.scopes,bindings:[binding]};
 const claims:any={active:true,iss:human.iss,aud:human.aud,token_type:'Bearer',sub:'synthetic-subject',client_id:'synthetic-client',scope:'b2b:products:write',iat:now-1,auth_time:now-2,exp:now+200,amr:['pwd','mfa'],acr:'urn:synthetic:mfa'};
 const user:any={active:true,authVersion:3,permissions:['product.manage'],scope:{kind:'GLOBAL'}};
 const deps={enabled:true,identity:{authenticate:vi.fn(async()=>structuredClone(principal))},provider:{introspect:vi.fn(async()=>structuredClone(claims))},users:{
  link:vi.fn(async()=>({enabled:true,clientId,clientRevision:2,userId:subjectId,userAuthRevision:3})),current:vi.fn(async()=>structuredClone(user))},
  live:{current:vi.fn(async()=>structuredClone(human))},store:{transaction:async(work:any)=>work({get:async()=>structuredClone(app),audit:async()=>{}}),rate:async()=>true},
  catalogue:{validate:vi.fn(async()=>{})},issuer:human.iss,clientId:'synthetic-client',acceptedAcr:['urn:synthetic:mfa']};
 const request={action:'AUTHORIZE',requestId:randomUUID(),operation:'PRODUCTS_CREATE',binding};
 return {subjectId,clientId,principal,human,app,claims,user,deps,request,core:new B2bBillingCurrentAuthority(deps)};
}
describe('current Billing authority binds MFA to the exact previously authenticated person/client',()=>{
 it('returns a current owner receipt with repeated permission, binding and step-up checks',async()=>{
  const f=fixture(),r=await f.core.execute(f.request,'synthetic-token-00000001','a'.repeat(64));expect(r).toMatchObject({principal:f.principal,stepUpVerified:true});
  expect(f.deps.identity.authenticate).toHaveBeenCalledTimes(3);expect(f.deps.users.link).toHaveBeenCalledTimes(3);expect(f.deps.catalogue.validate).toHaveBeenCalledTimes(3);expect(JSON.stringify(r)).not.toContain('PRIVATE_CANARY');
 });
 it.each(['subject','client','userRevision','clientRevision'])('cannot borrow the MFA of a different %s even if the first introspection principal is valid',async defect=>{
  const f=fixture(),linked={enabled:true,clientId:f.clientId,clientRevision:2,userId:f.subjectId,userAuthRevision:3};
  if(defect==='subject')linked.userId=randomUUID();if(defect==='client')linked.clientId=randomUUID();if(defect==='userRevision')linked.userAuthRevision=4;if(defect==='clientRevision')linked.clientRevision=3;
  f.deps.users.link.mockResolvedValue(linked);await expect(f.core.execute(f.request,'synthetic-token-00000001','a'.repeat(64))).rejects.toBeDefined();
 });
 it.each(['mfa','scope','permission','global','service'])('rejects missing current %s authority',async defect=>{
  const f=fixture();if(defect==='mfa')f.claims.amr=['pwd'];if(defect==='scope')f.claims.scope='b2b:products:read';if(defect==='permission')f.user.permissions=[];
  if(defect==='global')f.human.scope={kind:'ASSIGNED'};if(defect==='service')Object.assign(f.principal,{kind:'SERVICE',subjectId:null,userAuthRevision:null});
  await expect(f.core.execute(f.request,'synthetic-token-00000001','a'.repeat(64))).rejects.toBeDefined();
 });
 it('does not query any dependency when disabled',async()=>{
  const f=fixture(),c=new B2bBillingCurrentAuthority({...f.deps,enabled:false});await expect(c.execute(f.request,'synthetic-token-00000001','a'.repeat(64))).rejects.toBeDefined();expect(f.deps.identity.authenticate).not.toHaveBeenCalled();
 });
});
