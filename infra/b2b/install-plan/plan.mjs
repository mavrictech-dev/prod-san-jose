// Offline public configuration planner. No network, subprocess, DB, env-file,
// private-key parsing, secret generation, runtime imports or deployment.
import {readFileSync,lstatSync,realpathSync,openSync,fstatSync,readSync,closeSync,constants,mkdirSync,writeFileSync} from 'node:fs';
import {X509Certificate,createPublicKey,createHash} from 'node:crypto';
import {isIP} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const certificateRoles=['identityServer','billingServer','fiscalServer','webhooksServer','apiServer','resource','oauth','edge','operator','onpremResource','webhookPublisher'];
const serverRoles={identityServer:'identity',billingServer:'billing',fiscalServer:'fiscal',webhooksServer:'webhooks',apiServer:'api'};
const ownerNames=['identity','billing','fiscal'],allOwners=[...ownerNames,'webhooks','api'];
const publicKeys=['b2bSigning','human','integration'];
const caNames=['private','database'];
const fp=c=>c.fingerprint256.replaceAll(':','').toLowerCase();
const digest=b=>createHash('sha256').update(b).digest('hex');
const spki=k=>digest(k.export({format:'der',type:'spki'}));
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const fileName=v=>typeof v==='string'&&/^[a-z][a-z0-9-]{0,62}\.(pem|crt)$/.test(v);
function invalid(code='DESCRIPTOR_INVALID'){throw Object.assign(new Error(code),{code});}
function check(v,code){if(!v)invalid(code);}
function origin(v,privateOrigin=false){
 try{const u=new URL(v);check(typeof v==='string'&&u.protocol==='https:'&&u.origin===v&&!u.username&&!u.password&&!u.search&&!u.hash&&!v.includes('\\'),'HTTPS_ORIGIN_REQUIRED');
  if(privateOrigin)check(u.port&&Number(u.port)>=9000&&Number(u.port)<=9099,'REVIEW_OWNER_PORT_9000_9099_REQUIRED');return u;
 }catch(e){invalid(e?.code??'HTTPS_ORIGIN_REQUIRED');}
}
export function validateDescriptor(d){
 check(exact(d,['schemaVersion','environment','deploymentId','instanceIds','browserOrigin','existingBrowserOrigins','tokenIssuer','mountRoot','artifactsRoot','listenHost','origins','maintenancePorts','databases','nativeIdentityDatabase','publicFilesRoot','caFiles','certificateFiles','publicKeyFiles']),'DESCRIPTOR_FIELDS_INVALID');
 check(d.schemaVersion==='factuez.b2b.install-plan.v1'&&d.environment==='BETA'&&uuid(d.deploymentId),'BETA_INSTALL_DESCRIPTOR_REQUIRED');
 check(exact(d.instanceIds,['api','webhooks'])&&Object.values(d.instanceIds).every(uuid)&&d.instanceIds.api!==d.instanceIds.webhooks,'DISTINCT_INSTANCE_IDS_REQUIRED');
 origin(d.browserOrigin);origin(d.tokenIssuer);
 check(Array.isArray(d.existingBrowserOrigins)&&d.existingBrowserOrigins.length>0&&d.existingBrowserOrigins.length<=8&&new Set(d.existingBrowserOrigins).size===d.existingBrowserOrigins.length&&d.existingBrowserOrigins.includes(d.browserOrigin),'EXISTING_BROWSER_ORIGIN_ENROLLMENT_REQUIRED');
 d.existingBrowserOrigins.forEach(v=>origin(v));
 for(const target of [d.mountRoot,d.artifactsRoot])check(typeof target==='string'&&/^\/[a-zA-Z0-9/_-]+$/.test(target)&&path.posix.normalize(target)===target&&target!=='/','ABSOLUTE_LINUX_MOUNT_PATH_REQUIRED');
 check(![d.mountRoot,d.artifactsRoot].some(p=>p==='/'||p.startsWith('/run/secrets/'))&&d.mountRoot!==d.artifactsRoot,'DISTINCT_NEW_MOUNT_ROOTS_REQUIRED');
 check(['127.0.0.1','0.0.0.0'].includes(d.listenHost)&&exact(d.origins,allOwners),'FIXED_OWNER_ORIGINS_REQUIRED');
 const urls=Object.values(d.origins).map(v=>origin(v,true));check(new Set(urls.map(u=>u.origin)).size===5,'DISTINCT_OWNER_ORIGINS_REQUIRED');
 check(exact(d.maintenancePorts,['api','webhooks']),'MAINTENANCE_PORTS_REQUIRED');
 for(const p of Object.values(d.maintenancePorts))check(Number.isInteger(p)&&p>=9000&&p<=9099,'MAINTENANCE_PORT_9000_9099_REQUIRED');
 const ports=[...urls.map(u=>Number(u.port)),...Object.values(d.maintenancePorts)];check(new Set(ports).size===ports.length,'DISTINCT_REVIEW_PORTS_REQUIRED');
 check(exact(d.databases,[...ownerNames,'webhooks']),'OWNER_DATABASES_REQUIRED');
 for(const name of [...ownerNames,'webhooks']){
  const db=d.databases[name];check(exact(db,['host','port','name','user'])&&/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(db.host)&&Number.isInteger(db.port)&&db.port>0&&db.port<=65535&&/^[a-z][a-z0-9_]{0,62}$/.test(db.user),'PUBLIC_DATABASE_METADATA_REQUIRED');
  check(db.name===(name==='webhooks'?'b2b_webhooks_beta':name+'_readonly_beta'),'BOOTSTRAP_FIXED_DATABASE_NAME_REQUIRED');
  if(name==='webhooks')check(db.port===5432,'WEBHOOK_BOOTSTRAP_DATABASE_PORT_FIXED_5432');
 }
 check(exact(d.nativeIdentityDatabase,['host','port','name','user'])&&JSON.stringify(['host','port','name'].map(k=>d.nativeIdentityDatabase[k]))===JSON.stringify(['host','port','name'].map(k=>d.databases.identity[k]))&&/^[a-z][a-z0-9_]{0,62}$/.test(d.nativeIdentityDatabase.user),'NATIVE_AND_READONLY_IDENTITY_MUST_SHARE_DATABASE');
 check(typeof d.publicFilesRoot==='string'&&d.publicFilesRoot.length>0&&d.publicFilesRoot.length<1024&&!/[\x00-\x1f]/.test(d.publicFilesRoot),'PUBLIC_FILES_ROOT_REQUIRED');
 for(const [obj,keys]of [[d.caFiles,caNames],[d.certificateFiles,certificateRoles],[d.publicKeyFiles,publicKeys]])
  check(exact(obj,keys)&&Object.values(obj).every(fileName),'NAMED_PUBLIC_FILES_ONLY');
 return structuredClone(d);
}
// Open bounded regular files only. Symlinks, hardlinks and changed files fail.
// These functions are never called for a .key/.bin/private target.
function readPublic(file,maximum=65536){
 let fd;try{
  const before=lstatSync(file);check(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size>0&&before.size<=maximum,'PUBLIC_FILE_UNSAFE');
  check(realpathSync(file)===path.resolve(file),'PUBLIC_FILE_SYMLINK_NOT_ALLOWED');
  fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const stat=fstatSync(fd);
  check(stat.dev===before.dev&&stat.ino===before.ino&&stat.size===before.size,'PUBLIC_FILE_CHANGED');
  const bytes=Buffer.alloc(stat.size);let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,null);check(n>0,'PUBLIC_FILE_CHANGED');offset+=n;}
  const after=fstatSync(fd);check(after.mtimeMs===stat.mtimeMs&&after.ctimeMs===stat.ctimeMs&&after.size===stat.size,'PUBLIC_FILE_CHANGED');
  check(!bytes.includes(Buffer.from('PRIVATE KEY')),'PRIVATE_MATERIAL_REJECTED');return bytes;
 }finally{if(fd!==undefined)closeSync(fd);}
}
const alive=(cert,now)=>Date.parse(cert.validFrom)<=now&&Date.parse(cert.validTo)>now;
function certBytes(bytes){
 const s=bytes.toString('ascii').trim();check(/^-----BEGIN CERTIFICATE-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/.test(s),'ONE_PUBLIC_CERTIFICATE_REQUIRED');
 return new X509Certificate(bytes);
}
function strength(key){
 if(key.asymmetricKeyType==='rsa')return (key.asymmetricKeyDetails?.modulusLength??0)>=2048;
 if(key.asymmetricKeyType==='ec')return ['prime256v1','secp384r1','secp521r1'].includes(key.asymmetricKeyDetails?.namedCurve);
 return key.asymmetricKeyType==='ed25519'||key.asymmetricKeyType==='ed448';
}
function safeError(e){return e?.code==='ENOENT'?'PUBLIC_FILE_MISSING':/^[A-Z0-9_]+$/.test(e?.code??'')?e.code:'PUBLIC_FILE_INVALID';}

