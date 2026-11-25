'use strict';
// Administrator-only local diagnostic. No HTTP, credentials, P12, .env, volume scan, writes or activation.
const {spawnSync}=require('node:child_process'),{createRequire}=require('node:module');
const fs=require('node:fs'),path=require('node:path'),{createHash,X509Certificate}=require('node:crypto');
const FLAGS=['NATIVE_GRE_ENABLED','NATIVE_GRE_WORKERS_ENABLED','SUNAT_PRODUCTION_WORKFLOW_ENABLED','SUNAT_PRODUCTION_NOTES_ENABLED','SUNAT_BETA_TRANSMISSION_ENABLED','SUNAT_BETA_WORKFLOW_ENABLED','GRE_EXTERNAL_TRANSMISSION_ENABLED','BILLING_PRODUCTION_ISSUANCE_ENABLED','BILLING_PRODUCTION_NOTES_ENABLED'];
function docker(args){const r=spawnSync('docker',args,{windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:32768});if(r.status!==0)throw Error('DOCKER_READ_UNAVAILABLE');return r.stdout.trim();}
function container(name){
 if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name))throw Error('CONTAINER_NAME_INVALID');
 const fields={image:'.Config.Image',state:'.State.Status',project:'(index .Config.Labels "com.docker.compose.project")',service:'(index .Config.Labels "com.docker.compose.service")',composeFiles:'(index .Config.Labels "com.docker.compose.project.config_files")',composeConfigHash:'(index .Config.Labels "com.docker.compose.config-hash")'};
 const metadata=Object.fromEntries(Object.entries(fields).map(([key,expression])=>{const value=docker(['inspect','--format',`{{json ${expression}}}`,name]);return [key,value?JSON.parse(value):null];}));
 // Filtering and value normalization happen in Docker's template before stdout. No secret env is returned.
 const allowed=FLAGS.map(f=>`(eq (index $p 0) "${f}")`).join(' ');
 const template=`{{range .Config.Env}}{{$p := split . "="}}{{if or ${allowed}}}{{index $p 0}}={{if eq (index $p 1) "true"}}true{{else if eq (index $p 1) "false"}}false{{else}}UNSET_OR_INVALID{{end}}{{println}}{{end}}{{end}}`;
 const flags=Object.fromEntries(docker(['inspect','--format',template,name]).split('\n').filter(Boolean).map(line=>line.trim().split('=')));
 return {container:name,...metadata,flags,guideAssembly:'Explicit owner-injected enabled capability; these flags alone do not prove GRE composition'};
}
function publicFile(file,certificate=false){
 if(!path.isAbsolute(file)||!(/\.(?:cer|crt|der)$/i.test(file)||!certificate&&/\.(?:pem|crl)$/i.test(file)))throw Error('PUBLIC_FILE_PATH_INVALID');
 const label=path.basename(file);
 try{
  const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>1048576)throw Error();
  const bytes=fs.readFileSync(file);if(/PRIVATE KEY|BEGIN PKCS12/.test(bytes.toString('ascii')))throw Error();
  const metadata={file:label,exists:true,readable:true,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  if(!certificate)return metadata;
  const x509=new X509Certificate(bytes),local=createRequire(path.resolve(__dirname,'../services/sunat-service/package.json')),forge=local('node-forge');
  const {certificateRucCandidates}=local('./dist/infrastructure/crypto/certificate-identity');
  const cert=forge.pki.certificateFromPem(x509.toString());
  // Only public subject identity attributes. Never infer RUC from commonName or other free text.
  const identityAttributes=cert.subject.attributes.filter(a=>['2.5.4.5','2.5.4.97','2.5.4.11'].includes(a.type)).map(a=>({oid:a.type,value:String(a.value).slice(0,200)}));
  const subjectRucCandidates=certificateRucCandidates(cert.subject.attributes);
  return {...metadata,publicCertificate:{fingerprint:x509.fingerprint256.replaceAll(':','').toLowerCase(),subject:x509.subject,issuer:x509.issuer,validFrom:x509.validFrom,validTo:x509.validTo,identityAttributes,subjectRucCandidates,ca:x509.ca},trustDecision:'NOT_EVALUATED'};
 }catch{return {file:label,exists:fs.existsSync(file),readable:false,error:'PUBLIC_FILE_UNAVAILABLE_OR_INVALID'};}
}
function run(args){
 if(args[0]!=='--read-only')throw Error('REQUIRES_READ_ONLY');
 const result={version:1,readOnly:true,containers:[],publicFiles:[],guidance:{CERTIFICATE_RUC_NOT_MATCHED:'Identity gate failed; chain/revocation may not have been evaluated. Obtain public subject OIDs, do not relax identity matching.',PENDING:'No verified CRL evidence yet; do not treat as a verified or revoked certificate.',next:'Compare effective Compose files and flags, then inspect explicit public PKI paths inside the correct installation. No grant or environment changes are performed.'}};
 for(let i=1;i<args.length;i+=2){if(!args[i+1])throw Error('ARGUMENT_INVALID');if(args[i]==='--container')result.containers.push(container(args[i+1]));else if(args[i]==='--public-pki')result.publicFiles.push(publicFile(args[i+1]));else if(args[i]==='--public-certificate')result.publicFiles.push(publicFile(args[i+1],true));else throw Error('ARGUMENT_INVALID');}
 if(!result.containers.length&&!result.publicFiles.length)throw Error('EXPLICIT_TARGET_REQUIRED');
 return result;
}
module.exports={run,publicFile,FLAGS};
if(require.main===module){try{console.log(JSON.stringify(run(process.argv.slice(2)),null,2));}catch{console.error('READ_ONLY_DIAGNOSTIC_FAILED: verify explicit container/public file arguments and local read permissions');process.exitCode=1;}}
