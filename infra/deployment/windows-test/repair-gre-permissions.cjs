'use strict';
// Change ownership only; retain every existing transport/signing key byte.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function repair(root){
 if(!path.isAbsolute(root)||!fs.lstatSync(root).isDirectory()||fs.lstatSync(root).isSymbolicLink())throw Error('GRE_DIRECTORY_REQUIRED');
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
 if(manifest.version!=='factuez.native-gre.provisioning.v1')throw Error('GRE_MANIFEST_REQUIRED');
 const files=[];
 for(const side of ['identity','billing','sunat']){
  const dir=path.join(root,side),stat=fs.lstatSync(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('REGULAR_GRE_DIRECTORY_REQUIRED');
  const expected=['ca.pem','transport-cert.pem','transport-key.pem','config.json',...(side==='identity'?[]:['signing-private.pem','billing-public.pem','sunat-public.pem']),...(side==='sunat'?['catalogues.json']:[])].sort();
  if(JSON.stringify(fs.readdirSync(dir).sort())!==JSON.stringify(expected))throw Error('GRE_FILES_REQUIRE_REVIEW');
  for(const name of expected){
   const file=path.join(dir,name),s=fs.lstatSync(file);
   if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<1||s.size>65536)throw Error('REGULAR_GRE_FILE_REQUIRED');
   files.push({file,hash:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
  }
  const cert=new crypto.X509Certificate(fs.readFileSync(path.join(dir,'transport-cert.pem'))),ca=new crypto.X509Certificate(fs.readFileSync(path.join(dir,'ca.pem')));
  const derived=crypto.createPublicKey(fs.readFileSync(path.join(dir,'transport-key.pem'))).export({type:'spki',format:'der'});
  if(!derived.equals(cert.publicKey.export({type:'spki',format:'der'}))||!cert.verify(ca.publicKey)||cert.fingerprint256.replaceAll(':','').toLowerCase()!==manifest.transportFingerprints?.[side])throw Error('GRE_TRANSPORT_KEY_MISMATCH');
  if(side!=='identity'){
   const signing=crypto.createPublicKey(fs.readFileSync(path.join(dir,'signing-private.pem'))).export({type:'spki',format:'der'}),published=crypto.createPublicKey(fs.readFileSync(path.join(dir,side+'-public.pem'))).export({type:'spki',format:'der'});
   if(!signing.equals(published))throw Error('GRE_SIGNING_KEY_MISMATCH');
  }
 }
 // Validate the complete bundle before changing any ownership.
 for(const {file} of files){fs.chownSync(file,1000,1000);fs.chmodSync(file,0o600);}
 for(const side of ['identity','billing','sunat']){const dir=path.join(root,side);fs.chownSync(dir,1000,1000);fs.chmodSync(dir,0o700);}
 for(const {file,hash} of files){const s=fs.statSync(file);if(s.uid!==1000||(s.mode&0o777)!==0o600||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==hash)throw Error('GRE_PERMISSIONS_NOT_VERIFIED');}
 return {result:'GRE_PERMISSIONS_REPAIRED',keyMaterialUnchanged:true};
}
module.exports={repair};
if(require.main===module){try{if(process.argv.length!==3)throw Error('DIRECTORY_REQUIRED');console.log(JSON.stringify(repair(process.argv[2])));}catch(e){console.error(/^[A-Z_]+$/.test(e.message)?e.message:'GRE_PERMISSION_REPAIR_FAILED');process.exitCode=1;}}