export function compileInstallPlan(input,{baseDirectory=process.cwd(),now=Date.now()}={}){
 const d=validateDescriptor(input),publicRoot=path.resolve(baseDirectory,d.publicFilesRoot),issues=[],certs={},cas={},keys={};
 const add=(code,role,file,action)=>issues.push({code,role,file,action});
 let rootExists=true;
 try{const st=lstatSync(publicRoot);check(st.isDirectory()&&!st.isSymbolicLink()&&realpathSync(publicRoot)===publicRoot,'PUBLIC_FILES_ROOT_UNSAFE');}catch(e){if(e.code==='ENOENT')rootExists=false;else invalid(safeError(e));}
 const load=(group,name,filename,parse)=>{
  const file=path.join(publicRoot,filename);
  if(!rootExists){add('PUBLIC_FILE_MISSING',group+'.'+name,filename,'TI debe aportar este archivo público en publicFilesRoot; el CLI no genera PKI.');return;}
  try{return parse(readPublic(file));}catch(e){add(safeError(e),group+'.'+name,filename,'Aportar un archivo público regular válido; revisar certificado, CA, vigencia, firma, SAN y EKU según el rol.');}
 };
 for(const name of caNames)cas[name]=load('ca',name,d.caFiles[name],b=>{
  const c=certBytes(b);check(c.ca&&alive(c,now)&&strength(c.publicKey),'PUBLIC_CA_INVALID_OR_EXPIRED');
  check(c.checkIssued(c)&&c.verify(c.publicKey),'DIRECT_SELF_SIGNED_ROOT_CA_REQUIRED');return c;
 });
 for(const role of certificateRoles)certs[role]=load('certificate',role,d.certificateFiles[role],b=>{
  const c=certBytes(b);check(!c.ca&&alive(c,now)&&strength(c.publicKey),'LEAF_CERTIFICATE_INVALID_OR_EXPIRED');
  if(cas.private)check(c.checkIssued(cas.private)&&c.verify(cas.private.publicKey),'CERTIFICATE_SIGNATURE_OR_CA_MISMATCH');
  const oid=serverRoles[role]?'1.3.6.1.5.5.7.3.1':'1.3.6.1.5.5.7.3.2';
  check(c.keyUsage?.includes(oid),'CERTIFICATE_EXTENDED_KEY_USAGE_REQUIRED');
  if(serverRoles[role]){
   const host=new URL(d.origins[serverRoles[role]]).hostname;
   check(isIP(host)?c.checkIP(host):c.checkHost(host,{subject:'never'}),'SERVER_SAN_MISMATCH');
   check(c.checkIP('127.0.0.1'),'LOOPBACK_HEALTHCHECK_SAN_REQUIRED');
  }return c;
 });
 for(const name of publicKeys)keys[name]=load('publicKey',name,d.publicKeyFiles[name],b=>{
  check(/^-----BEGIN PUBLIC KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(b.toString('ascii')),'SPKI_PUBLIC_KEY_REQUIRED');
  const k=createPublicKey(b);check(k.asymmetricKeyType==='rsa'&&(k.asymmetricKeyDetails?.modulusLength??0)>=2048,'RSA_2048_PUBLIC_KEY_REQUIRED');return k;
 });
 // Separate trust roles. Reusing the common resource as OnPrem registrar is
 // permitted; token/edge/operator/publisher and server identities are distinct.
 const dedicated=certificateRoles.filter(r=>r!=='onpremResource');
 for(let i=0;i<dedicated.length;i++)for(let j=i+1;j<dedicated.length;j++){
  const [a,b]=[dedicated[i],dedicated[j]];
  if(certs[a]&&certs[b]&&fp(certs[a])===fp(certs[b]))add('CERTIFICATE_ROLE_REUSED',a+'/'+b,d.certificateFiles[b],'Emitir certificados distintos para estos roles; no copiar el mismo certificado.');
 }
 for(const role of ['oauth','edge','operator','webhookPublisher',...Object.keys(serverRoles)])
  if(certs.onpremResource&&certs[role]&&fp(certs.onpremResource)===fp(certs[role]))add('CERTIFICATE_ROLE_REUSED','onpremResource/'+role,d.certificateFiles.onpremResource,'OnPrem registrar sólo puede compartir el certificado resource, nunca edge/operator/token/servidor.');
 if(keys.b2bSigning){
  for(const name of ['human','integration'])if(keys[name]&&spki(keys.b2bSigning)===spki(keys[name]))add('B2B_SIGNING_KEY_NOT_SEPARATE',name,d.publicKeyFiles[name],'Aportar claves públicas B2B, humana e integración distintas.');
  for(const [role,c]of Object.entries(certs))if(c&&spki(keys.b2bSigning)===spki(c.publicKey))add('B2B_SIGNING_KEY_NOT_SEPARATE',role,d.certificateFiles[role],'La clave de firma B2B debe ser distinta de todas las claves TLS.');
 }
 const plan={schemaVersion:'factuez.b2b.install-plan-result.v1',environment:'BETA',profile:'ONPREM_READONLY_OAUTH_WEBHOOKS',
  state:issues.length?'PUBLIC_INPUTS_NEED_ACTION':'PUBLIC_CONFIGURATION_VALIDATED',
  activationAllowed:false,runtimeReady:false,privateMaterialRead:false,networkUsed:false,databaseUsed:false,
  capabilityMeaning:{label:'Consulta de comprobantes y gestión de webhooks',fiscalDocumentMutations:false,webhookManagementMutations:true,scope:'b2b:webhooks:manage',allMutationsDisabled:false},
  checkedAt:new Date(now).toISOString(),deploymentId:d.deploymentId,issues,publicFingerprints:{},
  configurationApprovals:'FALSE_PENDING_MAIN_REVIEW',privateValidation:'NOT_INSPECTED_NO_PRIVATE_FILES_OPENED',
  bootstrapCommands:{identity:'node services/identity-service/dist/b2b/readonly-host.js',billing:'node services/billing-service/dist/b2b/readonly-host.js',
   fiscal:'node services/sunat-service/dist/b2b/readonly-host.js',webhooks:'node services/webhook-service/dist/main.js',
   api:'node services/b2b-api-service/dist/readonly-main.js',onprem:'Existing native Identity AppModule; opt-in OnpremB2bAdminModule'},
  prerequisites:[
   {id:'identity-database',action:'Configurar Identity nativo y readonly en la MISMA base '+d.databases.identity.name+' de '+d.databases.identity.host+'. Verificar usuarios/RBAC reales y Redis browser. No copiar usuarios de cliente ni inventar un admin.'},
   {id:'identity-schema',action:'Main revisa services/identity-service/src/b2b/onprem-admin.minimal.sql sólo si faltan las tres tablas. No ejecutar si ya existen; comparar esquema. El CLI no aplica DDL.'},
   {id:'owner-schema',action:'Billing: esquema Prisma de lectura y contextos activos. Fiscal: esquema Prisma, B2bArtifactAudit y originales propios. Webhooks: webhooks-schema.candidate.sql en b2b_webhooks_beta. Main revisa/aplica manualmente.'},
   {id:'private-material',action:'Aportar todas las entradas PRIVATE_NOT_INSPECTED de mount-layout.json; comprobar externamente cert↔key, firma B2B↔SPKI y pepper compartido. No hay valores privados en este plan.'},
   {id:'approval',action:'Revisar JSON públicos y cambiar approvedForPrivateBeta/approvedForLocalSetup de false a true sólo en montajes aprobados. Los flags generados permanecen false.'},
   {id:'routing',action:'Main incorpora ruta HTTPS /api/v1/b2b-admin a identity-service, strip_path=false, mismo origen PWA. Mantener /internal/b2b privado. No se cambia Kong.'},
   {id:'runtime',action:'Main prepara imágenes compiladas, mounts/ACL, DNS y red privada TLS; ensaya owners→facade PAUSED→status OnPrem→contraseña→crear SERVICE→OAuth→XML. Nada de esto fue ejecutado por el CLI.'},
   {id:'publisher',action:'El Billing READ no produce eventos. Reutilizar publisher persistente del Billing de escritura para eventos reales; el plan mantiene dispatchEnabled=false y destinations=[].'},
  ]};
 for(const [role,c]of Object.entries(certs))if(c)plan.publicFingerprints[role]=fp(c);
 const files={'install.disabled.env':[
  'B2B_ONPREM_ADMIN_ENABLED=false','B2B_READONLY_OWNER_ENABLED=false','B2B_WEBHOOKS_ENABLED=false','B2B_READONLY_API_ENABLED=false','NEXT_PUBLIC_B2B_ADMIN_PROFILE=SSO',
  '# Values above are shared safe defaults; activation and each config root belong to main.',
 ].join('\n')+'\n','b2b-operations.json':{environment:'BETA',revision:1,mode:'PAUSED'}};
 const mounts=[];
 const pub=(target,source)=>mounts.push({target,kind:'PUBLIC',source,action:'Montar copia del archivo público validado; no generar claves.'});
 const priv=(target,requirement,sharedGroup)=>mounts.push({target,kind:'PRIVATE_NOT_INSPECTED',requirement,...(sharedGroup?{sharedGroup}:{})});
 const mount=(owner,name)=>path.posix.join(d.mountRoot,owner,name);
 for(const owner of allOwners){
  pub(mount(owner,'ca.pem'),d.caFiles.private);pub(mount(owner,'server.crt'),d.certificateFiles[owner+'Server']);
  priv(mount(owner,'server.key'),'Clave privada correspondiente al server.crt de este owner; comparación externa.');
  pub(mount(owner,'resource.crt'),d.certificateFiles.resource);priv(mount(owner,'resource.key'),'Clave privada del certificado resource; no leída.', 'resource-client');
 }
 for(const owner of [...ownerNames,'webhooks']){
  pub(mount(owner,'database-ca.pem'),d.caFiles.database);priv(mount(owner,'database-password.bin'),'Contraseña del rol PostgreSQL propio '+d.databases[owner].user+'.');
 }
 for(const target of ['identity','onprem']){
  if(target==='onprem'){pub(mount(target,'ca.pem'),d.caFiles.private);pub(mount(target,'resource.crt'),d.certificateFiles.onpremResource);priv(mount(target,'resource.key'),'Clave privada del certificado onpremResource.');}
  pub(mount(target,'human-public.pem'),d.publicKeyFiles.human);pub(mount(target,'integration-public.pem'),d.publicKeyFiles.integration);
  priv(mount(target,'signing-key.pem'),'RSA ≥2048 correspondiente al SPKI público '+d.publicKeyFiles.b2bSigning+'; igual en ambos procesos Identity.','b2b-signing');
  priv(mount(target,'pepper.bin'),'32 bytes aleatorios dedicados, IGUALES en Identity readonly y OnPrem; nunca imprimir.','b2b-pepper');
 }
 pub(mount('api','oauth.crt'),d.certificateFiles.oauth);priv(mount('api','oauth.key'),'Clave privada del certificado oauth, distinta de resource/edge/operator.');
 priv(mount('webhooks','vault-v1.bin'),'32 bytes aleatorios dedicados al vault de Webhooks; no el pepper ni una clave fiscal.');
 mounts.push({target:d.artifactsRoot,kind:'OWNER_DATA_NOT_INSPECTED',action:'Montar originales Fiscal propios existentes, no importarlos ni fabricarlos.'});
 if(!issues.length){
  const fingerprints=Object.fromEntries(Object.entries(certs).map(([k,c])=>[k,fp(c)])),r=fingerprints.resource,peers=[r];
  const dbFor=owner=>({...d.databases[owner],passwordFile:'database-password.bin'});
  for(const owner of ownerNames){
   files[owner+'/readonly-owner.json']={
    schemaVersion:'factuez.b2b.readonly-owner.v1',profile:'READONLY_OAUTH_WEBHOOKS',owner,environment:'BETA',approvedForPrivateBeta:false,
    deploymentId:d.deploymentId,listen:{host:d.listenHost,port:Number(new URL(d.origins[owner]).port)},callers:peers,database:dbFor(owner),
    ...(owner==='identity'?{tokenPeers:[fingerprints.oauth],webhookPeers:peers,billingOrigin:d.origins.billing,tokenIssuer:d.tokenIssuer}:
     owner==='billing'?{registrar:[...new Set([r,fingerprints.onpremResource])],identityOrigin:d.origins.identity}:
      {identityOrigin:d.origins.identity,billingOrigin:d.origins.billing,artifactsRoot:d.artifactsRoot}),
   };
  }
  files['onprem/onprem-admin.json']={schemaVersion:'factuez.b2b.onprem-admin.v1',profile:'ONPREM',environment:'BETA',
   approvedForLocalSetup:false,origins:[d.browserOrigin],billingOrigin:d.origins.billing,tokenIssuer:d.tokenIssuer};
  files['webhooks/runtime.json']={schemaVersion:'factuez.b2b.webhooks-runtime.v1',environment:'BETA',approvedForPrivateBeta:false,
   deploymentId:d.deploymentId,instanceId:d.instanceIds.webhooks,host:d.listenHost,port:Number(new URL(d.origins.webhooks).port),
   maintenancePort:d.maintenancePorts.webhooks,peers:{facade:peers,billingPublisher:[fingerprints.webhookPublisher]},
   operatorPeers:[fingerprints.operator],identityOrigin:d.origins.identity,
   database:{host:d.databases.webhooks.host,name:d.databases.webhooks.name,user:d.databases.webhooks.user},
   destinations:[],dispatchEnabled:false,vault:{activeKeyVersion:'v1',readableKeyVersions:['v1']}};
  files['api/readonly-runtime.json']={schemaVersion:'factuez.b2b.readonly-runtime.v1',profile:'READONLY_OAUTH_WEBHOOKS',environment:'BETA',approvedForPrivateBeta:false,
   deploymentId:d.deploymentId,instanceId:d.instanceIds.api,listen:{host:d.listenHost,port:Number(new URL(d.origins.api).port),maintenancePort:d.maintenancePorts.api},
   edgePeers:[fingerprints.edge],operatorPeers:[fingerprints.operator],origins:Object.fromEntries([...ownerNames,'webhooks'].map(o=>[o,d.origins[o]]))};
  files['api/b2b-operations.json']={environment:'BETA',revision:1,mode:'PAUSED'};
 }
 plan.generatedConfigurationFiles=Object.keys(files).filter(n=>n.endsWith('.json'));
 plan.configRoots=Object.fromEntries([...allOwners,'onprem'].map(o=>[o,path.posix.join(d.mountRoot,o)]));
 plan.hostEnvironmentPlan={onprem:{B2B_ONPREM_ADMIN_ENABLED:'false',B2B_ONPREM_ADMIN_CONFIG_ROOT:plan.configRoots.onprem,
  AUTH_BROWSER_ORIGINS:d.existingBrowserOrigins.join(','),B2B_PRIVATE_ACCESS:'false'},
  owners:Object.fromEntries(ownerNames.map(o=>[o,{B2B_READONLY_OWNER_ENABLED:'false',B2B_READONLY_OWNER_CONFIG_ROOT:plan.configRoots[o],B2B_PRIVATE_ACCESS:'false'}])),
  webhooks:{B2B_WEBHOOKS_ENABLED:'false',B2B_WEBHOOKS_CONFIG_ROOT:plan.configRoots.webhooks,B2B_PRIVATE_ACCESS:'false'},
  api:{B2B_READONLY_API_ENABLED:'false',B2B_READONLY_CONFIG_ROOT:plan.configRoots.api,B2B_PRIVATE_ACCESS:'false'}};
 for(const [owner,values]of Object.entries({...plan.hostEnvironmentPlan.owners,onprem:plan.hostEnvironmentPlan.onprem,webhooks:plan.hostEnvironmentPlan.webhooks,api:plan.hostEnvironmentPlan.api}))
  files[owner+'/install.disabled.env']=Object.entries(values).map(([k,v])=>k+'='+v).join('\n')+'\n';
 return {plan,files,mounts};
}
export function writeInstallPlan(result,outDirectory){
 const out=path.resolve(outDirectory),parent=path.dirname(out);
 try{check(!lstatSync(parent).isSymbolicLink()&&realpathSync(parent)===parent,'OUTPUT_PARENT_UNSAFE');}catch(e){invalid(e.code==='ENOENT'?'OUTPUT_PARENT_MISSING':safeError(e));}
 check(!path.basename(out).startsWith('.'),'NEW_OUTPUT_DIRECTORY_REQUIRED');
 // Never merges, replaces or cleans an existing target.
 mkdirSync(out,{mode:0o700});
 const entries={'plan.json':result.plan,'mount-layout.json':{schemaVersion:'factuez.b2b.mount-layout.v1',privateMaterialInspected:false,entries:result.mounts},...result.files};
 for(const [name,value]of Object.entries(entries)){
  check(!name.includes('..')&&!path.isAbsolute(name),'GENERATED_PATH_INVALID');
  const target=path.join(out,...name.split('/')),folder=path.dirname(target);if(folder!==out)mkdirSync(folder,{recursive:true,mode:0o700});
  writeFileSync(target,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
 }
 return {state:result.plan.state,activationAllowed:false,issues:result.plan.issues.length,filesWritten:Object.keys(entries).length,privateMaterialRead:false};
}
export function runCli(args){
 if(args.length===1&&args[0]==='--help')return {usage:'node infra/b2b/install-plan/plan.mjs --descriptor <public.json> --out <NEW_DIRECTORY>',operation:'Only offline public validation and new public plan files; no keys, DB, network or startup.'};
 check(args.length===4&&args[0]==='--descriptor'&&args[2]==='--out','USAGE_DESCRIPTOR_AND_NEW_OUT_REQUIRED');
 const descriptorPath=path.resolve(args[1]);check(/\.json$/.test(descriptorPath),'PUBLIC_JSON_DESCRIPTOR_REQUIRED');
 let descriptor;try{descriptor=JSON.parse(readPublic(descriptorPath));}catch(e){invalid(safeError(e));}
 const result=compileInstallPlan(descriptor,{baseDirectory:path.dirname(descriptorPath)});
 const summary=writeInstallPlan(result,args[3]);
 return {...summary,exitCode:result.plan.issues.length?2:0};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const summary=runCli(process.argv.slice(2));process.stdout.write(JSON.stringify(summary)+'\n');process.exitCode=summary.exitCode??0;}
 catch(e){
  const code=safeError(e),actions={
   NATIVE_AND_READONLY_IDENTITY_MUST_SHARE_DATABASE:'nativeIdentityDatabase debe apuntar al mismo host/puerto/nombre que databases.identity; no crear clientes en otra base. Ver restricciones del host en README.md.',
   BOOTSTRAP_FIXED_DATABASE_NAME_REQUIRED:'Usar los nombres fijados por los hosts: identity_readonly_beta, billing_readonly_beta, fiscal_readonly_beta, b2b_webhooks_beta. Si la base nativa difiere, main debe revisar composición antes de continuar.',
   EXISTING_BROWSER_ORIGIN_ENROLLMENT_REQUIRED:'browserOrigin debe ser un origen HTTPS exacto ya incluido en existingBrowserOrigins del mecanismo browser existente.',
   EEXIST:'El destino ya existe; elegir otra carpeta NUEVA. No se sobrescriben ni fusionan archivos.',
   OUTPUT_PARENT_MISSING:'Crear únicamente la carpeta padre de preparación antes de ejecutar; el destino final debe seguir sin existir.',
   PUBLIC_FILE_MISSING:'Aportar el descriptor público JSON indicado; para certificados faltantes consultar plan.json generado.',
  };
  process.stderr.write(JSON.stringify({code,action:actions[code]??'Corregir el campo público indicado por el código y usar salida NUEVA; consultar --help/README.md. No se arrancó ningún servicio ni se leyó material privado.'})+'\n');process.exitCode=1;
 }
}
