import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {generateKeyPairSync,randomBytes,X509Certificate} from 'node:crypto';
const forge=createRequire(resolve('packages/evidence-core/package.json'))('node-forge');
export const corporateFingerprint=(cert:Buffer)=>new X509Certificate(cert).fingerprint256.replace(/:/g,'').toLowerCase();
/** Entirely new in-memory PKI for each local test. No certificate/key files or environment lookups. */
export function corporateEmailPki(){
  const pki=forge.pki;
  const pair=()=>generateKeyPairSync('rsa',{modulusLength:2048,
    publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const root=pair(),ca=pki.createCertificate();ca.publicKey=pki.publicKeyFromPem(root.publicKey);
  ca.serialNumber='01'+randomBytes(12).toString('hex');ca.validity.notBefore=new Date(Date.now()-60000);
  ca.validity.notAfter=new Date(Date.now()+3600000);ca.setSubject([{name:'commonName',value:'EPHEMERAL CORPORATE EMAIL TEST CA'}]);
  ca.setIssuer(ca.subject.attributes);ca.setExtensions([{name:'basicConstraints',cA:true},{name:'keyUsage',keyCertSign:true,cRLSign:true}]);
  const rootKey=pki.privateKeyFromPem(root.privateKey);ca.sign(rootKey,forge.md.sha256.create());
  const leaf=(name:string,server=false)=>{
    const keys=pair(),cert=pki.createCertificate();cert.publicKey=pki.publicKeyFromPem(keys.publicKey);
    cert.serialNumber='02'+randomBytes(12).toString('hex');cert.validity.notBefore=ca.validity.notBefore;cert.validity.notAfter=ca.validity.notAfter;
    cert.setSubject([{name:'commonName',value:name}]);cert.setIssuer(ca.subject.attributes);
    cert.setExtensions([{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},
      {name:'extKeyUsage',serverAuth:server,clientAuth:!server},
      ...(server?[{name:'subjectAltName',altNames:[{type:7,ip:'127.0.0.1'}]}]:[])]);
    cert.sign(rootKey,forge.md.sha256.create());return {cert:Buffer.from(pki.certificateToPem(cert)),key:Buffer.from(keys.privateKey)};
  };
  return {ca:Buffer.from(pki.certificateToPem(ca)),server:leaf('loopback-email-server',true),
    sdk:leaf('synthetic-sdk'),owner:leaf('synthetic-owner-adapter'),outsider:leaf('unapproved-test-peer')};
}
