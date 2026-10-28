import 'reflect-metadata';
import { describe,it,expect,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { sign } from 'node:crypto';
import { B2bAudience } from '../packages/contracts/src/b2b';
import { b2bBindingsContain,validB2bBinding,validB2bPrincipal } from '../packages/contracts/src/b2b-security';
import { B2bTokenCodec } from '../services/identity-service/src/b2b/token';
import { OidcDelegationVerifier,HttpsOidcIntrospection } from '../services/identity-service/src/b2b/oidc';
import { HumanB2bAdministrator,PostgresLinkedUsers } from '../services/identity-service/src/b2b/users';
import { PostgresB2bStore } from '../services/identity-service/src/b2b/postgres-store';
import { B2bContextService,PrismaB2bContextRepository } from '../services/billing-service/src/b2b/context';
import { B2bPrivateHttp,B2bIdentityHttp } from '../packages/service-access/src/b2b';
import { fixture,issued,input,ctx,basic,binding,id,pem,others } from './b2b-identity.fixture';
import { fixture as legacyFixture,input as legacyInput,ctx as legacyCtx,basic as legacyBasic } from './integration-identity.fixture';

describe('B2B-02 SERVICE identity and revocation',()=>{
  it('uses dedicated audience, short JWT, one-time secret and hashed-only storage/audit',async()=>{
    const f=await issued();expect(f.made.clientSecret).toMatch(/^[\w-]{43}$/);expect(f.made.client).not.toHaveProperty('secretHash');
    expect(f.store.clients.get(f.made.client.id)?.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(f.store.audits)).not.toContain(f.made.clientSecret);
    const claims=JSON.parse(Buffer.from(f.token.split('.')[1],'base64url').toString());
    expect(claims).toMatchObject({aud:B2bAudience,kind:'SERVICE',environment:'BETA'});expect(claims.exp-claims.iat).toBe(300);
    expect(claims).not.toHaveProperty('bindings');
    const p=await f.core.authenticate(f.token,['b2b:catalog:read'],ctx());expect(validB2bPrincipal(p)).toBe(true);expect(p.bindings).toEqual([binding]);
  });
  it.each(['enabled','scopes','bindings'])('grant change %s invalidates old token immediately',async field=>{
    const f=await issued();const changes:any={enabled:false,scopes:['b2b:context:read'],bindings:[{...binding,seriesId:id(5)}]};
    await f.core.change('human-step-up',f.made.client.id,{expectedRevision:1,[field]:changes[field]},ctx());
    await expect(f.core.authenticate(f.token,[],ctx())).rejects.toMatchObject({status:401});
    expect(f.store.audits.at(-1)?.outcome).toBe('INVALID_TOKEN');
  });
  it('rotation invalidates old secret/JWT; re-enabling never resurrects old JWT',async()=>{
    const f=await issued();const change=await f.core.change('human-step-up',f.made.client.id,{expectedRevision:1},ctx(),true);
    expect(change.clientSecret).not.toBe(f.made.clientSecret);
    await expect(f.core.token(basic(f.made.client.id,f.made.clientSecret!),{grant_type:'client_credentials',scope:'b2b:context:read'},ctx())).rejects.toMatchObject({status:401});
    await expect(f.core.authenticate(f.token,[],ctx())).rejects.toMatchObject({status:401});
    await f.core.change('human-step-up',f.made.client.id,{expectedRevision:2,enabled:false},ctx());
    await f.core.change('human-step-up',f.made.client.id,{expectedRevision:3,enabled:true},ctx());
    await expect(f.core.authenticate(f.token,[],ctx())).rejects.toMatchObject({status:401});
  });
  it('only one concurrent rotation commits and audit failure rolls back effects',async()=>{
    const f=await issued();const results=await Promise.allSettled([1,2].map(()=>f.core.change('human-step-up',f.made.client.id,{expectedRevision:1},ctx(),true)));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(f.store.clients.get(f.made.client.id)?.revision).toBe(2);
    const previous=structuredClone(f.store.clients);f.store.failAudit=true;
    await expect(f.core.change('human-step-up',f.made.client.id,{expectedRevision:2},ctx(),true)).rejects.toMatchObject({status:503});expect(f.store.clients).toEqual(previous);
  });
  it('creation/token/authentication fail closed when audit or DB unavailable',async()=>{
    const f=fixture();f.store.failAudit=true;await expect(f.core.create('human-step-up',input(),ctx())).rejects.toMatchObject({status:503});expect(f.store.clients.size).toBe(0);
    const ok=await issued();ok.store.failAudit=true;await expect(ok.core.authenticate(ok.token,[],ctx())).rejects.toMatchObject({status:503});
    ok.store.down=true;await expect(ok.core.authenticate(ok.token,[],ctx())).rejects.toMatchObject({status:503});
  });
  it('revocation does not depend on owner catalogue availability',async()=>{
    const f=await issued();f.catalogue.validate.mockRejectedValue(new Error('Billing down'));
    expect((await f.core.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx())).client.enabled).toBe(false);
    await expect(f.core.change('human-step-up',f.made.client.id,{expectedRevision:2,enabled:true},ctx())).rejects.toMatchObject({status:503});
  });
  it('readonly and B2B audiences reject each other cryptographically',async()=>{
    const f=await issued(),old=legacyFixture(),made=await old.core.create('human-fixture',legacyInput(),legacyCtx());
    const token=await old.core.token(legacyBasic(made.client.id,made.clientSecret),{grant_type:'client_credentials',scope:'integration:documents:read'},legacyCtx());
    await expect(f.core.authenticate(token.access_token,[],ctx())).rejects.toMatchObject({status:401});
    await expect(old.core.authenticate(f.token,[],legacyCtx())).rejects.toMatchObject({status:401});
  });
  it.each([
    {aud:'factuez-integration-v1'},{aud:'factuez-services'},{environment:'PRODUCTION'},{kind:'USER'},
    {revision:0},{iat:1800000010,nbf:1800000010,exp:1800000310},{scope:'integration:documents:read'},
    {userId:id(9)},{nbf:1800000001},
  ])('rejects validly signed but invalid claims %j',async patch=>{
    const f=await issued();const [header,body]=f.token.split('.');
    const payload=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(body,'base64url').toString()),...patch})).toString('base64url');
    const message=header+'.'+payload;const token=message+'.'+sign('RSA-SHA256',Buffer.from(message),pem).toString('base64url');
    await expect(f.core.authenticate(token,[],ctx())).rejects.toMatchObject({status:401});
  });
  it('metadata recovery never returns stored credential material',async()=>{
    const f=await issued();const metadata=await f.core.read('human-step-up',f.made.client.id,ctx());
    expect(metadata.revision).toBe(1);expect(metadata).not.toHaveProperty('secretHash');expect(JSON.stringify(metadata)).not.toContain(f.made.clientSecret);
  });
  it.each(['password','refresh_token','authorization_code'])('SERVICE endpoint does not accept %s grant',async grant_type=>{
    const f=await issued();await expect(f.core.token(basic(f.made.client.id,f.made.clientSecret!),{grant_type,scope:'b2b:context:read'},ctx())).rejects.toMatchObject({status:400});
  });
  it.each(['integration:documents:read','b2b:documents:issue','b2b:identity:manage','*'])('scope not activated in phase 2 is denied: %s',async scope=>{
    const f=fixture();await expect(f.core.create('human-step-up',{...input(),scopes:[scope]},ctx())).rejects.toMatchObject({status:400});
  });
  it.each(['userId','roles','permissions','environment','client_secret'])('rejects caller-supplied authority %s',async field=>{
    const f=fixture();await expect(f.core.create('human-step-up',{...input(),[field]:'ADMIN'},ctx())).rejects.toMatchObject({status:400});
  });
  it('rejects plain human login as step-up and enforces quotas/expiry/tampering',async()=>{
    const f=await issued();await expect(f.core.create('human-password-only',input(),ctx())).rejects.toMatchObject({status:403});
    await expect(f.core.authenticate(f.token+'x',[],ctx())).rejects.toMatchObject({status:401});
    f.advance(300000);await expect(f.core.authenticate(f.token,[],ctx())).rejects.toMatchObject({status:401});
    f.store.limited=true;await expect(f.core.authenticate(f.token,[],ctx())).rejects.toMatchObject({status:429});
    expect(()=>new B2bTokenCodec(pem,'https://identity.invalid',()=>0,{...others,human:pem})).toThrow('must differ');
  });
  it('USER clients have no shared secret and cannot use client_credentials',async()=>{
    const f=fixture(),made=await f.core.create('human-step-up',{...input(),kind:'USER',oidcClientId:'corporate-portal'},ctx());
    expect(made).not.toHaveProperty('clientSecret');expect(f.store.clients.get(made.client.id)?.secretHash).toBeNull();
    await expect(f.core.token(basic(made.client.id,'a'.repeat(43)),{grant_type:'client_credentials',scope:'b2b:context:read'},ctx())).rejects.toMatchObject({status:401});
    await expect(f.core.authenticate('external-token-string',[],ctx(),'USER')).rejects.toMatchObject({code:'OIDC_NOT_CONFIGURED'});
  });
});

