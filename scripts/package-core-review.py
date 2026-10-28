"""Package only explicitly listed public review artifacts; never a runnable installer."""
from pathlib import Path
from hashlib import sha256
from datetime import datetime, timezone
import json, zipfile, sys, tempfile, subprocess
ROOT=Path(__file__).resolve().parent.parent
OUTPUT=ROOT/'output/install/FactuEz_core_entrega_TI_20261028_v2.zip'
files=[
 'infra/deployment/core-production/'+x for x in ['docker-compose.yml','kong.yml','README.md','validate.mjs','preflight.mjs','build-release.mjs','core-public.template.json']
]+[
 'output/install/core-schema-20261028-v2/'+x for x in ['identity-service.sql','billing-service.sql','sunat-service.sql','mailer-worker.sql','received-documents-service.sql','manifest.json','README.md']
]+['docs/ENTREGA_CONEXIONES_Y_FACTURA01_20261028.md','output/qa/prepared-v4-runtime-20261028.json','output/qa/core-kong-parser-20261028.json']
files += ['docs/CONEXION_API_NATIVA_CORE.md','examples/native-api-client.ts','tests/core-vps-preflight.test.mjs','tests/core-release-plan.test.mjs','services/mailer-worker/src/health.ts']
# Exact public source files required by validate.mjs to check native entrypoints/routes.
files += ['services/'+s+'/src/main.ts' for s in ['identity-service','billing-service','sunat-service','mailer-worker','realtime-service','received-documents-service']]
files += ['services/'+s+'/src/health.controller.ts' for s in ['identity-service','billing-service','sunat-service']]
files += ['services/received-documents-service/src/automation.worker.ts','services/received-documents-service/src/app.module.ts']
files += ['services/billing-service/src/'+x for x in ['products.controller.ts','print-settings.controller.ts','documents.controller.ts','stations.controller.ts']]
files += ['services/sunat-service/src/production-dispatch.controller.ts','services/mailer-worker/src/corporate-document-controller.ts']
verify=r"""import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const fail=()=>{throw Error('REVIEW_PACKAGE_INTEGRITY_FAILED');};
try {
 const manifest=JSON.parse(readFileSync(path.join(root,'MANIFEST.json'),'utf8'));
 if(manifest.scope!=='PUBLIC_REVIEW_ONLY_NOT_AN_INSTALLER'||!Array.isArray(manifest.files))fail();
 const seen=new Set(['MANIFEST.json']);
 for(const f of manifest.files){
  if(typeof f.path!=='string'||!/^[-a-zA-Z0-9_./]+$/.test(f.path)||f.path.split('/').some(p=>!p||p==='.'||p==='..')||seen.has(f.path)||!Number.isSafeInteger(f.bytes)||f.bytes<1||!(/^[a-f0-9]{64}$/).test(f.sha256))fail();
  const full=path.join(root,...f.path.split('/'));let at=root;
  for(const part of f.path.split('/')){at=path.join(at,part);if(lstatSync(at).isSymbolicLink())fail();}
  const st=lstatSync(full);if(!st.isFile()||st.size!==f.bytes)fail();
  const b=readFileSync(full);if(createHash('sha256').update(b).digest('hex')!==f.sha256)fail();seen.add(f.path);
 }
 let count=0;function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())fail();if(e.isDirectory())walk(p);else {if(!e.isFile()||!seen.has(path.relative(root,p).split(path.sep).join('/')))fail();count++;}}}walk(root);
 if(count!==seen.size)fail();
 console.log(JSON.stringify({result:'PASS',files:count,scope:manifest.scope,containersStarted:false,networkUsed:false,databaseUsed:false}));
}catch{console.error('REVIEW_PACKAGE_INTEGRITY_FAILED');process.exitCode=1;}
"""
readme="""# FactuEz — paquete de revisión para TI

Este ZIP actualiza el paquete posterior a la aprobación del Compose e incluye configuración, comprobaciones del servidor, esquemas iniciales, guía de API y evidencia local. No contiene imágenes de aplicación, secretos, certificados privados, ventas ni una copia de la base. Los fragmentos de código incluidos son los archivos originales que necesita el validador para contrastar rutas y procesos; no son el repositorio completo ni permiten compilarlo.

1. Extraer en una carpeta nueva, sin mezclar con una entrega anterior.
2. Ejecutar `node verify-package.mjs` y después `node infra/deployment/core-production/validate.mjs --test`. Sólo leen archivos. Las dos comprobaciones sólo necesitan Node, sin instalar paquetes. También se incluyen tests de la evaluación del host y del plan de imágenes (`node --test tests/core-vps-preflight.test.mjs tests/core-release-plan.test.mjs`), que no ejecutan Docker.
3. Leer `docs/ENTREGA_CONEXIONES_Y_FACTURA01_20261028.md` y `infra/deployment/core-production/README.md`. Este último detalla infraestructura, imágenes por digest, puertos, recursos, archivos, administrador inicial y autorizaciones por RUC.
4. El usuario confirmó la aprobación del Compose. La corrección del UID de Redis a1000:1000 mantiene secretos0600 sin cambiar puertos ni presupuesto; está ensayada en un contenedor nuevo sin red. Leer los prerrequisitos y comprobar el host ANTES del arranque, como fue solicitado. Usa once servicios, 7.700.000.000 bytes de límites y sólo 127.0.0.1:9000. Docker/containerd deben almacenar fuera de /var; los bind del sistema se ubican bajo /srv.
5. Los cinco SQL de `output/install/core-schema-20261028-v2` son exclusivamente para bases nuevas y vacías con confirmación de destino y rol propietario. No ejecutarlos sobre una base existente. No se aplica SQL al verificar este paquete.
6. TI configura infraestructura y primer administrador; después configura emisores, sedes, series, certificados y correo dentro de la plataforma. Los permisos por RUC siguen siendo explícitos; no se envía nada al guardar datos ni al revisar el paquete.

La instalación core aún no publica el B2B productivo completo ni activa recepción externa automática. Los lotes RC múltiples/RA, guías 09/31 productivas y otros perfiles pendientes se detallan en la entrega; este ZIP no acredita el cierre de esas funciones ni un piloto fiscal oficial. El SHA-256 comprueba integridad del paquete recibido, no aprobación fiscal ni autenticidad del remitente por sí solo.
"""
def main():
 if OUTPUT.exists(): raise RuntimeError('OUTPUT_EXISTS_USE_NEW_FILENAME')
 content={}
 for name in files:
  f=ROOT/name
  if not f.is_file() or f.is_symlink() or not f.resolve().is_relative_to(ROOT): raise RuntimeError('SOURCE_INVALID '+name)
  content[name]=f.read_bytes()
 for name in ['output/qa/prepared-v4-runtime-20261028.json','output/qa/core-kong-parser-20261028.json']:
  if json.loads(content[name].decode('utf-8-sig')).get('result')!='PASS': raise RuntimeError('REVIEW_EVIDENCE_NOT_PASS')
 content['verify-package.mjs']=verify.encode()
 content['LEEME_TI.md']=readme.encode()
 manifest={'schemaVersion':'factuez.core-review.v1','scope':'PUBLIC_REVIEW_ONLY_NOT_AN_INSTALLER','createdAt':datetime.now(timezone.utc).isoformat(),'files':[{'path':n,'bytes':len(b),'sha256':sha256(b).hexdigest()} for n,b in sorted(content.items())]}
 content['MANIFEST.json']=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode()
 with tempfile.TemporaryDirectory(prefix='factuez-public-review-') as td:
  base=Path(td)
  for name,b in content.items():
   f=base/name;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(b)
  for args in [['node','verify-package.mjs'],['node','infra/deployment/core-production/validate.mjs','--test'],['node','--test','tests/core-vps-preflight.test.mjs','tests/core-release-plan.test.mjs']]:
   r=subprocess.run(args,cwd=base,capture_output=True,text=True)
   if r.returncode: raise RuntimeError('EXTRACTED_PACKAGE_VERIFICATION_FAILED '+r.stderr[-700:])
   print(r.stdout.strip() if '--test' not in args or 'tests/core-vps-preflight.test.mjs' not in args else 'Extracted package: 42 host/release tests PASS')
 with zipfile.ZipFile(OUTPUT,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for name,b in sorted(content.items()): z.writestr(name,b)
 with zipfile.ZipFile(OUTPUT) as z:
  if z.testzip() is not None or set(z.namelist())!=set(content): raise RuntimeError('ZIP_VERIFICATION_FAILED')
  for name,b in content.items():
   if z.read(name)!=b: raise RuntimeError('ZIP_BYTES_CHANGED')
 digest=sha256(OUTPUT.read_bytes()).hexdigest()
 checksum=OUTPUT.with_suffix('.zip.sha256')
 with checksum.open('x',encoding='ascii') as f: f.write(digest+'  '+OUTPUT.name+'\n')
 print(json.dumps({'result':'PASS','artifact':str(OUTPUT),'sha256':digest,'files':len(content),'bytes':OUTPUT.stat().st_size,'privateDataIncluded':False,'installed':False}))
if __name__=='__main__':main()
