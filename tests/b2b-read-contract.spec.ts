import { describe,it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { b2bReadOpenApiV1 } from '../packages/contracts/src/b2b-read-openapi';
import { inspectControllerText } from '../migration/b2b-source-audit.mjs';
const read=(path:string)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
describe('B2B-03 contract matches candidate implementation, not the future design',()=>{
  it('matches all 15 actual read routes and no speculative write endpoint',()=>{
    const api=b2bReadOpenApiV1();
    const actual=inspectControllerText('candidate.ts',read('services/b2b-api-service/src/http.ts')).map((r:any)=>r.method+' '+r.path.replace(/:([A-Za-z]+)/g,'{$1}')).sort();
    const documented=Object.entries(api.paths).flatMap(([p,v]:any)=>Object.keys(v).map(m=>m.toUpperCase()+' '+p)).sort();
    expect(documented).toEqual(actual);expect(documented).toHaveLength(15);expect(documented.every(x=>x.startsWith('GET '))).toBe(true);
    expect(api['x-runtime-enabled']).toBe(false);expect(api.servers).toBeUndefined();
    expect(api).toEqual(JSON.parse(read('api-contracts/b2b/openapi.read.candidate.v1.json')));
  });
  it('requires environment and issuer explicitly for document/artifact IDs, with private transport',()=>{
    const api=b2bReadOpenApiV1();
    for(const [path,methods]of Object.entries(api.paths) as any){const op=methods.get;
      expect(op.security).toEqual([{B2bBearer:[],PrivateTransport:[]}]);expect(op['x-source-implemented']).toBe(true);expect(op['x-runtime-enabled']).toBe(false);
      if(path.includes('{id}'))for(const name of ['issuerId','environment'])expect(op.parameters).toContainEqual(expect.objectContaining({name,in:'query',required:true}));
      expect(op.parameters.some((p:any)=>['password','token','userId','role'].includes(p.name))).toBe(false);
    }
  });
  it('has closed detail, decimal strings, verification unasserted and no original PDF substitution',()=>{
    const s=b2bReadOpenApiV1().components.schemas;
    expect(s.Document.additionalProperties).toBe(false);expect(s.Document.properties.detail).toEqual({$ref:'#/components/schemas/Sale'});
    expect(s.Item.properties.quantity.anyOf[0].type).toBe('string');expect(s.State.properties.fiscal.const).toBe('NOT_VERIFIED');
    expect(s.Artifact.properties.kind.enum).not.toContain('PDF_A4');expect(s.Artifact.properties.representation.const).toBe('ORIGINAL');
    expect(s.PageInfo.required).toContain('snapshotId');expect(s.Coverage.properties.unsupported.const).toEqual(['07','08','09','31']);
  });
  it('all schema references resolve and callers cannot mutate the global contract',()=>{
    const api=b2bReadOpenApiV1();const visit=(v:any)=>{if(!v||typeof v!=='object')return;if(v.$ref)expect(api.components.schemas[v.$ref.split('/').at(-1)!]).toBeDefined();for(const child of Object.values(v))visit(child);};visit(api);
    api.components.schemas.Sale.properties.kind.const='WRONG';expect(b2bReadOpenApiV1().components.schemas.Sale.properties.kind.const).toBe('SALE');
  });
  it('new services remain detached from existing QA and Kong until explicit rollout',()=>{
    for(const path of ['services/billing-service/src/app.module.ts','services/sunat-service/src/app.module.ts','services/identity-service/src/app.module.ts'])expect(read(path)).not.toMatch(/B2bReadModule|B2bBillingReadModule|B2bSunatReadModule|B2bIdentityModule/);
    expect(read('infra/kong/kong.stage2.qa.yml')).not.toContain('/b2b/v1');
  });
});