function oidcFixture(){
  const issuer='https://oidc.invalid/realms/factuez',time=1800000000;
  const claims={active:true,iss:issuer,aud:B2bAudience,token_type:'Bearer',sub:'opaque-subject',client_id:'corporate-portal',iat:time,exp:time+300,scope:'openid b2b:context:read b2b:catalog:read'};
  const link={clientId:id(8),clientRevision:1,userId:id(9),userAuthRevision:3,enabled:true};
  const user={active:true,authVersion:3,permissions:['document.view'],scope:{kind:'ASSIGNED' as const,branchIds:[binding.branchId],emissionPointIds:[binding.pointId],series:[binding.seriesId]}};
  const provider={introspect:vi.fn(async()=>structuredClone(claims))},users={link:vi.fn(async()=>structuredClone(link)),current:vi.fn(async()=>structuredClone(user))};
  const verifier=new OidcDelegationVerifier(issuer,provider,users,()=>time);
  return {verifier,claims,provider,users,link,user};
}
describe('B2B-02 delegated USER uses current local permissions, not external roles',()=>{
  it('requires report.view/report.export for reception independently of sales scopes',async()=>{
    const selected=['b2b:context:read','b2b:received:read','b2b:received:artifacts:read'] as const;
    const user={clientId:id(80),clientRevision:1,oidcClientId:'corporate-portal',userId:id(9),authRevision:3,
      tokenScopes:[...selected],permissions:['document.view'],scope:{kind:'GLOBAL' as const}};
    const f=fixture({verify:async()=>structuredClone(user)},selected),made=await f.core.create('human-step-up',{
      ...input(),kind:'USER',oidcClientId:'corporate-portal',scopes:[...selected]},ctx());user.clientId=made.client.id;
    await expect(f.core.authenticate('opaque-token-string',['b2b:received:read'],ctx(),'USER')).rejects.toMatchObject({status:403});
    user.permissions.push('report.view');expect((await f.core.authenticate('opaque-token-string',['b2b:received:read'],ctx(),'USER')).scopes).toContain('b2b:received:read');
    await expect(f.core.authenticate('opaque-token-string',['b2b:received:read','b2b:received:artifacts:read'],ctx(),'USER')).rejects.toMatchObject({status:403});
    user.permissions.push('report.export');expect((await f.core.authenticate('opaque-token-string',['b2b:received:read','b2b:received:artifacts:read'],ctx(),'USER')).scopes).not.toContain('b2b:documents:read');
  });
  it.each(['b2b:batches:write','b2b:guides:issue'] as const)('requires live document.issue for the dedicated scope %s, not only document.view',async scope=>{
    const selected=['b2b:context:read','b2b:catalog:read','b2b:batches:read',scope] as const;
    const delegated={clientId:id(80),clientRevision:1,oidcClientId:'corporate-portal',userId:id(9),authRevision:3,
      tokenScopes:[...selected],permissions:['document.view'],scope:{kind:'GLOBAL' as const}};
    const verifier={verify:vi.fn(async()=>structuredClone(delegated))},f=fixture(verifier,selected);
    const made=await f.core.create('human-step-up',{...input(),kind:'USER',oidcClientId:'corporate-portal',scopes:[...selected]},ctx());
    delegated.clientId=made.client.id;
    expect((await f.core.authenticate('opaque-token-string',['b2b:batches:read'],ctx(),'USER')).scopes).toContain('b2b:batches:read');
    await expect(f.core.authenticate('opaque-token-string',[scope],ctx(),'USER')).rejects.toMatchObject({status:403});
    delegated.permissions.push('document.issue');
    expect((await f.core.authenticate('opaque-token-string',[scope],ctx(),'USER')).scopes).toContain(scope);
    delegated.permissions=['document.view'];
    await expect(f.core.authenticate('opaque-token-string',[scope],ctx(),'USER')).rejects.toMatchObject({status:403});
  });
  it('introspects every request and explicitly links issuer+sub+client, without copying credentials',async()=>{
    const f=oidcFixture();expect((await f.verifier.verify('opaque-token-string')).userId).toBe(id(9));await f.verifier.verify('opaque-token-string');
    expect(f.provider.introspect).toHaveBeenCalledTimes(2);expect(f.users.link).toHaveBeenCalledWith(f.claims.iss,'opaque-subject','corporate-portal');
  });
  it.each([
    ['active',false],['aud','factuez-integration-v1'],['iss','https://attacker.invalid'],['token_type','Refresh'],['exp',1800000000],['iat',1800000010],['scope','openid'],
  ])('rejects invalid provider response %s',async(field,value)=>{
    const f=oidcFixture();f.provider.introspect.mockResolvedValue({...f.claims,[field]:value} as any);
    await expect(f.verifier.verify('opaque-token-string')).rejects.toMatchObject({status:expect.any(Number)});
  });
  it('no implicit linking or fallback when link revoked, user changed or provider down',async()=>{
    const f=oidcFixture();f.users.link.mockResolvedValue(null as any);await expect(f.verifier.verify('opaque-token-string')).rejects.toMatchObject({code:'USER_LINK_REQUIRED'});
    f.users.link.mockResolvedValue(f.link);f.users.current.mockResolvedValue({...f.user,authVersion:4});await expect(f.verifier.verify('opaque-token-string')).rejects.toMatchObject({code:'USER_ACCESS_CHANGED'});
    const g=fixture(f.verifier);f.provider.introspect.mockRejectedValue(new Error('OIDC down'));await expect(g.core.authenticate('opaque-token-string',[],ctx(),'USER')).rejects.toMatchObject({status:503});
  });
  it('intersects app scopes, OIDC token scopes, local permissions and exact assigned resources',async()=>{
    const o=oidcFixture(),f=fixture(o.verifier);const made=await f.core.create('human-step-up',{...input(),kind:'USER',oidcClientId:'corporate-portal'},ctx());
    o.users.link.mockResolvedValue({...o.link,clientId:made.client.id});
    expect((await f.core.authenticate('opaque-token-string',['b2b:catalog:read'],ctx(),'USER')).bindings).toEqual([binding]);
    o.users.current.mockResolvedValue({...o.user,permissions:[]});await expect(f.core.authenticate('opaque-token-string',['b2b:catalog:read'],ctx(),'USER')).rejects.toMatchObject({status:403});
    o.users.current.mockResolvedValue({...o.user,scope:{...o.user.scope,series:[id(77)]}});await expect(f.core.authenticate('opaque-token-string',[],ctx(),'USER')).rejects.toMatchObject({code:'NO_AUTHORIZED_CONTEXT'});
  });
  it('closed step-up adapter does not treat ADMIN password session as MFA',async()=>{
    const auth:any={verifyAccessToken:()=>({sub:id(9),roles:['ADMIN'],permissions:['setup.manage','user.manage','role.manage'],scope:{kind:'GLOBAL'}}),assertActive:async()=>{}};
    await expect(new HumanB2bAdministrator(auth,null).verify('human')).rejects.toMatchObject({code:'STEP_UP_REQUIRED'});
  });
  it.each(['http://oidc.invalid/token','https://oidc.invalid/token?next=evil','https://u:p@oidc.invalid/token'])('refuses unsafe OIDC endpoint: %s',endpoint=>{
    expect(()=>new HttpsOidcIntrospection(endpoint,'Basic YTpi',{ca:Buffer.alloc(0),cert:Buffer.alloc(0),key:Buffer.alloc(0)})).toThrow();
  });
});

