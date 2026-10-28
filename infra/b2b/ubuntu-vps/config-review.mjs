import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseStrictJson, validateModel, withPostgresOverride, requiredRef } from './model.mjs';
export function reviewConfig(args=[]){
  if(args.some(a=>!['--model-only','--postgres-loopback'].includes(a))||new Set(args).size!==args.length)throw new Error('REVIEW_ARGUMENTS');
  let model=parseStrictJson(readFileSync(new URL('docker-compose.yml',import.meta.url),'utf8'));
  if(args.includes('--postgres-loopback'))model=withPostgresOverride(model,parseStrictJson(readFileSync(new URL('postgres-loopback.override.yml',import.meta.url),'utf8')));
  const validation=validateModel(model);
  const missingImages=Object.entries(model.services).filter(([,s])=>requiredRef(s.image)).map(([n])=>n);
  const missingTiKeys=[...new Set(Object.values(model.services).flatMap(s=>Object.values(s.environment).filter(requiredRef).map(v=>/^\$\{([^:]+)/.exec(v)[1])))].sort();
  return {status:'BLOCKED',modelValid:validation.valid,memoryBytesAllProfiles:validation.memoryBytes,cpuAllProfiles:validation.cpus,errors:validation.errors,missingImages,missingTiKeys,
    gaps:['OWNER_RUNTIME_COMPOSITION','B2B_MTLS_INGRESS_AND_ADMIN_BFF','DATABASE_MIGRATIONS_AND_LEAST_PRIVILEGE_ROLES','FULL_BACKUP_AND_RESTORE','TI_STORAGE_METADATA','PERMANENT_REVIEW_ENTRYPOINT'],
    activationAllowed:false,exitCode:validation.valid&&args.includes('--model-only')?0:2};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  try{const r=reviewConfig(process.argv.slice(2));console.log(JSON.stringify(r,null,2));process.exitCode=r.exitCode;}
  catch{console.log(JSON.stringify({status:'BLOCKED',code:'REVIEW_INPUT_INVALID',activationAllowed:false}));process.exitCode=2;}
}
