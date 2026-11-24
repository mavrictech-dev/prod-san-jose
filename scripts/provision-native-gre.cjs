'use strict';
// NEW purpose-specific local transport/signing keys only. Existing material is never overwritten.
const {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,lstatSync,rmdirSync}=require('node:fs'),{join,resolve}=require('node:path'),{createRequire}=require('node:module'),{generateKeyPairSync,X509Certificate}=require('node:crypto');
function provision(root,target,options={}){
 if(!target)throw Error('NEW_GRE_DIRECTORY_REQUIRED');
 if(existsSync(target)){
  // Docker creates empty bind-mount placeholders before first provisioning.
  // Never unlink the mounted root on Windows, and never accept existing material.
  const entries=readdirSync(target);
  if(!options.allowEmptyPlaceholder||!lstatSync(target).isDirectory()||entries.some(name=>!['identity','billing','sunat'].includes(name)||!lstatSync(join(target,name)).isDirectory()||readdirSync(join(target,name)).length))throw Error('NEW_GRE_DIRECTORY_REQUIRED: keep existing GRE identity; do not rotate it during updates');
  for(const name of entries)rmdirSync(join(target,name));
 }
 const forge=createRequire(join(root,'services/sunat-service/package.json'))('node-forge');mkdirSync(target,{recursive:true,mode:0o700});
 const caKeys=forge.pki.rsa.generateKeyPair(3072),ca=forge.pki.createCertificate();ca.publicKey=caKeys.publicKey;ca.serialNumber='01';ca.validity.notBefore=new Date(Date.now()-60000);ca.validity.notAfter=new Date(Date.now()+5*365*86400000);ca.setSubject([{name:'commonName',value:'FactuEz private GRE transport CA'}]);ca.setIssuer(ca.subject.attributes);ca.setExtensions([{name:'basicConstraints',cA:true},{name:'keyUsage',keyCertSign:true,cRLSign:true}]);ca.sign(caKeys.privateKey,forge.md.sha256.create());
 const put=(file,value)=>writeFileSync(file,value,{flag:'wx',mode:0o600});put(join(target,'transport-ca-private.pem'),forge.pki.privateKeyToPem(caKeys.privateKey));
 const material={},signing={};
 for(const [i,name] of ['identity','billing','sunat'].entries()){
  const dir=join(target,name);mkdirSync(dir,{mode:0o700});const keys=forge.pki.rsa.generateKeyPair(2048),cert=forge.pki.createCertificate();cert.publicKey=keys.publicKey;cert.serialNumber=String(i+10);cert.validity.notBefore=ca.validity.notBefore;cert.validity.notAfter=new Date(Date.now()+365*86400000);cert.setSubject([{name:'commonName',value:name+'-service'}]);cert.setIssuer(ca.subject.attributes);cert.setExtensions([{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},{name:'extKeyUsage',serverAuth:true,clientAuth:true},{name:'subjectAltName',altNames:[{type:2,value:name+'-service'},{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'}]}]);cert.sign(caKeys.privateKey,forge.md.sha256.create());
  const pem=forge.pki.certificateToPem(cert);put(join(dir,'ca.pem'),forge.pki.certificateToPem(ca));put(join(dir,'transport-cert.pem'),pem);put(join(dir,'transport-key.pem'),forge.pki.privateKeyToPem(keys.privateKey));material[name]=new X509Certificate(pem).fingerprint256.replaceAll(':','').toLowerCase();
  if(name!=='identity'){signing[name]=generateKeyPairSync('ed25519');put(join(dir,'signing-private.pem'),signing[name].privateKey.export({type:'pkcs8',format:'pem'}));}
 }
 for(const [name,port] of [['identity',3441],['billing',3442],['sunat',3443]]){
  const dir=join(target,name),config={version:'factuez.native-gre.host.v1',listener:{port,host:'0.0.0.0',caFile:'/run/gre/ca.pem',certFile:'/run/gre/transport-cert.pem',keyFile:'/run/gre/transport-key.pem'},peers:name==='identity'?[material.billing]:[material[name==='billing'?'sunat':'billing']]};
  if(name!=='identity'){
   const remote=name==='billing'?'sunat':'billing';config.remote={origin:`https://${remote}-service:${remote==='billing'?3442:3443}`,serverFingerprint:material[remote]};config.signing={keyId:'native-gre-'+name+'-v1',keyFile:'/run/gre/signing-private.pem'};
   for(const side of ['billing','sunat'])put(join(dir,side+'-public.pem'),signing[side].publicKey.export({type:'spki',format:'pem'}));
   config.ownerPublicKeys=[{keyId:'native-gre-billing-v1',file:'/run/gre/billing-public.pem'}];config.sunatPublicKeys=[{keyId:'native-gre-sunat-v1',file:'/run/gre/sunat-public.pem'}];
   if(name==='billing')config.identity={origin:'https://identity-service:3441',serverFingerprint:material.identity};
   else {config.cataloguesFile='/run/gre/catalogues.json';put(join(dir,'catalogues.json'),'[]\n');}
  }
  put(join(dir,'config.json'),JSON.stringify(config,null,2)+'\n');
 }
 put(join(target,'manifest.json'),JSON.stringify({version:'factuez.native-gre.provisioning.v1',createdAt:new Date().toISOString(),transportFingerprints:material,fiscalSecretsCreated:false,transmissionActivated:false})+'\n');
 return {provisioned:true,fiscalSecretsCreated:false,transmissionActivated:false};
}
module.exports={provision};if(require.main===module){try{const target=process.argv[2],flag=process.argv[3];if(process.argv.length!==3&&!(process.argv.length===4&&flag==='--empty-placeholder'))throw Error();console.log(JSON.stringify(provision(resolve(__dirname,'..'),resolve(target),{allowEmptyPlaceholder:flag==='--empty-placeholder'})));}catch{console.error('GRE_PROVISIONING_BLOCKED: requires a new or empty placeholder directory, retain existing identity');process.exitCode=1;}}
