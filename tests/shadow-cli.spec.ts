import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';
const path=fileURLToPath(new URL('../migration/shadow-qa-cli.cjs',import.meta.url));
function run(args:string[]){return spawnSync(process.execPath,[path,...args],{encoding:'utf8',timeout:30000});}
describe('fase 4: CLI sólo con fixtures integrados, sin entradas reales',()=>{
  it('ejecuta cuatro casos y mantiene salida de revisión, no de aprobación',()=>{
    const r=run(['--isolated-synthetic-only']);expect(r.error).toBeUndefined();expect(r.status).toBe(3);expect(r.stderr).toBe('');
    const body=JSON.parse(r.stdout);expect(body).toMatchObject({schemaVersion:'factuez.shadow-run-report.v1',count:4,matchingCount:1,
      reviewRequired:true,transmission:false,persisted:false,fiscalWrites:0,outboxWrites:0,countersChanged:false,productionBlocked:true});
    expect(body.reports).toHaveLength(4);expect(body.reports[0]).not.toHaveProperty('differences');
  });
  it('informe completo incluye diferencias sin promover confianza',()=>{
    const r=run(['--isolated-synthetic-only','--full-report']);expect(r.status).toBe(3);const b=JSON.parse(r.stdout);
    expect(b.reports[1].differences.length).toBeGreaterThan(0);expect(b.signatureVerified).toBe(false);expect(b.pdfBytesVerified).toBe(false);
  });
  it.each([[],['--full-report'],['--isolated-synthetic-only','--input','client.json'],['--isolated-synthetic-only','--production'],
    ['--isolated-synthetic-only','--send'],['--isolated-synthetic-only','--isolated-synthetic-only'],['--isolated-synthetic-only','--db','postgres://anything']].map(args=>({args})))('bloquea argumentos ajenos $args',({args})=>{
    const r=run(args);expect(r.status).toBe(2);expect(r.stdout).toBe('');const b=JSON.parse(r.stderr);
    expect(b).toMatchObject({reason:'SHADOW_ARGUMENTS_BLOCKED',transmission:false,persisted:false,productionBlocked:true});
    expect(r.stderr).not.toContain('postgres://');expect(r.stderr).not.toContain('client.json');
  });
});
