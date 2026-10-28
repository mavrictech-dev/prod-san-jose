import { describe,it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { b2bDraftOpenApiV1 } from '../packages/contracts/src/b2b-read-openapi';
import { inspectControllerText } from '../migration/b2b-source-audit.mjs';
const read=(path:string)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
describe('B2B-04 implemented candidate command contract, no official activation',()=>{
  it('documents 23 actual routes including gated issue',()=>{
    const api=b2bDraftOpenApiV1(),actual=['http.ts','command-http.ts'].flatMap(file=>inspectControllerText(file,read('services/b2b-api-service/src/'+file))).map((r:any)=>r.method+' '+r.path.replace(/:([A-Za-z]+)/g,'{$1}')).sort();
    const documented=Object.entries(api.paths).flatMap(([p,v]:any)=>Object.keys(v).map(m=>m.toUpperCase()+' '+p)).sort();
    expect(documented).toEqual(actual);expect(actual).toHaveLength(23);expect(actual.some(x=>x.endsWith('/issue'))).toBe(true);
    expect(api).toEqual(JSON.parse(read('api-contracts/b2b/openapi.drafts.candidate.v1.json')));expect(api['x-runtime-enabled']).toBe(false);
  });
  it('uses If-Match, idempotency headers and exact recovery; no bearer/command keys in query',()=>{
    const api=b2bDraftOpenApiV1();
    for(const [path,methods]of Object.entries(api.paths) as any)for(const [method,op]of Object.entries(methods) as any){
      expect(op.parameters.some((p:any)=>p.in==='query'&&/token|password|idempotencyKey/.test(p.name))).toBe(false);
      if(method==='patch'||(method==='post'&&path.endsWith('/cancel')))expect(op.parameters).toContainEqual(expect.objectContaining({in:'header',name:'If-Match',required:true}));
      if(path.endsWith('/operations/lookup'))expect(op.parameters).toContainEqual(expect.objectContaining({in:'header',name:'Idempotency-Key',required:true}));
    }
    const draft=api.components.schemas.Draft;expect(draft.properties).not.toHaveProperty('number');expect(draft.properties).not.toHaveProperty('userId');
  });
  it('candidate DDL is not installed at startup and PostgreSQL adapter stores only parameterized drafts/operations',()=>{
    const ddl=read('services/billing-service/b2b-drafts-schema.candidate.sql'),store=read('services/billing-service/src/b2b/draft-store.ts');
    expect(ddl).toContain('B2bDraftCommandUnique');expect(ddl).toContain('B2bDraftReferenceUnique');expect(ddl).not.toMatch(/ALTER TABLE|DELETE FROM|TRUNCATE|nextNumber/);
    expect(store).not.toMatch(/SELECT \*|process\.env|readFile|SeriesCounter|OutboxEvent/);
    expect(read('services/billing-service/src/app.module.ts')).not.toContain('B2bDraftOwnerModule');
    expect(read('infra/kong/kong.stage2.qa.yml')).not.toContain('/b2b/v1');
  });
  it('USER write scopes require document.issue, not merely document.view',()=>{
    const code=read('services/identity-service/src/b2b/service.ts');
    expect(code).toContain("scope === 'b2b:drafts:write' || scope === 'b2b:operations:read' || scope === 'b2b:documents:issue' ? 'document.issue' : 'document.view'");
  });
  it('issue uses a separate explicit scope, 202, revision and empty body, with no fiscal acceptance assertion',()=>{
    const api=b2bDraftOpenApiV1(),op=api.paths['/b2b/v1/document-drafts/{id}/issue'].post;
    expect(op['x-required-scopes']).toEqual(['b2b:drafts:write','b2b:documents:issue']);expect(op.responses['202']).toBeDefined();expect(op.responses['200']).toBeUndefined();
    expect(op.parameters).toContainEqual(expect.objectContaining({name:'If-Match',required:true}));
    expect(api.components.schemas.IssueCommit.properties.fiscalAcceptance.const).toBe('NOT_ASSERTED');
    const issuer=read('services/billing-service/src/b2b/issuance.ts');expect(issuer).toContain('executeWithinTransaction');expect(issuer).not.toMatch(/service\.execute\(|\.fetch\(|SET "publishedAt"/);
    expect(read('services/billing-service/b2b-issuance-schema.candidate.sql')).toContain('fannedOutAt');
  });
});
