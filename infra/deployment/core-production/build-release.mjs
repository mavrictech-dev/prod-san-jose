/** Build native production images in the source checkout, never on startup or during preflight. */
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,realpathSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../../..');
export function releasePlan({repository,version,nodeBase}){
 if(typeof repository!=='string'||repository.length>180||!(/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{2,5})?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/).test(repository))throw Error('PRIVATE_REGISTRY_REPOSITORY_REQUIRED');
 if(typeof version!=='string'||!(/^[0-9][a-zA-Z0-9._-]{0,63}$/).test(version)||/latest/i.test(version))throw Error('EXPLICIT_RELEASE_VERSION_REQUIRED');
 if(typeof nodeBase!=='string'||!/^node:22-bookworm-slim@sha256:[a-f0-9]{64}$/.test(nodeBase))throw Error('PINNED_NODE_22_BASE_REQUIRED');
 const services=['identity-service','billing-service','sunat-service','mailer-worker','realtime-service','received-documents-service','web-pwa'];
 return {schemaVersion:'factuez.native-release-plan.v1',platform:'linux/amd64',repository,version,nodeBase,images:services.map(service=>{
  const image=`${repository}/${service}:${version}`,web=service==='web-pwa';
  const args=['build','--platform','linux/amd64','--file',web?'docker/Dockerfile.web-pwa':'docker/Dockerfile.service',
   '--build-arg','NODE_BASE_IMAGE='+nodeBase,...(web?['--build-arg','NEXT_PUBLIC_API_BASE_URL=','--build-arg','NEXT_PUBLIC_B2B_ADMIN_PROFILE=SSO']:
   ['--build-arg','SERVICE_NAME=@factuez/'+service,'--build-arg','SERVICE_PATH=services/'+service]),'--tag',image,'.'];
  return {service,image,build:{executable:'docker',args},publishAfterPrivateRegistryApproval:{executable:'docker',args:['push',image]}};
 }),startsContainers:false,pushesImages:false,buildOnVpsRecommended:false};
}
function docker(args,inherit=false){const r=spawnSync('docker',args,{cwd:root,encoding:'utf8',stdio:inherit?'inherit':['ignore','pipe','pipe'],windowsHide:true,maxBuffer:1048576});
 if(r.error||r.status!==0)throw Error('RELEASE_DOCKER_COMMAND_FAILED');return r.stdout?.trim();}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2);if(args.length!==5||!['--plan','--build'].includes(args[0]))throw Error('USAGE_plan_or_build_REPOSITORY_VERSION_NODE_BASE_ABSOLUTE_NEW_MANIFEST');
  const [action,repository,version,nodeBase,out]=args,plan=releasePlan({repository,version,nodeBase});
  if(!path.isAbsolute(out)||realpathSync(path.dirname(out))!==path.dirname(out))throw Error('NEW_ABSOLUTE_OUTPUT_REQUIRED');
  try{lstatSync(out);throw Error('OUTPUT_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
  const bundle={...plan,createdAt:new Date().toISOString(),buildDefinitionSha256:createHash('sha256').update(readFileSync(path.join(root,'pnpm-lock.yaml'))).update(readFileSync(path.join(root,'docker/Dockerfile.service'))).update(readFileSync(path.join(root,'docker/Dockerfile.web-pwa'))).digest('hex')};
  if(action==='--build'){
   const info=JSON.parse(docker(['info','--format','{{json .}}']));if(info.OSType!=='linux')throw Error('LINUX_DOCKER_REQUIRED');
   for(const image of bundle.images){docker(image.build.args,true);const meta=JSON.parse(docker(['image','inspect',image.image,'--format','{{json .}}']));
    if(meta.Os!=='linux'||meta.Architecture!=='amd64'||!/^sha256:[a-f0-9]{64}$/.test(meta.Id))throw Error('RELEASE_IMAGE_PLATFORM_INVALID');
    image.built={imageId:meta.Id,platform:'linux/amd64',repoDigests:meta.RepoDigests??[],publishedByThisTool:false};
   }
  }
  writeFileSync(out,JSON.stringify({...bundle,result:action==='--build'?'LOCAL_IMAGES_BUILT_NOT_PUBLISHED':'PLAN_ONLY'},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({result:action==='--build'?'LOCAL_IMAGES_BUILT_NOT_PUBLISHED':'PLAN_ONLY',images:bundle.images.length,manifest:out,pushed:false,containersStarted:false}));
 }catch(e){console.error(/^[A-Z_]+$/.test(e.message)?e.message:'RELEASE_PREPARATION_FAILED');process.exitCode=1;}
}
