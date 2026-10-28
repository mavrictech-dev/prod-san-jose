import 'reflect-metadata';
import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {b2bReadonlyConfig} from '../services/b2b-api-service/src/readonly-runtime-config';
import {bootstrapB2bReadonly} from '../services/b2b-api-service/src/readonly-main';
import {createBillingReadonlyOwner} from '../services/billing-service/src/b2b/readonly-owner-runtime';
import {createIdentityReadonlyOwner} from '../services/identity-service/src/b2b/readonly-owner-runtime';
import {createFiscalReadonlyOwner} from '../services/sunat-service/src/b2b/readonly-owner-runtime';
import {bootstrapBillingReadonly} from '../services/billing-service/src/b2b/readonly-host';
import {bootstrapIdentityReadonly} from '../services/identity-service/src/b2b/readonly-host';
import {bootstrapFiscalReadonly} from '../services/sunat-service/src/b2b/readonly-host';
const metadata=()=>({schemaVersion:'factuez.b2b.readonly-runtime.v1',profile:'READONLY_OAUTH_WEBHOOKS',environment:'BETA',approvedForPrivateBeta:true,
 deploymentId:randomUUID(),instanceId:randomUUID(),listen:{host:'127.0.0.1',port:9000,maintenancePort:9001},
 edgePeers:['a'.repeat(64)],operatorPeers:['b'.repeat(64)],origins:{identity:'https://identity:9010',billing:'https://billing:9020',fiscal:'https://fiscal:9030',webhooks:'https://webhooks:9040'}});
describe('separate readonly publication selection and review constraints',()=>{
 it('is disabled without explicit opt-in, regardless of fullgraph flags or absent files',async()=>{
  expect(await bootstrapB2bReadonly({B2B_API_ENABLED:'true',B2B_READONLY_CONFIG_ROOT:'Z:/missing'})).toBeNull();
 });
 it('requires B2B_PRIVATE_ACCESS before any owner database or config access',async()=>{
  await expect(bootstrapB2bReadonly({B2B_READONLY_API_ENABLED:'true'})).rejects.toThrow('B2B_PRIVATE_ACCESS_REQUIRED');
  expect(await createBillingReadonlyOwner({enabled:false} as any,null as any)).toBeNull();
  expect(await createIdentityReadonlyOwner({enabled:false} as any,null as any,null as any)).toBeNull();
  expect(await createFiscalReadonlyOwner({enabled:false} as any,null as any)).toBeNull();
  for(const factory of [
   ()=>createBillingReadonlyOwner({enabled:true} as any,null as any),
   ()=>createIdentityReadonlyOwner({enabled:true} as any,null as any,null as any),
   ()=>createFiscalReadonlyOwner({enabled:true} as any,null as any),
  ])await expect(factory()).rejects.toThrow('B2B_PRIVATE_ACCESS_READONLY_OWNER_REQUIRED');
  for(const bootstrap of [bootstrapBillingReadonly,bootstrapIdentityReadonly,bootstrapFiscalReadonly]){
   expect(await bootstrap({DATABASE_URL:'postgresql://never-read.invalid'})).toBeNull();
   await expect(bootstrap({B2B_READONLY_OWNER_ENABLED:'true'})).rejects.toThrow('B2B_PRIVATE_ACCESS_AND_READONLY_CONFIG_REQUIRED');
  }
 });
 it('requires exact BETA approval, four distinct fixed HTTPS owners, bounded ports and separated peers',()=>{
  expect(b2bReadonlyConfig(metadata()).profile).toBe('READONLY_OAUTH_WEBHOOKS');
  for(const patch of [{environment:'PRODUCTION'},{profile:'FULL'},{approvedForPrivateBeta:false},{edgePeers:['b'.repeat(64)]},
   {listen:{host:'0.0.0.0',port:8080,maintenancePort:9001}},{listen:{host:'127.0.0.1',port:9000,maintenancePort:9000}},
   {localIssuanceEnabled:true},{origins:{}}])expect(()=>b2bReadonlyConfig({...metadata(),...patch})).toThrow();
  for(const origin of ['http://identity:9010','https://u:p@identity:9010','https://identity:9010/path','https://identity:9010/?x=1','https://identity:8444','https://identity:9010/#x','https://billing:9020'])
   expect(()=>b2bReadonlyConfig({...metadata(),origins:{...metadata().origins,identity:origin}})).toThrow();
 });
 it('has an isolated review compose fragment with only loopback ports and no current QA mounts',()=>{
  const text=readFileSync(resolve('infra/kong/compose.b2b-readonly.review.yml'),'utf8');
  expect(text).toContain('internal: true');expect(text).toContain('127.0.0.1:9000:9000');expect(text).toContain('127.0.0.1:9001:9001');
  expect(text).not.toMatch(/external:\s*true|privileged:\s*true|network_mode:\s*host|\/var\/run\/docker.sock|stage2|currentQA/i);
  const ports=[...text.matchAll(/- "([^"]+:[0-9]+:[0-9]+)"/g)].map(m=>m[1]);expect(ports).toHaveLength(2);
  for(const port of ports)expect(port).toMatch(/^127\.0\.0\.1:90[0-9]{2}:90[0-9]{2}$/);
 });
});
