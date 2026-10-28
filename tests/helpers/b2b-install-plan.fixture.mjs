import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {generateKeyPairSync} from 'node:crypto';
import path from 'node:path';
const require=createRequire(new URL('../../packages/evidence-core/package.json',import.meta.url));
const forge=require('node-forge');
export const example=()=>JSON.parse(readFileSync(new URL('../../infra/b2b/install-plan/descriptor.example.json',import.meta.url),'utf8'));
/** Test-only CA/cert issuance. The CLI itself never generates a key or cert.
 * Private keys exist only in the isolated test process, not in the plan/public directory. */
export function syntheticPublicInputs(root){
 const d=example(),publicRoot=path.join(root,'public');mkdirSync(publicRoot,{mode:0o700});
 const pki=forge.pki,caKey=pki.rsa.generateKeyPair(2048),leafKey=pki.rsa.generateKeyPair(2048),ca=pki.createCertificate();
 ca.publicKey=caKey.publicKey;ca.serialNumber='01';ca.validity.notBefore=new Date(Date.now()-60000);ca.validity.notAfter=new Date(Date.now()+3600000);
 ca.setSubject([{name:'commonName',value:'SYNTHETIC OFFLINE INSTALL PLAN CA'}]);ca.setIssuer(ca.subject.attributes);
 ca.setExtensions([{name:'basicConstraints',cA:true},{name:'keyUsage',keyCertSign:true,cRLSign:true}]);ca.sign(caKey.privateKey,forge.md.sha256.create());
 for(const file of Object.values(d.caFiles))writeFileSync(path.join(publicRoot,file),pki.certificateToPem(ca));
 let serial=2;
 const issue=(role,options={})=>{
  const c=pki.createCertificate();c.publicKey=leafKey.publicKey;c.serialNumber=(serial++).toString(16).padStart(2,'0');
  c.validity.notBefore=ca.validity.notBefore;c.validity.notAfter=options.expired?new Date(Date.now()-1000):ca.validity.notAfter;
  c.setSubject([{name:'commonName',value:'synthetic-'+role}]);c.setIssuer(ca.subject.attributes);
  const owner={identityServer:'identity',billingServer:'billing',fiscalServer:'fiscal',webhooksServer:'webhooks',apiServer:'api'}[role];
  const server=!!owner,host=server?new URL(d.origins[owner]).hostname:null;
  c.setExtensions([{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},
   {name:'extKeyUsage',serverAuth:server&&!options.wrongEku,clientAuth:!server||options.wrongEku},
   ...(server?[{name:'subjectAltName',altNames:[{type:2,value:options.wrongSan?'wrong.synthetic.invalid':host},{type:7,ip:'127.0.0.1'}]}]:[])]);
  c.sign(options.wrongSignature?leafKey.privateKey:caKey.privateKey,forge.md.sha256.create());
  writeFileSync(path.join(publicRoot,d.certificateFiles[role]),pki.certificateToPem(c));return c;
 };
 for(const role of Object.keys(d.certificateFiles))issue(role);
 for(const file of Object.values(d.publicKeyFiles)){
  const pair=generateKeyPairSync('rsa',{modulusLength:2048});writeFileSync(path.join(publicRoot,file),pair.publicKey.export({type:'spki',format:'pem'}));
 }
 const descriptor=path.join(root,'descriptor.json');writeFileSync(descriptor,JSON.stringify(d,null,2));
 return {d,publicRoot,descriptor,issue,leafPublic:Buffer.from(pki.publicKeyToPem(leafKey.publicKey))};
}
