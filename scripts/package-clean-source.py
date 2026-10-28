"""Package software sources without local assistants, secrets, data or build caches.
No application, database or Docker mutation. Includes uncommitted source files.
"""
import argparse, hashlib, json, os, stat, zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
DIRECTORIES={'.github','api-contracts','apps','docker','examples','infra','packages','scripts','services','tests'}
ROOT_FILES={'.dockerignore','.env.example','.gitattributes','.gitignore','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','README.md','tsconfig.base.json','turbo.json','vitest.config.mts'}
SKIP_DIRS={'.git','.agents','.codex','.kilo','.cursor','.claude','.vscode','.factuez-demo','.turbo','.ci-python','node_modules','dist','.next','.cache','.pnpm-store','coverage','output','tmp','backups','secrets','data','private_data','generated','__pycache__','.venv','venv'}
PRIVATE_SUFFIXES={'.p12','.pfx','.key','.pem','.p7b','.p7m','.dump','.backup','.bak','.db','.sqlite','.sqlite3','.log','.pyc','.tsbuildinfo'}
def eligible(parts):
 p=Path(*parts);name=p.name
 return not any(s.lower() in SKIP_DIRS for s in parts[:-1]) and not any(s in {'.','..'} for s in parts) and name not in {'AGENTS.md','CODEX.md','skills-lock.json'} and 'HANDOFF' not in name.upper() and p.suffix.lower() not in PRIVATE_SUFFIXES and (not name.startswith('.env') or name=='.env.example')
def inventory():
 files=[]
 for e in ROOT.iterdir():
  if e.is_symlink() or getattr(e.lstat(),'st_file_attributes',0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:continue
  if e.is_file() and (e.name in ROOT_FILES or e.name.startswith('docker-compose') and e.suffix in {'.yml','.yaml'}):files.append(e)
  if e.is_dir() and e.name in DIRECTORIES:
   for base,dirs,names in os.walk(e,followlinks=False):
    dirs[:]=sorted(d for d in dirs if d.lower() not in SKIP_DIRS and not (Path(base)/d).is_symlink() and not (getattr((Path(base)/d).lstat(),'st_file_attributes',0) & stat.FILE_ATTRIBUTE_REPARSE_POINT))
    for name in sorted(names):
     p=Path(base)/name
     if p.is_symlink() or getattr(p.lstat(),'st_file_attributes',0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:continue
     if eligible(p.relative_to(ROOT).parts):files.append(p)
 return sorted(files,key=lambda p:p.relative_to(ROOT).as_posix())
def package(out):
 out=out.resolve()
 if out.exists() or not out.parent.is_dir():raise ValueError('NEW_OUTPUT_WITH_EXISTING_PARENT_REQUIRED')
 files=inventory();manifest=[]
 with zipfile.ZipFile(out,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
  for p in files:
   b=p.read_bytes();name=p.relative_to(ROOT).as_posix();z.writestr(name,b);manifest.append({'path':name,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
  z.writestr('SOURCE_MANIFEST.json',json.dumps({'scope':'CLEAN_SOURCE_NOT_INSTALLED_OR_COMPILED','secretsAndDataIncluded':False,'files':manifest},ensure_ascii=False,indent=2))
 with zipfile.ZipFile(out) as z:
  assert len(z.namelist())==len(manifest)+1
  for f in manifest:assert hashlib.sha256(z.read(f['path'])).hexdigest()==f['sha256'] and eligible(Path(f['path']).parts)
 print(json.dumps({'result':'PASS','files':len(files),'bytes':out.stat().st_size,'zip':str(out),'compiled':False,'containersChanged':False}))
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('output',type=Path);args=parser.parse_args();package(args.output)
