// Parse the reviewed public gateway file with local QA Kong; never reload or start services.
'use strict';
const {spawnSync}=require('node:child_process');
const {readFileSync}=require('node:fs');
const {createHash,randomUUID}=require('node:crypto');
const path=require('node:path');
const container='factuez-stage2-qa-kong-1';
function docker(args,input){const r=spawnSync('docker',['--context','desktop-linux',...args],{input,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});if(r.error)throw Error('LOCAL_KONG_CHECK_UNAVAILABLE');return r;}
function checked(args){const r=docker(args);if(r.status!==0)throw Error('LOCAL_QA_METADATA_UNAVAILABLE');return r.stdout.trim();}
try{
 const endpoint=checked(['context','inspect','desktop-linux','--format','{{.Endpoints.docker.Host}}']);
 if(!endpoint.startsWith('npipe:')||!endpoint.toLowerCase().includes('dockerdesktoplinuxengine'))throw Error('LOCAL_DESKTOP_QA_ONLY');
 const meta=JSON.parse(checked(['inspect',container,'--format','{{json .}}']));
 if(meta.Config.Labels['com.docker.compose.project']!=='factuez-stage2-qa'||meta.Config.Labels['com.docker.compose.service']!=='kong'||meta.State.Status!=='running')throw Error('QA_OWNER_OR_STATE_MISMATCH');
 const bytes=readFileSync(path.resolve(__dirname,'../infra/deployment/core-production/kong.yml'));
 if(bytes.length>256*1024)throw Error('PUBLIC_CONFIG_TOO_LARGE');
 const cfg=JSON.parse(bytes.toString('utf8'));
 if(cfg._format_version!=='3.0'||cfg.services?.length!==7)throw Error('PUBLIC_CONFIG_SCOPE_MISMATCH');
 const tmp='/tmp/factuez-core-route-review-'+randomUUID()+'.json';
 const r=docker(['exec','-i',container,'sh','-c','umask 077; cat > "$1"; trap \'rm -f -- "$1"\' EXIT; kong config parse "$1" >/dev/null','sh',tmp],bytes);
 if(r.status!==0)throw Error('KONG_DECLARATIVE_REJECTED');
 console.log(JSON.stringify({result:'PASS',scope:'PUBLIC_CORE_CONFIGURATION_PARSER_ONLY',sha256:createHash('sha256').update(bytes).digest('hex'),kongImageId:meta.Image,services:cfg.services.length,routes:cfg.services.reduce((n,s)=>n+s.routes.length,0),reloaded:false,externalRequests:0}));
}catch(e){console.error(e.message);process.exitCode=1;}
