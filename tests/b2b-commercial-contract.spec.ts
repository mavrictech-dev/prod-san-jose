import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {b2bCandidateOpenApiV1} from '../packages/contracts/src/b2b-read-openapi';
import {inspectControllerText} from '../migration/b2b-source-audit.mjs';
import {PostgresB2bCommercialStore} from '../services/billing-service/src/b2b/commercial-store';
const read=(p:string)=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
describe('B2B-06 actual contract and immutable fiscal boundaries',()=>{
  it('documents all 136 actual candidate actions and never adds undocumented producer endpoints',()=>{
    const api=b2bCandidateOpenApiV1(),actual=['http.ts','command-http.ts','extraction-http.ts','webhooks.ts','commercial.ts','corrections.ts','guides.ts','guide-preparation.ts','guide-issue.ts','guide-artifacts.ts','carrier-guide-operations.ts','batch-operations.ts','batch-artifacts.ts','received.ts','received-commands.ts','integration-admin.ts','phase8-business.ts','phase8-reports.ts','phase8-history.ts','phase8-admin.ts','received-automation.ts','email-deliveries.ts'].flatMap(file=>inspectControllerText(file,read('services/b2b-api-service/src/'+file))).map((r:any)=>r.method+' '+r.path.replace(/:([A-Za-z]+)/g,'{$1}')).sort();
    const documented=Object.entries(api.paths).flatMap(([path,v]:any)=>Object.keys(v).map(m=>m.toUpperCase()+' '+path)).sort();expect(documented).toEqual(actual);expect(actual).toHaveLength(136);expect(api).toEqual(JSON.parse(read('api-contracts/b2b/openapi.candidate.v1.json')));
    expect(api.paths).not.toHaveProperty('/b2b/v1/credit-notes');expect(api.paths).not.toHaveProperty('/b2b/v1/debit-notes');
  });
  it('conversion requires write + issue scopes, exact ETag, 202 and empty body',()=>{
    const api=b2bCandidateOpenApiV1(),op=api.paths['/b2b/v1/sales-notes/{id}/convert'].post;expect(op['x-required-scopes']).toEqual(['b2b:sales-notes:write','b2b:documents:issue']);expect(op.responses['202']).toBeDefined();expect(op.parameters).toContainEqual(expect.objectContaining({name:'If-Match',required:true}));expect(op.requestBody.content['application/json'].schema.$ref).toContain('EmptyCommand');
    expect(api.components.schemas.SalesNote.properties.documentType.const).toBe('NV');expect(api.components.schemas.CorrectionRequest.properties.fiscalExecutionEnabled.const).toBe(false);
  });
  it('readiness never accepts proof flags, confirms completeness or supplies an executable balance',()=>{
    const api=b2bCandidateOpenApiV1(),op=api.paths['/b2b/v1/correction-requests/{id}/readiness'].get;expect(op['x-required-scopes']).toEqual(['b2b:corrections:read','b2b:documents:read']);expect(op.requestBody).toBeUndefined();
    const p=api.components.schemas.CorrectionReadiness.properties;expect(p.evidenceAuthenticityVerified.const).toBe(false);expect(p.declarations.properties.spendableBalance.const).toBe(false);expect(p.declarations.properties.historyCompleteness.const).toBe('NOT_VERIFIED');
    const code=read('services/billing-service/src/b2b/commercial-store.ts');expect(code).toContain('LIMIT 101');expect(code).toContain('UNION');expect(code).toContain('SELECT DISTINCT n."id" FROM "DocumentReference"');expect(code).not.toContain("sunatStatus\"<>'REJECTED'");
  });
  it('does not change fiscal activation guards, mains, Kong or legacy Outbox cursors',()=>{
    expect(read('services/billing-service/src/application/beta-supplement-command.service.ts')).toContain('assertBillingSupplementActivation();');expect(read('services/billing-service/src/application/financial-ledger-candidate.service.ts')).toContain('assertFinancialLedgerCandidateActivation();');
    const store=read('services/billing-service/src/b2b/commercial-store.ts');expect(store).toContain('new PgDraftTransaction(db,issuer)');expect(store).not.toMatch(/\.execute\(|SET "publishedAt"|notes-qa|process\.env|SELECT \*/);
    expect(read('services/billing-service/src/app.module.ts')).not.toContain('B2bCommercialOwnerModule');expect(read('infra/kong/kong.stage2.qa.yml')).not.toContain('/b2b/v1');
    const ddl=read('services/billing-service/b2b-commercial-schema.candidate.sql');expect(ddl).toContain('B2bSalesNoteCounter');expect(ddl).toContain('"convertedDocumentId" uuid UNIQUE');expect(ddl).not.toMatch(/ALTER TABLE|TRUNCATE|DELETE FROM|UPDATE "SeriesCounter"/);
  });
  it.each([
    {code:'23505'},
    {code:'P2002'},
    {code:'P2010',meta:{code:'23505'}},
    {code:'P2010',meta:{driverAdapterError:{cause:{kind:'UniqueConstraintViolation'}}}},
  ])('normalizes a real unique violation, including the Prisma pg driver shape',async error=>{
    const store=new PostgresB2bCommercialStore({$transaction:async()=>{throw error;}});
    await expect(store.transaction('synthetic',async()=>null)).rejects.toMatchObject({status:409,code:'COMMERCIAL_REFERENCE_CONFLICT'});
  });
  it('does not misclassify a foreign-key or unknown driver error as a duplicate',async()=>{
    const store=new PostgresB2bCommercialStore({$transaction:async()=>{throw {code:'P2010',meta:{driverAdapterError:{cause:{kind:'ForeignKeyConstraintViolation'}}}};}});
    await expect(store.transaction('synthetic',async()=>null)).rejects.toMatchObject({status:503,code:'COMMERCIAL_STORE_UNAVAILABLE'});
  });
});
