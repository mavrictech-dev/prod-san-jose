import { describe,it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { b2bCandidateOpenApiV1 } from '../packages/contracts/src/b2b-read-openapi';
import { inspectControllerText } from '../migration/b2b-source-audit.mjs';
const read=(path:string)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
describe('B2B-03 persistent extraction contract and gates',()=>{
  it('documents exactly 136 candidate operations without publishing them',()=>{
    const api=b2bCandidateOpenApiV1(),actual=['http.ts','command-http.ts','extraction-http.ts','webhooks.ts','commercial.ts','corrections.ts','guides.ts','guide-preparation.ts','guide-issue.ts','guide-artifacts.ts','carrier-guide-operations.ts','batch-operations.ts','batch-artifacts.ts','received.ts','received-commands.ts','integration-admin.ts','phase8-business.ts','phase8-reports.ts','phase8-history.ts','phase8-admin.ts','received-automation.ts','email-deliveries.ts'].flatMap(file=>inspectControllerText(file,read('services/b2b-api-service/src/'+file))).map((r:any)=>r.method+' '+r.path.replace(/:([A-Za-z]+)/g,'{$1}')).sort();
    const documented=Object.entries(api.paths).flatMap(([p,v]:any)=>Object.keys(v).map(m=>m.toUpperCase()+' '+p)).sort();expect(documented).toEqual(actual);expect(actual).toHaveLength(136);
    expect(api).toEqual(JSON.parse(read('api-contracts/b2b/openapi.candidate.v1.json')));expect(api.servers).toBeUndefined();expect(api['x-runtime-enabled']).toBe(false);
  });
  it('preserves legacy payload version, validates all references and documents issuer selection separately',()=>{
    const api=b2bCandidateOpenApiV1(),visit=(v:any)=>{if(!v||typeof v!=='object')return;if(v.$ref)expect(api.components.schemas[v.$ref.split('/').at(-1)!]).toBeDefined();for(const child of Object.values(v))visit(child);};visit(api);
    const s=api.components.schemas;expect(s.WrappedExportJob.properties.payloadContract.const).toBe('factuez.integration.v1');expect(s.B2bExportRequest.properties.filters.properties).not.toHaveProperty('issuerRuc');
    const post=api.paths['/b2b/v1/exports'].post;expect(post.parameters).toContainEqual(expect.objectContaining({name:'issuerId',in:'query',required:true}));expect(post.responses['202']).toBeDefined();
  });
  it('keeps separate owner authentication and persistence; no TOKEN/B2B -> legacy HTTP forwarding',()=>{
    const bridge=read('services/integration-export-service/src/b2b/core.ts');expect(bridge).toContain('B2bOwnerReadFrame');expect(bridge).not.toMatch(/new PrivateReadHttp|new RemoteReadIdentity|DATABASE_URL|process\.env/);
    const persistence=read('services/integration-export-service/src/b2b/persistence.ts');expect(persistence).toContain("name!=='b2b_exports_beta'");expect(persistence).not.toContain('CREATE TABLE');
    const identity=read('services/identity-service/src/b2b/service.ts');expect(identity).toContain("user.permissions.includes('report.export')");
  });
  it('does not wrap the existing process main, join its work queue or relax TLS',()=>{
    expect(read('services/integration-export-service/src/main.ts')).not.toContain('B2bExtraction');
    expect(read('infra/kong/kong.stage2.qa.yml')).not.toContain('/b2b/v1');
    expect(read('services/b2b-api-service/src/draft-application.ts')).toContain("minVersion:'TLSv1.2'");
  });
});
