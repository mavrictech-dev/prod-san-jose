import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const services=['identity-service','billing-service','sunat-service','mailer-worker','realtime-service','received-documents-service','web-pwa'];
export const variables=Object.fromEntries(services.map(s=>[s,'CORE_'+s.replaceAll('-','_').toUpperCase()+'_IMAGE']));
export const digest=b=>createHash('sha256').update(b).digest('hex');
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join('|')===[...keys].sort().join('|');
export function registryPrefix(repository){
 if(typeof repository!=='string'||!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(repository))throw Error('SOURCE_REPOSITORY_INVALID');
 const result='ghcr.io/'+repository.toLowerCase().split('/').map(s=>s.replace(/^[._-]+|[._-]+$/g,'').replace(/[._-]+/g,'-')).join('/');
 if(!/^ghcr\.io\/[a-z0-9][a-z0-9-]*[a-z0-9]\/[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(result))throw Error('SOURCE_REPOSITORY_INVALID');return result;
}
export function validateRelease(r,prefix){
 if(!/^ghcr\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/.test(prefix)||prefix.includes('..'))throw Error('REGISTRY_PREFIX_INVALID');
 if(!exact(r,['format','commit','platform','schemaSha256','composeSha256','kongSha256','images'])||r.format!=='factuez.core.release.v1'||r.platform!=='linux/amd64'||!(/^[a-f0-9]{40}$/).test(r.commit)||!['schemaSha256','composeSha256','kongSha256'].every(k=>/^[a-f0-9]{64}$/.test(r[k])))throw Error('RELEASE_INVALID');
 if(!exact(r.images,services))throw Error('EXACT_CORE_IMAGES_REQUIRED');
 for(const s of services)if(!new RegExp('^'+(prefix+'/'+s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'@sha256:[a-f0-9]{64}$').test(r.images[s]))throw Error('IMAGE_NOT_APPROVED_REPOSITORY');
 return r;
}
export function releaseEnvironment(r){return services.map(s=>variables[s]+'='+r.images[s]).join('\n')+'\n';}
export function schemaDigest(root){
 const files=[];function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)){const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('SCHEMA_SYMLINK');if(e.isDirectory())walk(p);else if(/\.(sql|prisma)$/.test(e.name))files.push(p);}}
 for(const s of services.filter(s=>s!=='web-pwa'&&s!=='realtime-service'))walk(path.join(root,'services',s,'prisma'));
 return digest(files.map(p=>path.relative(root,p).replaceAll('\\','/')+'\0'+digest(readFileSync(p))).join('\n'));
}
export function assemble(root,prefix,commit,metadata){
 const images=Object.fromEntries(services.map(s=>{const hash=metadata[s]?.['containerimage.digest'];if(!/^sha256:[a-f0-9]{64}$/.test(hash))throw Error('BUILD_DIGEST_MISSING');return [s,prefix+'/'+s+'@'+hash];}));
 return validateRelease({format:'factuez.core.release.v1',commit,platform:'linux/amd64',schemaSha256:schemaDigest(root),composeSha256:digest(readFileSync(path.join(root,'infra/deployment/core-production/docker-compose.yml'))),kongSha256:digest(readFileSync(path.join(root,'infra/deployment/core-production/kong.yml'))),images},prefix);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const [root,prefix,commit,metadataDir,out]=process.argv.slice(2);if(!out)throw Error('ARGS_REQUIRED');const metadata=Object.fromEntries(services.map(s=>[s,JSON.parse(readFileSync(path.join(metadataDir,s+'.json'),'utf8'))]));const r=assemble(path.resolve(root),prefix,commit,metadata);writeFileSync(out,JSON.stringify(r,null,2)+'\n',{flag:'wx'});console.log('RELEASE_MANIFEST_READY');}catch{console.error('RELEASE_MANIFEST_FAILED');process.exitCode=1;}
}
