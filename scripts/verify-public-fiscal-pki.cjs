'use strict';
// Public material only. No vault, P12, application configuration or network access.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
function verifyPublicBundle(staging,reviewed,openssl='/usr/bin/openssl'){
 if(!path.isAbsolute(staging)||!path.isAbsolute(reviewed)||!path.isAbsolute(openssl))throw Error('ABSOLUTE_PATHS_REQUIRED');
 const read=(dir,name)=>{const p=path.join(dir,name),stat=fs.lstatSync(p);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('PUBLIC_FILE_INVALID');const bytes=fs.readFileSync(p);if(bytes.includes(Buffer.from('PRIVATE KEY')))throw Error('PRIVATE_MATERIAL_NOT_ALLOWED');return bytes;};
 const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
 const manifest=JSON.parse(read(reviewed,'manifest.json').toString('utf8'));
 if(manifest.version!=='factuez.reviewed-public-pki.v1')throw Error('REVIEWED_MANIFEST_REQUIRED');
 for(const name of ['issuer-roots.pem','cdr-signers.pem'])if(sha(read(reviewed,name))!==manifest.files[name])throw Error('REVIEWED_PUBLIC_PIN_CHANGED');
 const rootBytes=read(reviewed,'issuer-roots.pem'),signerBytes=read(reviewed,'cdr-signers.pem');
 const roots=rootBytes.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)||[];
 const chain=signerBytes.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)||[];
 if(roots.length!==1||chain.length!==2)throw Error('REVIEWED_CHAIN_REQUIRED');
 const root=new crypto.X509Certificate(roots[0]),leaf=new crypto.X509Certificate(chain[0]),intermediate=new crypto.X509Certificate(chain[1]);
 if(!root.ca||!root.verify(root.publicKey)||!intermediate.ca||!intermediate.verify(root.publicKey)||!leaf.verify(intermediate.publicKey))throw Error('PUBLIC_CERTIFICATE_CHAIN_INVALID');
 const now=Date.now();for(const c of [root,intermediate,leaf])if(now<Date.parse(c.validFrom)||now>=Date.parse(c.validTo))throw Error('PUBLIC_CERTIFICATE_EXPIRED_OR_NOT_YET_VALID');
 if(leaf.fingerprint256.replaceAll(':','').toLowerCase()!==manifest.sunatSignerFingerprint)throw Error('SUNAT_SIGNER_PIN_CHANGED');
 const exec=args=>{const p=spawnSync(openssl,args,{encoding:'utf8',timeout:10000,maxBuffer:2*1024*1024,windowsHide:true});if(p.error||p.status!==0)throw Error('PUBLIC_PKI_CRYPTOGRAPHIC_CHECK_FAILED');return p.stdout;};
 fs.writeFileSync(path.join(staging,'roots.verify.pem'),rootBytes);fs.writeFileSync(path.join(staging,'intermediate.verify.pem'),chain[1]+'\n');fs.writeFileSync(path.join(staging,'signer.verify.pem'),chain[0]+'\n');
 const crls=[],expiry=[];
 for(const [source,issuer]of [['root.crl','roots.verify.pem'],['intermediate.crl','intermediate.verify.pem']]){
  const bytes=read(staging,source),pem=path.join(staging,source+'.pem');
  const text=exec(['crl','-inform',bytes.toString('ascii',0,11)==='-----BEGIN '?'PEM':'DER','-in',path.join(staging,source),'-outform','PEM']);
  fs.writeFileSync(pem,text);exec(['crl','-in',pem,'-noout','-verify','-CAfile',path.join(staging,issuer)]);
  const dates=exec(['crl','-in',pem,'-noout','-lastupdate','-nextupdate']);
  const before=Date.parse(dates.match(/^lastUpdate=(.+)$/m)?.[1]||''),after=Date.parse(dates.match(/^nextUpdate=(.+)$/m)?.[1]||'');
  if(!Number.isFinite(before)||!Number.isFinite(after)||now<before||now>=after)throw Error('CRL_EXPIRED_OR_NOT_YET_VALID');
  expiry.push(after);crls.push(Buffer.from(text));
 }
 const bundle=Buffer.concat(crls);fs.writeFileSync(path.join(staging,'crls.pem'),bundle);
 exec(['verify','-CAfile',path.join(staging,'roots.verify.pem'),'-untrusted',path.join(staging,'intermediate.verify.pem'),'-CRLfile',path.join(staging,'crls.pem'),'-crl_check_all','-x509_strict','-check_ss_sig',path.join(staging,'signer.verify.pem')]);
 const files={'issuer-roots.pem':rootBytes,'crls.pem':bundle,'cdr-signers.pem':signerBytes};
 for(const [name,bytes]of Object.entries(files))fs.writeFileSync(path.join(staging,name),bytes);
 const result={verified:true,checkedAt:new Date(now).toISOString(),crlExpiresAt:new Date(Math.min(...expiry)).toISOString(),sunatSignerFingerprint:manifest.sunatSignerFingerprint,hashes:Object.fromEntries(Object.entries(files).map(([n,b])=>[n,sha(b)])),transmissionActivated:false};
 fs.writeFileSync(path.join(staging,'verification.json'),JSON.stringify(result,null,2)+'\n');return result;
}
module.exports={verifyPublicBundle};
if(require.main===module){try{if(process.argv.length!==4)throw Error('STAGING_AND_REVIEWED_DIRECTORIES_REQUIRED');console.log(JSON.stringify(verifyPublicBundle(path.resolve(process.argv[2]),path.resolve(process.argv[3]))));}catch(e){console.error(e.message);process.exitCode=1;}}
