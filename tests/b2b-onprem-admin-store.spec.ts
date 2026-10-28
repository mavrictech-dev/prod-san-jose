import {describe,it,expect,vi} from 'vitest';
import {OnpremReadonlyPgStore} from '../services/identity-service/src/b2b/onprem-admin-store';
import {onpremAdminConfig} from '../services/identity-service/src/b2b/onprem-admin-runtime';
import {binding,id} from './b2b-identity.fixture';
import {b2bReadonlyScopes} from '../packages/service-access/src/b2b-readonly-owner';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
const row=()=>({id:id(51),label:'Synthetic readonly client',kind:'SERVICE' as const,enabled:true,revision:1,secretHash:'a'.repeat(64),oidcClientId:null,scopes:['b2b:context:read' as const],bindings:[binding]});
function setup(){
 const calls:{sql:string;values:any[]}[]=[],c=row(),catalogue={validate:vi.fn(async()=>{})};
 const raw:any={$queryRawUnsafe:vi.fn(async(sql:string,...values:any[])=>{
  calls.push({sql,values});
  if(sql.includes('FOR UPDATE'))return [c];
  const {secretHash,...metadata}=c;return [metadata];
 }),$executeRawUnsafe:vi.fn(async(sql:string,...values:any[])=>{calls.push({sql,values});return 1;})};
 const db:any={...raw,$transaction:vi.fn(async(work:any)=>work(raw))};
 return {store:new OnpremReadonlyPgStore(db,catalogue),db,raw,catalogue,c,calls};
}
describe('OnPrem persistence reuses PostgreSQL owner transactions and limits the profile',()=>{
 it('limits metadata SQL to BETA SERVICE readonly scopes with keyset paging and no hash projection',async()=>{
  const f=setup();const rows=await f.store.transaction(tx=>tx.list!({environment:'BETA',limit:25}));
  expect(rows).toHaveLength(1);const q=f.calls[0];expect(q.sql).toContain('"environment"=\'BETA\'');expect(q.sql).toContain('"kind"=\'SERVICE\'');
  expect(q.sql).toContain('"scopes"<@$3::jsonb');expect(q.sql).not.toContain('secretHash');expect(q.values).toEqual([null,26,JSON.stringify(b2bReadonlyScopes)]);
 });
 it('revalidates current complete bindings before create/update and leaves rate/audit SQL owned by the existing adapter',async()=>{
  const f=setup();await f.store.transaction(async tx=>{await tx.create(f.c);await tx.save({...f.c,revision:2},1);});
  expect(f.catalogue.validate).toHaveBeenCalledTimes(2);expect(f.catalogue.validate).toHaveBeenCalledWith([binding]);
  expect(f.calls.some(q=>q.sql.startsWith('INSERT INTO "B2bClient"'))).toBe(true);expect(f.calls.some(q=>q.sql.startsWith('UPDATE "B2bClient"'))).toBe(true);
  await f.store.rate('b'.repeat(64),1,5);expect(f.calls.at(-1)!.sql).toContain('"B2bRateBucket"');
 });
 it('rejects USER, execution scopes, production binding and retired hierarchy before any SQL mutation',async()=>{
  const f=setup();
  for(const patch of [{kind:'USER',oidcClientId:'no'},{scopes:['b2b:documents:issue']},{bindings:[{...binding,environment:'PRODUCTION'}]}])
   await expect(f.store.transaction(tx=>tx.create({...f.c,...patch} as any))).rejects.toThrow();
  expect(f.raw.$executeRawUnsafe).not.toHaveBeenCalled();
  f.catalogue.validate.mockRejectedValueOnce(Error('RETIRED_CONTEXT'));
  await expect(f.store.transaction(tx=>tx.create(f.c))).rejects.toThrow('RETIRED_CONTEXT');expect(f.raw.$executeRawUnsafe).not.toHaveBeenCalled();
 });
 it('allows revocation of a client whose catalogue retired, while preventing re-enable and secret rotation into retired grants',async()=>{
  const f=setup();f.catalogue.validate.mockRejectedValue(Error('RETIRED_CONTEXT'));
  await f.store.transaction(tx=>tx.save({...f.c,enabled:false,revision:2},1));expect(f.catalogue.validate).not.toHaveBeenCalled();
  await expect(f.store.transaction(tx=>tx.save({...f.c,enabled:true,revision:3},2))).rejects.toThrow('RETIRED_CONTEXT');
 });
 it('requires approved BETA metadata and HTTPS origins already enrolled by browser sessions',()=>{
  const root=mkdtempSync(join(tmpdir(),'factuez-onprem-config-'));
  const metadata={schemaVersion:'factuez.b2b.onprem-admin.v1',profile:'ONPREM',environment:'BETA',approvedForLocalSetup:true,
   origins:['https://pwa.synthetic.invalid'],billingOrigin:'https://billing.synthetic.invalid:9020',tokenIssuer:'https://identity.synthetic.invalid'};
  const env={B2B_ONPREM_ADMIN_ENABLED:'true',B2B_PRIVATE_ACCESS:'true',B2B_ONPREM_ADMIN_CONFIG_ROOT:root,AUTH_BROWSER_ORIGINS:'https://pwa.synthetic.invalid'};
  try{
   writeFileSync(join(root,'onprem-admin.json'),JSON.stringify(metadata),{mode:0o600});expect(onpremAdminConfig(env)!.config.profile).toBe('ONPREM');
   expect(()=>onpremAdminConfig({...env,AUTH_BROWSER_ORIGINS:''})).toThrow('ONPREM_EXISTING_BROWSER_HTTPS_ORIGIN_REQUIRED');
   for(const patch of [{environment:'PRODUCTION'},{profile:'SSO'},{approvedForLocalSetup:false},{origins:['http://pwa.synthetic.invalid']}]){writeFileSync(join(root,'onprem-admin.json'),JSON.stringify({...metadata,...patch}));expect(()=>onpremAdminConfig(env)).toThrow();}
  }finally{if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw Error('SYNTHETIC_ROOT_REQUIRED');rmSync(root,{recursive:true,force:true});}
 });
});
