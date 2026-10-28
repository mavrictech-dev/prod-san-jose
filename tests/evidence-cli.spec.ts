import {it,describe,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
describe('runner evidencia: inputs y efectos fuera de alcance bloqueados',()=>{
  it.each([[],['--production'],['--isolated-synthetic-only','--ruc','20615878481'],['--isolated-synthetic-only','--file','real.xml'],['--isolated-synthetic-only','--send'],['--isolated-synthetic-only','--output','D:/Facturacion/FactuEz']].map(args=>[args]))('bloquea argumentos %j antes de cargar fixtures/servicios',args=>{
    const r=spawnSync(process.execPath,['migration/evidence-qa-cli.cjs',...args],{cwd:resolve('.'),encoding:'utf8',timeout:8000,windowsHide:true});
    expect(r.status).toBe(2);expect(r.stdout).toBe('');expect(r.stderr).toContain('EVIDENCE_ARGUMENTS_BLOCKED');
  });
  it('no contiene configuración real, certificados guardados o clientes de emisión',()=>{
    const source=readFileSync('migration/evidence-qa-cli.cjs','utf8');expect(source).not.toMatch(/process\.env|readFileSync|new PrismaClient|new Queue|sendBill|sendSummary|OAuth/);
    const imports=[...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m=>m[1]);expect(imports.some(p=>/prisma|dotenv|billing|sunat-service|bullmq|redis|soap/.test(p))).toBe(false);
    expect(source).toContain('networkAttempts');expect(source).toContain("flag:'wx'");expect(source).toContain('privateKeysPersisted:false');
  });
});
