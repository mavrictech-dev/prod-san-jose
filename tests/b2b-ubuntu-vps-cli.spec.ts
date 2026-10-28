import { describe,it,expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../infra/b2b/ubuntu-vps/model.mjs';
const path=(n:string)=>fileURLToPath(new URL('../infra/b2b/ubuntu-vps/'+n,import.meta.url));
const cli=(file:string,args:string[]=[])=>spawnSync(process.execPath,[path(file),...args],{encoding:'utf8',timeout:15000});
describe('B2B VPS review CLI and non-activation artifacts',()=>{
  it.each([{args:[]},{args:['--postgres-loopback']}])('default review exits blocked with actionable metadata $args',({args})=>{
    const p=cli('config-review.mjs',args),r=JSON.parse(p.stdout);expect(p.status).toBe(2);expect(r.modelValid).toBe(true);expect(r.activationAllowed).toBe(false);expect(r.status).toBe('BLOCKED');expect(r.missingImages).toHaveLength(18);expect(r.missingTiKeys).toContain('B2B_TI_REVIEW_REFERENCE');
  });
  it.each([{args:['--model-only']},{args:['--model-only','--postgres-loopback']}])('model-only exit zero never means activation $args',({args})=>{
    const p=cli('config-review.mjs',args),r=JSON.parse(p.stdout);expect(p.status).toBe(0);expect(r.status).toBe('BLOCKED');expect(r.memoryBytesAllProfiles).toBe(6_912_212_992);expect(r.activationAllowed).toBe(false);
  });
  it.each([{args:['--activate']},{args:['--model-only','--model-only']}])('has no activation bypass $args',({args})=>expect(cli('config-review.mjs',args).status).toBe(2));
  it('preflight without explicitly supplied metadata blocks without contacting Docker',()=>{
    const p=cli('preflight.mjs');expect(p.status).toBe(2);expect(JSON.parse(p.stdout)).toMatchObject({status:'BLOCKED',activationAllowed:false});
  });
  it('permanent script cannot be enabled by a variable or start a service',()=>{
    const text=readFileSync(path('review-blocked.sh'),'utf8');expect(text).toContain('exit 78');expect(text).not.toMatch(/\bexec\b|\beval\b|\bsource\b|\bif\b/);expect(text).not.toContain('$');
  });
  it('maps exactly the fourteen managed services, with separate infrastructure and placeholders',()=>{
    const r=parseStrictJson(readFileSync(path('runtime-inventory.review.json'),'utf8')),m=parseStrictJson(readFileSync(path('docker-compose.yml'),'utf8'));
    expect(Object.keys(r.managedServices)).toHaveLength(14);expect(r.phases).toEqual(['ADMISSION','PRODUCERS','WORKERS','STORAGE']);
    expect([...Object.values(r.managedServices),...r.infrastructureOnly,...r.metadataOnly].sort()).toEqual(Object.keys(m.services).sort());
    expect(r.facadeSource).toContain('runtime-assembly.ts');expect(r.facadeBootstrapSource).toContain('src/main.ts');expect(m.services['b2b-api-service'].environment.B2B_API_ENABLED).toBe('false');expect(r.activationAllowed).toBe(false);expect(r.managedServices).not.toHaveProperty('REPORTING');
  });
  it('Kong has no reporting, B2B, maintenance, operator, history or exports upstream',()=>{
    const k=parseStrictJson(readFileSync(path('kong.review.json'),'utf8'));expect(k.services.map((s:any)=>s.name).sort()).toEqual(['identity-service','billing-service','sunat-service','received-documents-service','realtime-service','web-pwa'].sort());
    expect(JSON.stringify(k)).not.toMatch(/reporting|b2b-api|maintenance|operations|history-service|integration-export/);
    expect(readFileSync(path('nginx-existing-server.review.conf'),'utf8')).toContain('proxy_pass http://127.0.0.1:9000;');
  });
});
