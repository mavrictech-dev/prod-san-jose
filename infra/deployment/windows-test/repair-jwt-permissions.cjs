'use strict';
// Permissions only: never generate, replace, print or rotate authentication keys.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function repair(root){
 if(!path.isAbsolute(root)||fs.lstatSync(root).isSymbolicLink()||!fs.lstatSync(root).isDirectory())throw Error('KEY_DIRECTORY_REQUIRED');
 const names=['jwt_private_key','jwt_public_key'],files=names.map(n=>path.join(root,n));
 const bytes=files.map(f=>{const s=fs.lstatSync(f);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<100||s.size>16384)throw Error('REGULAR_JWT_KEY_REQUIRED');return fs.readFileSync(f);});
 try{
  const derived=crypto.createPublicKey(crypto.createPrivateKey(bytes[0])).export({format:'der',type:'spki'}),published=crypto.createPublicKey(bytes[1]).export({format:'der',type:'spki'});
  if(!derived.equals(published))throw Error('EXISTING_KEY_PAIR_MISMATCH');
  const hashes=bytes.map(b=>crypto.createHash('sha256').update(b).digest('hex'));
  files.forEach((f,i)=>{fs.chownSync(f,1000,1000);fs.chmodSync(f,i===0?0o600:0o644);});
  files.forEach((f,i)=>{const s=fs.lstatSync(f);if(s.uid!==1000||(s.mode&0o777)!==(i===0?0o600:0o644)||crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')!==hashes[i])throw Error('JWT_PERMISSIONS_NOT_VERIFIED');});
  return {result:'JWT_PERMISSIONS_REPAIRED',keyMaterialUnchanged:true};
 }finally{bytes.forEach(b=>b.fill(0));}
}
module.exports={repair};
if(require.main===module){try{if(process.argv.length!==3)throw Error('DIRECTORY_REQUIRED');console.log(JSON.stringify(repair(process.argv[2])));}catch(e){console.error(/^[A-Z_]+$/.test(e.message)?e.message:'JWT_PERMISSION_REPAIR_FAILED');process.exitCode=1;}}
