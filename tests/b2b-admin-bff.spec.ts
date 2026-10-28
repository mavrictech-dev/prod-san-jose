import {describe,it,expect} from 'vitest';
import {inspect} from 'node:util';
import {randomBytes} from 'node:crypto';
import {AdminSessionBff} from '../services/b2b-api-service/src/admin-bff-core';
import {RedisAdminBffStore,adminBffHash} from '../services/b2b-api-service/src/admin-bff-store';
import {adminBffFixture,AdminRedisDouble} from './helpers/b2b-admin-bff.fixture';
import {input} from './b2b-integration-admin.fixture';
describe('B2B admin BFF server-only sessions and current owner authority',()=>{
 it('is disabled unless explicitly enabled and performs no provider/storage I/O on construction',async()=>{
  const f=adminBffFixture('https://factuez.test',false);expect(f.provider.authorize).not.toHaveBeenCalled();await expect(f.core.start()).rejects.toMatchObject({status:503,code:'ADMIN_BFF_DISABLED'});expect(f.provider.authorize).not.toHaveBeenCalled();
  expect(()=>new AdminSessionBff({origin:'http://localhost',provider:f.provider,store:f.store,facade:f.owner.facade})).toThrow();
 });
 it('issues nonce, state and PKCE bound to a one-use browser flow; never returns an access token',async()=>{
  const f=adminBffFixture(),start=await f.core.start(),u=new URL(start.authorizeUrl),state=u.searchParams.get('state')!;
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(u.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(u.searchParams.get('codeChallenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(f.core.callback('synthetic-valid-code',state,'z'.repeat(43))).rejects.toMatchObject({status:400});
  const login=await f.core.callback('synthetic-valid-code',state,start.browserCookie);expect(Object.keys(login).sort()).toEqual(['expiresAt','sessionCookie']);
  await expect(f.core.callback('synthetic-valid-code',state,start.browserCookie)).rejects.toMatchObject({status:400});expect(f.provider.exchange).toHaveBeenCalledTimes(1);
 });
 it('requires both live IdP verification and the existing Identity administrator before establishing a session',async()=>{
  const f=adminBffFixture();f.owner.state.stepUp=false;await expect(f.login()).rejects.toMatchObject({status:403});expect(f.provider.exchange).toHaveBeenCalledOnce();
  f.owner.state.stepUp=true;const login=await f.login(),s=await f.core.summary(login.sessionCookie);expect(s).toMatchObject({authenticated:true,environment:'BETA'});expect(JSON.stringify(s)).not.toContain(f.token);
 });
 it('seals every server record and binds ciphertext to the deployment, kind and random key',async()=>{
  const f=adminBffFixture(),login=await f.login(),redis=f.redis as AdminRedisDouble;
  const row=[...redis.values.entries()].find(([k])=>k.includes(':session:'))!;expect(row[1].value).not.toContain(f.token);expect(row[0]).not.toContain(login.sessionCookie);expect(row[1].value).toMatch(/^v1\./);
  const target='x'.repeat(43),newKey=row[0].slice(0,row[0].lastIndexOf(':')+1)+adminBffHash(target);redis.values.set(newKey,{...row[1]});await expect(f.store.getSession(target)).rejects.toThrow();
  expect(inspect(f.store)).not.toContain(f.token);expect(inspect(f.core)).not.toContain(f.token);expect(JSON.stringify(f.core)).not.toContain(f.token);
 });
 it('fails closed for unknown sessions, missing CSRF, production, extra queries and arbitrary proxy targets',async()=>{
  const f=adminBffFixture(),login=await f.login(),s=await f.core.summary(login.sessionCookie);if(!s.authenticated)throw Error();
  await expect(f.core.operation(login.sessionCookie,'bad','GET','/bff/b2b-admin/applications?environment=BETA')).rejects.toMatchObject({status:403});
  for(const path of ['https://outside.invalid/bff/b2b-admin/applications?environment=BETA','/bff/b2b-admin/applications?environment=PRODUCTION','/bff/b2b-admin/applications?environment=BETA&environment=BETA','/bff/b2b-admin/applications?environment=BETA&secret=bad'])await expect(f.core.operation(login.sessionCookie,s.csrfToken,'GET',path)).rejects.toThrow();
  await expect(f.core.summary('z'.repeat(43))).rejects.toMatchObject({status:401});
 });
 it('uses real owner CAS/audit for create, read, update and rotate, and exposes a secret only once',async()=>{
  const f=adminBffFixture(),login=await f.login(),s=await f.core.summary(login.sessionCookie);if(!s.authenticated)throw Error();
  const created:any=await f.core.operation(login.sessionCookie,s.csrfToken,'POST','/bff/b2b-admin/applications?environment=BETA',input());expect(created.clientSecret).toHaveLength(43);const id=created.application.id;
  const read:any=await f.core.operation(login.sessionCookie,s.csrfToken,'GET','/bff/b2b-admin/applications/'+id+'?environment=BETA');expect(read).not.toHaveProperty('clientSecret');
  const updated:any=await f.core.operation(login.sessionCookie,s.csrfToken,'PATCH','/bff/b2b-admin/applications/'+id+'?environment=BETA',{expectedRevision:1,label:'SYNTHETIC UPDATED'});expect(updated.application.revision).toBe(2);
  await expect(f.core.operation(login.sessionCookie,s.csrfToken,'PATCH','/bff/b2b-admin/applications/'+id+'?environment=BETA',{expectedRevision:1,enabled:false})).rejects.toMatchObject({status:409});
  const rotated:any=await f.core.operation(login.sessionCookie,s.csrfToken,'POST','/bff/b2b-admin/applications/'+id+'/rotate-secret?environment=BETA',{expectedRevision:2});expect(rotated.application.revision).toBe(3);expect(rotated.clientSecret).not.toBe(created.clientSecret);expect(f.owner.store.audits.filter(x=>x.outcome==='OK')).not.toHaveLength(0);
 });
 it.each(['provider','owner','subject','logout','expiry'])('blocks an existing session after %s changes',async change=>{
  const f=adminBffFixture(),login=await f.login(),s=await f.core.summary(login.sessionCookie);if(!s.authenticated)throw Error();
  if(change==='provider')f.control.active=false;if(change==='owner')f.owner.state.active=false;if(change==='subject')f.control.drift=true;if(change==='logout')await f.core.logout(login.sessionCookie,s.csrfToken);if(change==='expiry')f.control.time+=300001;
  await expect(f.core.operation(login.sessionCookie,s.csrfToken,'GET','/bff/b2b-admin/applications?environment=BETA')).rejects.toThrow();
 });
 it('replaces a prior browser session and rejects in-flight results after logout',async()=>{
  const f=adminBffFixture(),first=await f.login(),start=await f.core.start(),state=new URL(start.authorizeUrl).searchParams.get('state')!,second=await f.core.callback('synthetic-valid-code',state,start.browserCookie,first.sessionCookie);
  await expect(f.core.summary(first.sessionCookie)).rejects.toMatchObject({status:401});const s=await f.core.summary(second.sessionCookie);if(!s.authenticated)throw Error();
  f.owner.store.onGet=()=>{void f.store.deleteSession(second.sessionCookie);};const made:any=await f.core.operation(second.sessionCookie,s.csrfToken,'POST','/bff/b2b-admin/applications?environment=BETA',input());
  f.owner.store.onGet=()=>{void f.store.deleteSession(second.sessionCookie);};await expect(f.core.operation(second.sessionCookie,s.csrfToken,'GET','/bff/b2b-admin/applications/'+made.application.id+'?environment=BETA')).rejects.toMatchObject({status:401});
 });
 it('sanitizes provider failure and caps TTLs/rates without reading any environment secrets',async()=>{
  const f=adminBffFixture();f.control.fail=true;const error:any=await f.login().catch(e=>e);expect(error.code).toBe('ADMIN_BFF_UNAVAILABLE');expect(String(error)).not.toContain('PRIVATE');
  const r=new AdminRedisDouble(f.now);expect(()=>new RedisAdminBffStore(r,randomBytes(31),'qa')).toThrow();expect(()=>new RedisAdminBffStore(r,randomBytes(32),'../escape')).toThrow();
  const fresh=adminBffFixture();for(let i=0;i<30;i++)await fresh.core.rate('one-edge','start');await expect(fresh.core.rate('one-edge','start')).rejects.toMatchObject({status:429});
 });
});
