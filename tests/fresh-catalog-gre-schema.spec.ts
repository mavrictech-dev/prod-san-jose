import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
const local=createRequire(import.meta.url),{withNativePostgres}=local('./helpers/native-postgres.cjs'),{update}=local('../scripts/update-igv-catalogs-gre.cjs');

describe.skipIf(!process.env.NATIVE_TEST_POSTGRES_BIN)('fresh baseline and subsequent safe update',()=>{
 it('installs all five owner schemas and records applied tax/GRE updates without business rows',async()=>{
  const root=resolve('.'),parent=mkdtempSync(join(tmpdir(),'factuez-fresh-schema-')),target=join(parent,'schemas');
  try{
   const exportResult=spawnSync(process.execPath,['scripts/export-windows-test-schemas.cjs',target],{cwd:root,encoding:'utf8',windowsHide:true,timeout:120000});
   expect(exportResult.status,exportResult.stderr).toBe(0);
   for(const service of ['identity-service','billing-service','sunat-service','mailer-worker','received-documents-service']){
    await withNativePostgres(async({pool}:any)=>{
     await pool.query("SELECT set_config('factuez.schema_target',current_database(),false)");
     await pool.query(readFileSync(join(target,service+'.sql'),'utf8'));
     if(service==='billing-service'||service==='sunat-service'){
      expect((await update(pool,{root,service,apply:false})).pending).toEqual([]);
      await update(pool,{root,service,apply:true});
     }
     if(service==='billing-service'){
      expect((await pool.query('SELECT count(*)::int AS n FROM "Document"')).rows[0].n).toBe(0);
      expect((await pool.query('SELECT count(*)::int AS n FROM "ProductUnit"')).rows[0].n).toBe(7);
      await pool.query('INSERT INTO "ProductCategory" (name,"normalizedKey") VALUES (\'Categoría de prueba\',\'ignored\')');
      expect((await pool.query('SELECT "normalizedKey" FROM "ProductCategory"')).rows[0].normalizedKey).toBe('categoría de prueba');
     }
    });
   }
  }finally{
   expect(realpathSync(parent).startsWith(realpathSync(tmpdir())+sep)).toBe(true);
   rmSync(parent,{recursive:true});
  }
 },120000);
});
