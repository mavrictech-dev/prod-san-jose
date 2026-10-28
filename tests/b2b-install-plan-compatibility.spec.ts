import {describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {compileInstallPlan} from '../infra/b2b/install-plan/plan.mjs';
import {syntheticPublicInputs} from './helpers/b2b-install-plan.fixture.mjs';
import {b2bReadonlyConfig} from '../services/b2b-api-service/src/readonly-runtime-config';
import {onpremAdminConfig} from '../services/identity-service/src/b2b/onprem-admin-runtime';
describe('install descriptor public JSON matches existing parsers without runtime start or private reads',()=>{
 it('keeps guards closed and validates after explicit approval only in test memory',()=>{
  const root=mkdtempSync(join(tmpdir(),'factuez-install-compat-'));
  try{
   const {d}=syntheticPublicInputs(root),{plan,files}=compileInstallPlan(d,{baseDirectory:root});
   expect(plan.issues).toEqual([]);
   expect(()=>b2bReadonlyConfig(files['api/readonly-runtime.json'])).toThrow('B2B_READONLY_CONFIG_INVALID');
   expect(b2bReadonlyConfig({...files['api/readonly-runtime.json'],approvedForPrivateBeta:true}).origins.identity).toBe(d.origins.identity);
   const config=join(root,'onprem');mkdirSync(config,{mode:0o700});
   writeFileSync(join(config,'onprem-admin.json'),JSON.stringify(files['onprem/onprem-admin.json']),{mode:0o600});
   const env={B2B_ONPREM_ADMIN_ENABLED:'true',B2B_PRIVATE_ACCESS:'true',B2B_ONPREM_ADMIN_CONFIG_ROOT:config,AUTH_BROWSER_ORIGINS:d.existingBrowserOrigins.join(',')};
   expect(()=>onpremAdminConfig(env)).toThrow('ONPREM_CONFIG_INVALID');
   writeFileSync(join(config,'onprem-admin.json'),JSON.stringify({...files['onprem/onprem-admin.json'],approvedForLocalSetup:true}),{mode:0o600});
   expect(onpremAdminConfig(env)!.config.tokenIssuer).toBe(d.tokenIssuer);
   // Public guard only. No factory, listener, private file or DB is invoked.
   const onprem=readFileSync('services/identity-service/src/b2b/ONPREM_ADMIN_QA.md','utf8');
   expect(onprem).toContain('B2B_ONPREM_ADMIN_ENABLED=false');
  }finally{if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw Error('OWNED_TEST_ROOT_REQUIRED');rmSync(root,{recursive:true,force:true});}
 });
});
