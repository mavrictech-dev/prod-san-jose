import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { X509Certificate } from 'node:crypto';
const forge=createRequire(resolve('packages/evidence-core/package.json'))('node-forge');
export const fingerprint=(cert:Buffer)=>new X509Certificate(cert).fingerprint256.replace(/:/g,'').toLowerCase();
/** Throwaway PKI for loopback tests only. No P12/customer key is read. */
export function b2bCertificates(){
  const pki=forge.pki,root=pki.rsa.generateKeyPair(2048),leaf=pki.rsa.generateKeyPair(2048),ca=pki.createCertificate();
  ca.publicKey=root.publicKey;ca.serialNumber='01';ca.validity.notBefore=new Date(Date.now()-60000);ca.validity.notAfter=new Date(Date.now()+3600000);
  ca.setSubject([{name:'commonName',value:'SYNTHETIC B2B ONLY CA'}]);ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([{name:'basicConstraints',cA:true},{name:'keyUsage',keyCertSign:true,cRLSign:true}]);ca.sign(root.privateKey,forge.md.sha256.create());
  const make=(serial:string,server=false)=>{const c=pki.createCertificate();c.publicKey=leaf.publicKey;c.serialNumber=serial;c.validity.notBefore=ca.validity.notBefore;c.validity.notAfter=ca.validity.notAfter;
    c.setSubject([{name:'commonName',value:server?'localhost':'synthetic-b2b-'+serial}]);c.setIssuer(ca.subject.attributes);
    c.setExtensions([{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},{name:'extKeyUsage',serverAuth:server,clientAuth:!server},...(server?[{name:'subjectAltName',altNames:[{type:7,ip:'127.0.0.1'},{type:2,value:'localhost'}]}]:[])]);
    c.sign(root.privateKey,forge.md.sha256.create());return Buffer.from(pki.certificateToPem(c));};
  return {ca:Buffer.from(pki.certificateToPem(ca)),key:Buffer.from(pki.privateKeyToPem(leaf.privateKey)),server:make('02',true),resource:make('03'),edge:make('04'),other:make('05')};
}