describe('B2B-02 canonical owner context and persistence adapters',()=>{
  it('does not authorize cross-products, another issuer, type or production',()=>{
    expect(b2bBindingsContain([binding],binding)).toBe(true);
    for(const field of ['issuerId','issuerRuc','branchId','pointId','seriesId','documentType','environment']){
      const value:any={...binding,[field]:field==='issuerId'?2:field==='issuerRuc'?'00000000002':field==='environment'?'PRODUCTION':field==='documentType'?'03':id(99)};
      expect(b2bBindingsContain([binding],value)).toBe(false);
    }
    expect(validB2bBinding({...binding,issuerId:id(8)})).toBe(false);
  });
  it('fresh identity + exact binding required before owner read; removed resources fail closed',async()=>{
    const f=await issued(),identity={authenticate:vi.fn((token:string,required:any)=>f.core.authenticate(token,required,ctx()))};
    const repo={resolve:vi.fn(async()=>({binding}))},core=new B2bContextService(repo,identity);
    expect(await core.resolve(f.token,binding,'SERVICE')).toEqual({binding});
    await expect(core.resolve(f.token,{...binding,pointId:id(77)},'SERVICE')).rejects.toMatchObject({status:404});expect(repo.resolve).toHaveBeenCalledTimes(1);
    repo.resolve.mockResolvedValue(null as any);await expect(core.resolve(f.token,binding,'SERVICE')).rejects.toMatchObject({status:404});
    await f.core.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());await expect(core.resolve(f.token,binding,'SERVICE')).rejects.toMatchObject({status:401});
  });
  it('Prisma selector checks the complete hierarchy and never selects the next counter',async()=>{
    const db:any={seriesCounter:{findFirst:vi.fn(async()=>null)}};await new PrismaB2bContextRepository(db).resolve(binding);
    const args=db.seriesCounter.findFirst.mock.calls[0][0];expect(args.where).toMatchObject({id:binding.seriesId,companyId:1,emissionPointId:binding.pointId,active:true,company:{ruc:binding.issuerRuc,environment:'BETA',active:true}});
    expect(args.where.emissionPoint.branch).toMatchObject({id:binding.branchId,companyId:1,active:true});expect(JSON.stringify(args.select)).not.toContain('nextNumber');
  });
  it('Postgres adapter uses separate B2B tables, bound SQL and optimistic revision',async()=>{
    const sql:any={$queryRawUnsafe:vi.fn(async()=>[]),$executeRawUnsafe:vi.fn(async()=>0),$transaction:async(work:any)=>work(sql)};
    const store=new PostgresB2bStore(sql);await store.transaction(tx=>tx.get(id(1)));expect(sql.$queryRawUnsafe.mock.calls[0][0]).toContain('"B2bClient"');expect(sql.$queryRawUnsafe.mock.calls[0][1]).toBe(id(1));
    const row:any={id:id(1),enabled:false,revision:2,secretHash:'a'.repeat(64),scopes:[],bindings:[]};await expect(store.transaction(tx=>tx.save(row,1))).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  });
  it('user lookup selects no password and never auto-links by email/name',async()=>{
    const db:any={$queryRawUnsafe:vi.fn(async()=>[]),user:{findUnique:vi.fn(async()=>null)}};
    const users=new PostgresLinkedUsers(db,{effective:async()=>[]});expect(await users.link('https://oidc.invalid','subject','client')).toBeNull();await users.current(id(9));
    expect(JSON.stringify(db.user.findUnique.mock.calls[0][0])).not.toMatch(/password|username|email/i);
  });
  it('private transport refuses arbitrary URLs/paths and malformed introspection principal',async()=>{
    const http=new B2bPrivateHttp('https://owner.invalid',{ca:Buffer.alloc(0),cert:Buffer.alloc(0),key:Buffer.alloc(0)});
    await expect(http.post('https://attacker.invalid' as any,{})).rejects.toMatchObject({status:400});
    const identity=new B2bIdentityHttp({post:async()=>({clientId:id(1),environment:'BETA',roles:['ADMIN']})} as any);
    await expect(identity.authenticate('token',[],'SERVICE')).rejects.toMatchObject({status:503});
  });
  it('does not import B2B into existing runtime or apply SQL automatically',()=>{
    for(const file of ['services/identity-service/src/app.module.ts','services/billing-service/src/app.module.ts','infra/kong/kong.yml'])expect(readFileSync(file,'utf8')).not.toMatch(/B2b|internal\/b2b|b2b\/oauth/);
    const sql=readFileSync('services/identity-service/b2b-schema.candidate.sql','utf8');expect(sql).not.toMatch(/^\s*(DROP|DELETE|UPDATE)\s|IntegrationClient/m);expect(sql).toContain('CHECK ("environment"=\'BETA\')');
  });
});
