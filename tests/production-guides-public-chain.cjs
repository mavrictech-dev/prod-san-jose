'use strict';
// Public certificate + pinned public roots/intermediates/CRLs only. No CA installation or external I/O.
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),{createHash,X509Certificate}=require('node:crypto');
const {publicFile}=require('./production-guides-readonly-diagnostic.cjs');
async function run(args){
 if(args[0]!=='--read-only')throw Error('REQUIRES_READ_ONLY');
 const options={};for(let i=1;i<args.length;i+=2){if(!['--public-certificate','--root','--intermediate','--crl','--openssl','--expected-ruc'].includes(args[i])||!args[i+1]||options[args[i]])throw Error('ARGUMENT_INVALID');options[args[i]]=args[i+1];}
 for(const flag of ['--public-certificate','--root','--intermediate','--crl','--openssl','--expected-ruc'])if(!options[flag])throw Error('ARGUMENT_REQUIRED');
 if(!/^\d{11}$/.test(options['--expected-ruc'])||!path.isAbsolute(options['--openssl']))throw Error('ARGUMENT_INVALID');
 const root=path.resolve(__dirname,'..'),local=createRequire(path.join(root,'services/sunat-service/package.json')),forge=local('node-forge');
 const {certificateRucCandidates}=local('./dist/infrastructure/crypto/certificate-identity'),{CertificateTrustService}=local('./dist/infrastructure/crypto/certificate-trust.service');
 for(const flag of ['--public-certificate','--root','--intermediate','--crl'])if(!publicFile(options[flag],flag==='--public-certificate').readable)throw Error('PUBLIC_FILE_UNAVAILABLE');
 const leaf=new X509Certificate(fs.readFileSync(options['--public-certificate'])),pem=leaf.toString(),parsed=forge.pki.certificateFromPem(pem),usage=parsed.getExtension('keyUsage');
 const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 // This short-lived diagnostic process configures only explicitly supplied public pins.
 Object.assign(process.env,{SUNAT_OPENSSL_PATH:options['--openssl'],SUNAT_TRUST_STORE_FILE:options['--root'],SUNAT_TRUST_STORE_SHA256:sha(options['--root']),SUNAT_CRL_BUNDLE_FILE:options['--crl'],SUNAT_CRL_BUNDLE_SHA256:sha(options['--crl'])});
 const proof=await new CertificateTrustService().evaluate({fingerprint:leaf.fingerprint256.replaceAll(':','').toLowerCase(),expiresAt:new Date(leaf.validTo),selfSigned:leaf.subject===leaf.issuer&&leaf.verify(leaf.publicKey),digitalSignature:usage?.digitalSignature===true,certificatePem:pem,chainPems:[fs.readFileSync(options['--intermediate'],'utf8')],subjectRucCandidates:certificateRucCandidates(parsed.subject.attributes)},options['--expected-ruc']);
 // No customer subject, RUC, certificate bytes or fingerprint is written into the repository evidence.
 return {readOnly:true,publicCertificateOnly:true,identityMatched:proof.identityMatched,chainValid:proof.chainValid,revocation:proof.revocation,checkedAt:proof.checkedAt,blockers:proof.blockers,rootSha256:sha(options['--root']),crlBundleSha256:sha(options['--crl'])};
}
module.exports={run};
if(require.main===module)run(process.argv.slice(2)).then(result=>{console.log(JSON.stringify(result,null,2));if(!result.identityMatched||!result.chainValid||result.revocation!=='VERIFIED_OFFLINE_CRL'||result.blockers.length)process.exitCode=1;}).catch(()=>{console.error('PUBLIC_CHAIN_DIAGNOSTIC_FAILED');process.exitCode=1;});
