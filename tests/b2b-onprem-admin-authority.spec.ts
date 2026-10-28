import 'reflect-metadata';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import {onpremFixture,origin,password} from './helpers/b2b-onprem-admin.fixture';
import {binding} from './b2b-identity.fixture';
import {onpremAdminConfig} from '../services/identity-service/src/b2b/onprem-admin-runtime';
const fixtures:Awaited<ReturnType<typeof onpremFixture>>[]=[];
async function make(){const f=await onpremFixture();fixtures.push(f);return f;}
afterEach(()=>{for(const f of fixtures.splice(0))f.close();vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('OnPrem authority verifies actual current password, human JWT, owner RBAC and browser revocation',()=>{
 it('is opt-in; disabled startup reads no mounted config',()=>{
  expect(onpremAdminConfig({})).toBeNull();
  expect(onpremAdminConfig({B2B_ONPREM_ADMIN_CONFIG_ROOT:'Z:/never-read',B2B_ONPREM_ADMIN_ENABLED:'false'})).toBeNull();
  expect(()=>onpremAdminConfig({B2B_ONPREM_ADMIN_ENABLED:'true'})).toThrow('ONPREM_PRIVATE_ACCESS_AND_CONFIG_REQUIRED');
 });
 it('cannot turn a fresh regular PWA login or a forged stepUp claim into authority',async()=>{
  const f=await make();await f.establish();
  await expect(f.authority.verify('forged-proof')).rejects.toMatchObject({status:403});
  await expect(f.authority.execute(f.req,proof=>f.authority.verify(proof))).rejects.toMatchObject({status:403});
  const parts=f.req.headers.authorization.slice(7).split('.'),claims=JSON.parse(Buffer.from(parts[1],'base64url').toString());
  claims.stepUpVerified=true;parts[1]=Buffer.from(JSON.stringify(claims)).toString('base64url');f.req.headers.authorization='Bearer '+parts.join('.');
  await expect(f.authority.status(f.req)).rejects.toMatchObject({status:401});
 });
 it('requires exact current password, not username, subject, current login or a new password store',async()=>{
  const f=await make();await f.establish();
  await expect(f.authority.reauthenticate(f.req,{password:'incorrect-password'})).rejects.toMatchObject({status:403,code:'ONPREM_PASSWORD_REAUTH_FAILED'});
  expect(f.store.audits.at(-1)?.outcome).toBe('INVALID_PASSWORD');
  await expect(f.authority.reauthenticate(f.req,{password,userId:f.userId})).rejects.toMatchObject({status:400});
  await f.authority.reauthenticate(f.req,{password});
  const result=await f.authority.execute(f.req,proof=>f.authority.verify(proof));
  expect(result).toEqual({id:f.userId,stepUpVerified:true});
  expect(f.store.audits.at(-1)?.outcome).toBe('VERIFIED');
  expect(JSON.stringify(f.store.audits)).not.toContain(password);
  expect(JSON.stringify(f.authority)).not.toMatch(new RegExp(password+'|'+f.req.headers.authorization.slice(7)));
 });
 it.each([
  {origin:'https://forged.invalid'},
  {origin:origin+'/'},
  {origin:'null'},
  {'sec-fetch-site':'cross-site'},
  {'x-factuez-b2b-admin':'SSO'},
 ])('rejects forged/missing origin and intent metadata %j before password work',async patch=>{
  const f=await make();await f.establish();Object.assign(f.req.headers,patch);
  const verify=vi.spyOn(f.passwords,'verify');
  await expect(f.authority.reauthenticate(f.req,{password})).rejects.toMatchObject({status:403});expect(verify).not.toHaveBeenCalled();
 });
 it('rejects CSRF loss, duplicate cookies and cookie transplantation to another primary session',async()=>{
  const f=await make();await f.establish();
  f.req.headers['x-factuez-csrf']=randomBytes(32).toString('base64url');
  await expect(f.authority.reauthenticate(f.req,{password})).rejects.toMatchObject({status:403});
  await f.establish();f.req.headers.cookie+='; '+f.req.headers.cookie;
  await expect(f.authority.reauthenticate(f.req,{password})).rejects.toMatchObject({status:401});
 });
 it.each(['revision','disabled','role','permission','primary-session'])('rejects stale authority after %s change on every operation',async change=>{
  const f=await make();await f.verify();
  if(change==='revision')f.row.authVersion++;
  if(change==='disabled')f.row.active=false;
  if(change==='role')f.row.roles[0].role.active=false;
  if(change==='permission')f.row.roles[0].role.permissions=f.row.roles[0].role.permissions.filter((p:any)=>p.permission.code!=='ROLE_MANAGE');
  if(change==='primary-session')f.revokeBrowser();
  await expect(f.authority.execute(f.req,proof=>f.authority.verify(proof))).rejects.toMatchObject({status:expect.any(Number)});
 });
 it('rechecks the owner row after real scrypt and refuses a password/auth revision changed during verification',async()=>{
  const f=await make();await f.establish();
  const verify=f.passwords.verify.bind(f.passwords);
  vi.spyOn(f.passwords,'verify').mockImplementation(async(...args)=>{const result=await verify(...args);f.row.authVersion++;return result;});
  await expect(f.authority.reauthenticate(f.req,{password})).rejects.toMatchObject({status:401});
  expect(f.store.audits.some(a=>a.outcome==='VERIFIED')).toBe(false);
 });
 it('invalidates previous proof on wrong repeat password and fails closed when audit persistence fails',async()=>{
  const f=await make();await f.verify();
  await expect(f.authority.reauthenticate(f.req,{password:'incorrect'})).rejects.toMatchObject({status:403});
  await expect(f.authority.execute(f.req,p=>f.authority.verify(p))).rejects.toMatchObject({status:403});
  f.store.failAudit=true;
  await expect(f.authority.reauthenticate(f.req,{password})).rejects.toThrow();
  f.store.failAudit=false;await expect(f.authority.execute(f.req,p=>f.authority.verify(p))).rejects.toMatchObject({status:403});
 });
 it('expires at a fixed two-minute bound and rate-limits reauth before repeated password work',async()=>{
  const f=await make();await f.verify();f.advance(120001);
  await expect(f.authority.execute(f.req,p=>f.authority.verify(p))).rejects.toMatchObject({status:401});
  await f.establish();f.store.limited=true;const verify=vi.spyOn(f.passwords,'verify');
  await expect(f.authority.reauthenticate(f.req,{password})).rejects.toMatchObject({status:429});expect(verify).not.toHaveBeenCalled();
 });
 it('uses verified server authority for persistent B2bIdentity create/read/update/secret rotation, never password forwarding',async()=>{
  const f=await make();await f.verify();const query={environment:'BETA'};
  const made:any=await f.applications.run(f.req,'CREATE',undefined,query,{label:'Synthetic readonly',kind:'SERVICE',scopes:['b2b:context:read','b2b:catalog:read'],bindings:[binding]});
  expect(made.application.kind).toBe('SERVICE');expect(made.clientSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(f.store.clients.get(made.application.id)!.secretHash).not.toBe(made.clientSecret);
  const read:any=await f.applications.run(f.req,'READ',made.application.id,query);expect(read.application.id).toBe(made.application.id);expect(read.clientSecret).toBeUndefined();
  const rotated:any=await f.applications.run(f.req,'ROTATE',made.application.id,query,{expectedRevision:1});expect(rotated.clientSecret).not.toBe(made.clientSecret);
  await expect(f.applications.run(f.req,'CREATE',undefined,query,{label:'Unsafe',kind:'USER',scopes:['b2b:context:read'],bindings:[binding]})).rejects.toMatchObject({status:400});
  await expect(f.applications.run(f.req,'CREATE',undefined,query,{label:'Unsafe',kind:'SERVICE',scopes:['b2b:documents:issue'],bindings:[binding]})).rejects.toMatchObject({status:400});
  expect(f.catalogue.validate).toHaveBeenCalledWith([binding]);
  expect(JSON.stringify(f.catalogue.validate.mock.calls)).not.toContain(password);
  await f.authority.logout(f.req);await expect(f.applications.run(f.req,'READ',made.application.id,query)).rejects.toMatchObject({status:401});
 });
});
